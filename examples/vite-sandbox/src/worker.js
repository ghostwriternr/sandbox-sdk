import { getSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

const VITE_PORT = 5173;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/sandbox') {
      return handleAPISandboxRoute(env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

async function handleAPISandboxRoute(env) {
  const sandbox = getSandbox(env.Sandbox, 'vite-sandbox');

  // Check if the port is already listening before spawning
  const checkPort = await sandbox.exec(`nc -z 127.0.0.1 ${VITE_PORT}`);
  const checkResult = await checkPort.output();
  if (checkResult.exitCode !== 0) {
    const proc = await sandbox.exec('npm run dev', {
      cwd: '/app',
      env: {
        VITE_PORT: `${VITE_PORT}`
      }
    });
    await proc.waitForPort(VITE_PORT);
  }

  // Create a temporary dummy proc/handle to wait for port or just use sandbox.waitForPort?
  // Wait! Does Sandbox have a top-level waitForPort or similar? Let's check sandbox methods or if SandboxProcess has waitForPort.
  // Wait! In the original code, they did `const proc = await sandbox.exec('npm run dev', ...); await proc.waitForPort(VITE_PORT);`.
  // Since we might not have the proc if already running, wait, can we do `waitForPort`?
  // Let's check if Sandbox has `waitForPort` or we can just spawn a quick dummy or do we have a way to wait?
  // Actually, wait, let's check `packages/sandbox/src/sandbox.ts` to see if `waitForPort` is exposed on `sandbox`.
  // Let's search for "waitForPort" in packages/sandbox/src/sandbox.ts.

  try {
    const tunnel = await sandbox.tunnels.get(VITE_PORT);
    return Response.json({ url: tunnel.url });
  } catch (error) {
    // cloudflared tunnels don't work when WARP is running.
    if (
      error instanceof Error &&
      'errorResponse' in error &&
      error.errorResponse.code === 'TUNNEL_START_ERROR'
    ) {
      const detail =
        'Failed to create Cloudflare Tunnel. If you are running WARP please ensure it is disabled';
      console.error({ message: detail, error });
      return Response.json({ detail }, { status: 503 });
    }

    return Response.json({ detail: `${error}` }, { status: 500 });
  }
}
