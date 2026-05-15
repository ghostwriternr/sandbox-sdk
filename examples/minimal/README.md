# Minimal Sandbox SDK Example

A minimal Cloudflare Worker configured to stress-test Sandbox SDK file reads.

## What It Tests

The Worker exposes a perf endpoint that launches many `sandbox.readFile()` calls at the same time against a small file in the sandbox filesystem. It is useful for observing how a single `standard-1` Sandbox container behaves under high read concurrency.

## API Endpoints

### Concurrent readFile perf test

```bash
GET /perf?count=10000
```

`count` is optional and defaults to `10000`. Values above `10000` are clamped to `10000`.

Example:

```bash
curl 'http://localhost:8787/perf?count=10000'
```

Response shape:

```json
{
  "count": 10000,
  "requestedCount": "10000",
  "clamped": false,
  "successfulReads": 10000,
  "failedReads": 0,
  "durationMs": 1234.56,
  "readsPerSecond": 8099.97,
  "expectedContentLength": 43,
  "sampleContentLength": 43,
  "errorSamples": []
}
```

### Destroy the sandbox

```bash
POST /destroy
```

Use this between perf runs when you want the next `/perf` request to start from a fresh sandbox container.

Example:

```bash
curl -X POST 'http://localhost:8787/destroy'
```

Response shape:

```json
{
  "destroyed": true,
  "sandboxId": "my-sandbox",
  "durationMs": 123.45
}
```

## Setup

From the project root, install dependencies and build packages:

```bash
npm install
npm run build
```

## Run Locally

```bash
cd examples/minimal
npm run dev
```

The first run builds the Docker container. Subsequent runs reuse the cached image unless the SDK or Dockerfile changes.

## Deploy

Deploy with Wrangler from this directory:

```bash
npm run deploy
```

Before deploying, confirm Wrangler is authenticated to the intended Cloudflare account:

```bash
wrangler whoami
```

After first deployment, wait a few minutes for container provisioning before making requests.
