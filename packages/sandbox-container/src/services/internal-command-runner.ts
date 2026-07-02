import type { ExecResult, Logger } from '@repo/shared';

const DEFAULT_CWD = '/workspace';
const TIMEOUT_EXIT_CODE = 124;

export interface InternalCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  origin?: 'internal' | 'user';
}

export class InternalCommandRunner {
  constructor(private readonly logger: Logger) {}

  async run(
    command: string,
    options: InternalCommandOptions = {}
  ): Promise<ExecResult> {
    const start = Date.now();
    const proc = Bun.spawn(['/bin/bash', '-lc', command], {
      cwd: options.cwd ?? DEFAULT_CWD,
      env: this.buildEnv(options.env),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    });

    const exitCode = await this.waitWithTimeout(proc, options.timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text()
    ]);

    return {
      success: exitCode === 0,
      exitCode,
      stdout,
      stderr:
        exitCode === TIMEOUT_EXIT_CODE && options.timeoutMs !== undefined
          ? `${stderr}Command timed out after ${options.timeoutMs}ms\n`
          : stderr,
      command,
      duration: Date.now() - start,
      timestamp: new Date(start).toISOString()
    };
  }

  private buildEnv(
    env?: Record<string, string | undefined>
  ): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) merged[key] = value;
    }
    for (const [key, value] of Object.entries(env ?? {})) {
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }

  private async waitWithTimeout(
    proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
    timeoutMs?: number
  ): Promise<number> {
    if (timeoutMs === undefined) return proc.exited;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        proc.exited,
        new Promise<number>((resolve) => {
          timeout = setTimeout(() => {
            proc.kill('SIGTERM');
            resolve(TIMEOUT_EXIT_CODE);
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
