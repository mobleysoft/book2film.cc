import { test } from 'node:test';
import assert from 'node:assert/strict';
import filmline from '../../filmline.cc/video-worker/index.js';
import { pageRange } from '../../weylandai.com/ocr-worker/page-range.js';
import { handle as cortex } from '../cortex/worker.js';
import { validateBeats, advance } from '../worker/pipeline.js';
import { treatment } from './fixtures.mjs';

test('OCR ranges preserve original defaults while proving actual document coverage', () => {
  assert.deepEqual(pageRange(new Headers(), 20), { start: 1, end: 1, documentPages: 20 });
  assert.deepEqual(pageRange(new Headers({ 'X-Start-Page': '19', 'X-Total-Pages': '10' }), 20), { start: 19, end: 20, documentPages: 20 });
  for (const headers of [{ 'X-Start-Page': '0' }, { 'X-Start-Page': '21' }, { 'X-Total-Pages': '-1' }, { 'X-Total-Pages': 'NaN' }, { 'X-Max-Document-Pages': '10' }]) assert.throws(() => pageRange(new Headers(headers), 20));
});
test('Filmline renders twelve beats without calling inference, with escaped XML', async () => {
  const body = treatment(); body.title = '<script>alert(1)</script>'; body.scenes[0].description = '<image onload="alert(1)">';
  const response = await filmline.fetch(new Request('https://internal/api/render', { method: 'POST', body: JSON.stringify(body) }), { STORY_ENGINE: { fetch() { assert.fail('No second inference'); } } });
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.scenes.length, 12); assert.ok(!result.video.svg.includes('<script>')); assert.ok(!result.video.svg.includes('<image '));
  assert.equal(result.page_html, undefined);
});
test('Filmline rejects malformed, oversized and unnumbered scenes', async () => {
  for (const [body, status] of [['{', 400], [' '.repeat(32769), 413], [JSON.stringify({ ...treatment(), scenes: [{ description: 'no number' }] }), 422]]) {
    assert.equal((await filmline.fetch(new Request('https://internal/api/render', { method: 'POST', body }), {})).status, status);
  }
});
test('beat schema rejects nonexistent pages and unmarked additions', () => {
  const value = treatment(); value.scenes[0].source_pages = [121]; assert.throws(() => validateBeats(value, 120));
  value.scenes[0].source_pages = [1]; value.scenes[0].adaptation_notes = ''; assert.throws(() => validateBeats(value, 120));
});
test('hierarchical condensation retains page locator coverage', async () => {
  const state = { stage: 'compose', summaries: Array.from({ length: 40 }, (_, i) => ({ pages: [i + 1], summary: 'a'.repeat(600) })), reductionSteps: 0 };
  const result = await advance(state, 'test', { LLM_CORTEX: { fetch: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ summary: 'Condensed narrative' }) } }] }) } });
  assert.equal(result.stage, 'compose'); assert.equal(result.reductionSteps, 1);
  assert.deepEqual(result.summaries.flatMap(s => s.pages), Array.from({ length: 40 }, (_, i) => i + 1));
});
test('Qwen bridge uses fixed local tunnel, disables thinking and has no paid fallback', async () => {
  const input = { messages: [{ role: 'system', content: 'Return JSON' }, { role: 'user', content: 'test' }], max_tokens: 100, output_schema: 'summary' };
  const request = () => new Request('https://internal/v1/chat/completions', { method: 'POST', body: JSON.stringify(input) });
  assert.equal((await cortex(request(), {}, () => assert.fail())).status, 503);
  const env = { LLAMA_ACCESS_CLIENT_ID: 'test-id', LLAMA_ACCESS_CLIENT_SECRET: 'test-secret' };
  const result = await cortex(request(), env, async (url, init) => {
    assert.equal(url, 'https://llama.mobleysoft.com/v1/chat/completions'); assert.equal(init.redirect, 'manual');
    assert.equal(JSON.parse(init.body).chat_template_kwargs.enable_thinking, false);
    assert.equal(JSON.parse(init.body).response_format.schema.properties.summary.maxLength, 650);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] });
  });
  assert.equal(result.status, 200);
  assert.equal((await cortex(request(), env, async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{' } }] }))).status, 502);
  assert.equal((await cortex(request(), env, async () => new Response('Access redirect', { status: 302 }))).status, 502);
});
