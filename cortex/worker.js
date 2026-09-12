import { HttpError, json, readJson } from '../worker/common.js';
import { schemas } from './schemas.js';

// Binding-only gateway. Localhost inside a Cloudflare Worker is not the Mac.
// The observed tunnel forwards this HTTPS host to llama-server :18087.
export async function handle(request, env, transport = fetch) {
  if (new URL(request.url).pathname !== '/v1/chat/completions' || request.method !== 'POST') return json({ error: 'Not found' }, 404);
  try {
    if (!env.LLAMA_ACCESS_CLIENT_ID || !env.LLAMA_ACCESS_CLIENT_SECRET) throw new HttpError(503, 'Local Qwen gateway credentials not configured');
    const body = await readJson(request, 64000);
    if (!Array.isArray(body.messages) || body.messages.length !== 2 || body.messages[0]?.role !== 'system' || body.messages[1]?.role !== 'user' ||
      body.messages.some(m => typeof m.content !== 'string') || body.messages.reduce((n, m) => n + m.content.length, 0) > 24000 ||
      !Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 3200 || !Object.hasOwn(schemas, body.output_schema)) throw new HttpError(422, 'Unsupported inference request');
    const response = await transport('https://llama.mobleysoft.com/v1/chat/completions', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(140000),
      headers: { 'Content-Type': 'application/json', 'CF-Access-Client-Id': env.LLAMA_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.LLAMA_ACCESS_CLIENT_SECRET },
      body: JSON.stringify({ messages: body.messages, max_tokens: body.max_tokens, temperature: 0.2, chat_template_kwargs: { enable_thinking: false },
        response_format: { type: 'json_object', schema: schemas[body.output_schema] } }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'Local Qwen unavailable; no paid API fallback'); }
    const result = await readJson(response, 128000);
    if (result.choices?.[0]?.finish_reason !== 'stop' || typeof result.choices[0].message?.content !== 'string') throw new HttpError(502, 'Local Qwen response incomplete');
    return json({ choices: [{ message: { role: 'assistant', content: result.choices[0].message.content }, finish_reason: 'stop' }],
      model: result.model || 'local-qwen', usage: result.usage });
  } catch (error) { return json({ error: error instanceof HttpError ? error.message : 'Local Qwen request failed' }, error instanceof HttpError ? error.status : 502); }
}
export default { fetch: (request, env) => handle(request, env) };
