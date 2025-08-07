# Secure Platform Operations API Design

## Design Principles

1. **Secure by Default**: Impossible to accidentally expose secrets
2. **Intuitive**: Follows familiar patterns developers already know
3. **Type-Safe**: Full TypeScript support with compile-time checks
4. **Progressive Disclosure**: Simple for basic use, powerful when needed
5. **Fail Loudly**: Clear errors when misused, not silent failures

## Developer Mental Model

Developers building platforms need to:
- Run platform operations (with secrets) on behalf of users
- Execute user/AI-generated code (without secret access)
- Clearly separate these two contexts

## API Design Options

### Option 1: Service Provider Pattern (Recommended)
**Mental model**: "I'm providing services to the sandbox that it can call"

```typescript
// Worker code
const sandbox = await createSecureSandbox(env.Sandbox, userId);

// Register platform services (with secrets)
await sandbox.providePlatformServices({
  storage: {
    async fetchTemplate(templateId: string) {
      // This runs in Worker, has access to env.R2_KEY
      const object = await env.R2.get(`templates/${templateId}`);
      return await object.text();
    },
    
    async saveProject(name: string, data: string) {
      await env.R2.put(`projects/${userId}/${name}`, data);
      return { success: true };
    }
  },
  
  database: {
    async queryUsage() {
      const result = await env.DB.prepare(
        "SELECT * FROM usage WHERE user_id = ?"
      ).bind(userId).first();
      return result;
    }
  },
  
  ai: {
    async complete(prompt: string, model: string = 'gpt-4') {
      return await callOpenAI(env.OPENAI_KEY, prompt, model);
    }
  }
});

// Set safe environment variables for user code
await sandbox.setEnvironment({
  NODE_ENV: 'production',
  PORT: '3000',
  USER_ID: userId  // Safe to expose
});

// Execute user code - it can call platform services but not access secrets
await sandbox.exec("npm start");
```

**In the sandbox, user code can call services:**
```javascript
// This would be injected or available globally
const platform = getPlatformServices();

// User/AI code can call these
const template = await platform.storage.fetchTemplate('react-starter');
const usage = await platform.database.queryUsage();
const completion = await platform.ai.complete('Generate a React component');
```

**Pros**:
- Services are explicitly defined and documented
- TypeScript can infer all method signatures
- Clear separation of concerns
- Services can be versioned/deprecated
- Easy to add middleware (logging, rate limiting)

**Cons**:
- More upfront setup
- Need to predefine all operations

---

### Option 2: Command Pattern
**Mental model**: "I'm sending commands to the platform"

```typescript
// Worker code
const sandbox = await createSecureSandbox(env.Sandbox, userId);

// Register command handler
await sandbox.setPlatformHandler(async (command: PlatformCommand) => {
  // Validate command
  if (!ALLOWED_COMMANDS.includes(command.type)) {
    throw new Error(`Unknown command: ${command.type}`);
  }
  
  // Execute with secrets
  switch(command.type) {
    case 'storage:fetch':
      return await env.R2.get(command.params.key);
    case 'db:query':
      return await env.DB.prepare(command.params.sql).run();
    default:
      throw new Error(`Unhandled command: ${command.type}`);
  }
});

// In sandbox
await platform.execute({ 
  type: 'storage:fetch', 
  params: { key: 'templates/react' }
});
```

**Pros**:
- Flexible, can add commands without changing API
- Easy to implement logging/auditing
- Can be made type-safe with discriminated unions

**Cons**:
- Less discoverable
- Harder to get TypeScript inference
- More verbose for users

---

### Option 3: Capability-Based Security
**Mental model**: "I'm granting specific capabilities to the sandbox"

```typescript
// Worker code
const sandbox = await createSecureSandbox(env.Sandbox, userId);

// Grant specific capabilities
const capabilities = await sandbox.grantCapabilities({
  'storage:read': {
    paths: ['templates/*'],
    handler: async (path) => env.R2.get(path)
  },
  'storage:write': {
    paths: [`projects/${userId}/*`],
    handler: async (path, data) => env.R2.put(path, data)
  },
  'ai:complete': {
    models: ['gpt-3.5-turbo'],
    rateLimit: 100, // per hour
    handler: async (prompt, model) => callOpenAI(env.OPENAI_KEY, prompt, model)
  }
});

// In sandbox - capabilities are checked before execution
await capability.storage.read('templates/react'); // ✅ Allowed
await capability.storage.read('projects/other-user/secret'); // ❌ Denied
```

**Pros**:
- Fine-grained permissions
- Principle of least privilege
- Self-documenting permissions

**Cons**:
- More complex to set up
- Can become verbose with many capabilities
- Might be overkill for simple use cases

---

### Option 4: Proxy Object Pattern
**Mental model**: "I'm creating a platform proxy with my secrets"

```typescript
// Worker code
const sandbox = await createSecureSandbox(env.Sandbox, userId);

// Create platform proxy
const platform = new PlatformProxy(env);
await sandbox.attachPlatform(platform);

// PlatformProxy class (shared between Worker and SDK)
class PlatformProxy {
  constructor(private env: Env) {}
  
  @expose()  // Decorator marks method as callable from sandbox
  async fetchTemplate(id: string) {
    return await this.env.R2.get(`templates/${id}`);
  }
  
  @expose({ rateLimit: 100 })
  async queryDatabase(query: string) {
    return await this.env.DB.prepare(query).run();
  }
  
  // Not decorated = not exposed to sandbox
  private async internalMethod() {
    // This can't be called from sandbox
  }
}
```

**Pros**:
- Very clean, class-based API
- Decorators provide metadata
- Easy to test and mock
- Familiar OOP pattern

**Cons**:
- Requires decorators (experimental in TS)
- More "magic" happening behind scenes
- Need to ensure methods are serializable

---

## Recommended Approach: Hybrid Service Provider

Combining the best aspects:

```typescript
// 1. Define your platform services interface (shared types)
interface PlatformServices {
  storage: StorageService;
  database: DatabaseService;
  ai: AIService;
}

interface StorageService {
  fetchTemplate(id: string): Promise<string>;
  saveProject(name: string, data: string): Promise<void>;
}

// 2. In Worker - implement and provide services
export default {
  async fetch(request: Request, env: Env) {
    const sandbox = await createSecureSandbox(env.Sandbox, userId);
    
    // Type-safe service implementation
    const services: PlatformServices = {
      storage: {
        async fetchTemplate(id) {
          const obj = await env.R2.get(`templates/${id}`);
          if (!obj) throw new Error('Template not found');
          return await obj.text();
        },
        async saveProject(name, data) {
          await env.R2.put(`projects/${userId}/${name}`, data);
        }
      },
      database: {
        async getUsage() {
          return await env.DB.prepare(
            "SELECT * FROM usage WHERE user_id = ?"
          ).bind(userId).first();
        }
      },
      ai: {
        async complete(prompt, options = {}) {
          return await callOpenAI(env.OPENAI_KEY, prompt, options);
        }
      }
    };
    
    // Attach services with optional middleware
    await sandbox.providePlatformServices(services, {
      middleware: [
        rateLimiter({ max: 100, window: '1h' }),
        logger({ level: 'info' }),
        validator({ schemas: platformSchemas })
      ]
    });
    
    // Safe environment variables
    await sandbox.setUserEnvironment({
      NODE_ENV: 'production',
      PUBLIC_API_URL: 'https://api.example.com'  // Safe to expose
    });
    
    // Execute user code
    return await sandbox.exec(userCode);
  }
}
```

```typescript
// 3. In sandbox (what user/AI code sees)
// This could be auto-injected or imported
import { platform } from '@sandbox/platform';

// Fully typed, auto-completed
const template = await platform.storage.fetchTemplate('react-starter');
const usage = await platform.database.getUsage();
const response = await platform.ai.complete('Generate a React component');

// Regular env vars (safe ones only)
console.log(process.env.NODE_ENV); // 'production'
console.log(process.env.OPENAI_KEY); // undefined - not exposed!
```

## Migration Strategy

### Phase 1: Deprecation Warning
```typescript
class Sandbox {
  async setEnvVars(vars: Record<string, string>) {
    console.warn(
      "⚠️ setEnvVars() is deprecated for secrets. " +
      "Use providePlatformServices() for secret operations or " +
      "setUserEnvironment() for safe variables. " +
      "See: https://docs.../migration"
    );
    
    // Detect likely secrets
    const suspiciousKeys = Object.keys(vars).filter(k => 
      /key|secret|token|password|credential/i.test(k)
    );
    
    if (suspiciousKeys.length > 0) {
      console.error(
        "🚨 SECURITY WARNING: Detected potential secrets: " +
        suspiciousKeys.join(', ')
      );
    }
  }
}
```

### Phase 2: Dual Mode
```typescript
// Support both patterns during transition
const sandbox = await createSecureSandbox(env.Sandbox, userId, {
  mode: 'hybrid',  // or 'legacy' or 'secure'
  allowLegacyEnvVars: true  // Must explicitly opt-in
});
```

### Phase 3: Secure by Default
```typescript
// New API only
const sandbox = await createSecureSandbox(env.Sandbox, userId);
// sandbox.setEnvVars() no longer exists
// Must use sandbox.providePlatformServices() and sandbox.setUserEnvironment()
```

## TypeScript Types

```typescript
// Platform service constraints
type PlatformService = {
  [method: string]: (...args: any[]) => Promise<any>;
};

type PlatformServices = {
  [namespace: string]: PlatformService;
};

// Middleware types
interface ServiceMiddleware {
  before?(method: string, args: any[]): Promise<void>;
  after?(method: string, result: any): Promise<any>;
  onError?(method: string, error: Error): Promise<void>;
}

// Sandbox options
interface SecureSandboxOptions {
  mode?: 'secure' | 'hybrid' | 'legacy';
  middleware?: ServiceMiddleware[];
  timeout?: number;
  maxConcurrentCalls?: number;
}

// Full API
interface SecureSandbox {
  // Platform operations (secrets)
  providePlatformServices<T extends PlatformServices>(
    services: T, 
    options?: ServiceOptions
  ): Promise<void>;
  
  // User environment (no secrets)
  setUserEnvironment(vars: Record<string, string>): Promise<void>;
  
  // Execution
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  runCode(code: string, options?: RunCodeOptions): Promise<CodeResult>;
  
  // Lifecycle
  destroy(): Promise<void>;
}
```

## Error Handling

```typescript
// Clear, actionable errors
class PlatformServiceError extends Error {
  constructor(
    message: string,
    public service: string,
    public method: string,
    public cause?: Error
  ) {
    super(`Platform service error in ${service}.${method}: ${message}`);
  }
}

// Usage
try {
  await platform.storage.fetchTemplate('non-existent');
} catch (error) {
  if (error instanceof PlatformServiceError) {
    console.error(`Failed to call ${error.service}.${error.method}`);
    // Handle appropriately
  }
}
```

## Developer Experience Checklist

- [ ] IntelliSense/autocomplete for all platform methods
- [ ] Clear error messages with suggested fixes
- [ ] Migration guide with code examples
- [ ] Debug mode to log all platform calls
- [ ] Mock implementations for testing
- [ ] Rate limiting and quotas built-in
- [ ] Audit logging for compliance
- [ ] Gradual migration path
- [ ] Examples for common use cases
- [ ] VSCode extension for validation

## Next Steps

1. Prototype the Service Provider pattern
2. Create TypeScript definitions
3. Build middleware system
4. Write migration tooling
5. Create comprehensive examples
6. Test with real use cases