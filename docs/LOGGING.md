# Logging Architecture & Implementation Plan

> **Status**: Phase 2 Complete ✅ | Phase 3 Ready 🎯
> **Last Updated**: 2025-10-17
> **Owner**: Engineering Team
>
> **Progress**: 2 of 6 phases complete (33%)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current State Analysis](#current-state-analysis)
3. [Problems Identified](#problems-identified)
4. [Proposed Architecture](#proposed-architecture)
5. [Implementation Plan](#implementation-plan)
6. [Expected Impact](#expected-impact)
7. [Design Decisions](#design-decisions) ✅ ALL RESOLVED
8. [References](#references)

---

## Executive Summary

This document outlines a comprehensive plan to overhaul the logging infrastructure in the Sandbox SDK. The SDK currently has fragmented, overly verbose logging with no request tracing capability. This makes debugging distributed flows (Worker → Durable Object → Container) extremely difficult.

**Goals:**
- Implement structured, trace-aware logging across all packages
- Reduce log volume by 70-80% while improving signal-to-noise ratio
- Enable end-to-end request tracing across Worker/DO/Container boundaries
- Follow Cloudflare logging best practices
- Provide consistent logging API across all packages

**Key Changes:**
- Create shared logging infrastructure in `@packages/shared`
- Replace 138 `console.log` statements with structured logger
- Implement trace ID propagation via `X-Trace-Id` header
- Reduce logging verbosity while improving observability

---

## Current State Analysis

### Architecture Flow

```
User Worker → Sandbox DO → Container (Bun server) → Back
     ↓           ↓              ↓
  (Worker)   (Durable     (Separate container,
             Object)       separate logs in dashboard)
```

### Logging Statistics

- **Total console.log statements**: 138 across 21 files
- **Most verbose file**: `packages/sandbox-container/src/session.ts` (29 console statements)
- **Logging approaches**:
  - `packages/sandbox`: Raw `console.log` with `[Sandbox]`, `[Container]` prefixes
  - `packages/sandbox-container`: Has `ConsoleLogger` class but **barely used**
  - `packages/shared`: No logging infrastructure

### File Breakdown

| Package | File | Console Statements |
|---------|------|-------------------|
| sandbox-container | session.ts | 29 |
| sandbox | sandbox.ts | 15 |
| sandbox-container | runtime/process-pool.ts | 17 |
| sandbox-container | core/logger.ts | 5 |
| sandbox-container | interpreter-service.ts | 5 |
| sandbox-container | services/session-manager.ts | 10 |
| sandbox-container | core/container.ts | 2 |
| sandbox | sse-parser.ts | 3 |
| sandbox | file-stream.ts | 5 |
| sandbox | security.ts | 3 |
| Others | Various | 44 |

---

## Problems Identified

### 1. No Tracing/Correlation

**Problem**: Zero trace IDs or correlation mechanisms exist.

**Impact**:
- Impossible to follow a single request from worker → DO → container → back
- Durable Object logs and container logs appear on **separate pages** in Cloudflare dashboard
- No way to connect related log entries across the distributed system

**Example**: When debugging "why did this command fail?", you have to:
1. Search DO logs for the sandbox ID
2. Separately search container logs for the session ID
3. Manually correlate timestamps
4. Hope you find related entries

### 2. Mixed Logging Approaches

**Problem**: Three different logging patterns coexist:

```typescript
// Pattern 1: Raw console.log (most common)
console.log(`[Sandbox] Stored sandbox name: ${name}`);

// Pattern 2: Console with structured attempt
console.log('[Session', this.id, '] exec() START:', commandId);

// Pattern 3: Actual logger (barely used)
this.logger.info('Request started', { requestId, method });
```

**Impact**:
- No consistent format
- Can't reliably parse or filter logs
- Existing `ConsoleLogger` class is unused in most of the codebase

### 3. Overly Verbose

**Problem**: Logging at every tiny step, especially in hot paths.

**Examples from session.ts**:
```typescript
console.log(`[Session ${this.id}] exec() START: ${commandId}...`);           // Line 194
console.log(`[Session ${this.id}] exec() writing script to shell stdin`);    // Line 204
console.log(`[Session ${this.id}] exec() waiting for exit code file...`);    // Line 213
console.log(`[Session ${this.id}] exec() got exit code: ${exitCode}...`);    // Line 224
console.log(`[Session ${this.id}] exec() COMPLETE: ${commandId}...`);        // Line 237
```

**Impact**:
- Log volume is excessive
- Important errors get buried in noise
- Performance overhead in hot paths
- Expensive for Cloudflare Workers Logs (pricing per log)

### 4. Unstructured Logs

**Problem**: Most logs are plain strings with interpolated values.

```typescript
// Current (unstructured)
console.log(`[Session ${id}] exec() COMPLETE: ${commandId} | Exit code: ${exitCode} | Duration: ${duration}ms`);

// Can't easily filter by:
// - sessionId
// - commandId
// - exitCode
// - duration range
```

**Impact**:
- Can't filter logs by specific fields
- Can't aggregate metrics (e.g., "average command duration")
- Manual parsing required for analysis

### 5. No Log Level Strategy

**Problem**: Everything logged at the same level (mostly `console.log`).

**Impact**:
- Can't distinguish between errors, warnings, info, and debug
- No way to reduce verbosity in production
- Errors sometimes logged with `console.log` instead of `console.error`

---

## Proposed Architecture

### Design Principles

Based on Cloudflare's logging best practices:

1. **Use Standard Console API**: `console.log`, `console.error`, `console.warn`, `console.info` (Workers-compatible)
2. **Structured Logging**: All logs include JSON metadata
3. **Trace Propagation**: TraceId flows through entire request lifecycle
4. **Context-Aware**: Include sandboxId, sessionId, processId, component
5. **Performance-Conscious**: Minimal overhead, lazy evaluation
6. **Shared Infrastructure**: Logger in `@packages/shared`, used everywhere

### High-Level Architecture

```
@packages/shared/
├── logger/
│   ├── types.ts              # Logger interface, LogContext type
│   ├── logger.ts             # CloudflareLogger implementation
│   ├── trace-context.ts      # TraceContext management
│   └── index.ts              # Public API

Request Flow with Tracing:
┌─────────────────────────────────────────────────────────────────┐
│ User Worker (fetch handler)                                     │
│ - Generates traceId OR extracts from header                     │
│ - Creates logger with { component: 'worker', traceId }          │
│ - Passes traceId via X-Trace-Id header                          │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ Sandbox Durable Object                                          │
│ - Extracts traceId from request headers                         │
│ - Creates logger with { component: 'durable-object',            │
│                         sandboxId, traceId }                    │
│ - Forwards traceId to container via X-Trace-Id header           │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ Container (Bun server)                                          │
│ - Extracts traceId from request headers                         │
│ - Creates logger with { component: 'container',                 │
│                         sessionId, traceId }                    │
│ - All operations logged with same traceId                       │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
                  Response returns
                  (same traceId throughout)
```

### Core Components

#### 1. Logger Interface

```typescript
// @packages/shared/src/logger/types.ts

interface Logger {
  // Core logging methods
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: Error, context?: LogContext): void;

  // Context management
  child(context: Partial<LogContext>): Logger;
}

interface LogContext {
  // Trace information
  traceId: string;              // Unique per request (e.g., "tr_abc123...")

  // Component context
  component: 'worker' | 'durable-object' | 'container';

  // Entity context
  sandboxId?: string;           // Which sandbox
  sessionId?: string;           // Which session
  processId?: string;           // Which process
  commandId?: string;           // Which command

  // Operation context
  operation?: string;           // 'exec' | 'startProcess' | 'writeFile' | etc.

  // Performance metrics
  duration?: number;            // Milliseconds

  // Extensible for additional metadata
  [key: string]: unknown;
}
```

#### 2. CloudflareLogger Implementation

```typescript
// @packages/shared/src/logger/logger.ts

class CloudflareLogger implements Logger {
  constructor(
    private baseContext: LogContext,
    private minLevel: LogLevel = LogLevel.INFO,
    private pretty: boolean = false  // Pretty print for local development
  ) {}

  info(message: string, context?: LogContext): void {
    if (this.shouldLog(LogLevel.INFO)) {
      const logData = {
        level: 'info',
        msg: message,
        ...this.baseContext,
        ...context,
        timestamp: new Date().toISOString()
      };
      this.output(console.log, logData);
    }
  }

  error(message: string, error?: Error, context?: LogContext): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      const logData = {
        level: 'error',
        msg: message,
        ...this.baseContext,
        ...context,
        error: error ? {
          message: error.message,
          stack: error.stack
        } : undefined,
        timestamp: new Date().toISOString()
      };
      this.output(console.error, logData);
    }
  }

  // Similar implementations for warn(), debug()

  child(context: Partial<LogContext>): Logger {
    return new CloudflareLogger(
      { ...this.baseContext, ...context },
      this.minLevel,
      this.pretty
    );
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.minLevel;
  }

  private output(consoleFn: typeof console.log, data: any): void {
    if (this.pretty) {
      // Pretty print for local development
      const { level, msg, timestamp, traceId, component, ...rest } = data;
      const levelColor = this.getLevelColor(level);
      const componentBadge = component ? `[${component}]` : '';
      const traceIdShort = traceId ? traceId.substring(0, 12) : '';

      consoleFn(
        `${levelColor}${level.toUpperCase()}${this.colors.reset} ${componentBadge} ${msg}`,
        traceIdShort ? `(trace: ${traceIdShort})` : '',
        Object.keys(rest).length > 0 ? rest : ''
      );
    } else {
      // JSON for production (Cloudflare Workers Logs)
      consoleFn(JSON.stringify(data));
    }
  }

  private getLevelColor(level: string): string {
    // ANSI color codes for terminal output
    const colors = {
      debug: '\x1b[36m',  // Cyan
      info: '\x1b[32m',   // Green
      warn: '\x1b[33m',   // Yellow
      error: '\x1b[31m',  // Red
    };
    return colors[level as keyof typeof colors] || '';
  }

  private colors = {
    reset: '\x1b[0m',
  };
}
```

**Features**:
- **JSON output for production** (Cloudflare Workers Logs)
- **Pretty printing for local development** (human-readable)
- Automatic timestamp injection
- Context inheritance via `.child()`
- Log level filtering (configurable via MIN_LOG_LEVEL)
- Cloudflare Workers compatible (uses console.* methods)
- Performance: lazy serialization, minimal overhead

**Output Examples**:

Production (JSON):
```json
{"level":"info","msg":"Command execution started","component":"durable-object","traceId":"tr_7f3a9b2c","timestamp":"2025-10-17T10:30:00.123Z"}
```

Local Development (Pretty):
```
INFO [durable-object] Command execution started (trace: tr_7f3a9b2c)
```

#### 3. TraceContext Utility

```typescript
// @packages/shared/src/logger/trace-context.ts

class TraceContext {
  private static readonly TRACE_HEADER = 'X-Trace-Id';

  /**
   * Generate a new trace ID
   * Format: "tr_" + 16 random hex chars (e.g., "tr_7f3a9b2c4e5d6f1a")
   */
  static generate(): string {
    const randomHex = crypto.randomUUID().replace(/-/g, '').substring(0, 16);
    return `tr_${randomHex}`;
  }

  /**
   * Extract trace ID from request headers
   * Returns null if not present
   */
  static fromHeaders(headers: Headers): string | null {
    return headers.get(this.TRACE_HEADER);
  }

  /**
   * Create headers object with trace ID
   */
  static toHeaders(traceId: string): Record<string, string> {
    return { [this.TRACE_HEADER]: traceId };
  }
}
```

#### 4. Factory Function

```typescript
// @packages/shared/src/logger/index.ts

export function createLogger(context: Partial<LogContext> & { component: string }): Logger {
  const minLevel = getLogLevelFromEnv();
  const pretty = isPrettyPrintEnabled();

  const baseContext: LogContext = {
    traceId: context.traceId || TraceContext.generate(),
    component: context.component as any,
    ...context
  };

  return new CloudflareLogger(baseContext, minLevel, pretty);
}

function getLogLevelFromEnv(): LogLevel {
  const envLevel = getEnvVar('LOG_LEVEL') || getDefaultLogLevel();

  switch (envLevel.toLowerCase()) {
    case 'debug': return LogLevel.DEBUG;
    case 'info': return LogLevel.INFO;
    case 'warn': return LogLevel.WARN;
    case 'error': return LogLevel.ERROR;
    default: return LogLevel.INFO;
  }
}

function getDefaultLogLevel(): string {
  // Default: info for production, debug for development
  return isProduction() ? 'info' : 'debug';
}

function isPrettyPrintEnabled(): boolean {
  // Check explicit LOG_FORMAT env var
  const format = getEnvVar('LOG_FORMAT');
  if (format) {
    return format.toLowerCase() === 'pretty';
  }

  // Auto-detect: pretty in local development, JSON in production
  return !isProduction();
}

function isProduction(): boolean {
  // Detect Cloudflare Workers environment
  // In Workers, globalThis has specific Cloudflare APIs
  const hasCloudflareAPIs =
    typeof globalThis.caches !== 'undefined' &&
    typeof globalThis.Response !== 'undefined' &&
    typeof globalThis.Request !== 'undefined';

  // Check NODE_ENV if available (container/local)
  const nodeEnv = getEnvVar('NODE_ENV');
  if (nodeEnv) {
    return nodeEnv === 'production';
  }

  // Default: assume production if Cloudflare APIs detected
  return hasCloudflareAPIs;
}

function getEnvVar(name: string): string | undefined {
  // Try process.env first (Node.js / Bun)
  if (typeof process !== 'undefined' && process.env) {
    return process.env[name];
  }

  // Try Bun.env (Bun runtime)
  if (typeof Bun !== 'undefined' && (Bun as any).env) {
    return (Bun as any).env[name];
  }

  return undefined;
}
```

**Environment Detection**:
- **Local Development** (`wrangler dev` or `npm run dev`):
  - `LOG_LEVEL`: `debug` (default)
  - `LOG_FORMAT`: `pretty` (auto-detected)
  - Result: Colored, human-readable logs

- **Production** (deployed to Cloudflare):
  - `LOG_LEVEL`: `info` (default)
  - `LOG_FORMAT`: `json` (auto-detected)
  - Result: Structured JSON logs

**Override Options**:
```bash
# Force JSON in local development
LOG_FORMAT=json npm run dev

# Force pretty in production (not recommended)
LOG_FORMAT=pretty wrangler deploy

# Set log level explicitly
LOG_LEVEL=error npm run dev
```

### Usage Patterns

#### In Sandbox Durable Object

```typescript
export class Sandbox<Env = unknown> extends Container<Env> implements ISandbox {
  private logger: Logger;

  constructor(ctx: DurableObject['ctx'], env: Env) {
    super(ctx, env);

    this.logger = createLogger({
      component: 'durable-object',
      sandboxId: this.id
    });
  }

  override async fetch(request: Request): Promise<Response> {
    // Extract or generate trace ID
    const traceId = TraceContext.fromHeaders(request.headers) || TraceContext.generate();
    const logger = this.logger.child({ traceId, operation: 'fetch' });

    logger.info('Request received', {
      method: request.method,
      path: new URL(request.url).pathname
    });

    try {
      const response = await this.handleRequest(request, traceId);
      logger.info('Request completed', { status: response.status });
      return response;
    } catch (error) {
      logger.error('Request failed', error as Error);
      throw error;
    }
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const logger = this.logger.child({ operation: 'exec' });
    const startTime = Date.now();

    logger.info('Command execution started', { command });

    try {
      const result = await this.executeCommand(command, options);
      logger.info('Command execution completed', {
        command,
        exitCode: result.exitCode,
        duration: Date.now() - startTime
      });
      return result;
    } catch (error) {
      logger.error('Command execution failed', error as Error, { command });
      throw error;
    }
  }
}
```

#### In Container Session

```typescript
export class Session {
  private logger: Logger;

  constructor(options: SessionOptions, parentLogger: Logger) {
    this.id = options.id;

    // Create child logger with session context
    this.logger = parentLogger.child({
      sessionId: this.id
    });
  }

  async exec(command: string, options?: ExecOptions): Promise<RawExecResult> {
    const commandId = randomUUID();
    const logger = this.logger.child({ operation: 'exec', commandId });
    const startTime = Date.now();

    logger.info('Command execution started', { command: command.substring(0, 50) });

    try {
      // ... execution logic ...

      logger.info('Command execution completed', {
        exitCode,
        duration: Date.now() - startTime
      });

      return result;
    } catch (error) {
      logger.error('Command execution failed', error as Error);
      throw error;
    }
  }
}
```

### Log Output Examples

#### Before (Current)

```
[Sandbox] Stored sandbox name: my-sandbox
[Session abc123] exec() START: cmd-456 | Command: echo hello...
[Session abc123] exec() writing script to shell stdin
[Session abc123] exec() waiting for exit code file: /tmp/abc/exit
[Session abc123] exec() got exit code: 0, parsing log file
[Session abc123] exec() COMPLETE: cmd-456 | Exit code: 0 | Duration: 45ms
```

**Problems**:
- Unstructured (can't filter by sessionId, commandId)
- Too verbose (6 logs for one operation)
- No trace ID (can't connect to DO logs)

#### After (Proposed)

```json
{"level":"info","msg":"Command execution started","component":"durable-object","sandboxId":"my-sandbox","operation":"exec","command":"echo hello","traceId":"tr_7f3a9b2c4e5d6f1a","timestamp":"2025-10-17T10:30:00.123Z"}
{"level":"info","msg":"Command execution started","component":"container","sessionId":"abc123","commandId":"cmd-456","operation":"exec","command":"echo hello","traceId":"tr_7f3a9b2c4e5d6f1a","timestamp":"2025-10-17T10:30:00.125Z"}
{"level":"info","msg":"Command execution completed","component":"container","sessionId":"abc123","commandId":"cmd-456","operation":"exec","exitCode":0,"duration":43,"traceId":"tr_7f3a9b2c4e5d6f1a","timestamp":"2025-10-17T10:30:00.168Z"}
{"level":"info","msg":"Command execution completed","component":"durable-object","sandboxId":"my-sandbox","operation":"exec","exitCode":0,"duration":45,"traceId":"tr_7f3a9b2c4e5d6f1a","timestamp":"2025-10-17T10:30:00.170Z"}
```

**Benefits**:
- Structured (can filter by any field)
- Concise (4 logs instead of 6)
- **Same traceId** across DO and container
- Can filter all logs: `traceId:"tr_7f3a9b2c4e5d6f1a"`

---

## Implementation Plan

### Phase 1: Core Infrastructure ✅ COMPLETE

**Status**: ✅ Complete
**Actual effort**: ~4 hours
**Completed**: 2025-10-17

#### Tasks

**1.1 Create Shared Logger Infrastructure** ✅

- [x] Create `@packages/shared/src/logger/` directory
- [x] Create `types.ts`:
  - Define `Logger` interface
  - Define `LogContext` interface
  - Define `LogLevel` enum
- [x] Create `logger.ts`:
  - Implement `CloudflareLogger` class
  - Implement all logging methods (debug, info, warn, error)
  - Implement context inheritance via `.child()`
  - Implement log level filtering
  - **Implement pretty printing** for local development (colored, human-readable)
  - **Implement JSON output** for production (Cloudflare Workers Logs)
- [x] Create `trace-context.ts`:
  - Implement `TraceContext.generate()`
  - Implement `TraceContext.fromHeaders()`
  - Implement `TraceContext.toHeaders()`
- [x] Create `index.ts`:
  - Export all public APIs
  - Export `createLogger()` factory function
  - Export `TraceContext` utility
  - Implement environment detection (production vs development)
  - Implement log level configuration from env vars
  - Implement format detection (JSON vs pretty)
  - **Implement AsyncLocalStorage context management**:
    - `loggerStorage` AsyncLocalStorage instance
    - `getLogger()` function to retrieve logger from context
    - `runWithLogger()` function to run code with logger context
- [x] Update `@packages/shared/src/index.ts`: Add logger exports
- [x] Update `@packages/shared/package.json`: Ensure exports configured

**1.2 Update Package Dependencies** ✅

- [x] Verify `@packages/sandbox/package.json` has `@repo/shared` dependency
- [x] Verify `@packages/sandbox-container/package.json` has `@repo/shared` dependency
- [x] Dependencies already present, no npm install needed

**1.3 Enable AsyncLocalStorage Support** ✅

- [x] Verified `wrangler.jsonc` files have `nodejs_compat` flag enabled
- [x] Verified compatibility date is 2024-09-23 or later (all configs use 2025-05-06)

**1.4 Testing** ✅

- [x] Create comprehensive unit tests (`packages/shared/tests/logger.test.ts`)
- [x] Create vitest configuration (`packages/shared/vitest.config.ts`)
- [x] All 34 tests passing
- [x] TypeScript builds successfully
- [x] Biome checks pass (no warnings)

**Files created:**
- ✅ `packages/shared/src/logger/types.ts`
- ✅ `packages/shared/src/logger/logger.ts`
- ✅ `packages/shared/src/logger/trace-context.ts`
- ✅ `packages/shared/src/logger/index.ts`
- ✅ `packages/shared/tests/logger.test.ts`
- ✅ `packages/shared/vitest.config.ts`

**Files modified:**
- ✅ `packages/shared/src/index.ts` (added logger exports)
- ✅ `packages/shared/package.json` (added test script)

**Verification:**
- ✅ `npm run build` - builds successfully
- ✅ `npm test` - 34/34 tests passing
- ✅ `npm run check` - all checks pass
- ✅ Consistent with turbo.json and repo structure

**Key Deliverables:**
- Complete logger infrastructure in `@repo/shared`
- AsyncLocalStorage support for implicit context propagation
- Pretty printing (local dev) + JSON output (production)
- Comprehensive test coverage
- Ready for integration in sandbox packages

---

### Phase 2: Integrate Logging in @packages/sandbox ✅ COMPLETE

**Status**: ✅ Complete
**Actual effort**: ~5 hours
**Completed**: 2025-10-17

#### Tasks

**2.1 Update Sandbox DO Class** ✅

File: `packages/sandbox/src/sandbox.ts`

- [x] Import `createLogger`, `TraceContext`, `runWithLogger`, `getLogger` from `@repo/shared`
- [x] Add `private logger: Logger` property
- [x] Initialize logger in constructor with component='durable-object' and sandboxId
- [x] Update `fetch()` method:
  - Extract traceId: `TraceContext.fromHeaders()` or `TraceContext.generate()`
  - Create child logger with traceId and operation='fetch'
  - Use `runWithLogger()` to store logger in AsyncLocalStorage
  - Replace console.log → logger.info
- [x] Update all public methods:
  - Use instance logger for synchronous contexts
  - Replace all console.log → logger.info/debug
  - Add structured context
- [x] Update error handling: console.error → logger.error
- [x] Update lifecycle methods (onStart, onStop, onError, destroy)
- [x] Update helper methods (ensureDefaultSession, isPortExposed, validatePortToken)
- [x] Update session wrapper methods (setEnvVars in getSessionWrapper)

**Console statements replaced**: 15 → 0 (all replaced with structured logging)

**2.2 Update SandboxClient and Related Clients** ✅

Files:
- `packages/sandbox/src/clients/base-client.ts` ✅
- `packages/sandbox/src/clients/interpreter-client.ts` ✅

- [x] `base-client.ts`:
  - Added `safeLog()` helper method with console fallback
  - Replaced all console.log → safeLog('debug'/info'/warn'/error')
  - Updated doFetch() method (9 console statements)
  - Updated executeFetch() method (3 console statements)
  - Updated isContainerProvisioningError() method (3 console statements)
  - Updated logSuccess() and logError() utility methods
- [x] `interpreter-client.ts`:
  - Replaced console.error → this.logError() (inherited from BaseHttpClient)

**Console statements replaced**: 19 → 0 (all replaced, with fallbacks in safeLog)

**2.3 Update Security Module** ✅

File: `packages/sandbox/src/security.ts`

- [x] Import `getLogger` from `@repo/shared`
- [x] Update `logSecurityEvent()` function:
  - Use `getLogger()` to retrieve logger from AsyncLocalStorage
  - Map severity to log levels:
    - `critical`/`high` → `logger.error()`
    - `medium` → `logger.warn()`
    - `low` → `logger.info()`
  - Include structured metadata (securityEvent, severity, ...details)
  - Added try-catch with console fallback

**Console statements replaced**: 3 → 1 (fallback only)

**2.4 Update Supporting Files** ✅

- [x] `file-stream.ts`: Replaced console.error → getLogger().error with fallback (1 statement)
- [x] `sse-parser.ts`: Replaced console.error/log → getLogger().error/debug with fallbacks (3 statements)
- [x] `request-handler.ts`: Replaced console.error → getLogger().error with fallback (1 statement)
- [x] `interpreter.ts`: No console statements found ✅

**Total console statements replaced**: 5 → 3 (fallbacks only)

**Files modified:**
- ✅ `packages/sandbox/src/sandbox.ts`
- ✅ `packages/sandbox/src/clients/base-client.ts`
- ✅ `packages/sandbox/src/clients/interpreter-client.ts`
- ✅ `packages/sandbox/src/security.ts`
- ✅ `packages/sandbox/src/file-stream.ts`
- ✅ `packages/sandbox/src/sse-parser.ts`
- ✅ `packages/sandbox/src/request-handler.ts`

**Verification:**
- ✅ `npm run build --workspace=@cloudflare/sandbox` - builds successfully
- ✅ `npm run check --workspace=@cloudflare/sandbox` - all checks pass (TypeScript + Biome)
- ✅ `npm run build --workspace=@repo/shared` - builds successfully
- ✅ `npm run test --workspace=@repo/shared` - 34/34 tests passing

**Key Deliverables:**
- Complete structured logging integration in Durable Object layer
- All console.log statements replaced in sandbox package
- Safe logging with fallbacks in client utilities
- Trace ID propagation via runWithLogger() in fetch handler
- AsyncLocalStorage for implicit logger propagation
- Security events now use structured logger
- Ready for Phase 3 (Container integration)

---

### Phase 2.5: Lessons Learned & Refactoring Insights

**Status**: Documented lessons from Phase 2 implementation
**Date**: 2025-10-17

During Phase 2 implementation, we encountered several important issues that led to significant refactoring beyond the original plan. These lessons are documented here to inform future phases and similar projects.

#### Lesson 1: Hardcoded Type Constraints Can Block Refactoring

**Problem**: Changed `component` type from `'durable-object'` to `'sandbox-do'` in `LogContext` interface, but TypeScript build failed with:
```
Type '"sandbox-do"' is not assignable to type '"worker" | "durable-object" | "container"'
```

**Root Cause**: The `createLogger()` function had a **hardcoded union type** in its signature that didn't match the updated interface:
```typescript
// packages/shared/src/logger/index.ts (line 141)
export function createLogger(
  context: Partial<LogContext> & { component: 'worker' | 'durable-object' | 'container' }  // ❌ Hardcoded!
): Logger
```

**Impact**: Spent 2+ hours debugging, thinking it was a caching/module resolution issue, when the actual problem was a simple hardcoded type constraint.

**Solution**: Always reference the source interface type instead of duplicating:
```typescript
// BEFORE (BAD):
context: Partial<LogContext> & { component: 'worker' | 'durable-object' | 'container' }

// AFTER (GOOD):
context: Partial<LogContext> & { component: LogContext['component'] }
```

**Key Takeaway**: When changing a type definition, search for ALL occurrences including:
1. The type definition itself
2. Function parameter constraints (often missed!)
3. Type assertions and annotations
4. Documentation/comments

---

#### Lesson 2: Logging Verbosity Review Is Essential

**Problem**: Initial Phase 2 implementation simply replaced `console.log` with `logger.info` without reviewing **which logs were actually useful**.

**Examples of Unnecessary Logs** (from sandbox.ts):
```typescript
// Internal bookkeeping - not useful for debugging
logger.info('Stored sandbox name via RPC', { name });
logger.debug('Set environment variable', { key });

// Success messages that add no value
logger.info('Environment variables set successfully');

// Lifecycle events that could be DEBUG level
logger.info('Sandbox started');
logger.info('Sandbox stopped');
```

**Refactoring Insights**:
1. **Remove internal bookkeeping logs** - Users don't care that we stored a value in storage
2. **Remove successful operation logs** - Logging success adds noise (errors are what matter)
3. **Downgrade lifecycle to DEBUG** - Lifecycle events are useful for debugging but not production
4. **Keep only operation boundaries** - Log when operations start/complete with relevant context

**Result**: Reduced logs from ~40 to ~15 in sandbox package (62% reduction) while improving signal-to-noise ratio.

**Key Takeaway**: Structured logging ≠ just replacing console.log. Review each log's value first.

---

#### Lesson 3: Utilities Should Not Log

**Problem**: Utility functions like `sse-parser.ts` and `file-stream.ts` had logging for error cases:
```typescript
// sse-parser.ts
try {
  const event = JSON.parse(data);
  yield event;
} catch (error) {
  logger.error('Failed to parse SSE event', error); // ❌ Utility logging error
  continue;
}
```

**Refactoring Decision**: Utilities should **not log** - they should:
1. Skip invalid data silently (for parsers)
2. Throw errors for exceptional cases (let callers decide how to handle)
3. Let callers add logging context if needed

**Solution**:
```typescript
// AFTER: Just skip invalid JSON, don't log
try {
  const event = JSON.parse(data);
  yield event;
} catch {
  continue; // Skip invalid events silently
}
```

**Key Takeaway**: Utilities should be pure, side-effect-free. Logging is a side effect. Let callers control logging.

---

#### Lesson 4: Defensive Logging Patterns Can Be Eliminated

**Problem**: The `safeLog()` pattern in BaseHttpClient attempted to be defensive:
```typescript
protected safeLog(level: 'debug' | 'info' | 'warn' | 'error', message: string, context?: any): void {
  try {
    const logger = getLogger();
    logger[level](message, context);
  } catch (error) {
    // Fallback to console if logger not available
    console[level === 'error' ? 'error' : 'log'](message, context);
  }
}
```

**Refactoring Decision**: Instead of defensive logging, **pass logger explicitly**:
```typescript
// HttpClientOptions now requires logger
export interface HttpClientOptions {
  logger: Logger;  // Required in production, optional for tests
  baseUrl?: string;
  // ...
}
```

**Benefits**:
1. Explicit dependency - constructor requires logger
2. No try-catch overhead
3. Clearer code - no hidden fallback logic
4. Production code always has proper logging

**For Tests**: Provide a no-op logger:
```typescript
const createNoOpLogger = (): Logger => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => createNoOpLogger()
});
```

**Key Takeaway**: Explicit dependencies > defensive programming. Make logger required in production code, optional for tests.

---

#### Lesson 5: Security Logging Should Be Simple

**Problem**: Created an over-engineered `logSecurityEvent()` function with severity levels and special handling.

**Reality Check**: We only had ~3 security log call sites, all in port exposure / URL construction.

**Refactoring Decision**: Remove `logSecurityEvent()` entirely:
- Just throw `SecurityError` for invalid inputs (e.g., invalid ports, malformed sandbox IDs)
- Use regular `logger.warn()` for suspicious activity (e.g., invalid token attempts)
- No need for special security logging infrastructure

**Key Takeaway**: Don't build infrastructure for 3 use cases. YAGNI (You Aren't Gonna Need It).

---

#### Lesson 6: Component Naming Should Match User Mental Model

**Problem**: Used generic name `'durable-object'` for component identifier.

**Better Approach**: Use specific name `'sandbox-do'` that matches the actual class name and makes logs more searchable.

**Benefits**:
1. Logs are more specific: "sandbox-do" vs generic "durable-object"
2. Easier to filter: Can distinguish if we ever add more Durable Objects
3. Matches code structure: Sandbox class → 'sandbox-do'

**Key Takeaway**: Component names should be specific and match the actual architecture, not generic categories.

---

#### Lesson 7: Test Mocks Shouldn't Require Full Production Setup

**Problem**: Made `logger` required in `HttpClientOptions`, which broke 123 tests that used minimal test mocks.

**Solution**: Make logger optional with no-op fallback:
```typescript
constructor(options: HttpClientOptions = {}) {
  this.logger = options.logger ?? createNoOpLogger();
  // ...
}
```

**Benefits**:
1. Production code explicitly passes loggers
2. Tests work without setup (no-op logger)
3. Tests can enable logging when debugging test failures
4. Zero test maintenance overhead

**Key Takeaway**: Production code should be explicit (pass logger), but tests should have sensible defaults.

---

### Summary: Phase 2 Key Insights

1. **Search ALL type occurrences** - Don't forget function parameter constraints
2. **Review log value first** - Don't blindly replace console.log
3. **Utilities don't log** - Keep utilities pure, let callers log
4. **Explicit > Defensive** - Pass logger explicitly, don't try-catch everywhere
5. **YAGNI for infrastructure** - 3 use cases don't justify special infrastructure
6. **Specific > Generic** - Component names should match actual architecture
7. **Tests need defaults** - No-op logger for tests, explicit logger for production

**These lessons significantly improved the implementation and should guide Phase 3 (Container integration).**

---

### Phase 3: Integrate Logging in @packages/sandbox-container (Priority: HIGH)

**Estimated effort**: 8-10 hours

#### Tasks

**3.1 Replace ConsoleLogger**

- [ ] Remove old logger: `packages/sandbox-container/src/core/logger.ts`
- [ ] Update `core/types.ts`: Remove old Logger interface (use shared one)
- [ ] Update `core/container.ts`:
  - Import `createLogger` from `@repo/shared`
  - Replace `ConsoleLogger` with `createLogger({ component: 'container' })`
  - Pass logger to all services/handlers

**3.2 Update Session Class** (MOST VERBOSE FILE)

File: `packages/sandbox-container/src/session.ts`

This is the highest priority file - it has 29 console.log statements!

- [ ] Accept logger parameter in constructor
- [ ] Create child logger: `this.logger = logger.child({ sessionId: this.id })`
- [ ] **DRASTICALLY reduce logging**:
  - **Remove** debug logs (lines 194, 204, 213, 224, 237, 248, 274, 285, 292, 300, 392, 415, 417, 448-450, 454, 458, 464, 467, 469, 473, 478, 481, 484, 492, 899, 908)
  - **Keep only**:
    - Session lifecycle: initialize(), destroy()
    - Command start/complete: exec(), execStream()
    - Errors
  - Move removed logs to `logger.debug()` (can be enabled for debugging)
- [ ] Update remaining logs:
  - Add operation context: `.child({operation: 'exec', commandId})`
  - Include structured metadata (command, exitCode, duration)
  - Use appropriate log levels (info for events, error for failures)

**Current**: 29 console statements
**Target**: ~6-8 (lifecycle + operation boundaries only)

Example transformation:
```typescript
// BEFORE (5 logs for one operation)
console.log(`[Session ${this.id}] exec() START: ${commandId}...`);
console.log(`[Session ${this.id}] exec() writing script to shell stdin`);
console.log(`[Session ${this.id}] exec() waiting for exit code file...`);
console.log(`[Session ${this.id}] exec() got exit code: ${exitCode}...`);
console.log(`[Session ${this.id}] exec() COMPLETE: ${commandId}...`);

// AFTER (2 logs)
const logger = this.logger.child({ operation: 'exec', commandId });
logger.info('Command execution started', { command: command.substring(0, 50) });
// ... execution logic ...
logger.info('Command execution completed', { exitCode, duration });
```

**3.3 Update Services**

- [ ] `services/process-service.ts`:
  - Use logger instead of console.log
  - Create child logger: `.child({processId})` for process-specific logs
  - Reduce verbosity: log start/complete/error only
  - Move detail logs to debug level
- [ ] `services/file-service.ts`: Replace console.log → logger
- [ ] `services/git-service.ts`: Replace console.log → logger
- [ ] `services/port-service.ts`: Replace console.log → logger
- [ ] `services/session-manager.ts`: Replace console.log → logger
- [ ] `services/interpreter-service.ts`: Replace console.log → logger

**3.4 Update Handlers**

All handlers in `packages/sandbox-container/src/handlers/`:

- [ ] `base-handler.ts`: Accept logger in constructor
- [ ] `execute-handler.ts`: Use logger, extract traceId from request
- [ ] `file-handler.ts`: Use logger, extract traceId
- [ ] `process-handler.ts`: Use logger, extract traceId
- [ ] `port-handler.ts`: Use logger, extract traceId
- [ ] `git-handler.ts`: Use logger, extract traceId
- [ ] `interpreter-handler.ts`: Use logger, extract traceId
- [ ] `session-handler.ts`: Use logger, extract traceId
- [ ] `misc-handler.ts`: Use logger, extract traceId

**Pattern for all handlers**:
```typescript
async handle(request: Request, context: RequestContext): Promise<Response> {
  const traceId = TraceContext.fromHeaders(request.headers);
  const logger = this.logger.child({
    traceId,
    requestId: context.requestId,
    operation: 'handleExecute'
  });

  logger.info('Request handling started');
  // ... handle request ...
  logger.info('Request handling completed');
}
```

**3.5 Update Middleware**

File: `packages/sandbox-container/src/middleware/logging.ts`

- [ ] Extract traceId from request headers
- [ ] Add traceId to log context
- [ ] Simplify format: use structured logging
- [ ] Use logger.child() for request-scoped logging

**3.6 Update Entry Point**

File: `packages/sandbox-container/src/index.ts`

- [ ] Import `createLogger`
- [ ] Create module-level logger
- [ ] Replace console.log → logger.info (server startup)
- [ ] Replace console.error → logger.error (shutdown errors)

**Files to modify:**
- `packages/sandbox-container/src/session.ts` (~29 statements → ~6-8)
- `packages/sandbox-container/src/core/container.ts`
- `packages/sandbox-container/src/core/types.ts`
- `packages/sandbox-container/src/services/*.ts` (6 files)
- `packages/sandbox-container/src/handlers/*.ts` (9 files)
- `packages/sandbox-container/src/middleware/logging.ts`
- `packages/sandbox-container/src/index.ts`

**Files to remove:**
- `packages/sandbox-container/src/core/logger.ts` (old implementation)

---

### Phase 4: Update Test Worker (Priority: MEDIUM)

**Estimated effort**: 1-2 hours

#### Tasks

File: `tests/e2e/test-worker/index.ts`

- [ ] Import `createLogger`, `TraceContext` from `@repo/shared`
- [ ] Create logger at module level
- [ ] In fetch handler:
  - Generate traceId: `const traceId = TraceContext.generate()`
  - Create request-scoped logger: `logger.child({ traceId })`
  - Pass traceId in all sandbox requests via `X-Trace-Id` header
- [ ] Replace console.log (line 74) → logger.debug (keep minimal)
- [ ] Add traceId to all getSandbox/fetch calls

**Files to modify:**
- `tests/e2e/test-worker/index.ts`

---

### Phase 5: Documentation & Configuration (Priority: MEDIUM)

**Estimated effort**: 2-3 hours

#### Tasks

**5.1 Add Log Level Configuration**

- [ ] Document `LOG_LEVEL` environment variable (debug|info|warn|error)
- [ ] Update `wrangler.jsonc` examples
- [ ] Add default log level: `info` (production), `debug` (development)
- [ ] Document how to override per-environment

**5.2 Update This Document (LOGGING.md)**

- [ ] Add "How to Use" section
- [ ] Add "Viewing Logs in Cloudflare Dashboard" section
- [ ] Add "Filtering by Trace ID" section
- [ ] Add "Troubleshooting" section
- [ ] Add "Best Practices" section

**5.3 Update README**

- [ ] Add "Observability & Logging" section
- [ ] Link to LOGGING.md
- [ ] Mention trace IDs for debugging
- [ ] Explain how to enable debug logging

**Files to create/modify:**
- `docs/LOGGING.md` (this file - expand after implementation)
- `README.md` (add observability section)
- Wrangler config examples

---

### Phase 6: Testing & Validation (Priority: HIGH)

**Estimated effort**: 4-5 hours

#### Tasks

**6.1 Manual Testing**

- [ ] Run e2e tests: `npm run test:e2e`
- [ ] Verify logs appear in console (local)
- [ ] Verify structured JSON format
- [ ] Check log volume reduction (should see ~70% fewer logs)
- [ ] Verify all logs include traceId

**6.2 Cloudflare Dashboard Testing**

- [ ] Deploy to Cloudflare
- [ ] Enable Workers Logs (if not enabled)
- [ ] Make test requests
- [ ] Verify trace IDs visible in dashboard
- [ ] Test filtering by traceId
- [ ] Verify DO logs and container logs both include same traceId
- [ ] Verify logs from both DO and container can be correlated

**6.3 Trace Propagation Validation**

- [ ] Make a request, capture traceId from response or logs
- [ ] Search logs for that traceId in Cloudflare dashboard
- [ ] Verify logs appear from all components:
  - Worker (test-worker)
  - Durable Object (Sandbox)
  - Container (Session)
- [ ] Verify chronological order makes sense

**6.4 Performance Testing**

- [ ] Run performance benchmarks (if exist)
- [ ] Verify no performance regression
- [ ] Check logger overhead: should be < 1% CPU
- [ ] Verify JSON serialization doesn't impact hot paths
- [ ] Profile command execution: ensure logging doesn't add > 5ms

**6.5 Edge Cases**

- [ ] Test without traceId header (logger should auto-generate)
- [ ] Test with very long context (verify no truncation issues)
- [ ] Test error logging with stack traces
- [ ] Test with all log levels (debug, info, warn, error)
- [ ] Test log level filtering (set LOG_LEVEL=error, verify only errors show)

---

## Expected Impact

### Quantitative Improvements

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Console statements | 138 | ~40-50 | 70% reduction |
| Logs per request | ~20-30 | ~6-10 | 70% reduction |
| Correlation ability | 0% | 100% | Full tracing |
| Structured logs | ~5% | 100% | Full coverage |
| Log levels used | 1 (console.log) | 4 (debug/info/warn/error) | 4x granularity |

### Qualitative Improvements

**Before**:
- No tracing → Impossible to follow request flow
- Mixed approaches → ConsoleLogger exists but barely used
- Verbose → Logs at every tiny step
- Unstructured → Plain string logs
- Separate streams → DO and container logs disconnected

**After**:
- Full tracing → Every request has traceId from entry to exit
- Consistent → Single logger implementation everywhere
- Focused → Log important events (start/complete/error)
- Structured → JSON metadata for all logs
- Connected → Same traceId in DO logs and container logs

### Developer Experience

**Debugging a Failed Command (Before)**:
1. Check DO logs for sandbox ID
2. Manually search container logs
3. Try to correlate via timestamps
4. Guess which logs are related
5. Still unclear what happened

**Debugging a Failed Command (After)**:
1. Get traceId from error response or any log
2. Filter all logs by traceId
3. See complete request flow:
   - Worker received request (traceId: tr_abc123)
   - DO started command execution (traceId: tr_abc123)
   - Container received command (traceId: tr_abc123)
   - Container command failed (traceId: tr_abc123, exitCode: 1, stderr: "...")
   - DO returned error (traceId: tr_abc123)
4. Root cause identified in < 30 seconds

---

## Design Decisions

> **Status**: Approved
> **Date**: 2025-10-17

### 1. Log Level Configuration ✅ RESOLVED

**Decision**: `info` for production, `debug` for development

**Implementation**:
- Default log level: `info` (production)
- Development mode: `debug` (more verbose for debugging)
- Configurable via `LOG_LEVEL` environment variable
- **Pretty printing**: Human-readable format in local development, JSON in production

**Rationale**:
- Production: Only essential events (keeps costs low, good signal-to-noise)
- Development: Detailed logging for debugging without cluttering production
- Pretty printing improves local development experience

---

### 2. Trace ID Generation ✅ RESOLVED

**Decision**: Auto-generate trace IDs always; internal use only

**Implementation**:
- SDK auto-generates trace ID at the entry point (Sandbox DO `fetch()` method)
- Trace ID propagates through entire request lifecycle via `X-Trace-Id` header
- Trace IDs are included in all log entries for correlation
- **Not exposed to users** - purely internal for log correlation

**Code Example**:
```typescript
// In Sandbox DO fetch()
const traceId = TraceContext.fromHeaders(request.headers) || TraceContext.generate();
const logger = this.logger.child({ traceId });

// Trace ID automatically included in all subsequent logs
logger.info('Request received'); // Includes traceId in log output
```

**Rationale**:
- Simplicity: No API surface for users to learn
- Automatic: Works without any user configuration
- Effective: Solves the correlation problem (DO logs ↔ Container logs)
- Following Sentry's pattern: They never expose trace IDs to users either

**Note**: Users interact with our SDK via RPC methods (`getSandbox()`, `sandbox.exec()`), not HTTP requests, so there's no natural place to expose trace IDs anyway.

---

### 3. Performance & Cost Optimization ✅ RESOLVED

**Decision**: Treat entire application as performance-critical; be extremely judicious with logs

**Key Considerations**:
1. **Performance**: Logging overhead in hot paths (command execution, file operations)
2. **Cost**: Cloudflare charges for observability - users bear this cost
3. **Signal-to-Noise**: Too many logs make debugging harder, not easier

**Implementation Guidelines**:
- **Use `debug` level** for verbose/detailed logs (disabled in production)
- **Use `info` level** for operation boundaries only (start/complete)
- **Use `warn` level** for recoverable issues
- **Use `error` level** for failures
- **Avoid logging in loops** or high-frequency operations
- **Truncate large payloads** (e.g., command output, file contents)

**Target Metrics**:
- 70-80% reduction in log volume (138 → 40-50 statements)
- 70% reduction in logs per request (~20-30 → ~6-10 logs)
- < 1% CPU overhead from logging
- < 5ms added latency per request

---

### 4. Cloudflare Workers Logs Setup ✅ RESOLVED

**Decision**: Include setup instructions in documentation

**Setup** (from Cloudflare docs):
```jsonc
// wrangler.jsonc
{
  "observability": {
    "enabled": true,
    "head_sampling_rate": 0.01  // 1% sampling (optional)
  }
}
```

**Documentation Tasks**:
- [ ] Add Workers Logs setup section
- [ ] Link to Cloudflare docs
- [ ] Explain sampling rates
- [ ] Show how to view logs in dashboard
- [ ] Show how to filter by trace ID

---

### 5. Migration Strategy ✅ RESOLVED

**Decision**: Clean break - replace all console.log immediately

**Rationale**:
- Cleaner codebase
- Easier to review changes (all in one PR)
- No confusion about which logging approach to use
- Faster completion

**Rollout**:
- Single feature branch: `feat/structured-logging-with-tracing`
- All changes in one PR (easier to review holistically)
- Deploy to staging first, validate, then production

---

### 6. Testing Strategy ✅ RESOLVED

**Decision**: Unit tests for logger module only; no tests for log output

**What to Test**:
- ✅ Logger methods work correctly (debug, info, warn, error)
- ✅ Context inheritance via `.child()`
- ✅ Log level filtering (debug/info/warn/error levels)
- ✅ Trace ID generation and extraction from headers
- ✅ **Pretty printing vs JSON formatting** (environment detection)
- ✅ **Color codes in pretty mode** (ANSI colors applied correctly)
- ✅ Environment detection (production vs development)
- ✅ Edge cases (null context, undefined errors, empty metadata, etc.)

**What NOT to Test**:
- ❌ Exact log output format (implementation detail, will change)
- ❌ Whether specific operations log (brittle, not valuable)
- ❌ Log content validation (too fragile)

**Implementation**:
- Mock console.* methods
- Verify correct console method called (log vs error vs warn)
- Verify log data structure (has expected fields)
- Keep tests simple and maintainable

---

### 7. AsyncLocalStorage for Context Propagation ✅ RESOLVED

**Decision**: Use AsyncLocalStorage to eliminate explicit logger passing

**Implementation**:
- Store logger in AsyncLocalStorage at request entry points
- Use `.child()` to add operation-specific context
- Update AsyncLocalStorage with child logger for nested operations
- Helper functions automatically retrieve logger from context

**How It Works Together**:

AsyncLocalStorage eliminates **passing** the logger, but we still use `.child()` to **create** context-specific loggers.

```typescript
// In @packages/shared/src/logger/index.ts
import { AsyncLocalStorage } from 'node:async_hooks';

const loggerStorage = new AsyncLocalStorage<Logger>();

export function getLogger(): Logger {
  const logger = loggerStorage.getStore();
  if (!logger) {
    throw new Error('Logger not initialized in async context');
  }
  return logger;
}

export function runWithLogger<T>(logger: Logger, fn: () => T | Promise<T>): T | Promise<T> {
  return loggerStorage.run(logger, fn);
}
```

**Usage in Sandbox DO**:
```typescript
export class Sandbox<Env = unknown> extends Container<Env> implements ISandbox {
  async fetch(request: Request): Promise<Response> {
    const traceId = TraceContext.generate();
    const logger = createLogger({ component: 'durable-object', traceId, sandboxId });

    // Store logger in AsyncLocalStorage for entire request
    return runWithLogger(logger, async () => {
      return await this.handleRequest(request);
    });
  }

  async exec(command: string) {
    // Get logger from context and add operation-specific context
    const logger = getLogger().child({ operation: 'exec', commandId });

    // Update AsyncLocalStorage with child logger
    return runWithLogger(logger, async () => {
      logger.info('Command started');
      await this.helperMethod(); // 🎉 No logger parameter!
      logger.info('Command completed');
    });
  }

  async helperMethod() {
    // 🎉 No logger parameter needed!
    const logger = getLogger(); // Automatically has all context!
    logger.info('Helper called'); // Has traceId, sandboxId, operation, commandId
  }
}
```

**Benefits**:
- 🎉 No logger parameters through deep call stacks
- 🎉 Still use `.child()` to add context at operation boundaries
- 🎉 Helper functions automatically get the right logger with full context
- 🎉 Follows Sentry's proven pattern

**Platform Support**:
- ✅ **Cloudflare Workers**: Supported with `nodejs_compat` flag (compatibility date 2024-09-23+)
- ✅ **Bun (Container)**: Supported (partial implementation, sufficient for our needs)
- ✅ **Durable Objects**: Same as Workers (uses Workers runtime)

**Note**: This is the same pattern Sentry uses for context management. They use AsyncLocalStorage for propagation + Scope for context.

---

### 8. Flush Lock Pattern ✅ RESOLVED

**Decision**: Not needed for our SDK implementation

**Rationale**:

From Cloudflare documentation on Durable Objects:
> "`waitUntil` is not necessary. If a Durable Object is still waiting on any ongoing work or outbound I/O, it will remain active for a period of time."

**Where Flush Lock is Needed**:
- ❌ **Durable Objects**: Not needed - DOs stay alive while I/O is pending
- ❌ **Container**: Not needed - long-lived process
- ✅ **User Workers**: May be needed if users want reliable logging

**Implementation**:
- We will NOT implement flush lock in our SDK
- Our SDK only implements DO and Container layers (both don't need it)
- Users writing their own Workers can implement flush lock themselves if needed

**Documentation for Users**:

We will document that users who want guaranteed log delivery in their Workers should wrap logging operations:

```typescript
// User's worker (outside our SDK)
export default {
  async fetch(request, env, ctx) {
    // Wrap SDK calls to ensure logs flush before Worker terminates
    const promise = (async () => {
      const sandbox = getSandbox(env.Sandbox, 'my-sandbox');
      return await sandbox.exec('echo hello');
    })();

    ctx.waitUntil(promise);
    return await promise;
  }
};
```

**References**:
- [Durable Objects State API - waitUntil](https://developers.cloudflare.com/durable-objects/api/state/#waituntil)
- [Durable Objects Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)

---

### 9. Log Sampling ✅ RESOLVED

**Decision**: No sampling in logger; rely on Cloudflare's platform-level sampling

**Rationale**:
1. **We're already reducing log volume by 70%** (138 → 40 statements)
2. **We have log levels** (debug vs info) which accomplishes similar goals
3. **Cloudflare provides platform-level sampling** via `head_sampling_rate`
4. **Sampling adds complexity** and makes debugging harder
5. **Premature optimization** - we should measure first, then optimize if needed

**Implementation**:
- No sampling logic in CloudflareLogger
- Users configure sampling via `wrangler.jsonc`:

```jsonc
// wrangler.jsonc
{
  "observability": {
    "enabled": true,
    "head_sampling_rate": 0.1  // 10% sampling (user-configurable)
  }
}
```

**Benefits**:
- ✅ Simpler logger implementation
- ✅ Users control sampling at deployment level
- ✅ Same sampling applies to all logs (not just our SDK)
- ✅ Easier to debug (sampling is not hidden in code)

**Cost Control Strategy**:
- Use appropriate log levels (info for production, debug for development)
- Reduce log volume through thoughtful logging (operation boundaries only)
- Let users tune platform sampling based on their budget
- Document best practices for cost-conscious logging

---

### Summary: All Design Decisions Resolved ✅

All major design decisions have been finalized and approved:

| Decision | Status | Summary |
|----------|--------|---------|
| **1. Log Level Configuration** | ✅ RESOLVED | `info` for production, `debug` for development; pretty printing in local, JSON in production |
| **2. Trace ID Generation** | ✅ RESOLVED | Auto-generate always; internal use only; no user exposure |
| **3. Performance & Cost Optimization** | ✅ RESOLVED | Treat entire application as performance-critical; 70-80% log reduction target |
| **4. Workers Logs Setup** | ✅ RESOLVED | Document setup with `observability` config in wrangler.jsonc |
| **5. Migration Strategy** | ✅ RESOLVED | Clean break - replace all console.log immediately |
| **6. Testing Strategy** | ✅ RESOLVED | Unit tests for logger module only; no tests for log output |
| **7. AsyncLocalStorage** | ✅ RESOLVED | Use AsyncLocalStorage + `.child()` for context propagation |
| **8. Flush Lock Pattern** | ✅ RESOLVED | Not needed for SDK (DO + Container); only for user Workers |
| **9. Log Sampling** | ✅ RESOLVED | No sampling in logger; rely on Cloudflare's `head_sampling_rate` |

**Key Takeaways:**
- Simple auto-generated trace IDs (internal only)
- AsyncLocalStorage for elegant context propagation
- No flush lock needed in our SDK implementation
- No sampling logic (rely on Cloudflare platform)
- Clean migration: replace everything at once
- Ready to implement Phase 1!

---

## References

### Cloudflare Documentation

- [Workers Observability - Logs](https://developers.cloudflare.com/workers/observability/logs/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Real-time Logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)
- [Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/)
- [Console API](https://developers.cloudflare.com/workers/runtime-apis/console/)
- [Containers Logging FAQ](https://developers.cloudflare.com/containers/faq/#how-do-container-logs-work)

### Related Blog Posts

- [Durable Objects: Easy, Fast, Correct](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)
- [Billions of Logs: Scaling AI Gateway](https://blog.cloudflare.com/billions-and-billions-of-logs-scaling-ai-gateway-with-the-cloudflare/)

### Internal Documentation

- [Architecture Overview](../README.md)
- [Durable Objects Setup](../packages/sandbox/README.md)
- [Container Runtime](../packages/sandbox-container/README.md)

---

## Appendices

### Appendix A: Log Volume Analysis

Detailed breakdown of console.log statements by file:

| File | Package | Statements | Category |
|------|---------|-----------|----------|
| session.ts | sandbox-container | 29 | Hot path (execution) |
| sandbox.ts | sandbox | 15 | DO lifecycle |
| runtime/process-pool.ts | sandbox-container | 17 | Process management |
| services/session-manager.ts | sandbox-container | 10 | Session management |
| core/logger.ts | sandbox-container | 5 | Logger impl (remove) |
| interpreter-service.ts | sandbox-container | 5 | Code interpreter |
| file-stream.ts | sandbox | 5 | File operations |
| sse-parser.ts | sandbox | 3 | Streaming |
| security.ts | sandbox | 3 | Security events |
| core/container.ts | sandbox-container | 2 | DI container |
| Others | various | 44 | Various |
| **Total** | | **138** | |

### Appendix B: Trace ID Format

**Format**: `tr_` + 16 hexadecimal characters

**Example**: `tr_7f3a9b2c4e5d6f1a`

**Properties**:
- Fixed prefix `tr_` for easy identification
- 16 hex chars = 64 bits of randomness (low collision probability)
- URL-safe (no special characters)
- Human-readable (easier to copy/paste)
- Consistent length (18 chars total)

**Alternative considered**: Full UUID (32 hex chars)
- Rejected: Too long, harder to work with in logs

### Appendix C: Log Retention

Based on Cloudflare Workers Logs limits:

| Plan | Retention | Max Logs/Day |
|------|-----------|--------------|
| Free | 3 days | Not specified |
| Paid | 7 days | 5 billion |

**Recommendation**: Enable Workers Logs on Paid plan for 7-day retention.

---

**Document Version**: 1.0
**Last Updated**: 2025-10-17
**Next Review**: After Phase 1 completion
