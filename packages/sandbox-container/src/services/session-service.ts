import type {
  ExecOptions,
  SandboxCommand,
  SessionCreateResult,
  SessionDeleteResult,
  SessionExecStartResult,
  SessionListResult,
  SessionOptions
} from '@repo/shared';
import type { ServiceResult } from '../core/types';
import type { SessionManager } from './session-manager';

function throwIfError(result: ServiceResult<any, any>): void {
  if (!result.success) {
    const { code, message, details } = result.error;
    throw Object.assign(new Error(message), { code, details });
  }
}

function extractData<T>(result: ServiceResult<any, any>): T {
  throwIfError(result);
  return (result as { data: T }).data;
}

export class SessionService {
  constructor(private readonly sessionManager: SessionManager) {}

  async create(options: SessionOptions = {}): Promise<SessionCreateResult> {
    const sessionOpts = {
      ...options,
      id: options.id || crypto.randomUUID()
    };
    const result = await this.sessionManager.createSession(sessionOpts);
    const session = extractData<{ id: string; name?: string; cwd?: string }>(
      result
    );
    return {
      success: true,
      sessionId: session.id,
      name: session.name,
      cwd: session.cwd,
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
