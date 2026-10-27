import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Vercel runs with production logging and may use either the project root or
// dist/ as its Express entrypoint, depending on the project's output setting.
process.env.NODE_ENV = 'production';

for (const entrypoint of ['../server.mjs', '../dist/server.mjs']) {
  test(`deployment entrypoint ${entrypoint} serves the API`, async () => {
    const source = await readFile(new URL(entrypoint, import.meta.url), 'utf8');
    // The Express preset detects entrypoints by their literal express import.
    assert.match(source, /(?:from|require|import)\s*(?:\(\s*)?["']express["']/);
    const { default: app } = await import(entrypoint);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const health = await fetch(`${baseUrl}/api/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: 'ok' });

      const invalid = await fetch(`${baseUrl}/api/analysis`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(invalid.status, 400);
      assert.ok((await invalid.json()).error);

      const missing = await fetch(`${baseUrl}/api/does-not-exist`);
      assert.equal(missing.status, 404);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
}
