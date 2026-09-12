export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const json = (data, status = 200) => Response.json(data, { status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
} });
export async function bytes(message, limit) {
  if (Number(message.headers.get('Content-Length')) > limit) throw new HttpError(413, 'Payload exceeds limit');
  const reader = message.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0; const parts = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, 'Payload exceeds limit'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
export async function readJson(message, limit = 128 * 1024) {
  const data = await bytes(message, limit);
  try { return JSON.parse(new TextDecoder().decode(data)); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}
export async function provider(binding, path, body, headers = {}) {
  if (!binding?.fetch) throw new HttpError(503, 'Required service binding is not configured');
  let response;
  try {
    response = await binding.fetch(`https://internal${path}`, { method: 'POST', headers: {
      'Content-Type': 'application/json', ...headers }, body: body instanceof Uint8Array ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(150000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Provider rejected request'); }
    return await readJson(response);
  } catch { throw new HttpError(502, 'Shared service failed or timed out; checkpoint retained'); }
}
export const validText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
