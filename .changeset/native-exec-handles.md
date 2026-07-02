---
'@cloudflare/sandbox': minor
---

Align command execution with Cloudflare Containers native exec. Top-level `exec()` now returns a process handle and is sessionless by default, while persistent shell state remains available through explicit sessions.
