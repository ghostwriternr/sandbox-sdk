import { Buffer } from 'node:buffer';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMMAND_SESSION_FRAME_PREFIX,
  createCommandSessionScript
} from './shell-script';

type PromiseWithResolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

export type StdioChunk = {
  stream: 'stdout' | 'stderr';
  data: string;
  seq: number;
};

const FRAME_PREFIX = COMMAND_SESSION_FRAME_PREFIX;
const READY_TIMEOUT_MS = 2_000;
const PROCESS_TIMEOUT_GRACE_MS = 100;

type SessionState = 'starting' | 'ready' | 'closing' | 'closed' | 'failed';

type StdinWriter = {
  write(data: string): number | Promise<number>;
  end?: () => number | Promise<number>;
};

export type CommandSessionExecOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
};

export type CommandSessionStartProcessOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: StdioChunk) => void;
};

type PendingOperation =
  | {
      kind: 'exec';
      id: string;
      stdoutController: ReadableStreamDefaultController<Uint8Array>;
      stderrController: ReadableStreamDefaultController<Uint8Array>;
      exitCode: PromiseWithResolvers<number>;
      timeout?: ReturnType<typeof setTimeout>;
    }
  | {
      kind: 'startProcess';
      id: string;
      timeoutMs?: number;
      abortSignal?: AbortSignal;
      onOutput?: (chunk: StdioChunk) => void;
      resolve: (process: CommandSessionProcess) => void;
      reject: (error: Error) => void;
    };

type ProcessCompletion = {
  pid: number;
  stdoutController?: ReadableStreamDefaultController<Uint8Array>;
  stderrController?: ReadableStreamDefaultController<Uint8Array>;
  exitCode: PromiseWithResolvers<number>;
  nextSeq: number;
  onOutput?: (chunk: StdioChunk) => void;
  timeout?: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
};

const backgroundProcesses = new WeakSet<CommandSessionProcess>();

export class CommandSessionProcess {
  constructor(
    readonly pid: number,
    readonly stdin: WritableStream<Uint8Array> | null,
    readonly stdout: ReadableStream<Uint8Array> | null,
    readonly stderr: ReadableStream<Uint8Array> | null,
    readonly exitCode: Promise<number>,
    private readonly killFn: (signal?: number) => Promise<void> | void
  ) {}

  async output(): Promise<{
    stdout: ArrayBuffer;
    stderr: ArrayBuffer;
    exitCode: number;
  }> {
    const [stdout, stderr, exitCode] = await Promise.all([
      this.stdout
        ? new Response(this.stdout).arrayBuffer()
        : new ArrayBuffer(0),
      this.stderr
        ? new Response(this.stderr).arrayBuffer()
        : new ArrayBuffer(0),
      this.exitCode
    ]);

    return { stdout, stderr, exitCode };
  }

  kill(signal?: number): Promise<void> | void {
    return this.killFn(signal);
  }
}

export class CommandSession implements AsyncDisposable {
  private readonly shell: Bun.Subprocess;
  private readonly stdin: StdinWriter;
  private readonly tempDir: string;
  private readonly ready = Promise.withResolvers<void>();
  private readonly processes = new Map<string, ProcessCompletion>();
  private state: SessionState = 'starting';
  private outputBuffer = '';
  private pending?: PendingOperation;
  private failure?: Error;
  private shellExitCode: number | null = null;
  private cleanupPromise?: Promise<void>;
  private operationQueue: Promise<void> = Promise.resolve();

  private constructor(options: {
    shell: Bun.Subprocess;
    stdin: StdinWriter;
    tempDir: string;
  }) {
    this.shell = options.shell;
    this.stdin = options.stdin;
    this.tempDir = options.tempDir;
    this.ready.promise.catch(() => {});
    this.shell.exited.then((exitCode) => {
      this.shellExitCode = exitCode;
      if (
        this.state !== 'closing' &&
        this.state !== 'closed' &&
        this.state !== 'failed'
      ) {
        this.fail(
          new Error(`Command session shell exited with code ${exitCode}`)
        );
      }
    });
    void this.readFrames();
  }

  static async create(
    options: { cwd?: string; env?: Record<string, string> } = {}
  ): Promise<CommandSession> {
    const tempDir = await mkdtemp(join(tmpdir(), 'sandbox-command-session-'));
    const shell = Bun.spawn(['bash', '--noprofile', '--norc'], {
      cwd: await resolveStartupCwd(options.cwd),
      env: {
        ...process.env,
        ...options.env,
        HISTFILE: ''
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    });

    const session = new CommandSession({
      shell,
      stdin: getShellStdin(shell),
      tempDir
    });

    try {
      await session.writeShell(createCommandSessionScript(tempDir));
      await session.waitForReady();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  async exec(
    command: string | string[],
    options: CommandSessionExecOptions = {}
  ): Promise<CommandSessionProcess> {
    if (Array.isArray(command)) {
      const cmdStr = argvToShellCommand(command);
      return this.enqueueOperation(() => this.startProcessNow(cmdStr, options));
    }
    return this.enqueueOperation(() => this.execNow(command, options));
  }

  async startProcess(
    command: string,
    options: CommandSessionStartProcessOptions = {}
  ): Promise<CommandSessionProcess> {
    return this.enqueueOperation(() => this.startProcessNow(command, options));
  }

  isReady(): boolean {
    return this.state === 'ready' && !this.failure;
  }

  getShellExitCode(): number | null {
    return this.shellExitCode;
  }

  async close(): Promise<void> {
    if (this.state === 'closed') {
      return;
    }

    const error = this.failure ?? new Error('Command session is closed');
    this.failure = error;
    if (this.state !== 'failed') {
      this.state = 'closing';
    }
    this.ready.reject(error);
    this.rejectPending(error);
    await this.terminateProcesses(error);
    await this.cleanupResources();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private enqueueOperation<T>(run: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(run, run);
    this.operationQueue = result.then(
      async (val) => {
        if (val instanceof CommandSessionProcess) {
          if (!backgroundProcesses.has(val)) {
            await val.exitCode.catch(() => {});
          }
        }
      },
      () => {}
    );
    return result;
  }

  private async waitForReady(): Promise<void> {
    await Promise.race([
      this.ready.promise,
      Bun.sleep(READY_TIMEOUT_MS).then(() => {
        throw new Error('Timed out waiting for command session readiness');
      })
    ]);
  }

  private async execNow(
    command: string,
    options: CommandSessionExecOptions
  ): Promise<CommandSessionProcess> {
    this.assertReadyForOperation();

    const id = crypto.randomUUID().replaceAll('-', '');
    const encodedCommand = Buffer.from(
      buildScopedCommand(command, options)
    ).toString('base64');

    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      }
    });

    let stderrController!: ReadableStreamDefaultController<Uint8Array>;
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        stderrController = controller;
      }
    });

    const exitCodeResolver = Promise.withResolvers<number>();

    const killFn = () => {
      try {
        this.shell.kill('SIGINT');
      } catch {}
    };

    const process = new CommandSessionProcess(
      this.shell.pid,
      null,
      stdout,
      stderr,
      exitCodeResolver.promise,
      killFn
    );

    const pending: PendingOperation = {
      kind: 'exec',
      id,
      stdoutController,
      stderrController,
      exitCode: exitCodeResolver
    };

    if (options.timeoutMs !== undefined) {
      pending.timeout = setTimeout(() => {
        const error = new Error(`Timed out waiting for command ${id}`);
        this.fail(error);
        void this.cleanupResources();
      }, options.timeoutMs);
    }
    this.pending = pending;

    await this.writeShell(`__sandbox_sessions_exec ${id} ${encodedCommand}\n`);
    return process;
  }

  private async startProcessNow(
    command: string,
    options: CommandSessionStartProcessOptions
  ): Promise<CommandSessionProcess> {
    this.assertReadyForOperation();
    if (options.signal?.aborted) {
      throw new Error('Process start aborted');
    }

    const id = crypto.randomUUID().replaceAll('-', '');
    const encodedCommand = Buffer.from(
      buildScopedCommand(command, options)
    ).toString('base64');
    const process = new Promise<CommandSessionProcess>((resolve, reject) => {
      this.pending = {
        kind: 'startProcess',
        id,
        timeoutMs: options.timeoutMs,
        abortSignal: options.signal,
        onOutput: options.onOutput,
        resolve,
        reject
      };
    });

    await this.writeShell(
      `__sandbox_sessions_start_process ${id} ${encodedCommand}\n`
    );
    return process;
  }

  private assertReadyForOperation(): void {
    if (this.state === 'closed' || this.state === 'closing') {
      throw new Error('Command session is closed');
    }
    if (this.failure) {
      throw this.failure;
    }
    if (this.state !== 'ready') {
      throw new Error(`Command session is ${this.state}`);
    }
    if (this.pending) {
      throw new Error('Command session already has a pending operation');
    }
  }

  private async writeShell(data: string): Promise<void> {
    await this.stdin.write(data);
  }

  private async readFrames(): Promise<void> {
    const stdout = this.shell.stdout;
    if (!stdout || typeof stdout === 'number') {
      this.fail(new Error('Command session shell stdout is not available'));
      return;
    }

    const reader = stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        this.outputBuffer += decoder.decode(value, { stream: true });
        this.processFrameLines();
      }
      this.outputBuffer += decoder.decode();
      this.processFrameLines();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail(new Error(`Command session frame reader failed: ${message}`));
    } finally {
      reader.releaseLock();
    }
  }

  private processFrameLines(): void {
    while (true) {
      const newlineIndex = this.outputBuffer.indexOf('\n');
      if (newlineIndex < 0) {
        return;
      }
      const line = this.outputBuffer.slice(0, newlineIndex);
      this.outputBuffer = this.outputBuffer.slice(newlineIndex + 1);
      this.handleFrameLine(line);
    }
  }

  private handleFrameLine(line: string): void {
    if (!line.startsWith(`${FRAME_PREFIX}|`)) {
      return;
    }

    const [, type, id, field, stdoutPayload = '', stderrPayload = ''] =
      line.split('|');
    if (type === 'READY') {
      if (this.state === 'starting') {
        this.state = 'ready';
        this.ready.resolve();
      }
      return;
    }

    if (type === 'PROCESS_OUTPUT') {
      this.recordProcessOutput(id, field, stdoutPayload);
      return;
    }

    if (type === 'PROCESS_DONE') {
      this.resolveProcess(id, field);
      return;
    }

    if (!this.pending || this.pending.id !== id) {
      return;
    }

    if (type === 'DONE' && this.pending.kind === 'exec') {
      const pending = this.pending;
      this.pending = undefined;
      this.cleanupPending(pending);
      void this.resolveExecResult(pending, id, field);
      return;
    }

    if (type === 'PROCESS_STARTED' && this.pending.kind === 'startProcess') {
      const pending = this.pending;
      this.pending = undefined;
      const pid = parsePID(field);

      let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          stdoutController = controller;
        }
      });

      let stderrController!: ReadableStreamDefaultController<Uint8Array>;
      const stderr = new ReadableStream<Uint8Array>({
        start(controller) {
          stderrController = controller;
        }
      });

      const exitCodeResolver = Promise.withResolvers<number>();
      // Guard against unhandled rejection for background processes
      exitCodeResolver.promise.catch(() => {});

      const killFn = async (signal?: number) => {
        const sigName = signal === 9 ? 'SIGKILL' : 'SIGTERM';
        await killProcessTree(pid, sigName);
      };

      const process = new CommandSessionProcess(
        pid,
        null,
        stdout,
        stderr,
        exitCodeResolver.promise,
        killFn
      );
      backgroundProcesses.add(process);

      const processCompletion: ProcessCompletion = {
        pid,
        stdoutController,
        stderrController,
        exitCode: exitCodeResolver,
        nextSeq: 0,
        onOutput: pending.onOutput,
        abortSignal: pending.abortSignal
      };

      if (pending.timeoutMs !== undefined) {
        processCompletion.timeout = setTimeout(() => {
          void terminateProcessTree(pid, PROCESS_TIMEOUT_GRACE_MS);
        }, pending.timeoutMs);
      }
      if (pending.abortSignal) {
        processCompletion.abortListener = () => {
          void terminateProcessTree(pid, PROCESS_TIMEOUT_GRACE_MS);
        };
        pending.abortSignal.addEventListener(
          'abort',
          processCompletion.abortListener,
          { once: true }
        );
      }
      this.processes.set(id, processCompletion);
      if (pending.abortSignal?.aborted) {
        void terminateProcessTree(pid, PROCESS_TIMEOUT_GRACE_MS);
      }
      pending.resolve(process);
    }
  }

  private recordProcessOutput(
    id: string,
    stream: string,
    payload: string
  ): void {
    const process = this.processes.get(id);
    if (!process || (stream !== 'stdout' && stream !== 'stderr')) {
      return;
    }

    const data = decodePayload(payload);
    if (data.length === 0) {
      return;
    }

    const chunk: StdioChunk = {
      stream,
      data,
      seq: process.nextSeq++
    };

    const encoder = new TextEncoder();
    const bytes = encoder.encode(data);
    if (stream === 'stdout' && process.stdoutController) {
      try {
        process.stdoutController.enqueue(bytes);
      } catch {}
    } else if (stream === 'stderr' && process.stderrController) {
      try {
        process.stderrController.enqueue(bytes);
      } catch {}
    }

    try {
      process.onOutput?.(chunk);
    } catch (error) {
      this.rejectProcess(id, toError(error));
    }
  }

  private resolveProcess(id: string, exitCode: string): void {
    const process = this.processes.get(id);
    if (!process) {
      return;
    }
    this.processes.delete(id);
    this.cleanupProcess(process);
    const parsedExitCode = Number.parseInt(exitCode, 10);
    const code = Number.isNaN(parsedExitCode) ? 1 : parsedExitCode;

    try {
      process.stdoutController?.close();
    } catch {}
    try {
      process.stderrController?.close();
    } catch {}

    process.exitCode.resolve(code);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    if (this.state !== 'closing' && this.state !== 'closed') {
      this.state = 'failed';
    }
    this.ready.reject(error);
    this.rejectPending(error);
    void this.terminateProcesses(error);
  }

  private rejectPending(error: Error): void {
    if (!this.pending) {
      return;
    }
    const pending = this.pending;
    this.pending = undefined;
    this.cleanupPending(pending);
    if (pending.kind === 'exec') {
      try {
        pending.stdoutController.error(error);
      } catch {}
      try {
        pending.stderrController.error(error);
      } catch {}
      pending.exitCode.reject(error);
    } else {
      pending.reject(error);
    }
  }

  private rejectProcess(id: string, error: Error): void {
    const process = this.processes.get(id);
    if (!process) {
      return;
    }
    this.processes.delete(id);
    this.cleanupProcess(process);
    try {
      process.stdoutController?.error(error);
    } catch {}
    try {
      process.stderrController?.error(error);
    } catch {}
    process.exitCode.reject(error);
  }

  private async terminateProcesses(error: Error): Promise<void> {
    const entries = [...this.processes.entries()];
    await Promise.all(
      entries.map(([, process]) =>
        terminateProcessTree(process.pid, PROCESS_TIMEOUT_GRACE_MS)
      )
    );
    for (const [id, process] of entries) {
      if (this.processes.get(id) === process) {
        this.processes.delete(id);
        this.cleanupProcess(process);
        try {
          process.stdoutController?.error(error);
        } catch {}
        try {
          process.stderrController?.error(error);
        } catch {}
        process.exitCode.reject(error);
      }
    }
  }

  private cleanupProcess(process: ProcessCompletion): void {
    if (process.timeout) {
      clearTimeout(process.timeout);
    }
    if (process.abortSignal && process.abortListener) {
      process.abortSignal.removeEventListener('abort', process.abortListener);
    }
  }

  private async resolveExecResult(
    pending: Extract<PendingOperation, { kind: 'exec' }>,
    id: string,
    exitCode: string
  ): Promise<void> {
    const stdoutFile = join(this.tempDir, `${id}.stdout`);
    const stderrFile = join(this.tempDir, `${id}.stderr`);
    try {
      const stdoutText = await Bun.file(stdoutFile).text();
      const stderrText = await Bun.file(stderrFile).text();

      const encoder = new TextEncoder();
      if (stdoutText.length > 0) {
        pending.stdoutController.enqueue(encoder.encode(stdoutText));
      }
      if (stderrText.length > 0) {
        pending.stderrController.enqueue(encoder.encode(stderrText));
      }

      pending.stdoutController.close();
      pending.stderrController.close();

      const code = parseExitCode(exitCode);
      pending.exitCode.resolve(code);
    } catch (error) {
      const err = toError(error);
      try {
        pending.stdoutController.error(err);
      } catch {}
      try {
        pending.stderrController.error(err);
      } catch {}
      pending.exitCode.reject(err);
    } finally {
      await Promise.all([
        rm(stdoutFile, { force: true }),
        rm(stderrFile, { force: true })
      ]).catch(() => {});
    }
  }

  private cleanupPending(pending: PendingOperation): void {
    if (pending.kind === 'exec' && pending.timeout) {
      clearTimeout(pending.timeout);
    }
  }

  private cleanupResources(): Promise<void> {
    this.cleanupPromise ??= this.cleanupResourcesOnce();
    return this.cleanupPromise;
  }

  private async cleanupResourcesOnce(): Promise<void> {
    try {
      await this.stdin.write('exit\n');
    } catch {}
    try {
      this.stdin.end?.();
    } catch {}
    try {
      this.shell.kill('SIGTERM');
    } catch {}
    await Promise.race([this.shell.exited, Bun.sleep(500)]);
    await rm(this.tempDir, { force: true, recursive: true });
    this.state = this.failure ? 'failed' : 'closed';
  }
}

function parseExitCode(exitCode: string): number {
  const parsedExitCode = Number.parseInt(exitCode, 10);
  return Number.isNaN(parsedExitCode) ? 1 : parsedExitCode;
}

function decodePayload(payload: string): string {
  return Buffer.from(payload, 'base64').toString();
}

function parsePID(pid: string): number {
  const parsedPID = Number.parseInt(pid, 10);
  if (!Number.isInteger(parsedPID) || parsedPID <= 0) {
    throw new Error(`Invalid process PID ${pid}`);
  }
  return parsedPID;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function buildScopedCommand(
  command: string,
  options: CommandSessionExecOptions
): string {
  const setup: string[] = [];
  const cleanup: string[] = [];

  if (options.cwd) {
    setup.push('__sandbox_exec_prev_dir=$(pwd)');
    setup.push(`cd ${shellQuote(options.cwd)} || __sandbox_exec_status=$?`);
    cleanup.push('cd "$__sandbox_exec_prev_dir" >/dev/null 2>&1 || true');
    cleanup.push('unset __sandbox_exec_prev_dir');
  }

  let index = 0;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }

    const saved = `__sandbox_exec_saved_${index}`;
    const had = `__sandbox_exec_had_${index}`;
    setup.push(`${had}=0`);
    setup.push(`if declare -p ${key} >/dev/null 2>&1; then`);
    setup.push(`  ${had}=1`);
    setup.push(`  ${saved}=$(declare -p ${key})`);
    setup.push('fi');
    setup.push(`export ${key}=${shellQuote(value)}`);
    cleanup.push(`if [[ $${had} -eq 1 ]]; then`);
    cleanup.push(`  eval "$${saved}"`);
    cleanup.push('else');
    cleanup.push(`  unset ${key}`);
    cleanup.push('fi');
    cleanup.push(`unset ${saved} ${had}`);
    index++;
  }

  if (setup.length === 0 && cleanup.length === 0) {
    return command;
  }

  return [
    '{',
    '  __sandbox_exec_status=0',
    ...setup.map((line) => `  ${line}`),
    '  if [[ $__sandbox_exec_status -eq 0 ]]; then',
    '    {',
    indentFirstLine(command, 6),
    '      __sandbox_exec_status=$?',
    '    }',
    '  fi',
    ...cleanup.map((line) => `  ${line}`),
    '  ( exit "$__sandbox_exec_status" )',
    '}'
  ].join('\n');
}

function indentFirstLine(command: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  const lines = command.split('\n');
  return lines.length === 1
    ? `${prefix}${command}`
    : `${prefix}${lines[0]}\n${lines.slice(1).join('\n')}`;
}

function argvToShellCommand(argv: string[]): string {
  return argv.map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function resolveStartupCwd(cwd?: string): Promise<string | undefined> {
  if (!cwd) {
    return undefined;
  }

  try {
    await access(cwd);
    return cwd;
  } catch {
    return process.env.HOME;
  }
}

async function terminateProcessTree(
  rootPID: number,
  graceMs: number
): Promise<void> {
  await killProcessTree(rootPID, 'SIGTERM');
  await Bun.sleep(graceMs);
  await killProcessTree(rootPID, 'SIGKILL');
}

async function killProcessTree(
  rootPID: number,
  signal: NodeJS.Signals
): Promise<void> {
  const descendants = await listDescendantPIDs(rootPID);
  for (const pid of descendants.reverse()) {
    killPID(pid, signal);
  }
  killPID(rootPID, signal);
}

async function listDescendantPIDs(rootPID: number): Promise<number[]> {
  const children = await listChildPIDs(rootPID);
  const descendants: number[] = [];
  for (const child of children) {
    descendants.push(child, ...(await listDescendantPIDs(child)));
  }
  return descendants;
}

async function listChildPIDs(parentPID: number): Promise<number[]> {
  const ps = Bun.spawn(['ps', '-o', 'pid=', '--ppid', String(parentPID)], {
    stdout: 'pipe',
    stderr: 'ignore'
  });
  const output = ps.stdout ? await new Response(ps.stdout).text() : '';
  await ps.exited;
  return output
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function killPID(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {}
}

function getShellStdin(shell: Bun.Subprocess): StdinWriter {
  const stdin = shell.stdin;
  if (!stdin || typeof stdin === 'number' || !('write' in stdin)) {
    throw new Error('Command session shell stdin is not writable');
  }
  return stdin;
}
