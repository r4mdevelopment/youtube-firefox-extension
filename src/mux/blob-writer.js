// Blob blocks support MP4 header patches without a whole-file ArrayBuffer.
export function createBlobWriter() {
  const blockSize = 4 * 1024 * 1024;
  const blocks = [];
  let size = 0;
  return {
    write(data, position) {
      if (!(data instanceof Uint8Array) || !Number.isSafeInteger(position) || position < 0 || position > size) {
        throw new Error('Invalid MP4 write position');
      }
      for (let source = 0; source < data.byteLength;) {
        const index = Math.floor(position / blockSize);
        const offset = position % blockSize;
        const length = Math.min(data.byteLength - source, blockSize - offset);
        const previous = blocks[index] ?? new Blob();
        blocks[index] = new Blob([
          previous.slice(0, offset), data.subarray(source, source + length), previous.slice(offset + length),
        ]);
        source += length; position += length;
      }
      size = Math.max(size, position);
    },
    finish() { return new Blob(blocks, { type: 'video/mp4' }); },
    clear() { blocks.length = 0; size = 0; },
  };
}
