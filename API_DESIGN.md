# API Design for Critical Security Issues

## Focus: The Three Critical Problems

We're focusing ONLY on issues that break the sandbox:

1. **Process Killing** - User code can kill Jupyter/Bun → Sandbox dies
2. **Port Hijacking** - User code can steal ports 8080/8888 → Control plane fails  
3. **Credential Exposure** - Secrets visible in environment → Financial/security risk

Everything else (resource limits, metadata endpoints, etc.) is nice-to-have but not urgent.

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
  persistent?: boolean;  // Maintain pwd, env changes
  isolation?: 'none' | 'secure';  // Namespace isolation level
  childContext?: string;  // Route ALL child processes to this context
  // Note: We removed routeChild callback - universal routing is simpler
```

### How It Works

```typescript
// Create contexts with different credentials
const platform = await sandbox.createContext({
  name: "platform",
  env: { ANTHROPIC_API_KEY: platformKey },
  persistent: true,
  childContext: "user"  // ALL children route to user context (universal routing)
});

const user = await sandbox.createContext({
  name: "user",
  env: { 
    CLOUDFLARE_API_TOKEN: userToken,
    AWS_ACCESS_KEY_ID: userAwsKey
  },
  persistent: true
});

// Execute in specific contexts
await platform.exec("claude code --prompt 'create worker'");
// Claude gets: ANTHROPIC_API_KEY
// When Claude runs `wrangler deploy`, it executes in user context

await user.exec("wrangler deploy");
// Gets: CLOUDFLARE_API_TOKEN

// Contexts maintain state
await user.exec("cd /my-project");
await user.exec("npm install");  // Runs in /my-project
await user.exec("pwd");  // Output: /my-project
```

### Why This Design Wins

1. **Explicit Over Magic** - Developer chooses context explicitly, no command pattern matching
2. **Unified Abstraction** - Sessions and namespaces are both just "contexts"
3. **Solves Multi-Tenancy** - Platform and user credentials clearly separated
4. **Handles Nesting** - Parent contexts can route children to different contexts
5. **Stateful Sessions** - Each context maintains pwd, env changes, etc.
6. **Clear Mental Model** - "Context = Environment + State + Credentials"

## Behind the Scenes: Simplified Architecture

### Important Context
We're already running inside:
- **Firecracker VM** (hardware isolation provided by Cloudflare)
- **Docker Container** (namespace isolation provided by container runtime)

We only need lightweight isolation WITHIN the container to protect our control plane.

```
Firecracker VM (Cloudflare infrastructure)
└── Docker Container (Our Dockerfile)
    ├── Control Plane (Hidden via simple PID namespace)
    │   ├── Bun Server (port 8080) - invisible to user code
    │   └── Jupyter Kernel (port 8888) - invisible to user code
    │
    └── User Space (Default namespace)
        ├── Platform Context
        │   ├── AI agents run here (Claude, etc.)
        │   ├── Has ANTHROPIC_API_KEY
        │   └── LD_PRELOAD routes ALL children to User Context
        │
        └── User Context  
            ├── All AI agent children run here
            ├── Has CLOUDFLARE_API_TOKEN, AWS_KEY
            └── Never sees platform credentials
```

### Simplified Isolation Strategy

Since we're already inside Firecracker+Docker, we only need:

1. **Control Plane Protection**: Simple `unshare --pid` to hide Bun/Jupyter
2. **Credential Routing**: LD_PRELOAD universal routing for AI agent children
3. **Session State**: Persistent shell process per context

No complex namespace management needed - we leverage existing container isolation.

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

### The Magic: Automatic Namespace Selection

```typescript
class ContainerServer {
  private namespaces = {
    control: null,  // Created once, hidden forever
    user: null,     // Created once, reused for all regular exec
    secure: null    // Created once, reused for all secure exec
  };
  
  async initialize() {
    // Create all three namespaces at container startup
    this.namespaces.control = await this.createNamespace({ hidden: true });
    this.namespaces.user = await this.createNamespace({ shared: true });
    this.namespaces.secure = await this.createNamespace({ isolated: true });
    
    // Start control plane in its namespace
    await this.namespaces.control.exec('bun serve --port 8080');
    await this.namespaces.control.exec('jupyter kernel --port 8888');
  }
  
  async exec(command: string, options?: ExecOptions) {
    // Smart namespace selection
    if (options?.env && Object.keys(options.env).length > 0) {
      // Has credentials? Use secure namespace
      return this.namespaces.secure.exec(command, {
        ...options,
        env: { PATH: '/usr/bin:/bin', ...options.env }
      });
    } else {
      // No credentials? Use shared user namespace
      return this.namespaces.user.exec(command, options);
    }
  }
}
```

### What This Means for Users

| Command | Namespace Used | Can See | Has Access To |
|---------|---------------|---------|---------------|
| `exec("ls")` | User | Other user processes | No credentials |
| `exec("ps aux")` | User | Other user processes | No credentials |
| `exec("npm install")` | User | Other user processes | No credentials |
| `exec("aws deploy", {env: {AWS_KEY}})` | Secure | Only its own process | AWS_KEY only |
| `exec("node app.js")` | User | Other user processes | No credentials |

## Implementation Details

### Startup Sequence

```typescript
// Container startup (happens once)
async function initializeContainer() {
  // Step 1: Pre-bind critical ports
  const bunServer = Bun.serve({ port: 8080 });
  
  // Step 2: Create three persistent namespaces
  const controlNS = await createNamespace('control', { hidden: true });
  const userNS = await createNamespace('user', { shared: true });
  const secureNS = await createNamespace('secure', { isolated: true });
  
  // Step 3: Start Jupyter in control namespace
  await controlNS.exec('jupyter kernel --port 8888');
  
  // Ready to accept commands!
}
```

### How exec() Routes Commands

```typescript
async function exec(command: string, options?: ExecOptions) {
  // Decision tree for namespace selection
  if (options?.env && Object.keys(options.env).length > 0) {
    // Has environment variables → Secure namespace
    return await secureNS.exec(command, {
      env: { 
        PATH: process.env.PATH,  // Preserve PATH
        HOME: '/workspace',       // Standard HOME
        ...options.env           // User-provided secrets
      },
      clearEnvAfter: true  // Clean up after execution
    });
  } else {
    // No environment variables → User namespace  
    return await userNS.exec(command, options);
  }
}
```

### Namespace Implementation (Linux)

```typescript
// Creating reusable namespaces
function createNamespace(name: string, opts: NamespaceOptions) {
  // Create namespace and keep it alive
  const proc = spawn('unshare', [
    '--pid',      // Separate process tree
    '--mount',    // Separate mount points
    '--fork',     // Fork before exec
    'sh', '-c', 'sleep infinity'  // Keep namespace alive
  ]);
  
  const nsPath = `/proc/${proc.pid}/ns/pid`;
  
  return {
    // Execute commands in this namespace
    exec: async (cmd: string, options?: {}) => {
      return spawn('nsenter', [
        `--pid=${nsPath}`,  // Enter the namespace
        '--', 
        'sh', '-c', cmd
      ], options);
    },
    
    // Namespace persists until container shutdown
    destroy: () => proc.kill()
  };
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
A: The SDK falls back gracefully - you get a warning but everything still works.

**Q: Can processes see each other?**
A: Yes! Regular commands in the user namespace can see each other (for debugging). Only secure commands are isolated.

**Q: What about setEnvVars()?**
A: Still works for non-secrets like NODE_ENV, PORT, etc. Just don't use it for credentials.

**Q: Performance impact?**
A: Near zero. Namespaces are created once at startup, not per command.

**Q: Can I debug my processes?**
A: Yes! `ps aux`, `htop`, etc. work normally in the user namespace.

**Q: How does the SDK know what's a credential?**
A: It doesn't! It just isolates any command that has the `env` option.