import {describe, it, expect} from 'vitest';
import {newState, migrateV3, upgrade, referencedAtts, stageIdx, STAGES} from '../src/store.js';

const v3State = () => ({
  v: 3, profileName: 'Test',
  songs: [
    {id: 's0', title: 'A', stage: 'exported', exported6db: 'Yes', mastered16: null},
    {id: 'a1', title: 'B', stage: 'mixing', exported6db: null},
  ],
  artwork: {s0: 'data:image/jpeg;base64,AAAA'},
  snooze: {'s0:note': true}, sequence: ['s0'], audio: {s0: 'a.mp3'},
  revenue: {'0-1': 100}, nextId: 2,
  reports: [{id: 'r1', name: 'R', status: 'Draft', items: [
    {date: '2026-01-01', cat: 'Hotel', pay: 'Cash', amt: 10, note: '', receipt: 'data:image/jpeg;base64,BBBB'},
  ]}],
  settings: {autoLockMin: 5, sync: {enabled: false, id: null, lastAt: null}},
});

describe('store migration v3 -> v4', () => {
  it('moves inline images to the attachment list and refs them', () => {
    const {state, attachments} = migrateV3(v3State());
    expect(state.v).toBe(4);
    expect(attachments).toHaveLength(2);
    const art = attachments.find(a => a.dataUri.endsWith('AAAA'));
    expect(state.songs[0].artRef).toBe(art.ref);
    const rec = attachments.find(a => a.dataUri.endsWith('BBBB'));
    expect(state.reports[0].items[0].receiptRef).toBe(rec.ref);
    expect(state.reports[0].items[0].receipt).toBeUndefined();
  });

  it('drops legacy export flags but keeps everything else', () => {
    const {state} = migrateV3(v3State());
    expect(state.songs[0].exported6db).toBeUndefined();
    expect(state.songs[0].mastered16).toBeUndefined();
    expect(state.songs[0].stage).toBe('exported');
    expect(state.sequence).toEqual(['s0']);
    expect(state.revenue['0-1']).toBe(100);
    expect(state.settings.autoLockMin).toBe(5);
    expect(state.needsPeopleImport).toBe(true);
  });

  it('upgrade() passes v4 through untouched and rejects v2', () => {
    const st = newState();
    st.songs = [{id: 's0', title: 'X', stage: 'writing'}];
    const up = upgrade(st);
    expect(up.state).toBe(st);
    expect(up.attachments).toEqual([]);
    expect(() => upgrade({v: 2})).toThrow();
  });

  it('referencedAtts collects art and receipt refs', () => {
    const st = newState();
    st.songs = [{id: 's0', title: 'X', stage: 'writing', artRef: 'aaa'}];
    st.reports = [{id: 'r', name: 'R', status: 'Draft', items: [{amt: 1, receiptRef: 'bbb'}]}];
    expect([...referencedAtts(st)].sort()).toEqual(['aaa', 'bbb']);
  });

  it('stage order is the production pipeline', () => {
    expect(STAGES.map(s => s[0])).toEqual(['writing', 'recorded', 'mixing', 'exported', 'mastered', 'video']);
    expect(stageIdx('exported')).toBe(3);
  });
});
