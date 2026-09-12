import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions, Response as MFResponse } from 'miniflare';
import { treatment, pdfFixture } from './fixtures.mjs';

let mf, db, bucket, storage, ocrMode = 'ok', modelMode = 'ok', modelCalls = 0, unblock, entered;
const origin = 'https://book2film.test';
const token = 'operator-token-00000001';
const call = (path, { method = 'GET', body, auth = token, headers = {} } = {}) => mf.dispatchFetch(origin + path, {
  method, headers: { Origin: origin, ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers }, ...(body ? { body } : {}),
});
async function start() {
  mf = new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath: storage, workers: [{
    name: 'studio', modules: true, scriptPath: '.test-build/index.js', compatibilityDate: '2026-08-27',
    d1Databases: ['DB'], r2Buckets: ['MANUSCRIPTS'],
    bindings: { CANARY_ENABLED: 'true', CANARY_ALLOWED_EMAILS: 'operator@example.test,other@example.test' },
    serviceBindings: {
      AUTHFOR: async r => {
        if (new URL(r.url).pathname.endsWith('/login')) return MFResponse.json({ token });
        const auth = r.headers.get('Authorization');
        return MFResponse.json(auth === `Bearer ${token}` ? { id: 'operator', email: 'operator@example.test' } :
          auth === 'Bearer other-token-000000001' ? { id: 'other', email: 'other@example.test' } : { error: 'Invalid' }, { status: auth?.includes('token-') ? 200 : 401 });
      },
      OCR_SERVICE: async r => {
        if (ocrMode === 'error') return new MFResponse('Down', { status: 503 });
        const page = Number(r.headers.get('X-Start-Page'));
        assert.equal(r.headers.get('X-Total-Pages'), '1');
        assert.equal(r.headers.get('X-Max-Document-Pages'), '120');
        return MFResponse.json({ pages: [{ page, text: `Page ${page}. Mara lights the lighthouse and rescues the boat.` }], pageCount: 1,
          ...(ocrMode === 'missing-coverage' ? {} : { documentPageCount: 2, endPage: page, hasMore: page < 2 }) });
      },
      LLM_CORTEX: async r => {
        modelCalls++; const body = await r.json();
        if (modelMode === 'wait') { entered(); await new Promise(resolve => { unblock = resolve; }); }
        if (modelMode === 'error') return new MFResponse('Down', { status: 503 });
        let value = body.messages[0].content.includes('twelve-beat') ? treatment() : { summary: 'Mara and Eli repair the lighthouse and save the boat.' };
        if (modelMode === 'eleven' && value.scenes) value.scenes.pop();
        if (modelMode === 'truncated') return MFResponse.json({ choices: [{ message: { content: '{' } }] });
        return MFResponse.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
      }, FILMLINE_VIDEO: 'filmline',
    },
  }, { name: 'filmline', modules: true, script: await readFile('../filmline.cc/video-worker/index.js', 'utf8'), compatibilityDate: '2026-08-27' }] }));
  db = await mf.getD1Database('DB'); bucket = await mf.getR2Bucket('MANUSCRIPTS');
}
async function upload(id = crypto.randomUUID(), body = pdfFixture(), headers = {}) {
  return call('/api/book2film/adapt', { method: 'POST', body, headers: { 'Content-Type': 'application/pdf', 'X-Rights-Confirmed': 'true', 'Idempotency-Key': id, ...headers } });
}
async function newJob() { const response = await upload(); assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).job; }
const step = id => call(`/api/book2film/jobs/${id}/advance`, { method: 'POST' });
async function stepsUntil(id, stage) {
  for (let i = 0; i < 12; i++) { const r = await step(id); assert.equal(r.status, 200, await r.clone().text()); const job = (await r.json()).job; if (job.stage === stage) return job; }
  assert.fail('Stage not reached');
}
before(async () => {
  storage = await mkdtemp(join(tmpdir(), 'book2film-test-')); await start();
  for (const statement of (await readFile('migrations/0001_jobs.sql', 'utf8')).split(';').filter(s => s.trim())) await db.prepare(statement).run();
});
beforeEach(async () => { ocrMode = modelMode = 'ok'; modelCalls = 0; await db.prepare('DELETE FROM jobs').run(); const keys = (await bucket.list()).objects.map(o => o.key); if (keys.length) await bucket.delete(keys); });
after(async () => { await mf?.dispose(); await rm(storage, { recursive: true, force: true }); });

test('authentication, origin checks, upload rights, media and size boundaries', async () => {
  assert.equal((await call('/api/book2film/jobs', { auth: '' })).status, 401);
  assert.equal((await call('/api/book2film/jobs', { headers: { Origin: 'https://attacker.test' } })).status, 403);
  assert.equal((await upload(crypto.randomUUID(), pdfFixture(), { 'X-Rights-Confirmed': 'false' })).status, 400);
  assert.equal((await upload(crypto.randomUUID(), pdfFixture(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await upload(crypto.randomUUID(), 'not a pdf')).status, 400);
  assert.equal((await upload('bad')).status, 400);
  assert.equal((await upload(crypto.randomUUID(), new Uint8Array(10 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await call('/api/does-not-exist')).status, 404);
  assert.equal(modelCalls, 0);
});
test('upload idempotency and one active job per owner', async () => {
  const id = crypto.randomUUID(); assert.equal((await upload(id)).status, 201);
  assert.equal((await upload(id)).status, 200);
  assert.equal((await upload(id, '%PDF-different')).status, 409);
  assert.equal((await upload()).status, 409);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM jobs').first()).n, 1);
});
test('full checkpoint workflow uses actual Filmline renderer, references, source read and private deletion', async () => {
  const saved = await newJob(); const job = await stepsUntil(saved.id, 'complete');
  assert.equal(job.result.scenes.length, 12); assert.equal(job.result.human_review_required, true);
  assert.equal(job.result.coverage.extracted_pages, 2); assert.equal(modelCalls, 3);
  assert.match(job.result.video.svg, /<animate /);
  assert.equal(job.result.video.total_seconds, 54);
  const source = await call(`/api/book2film/jobs/${job.id}/pages/1`); assert.match((await source.json()).text, /Mara/);
  for (const operation of ['', '/pages/1', '/advance']) {
    assert.equal((await call(`/api/book2film/jobs/${job.id}${operation}`, { auth: 'other-token-000000001', method: operation === '/advance' ? 'POST' : 'GET' })).status, 404);
  }
  assert.equal((await step(job.id)).status, 200); assert.equal(modelCalls, 3, 'completed requests must not repeat inference');
  assert.equal((await call(`/api/book2film/jobs/${job.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await bucket.list({ prefix: `${job.id}/` })).objects.length, 0);
  assert.equal((await call(`/api/book2film/jobs/${job.id}`)).status, 404);
});
test('old or unavailable OCR fails closed instead of adapting a partial document', async () => {
  const job = await newJob(); ocrMode = 'missing-coverage'; assert.equal((await step(job.id)).status, 502);
  const saved = (await (await call(`/api/book2film/jobs/${job.id}`)).json()).job;
  assert.equal(saved.stage, 'extract'); assert.equal(saved.extracted_pages, 0); assert.match(saved.error, /coverage/);
  ocrMode = 'ok'; assert.equal((await step(job.id)).status, 200);
});
test('malformed or eleven-beat completion is not success and retry preserves checkpoint', async () => {
  const job = await newJob(); await stepsUntil(job.id, 'compose'); modelMode = 'eleven';
  assert.equal((await step(job.id)).status, 502);
  let saved = (await (await call(`/api/book2film/jobs/${job.id}`)).json()).job;
  assert.equal(saved.stage, 'compose'); assert.equal(saved.result, null);
  modelMode = 'truncated'; assert.equal((await step(job.id)).status, 502);
  modelMode = 'ok'; saved = await stepsUntil(job.id, 'complete'); assert.equal(saved.result.scenes.length, 12);
});
test('concurrent advance and delete are excluded while a model checkpoint runs', async () => {
  const job = await newJob(); await step(job.id); modelMode = 'wait';
  const ready = new Promise(resolve => { entered = resolve; }); const first = step(job.id); await ready;
  assert.equal((await step(job.id)).status, 409);
  assert.equal((await call(`/api/book2film/jobs/${job.id}`, { method: 'DELETE' })).status, 409);
  unblock(); assert.equal((await first).status, 200); assert.equal(modelCalls, 1);
});
test('expired lease recovers and durable job resumes after worker restart', async () => {
  const job = await newJob(); await step(job.id);
  await db.prepare('UPDATE jobs SET lease=?,lease_until=? WHERE id=?').bind('crashed-owner', Date.now() - 1000, job.id).run();
  await mf.dispose(); await start();
  const resumed = await step(job.id); assert.equal(resumed.status, 200, await resumed.clone().text());
  const result = await stepsUntil(job.id, 'complete'); assert.equal(result.document_pages, 2);
});
