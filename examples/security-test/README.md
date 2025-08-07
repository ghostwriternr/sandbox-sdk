# Security Test Worker

This worker tests the security capabilities and limitations of Cloudflare Containers.

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

## What We're Looking For

### Critical Capabilities for Security

1. **CAP_SYS_ADMIN**: Can we create namespaces for isolation?
2. **Seccomp Filters**: Are dangerous syscalls blocked?
3. **Cgroup Delegation**: Can we create isolated process groups?
4. **Process Isolation**: Can processes read each other's environment?

### Expected Results

#### Current (Likely) State
- ❌ No CAP_SYS_ADMIN (cannot create namespaces)
- ❌ Can read /proc/*/environ (credential theft possible)
- ❌ All processes visible to each other
- ❌ Secrets exposed to all code

#### Desired State (With Platform Support)
- ✅ CAP_SYS_ADMIN enabled (namespace isolation)
- ✅ Custom seccomp filters (block cross-process reads)
- ✅ Cgroup v2 with delegation (process group isolation)
- ✅ Complete credential isolation

## Deployment Notes

When you deploy this, you'll see output like:

```json
[
  {
    "test": "CAP_SYS_ADMIN (PID namespace)",
    "result": "❌ NOT AVAILABLE: unshare: unshare failed: Operation not permitted"
  },
  {
    "test": "Read /proc/1/environ",
    "result": "⚠️ CAN READ (security risk!)"
  }
]
```

Share these results to understand what security features are available!