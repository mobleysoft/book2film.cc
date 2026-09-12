import { HttpError, bytes, json, readJson } from './common.js';
import { advance } from './pipeline.js';
const PREFIX = '/api/book2film';
const LEASE_MS = 240000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function allowed(env) { return (env.CANARY_ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean); }
async function authCall(env, path, init) {
  const transport = env.AUTHFOR?.fetch ? env.AUTHFOR.fetch.bind(env.AUTHFOR) : fetch;
  try {
    const response = await transport(`https://authfor.com/api/v1/${path}`, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError([401, 403].includes(response.status) ? 401 : 503, 'AuthFor could not authenticate this session'); }
    return await readJson(response, 16384);
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, 'AuthFor unavailable'); }
}
async function identity(request, env) {
  const authorization = request.headers.get('Authorization') || '';
  if (!/^Bearer \S{16,4096}$/.test(authorization)) throw new HttpError(401, 'Sign in with AuthFor');
  const user = await authCall(env, 'verify', { headers: { Authorization: authorization } });
  const email = typeof user?.email === 'string' ? user.email.toLowerCase().trim() : '';
  if (!allowed(env).includes(email)) throw new HttpError(403, 'This studio is restricted to approved operators');
  // Never persist a bearer token or trust a client-supplied owner.
  return String(user.id || email);
}
function view(row) {
  const state = JSON.parse(row.state);
  return { id: row.id, name: state.name, status: row.status, stage: state.stage,
    created_at: row.created_at, updated_at: row.updated_at,
    busy: row.lease_until > Date.now(), error: state.error || null,
    document_pages: state.documentPages, extracted_pages: state.extractedPages,
    summarized_pages: Math.max(0, state.nextPage - 1), blank_pages: state.blankPages,
    reduction_steps: state.reductionSteps, result: state.result || null };
}
async function owned(env, id, owner) {
  const row = await env.DB.prepare("SELECT * FROM jobs WHERE id=? AND owner=? AND status!='deleted'").bind(id, owner).first();
  if (!row) throw new HttpError(404, 'Job not found');
  return row;
}
async function claim(env, row) {
  const lease = crypto.randomUUID(), now = Date.now();
  const result = await env.DB.prepare('UPDATE jobs SET lease=?,lease_until=? WHERE id=? AND lease_until<=? AND status=? AND version=?')
    .bind(lease, now + LEASE_MS, row.id, now, row.status, row.version).run();
  if (result.meta.changes !== 1) throw new HttpError(409, 'A checkpoint is already running; reload status instead of starting another');
  return lease;
}
async function release(env, id, lease, state, status = state.stage) {
  const result = await env.DB.prepare('UPDATE jobs SET state=?,status=?,lease=NULL,lease_until=0,version=version+1,updated_at=? WHERE id=? AND lease=?')
    .bind(JSON.stringify(state), status, Date.now(), id, lease).run();
  if (result.meta.changes !== 1) throw new HttpError(409, 'Checkpoint lease changed; reload saved status');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname;
    if (!path.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Studio assets not built', { status: 503 });
    try {
      if (path === '/api/health' && request.method === 'GET') {
        await env.DB.prepare('SELECT 1').first();
        return json({ database: 'reachable', canary_enabled: env.CANARY_ENABLED === 'true',
          configured_bindings: { ocr: !!env.OCR_SERVICE, cortex: !!env.LLM_CORTEX, filmline: !!env.FILMLINE_VIDEO, storage: !!env.MANUSCRIPTS },
          note: 'Configuration presence is not an end-to-end provider health check.' });
      }
      if (env.CANARY_ENABLED !== 'true' || !allowed(env).length) throw new HttpError(503, 'Operator pilot is not enabled');
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-origin request rejected');
      if (path === '/api/auth/login' && request.method === 'POST') {
        const body = await readJson(request, 8192);
        if (typeof body?.email !== 'string' || !allowed(env).includes(body.email.trim().toLowerCase()) ||
          typeof body.password !== 'string' || !body.password || body.password.length > 1024) throw new HttpError(403, 'Approved operator credentials required');
        const result = await authCall(env, 'login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: body.email.trim(), password: body.password, venture_id: 'book2film.cc', client_id: 'book2film' }) });
        if (typeof result.token !== 'string' || !/^\S{16,4096}$/.test(result.token)) throw new HttpError(502, 'AuthFor returned an invalid session');
        return json({ token: result.token });
      }
      const owner = await identity(request, env);
      if (!env.DB || !env.MANUSCRIPTS) throw new HttpError(503, 'Private storage has not been provisioned');
      if (path === `${PREFIX}/jobs` && request.method === 'GET') {
        const rows = await env.DB.prepare("SELECT * FROM jobs WHERE owner=? AND status!='deleted' ORDER BY created_at DESC LIMIT 10").bind(owner).all();
        return json({ jobs: rows.results.map(view) });
      }
      if (path === `${PREFIX}/adapt` && request.method === 'POST') {
        if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/pdf') throw new HttpError(415, 'Upload a PDF');
        if (request.headers.get('X-Rights-Confirmed') !== 'true') throw new HttpError(400, 'Confirm that you have adaptation rights');
        const id = request.headers.get('Idempotency-Key') || '';
        if (!UUID.test(id)) throw new HttpError(400, 'A UUID Idempotency-Key is required');
        const pdf = await bytes(request, 10 * 1024 * 1024);
        if (new TextDecoder().decode(pdf.subarray(0, 5)) !== '%PDF-') throw new HttpError(400, 'PDF signature missing');
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', pdf))].map(b => b.toString(16).padStart(2, '0')).join('');
        let row = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first();
        if (row && (row.owner !== owner || JSON.parse(row.state).digest !== digest || row.status === 'deleted')) throw new HttpError(409, 'Upload key was already used for another request');
        if (!row) {
          const state = { stage: 'uploading', name: (request.headers.get('X-Manuscript-Name') || 'Untitled manuscript').slice(0, 160), digest,
            documentPages: null, extractedPages: 0, nextPage: 1, summaries: [], chunks: [], blankPages: [], reductionSteps: 0, rights_confirmed: true };
          try {
            const inserted = await env.DB.prepare("INSERT INTO jobs(id,owner,status,state,created_at,updated_at) SELECT ?,?,'uploading',?,?,? WHERE (SELECT COUNT(*) FROM jobs WHERE owner=? AND status!='deleted')<10")
              .bind(id, owner, JSON.stringify(state), Date.now(), Date.now(), owner).run();
            if (!inserted.meta.changes) throw new Error('Quota');
          } catch { throw new HttpError(409, 'Finish or delete the active job, or delete an older job (ten retained jobs maximum)'); }
          row = await owned(env, id, owner);
        }
        if (row.status !== 'uploading') return json({ job: view(row) }, 200);
        const lease = await claim(env, row), state = JSON.parse(row.state);
        try {
          await env.MANUSCRIPTS.put(`${id}/source.pdf`, pdf, { httpMetadata: { contentType: 'application/pdf' } });
          state.stage = 'extract';
          await release(env, id, lease, state);
        } catch (error) { await release(env, id, lease, JSON.parse(row.state)); throw error; }
        return json({ job: view(await owned(env, id, owner)) }, 201);
      }
      const match = path.match(/^\/api\/book2film\/jobs\/([a-f0-9-]{36})(?:\/(advance|pages\/\d+))?$/);
      if (!match || !UUID.test(match[1])) throw new HttpError(404, 'Endpoint not found');
      const [, id, operation] = match;
      const row = await owned(env, id, owner);
      if (!operation && request.method === 'GET') return json({ job: view(row) });
      if (operation?.startsWith('pages/') && request.method === 'GET') {
        const page = Number(operation.split('/')[1]), state = JSON.parse(row.state);
        if (page < 1 || page > state.extractedPages) throw new HttpError(404, 'Page not extracted');
        const object = await env.MANUSCRIPTS.get(`${id}/pages/${page}.txt`);
        if (!object) throw new HttpError(404, 'Page not stored');
        return json({ page, text: await object.text(), note: 'OCR transcript, not guaranteed exact text' });
      }
      if (!operation && request.method === 'DELETE') {
        const lease = await claim(env, row);
        try {
          // The lease excludes in-flight page writes; a retry also removes
          // objects left behind by a crashed extraction before its checkpoint.
          let cursor;
          do {
            const listed = await env.MANUSCRIPTS.list({ prefix: `${id}/`, cursor });
            if (listed.objects.length) await env.MANUSCRIPTS.delete(listed.objects.map(o => o.key));
            cursor = listed.truncated ? listed.cursor : undefined;
          } while (cursor);
          await release(env, id, lease, { ...JSON.parse(row.state), stage: 'deleted', summaries: [], chunks: [], result: null, treatment: null }, 'deleted');
        } catch (error) { await release(env, id, lease, JSON.parse(row.state), row.status); throw error; }
        return json({ deleted: true });
      }
      if (operation === 'advance' && request.method === 'POST') {
        if (row.status === 'complete') return json({ job: view(row) });
        if (row.status === 'uploading') throw new HttpError(409, 'Retry the original upload before processing');
        const lease = await claim(env, row), original = JSON.parse(row.state);
        try {
          const state = await advance(structuredClone(original), id, env);
          state.error = null;
          await release(env, id, lease, state);
        } catch (error) {
          original.error = error instanceof HttpError ? error.message : 'Processing failed; saved checkpoint retained';
          await release(env, id, lease, original, row.status);
          throw error;
        }
        return json({ job: view(await owned(env, id, owner)) });
      }
      throw new HttpError(405, 'Method not supported');
    } catch (error) {
      return json({ error: error instanceof HttpError ? error.message : 'Storage or service unavailable; retry from the saved checkpoint' }, error instanceof HttpError ? error.status : 503);
    }
  },
};
