---
'@cloudflare/sandbox': minor
---

Top-level execution is now stateless by default. `exec()`, file, watch, git, and backup calls no longer reuse a hidden default session; create an explicit session via `sandbox.createSession()` and use `session.exec()` when commands need to share shell state.

Command execution has been redesigned to use native container capabilities, returning a process handle supporting `.output()` and streaming output via `.stdout`/`.stderr` readable streams. Legacy streaming execution APIs such as `execStream()` and `exec({ stream, onOutput, onComplete, onError, signal })` are removed. Interactive terminals are now explicit resources: use `sandbox.terminal({ id, cwd, shell }).connect(request, { cols, rows })` instead of the removed `ExecutionSession.terminal()`.
