import {describe, it, expect} from 'vitest';
import EXAMPLE from '../src/example.js';

// The example ships in a PUBLIC repo. This guard keeps personal contact info out of it, permanently.
describe('example dataset PII guard', () => {
  const blob = JSON.stringify(EXAMPLE);

  it('contains no email addresses or phone numbers', () => {
    expect(blob).not.toMatch(/@/);
    expect(blob).not.toMatch(/\d{3}[.\-\s]\d{3}[.\-\s]\d{4}/);
  });

  it('artists carry stage names only — no legal names or contact details', () => {
    for (const a of EXAMPLE.artists) {
      expect(a.stage).toBeTruthy();
      expect(a.legal).toBeNull();
      expect(a.phone).toBeNull();
      expect(a.email).toBeNull();
    }
    for (const p of EXAMPLE.pocs) {
      expect(p.poc).toBeNull();
      expect(p.phone).toBeNull();
      expect(p.email).toBeNull();
    }
    for (const s of EXAMPLE.social) expect(s.email).toBeNull();
  });

  it('is a full, well-formed catalog', () => {
    expect(EXAMPLE.songs.length).toBeGreaterThan(50);
    expect(EXAMPLE.albumTitle).toBeTruthy();
    const stages = new Set(EXAMPLE.songs.map(s => s.stage));
    expect([...stages].every(st => ['writing', 'recorded', 'mixing', 'exported', 'mastered', 'video'].includes(st))).toBe(true);
  });
});
