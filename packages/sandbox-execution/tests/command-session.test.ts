import { describe, expect, it } from 'bun:test';
import { CommandSession, type CommandSessionProcess } from '../src/index';

async function getProcessText(process: CommandSessionProcess) {
  const out = await process.output();
  return {
    exitCode: out.exitCode,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr)
  };
}

describe('CommandSession', () => {
  it('returns a process-like handle for stateful string commands', async () => {
    await using session = await CommandSession.create({ cwd: '/workspace' });

    const cd = await session.exec('cd /tmp');
    expect(await cd.exitCode).toBe(0);

    const pwd = await session.exec('pwd');
    const output = await pwd.output();

    expect(new TextDecoder().decode(output.stdout).trim()).toBe('/tmp');
    expect(output.exitCode).toBe(0);
  });

  it('runs argv commands from session cwd without mutating parent session', async () => {
    await using session = await CommandSession.create({ cwd: '/workspace' });

    expect(await (await session.exec('cd /tmp')).exitCode).toBe(0);

    const argvPwd = await session.exec(['pwd']);
    const argvOutput = await argvPwd.output();
    expect(new TextDecoder().decode(argvOutput.stdout).trim()).toBe('/tmp');

    const argvMutation = await session.exec([
      '/bin/bash',
      '-lc',
      'cd /workspace'
    ]);
    expect(await argvMutation.exitCode).toBe(0);

    const parentPwd = await session.exec('pwd');
    const parentOutput = await parentPwd.output();
    expect(new TextDecoder().decode(parentOutput.stdout).trim()).toBe('/tmp');
  });

  it('streams stdout from session string commands', async () => {
    await using session = await CommandSession.create({ cwd: '/workspace' });

    const process = await session.exec("printf 'a'; printf 'b'");
    const text = await new Response(process.stdout).text();

    expect(text).toBe('ab');
    expect(await process.exitCode).toBe(0);
  });

  it('preserves aliases across commands', async () => {
    await using session = await CommandSession.create();

    const defineAlias = await session.exec(
      String.raw`alias say_ok='printf "alias-ok\n"'`
    );
    expect(await defineAlias.exitCode).toBe(0);

    const useAlias = await session.exec('say_ok');
    const res = await getProcessText(useAlias);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('alias-ok\n');
  });

  it('preserves shell functions across commands', async () => {
    await using session = await CommandSession.create();

    const defineFunction = await session.exec(
      String.raw`say_func() { printf "func:%s\n" "$1"; }`
    );
    expect(await defineFunction.exitCode).toBe(0);

    const useFunction = await session.exec('say_func ok');
    const res = await getProcessText(useFunction);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('func:ok\n');
  });

  it('applies per-command cwd without mutating session cwd', async () => {
    await using session = await CommandSession.create();

    const scoped = await session.exec('pwd', { cwd: '/tmp' });
    const persisted = await session.exec('pwd');

    const resScoped = await getProcessText(scoped);
    const resPersisted = await getProcessText(persisted);

    expect(resScoped.exitCode).toBe(0);
    expect(resScoped.stdout.trim()).toBe('/tmp');
    expect(resPersisted.exitCode).toBe(0);
    expect(resPersisted.stdout.trim()).toBe('/workspace');
  });

  it('applies per-command env without mutating session env', async () => {
    await using session = await CommandSession.create();

    const scoped = await session.exec('printf "$SCOPED_ENV"', {
      env: { SCOPED_ENV: 'from-call' }
    });
    const persisted = await session.exec('printf "$SCOPED_ENV"');

    const resScoped = await getProcessText(scoped);
    const resPersisted = await getProcessText(persisted);

    expect(resScoped.exitCode).toBe(0);
    expect(resScoped.stdout).toBe('from-call');
    expect(resPersisted.exitCode).toBe(0);
    expect(resPersisted.stdout).toBe('');
  });

  it('kills a running process and keeps the session usable', async () => {
    await using session = await CommandSession.create();

    const process = await session.exec(['sleep', '10']);
    await process.kill();

    const res = await getProcessText(process);
    expect(res.exitCode).not.toBe(0);

    const afterKill = await session.exec("printf 'session-alive\n'");
    const resAfter = await getProcessText(afterKill);
    expect(resAfter.exitCode).toBe(0);
    expect(resAfter.stdout).toBe('session-alive\n');
  });

  it('fails the session if a stateful string command times out', async () => {
    await using session = await CommandSession.create();
    const process = await session.exec('sleep 2', { timeoutMs: 50 });
    await expect(process.exitCode).rejects.toThrow(
      'Timed out waiting for command'
    );
    expect(session.isReady()).toBe(false);
  });

  it('marks the session failed if the underlying shell exits', async () => {
    await using session = await CommandSession.create();
    const process = await session.exec('exit 42');
    await expect(process.exitCode).rejects.toThrow(
      'Command session shell exited with code 42'
    );
    expect(session.isReady()).toBe(false);
    await expect(session.exec('echo test')).rejects.toThrow(
      'Command session shell exited with code 42'
    );
  });

  it('aborts a background process and reaps descendants when its abort signal is triggered', async () => {
    await using session = await CommandSession.create();
    const controller = new AbortController();
    let childPid = 0;
    const proc = await session.exec(
      ['bash', '-c', 'sleep 100 & echo "PID:$!"; wait'],
      {
        signal: controller.signal,
        onOutput: (chunk) => {
          const match = chunk.data.match(/PID:(\d+)/);
          if (match) {
            childPid = Number.parseInt(match[1], 10);
          }
        }
      }
    );

    // Wait until the child PID is captured
    for (let i = 0; i < 100 && childPid === 0; i++) {
      await Bun.sleep(20);
    }
    expect(childPid).toBeGreaterThan(0);

    // Verify descendant is alive
    let aliveBefore = false;
    try {
      process.kill(childPid, 0);
      aliveBefore = true;
    } catch {}
    expect(aliveBefore).toBe(true);

    controller.abort();

    const res = await getProcessText(proc);
    expect(res.exitCode).not.toBe(0);

    // Verify descendant is reaped
    let aliveAfter = true;
    try {
      process.kill(childPid, 0);
      aliveAfter = true;
    } catch {
      aliveAfter = false;
    }
    expect(aliveAfter).toBe(false);
  });

  it('kills a background process and descendants on timeoutMs', async () => {
    await using session = await CommandSession.create();
    const process = await session.exec(['sleep', '10'], { timeoutMs: 50 });
    const res = await getProcessText(process);
    expect(res.exitCode).not.toBe(0);
  });

  it('handles invalid per-command cwd and returns non-zero exit code', async () => {
    await using session = await CommandSession.create();
    const process = await session.exec('pwd', {
      cwd: '/nonexistent-directory'
    });
    const res = await getProcessText(process);
    expect(res.exitCode).not.toBe(0);
  });
});
