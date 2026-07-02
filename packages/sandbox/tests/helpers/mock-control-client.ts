import type {
  ExecOptions,
  ExecOutput,
  SandboxCommand,
  SessionCreateOptions,
  SessionCreateResult,
  SessionDeleteResult,
  SessionExecStartResult,
  SessionListResult
} from '@repo/shared';
import { vi } from 'vitest';
import type { Sandbox } from '../../src/sandbox';

/**
 * Create a test double for Sandbox's container control client.
 *
 * Keep this aligned with ContainerControlClient's public surface so tests can
 * override only the methods relevant to the scenario under test.
 */
export function createMockControlClient(): Sandbox['client'] {
  return {
    files: {
      readFile: vi.fn(),
      readFileStream: vi.fn(),
      writeFile: vi.fn(),
      writeFileStream: vi.fn(),
      deleteFile: vi.fn(),
      renameFile: vi.fn(),
      moveFile: vi.fn(),
      mkdir: vi.fn(),
      listFiles: vi.fn(),
      exists: vi.fn()
    },
    sessions: {
      create: vi.fn(
        async (
          options?: SessionCreateOptions
        ): Promise<SessionCreateResult> => {
          return {
            success: true,
            sessionId: options?.id ?? 'mock-session-id',
            timestamp: new Date().toISOString()
          };
        }
      ),
      delete: vi.fn(async (sessionId: string): Promise<SessionDeleteResult> => {
        return {
          success: true,
          sessionId,
          timestamp: new Date().toISOString()
        };
      }),
      list: vi.fn(async (): Promise<SessionListResult> => {
        return {
          success: true,
          sessions: [],
          timestamp: new Date().toISOString()
        };
      }),
      exec: vi.fn(
        async (
          _sessionId: string,
          _command: SandboxCommand,
          _options?: ExecOptions
        ): Promise<SessionExecStartResult> => {
          return {
            processId: 'mock-proc-id',
            pid: 123,
            stdin: null,
            stdout: null,
            stderr: null,
            exitCode: Promise.resolve(0),
            output: async (): Promise<ExecOutput> => ({
              exitCode: 0,
              stdout: new ArrayBuffer(0),
              stderr: new ArrayBuffer(0)
            }),
            kill: (_signal?: number): void => {}
          };
        }
      )
    },
    ports: {
      watchPort: vi.fn()
    },
    git: {
      checkout: vi.fn()
    },
    utils: {
      ping: vi.fn(),
      getVersion: vi.fn(),
      getCommands: vi.fn()
    },
    backup: {
      createArchive: vi.fn(),
      restoreArchive: vi.fn(),
      uploadParts: vi.fn()
    },
    watch: {
      watch: vi.fn(),
      checkChanges: vi.fn()
    },
    tunnels: {
      ensureTunnelRun: vi.fn(),
      stopTunnelRun: vi.fn()
    },
    terminals: {
      createTerminal: vi.fn(),
      destroyTerminal: vi.fn()
    },
    setRetryTimeoutMs: vi.fn(),
    isWebSocketConnected: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn()
  } as unknown as Sandbox['client'];
}
