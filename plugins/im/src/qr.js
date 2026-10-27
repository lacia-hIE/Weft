/**
 * Minimal QR Code encoder (ISO/IEC 18004): byte mode, error correction M,
 * versions 1-10, automatic mask selection. Enough for a login URL; renders SVG.
 */

// [total codewords, EC codewords per block, [blocks, data codewords]...] for level M.
const BLOCKS = [null,
  [26, 10, [1, 16]], [44, 16, [1, 28]], [70, 26, [1, 44]], [100, 18, [2, 32]], [134, 24, [2, 43]],
  [172, 16, [4, 27]], [196, 18, [4, 31]], [242, 22, [2, 38], [2, 39]], [292, 22, [3, 36], [2, 37]], [346, 26, [4, 43], [1, 44]],
];
const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d;}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const multiply = (a, b) => a && b ? EXP[LOG[a] + LOG[b]] : 0;
function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {next[j] ^= poly[j]; next[j + 1] ^= multiply(poly[j], EXP[i]);}
    poly = next;
  }
  return poly;
}
function remainder(data, degree) {
  const gen = generator(degree), result = [...data, ...new Array(degree).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const factor = result[i];
    if (factor) for (let j = 0; j < gen.length; j++) result[i + j] ^= multiply(gen[j], factor);
  }
  return result.slice(data.length);
}

function codewords(bytes, version) {
  const [total, ec, ...groups] = BLOCKS[version];
  const capacity = total - ec * groups.reduce((sum, [count]) => sum + count, 0);
  const bits = [];
  const push = (value, length) => {for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);};
  push(0b0100, 4); push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((value, bit) => value << 1 | bit, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);
  const blocks = [];
  let offset = 0;
  for (const [count, size] of groups) for (let i = 0; i < count; i++) {blocks.push(data.slice(offset, offset + size)); offset += size;}
  const result = [];
  for (let i = 0; i < Math.max(...blocks.map(block => block.length)); i++) for (const block of blocks) if (i < block.length) result.push(block[i]);
  const corrections = blocks.map(block => remainder(block, ec));
  for (let i = 0; i < ec; i++) for (const block of corrections) result.push(block[i]);
  return result;
}

function bch(value, poly, shift) {
  let result = value << shift;
  const degree = Math.floor(Math.log2(poly));
  while (result >= 1 << degree) result ^= poly << (Math.floor(Math.log2(result)) - degree);
  return value << shift | result;
}

const MASKS = [
  (i, j) => (i + j) % 2 === 0, (i) => i % 2 === 0, (_i, j) => j % 3 === 0, (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0, (i, j) => (i * j) % 2 + (i * j) % 3 === 0,
  (i, j) => ((i * j) % 2 + (i * j) % 3) % 2 === 0, (i, j) => ((i + j) % 2 + (i * j) % 3) % 2 === 0,
];

function base(version) {
  const size = version * 4 + 17;
  const modules = Array.from({length: size}, () => new Array(size).fill(false));
  const reserved = Array.from({length: size}, () => new Array(size).fill(false));
  const set = (row, col, dark) => {modules[row][col] = dark; reserved[row][col] = true;};
  for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const y = row + r, x = col + c;
      if (y < 0 || y >= size || x < 0 || x >= size) continue;
      set(y, x, r >= 0 && r <= 6 && (c === 0 || c === 6) || c >= 0 && c <= 6 && (r === 0 || r === 6) || r >= 2 && r <= 4 && c >= 2 && c <= 4);
    }
  }
  for (let i = 8; i < size - 8; i++) {set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0);}
  const centres = ALIGNMENT[version];
  const last = centres.at(-1);
  for (const row of centres) for (const col of centres) {
    if (row === 6 && col === 6 || row === 6 && col === last || row === last && col === 6) continue;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) set(row + r, col + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
  }
  // Format areas are reserved here and written per mask.
  for (let i = 0; i < 9; i++) {reserved[8][i] = reserved[i][8] = true;}
  for (let i = 0; i < 8; i++) {reserved[8][size - 1 - i] = reserved[size - 1 - i][8] = true;}
  set(size - 8, 8, true);
  if (version >= 7) {
    const bits = bch(version, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const row = Math.floor(i / 3), col = i % 3 + size - 11, dark = (bits >> i & 1) === 1;
      set(row, col, dark); set(col, row, dark);
    }
  }
  return {size, modules, reserved};
}

function place(matrix, data) {
  const {size, modules, reserved} = matrix;
  let bit = 0, upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const x of [col, col - 1]) {
        if (reserved[row][x]) continue;
        modules[row][x] = bit < data.length * 8 && (data[bit >> 3] >> (7 - (bit & 7)) & 1) === 1;
        bit++;
      }
    }
    upward = !upward;
  }
}

function format(modules, size, mask) {
  // Level M is 00.
  const bits = bch(mask, 0x537, 10) ^ 0x5412;
  for (let i = 0; i < 15; i++) {
    const dark = (bits >> i & 1) === 1;
    if (i < 6) modules[i][8] = dark; else if (i < 8) modules[i + 1][8] = dark; else modules[size - 15 + i][8] = dark;
    if (i < 8) modules[8][size - i - 1] = dark; else if (i < 9) modules[8][15 - i] = dark; else modules[8][14 - i] = dark;
  }
}

function penalty(modules) {
  const size = modules.length;
  let score = 0, dark = 0;
  for (let i = 0; i < size; i++) {
    for (const line of [modules[i], modules.map(row => row[i])]) {
      let run = 1;
      for (let j = 1; j <= size; j++) {
        if (j < size && line[j] === line[j - 1]) {run++; continue;}
        if (run >= 5) score += run - 2;
        run = 1;
      }
      for (let j = 0; j + 10 < size; j++) {
        const window = line.slice(j, j + 11).reduce((value, module) => value << 1 | (module ? 1 : 0), 0);
        if (window === 0b10111010000 || window === 0b00001011101) score += 40;
      }
    }
    for (let j = 0; j < size; j++) {
      if (modules[i][j]) dark++;
      if (i + 1 < size && j + 1 < size) {
        const value = modules[i][j];
        if (modules[i + 1][j] === value && modules[i][j + 1] === value && modules[i + 1][j + 1] === value) score += 3;
      }
    }
  }
  return score + Math.abs(Math.ceil(dark * 100 / (size * size) / 5) - 10) * 10;
}

/**
 * Encode text as a QR matrix.
 * @param {string} text - UTF-8 content, at most 213 bytes.
 * @returns {{version: number, mask: number, modules: boolean[][]}}
 */
export function encodeQr(text) {
  const bytes = [...new TextEncoder().encode(text)];
  const version = BLOCKS.findIndex((row, index) => row && (row[0] - row[1] * row.slice(2).reduce((sum, [count]) => sum + count, 0)) * 8 >= 4 + (index < 10 ? 8 : 16) + bytes.length * 8);
  if (version < 1) throw new Error('QR content is too long');
  const data = codewords(bytes, version);
  let best;
  for (let mask = 0; mask < 8; mask++) {
    const matrix = base(version);
    place(matrix, data);
    for (let row = 0; row < matrix.size; row++) for (let col = 0; col < matrix.size; col++) if (!matrix.reserved[row][col] && MASKS[mask](row, col)) matrix.modules[row][col] = !matrix.modules[row][col];
    format(matrix.modules, matrix.size, mask);
    const score = penalty(matrix.modules);
    if (!best || score < best.score) best = {version, mask, modules: matrix.modules, score};
  }
  return {version: best.version, mask: best.mask, modules: best.modules};
}

/** An SVG image of the text's QR code with a four-module quiet zone. */
export function qrSvg(text, scale = 6) {
  const {modules} = encodeQr(text), size = modules.length + 8;
  let path = '';
  modules.forEach((row, y) => row.forEach((dark, x) => {if (dark) path += `M${x + 4} ${y + 4}h1v1h-1z`;}));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * scale}" height="${size * scale}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
