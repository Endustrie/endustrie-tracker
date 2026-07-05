import {describe, it, expect} from 'vitest';
import {bufToB64, b64ToBuf, splitChunks, joinChunks, CHUNK_BYTES} from '../src/chunks.js';

describe('audio chunk helpers', () => {
  it('base64 round-trips large buffers without stack overflow', () => {
    const big = new Uint8Array(3 * 1024 * 1024);
    crypto.getRandomValues(big.subarray(0, 65536));
    big.set(big.subarray(0, 65536), big.length - 65536);
    const back = b64ToBuf(bufToB64(big));
    expect(back.length).toBe(big.length);
    expect([...back.subarray(0, 32)]).toEqual([...big.subarray(0, 32)]);
    expect([...back.subarray(back.length - 32)]).toEqual([...big.subarray(big.length - 32)]);
  });
  it('split + join reconstructs the exact payload', () => {
    const buf = new Uint8Array(Math.floor(CHUNK_BYTES * 2.4));
    crypto.getRandomValues(buf.subarray(0, 65536));
    const parts = splitChunks(buf);
    expect(parts.length).toBe(3);
    const joined = joinChunks(parts);
    expect(joined.length).toBe(buf.length);
    expect([...joined.subarray(0, 64)]).toEqual([...buf.subarray(0, 64)]);
  });
  it('handles empty and sub-chunk payloads', () => {
    expect(splitChunks(new Uint8Array(10)).length).toBe(1);
    expect(joinChunks(splitChunks(new Uint8Array(0))).length).toBe(0);
  });
});
