import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv, createMockSandbox, parseSSE, sandboxUrl } from './helpers';

const mockSandbox = createMockSandbox();
vi.mock('../../../../packages/sandbox/src/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
  Sandbox: class {}
}));

const { app } = await import('./bridge-app');

const env = createMockEnv();

function execRequest(body: Record<string, unknown>) {
  return app.request(
    sandboxUrl('test', 'exec'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    },
    env
  );
}

describe('POST /sandbox/:id/exec — SSE streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('streams stdout chunks as base64 SSE events', async () => {
    mockSandbox.exec.mockResolvedValue({
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello world'));
          controller.close();
        }
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        }
      }),
      exitCode: Promise.resolve(0),
      output: async () => ({
        stdout: new TextEncoder().encode('hello world'),
        stderr: new Uint8Array(),
        exitCode: 0
      })
    });

    const res = await execRequest({ argv: ['echo', 'hello world'] });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const text = await res.text();
    const events = parseSSE(text);

    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('stdout');
    expect(atob(events[0].data)).toBe('hello world');
    expect(events[1].event).toBe('exit');
    expect(JSON.parse(events[1].data)).toEqual({ exit_code: 0 });
  });

  it('streams stderr chunks as base64 SSE events', async () => {
    mockSandbox.exec.mockResolvedValue({
      stdout: new ReadableStream({
        start(controller) {
          controller.close();
        }
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('oh no'));
          controller.close();
        }
      }),
      exitCode: Promise.resolve(1),
      output: async () => ({
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode('oh no'),
        exitCode: 1
      })
    });

    const res = await execRequest({ argv: ['fail'] });
    const text = await res.text();
    const events = parseSSE(text);

    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('stderr');
    expect(atob(events[0].data)).toBe('oh no');
    expect(events[1].event).toBe('exit');
    expect(JSON.parse(events[1].data)).toEqual({ exit_code: 1 });
  });

  it('sends exit event with correct exit code', async () => {
    mockSandbox.exec.mockResolvedValue({
      stdout: new ReadableStream({
        start(c) {
          c.close();
        }
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        }
      }),
      exitCode: Promise.resolve(42),
      output: async () => ({
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        exitCode: 42
      })
    });

    const res = await execRequest({ argv: ['exit', '42'] });
    const text = await res.text();
    const events = parseSSE(text);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('exit');
    expect(JSON.parse(events[0].data)).toEqual({ exit_code: 42 });
  });

  it('sends error event when exitCode rejects', async () => {
    mockSandbox.exec.mockResolvedValue({
      stdout: new ReadableStream({
        start(c) {
          c.close();
        }
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        }
      }),
      exitCode: Promise.reject(new Error('command not found')),
      output: async () => {
        throw new Error('command not found');
      }
    });

    const res = await execRequest({ argv: ['bad-cmd'] });
    const text = await res.text();
    const events = parseSSE(text);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('error');
    const data = JSON.parse(events[0].data);
    expect(data.error).toBe('command not found');
    expect(data.code).toBe('exec_error');
  });

  it('sends error event when exec promise rejects (belt-and-suspenders)', async () => {
    mockSandbox.exec.mockRejectedValue(new Error('connection lost'));

    const res = await execRequest({ argv: ['echo', 'hi'] });
    expect(res.status).toBe(200); // stream already started
    const text = await res.text();
    const events = parseSSE(text);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('error');
    const data = JSON.parse(events[0].data);
    expect(data.error).toContain('connection lost');
    expect(data.code).toBe('exec_transport_error');
  });

  it('streams multiple stdout and stderr chunks interleaved', async () => {
    mockSandbox.exec.mockResolvedValue({
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('line1'));
          controller.enqueue(new TextEncoder().encode('line2'));
          controller.close();
        }
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('warn1'));
          controller.close();
        }
      }),
      exitCode: Promise.resolve(0),
      output: async () => ({
        stdout: new TextEncoder().encode('line1line2'),
        stderr: new TextEncoder().encode('warn1'),
        exitCode: 0
      })
    });

    const res = await execRequest({ argv: ['mixed'] });
    const text = await res.text();
    const events = parseSSE(text);

    expect(events).toHaveLength(4);
    // Note: because stdout and stderr stream reading are concurrent, the exact interleaved order can be:
    // e.g. line1, warn1, line2, exit (or similar). Let's verify events contain the expected items.
    const eventNames = events.map((e) => e.event);
    expect(eventNames).toContain('stdout');
    expect(eventNames).toContain('stderr');
    expect(eventNames[3]).toBe('exit');
  });
});

describe('POST /sandbox/:id/exec — pre-validation errors (JSON)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 for invalid JSON body', async () => {
    const res = await app.request(
      sandboxUrl('test', 'exec'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json'
      },
      env
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('invalid_request');
  });

  it('returns 400 for empty argv', async () => {
    const res = await execRequest({ argv: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain('argv must be a non-empty array');
  });

  it('returns 400 for missing argv', async () => {
    const res = await execRequest({});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain('argv must be a non-empty array');
  });

  it('returns 403 for cwd outside /workspace', async () => {
    const res = await execRequest({ argv: ['ls'], cwd: '/tmp' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('invalid_request');
  });

  it('returns 403 for cwd with path traversal', async () => {
    const res = await execRequest({ argv: ['ls'], cwd: '/workspace/../../etc' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain('cwd must resolve to a location within /workspace');
  });
});

describe('POST /sandbox/:id/exec — cwd validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.exec.mockResolvedValue({
      stdout: new ReadableStream({
        start(c) {
          c.close();
        }
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        }
      }),
      exitCode: Promise.resolve(0),
      output: async () => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 0 })
    });
  });

  it('passes through when no cwd is provided', async () => {
    const res = await execRequest({ argv: ['echo', 'hello'] });
    expect(res.status).toBe(200);
    expect(mockSandbox.exec).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = mockSandbox.exec.mock.calls[0] as any[];
    const opts = call[1] as Record<string, unknown> | undefined;
    expect(opts?.cwd).toBeUndefined();
  });

  it('allows cwd within /workspace', async () => {
    const res = await execRequest({ argv: ['ls'], cwd: '/workspace/src' });
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = mockSandbox.exec.mock.calls[0] as any[];
    const opts = call[1] as Record<string, unknown>;
    expect(opts.cwd).toBe('/workspace/src');
  });

  it('rejects cwd with path traversal escaping /workspace', async () => {
    const res = await execRequest({ argv: ['ls'], cwd: '/workspace/../../etc' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain('cwd must resolve to a location within /workspace');
  });

  it('rejects cwd pointing outside /workspace entirely', async () => {
    const res = await execRequest({ argv: ['ls'], cwd: '/tmp' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('invalid_request');
  });

  it('resolves a relative cwd against /workspace', async () => {
    const res = await execRequest({ argv: ['ls'], cwd: 'src' });
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = mockSandbox.exec.mock.calls[0] as any[];
    const opts = call[1] as Record<string, unknown>;
    expect(opts.cwd).toBe('/workspace/src');
  });
});

describe('POST /sandbox/:id/exec — argv to command string quoting', () => {
  /** Helper: capture the command string passed to sandbox.exec(). */
  function capturedCommand(): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = mockSandbox.exec.mock.calls[0] as any[];
    return call[0] as string;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.exec.mockResolvedValue({
      stdout: new ReadableStream({
        start(c) {
          c.close();
        }
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        }
      }),
      exitCode: Promise.resolve(0),
      output: async () => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 0 })
    });
  });

  it('passes safe tokens unquoted', async () => {
    await execRequest({ argv: ['echo', 'hello'] });
    expect(capturedCommand()).toBe('echo hello');
  });

  it("quotes tokens with spaces using $'...'", async () => {
    await execRequest({ argv: ['echo', 'hello world'] });
    expect(capturedCommand()).toBe("echo $'hello world'");
  });

  it('quotes tokens with single quotes', async () => {
    await execRequest({ argv: ['echo', "it's"] });
    expect(capturedCommand()).toBe("echo $'it\\'s'");
  });

  it('quotes tokens with double quotes', async () => {
    await execRequest({ argv: ['echo', 'say "hi"'] });
    expect(capturedCommand()).toBe('echo $\'say "hi"\'');
  });

  it('escapes newlines in argv values', async () => {
    await execRequest({ argv: ['printf', 'line1\nline2'] });
    expect(capturedCommand()).toBe("printf $'line1\\nline2'");
    expect(capturedCommand()).not.toContain('\n');
  });

  it('escapes carriage returns in argv values', async () => {
    await execRequest({ argv: ['printf', 'a\rb'] });
    expect(capturedCommand()).toBe("printf $'a\\rb'");
  });

  it('escapes tabs in argv values', async () => {
    await execRequest({ argv: ['printf', 'a\tb'] });
    expect(capturedCommand()).toBe("printf $'a\\tb'");
  });

  it('escapes backslashes in argv values', async () => {
    await execRequest({ argv: ['echo', 'a\\b'] });
    expect(capturedCommand()).toBe("echo $'a\\\\b'");
  });

  it('quotes dollar signs to prevent variable expansion', async () => {
    await execRequest({ argv: ['echo', '$dollar'] });
    expect(capturedCommand()).toBe("echo $'$dollar'");
  });

  it('quotes shell metacharacters (semicolons, pipes, ampersands)', async () => {
    await execRequest({ argv: ['echo', 'a;b', 'c|d', 'e&f'] });
    expect(capturedCommand()).toBe("echo $'a;b' $'c|d' $'e&f'");
  });

  it('quotes backticks and command substitution', async () => {
    await execRequest({ argv: ['echo', '`whoami`', '$(id)'] });
    expect(capturedCommand()).toBe("echo $'`whoami`' $'$(id)'");
  });

  // Mirrors test_cloudflare_exec_applies_manifest_environment from the OpenAI SDK
  it('handles env-prefixed argv (env KEY=VALUE command)', async () => {
    await execRequest({ argv: ['env', 'A=1', 'B=two', 'printenv', 'A'] });
    expect(capturedCommand()).toBe('env A=1 B=two printenv A');
  });

  // Mirrors test_cloudflare_exec_quotes_argv_for_worker from the OpenAI SDK
  it('handles mixed special characters matching OpenAI SDK test vectors', async () => {
    await execRequest({
      argv: ['sh', '-c', 'printf argv-ok', 'argv-test', 'space value', '$dollar', 'quote\'"value', 'line\nbreak']
    });
    const cmd = capturedCommand();
    // No literal newlines in the command string
    expect(cmd).not.toContain('\n');
    // Each token is properly represented
    expect(cmd).toContain('sh');
    expect(cmd).toContain('-c');
    expect(cmd).toContain("$'printf argv-ok'");
    expect(cmd).toContain('argv-test');
    expect(cmd).toContain("$'space value'");
    expect(cmd).toContain("$'$dollar'");
    expect(cmd).toContain("$'quote\\'\"value'");
    expect(cmd).toContain("$'line\\nbreak'");
  });
});
