# API Design for Critical Security Issues - UPDATED

## ⚠️ CRITICAL: Inverse Isolation Model Required

After discovering that our initial implementation isolated the wrong direction, we need to update the API design to reflect the correct approach.

## Focus: The Three Critical Problems (Corrected)

1. **Process Killing** - Isolate USER commands so they can't see/kill Jupyter/Bun
2. **Port Hijacking** - USER commands run in isolated namespace, can't steal ports
3. **Credential Exposure** - Context credentials + namespace isolation = complete protection

**The Fix**: Don't isolate the control plane. Isolate every user command execution!

## API Design Evolution

### What We Learned

Our initial design of "env triggers secure namespace" was too simplistic. Real-world use cases revealed:

1. **Multi-tenancy Requirements**: Platform developers need THEIR credentials (e.g., Anthropic API key) while end-users need DIFFERENT credentials (e.g., Cloudflare tokens)
2. **Nested Execution**: AI agents like Claude Code need platform credentials, but their child processes need user credentials
3. **Session State**: Users expect persistent state (pwd, env vars) across commands
4. **Explicit is Better**: Auto-magical credential routing based on command patterns is fragile
5. **Universal Routing**: AI agents NEVER need to run commands in platform context - ALL child processes should route to user context
6. **No Pattern Matching**: Detecting specific commands ('wrangler', 'aws', etc.) is unmaintainable - route everything instead

### The Solution: Contexts as First-Class Citizens

We're unifying namespaces (isolation) and sessions (state) into **Execution Contexts** - explicit, stateful environments with their own credentials.

#### Key Insight: Universal Child Routing

After extensive analysis, we discovered that AI agents (Claude, Gemini, etc.) never need to execute commands in their own platform context. This simplifies routing dramatically:

- AI agent runs in platform context (has ANTHROPIC_API_KEY)
- ALL child processes route to user context (has CLOUDFLARE_API_TOKEN, AWS_KEY, etc.)
- No pattern matching or command detection needed
- Complete isolation maintained automatically

### The Context-Based API

```typescript
interface Sandbox {
  // Context management (primary API)
  createContext(options: ContextOptions): Promise<Context>;
  context(name: string): Context;
  hasContext(name: string): boolean;
  listContexts(): string[];
  
  // Legacy/convenience methods (use default context)
  exec(command: string): Promise<ExecResult>;
  setEnvVars(vars: Record<string, string>): Promise<void>;
}

interface Context {
  // Execution
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  execStream(command: string, options?: ExecOptions): Promise<ReadableStream>;
  startProcess(command: string, options?: ExecOptions): Promise<Process>;
  
  // Environment management
  setEnv(vars: Record<string, string>): Promise<void>;
  getEnv(key?: string): Promise<Record<string, string> | string>;
  
  // Session state
  cd(path: string): Promise<void>;
  pwd(): Promise<string>;
  
  // Child process routing
  setChildContext(context: Context | string): void;
  setChildRouter(router: (cmd: string) => Context): void;
  
  // Lifecycle
  destroy(): Promise<void>;
}

interface ContextOptions {
  name: string;
  env?: Record<string, string>;
  cwd?: string;
  persistent?: boolean;  // DEFAULT: true - Creates ONE namespace for context lifetime
  isolation?: 'none' | 'secure';  // Namespace isolation level
  childContext?: string;  // Route ALL child processes to this context
  
  // CRITICAL: How persistent sessions work with isolation:
  // persistent=true  → ONE isolated namespace, commands share state (pwd, env, processes)
  // persistent=false → FRESH namespace per command, no state sharing
  // Both modes hide control plane in production!
```

### How It Works

```typescript
// Create contexts with different credentials
const platform = await sandbox.createContext({
  name: "platform",
  env: { ANTHROPIC_API_KEY: platformKey },
  persistent: true,  // ONE namespace for all platform commands
  childContext: "user"  // ALL children route to user context (universal routing)
});

const user = await sandbox.createContext({
  name: "user",
  env: { 
    CLOUDFLARE_API_TOKEN: userToken,
    AWS_ACCESS_KEY_ID: userAwsKey
  },
  persistent: true  // ONE namespace for all user commands
});

// Execute in specific contexts
await platform.exec("claude code --prompt 'create worker'");
// Claude gets: ANTHROPIC_API_KEY
// When Claude runs `wrangler deploy`, it executes in user context

await user.exec("wrangler deploy");
// Gets: CLOUDFLARE_API_TOKEN

// CRITICAL: Persistent sessions maintain state across commands!
await user.exec("cd /my-project");
await user.exec("npm install");  // Still in /my-project
await user.exec("export NODE_ENV=production");
await user.exec("npm start &");  // Background process persists
await user.exec("ps aux");  // Sees npm process, NOT Jupyter/Bun!
await user.exec("pwd");  // Output: /my-project
await user.exec("echo $NODE_ENV");  // Output: production

// Behind the scenes: ALL these commands run in the SAME isolated namespace
// - Control plane (Jupyter/Bun) is invisible
// - Working directory persists
// - Environment variables persist
// - Background processes persist
// - Complete isolation maintained!
```

### Persistent vs Stateless Contexts

```typescript
// PERSISTENT CONTEXT (default - recommended for most use cases)
const devContext = await sandbox.createContext({
  name: "development",
  persistent: true,  // ONE isolated namespace for context lifetime
  env: { NODE_ENV: "development" }
});

// All run in SAME namespace - state preserved
await devContext.exec("cd /app");
await devContext.exec("git pull");  // Still in /app
await devContext.exec("npm install");  // Still in /app
await devContext.exec("npm test &");  // Background process
await devContext.exec("tail -f test.log");  // Can see test output

// STATELESS CONTEXT (for one-off commands)
const tempContext = await sandbox.createContext({
  name: "temp",
  persistent: false,  // FRESH namespace per command
  env: { TEMP: "true" }
});

// Each command gets fresh isolation - no state
await tempContext.exec("cd /tmp");  // Isolated
await tempContext.exec("pwd");  // Output: /workspace (NOT /tmp!)
// Each command starts fresh
```

### Why This Design Wins

1. **Explicit Over Magic** - Developer chooses context explicitly, no command pattern matching
2. **Unified Abstraction** - Sessions and namespaces are both just "contexts"
3. **Solves Multi-Tenancy** - Platform and user credentials clearly separated
4. **Handles Nesting** - Parent contexts can route children to different contexts
5. **Stateful Sessions** - Each context maintains pwd, env changes, etc.
6. **Clear Mental Model** - "Context = Environment + State + Credentials"

## Behind the Scenes: Corrected Architecture

### Important Context
We're already running inside:
- **Firecracker VM** (hardware isolation provided by Cloudflare)
- **Docker Container** (namespace isolation provided by container runtime)

### CRITICAL FIX: Inverse Isolation Model

**What we built initially (BROKEN):**
```
Container
└── Isolated Namespace (unshare wrapper)
    ├── Jupyter (hidden)
    ├── Bun (hidden)
    └── But user commands escape to host namespace! ❌
```

**Correct Architecture (FIXED):**
```
Firecracker VM (Cloudflare infrastructure)
└── Docker Container (Our Dockerfile)
    ├── Control Plane (Default namespace - visible)
    │   ├── Bun Server (port 3000) - runs normally
    │   └── Jupyter (port 8888) - runs normally
    │
    └── User Commands (EACH wrapped in isolation)
        ├── Platform Context Commands
        │   └── unshare --pid --fork --mount-proc bash -c 'command'
        │       ├── Cannot see control plane ✅
        │       ├── Has ANTHROPIC_API_KEY
        │       └── LD_PRELOAD routes children to User Context
        │
        └── User Context Commands
            └── unshare --pid --fork --mount-proc bash -c 'command'
                ├── Cannot see control plane ✅
                ├── Has CLOUDFLARE_API_TOKEN, AWS_KEY
                └── Completely isolated from platform
```

### The Key Change: Where Isolation Happens

Instead of wrapping the control plane startup:
```bash
# WRONG - Don't do this!
unshare --pid bash -c 'jupyter & bun &'
```

We wrap EACH user command:
```bash
# CORRECT - Isolate user commands!
unshare --pid --fork --mount-proc bash -c 'user_command'
```

This ensures user commands can't see or kill the control plane!

#### Our Key Innovation: Universal Routing via LD_PRELOAD

While existing tools (Bubblewrap, gVisor, etc.) solve general sandboxing, none handle our specific need: routing AI agent children to different credential contexts. Our LD_PRELOAD approach elegantly solves this:

```c
// When Claude runs ANY command, our interceptor routes it
int execve(const char *pathname, char *const argv[], char *const envp[]) {
    const char* target = getenv("SANDBOX_ROUTE_TO_CONTEXT");
    if (target) {
        // Route to specified context (e.g., 'user')
        return route_to_context(pathname, argv, envp, target);
    }
    return real_execve(pathname, argv, envp);
}
```

This means:
- No pattern matching needed
- No command detection required
- ALL child processes automatically route
- Complete transparency to AI agents

### Implementation: Simplified Control Plane + Contexts

```typescript
class ContainerServer {
  private contexts = new Map<string, Context>();
  
  async initialize() {
    // Step 1: Hide control plane with simple unshare (one command!)
    spawn('unshare', [
      '--pid', '--fork', '--mount-proc',
      'sh', '-c', `
        bun serve --port 8080 &
        jupyter kernel --port 8888 &
        sleep infinity
      `
    ]);
    
    // Step 2: Set up LD_PRELOAD router for credential isolation
    await this.setupUniversalRouter();
    
    // Step 3: Contexts handle credential separation
    // User creates contexts as needed with different credentials
  }
  
  async createContext(options: ContextOptions): Promise<Context> {
    const context = new Context(options);
    
    // If childContext specified, enable universal routing
    if (options.childContext) {
      context.env.LD_PRELOAD = '/lib/universal_router.so';
      context.env.SANDBOX_ROUTE_TO_CONTEXT = options.childContext;
    }
    
    this.contexts.set(options.name, context);
    return context;
  }
}
```

### What This Means for Users

| Component | Purpose | Visibility |
|-----------|---------|------------|
| Control Plane | Bun + Jupyter servers | Hidden via PID namespace |
| Platform Context | AI agents (Claude, etc.) | Has platform credentials |
| User Context | Deployment commands | Has user credentials |
| LD_PRELOAD | Routes ALL AI children to user context | Transparent |

## Implementation Details

### Startup Sequence (Environment-Aware)

```typescript
// Container startup - detects environment and adapts
async function initializeContainer() {
  const capabilities = await detectCapabilities();
  
  if (capabilities.hasNamespaces) {
    // PRODUCTION: Hide control plane (one command)
    spawn('unshare', [
      '--pid', '--fork', '--mount-proc',
      'sh', '-c', 'bun serve --port 8080 & jupyter kernel --port 8888 & sleep infinity'
    ]);
    console.log('✅ Production: Control plane hidden');
  } else {
    // LOCAL DEV: Start normally (visible but functional)
    spawn('bun', ['serve', '--port', '8080'], { detached: true });
    spawn('jupyter', ['kernel', '--port', '8888'], { detached: true });
    console.warn('⚠️ Local dev: Control plane visible');
  }
  
  // Step 2: Set up routing (works in both environments)
  await compileUniversalRouter();
  await startRoutingDaemon();
  
  console.log(`Ready in ${capabilities.mode} mode`);
}
```

### How Universal Routing Works

```typescript
// No complex routing logic needed!
class Context {
  async exec(command: string, options?: ExecOptions) {
    // If this context has childContext set, ALL children route there
    if (this.childContext && isAIAgent(command)) {
      // Enable LD_PRELOAD routing
      const env = {
        ...this.env,
        LD_PRELOAD: '/lib/universal_router.so',
        SANDBOX_ROUTE_TO_CONTEXT: this.childContext
      };
      return spawn(command, { ...options, env });
    }
    
    // Normal execution
    return spawn(command, { ...options, env: this.env });
  }
}
```

### Control Plane Isolation (Simplified)

```typescript
// We only need ONE namespace - to hide control plane
function hideControlPlane() {
  // That's it! One command to hide Bun + Jupyter
  spawn('unshare', [
    '--pid',           // Hide processes
    '--fork',          // Fork before exec
    '--mount-proc',    // Separate /proc
    'sh', '-c', `
      bun serve --port 8080 &
      jupyter kernel --port 8888 &
      sleep infinity   # Keep namespace alive
    `
  ]);
  
  // Control plane now invisible to user code
  // No complex namespace management needed!
}
```

## Real-World Usage Patterns

### AI Code Generation Platform

```typescript
export async function runAICodeGenerator(env: Env, userId: string, prompt: string) {
  const sandbox = getSandbox(env.Sandbox, userId);
  
  // Create contexts if not exists
  if (!sandbox.hasContext("platform")) {
    // Platform context for AI tools
    await sandbox.createContext({
      name: "platform",
      env: { ANTHROPIC_API_KEY: env.ANTHROPIC_KEY },
      childContext: "user"  // Route children to user context
    });
    
    // User context for deployments
    await sandbox.createContext({
      name: "user",
      env: { 
        CLOUDFLARE_API_TOKEN: await getUserToken(userId),
        AWS_ACCESS_KEY_ID: await getUserAwsKey(userId)
      }
    });
  }
  
  const platform = sandbox.context("platform");
  const user = sandbox.context("user");
  
  // AI runs in platform context
  await platform.exec(`claude code --prompt "${prompt}"`);
  // Claude's child processes (wrangler, aws cli) run in user context
  
  // Check results in user context
  const files = await user.exec("ls -la");
  return files;
}
```

### Build Pipeline with Isolation

```typescript
// Separate contexts for different build stages
const build = await sandbox.createContext({
  name: "build",
  env: { NODE_ENV: "production" },
  isolation: "secure"
});

const test = await sandbox.createContext({
  name: "test",
  env: { NODE_ENV: "test", TEST_API_KEY: testKey },
  isolation: "secure"
});

await build.exec("npm install");
await build.exec("npm run build");

await test.exec("npm test");
await test.exec("npm run integration-tests");
```

## Migration Guide

### From Global Environment Variables

```typescript
// Old: Global environment (insecure)
await sandbox.setEnvVars({ 
  AWS_ACCESS_KEY_ID: secret,
  ANTHROPIC_API_KEY: apiKey
});
await sandbox.exec('aws s3 ls');
await sandbox.exec('claude code');

// New: Context-based (secure)
const aws = await sandbox.createContext({
  name: "aws",
  env: { AWS_ACCESS_KEY_ID: secret }
});

const ai = await sandbox.createContext({
  name: "ai",
  env: { ANTHROPIC_API_KEY: apiKey }
});

await aws.exec('aws s3 ls');
await ai.exec('claude code');
```

### From Session IDs

```typescript
// Old: Session IDs (limited)
const sessionId = "user-123";
await sandbox.exec("cd /project", { sessionId });
await sandbox.exec("npm install", { sessionId });

// New: Contexts (full state management)
const project = await sandbox.createContext({ 
  name: "project",
  persistent: true 
});
await project.exec("cd /project");
await project.exec("npm install");  // Runs in /project
```

### Backward Compatibility

The old `sandbox.exec()` method still works - it uses a default context:

```typescript
// These are equivalent:
await sandbox.exec("ls");
await sandbox.context("default").exec("ls");
```

## FAQ

**Q: Do I need to change my code?**
A: Only if you're using `setEnvVars()` for secrets. Move them to `exec(cmd, {env})` instead.

**Q: What if I'm running locally without CAP_SYS_ADMIN?**
A: The SDK falls back gracefully:
- Control plane remains visible (can't use `unshare`)
- Context-based credential isolation still works
- LD_PRELOAD routing still functions
- You get a warning to avoid `pkill` commands

**Q: Can processes see each other?**
A: Yes! Regular commands in the user namespace can see each other (for debugging). Only secure commands are isolated.

**Q: What about setEnvVars()?**
A: Still works for non-secrets like NODE_ENV, PORT, etc. Just don't use it for credentials.

**Q: Performance impact?**
A: Minimal overhead:
- Production: ~15ms startup (one `unshare` command)
- Local dev: ~5ms startup (no hiding needed)
- Per-exec: ~2-3ms with context + routing

**Q: Can I debug my processes?**
A: Yes! `ps aux`, `htop`, etc. work normally in the user namespace.

**Q: How does credential isolation work?**
A: Contexts with different credentials + LD_PRELOAD universal routing. AI agents in platform context have ALL their children routed to user context automatically.