# API Design for Critical Security Issues

## Focus: The Three Critical Problems

We're focusing ONLY on issues that break the sandbox:

1. **Process Killing** - User code can kill Jupyter/Bun → Sandbox dies
2. **Port Hijacking** - User code can steal ports 8080/8888 → Control plane fails  
3. **Credential Exposure** - Secrets visible in environment → Financial/security risk

Everything else (resource limits, metadata endpoints, etc.) is nice-to-have but not urgent.

## API Design Decision: Single Unified exec() Method

After careful analysis, we've decided on a **single exec() method** that automatically provides security based on context.

### The Simplified API

```typescript
interface Sandbox {
  // One method to rule them all!
  exec(
    command: string, 
    options?: ExecOptions
  ): Promise<ExecResult>;
  
  // Existing methods remain
  setEnvVars(vars: Record<string, string>): Promise<void>;
}

interface ExecOptions {
  // When env is provided, automatically uses secure namespace
  env?: Record<string, string>;
  
  // Standard options
  cwd?: string;
  timeout?: number;
  sessionId?: string;
}
```

### How It Works

```typescript
// Regular command - runs in shared user namespace
await sandbox.exec("npm install");
await sandbox.exec("node app.js");
await sandbox.exec("ps aux");  // Can see other user processes

// Command with credentials - automatically uses secure namespace
await sandbox.exec("aws s3 deploy", {
  env: { 
    AWS_ACCESS_KEY_ID: secret,
    AWS_SECRET_ACCESS_KEY: secretKey
  }
});
// ↑ This automatically runs in isolated secure namespace!

// Back to regular commands - no credentials visible
await sandbox.exec("echo $AWS_ACCESS_KEY_ID");  // Empty
```

### Why This Design Wins

1. **Zero Learning Curve** - Just use exec() like always
2. **Automatic Security** - Credentials trigger isolation automatically
3. **No Migration Pain** - Existing code just works
4. **Clear Mental Model** - "Credentials = Isolated" 
5. **Optimal Performance** - Only isolated when needed

## Behind the Scenes: Three Reusable Namespaces

```
Container (at startup, creates 3 persistent namespaces)
├── Control Namespace (Hidden from user)
│   ├── Bun Server (port 8080)
│   └── Jupyter Kernel (port 8888)
│
├── User Namespace (Default for exec)
│   ├── All regular commands run here
│   ├── Processes can see each other
│   └── NO credentials ever
│
└── Secure Namespace (When env provided)
    ├── Isolated from user namespace
    ├── Credentials exist only during command
    └── Cleared after each use
```

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

## What SDK Users Get

### Automatic Protection (Zero Code Changes)

1. **Control Plane Protection**: Jupyter/Bun can't be killed by user code
2. **Port Protection**: Ports 8080/8888 pre-reserved at startup
3. **Process Isolation**: Control plane hidden from `ps aux`

### Credential Isolation (Automatic with env option)

```typescript
// Just pass env to get isolation - that's it!
await sandbox.exec("aws s3 deploy", {
  env: { AWS_KEY: secret }  // Automatically isolated
});
```

- Credentials never in global environment
- Scoped to single command only  
- No cross-contamination between commands
- Automatic cleanup after execution

## Migration Guide

### Old Pattern (Insecure)
```typescript
// DON'T: Global environment variables
await sandbox.setEnvVars({ 
  AWS_ACCESS_KEY_ID: secret,
  AWS_SECRET_ACCESS_KEY: secretKey
});
await sandbox.exec('aws s3 ls');  // Has access
await sandbox.exec('node app.js'); // ALSO has access (bad!)
```

### New Pattern (Secure)
```typescript
// DO: Scoped environment variables
await sandbox.exec('aws s3 ls', {
  env: { 
    AWS_ACCESS_KEY_ID: secret,
    AWS_SECRET_ACCESS_KEY: secretKey
  }
});  // Only this command has access

await sandbox.exec('node app.js'); // No access (good!)
```

### That's It!
Literally just move your secrets from `setEnvVars()` to the `env` option of `exec()`. The SDK handles the isolation automatically.

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