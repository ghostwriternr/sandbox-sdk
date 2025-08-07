# Security Test Worker

This worker tests the security capabilities and limitations of Cloudflare Containers, and validates namespace isolation implementation.

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

### 4. 🆕 Comprehensive Security Validation
```bash
curl https://your-worker.workers.dev/test-comprehensive
```

This is the main validation endpoint that:
- Detects SDK version (v1.x vulnerable vs v2.0 with isolation)
- Tests current vulnerabilities if no isolation is implemented
- Validates namespace isolation if new methods are available
- Provides clear VULNERABLE/SECURE status

## Success Criteria

### Using `/test-comprehensive` for Validation

The comprehensive test will show different results based on implementation status:

#### Before Implementation (Current State - v1.x)
```json
{
  "summary": {
    "status": "VULNERABLE",
    "message": "🚨 Current implementation exposes secrets to all code",
    "implementation": "v1.x (without isolation)",
    "vulnerabilities": 1
  }
}
```

#### After Implementation (Target State - v2.0)
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

### What Each Test Validates

| Test | Current (v1.x) | Target (v2.0) |
|------|----------------|---------------|
| Environment Variables | ❌ Exposed to all code | ✅ Isolated in namespace |
| Process Visibility | ❌ All processes visible | ✅ Isolated processes hidden |
| /proc Access | ❌ Can read any process | ✅ Cross-namespace blocked |
| File Sharing | ✅ Works | ✅ Still works |
| Performance | N/A | ✅ < 10ms overhead |

## Production vs Local Development

### Production Environment
- ✅ Has CAP_SYS_ADMIN (discovered through testing!)
- ✅ Can create namespaces
- ✅ Full isolation possible

### Local Development
- ❌ No CAP_SYS_ADMIN (safety restriction)
- ⚠️ Falls back to process isolation
- ⚠️ Shows warning about degraded security

## How to Use for Implementation Validation

1. **Before starting implementation:**
   ```bash
   curl http://localhost:8787/test-comprehensive | jq .summary
   # Should show "status": "VULNERABLE"
   ```

2. **After implementing namespace isolation:**
   ```bash
   curl http://localhost:8787/test-comprehensive | jq .summary
   # Should show "status": "SECURE"
   ```

3. **Check specific test results:**
   ```bash
   curl http://localhost:8787/test-comprehensive | jq .tests
   # Review each test for pass/fail status
   ```