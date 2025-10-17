# Learnings from Sentry SDK

## Executive Summary

**Key Takeaways:**

1. **Automatic Trace ID Generation**: Sentry auto-generates trace IDs using UUID4 at scope initialization, with special deterministic generation for workflows that need consistent IDs across steps.

2. **Context via AsyncLocalStorage**: Uses Node's AsyncLocalStorage with `withIsolationScope` and `withScope` wrappers to maintain isolated contexts per request without passing context explicitly.

3. **Flush Lock Pattern**: Critical for Workers - wraps ExecutionContext.waitUntil to track pending operations and ensure all telemetry is sent before the request completes.

4. **Minimal Logging Infrastructure**: Sentry uses a debug logger that's completely stripped in production builds via `DEBUG_BUILD` flag - they don't have a general-purpose logging system.

5. **Sampling at Root Span Creation**: Performance optimization happens via sampling decisions made once at the root span level, with a random value propagated through distributed traces.

## 1. Trace ID & Context Management

### Trace ID Generation

Sentry **automatically generates** trace IDs - users never provide them manually. The generation happens at multiple points:

**Standard Generation (uuid4):**
```typescript
// From: /Users/naresh/github/sentry-javascript/packages/core/src/utils/misc.ts
export function uuid4(crypto = getCrypto()): string {
  let getRandomByte = (): number => Math.random() * 16;
  try {
    if (crypto?.randomUUID) {
      return crypto.randomUUID().replace(/-/g, ''); // 32 hex chars
    }
    if (crypto?.getRandomValues) {
      getRandomByte = () => {
        const typedArray = new Uint8Array(1);
        crypto.getRandomValues(typedArray);
        return typedArray[0]!;
      };
    }
  } catch {
    // fallback to Math.random()
  }
  return (([1e7] as unknown as string) + 1e3 + 4e3 + 8e3 + 1e11).replace(/[018]/g, c =>
    ((c as unknown as number) ^ ((getRandomByte() & 15) >> ((c as unknown as number) / 4))).toString(16),
  );
}

// Used by:
// /Users/naresh/github/sentry-javascript/packages/core/src/utils/propagationContext.ts
export function generateTraceId(): string {
  return uuid4();
}
```

**Deterministic Generation (Workflows):**
```typescript
// From: /Users/naresh/github/sentry-javascript/packages/cloudflare/src/workflows.ts
async function deterministicTraceIdFromInstanceId(instanceId: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(instanceId));
  return (
    Array.from(new Uint8Array(buf))
      .slice(0, 16) // First 16 bytes = 32 hex chars
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

async function propagationContextFromInstanceId(instanceId: string): Promise<PropagationContext> {
  const traceId = UUID_REGEX.test(instanceId)
    ? instanceId.replace(/-/g, '')
    : await deterministicTraceIdFromInstanceId(instanceId);

  // Derive sampleRand from last 4 characters - ensures consistent sampling
  const sampleRand = parseInt(traceId.slice(-4), 16) / 0xffff;

  return { traceId, sampleRand };
}
```

**Why deterministic for workflows?** Workflows cannot store state between steps, so they hash the workflow instance ID to get a consistent trace ID across all steps.

### PropagationContext Structure

```typescript
// From: /Users/naresh/github/sentry-javascript/packages/core/src/scope.ts
export interface PropagationContext {
  traceId: string;              // 32 hex chars (UUID4 without dashes)
  parentSpanId?: string;        // Optional: 16 hex chars
  spanId?: string;              // Optional: current span ID
  sampled?: boolean;            // Sampling decision
  sampleRand: number;           // Random 0-1 for consistent sampling decisions
  dsc?: DynamicSamplingContext; // Dynamic sampling context from baggage
}

// Initialized automatically in Scope constructor:
protected _propagationContext: PropagationContext;

public constructor() {
  // ...
  this._propagationContext = {
    traceId: generateTraceId(),
    sampleRand: Math.random(),
  };
}
```

### Context Passing via AsyncLocalStorage

Sentry does **NOT** pass context explicitly. Instead, they use AsyncLocalStorage to maintain request-scoped context:

```typescript
// From: /Users/naresh/github/sentry-javascript/packages/cloudflare/src/async.ts
export function setAsyncLocalStorageAsyncContextStrategy(): void {
  const asyncStorage = new AsyncLocalStorage<{
    scope: Scope;
    isolationScope: Scope;
  }>();

  function withIsolationScope<T>(callback: (isolationScope: Scope) => T): T {
    const scope = getScopes().scope;
    const isolationScope = getScopes().isolationScope.clone();
    return asyncStorage.run({ scope, isolationScope }, () => {
      return callback(isolationScope);
    });
  }

  setAsyncContextStrategy({
    suppressTracing,
    withScope,
    withSetScope,
    withIsolationScope,
    withSetIsolationScope,
    getCurrentScope: () => getScopes().scope,
    getIsolationScope: () => getScopes().isolationScope,
  });
}
```

**Two types of scopes:**
- **Scope**: Forked per operation (e.g., per span), cloned frequently
- **IsolationScope**: One per request, holds the client and request-level context

### Trace Propagation Across Services

```typescript
// From: /Users/naresh/github/sentry-javascript/packages/cloudflare/src/request.ts
export function wrapRequestHandler(wrapperOptions, handler): Promise<Response> {
  return withIsolationScope(async isolationScope => {
    const { options, request, context } = wrapperOptions;

    // Initialize client for this request
    const client = init({ ...options, ctx: context });
    isolationScope.setClient(client);

    // Continue trace from incoming headers
    return continueTrace(
      {
        sentryTrace: request.headers.get('sentry-trace') || '',
        baggage: request.headers.get('baggage')
      },
      () => {
        return startSpan({ name, attributes }, async span => {
          const res = await handler();
          return res;
        });
      },
    );
  });
}
```

**continueTrace:**
```typescript
// From: /Users/naresh/github/sentry-javascript/packages/core/src/tracing/trace.ts
export const continueTrace = <V>(
  options: { sentryTrace: string; baggage: string },
  callback: () => V,
): V => {
  const { sentryTrace, baggage } = options;
  const client = getClient();
  const incomingDsc = baggageHeaderToDynamicSamplingContext(baggage);

  if (client && !shouldContinueTrace(client, incomingDsc?.org_id)) {
    return startNewTrace(callback); // New trace if different org
  }

  return withScope(scope => {
    const propagationContext = propagationContextFromHeaders(sentryTrace, baggage);
    scope.setPropagationContext(propagationContext); // Set incoming trace context
    return callback();
  });
};
```

## 2. Logger Architecture

**Important Discovery: Sentry doesn't have a traditional logger.**

Sentry uses a minimal debug logger that's **completely stripped in production builds**:

```typescript
// From: /Users/naresh/github/sentry-javascript/packages/core/src/utils/debug-logger.ts
function _maybeLog(level: ConsoleLevel, ...args: Parameters<(typeof console)[typeof level]>): void {
  if (!DEBUG_BUILD) {
    return; // Completely no-op in production
  }

  if (isEnabled()) {
    consoleSandbox(() => {
      GLOBAL_OBJ.console[level](`${PREFIX}[${level}]:`, ...args);
    });
  }
}

export const debug = {
  enable,
  disable,
  isEnabled,
  log,
  warn,
  error,
} satisfies SentryDebugLogger;
```

**Key Points:**
- No structured logging
- No JSON formatting
- Only for development/debugging
- Uses `DEBUG_BUILD` flag to completely eliminate logging code in production
- All logging goes through `consoleSandbox` to avoid instrumenting their own logs

**For actual observability, Sentry relies on:**
1. **Breadcrumbs** - lightweight event trail
2. **Spans** - performance timing
3. **Events** - errors and messages sent to Sentry backend

```typescript
// Example breadcrumb (structured data):
addBreadcrumb({
  category: 'fetch',
  data: {
    method: 'GET',
    url: 'https://api.example.com',
    status_code: 200,
  },
  level: 'info',
  type: 'http',
});
```

## 3. Cloudflare Workers Implementation

### SDK Initialization Pattern

```typescript
// From: /Users/naresh/github/sentry-javascript/packages/cloudflare/src/handler.ts
export function withSentry<Env = unknown>(
  optionsCallback: (env: Env) => CloudflareOptions,
  handler: ExportedHandler<Env>,
): ExportedHandler<Env> {
  setAsyncLocalStorageAsyncContextStrategy();

  // Wrap each handler method (fetch, scheduled, queue, etc.)
  if ('fetch' in handler && typeof handler.fetch === 'function') {
    handler.fetch = new Proxy(handler.fetch, {
      apply(target, thisArg, args: [Request, Env, ExecutionContext]) {
        const [request, env, ctx] = args;
        const context = copyExecutionContext(ctx);
        const options = getFinalOptions(optionsCallback(env), env);

        return wrapRequestHandler({ options, request, context }, () =>
          target.apply(thisArg, args)
        );
      },
    });
  }

  return handler;
}
```

**Key pattern:**
- SDK is initialized **per request**, not globally
- Uses a callback to get options from `env` (environment variables)
- Client is set on the isolation scope for that request

```typescript
// From: /Users/naresh/github/sentry-javascript/packages/cloudflare/src/sdk.ts
export function init(options: CloudflareOptions): CloudflareClient | undefined {
  if (options.defaultIntegrations === undefined) {
    options.defaultIntegrations = getDefaultIntegrations(options);
  }

  const flushLock = options.ctx ? makeFlushLock(options.ctx) : undefined;

  const clientOptions: CloudflareClientOptions = {
    ...options,
    stackParser: stackParserFromStackParserOptions(options.stackParser || defaultStackParser),
    integrations: getIntegrationsToSetup(options),
    transport: options.transport || makeCloudflareTransport,
    flushLock,
  };

  // Setup OpenTelemetry compatibility
  if (!options.skipOpenTelemetrySetup) {
    setupOpenTelemetryTracer();
  }

  return initAndBind(CloudflareClient, clientOptions) as CloudflareClient;
}
```

### Durable Objects Instrumentation

```typescript
// From: /Users/naresh/github/sentry-javascript/packages/cloudflare/src/durableobject.ts
export function instrumentDurableObjectWithSentry<E, T extends DurableObject<E>, C extends new (state: DurableObjectState, env: E) => T>(
  optionsCallback: (env: E) => CloudflareOptions,
  DurableObjectClass: C
): C {
  return new Proxy(DurableObjectClass, {
    construct(target, [ctx, env]) {
      setAsyncLocalStorageAsyncContextStrategy();
      const context = copyExecutionContext(ctx);
      const options = getFinalOptions(optionsCallback(env), env);
      const obj = new target(context, env);

      // Instrument standard methods
      if (obj.fetch) {
        obj.fetch = new Proxy(obj.fetch, {
          apply(target, thisArg, args) {
            return wrapRequestHandler({ options, request: args[0], context }, () =>
              Reflect.apply(target, thisArg, args)
            );
          },
        });
      }

      // Instrument RPC methods on instance
      for (const method of Object.getOwnPropertyNames(obj)) {
        if (/* not standard method */ && typeof value === 'function') {
          obj[method] = wrapMethodWithSentry(
            { options, context, spanName: method, spanOp: 'rpc' },
            value
          );
        }
      }

      // Store context for prototype methods
      Object.defineProperty(obj, '__SENTRY_CONTEXT__', {
        value: context,
        enumerable: false,
        writable: false,
      });

      if (options?.instrumentPrototypeMethods) {
        instrumentPrototype(target, options.instrumentPrototypeMethods);
      }

      return obj;
    },
  });
}
```

**Key Insights:**
1. **Two-level instrumentation**: Instance methods + optional prototype methods
2. **Context stored on instance** via hidden `__SENTRY_CONTEXT__` property
3. **Opt-in prototype instrumentation** (adds overhead, disabled by default)

### ExecutionContext Copying

Critical pattern for Workers:

```typescript
// From: /Users/naresh/github/sentry-javascript/packages/cloudflare/src/utils/copyExecutionContext.ts
export function copyExecutionContext<T extends ContextType>(ctx: T): T {
  if (!ctx) return ctx;

  const overrides: OverridesStore<T> = new Map();
  const descriptors = /* build descriptors for all methods */;

  return Object.create(ctx, descriptors);
}

// Allows overriding waitUntil while maintaining original behavior
function makeOverridableDescriptor(store, ctx, method): PropertyDescriptor {
  return {
    configurable: true,
    enumerable: true,
    set: newValue => {
      if (typeof newValue == 'function') {
        store.set(method, newValue);
      }
    },
    get: () => {
      if (store.has(method)) return store.get(method);
      const methodFunction = Reflect.get(ctx, method);
      return methodFunction.bind(ctx);
    },
  };
}
```

**Why copy?** Allows wrapping `waitUntil` without mutating the original context.

### Environment Detection

```typescript
// From: /Users/naresh/github/sentry-javascript/packages/cloudflare/src/options.ts
export function getFinalOptions(userOptions: CloudflareOptions, env: unknown): CloudflareOptions {
  if (typeof env !== 'object' || env === null) {
    return userOptions;
  }

  const release = 'SENTRY_RELEASE' in env && typeof env.SENTRY_RELEASE === 'string'
    ? env.SENTRY_RELEASE
    : undefined;

  return { release, ...userOptions };
}
```

Simple pattern: Read from environment variables, merge with user options.

## 4. SDK Design Patterns

### Global State vs. Explicit Context

**Sentry uses ZERO explicit context passing.** Everything is implicit via:

1. **AsyncLocalStorage** for request isolation
2. **Scope** for operation-level context
3. **IsolationScope** for request-level context

```typescript
// Users write this:
startSpan({ name: 'database query' }, async (span) => {
  const data = await db.query();
  return data;
});

// SDK automatically:
// 1. Gets current scope from AsyncLocalStorage
// 2. Creates child span from parent on scope
// 3. Sets new span as active on scope
// 4. Restores previous span when done
```

### Configuration Pattern

```typescript
// User provides callback that returns options
export default withSentry(
  (env) => ({
    dsn: env.SENTRY_DSN,
    environment: env.ENVIRONMENT,
    tracesSampleRate: 0.1,
    release: env.SENTRY_RELEASE,
  }),
  {
    fetch: async (request, env, ctx) => {
      // Application code
    }
  }
);
```

**Why callback?**
- Allows reading from `env` which isn't available at module load time
- Gets called per-request with fresh environment

### Span Creation Pattern

```typescript
// From: /Users/naresh/github/sentry-javascript/packages/core/src/tracing/trace.ts
export function startSpan<T>(options: StartSpanOptions, callback: (span: Span) => T): T {
  return withScope(customForkedScope, () => {
    const scope = getCurrentScope();
    const parentSpan = getParentSpan(scope);

    const activeSpan = createChildOrRootSpan({
      parentSpan,
      spanArguments,
      scope,
    });

    _setSpanForScope(scope, activeSpan); // Set as active

    return handleCallbackErrors(
      () => callback(activeSpan),
      () => { /* set error status */ },
      () => { activeSpan.end(); } // Always end span
    );
  });
}
```

**Key patterns:**
1. **Fork scope** for each span (isolation)
2. **Automatic parent detection** from scope
3. **Automatic cleanup** via try/finally
4. **Error handling** built-in

### Async Operations

```typescript
// Sentry handles both sync and async transparently
function wrapMethodWithSentry(options, handler) {
  return new Proxy(handler, {
    apply(target, thisArg, args) {
      return withScope(scope => {
        const result = Reflect.apply(target, thisArg, args);

        if (isThenable(result)) {
          return result.then(
            (res) => {
              waitUntil?.(flush(2000));
              return res;
            },
            (e) => {
              captureException(e);
              waitUntil?.(flush(2000));
              throw e;
            }
          );
        } else {
          waitUntil?.(flush(2000));
          return result;
        }
      });
    },
  });
}
```

## 5. Performance & Cost Optimization

### Sampling Strategy

```typescript
// From: /Users/naresh/github/sentry-javascript/packages/core/src/tracing/sampling.ts
export function sampleSpan(
  options: Pick<CoreOptions, 'tracesSampleRate' | 'tracesSampler'>,
  samplingContext: SamplingContext,
  sampleRand: number, // Random value from PropagationContext
): [sampled: boolean, sampleRate?: number, localSampleRateWasApplied?: boolean] {
  if (!hasSpansEnabled(options)) {
    return [false];
  }

  let sampleRate;
  if (typeof options.tracesSampler === 'function') {
    sampleRate = options.tracesSampler({
      ...samplingContext,
      inheritOrSampleWith: fallbackSampleRate => {
        // Use parent's sample rate if available
        if (typeof samplingContext.parentSampleRate === 'number') {
          return samplingContext.parentSampleRate;
        }
        return fallbackSampleRate;
      },
    });
  } else if (samplingContext.parentSampled !== undefined) {
    sampleRate = samplingContext.parentSampled;
  } else if (typeof options.tracesSampleRate !== 'undefined') {
    sampleRate = options.tracesSampleRate;
  }

  const parsedSampleRate = parseSampleRate(sampleRate);

  // Compare against sampleRand (generated once per trace)
  const shouldSample = sampleRand < parsedSampleRate;
  return [shouldSample, parsedSampleRate, localSampleRateWasApplied];
}
```

**Key insights:**
1. **Sampling decision made ONCE** at root span creation
2. **sampleRand propagated** through entire distributed trace
3. **Consistent sampling** across all services in a trace
4. **Dynamic sampler** allows context-based sampling (e.g., sample errors at 100%, success at 10%)

### Transport Buffering

```typescript
// From: /Users/naresh/github/sentry-javascript/packages/cloudflare/src/transport.ts
export class IsolatedPromiseBuffer {
  private _taskProducers: (() => PromiseLike<TransportMakeRequestResponse>)[];
  private readonly _bufferSize: number;

  public add(taskProducer: () => PromiseLike<TransportMakeRequestResponse>) {
    if (this._taskProducers.length >= this._bufferSize) {
      return Promise.reject(SENTRY_BUFFER_FULL_ERROR);
    }
    this._taskProducers.push(taskProducer);
    return Promise.resolve({});
  }

  public drain(timeout?: number): PromiseLike<boolean> {
    const oldTaskProducers = [...this._taskProducers];
    this._taskProducers = [];

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (timeout && timeout > 0) {
          resolve(false);
        }
      }, timeout);

      Promise.all(
        oldTaskProducers.map(taskProducer =>
          taskProducer().then(null, () => { /* swallow errors */ }),
        ),
      ).then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
```

**Why IsolatedPromiseBuffer?**
- Workers don't share I/O between invocations
- Buffer collects tasks but doesn't execute them
- All tasks drained together when `flush()` is called
- Default limit: 30 events per invocation

### Flush Lock Pattern

**Critical for Workers:**

```typescript
// From: /Users/naresh/github/sentry-javascript/packages/cloudflare/src/flush.ts
export function makeFlushLock(context: ExecutionContext): FlushLock {
  let resolveAllDone: () => void = () => undefined;
  const allDone = new Promise<void>(res => {
    resolveAllDone = res;
  });

  let pending = 0;
  const originalWaitUntil = context.waitUntil.bind(context);

  context.waitUntil = promise => {
    pending++;
    return originalWaitUntil(
      promise.finally(() => {
        if (--pending === 0) resolveAllDone();
      }),
    );
  };

  return Object.freeze({
    ready: allDone,
    finalize: () => {
      if (pending === 0) resolveAllDone();
      return allDone;
    },
  });
}

// Used in client:
public async flush(timeout?: number): Promise<boolean> {
  if (this._flushLock) {
    await this._flushLock.finalize(); // Wait for all waitUntil promises
  }
  return super.flush(timeout);
}
```

**How it works:**
1. Wraps `ExecutionContext.waitUntil` with a counter
2. Tracks all pending promises
3. `finalize()` returns a promise that resolves when all pending work is done
4. Ensures telemetry is sent before Worker terminates

### Suppressing Tracing

```typescript
// From: /Users/naresh/github/sentry-javascript/packages/core/src/tracing/trace.ts
export function suppressTracing<T>(callback: () => T): T {
  return withScope(scope => {
    scope.setSDKProcessingMetadata({ '__SENTRY_SUPPRESS_TRACING__': true });
    const res = callback();
    scope.setSDKProcessingMetadata({ '__SENTRY_SUPPRESS_TRACING__': undefined });
    return res;
  });
}

// Used when sending to Sentry (avoid instrumenting internal fetch):
function makeRequest(request: TransportRequest) {
  return suppressTracing(() => {
    return fetch(options.url, requestOptions);
  });
}
```

## 6. Recommendations for Sandbox SDK

### ✅ What to Adopt

#### 1. Auto-generate Trace IDs
**Don't require users to pass trace IDs.**

```typescript
// Good (Sentry's approach)
logger.info('Processing request');

// Bad (requires manual ID management)
logger.info('Processing request', { traceId: generateTraceId() });
```

Generate trace IDs automatically and propagate them through the call stack.

#### 2. Use AsyncLocalStorage for Context
**Eliminate explicit context passing.**

```typescript
// Good (implicit context)
export const sandboxSDK = {
  async execute(code: string) {
    return withSandboxContext(async (ctx) => {
      ctx.log('Starting execution');
      const result = await container.run(code);
      ctx.log('Execution complete');
      return result;
    });
  }
};

// Bad (explicit context everywhere)
export const sandboxSDK = {
  async execute(code: string, ctx: Context) {
    ctx.log('Starting execution');
    const result = await container.run(code, ctx);
    ctx.log('Execution complete', ctx);
    return result;
  }
};
```

#### 3. Implement Flush Lock Pattern
**Critical for ensuring logs are sent before termination.**

```typescript
export function createFlushLock(ctx: ExecutionContext) {
  let pending = 0;
  const allDone = new Promise<void>(resolve => {
    originalWaitUntil = ctx.waitUntil.bind(ctx);

    ctx.waitUntil = (promise) => {
      pending++;
      return originalWaitUntil(
        promise.finally(() => {
          if (--pending === 0) resolve();
        })
      );
    };
  });

  return {
    finalize: () => allDone,
  };
}
```

#### 4. Per-Request SDK Initialization
**Don't initialize globally, initialize per-request.**

```typescript
export function withSandboxSDK(
  optionsCallback: (env: Env) => SandboxOptions,
  handler: ExportedHandler<Env>
) {
  return {
    fetch: new Proxy(handler.fetch, {
      apply(target, thisArg, [request, env, ctx]) {
        return withRequestContext(async () => {
          const options = optionsCallback(env);
          const sdk = initSandboxSDK(options, ctx);
          return target.apply(thisArg, [request, env, ctx]);
        });
      }
    })
  };
}
```

#### 5. Two-Level Scoping
**Separate request-level and operation-level context.**

```typescript
// Request-level (isolation scope)
interface IsolationScope {
  traceId: string;
  sandboxId: string;
  userId?: string;
  environment: 'dev' | 'prod';
}

// Operation-level (scope)
interface Scope extends IsolationScope {
  spanId: string;
  operation: string;
  tags: Record<string, string>;
}
```

#### 6. Sampling Strategy
**Implement sampling to control costs.**

```typescript
interface SandboxOptions {
  // Static rate
  logSampleRate?: number; // 0-1, what % of traces to log

  // Dynamic sampler
  logSampler?: (context: {
    sandboxId: string;
    userId?: string;
    hasError: boolean;
  }) => number;
}

// Sample errors at 100%, normal execution at 10%
logSampler: ({ hasError }) => hasError ? 1.0 : 0.1
```

#### 7. Structured Context Storage

```typescript
interface SandboxContext {
  // Core tracing
  traceId: string;
  spanId: string;
  parentSpanId?: string;

  // Sandbox-specific
  sandboxId: string;
  containerUrl?: string;

  // User context
  userId?: string;

  // Metadata (not sent to logs, but used for filtering)
  _metadata: {
    samplingDecision: boolean;
    startTime: number;
  };
}

// Use Scope's setContext pattern:
scope.setContext('sandbox', {
  sandboxId: 'sb_123',
  containerUrl: 'http://container:8080',
});

scope.setContext('user', {
  id: 'user_456',
  email: 'user@example.com',
});
```

### ❌ What to Avoid

#### 1. Don't Build a Debug Logger
**Sentry's debug logger is development-only.** For production observability, use structured events/logs.

```typescript
// Don't do this (Sentry's debug logger):
debug.log('[Sandbox] Starting execution'); // Stripped in production

// Do this instead (structured logging):
logger.info('Sandbox execution started', {
  sandboxId: 'sb_123',
  codeSize: 1024,
});
```

#### 2. Don't Over-Instrument
**Sentry has opt-in prototype instrumentation because it adds overhead.**

```typescript
// Bad - instruments everything
instrumentAllMethods(durableObject);

// Good - only instrument what's needed
instrumentDurableObjectWithSentry(
  optionsCallback,
  DurableObjectClass,
  {
    instrumentPrototypeMethods: ['specificMethod'], // Opt-in specific methods
  }
);
```

#### 3. Don't Use Global State
**Everything should be request-scoped via AsyncLocalStorage.**

```typescript
// Bad
let currentTraceId: string;

export function log(message: string) {
  console.log(`[${currentTraceId}] ${message}`);
}

// Good
export function log(message: string) {
  const ctx = getCurrentContext(); // From AsyncLocalStorage
  console.log(`[${ctx.traceId}] ${message}`);
}
```

#### 4. Don't Expose Low-Level APIs
**Users shouldn't need to understand scopes, spans, etc.**

```typescript
// Bad (Sentry's low-level API - necessary for their use case)
withScope(scope => {
  scope.setTag('sandbox', 'sb_123');
  scope.setExtra('code', code);
  startSpan({ name: 'execute' }, span => {
    // ...
  });
});

// Good (high-level API for sandbox use case)
sandbox.execute(code, {
  sandboxId: 'sb_123',
  metadata: { code },
});
```

#### 5. Don't Reinvent Distributed Tracing
**If you need full distributed tracing, use OpenTelemetry or Sentry's existing patterns.**

Our use case (Worker → DO → Container) is simpler than full distributed tracing. We can use:
- Single trace ID for the entire flow
- Parent/child span IDs for hierarchy
- Simpler propagation (just HTTP headers)

### 🎯 Specific Recommendations for Sandbox SDK

#### Logger Interface

```typescript
export interface SandboxLogger {
  // Simple methods (no trace ID needed)
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, error?: Error, metadata?: Record<string, unknown>): void;

  // Span tracking (for performance)
  startSpan(name: string): Span;
}

// Usage:
const logger = getSandboxLogger(); // Gets from AsyncLocalStorage
logger.info('Container started', {
  sandboxId: 'sb_123',
  containerId: 'cnt_456',
});
```

#### Context Propagation

```typescript
// Worker → Durable Object
export class SandboxCoordinator extends DurableObject {
  async fetch(request: Request) {
    return withSandboxContext(async (ctx) => {
      // Context automatically available
      ctx.log('DO received request');

      // Propagate to container
      const response = await fetch(containerUrl, {
        headers: {
          'X-Trace-Id': ctx.traceId,
          'X-Span-Id': ctx.generateSpanId(),
          'X-Parent-Span-Id': ctx.spanId,
        }
      });

      return response;
    });
  }
}
```

#### Initialization Pattern

```typescript
// User code
export default withSandboxSDK(
  (env) => ({
    logDestination: env.LOG_DESTINATION_URL,
    logSampleRate: 0.1,
    environment: env.ENVIRONMENT,
  }),
  {
    fetch: async (request, env, ctx) => {
      const logger = getSandboxLogger();
      logger.info('Request received');

      // SDK automatically handles tracing
      const sandbox = env.SANDBOX.get(id);
      const result = await sandbox.execute(code);

      return Response.json(result);
    }
  }
);
```

## 7. Code Examples from Sentry

### Example 1: Request Handler Wrapper
```typescript
// File: /Users/naresh/github/sentry-javascript/packages/cloudflare/src/request.ts
export function wrapRequestHandler(
  wrapperOptions: RequestHandlerWrapperOptions,
  handler: (...args: unknown[]) => Response | Promise<Response>,
): Promise<Response> {
  return withIsolationScope(async isolationScope => {
    const { options, request, captureErrors = true } = wrapperOptions;
    const context = wrapperOptions.context as ExecutionContext | undefined;
    const waitUntil = context?.waitUntil?.bind?.(context);

    // Initialize client per-request
    const client = init({ ...options, ctx: context });
    isolationScope.setClient(client);

    // Continue trace from headers
    return continueTrace(
      { sentryTrace: request.headers.get('sentry-trace') || '', baggage: request.headers.get('baggage') },
      () => {
        return startSpan({ name, attributes }, async span => {
          try {
            const res = await handler();
            setHttpStatus(span, res.status);
            return res;
          } catch (e) {
            if (captureErrors) {
              captureException(e, { mechanism: { handled: false, type: 'auto.http.cloudflare' } });
            }
            throw e;
          } finally {
            waitUntil?.(flush(2000));
          }
        });
      },
    );
  });
}
```

### Example 2: Durable Object Wrapper
```typescript
// File: /Users/naresh/github/sentry-javascript/packages/cloudflare/src/durableobject.ts
function wrapMethodWithSentry<T extends OriginalMethod>(
  wrapperOptions: MethodWrapperOptions,
  handler: T,
  callback?: (...args: Parameters<T>) => void,
  noMark?: true,
): T {
  if (isInstrumented(handler)) {
    return handler;
  }

  return new Proxy(handler, {
    apply(target, thisArg, args: Parameters<T>) {
      const currentClient = getClient();
      const sentryWithScope = currentClient ? withScope : withIsolationScope;

      const wrappedFunction = (scope: Scope): unknown => {
        const context = wrapperOptions.context as ExecutionContext | undefined;
        const waitUntil = context?.waitUntil?.bind?.(context);

        const currentClient = scope.getClient();
        if (!currentClient) {
          const client = init({ ...wrapperOptions.options, ctx: context });
          scope.setClient(client);
        }

        return startSpan({ name: wrapperOptions.spanName, attributes }, () => {
          try {
            const result = Reflect.apply(target, thisArg, args);

            if (isThenable(result)) {
              return result.then(
                (res: unknown) => {
                  waitUntil?.(flush(2000));
                  return res;
                },
                (e: unknown) => {
                  captureException(e, {
                    mechanism: { type: 'auto.faas.cloudflare.durable_object', handled: false },
                  });
                  waitUntil?.(flush(2000));
                  throw e;
                },
              );
            } else {
              waitUntil?.(flush(2000));
              return result;
            }
          } catch (e) {
            captureException(e, {
              mechanism: { type: 'auto.faas.cloudflare.durable_object', handled: false },
            });
            waitUntil?.(flush(2000));
            throw e;
          }
        });
      };

      return sentryWithScope(wrappedFunction);
    },
  });
}
```

### Example 3: Workflow Instrumentation
```typescript
// File: /Users/naresh/github/sentry-javascript/packages/cloudflare/src/workflows.ts
export function instrumentWorkflowWithSentry(optionsCallback, WorkFlowClass) {
  return new Proxy(WorkFlowClass, {
    construct(target, args, newTarget) {
      const [ctx, env] = args;
      const context = copyExecutionContext(ctx);
      const options = optionsCallback(env);
      const instance = Reflect.construct(target, args, newTarget);

      return new Proxy(instance, {
        get(obj, prop, receiver) {
          if (prop === 'run') {
            return async function (event, step) {
              setAsyncLocalStorageAsyncContextStrategy();

              return withIsolationScope(async isolationScope => {
                const client = init({ ...options, enableDedupe: false });
                isolationScope.setClient(client);

                return withScope(async scope => {
                  // Deterministic trace ID from workflow instance ID
                  const propagationContext = await propagationContextFromInstanceId(event.instanceId);
                  scope.setPropagationContext(propagationContext);

                  try {
                    return await obj.run.call(obj, event, new WrappedWorkflowStep(...));
                  } finally {
                    context.waitUntil(flush(2000));
                  }
                });
              });
            };
          }
          return Reflect.get(obj, prop, receiver);
        },
      });
    },
  });
}
```

### Example 4: Fetch Integration (Distributed Tracing)
```typescript
// File: /Users/naresh/github/sentry-javascript/packages/cloudflare/src/integrations/fetch.ts
export const fetchIntegration = defineIntegration((options) => {
  return {
    name: 'Fetch',
    setupOnce() {
      addFetchInstrumentationHandler(handlerData => {
        const client = getClient();
        if (!client) return;

        instrumentFetchRequest(
          handlerData,
          _shouldCreateSpan,
          _shouldAttachTraceData, // Attach sentry-trace header
          spans,
          { spanOrigin: 'auto.http.fetch' }
        );

        if (breadcrumbs) {
          createBreadcrumb(handlerData);
        }
      }, true);
    },
  };
});
```

## 8. References

### Files Explored

**Core SDK:**
- `/Users/naresh/github/sentry-javascript/packages/core/src/tracing/trace.ts` - Main tracing implementation
- `/Users/naresh/github/sentry-javascript/packages/core/src/scope.ts` - Scope and context management
- `/Users/naresh/github/sentry-javascript/packages/core/src/utils/propagationContext.ts` - Trace ID generation
- `/Users/naresh/github/sentry-javascript/packages/core/src/utils/traceData.ts` - Trace data serialization
- `/Users/naresh/github/sentry-javascript/packages/core/src/tracing/sampling.ts` - Sampling logic
- `/Users/naresh/github/sentry-javascript/packages/core/src/utils/debug-logger.ts` - Debug logger (dev-only)
- `/Users/naresh/github/sentry-javascript/packages/core/src/utils/misc.ts` - UUID4 generation

**Cloudflare SDK:**
- `/Users/naresh/github/sentry-javascript/packages/cloudflare/src/index.ts` - Public API exports
- `/Users/naresh/github/sentry-javascript/packages/cloudflare/src/sdk.ts` - SDK initialization
- `/Users/naresh/github/sentry-javascript/packages/cloudflare/src/client.ts` - CloudflareClient implementation
- `/Users/naresh/github/sentry-javascript/packages/cloudflare/src/handler.ts` - Worker handler wrapper
- `/Users/naresh/github/sentry-javascript/packages/cloudflare/src/request.ts` - Request handler wrapper
- `/Users/naresh/github/sentry-javascript/packages/cloudflare/src/durableobject.ts` - Durable Object instrumentation
- `/Users/naresh/github/sentry-javascript/packages/cloudflare/src/workflows.ts` - Workflow instrumentation
- `/Users/naresh/github/sentry-javascript/packages/cloudflare/src/async.ts` - AsyncLocalStorage strategy
- `/Users/naresh/github/sentry-javascript/packages/cloudflare/src/scope-utils.ts` - Scope utilities
- `/Users/naresh/github/sentry-javascript/packages/cloudflare/src/transport.ts` - Transport and buffering
- `/Users/naresh/github/sentry-javascript/packages/cloudflare/src/flush.ts` - Flush lock implementation
- `/Users/naresh/github/sentry-javascript/packages/cloudflare/src/utils/copyExecutionContext.ts` - Context copying
- `/Users/naresh/github/sentry-javascript/packages/cloudflare/src/options.ts` - Options merging
- `/Users/naresh/github/sentry-javascript/packages/cloudflare/src/opentelemetry/tracer.ts` - OpenTelemetry compatibility
- `/Users/naresh/github/sentry-javascript/packages/cloudflare/src/integrations/fetch.ts` - Fetch instrumentation

**Tests:**
- `/Users/naresh/github/sentry-javascript/packages/cloudflare/test/durableobject.test.ts` - DO instrumentation tests

### Key Concepts

1. **Propagation Context** - Contains traceId, spanId, parentSpanId, sampled decision, and sampleRand
2. **Isolation Scope** - Request-level scope, holds the client
3. **Scope** - Operation-level scope, forked frequently, holds tags/extra/breadcrumbs
4. **AsyncLocalStorage** - Node.js API for maintaining async context
5. **Flush Lock** - Ensures all telemetry is sent before Worker terminates
6. **Isolated Promise Buffer** - Batches events for Workers environment
7. **Sampling** - Performance optimization via random sampling decisions
8. **Dynamic Sampling Context (DSC)** - Metadata propagated via baggage header

### Architecture Principles

1. **Implicit Context** - No explicit context passing, everything via AsyncLocalStorage
2. **Per-Request Initialization** - SDK client created per request, not globally
3. **Two-Level Scoping** - Isolation scope (request) + Scope (operation)
4. **Automatic Instrumentation** - Proxy-based wrapping of handlers
5. **Lazy Evaluation** - Spans only created if sampled
6. **Flush Guarantees** - waitUntil tracking ensures telemetry delivery
7. **Deterministic Tracing** - Workflows use deterministic trace IDs for consistency across steps
