import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';

// Types
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ContextOptions {
  name: string;
  env?: Record<string, string>;
  cwd?: string;
  isolation?: boolean;
}

// Check if we can create namespaces
export function hasNamespaceSupport(): boolean {
  try {
    const child = spawn('unshare', ['--pid', '--fork', 'true']);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Linux-native execution context
 * Uses bash for state management, but safely!
 */
export class SimpleContext {
  private shell: ChildProcess | null = null;
  private ready = false;
  private canIsolate: boolean;
  
  constructor(private options: ContextOptions) {
    this.canIsolate = (options.isolation !== false) && hasNamespaceSupport();
  }
  
  async initialize(): Promise<void> {
    // Start bash with or without isolation
    const shellCommand = this.canIsolate
      ? ['unshare', '--pid', '--fork', '--mount-proc', 'bash', '--norc', '-i']
      : ['bash', '--norc', '-i'];
    
    this.shell = spawn(shellCommand[0], shellCommand.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...this.options.env,
        PS1: '\\$ ',  // Simple prompt
        HOME: '/workspace',
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
      },
      cwd: this.options.cwd || '/workspace'
    });
    
    // Wait for shell to be ready
    await this.waitForReady();
    this.ready = true;
  }
  
  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Shell initialization timeout'));
      }, 5000);
      
      const marker = `READY_${randomUUID()}`;
      let output = '';
      
      const onData = (data: Buffer) => {
        output += data.toString();
        if (output.includes(marker)) {
          clearTimeout(timeout);
          this.shell?.stdout?.off('data', onData);
          resolve();
        }
      };
      
      this.shell?.stdout?.on('data', onData);
      this.shell?.stdin?.write(`echo ${marker}\n`);
    });
  }
  
  /**
   * Execute command in the shell session
   * The shell maintains pwd, env vars, background processes, etc.
   */
  async exec(command: string): Promise<ExecResult> {
    if (!this.ready || !this.shell) {
      throw new Error('Context not initialized');
    }
    
    return new Promise((resolve, reject) => {
      const execId = randomUUID();
      const startMarker = `START_${execId}`;
      const endMarker = `END_${execId}`;
      
      let capturing = false;
      let stdout = '';
      let stderr = '';
      
      const onStdout = (data: Buffer) => {
        const chunk = data.toString();
        
        if (chunk.includes(startMarker)) {
          capturing = true;
          // Remove everything up to and including the start marker
          const parts = chunk.split(startMarker);
          if (parts[1]) {
            stdout += parts[1];
          }
          return;
        }
        
        if (capturing) {
          if (chunk.includes(endMarker)) {
            // Capture up to the end marker
            const parts = chunk.split(endMarker);
            stdout += parts[0];
            
            // Extract exit code from marker line
            const exitMatch = chunk.match(new RegExp(`${endMarker}:(\\d+)`));
            const exitCode = exitMatch ? parseInt(exitMatch[1]) : 0;
            
            // Clean up and resolve
            this.shell?.stdout?.off('data', onStdout);
            this.shell?.stderr?.off('data', onStderr);
            
            resolve({ stdout, stderr, exitCode });
            capturing = false;
          } else {
            stdout += chunk;
          }
        }
      };
      
      const onStderr = (data: Buffer) => {
        if (capturing) {
          stderr += data.toString();
        }
      };
      
      // Set up listeners
      this.shell.stdout?.on('data', onStdout);
      this.shell.stderr?.on('data', onStderr);
      
      // Execute command with markers
      const wrappedCommand = `
echo ${startMarker}
${command}
EXIT_CODE=$?
echo "${endMarker}:\${EXIT_CODE}"
`;
      
      this.shell.stdin?.write(wrappedCommand);
      
      // Timeout protection
      setTimeout(() => {
        if (capturing) {
          this.shell?.stdout?.off('data', onStdout);
          this.shell?.stderr?.off('data', onStderr);
          reject(new Error(`Command timeout: ${command}`));
        }
      }, 30000);
    });
  }
  
  destroy(): void {
    if (this.shell) {
      this.shell.kill('SIGTERM');
      this.shell = null;
      this.ready = false;
    }
  }
}

/**
 * Simple context manager
 */
export class SimpleContextManager {
  private contexts = new Map<string, SimpleContext>();
  
  async createContext(options: ContextOptions): Promise<SimpleContext> {
    // Clean up existing context with same name
    const existing = this.contexts.get(options.name);
    if (existing) {
      existing.destroy();
    }
    
    const context = new SimpleContext(options);
    await context.initialize();
    this.contexts.set(options.name, context);
    return context;
  }
  
  getContext(name: string): SimpleContext | undefined {
    return this.contexts.get(name);
  }
  
  async exec(command: string): Promise<ExecResult> {
    let defaultCtx = this.contexts.get('default');
    if (!defaultCtx) {
      defaultCtx = await this.createContext({ name: 'default' });
    }
    return defaultCtx.exec(command);
  }
  
  destroyAll(): void {
    for (const context of this.contexts.values()) {
      context.destroy();
    }
    this.contexts.clear();
  }
}

// That's it! ~200 lines, Linux does all the work!