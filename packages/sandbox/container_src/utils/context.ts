import { spawn, ChildProcess, execSync } from 'child_process';
import { Readable, Writable } from 'stream';
import { PersistentNamespace, execInNamespace, canCreateNamespaces } from './namespace';

export interface ContextOptions {
  name: string;
  env?: Record<string, string>;
  cwd?: string;
  persistent?: boolean;
  isolation?: 'none' | 'secure';
  childContext?: string;
}

export interface ExecOptions {
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface Process {
  id: string;
  pid?: number;
  kill: () => Promise<void>;
  stdin?: Writable;
  stdout?: Readable;
  stderr?: Readable;
}

export class ExecutionContext {
  private name: string;
  private env: Record<string, string>;
  private cwd: string;
  private shellProcess?: ChildProcess;
  private persistentNamespace?: PersistentNamespace;
  private childContext?: string;
  private persistent: boolean;
  private isolation: 'none' | 'secure';
  private hasNamespaces: boolean;
  
  constructor(options: ContextOptions) {
    this.name = options.name;
    this.env = options.env || {};
    this.cwd = options.cwd || '/workspace';
    this.childContext = options.childContext;
    this.persistent = options.persistent ?? true;
    this.isolation = options.isolation || 'secure';
    this.hasNamespaces = canCreateNamespaces();
  }
  
  async initialize(): Promise<void> {
    // Create persistent namespace if isolation is enabled and we have capabilities
    if (this.persistent && this.isolation === 'secure' && this.hasNamespaces) {
      console.log(`[ExecutionContext:${this.name}] Creating persistent namespace session`);
      this.persistentNamespace = new PersistentNamespace(this.name, this.env, this.cwd);
      await this.persistentNamespace.initialize();
    } 
    // Fallback to regular shell if no namespace capabilities
    else if (this.persistent) {
      await this.createShell();
    }
  }
  
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    console.log(`[ExecutionContext:${this.name}] exec: ${command}, persistent=${this.persistent}, hasNamespace=${!!this.persistentNamespace}`);
    
    // Enable universal routing for AI agents
    if (this.childContext && this.isAIAgent(command)) {
      // ALL child processes will route to childContext
      return await this.execWithRouting(command, options);
    }
    
    // Use persistent namespace if available (maintains state + isolation)
    if (this.persistentNamespace) {
      console.log(`[ExecutionContext:${this.name}] Using persistent namespace session`);
      return await this.persistentNamespace.exec(command);
    }
    
    // Use namespace isolation for non-persistent secure contexts
    if (this.isolation === 'secure' && this.hasNamespaces && !this.persistent) {
      console.log(`[ExecutionContext:${this.name}] Using isolated namespace (stateless)`);
      return await execInNamespace(command, {
        env: { ...this.env, ...options?.env },
        cwd: options?.cwd || this.cwd,
        timeout: options?.timeout
      });
    }
    
    // Fallback to shell or direct execution
    if (this.shellProcess && this.persistent) {
      console.log(`[ExecutionContext:${this.name}] Using persistent shell (no isolation)`);
      return await this.execInShell(command, options);
    } else {
      console.log(`[ExecutionContext:${this.name}] Using direct exec, env keys:`, Object.keys(this.env));
      return await this.execDirect(command, options);
    }
  }
  
  async execStream(command: string, options?: ExecOptions): Promise<Readable> {
    const env = {
      ...this.env,
      ...options?.env
    };
    
    // Enable routing if needed
    if (this.childContext && this.isAIAgent(command)) {
      env.LD_PRELOAD = '/lib/universal_router.so';
      env.SANDBOX_ROUTE_TO_CONTEXT = this.childContext;
    }
    
    const child = spawn('sh', ['-c', command], {
      env,
      cwd: options?.cwd || this.cwd
    });
    
    return child.stdout!;
  }
  
  async startProcess(command: string, options?: ExecOptions): Promise<Process> {
    const env = {
      ...this.env,
      ...options?.env
    };
    
    // Enable routing if needed
    if (this.childContext && this.isAIAgent(command)) {
      env.LD_PRELOAD = '/lib/universal_router.so';
      env.SANDBOX_ROUTE_TO_CONTEXT = this.childContext;
    }
    
    const child = spawn('sh', ['-c', command], {
      env,
      cwd: options?.cwd || this.cwd,
      detached: true
    });
    
    const processId = `proc_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    return {
      id: processId,
      pid: child.pid,
      kill: async () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch (e) {
            // Process might already be dead
          }
        }
      },
      stdin: child.stdin || undefined,
      stdout: child.stdout || undefined,
      stderr: child.stderr || undefined
    };
  }
  
  private async execWithRouting(command: string, options?: ExecOptions): Promise<ExecResult> {
    // Enable LD_PRELOAD universal routing
    const envWithRouting = {
      ...this.env,
      ...options?.env,
      LD_PRELOAD: '/lib/universal_router.so',
      SANDBOX_ROUTE_TO_CONTEXT: this.childContext!
    };
    
    return this.execDirect(command, { ...options, env: envWithRouting });
  }
  
  private isAIAgent(command: string): boolean {
    // Detect AI agent commands that need routing
    const aiAgents = ['claude', 'gemini', 'gpt', 'copilot', 'ai', 'llm'];
    const lowerCommand = command.toLowerCase();
    return aiAgents.some(agent => lowerCommand.includes(agent));
  }
  
  private async createShell(): Promise<void> {
    // Create a persistent bash shell for this context
    // Start with a clean environment, only including the context's env vars
    this.shellProcess = spawn('bash', ['--norc', '--noprofile'], {
      env: {
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: process.env.HOME || '/root',
        USER: process.env.USER || 'root',
        ...this.env  // Context's environment variables override defaults
      },
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    // Ensure streams exist
    if (!this.shellProcess.stdin || !this.shellProcess.stdout || !this.shellProcess.stderr) {
      throw new Error('Failed to create shell process with proper stdio streams');
    }
    
    // Wait for shell to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Shell initialization timeout'));
      }, 5000);
      
      const stdout = this.shellProcess?.stdout;
      if (!stdout) {
        clearTimeout(timeout);
        reject(new Error('Shell stdout not available'));
        return;
      }
      
      const onData = (data: Buffer) => {
        const str = data.toString();
        if (str.includes('SHELL_READY')) {
          clearTimeout(timeout);
          stdout.off('data', onData);
          resolve();
        }
      };
      
      stdout.on('data', onData);
      
      const stdin = this.shellProcess?.stdin;
      if (!stdin) {
        clearTimeout(timeout);
        reject(new Error('Shell stdin not available'));
        return;
      }
      
      stdin.write('echo SHELL_READY\n');
    });
    
    // Set working directory
    if (this.cwd !== '/workspace') {
      await this.execInShell(`cd ${this.cwd}`);
    }
  }
  
  private async execInShell(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (!this.shellProcess || !this.shellProcess.stdin || !this.shellProcess.stdout) {
      throw new Error('Shell process not properly initialized');
    }
    
    const stdin = this.shellProcess.stdin;
    const stdout = this.shellProcess.stdout;
    
    return new Promise((resolve, reject) => {
      const marker = `END_OF_COMMAND_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      let outputBuffer = '';
      let stderr = '';
      
      const timeout = setTimeout(() => {
        stdout.off('data', onData);
        reject(new Error(`Command timeout: ${command}`));
      }, options?.timeout || 30000);
      
      const onData = (data: Buffer) => {
        const str = data.toString();
        outputBuffer += str;
        
        if (outputBuffer.includes(marker)) {
          clearTimeout(timeout);
          stdout.off('data', onData);
          const output = outputBuffer.split(marker)[0].trim();
          resolve({ stdout: output, stderr, exitCode: 0 });
        }
      };
      
      stdout.on('data', onData);
      
      // Apply any environment overrides for this command
      if (options?.env) {
        for (const [key, value] of Object.entries(options.env)) {
          stdin.write(`export ${key}="${value}"\n`);
        }
      }
      
      // Execute command and echo marker when done
      stdin.write(`${command}\necho ${marker}\n`);
    });
  }
  
  private async execDirect(command: string, options?: ExecOptions): Promise<ExecResult> {
    try {
      const result = execSync(command, {
        env: {
          ...this.env,
          ...options?.env
        },
        cwd: options?.cwd || this.cwd,
        encoding: 'utf8',
        timeout: options?.timeout
      });
      
      return {
        stdout: result.toString(),
        stderr: '',
        exitCode: 0
      };
    } catch (error: any) {
      return {
        stdout: error.stdout?.toString() || '',
        stderr: error.stderr?.toString() || error.message,
        exitCode: error.status || 1
      };
    }
  }
  
  async cd(path: string): Promise<void> {
    this.cwd = path;
    if (this.persistentNamespace) {
      await this.persistentNamespace.cd(path);
    } else if (this.shellProcess) {
      await this.execInShell(`cd ${path}`);
    }
  }
  
  async setEnv(vars: Record<string, string>): Promise<void> {
    this.env = { ...this.env, ...vars };
    if (this.persistentNamespace) {
      await this.persistentNamespace.setEnv(vars);
    } else if (this.shellProcess) {
      for (const [key, value] of Object.entries(vars)) {
        await this.execInShell(`export ${key}="${value}"`);
      }
    }
  }
  
  async getEnv(key?: string): Promise<Record<string, string> | string> {
    if (key) {
      return this.env[key] || '';
    }
    return this.env;
  }
  
  async pwd(): Promise<string> {
    if (this.persistentNamespace) {
      return await this.persistentNamespace.pwd();
    } else if (this.shellProcess) {
      const result = await this.execInShell('pwd');
      return result.stdout.trim();
    }
    return this.cwd;
  }
  
  setChildContext(context: string): void {
    this.childContext = context;
  }
  
  getName(): string {
    return this.name;
  }
  
  async destroy(): Promise<void> {
    if (this.persistentNamespace) {
      this.persistentNamespace.destroy();
      this.persistentNamespace = undefined;
    }
    if (this.shellProcess) {
      this.shellProcess.kill('SIGTERM');
      this.shellProcess = undefined;
    }
  }
}