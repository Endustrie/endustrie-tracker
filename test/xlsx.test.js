// @vitest-environment jsdom
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {colToIdx, serialToISO, serialToLen, importWorkbook, deriveStage} from '../src/xlsx.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('xlsx primitives', () => {
  it('converts column refs', () => {
    expect(colToIdx('A1')).toBe(0);
    expect(colToIdx('V7')).toBe(21);
    expect(colToIdx('AA3')).toBe(26);
  });
  it('converts Excel serials', () => {
    expect(serialToISO(44576)).toBe('2022-01-15');
    expect(serialToLen(1 + (3 * 60 + 44) / 1440)).toBe('3:44');
  });
  it('derives stages from row flags', () => {
    expect(deriveStage({notes: 'Music Video Completed'})).toBe('video');
    expect(deriveStage({_mastered16: 'Yes'})).toBe('mastered');
    expect(deriveStage({_exported6db: 'Yes'})).toBe('exported');
    expect(deriveStage({notes: 'No vocals on Project'})).toBe('writing');
    expect(deriveStage({producer: 'X', key: 'Am', bpm: 90})).toBe('mixing');
  });
});

describe('workbook import (synthetic fixture)', () => {
  it('imports every sheet with correct values', async () => {
    const buf = readFileSync(join(here, 'fixtures/mini.xlsx'));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const data = await importWorkbook(ab, window.DOMParser);

    expect(data.songs).toHaveLength(3);
    const [one, two, three] = data.songs;
    expect(one).toMatchObject({title: 'Test Song One', finished: 'Final One', producer: 'ProducerX',
                               key: 'Am', bpm: 94, exportDate: '2022-01-15', length: '3:44', stage: 'exported'});
    expect(two).toMatchObject({title: 'Test Song Two', stems: "Need X's vocal stems.", stage: 'mixing'});
    expect(three.stage).toBe('video');
    expect(one._exported6db).toBeUndefined(); // legacy flags must not leak into the model

    expect(data.artists).toEqual([{legal: 'Test Person', stage: 'TestStage', phone: '555.000.1111',
      email: 'test@example.com', spotify: null, apple: null, publishing: null, links: null}]);
    expect(data.pocs).toEqual([{company: 'TestCo', employees: null, poc: 'Test Contact',
      phone: '555.222.3333', email: null, services: null, status: 'Active'}]);
    expect(data.social).toEqual([{platform: 'TestTube', email: null, user: 'testhandle', linktree: null,
      pfp: null, header: null, updated: '2022-01-02', info: null}]);
    expect(data.marketing).toEqual([{type: 'Blog Campaign', company: 'TestBlog', website: null,
      services: null, kickoff: '2022-01-02', duration: null, cost: null, notes: null}]);
  });
});
