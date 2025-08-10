# Implementation Plan for Critical Security Issues

## Focus: Three Critical Problems Only

1. **Process Killing** → PID namespace isolation
2. **Port Hijacking** → Pre-binding + port reservation
3. **Credential Exposure** → Isolated execution contexts

Everything else is deferred as nice-to-have.

## Implementation Architecture

### Environment Context
```
Cloudflare Infrastructure
└── Firecracker VM (hardware isolation)
    └── Docker Container (namespace isolation)
        └── Our Sandbox (need to isolate WITHIN container)
```

We're already inside strong isolation layers. We only need to protect our control plane from user code.

### Current State (Vulnerable)
```
Docker Container
├── All processes visible (user can pkill jupyter/bun)
├── Shared environment variables (credentials leaked)
└── Ports can be hijacked (8080, 8888)
```

### Target State (Simplified)
```
Docker Container
├── Control Plane (Hidden via simple unshare --pid)
│   ├── Bun Server (port 8080) - invisible to ps/pkill
│   └── Jupyter Kernel (port 8888) - invisible to ps/pkill
│
└── User Space (Default namespace)
    ├── Platform Context (AI agents run here)
    │   └── LD_PRELOAD universal routing
    └── User Context (AI children run here)
        └── Has deployment credentials
```

**Key Insight**: We don't need complex isolation - we're already inside Firecracker+Docker! Just hide the control plane and route credentials.

## Implementation Details

### Phase 1: Simplified Container Startup

```typescript
// container_src/index.ts
class ContainerServer {
  private contexts: Map<string, ExecutionContext> = new Map();
  private controlPlanePid: number;
  
  async initialize() {
    // Step 1: Start control plane in hidden PID namespace (simple!)
    const control = spawn('unshare', [
      '--pid',           // Hide from ps/pkill
      '--fork',          // Fork before exec
      '--mount-proc',    // Separate /proc
      'sh', '-c', `
        # Pre-bind ports and start services
        bun serve --port 8080 &
        jupyter kernel --port 8888 &
        sleep infinity  # Keep namespace alive
      `
    ]);
    this.controlPlanePid = control.pid;
    
    // Step 2: Initialize LD_PRELOAD router
    await this.compileUniversalRouter();
    await this.startRoutingDaemon();
    
    // Step 3: Create default contexts for user code
    await this.createContext({ name: 'platform' });
    await this.createContext({ name: 'user' });
    
    console.log('Control plane hidden, router ready');
  }
  
  private async createNamespaces() {
    // Create control namespace (hidden from user)
    const control = await this.createNamespace({
      name: 'control',
      pid: true,   // Separate PID namespace
      mount: true, // Separate /proc
      net: false   // Share network (needs ports)
    });
    
    // Create user namespace (shared for debugging)
    const user = await this.createNamespace({
      name: 'user',
      pid: false,  // Share PID space for debugging
      mount: false,// Share filesystem
      net: false   // Share network
    });
    
    // Create secure namespace (isolated for credentials)
    const secure = await this.createNamespace({
      name: 'secure',
      pid: true,   // Separate PID namespace
      mount: true, // Separate /proc (hide credentials)
      net: false   // Share network
    });
    
    return { control, user, secure };
  }
}
```

### Phase 2: Context Management API

```typescript
// container_src/api/context.ts
export async function createContext(
  options: ContextOptions
): Promise<ExecutionContext> {
  // Check if context already exists
  if (this.contexts.has(options.name)) {
    throw new Error(`Context '${options.name}' already exists`);
  }
  
  // Create new execution context
  const context = new ExecutionContext({
    name: options.name,
    env: options.env || {},
    cwd: options.cwd || '/workspace',
    persistent: options.persistent ?? true,
    isolation: options.isolation || 'secure',
    childContext: options.childContext,
    routeChild: options.routeChild
  });
  
  await context.initialize();
  this.contexts.set(options.name, context);
  
  return context;
}

export function getContext(name: string): ExecutionContext {
  const context = this.contexts.get(name);
  if (!context) {
    throw new Error(`Context '${name}' not found`);
  }
  return context;
}
```

### Phase 3: ExecutionContext Implementation

```typescript
// container_src/utils/context.ts
class ExecutionContext {
  private name: string;
  private env: Record<string, string>;
  private cwd: string;
  private shellProcess?: ChildProcess;
  private namespace?: Namespace;
  private childContext?: string;  // Universal routing target
  
  constructor(options: ContextOptions) {
    this.name = options.name;
    this.env = options.env || {};
    this.cwd = options.cwd || '/workspace';
    this.childContext = options.childContext;
    this.routeChild = options.routeChild;
  }
  
  async initialize() {
    // Create namespace if isolation requested
    if (this.options.isolation === 'secure') {
      this.namespace = await this.createNamespace();
    }
    
    // Create persistent shell if requested
    if (this.options.persistent) {
      this.shellProcess = await this.createShell();
    }
  }
  
  async exec(command: string, options?: ExecOptions) {
    // Enable universal routing for AI agents
    if (this.childContext && this.isAIAgent(command)) {
      // ALL child processes will route to childContext
      return await this.execWithRouting(command, options);
    }
    
    // Normal execution without routing
    if (this.shellProcess) {
      return await this.execInShell(command, options);
    } else if (this.namespace) {
      return await this.namespace.exec(command, options);
    } else {
      return await this.execDirect(command, options);
    }
  }
  
  private async execWithRouting(command: string, options?: ExecOptions) {
    // Enable LD_PRELOAD universal routing
    const envWithRouting = {
      ...this.env,
      ...options?.env,
      LD_PRELOAD: '/lib/universal_router.so',
      SANDBOX_ROUTE_TO_CONTEXT: this.childContext
    };
    
    return this.execDirect(command, { ...options, env: envWithRouting });
  }
  
  private isAIAgent(command: string): boolean {
    // Detect AI agent commands that need routing
    const aiAgents = ['claude', 'gemini', 'gpt', 'copilot'];
    return aiAgents.some(agent => command.includes(agent));
  }
  
  private async createShell(): Promise<ChildProcess> {
    // Create a persistent bash shell for this context
    const shell = spawn('bash', [], {
      env: this.env,
      cwd: this.cwd
    });
    
    // Initialize shell state
    await this.execInShell(`cd ${this.cwd}`);
    for (const [key, value] of Object.entries(this.env)) {
      await this.execInShell(`export ${key}="${value}"`);
    }
    
    return shell;
  }
  
  async cd(path: string) {
    this.cwd = path;
    if (this.shellProcess) {
      await this.execInShell(`cd ${path}`);
    }
  }
  
  async setEnv(vars: Record<string, string>) {
    this.env = { ...this.env, ...vars };
    if (this.shellProcess) {
      for (const [key, value] of Object.entries(vars)) {
        await this.execInShell(`export ${key}="${value}"`);
      }
    }
  }
  
  async pwd(): Promise<string> {
    if (this.shellProcess) {
      const result = await this.execInShell('pwd');
      return result.stdout.trim();
    }
    return this.cwd;
  }
  
  setChildContext(context: string) {
    this.childContext = context;
  }
  
  async destroy() {
    if (this.shellProcess) {
      this.shellProcess.kill();
    }
    if (this.namespace) {
      await this.namespace.destroy();
    }
  }
}
```

## Testing & Validation

### Test 1: Control Plane Protection
```typescript
test('Control plane is invisible and unkillable', async () => {
  const userCtx = await sandbox.createContext({ name: 'user' });
  
  // User context can't see Jupyter/Bun
  const ps = await userCtx.exec('ps aux');
  expect(ps.stdout).not.toContain('jupyter');
  expect(ps.stdout).not.toContain('bun serve');
  
  // User context can't kill them
  await userCtx.exec('pkill jupyter');
  await userCtx.exec('pkill bun');
  
  // Control plane still running
  const health = await fetch('http://localhost:8080/health');
  expect(health.ok).toBe(true);
});
```

### Test 2: Port Protection
```typescript
test('Critical ports are pre-reserved', async () => {
  // Try to steal port 8080
  const result = await sandbox.exec(
    'python3 -m http.server 8080'
  );
  expect(result.stderr).toContain('Address already in use');
  
  // Try to steal port 8888
  const jupyter = await sandbox.exec(
    'nc -l 8888'
  );
  expect(jupyter.stderr).toContain('Address already in use');
});
```

### Test 3: Context-Based Credential Isolation
```typescript
test('Credentials isolated between contexts', async () => {
  // Create contexts with different credentials
  const aws = await sandbox.createContext({
    name: 'aws',
    env: { AWS_ACCESS_KEY_ID: 'secret123' }
  });
  
  const azure = await sandbox.createContext({
    name: 'azure',
    env: { AZURE_CLIENT_ID: 'azure456' }
  });
  
  // AWS context can see its credentials
  const awsCheck = await aws.exec('echo $AWS_ACCESS_KEY_ID');
  expect(awsCheck.stdout.trim()).toBe('secret123');
  
  // But not Azure's
  const azureCheck = await aws.exec('echo $AZURE_CLIENT_ID');
  expect(azureCheck.stdout.trim()).toBe('');
  
  // And vice versa
  const azureHasOwn = await azure.exec('echo $AZURE_CLIENT_ID');
  expect(azureHasOwn.stdout.trim()).toBe('azure456');
  const azureNoAws = await azure.exec('echo $AWS_ACCESS_KEY_ID');
  expect(azureNoAws.stdout.trim()).toBe('');
});
```

### Test 4: Context State Persistence
```typescript
test('Contexts maintain session state', async () => {
  const ctx = await sandbox.createContext({
    name: 'stateful',
    persistent: true
  });
  
  // Change directory
  await ctx.exec('cd /tmp');
  const pwd1 = await ctx.exec('pwd');
  expect(pwd1.stdout.trim()).toBe('/tmp');
  
  // Set environment variable
  await ctx.exec('export MY_VAR=hello');
  const var1 = await ctx.exec('echo $MY_VAR');
  expect(var1.stdout.trim()).toBe('hello');
  
  // State persists across commands
  const pwd2 = await ctx.exec('pwd');
  expect(pwd2.stdout.trim()).toBe('/tmp');
  const var2 = await ctx.exec('echo $MY_VAR');
  expect(var2.stdout.trim()).toBe('hello');
});
```

### Test 5: Child Context Routing
```typescript
test('Parent context routes children correctly', async () => {
  const platform = await sandbox.createContext({
    name: 'platform',
    env: { PLATFORM_KEY: 'platform123' },
    childContext: 'user'
  });
  
  const user = await sandbox.createContext({
    name: 'user',
    env: { USER_KEY: 'user456' }
  });
  
  // Simulate AI agent spawning child process
  // (In reality, Claude would spawn this internally)
  await platform.exec('mock-ai-agent-command');
  
  // Verify child ran in user context
  // (would need instrumentation to verify)
});
```

## Phase 4: Universal Routing Implementation

### LD_PRELOAD Interceptor (C)

```c
// container_src/lib/universal_router.c
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/un.h>

static int (*real_execve)(const char*, char *const[], char *const[]) = NULL;
static int (*real_system)(const char*) = NULL;

__attribute__((constructor)) void init() {
    real_execve = dlsym(RTLD_NEXT, "execve");
    real_system = dlsym(RTLD_NEXT, "system");
}

int execve(const char *pathname, char *const argv[], char *const envp[]) {
    const char* target = getenv("SANDBOX_ROUTE_TO_CONTEXT");
    
    if (target) {
        // Route ALL commands to target context
        int sock = socket(AF_UNIX, SOCK_STREAM, 0);
        struct sockaddr_un addr = {.sun_family = AF_UNIX};
        strncpy(addr.sun_path, "/tmp/sandbox_router.sock", sizeof(addr.sun_path)-1);
        
        if (connect(sock, (struct sockaddr*)&addr, sizeof(addr)) == 0) {
            // Send routing request
            dprintf(sock, "CONTEXT:%s\n", target);
            dprintf(sock, "CMD:%s\n", pathname);
            for (int i = 0; argv[i]; i++) {
                dprintf(sock, "ARG:%s\n", argv[i]);
            }
            dprintf(sock, "END\n");
            
            // Wait for exit code
            char result[32];
            read(sock, result, sizeof(result));
            close(sock);
            exit(atoi(result));
        }
    }
    
    return real_execve(pathname, argv, envp);
}

int system(const char *command) {
    const char* target = getenv("SANDBOX_ROUTE_TO_CONTEXT");
    if (target) {
        // Route via execve
        char *argv[] = {"sh", "-c", (char*)command, NULL};
        return execve("/bin/sh", argv, environ);
    }
    return real_system(command);
}
```

### Routing Daemon (TypeScript)

```typescript
// container_src/services/universal_router.ts
export class UniversalRouter {
  private server: any;
  private contexts: Map<string, ExecutionContext>;
  
  async initialize() {
    // Compile interceptor
    await exec('gcc -shared -fPIC -o /lib/universal_router.so /container_src/lib/universal_router.c -ldl');
    
    // Start routing daemon
    this.server = createServer((client) => {
      let buffer = '';
      
      client.on('data', async (data) => {
        buffer += data.toString();
        
        if (buffer.includes('END\n')) {
          const lines = buffer.split('\n');
          const context = lines.find(l => l.startsWith('CONTEXT:'))?.substring(8);
          const cmd = lines.find(l => l.startsWith('CMD:'))?.substring(4);
          const args = lines.filter(l => l.startsWith('ARG:')).map(l => l.substring(4));
          
          // Route to target context
          const targetContext = this.contexts.get(context);
          if (targetContext) {
            const result = await targetContext.exec(`${cmd} ${args.join(' ')}`);
            client.write(result.exitCode.toString());
          }
          
          client.end();
        }
      });
    });
    
    this.server.listen('/tmp/sandbox_router.sock');
  }
}
```

## Implementation Timeline

### Week 1: Simplified Implementation
**Goal**: Minimal control plane protection + universal routing

1. **Day 1**: Control plane isolation
   - Simple `unshare --pid` for Bun/Jupyter
   - Verify processes hidden from user code
   - Test port pre-binding
   
2. **Day 2**: LD_PRELOAD interceptor
   - Write `universal_router.c`
   - Compile to shared library
   - Test all exec variants
   
3. **Day 3**: Routing daemon
   - Unix socket server
   - Context lookup
   - Test routing
   
4. **Day 4-5**: Integration
   - Test with Claude Code
   - Verify credential isolation
   - Confirm universal routing works

**Note**: This is much simpler than general sandboxing because we're already inside strong isolation (Firecracker+Docker).

### Week 2: SDK Integration
**Goal**: Update SDK client with new behavior

1. **Day 1-2**: SDK client updates
   - Update exec() to accept env option
   - Remove execSecure() if it exists
   
2. **Day 3-4**: Integration testing
   - Test with real AWS CLI
   - Test with database tools
   - Verify backward compatibility
   
3. **Day 5**: Performance optimization
   - Benchmark namespace switching
   - Optimize for common patterns

### Week 3: Release
**Goal**: Ship to production

1. **Day 1-2**: Documentation
   - Update README
   - Write migration guide
   - Create examples
   
2. **Day 3-4**: Staged rollout
   - Deploy to staging environment
   - Test with select users
   
3. **Day 5**: General availability
   - Publish npm package
   - Announce improvements

## Performance Characteristics

### Namespace Creation (One-time at startup)
```
Control namespace creation: ~10ms
User namespace creation: ~5ms  
Secure namespace creation: ~10ms
Total startup overhead: ~25ms (once per container)
```

### Command Execution Overhead
```
Regular exec() in user namespace: ~0ms overhead
Secure exec() with env: ~2-3ms overhead (namespace switch)
```

### Memory Usage
```
Per namespace overhead: ~2MB
Total for 3 namespaces: ~6MB
```

## Fallback for Local Development

```typescript
// container_src/utils/capabilities.ts
export async function detectCapabilities() {
  try {
    // Test if we can create namespaces
    execSync('unshare --pid --fork true', { stdio: 'ignore' });
    return {
      hasNamespaces: true,
      mode: 'production'
    };
  } catch {
    // Local dev environment
    console.warn(
      '[LOCAL DEV] Running without namespace isolation.\n' +
      'Control plane protection and credential isolation disabled.'
    );
    return {
      hasNamespaces: false,
      mode: 'development'
    };
  }
}

// Graceful degradation
if (capabilities.mode === 'development') {
  // Single namespace fallback
  this.namespaces = {
    control: defaultNamespace,
    user: defaultNamespace,
    secure: defaultNamespace  // Warning on use
  };
}
```

## Files to Modify

### Container (Bun Server)
```
container_src/
├── index.ts              # Add context initialization
├── api/
│   ├── execute.ts        # Update to use contexts
│   └── context.ts        # NEW: Context management API
├── services/
│   ├── jupyter.ts        # Start in control context
│   └── process.ts        # Update to use contexts
└── utils/
    ├── context.ts        # NEW: ExecutionContext class
    ├── namespace.ts      # Linux namespace utilities
    └── capabilities.ts   # Detect CAP_SYS_ADMIN
```

### SDK Client
```
packages/sandbox/src/
├── index.ts              # Export Context interface
├── client/
│   ├── methods.ts        # Add context methods
│   └── context.ts        # NEW: Context client class
└── types.ts              # Add Context types
```

### Key Changes

1. **container_src/utils/context.ts** (NEW)
   - ExecutionContext class implementation
   - Combines namespace isolation + session state
   - Child routing logic

2. **container_src/api/context.ts** (NEW)
   - Context creation and management API
   - Context lookup and lifecycle

3. **container_src/index.ts** (MODIFY)
   - Create control context at startup
   - Pre-bind ports 8080/8888
   - Start Jupyter in control context

4. **packages/sandbox/src/client/context.ts** (NEW)
   - Client-side Context class
   - Proxies commands to server context
   - Maintains context reference

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Namespace escape vulnerability | High | Monitor kernel CVEs, update base image regularly |
| Reusable namespace contamination | Medium | Clear environment after each secure exec |
| Local dev confusion | Low | Clear warning messages, graceful fallback |
| File sharing between namespaces | Medium | Mount shared /workspace carefully |
| Debugging complexity | Low | User namespace preserves normal debugging |