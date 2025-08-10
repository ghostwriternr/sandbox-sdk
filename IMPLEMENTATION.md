# Implementation Plan for Critical Security Issues

## Focus: Three Critical Problems Only

1. **Process Killing** → PID namespace isolation
2. **Port Hijacking** → Pre-binding + port reservation
3. **Credential Exposure** → Isolated execution contexts

Everything else is deferred as nice-to-have.

## Implementation Architecture

### Current State (Vulnerable)
```
Container (Single namespace)
├── All processes visible to each other
├── Shared environment variables
├── First-come-first-served ports
└── No isolation boundaries
```

### Target State (Secure with 3 Reusable Namespaces)
```
Container (Created at startup)
├── Control Namespace (Hidden, persistent)
│   ├── Bun Server (port 8080 pre-bound)
│   ├── Jupyter Kernel (port 8888 pre-bound)
│   └── Invisible to user code
│
├── User Namespace (Shared, persistent)
│   ├── Regular exec() commands run here
│   ├── Processes CAN see each other (for debugging)
│   ├── ps aux, htop, etc. work normally
│   └── NO credentials ever
│
└── Secure Namespace (Isolated, persistent)
    ├── exec() with env option runs here
    ├── Credentials exist only during execution
    ├── Cleared after each command
    └── Isolated from user namespace
```

**Key Insight**: All three namespaces are created ONCE at container startup and reused. No per-command overhead!

## Implementation Details

### Phase 1: Container Startup (One-Time Setup)

```typescript
// container_src/index.ts
class ContainerServer {
  private namespaces: {
    control: Namespace;
    user: Namespace;
    secure: Namespace;
  };
  
  async initialize() {
    // Step 1: Pre-bind critical ports immediately
    this.bunServer = Bun.serve({ port: 8080 });
    
    // Step 2: Create three persistent namespaces
    if (await this.hasCapSysAdmin()) {
      this.namespaces = await this.createNamespaces();
    } else {
      // Local dev fallback - everything in one namespace
      this.namespaces = await this.createFallbackNamespaces();
    }
    
    // Step 3: Start control plane in control namespace
    await this.namespaces.control.exec('jupyter kernel --port 8888');
    
    console.log('Container initialized with 3 namespaces');
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

### Phase 2: Smart exec() Routing

```typescript
// container_src/api/execute.ts
export async function execute(
  command: string,
  options?: ExecOptions
) {
  // Smart namespace selection based on options
  const namespace = selectNamespace(options);
  
  // Execute in selected namespace
  return await namespace.exec(command, options);
}

function selectNamespace(options?: ExecOptions): Namespace {
  // If environment variables provided, use secure namespace
  if (options?.env && Object.keys(options.env).length > 0) {
    return namespaces.secure;
  }
  
  // Otherwise use shared user namespace
  return namespaces.user;
}
```

### Phase 3: Namespace Implementation

```typescript
// container_src/utils/namespace.ts
class Namespace {
  private nsProcess: ChildProcess;
  private nsPid: number;
  
  constructor(options: NamespaceOptions) {
    // Create namespace with long-lived process
    this.nsProcess = spawn('unshare', [
      ...(options.pid ? ['--pid', '--fork', '--mount-proc'] : []),
      ...(options.mount ? ['--mount'] : []),
      ...(options.net ? ['--net'] : []),
      'sh', '-c', 'sleep infinity'  // Keep namespace alive
    ]);
    
    this.nsPid = this.nsProcess.pid;
  }
  
  async exec(command: string, options?: ExecOptions) {
    // Execute command in this namespace
    const child = spawn('nsenter', [
      `--target=${this.nsPid}`,
      ...(this.options.pid ? ['--pid'] : []),
      ...(this.options.mount ? ['--mount'] : []),
      '--',
      'sh', '-c', command
    ], {
      env: this.prepareEnv(options?.env),
      cwd: options?.cwd || '/workspace'
    });
    
    return await collectOutput(child);
  }
  
  private prepareEnv(userEnv?: Record<string, string>) {
    if (this.name === 'secure' && userEnv) {
      // Secure namespace: Only specified env vars
      return {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: '/workspace',
        ...userEnv  // Only user-provided vars
      };
    } else {
      // User/control namespace: Inherit current env
      return { ...process.env, ...userEnv };
    }
  }
}
```

## Testing & Validation

### Test 1: Control Plane Protection
```typescript
test('Control plane is invisible and unkillable', async () => {
  // User code can't see Jupyter/Bun
  const ps = await sandbox.exec('ps aux');
  expect(ps.stdout).not.toContain('jupyter');
  expect(ps.stdout).not.toContain('bun serve');
  
  // User code can't kill them
  await sandbox.exec('pkill jupyter');
  await sandbox.exec('pkill bun');
  
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

### Test 3: Automatic Credential Isolation
```typescript
test('Credentials auto-isolated when env provided', async () => {
  // Command with env automatically uses secure namespace
  await sandbox.exec('aws s3 ls', {
    env: { AWS_ACCESS_KEY_ID: 'secret123' }
  });
  
  // Next command can't see it
  const check = await sandbox.exec('echo $AWS_ACCESS_KEY_ID');
  expect(check.stdout.trim()).toBe('');
  
  // Can't find in any /proc
  const proc = await sandbox.exec('cat /proc/*/environ 2>/dev/null | grep -c secret123');
  expect(proc.stdout.trim()).toBe('0');
});
```

### Test 4: User Namespace Process Visibility
```typescript
test('User processes can see each other for debugging', async () => {
  // Start a long-running process
  await sandbox.exec('sleep 30 &');
  
  // Another command can see it
  const ps = await sandbox.exec('ps aux | grep sleep');
  expect(ps.stdout).toContain('sleep 30');
  
  // But still can't see control plane
  expect(ps.stdout).not.toContain('jupyter');
});
```

## Implementation Timeline

### Week 1: Core Infrastructure
**Goal**: Three-namespace architecture + port protection

1. **Day 1-2**: Namespace manager implementation
   - Create `container_src/utils/namespace.ts`
   - Implement namespace creation and reuse
   - Add capability detection
   
2. **Day 3**: Port pre-binding
   - Modify container startup sequence
   - Pre-bind 8080 and 8888
   
3. **Day 4**: Update exec() routing
   - Modify `/api/execute` endpoint
   - Add smart namespace selection
   
4. **Day 5**: Testing
   - Verify namespace isolation
   - Test fallback for local dev

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
├── index.ts              # Add namespace initialization
├── api/
│   └── execute.ts        # Update with smart routing
├── services/
│   ├── jupyter.ts        # Start in control namespace
│   └── process.ts        # Update to use namespaces
└── utils/
    ├── namespace.ts      # NEW: Namespace manager
    └── capabilities.ts   # NEW: Detect CAP_SYS_ADMIN
```

### SDK Client
```
packages/sandbox/src/
├── index.ts              # No changes needed!
├── client/
│   └── methods.ts        # Update exec() signature
└── types.ts              # Add env to ExecOptions
```

### Key Changes

1. **container_src/utils/namespace.ts** (NEW)
   - Namespace creation and management
   - Reusable namespace instances
   - Exec routing logic

2. **container_src/index.ts** (MODIFY)
   - Create 3 namespaces at startup
   - Pre-bind ports 8080/8888
   - Start Jupyter in control namespace

3. **container_src/api/execute.ts** (MODIFY)
   - Check for env option
   - Route to appropriate namespace
   - No new endpoint needed!

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Namespace escape vulnerability | High | Monitor kernel CVEs, update base image regularly |
| Reusable namespace contamination | Medium | Clear environment after each secure exec |
| Local dev confusion | Low | Clear warning messages, graceful fallback |
| File sharing between namespaces | Medium | Mount shared /workspace carefully |
| Debugging complexity | Low | User namespace preserves normal debugging |