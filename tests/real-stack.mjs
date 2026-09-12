// Real PDF -> bundled PDFium/Tesseract -> local Qwen -> real Filmline.
// AuthFor identity alone is a fixture, so this is NOT a live auth/deployment test.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions, Response as MFResponse } from 'miniflare';
import { pdfFixture } from './fixtures.mjs';
import { handle as cortex } from '../cortex/worker.js';

const ocrRoot = '../weylandai.com/ocr-worker/.local/book2film-test-build';
const ocrModules = [{ type: 'ESModule', path: `${ocrRoot}/index.js` }, ...(await readdir(ocrRoot))
  .filter(name => /\.(wasm|bin)$/.test(name)).map(name => ({ type: name.endsWith('.wasm') ? 'CompiledWasm' : 'Data', path: `${ocrRoot}/${name}` }))];
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
  name: 'studio', modules: true, scriptPath: '.test-build/index.js', compatibilityDate: '2026-08-27', d1Databases: ['DB'], r2Buckets: ['MANUSCRIPTS'],
  bindings: { CANARY_ENABLED: 'true', CANARY_ALLOWED_EMAILS: 'operator@example.test' },
  serviceBindings: {
    AUTHFOR: () => MFResponse.json({ id: 'test-operator', email: 'operator@example.test' }),
    OCR_SERVICE: 'ocr', FILMLINE_VIDEO: 'filmline',
    LLM_CORTEX: async request => {
      const response = await cortex(new Request(request.url, { method: 'POST', body: await request.text() }),
        { LLAMA_ACCESS_CLIENT_ID: 'local-test-only', LLAMA_ACCESS_CLIENT_SECRET: 'local-test-only' },
        (_url, init) => fetch('http://127.0.0.1:11435/v1/chat/completions', { ...init, headers: { 'Content-Type': 'application/json' } }));
      return new MFResponse(await response.text(), { status: response.status, headers: { 'Content-Type': 'application/json' } });
    },
  },
}, { name: 'filmline', modules: true, script: await readFile('../filmline.cc/video-worker/index.js', 'utf8'), compatibilityDate: '2026-08-27' },
{ name: 'ocr', modules: ocrModules, modulesRoot: ocrRoot,
  compatibilityDate: '2026-08-27', compatibilityFlags: ['nodejs_compat'],
}] }));
try {
  const db = await mf.getD1Database('DB');
  for (const sql of (await readFile('migrations/0001_jobs.sql', 'utf8')).split(';').filter(s => s.trim())) await db.prepare(sql).run();
  const headers = { Authorization: 'Bearer local-test-token-000000001' };
  const started = Date.now();
  const response = await mf.dispatchFetch('https://book2film.test/api/book2film/adapt', { method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/pdf', 'Idempotency-Key': crypto.randomUUID(), 'X-Rights-Confirmed': 'true' }, body: pdfFixture() });
  assert.equal(response.status, 201, await response.clone().text());
  let job = (await response.json()).job;
  for (let i = 0; i < 8 && job.stage !== 'complete'; i++) {
    const checkpoint = Date.now();
    const next = await mf.dispatchFetch(`https://book2film.test/api/book2film/jobs/${job.id}/advance`, { method: 'POST', headers });
    assert.equal(next.status, 200, await next.clone().text()); job = (await next.json()).job;
    console.log(JSON.stringify({ stage: job.stage, elapsed_ms: Date.now() - checkpoint, extracted_pages: job.extracted_pages }));
  }
  assert.equal(job.stage, 'complete'); assert.equal(job.result.scenes.length, 12); assert.equal(job.document_pages, 1);
  const page = await mf.dispatchFetch(`https://book2film.test/api/book2film/jobs/${job.id}/pages/1`, { headers });
  const transcript = (await page.json()).text;
  assert.match(transcript, /Mara/); assert.match(transcript, /lighthouse/i);
  console.log(JSON.stringify({ result: 'passed', total_ms: Date.now() - started, title: job.result.title, scenes: job.result.scenes.length,
    ocr_characters: transcript.length, svg_bytes: job.result.video.svg.length, auth: 'fixture, not live', inference: 'actual local Qwen through adapter :11435',
    semantic_quality: 'not established by schema validation' }));
} finally { await mf.dispose(); }
