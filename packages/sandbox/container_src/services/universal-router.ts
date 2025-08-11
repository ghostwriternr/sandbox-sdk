import { createServer, Socket } from 'net';
import { spawn } from 'child_process';
import { ExecutionContext } from '../utils/context';
import { unlinkSync, existsSync } from 'fs';

export class UniversalRouter {
  private server: any;
  private contexts: Map<string, ExecutionContext>;
  private socketPath = '/tmp/sandbox_router.sock';
  
  constructor(contexts: Map<string, ExecutionContext>) {
    this.contexts = contexts;
  }
  
  async initialize(): Promise<void> {
    // Clean up any existing socket
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }
    
    // Create Unix domain socket server
    this.server = createServer((client: Socket) => {
      let buffer = '';
      
      client.on('data', (data) => {
        buffer += data.toString();
        
        // Process complete messages
        if (buffer.includes('END\n')) {
          this.handleRoutingRequest(client, buffer);
        }
      });
      
      client.on('error', (err) => {
        console.error('[Router] Client error:', err);
        client.destroy();
      });
    });
    
    // Start listening
    this.server.listen(this.socketPath, () => {
      console.log('[Router] Universal routing daemon listening on', this.socketPath);
    });
    
    this.server.on('error', (err: any) => {
      console.error('[Router] Server error:', err);
    });
  }
  
  private async handleRoutingRequest(client: Socket, buffer: string) {
    try {
      const lines = buffer.split('\n');
      
      // Parse the request
      if (lines[0] !== 'ROUTE') {
        client.write('ERROR: Invalid request');
        client.end();
        return;
      }
      
      let contextName = '';
      let command = '';
      const args: string[] = [];
      const env: Record<string, string> = {};
      
      for (const line of lines) {
        if (line.startsWith('CONTEXT:')) {
          contextName = line.substring(8);
        } else if (line.startsWith('CMD:')) {
          command = line.substring(4);
        } else if (line.startsWith('ARG:')) {
          args.push(line.substring(4));
        } else if (line.startsWith('ENV:')) {
          const envLine = line.substring(4);
          const eqIndex = envLine.indexOf('=');
          if (eqIndex > 0) {
            const key = envLine.substring(0, eqIndex);
            const value = envLine.substring(eqIndex + 1);
            env[key] = value;
          }
        }
      }
      
      // Get the target context
      const context = this.contexts.get(contextName);
      if (!context) {
        console.error(`[Router] Context '${contextName}' not found`);
        client.write('1'); // Exit code 1
        client.end();
        return;
      }
      
      // Build the full command
      const fullCommand = args.length > 0 
        ? `${command} ${args.join(' ')}` 
        : command;
      
      console.log(`[Router] Routing to context '${contextName}': ${fullCommand}`);
      
      // Execute in the target context
      const result = await context.exec(fullCommand, { env });
      
      // Send back the exit code
      client.write(result.exitCode.toString());
      client.end();
      
    } catch (error) {
      console.error('[Router] Error handling request:', error);
      client.write('1'); // Exit code 1 on error
      client.end();
    }
  }
  
  async shutdown(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          // Clean up socket file
          if (existsSync(this.socketPath)) {
            unlinkSync(this.socketPath);
          }
          console.log('[Router] Universal routing daemon stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
  
  // Helper to compile the LD_PRELOAD library
  static async compileInterceptor(): Promise<void> {
    const { execSync } = require('child_process');
    
    try {
      console.log('[Router] Compiling LD_PRELOAD interceptor...');
      execSync('cd /container-server/lib && make', { stdio: 'inherit' });
      console.log('[Router] LD_PRELOAD interceptor compiled successfully');
    } catch (error) {
      console.error('[Router] Failed to compile interceptor:', error);
      throw error;
    }
  }
}