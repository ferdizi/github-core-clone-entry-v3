// main.ts — entrypoint. One process: binds an ephemeral port (never 8080),
// registers with the suite, long-polls for /done, exits 0 when done.
// Run as: node --experimental-strip-types main.ts
// (the trial runs `node /bot/main.ts`).

import { createApp } from './src/app.ts';
import { Forge } from './src/store.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

async function postJson(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function getJson(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  return { status: response.status, text: await response.text() };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const forge = new Forge();
  const app = createApp(forge, { token: TOKEN });
  const port = await new Promise<number>((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, '127.0.0.1', () => {
      const address = app.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not bind an ephemeral port'));
        return;
      }
      resolve(address.port);
    });
  });

  if (ENV_URL === '') {
    // Local development: no suite to register with. Just serve.
    process.stdout.write(`forge listening on http://127.0.0.1:${port}\n`);
    return;
  }

  const envBase = ENV_URL.replace(/\/+$/, '');
  const registered = await postJson(`${envBase}/register`, { port });
  if (registered.status !== 200 && registered.status !== 201 && registered.status !== 204) {
    process.stderr.write(`register failed: HTTP ${registered.status} ${registered.text}\n`);
    process.exit(1);
  }

  // Long-poll /done until the suite says the export is written.
  for (;;) {
    let done: { status: number; text: string };
    try {
      done = await getJson(`${envBase}/done`);
    } catch {
      await sleep(500);
      continue;
    }
    if (done.status === 200) {
      try {
        const parsed = JSON.parse(done.text) as { done?: boolean };
        if (parsed.done === true) break;
      } catch {
        // Not JSON yet; keep polling.
      }
    }
    await sleep(500);
  }

  app.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
