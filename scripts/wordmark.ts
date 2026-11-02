// Draws the "tagreeve" wordmark as outlines from the Jost Medium file that the docs theme self-hosts,
// and writes it into the brand SVGs. Run: node scripts/wordmark.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const WORD = 'tagreeve';
const X_HEIGHT = 23;
const BASELINE = 45;
const LEFT = 83;
const RIGHT_MARGIN = 10.6;

const path = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const woff = readFileSync(path('node_modules/@fontsource/jost/files/jost-latin-500-normal.woff'));

const tables = new Map<string, Buffer>();
for (let i = 0; i < woff.readUInt16BE(12); i++) {
  const entry = 44 + i * 20;
  const offset = woff.readUInt32BE(entry + 4);
  const compressed = woff.readUInt32BE(entry + 8);
  const length = woff.readUInt32BE(entry + 12);
  const raw = woff.subarray(offset, offset + compressed);
  tables.set(woff.toString('latin1', entry, entry + 4), compressed < length ? inflateSync(raw) : raw);
}
const table = (name: string): Buffer => {
  const found = tables.get(name);
  if (!found) throw new Error(`The font has no ${name} table`);
  return found;
};

const head = table('head');
const longLoca = head.readInt16BE(50) === 1;
const loca = table('loca');
const glyf = table('glyf');
const hmtx = table('hmtx');
const hMetrics = table('hhea').readUInt16BE(34);

function glyphIndex(char: string): number {
  const cmap = table('cmap');
  const code = char.codePointAt(0)!;
  for (let i = 0; i < cmap.readUInt16BE(2); i++) {
    const offset = cmap.readUInt32BE(4 + i * 8 + 4);
    if (cmap.readUInt16BE(offset) !== 4) continue;
    const segments = cmap.readUInt16BE(offset + 6) / 2;
    const ends = offset + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const rangeOffsets = deltas + segments * 2;
    for (let s = 0; s < segments; s++) {
      if (code > cmap.readUInt16BE(ends + s * 2) || code < cmap.readUInt16BE(starts + s * 2)) continue;
      const range = cmap.readUInt16BE(rangeOffsets + s * 2);
      if (range === 0) return (code + cmap.readInt16BE(deltas + s * 2)) & 0xffff;
      const at = rangeOffsets + s * 2 + range + (code - cmap.readUInt16BE(starts + s * 2)) * 2;
      const glyph = cmap.readUInt16BE(at);
      return glyph === 0 ? 0 : (glyph + cmap.readInt16BE(deltas + s * 2)) & 0xffff;
    }
  }
  throw new Error(`The font has no glyph for ${char}`);
}

type Point = { x: number; y: number; on: boolean };

function contours(glyph: number): Point[][] {
  const start = longLoca ? loca.readUInt32BE(glyph * 4) : loca.readUInt16BE(glyph * 2) * 2;
  const end = longLoca ? loca.readUInt32BE(glyph * 4 + 4) : loca.readUInt16BE(glyph * 2 + 2) * 2;
  if (start === end) return [];
  const count = glyf.readInt16BE(start);
  if (count < 0) throw new Error('Composite glyphs are not supported');
  const ends = Array.from({ length: count }, (_, i) => glyf.readUInt16BE(start + 10 + i * 2));
  const total = ends[count - 1]! + 1;
  let at = start + 10 + count * 2;
  at += 2 + glyf.readUInt16BE(at);
  const flags: number[] = [];
  while (flags.length < total) {
    const flag = glyf.readUInt8(at++);
    flags.push(flag);
    if (flag & 8) for (let repeat = glyf.readUInt8(at++); repeat > 0; repeat--) flags.push(flag);
  }
  const read = (short: number, same: number): number[] => {
    const values: number[] = [];
    let value = 0;
    for (const flag of flags) {
      if (flag & short) {
        const delta = glyf.readUInt8(at++);
        value += flag & same ? delta : -delta;
      } else if (!(flag & same)) {
        value += glyf.readInt16BE(at);
        at += 2;
      }
      values.push(value);
    }
    return values;
  };
  const xs = read(2, 16);
  const ys = read(4, 32);
  const result: Point[][] = [];
  let first = 0;
  for (const last of ends) {
    result.push(Array.from({ length: last - first + 1 }, (_, i) => ({ x: xs[first + i]!, y: ys[first + i]!, on: (flags[first + i]! & 1) === 1 })));
    first = last + 1;
  }
  return result;
}

const advance = (glyph: number): number => hmtx.readUInt16BE(Math.min(glyph, hMetrics - 1) * 4);

const xHeightUnits = Math.max(...contours(glyphIndex('x')).flat().map((p) => p.y));
const scale = X_HEIGHT / xHeightUnits;
const num = (value: number): string => String(Number(value.toFixed(2)));

function outline(points: Point[], dx: number): string {
  const map = (p: Point) => `${num(dx + p.x * scale)} ${num(BASELINE - p.y * scale)}`;
  const expanded = points.flatMap((p, i) => {
    const next = points[(i + 1) % points.length]!;
    return !p.on && !next.on ? [p, { x: (p.x + next.x) / 2, y: (p.y + next.y) / 2, on: true }] : [p];
  });
  const first = expanded.findIndex((p) => p.on);
  const ring = [...expanded.slice(first), ...expanded.slice(0, first)];
  let d = `M${map(ring[0]!)}`;
  for (let i = 1; i <= ring.length; ) {
    const p = ring[i % ring.length]!;
    if (p.on) {
      d += `L${map(p)}`;
      i++;
    } else {
      d += `Q${map(p)} ${map(ring[(i + 1) % ring.length]!)}`;
      i += 2;
    }
  }
  return `${d}Z`;
}

let pen = LEFT;
let outlines = '';
let right = LEFT;
for (const char of WORD) {
  const glyph = glyphIndex(char);
  const shapes = contours(glyph);
  for (const shape of shapes) outlines += outline(shape, pen);
  const xMax = Math.max(...shapes.flat().map((p) => p.x));
  right = pen + xMax * scale;
  pen += advance(glyph) * scale;
}
const width = Math.ceil(right + RIGHT_MARGIN);

const wordmark = /(<path fill="#[0-9A-Fa-f]{6}" d=")[^"]*(")/;
for (const file of ['brand/lockup.svg', 'brand/lockup-dark.svg', 'brand/social-preview.svg']) {
  const text = readFileSync(path(file), 'utf8');
  let next = text.replace(wordmark, (_, open: string, close: string) => `${open}${outlines}${close}`);
  if (file.startsWith('brand/lockup')) {
    next = next.replace(/width="\d+" height="64" viewBox="0 0 \d+ 64"/, `width="${width}" height="64" viewBox="0 0 ${width} 64"`);
  }
  writeFileSync(path(file), next);
}
console.log(`wordmark width ${width}`);
