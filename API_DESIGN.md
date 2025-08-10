# API Design for Critical Security Issues

## Focus: The Three Critical Problems

We're focusing ONLY on issues that break the sandbox:

1. **Process Killing** - User code can kill Jupyter/Bun → Sandbox dies
2. **Port Hijacking** - User code can steal ports 8080/8888 → Control plane fails  
3. **Credential Exposure** - Secrets visible in environment → Financial/security risk

Everything else (resource limits, metadata endpoints, etc.) is nice-to-have but not urgent.

## Key Design Question: User Control vs Transparent Protection

### Option 1: Completely Transparent (No API Changes)
**Everything happens behind the scenes**

```typescript
// User code stays exactly the same
const sandbox = getSandbox(env.Sandbox, "my-sandbox");
await sandbox.exec("npm install");  // Automatically protected
await sandbox.setEnvVars({ AWS_KEY: secret });  // Automatically isolated
```

**Pros:**
- Zero migration effort
- No learning curve
- Works with existing code

**Cons:**
- No way to opt into stricter security
- Can't distinguish platform vs user operations
- Credentials still globally visible (just to fewer processes)

### Option 2: Explicit Security Contexts (Recommended)
**Users choose when they need isolation**

```typescript
// New API for platform operations with secrets
await sandbox.execSecure("aws s3 deploy", {
  env: { AWS_ACCESS_KEY_ID: secret },
  isolated: true  // Runs in separate namespace
});

// Regular operations unchanged
await sandbox.exec("node app.js");  // No secrets, no isolation needed
```

**Pros:**
- Clear security boundaries
- Explicit about what has access to secrets
- Platform operations clearly separated
- Minimal API changes

**Cons:**
- Requires migration for secure operations
- Users must understand when to use which method

### Option 3: Dual Context API (Most Explicit)
**Two separate execution contexts**

```typescript
const sandbox = getSandbox(env.Sandbox, "my-sandbox");

// Platform context for privileged operations
await sandbox.platform.exec("aws deploy", {
  env: { AWS_KEY: secret }
});

// User context for generated code
await sandbox.user.exec("node app.js");
```

**Pros:**
- Clearest mental model
- Impossible to accidentally expose secrets
- State separation between contexts

**Cons:**
- Bigger API change
- More complex for simple use cases

## Recommended API Design: Explicit Security Contexts

Based on our analysis, we recommend **Option 2** - adding a secure execution method while keeping the existing API for backward compatibility.

### Core API Additions

```typescript
interface Sandbox {
  // Existing methods remain unchanged
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  setEnvVars(vars: Record<string, string>): Promise<void>;
  
  // NEW: Secure execution with isolated credentials
  execSecure(
    command: string,
    options?: SecureExecOptions
  ): Promise<ExecResult>;
  
  // NEW: Check if secure execution is available
  hasSecureExecution(): Promise<boolean>;
}

interface SecureExecOptions extends ExecOptions {
  // Environment variables only visible to this command
  env?: Record<string, string>;
  
  // Run in isolated namespace (default: true)
  isolated?: boolean;
  
  // Timeout for the operation
  timeout?: number;
}
```

### Usage Examples

#### Deploying with AI Agent
```typescript
// AI agent needs AWS credentials to deploy
await sandbox.execSecure('aws lambda deploy function.zip', {
  env: {
    AWS_ACCESS_KEY_ID: env.AWS_KEY,
    AWS_SECRET_ACCESS_KEY: env.AWS_SECRET
  }
});

// Code the AI wrote runs WITHOUT credentials
await sandbox.exec('node app.js');  // No access to AWS keys
```

#### Database Migration
```typescript
// Run migration with database credentials
await sandbox.execSecure('psql -f migrate.sql', {
  env: {
    PGPASSWORD: env.DB_PASSWORD,
    PGHOST: 'prod-db.example.com'
  }
});

// Start app without database credentials
await sandbox.exec('npm start');  // Can't directly access DB
```

#### Package Installation
```typescript
// Install packages in isolated environment
// Prevents postinstall scripts from accessing secrets
await sandbox.execSecure('npm install untrusted-package', {
  isolated: true,
  env: {}  // No secrets during installation
});
```

### Backward Compatibility

```typescript
// Old code continues to work (with security warning)
await sandbox.setEnvVars({ AWS_KEY: secret });
await sandbox.exec('aws s3 ls');  // Works but logs warning

// Migration path
if (await sandbox.hasSecureExecution()) {
  // Use new secure API
  await sandbox.execSecure('aws s3 ls', { env: { AWS_KEY: secret }});
} else {
  // Fall back to old method
  console.warn('Secure execution not available');
  await sandbox.setEnvVars({ AWS_KEY: secret });
  await sandbox.exec('aws s3 ls');
}
```

### Why This Design?

1. **Minimal API Surface**: Just two new methods
2. **Clear Security Boundary**: `execSecure` = with secrets, `exec` = without
3. **Backward Compatible**: Existing code continues to work
4. **Progressive Enhancement**: Can detect and use when available
5. **Simple Mental Model**: "Use execSecure for operations with credentials"

## Implementation Behind the Scenes

### For Process Killing Prevention
```typescript
// Bun server automatically runs control plane in hidden namespace
class ContainerServer {
  async start() {
    // Control plane components start in isolated PID namespace
    await this.startInNamespace({
      jupyter: 'jupyter kernel',
      bun: 'bun serve --port 8080'
    });
    // User code can't see or kill these processes
  }
}
```

### For Port Protection  
```typescript
// Pre-bind critical ports before user code runs
class ContainerServer {
  async initialize() {
    // Bind ports immediately on container start
    this.bunServer = Bun.serve({ port: 8080 });
    this.jupyterServer = new JupyterKernel({ port: 8888 });
    // User code gets EADDRINUSE if they try to bind
  }
}
```

### For Credential Isolation
```typescript
// execSecure implementation
async execSecure(command: string, options?: SecureExecOptions) {
  if (!this.hasCapSysAdmin()) {
    // Fallback for local dev
    return this.execWithWarning(command, options);
  }
  
  // Create isolated namespace for this execution
  const result = await this.runInNamespace(command, {
    env: options?.env || {},
    mount: ['--mount'],  // Separate /proc
    pid: ['--pid'],      // Separate process tree
  });
  
  return result;
}
```

## Benefits for SDK Users

### What They Get Automatically (No Code Changes)

1. **Control Plane Protection**: Jupyter/Bun can't be killed
2. **Port Protection**: Ports 8080/8888 are pre-reserved
3. **Process Isolation**: Control plane hidden from `ps aux`

### What They Get with Migration (Using execSecure)

1. **Credential Isolation**: Secrets never in global environment
2. **Scoped Access**: Credentials only available to specific commands
3. **Audit Trail**: Can log all secure executions
4. **Time-Limited Exposure**: Credentials exist only during execution

## Migration Guide

### Step 1: Identify Credential Usage
```typescript
// Look for patterns like:
await sandbox.setEnvVars({ AWS_KEY: secret });
await sandbox.exec('aws s3 ls');
```

### Step 2: Replace with Secure Execution
```typescript
// Change to:
await sandbox.execSecure('aws s3 ls', {
  env: { AWS_KEY: secret }
});
```

### Step 3: Remove Global Environment Variables
```typescript
// Remove calls to setEnvVars() for secrets
// Keep it only for non-sensitive config:
await sandbox.setEnvVars({ 
  NODE_ENV: 'development',  // OK - not secret
  PORT: '3000'              // OK - not secret
});
```

## FAQ

**Q: Do I have to change my code?**
A: No, but you should for security. Control plane protection happens automatically.

**Q: What about existing setEnvVars() calls?**
A: They continue to work but with security warnings for sensitive-looking keys.

**Q: How do I know if secure execution is available?**
A: Use `hasSecureExecution()` to check (returns true in production, false in local dev).

**Q: Can I still use environment variables for non-secrets?**
A: Yes! Use `setEnvVars()` for configuration, `execSecure()` for secrets.

**Q: What's the performance impact?**
A: Minimal - namespace creation adds <5ms per execution.