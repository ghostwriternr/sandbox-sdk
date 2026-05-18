import { createLogger, TraceContext } from '@repo/shared';
import { getSandbox, type Sandbox } from './sandbox';
import { sanitizeSandboxId, validatePort } from './security';

export interface SandboxEnv<T extends Sandbox<any> = Sandbox<any>> {
  Sandbox: DurableObjectNamespace<T>;
}

export interface RouteInfo {
  port: number;
  sandboxId: string;
  path: string;
  token: string;
}

export const PREVIEW_PROXY_HEADER = 'x-sandbox-preview-proxy';
export const PREVIEW_PROXY_PORT_HEADER = 'x-sandbox-preview-port';
export const PREVIEW_PROXY_TOKEN_HEADER = 'x-sandbox-preview-token';
export const PREVIEW_PROXY_SANDBOX_ID_HEADER = 'x-sandbox-preview-sandbox-id';

export async function proxyToSandbox<
  T extends Sandbox<any>,
  E extends SandboxEnv<T>
>(request: Request, env: E): Promise<Response | null> {
  // Create logger context for this request
  const traceId =
    TraceContext.fromHeaders(request.headers) || TraceContext.generate();
  const logger = createLogger({
    component: 'sandbox-do',
    traceId,
    operation: 'proxy'
  });

  try {
    const url = new URL(request.url);
    const routeInfo = extractSandboxRoute(url);

    if (!routeInfo) {
      return null; // Not a request to an exposed container port
    }

    const { sandboxId, port, token } = routeInfo;
    // Preview URLs always use normalized (lowercase) IDs
    const sandbox = getSandbox(env.Sandbox, sandboxId, { normalizeId: true });

    const headers = new Headers(request.headers);
    headers.set(PREVIEW_PROXY_HEADER, '1');
    headers.set(PREVIEW_PROXY_PORT_HEADER, port.toString());
    headers.set(PREVIEW_PROXY_TOKEN_HEADER, token);
    headers.set(PREVIEW_PROXY_SANDBOX_ID_HEADER, sandboxId);

    const previewRequest = new Request(request, { headers });
    return await sandbox.fetch(previewRequest);
  } catch (error) {
    logger.error(
      'Proxy routing error',
      error instanceof Error ? error : new Error(String(error))
    );
    return new Response('Proxy routing error', { status: 500 });
  }
}

function extractSandboxRoute(url: URL): RouteInfo | null {
  // URL format: {port}-{sandboxId}-{token}.{domain}
  // Tokens are [a-z0-9_]+, so we split at the last hyphen to handle sandboxIds with hyphens (UUIDs)
  const dotIndex = url.hostname.indexOf('.');
  if (dotIndex === -1) {
    return null;
  }

  const subdomain = url.hostname.slice(0, dotIndex);

  // Extract port (digits at start followed by hyphen)
  const firstHyphen = subdomain.indexOf('-');
  if (firstHyphen === -1) {
    return null;
  }

  const portStr = subdomain.slice(0, firstHyphen);
  if (!/^\d{4,5}$/.test(portStr)) {
    return null;
  }

  const port = parseInt(portStr, 10);
  if (!validatePort(port)) {
    return null;
  }

  // Extract token (last hyphen-delimited segment) and sandboxId (everything between port and token)
  const rest = subdomain.slice(firstHyphen + 1);
  const lastHyphen = rest.lastIndexOf('-');
  if (lastHyphen === -1) {
    return null;
  }

  const sandboxId = rest.slice(0, lastHyphen);
  const token = rest.slice(lastHyphen + 1);

  // No hyphens in tokens: URL is {port}-{sandboxId}-{token}.{domain}
  // We split at the LAST hyphen, so hyphens in tokens would be ambiguous
  if (!/^[a-z0-9_]+$/.test(token) || token.length === 0 || token.length > 63) {
    return null;
  }

  // Validate and sanitize sandboxId
  if (sandboxId.length === 0 || sandboxId.length > 63) {
    return null;
  }

  let sanitizedSandboxId: string;
  try {
    sanitizedSandboxId = sanitizeSandboxId(sandboxId);
  } catch {
    return null;
  }

  return {
    port,
    sandboxId: sanitizedSandboxId,
    path: url.pathname || '/',
    token
  };
}

export function isLocalhostPattern(hostname: string): boolean {
  // Handle IPv6 addresses in brackets (with or without port)
  if (hostname.startsWith('[')) {
    if (hostname.includes(']:')) {
      // [::1]:port format
      const ipv6Part = hostname.substring(0, hostname.indexOf(']:') + 1);
      return ipv6Part === '[::1]';
    } else {
      // [::1] format without port
      return hostname === '[::1]';
    }
  }

  // Handle bare IPv6 without brackets
  if (hostname === '::1') {
    return true;
  }

  // For IPv4 and regular hostnames, split on colon to remove port
  const hostPart = hostname.split(':')[0];

  return (
    hostPart === 'localhost' ||
    hostPart === '127.0.0.1' ||
    hostPart === '0.0.0.0'
  );
}
