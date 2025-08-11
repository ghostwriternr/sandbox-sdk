# Implicit Contexts Design

## Goal
Maintain backward compatibility while providing isolation and security benefits automatically.

## Design Principles

1. **Zero Breaking Changes** - Existing code must continue working
2. **Security by Default** - Isolation happens automatically 
3. **Progressive Enhancement** - Advanced features available when needed
4. **Transparent Upgrade** - Users get benefits without code changes

## Implementation

### 1. Default Context (Implicit)

Every sandbox automatically gets a 'default' context:

```typescript
// User code (unchanged)
const sandbox = getSandbox(env.Sandbox, "my-sandbox");
const result = await sandbox.exec("echo 'Hello!'");

// Behind the scenes
// → Automatically uses 'default' context with isolation
// → State persists (cd, export, background processes)
// → Control plane hidden when CAP_SYS_ADMIN available
```

### 2. Session Contexts (Implicit)

When sessionId is provided, we create session-specific contexts:

```typescript
// User code (existing pattern)
await sandbox.exec("cd /app", { sessionId: "user-123" });
await sandbox.exec("npm install", { sessionId: "user-123" });

// Behind the scenes
// → Creates 'session-user-123' context on first use
// → State persists within session
// → Isolated from other sessions
```

### 3. setEnvVars Integration

The existing `setEnvVars` method should update the default context:

```typescript
// User code (unchanged)
await sandbox.setEnvVars({ API_KEY: "secret" });
await sandbox.exec("echo $API_KEY");  // Works!

// Behind the scenes
// → Updates default context's environment
// → New contexts inherit these env vars
```

### 4. Advanced Usage (Explicit)

Power users can still create explicit contexts:

```typescript
// Advanced: Multiple isolated contexts
await sandbox.createContext({ 
  name: "aws",
  env: { AWS_KEY: "aws-secret" }
});

await sandbox.createContext({ 
  name: "gcp",
  env: { GCP_KEY: "gcp-secret" }
});

await sandbox.execInContext("aws", "aws s3 ls");
await sandbox.execInContext("gcp", "gcloud compute instances list");
```

## Benefits

### For Existing Users
- **No code changes required**
- **Automatic security improvements**
- **State persistence (pwd, env) now works**
- **Background processes persist**
- **Control plane protected**

### For New Users  
- **Simple API for simple cases**
- **Advanced features when needed**
- **Clear upgrade path**

### For Security
- **Isolation by default**
- **Credential separation available**
- **Process hiding automatic**

## Migration Examples

### Before (vulnerable)
```typescript
const sandbox = getSandbox(env.Sandbox, "test");
await sandbox.exec("ps aux | grep jupyter");  // Can see Jupyter!
await sandbox.exec("pkill jupyter");          // Can kill it!
```

### After (secure, same code!)
```typescript
const sandbox = getSandbox(env.Sandbox, "test");
await sandbox.exec("ps aux | grep jupyter");  // Jupyter hidden!
await sandbox.exec("pkill jupyter");          // No effect!
```

### Session State (now works!)
```typescript
const sandbox = getSandbox(env.Sandbox, "dev");
await sandbox.exec("cd /app");       // Persists!
await sandbox.exec("export FOO=bar"); // Persists!
await sandbox.exec("echo $FOO");      // Output: bar
await sandbox.exec("pwd");            // Output: /app
```

## Implementation Checklist

- [x] Default context created automatically
- [x] `exec()` uses default context implicitly
- [x] Sessions create implicit contexts
- [ ] `setEnvVars()` updates default context
- [ ] Environment inheritance for new contexts
- [x] Graceful fallback when no isolation available
- [x] Advanced API still available

## Testing

```typescript
// Test 1: Backward compatibility
const sandbox = getSandbox(env.Sandbox, "test");
const result = await sandbox.exec("echo 'Hello'");
assert(result.stdout === "Hello\n");

// Test 2: State persistence
await sandbox.exec("cd /tmp");
const pwd = await sandbox.exec("pwd");
assert(pwd.stdout.trim() === "/tmp");

// Test 3: Isolation
const ps = await sandbox.exec("ps aux");
assert(!ps.stdout.includes("jupyter"));

// Test 4: setEnvVars integration
await sandbox.setEnvVars({ MY_VAR: "test" });
const env = await sandbox.exec("echo $MY_VAR");
assert(env.stdout.trim() === "test");
```

## Summary

By making contexts implicit, we achieve:
- **100% backward compatibility**
- **Automatic security improvements**
- **Better developer experience**
- **Progressive disclosure of complexity**

The simple things remain simple, and the complex things become possible.