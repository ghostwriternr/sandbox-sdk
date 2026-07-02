import type { ExecResult } from '@repo/shared';
import type {
  InternalCommandOptions,
  InternalCommandRunner
} from './internal-command-runner';
import type { SessionManager } from './session-manager';

export interface CommandContextOptions extends InternalCommandOptions {
  sessionId?: string;
}

export type ContextExec = (
  command: string,
  options?: InternalCommandOptions
) => Promise<ExecResult>;

export class CommandContextService {
  constructor(
    private readonly internalRunner: InternalCommandRunner,
    private readonly sessionManager: SessionManager
  ) {}

  async run(
    command: string,
    options: CommandContextOptions = {}
  ): Promise<ExecResult> {
    if (options.sessionId) {
      const result = await this.sessionManager.executeInSession(
        options.sessionId,
        command,
        {
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
          env: options.env,
          origin: options.origin
        }
      );
      if (!result.success) throw result.error;
      return {
        ...result.data,
        success: result.data.exitCode === 0
      };
    }

    return this.internalRunner.run(command, options);
  }

  async withExecution<T>(
    options: CommandContextOptions,
    fn: (exec: ContextExec) => Promise<T>
  ): Promise<T> {
    const exec: ContextExec = (command, overrides = {}) =>
      this.run(command, {
        ...options,
        ...overrides,
        env:
          options.env || overrides.env
            ? { ...options.env, ...overrides.env }
            : undefined,
        sessionId: options.sessionId
      });

    return fn(exec);
  }
}
