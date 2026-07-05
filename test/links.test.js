import {describe, it, expect} from 'vitest';
import {parseLink, linkBadge} from '../src/links.js';

describe('listen-link parsing', () => {
  it('recognizes YouTube in all common shapes', () => {
    for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                       'https://youtu.be/dQw4w9WgXcQ',
                       'https://youtube.com/shorts/dQw4w9WgXcQ',
                       'https://www.youtube.com/embed/dQw4w9WgXcQ']) {
      const p = parseLink(url);
      expect(p.type).toBe('youtube');
      expect(p.embed).toContain('/embed/dQw4w9WgXcQ');
    }
  });
  it('turns Dropbox links into direct streams and flags audio', () => {
    const p = parseLink('https://www.dropbox.com/s/abc123/My%20Song.mp3?dl=0');
    expect(p.type).toBe('dropbox');
    expect(p.audio).toBe(true);
    expect(p.stream).toContain('dl.dropboxusercontent.com');
    expect(p.stream).toContain('raw=1');
    expect(p.stream).not.toContain('dl=0');
    expect(parseLink('https://www.dropbox.com/s/abc123/stems.zip?dl=0').audio).toBe(false);
  });
  it('passes other links through and rejects junk', () => {
    expect(parseLink('https://soundcloud.com/x/y').type).toBe('link');
    expect(parseLink('not a url').type).toBe('invalid');
    expect(parseLink('javascript:alert(1)').type).toBe('invalid');
  });
  it('badges are right', () => {
    expect(linkBadge('https://youtu.be/dQw4w9WgXcQ')).toBe('YT');
    expect(linkBadge('https://www.dropbox.com/s/a/b.mp3')).toBe('DBX');
    expect(linkBadge('https://example.com')).toBe('LINK');
  });
});
