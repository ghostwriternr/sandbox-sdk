import type { Config } from '@opencode-ai/sdk/v2';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { createLogger, type Logger, type SandboxProcess } from '@repo/shared';
import type { Sandbox } from '../sandbox';
import type { OpencodeOptions, OpencodeResult, OpencodeServer } from './types';
import { OpencodeStartupError } from './types';

// Lazy logger creation to avoid global scope restrictions in Workers
function getLogger(): Logger {
  return createLogger({ component: 'sandbox-do', operation: 'opencode' });
}

const DEFAULT_PORT = 4096;
const OPENCODE_STARTUP_TIMEOUT_MS = 180_000;
const OPENCODE_SERVE = (port: number) =>
  `opencode serve --port ${port} --hostname 0.0.0.0`;

/**
 * Build the full command, optionally with a directory prefix.
 * If directory is provided, we cd to it first so OpenCode uses it as cwd.
 */
function buildOpencodeCommand(port: number, directory?: string): string {
  const serve = OPENCODE_SERVE(port);
  return directory ? `cd ${directory} && ${serve}` : serve;
}

type OpencodeClientFactory = (options: {
  baseUrl: string;
  fetch: typeof fetch;
  directory?: string;
}) => OpencodeClient;

// Dynamic import to handle peer dependency
let createOpencodeClient: OpencodeClientFactory | undefined;

async function ensureSdkLoaded(): Promise<void> {
  if (createOpencodeClient) return;

  try {
    const sdk = await import('@opencode-ai/sdk/v2/client');
    createOpencodeClient = sdk.createOpencodeClient as OpencodeClientFactory;
  } catch {
    throw new Error(
      '@opencode-ai/sdk is required for OpenCode integration. ' +
        'Install it with: npm install @opencode-ai/sdk'
    );
  }
}

/**
 * Internal function to start a new OpenCode server process.
 */
async function startOpencodeServer(
  sandbox: Sandbox<unknown>,
  port: number,
  directory?: string,
  config?: Config,
  customEnv?: Record<string, string>
): Promise<SandboxProcess> {
  // Check if port is already serving
  const checkPort = await sandbox.exec(`nc -z 127.0.0.1 ${port}`);
  const checkResult = await checkPort.output();
  if (checkResult.exitCode === 0) {
    getLogger().info('OpenCode server is already running', { port });
    return {
      stdin: null,
      stdout: null,
      stderr: null,
      pid: -1,
      exitCode: Promise.resolve(0),
      output: async () => ({
        stdout: new Uint8Array().buffer,
        stderr: new Uint8Array().buffer,
        exitCode: 0
      }),
      kill: async () => {},
      waitForPort: async () => {}
    };
  }

  getLogger().info('Starting OpenCode server', { port, directory });

  // Pass config via OPENCODE_CONFIG_CONTENT and also extract API keys to env vars
  // because OpenCode's provider auth looks for env vars like ANTHROPIC_API_KEY
  const env: Record<string, string> = {};

  if (config) {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);

    // Extract API keys from provider config
    // Support both options.apiKey (official type) and legacy top-level apiKey
    if (
      config.provider &&
      typeof config.provider === 'object' &&
      !Array.isArray(config.provider)
    ) {
      for (const [providerId, providerConfig] of Object.entries(
        config.provider
      )) {
        if (providerId === 'cloudflare-ai-gateway') {
          continue;
        }

        // Try options.apiKey first (official Config type)
        let apiKey = providerConfig?.options?.apiKey;
        // Fall back to top-level apiKey for convenience
        if (!apiKey) {
          apiKey = (providerConfig as Record<string, unknown> | undefined)
            ?.apiKey as string | undefined;
        }
        if (typeof apiKey === 'string') {
          const envVar = `${providerId.toUpperCase()}_API_KEY`;
          env[envVar] = apiKey;
        }
      }

      const aiGatewayConfig = config.provider['cloudflare-ai-gateway'];
      if (aiGatewayConfig?.options) {
        const options = aiGatewayConfig.options as Record<string, unknown>;

        if (typeof options.accountId === 'string') {
          env.CLOUDFLARE_ACCOUNT_ID = options.accountId;
        }

        if (typeof options.gatewayId === 'string') {
          env.CLOUDFLARE_GATEWAY_ID = options.gatewayId;
        }

        if (typeof options.apiToken === 'string') {
          env.CLOUDFLARE_API_TOKEN = options.apiToken;
        }
      }
    }
  }

  // Custom env vars override config-extracted ones
  if (customEnv) {
    Object.assign(env, customEnv);
  }

  const command = buildOpencodeCommand(port, directory);
  const process = await sandbox.exec(command, {
    env: Object.keys(env).length > 0 ? env : undefined
  });

  let stdoutStr = '';
  let stderrStr = '';

  const stdoutStream = process.stdout;
  if (stdoutStream) {
    (async () => {
      try {
        const reader = stdoutStream.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stdoutStr += decoder.decode(value, { stream: true });
          if (stdoutStr.length > 10000) stdoutStr = stdoutStr.slice(-10000);
        }
      } catch {}
    })();
  }

  const stderrStream = process.stderr;
  if (stderrStream) {
    (async () => {
      try {
        const reader = stderrStream.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stderrStr += decoder.decode(value, { stream: true });
          if (stderrStr.length > 10000) stderrStr = stderrStr.slice(-10000);
        }
      } catch {}
    })();
  }

  // Wait for server to be ready - check the actual health endpoint
  try {
    await process.waitForPort(port, {
      mode: 'http',
      path: '/path',
      status: 200,
      timeout: OPENCODE_STARTUP_TIMEOUT_MS
    });
    getLogger().info('OpenCode server started successfully', {
      port,
      pid: process.pid
    });
  } catch (e) {
    const error = e instanceof Error ? e : undefined;
    getLogger().error('OpenCode server failed to start', error, {
      port,
      stdout: stdoutStr,
      stderr: stderrStr
    });
    const diagnostics = stderrStr || stdoutStr || 'Unknown error';
    throw new OpencodeStartupError(
      `OpenCode server failed to start: ${diagnostics}`,
      { port, stderr: stderrStr, command },
      { cause: e }
    );
  }

  return process;
}

/**
 * Starts an OpenCode server inside a Sandbox container.
 *
 * This function manages the server lifecycle only - use `createOpencode()` if you
 * also need a typed SDK client for programmatic access.
 *
 * @param sandbox - The Sandbox instance to run OpenCode in
 * @param options - Configuration options
 * @returns Promise resolving to server handle { port, url, close() }
 */
export async function createOpencodeServer(
  sandbox: Sandbox<unknown>,
  options?: OpencodeOptions
): Promise<OpencodeServer> {
  const port = options?.port ?? DEFAULT_PORT;
  const process = await startOpencodeServer(
    sandbox,
    port,
    options?.directory,
    options?.config,
    options?.env
  );

  return {
    port,
    url: `http://localhost:${port}`,
    close: async () => {
      await process.kill();
    }
  };
}

/**
 * Creates an OpenCode server inside a Sandbox container and returns a typed SDK client.
 *
 * This function is API-compatible with OpenCode's own createOpencode(), but uses
 * Sandbox process management instead of Node.js spawn. The returned client uses
 * a custom fetch adapter to route requests through the Sandbox container.
 *
 * @param sandbox - The Sandbox instance to run OpenCode in
 * @param options - Configuration options
 * @returns Promise resolving to { client, server }
 */
export async function createOpencode<TClient = OpencodeClient>(
  sandbox: Sandbox<unknown>,
  options?: OpencodeOptions
): Promise<OpencodeResult<TClient>> {
  await ensureSdkLoaded();

  const server = await createOpencodeServer(sandbox, options);

  const clientFactory = createOpencodeClient;
  if (!clientFactory) {
    throw new Error('OpenCode SDK client unavailable.');
  }

  const client = clientFactory({
    baseUrl: server.url,
    fetch: (input, init?) =>
      sandbox.containerFetch(new Request(input, init), server.port)
  });

  return { client: client as TClient, server };
}

/**
 * Proxy a request directly to the OpenCode server.
 *
 * Unlike `proxyToOpencode()`, this helper does not apply any web UI redirects
 * or query parameter rewrites. Use it for API/CLI traffic where raw request
 * forwarding is preferred.
 */
export function proxyToOpencodeServer(
  request: Request,
  sandbox: Sandbox<unknown>,
  server: OpencodeServer
): Promise<Response> {
  return sandbox.containerFetch(request, server.port);
}

/**
 * Proxy a request to the OpenCode web UI.
 *
 * This function handles the redirect and proxying only - you must start the
 * server separately using `createOpencodeServer()`.
 *
 * Specifically handles:
 * 1. Ensuring the `?url=` parameter is set (required for OpenCode's frontend to
 *    make API calls through the proxy instead of directly to localhost:4096)
 * 2. Proxying the request to the container
 *
 * @param request - The incoming HTTP request
 * @param sandbox - The Sandbox instance running OpenCode
 * @param server - The OpenCode server handle from createOpencodeServer()
 * @returns Response from OpenCode or a redirect response
 */
export function proxyToOpencode(
  request: Request,
  sandbox: Sandbox<unknown>,
  server: OpencodeServer
): Response | Promise<Response> {
  const url = new URL(request.url);

  // OpenCode's frontend defaults to http://127.0.0.1:4096 when hostname includes
  // "localhost" or "opencode.ai". The ?url= parameter overrides this behavior.
  // We only redirect GET requests for HTML pages (initial page load).
  // API calls (POST, PATCH, etc.) and asset requests are proxied directly
  // since redirecting POST loses the request body.
  if (!url.searchParams.has('url') && request.method === 'GET') {
    const accept = request.headers.get('accept') || '';
    const isHtmlRequest = accept.includes('text/html') || url.pathname === '/';
    if (isHtmlRequest) {
      url.searchParams.set('url', url.origin);
      return Response.redirect(url.toString(), 302);
    }
  }

  return proxyToOpencodeServer(request, sandbox, server);
}
