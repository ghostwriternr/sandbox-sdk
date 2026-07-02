import type {
  ExecOptions,
  SandboxCommand,
  SessionCreateResult,
  SessionDeleteResult,
  SessionExecStartResult,
  SessionListResult,
  SessionOptions
} from '@repo/shared';
import type { ServiceError } from '../core/types';
import type { ManagedSession, SessionManager } from './session-manager';

interface ServiceResultLike {
  success: boolean;
  error?: ServiceError;
}

function throwIfError(result: ServiceResultLike): void {
  if (!result.success && result.error) {
    const { code, message, details } = result.error;
    throw Object.assign(new Error(message), { code, details });
  }
}

function extractData<T>(
  result: { success: true; data: T } | { success: false; error: ServiceError }
): T {
  throwIfError(result);
  return (result as { success: true; data: T }).data;
}

export class SessionService {
  constructor(private readonly sessionManager: SessionManager) {}

  async create(options: SessionOptions = {}): Promise<SessionCreateResult> {
    const sessionOpts = {
      ...options,
      id: options.id || crypto.randomUUID()
    };
    const result = await this.sessionManager.createSession(sessionOpts);
    extractData<ManagedSession>(result);
    return {
      success: true,
      sessionId: sessionOpts.id,
      name: sessionOpts.name,
      cwd: sessionOpts.cwd,
      timestamp: new Date().toISOString()
    };
  }

  async delete(sessionId: string): Promise<SessionDeleteResult> {
    const result = await this.sessionManager.deleteSession(sessionId);
    throwIfError(result);
    return {
      success: true,
      sessionId,
      timestamp: new Date().toISOString()
    };
  }

  async list(): Promise<SessionListResult> {
    const result = await this.sessionManager.listSessions();
    const sessions = extractData<string[]>(result);
    return {
      success: true,
      sessions: sessions.map((id) => ({ id })),
      timestamp: new Date().toISOString()
    };
  }

  exec(
    sessionId: string,
    command: SandboxCommand,
    options: ExecOptions = {}
  ): Promise<SessionExecStartResult> {
    return this.sessionManager.execProcess(sessionId, command, options);
  }
}
