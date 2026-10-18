import sharp from 'sharp';

/** Node is used only to prepare and inspect test fixtures; production uses the Images binding. */
export async function imageFixtures() {
  const pixels = Uint8Array.from({length: 64 * 32 * 4}, (_, offset) => offset % 4 === 3 ? 127 : offset % 4 === 0 ? 255 : 0);
  const source = sharp(pixels, {raw: {width: 64, height: 32, channels: 4}});
  const png = await source.clone().png().toBuffer();
  const jpeg = await source.clone().jpeg().toBuffer();
  const webp = await source.clone().webp({lossless: true}).toBuffer();
  const orientationPixels = Uint8Array.from(pixels, (_value, offset) => {
    const pixel = Math.floor(offset / 4), x = pixel % 64, y = Math.floor(pixel / 64);
    const color = y < 16 ? x < 32 ? [255, 0, 0, 255] : [0, 255, 0, 255] : x < 32 ? [0, 0, 255, 255] : [255, 255, 0, 255];
    return color[offset % 4]!;
  });
  const oriented = await sharp(orientationPixels, {raw: {width: 64, height: 32, channels: 4}}).jpeg().withMetadata({orientation: 6}).toBuffer();
  const profiled = await source.clone().withIccProfile('p3').png().toBuffer();
  const sixteenBit = await source.clone().toColourspace('rgb16').png().toBuffer();
  const gif = Buffer.from([
    ...Buffer.from('GIF89a'), 1, 0, 1, 0, 0xf0, 0, 0, 255, 0, 0, 0, 255, 0,
    0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0,
    0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0,
    0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0, 0x3b,
  ]);
  return {png, jpeg, webp, gif, oriented, profiled, sixteenBit};
}

/** Valid ancillary padding exercises input byte/frame bounds without huge decoded pixels. */
export function paddedPng(source: Buffer, length: number): Buffer {
  const payload = Buffer.alloc(length - source.length - 12, 97);
  const type = Buffer.from('npAD');
  const header = Buffer.alloc(8); header.writeUInt32BE(payload.length); type.copy(header, 4);
  let crc = 0xffffffff;
  for (const bytes of [type, payload]) for (const byte of bytes) {crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);}
  const trailer = Buffer.alloc(4); trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([source.subarray(0, -12), header, payload, trailer, source.subarray(-12)]);
}
