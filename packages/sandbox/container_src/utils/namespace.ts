import { spawn, execSync, type ChildProcess } from 'child_process';
import type { ExecOptions, ExecResult } from '../types';

/**
 * Executes a command in an isolated PID namespace
 * This hides the control plane (Jupyter/Bun) from user commands
 */
export async function execInNamespace(
  command: string,
  options?: ExecOptions
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    // Wrap command in unshare to create isolated namespace
    const isolatedCommand = [
      'unshare',
      '--pid',        // Separate PID namespace
      '--fork',       // Fork before exec
      '--mount-proc', // Mount new /proc (hides host processes)
      'bash', '-c',
      command
    ];
    
    const childProcess = spawn(isolatedCommand[0], isolatedCommand.slice(1), {
      env: options?.env || process.env,
      cwd: options?.cwd || '/workspace',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    childProcess.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    
    childProcess.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    childProcess.on('error', (error) => {
      reject(error);
    });
    
    childProcess.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code || 0
      });
    });
  });
}

/**
 * Creates a persistent namespace session for stateful command execution
 */
export class PersistentNamespace {
  private process: ChildProcess | null = null;
  private ready = false;
  private commandQueue: Array<{
    command: string;
    resolve: (result: ExecResult) => void;
    reject: (error: Error) => void;
  }> = [];
  
  constructor(
    private name: string,
    private env: Record<string, string>,
    private cwd: string
  ) {}
  
  async initialize(): Promise<void> {
    // Start a long-lived bash process in an isolated namespace
    this.process = spawn('unshare', [
      '--pid',        // Separate PID namespace
      '--fork',       // Fork before exec
      '--mount-proc', // Mount new /proc
      'bash',         // Interactive bash session
      '--norc'        // Don't load .bashrc
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...this.env,
        PS1: `[${this.name}]$ `,
        HOME: '/workspace',
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
      }
    });
    
    // Wait for bash to be ready
    await this.waitForPrompt();
    
    // Initialize working directory
    if (this.cwd !== '/workspace') {
      await this.exec(`cd ${this.cwd}`);
    }
    
    // Set initial environment variables
    for (const [key, value] of Object.entries(this.env)) {
      await this.exec(`export ${key}="${value}"`);
    }
    
    this.ready = true;
  }
  
  private async waitForPrompt(): Promise<void> {
    return new Promise((resolve) => {
      const checkReady = () => {
        // Send a simple echo command to check if bash is ready
        this.process?.stdin?.write('echo "READY"\n');
        
        const onData = (data: Buffer) => {
          if (data.toString().includes('READY')) {
            this.process?.stdout?.removeListener('data', onData);
            resolve();
          }
        };
        
        this.process?.stdout?.on('data', onData);
      };
      
      // Give bash a moment to start
      setTimeout(checkReady, 100);
    });
  }
  
  async exec(command: string): Promise<ExecResult> {
    if (!this.ready || !this.process) {
      throw new Error(`Namespace ${this.name} not initialized`);
    }
    
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let completed = false;
      
      // Add unique marker to know when command is done
      const marker = `__NAMESPACE_EXEC_${Date.now()}__`;
      const fullCommand = `${command}; echo "${marker}:$?"`; 
      
      const onStdout = (data: Buffer) => {
        const output = data.toString();
        
        // Check for completion marker
        const markerMatch = output.match(new RegExp(`${marker}:(\\d+)`));
        if (markerMatch) {
          completed = true;
          const exitCode = parseInt(markerMatch[1]);
          
          // Remove marker from output
          stdout = stdout.replace(new RegExp(`${marker}:\\d+\\n?`), '');
          
          // Clean up listeners
          this.process?.stdout?.removeListener('data', onStdout);
          this.process?.stderr?.removeListener('data', onStderr);
          
          resolve({ stdout, stderr, exitCode });
        } else {
          stdout += output;
        }
      };
      
      const onStderr = (data: Buffer) => {
        stderr += data.toString();
      };
      
      this.process.stdout?.on('data', onStdout);
      this.process.stderr?.on('data', onStderr);
      
      // Send command
      this.process.stdin?.write(fullCommand + '\n');
      
      // Timeout after 30 seconds
      setTimeout(() => {
        if (!completed) {
          this.process?.stdout?.removeListener('data', onStdout);
          this.process?.stderr?.removeListener('data', onStderr);
          reject(new Error(`Command timeout: ${command}`));
        }
      }, 30000);
    });
  }
  
  async cd(path: string): Promise<void> {
    await this.exec(`cd ${path}`);
    this.cwd = path;
  }
  
  async setEnv(vars: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(vars)) {
      await this.exec(`export ${key}="${value}"`);
    }
    this.env = { ...this.env, ...vars };
  }
  
  async pwd(): Promise<string> {
    const result = await this.exec('pwd');
    return result.stdout.trim();
  }
  
  destroy(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.ready = false;
  }
}

/**
 * Tests if namespace creation is available (requires CAP_SYS_ADMIN)
 */
export function canCreateNamespaces(): boolean {
  try {
    execSync('unshare --pid --fork true', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}