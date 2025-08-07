# Secure Platform Operations API Design V2

## The Problem We're Solving

Platform developers need to deploy AI-generated code to AWS, but:
1. AWS CLI must run INSIDE the container (where files are)
2. AWS CLI needs real credentials (can't be modified)
3. User/AI code also runs in the container
4. We can't let user/AI code access AWS credentials

## The AWS Deployment Example

Let's use this concrete scenario throughout:

```typescript
// User prompt: "Create and deploy a Lambda function that processes images"
// AI generates Lambda code, packages it, and needs to deploy to AWS
```

## Solution Patterns

### Pattern 1: Worker Orchestration (Secure, Limited)

**How it works**: Keep secrets in Worker, pull files out for operations

```typescript
// Worker code
export default {
  async fetch(request: Request, env: Env) {
    const sandbox = getSandbox(env.Sandbox, "user-123");
    
    // Step 1: AI generates Lambda code in container
    await sandbox.writeFile('/app/handler.js', aiGeneratedLambdaCode);
    
    // Step 2: Package in container (no secrets needed)
    await sandbox.exec('zip function.zip handler.js node_modules/**');
    
    // Step 3: Pull package to Worker
    const zipFile = await sandbox.readFile('/app/function.zip');
    
    // Step 4: Deploy from Worker using AWS SDK (has secrets)
    const lambda = new AWS.Lambda({
      accessKeyId: env.AWS_ACCESS_KEY,
      secretAccessKey: env.AWS_SECRET
    });
    
    await lambda.updateFunctionCode({
      FunctionName: 'user-function',
      ZipFile: zipFile.content
    }).promise();
  }
}
```

**Pros:**
- Completely secure - secrets never in container
- Works today with current SDK

**Cons:**
- Can't use AWS CLI
- Limited to operations that have SDK equivalents
- Can't do complex AWS CLI operations (like SSM sessions)

### Pattern 2: Temporary Credentials (Risky, Functional)

**How it works**: Create short-lived credentials for specific operations

```typescript
// Worker code
export default {
  async fetch(request: Request, env: Env) {
    const sandbox = getSandbox(env.Sandbox, "user-123");
    
    // Create very limited, short-lived credentials
    const sts = new AWS.STS({
      accessKeyId: env.AWS_ACCESS_KEY,
      secretAccessKey: env.AWS_SECRET
    });
    
    const tempCreds = await sts.assumeRole({
      RoleArn: 'arn:aws:iam::123456:role/lambda-deploy-only',
      RoleSessionName: `deploy-${Date.now()}`,
      DurationSeconds: 300, // 5 minutes
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: ['lambda:UpdateFunctionCode'],
          Resource: 'arn:aws:lambda:us-east-1:123456:function:user-*'
        }]
      })
    }).promise();
    
    // Inject temporary credentials (RISKY - exposed to user code!)
    await sandbox.setEnvVars({
      AWS_ACCESS_KEY_ID: tempCreds.Credentials.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: tempCreds.Credentials.SecretAccessKey,
      AWS_SESSION_TOKEN: tempCreds.Credentials.SessionToken
    });
    
    // Now AWS CLI works
    await sandbox.exec('aws lambda update-function-code --function-name user-func --zip-file fileb://function.zip');
    
    // Problem: Credentials remain exposed for 5 minutes!
  }
}
```

**Pros:**
- AWS CLI works normally
- Can do any AWS operation

**Cons:**
- Credentials exposed to user code (even if temporary)
- Risk window of 5 minutes
- User code could exfiltrate credentials

### Pattern 3: Platform-Controlled Execution (Proposed)

**How it works**: Use our control of the bun server to create isolated execution

```typescript
// New SDK API (what we could build)
interface SecureSandbox extends Sandbox {
  // Register credentials with the container's control plane
  async registerPlatformCredentials(creds: Record<string, string>): Promise<void>;
  
  // Execute with just-in-time credential injection
  async execSecure(command: string, options: {
    credentials: string[], // Which credentials to inject
    timeout: number,       // Max execution time
    isolated: boolean      // Run in isolated context
  }): Promise<ExecResult>;
}

// Worker code using new API
export default {
  async fetch(request: Request, env: Env) {
    const sandbox = getSecureSandbox(env.Sandbox, "user-123");
    
    // Register credentials with container control plane (never in env!)
    await sandbox.registerPlatformCredentials({
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY,
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET
    });
    
    // AI generates and packages Lambda
    await sandbox.writeFile('/app/handler.js', aiGeneratedCode);
    await sandbox.exec('zip function.zip handler.js');
    
    // Deploy using AWS CLI with isolated credentials
    await sandbox.execSecure(
      'aws lambda update-function-code --function-name user-func --zip-file fileb://function.zip',
      {
        credentials: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
        timeout: 30000,
        isolated: true // User code can't see this process
      }
    );
    
    // Credentials were only available during that specific command!
  }
}
```

**Implementation in our bun server:**

```typescript
// container_src/handlers/secure-exec.ts
export async function handleSecureExec(req: Request) {
  const { command, credentials, timeout, isolated } = await req.json();
  
  // Get credentials from secure storage (not process.env)
  const creds = getSecureCredentials(credentials);
  
  if (isolated) {
    // Create isolated process that user code can't inspect
    const proc = spawn(command, {
      env: { ...cleanEnv, ...creds },
      detached: true,  // Run in separate process group
      stdio: 'pipe'    // Don't inherit stdio
    });
    
    // Prevent user code from accessing this process
    hideProcessFromUserCode(proc.pid);
    
    // Auto-kill after timeout
    setTimeout(() => proc.kill(), timeout);
    
    return collectOutput(proc);
  } else {
    // Regular execution with temporary credentials
    return execWithTempEnv(command, creds, timeout);
  }
}
```

**Pros:**
- Credentials never in global environment
- Very short exposure window
- Can hide processes from user code
- Works with any CLI tool

**Cons:**
- Requires SDK changes
- Still some risk if not properly isolated

## Comparison for AWS Deployment Scenario

| Approach | Can Deploy Lambda? | Can Use AWS CLI? | Security Risk | Available Today? |
|----------|-------------------|------------------|---------------|------------------|
| Worker Orchestration | ✅ (via SDK) | ❌ | None | ✅ |
| Temporary Credentials | ✅ | ✅ | High (5 min exposure) | ✅ |
| Platform-Controlled | ✅ | ✅ | Low (millisecond exposure) | ❌ (needs implementation) |

## Recommended Approach Today

### For Maximum Security (Limited Functionality)
```typescript
class AWSDeployer {
  async deployLambda(sandbox: Sandbox, env: Env) {
    // Package in container
    await sandbox.exec('zip function.zip handler.js');
    
    // Pull to Worker
    const zip = await sandbox.readFile('/app/function.zip');
    
    // Deploy from Worker
    const lambda = new AWS.Lambda({
      accessKeyId: env.AWS_ACCESS_KEY,
      secretAccessKey: env.AWS_SECRET
    });
    
    await lambda.updateFunctionCode({
      FunctionName: 'my-function',
      ZipFile: zip.content
    }).promise();
  }
}
```

### For Full Functionality (Accept Risk)
```typescript
class AWSDeployer {
  async deployWithCLI(sandbox: Sandbox, env: Env) {
    // Create minimal temporary credentials
    const tempCreds = await this.getMinimalTempCredentials({
      duration: 300,
      permissions: ['lambda:UpdateFunctionCode'],
      resources: ['arn:aws:lambda:*:*:function:my-function']
    });
    
    // Wrapper script to minimize exposure
    await sandbox.writeFile('/tmp/deploy.sh', `
      #!/bin/bash
      set -e
      aws lambda update-function-code "$@"
      # Clear credentials immediately after
      unset AWS_ACCESS_KEY_ID
      unset AWS_SECRET_ACCESS_KEY
      exit $?
    `);
    
    // Inject credentials (risky!)
    await sandbox.setEnvVars(tempCreds);
    
    // Run quickly
    await sandbox.exec('bash /tmp/deploy.sh --function-name my-function --zip-file fileb://function.zip');
    
    // Note: Credentials still in env for container lifetime
  }
}
```

## What We Can Build (Leveraging Container Control)

Since we control the bun server, we can implement:

### 1. Credential Vault in Container
```typescript
// New endpoint in container_src/index.ts
case "/api/vault/store":
  // Store credentials in memory, never in env
  credentialVault.store(await req.json());
  break;

case "/api/vault/exec":
  // Execute with vaulted credentials
  const { command, credKeys } = await req.json();
  const creds = credentialVault.get(credKeys);
  return execWithCreds(command, creds);
```

### 2. Process Isolation
```typescript
// Hide platform processes from user code
case "/api/platform/exec":
  const proc = spawn(command, {
    env: platformEnv,
    detached: true
  });
  
  // Don't add to process list visible to user
  platformProcesses.set(proc.pid, proc);
  
  return collectOutput(proc);
```

### 3. Just-In-Time Credentials
```typescript
// Inject credentials only for specific command
case "/api/jit/exec":
  const { command, duration } = await req.json();
  
  // Get credentials from DO
  const creds = await requestCredentialsFromDO();
  
  // Run with timeout
  const result = await Promise.race([
    execWithEnv(command, creds),
    sleep(duration).then(() => {
      throw new Error('Command timeout');
    })
  ]);
  
  // Credentials gone after command completes
  return result;
```

## Next Steps for Implementation

1. **Immediate (What developers can do today)**:
   - Use Worker orchestration for operations with SDK support
   - Use temporary credentials when CLI is absolutely necessary
   - Document security trade-offs clearly

2. **Short-term (What we can build in SDK)**:
   - Credential vault in container control plane
   - Secure exec endpoint with JIT credentials
   - Process isolation for platform operations

3. **Long-term (What we need from Cloudflare platform)**:
   - Linux namespace isolation per process
   - Capability-based security model
   - Kernel-level credential isolation

## The Bottom Line

**Is this solvable?** Yes, partially:
- **Today**: Worker orchestration (secure but limited) OR temporary credentials (risky but functional)
- **With SDK changes**: We can build secure execution using our container control
- **With platform changes**: Full isolation becomes possible

**Recommended approach**: Start with Worker orchestration, use temporary credentials only when absolutely necessary, and work towards implementing secure execution in the SDK.