import { ExecutionContext, ContextOptions, ExecOptions, ExecResult, Process } from '../utils/context';

export class ContextManager {
  public contexts: Map<string, ExecutionContext> = new Map();
  
  async createContext(options: ContextOptions): Promise<ExecutionContext> {
    // Check if context already exists
    if (this.contexts.has(options.name)) {
      throw new Error(`Context '${options.name}' already exists`);
    }
    
    // Create new execution context
    const context = new ExecutionContext(options);
    await context.initialize();
    
    this.contexts.set(options.name, context);
    
    const envVars = options.env || {};
    console.log(`[ContextManager] Context '${options.name}' created with env:`, Object.keys(envVars));
    
    return context;
  }
  
  getContext(name: string): ExecutionContext {
    const context = this.contexts.get(name);
    if (!context) {
      throw new Error(`Context '${name}' not found`);
    }
    return context;
  }
  
  hasContext(name: string): boolean {
    return this.contexts.has(name);
  }
  
  listContexts(): string[] {
    return Array.from(this.contexts.keys());
  }
  
  async destroyContext(name: string): Promise<void> {
    const context = this.contexts.get(name);
    if (context) {
      await context.destroy();
      this.contexts.delete(name);
      console.log(`Context '${name}' destroyed`);
    }
  }
  
  async destroyAllContexts(): Promise<void> {
    for (const [name, context] of this.contexts) {
      await context.destroy();
    }
    this.contexts.clear();
    console.log('All contexts destroyed');
  }
  
  // Helper methods for API endpoints
  async execInContext(
    contextName: string, 
    command: string, 
    options?: ExecOptions
  ): Promise<ExecResult> {
    const context = this.getContext(contextName);
    return context.exec(command, options);
  }
  
  async execStreamInContext(
    contextName: string,
    command: string,
    options?: ExecOptions
  ): Promise<ReadableStream> {
    const context = this.getContext(contextName);
    const stream = await context.execStream(command, options);
    
    // Convert Node stream to Web stream
    return new ReadableStream({
      start(controller) {
        stream.on('data', (chunk) => {
          controller.enqueue(chunk);
        });
        stream.on('end', () => {
          controller.close();
        });
        stream.on('error', (err) => {
          controller.error(err);
        });
      }
    });
  }
  
  async startProcessInContext(
    contextName: string,
    command: string,
    options?: ExecOptions
  ): Promise<Process> {
    const context = this.getContext(contextName);
    return context.startProcess(command, options);
  }
  
  // Default context management
  async ensureDefaultContext(): Promise<ExecutionContext> {
    if (!this.contexts.has('default')) {
      return this.createContext({
        name: 'default',
        env: {},
        cwd: '/workspace',
        persistent: true
      });
    }
    return this.getContext('default');
  }
}