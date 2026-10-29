import { randomBytes } from 'node:crypto';

export const idPrefixes = {
  run: 'run',
  step: 'stp',
  request: 'req',
  response: 'res',
  hit: 'hit',
  dataLayerEvent: 'dle',
  tagReport: 'tag',
  consentEpoch: 'cep',
  checkpoint: 'ckp',
  result: 'rsl',
  flag: 'flg',
  collectorReport: 'rpt',
} as const;

export type IdKind = keyof typeof idPrefixes;
export type Id<P extends string = string> = `${P}_${string}`;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const RANDOM_MAX = (1n << 80n) - 1n;

let lastTime = -1;
let lastRandom = 0n;

function encode(value: bigint, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

// Top bit cleared so that counting up inside one millisecond cannot overflow in practice.
function freshRandom(): bigint {
  return BigInt('0x' + randomBytes(10).toString('hex')) >> 1n;
}

/** 26-character ULID. Strictly increasing within this process, also inside one millisecond. */
export function ulid(now: number = Date.now()): string {
  let time = now;
  if (time <= lastTime) {
    // A clock step back must not break ordering, so keep counting from the last ULID.
    time = lastTime;
    lastRandom += 1n;
    if (lastRandom > RANDOM_MAX) {
      time += 1;
      lastRandom = freshRandom();
    }
  } else {
    lastRandom = freshRandom();
  }
  lastTime = time;
  return encode(BigInt(time), TIME_LEN) + encode(lastRandom, RANDOM_LEN);
}

export function newId<K extends IdKind>(kind: K, now?: number): Id<(typeof idPrefixes)[K]> {
  return `${idPrefixes[kind]}_${ulid(now)}` as Id<(typeof idPrefixes)[K]>;
}

export function idKind(id: string): IdKind | undefined {
  const prefix = id.slice(0, id.indexOf('_'));
  const entry = Object.entries(idPrefixes).find(([, p]) => p === prefix);
  return entry ? (entry[0] as IdKind) : undefined;
}

const ID_PATTERN = new RegExp(`^[a-z]{3}_[${ALPHABET}]{26}$`);

export function isId(value: unknown, kind?: IdKind): value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) return false;
  return kind ? value.startsWith(`${idPrefixes[kind]}_`) : idKind(value) !== undefined;
}
