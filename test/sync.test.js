import {describe, it, expect} from 'vitest';
import {pruneList} from '../src/sync.js';

describe('sync version pruning', () => {
  it('keeps the newest N and returns the rest for deletion', () => {
    const vers = [1, 5, 3, 9, 7, 2, 8, 4, 6, 10, 11, 12];
    expect(pruneList(vers, 10).sort((a, b) => a - b)).toEqual([1, 2]);
  });
  it('returns nothing when at or under the limit', () => {
    expect(pruneList([3, 1, 2], 10)).toEqual([]);
    expect(pruneList([], 10)).toEqual([]);
  });
});
