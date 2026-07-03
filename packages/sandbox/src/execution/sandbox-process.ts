import { RpcTarget } from 'cloudflare:workers';
import type {
  ExecOutput,
  SandboxProcess,
  WaitForPortOptions
} from '@repo/shared';
import { readAllBytes } from './stream-utils';

export interface SandboxProcessSource {
  pid: number;
  stdin: WritableStream<Uint8Array> | null;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exitCode: Promise<number>;
  kill(signal?: number): void | Promise<void>;
  output?: () => Promise<ExecOutput>;
  waitForPort(
    port: number,
    options: WaitForPortOptions | undefined,
    exitCode: Promise<number>
  ): Promise<void>;
}

export class SandboxProcessImpl extends RpcTarget implements SandboxProcess {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array> | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exitCode: Promise<number>;

  #outputCalled = false;

  constructor(private readonly source: SandboxProcessSource) {
    super();
    this.pid = source.pid;
    this.stdin = source.stdin;
    this.stdout = source.stdout;
    this.stderr = source.stderr;
    this.exitCode = source.exitCode;
  }

  async output(): Promise<ExecOutput> {
    if (this.#outputCalled) {
      throw new TypeError('output() can only be called once.');
    }
    this.#outputCalled = true;

    if (this.source.output) {
      return plainExecOutput(await this.source.output());
    }

    const [stdout, stderr, exitCode] = await Promise.all([
      readAllBytes(this.stdout),
      readAllBytes(this.stderr),
      this.exitCode
    ]);

    return plainExecOutput({ stdout, stderr, exitCode });
  }

  kill(signal?: number): void | Promise<void> {
    return this.source.kill(signal);
  }

  waitForPort(port: number, options?: WaitForPortOptions): Promise<void> {
    return this.source.waitForPort(port, options, this.exitCode);
  }
}

function plainExecOutput(output: ExecOutput): ExecOutput {
  return {
    stdout: output.stdout,
    stderr: output.stderr,
    exitCode: output.exitCode
  };
}

export function createSandboxProcess(
  source: SandboxProcessSource
): SandboxProcess {
  return new SandboxProcessImpl(source);
}
