import type { PortExposeResult } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';

// Port exposure tests require custom domain with wildcard DNS routing
const skipPortExposureTests =
  process.env.TEST_WORKER_URL?.endsWith('.workers.dev') ?? false;

/**
 * Process Readiness Workflow Integration Tests
 *
 * Tests modern process port readiness feature using `/api/exec-and-wait-for-port`.
 */
describe('Process Readiness Workflow', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let portHeaders: Record<string, string>;
  let sandbox: TestSandbox | null = null;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers(createUniqueSession());
    // Port exposure requires sandbox headers (not session headers)
    portHeaders = {
      'X-Sandbox-Id': sandbox.sandboxId,
      'Content-Type': 'application/json'
    };
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
  }, 120000);

  test('should start a server and wait for its port to become ready', async () => {
    // Write a Bun server that listens on a port
    const serverCode = `
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 9090,
  fetch(req) {
    return new Response("OK");
  },
});
console.log("Server started on " + server.hostname + ":" + server.port);
await Bun.sleep(60000);
    `.trim();

    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/portserver.js',
        content: serverCode
      })
    });

    // Start process and wait for port 9090
    const response = await fetch(`${workerUrl}/api/exec-and-wait-for-port`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'bun run /workspace/portserver.js',
        port: 9090
      })
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as { ready: boolean; pid: number };
    expect(data.ready).toBe(true);
    expect(data.pid).toBeGreaterThan(0);

    // Verify the port is actually listening by trying to curl it
    const verifyResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'curl -s http://localhost:9090'
      })
    });

    const verifyData = (await verifyResponse.json()) as { stdout: string };
    expect(verifyData.stdout).toBe('OK');
  }, 60000);

  test.skipIf(skipPortExposureTests)(
    'should start server, wait for port, and expose it',
    async () => {
      // Write a simple HTTP server
      const serverCode = `
const server = Bun.serve({
  port: 9092,
  fetch(req) {
    return new Response(JSON.stringify({ message: "Hello!" }), {
      headers: { "Content-Type": "application/json" }
    });
  },
});
console.log("Server listening on port 9092");
      `.trim();

      await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/http-server.js',
          content: serverCode
        })
      });

      // Start the process and wait for port
      const waitPortResponse = await fetch(
        `${workerUrl}/api/exec-and-wait-for-port`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: 'bun run /workspace/http-server.js',
            port: 9092
          })
        }
      );
      expect(waitPortResponse.status).toBe(200);

      // Expose the port
      const exposeResponse = await fetch(`${workerUrl}/api/port/expose`, {
        method: 'POST',
        headers: portHeaders,
        body: JSON.stringify({
          port: 9092
        })
      });

      expect(exposeResponse.status).toBe(200);
      const exposeData = (await exposeResponse.json()) as PortExposeResult;
      expect(exposeData.url).toBeTruthy();

      // Make a request to the exposed URL
      const apiResponse = await fetch(exposeData.url);
      expect(apiResponse.status).toBe(200);
      const apiData = (await apiResponse.json()) as { message: string };
      expect(apiData.message).toBe('Hello!');

      // Cleanup
      await fetch(`${workerUrl}/api/exposed-ports/9092`, {
        method: 'DELETE',
        headers: portHeaders
      });
    },
    90000
  );
});
