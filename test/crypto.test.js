import {describe, it, expect} from 'vitest';
import {kekFromPass, importAes, aesEncrypt, aesDecrypt, encJson, decJson, b64, unb64, sha256hex, randHex} from '../src/crypto.js';

describe('crypto', () => {
  it('encrypts and decrypts JSON round-trip', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await kekFromPass('correct horse battery', salt);
    const blob = await encJson(key, {songs: [{title: 'X'}], n: 42});
    expect(blob).toMatch(/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(blob).not.toContain('songs');
    const back = await decJson(key, blob);
    expect(back).toEqual({songs: [{title: 'X'}], n: 42});
  });

  it('rejects the wrong passphrase', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await kekFromPass('right-pass-123', salt);
    const blob = await encJson(key, {secret: true});
    const wrong = await kekFromPass('wrong-pass-123', salt);
    await expect(decJson(wrong, blob)).rejects.toThrow();
  });

  it('wraps and unwraps a master key (the profile model)', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const master = crypto.getRandomValues(new Uint8Array(32));
    const kek = await kekFromPass('my passphrase 9', salt);
    const wrapped = await aesEncrypt(kek, master);
    const unwrapped = await aesDecrypt(await kekFromPass('my passphrase 9', salt), wrapped);
    expect([...unwrapped]).toEqual([...master]);
    const dataKey = await importAes(unwrapped);
    const blob = await encJson(dataKey, {ok: 1});
    expect(await decJson(dataKey, blob)).toEqual({ok: 1});
  });

  it('b64 helpers round-trip and sha256 is stable', async () => {
    const u8 = crypto.getRandomValues(new Uint8Array(33));
    expect([...unb64(b64(u8))]).toEqual([...u8]);
    expect(await sha256hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(randHex(16)).toMatch(/^[0-9a-f]{32}$/);
  });
});
