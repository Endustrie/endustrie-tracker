import './styles.css';
import {b64, unb64, randHex, kekFromPass, importAes, aesEncrypt, aesDecrypt, encJson, decJson, sha256hex} from './crypto.js';
import {dbOpen, dbGet, dbSet, dbDel, dbKeys} from './db.js';
import * as SY from './sync.js';
import {STAGES, stageIdx, stageLabel, newState, upgrade, referencedAtts} from './store.js';
import {importWorkbook} from './xlsx.js';
import EXAMPLE from './example.js';

/* ================= helpers ================= */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const money = n => '$' + n.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const KEYS = ['', 'C', 'Cm', 'Db', 'Dbm', 'D', 'Dm', 'Eb', 'Ebm', 'E', 'Em', 'F', 'Fm', 'Gb', 'Gbm', 'G', 'Gm', 'Ab', 'Abm', 'A', 'Am', 'Bb', 'Bbm', 'B', 'Bm'];
const EXP_CATS = ['Hotel', 'Airfare', 'Baggage Fees', 'Car Monthly', 'Car Rental', 'Gas/Tolls/Parking', 'Taxis', 'Meals', 'Wardrobe', 'Hair/Makeup', 'Laundry', 'Video Production', 'Photography Production', 'Models', 'Entertaining Clients', 'Marketing', 'Rehearsal Fees', 'Venue Fees', 'New Equipment', 'Equipment Upkeep', 'Equipment Rentals', 'Equipment Repairs'];
const PAY_TYPES = ['Personal Card', 'Company Card', 'Cash', 'Check', 'Other'];
const REV_CATS = ['Performances', 'Streaming', 'Merch', 'Features', 'Photography', 'Modeling', 'Sync Licensing', 'Sponsors'];
const QTRS = ['Qtr 1', 'Qtr 2', 'Qtr 3', 'Qtr 4'];

/* ================= session & persistence ================= */
let profiles = [], session = null, state = null, lastBlob = null;
const attCache = new Map(); // ref -> dataUri (decrypted)

let saveChain = Promise.resolve();
function persist() {
  if (!session) return;
  const snap = JSON.stringify(state);
  saveChain = saveChain.then(async () => {
    lastBlob = await encJson(session.masterKey, JSON.parse(snap));
    await dbSet('blob:' + session.profile.id, lastBlob);
  }).catch(e => console.error('save failed', e));
  scheduleSync();
}
const flush = () => saveChain;

async function attPut(dataUri) {
  const ref = (await sha256hex(dataUri)).slice(0, 32);
  if (!attCache.has(ref)) {
    await dbSet(`att:${session.profile.id}:${ref}`, await aesEncrypt(session.masterKey, new TextEncoder().encode(dataUri)));
    attCache.set(ref, dataUri);
  }
  return ref;
}
const attGet = ref => attCache.get(ref) || null;
async function loadAtts() {
  attCache.clear();
  for (const k of await dbKeys(`att:${session.profile.id}:`)) {
    try {
      const u8 = await aesDecrypt(session.masterKey, await dbGet(k));
      attCache.set(k.split(':')[2], new TextDecoder().decode(u8));
    } catch (e) {}
  }
}
async function gcAtts() {
  const refs = referencedAtts(state);
  for (const ref of [...attCache.keys()]) {
    if (!refs.has(ref)) { attCache.delete(ref); await dbDel(`att:${session.profile.id}:${ref}`); }
  }
}
/* apply an upgrade() result: store returned inline attachments, fix temp refs */
async function applyUpgrade(up) {
  state = up.state;
  for (const att of up.attachments) {
    const real = await attPut(att.dataUri);
    state.songs.forEach(s => { if (s.artRef === att.ref) s.artRef = real; });
    state.reports.forEach(r => r.items.forEach(it => { if (it.receiptRef === att.ref) it.receiptRef = real; }));
  }
}
const saveProfiles = () => dbSet('profiles', profiles);
function backupEnvelope() {
  return {app: 'endustrie-tracker', v: 4, kind: 'encrypted', name: session.profile.name,
          salt: session.profile.salt, wrapped_key: session.profile.wrappedPass, ciphertext: lastBlob,
          attachments: Object.fromEntries([...referencedAtts(state)].map(r => [r, null]))};
}

/* undo */
const undoStack = [];
function pushUndo() {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 40) undoStack.shift();
  $('#undoBtn').disabled = false;
}
function doUndo() {
  const s = undoStack.pop();
  if (!s) return;
  state = JSON.parse(s);
  $('#undoBtn').disabled = !undoStack.length;
  persist(); renderAll();
}

/* ================= sync orchestration ================= */
let syncTimer = null;
function scheduleSync() {
  if (!state?.settings?.sync?.enabled) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncAll().catch(() => setSyncDot('err')), 2500);
}
async function syncAll() {
  const sy = state.settings.sync;
  if (!sy.enabled) return;
  await flush();
  await SY.pushVersion(sy.id, {salt: session.profile.salt, wrapped_key: session.profile.wrappedPass, ciphertext: lastBlob});
  // attachments: upload missing, drop remote strays
  const refs = referencedAtts(state);
  const remote = new Set(await SY.listRemoteAtt(sy.id));
  for (const ref of refs) {
    if (!remote.has(ref)) {
      const ct = await dbGet(`att:${session.profile.id}:${ref}`);
      if (ct) await SY.pushAtt(sy.id, ref, ct);
    }
  }
  await SY.deleteAtt(sy.id, [...remote].filter(h => !refs.has(h)));
  state.settings.sync.lastAt = new Date().toISOString();
  setSyncDot('on');
  renderSettings();
}
async function pullRemoteAtts(syncId) {
  for (const ref of referencedAtts(state)) {
    if (attCache.has(ref)) continue;
    const ct = await SY.pullAtt(syncId, ref).catch(() => null);
    if (ct) {
      await dbSet(`att:${session.profile.id}:${ref}`, ct);
      try {
        const u8 = await aesDecrypt(session.masterKey, ct);
        attCache.set(ref, new TextDecoder().decode(u8));
      } catch (e) {}
    }
  }
}
function setSyncDot(mode) {
  const d = $('#syncDot');
  d.className = 'syncdot' + (mode === 'on' ? ' on' : mode === 'err' ? ' err' : '');
  d.title = mode === 'on' ? 'Synced' : mode === 'err' ? 'Sync error (retries on next change)' : 'Sync off';
}

/* ================= lock screen ================= */
let lockMode = 'unlock', lockTarget = null;
const THROTTLE_KEY = 'endustrie-unlock-throttle';
function throttled() {
  try {
    const t = JSON.parse(localStorage.getItem(THROTTLE_KEY)) || {};
    return t.until && Date.now() < t.until ? Math.ceil((t.until - Date.now()) / 1000) : 0;
  } catch (e) { return 0; }
}
function noteFail() {
  let t;
  try { t = JSON.parse(localStorage.getItem(THROTTLE_KEY)) || {n: 0}; } catch (e) { t = {n: 0}; }
  t.n = (t.n || 0) + 1;
  if (t.n >= 5) { t.until = Date.now() + 30000; t.n = 0; }
  localStorage.setItem(THROTTLE_KEY, JSON.stringify(t));
}
const clearFails = () => localStorage.removeItem(THROTTLE_KEY);

function renderProfiles() {
  $('#profileList').innerHTML = profiles.length
    ? profiles.map(p => `<button class="profilebtn" data-pid="${p.id}" type="button">
        <span>${esc(p.name)}</span>
        <span class="del" data-delp="${p.id}" title="Delete profile">×</span></button>`).join('')
    : '<p class="sub" style="margin:0">No profiles yet — create one to begin.</p>';
}
function showPassPanel(title, opts = {}) {
  $('#lockChoose').hidden = true; $('#lockPass').hidden = false;
  $('#lockPassTitle').textContent = title;
  $('#npName').hidden = !opts.name; $('#passConfirm').hidden = !opts.confirm;
  $('#syncIdInput').hidden = !opts.syncId;
  $('#touchIdBtn').hidden = !opts.touchId;
  $('#lockErr').textContent = '';
  ['#npName', '#passInput', '#passConfirm', '#syncIdInput'].forEach(s => $(s).value = '');
  (opts.syncId ? $('#syncIdInput') : opts.name ? $('#npName') : $('#passInput')).focus();
}
function bindLock() {
  $('#profileList').addEventListener('click', async e => {
    const delId = e.target.dataset.delp;
    if (delId) {
      e.stopPropagation();
      if (confirm('Delete this profile and ALL its data? This cannot be undone.') && confirm('Really delete?')) {
        profiles = profiles.filter(p => p.id !== delId);
        await saveProfiles();
        await dbDel('blob:' + delId);
        for (const k of await dbKeys(`att:${delId}:`)) await dbDel(k);
        renderProfiles();
      }
      return;
    }
    const btn = e.target.closest('[data-pid]');
    if (!btn) return;
    lockTarget = profiles.find(p => p.id === btn.dataset.pid);
    lockMode = 'unlock';
    showPassPanel('Passphrase for ' + lockTarget.name, {touchId: !!lockTarget.wrappedPrf && !!window.PublicKeyCredential});
  });
  $('#newProfileBtn').addEventListener('click', () => { lockMode = 'create'; showPassPanel('Create profile', {name: true, confirm: true}); });
  $('#restoreSyncBtn').addEventListener('click', () => { lockMode = 'sync'; showPassPanel('Restore from sync', {syncId: true}); });
  $('#restoreBackupBtn').addEventListener('click', () => $('#lockBackupFile').click());
  $('#lockBackupFile').addEventListener('change', () => {
    const f = $('#lockBackupFile').files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const env = JSON.parse(rd.result);
        if (env.app !== 'endustrie-tracker' || env.kind !== 'encrypted') throw 0;
        lockMode = 'backup'; lockTarget = env;
        showPassPanel('Passphrase for backup of ' + (env.name || 'profile'));
      } catch (e) { alert('Not a valid encrypted backup file.'); }
    };
    rd.readAsText(f);
    $('#lockBackupFile').value = '';
  });
  $('#lockBack').addEventListener('click', () => { $('#lockPass').hidden = true; $('#lockChoose').hidden = false; });
  ['#passInput', '#passConfirm', '#syncIdInput'].forEach(s =>
    $(s).addEventListener('keydown', e => { if (e.key === 'Enter') $('#unlockBtn').click(); }));
  $('#unlockBtn').addEventListener('click', () => {
    const wait = throttled();
    if (wait) { $('#lockErr').textContent = `Too many attempts — wait ${wait}s.`; return; }
    attemptUnlock().catch(e => {
      if (!e.userMsg) noteFail();
      $('#lockErr').textContent = e.userMsg || 'Wrong passphrase.';
    });
  });
  $('#touchIdBtn').addEventListener('click', () => touchIdUnlock().catch(() => { $('#lockErr').textContent = 'Touch ID failed — use your passphrase.'; }));
  $('#lockNow').addEventListener('click', () => location.reload());
}
async function attemptUnlock() {
  const pass = $('#passInput').value;
  const fail = msg => { const e = new Error(msg); e.userMsg = msg; throw e; };
  if (!pass) fail('Enter a passphrase.');

  if (lockMode === 'create') {
    const name = $('#npName').value.trim();
    if (!name) fail('Give the profile a name.');
    if (profiles.some(p => p.name.toLowerCase() === name.toLowerCase())) fail('That name is taken.');
    if (pass.length < 8) fail('Passphrase must be at least 8 characters.');
    if (pass !== $('#passConfirm').value) fail('Passphrases don’t match.');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const master = crypto.getRandomValues(new Uint8Array(32));
    const kek = await kekFromPass(pass, salt);
    const profile = {id: 'p' + randHex(6), name, salt: b64(salt), wrappedPass: await aesEncrypt(kek, master)};
    profiles.push(profile); await saveProfiles();
    sessionMasterRaw = master;
    session = {profile, masterKey: await importAes(master)};
    state = newState(); state.profileName = name;
    persist();
  } else if (lockMode === 'unlock') {
    const kek = await kekFromPass(pass, unb64(lockTarget.salt));
    const master = await aesDecrypt(kek, lockTarget.wrappedPass);
    sessionMasterRaw = master;
    session = {profile: lockTarget, masterKey: await importAes(master)};
    lastBlob = await dbGet('blob:' + lockTarget.id);
    await loadAtts();
    if (lastBlob) {
      await applyUpgrade(upgrade(await decJson(session.masterKey, lastBlob)));
    } else state = Object.assign(newState(), {profileName: lockTarget.name});
    persist();
    await maybePullNewer();
  } else if (lockMode === 'sync') {
    const id = $('#syncIdInput').value.trim();
    if (!/^[0-9a-f]{32,64}$/i.test(id)) fail('That doesn’t look like a Sync ID.');
    let row;
    try { row = await SY.pullLatest(id); } catch (e) { fail('Could not reach sync — are you online?'); }
    if (!row) fail('No data found for that Sync ID.');
    const kek = await kekFromPass(pass, unb64(row.salt));
    const master = await aesDecrypt(kek, row.wrapped_key);
    sessionMasterRaw = master;
    const masterKey = await importAes(master);
    const raw = await decJson(masterKey, row.ciphertext);
    const profile = {id: 'p' + randHex(6), name: raw.profileName || 'Restored', salt: row.salt, wrapped_key: undefined, wrappedPass: row.wrapped_key};
    profiles.push(profile); await saveProfiles();
    session = {profile, masterKey};
    await applyUpgrade(upgrade(raw));
    state.settings.sync = {enabled: true, id, lastAt: new Date(row.ver || Date.now()).toISOString()};
    await pullRemoteAtts(id);
    persist();
  } else if (lockMode === 'backup') {
    const env = lockTarget;
    const kek = await kekFromPass(pass, unb64(env.salt));
    const master = await aesDecrypt(kek, env.wrapped_key);
    sessionMasterRaw = master;
    const masterKey = await importAes(master);
    const raw = await decJson(masterKey, env.ciphertext);
    const profile = {id: 'p' + randHex(6), name: env.name || raw.profileName || 'Restored', salt: env.salt, wrappedPass: env.wrapped_key};
    profiles.push(profile); await saveProfiles();
    session = {profile, masterKey};
    // restore embedded encrypted attachments before upgrading (refs must resolve)
    for (const [ref, ct] of Object.entries(env.attachments || {})) {
      if (!ct) continue;
      await dbSet(`att:${profile.id}:${ref}`, ct);
      try {
        const u8 = await aesDecrypt(masterKey, ct);
        attCache.set(ref, new TextDecoder().decode(u8));
      } catch (e) {}
    }
    await applyUpgrade(upgrade(raw));
    if (state.settings.sync?.enabled) await pullRemoteAtts(state.settings.sync.id).catch(() => {});
    persist();
  }
  clearFails();
  finishUnlock();
}
async function maybePullNewer() {
  const sy = state.settings?.sync;
  if (!sy?.enabled || !sy.id) return;
  try {
    const row = await SY.pullLatest(sy.id);
    if (row && sy.lastAt && new Date(row.ver).toISOString() > sy.lastAt &&
        confirm('A newer copy of your data exists in sync (from another device). Use it?')) {
      await applyUpgrade(upgrade(await decJson(session.masterKey, row.ciphertext)));
      state.settings.sync.lastAt = new Date(row.ver).toISOString();
      await pullRemoteAtts(sy.id);
      persist();
    }
    setSyncDot('on');
  } catch (e) { setSyncDot('err'); }
}
function finishUnlock() {
  $('#lock').style.display = 'none';
  $('#whoAmI').textContent = session.profile.name;
  setSyncDot(state.settings?.sync?.enabled ? 'on' : 'off');
  startApp();
}

/* Touch ID (WebAuthn PRF) */
let sessionMasterRaw = null;
const PRF_SALT = new TextEncoder().encode('endustrie-tracker-prf-v1'.padEnd(32, '.'));
async function prfSupported() {
  try {
    return isSecureContext && !!window.PublicKeyCredential &&
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (e) { return false; }
}
async function prfKek(credId) {
  const cred = await navigator.credentials.get({publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: credId ? [{id: unb64(credId), type: 'public-key'}] : [],
    userVerification: 'required',
    extensions: {prf: {eval: {first: PRF_SALT}}},
  }});
  const out = cred.getClientExtensionResults()?.prf?.results?.first;
  if (!out) throw new Error('authenticator lacks PRF support');
  return importAes(new Uint8Array(out).slice(0, 32));
}
async function enableTouchId() {
  const cred = await navigator.credentials.create({publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: {name: 'Endustrie Tracker'},
    user: {id: crypto.getRandomValues(new Uint8Array(16)), name: session.profile.name, displayName: session.profile.name},
    pubKeyCredParams: [{alg: -7, type: 'public-key'}, {alg: -257, type: 'public-key'}],
    authenticatorSelection: {authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred'},
    extensions: {prf: {}},
  }});
  const credId = b64(new Uint8Array(cred.rawId));
  const kek = await prfKek(credId);
  if (!sessionMasterRaw) throw new Error('master key unavailable — unlock with your passphrase first');
  session.profile.wrappedPrf = await aesEncrypt(kek, sessionMasterRaw);
  session.profile.credId = credId;
  await saveProfiles();
  alert('Touch ID unlock enabled for this profile on this device.');
}
async function touchIdUnlock() {
  const kek = await prfKek(lockTarget.credId);
  const master = await aesDecrypt(kek, lockTarget.wrappedPrf);
  sessionMasterRaw = master;
  session = {profile: lockTarget, masterKey: await importAes(master)};
  lastBlob = await dbGet('blob:' + lockTarget.id);
  await loadAtts();
  if (lastBlob) await applyUpgrade(upgrade(await decJson(session.masterKey, lastBlob)));
  else state = Object.assign(newState(), {profileName: lockTarget.name});
  await maybePullNewer();
  clearFails();
  finishUnlock();
}

/* ================= derived helpers ================= */
const isBlocked = s => !!s.stems && !/received|not needed|^n\/?a\.?$/i.test(s.stems);
const hasVideo = s => s.stage === 'video';
const hasNotes = s => !!s.notes;
const isIncomplete = s => !s.key || !s.bpm || !s.length || !s.exportDate;
const byId = id => state.songs.find(s => s.id === id);
const parseLen = t => { const m = /^(\d+):([0-5]\d)$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : 0; };
const fmtLen = sec => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
const reportTotal = r => r.items.reduce((a, i) => a + i.amt, 0);
const allExpenses = () => state.reports.flatMap(r => r.items);
const revenueTotal = () => Object.values(state.revenue).reduce((a, v) => a + Number(v || 0), 0);

/* ================= boot ================= */
let appStarted = false, nudgeHidden = false;
function startApp() {
  if (appStarted) { renderAll(); return; }
  appStarted = true;
  bindChrome(); bindSongs(); bindEditor(); bindAlbum(); bindFinance(); bindSettings(); bindAudio(); bindSetup(); bindPeople();
  renderAll(); initAutoLock();
  prfSupported().then(ok => {
    if (ok) { $('#touchIdRow').hidden = false;
      if (session.profile.wrappedPrf) $('#touchIdEnable').textContent = 'Re-enroll Touch ID'; }
  });
  if ('showDirectoryPicker' in window) $('#audioFolderBtn').hidden = false;
  restoreAudioDir();
}
function renderAll() {
  renderDash(); renderSongs(); renderQueue(); renderAlbum(); renderFinance(); renderSettings(); renderPeople();
}

/* ================= setup (first run) ================= */
function bindSetup() {
  $('#setupImport').addEventListener('click', () => $('#setupFile').click());
  $('#setupFile').addEventListener('change', async () => {
    const f = $('#setupFile').files[0];
    $('#setupFile').value = '';
    if (!f) return;
    try {
      const data = await importWorkbook(await f.arrayBuffer());
      if (!data.songs.length) throw new Error('no songs found in Project Status sheet');
      pushUndo();
      state.songs = data.songs.map((s, i) => ({id: 's' + i, ...s}));
      state.artists = data.artists; state.pocs = data.pocs;
      state.social = data.social; state.marketing = data.marketing;
      state.albumTitle = data.albumTitle || state.albumTitle || null;
      state.setupDone = true;
      delete state.needsPeopleImport;
      persist(); renderAll();
    } catch (e) { alert('Import failed: ' + e.message); }
  });
  $('#setupExample').addEventListener('click', () => {
    state.songs = EXAMPLE.songs.map((s, i) => ({id: 's' + i, ...s}));
    state.artists = structuredClone(EXAMPLE.artists);
    state.pocs = structuredClone(EXAMPLE.pocs);
    state.social = structuredClone(EXAMPLE.social);
    state.marketing = structuredClone(EXAMPLE.marketing);
    state.albumTitle = EXAMPLE.albumTitle;
    state.setupDone = true;
    persist(); renderAll();
  });
  $('#setupEmpty').addEventListener('click', () => { state.setupDone = true; persist(); renderAll(); });
}

/* ================= chrome ================= */
function bindChrome() {
  const burger = $('#burger'), tabnav = $('#tabnav'), backdrop = $('#menuBackdrop');
  const closeMenu = () => { tabnav.classList.remove('open'); backdrop.hidden = true; burger.setAttribute('aria-expanded', 'false'); };
  burger.addEventListener('click', () => {
    const open = tabnav.classList.toggle('open');
    backdrop.hidden = !open;
    burger.setAttribute('aria-expanded', String(open));
  });
  backdrop.addEventListener('click', closeMenu);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeMenu(); closeModal(); $('#lightbox').hidden = true; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) {
      e.preventDefault(); doUndo();
    }
  });
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', b === btn));
      document.querySelectorAll('main > section').forEach(sec => sec.hidden = sec.id !== 'tab-' + btn.dataset.tab);
      closeMenu();
    });
  });
  $('#undoBtn').addEventListener('click', doUndo);
}
let lastActivity = Date.now();
function initAutoLock() {
  ['pointerdown', 'keydown', 'scroll'].forEach(ev => document.addEventListener(ev, () => lastActivity = Date.now(), {passive: true}));
  setInterval(() => {
    const min = state?.settings?.autoLockMin || 0;
    if (min && Date.now() - lastActivity > min * 60000) location.reload();
  }, 15000);
}

/* ================= dashboard ================= */
function renderDash() {
  const setup = !state.setupDone;
  $('#setupPanel').hidden = !setup;
  $('#dashContent').hidden = setup;
  if (setup) return;
  const last = state.settings.lastBackupAt;
  $('#backupNudge').hidden = nudgeHidden || (last && Date.now() - new Date(last).getTime() < 30 * 86400000);
  $('#peopleNudge').hidden = !state.needsPeopleImport;
  const songs = state.songs, total = songs.length;
  $('#songTotal').textContent = total;
  if (state.albumTitle) $('#subline').innerHTML = 'Album <b>' + esc(state.albumTitle) + '</b> · <span id="songTotal">' + total + '</span> tracks';
  const counts = Object.fromEntries(STAGES.map(([k]) => [k, songs.filter(s => s.stage === k).length]));
  $('#pipeBar').innerHTML = STAGES.map(([k, l, c]) =>
    counts[k] ? `<div style="background:${c};flex:${counts[k]}" title="${l}: ${counts[k]}">${counts[k]}</div>` : '').join('');
  $('#pipeLegend').innerHTML = STAGES.map(([k, l, c]) =>
    `<span><span class="sw" style="background:${c}"></span>${l} · ${counts[k]}</span>`).join('');
  const exportedPlus = songs.filter(s => stageIdx(s.stage) >= 3).length;
  const blocked = songs.filter(isBlocked), pending = songs.filter(s => stageIdx(s.stage) < 3);
  const openNotes = songs.filter(s => hasNotes(s) && !hasVideo(s)), vids = songs.filter(hasVideo);
  $('#statCards').innerHTML = [
    ['hot', total, 'Tracks in catalog'],
    ['ok', exportedPlus, 'Exported or beyond'],
    ['warn', pending.length, 'Still in production'],
    ['warn', blocked.length, 'Blocked on stems'],
    ['', openNotes.length, 'Open prod. notes'],
    ['ok', vids.length, 'Videos done'],
  ].map(([cls, n, l]) => `<div class="card ${cls}"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
  const pct = total ? exportedPlus / total * 100 : 0;
  $('#progLabel').textContent = `${exportedPlus} / ${total} — ${Math.round(pct)}%`;
  requestAnimationFrame(() => { $('#progBar').style.width = pct + '%'; });
  const rev = revenueTotal(), exp = allExpenses().reduce((a, i) => a + i.amt, 0), net = rev - exp;
  $('#moneyCards').innerHTML = [
    ['ok', money(rev), 'Revenue (year)'],
    ['warn', money(exp), 'Expenses (all reports)'],
    [net >= 0 ? 'ok' : 'hot', money(net), 'Net'],
  ].map(([cls, n, l]) => `<div class="card ${cls}"><div class="n money">${n}</div><div class="l">${l}</div></div>`).join('');
  const li = (s, why) => `<li class="clickable" data-open="${s.id}"><span class="song">${esc(s.title)}</span><span class="why">${esc(why)}</span></li>`;
  $('#cBlocked').textContent = blocked.length;
  $('#listBlocked').innerHTML = blocked.map(s => li(s, s.stems)).join('') || '<li class="why">Nothing blocked.</li>';
  $('#cPending').textContent = pending.length;
  $('#listPending').innerHTML = pending.map(s => li(s, stageLabel(s.stage) + (s.notes ? ' — ' + s.notes : ''))).join('') || '<li class="why">All exported.</li>';
  $('#cNotes').textContent = openNotes.length;
  $('#listNotes').innerHTML = openNotes.map(s => li(s, s.notes)).join('') || '<li class="why">No open notes.</li>';
  $('#cVideos').textContent = vids.length;
  $('#listVideos').innerHTML = vids.map(s => li(s, 'Working title: ' + s.title)).join('') || '<li class="why">None yet.</li>';
}
document.addEventListener('click', e => {
  const id = e.target.closest('[data-open]')?.dataset.open;
  if (id && appStarted) openSongEditor(id);
});

/* ================= songs ================= */
const FILTERS = [
  ['all', 'All', () => true],
  ['production', 'In production', s => stageIdx(s.stage) < 3],
  ['exported', 'Exported+', s => stageIdx(s.stage) >= 3],
  ['blocked', 'Stems needed', isBlocked],
  ['notes', 'Has notes', hasNotes],
  ['videos', 'Video done', hasVideo],
  ['incomplete', 'Incomplete data', isIncomplete],
];
let activeFilter = 'all', query = '', sortKey = 'title', sortDir = 1;
function bindSongs() {
  $('#songFilters').innerHTML = FILTERS.map(([id, label]) =>
    `<button class="fbtn" data-f="${id}" aria-pressed="${id === 'all'}" type="button">${label}<span class="c"></span></button>`).join('');
  document.querySelectorAll('.fbtn').forEach(b => b.addEventListener('click', () => {
    activeFilter = b.dataset.f;
    document.querySelectorAll('.fbtn').forEach(x => x.setAttribute('aria-pressed', x === b));
    renderSongs();
  }));
  $('#songSearch').addEventListener('input', e => { query = e.target.value.toLowerCase(); renderSongs(); });
  document.querySelectorAll('#songTable th.sortable').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
    document.querySelectorAll('#songTable th .arrow').forEach(a => a.textContent = '');
    th.querySelector('.arrow').textContent = sortDir > 0 ? '▲' : '▼';
    renderSongs();
  }));
  $('#addSongBtn').addEventListener('click', () => openSongEditor(null));
  $('#songBody').addEventListener('click', e => {
    if (e.target.closest('.playbtn')) { playSong(e.target.closest('tr[data-song]').dataset.song); return; }
    const tr = e.target.closest('tr[data-song]');
    if (tr) openSongEditor(tr.dataset.song);
  });
  $('#songBody').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      const tr = e.target.closest('tr[data-song]');
      if (tr) { e.preventDefault(); openSongEditor(tr.dataset.song); }
    }
  });
}
function stageChip(s) {
  const cls = {writing: 'off', recorded: 'warn', mixing: 'warn', exported: 'ok', mastered: 'ok', video: 'hot'}[s.stage] || 'off';
  let out = `<span class="chip ${cls}">${stageLabel(s.stage)}</span>`;
  if (isBlocked(s)) out += ' <span class="chip warn">Stems</span>';
  return out;
}
function artThumb(s) {
  const art = s.artRef && attGet(s.artRef);
  return art ? `<img class="thumb" src="${art}" alt="">`
             : `<span class="thumb ph" aria-hidden="true">${esc((s.title || '?')[0].toUpperCase())}</span>`;
}
function renderSongs() {
  const songs = state.songs;
  document.querySelectorAll('.fbtn').forEach(b => {
    const f = FILTERS.find(x => x[0] === b.dataset.f);
    b.querySelector('.c').textContent = songs.filter(f[2]).length;
  });
  const fn = FILTERS.find(f => f[0] === activeFilter)[2];
  let rows = songs.filter(fn);
  if (query) rows = rows.filter(s =>
    [s.title, s.finished, s.producer, s.featured, s.notes].some(v => v && v.toLowerCase().includes(query)));
  rows = [...rows].sort((a, b) => {
    if (sortKey === 'bpm') return ((a.bpm || 0) - (b.bpm || 0)) * sortDir;
    if (sortKey === 'stage') return (stageIdx(a.stage) - stageIdx(b.stage)) * sortDir;
    const va = (a[sortKey] || '').toString().toLowerCase(), vb = (b[sortKey] || '').toString().toLowerCase();
    if (!va && vb) return 1; if (va && !vb) return -1;
    return va.localeCompare(vb) * sortDir;
  });
  $('#songBody').innerHTML = rows.length ? rows.map(s => `
    <tr data-song="${s.id}" tabindex="0">
      <td><button class="playbtn ${audioFor(s) ? 'avail' : ''}" aria-label="Play" type="button">▶</button></td>
      <td><div class="titlecell">${artThumb(s)}<div><strong>${esc(s.title)}</strong>${s.finished && s.finished !== s.title ? `<span class="ft">Final: ${esc(s.finished)}</span>` : ''}</div></div></td>
      <td>${stageChip(s)}</td>
      <td class="mono">${esc(s.key || '—')}</td>
      <td class="mono">${s.bpm || '—'}</td>
      <td>${esc(s.featured || '')}</td>
      <td class="mono">${esc(s.exportDate || '—')}</td>
      <td class="mono">${esc(s.length || '—')}</td>
    </tr>`).join('') : '<tr><td colspan="8"><div class="empty">No songs yet — use “+ Add song” or import the spreadsheet in Settings.</div></td></tr>';
}

/* ================= modal (song editor + collection editor) ================= */
let editId = null, pendingArt, editColl = null;
function bindEditor() {
  $('#eKey').innerHTML = KEYS.map(k => `<option value="${k}">${k || '—'}</option>`).join('');
  $('#eStage').innerHTML = STAGES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  $('#eCancel').addEventListener('click', closeModal);
  $('#modalBack').addEventListener('click', e => { if (e.target === $('#modalBack')) closeModal(); });
  $('#eArt').addEventListener('change', () => {
    const f = $('#eArt').files[0];
    if (f) downscale(f, 320, uri => { pendingArt = uri; $('#eArtPrev').src = uri; $('#eArtPrev').classList.remove('ph'); });
  });
  $('#eArtRemove').addEventListener('click', () => { pendingArt = ''; $('#eArtPrev').removeAttribute('src'); $('#eArtPrev').classList.add('ph'); });
  $('#eSave').addEventListener('click', () => editColl ? saveCollEditor() : saveSongEditor());
  $('#eDelete').addEventListener('click', () => {
    if (editColl) {
      const {coll, idx} = editColl;
      if (idx == null || !confirm('Delete this entry?')) { closeModal(); return; }
      pushUndo();
      state[coll].splice(idx, 1);
      persist(); closeModal(); renderPeople();
      return;
    }
    if (!editId) { closeModal(); return; }
    const s = byId(editId);
    if (!confirm(`Delete "${s.title}" from the catalog?`)) return;
    pushUndo();
    state.songs = state.songs.filter(x => x.id !== editId);
    delete state.audio[editId];
    state.sequence = state.sequence.filter(x => x !== editId);
    persist(); closeModal(); renderAll();
  });
}
function downscale(file, max, cb) {
  const img = new Image();
  img.onload = () => {
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    cb(c.toDataURL('image/jpeg', .82));
  };
  img.src = URL.createObjectURL(file);
}
function openSongEditor(id) {
  editId = id; pendingArt = undefined; editColl = null;
  $('#songGrid').hidden = false; $('#collGrid').hidden = true;
  const producers = [...new Set(state.songs.map(s => s.producer).filter(Boolean))];
  const feats = [...new Set(state.artists.map(a => a.stage).concat(state.songs.map(s => s.featured)).filter(Boolean))];
  $('#dlProducers').innerHTML = producers.map(p => `<option value="${esc(p)}">`).join('');
  $('#dlFeatured').innerHTML = feats.map(f => `<option value="${esc(f)}">`).join('');
  const s = id ? byId(id) : {stage: 'writing'};
  if (id && !s) return;
  $('#mTitle').textContent = id ? 'Edit — ' + s.title : 'Add song';
  $('#eTitle').value = s.title || '';
  $('#eFinished').value = s.finished || '';
  $('#eStage').value = s.stage || 'writing';
  $('#eProducer').value = s.producer || '';
  $('#eKey').value = KEYS.includes(s.key) ? s.key : '';
  $('#eBpm').value = s.bpm || '';
  $('#eLength').value = s.length || '';
  $('#eFeatured').value = s.featured || '';
  const stemsSel = $('#eStems');
  if (s.stems && ![...stemsSel.options].some(o => o.value === s.stems)) {
    const o = document.createElement('option'); o.value = o.textContent = s.stems; stemsSel.appendChild(o);
  }
  stemsSel.value = s.stems || '';
  $('#eDate').value = s.exportDate || '';
  $('#eNotes').value = s.notes || '';
  $('#eAudio').innerHTML = '<option value="">— none linked —</option>' +
    audioFiles.map(f => `<option${state.audio[id] === f ? ' selected' : ''}>${esc(f)}</option>`).join('');
  const art = id && s.artRef ? attGet(s.artRef) : null;
  if (art) { $('#eArtPrev').src = art; $('#eArtPrev').classList.remove('ph'); }
  else { $('#eArtPrev').removeAttribute('src'); $('#eArtPrev').classList.add('ph'); }
  $('#eArt').value = '';
  $('#eDelete').style.visibility = id ? 'visible' : 'hidden';
  $('#modalBack').hidden = false;
  $('#eTitle').focus();
}
function closeModal() { $('#modalBack').hidden = true; editId = null; editColl = null; }
async function saveSongEditor() {
  const title = $('#eTitle').value.trim();
  if (!title) { $('#eTitle').focus(); return; }
  const len = $('#eLength').value.trim();
  if (len && !/^\d+:[0-5]\d$/.test(len)) { alert('Length must look like 3:44'); return; }
  pushUndo();
  const vals = {
    title, finished: $('#eFinished').value.trim() || null,
    stage: $('#eStage').value,
    producer: $('#eProducer').value.trim() || null,
    key: $('#eKey').value || null,
    bpm: $('#eBpm').value ? Number($('#eBpm').value) : null,
    length: len || null,
    featured: $('#eFeatured').value.trim() || null,
    stems: $('#eStems').value || null,
    exportDate: $('#eDate').value || null,
    notes: $('#eNotes').value.trim() || null,
  };
  let id = editId, song;
  if (!id) {
    id = 'a' + state.nextId++;
    song = Object.assign({id}, vals);
    state.songs.push(song);
  } else { song = byId(id); Object.assign(song, vals); }
  const aud = $('#eAudio').value;
  if (aud) state.audio[id] = aud; else delete state.audio[id];
  if (pendingArt !== undefined) {
    if (pendingArt) song.artRef = await attPut(pendingArt);
    else delete song.artRef;
  }
  persist(); closeModal(); renderAll();
}

/* ================= people collections (editable) ================= */
const COLLS = {
  artists: {label: 'artist', fields: [
    ['stage', 'Stage name'], ['legal', 'Full legal name'], ['phone', 'Phone'], ['email', 'Email'],
    ['spotify', 'Spotify ID'], ['apple', 'Apple Artist ID'], ['publishing', 'Publishing affiliation'], ['links', 'Links']]},
  pocs: {label: 'contact', fields: [
    ['company', 'Company'], ['poc', 'Contact name'], ['phone', 'Phone'], ['email', 'Email'],
    ['services', 'Services'], ['status', 'Status', ['', 'Active', 'Inactive']]]},
  social: {label: 'platform', fields: [
    ['platform', 'Platform'], ['user', 'Handle / username'], ['email', 'Account email'],
    ['linktree', 'On link tree?', ['', 'Yes', 'No']], ['pfp', 'Profile picture?', ['', 'Yes', 'No']],
    ['updated', 'Last updated', 'date'], ['info', 'To-do / notes', 'wide']]},
  marketing: {label: 'campaign', fields: [
    ['type', 'Campaign type'], ['company', 'Company'], ['website', 'Website'], ['services', 'Services provided'],
    ['kickoff', 'Kick-off', 'date'], ['duration', 'Duration'], ['notes', 'Notes', 'wide']]},
};
function bindPeople() {
  document.querySelectorAll('[data-addcoll]').forEach(b =>
    b.addEventListener('click', () => openCollEditor(b.dataset.addcoll, null)));
  document.addEventListener('click', e => {
    const ed = e.target.closest('[data-editcoll]');
    if (ed) { openCollEditor(ed.dataset.editcoll, Number(ed.dataset.idx)); return; }
    const del = e.target.closest('[data-delcoll]');
    if (del && confirm('Delete this entry?')) {
      pushUndo();
      state[del.dataset.delcoll].splice(Number(del.dataset.idx), 1);
      persist(); renderPeople();
    }
  });
}
function openCollEditor(coll, idx) {
  editColl = {coll, idx}; editId = null;
  const def = COLLS[coll];
  const item = idx != null ? state[coll][idx] : {};
  $('#mTitle').textContent = (idx != null ? 'Edit ' : 'Add ') + def.label;
  $('#songGrid').hidden = true;
  const g = $('#collGrid');
  g.hidden = false;
  g.innerHTML = def.fields.map(([k, l, t]) => {
    const v = esc(item[k] ?? '');
    if (Array.isArray(t)) return `<label>${l}<select data-ck="${k}">${t.map(o => `<option${o === (item[k] || '') ? ' selected' : ''}>${o}</option>`).join('')}</select></label>`;
    if (t === 'date') return `<label>${l}<input type="date" data-ck="${k}" value="${v}"></label>`;
    if (t === 'wide') return `<label class="wide">${l}<textarea data-ck="${k}">${v}</textarea></label>`;
    return `<label>${l}<input type="text" data-ck="${k}" value="${v}"></label>`;
  }).join('');
  $('#eDelete').style.visibility = idx != null ? 'visible' : 'hidden';
  $('#modalBack').hidden = false;
  g.querySelector('input,select,textarea')?.focus();
}
function saveCollEditor() {
  const {coll, idx} = editColl;
  const item = {};
  $('#collGrid').querySelectorAll('[data-ck]').forEach(el => { item[el.dataset.ck] = el.value.trim() || null; });
  if (!Object.values(item).some(Boolean)) { closeModal(); return; }
  pushUndo();
  if (idx != null) state[coll][idx] = item; else state[coll].push(item);
  persist(); closeModal(); renderPeople();
}
function renderPeople() {
  const eb = (coll, i) => `<button class="btn ghost small editbtn" data-editcoll="${coll}" data-idx="${i}" type="button">Edit</button>`;
  const db = (coll, i) => `<button class="del" data-delcoll="${coll}" data-idx="${i}" aria-label="Delete" type="button">×</button>`;
  $('#artistGrid').innerHTML = state.artists.map((a, i) => `
    <div class="acard">
      ${eb('artists', i)}
      <div class="stage">${esc(a.stage || a.legal || '?')}</div>
      <div class="legal">${esc(a.legal || '')}</div>
      <dl>
        ${a.phone ? `<dt>Phone</dt><dd>${esc(a.phone)}</dd>` : ''}
        ${a.email ? `<dt>Email</dt><dd>${esc(a.email)}</dd>` : ''}
        ${a.apple ? `<dt>Apple ID</dt><dd>${esc(a.apple)}</dd>` : ''}
        ${a.spotify ? `<dt>Spotify</dt><dd>${esc(a.spotify)}</dd>` : ''}
        ${a.publishing ? `<dt>Publishing</dt><dd>${esc(a.publishing)}</dd>` : ''}
      </dl>
    </div>`).join('') || '<div class="empty">No artists yet.</div>';
  $('#pocBody').innerHTML = state.pocs.map((p, i) => `
    <tr><td><strong>${esc(p.company || '')}</strong></td><td>${esc(p.poc || '')}</td>
    <td class="mono">${esc(p.phone || '')}</td><td class="mono">${esc(p.email || '')}</td>
    <td>${esc(p.services || '')}</td>
    <td>${p.status === 'Active' ? '<span class="chip ok">Active</span>' : '<span class="chip off">—</span>'}</td>
    <td style="white-space:nowrap">${eb('pocs', i)} ${db('pocs', i)}</td></tr>`).join('') ||
    '<tr><td colspan="7"><div class="empty">No contacts yet.</div></td></tr>';
  $('#socialBody').innerHTML = state.social.map((s, i) => {
    const live = !!(s.user || s.email);
    return `<tr><td><strong>${esc(s.platform || '')}</strong></td>
      <td>${live ? '<span class="chip ok">Set up</span>' : '<span class="chip off">Not set up</span>'}</td>
      <td class="mono">${esc(s.user || s.email || '')}</td><td>${esc(s.linktree || '')}</td>
      <td>${esc(s.pfp || '')}</td><td class="mono">${esc(s.updated || '')}</td>
      <td style="max-width:340px">${esc(s.info || '')}</td>
      <td style="white-space:nowrap">${eb('social', i)} ${db('social', i)}</td></tr>`;
  }).join('') || '<tr><td colspan="8"><div class="empty">No platforms yet.</div></td></tr>';
  $('#mktBody').innerHTML = state.marketing.map((m, i) => `
    <tr><td><strong>${esc(m.type || '')}</strong></td><td>${esc(m.company || '')}</td>
    <td class="mono">${esc(m.website || '')}</td><td>${esc(m.services || '')}</td>
    <td class="mono">${esc(m.kickoff || '')}</td><td>${esc(m.duration || '')}</td><td>${esc(m.notes || '')}</td>
    <td style="white-space:nowrap">${eb('marketing', i)} ${db('marketing', i)}</td></tr>`).join('') ||
    '<tr><td colspan="8"><div class="empty">No campaigns yet.</div></td></tr>';
}

/* ================= work queue ================= */
function buildTasks() {
  const t = [];
  for (const s of state.songs) {
    if (isBlocked(s)) t.push({id: s.id + ':stems', song: s, kind: 'Stems', label: 'Collect vocal stems', why: s.stems});
    if (stageIdx(s.stage) < 3) t.push({id: s.id + ':export', song: s, kind: 'Export', label: 'Finish & export at −6 dB', why: stageLabel(s.stage)});
    if (hasNotes(s) && !hasVideo(s)) t.push({id: s.id + ':note', song: s, kind: 'Note', label: 'Resolve production note', why: s.notes});
  }
  return t;
}
function completeTask(taskId) {
  const [sid, kind] = taskId.split(':');
  const s = byId(sid);
  if (!s) return;
  pushUndo();
  if (kind === 'stems') s.stems = 'Stems received';
  else if (kind === 'export') {
    if (stageIdx(s.stage) < 3) s.stage = 'exported';
    s.exportDate = new Date().toISOString().slice(0, 10);
  } else if (kind === 'note') {
    s.resolvedNotes = (s.resolvedNotes ? s.resolvedNotes + '\n---\n' : '') + s.notes;
    s.notes = null;
  }
  delete state.snooze[taskId];
  persist(); renderAll();
}
function renderQueue() {
  const tasks = buildTasks();
  const todo = tasks.filter(t => !state.snooze[t.id]);
  const snoozed = tasks.filter(t => state.snooze[t.id]);
  const row = (t, sn) => `
    <div class="qtask">
      <div class="tt">
        <span class="kind">${t.kind}</span> — <strong>${esc(t.song.title)}</strong>
        <span class="why">${esc(t.label)}: ${esc(t.why || '')}</span>
      </div>
      <button class="btn ghost small" data-open="${t.song.id}" type="button">Open</button>
      <button class="btn good small" data-complete="${t.id}" type="button">Done</button>
      <button class="btn ghost small" data-snooze="${t.id}" data-on="${sn ? 1 : 0}" type="button">${sn ? 'Unsnooze' : 'Snooze'}</button>
    </div>`;
  $('#qTodo').innerHTML = todo.map(t => row(t, false)).join('') || '<div class="empty">Queue is clear — the album is ready when you are.</div>';
  $('#qSnooze').innerHTML = snoozed.map(t => row(t, true)).join('') || '<div class="empty">Nothing snoozed.</div>';
  $('#qTodoN').textContent = todo.length;
  $('#qSnoozeN').textContent = snoozed.length;
  $('#queueBadge').textContent = todo.length || '';
}
document.addEventListener('click', e => {
  if (e.target.dataset.complete) completeTask(e.target.dataset.complete);
  else if (e.target.dataset.snooze) {
    const id = e.target.dataset.snooze;
    if (e.target.dataset.on === '1') delete state.snooze[id]; else state.snooze[id] = true;
    persist(); renderQueue();
  }
});

/* ================= album ================= */
let poolQuery = '', dragIdx = null;
function bindAlbum() {
  $('#poolSearch').addEventListener('input', e => { poolQuery = e.target.value.toLowerCase(); renderAlbum(); });
  $('#seqCopy').addEventListener('click', () => {
    const lines = state.sequence.map((id, i) => {
      const s = byId(id);
      return `${i + 1}. ${s.finished || s.title}${s.length ? ' (' + s.length + ')' : ''}`;
    });
    navigator.clipboard.writeText((state.albumTitle || 'Album') + ' — tracklist\n' + lines.join('\n'))
      .then(() => { $('#seqCopy').textContent = 'Copied!'; setTimeout(() => $('#seqCopy').textContent = 'Copy tracklist', 1400); });
  });
  $('#seqList').addEventListener('click', e => {
    const item = e.target.closest('[data-idx]');
    if (!item) return;
    const idx = Number(item.dataset.idx);
    if (e.target.dataset.act === 'up' && idx > 0) swapSeq(idx, idx - 1);
    else if (e.target.dataset.act === 'down' && idx < state.sequence.length - 1) swapSeq(idx, idx + 1);
    else if (e.target.dataset.act === 'rm') { pushUndo(); state.sequence.splice(idx, 1); persist(); renderAlbum(); }
  });
  $('#poolList').addEventListener('click', e => {
    const id = e.target.dataset.add;
    if (id) { pushUndo(); state.sequence.push(id); persist(); renderAlbum(); }
  });
  $('#seqList').addEventListener('dragstart', e => {
    const it = e.target.closest('[data-idx]');
    if (it) { dragIdx = Number(it.dataset.idx); e.dataTransfer.effectAllowed = 'move'; }
  });
  $('#seqList').addEventListener('dragover', e => {
    e.preventDefault();
    document.querySelectorAll('.seqitem').forEach(x => x.classList.remove('dragover'));
    e.target.closest('[data-idx]')?.classList.add('dragover');
  });
  $('#seqList').addEventListener('drop', e => {
    e.preventDefault();
    document.querySelectorAll('.seqitem').forEach(x => x.classList.remove('dragover'));
    const it = e.target.closest('[data-idx]');
    if (!it || dragIdx === null) return;
    pushUndo();
    const [moved] = state.sequence.splice(dragIdx, 1);
    state.sequence.splice(Number(it.dataset.idx), 0, moved);
    dragIdx = null; persist(); renderAlbum();
  });
}
function swapSeq(a, b) { pushUndo(); const s = state.sequence; [s[a], s[b]] = [s[b], s[a]]; persist(); renderAlbum(); }
function renderAlbum() {
  state.sequence = state.sequence.filter(id => byId(id));
  const seq = state.sequence.map(byId);
  const known = seq.filter(s => s.length);
  const total = known.reduce((a, s) => a + parseLen(s.length), 0);
  $('#seqStats').textContent = seq.length + ' tracks · ' + fmtLen(total) + (known.length < seq.length ? ` (${seq.length - known.length} no length)` : '');
  $('#seqList').innerHTML = seq.length ? seq.map((s, i) => `
    <div class="seqitem" draggable="true" data-idx="${i}">
      <span class="num">${i + 1}</span>
      <span class="nm">${esc(s.finished || s.title)}</span>
      <span class="len">${esc(s.length || '–:––')}</span>
      <button class="mv" data-act="up" type="button" aria-label="Move up">▲</button>
      <button class="mv" data-act="down" type="button" aria-label="Move down">▼</button>
      <button class="del" data-act="rm" type="button" aria-label="Remove">×</button>
    </div>`).join('') : '<div class="empty">Add tracks from the pool →</div>';
  const inSeq = new Set(state.sequence);
  let pool = state.songs.filter(s => !inSeq.has(s.id));
  if (poolQuery) pool = pool.filter(s => (s.title + ' ' + (s.finished || '')).toLowerCase().includes(poolQuery));
  $('#poolList').innerHTML = pool.map(s => `
    <div class="seqitem">
      <span class="nm">${esc(s.title)}${s.finished ? ` <span class="len">(${esc(s.finished)})</span>` : ''}</span>
      <span class="len">${esc(s.length || '')}</span>
      <button class="btn ghost small" data-add="${s.id}" type="button">Add</button>
    </div>`).join('') || '<div class="empty">Every song is on the album.</div>';
}

/* ================= finance ================= */
let currentReport = null;
function bindFinance() {
  $('#revTable').addEventListener('change', e => {
    const k = e.target.dataset.rev;
    if (!k) return;
    pushUndo();
    const v = parseFloat(e.target.value);
    if (v > 0) state.revenue[k] = v; else delete state.revenue[k];
    persist(); renderFinance(); renderDash();
  });
  $('#revClear').addEventListener('click', () => {
    if (!confirm('Clear all revenue entries?')) return;
    pushUndo(); state.revenue = {}; persist(); renderFinance(); renderDash();
  });
  $('#newReport').addEventListener('click', () => {
    const name = prompt('Report name (e.g. "April tour", "Studio equipment Q3"):');
    if (!name || !name.trim()) return;
    pushUndo();
    const r = {id: 'r' + randHex(4), name: name.trim(), status: 'Draft', items: []};
    state.reports.unshift(r);
    currentReport = r.id;
    persist(); renderFinance();
  });
  $('#reportArea').addEventListener('click', async e => {
    const t = e.target;
    if (t.dataset.rep === 'back') { currentReport = null; renderFinance(); return; }
    const li = t.closest('[data-repopen]');
    if (li) { currentReport = li.dataset.repopen; renderFinance(); return; }
    const r = state.reports.find(x => x.id === currentReport);
    if (!r) return;
    if (t.id === 'itemAdd') {
      const amt = parseFloat($('#itemAmt').value);
      if (!(amt > 0)) { $('#itemAmt').focus(); return; }
      const item = {date: $('#itemDate').value, vendor: $('#itemVendor').value.trim(),
                    cat: $('#itemCat').value, pay: $('#itemPay').value, amt,
                    note: $('#itemNote').value.trim()};
      const rf = $('#itemReceipt').files[0];
      const push = () => { pushUndo(); r.items.unshift(item); persist(); renderFinance(); renderDash(); };
      if (rf) downscale(rf, 700, async uri => { item.receiptRef = await attPut(uri); push(); }); else push();
      return;
    }
    if (t.dataset.delitem !== undefined) { pushUndo(); r.items.splice(Number(t.dataset.delitem), 1); persist(); renderFinance(); renderDash(); return; }
    if (t.dataset.status) { pushUndo(); r.status = t.dataset.status; persist(); renderFinance(); return; }
    if (t.id === 'repDelete') {
      if (confirm(`Delete report "${r.name}" and its ${r.items.length} expenses?`)) {
        pushUndo();
        state.reports = state.reports.filter(x => x.id !== r.id);
        currentReport = null;
        persist(); renderFinance(); renderDash();
      }
      return;
    }
    const rc = t.closest('img.receipt');
    if (rc) { $('#lightboxImg').src = rc.src; $('#lightbox').hidden = false; }
  });
  $('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; });
}
function renderRevenue() {
  let html = '<thead><tr><th></th>' + REV_CATS.map(c => `<th>${c}</th>`).join('') + '<th class="tot">Total</th></tr></thead><tbody>';
  const colTotals = REV_CATS.map(() => 0);
  QTRS.forEach((q, qi) => {
    let rowTotal = 0;
    html += `<tr><td><strong>${q}</strong></td>`;
    REV_CATS.forEach((c, ci) => {
      const v = Number(state.revenue[qi + '-' + ci] || 0);
      rowTotal += v; colTotals[ci] += v;
      html += `<td><input type="number" min="0" step="0.01" data-rev="${qi}-${ci}" value="${v || ''}" placeholder="—" aria-label="${q} ${c}"></td>`;
    });
    html += `<td class="tot">${rowTotal ? money(rowTotal) : '—'}</td></tr>`;
  });
  const grand = colTotals.reduce((a, b) => a + b, 0);
  html += '<tr><td><strong>Year</strong></td>' +
    colTotals.map(t => `<td class="tot">${t ? money(t) : '—'}</td>`).join('') +
    `<td class="tot grand">${grand ? money(grand) : '—'}</td></tr></tbody>`;
  $('#revTable').innerHTML = html;
}
const statusChipRep = st =>
  st === 'Approved' ? '<span class="chip ok">Approved</span>'
  : st === 'Submitted' ? '<span class="chip warn">Submitted</span>'
  : '<span class="chip off">Draft</span>';
function renderReports() {
  const r = state.reports.find(x => x.id === currentReport);
  if (!r) {
    $('#reportArea').innerHTML = state.reports.length ? '<ul class="replist">' + state.reports.map(rep => `
      <li data-repopen="${rep.id}">
        <span class="rname">${esc(rep.name)}</span>
        ${statusChipRep(rep.status)}
        <span class="mono" style="color:var(--muted)">${rep.items.length} item${rep.items.length === 1 ? '' : 's'}</span>
        <span class="rtot mono">${money(reportTotal(rep))}</span>
      </li>`).join('') + '</ul>'
      : '<div class="empty">No expense reports yet. Create one, add line items, attach receipts, then submit — Concur style, minus the corporate approval chain (you’re the approver).</div>';
    return;
  }
  const editable = r.status === 'Draft';
  const actions =
    r.status === 'Draft' ? '<button class="btn small" data-status="Submitted" type="button">Submit report</button>' :
    r.status === 'Submitted' ? `<button class="btn good small" data-status="Approved" type="button">Approve</button>
                                <button class="btn ghost small" data-status="Draft" type="button">Return to draft</button>` :
    '<button class="btn ghost small" data-status="Draft" type="button">Reopen</button>';
  $('#reportArea').innerHTML = `
    <div class="addrow" style="justify-content:space-between">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn ghost small" data-rep="back" type="button">← All reports</button>
        <strong>${esc(r.name)}</strong> ${statusChipRep(r.status)}
        <span class="mono" style="color:var(--good)">${money(reportTotal(r))}</span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${actions}
        <button class="btn ghost small" id="repDelete" type="button">Delete</button></div>
    </div>
    ${editable ? `
    <div class="addrow">
      <input type="date" id="itemDate" aria-label="Date">
      <input type="text" id="itemVendor" placeholder="Vendor" style="width:130px" aria-label="Vendor">
      <select id="itemCat" aria-label="Category">${EXP_CATS.map(c => `<option>${c}</option>`).join('')}</select>
      <select id="itemPay" aria-label="Payment type">${PAY_TYPES.map(p => `<option>${p}</option>`).join('')}</select>
      <input type="number" id="itemAmt" min="0" step="0.01" placeholder="0.00" aria-label="Amount">
      <input type="text" id="itemNote" placeholder="Note" style="flex:1;min-width:110px" aria-label="Note">
      <label style="font-size:11px;color:var(--muted);display:flex;align-items:center;gap:6px">Receipt
        <input type="file" id="itemReceipt" accept="image/*" style="max-width:180px"></label>
      <button class="btn" id="itemAdd" type="button">Add</button>
    </div>` : ''}
    <div class="tablewrap" style="border:none">
      <table style="min-width:700px">
        <thead><tr><th>Date</th><th>Vendor</th><th>Category</th><th>Payment</th><th style="text-align:right">Amount</th><th>Note</th><th>Receipt</th>${editable ? '<th></th>' : ''}</tr></thead>
        <tbody>
        ${r.items.length ? r.items.map((it, i) => {
          const rimg = it.receiptRef && attGet(it.receiptRef);
          return `<tr>
            <td class="mono">${esc(it.date || '—')}</td>
            <td>${esc(it.vendor || '')}</td>
            <td>${esc(it.cat)}</td>
            <td>${esc(it.pay)}</td>
            <td class="mono" style="text-align:right">${money(it.amt)}</td>
            <td>${esc(it.note || '')}</td>
            <td>${rimg ? `<img class="receipt" src="${rimg}" alt="Receipt thumbnail">` : '<span class="chip off">None</span>'}</td>
            ${editable ? `<td><button class="del" data-delitem="${i}" aria-label="Delete line" type="button">×</button></td>` : ''}
          </tr>`;
        }).join('') : '<tr><td colspan="8"><div class="empty">No line items yet.</div></td></tr>'}
        </tbody>
      </table>
    </div>`;
}
function renderChart() {
  const canvas = $('#expChart'), wrap = $('#chartWrap');
  const W = canvas.width = Math.max(300, wrap.clientWidth - 28);
  const H = canvas.height = 190;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const byMonth = {};
  for (const it of allExpenses()) {
    const m = (it.date || '').slice(0, 7) || 'undated';
    byMonth[m] = (byMonth[m] || 0) + it.amt;
  }
  const months = Object.keys(byMonth).sort();
  if (!months.length) {
    ctx.fillStyle = '#6E6265'; ctx.font = '13px Menlo, monospace'; ctx.textAlign = 'center';
    ctx.fillText('No expense data yet — add line items to a report.', W / 2, H / 2);
    return;
  }
  const max = Math.max(...months.map(m => byMonth[m]));
  const pad = 34, bw = Math.min(64, (W - pad * 2) / months.length * .62);
  const step = (W - pad * 2) / months.length;
  ctx.strokeStyle = '#342A2D'; ctx.beginPath(); ctx.moveTo(pad, H - 30); ctx.lineTo(W - pad + 10, H - 30); ctx.stroke();
  months.forEach((m, i) => {
    const h = Math.max(2, (byMonth[m] / max) * (H - 70));
    const x = pad + i * step + (step - bw) / 2, y = H - 30 - h;
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#FF453C'); g.addColorStop(1, '#D92B2B');
    ctx.fillStyle = g; ctx.fillRect(x, y, bw, h);
    ctx.fillStyle = '#9C8F91'; ctx.font = '10px Menlo, monospace'; ctx.textAlign = 'center';
    ctx.fillText(m, x + bw / 2, H - 16);
    ctx.fillStyle = '#EFE8E6';
    ctx.fillText('$' + Math.round(byMonth[m]).toLocaleString(), x + bw / 2, y - 6);
  });
}
function renderFinance() { renderRevenue(); renderReports(); renderChart(); }

/* ================= audio ================= */
let audioDirHandle = null, audioFiles = [];
const normName = t => (t || '').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]/g, '');
function audioFor(s) {
  if (state.audio[s.id]) return state.audio[s.id];
  if (!audioFiles.length) return null;
  const t1 = normName(s.title), t2 = normName(s.finished);
  return audioFiles.find(f => { const n = normName(f); return n === t1 || (t2 && n === t2); }) ||
         audioFiles.find(f => { const n = normName(f); return t1.length > 5 && (n.includes(t1) || t1.includes(n)); }) || null;
}
async function scanAudioDir() {
  audioFiles = [];
  if (!audioDirHandle) return;
  try {
    for await (const [name, h] of audioDirHandle.entries()) {
      if (h.kind === 'file' && /\.(mp3|wav|m4a|aif|aiff|flac|ogg)$/i.test(name)) audioFiles.push(name);
    }
    audioFiles.sort();
  } catch (e) { audioFiles = []; }
}
async function restoreAudioDir() {
  try {
    const h = await dbGet('audioDir');
    if (h && await h.queryPermission({mode: 'read'}) === 'granted') {
      audioDirHandle = h;
      await scanAudioDir(); renderSongs();
    }
  } catch (e) {}
}
function bindAudio() {
  $('#audioFolderBtn').addEventListener('click', async () => {
    try {
      audioDirHandle = await showDirectoryPicker({mode: 'read'});
      await dbSet('audioDir', audioDirHandle);
      await scanAudioDir();
      renderSongs();
      alert(`Linked. Found ${audioFiles.length} audio files — matches show a green ▶.`);
    } catch (e) {}
  });
  $('#playerClose').addEventListener('click', () => { $('#playerAudio').pause(); $('#player').hidden = true; });
}
async function playSong(id) {
  const s = byId(id);
  const fname = audioFor(s);
  if (!fname || !audioDirHandle) return;
  try {
    if (await audioDirHandle.queryPermission({mode: 'read'}) !== 'granted' &&
        await audioDirHandle.requestPermission({mode: 'read'}) !== 'granted') return;
    const fh = await audioDirHandle.getFileHandle(fname);
    const file = await fh.getFile();
    const a = $('#playerAudio');
    if (a.dataset.url) URL.revokeObjectURL(a.dataset.url);
    a.src = a.dataset.url = URL.createObjectURL(file);
    $('#playerTitle').textContent = s.finished || s.title;
    $('#player').hidden = false;
    a.play();
  } catch (e) { alert('Could not open ' + fname); }
}

/* ================= settings ================= */
function bindSettings() {
  $('#autoLockSel').addEventListener('change', () => {
    state.settings.autoLockMin = Number($('#autoLockSel').value);
    persist();
  });
  $('#syncToggle').addEventListener('click', async () => {
    const sy = state.settings.sync;
    if (sy.enabled) {
      if (!confirm('Turn off sync? The cloud copy (all versions) will be deleted.')) return;
      await SY.deleteAll(sy.id).catch(() => {});
      state.settings.sync = {enabled: false, id: null, lastAt: null};
      setSyncDot('off');
      persist(); renderSettings();
    } else {
      state.settings.sync = {enabled: true, id: randHex(16), lastAt: null};
      persist();
      try { await syncAll(); } catch (e) { setSyncDot('err'); }
      renderSettings();
    }
  });
  $('#syncNow').addEventListener('click', async () => {
    try { await syncAll(); alert('Synced.'); }
    catch (e) { setSyncDot('err'); alert('Sync failed — check your connection.'); }
  });
  $('#syncHistory').addEventListener('click', async () => {
    const row = $('#versionRow');
    if (!row.hidden) { row.hidden = true; return; }
    try {
      const vers = await SY.listVersions(state.settings.sync.id);
      $('#versionList').innerHTML = '<b>Cloud versions (newest first)</b>' + (vers.map(v =>
        `<div class="lockrow" style="margin-top:6px"><span class="mono" style="flex:1">${new Date(v.ver).toLocaleString()}</span>
         <button class="btn ghost small" data-restorever="${v.ver}" type="button">Restore</button></div>`).join('') ||
        '<span>No versions yet.</span>');
      row.hidden = false;
    } catch (e) { alert('Could not load version history.'); }
  });
  $('#versionList')?.parentElement?.addEventListener('click', async e => {
    const ver = e.target.dataset.restorever;
    if (!ver) return;
    if (!confirm('Replace your current data with this cloud version? (Undo is available.)')) return;
    try {
      const row = await SY.pullVersion(state.settings.sync.id, ver);
      if (!row) throw new Error('version gone');
      pushUndo();
      await applyUpgrade(upgrade(await decJson(session.masterKey, row.ciphertext)));
      state.settings.sync = {enabled: true, id: row.sync_id, lastAt: new Date(row.ver).toISOString()};
      await pullRemoteAtts(row.sync_id);
      persist(); renderAll();
      $('#versionRow').hidden = true;
    } catch (e) { alert('Restore failed: ' + e.message); }
  });
  $('#touchIdEnable').addEventListener('click', () => {
    enableTouchId().then(renderSettings).catch(e => alert('Touch ID enrollment failed: ' + e.message));
  });
  $('#btnBackupEnc').addEventListener('click', exportEncBackup);
  $('#nudgeBackup').addEventListener('click', exportEncBackup);
  $('#nudgeDismiss').addEventListener('click', () => { nudgeHidden = true; renderDash(); });
  $('#peopleDismiss').addEventListener('click', () => { delete state.needsPeopleImport; persist(); renderDash(); });
  $('#btnBackup').addEventListener('click', () => {
    if (!confirm('This file will be READABLE — it contains all your data unencrypted. Continue?')) return;
    const atts = Object.fromEntries([...referencedAtts(state)].map(r => [r, attGet(r)]));
    download(JSON.stringify({app: 'endustrie-tracker', v: 4, kind: 'plain', state, attachments: atts}, null, 1), 'endustrie-plain-backup.json');
    state.settings.lastBackupAt = new Date().toISOString();
    persist(); renderDash();
  });
  $('#btnCsv').addEventListener('click', () => {
    const cols = ['title', 'finished', 'stage', 'producer', 'key', 'bpm', 'featured', 'stems', 'exportDate', 'length', 'notes'];
    const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const csv = [cols.join(',')].concat(state.songs.map(s => cols.map(c => q(s[c])).join(','))).join('\n');
    download(csv, 'endustrie-songs.csv', 'text/csv');
  });
  $('#btnPrint').addEventListener('click', buildAndPrint);
  $('#btnXlsx').addEventListener('click', () => $('#xlsxFile').click());
  $('#xlsxFile').addEventListener('change', async () => {
    const f = $('#xlsxFile').files[0];
    $('#xlsxFile').value = '';
    if (!f) return;
    try {
      const data = await importWorkbook(await f.arrayBuffer());
      if (!data.songs.length) throw new Error('no songs found');
      if (!confirm(`Found ${data.songs.length} songs plus ${data.artists.length} artists, ${data.pocs.length} contacts, ${data.social.length} platforms, ${data.marketing.length} campaigns. Replace the catalog? (Hand-added songs are kept; artwork stays matched by title.)`)) return;
      pushUndo();
      const artByTitle = {};
      state.songs.forEach(s => { if (s.artRef) artByTitle[normName(s.title)] = s.artRef; });
      const kept = state.songs.filter(s => s.id.startsWith('a'));
      state.songs = data.songs.map((s, i) => ({id: 's' + i, ...s})).concat(kept);
      state.songs.forEach(s => { const a = artByTitle[normName(s.title)]; if (a) s.artRef = a; });
      state.artists = data.artists; state.pocs = data.pocs;
      state.social = data.social; state.marketing = data.marketing;
      state.sequence = state.sequence.filter(id => byId(id));
      state.albumTitle = data.albumTitle || state.albumTitle || null;
      state.setupDone = true;
      delete state.needsPeopleImport;
      persist(); renderAll();
      alert(`Imported ${data.songs.length} songs.`);
    } catch (e) { alert('Import failed: ' + e.message); }
  });
}
async function exportEncBackup() {
  await flush();
  const env = backupEnvelope();
  // embed encrypted attachments so the backup is complete
  for (const ref of Object.keys(env.attachments)) {
    env.attachments[ref] = await dbGet(`att:${session.profile.id}:${ref}`) || null;
  }
  download(JSON.stringify(env, null, 1), `endustrie-encrypted-${session.profile.name.toLowerCase().replace(/\s+/g, '-')}.json`);
  state.settings.lastBackupAt = new Date().toISOString();
  persist(); renderDash();
}
function download(text, name, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type}));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function renderSettings() {
  const sy = state.settings.sync;
  $('#syncState').textContent = sy.enabled ? ('on — last push ' + (sy.lastAt ? new Date(sy.lastAt).toLocaleString() : 'pending')) : 'off';
  $('#syncToggle').textContent = sy.enabled ? 'Disable sync' : 'Enable sync';
  $('#syncIdRow').hidden = !sy.enabled;
  if (!sy.enabled) $('#versionRow').hidden = true;
  if (sy.enabled) $('#syncIdShow').textContent = sy.id;
  $('#autoLockSel').value = String(state.settings.autoLockMin ?? 10);
}
function buildAndPrint() {
  const songs = state.songs;
  const seq = state.sequence.map(byId).filter(Boolean);
  const blocked = songs.filter(isBlocked), pending = songs.filter(s => stageIdx(s.stage) < 3);
  $('#printArea').innerHTML = `
    <h1>${esc(state.albumTitle || 'Album')} — status report</h1>
    <div class="pm">Endustrie Tracker · ${new Date().toLocaleDateString()} · ${songs.length} tracks · ${songs.filter(s => stageIdx(s.stage) >= 3).length} exported or beyond</div>
    <h2>Blocked on vocal stems (${blocked.length})</h2>
    <table><tr><th>Song</th><th>Status</th></tr>${blocked.map(s => `<tr><td>${esc(s.title)}</td><td>${esc(s.stems)}</td></tr>`).join('')}</table>
    <h2>Still in production (${pending.length})</h2>
    <table><tr><th>Song</th><th>Stage</th><th>Note</th></tr>${pending.map(s => `<tr><td>${esc(s.title)}</td><td>${stageLabel(s.stage)}</td><td>${esc(s.notes || '')}</td></tr>`).join('')}</table>
    ${seq.length ? `<h2>Working tracklist (${seq.length})</h2>
    <table><tr><th>#</th><th>Track</th><th>Length</th></tr>${seq.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.finished || s.title)}</td><td>${esc(s.length || '')}</td></tr>`).join('')}</table>` : ''}`;
  window.print();
}

/* ================= init ================= */
(async () => {
  await dbOpen();
  profiles = (await dbGet('profiles')) || [];
  bindLock();
  renderProfiles();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => {});
  }
})();

/* debug/inspection handle (in-memory only; nothing here bypasses encryption at rest) */
window.__ET = {
  get state() { return state; }, get session() { return session; }, get attCache() { return attCache; },
  byId: id => byId(id), persist, flush, syncAll, undo: doUndo, attPut, attGet,
};
