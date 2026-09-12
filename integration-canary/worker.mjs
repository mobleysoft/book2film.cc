// Isolated canary: shared AuthFor / OCR / Filmline contracts, not new providers.
// No routes, paid checkout, or public deployment are configured by this module.
const PDF_LIMIT = 2 * 1024 * 1024;
const JSON_LIMIT = 8192;
const RESPONSE_LIMIT = 512 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

async function boundedBytes(message, limit) {
  const size = Number(message.headers.get("content-length"));
  if (Number.isFinite(size) && size > limit) throw new HttpError(413, "Payload exceeds limit");
  if (!message.body) return new Uint8Array();
  const reader = message.body.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); throw new HttpError(413, "Payload exceeds limit"); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

async function providerJson(response) {
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, "Shared provider failed"); }
  try { return JSON.parse(new TextDecoder().decode(await boundedBytes(response, RESPONSE_LIMIT))); }
  catch { throw new HttpError(502, "Invalid or oversized provider response"); }
}

export async function handle(request, env, authFetch = globalThis.fetch) {
  const path = new URL(request.url).pathname;
  if (!["/api/source-text", "/api/storyboard"].includes(path)) return json({ error: "Not found" }, 404);
  if (request.method !== "POST") return json({ error: "POST required" }, 405);
  if (env.CANARY_ENABLED !== "true") return json({ error: "Canary disabled" }, 503);
  const allowed = (env.CANARY_ALLOWED_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) return json({ error: "Canary allowlist not configured" }, 503);
  const auth = request.headers.get("Authorization") || "";
  if (!/^Bearer [^\s]+$/i.test(auth) || auth.length > 8192) return json({ error: "Bearer token required" }, 401);
  try {
    const type = request.headers.get("Content-Type")?.split(";")[0].toLowerCase();
    if (type !== (path === "/api/source-text" ? "application/pdf" : "application/json")) throw new HttpError(415, "Unsupported content type");
    const raw = await boundedBytes(request, path === "/api/source-text" ? PDF_LIMIT : JSON_LIMIT);
    let input;
    if (path === "/api/source-text") {
      if (new TextDecoder().decode(raw.slice(0, 5)) !== "%PDF-") throw new HttpError(400, "PDF header required");
    } else {
      try { input = JSON.parse(new TextDecoder().decode(raw)); }
      catch { throw new HttpError(400, "Invalid JSON"); }
      if (typeof input?.excerpt !== "string" || !input.excerpt.trim() || input.excerpt.length > 850 || input.approved !== true) {
        throw new HttpError(400, "Approve a nonempty excerpt of at most 850 characters");
      }
    }
    // AuthFor's real contract is GET /api/v1/verify, not a client-supplied identity.
    const authResponse = await authFetch("https://authfor.com/api/v1/verify", {
      headers: { Authorization: auth }, signal: AbortSignal.timeout(10000), redirect: "error",
    });
    if ([401, 403].includes(authResponse.status)) { await authResponse.body?.cancel(); throw new HttpError(401, "Invalid AuthFor identity"); }
    const identity = await providerJson(authResponse);
    if (typeof identity?.email !== "string") throw new HttpError(502, "AuthFor identity missing email");
    if (!allowed.includes(identity.email.trim().toLowerCase())) throw new HttpError(403, "Identity not allowed for this canary");

    if (path === "/api/source-text") {
      if (!env.OCR_SERVICE?.fetch) throw new HttpError(503, "OCR_SERVICE not configured");
      const data = await providerJson(await env.OCR_SERVICE.fetch("https://internal/extract-text", {
        method: "POST", headers: { "Content-Type": "application/pdf", "X-Total-Pages": "10" },
        body: raw, signal: AbortSignal.timeout(60000),
      }));
      if (!Array.isArray(data.pages) || !data.pages.length || data.pages.some(p => typeof p?.text !== "string")) throw new HttpError(502, "OCR returned invalid pages");
      if (!data.pages.some(p => p.text.trim())) throw new HttpError(422, "No readable text found");
      return json({ pages: data.pages.map((p, i) => ({ page: i + 1, text: p.text })), pageCount: data.pageCount ?? data.pages.length,
        scope: "OCR response only; page limit is a provider hint, not a guarantee of whole-book extraction",
        next: "Choose and approve an excerpt of at most 850 characters for /api/storyboard. No generation has run." });
    }
    if (!env.FILMLINE_VIDEO?.fetch) throw new HttpError(503, "FILMLINE_VIDEO not configured");
    const started = Date.now();
    const premise = "Create a short storyboard based only on this excerpt. Mark invented details as suggestions. Excerpt: " + input.excerpt.trim();
    const result = await providerJson(await env.FILMLINE_VIDEO.fetch("https://internal/api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ premise }), signal: AbortSignal.timeout(120000),
    }));
    if (typeof result?.title !== "string" || !Array.isArray(result.scenes) || !result.scenes.length ||
        result.scenes.some(s => typeof s?.description !== "string") || result.video?.format !== "animated-svg-storyboard" || typeof result.video.svg !== "string") {
      throw new HttpError(502, "Filmline returned an invalid storyboard");
    }
    // Do not forward provider page_html: the client must sandbox generated SVG.
    return json({ title: result.title, logline: result.logline, scenes: result.scenes, video: result.video,
      scope: "Excerpt-based storyboard proposal; not a full book adaptation, finished screenplay, or encoded film",
      human_review_required: true, latency_ms: Date.now() - started });
  } catch (error) {
    return json({ error: error instanceof HttpError ? error.message : "Shared service unavailable or timed out" }, error instanceof HttpError ? error.status : 502);
  }
}

export default { fetch: (request, env) => handle(request, env) };
