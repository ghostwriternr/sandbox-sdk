/**
 * Unit tests for process readiness feature
 *
 * Tests the waitForPort() functionality
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProcessExitedBeforeReadyError,
  ProcessReadyTimeoutError
} from '../src/errors';
import { Sandbox } from '../src/sandbox';
import { createMockControlClient } from './helpers/mock-control-client';

vi.mock('@cloudflare/containers', () => {
  const MockContainer = class Container {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    async fetch(): Promise<Response> {
      return new Response('Mock Container fetch');
    }
    async containerFetch(): Promise<Response> {
      return new Response('Mock Container HTTP fetch');
    }
    async getState() {
      return { status: 'healthy' };
    }
    async startAndWaitForPorts(): Promise<void> {}
  };

  return {
    Container: MockContainer,
    ContainerProxy: class ContainerProxy {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      async fetch(request: Request): Promise<Response> {
        return new Response('Mock ContainerProxy fetch');
      }
    },
    getContainer: vi.fn(),
    switchPort: vi.fn()
  };
});

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}

describe('Process Readiness Feature', () => {
  let sandbox: Sandbox;
  let mockCtx: Partial<DurableObjectState<{}>>;
  let mockEnv: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockCtx = {
      storage: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue(new Map())
      } as any,
      blockConcurrencyWhile: vi
        .fn()
        .mockImplementation(
          <T>(callback: () => Promise<T>): Promise<T> => callback()
        ),
      waitUntil: vi.fn(),
      id: {
        toString: () => 'test-sandbox-id',
        equals: vi.fn(),
        name: 'test-sandbox'
      } as any
    };

    mockEnv = {};

    sandbox = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      mockEnv
    );

    await vi.waitFor(() => {
      expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
    });

    sandbox.client = createMockControlClient();

    // Mock session creation
    vi.spyOn(sandbox.client.sessions, 'create').mockResolvedValue({
      success: true,
      id: 'sandbox-default',
      message: 'Created'
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('waitForPort() method', () => {
    // Helper to create an SSE stream with events
    function createPortWatchStream(
      events: Array<{
        type: string;
        port: number;
        statusCode?: number;
        exitCode?: number;
        error?: string;
      }>
    ): ReadableStream<Uint8Array> {
      return new ReadableStream({
        start(controller) {
          for (const event of events) {
            const data = `data: ${JSON.stringify(event)}\n\n`;
            controller.enqueue(new TextEncoder().encode(data));
          }
          controller.close();
        }
      });
    }

    function setupNativeExec(
      exitCodePromise: Promise<number> = new Promise<number>(() => {})
    ) {
      const nativeProcessMock = {
        stdin: null,
        stdout: textStream(''),
        stderr: textStream(''),
        pid: 12345,
        exitCode: exitCodePromise,
        output: async () => ({
          stdout: new ArrayBuffer(0),
          stderr: new ArrayBuffer(0),
          exitCode: 0
        }),
        kill: vi.fn()
      };
      const nativeExec = vi.fn(async () => nativeProcessMock);
      Object.assign((sandbox as any).ctx, {
        container: { running: true, exec: nativeExec }
      });
    }

    it('should wait for port to become available with HTTP mode (default)', async () => {
      setupNativeExec();

      const mockStream = createPortWatchStream([
        { type: 'watching', port: 3000 },
        { type: 'ready', port: 3000, statusCode: 200 }
      ]);
      vi.spyOn(sandbox.client.ports, 'watchPort').mockResolvedValue(mockStream);

      const proc = await sandbox.exec('npm start');
      await proc.waitForPort(3000);

      expect(sandbox.client.ports.watchPort).toHaveBeenCalledWith({
        port: 3000,
        mode: 'http',
        path: undefined,
        statusMin: undefined,
        statusMax: undefined,
        interval: undefined
      });
    });

    it('should support TCP mode for non-HTTP services', async () => {
      setupNativeExec();

      const mockStream = createPortWatchStream([
        { type: 'watching', port: 5432 },
        { type: 'ready', port: 5432 }
      ]);
      vi.spyOn(sandbox.client.ports, 'watchPort').mockResolvedValue(mockStream);

      const proc = await sandbox.exec('postgres');
      await proc.waitForPort(5432, { mode: 'tcp' });

      expect(sandbox.client.ports.watchPort).toHaveBeenCalledWith({
        port: 5432,
        mode: 'tcp',
        path: undefined,
        statusMin: undefined,
        statusMax: undefined,
        interval: undefined
      });
    });

    it('should support custom health check path', async () => {
      setupNativeExec();

      const mockStream = createPortWatchStream([
        { type: 'watching', port: 3000 },
        { type: 'ready', port: 3000, statusCode: 200 }
      ]);
      vi.spyOn(sandbox.client.ports, 'watchPort').mockResolvedValue(mockStream);

      const proc = await sandbox.exec('npm start');
      await proc.waitForPort(3000, { path: '/health', status: 200 });

      expect(sandbox.client.ports.watchPort).toHaveBeenCalledWith({
        port: 3000,
        mode: 'http',
        path: '/health',
        statusMin: 200,
        statusMax: 200,
        interval: undefined
      });
    });

    it('should throw ProcessExitedBeforeReadyError when process exits before port is ready', async () => {
      let resolveExitCode: (code: number) => void = () => {};
      const exitCodePromise = new Promise<number>((resolve) => {
        resolveExitCode = resolve;
      });
      setupNativeExec(exitCodePromise);

      // Stream emits process_exited event
      const mockStream = createPortWatchStream([
        { type: 'watching', port: 3000 },
        { type: 'process_exited', port: 3000, exitCode: 1 }
      ]);
      vi.spyOn(sandbox.client.ports, 'watchPort').mockResolvedValue(mockStream);

      const proc = await sandbox.exec('npm start');
      resolveExitCode(1);

      try {
        await proc.waitForPort(3000);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ProcessExitedBeforeReadyError);
        const exitError = error as ProcessExitedBeforeReadyError;
        expect(exitError.condition).toBe('port 3000');
      }
    });

    it('should throw ProcessReadyTimeoutError when port does not become ready', async () => {
      const exitCodePromise = new Promise<number>(() => {}); // never exits
      setupNativeExec(exitCodePromise);

      // Stream that stays open (never emits ready or exit events)
      const mockStream = new ReadableStream<Uint8Array>({
        start(controller) {
          const data = `data: ${JSON.stringify({ type: 'watching', port: 3000 })}\n\n`;
          controller.enqueue(new TextEncoder().encode(data));
          // Never close - simulates port never becoming ready
        }
      });
      vi.spyOn(sandbox.client.ports, 'watchPort').mockResolvedValue(mockStream);

      const proc = await sandbox.exec('npm start');

      try {
        await proc.waitForPort(3000, { timeout: 100, interval: 50 });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ProcessReadyTimeoutError);
        const timeoutError = error as ProcessReadyTimeoutError;
        expect(timeoutError.condition).toBe('port 3000');
      }
    });
  });
});
