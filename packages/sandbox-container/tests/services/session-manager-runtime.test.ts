import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandSession } from '@repo/sandbox-execution';
import { createNoOpLogger } from '@repo/shared';
import { SessionManager } from '../../src/services/session-manager';

describe('SessionManager runtime integration', () => {
  let sessionManager: SessionManager;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `session-runtime-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    sessionManager = new SessionManager(createNoOpLogger());
  });

  afterEach(async () => {
    await sessionManager.destroy();
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it('stores runtime sessions as managed session objects', async () => {
    const result = await sessionManager.executeInSession(
      'runtime-managed-session',
      'printf "managed"',
      { cwd: testDir }
    );

    expect(result.success).toBe(true);
    const managerInternals = sessionManager as unknown as {
      sessions: Map<string, unknown>;
    };
    const session = managerInternals.sessions.get('runtime-managed-session');

    expect(session).toBeDefined();
    expect(session).not.toHaveProperty('execStream');
    expect(session).not.toHaveProperty('pty');
  });

  it('does not keep the legacy Session source module', async () => {
    expect(
      await Bun.file(join(import.meta.dir, '../../src/session.ts')).exists()
    ).toBe(false);
  });

  it('creates persistent exec sessions through the execution runtime', async () => {
    const createSpy = vi.spyOn(CommandSession, 'create');

    const setResult = await sessionManager.executeInSession(
      'runtime-session',
      'export SESSION_RUNTIME_VALUE=from-runtime',
      { cwd: testDir }
    );
    const readResult = await sessionManager.executeInSession(
      'runtime-session',
      'printf "$SESSION_RUNTIME_VALUE"',
      { cwd: testDir }
    );

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: testDir })
    );
    expect(setResult.success).toBe(true);
    expect(readResult.success).toBe(true);
    if (readResult.success) {
      expect(readResult.data.stdout).toBe('from-runtime');
    }
  });

  it('does not expose pty on runtime sessions', async () => {
    const sessionId = 'runtime-no-pty-session';
    const createResult = await sessionManager.executeInSession(
      sessionId,
      'printf "ready"',
      { cwd: testDir }
    );
    expect(createResult.success).toBe(true);

    const managerInternals = sessionManager as unknown as {
      sessions: Map<string, Record<string, unknown>>;
    };
    const session = managerInternals.sessions.get(sessionId);

    expect(session).toBeDefined();
    expect(session).not.toHaveProperty('pty');
  });

  it('does not expose legacy execStream on runtime sessions', async () => {
    const sessionId = 'runtime-no-exec-stream-session';
    const createResult = await sessionManager.executeInSession(
      sessionId,
      'printf "ready"',
      { cwd: testDir }
    );
    expect(createResult.success).toBe(true);

    const managerInternals = sessionManager as unknown as {
      sessions: Map<string, Record<string, unknown>>;
    };
    const session = managerInternals.sessions.get(sessionId);

    expect(session).toBeDefined();
    expect(session).not.toHaveProperty('execStream');
  });
});
