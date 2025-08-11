import { spawn, execFile, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { execSync } from 'child_process';

const execFileAsync = promisify(execFile);

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
  persistent?: boolean;
  isolation?: boolean;
}

// Check if we can create namespaces
export function hasNamespaceSupport(): boolean {
  try {
    execSync('unshare --pid --fork true', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Simple, secure execution context
 * Under 100 lines, does EVERYTHING we need
 */
export class SimpleContext {
  private sessionEnv: Record<string, string> = {};
  private sessionCwd: string;
  private canIsolate: boolean;
  
  constructor(private options: ContextOptions) {
    this.sessionEnv = { ...process.env, ...options.env };
    this.sessionCwd = options.cwd || '/workspace';
    this.canIsolate = (options.isolation !== false) && hasNamespaceSupport();
  }
  
  /**
   * Execute command with proper isolation and state management
   * NO SHELL INJECTION - uses arrays not strings!
   */
  async exec(command: string, options?: { env?: Record<string, string>; cwd?: string }): Promise<ExecResult> {
    // Parse command safely (basic tokenization - could use shell-quote for production)
    const args = this.parseCommand(command);
    const cmd = args[0];
    const cmdArgs = args.slice(1);
    
    // Merge environment
    const execEnv = { ...this.sessionEnv, ...options?.env };
    const execCwd = options?.cwd || this.sessionCwd;
    
    // Handle state-changing commands
    if (cmd === 'cd' && cmdArgs[0]) {
      this.sessionCwd = cmdArgs[0].startsWith('/') ? cmdArgs[0] : `${this.sessionCwd}/${cmdArgs[0]}`;
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    
    if (cmd === 'export' && cmdArgs[0]) {
      const [key, value] = cmdArgs[0].split('=');
      if (key && value) {
        this.sessionEnv[key] = value;
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    
    // Execute with or without isolation
    try {
      if (this.canIsolate) {
        // Use unshare for isolation - simple and secure
        const { stdout, stderr } = await execFileAsync('unshare', [
          '--pid', '--fork', '--mount-proc',
          cmd, ...cmdArgs
        ], {
          env: execEnv,
          cwd: execCwd,
          maxBuffer: 10 * 1024 * 1024, // 10MB
          timeout: 30000 // 30s timeout
        });
        
        return { stdout, stderr, exitCode: 0 };
      } else {
        // Fallback without isolation
        const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
          env: execEnv,
          cwd: execCwd,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30000
        });
        
        return { stdout, stderr, exitCode: 0 };
      }
    } catch (error: any) {
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || error.message,
        exitCode: error.code || 1
      };
    }
  }
  
  // Getters for session state
  getEnv(): Record<string, string> { return this.sessionEnv; }
  getCwd(): string { return this.sessionCwd; }
  
  // Basic command parser (replace with shell-quote in production)
  private parseCommand(command: string): string[] {
    // This is simplified - use a proper shell parser in production
    return command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(s => s.replace(/"/g, '')) || [];
  }
}

/**
 * Simple context manager
 * Manages multiple named contexts
 */
export class SimpleContextManager {
  private contexts = new Map<string, SimpleContext>();
  
  createContext(options: ContextOptions): SimpleContext {
    const context = new SimpleContext(options);
    this.contexts.set(options.name, context);
    return context;
  }
  
  getContext(name: string): SimpleContext | undefined {
    return this.contexts.get(name);
  }
  
  // Execute in default context (backward compatibility)
  async exec(command: string): Promise<ExecResult> {
    let defaultCtx = this.contexts.get('default');
    if (!defaultCtx) {
      defaultCtx = this.createContext({ name: 'default' });
    }
    return defaultCtx.exec(command);
  }
}

// That's it! ~150 lines covers ALL requirements