function concat(arrays) {
  const result = new Uint8Array(arrays.reduce((size, array) => size + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

function integer(value) {
  const bytes = [];
  do {
    bytes.unshift(value % 256);
    value = Math.floor(value / 256);
  } while (value);
  return Uint8Array.from(bytes);
}

function size(value) {
  let length = 1;
  while (value >= 2 ** (7 * length) - 1) length++;
  const bytes = new Uint8Array(length);
  for (let index = length - 1; index >= 0; index--) {
    bytes[index] = value % 256;
    value = Math.floor(value / 256);
  }
  bytes[0] |= 1 << (8 - length);
  return bytes;
}

function element(id, value) {
  const bytes =
    typeof value === 'number'
      ? integer(value)
      : typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value;
  return concat([integer(id), size(bytes.length), bytes]);
}

function float(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value);
  return bytes;
}

export function muxWebM(chunks, { width, height, duration, fps = 10 }) {
  if (!chunks.length) throw new Error('No encoded video frames.');
  const header = element(
    0x1a45dfa3,
    concat([
      element(0x4286, 1),
      element(0x42f7, 1),
      element(0x42f2, 4),
      element(0x42f3, 8),
      element(0x4282, 'webm'),
      element(0x4287, 2),
      element(0x4285, 2),
    ]),
  );
  const info = element(
    0x1549a966,
    concat([
      element(0x2ad7b1, 1000000),
      element(0x4489, float(duration)),
      element(0x4d80, 'OpenCode verified walkthrough'),
      element(0x5741, 'OpenCode'),
    ]),
  );
  const tracks = element(
    0x1654ae6b,
    element(
      0xae,
      concat([
        element(0xd7, 1),
        element(0x73c5, 1),
        element(0x83, 1),
        element(0x86, 'V_VP8'),
        element(0x23e383, Math.round(1e9 / fps)),
        element(0xe0, concat([element(0xb0, width), element(0xba, height)])),
      ]),
    ),
  );
  const clusters = [];
  let blocks = [],
    start = 0;
  for (const chunk of chunks) {
    const timestamp = Math.round(chunk.timestamp / 1000);
    if (blocks.length && timestamp - start >= 5000) {
      clusters.push(element(0x1f43b675, concat([element(0xe7, start), ...blocks])));
      blocks = [];
      start = timestamp;
    }
    const block = new Uint8Array(4 + chunk.data.length);
    block[0] = 0x81;
    new DataView(block.buffer).setInt16(1, timestamp - start);
    block[3] = chunk.key ? 0x80 : 0;
    block.set(chunk.data, 4);
    blocks.push(element(0xa3, block));
  }
  clusters.push(element(0x1f43b675, concat([element(0xe7, start), ...blocks])));
  return concat([header, element(0x18538067, concat([info, tracks, ...clusters]))]);
}
