export interface NativeExecOutput {
  readonly stdout: ArrayBuffer;
  readonly stderr: ArrayBuffer;
  readonly exitCode: number;
}

export interface NativeExecProcess {
  readonly stdin: WritableStream<Uint8Array> | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly pid: number;
  readonly exitCode: Promise<number>;
  output(): Promise<NativeExecOutput>;
  kill(signal?: number): void;
}

export interface NativeContainerExecOptions {
  stdin?: ReadableStream<Uint8Array> | 'pipe';
  stdout?: 'pipe' | 'ignore';
  stderr?: 'pipe' | 'ignore' | 'combined';
  cwd?: string;
  env?: Record<string, string>;
  user?: string;
}

export interface NativeContainerWithExec {
  readonly running: boolean;
  exec(
    command: string[],
    options?: NativeContainerExecOptions
  ): Promise<NativeExecProcess>;
}

export function getNativeContainerExec(
  container: unknown
): NativeContainerWithExec {
  if (
    !container ||
    typeof container !== 'object' ||
    typeof (container as { exec?: unknown }).exec !== 'function'
  ) {
    throw new Error(
      'Native container exec is not available in this Workers runtime. Use a compatibility date and runtime that support ctx.container.exec().'
    );
  }

  return container as NativeContainerWithExec;
}

export function normalizeNativeEnv(
  env?: Record<string, string | undefined>
): Record<string, string> | undefined {
  if (!env) return undefined;

  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}
