---
'@cloudflare/sandbox': patch
---

Retry transient WebSocket upgrade failures from the sandbox control plane. Upgrade responses with temporary 5xx statuses now use the existing retry budget, and failed container-side upgrades return a retryable 503 response.
