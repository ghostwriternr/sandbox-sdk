import { RpcTarget } from 'cloudflare:workers';
import type { ExecOutput, WaitForPortOptions } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import { createSandboxProcess } from '../../src/execution/sandbox-process';

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}

describe('createSandboxProcess', () => {
  it('returns a Workers RPC target', () => {
    const process = createSandboxProcess({
      pid: 321,
      stdin: null,
      stdout: null,
      stderr: null,
      exitCode: Promise.resolve(0),
      kill: vi.fn(),
      waitForPort: vi.fn()
    });

    expect(process).toBeInstanceOf(RpcTarget);
  });

  it('exposes process properties and delegates kill', async () => {
    const kill = vi.fn();
    const waitForPort = vi.fn<
      (
        port: number,
        options: WaitForPortOptions | undefined,
        exitCode: Promise<number>
      ) => Promise<void>
    >(() => Promise.resolve());

    const process = createSandboxProcess({
      pid: 123,
      stdin: null,
      stdout: streamFromText('out'),
      stderr: streamFromText('err'),
      exitCode: Promise.resolve(0),
      kill,
      waitForPort
    });

    expect(process.pid).toBe(123);
    process.kill(15);
    expect(kill).toHaveBeenCalledWith(15);

    const output = await process.output();
    expect(new TextDecoder().decode(output.stdout)).toBe('out');
    expect(new TextDecoder().decode(output.stderr)).toBe('err');
    expect(output.exitCode).toBe(0);
  });

  it('normalizes source output to a plain object', async () => {
    class NativeOutput implements ExecOutput {
      stdout = new TextEncoder().encode('native out').buffer;
      stderr = new TextEncoder().encode('native err').buffer;
      exitCode = 0;
    }

    const nativeOutput = new NativeOutput();
    const process = createSandboxProcess({
      pid: 654,
      stdin: null,
      stdout: null,
      stderr: null,
      exitCode: Promise.resolve(0),
      output: () => Promise.resolve(nativeOutput),
      kill: vi.fn(),
      waitForPort: vi.fn()
    });

    const output = await process.output();
    expect(output).not.toBe(nativeOutput);
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(new TextDecoder().decode(output.stdout)).toBe('native out');
    expect(new TextDecoder().decode(output.stderr)).toBe('native err');
    expect(output.exitCode).toBe(0);
  });

  it('rejects repeated output reads', async () => {
    const process = createSandboxProcess({
      pid: 789,
      stdin: null,
      stdout: streamFromText('out'),
      stderr: streamFromText(''),
      exitCode: Promise.resolve(0),
      kill: vi.fn(),
      waitForPort: vi.fn()
    });

    await process.output();
    await expect(process.output()).rejects.toThrow(
      'output() can only be called once.'
    );
  });

  it('delegates waitForPort with the process exitCode promise', async () => {
    const waitForPort = vi.fn<
      (
        port: number,
        options: WaitForPortOptions | undefined,
        exitCode: Promise<number>
      ) => Promise<void>
    >(() => Promise.resolve());
    const exitCode = Promise.resolve(0);

    const process = createSandboxProcess({
      pid: 456,
      stdin: null,
      stdout: null,
      stderr: null,
      exitCode,
      kill: vi.fn(),
      waitForPort
    });

    await process.waitForPort(3000, { timeout: 1000 });
    expect(waitForPort).toHaveBeenCalledWith(3000, { timeout: 1000 }, exitCode);
  });
});
