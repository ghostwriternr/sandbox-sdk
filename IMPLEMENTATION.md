# Implementation Plan for Critical Security Issues

## Focus: Three Critical Problems Only

1. **Process Killing** → PID namespace isolation
2. **Port Hijacking** → Pre-binding + port reservation
3. **Credential Exposure** → Isolated execution contexts

Everything else is deferred as nice-to-have.

## Implementation Architecture

### Current State (Vulnerable)
```
Container
├── All processes in same namespace
├── All processes see each other
├── All processes share environment
└── First-come-first-served ports
```

### Target State (Secure)
```
Container
├── Control Plane (Hidden PID namespace)
│   ├── Bun Server (port 8080 pre-bound)
│   └── Jupyter Kernel (port 8888 pre-bound)
└── User Space (Default namespace)
    ├── User code (can't see control plane)
    └── Isolated executions (for credentials)
```

## Implementation Details

### 1. Process Killing Prevention

**Approach**: Hide control plane in separate PID namespace

**Implementation in Bun Server**:
```typescript
// container_src/index.ts
class ContainerServer {
  async initialize() {
    if (this.hasCapSysAdmin()) {
      // Start Jupyter in hidden namespace
      await this.startJupyterIsolated();
    } else {
      // Local dev fallback
      await this.startJupyterNormal();
    }
  }
  
  private async startJupyterIsolated() {
    const child = spawn('unshare', [
      '--pid',           // New PID namespace
      '--fork',          // Fork before exec
      '--mount-proc',    // Mount new /proc
      'jupyter', 'kernel'
    ]);
    
    // Jupyter now invisible to user code
    this.jupyterPid = child.pid;
  }
}
```

**Result**: User code can't see or kill Jupyter/Bun

### 2. Port Hijacking Prevention

**Approach**: Pre-bind critical ports on container startup

**Implementation**:
```typescript
// container_src/index.ts
class ContainerServer {
  constructor() {
    // Immediately claim critical ports
    this.bunServer = Bun.serve({
      port: 8080,
      fetch: this.handleRequest.bind(this)
    });
    
    // Reserve Jupyter port
    this.jupyterSocket = net.createServer();
    this.jupyterSocket.listen(8888);
  }
}
```

**Result**: User code gets EADDRINUSE if trying to bind 8080/8888

### 3. Credential Isolation

**Approach**: Run credential-needing commands in isolated namespace

**Implementation**:
```typescript
// container_src/api/execute-secure.ts
export async function executeSecure(
  command: string,
  env: Record<string, string>,
  options?: { timeout?: number }
) {
  // Check for capability
  if (!hasCapSysAdmin()) {
    // Fallback: run with warning
    console.warn('[SECURITY] Running without isolation');
    return executeNormal(command, { env });
  }
  
  // Create isolated execution
  const child = spawn('unshare', [
    '--pid',      // Separate PID namespace
    '--mount',    // Separate mount namespace
    '--fork',     // Fork before exec
    'sh', '-c', command
  ], {
    env: {
      PATH: process.env.PATH,  // Keep PATH
      HOME: '/workspace',       // Set HOME
      ...env                    // Add secrets
    },
    cwd: '/workspace',
    timeout: options?.timeout || 60000
  });
  
  // Collect output
  const stdout = [];
  const stderr = [];
  
  child.stdout.on('data', d => stdout.push(d));
  child.stderr.on('data', d => stderr.push(d));
  
  await new Promise((resolve, reject) => {
    child.on('exit', resolve);
    child.on('error', reject);
  });
  
  return {
    stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
    exitCode: child.exitCode || 0
  };
}
```

**Result**: Credentials never enter main process environment

## Testing & Validation

### Critical Issue #1: Process Killing
```typescript
// Test: User code cannot kill control plane
test('Control plane is unkillable', async () => {
  // Try to kill Jupyter
  const result = await sandbox.exec('pkill jupyter');
  expect(result.stderr).toContain('no process found');
  
  // Verify Jupyter still running
  const health = await sandbox.ping();
  expect(health.jupyter).toBe('running');
});
```

### Critical Issue #2: Port Hijacking
```typescript
// Test: User code cannot steal control ports
test('Control ports are protected', async () => {
  // Try to bind port 8080
  const result = await sandbox.exec(`
    node -e "require('http').createServer().listen(8080)"
  `);
  expect(result.stderr).toContain('EADDRINUSE');
  
  // Control plane still accessible
  const response = await fetch('http://localhost:8080/health');
  expect(response.ok).toBe(true);
});
```

### Critical Issue #3: Credential Isolation
```typescript
// Test: Credentials don't leak to user code
test('Credentials are isolated', async () => {
  // Run secure command with credentials
  await sandbox.execSecure('echo "deployed"', {
    env: { AWS_SECRET: 'secret123' }
  });
  
  // User code can't see credentials
  const result = await sandbox.exec('echo $AWS_SECRET');
  expect(result.stdout.trim()).toBe('');
  
  // Can't read from /proc either
  const proc = await sandbox.exec('cat /proc/*/environ | grep AWS');
  expect(proc.stdout).not.toContain('secret123');
});
```

## Implementation Order & Timeline

### Phase 1: Control Plane Protection (Week 1)
**Goal**: Prevent process killing and port hijacking

1. **Day 1-2**: Pre-bind ports 8080/8888 on startup
   - Modify `container_src/index.ts`
   - Test port protection
   
2. **Day 3-4**: PID namespace for Jupyter (if CAP_SYS_ADMIN available)
   - Add namespace detection
   - Implement fallback for local dev
   
3. **Day 5**: Testing & validation
   - Verify control plane can't be killed
   - Verify ports can't be hijacked

### Phase 2: Credential Isolation (Week 2)  
**Goal**: Implement execSecure() API

1. **Day 1-2**: Add execSecure endpoint to Bun server
   - `/api/execute-secure` endpoint
   - Namespace creation logic
   
2. **Day 3-4**: SDK client implementation
   - Add `execSecure()` method
   - Add `hasSecureExecution()` check
   
3. **Day 5**: Integration testing
   - Test with real AWS CLI
   - Verify credential isolation

### Phase 3: Production Release (Week 3)
**Goal**: Ship and migrate users

1. **Day 1-2**: Documentation
   - Migration guide
   - Security best practices
   
2. **Day 3-4**: Gradual rollout
   - Deploy to staging
   - Monitor for issues
   
3. **Day 5**: General availability
   - Publish new SDK version
   - Announce security improvements

## Key Technical Enablers

### Production Capabilities (Confirmed)
```bash
# Production has everything we need:
CAP_SYS_ADMIN: ✅  # Can create namespaces
PID namespaces: ✅  # Can hide processes
Mount namespaces: ✅  # Can isolate /proc
Network namespaces: ✅  # Can isolate network (if needed)

# Local dev is restricted (expected):
CAP_SYS_ADMIN: ❌  # For developer safety
```

### Fallback Strategy for Local Development
```typescript
// Detect capabilities and adapt
function hasCapSysAdmin(): boolean {
  try {
    execSync('unshare --pid true');
    return true;
  } catch {
    return false;  // Local dev environment
  }
}

// Use appropriate strategy
if (hasCapSysAdmin()) {
  // Production: Full isolation
  await executeInNamespace(command, env);
} else {
  // Local: Best-effort isolation
  console.warn('[DEV] Running without namespace isolation');
  await executeWithWarning(command, env);
}
```

## Files to Modify

### Container (Bun Server)
```
container_src/
├── index.ts           # Add port pre-binding, capability detection
├── api/
│   ├── execute.ts     # Existing execution endpoint
│   └── execute-secure.ts  # NEW: Isolated execution endpoint
├── services/
│   ├── jupyter.ts     # Modify to use namespace if available
│   └── process.ts     # Add namespace support
└── utils/
    └── capabilities.ts  # NEW: Detect CAP_SYS_ADMIN
```

### SDK Client
```
packages/sandbox/src/
├── index.ts           # Add execSecure, hasSecureExecution
├── client/
│   └── methods.ts     # Add new secure methods
└── types.ts           # Add SecureExecOptions interface
```

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|---------|------------|  
| Namespace escape vulnerability | High | Monitor kernel CVEs, update regularly |
| Performance overhead | Low | Benchmark, optimize, cache namespaces |
| Local dev incompatibility | Medium | Detect and fallback gracefully |
| Migration complexity | Medium | Clear docs, automated migration tools |
| Breaking existing code | Low | Backward compatible by default |