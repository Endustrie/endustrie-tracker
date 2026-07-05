// Binary helpers for large encrypted payloads (uploaded audio).
// Stride-based base64 conversion — a naive spread overflows the stack on MB-sized buffers.
export function bufToB64(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(out);
}
export function b64ToBuf(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
export const CHUNK_BYTES = 1.5 * 1024 * 1024;
export function splitChunks(u8, size = CHUNK_BYTES) {
  const out = [];
  for (let i = 0; i < u8.length; i += size) out.push(u8.subarray(i, i + size));
  return out.length ? out : [u8];
}
export function joinChunks(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
