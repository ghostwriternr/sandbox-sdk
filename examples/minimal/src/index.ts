import { getSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

const SANDBOX_ID = 'my-sandbox';
const DEFAULT_READ_COUNT = 10_000;
const MAX_READ_COUNT = 10_000;
const PERF_FILE_PATH = '/workspace/readfile-perf.txt';
const PERF_FILE_CONTENT = 'Hello from the Sandbox readFile perf test.\n';

type CountResult =
  | { ok: true; count: number; clamped: boolean }
  | { ok: false; message: string };

function parseReadCount(url: URL): CountResult {
  const rawCount = url.searchParams.get('count');

  if (rawCount === null || rawCount === '') {
    return { ok: true, count: DEFAULT_READ_COUNT, clamped: false };
  }

  const parsed = Number(rawCount);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, message: 'count must be a positive integer' };
  }

  return {
    ok: true,
    count: Math.min(parsed, MAX_READ_COUNT),
    clamped: parsed > MAX_READ_COUNT
  };
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }

  return String(reason);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/destroy') {
      if (request.method !== 'POST') {
        return new Response('Use POST /destroy', { status: 405 });
      }

      const sandbox = getSandbox(env.Sandbox, SANDBOX_ID);
      const startedAt = performance.now();
      await sandbox.destroy();

      return Response.json({
        destroyed: true,
        sandboxId: SANDBOX_ID,
        durationMs: performance.now() - startedAt
      });
    }

    if (url.pathname !== '/perf') {
      return new Response('Try /perf?count=10000 or POST /destroy');
    }

    const countResult = parseReadCount(url);

    if (!countResult.ok) {
      return Response.json({ error: countResult.message }, { status: 400 });
    }

    const sandbox = getSandbox(env.Sandbox, SANDBOX_ID);

    await sandbox.writeFile(PERF_FILE_PATH, PERF_FILE_CONTENT);

    const startedAt = performance.now();
    const reads = Array.from({ length: countResult.count }, () =>
      sandbox.readFile(PERF_FILE_PATH)
    );
    const results = await Promise.allSettled(reads);
    const durationMs = performance.now() - startedAt;

    const successfulResults = results.filter(
      (result) => result.status === 'fulfilled'
    );
    const failedResults = results.filter(
      (result) => result.status === 'rejected'
    );
    const firstSuccessfulResult = successfulResults[0];

    return Response.json({
      count: countResult.count,
      requestedCount: url.searchParams.get('count') ?? DEFAULT_READ_COUNT,
      clamped: countResult.clamped,
      successfulReads: successfulResults.length,
      failedReads: failedResults.length,
      durationMs,
      readsPerSecond: countResult.count / (durationMs / 1000),
      expectedContentLength: PERF_FILE_CONTENT.length,
      sampleContentLength:
        firstSuccessfulResult?.status === 'fulfilled'
          ? firstSuccessfulResult.value.content.length
          : null,
      errorSamples: failedResults
        .slice(0, 5)
        .map((result) =>
          result.status === 'rejected' ? errorMessage(result.reason) : ''
        )
    });
  }
};
