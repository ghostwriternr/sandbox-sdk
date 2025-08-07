# Namespace Isolation Implementation Plan

## Critical Execution Context Analysis

### The Claude Code Scenario Breakdown

When a platform developer runs `claude -p "Create a bun app and deploy it to our AWS account"`, we have multiple execution contexts with different security requirements:

#### Scenario 1: Claude Code Process Initialization
```bash
# Platform developer starts Claude Code
claude -p "Create a bun app and deploy it to our AWS account"
```
- **Process**: Claude Code main process
- **Needs**: ANTHROPIC_API_KEY (to call Claude API)
- **Execution**: `startProcessWithSecrets('claude ...', {env: {ANTHROPIC_API_KEY}})`
- **Security**: ✅ Isolated namespace with platform secrets

#### Scenario 2: Claude Code Using Platform Tools
```bash
# Claude Code executes commands to create/deploy
npx create-bun-app my-app
aws s3 cp ./dist s3://platform-bucket/
aws ecs update-service --cluster prod --service my-app
```
- **Process**: Commands run BY Claude Code
- **Needs**: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (platform's AWS account)
- **Execution**: Claude Code internally uses `execWithSecrets()` for these
- **Security**: ✅ Each command in isolated namespace with necessary secrets

#### Scenario 3: Claude Code Testing Generated Code
```bash
# Claude Code tests the app it just wrote
cd my-app && npm test
node server.js  # Testing if server starts
```
- **Process**: Generated app code being tested
- **Needs**: NO platform secrets (this is user code now!)
- **Execution**: Claude Code uses regular `exec()` for these
- **Security**: ✅ Runs in main namespace, no access to secrets

#### Scenario 4: Claude Code Starting Dev Server
```bash
# Claude might start a dev server to verify the app works
npm run dev  # or: node app.js
```
- **Process**: User application server
- **Needs**: NO platform secrets
- **Execution**: Regular `exec()` or `startProcess()`
- **Security**: ✅ Main namespace, no secrets
- **Trap**: Claude might do this automatically without being asked!

#### Scenario 5: Platform Developer Running Dev Server
```bash
# Platform developer manually starts the generated app
npm run dev
```
- **Process**: User application
- **Needs**: NO platform secrets
- **Execution**: `exec('npm run dev')`
- **Security**: ✅ Main namespace, no secrets

### The Critical Design Challenge

The challenge is that Claude Code (or any AI agent) needs to intelligently decide WHEN to use secrets:

```typescript
// Inside Claude Code's execution logic (pseudocode)
class ClaudeCodeExecutor {
  async executeCommand(command: string) {
    // Claude Code needs to decide: does this need platform secrets?
    
    if (this.isPlatformOperation(command)) {
      // AWS CLI, gcloud, npm publish, etc.
      return await sandbox.execWithSecrets(command, {
        env: this.platformSecrets
      });
    } else {
      // Running user code, tests, dev servers
      return await sandbox.exec(command);
    }
  }
  
  isPlatformOperation(command: string): boolean {
    // Heuristics: aws, gcloud, npm publish, docker push, etc.
    const platformCommands = ['aws', 'gcloud', 'npm publish', 'docker push'];
    return platformCommands.some(cmd => command.startsWith(cmd));
  }
}
```

### Real-World Execution Patterns

#### Pattern A: AI Agent as Long-Running Process
```typescript
// Start Claude Code with platform secrets
const claudeProcess = await sandbox.startProcessWithSecrets('claude', {
  env: {
    ANTHROPIC_API_KEY: secrets.anthropic,
    AWS_ACCESS_KEY_ID: secrets.aws.key,
    AWS_SECRET_ACCESS_KEY: secrets.aws.secret
  }
});

// Claude Code internally decides when to use secrets
// It has them available but chooses when to expose them to subprocesses
```

#### Pattern B: Platform Orchestrator Approach
```typescript
// Platform controls what gets secrets
async function runClaudeTask(prompt: string) {
  // Parse Claude's intended action
  const action = await claude.getNextAction(prompt);
  
  if (action.type === 'deploy') {
    // Platform knows this needs secrets
    return await sandbox.execWithSecrets(action.command, {
      env: { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY }
    });
  } else if (action.type === 'test') {
    // Platform knows this shouldn't have secrets
    return await sandbox.exec(action.command);
  }
}
```

#### Pattern C: Hybrid - Selective Secret Injection
```typescript
// Claude Code starts without secrets
const claude = await sandbox.startProcess('claude');

// Platform injects secrets only for specific operations
claude.on('needs_aws_deploy', async (command) => {
  return await sandbox.execWithSecrets(command, { env: awsCreds });
});

claude.on('run_user_code', async (command) => {
  return await sandbox.exec(command);  // No secrets
});
```

### The Uncontrollable AI Problem

**Critical Issue**: AI models are not 100% steerable. Even with clear instructions, Claude Code might:

1. **Unexpectedly start servers**: Even when just asked to "create" an app, it might test it
2. **Mix contexts**: Run `aws s3 ls && node test.js` in a single command
3. **Use different tools**: Use Python's boto3 instead of AWS CLI
4. **Create wrapper scripts**: Write a deploy.sh that needs credentials

This means we CANNOT rely on the AI to always make the right decision about security contexts.

### Proposed Solution Architecture

Given these complexities, our implementation needs to support:

1. **Explicit Secret Boundaries**: Make it impossible to accidentally leak secrets
2. **Granular Control**: Each command can be individually secured
3. **Default-Deny**: By default, NO secrets are available
4. **Audit Trail**: Log every secret access for review

```typescript
// The API makes the boundary explicit
await sandbox.exec('node app.js');  // NEVER has secrets
await sandbox.execWithSecrets('aws s3 ls', { env });  // ONLY has specified secrets

// Even if Claude Code has secrets in its process:
const claude = await sandbox.startProcessWithSecrets('claude', { env: allSecrets });

// The code it generates and runs won't inherit them:
// Inside Claude's execution, when it runs: exec('node app.js')
// That subprocess won't see the secrets
```

## Executive Summary

This document details the technical implementation of namespace-based credential isolation for the Cloudflare Sandbox SDK. We'll modify the bun server (`container_src/index.ts`) to leverage Linux namespaces (available in production with CAP_SYS_ADMIN) to create isolated execution contexts.

The critical insight is that AI agents like Claude Code need platform secrets to perform deployments, but the code they generate must never have access to these secrets. Our implementation uses Linux namespaces to create this security boundary.

## Architecture Overview

```
┌─────────────────────────────────────┐
│         Worker (Your Code)          │
│  - Holds platform secrets           │
│  - Makes RPC calls to DO            │
└──────────────┬──────────────────────┘
               │ RPC
┌──────────────▼──────────────────────┐
│      Durable Object (Sandbox)       │
│  - Receives exec commands           │
│  - Forwards to container            │
└──────────────┬──────────────────────┘
               │ HTTP
┌──────────────▼──────────────────────┐
│    Bun Server (container_src)       │
│  ┌─────────────────────────────┐    │
│  │  Namespace Manager (NEW)    │    │
│  │  - Creates isolated spaces  │    │
│  │  - Manages credentials      │    │
│  └─────────────────────────────┘    │
│  ┌─────────────────────────────┐    │
│  │    Main Namespace           │    │
│  │  - User code execution      │    │
│  │  - No access to secrets     │    │
│  └─────────────────────────────┘    │
│  ┌─────────────────────────────┐    │
│  │  Isolated Namespace(s)      │    │
│  │  - Platform operations      │    │
│  │  - Has injected secrets     │    │
│  └─────────────────────────────┘    │
└──────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Core Namespace Support (Week 1)

#### 1.1 Modify Bun Server Routes

**File: `container_src/index.ts`**

Add new routes for secure execution:

```typescript
// Existing route
app.post("/api/execute", executeHandler);

// NEW: Secure execution route
app.post("/api/execute-secure", executeSecureHandler);

// NEW: Secure process start route  
app.post("/api/process/start-secure", startProcessSecureHandler);
```

#### 1.2 Create Namespace Manager

**New File: `container_src/namespaceManager.ts`**

```typescript
import { spawn, type Subprocess } from "bun";
import { randomUUID } from "crypto";

interface NamespaceOptions {
  env: Record<string, string>;
  cwd?: string;
  timeout?: number;
  stdin?: string;
}

class NamespaceManager {
  private activeNamespaces = new Map<string, Subprocess>();
  
  async executeInNamespace(
    command: string,
    options: NamespaceOptions
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const namespaceId = randomUUID();
    
    // Build unshare command
    const unshareArgs = [
      '--pid',      // Isolate process IDs
      '--mount',    // Isolate filesystem
      '--fork',     // Fork before exec
      '--',         // End of unshare options
      'sh', '-c', command
    ];
    
    // Create minimal environment
    const minimalEnv = {
      PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: '/tmp',
      USER: 'sandbox',
      TERM: 'xterm-256color',
      ...options.env  // Add secrets here
    };
    
    try {
      // Spawn in isolated namespace
      const proc = spawn(['unshare', ...unshareArgs], {
        env: minimalEnv,
        cwd: options.cwd || '/app',
        stdin: options.stdin ? 'pipe' : 'inherit',
        stdout: 'pipe',
        stderr: 'pipe'
      });
      
      // Track for cleanup
      this.activeNamespaces.set(namespaceId, proc);
      
      // Handle stdin if provided
      if (options.stdin && proc.stdin) {
        const writer = proc.stdin.getWriter();
        await writer.write(new TextEncoder().encode(options.stdin));
        await writer.close();
      }
      
      // Apply timeout if specified
      let timeoutHandle: Timer | null = null;
      if (options.timeout) {
        timeoutHandle = setTimeout(() => {
          proc.kill();
        }, options.timeout);
      }
      
      // Collect output
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text()
      ]);
      
      // Wait for exit
      const exitCode = await proc.exited;
      
      // Cleanup
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.activeNamespaces.delete(namespaceId);
      
      return { stdout, stderr, exitCode };
      
    } catch (error) {
      this.activeNamespaces.delete(namespaceId);
      throw error;
    }
  }
  
  async startProcessInNamespace(
    command: string,
    options: NamespaceOptions
  ): Promise<{ id: string; pid: number }> {
    const processId = randomUUID();
    
    const unshareArgs = [
      '--pid',
      '--mount', 
      '--fork',
      '--',
      'sh', '-c', command
    ];
    
    const minimalEnv = {
      PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: '/tmp',
      USER: 'sandbox',
      ...options.env
    };
    
    const proc = spawn(['unshare', ...unshareArgs], {
      env: minimalEnv,
      cwd: options.cwd || '/app',
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe'
    });
    
    this.activeNamespaces.set(processId, proc);
    
    // Store process info for later retrieval
    processStore.set(processId, {
      id: processId,
      pid: proc.pid,
      command,
      isolated: true,  // Mark as isolated
      startTime: Date.now()
    });
    
    return { id: processId, pid: proc.pid };
  }
  
  // Clean up all namespaces on shutdown
  cleanup() {
    for (const [id, proc] of this.activeNamespaces) {
      proc.kill();
    }
    this.activeNamespaces.clear();
  }
}

export const namespaceManager = new NamespaceManager();
```

#### 1.3 Implement Secure Execution Handler

**File: `container_src/handler/execSecure.ts`**

```typescript
import { namespaceManager } from "../namespaceManager";

export async function executeSecureHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { command, env = {}, cwd, timeout, stdin } = body;
    
    // Validate command
    if (!command || typeof command !== 'string') {
      return Response.json(
        { error: 'Invalid command' },
        { status: 400 }
      );
    }
    
    // Check for CAP_SYS_ADMIN (production only)
    const hasCapability = await checkCapSysAdmin();
    if (!hasCapability) {
      console.warn(
        '[SECURITY] CAP_SYS_ADMIN not available - falling back to process isolation'
      );
      // In local dev, fall back to regular execution with warning
      // This is less secure but maintains functionality
      return executeWithWarning(command, env, cwd, timeout);
    }
    
    // Execute in isolated namespace
    const result = await namespaceManager.executeInNamespace(command, {
      env,
      cwd,
      timeout,
      stdin
    });
    
    return Response.json({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      isolated: true  // Indicate this ran in isolation
    });
    
  } catch (error) {
    console.error('[execSecure] Error:', error);
    return Response.json(
      { error: error.message },
      { status: 500 }
    );
  }
}

async function checkCapSysAdmin(): Promise<boolean> {
  try {
    // Check if we can create namespaces
    const { exitCode } = await Bun.spawn(
      ['unshare', '--pid', '--fork', 'true'],
      { stdout: 'pipe', stderr: 'pipe' }
    ).exited;
    
    return exitCode === 0;
  } catch {
    return false;
  }
}
```

### Phase 2: SDK Integration (Week 1-2)

#### 2.1 Update SDK Methods

**File: `packages/sandbox/src/sandbox.ts`**

```typescript
export class Sandbox {
  // Existing method
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const response = await this.request('/api/execute', {
      command,
      env: options?.env,
      cwd: options?.cwd,
      timeout: options?.timeout
    });
    
    return response.json();
  }
  
  // NEW: Secure execution with secrets
  async execWithSecrets(
    command: string,
    options?: ExecWithSecretsOptions
  ): Promise<ExecResult> {
    // Validate that secrets are provided
    if (!options?.env || Object.keys(options.env).length === 0) {
      throw new Error(
        'execWithSecrets requires environment variables to be specified'
      );
    }
    
    const response = await this.request('/api/execute-secure', {
      command,
      env: options.env,
      cwd: options.cwd,
      timeout: options.timeout
    });
    
    const result = await response.json();
    
    // Log for audit purposes
    console.log(
      `[AUDIT] Executed with secrets: ${command.split(' ')[0]}`
    );
    
    return result;
  }
  
  // NEW: Start process with secrets
  async startProcessWithSecrets(
    command: string,
    options?: ProcessWithSecretsOptions
  ): Promise<Process> {
    const response = await this.request('/api/process/start-secure', {
      command,
      env: options?.env,
      cwd: options?.cwd
    });
    
    return response.json();
  }
}
```

#### 2.2 Update TypeScript Definitions

**File: `packages/sandbox/src/types.ts`**

```typescript
export interface ExecWithSecretsOptions {
  env: Record<string, string>;  // Required for secrets
  cwd?: string;
  timeout?: number;
  stdin?: string;
}

export interface ProcessWithSecretsOptions {
  env: Record<string, string>;  // Required for secrets
  cwd?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  isolated?: boolean;  // Indicates if ran in isolated namespace
}
```

### Phase 3: File System Sharing (Week 2)

#### 3.1 Shared Directory Setup

Challenge: Isolated namespaces have separate mount namespaces, so files written in one namespace might not be visible in another.

Solution: Use bind mounts to share specific directories.

```typescript
// In namespaceManager.ts
async executeInNamespace(command: string, options: NamespaceOptions) {
  // Create a wrapper script that sets up bind mounts
  const wrapperScript = `
#!/bin/sh
# Ensure /app is shared between namespaces
mount --bind /app /app 2>/dev/null || true

# Ensure /tmp is shared for inter-process communication
mount --bind /tmp /tmp 2>/dev/null || true

# Execute the actual command
exec ${command}
`;

  // Write wrapper to temp file
  const wrapperPath = `/tmp/wrapper_${randomUUID()}.sh`;
  await fs.writeFile(wrapperPath, wrapperScript);
  await fs.chmod(wrapperPath, 0o755);
  
  // Execute wrapper in namespace
  const unshareArgs = [
    '--pid',
    '--mount',
    '--fork',
    '--',
    wrapperPath
  ];
  
  // ... rest of execution
}
```

### Phase 4: Process Visibility Control (Week 2)

#### 4.1 Hide Isolated Processes from Main Namespace

```typescript
// In processHandler.ts
export async function listProcessesHandler(req: Request): Promise<Response> {
  const allProcesses = processStore.getAll();
  
  // Filter out isolated processes from regular list
  const visibleProcesses = allProcesses.filter(p => !p.isolated);
  
  return Response.json({ processes: visibleProcesses });
}

// Add new endpoint for listing ALL processes (admin use)
export async function listAllProcessesHandler(req: Request): Promise<Response> {
  const allProcesses = processStore.getAll();
  
  return Response.json({ 
    processes: allProcesses,
    isolated: allProcesses.filter(p => p.isolated),
    regular: allProcesses.filter(p => !p.isolated)
  });
}
```

### Phase 5: Testing & Validation (Week 2-3)

#### 5.1 Using the Security Test Worker

The primary validation tool is the security test worker at `examples/security-test/`. This provides comprehensive validation without needing complex test infrastructure.

**Deploy and test:**
```bash
cd examples/security-test
npm install
npm run deploy

# Test current vulnerabilities
curl https://your-worker.workers.dev/test-isolation

# Validate implementation (works for both v1.x and v2.0)
curl https://your-worker.workers.dev/test-comprehensive
```

**Expected results after implementation:**
```json
{
  "summary": {
    "status": "SECURE",
    "message": "🎉 Namespace isolation working correctly!",
    "implementation": "v2.0 (with isolation)",
    "passed": 8,
    "failed": 0
  }
}
```

#### 5.2 Key Tests Performed

The `/test-comprehensive` endpoint validates:

1. **Environment Variable Isolation**
   - Secrets set with `execWithSecrets()` not visible to regular `exec()`
   - Python/Node.js subprocesses cannot access secrets

2. **Process Visibility**
   - Processes started with `startProcessWithSecrets()` hidden from `listProcesses()`
   - Cannot read `/proc/[pid]/environ` across namespaces

3. **File System Sharing**
   - Files written in isolated namespace accessible in main namespace
   - Shared `/app` and `/tmp` directories work correctly

4. **Performance**
   - Namespace creation overhead < 10ms
   - No degradation in file I/O operations

5. **Attack Vectors**
   - NPM postinstall scripts cannot access secrets
   - Process scanning tools cannot find isolated processes

#### 5.3 Local vs Production Testing

**Local Development:**
- Will show warnings about missing CAP_SYS_ADMIN
- Falls back to process-level isolation
- Still validates API functionality

**Production:**
- Full namespace isolation with CAP_SYS_ADMIN
- All security tests should pass
- Performance metrics accurate

## Performance Considerations

### Namespace Creation Overhead

Creating a new namespace adds ~5ms overhead. Strategies to minimize impact:

1. **Namespace Pooling** (Future optimization)
```typescript
class NamespacePool {
  private available: NamespaceInstance[] = [];
  private inUse = new Map<string, NamespaceInstance>();
  
  async acquire(env: Record<string, string>): Promise<NamespaceInstance> {
    // Reuse existing namespace if available
    let instance = this.available.pop();
    if (!instance) {
      instance = await this.createNamespace();
    }
    
    // Inject environment
    await instance.setEnvironment(env);
    return instance;
  }
  
  async release(instance: NamespaceInstance) {
    // Clear environment
    await instance.clearEnvironment();
    this.available.push(instance);
  }
}
```

2. **Long-Running Processes**
For operations that need multiple commands with the same secrets, use `startProcessWithSecrets()` and communicate via stdin/stdout.

### Memory Considerations

Each namespace has minimal memory overhead (~1MB), but we should:
- Limit concurrent namespaces (e.g., max 10)
- Implement automatic cleanup after timeout
- Monitor memory usage in production

## Migration Strategy

### Phase 1: Deprecation Warnings (v1.9.0)
```typescript
async setEnvVars(vars: Record<string, string>) {
  console.warn(
    '[DEPRECATED] setEnvVars() exposes secrets to all code. ' +
    'Migrate to execWithSecrets() for secure execution. ' +
    'See: https://docs.cloudflare.com/sandbox/security'
  );
  
  // Continue working for backward compatibility
  this.envVars = { ...this.envVars, ...vars };
}
```

### Phase 2: Feature Release (v2.0.0)
- Remove `setEnvVars()` completely
- Make `execWithSecrets()` the standard for secret operations
- Provide migration tool to update existing code

### Migration Tool
```bash
# Automated migration script
npx @cloudflare/sandbox-migrate v2

# What it does:
# 1. Finds all setEnvVars() calls
# 2. Identifies which exec() calls need secrets
# 3. Converts to execWithSecrets()
# 4. Updates imports and types
```

## Local Development Support

Since local development lacks CAP_SYS_ADMIN, we need graceful degradation:

```typescript
class LocalDevFallback {
  async executeWithSecrets(command: string, env: Record<string, string>) {
    console.warn(
      '⚠️  LOCAL DEV MODE: Running without namespace isolation\n' +
      '   Secrets are temporarily exposed to all processes.\n' +
      '   This is NOT how production behaves.'
    );
    
    // Create a subprocess with limited exposure
    const proc = spawn(['sh', '-c', command], {
      env: {
        ...process.env,
        ...env,
        _CLOUDFLARE_SANDBOX_INSECURE: 'true'  // Flag for detection
      }
    });
    
    // Immediately clear from parent process.env
    // (Still exposed in child, but better than global)
    
    return await collectOutput(proc);
  }
}
```

## Monitoring & Observability

### Audit Logging
```typescript
interface AuditLog {
  timestamp: number;
  operation: 'execWithSecrets' | 'startProcessWithSecrets';
  command: string;
  secretKeys: string[];  // Just key names, not values
  userId: string;
  duration: number;
  isolated: boolean;
}

class AuditLogger {
  private logs: AuditLog[] = [];
  
  log(entry: AuditLog) {
    this.logs.push(entry);
    
    // Send to monitoring service
    if (process.env.MONITORING_ENDPOINT) {
      fetch(process.env.MONITORING_ENDPOINT, {
        method: 'POST',
        body: JSON.stringify(entry)
      }).catch(console.error);
    }
  }
  
  getRecentLogs(limit = 100): AuditLog[] {
    return this.logs.slice(-limit);
  }
}
```

### Metrics to Track
- Namespace creation latency
- Number of concurrent namespaces
- Secret operation frequency
- Isolation failures (fallback to regular exec)
- Memory usage per namespace

## Error Handling

### Common Errors and Solutions

1. **CAP_SYS_ADMIN Not Available**
```typescript
if (!hasCapSysAdmin) {
  return {
    error: 'CAPABILITY_MISSING',
    message: 'Namespace isolation not available in this environment',
    fallback: 'Using process-level isolation with reduced security'
  };
}
```

2. **Namespace Creation Failure**
```typescript
try {
  await createNamespace();
} catch (error) {
  if (error.code === 'EMFILE') {
    // Too many open files/processes
    await cleanupOldNamespaces();
    return retry();
  }
  throw error;
}
```

3. **Timeout Handling**
```typescript
const timeout = setTimeout(() => {
  namespace.kill('SIGTERM');
  setTimeout(() => {
    namespace.kill('SIGKILL');  // Force kill after grace period
  }, 5000);
}, options.timeout);
```

## Success Criteria

### Production Environment Success Metrics

These are the specific, measurable criteria that indicate our implementation is successful:

#### 1. Namespace Isolation Tests ✅

| Test | Current State | Success State | How to Verify |
|------|--------------|---------------|---------------|
| **Environment Variable Isolation** | `exec('echo $SECRET')` shows secrets | Returns empty string | Run test with `execWithSecrets()` then `exec()` |
| **Process Visibility** | All processes visible via `ps aux` | Isolated processes invisible | Start process with secrets, check `ps` output |
| **/proc/*/environ Access** | Can read any process's environment | Cannot access across namespaces | Try `cat /proc/[pid]/environ` from main namespace |
| **Cross-Process Memory** | Can potentially read via `/proc/[pid]/mem` | Access denied across namespaces | Attempt memory read from different namespace |
| **Process Count** | `ps aux \| wc -l` shows all processes | Only shows main namespace processes | Compare counts before/after isolated process |

#### 2. Functional Requirements ✅

| Requirement | Success Criteria | Test Method |
|------------|------------------|-------------|
| **AWS CLI Works** | Can deploy with credentials in isolation | `execWithSecrets('aws s3 ls', {env: AWS_CREDS})` |
| **File Sharing** | Files written in isolated namespace visible in main | Write file in isolated, read from main |
| **Database Tools** | psql/mysql work with isolated credentials | Run migration with `execWithSecrets()` |
| **AI Agent Support** | Claude Code can deploy with secrets | Start Claude with `startProcessWithSecrets()` |
| **No Global Pollution** | Main `process.env` never contains secrets | Check `process.env` in bun server after operations |

#### 3. Security Validation ✅

| Attack Vector | Current Vulnerability | Success Protection | Validation Test |
|--------------|----------------------|-------------------|---------------|
| **Direct Access** | `echo $SECRET_KEY` exposes value | No output | Set secret, try to echo |
| **Python Introspection** | `os.environ['SECRET']` works | KeyError or empty | Run Python script checking env |
| **Node.js Access** | `process.env.SECRET` accessible | undefined | Execute Node.js env dump |
| **Package Postinstall** | npm scripts see secrets | No access | Install package with postinstall script |
| **Process Scanning** | Can find secret processes | Processes hidden | Scan for processes with 'aws' or 'secret' |

#### 4. Performance Criteria ✅

| Metric | Acceptable Range | How to Measure |
|--------|-----------------|----------------|
| **Namespace Creation** | < 10ms overhead | Time `execWithSecrets()` vs `exec()` |
| **Memory Per Namespace** | < 2MB additional | Monitor RSS before/after |
| **Concurrent Namespaces** | Support 10+ simultaneous | Stress test with parallel operations |
| **File I/O Performance** | No degradation | Benchmark file operations |

### Local Development Success Metrics

In local development (without CAP_SYS_ADMIN):

| Test | Expected Behavior | Success Criteria |
|------|------------------|------------------|
| **Fallback Works** | Commands still execute | No errors, just warnings |
| **Clear Warnings** | User informed of degraded security | Console shows security warning |
| **Functionality Intact** | All operations complete | Same results as production (minus isolation) |

### User Experience Success Criteria

| Aspect | Success Criteria |
|--------|------------------|
| **Migration Effort** | < 1 hour for typical project |
| **API Clarity** | Developers understand `execWithSecrets()` vs `exec()` immediately |
| **Error Messages** | Clear, actionable error messages |
| **Documentation** | Migration guide covers 90%+ of use cases |

## Security Considerations

### What We Protect Against
- ✅ Environment variable leakage
- ✅ Process snooping via /proc
- ✅ Memory reading attacks
- ✅ Credential persistence

### What We Don't Protect Against
- ❌ Kernel vulnerabilities (namespace escape)
- ❌ Side-channel attacks (timing, cache)
- ❌ Network-based exfiltration (needs additional controls)
- ❌ Disk-based persistence (needs encryption)

### Defense in Depth
Even with namespace isolation, we should:
1. Rotate credentials frequently
2. Use minimal permission scopes
3. Monitor for suspicious patterns
4. Implement rate limiting
5. Add network egress controls

## Next Steps

### Immediate (Week 1)
- [ ] Implement core namespace manager
- [ ] Add secure execution routes
- [ ] Update SDK with new methods
- [ ] Create basic integration tests

### Short Term (Week 2)
- [ ] Handle file system sharing
- [ ] Implement process visibility controls
- [ ] Add comprehensive error handling
- [ ] Create migration documentation

### Medium Term (Week 3-4)
- [ ] Performance optimizations
- [ ] Namespace pooling
- [ ] Monitoring integration
- [ ] Production deployment

### Long Term (Month 2+)
- [ ] Advanced isolation features
- [ ] Network namespace support
- [ ] Resource limits via cgroups
- [ ] Security audit and penetration testing

---

*This implementation plan is a living document and will be updated as we discover new requirements or challenges during development.*