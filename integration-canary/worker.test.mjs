import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "./worker.mjs";
import filmline from "../../filmline.cc/video-worker/index.js";

const reply = data => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
function fixture() {
  const calls = [];
  return {
    calls, auth: async (url, options) => { calls.push(["auth", url, options]); return reply({ email: "Operator@Example.com" }); },
    env: {
      CANARY_ENABLED: "true", CANARY_ALLOWED_EMAILS: "operator@example.com",
      OCR_SERVICE: { fetch: async (url, options) => { calls.push(["ocr", url, options]); return reply({ pages: [{ text: "A lighthouse keeper receives a letter." }], pageCount: 1 }); } },
      FILMLINE_VIDEO: { fetch: async (url, options) => { calls.push(["storyboard", url, options]); return reply({ title: "The Letter", scenes: [{ description: "A letter arrives" }], video: { format: "animated-svg-storyboard", svg: "<svg></svg>" }, page_html: "<script>untrusted</script>" }); } },
    },
  };
}
function request(path, body, headers = {}) {
  return new Request("https://canary.invalid" + path, { method: "POST", headers: {
    Authorization: "Bearer canary-test-token", "Content-Type": path === "/api/source-text" ? "application/pdf" : "application/json", ...headers,
  }, body });
}
test("real contract-shaped PDF extraction calls auth then OCR, never generation", async () => {
  const f = fixture();
  const result = await handle(request("/api/source-text", "%PDF-1.4\nfixture"), f.env, f.auth);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).pages[0].page, 1);
  assert.deepEqual(f.calls.map(c => c[0]), ["auth", "ocr"]);
  assert.equal(f.calls[0][1], "https://authfor.com/api/v1/verify");
  assert.equal(f.calls[1][1], "https://internal/extract-text");
});
test("approved excerpt calls Filmline with bounded premise and omits executable HTML", async () => {
  const f = fixture();
  const result = await handle(request("/api/storyboard", JSON.stringify({ excerpt: "A letter arrives.", approved: true })), f.env, f.auth);
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls.map(c => c[0]), ["auth", "storyboard"]);
  assert.ok(JSON.parse(f.calls[1][2].body).premise.length <= 1000);
  const output = await result.json();
  assert.equal(output.human_review_required, true);
  assert.equal(output.page_html, undefined);
});
for (const [name, change, status] of [
  ["disabled", f => { f.env.CANARY_ENABLED = "false"; }, 503],
  ["no allowlist", f => { f.env.CANARY_ALLOWED_EMAILS = ""; }, 503],
  ["wrong identity", f => { f.env.CANARY_ALLOWED_EMAILS = "other@example.com"; }, 403],
  ["auth down", f => { f.auth = async () => new Response("down", { status: 503 }); }, 502],
  ["invalid identity", f => { f.auth = async () => new Response("expired", { status: 401 }); }, 401],
  ["OCR down", f => { f.env.OCR_SERVICE.fetch = async () => { throw new Error("unavailable"); }; }, 502],
  ["missing OCR", f => { delete f.env.OCR_SERVICE; }, 503],
  ["blank OCR", f => { f.env.OCR_SERVICE.fetch = async () => reply({ pages: [{ text: "" }] }); }, 422],
]) test(name, async () => {
  const f = fixture(); change(f);
  assert.equal((await handle(request("/api/source-text", "%PDF-1.4\nfixture"), f.env, f.auth)).status, status);
});
test("missing bearer rejected without any provider call", async () => {
  const f = fixture();
  assert.equal((await handle(request("/api/source-text", "%PDF-", { Authorization: "" }), f.env, f.auth)).status, 401);
  assert.equal(f.calls.length, 0);
});
test("oversize PDF without content-length rejected before provider call", async () => {
  const f = fixture();
  const result = await handle(request("/api/source-text", "%PDF-" + "x".repeat(2 * 1024 * 1024)), f.env, f.auth);
  assert.equal(result.status, 413);
  assert.equal(f.calls.length, 0);
});
test("unapproved or overlong excerpt cannot silently generate", async () => {
  const f = fixture();
  for (const body of [{ excerpt: "Hello" }, { excerpt: "x".repeat(851), approved: true }, null]) {
    assert.equal((await handle(request("/api/storyboard", JSON.stringify(body)), f.env, f.auth)).status, 400);
  }
  assert.equal(f.calls.length, 0);
});
test("malformed Filmline output fails rather than fabricating a storyboard", async () => {
  const f = fixture(); f.env.FILMLINE_VIDEO.fetch = async () => reply({ title: "missing scenes" });
  assert.equal((await handle(request("/api/storyboard", JSON.stringify({ excerpt: "Hello", approved: true })), f.env, f.auth)).status, 502);
});
test("actual Filmline renderer integrates with canary; inference is explicitly stubbed", async () => {
  const f = fixture();
  f.env.FILMLINE_VIDEO.fetch = (url, options) => filmline.fetch(new Request(url, options), {
    STORY_ENGINE: { fetch: async (url, options) => {
      assert.equal(url, "https://filmline.cc/api/story-treatment");
      assert.ok(JSON.parse(options.body).premise.includes("lighthouse"));
      return reply({ parsed: { title: "The Letter", logline: "An isolated keeper receives news.", scenes: [{ description: "A lighthouse at dusk." }] } });
    } },
  });
  const response = await handle(request("/api/storyboard", JSON.stringify({ excerpt: "A lighthouse keeper receives a letter.", approved: true })), f.env, f.auth);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.video.svg.includes("<animate"));
  assert.equal(result.video.format, "animated-svg-storyboard");
  assert.equal(result.page_html, undefined);
});
test("oversized provider response fails closed", async () => {
  const f = fixture(); f.env.OCR_SERVICE.fetch = async () => reply({ pages: [{ text: "x".repeat(600000) }] });
  assert.equal((await handle(request("/api/source-text", "%PDF-"), f.env, f.auth)).status, 502);
});
test("unknown routes and methods do not reach providers", async () => {
  const f = fixture();
  assert.equal((await handle(new Request("https://canary.invalid/api/storyboard"), f.env, f.auth)).status, 405);
  assert.equal((await handle(new Request("https://canary.invalid/"), f.env, f.auth)).status, 404);
  assert.equal(f.calls.length, 0);
});
