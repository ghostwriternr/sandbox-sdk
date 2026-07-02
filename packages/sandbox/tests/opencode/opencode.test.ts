// packages/sandbox/tests/opencode/opencode.test.ts
import type { SandboxProcess } from '@repo/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOpencode,
  proxyToOpencode,
  proxyToOpencodeServer
} from '../../src/opencode/opencode';
import type { OpencodeServer } from '../../src/opencode/types';
import { OpencodeStartupError } from '../../src/opencode/types';
import type { Sandbox } from '../../src/sandbox';

// Mock the dynamic import of @opencode-ai/sdk/v2/client
vi.mock('@opencode-ai/sdk/v2/client', () => ({
  createOpencodeClient: vi.fn().mockReturnValue({ session: {} })
}));

/** Minimal mock for SandboxProcess methods used by OpenCode integration */
interface MockProcess {
  pid: number;
  stdin: any;
  stdout: any;
  stderr: any;
  exitCode: Promise<number>;
  waitForPort: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  output: ReturnType<typeof vi.fn>;
}

/** Minimal mock for Sandbox methods used by OpenCode integration */
interface MockSandbox {
  exec: ReturnType<typeof vi.fn>;
  containerFetch: ReturnType<typeof vi.fn>;
}

function createMockProcess(overrides: Partial<MockProcess> = {}): MockProcess {
  return {
    pid: 123,
    stdin: null,
    stdout: null,
    stderr: null,
    exitCode: Promise.resolve(0),
    waitForPort: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    output: vi
      .fn()
      .mockResolvedValue({
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        exitCode: 0
      }),
    ...overrides
  };
}

function createMockSandbox(overrides: Partial<MockSandbox> = {}): MockSandbox {
  return {
    exec: vi.fn(),
    containerFetch: vi.fn().mockResolvedValue(new Response('ok')),
    ...overrides
  };
}

describe('createOpencode', () => {
  let mockSandbox: MockSandbox;
  let mockProcess: MockProcess;

  beforeEach(() => {
    mockProcess = createMockProcess();
    mockSandbox = createMockSandbox({
      exec: vi.fn().mockResolvedValue(mockProcess)
    });
  });

  it('should start OpenCode server on default port 4096', async () => {
    const result = await createOpencode(mockSandbox as unknown as Sandbox);

    expect(mockSandbox.exec).toHaveBeenCalledWith(
      'opencode serve --port 4096 --hostname 0.0.0.0',
      expect.any(Object)
    );
    expect(result.server.port).toBe(4096);
    expect(result.server.url).toBe('http://localhost:4096');
  });

  it('should start OpenCode server on custom port', async () => {
    const result = await createOpencode(mockSandbox as unknown as Sandbox, {
      port: 8080
    });

    expect(mockSandbox.exec).toHaveBeenCalledWith(
      'opencode serve --port 8080 --hostname 0.0.0.0',
      expect.any(Object)
    );
    expect(result.server.port).toBe(8080);
  });

  it('should start OpenCode server in specified directory', async () => {
    await createOpencode(mockSandbox as unknown as Sandbox, {
      directory: '/home/user/project'
    });

    expect(mockSandbox.exec).toHaveBeenCalledWith(
      'cd /home/user/project && opencode serve --port 4096 --hostname 0.0.0.0',
      expect.any(Object)
    );
  });

  it('should pass config via OPENCODE_CONFIG_CONTENT env var', async () => {
    const config = {
      provider: { anthropic: { options: { apiKey: 'test-key' } } }
    };
    await createOpencode(mockSandbox as unknown as Sandbox, { config });

    expect(mockSandbox.exec).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config)
        })
      })
    );
  });

  it('should extract API keys from config to env vars', async () => {
    const config = {
      provider: {
        anthropic: { options: { apiKey: 'anthropic-key' } },
        openai: { options: { apiKey: 'openai-key' } }
      }
    };
    await createOpencode(mockSandbox as unknown as Sandbox, { config });

    expect(mockSandbox.exec).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          ANTHROPIC_API_KEY: 'anthropic-key',
          OPENAI_API_KEY: 'openai-key'
        })
      })
    );
  });

  it('should pass custom env vars to the process', async () => {
    await createOpencode(mockSandbox as unknown as Sandbox, {
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        TRACEPARENT: '00-abc123-def456-01'
      }
    });

    expect(mockSandbox.exec).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        env: expect.objectContaining({
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
          TRACEPARENT: '00-abc123-def456-01'
        })
      })
    );
  });

  it('should allow custom env vars to override config-extracted env vars', async () => {
    const config = {
      provider: {
        anthropic: { options: { apiKey: 'config-key' } }
      }
    };
    await createOpencode(mockSandbox as unknown as Sandbox, {
      config,
      env: {
        ANTHROPIC_API_KEY: 'custom-override-key'
      }
    });

    expect(mockSandbox.exec).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        env: expect.objectContaining({
          ANTHROPIC_API_KEY: 'custom-override-key'
        })
      })
    );
  });

  it('should wait for port to be ready', async () => {
    await createOpencode(mockSandbox as unknown as Sandbox);

    expect(mockProcess.waitForPort).toHaveBeenCalledWith(4096, {
      mode: 'http',
      path: '/path',
      status: 200,
      timeout: 180_000
    });
  });

  it('should return client and server', async () => {
    const result = await createOpencode(mockSandbox as unknown as Sandbox);

    expect(result.client).toBeDefined();
    expect(result.server).toBeDefined();
    expect(result.server.port).toBe(4096);
    expect(result.server.url).toBe('http://localhost:4096');
  });

  it('should provide close method that kills process', async () => {
    const result = await createOpencode(mockSandbox as unknown as Sandbox);

    await result.server.close();

    expect(mockProcess.kill).toHaveBeenCalledWith();
  });

  it('should throw OpencodeStartupError when server fails to start', async () => {
    mockProcess.waitForPort.mockRejectedValue(new Error('timeout'));

    await expect(
      createOpencode(mockSandbox as unknown as Sandbox)
    ).rejects.toThrow(OpencodeStartupError);
  });

  describe('malformed config handling', () => {
    it.each([
      ['string', { provider: 'anthropic' }],
      ['array', { provider: ['anthropic'] }],
      ['null', { provider: null }],
      ['number', { provider: 42 }]
    ])('should handle provider as %s without crashing', async (_, config) => {
      await createOpencode(mockSandbox as unknown as Sandbox, {
        config: config as never
      });

      // Should start process without extracting invalid API keys
      expect(mockSandbox.exec).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          env: expect.objectContaining({
            OPENCODE_CONFIG_CONTENT: JSON.stringify(config)
          })
        })
      );
      // Should NOT have any *_API_KEY env vars from malformed config
      const callArgs = mockSandbox.exec.mock.calls[0][1];
      const envKeys = Object.keys(callArgs.env);
      expect(envKeys.filter((k: string) => k.endsWith('_API_KEY'))).toEqual([]);
    });
  });
});

describe('proxyToOpencodeServer', () => {
  const server: OpencodeServer = {
    port: 4096,
    url: 'http://localhost:4096',
    close: vi.fn()
  };

  function createMockSandboxForProxy() {
    return {
      containerFetch: vi.fn().mockResolvedValue(new Response('proxied'))
    } as unknown as Sandbox;
  }

  it('should proxy GET requests directly without redirect', async () => {
    const sandbox = createMockSandboxForProxy();
    const request = new Request('http://example.com/', {
      headers: { accept: 'text/html' }
    });

    await proxyToOpencodeServer(request, sandbox, server);

    expect(sandbox.containerFetch).toHaveBeenCalledWith(request, 4096);
  });

  it('should proxy POST requests directly', async () => {
    const sandbox = createMockSandboxForProxy();
    const request = new Request('http://example.com/session', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test' })
    });

    await proxyToOpencodeServer(request, sandbox, server);

    expect(sandbox.containerFetch).toHaveBeenCalledWith(request, 4096);
  });
});

describe('proxyToOpencode', () => {
  const server: OpencodeServer = {
    port: 4096,
    url: 'http://localhost:4096',
    close: vi.fn()
  };

  function createMockSandboxForProxy() {
    return {
      containerFetch: vi.fn().mockResolvedValue(new Response('proxied'))
    } as unknown as Sandbox;
  }

  it('should redirect GET html requests to add ?url= parameter', () => {
    const sandbox = createMockSandboxForProxy();
    const request = new Request('http://example.com/', {
      headers: { accept: 'text/html' }
    });

    const response = proxyToOpencode(request, sandbox, server);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get('location')).toBe(
      'http://example.com/?url=http%3A%2F%2Fexample.com'
    );
  });

  it('should proxy POST requests directly without redirect', async () => {
    const sandbox = createMockSandboxForProxy();
    const request = new Request('http://example.com/session', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test' })
    });

    await proxyToOpencode(request, sandbox, server);

    expect(sandbox.containerFetch).toHaveBeenCalledWith(request, 4096);
  });

  it('should proxy GET requests that already have ?url= parameter', async () => {
    const sandbox = createMockSandboxForProxy();
    const request = new Request('http://example.com/?url=http://example.com', {
      headers: { accept: 'text/html' }
    });

    await proxyToOpencode(request, sandbox, server);

    expect(sandbox.containerFetch).toHaveBeenCalledWith(request, 4096);
  });

  it('should proxy GET requests for non-html assets', async () => {
    const sandbox = createMockSandboxForProxy();
    const request = new Request('http://example.com/app.js', {
      headers: { accept: 'application/javascript' }
    });

    await proxyToOpencode(request, sandbox, server);

    expect(sandbox.containerFetch).toHaveBeenCalledWith(request, 4096);
  });
});
