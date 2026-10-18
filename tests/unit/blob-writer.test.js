import { expect, it } from 'vitest';
import { createBlobWriter } from '../../src/mux/blob-writer.js';

it('patches a header and a block boundary without losing previously written media', async () => {
  const writer = createBlobWriter();
  const size = 4 * 1024 * 1024;
  const original = new Uint8Array(size * 2 + 100).fill(23);
  writer.write(original, 0);
  const old = writer.finish();
  writer.write(new Uint8Array([1, 2, 3, 4]), 0);
  writer.write(new Uint8Array(32).fill(99), size - 16);
  const result = new Uint8Array(await writer.finish().arrayBuffer());
  expect(result.length).toBe(original.length);
  expect(Array.from(result.slice(0, 5))).toEqual([1, 2, 3, 4, 23]);
  expect(result.slice(size - 16, size + 16)).toEqual(new Uint8Array(32).fill(99));
  expect(result[size - 17]).toBe(23);
  expect(result[size + 16]).toBe(23);
  expect(new Uint8Array(await old.slice(0, 4).arrayBuffer())).toEqual(new Uint8Array(4).fill(23));
  writer.clear();
  expect(writer.finish().size).toBe(0);
});

it('appends to partial blocks and rejects holes or invalid offsets', async () => {
  const writer = createBlobWriter();
  writer.write(new Uint8Array([1, 2]), 0);
  writer.write(new Uint8Array([3, 4]), 2);
  expect(Array.from(new Uint8Array(await writer.finish().arrayBuffer()))).toEqual([1, 2, 3, 4]);
  for (const position of [-1, 1.5, 10]) expect(() => writer.write(new Uint8Array([9]), position)).toThrow();
});
