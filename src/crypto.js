// All encryption is local. Keys never leave the device; sync and backups carry ciphertext only.
const te = new TextEncoder(), td = new TextDecoder();

export const b64 = u8 => btoa(String.fromCharCode(...u8));
export const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const randHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
export const hexToBytes = h => Uint8Array.from(h.match(/.{2}/g).map(x => parseInt(x, 16)));

export async function kekFromPass(pass, salt) {
  const km = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256'}, km, 256);
  return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
// legacy (v2-era): data key derived directly from the passphrase
export async function legacyKey(pass, salt) {
  const km = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256'}, km,
    {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
export const importAes = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

export async function aesEncrypt(key, u8) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, u8);
  return b64(iv) + '.' + b64(new Uint8Array(ct));
}
export async function aesDecrypt(key, str) {
  const [iv, ct] = str.split('.');
  return new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(iv)}, key, unb64(ct)));
}
export const encJson = (key, obj) => aesEncrypt(key, te.encode(JSON.stringify(obj)));
export const decJson = async (key, str) => JSON.parse(td.decode(await aesDecrypt(key, str)));

export async function sha256hex(str) {
  const h = await crypto.subtle.digest('SHA-256', te.encode(str));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
