# Security Test Worker

This worker tests the security capabilities and limitations of Cloudflare Containers, and validates our simplified security approach.

## Our Simplified Approach

We're leveraging existing isolation (Firecracker VM + Docker container) and adding minimal control plane protection:
1. **Hide control plane** - Simple `unshare --pid` to hide Bun/Jupyter
2. **Context-based credentials** - Separate contexts for platform vs user
3. **Universal routing** - LD_PRELOAD to route ALL AI children to user context

## Setup

```bash
# Install dependencies
npm install

# Deploy to Cloudflare
npm run deploy
```

## Test Endpoints

### 1. Test Container Capabilities
```bash
curl https://your-worker.workers.dev/test-capabilities
```

This tests:
- Linux capabilities (CAP_SYS_ADMIN, CAP_SYS_PTRACE, etc.)
- Namespace creation abilities (PID, Mount, Network, User)
- Cgroups version and delegation
- Seccomp filter status
- Process isolation features

### 2. Test Credential Isolation
```bash
curl https://your-worker.workers.dev/test-isolation
```

This tests:
- Environment variable exposure
- Cross-process environment reading
- Python subprocess access to secrets
- Node.js subprocess access to secrets
- /proc filesystem access

### 3. Test Process Visibility
```bash
curl https://your-worker.workers.dev/test-processes
```

This tests:
- Process listing and visibility
- /proc filesystem enumeration
- Cross-process environment reading

### 4. 🆕 Simplified Security Test
```bash
curl https://your-worker.workers.dev/test-simplified
```

This tests our simplified approach:
- Control plane hiding (Bun/Jupyter invisible to user code)
- Context-based credential separation
- LD_PRELOAD universal routing concept
- Port protection (pre-binding)
- Provides clear VULNERABLE/SECURE status

## Success Criteria

### Using `/test-simplified` for Validation

The test will show different results based on implementation status:

#### Before Implementation (Current State)
```json
{
  "summary": {
    "status": "VULNERABLE",
    "message": "🚨 Current implementation exposes secrets to all code",
    "implementation": "v1.x (vulnerable)",
    "approach": "Leveraging existing Firecracker+Docker, minimal additional isolation"
  }
}
```

#### After Implementation (Target State)
```json
{
  "summary": {
    "status": "SECURE",
    "message": "🎉 Context-based isolation working!",
    "implementation": "Simplified (contexts + hiding + routing)",
    "approach": "Leveraging existing Firecracker+Docker, minimal additional isolation",
    "passed": 6,
    "failed": 0
  }
}
```

### What Each Test Validates

| Test | Current | Target (Simplified) |
|------|---------|--------------------|
| Control Plane | ❌ Visible (can pkill) | ✅ Hidden via unshare |
| Credentials | ❌ Exposed to all code | ✅ Context-based isolation |
| AI Children | ❌ Inherit platform creds | ✅ Route to user context |
| Port Protection | ⚠️ Can be hijacked | ✅ Pre-bound by control plane |
| Complexity | N/A | ✅ Minimal (leverage existing) |

## Production vs Local Development

### Production Environment
- ✅ Has CAP_SYS_ADMIN (discovered through testing!)
- ✅ Can use `unshare --pid` to hide control plane
- ✅ Already inside Firecracker VM + Docker container
- ✅ Minimal additional isolation needed

### Local Development
- ❌ No CAP_SYS_ADMIN (safety restriction)
- ⚠️ Control plane remains visible
- ⚠️ Falls back to context-based isolation only
- ℹ️ Still inside Docker container isolation

## How to Use for Implementation Validation

1. **Before starting implementation:**
   ```bash
   curl http://localhost:8787/test-simplified | jq .summary
   # Should show "status": "VULNERABLE"
   ```

2. **After implementing simplified approach:**
   ```bash
   curl http://localhost:8787/test-simplified | jq .summary
   # Should show "status": "SECURE"
   ```

3. **Check specific test results:**
   ```bash
   curl http://localhost:8787/test-simplified | jq .tests
   # Review each test for pass/fail status
   ```

## Key Insight

We discovered we're already inside strong isolation (Firecracker+Docker). We don't need complex sandboxing - just:
1. Hide control plane from user code
2. Separate credentials via contexts
3. Route AI agent children appropriately

This is much simpler than building a full sandbox inside a sandbox!