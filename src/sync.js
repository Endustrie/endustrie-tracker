// E2EE sync against Supabase. Every payload is client-side ciphertext under a
// random capability id; RLS only exposes rows whose id is presented in X-Sync-Id.
const BASE = 'https://uasdqqatbrufdnyunilf.supabase.co/rest/v1';
const KEY = 'sb_publishable_WxmGNRaAl3-9CpPNyHyvKA_R0bPkIyq';
const KEEP_VERSIONS = 10;

const headers = id => ({apikey: KEY, 'X-Sync-Id': id, 'Content-Type': 'application/json'});
async function req(method, path, id, body, extra) {
  const r = await fetch(`${BASE}/${path}`, {method, headers: {...headers(id), ...extra}, body: body ? JSON.stringify(body) : undefined});
  if (!r.ok) throw new Error(`sync ${method} ${path.split('?')[0]}: ${r.status}`);
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

/* Pick which old versions to drop, keeping the newest KEEP_VERSIONS. Pure, for tests. */
export function pruneList(vers, keep = KEEP_VERSIONS) {
  return [...vers].sort((a, b) => b - a).slice(keep);
}

export async function pushVersion(id, {salt, wrapped_key, ciphertext}) {
  const ver = Date.now();
  await req('POST', 'endustrie_sync_v2', id, {sync_id: id, ver, salt, wrapped_key, ciphertext});
  const rows = await req('GET', `endustrie_sync_v2?sync_id=eq.${id}&select=ver`, id);
  const drop = pruneList(rows.map(r => r.ver));
  if (drop.length) await req('DELETE', `endustrie_sync_v2?sync_id=eq.${id}&ver=in.(${drop.join(',')})`, id);
  return ver;
}
export async function pullLatest(id) {
  const rows = await req('GET', `endustrie_sync_v2?sync_id=eq.${id}&select=*&order=ver.desc&limit=1`, id);
  if (rows[0]) return rows[0];
  // fall back to the v1 single-row table (pre-versioning clients)
  const legacy = await req('GET', `endustrie_sync?sync_id=eq.${id}&select=*`, id);
  return legacy[0] ? {...legacy[0], ver: 0} : null;
}
export const listVersions = id =>
  req('GET', `endustrie_sync_v2?sync_id=eq.${id}&select=ver,created_at&order=ver.desc&limit=${KEEP_VERSIONS}`, id);
export async function pullVersion(id, ver) {
  const rows = await req('GET', `endustrie_sync_v2?sync_id=eq.${id}&ver=eq.${ver}&select=*`, id);
  return rows[0] || null;
}

/* attachments: content-addressed encrypted blobs */
export const listRemoteAtt = id =>
  req('GET', `endustrie_sync_att?sync_id=eq.${id}&select=hash`, id).then(rows => rows.map(r => r.hash));
export const pushAtt = (id, hash, ciphertext) =>
  req('POST', 'endustrie_sync_att', id, {sync_id: id, hash, ciphertext});
export const pullAtt = async (id, hash) => {
  const rows = await req('GET', `endustrie_sync_att?sync_id=eq.${id}&hash=eq.${hash}&select=ciphertext`, id);
  return rows[0]?.ciphertext || null;
};
export const deleteAtt = (id, hashes) =>
  hashes.length ? req('DELETE', `endustrie_sync_att?sync_id=eq.${id}&hash=in.(${hashes.map(h => `"${h}"`).join(',')})`, id) : null;

/* read-only shares (key rides in the URL fragment; server sees ciphertext only) */
export const pushShare = (id, ciphertext) =>
  req('POST', 'endustrie_shares?on_conflict=share_id', id,
      {share_id: id, ciphertext, updated_at: new Date().toISOString()}, {'Prefer': 'resolution=merge-duplicates'});
export const pullShare = async id => {
  const rows = await req('GET', `endustrie_shares?share_id=eq.${id}&select=ciphertext,updated_at`, id);
  return rows[0] || null;
};
export const deleteShare = id => req('DELETE', `endustrie_shares?share_id=eq.${id}`, id);

export async function deleteAll(id) {
  await req('DELETE', `endustrie_sync_v2?sync_id=eq.${id}`, id).catch(() => {});
  await req('DELETE', `endustrie_sync_att?sync_id=eq.${id}`, id).catch(() => {});
  await req('DELETE', `endustrie_sync?sync_id=eq.${id}`, id).catch(() => {});
}
