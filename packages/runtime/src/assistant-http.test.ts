import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serveAssistant } from './assistant-http.js';

test('all HTML entrypoints revalidate while bundled assets retain immutable caching', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eris-entrypoints-'));
  const html = '<!doctype html><html><body>Template gallery</body></html>';
  await Promise.all(['index.html', 'chart-gallery.html', 'bundle.js'].map(name => writeFile(path.join(directory, name), name.endsWith('.html') ? html : 'export const ready=true;')));
  const server = await serveAssistant({ port: 0, userId: 'local', webDirectory: directory,
    endpoints: () => ({ async call() { throw new Error('Unexpected RPC'); }, async stream() { throw new Error('Unexpected stream'); }, async dispose() {} }) });
  try {
    for (const name of ['index.html', 'chart-gallery.html', 'bundle.js']) {
      const response = await fetch(`${server.url}/u/local/${name}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), name.endsWith('.html') ? 'no-store' : 'public,max-age=31536000,immutable');
      await response.text();
    }
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
