import { spawn, execSync, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';

// Types
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SessionOptions {
  name: string;
  env?: Record<string, string>;
  cwd?: string;
  isolation?: boolean;
}

// Cache the namespace support check
let namespaceSupport: boolean | null = null;

// Check if we can create namespaces
export function hasNamespaceSupport(): boolean {
  // Return cached result if available
  if (namespaceSupport !== null) {
    return namespaceSupport;
  }
  
  try {
    // Actually test if unshare works
    execSync('unshare --pid --fork --mount-proc true', { 
      stdio: 'ignore',
      timeout: 1000
    });
    console.log('[Session] Namespace support detected (CAP_SYS_ADMIN available) - isolation enabled');
    namespaceSupport = true;
    return true;
  } catch (error) {
    console.log('[Session] No namespace support (CAP_SYS_ADMIN not available) - isolation disabled');
    namespaceSupport = false;
    return false;
  }
}

/**
 * Linux-native execution session
 * Uses bash for state management, but safely!
 */
export class SimpleSession {
  private shell: ChildProcess | null = null;
  private ready = false;
  private canIsolate: boolean;
  
  constructor(private options: SessionOptions) {
    // Only try isolation if explicitly requested and supported
    this.canIsolate = (options.isolation === true) && hasNamespaceSupport();
    if (options.isolation === true && !this.canIsolate) {
      console.log(`[Session] Isolation requested for '${options.name}' but not available - using regular bash`);
    }
  }
  
  async initialize(): Promise<void> {
    // Start bash with or without isolation
    const shellCommand = this.canIsolate
      ? ['unshare', '--pid', '--fork', '--mount-proc', 'bash', '--norc', '-i']
      : ['bash', '--norc', '-i'];
    
    console.log(`[Session] Initializing session '${this.options.name}' ${this.canIsolate ? 'WITH isolation' : 'WITHOUT isolation'}`);
    
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
    
    // Handle shell errors
    this.shell.on('error', (error) => {
      console.error(`[Session] Shell process error for '${this.options.name}':`, error);
    });
    
    // Wait for shell to be ready
    await this.waitForReady();
    this.ready = true;
    console.log(`[Session] Session '${this.options.name}' initialized successfully`);
  }
  
  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.log(`[Session] Shell initialization timeout for '${this.options.name}' - proceeding anyway`);
        // Don't reject - just mark as ready anyway
        // The shell might still work, just took longer to initialize
        this.shell?.stdout?.off('data', onData);
        this.shell?.stderr?.off('data', onError);
        resolve();
      }, 3000); // Reduced to 3 seconds - faster fallback
      
      const marker = `READY_${randomUUID()}`;
      let output = '';
      let errorOutput = '';
      
      const onData = (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        console.log(`[Session] Shell stdout: ${chunk.trim()}`);
        if (output.includes(marker)) {
          console.log(`[Session] Ready marker received for '${this.options.name}'`);
          clearTimeout(timeout);
          this.shell?.stdout?.off('data', onData);
          this.shell?.stderr?.off('data', onError);
          resolve();
        }
      };
      
      const onError = (data: Buffer) => {
        errorOutput += data.toString();
        console.error(`[Session] Shell stderr: ${data.toString().trim()}`);
      };
      
      if (!this.shell) {
        clearTimeout(timeout);
        reject(new Error('Shell not initialized'));
        return;
      }
      
      this.shell.stdout?.on('data', onData);
      this.shell.stderr?.on('data', onError);
      
      // Send the ready marker immediately
      const cmd = `echo ${marker}\n`;
      console.log(`[Session] Sending ready marker: ${cmd.trim()}`);
      this.shell.stdin?.write(cmd);
    });
  }
  
  /**
   * Execute command in the shell session
   * The shell maintains pwd, env vars, background processes, etc.
   */
  async exec(command: string): Promise<ExecResult> {
    if (!this.ready || !this.shell) {
      throw new Error(`Session '${this.options.name}' not initialized`);
    }
    
    console.log(`[Session] Executing command in session '${this.options.name}': ${command}`);
    
    return new Promise((resolve, reject) => {
      const execId = randomUUID();
      const startMarker = `START_${execId}`;
      const endMarker = `END_${execId}`;
      
      let capturing = false;
      let stdoutBuffer = '';
      let stderrBuffer = '';
      
      const onStdout = (data: Buffer) => {
        const chunk = data.toString();
        
        // Check if both markers are in the same chunk
        if (chunk.includes(startMarker) && chunk.includes(endMarker)) {
          // Extract content between markers
          const startIdx = chunk.indexOf(startMarker) + startMarker.length;
          const endIdx = chunk.indexOf(endMarker);
          stdoutBuffer = chunk.substring(startIdx, endIdx);
          
          // Extract exit code from marker line
          const exitMatch = chunk.match(new RegExp(`${endMarker}:(\\d+)`));
          const exitCode = exitMatch ? parseInt(exitMatch[1]) : 0;
          
          // Clean up and resolve
          this.shell?.stdout?.off('data', onStdout);
          this.shell?.stderr?.off('data', onStderr);
          clearTimeout(timeoutId);
          
          resolve({ stdout: stdoutBuffer.trim(), stderr: stderrBuffer, exitCode });
          return;
        }
        
        if (chunk.includes(startMarker)) {
          capturing = true;
          // Remove everything up to and including the start marker
          const parts = chunk.split(startMarker);
          if (parts[1]) {
            stdoutBuffer += parts[1];
          }
          return;
        }
        
        if (capturing) {
          if (chunk.includes(endMarker)) {
            // Capture up to the end marker
            const parts = chunk.split(endMarker);
            stdoutBuffer += parts[0];
            
            // Extract exit code from marker line
            const exitMatch = chunk.match(new RegExp(`${endMarker}:(\\d+)`));
            const exitCode = exitMatch ? parseInt(exitMatch[1]) : 0;
            
            // Clean up and resolve
            this.shell?.stdout?.off('data', onStdout);
            this.shell?.stderr?.off('data', onStderr);
            clearTimeout(timeoutId);
            
            resolve({ stdout: stdoutBuffer.trim(), stderr: stderrBuffer, exitCode });
            capturing = false;
          } else {
            stdoutBuffer += chunk;
          }
        }
      };
      
      const onStderr = (data: Buffer) => {
        if (capturing) {
          stderrBuffer += data.toString();
        }
      };
      
      // Set up listeners
      if (this.shell && this.shell.stdout) {
        this.shell.stdout.on('data', onStdout);
      }
      if (this.shell && this.shell.stderr) {
        this.shell.stderr.on('data', onStderr);
      }
      
      // Execute command with markers
      const wrappedCommand = `
echo ${startMarker}
${command}
EXIT_CODE=$?
echo "${endMarker}:\${EXIT_CODE}"
`;
      
      if (this.shell && this.shell.stdin) {
        console.log(`[Session] Sending command to shell in '${this.options.name}'`);
        this.shell.stdin.write(wrappedCommand);
      } else {
        console.error(`[Session] Shell stdin not available for '${this.options.name}'`);
        reject(new Error('Shell stdin not available'));
        return;
      }
      
      // Timeout protection
      const timeoutId = setTimeout(() => {
        if (capturing) {
          console.error(`[Session] Command timeout in session '${this.options.name}': ${command}`);
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
 * Simple session manager
 */
export class SimpleSessionManager {
  private sessions = new Map<string, SimpleSession>();
  
  async createSession(options: SessionOptions): Promise<SimpleSession> {
    // Clean up existing session with same name
    const existing = this.sessions.get(options.name);
    if (existing) {
      existing.destroy();
    }
    
    // Create session (isolation will be auto-detected)
    const session = new SimpleSession(options);
    await session.initialize();
    
    this.sessions.set(options.name, session);
    console.log(`[SessionManager] Created session '${options.name}'`);
    return session;
  }
  
  getSession(name: string): SimpleSession | undefined {
    return this.sessions.get(name);
  }
  
  listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }
  
  async exec(command: string): Promise<ExecResult> {
    let defaultSession = this.sessions.get('default');
    if (!defaultSession) {
      defaultSession = await this.createSession({ name: 'default' });
    }
    return defaultSession.exec(command);
  }
  
  destroyAll(): void {
    for (const session of this.sessions.values()) {
      session.destroy();
    }
    this.sessions.clear();
  }
}

// That's it! ~200 lines, Linux does all the work!