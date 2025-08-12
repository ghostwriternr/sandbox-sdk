import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

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

interface ControlMessage {
  type: 'exec' | 'exit';
  id: string;
  command?: string;
}

interface ControlResponse {
  type: 'result' | 'error' | 'ready';
  id: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
}

// Cache the namespace support check
let namespaceSupport: boolean | null = null;

// Check if we can create namespaces
export function hasNamespaceSupport(): boolean {
  if (namespaceSupport !== null) {
    return namespaceSupport;
  }
  
  try {
    // Actually test if unshare works
    const { execSync } = require('child_process');
    execSync('unshare --pid --fork --mount-proc true', { 
      stdio: 'ignore',
      timeout: 1000
    });
    console.log('[Isolation] Namespace support detected (CAP_SYS_ADMIN available)');
    namespaceSupport = true;
    return true;
  } catch (error) {
    console.log('[Isolation] No namespace support (CAP_SYS_ADMIN not available)');
    namespaceSupport = false;
    return false;
  }
}

/**
 * Production-ready session with two-process architecture
 * Control process manages I/O via files, shell maintains state
 */
export class Session {
  private control: ChildProcess | null = null;
  private ready = false;
  private canIsolate: boolean;
  private pendingCallbacks = new Map<string, {
    resolve: (result: ExecResult) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  
  constructor(private options: SessionOptions) {
    this.canIsolate = (options.isolation === true) && hasNamespaceSupport();
    if (options.isolation === true && !this.canIsolate) {
      console.log(`[Session] Isolation requested for '${options.name}' but not available`);
    }
  }
  
  async initialize(): Promise<void> {
    const controlScript = this.createControlScript();
    
    // Write control script to temp file
    const scriptPath = `/tmp/control_${randomUUID()}.js`;
    await fs.writeFile(scriptPath, controlScript, 'utf8');
    
    // Start control process
    this.control = spawn('node', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SESSION_NAME: this.options.name,
        SESSION_CWD: this.options.cwd || '/workspace',
        SESSION_ISOLATED: this.canIsolate ? '1' : '0',
        ...this.options.env
      }
    });
    
    // Handle control process output
    this.control.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: ControlResponse = JSON.parse(line);
          this.handleControlMessage(msg);
        } catch (e) {
          console.error(`[Session] Failed to parse control message: ${line}`);
        }
      }
    });
    
    // Handle control process errors
    this.control.stderr?.on('data', (data: Buffer) => {
      console.error(`[Session] Control stderr for '${this.options.name}': ${data.toString()}`);
    });
    
    this.control.on('error', (error) => {
      console.error(`[Session] Control process error for '${this.options.name}':`, error);
      this.cleanup(error);
    });
    
    this.control.on('exit', (code) => {
      console.log(`[Session] Control process exited for '${this.options.name}' with code ${code}`);
      this.cleanup(new Error(`Control process exited with code ${code}`));
    });
    
    // Wait for ready signal
    await this.waitForReady();
    
    // Clean up temp script
    await fs.unlink(scriptPath).catch(() => {});
    
    console.log(`[Session] Session '${this.options.name}' initialized successfully`);
  }
  
  private createControlScript(): string {
    return `
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Parse environment
const sessionName = process.env.SESSION_NAME || 'default';
const sessionCwd = process.env.SESSION_CWD || '/workspace';
const isIsolated = process.env.SESSION_ISOLATED === '1';

console.error(\`[Control] Starting control process for session '\${sessionName}'\`);

// Start the shell with or without isolation
const shellCommand = isIsolated
  ? ['unshare', '--pid', '--fork', '--mount-proc', 'bash', '--norc']
  : ['bash', '--norc'];

const shell = spawn(shellCommand[0], shellCommand.slice(1), {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: sessionCwd,
  env: process.env
});

// Track shell health
let shellAlive = true;

shell.on('error', (error) => {
  console.error('[Control] Shell error:', error);
  shellAlive = false;
  process.stdout.write(JSON.stringify({
    type: 'error',
    id: 'shell',
    error: error.message
  }) + '\\n');
});

shell.on('exit', (code) => {
  console.error(\`[Control] Shell exited with code \${code}\`);
  shellAlive = false;
  process.exit(code || 1);
});

// Send ready signal
process.stdout.write(JSON.stringify({ type: 'ready', id: 'init' }) + '\\n');

// Handle commands from parent
process.stdin.on('data', async (data) => {
  const lines = data.toString().split('\\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    
    try {
      const msg = JSON.parse(line);
      
      if (msg.type === 'exit') {
        shell.kill('SIGTERM');
        process.exit(0);
      }
      
      if (msg.type === 'exec' && msg.command) {
        if (!shellAlive) {
          process.stdout.write(JSON.stringify({
            type: 'error',
            id: msg.id,
            error: 'Shell is not alive'
          }) + '\\n');
          continue;
        }
        
        // Create temp files for this command
        const cmdFile = \`/tmp/cmd_\${msg.id}.sh\`;
        const outFile = \`/tmp/out_\${msg.id}\`;
        const errFile = \`/tmp/err_\${msg.id}\`;
        const exitFile = \`/tmp/exit_\${msg.id}\`;
        
        // Write command to file
        fs.writeFileSync(cmdFile, msg.command, 'utf8');
        
        // Execute command with file redirection
        // Use 'source' to execute in current shell context (preserves pwd, env, etc)
        const execScript = \`
# Execute command with output redirection in current shell
source \${cmdFile} > \${outFile} 2> \${errFile}
echo $? > \${exitFile}
echo "DONE:\${msg.id}"
\`;
        
        shell.stdin.write(execScript);
        
        // Set up listener for completion
        const onData = (chunk) => {
          const output = chunk.toString();
          if (output.includes(\`DONE:\${msg.id}\`)) {
            shell.stdout.off('data', onData);
            
            try {
              // Read results
              const stdout = fs.readFileSync(outFile, 'utf8');
              const stderr = fs.readFileSync(errFile, 'utf8');
              const exitCode = parseInt(fs.readFileSync(exitFile, 'utf8').trim());
              
              // Send response
              process.stdout.write(JSON.stringify({
                type: 'result',
                id: msg.id,
                stdout,
                stderr,
                exitCode
              }) + '\\n');
              
              // Cleanup temp files
              fs.unlinkSync(cmdFile);
              fs.unlinkSync(outFile);
              fs.unlinkSync(errFile);
              fs.unlinkSync(exitFile);
            } catch (error) {
              process.stdout.write(JSON.stringify({
                type: 'error',
                id: msg.id,
                error: \`Failed to read output: \${error.message}\`
              }) + '\\n');
            }
          }
        };
        
        shell.stdout.on('data', onData);
        
        // Timeout protection
        setTimeout(() => {
          shell.stdout.off('data', onData);
          process.stdout.write(JSON.stringify({
            type: 'error',
            id: msg.id,
            error: 'Command timeout after 30 seconds'
          }) + '\\n');
          
          // Try to cleanup files
          try {
            fs.unlinkSync(cmdFile);
            fs.unlinkSync(outFile);
            fs.unlinkSync(errFile);
            fs.unlinkSync(exitFile);
          } catch (e) {}
        }, 30000);
      }
    } catch (e) {
      console.error('[Control] Failed to parse command:', e);
    }
  }
});

// Keep process alive
process.stdin.resume();
`;
  }
  
  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Control process initialization timeout'));
      }, 5000);
      
      const checkReady = (msg: ControlResponse) => {
        if (msg.type === 'ready' && msg.id === 'init') {
          clearTimeout(timeout);
          this.ready = true;
          resolve();
        }
      };
      
      // Temporarily store the ready handler
      const originalHandler = this.handleControlMessage;
      this.handleControlMessage = (msg) => {
        checkReady(msg);
        originalHandler.call(this, msg);
      };
    });
  }
  
  private handleControlMessage(msg: ControlResponse): void {
    if (msg.type === 'ready' && msg.id === 'init') {
      this.ready = true;
      return;
    }
    
    const callback = this.pendingCallbacks.get(msg.id);
    if (!callback) return;
    
    clearTimeout(callback.timeout);
    this.pendingCallbacks.delete(msg.id);
    
    if (msg.type === 'error') {
      callback.reject(new Error(msg.error || 'Unknown error'));
    } else if (msg.type === 'result') {
      callback.resolve({
        stdout: msg.stdout || '',
        stderr: msg.stderr || '',
        exitCode: msg.exitCode || 0
      });
    }
  }
  
  private cleanup(error?: Error): void {
    // Reject all pending callbacks
    for (const [id, callback] of this.pendingCallbacks) {
      clearTimeout(callback.timeout);
      callback.reject(error || new Error('Session terminated'));
    }
    this.pendingCallbacks.clear();
    
    // Kill control process if still running
    if (this.control && !this.control.killed) {
      this.control.kill('SIGTERM');
    }
    
    this.control = null;
    this.ready = false;
  }
  
  async exec(command: string): Promise<ExecResult> {
    if (!this.ready || !this.control) {
      throw new Error(`Session '${this.options.name}' not initialized`);
    }
    
    const id = randomUUID();
    
    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingCallbacks.delete(id);
        reject(new Error(`Command timeout: ${command}`));
      }, 30000);
      
      // Store callback
      this.pendingCallbacks.set(id, { resolve, reject, timeout });
      
      // Send command to control process
      const msg: ControlMessage = { type: 'exec', id, command };
      this.control!.stdin?.write(JSON.stringify(msg) + '\n');
    });
  }
  
  destroy(): void {
    if (this.control) {
      // Send exit command
      const msg: ControlMessage = { type: 'exit', id: 'destroy' };
      this.control.stdin?.write(JSON.stringify(msg) + '\n');
      
      // Give it a moment to exit cleanly
      setTimeout(() => {
        if (this.control && !this.control.killed) {
          this.control.kill('SIGTERM');
        }
      }, 100);
      
      this.cleanup();
    }
  }
}

/**
 * Session manager
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  
  async createSession(options: SessionOptions): Promise<Session> {
    // Clean up existing session with same name
    const existing = this.sessions.get(options.name);
    if (existing) {
      existing.destroy();
    }
    
    // Create new session
    const session = new Session(options);
    await session.initialize();
    
    this.sessions.set(options.name, session);
    console.log(`[SessionManager] Created session '${options.name}'`);
    return session;
  }
  
  getSession(name: string): Session | undefined {
    return this.sessions.get(name);
  }
  
  listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }
  
  async exec(command: string): Promise<ExecResult> {
    let defaultSession = this.sessions.get('default');
    if (!defaultSession) {
      defaultSession = await this.createSession({ 
        name: 'default',
        isolation: true 
      });
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