// Pure state logic: shape, migration, and referenced-attachment accounting.
export const STAGES = [
  ['writing', 'Writing', '#6E6265'], ['recorded', 'Recorded', '#8A6E3C'], ['mixing', 'Mixing', '#E5A13D'],
  ['exported', 'Exported', '#58B884'], ['mastered', 'Mastered', '#2E8B6A'], ['video', 'Video done', '#D92B2B']];
export const stageIdx = st => STAGES.findIndex(x => x[0] === st);
export const stageLabel = st => (STAGES.find(x => x[0] === st) || STAGES[0])[1];
export const stageColor = st => (STAGES.find(x => x[0] === st) || STAGES[0])[2];

export const newState = () => ({
  v: 4, profileName: '', setupDone: false,
  songs: [], artists: [], pocs: [], social: [], marketing: [],
  snooze: {}, sequence: [], audio: {},
  revenue: {}, reports: [], nextId: 1,
  settings: {autoLockMin: 10, sync: {enabled: false, id: null, lastAt: null}, lastBackupAt: null},
});

/* v3 (single-file era) -> v4. Inline base64 images move to the attachment store:
   returns {state, attachments:[{ref, dataUri}]} so the caller can persist them. */
export function migrateV3(old) {
  const st = newState();
  const atts = [];
  const put = uri => { const ref = 'm' + atts.length + '_' + uri.length; atts.push({ref, dataUri: uri}); return ref; };
  st.profileName = old.profileName || '';
  st.setupDone = true;
  st.songs = (old.songs || []).map(s => {
    const {exported6db, mastered16, video, ...rest} = s;
    if (old.artwork && old.artwork[s.id]) rest.artRef = put(old.artwork[s.id]);
    return rest;
  });
  st.snooze = old.snooze || {};
  st.sequence = old.sequence || [];
  st.audio = old.audio || {};
  st.revenue = old.revenue || {};
  st.reports = (old.reports || []).map(r => ({...r, items: r.items.map(it => {
    const {receipt, ...rest} = it;
    if (receipt) rest.receiptRef = put(receipt);
    return rest;
  })}));
  st.nextId = old.nextId || 1;
  st.settings = Object.assign(newState().settings, old.settings || {});
  st.needsPeopleImport = true; // v3 never stored contacts; re-import the xlsx to fill them
  return {state: st, attachments: atts};
}

/* every attachment ref the state still points at */
export function referencedAtts(st) {
  const refs = new Set();
  st.songs.forEach(s => s.artRef && refs.add(s.artRef));
  st.reports.forEach(r => r.items.forEach(it => it.receiptRef && refs.add(it.receiptRef)));
  return refs;
}

export function upgrade(st) {
  if (!st.v || st.v < 3) throw new Error('unsupported state version');
  if (st.v === 3) return migrateV3(st);
  return {state: st, attachments: []};
}
