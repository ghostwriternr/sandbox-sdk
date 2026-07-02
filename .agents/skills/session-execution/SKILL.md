---
name: session-execution
description: Use when working on or reviewing session execution, command handling, shell state, or stdout/stderr separation. Relevant for session-manager.ts, @repo/sandbox-execution, exec. (project)
---

# Session Execution

The SDK supports two execution pathways:

1. Native top-level stateless execution via `sandbox.exec()`, which uses the native `ctx.container.exec()` capability to run commands.
2. Stateful execution via `session.exec()`, which uses the explicit session runtime (`@repo/sandbox-execution`) to preserve shell state across executions.

Both pathways return a `SandboxProcess` handle supporting `.output()` and wait/signal capabilities.

## Key Concepts

**Execution surfaces:**

- `sandbox.exec()` is stateless. It runs natively using the environment runtime's `ctx.container.exec()`.
- `session.exec()` is stateful and runs in the persistent command session. It preserves shell state (such as `cd`, `export`, and shell functions) across calls within the same session.

**No process streaming/registry APIs:**

- There are no `startProcess`, `execStream`, generic process registry/log APIs, `ProcessService`, `ProcessManager`, `StatelessCommandRunner`, or `StatelessProcessRunner` components in the current architecture. All execution flows through the final native or session exec handle APIs.
