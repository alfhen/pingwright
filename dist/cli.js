#!/usr/bin/env node

// packages/recorder/src/origins.ts
var COLLECTOR_ORIGIN = "https://collector.tagreeve.invalid";
var SELFTEST_ORIGIN = "https://selftest.tagreeve.invalid";

// packages/recorder/src/user-agent.ts
function osToken() {
  switch (process.platform) {
    case "darwin":
      return "Macintosh; Intel Mac OS X 10_15_7";
    case "win32":
      return "Windows NT 10.0; Win64; x64";
    default:
      return "X11; Linux x86_64";
  }
}
function chromeUserAgent(browserVersion) {
  const major = browserVersion.split(".")[0];
  return `Mozilla/5.0 (${osToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// packages/core/src/ids.ts
import { randomBytes } from "node:crypto";
var idPrefixes = {
  run: "run",
  step: "stp",
  request: "req",
  response: "res",
  hit: "hit",
  dataLayerEvent: "dle",
  tagReport: "tag",
  consentEpoch: "cep",
  checkpoint: "ckp",
  result: "rsl",
  flag: "flg",
  collectorReport: "rpt"
};
var ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
var TIME_LEN = 10;
var RANDOM_LEN = 16;
var RANDOM_MAX = (1n << 80n) - 1n;
var lastTime = -1;
var lastRandom = 0n;
function encode(value, length) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}
function freshRandom() {
  return BigInt("0x" + randomBytes(10).toString("hex")) >> 1n;
}
function ulid(now = Date.now()) {
  let time = now;
  if (time <= lastTime) {
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
function newId(kind, now) {
  return `${idPrefixes[kind]}_${ulid(now)}`;
}
function idKind(id) {
  const sep = id.indexOf("_");
  if (sep < 0) return void 0;
  const prefix = id.slice(0, sep);
  const entry = Object.entries(idPrefixes).find(([, p]) => p === prefix);
  return entry ? entry[0] : void 0;
}
var ID_PATTERN = new RegExp(`^[a-z]{3}_[${ALPHABET}]{26}$`);
function isId(value, kind) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) return false;
  return kind ? value.startsWith(`${idPrefixes[kind]}_`) : idKind(value) !== void 0;
}

// packages/core/src/clock.ts
function nodeNow() {
  return Date.now();
}
var pageNowExpression = "performance.timeOrigin + performance.now()";
function measurePageOffset(nodeTime, pageTime) {
  return nodeTime - pageTime;
}
function bestPageOffset(samples) {
  let best;
  for (const s of samples) {
    const rtt = s.after - s.before;
    const offset = measurePageOffset(s.before + rtt / 2, s.page);
    if (!best || rtt < best.rtt) best = { rtt, offset };
  }
  if (!best) throw new Error("bestPageOffset needs at least one sample");
  return best.offset;
}
function pageTimeToEpoch(pageTime, offset) {
  return pageTime + offset;
}

// packages/core/src/records.ts
var RECORD_SCHEMA_VERSION = 4;

// packages/core/src/store.ts
import { createReadStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
function runFilePath(runsDir, runId) {
  if (!isId(runId, "run")) throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
  return join(runsDir, `${runId}.jsonl`);
}
var RunWriter = class _RunWriter {
  constructor(path, handle) {
    this.path = path;
    this.handle = handle;
  }
  path;
  handle;
  queue = Promise.resolve();
  closed = false;
  static async create(runsDir, run) {
    await mkdir(runsDir, { recursive: true });
    const path = runFilePath(runsDir, run.id);
    const handle = await open(path, "wx");
    const writer = new _RunWriter(path, handle);
    await writer.append({ ...run, recordSchemaVersion: RECORD_SCHEMA_VERSION });
    return writer;
  }
  append(record) {
    if (this.closed) return Promise.reject(new Error("RunWriter is closed"));
    const line = JSON.stringify(record) + "\n";
    const next = this.queue.then(() => this.handle.appendFile(line));
    this.queue = next.catch(() => void 0);
    return next;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.handle.close();
  }
};
function emptyRecords(run) {
  return {
    run,
    steps: [],
    requests: [],
    responses: [],
    hits: [],
    dataLayerEvents: [],
    tagReports: [],
    consentEpochs: [],
    checkpoints: [],
    results: [],
    flags: [],
    collectorReports: [],
    invalidReports: []
  };
}
function upsert(list2, record) {
  const at = list2.findIndex((r) => r.id === record.id);
  if (at < 0) list2.push(record);
  else list2[at] = record;
}
function missingRunFields(run) {
  const missing = [];
  if (typeof run.id !== "string" || !isId(run.id, "run")) missing.push("id");
  if (typeof run.scenario !== "string") missing.push("scenario");
  if (typeof run.site !== "string") missing.push("site");
  if (typeof run.startedAt !== "number") missing.push("startedAt");
  return missing;
}
async function readRun(path, options = {}) {
  const warn = options.onWarning ?? ((message) => console.warn(message));
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  let out;
  let lineNo = 0;
  let badLine = 0;
  for await (const line of lines) {
    lineNo++;
    if (line.trim() === "") continue;
    if (badLine) throw new Error(`${path}:${badLine}: invalid JSON`);
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      badLine = lineNo;
      continue;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new Error(`${path}:${lineNo}: record must be a JSON object`);
    }
    if (!out) {
      if (record.type !== "run") throw new Error(`${path}:${lineNo}: first record must be a run`);
      const missing = missingRunFields(record);
      if (missing.length) throw new Error(`${path}:${lineNo}: run record is missing ${missing.join(", ")}`);
      out = emptyRecords(record);
      const version = record.recordSchemaVersion;
      if (version === void 0) {
        record.recordSchemaVersion = 0;
      } else if (!Number.isInteger(version) || version < 0) {
        throw new Error(`${path}:${lineNo}: recordSchemaVersion must be a non-negative integer`);
      } else if (version > RECORD_SCHEMA_VERSION) {
        warn(
          `${path}: record schema version ${version} is newer than this reader knows (${RECORD_SCHEMA_VERSION}); fields may be missing or misread`
        );
      }
      continue;
    }
    switch (record.type) {
      case "run":
        throw new Error(`${path}:${lineNo}: more than one run record`);
      case "step":
        upsert(out.steps, record);
        break;
      case "request":
        out.requests.push(record);
        break;
      case "response":
        out.responses.push(record);
        break;
      case "hit":
        out.hits.push(record);
        break;
      case "dataLayerEvent":
        out.dataLayerEvents.push(record);
        break;
      case "tagReport":
        out.tagReports.push(record);
        break;
      case "consentEpoch":
        upsert(out.consentEpochs, record);
        break;
      case "checkpoint":
        out.checkpoints.push(record);
        break;
      case "result":
        out.results.push(record);
        break;
      case "flag":
        out.flags.push(record);
        break;
      case "collectorReport":
        out.collectorReports.push(record);
        break;
      case "invalidReport":
        out.invalidReports.push(record);
        break;
      default:
        throw new Error(`${path}:${lineNo}: unknown record type ${String(record.type)}`);
    }
  }
  if (!out) throw new Error(badLine ? `${path}:${badLine}: invalid JSON` : `${path}: empty run file`);
  if (badLine) out.truncatedAtLine = badLine;
  return out;
}

// packages/core/src/identity.ts
import { createHash } from "node:crypto";
import { Faker, base, de, en, en_GB, en_US, sv } from "@faker-js/faker";
var US_AREA_CODES = [201, 202, 206, 212, 213, 214, 305, 312, 404, 415, 512, 602, 617, 702, 718, 808];
var US = {
  locale: [en_US, en, base],
  zip: (faker) => faker.location.zipCode("#####"),
  phone: (faker) => `+1${faker.helpers.arrayElement(US_AREA_CODES)}5550${faker.number.int({ min: 100, max: 199 })}`,
  nationalDigits: (digits) => digits.slice(1)
};
var SE = {
  locale: [sv, en, base],
  zip: (faker) => String(faker.number.int({ min: 100, max: 984 })) + " " + faker.string.numeric(2),
  phone: (faker) => `+4670174${String(faker.number.int({ min: 605, max: 699 })).padStart(4, "0")}`,
  nationalDigits: (digits) => "0" + digits.slice(2)
};
var GB = {
  locale: [en_GB, en, base],
  // The en_GB locale patterns can give shapes such as "SW54 27L".
  zip: (faker) => faker.helpers.fromRegExp("[A-PR-UWYZ][A-HK-Y]?[0-9] [0-9][ABD-HJLNP-UW-Z]{2}"),
  phone: (faker) => `+447700900${String(faker.number.int({ min: 0, max: 999 })).padStart(3, "0")}`,
  nationalDigits: (digits) => "0" + digits.slice(2)
};
var DE = {
  locale: [de, en, base],
  zip: (faker) => faker.location.zipCode(),
  phone: (faker) => `+493023125${String(faker.number.int({ min: 0, max: 999 })).padStart(3, "0")}`,
  nationalDigits: (digits) => "0" + digits.slice(2)
};
var COUNTRIES = { US, SE, GB, DE };
var FICTIONAL_PHONE_HINT = {
  US: "+1 <area code> 555 0100 to 0199",
  SE: "+46 70 174 0605 to 0699",
  GB: "+44 7700 900000 to 900999",
  DE: "+49 30 23125000 to 23125999"
};
function hasCountryFormat(country) {
  return Object.hasOwn(COUNTRIES, country.toUpperCase());
}
function createIdentity(seed, options = {}) {
  const country = options.country ?? "US";
  const format = (hasCountryFormat(country) ? COUNTRIES[country.toUpperCase()] : void 0) ?? US;
  const faker = new Faker({ locale: format.locale });
  faker.seed(seed);
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const tag = faker.string.alphanumeric({ length: 4, casing: "lower" });
  const phone = format.phone(faker);
  return {
    seed,
    firstName,
    lastName,
    email: `${firstName}.${lastName}.${tag}@example.com`.toLowerCase().replace(/[^a-z0-9.@]/g, ""),
    phone,
    address1: faker.location.streetAddress(),
    city: faker.location.city(),
    zip: format.zip(faker),
    country
  };
}
function normalizeEmail(email) {
  return email.trim().toLowerCase();
}
function normalizePhone(phone) {
  return "+" + phone.replace(/\D/g, "");
}
function sha256(value) {
  const digest2 = createHash("sha256").update(value, "utf8").digest();
  return {
    hex: digest2.toString("hex"),
    base64: digest2.toString("base64"),
    base64url: digest2.toString("base64url")
  };
}
function hashEmail(email) {
  return sha256(normalizeEmail(email));
}
function hashPhone(phone) {
  return sha256(normalizePhone(phone));
}
var MAX_DEPTH = 3;
var EMAIL = /(?<![a-z0-9._+-])[a-z0-9._+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
var FILE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|css|js|mjs|json|map|woff2?|ttf|otf|eot|wasm|webm)$/i;
var PHONE = /(?<=^|[=\s"']|tel:)\+(?=\d)\d(?:[ .-]?\d){7,14}(?!\d|\+\d)|(?<=^|[=\s"'])\+\d+(?:\+\d+)+(?=$|[&\s"'])|\(\d{3}\)\s?\d{3}[-.\s]\d{4}|(?<![\w-])(?:1[-.\s])?\d{3}[-.\s]\d{3}[-.\s]\d{4}(?![\w-])/g;
var HASH = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi;
var NON_PERSONAL_HASH_KEYS = /* @__PURE__ */ new Set([
  "hmac",
  "client_id",
  "clientid",
  "client_id_hash",
  "clientidhash",
  "cid",
  "controllerid",
  "controller_id",
  "visitor_id",
  "visitorid",
  "device_id",
  "deviceid",
  "session_id",
  "sessionid",
  "anonymous_id",
  "anonymousid",
  "state",
  "nonce",
  "csrf",
  "csrf_token",
  "csrftoken"
]);
var REUSABLE_ID_KEYS = /* @__PURE__ */ new Set(["uid", "user_id", "userid", "external_id", "externalid", "id", "uuid", "guid"]);
var KEY_PREFIX = /^(?:epn?|up|upn|cd|ud)[._]/;
var KEY_BEFORE_VALUE = /([\w.[\]-]+)["']?\s*[=:]\s*["']?$/;
var MULTIPART_KEY = /\bname=["']([\w.[\]-]+)["'][^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n$/;
var BASE64_TOKEN = /[A-Za-z0-9+/_-]{12,}={0,2}/g;
function tryUrlDecode(text2) {
  if (!/%[0-9a-f]{2}/i.test(text2)) return void 0;
  return text2.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}
var utf8Lenient = new TextDecoder("utf-8");
var EDGE = 4;
var MIN_BYTES_FOR_EDGES = 12;
function binaryShare(text2) {
  let total2 = 0;
  let binary = 0;
  for (const ch of text2) {
    total2++;
    const c = ch.codePointAt(0);
    if (c === 65533 || c < 32 && c !== 9 && c !== 10 && c !== 13 || c === 127) binary++;
  }
  return total2 === 0 ? 0 : binary / total2;
}
function tryBase64Decode(token) {
  const bytes = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (bytes.length < 8) return void 0;
  const text2 = utf8Lenient.decode(bytes);
  const inner = bytes.length >= MIN_BYTES_FOR_EDGES ? [...text2].slice(EDGE, -EDGE) : [...text2];
  if (inner.length < 4) return void 0;
  return binaryShare(inner.join("")) <= 0.05 ? text2 : void 0;
}
function hasUrlEscapes(text2) {
  const decoded = tryUrlDecode(text2);
  return decoded !== void 0 && decoded !== text2;
}
function keyNameBefore(text2, index) {
  const before = text2.slice(Math.max(0, index - 128), index);
  const key = KEY_BEFORE_VALUE.exec(before.slice(-64))?.[1] ?? MULTIPART_KEY.exec(before)?.[1];
  if (!key) return void 0;
  return key.toLowerCase().replace(/[[\]]/g, "_").replace(/^_+|_+$/g, "").replace(KEY_PREFIX, "");
}
function isNonPersonalKey(text2, index) {
  const name = keyNameBefore(text2, index);
  return name !== void 0 && NON_PERSONAL_HASH_KEYS.has(name);
}
function findStableHashes(sources) {
  const seen = /* @__PURE__ */ new Map();
  for (const { requestId, text: text2 } of sources) {
    for (const variant of variants(text2)) {
      if (hasUrlEscapes(variant)) continue;
      for (const m of variant.matchAll(HASH)) {
        const hash = m[0].toLowerCase();
        const name = keyNameBefore(variant, m.index);
        let entry = seen.get(hash);
        if (!entry) seen.set(hash, entry = { keys: /* @__PURE__ */ new Set(), requests: /* @__PURE__ */ new Set(), allIdLike: true });
        const idLike = name !== void 0 && (REUSABLE_ID_KEYS.has(name) || NON_PERSONAL_HASH_KEYS.has(name));
        if (!idLike) entry.allIdLike = false;
        else if (REUSABLE_ID_KEYS.has(name)) {
          entry.keys.add(name.replace(/_/g, ""));
          entry.requests.add(requestId);
        }
      }
    }
  }
  const stable = /* @__PURE__ */ new Set();
  for (const [hash, e] of seen) if (e.allIdLike && (e.keys.size >= 2 || e.requests.size >= 2)) stable.add(hash);
  return stable;
}
var MAX_BOUNDARIES = 8;
var GLUE = /* @__PURE__ */ new Set(["_", "-", "+"]);
function* glueCuts(piece) {
  yield piece;
  const bounds = [];
  for (let i = 0; i < piece.length && bounds.length < MAX_BOUNDARIES; i++) if (GLUE.has(piece[i])) bounds.push(i);
  const tail = [];
  for (let i = piece.length - 1; i >= 0 && tail.length < MAX_BOUNDARIES; i--) if (GLUE.has(piece[i])) tail.push(i);
  const all = [.../* @__PURE__ */ new Set([...bounds, ...tail])];
  if (all.length === 0) return;
  const first = Math.min(...all);
  const last = Math.max(...all);
  for (const i of all) {
    yield piece.slice(i + 1);
    yield piece.slice(0, i);
  }
  if (last > first) yield piece.slice(first + 1, last);
}
function* base64Decodes(text2) {
  for (const token of text2.match(BASE64_TOKEN) ?? []) {
    const pieces = /* @__PURE__ */ new Set([token]);
    if (token.includes("/")) {
      for (const piece of token.split("/")) if (piece.length >= 12) pieces.add(piece);
    }
    const seen = /* @__PURE__ */ new Set();
    const attempt = (candidate) => {
      if (candidate.length < 12 || seen.has(candidate)) return void 0;
      seen.add(candidate);
      return tryBase64Decode(candidate);
    };
    for (const piece of pieces) {
      for (const cut of glueCuts(piece)) {
        for (let offset = 0; offset <= 3; offset++) {
          const decoded = attempt(cut.slice(offset));
          if (decoded !== void 0) {
            yield decoded;
          }
        }
      }
    }
  }
}
var DIGEST_VALUE = "([A-Za-z0-9+/_-]{43}={0,2})(?![A-Za-z0-9+/_=-])";
var IDENTITY_DIGEST_KEY = new RegExp(
  `(?<![\\w.\\[\\]-])(?:em|ph|fn|ln|ud\\[[^\\]&=]+\\]|sha256_(?:email_address|phone_number|first_name|last_name)|user_data\\.[\\w.]+)["']?\\s*[=:]\\s*["']?${DIGEST_VALUE}`,
  "gi"
);
var ADS_USER_DATA = /tv\.1~([^&\s"']*)/gi;
var ADS_FIELD = /^(?:em|ph|fn|ln)\.(.+)$/i;
function isDigest(token) {
  const bare = token.replace(/=+$/, "");
  return bare.length === 43 && Buffer.from(bare.replace(/-/g, "+").replace(/_/g, "/"), "base64").length === 32;
}
function* keyedDigests(text2) {
  for (const m of text2.matchAll(IDENTITY_DIGEST_KEY)) if (isDigest(m[1])) yield m[1];
  for (const m of text2.matchAll(ADS_USER_DATA)) {
    for (const field of m[1].split("~")) {
      const value = ADS_FIELD.exec(field)?.[1];
      if (value !== void 0 && /^[A-Za-z0-9+/_-]{43}={0,2}$/.test(value) && isDigest(value)) yield value;
    }
  }
}
function* variants(text2, depth = 0, seen = /* @__PURE__ */ new Set()) {
  if (seen.has(text2)) return;
  seen.add(text2);
  yield text2;
  const url = tryUrlDecode(text2);
  if (url !== void 0 && url !== text2) yield* variants(url, depth, seen);
  if (depth >= MAX_DEPTH) return;
  for (const decoded of base64Decodes(text2)) yield* variants(decoded, depth + 1, seen);
}
function fieldHashes(...values) {
  const hashes = /* @__PURE__ */ new Set();
  for (const value of values) {
    const lower = value.trim().toLowerCase();
    hashes.add(sha256(lower).hex);
    hashes.add(sha256(lower.replace(/[^\p{L}\p{N}]/gu, "")).hex);
  }
  for (const hex of [...hashes]) {
    const bytes = Buffer.from(hex, "hex");
    hashes.add(bytes.toString("base64").replace(/=+$/, ""));
    hashes.add(bytes.toString("base64url"));
  }
  return hashes;
}
function ownValues(identity) {
  const email = normalizeEmail(identity.email);
  const phone = normalizePhone(identity.phone);
  const extra = identity.extra ?? [];
  const fields2 = [
    email,
    phone,
    phone.slice(1),
    identity.firstName,
    identity.lastName,
    identity.address1,
    identity.city,
    identity.zip,
    identity.country,
    ...extra
  ];
  const hashes = fieldHashes(...fields2);
  const phoneDigits = phone.slice(1);
  const format = (hasCountryFormat(identity.country) ? COUNTRIES[identity.country.toUpperCase()] : void 0) ?? US;
  const extraEmails = extra.map(normalizeEmail).filter((v) => v.includes("@"));
  const extraPhones = extra.map((v) => v.replace(/\D/g, "")).filter((v) => v.length >= 8);
  return { email, phoneDigits, nationalDigits: format.nationalDigits(phoneDigits), hashes, extraEmails, extraPhones };
}
function* candidates(text2) {
  for (const variant of variants(text2)) {
    if (!hasUrlEscapes(variant)) {
      for (const raw of variant.match(EMAIL) ?? []) {
        const m = raw.slice(raw.lastIndexOf("+") + 1);
        if (!m.includes("@") || FILE_EXTENSION.test(m)) continue;
        const both = raw !== m && raw.indexOf("+") === raw.lastIndexOf("+") && !raw.startsWith("+");
        yield { kind: "email", value: m, alternate: both ? raw : void 0, variant, index: 0 };
      }
    }
    for (const m of variant.match(PHONE) ?? []) {
      const digits = m.replace(/\D/g, "");
      if (digits.length < 8 || digits.length > 15) continue;
      if (/^\+\d+\+/.test(m) && !/^\+\d{1,3}\+/.test(m)) continue;
      yield { kind: "phone", value: m, variant, index: 0 };
    }
    if (!hasUrlEscapes(variant)) {
      for (const m of variant.matchAll(HASH)) yield { kind: "hash", value: m[0].toLowerCase(), variant, index: m.index };
    }
  }
}
function valueKinds(text2) {
  const kinds = /* @__PURE__ */ new Set();
  for (const c of candidates(text2)) kinds.add(c.kind);
  return kinds;
}
function scan(text2, identity, options = {}) {
  const own = ownValues(identity);
  const found = /* @__PURE__ */ new Map();
  const add2 = (kind, value) => {
    const key = `${kind}:${value}`;
    if (!found.has(key)) found.set(key, { kind, value });
  };
  for (const c of candidates(text2)) {
    if (c.kind === "email") {
      if (normalizeEmail(c.value).includes(own.email) || own.extraEmails.includes(normalizeEmail(c.value))) continue;
      add2("email", c.value);
      if (c.alternate) add2("email", c.alternate);
    } else if (c.kind === "phone") {
      const digits = c.value.replace(/\D/g, "");
      if (!digits.includes(own.phoneDigits) && !digits.includes(own.nationalDigits) && !own.extraPhones.includes(digits)) add2("phone", c.value);
    } else if (!own.hashes.has(c.value) && !options.stableHashes?.has(c.value) && !isNonPersonalKey(c.variant, c.index)) {
      add2("hash", c.value);
    }
  }
  for (const variant of variants(text2)) {
    for (const token of hasUrlEscapes(variant) ? [] : keyedDigests(variant)) {
      if (!own.hashes.has(token.replace(/=+$/, ""))) add2("hash", token);
    }
  }
  return [...found.values()];
}

// packages/core/src/library.ts
var LIBRARY_PATH = /(?:^|\/)(?:gtag\/js|fbevents\.js|signals\/config\/[^/]*)$/;
function isLibraryLoadPath(pathname) {
  return LIBRARY_PATH.test(pathname);
}

// packages/core/src/version.ts
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
function readVersion() {
  for (const rel of ["../package.json", "../../../package.json"]) {
    const file = fileURLToPath(new URL(rel, import.meta.url));
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    if (pkg.name === "tagreeve" && pkg.version) return pkg.version;
  }
  throw new Error("Cannot find the tagreeve package.json");
}

// packages/core/src/glob.ts
function globToRegExp(glob) {
  return new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

// packages/core/src/limits.ts
var MAX_POST_DATA = 64 * 1024;

// packages/decoders/src/decoder.ts
var defaultHitId = () => newId("hit");
var vendorKeys = ["ga4", "google-ads", "meta", "meta-capi", "pinterest", "sgtm"];

// packages/decoders/src/identifiers.ts
var ANALYTICS_ID_NAMES = ["user_id", "uid", "up.user_id"];
var ADS_IDENTITY_NAMES = [
  "external_id",
  "ud",
  "ud[*]",
  "user_data",
  "user_data.*",
  "em",
  "ph",
  "hashed_email",
  "customer_hashed",
  "cookieData"
];
var CLIENT_ID_HASH_NAMES = ["clientIdHash", "client_id_hash", "cid_hash"];
var CLASSES = [
  { cls: "analytics", patterns: ANALYTICS_ID_NAMES.map(globToRegExp) },
  { cls: "adsIdentity", patterns: ADS_IDENTITY_NAMES.map(globToRegExp) },
  { cls: "clientIdHash", patterns: CLIENT_ID_HASH_NAMES.map(globToRegExp) }
];
var HEX_64 = /^[0-9a-f]{64}$/i;
function listedIdentifierClass(name) {
  return CLASSES.find((c) => c.patterns.some((re) => re.test(name)))?.cls;
}
function isIdentifierField(name, value) {
  return listedIdentifierClass(name) !== void 0 || HEX_64.test(value);
}
function identifierClass(name) {
  return listedIdentifierClass(name) ?? "analytics";
}
function identifierSignal(cls, state) {
  if (cls !== "adsIdentity") return { field: "analytics", value: state.analytics };
  return state.adUserData !== "unknown" ? { field: "adUserData", value: state.adUserData } : { field: "ads", value: state.ads };
}

// packages/decoders/src/fields.ts
var OTHER_NAME = "(other)";
var NAME_CHARS = /^[A-Za-z0-9_[\]-]*$/;
var HEX_TOKEN = /^[0-9a-fA-F]{32,}$/;
var DIGEST_TOKEN = /^[A-Za-z0-9_-]{22,}$/;
var LONG_DIGITS = /\d{6,}/;
var BODY_METHODS = /* @__PURE__ */ new Set(["POST", "PUT", "PATCH"]);
function mostlyDigits(segment) {
  const digits = segment.replace(/\D/g, "").length;
  return digits >= 6 && digits * 2 >= segment.length;
}
function looksLikeValueToken(segment) {
  if (segment.length > 64) return true;
  if (HEX_TOKEN.test(segment) || LONG_DIGITS.test(segment) || mostlyDigits(segment)) return true;
  return DIGEST_TOKEN.test(segment) && /[A-Z]/.test(segment) && /[a-z]/.test(segment) && /\d/.test(segment);
}
function isValueSegment(segment) {
  if (looksLikeValueToken(segment) || looksLikeValueToken(segment.replaceAll("-", ""))) return true;
  if (segment.includes("@") || /%[0-9a-fA-F]{2}/.test(segment)) return true;
  return valueKinds(segment).size > 0;
}
function looksLikeValue(segment) {
  return !NAME_CHARS.test(segment) || looksLikeValueToken(segment);
}
function guardFieldName(name) {
  if (name.includes("@")) return OTHER_NAME;
  for (const reading of [name, name.replace(/\[\]/g, "")]) {
    const kinds = valueKinds(reading);
    if (kinds.has("email") || kinds.has("phone")) return OTHER_NAME;
  }
  return name.split(".").map((segment) => looksLikeValue(segment.replace(/\[\]/g, "")) ? OTHER_NAME : segment).join(".");
}
function queryEntries(params) {
  const out = [];
  for (const [name, value] of params) if (value !== "") out.push({ name, value });
  return out;
}
function jsonEntries(value, prefix = "") {
  if (value === null || value === void 0) return [];
  if (Array.isArray(value)) return value.flatMap((item) => jsonEntries(item, `${prefix}[]`));
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => jsonEntries(child, prefix ? `${prefix}.${key}` : key));
  }
  const text2 = String(value);
  return text2 === "" || prefix === "" ? [] : [{ name: prefix, value: text2 }];
}
function bodyEntries(req) {
  const text2 = req.postData;
  if (!text2 || text2.trim() === "") return { entries: [], parsed: true };
  if (/^\s*[{[]/.test(text2)) {
    try {
      return { entries: jsonEntries(JSON.parse(text2)), parsed: true };
    } catch {
      return { entries: [], parsed: false };
    }
  }
  return { entries: queryEntries(new URLSearchParams(text2)), parsed: true };
}
function splitMultipart(body, headers) {
  const contentType = Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  const m = /multipart\/form-data;.*?boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = m?.[1] ?? m?.[2];
  if (!boundary) return null;
  const [preamble = "", ...rest] = body.split(`--${boundary}`);
  const parts = [];
  const epilogue = [];
  const chunks = [{ raw: preamble, part: null }];
  for (const raw of rest) {
    const part = raw.startsWith("--") ? null : parseChunk(raw);
    if (raw.startsWith("--")) epilogue.push(raw);
    else if (part) parts.push(part);
    chunks.push({ raw, part });
  }
  return { boundary, preamble, parts, epilogue: epilogue.join(`--${boundary}`), chunks };
}
function parseChunk(raw) {
  const split = /\r?\n\r?\n/.exec(raw);
  if (!split) return null;
  const headers = {};
  for (const line of raw.slice(0, split.index).split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const bodyStart = split.index + split[0].length;
  return { headers, body: raw.slice(bodyStart).replace(/\r?\n$/, ""), raw, bodyStart };
}
function multipartParts(body, headers) {
  return splitMultipart(body, headers)?.parts ?? null;
}
function multipartPartName(part) {
  return /\bname="([^"]*)"/i.exec(part.headers["content-disposition"] ?? "")?.[1];
}
function bodyComplete(req) {
  if (req.postData === null) return !(req.captured === "netlog" && BODY_METHODS.has(req.method.toUpperCase()));
  return req.postData.length < MAX_POST_DATA;
}
function withFields(hit, entries, complete) {
  const fields2 = /* @__PURE__ */ new Set();
  const idFields = /* @__PURE__ */ new Set();
  for (const { name, value } of entries) {
    const guarded = guardFieldName(name);
    fields2.add(guarded);
    if (isIdentifierField(name, value)) idFields.add(guarded);
  }
  return { ...hit, fields: [...fields2].sort(), fieldsComplete: complete, idFields: [...idFields].sort() };
}

// packages/decoders/src/ignore-lists.ts
var GA4_BODY_ONLY_IGNORE = [
  "v",
  "tid",
  "gtm",
  "_p",
  "_s",
  "sid",
  "sct",
  "seg",
  "dl",
  "dr",
  "dt",
  "en",
  "cid",
  "ul",
  "sr",
  "_eu",
  "_et",
  "gcs",
  "gcd",
  "npa",
  "dma",
  "dma_cps",
  "are",
  "frm",
  "pscdl",
  "tfd",
  "ec",
  "uaa",
  "uab",
  "uafvl",
  "uam",
  "uamb",
  "uap",
  "uapv",
  "uaw",
  "_ss",
  "_fv",
  "_nsi",
  "_c",
  "_ee",
  "_z",
  "_gaz",
  "tag_exp",
  "_tu",
  "ngs"
];
var META_BODY_ONLY_IGNORE = [
  "id",
  "ev",
  "dl",
  "rl",
  "if",
  "ts",
  "sw",
  "sh",
  "v",
  "r",
  "ec",
  "o",
  "fbp",
  "it",
  "coo",
  "rqm",
  "ler",
  "cdl",
  "plt",
  "pmd[*]",
  "expv2[*]",
  "cs_est",
  "a"
];
var META_CAPI_BODY_ONLY_IGNORE = ["event_name", "event_time", "event_id", "event_source_url", "action_source"];
var SGTM_BODY_ONLY_IGNORE = ["v", "tid", "event", "en", "dtdc"];
function matchesIgnoreList(name, list2) {
  return list2.some((entry) => globToRegExp(entry).test(name));
}

// packages/decoders/src/sandbox.ts
var SANDBOX_PATH = /\/(?:web-pixels|wpm)@[^/]+\/(?:[^/]+\/)*?sandbox\//;
var SANDBOX_PREFIX = new RegExp(`${SANDBOX_PATH.source}[^/]*`);
function isSandboxPageUrl(page2) {
  if (!page2) return false;
  try {
    return SANDBOX_PATH.test(new URL(page2).pathname);
  } catch {
    return SANDBOX_PATH.test(page2);
  }
}
function stripSandboxPrefix(path) {
  return path.replace(SANDBOX_PREFIX, "") || "/";
}
function maskValuePath(path, mask) {
  const maskSegments = (part) => part.split("/").map((segment) => isValueSegment(segment) ? mask : segment).join("/");
  const prefix = SANDBOX_PREFIX.exec(path);
  if (!prefix) return maskSegments(path);
  const end = prefix.index + prefix[0].length;
  return maskSegments(path.slice(0, prefix.index)) + prefix[0] + maskSegments(path.slice(end));
}

// packages/decoders/src/ga4.ts
function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return void 0;
  }
}
function isGa4Collect(req) {
  const url = parseUrl(req.url);
  return url?.pathname.endsWith("/g/collect") === true && url.searchParams.get("v") === "2";
}
function gcsValue(flag2) {
  if (flag2 === "1") return "granted";
  if (flag2 === "0") return "denied";
  return "unknown";
}
var GCD_LETTERS = {
  p: "denied",
  q: "denied",
  r: "granted",
  t: "granted",
  m: "denied",
  n: "granted",
  u: "denied",
  v: "granted",
  l: "unknown"
};
function parseGcd(gcd) {
  if (!gcd || gcd.length < 9) return void 0;
  return [2, 4, 6, 8].map((i) => GCD_LETTERS[gcd[i]] ?? "unknown");
}
function pick(...values) {
  return values.find((v) => v === "granted" || v === "denied") ?? "unknown";
}
function decodeGa4Consent(params) {
  const raw = {};
  const gcs = params.get("gcs") ?? void 0;
  const gcd = params.get("gcd") ?? void 0;
  if (gcs) raw.gcs = gcs;
  if (gcd) raw.gcd = gcd;
  const g = /^G1([01])([01])/.exec(gcs ?? "");
  const d = parseGcd(gcd);
  return {
    ads: pick(gcsValue(g?.[1]), d?.[0]),
    analytics: pick(gcsValue(g?.[2]), d?.[1]),
    adUserData: pick(d?.[2]),
    adPersonalization: pick(d?.[3]),
    raw
  };
}
function transport(resourceType) {
  return resourceType === "ping" ? "beacon" : resourceType;
}
function eventLines(req) {
  const base2 = new URL(req.url).searchParams;
  const lines = (req.postData ?? "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [base2];
  return lines.map((line) => {
    const own = new URLSearchParams(line);
    const merged = new URLSearchParams(base2);
    for (const key of new Set(own.keys())) merged.delete(key);
    for (const [k, v] of own) merged.append(k, v);
    return merged;
  });
}
function eventParams(p) {
  const out = {};
  for (const [k, v] of p) {
    if (k.startsWith("ep.")) out[k.slice(3)] = v;
    else if (k.startsWith("epn.")) out[k.slice(4)] = v;
  }
  return out;
}
var ga4 = {
  name: "ga4",
  match: isGa4Collect,
  isCollectionEndpoint: isGa4Collect,
  decode(req, newHitId = defaultHitId) {
    if (!isGa4Collect(req)) return [];
    const complete = bodyComplete(req);
    return eventLines(req).map((p) => {
      const ids = {};
      if (p.get("cid")) ids.client_id = true;
      if (p.get("uid")) ids.user_id = true;
      const tid = p.get("tid");
      return withFields({
        type: "hit",
        id: newHitId(),
        runId: req.runId,
        stepId: req.stepId,
        requestId: req.id,
        t: req.t,
        vendor: "ga4",
        event: p.get("en"),
        consent: decodeGa4Consent(p),
        ids,
        page: p.get("dl"),
        transport: transport(req.resourceType),
        params: { ...eventParams(p), ...tid ? { tid } : {} }
      }, queryEntries(p), complete);
    });
  }
};

// packages/decoders/src/meta.ts
var META_HOSTS = /* @__PURE__ */ new Set(["facebook.com", "www.facebook.com"]);
function isMetaTr(req) {
  try {
    const url = new URL(req.url);
    return META_HOSTS.has(url.hostname) && /^\/tr\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}
function bodyFields(req) {
  const body = req.postData ?? "";
  const parts = multipartParts(body, req.headers);
  if (!parts) return new URLSearchParams(body);
  const fields2 = [];
  for (const part of parts) {
    const name = multipartPartName(part);
    if (name !== void 0) fields2.push([name, part.body]);
  }
  return fields2;
}
function allParams(req) {
  const merged = new URLSearchParams(new URL(req.url).search);
  if (req.method === "POST" && req.postData) {
    for (const [k, v] of bodyFields(req)) merged.set(k, v);
  }
  return merged;
}
var meta = {
  name: "meta",
  match: isMetaTr,
  isCollectionEndpoint: isMetaTr,
  decode(req, newHitId = defaultHitId) {
    if (!isMetaTr(req)) return [];
    const p = allParams(req);
    const ids = {};
    const params = {};
    const pixel = p.get("id");
    if (pixel) params.pixelId = pixel;
    const eid = p.get("eid");
    if (eid) params.eid = eid;
    for (const [k, v] of p) {
      const cd = /^cd\[(.+)\]$/.exec(k);
      if (cd?.[1]) params[cd[1]] = v;
    }
    const udNames = { em: "hashedEmail", ph: "hashedPhone" };
    for (const [k, v] of p) {
      const ud = /^ud\[(.+)\]$/.exec(k);
      if (!ud?.[1] || v === "") continue;
      const name = udNames[ud[1]] ?? ud[1];
      ids[name] = true;
      params[name] = v;
    }
    return [
      withFields({
        type: "hit",
        id: newHitId(),
        runId: req.runId,
        stepId: req.stepId,
        requestId: req.id,
        t: req.t,
        vendor: "meta",
        event: p.get("ev"),
        consent: {
          ads: "unknown",
          analytics: "unknown",
          adUserData: "unknown",
          adPersonalization: "unknown",
          raw: {}
        },
        ids,
        page: p.get("dl"),
        transport: req.resourceType === "ping" ? "beacon" : req.resourceType,
        params
      }, queryEntries(p), bodyComplete(req))
    ];
  }
};

// packages/decoders/src/meta-capi.ts
var HASH_FIELDS = ["em", "ph", "fn", "ln", "ct", "zp", "country", "external_id"];
var META_CAPI_PARAM_NAMES = {
  em: "hashedEmail",
  ph: "hashedPhone",
  fn: "user_data.first_name",
  ln: "user_data.last_name",
  ct: "user_data.city",
  zp: "user_data.postal_code",
  country: "user_data.country"
};
function metaCapiBaseParam(name) {
  return name.replace(/\.\d+$/, "");
}
var PRESENCE_FIELDS = ["fbp", "fbc"];
var EVENTS_PATH = /^\/v\d+(?:\.\d+)?\/(\d+)\/events\/?$/;
function eventsPixel(req) {
  try {
    const url = new URL(req.url);
    return url.hostname === "graph.facebook.com" ? EVENTS_PATH.exec(url.pathname)?.[1] : void 0;
  } catch {
    return void 0;
  }
}
function isMetaCapiEndpoint(req) {
  return eventsPixel(req) !== void 0;
}
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function str(v) {
  const first = Array.isArray(v) ? v[0] : v;
  if (typeof first === "string") return first === "" ? void 0 : first;
  return typeof first === "number" ? String(first) : void 0;
}
function strs(v) {
  return (Array.isArray(v) ? v : [v]).flatMap((item) => {
    if (typeof item === "string") return item === "" ? [] : [item];
    return typeof item === "number" ? [String(item)] : [];
  });
}
function eventItems(body) {
  if (!body) return void 0;
  try {
    const json = /^\s*[{[]/.test(body) ? JSON.parse(body) : JSON.parse(new URLSearchParams(body).get("data") ?? "");
    const data = isObject(json) ? json.data : json;
    return Array.isArray(data) && data.every(isObject) ? data : void 0;
  } catch {
    return void 0;
  }
}
function decodeItem(item, req, pixel, newHitId, complete) {
  const userData2 = isObject(item.user_data) ? item.user_data : {};
  const ids = {};
  const hashes = {};
  const params = { pixelId: pixel };
  for (const field of HASH_FIELDS) {
    const values = strs(userData2[field]);
    if (values.length === 0) continue;
    hashes[field] = { present: true, matchesIdentity: null };
    const param = META_CAPI_PARAM_NAMES[field];
    if (param) values.forEach((value, i) => params[i === 0 ? param : `${param}.${i}`] = value);
  }
  if (Object.keys(hashes).length > 0) ids.hashes = hashes;
  for (const field of PRESENCE_FIELDS) if (str(userData2[field])) ids[field] = true;
  const eventId = str(item.event_id);
  if (eventId) {
    ids.event_id = true;
    params.eventId = eventId;
  }
  return withFields({
    type: "hit",
    id: newHitId(),
    runId: req.runId,
    stepId: req.stepId,
    requestId: req.id,
    t: req.t,
    vendor: "meta-capi",
    event: str(item.event_name) ?? null,
    consent: { ads: "unknown", analytics: "unknown", adUserData: "unknown", adPersonalization: "unknown", raw: {} },
    ids,
    page: str(item.event_source_url) ?? null,
    transport: req.resourceType === "ping" ? "beacon" : req.resourceType,
    params
  }, jsonEntries(item), complete);
}
var metaCapi = {
  name: "meta-capi",
  match: (req) => req.method.toUpperCase() === "POST" && eventsPixel(req) !== void 0,
  isCollectionEndpoint: isMetaCapiEndpoint,
  decode(req, newHitId = defaultHitId) {
    const pixel = eventsPixel(req);
    if (req.method.toUpperCase() !== "POST" || pixel === void 0) return [];
    const items = eventItems(req.postData);
    if (!items) return [decodeItem({}, req, pixel, newHitId, false)];
    const complete = bodyComplete(req);
    return items.map((item) => decodeItem(item, req, pixel, newHitId, complete));
  }
};

// packages/decoders/src/pinterest.ts
function onCollectionHost(req) {
  try {
    const url = new URL(req.url);
    return url.hostname === "ct.pinterest.com" ? url : void 0;
  } catch {
    return void 0;
  }
}
function isPinterestCollect(req) {
  const url = onCollectionHost(req);
  return url !== void 0 && /^\/(?:v3|user)\/?$/.test(url.pathname);
}
function isPinterestHost(req) {
  return onCollectionHost(req) !== void 0;
}
function jsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function text(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : void 0;
}
function flatten(prefix, value, out) {
  const s = text(value);
  if (s !== void 0) {
    if (prefix) out[prefix === "event_id" ? "eventId" : prefix] = s;
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, child] of Object.entries(value)) flatten(prefix ? `${prefix}.${k}` : k, child, out);
  }
}
function bracketKeys(name) {
  const m = /^(ed|pd)((?:\[[^\]]+\])+)$/.exec(name);
  if (!m?.[1] || !m[2]) return void 0;
  return { group: m[1], path: m[2].slice(1, -1).split("][").join(".") };
}
var pinterest = {
  name: "pinterest",
  match: isPinterestCollect,
  isCollectionEndpoint: isPinterestHost,
  decode(req, newHitId = defaultHitId) {
    if (!isPinterestCollect(req)) return [];
    const p = new URL(req.url).searchParams;
    const ed = jsonObject(p.get("ed"));
    const pd = jsonObject(p.get("pd"));
    const ad = jsonObject(p.get("ad"));
    const params = {};
    const tid = p.get("tid");
    if (tid) params.tagId = tid;
    flatten("", ed, params);
    let em = text(pd.em);
    for (const [name, value] of p) {
      const key = bracketKeys(name);
      if (!key || !value) continue;
      if (key.group === "pd") {
        if (key.path === "em") em = value;
      } else {
        params[key.path === "event_id" ? "eventId" : key.path] = value;
      }
    }
    const ids = {};
    if (em) {
      ids.hashedEmail = true;
      params.hashedEmail = em;
    }
    const entries = [];
    let complete = true;
    for (const [name, value] of p) {
      if (value === "") continue;
      if (name !== "ed" && name !== "pd" && name !== "ad") {
        entries.push(...queryEntries([[name, value]]));
        continue;
      }
      const parsed = jsonObject(value);
      if (Object.keys(parsed).length === 0 && value.trim() !== "{}") complete = false;
      entries.push(...jsonEntries(parsed, name));
    }
    return [
      withFields({
        type: "hit",
        id: newHitId(),
        runId: req.runId,
        stepId: req.stepId,
        requestId: req.id,
        t: req.t,
        vendor: "pinterest",
        event: p.get("event") ?? (/^\/user\/?$/.test(new URL(req.url).pathname) ? "user" : null),
        consent: {
          ads: "unknown",
          analytics: "unknown",
          adUserData: "unknown",
          adPersonalization: "unknown",
          raw: {}
        },
        ids,
        page: text(ad.loc) ?? null,
        transport: req.resourceType === "ping" ? "beacon" : req.resourceType,
        params
      }, entries, complete)
    ];
  }
};

// packages/decoders/src/google-ads.ts
var ADS_HOSTS = ["googleadservices.com", "doubleclick.net", "google.com", "googlesyndication.com"];
var PINGS = [
  /^\/pagead\/(?:viewthrough)?conversion\/(\w+)\/?$/,
  /^\/pagead\/1p-conversion\/(\w+)\/?$/,
  /^\/pagead\/1p-user-list\/(\w+)\/?$/,
  /^\/rmkt\/collect\/(\w+)(?:\/\w+)?\/?$/,
  /^\/ccm\/(?:s\/)?collect\/?$/
];
var REMARKETING = /^\/(?:pagead\/(?:viewthroughconversion|1p-user-list)|rmkt\/collect|ccm\/(?:s\/)?collect)(?:\/|$)/;
var GOOGLE_REGIONAL = /^(?:[a-z0-9-]+\.)*google\.(?:com?\.)?[a-z]{2}$/;
function hostMatches(host) {
  return GOOGLE_REGIONAL.test(host) || ADS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}
function pingPath(req) {
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return void 0;
  }
  if (!hostMatches(url.hostname)) return void 0;
  for (const re of PINGS) {
    const m = re.exec(url.pathname);
    if (m) return { url, id: m[1] };
  }
  return void 0;
}
var isAdsPing = (req) => pingPath(req) !== void 0;
function isGtmBeacon(req) {
  try {
    const url = new URL(req.url);
    return url.hostname === "www.googletagmanager.com" && url.pathname === "/td";
  } catch {
    return false;
  }
}
var googleAds = {
  name: "google-ads",
  match: isAdsPing,
  isCollectionEndpoint: (req) => isAdsPing(req) || isGtmBeacon(req),
  decode(req, newHitId = defaultHitId) {
    const ping = pingPath(req);
    if (!ping) return [];
    const p = new URLSearchParams(ping.url.search);
    if (req.method === "POST" && req.postData) {
      for (const [k, v] of new URLSearchParams(req.postData)) p.set(k, v);
    }
    const ids = {};
    for (const key of ["gclid", "gbraid", "wbraid"]) if (p.get(key)) ids[key] = true;
    const params = {};
    const conversionId = ping.id ?? p.get("tid")?.replace(/^AW-/, "") ?? /AW-(\d+)/.exec(p.get("gtm") ?? "")?.[1];
    if (conversionId) params.conversionId = conversionId;
    for (const [from, to] of [
      ["label", "label"],
      ["value", "value"],
      ["currency_code", "currency"]
    ]) {
      const v = p.get(from);
      if (v) params[to] = v;
    }
    if (p.get("userId") ?? p.get("uid")) ids.user_id = true;
    const oid = p.get("oid");
    if (oid) params.transaction_id = oid;
    for (const [k, v] of p) {
      if (k.startsWith("ep.")) params[k.slice(3)] = v;
      else if (k.startsWith("epn.")) params[k.slice(4)] = v;
    }
    return [
      withFields({
        type: "hit",
        id: newHitId(),
        runId: req.runId,
        stepId: req.stepId,
        requestId: req.id,
        t: req.t,
        vendor: "google-ads",
        event: p.get("en") ?? (REMARKETING.test(ping.url.pathname) ? "remarketing" : "conversion"),
        consent: decodeGa4Consent(p),
        ids,
        page: p.get("url") ?? p.get("dl"),
        transport: req.resourceType === "ping" ? "beacon" : req.resourceType,
        params
      }, queryEntries(p), bodyComplete(req))
    ];
  }
};

// packages/decoders/src/base64.ts
var ALPHABET2 = /^[A-Za-z0-9+/_-]+={0,2}$/;
function decodeBase64Text(value) {
  const v = value.replace(/ /g, "+");
  if (v.length < 4 || !ALPHABET2.test(v)) return void 0;
  const bare = v.replace(/=+$/, "");
  if (bare.length % 4 === 1) return void 0;
  const text2 = Buffer.from(bare.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return text2.includes("\uFFFD") ? void 0 : text2;
}

// packages/decoders/src/sgtm-data-client.ts
function parseObject(text2) {
  if (!text2) return {};
  try {
    const json = JSON.parse(text2);
    return json !== null && typeof json === "object" && !Array.isArray(json) ? json : {};
  } catch {
    return {};
  }
}
var parseDtdc = (value) => parseObject(value ? decodeBase64Text(value) : void 0);
var str2 = (v) => typeof v === "string" && v !== "" ? v : void 0;
var hasId = (v) => str2(v) !== void 0 || typeof v === "number" && Number.isFinite(v);
var USER_DATA_FIELDS = ["email_address", "phone_number", "first_name", "last_name", "street", "city", "postal_code", "country"];
function isObject2(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
var firstOf = (v) => Array.isArray(v) ? v.find((x) => str2(x) !== void 0 || isObject2(x)) : v;
function userData(...sources) {
  const out = {};
  for (const source of sources) {
    const hasUserData = isObject2(source.user_data);
    const fields2 = hasUserData ? source.user_data : source;
    const addressValue = firstOf(fields2.address);
    const address = isObject2(addressValue) ? addressValue : {};
    for (const field of USER_DATA_FIELDS) {
      const value = str2(firstOf(fields2[field])) ?? str2(firstOf(address[field]));
      if (value && out[`user_data.${field}`] === void 0) out[`user_data.${field}`] = value;
    }
  }
  return out;
}
function dataRequest(req, viaLoader) {
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return void 0;
  }
  if (url.pathname !== "/data") return void 0;
  if (viaLoader) return url;
  const p = url.searchParams;
  if (Object.keys(parseDtdc(p.get("dtdc"))).length > 0) return url;
  if (p.has("v") && (p.has("event") || p.has("en"))) return url;
  const body = req.method === "POST" ? parseObject(req.postData) : {};
  if (str2(body.event_name) && str2(body.page_location)) return url;
  return isCutDataBody(req) ? url : void 0;
}
function isCutDataBody(req) {
  if (req.method !== "POST" || req.postData === null || bodyComplete(req) || !req.postData.startsWith("{")) return false;
  return /"event_name"\s*:/.test(req.postData) && /"page_location"\s*:/.test(req.postData);
}
var sgtmDataClient = {
  name: "sgtm-data-client",
  match: (req, viaLoader = false) => dataRequest(req, viaLoader) !== void 0,
  isCollectionEndpoint: (req, viaLoader = false) => dataRequest(req, viaLoader) !== void 0,
  decode(req, newHitId = defaultHitId, viaLoader = false) {
    const url = dataRequest(req, viaLoader);
    if (!url) return [];
    const p = url.searchParams;
    const dtdc = parseDtdc(p.get("dtdc"));
    const body = req.method === "POST" ? parseObject(req.postData) : {};
    const posted = req.method === "POST" ? bodyEntries(req) : { entries: [], parsed: true };
    const queryFields = queryEntries([...p].filter(([k]) => k !== "dtdc"));
    const dtdcRaw = p.get("dtdc");
    const entries = [...queryFields, ...jsonEntries(dtdc), ...posted.entries];
    const complete = bodyComplete(req) && posted.parsed && (!dtdcRaw || Object.keys(dtdc).length > 0);
    const ids = {};
    if (p.get("cid") || hasId(body.client_id)) ids.client_id = true;
    if (p.get("uid") || hasId(body.user_id)) ids.user_id = true;
    const params = {};
    const tid = p.get("tid");
    if (tid) params.tid = tid;
    const hostname2 = str2(dtdc.page_hostname) ?? str2(body.page_hostname);
    if (hostname2) params.page_hostname = hostname2;
    Object.assign(params, userData(dtdc, body));
    return [
      withFields({
        type: "hit",
        id: newHitId(),
        runId: req.runId,
        stepId: req.stepId,
        requestId: req.id,
        t: req.t,
        vendor: "sgtm",
        event: p.get("event") ?? p.get("en") ?? str2(dtdc.event_name) ?? str2(body.event_name) ?? null,
        consent: decodeGa4Consent(p),
        ids,
        page: str2(dtdc.page_location) ?? str2(body.page_location) ?? null,
        transport: req.resourceType === "ping" ? "beacon" : req.resourceType,
        params
      }, entries, complete)
    ];
  }
};

// packages/decoders/src/stape-custom-loader.ts
var STAPE_LOADER_TRANSPORT = "stape-loader";
function unwrapStapeLoader(req) {
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return void 0;
  }
  if (!/^\/[^/]+$/.test(url.pathname)) return void 0;
  const real = [];
  for (const [, value] of url.searchParams) {
    const decoded = decodeBase64Text(value);
    if (decoded && /^\/[^/\s\\][\x21-\x7e]*$/.test(decoded)) real.push(decoded);
  }
  if (real.length !== 1) return void 0;
  try {
    return { ...req, url: new URL(real[0], url.origin).href };
  } catch {
    return void 0;
  }
}
function createStapeCustomLoader(inner) {
  return {
    name: "stape-custom-loader",
    match(req) {
      const real = unwrapStapeLoader(req);
      return real !== void 0 && inner.some((d) => d.match(real, true));
    },
    isCollectionEndpoint(req) {
      const real = unwrapStapeLoader(req);
      return real !== void 0 && inner.some((d) => d.isCollectionEndpoint(real, true));
    },
    decode(req, newHitId = defaultHitId) {
      const real = unwrapStapeLoader(req);
      if (!real) return [];
      return inner.filter((d) => d.match(real, true)).flatMap((d) => d.decode(real, newHitId, true)).map((hit) => ({ ...hit, transport: `${hit.transport} via ${STAPE_LOADER_TRANSPORT}` }));
    }
  };
}

// packages/decoders/src/tracker-list.ts
var trackerList = [
  {
    vendor: "linkedin",
    host: "px.ads.linkedin.com",
    paths: ["/wa"],
    source: "https://www.linkedin.com/help/lms/answer/a425696"
  },
  {
    vendor: "linkedin",
    host: "px.ads.linkedin.com",
    source: "https://www.linkedin.com/help/lms/answer/a425696"
  },
  {
    vendor: "microsoft-uet",
    host: "bat.bing.com",
    paths: ["/action/0"],
    source: "https://learn.microsoft.com/en-us/advertising/msa-help/hlp_ba_proc_uetv2addtag"
  },
  {
    vendor: "reddit",
    host: "alb.reddit.com",
    source: "https://business.reddithelp.com/articles/Knowledge/reddit-pixel"
  }
];
var trackerVendorKeys = [...new Set(trackerList.map((e) => e.vendor))];
function hostMatches2(pattern, hostname2) {
  if (pattern.startsWith("*.")) return hostname2.endsWith(pattern.slice(1));
  return hostname2 === pattern;
}
function pathMatches(prefix, pathname) {
  if (prefix.endsWith("/")) return pathname.startsWith(prefix);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
function trackerFor(req, list2 = trackerList) {
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return void 0;
  }
  return list2.find(
    (e) => hostMatches2(e.host, url.hostname) && (!e.paths || e.paths.some((p) => pathMatches(p, url.pathname)))
  );
}
var HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
function parseEntry(raw, at) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${at}: must be an object`);
  const o = raw;
  for (const k of Object.keys(o)) {
    if (!["vendor", "host", "paths", "source"].includes(k)) throw new Error(`${at}: unknown field "${k}"`);
  }
  const { vendor, host, paths, source } = o;
  if (typeof vendor !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(vendor)) {
    throw new Error(`${at}: "vendor" must be a lowercase key such as "tiktok"`);
  }
  if (vendorKeys.includes(vendor)) {
    throw new Error(`${at}: "vendor" "${vendor}" is a built-in decoder key; choose another key`);
  }
  if (typeof host !== "string" || !HOST.test(host)) {
    throw new Error(`${at}: "host" must be a lowercase host such as "t.example.com" or "*.example.com"`);
  }
  if (paths !== void 0 && (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string" && p.startsWith("/")))) {
    throw new Error(`${at}: "paths" must be a non-empty list of strings that start with "/"`);
  }
  if (typeof source !== "string" || !isHttps(source)) {
    throw new Error(`${at}: "source" must be an https link to the vendor's docs`);
  }
  return paths === void 0 ? { vendor, host, source } : { vendor, host, paths, source };
}
function isHttps(s) {
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}
function parseTrackerList(json) {
  if (!Array.isArray(json)) throw new Error("tracker list: must be a JSON array of entries");
  return json.map((raw, i) => parseEntry(raw, `tracker list entry ${i}`));
}

// packages/decoders/src/tracker.ts
var LOADS = /* @__PURE__ */ new Set(["script", "stylesheet", "font", "document"]);
var EVENT_PARAMS = ["event", "ev", "event_name", "en", "evt", "ea"];
var PAGE_PARAMS = ["dl", "page_location", "page_url", "url", "u", "loc", "href"];
function trackerCollection(req, list2 = trackerList) {
  const entry = trackerFor(req, list2);
  if (!entry) return void 0;
  if (entry.paths) return entry;
  if (isLibraryLoadPath(new URL(req.url).pathname)) return void 0;
  return LOADS.has(req.resourceType) ? void 0 : entry;
}
function carriesData(req) {
  if (req.resourceType !== "image" && req.resourceType !== "other") return true;
  return new URL(req.url).search.length > 1 || !!req.postData;
}
function firstParam(params, names) {
  for (const name of names) {
    const value = params.get(name);
    if (value) return value;
  }
  return null;
}
function decodeTracker(req, list2 = trackerList, newHitId = defaultHitId) {
  const entry = trackerCollection(req, list2);
  if (!entry) return [];
  if (!entry.paths && !carriesData(req)) return [];
  const params = new URL(req.url).searchParams;
  const body = bodyEntries(req);
  return [
    withFields({
      type: "hit",
      id: newHitId(),
      runId: req.runId,
      stepId: req.stepId,
      requestId: req.id,
      t: req.t,
      vendor: entry.vendor,
      event: firstParam(params, EVENT_PARAMS),
      consent: { ads: "unknown", analytics: "unknown", adUserData: "unknown", adPersonalization: "unknown", raw: {} },
      ids: {},
      page: firstParam(params, PAGE_PARAMS) ?? (isSandboxPageUrl(req.frameUrl) ? null : req.frameUrl),
      transport: "tracker-list",
      params: {}
    }, [...queryEntries(params), ...body.entries], body.parsed && bodyComplete(req))
  ];
}

// packages/decoders/src/registry.ts
var direct = [ga4, meta, metaCapi, pinterest, googleAds, sgtmDataClient];
var decoders = [...direct, createStapeCustomLoader(direct)];
function decodeRequest(req, newHitId, trackers = trackerList) {
  const matched = decoders.filter((d) => d.match(req));
  if (matched.length > 0) return matched.flatMap((d) => d.decode(req, newHitId));
  return decodeTracker(req, trackers, newHitId);
}
function isCollectionEndpoint(req, trackers = trackerList) {
  return decoders.some((d) => d.isCollectionEndpoint(req)) || trackerCollection(req, trackers) !== void 0;
}

// packages/decoders/src/platform-hosts.ts
var platformHosts = [
  {
    platform: "shopify",
    host: "cdn.shopify.com",
    purpose: "cdn",
    source: "https://shopify.dev/docs/storefronts/headless/hydrogen/content-security-policy"
  },
  {
    platform: "shopify",
    host: "monorail-edge.shopifysvc.com",
    purpose: "telemetry",
    source: "https://shopify.dev/docs/storefronts/headless/hydrogen/analytics/validation"
  },
  {
    platform: "shopify",
    host: "pay.shopify.com",
    purpose: "payments",
    source: "https://shopify.dev/docs/api/commerce-components/pay"
  },
  {
    platform: "shopify",
    host: "shop.app",
    purpose: "payments",
    source: "https://shopify.dev/docs/api/commerce-components/pay"
  },
  {
    platform: "shopify",
    host: "cdn.shopifycloud.com",
    purpose: "cdn",
    source: "https://shopify.dev/docs/api/commerce-components/pay"
  },
  {
    platform: "shopify",
    host: "*.shopifysvc.com",
    purpose: "telemetry",
    source: "https://shopify.dev/docs/api/commerce-components/pay"
  }
];
function hostMatches3(pattern, hostname2) {
  return pattern.startsWith("*.") ? hostname2.endsWith(pattern.slice(1)) : hostname2 === pattern;
}
function pathMatches2(prefix, pathname) {
  if (prefix.endsWith("/")) return pathname.startsWith(prefix);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
function platformHostFor(req, list2 = platformHosts) {
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return void 0;
  }
  return list2.find((e) => hostMatches3(e.host, url.hostname) && (!e.paths || e.paths.some((p) => pathMatches2(p, url.pathname))));
}

// packages/expect/src/scenario.ts
import { LineCounter, parseDocument } from "yaml";

// packages/expect/src/hosts.ts
import { getPublicSuffix } from "tldts";
var HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
function isHostPattern(value) {
  return typeof value === "string" && HOST_PATTERN.test(value);
}
function hostMatches4(host, patterns) {
  const h = host.toLowerCase();
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.startsWith("*.") ? h.endsWith(p.slice(1)) : h === p;
  });
}
var LOOPBACK = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
var EXTRA_SHARED_SUFFIXES = /* @__PURE__ */ new Set(["wordpress.com"]);
function isPublicSuffix(domain) {
  if (EXTRA_SHARED_SUFFIXES.has(domain)) return true;
  const opts = { allowPrivateDomains: true };
  if (getPublicSuffix(domain, opts) === domain) return true;
  const child = `pw-probe.${domain}`;
  return getPublicSuffix(child, opts) === child;
}
var VENDOR_DOMAINS = [
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
  "doubleclick.net",
  "googleadservices.com",
  "googlesyndication.com",
  "google.com",
  "facebook.com",
  "facebook.net",
  "pinterest.com"
];
function bareDomain(pattern) {
  return pattern.toLowerCase().replace(/^\*\./, "");
}
function sameOrBelow(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}
function isLoopbackPattern(pattern) {
  return LOOPBACK.has(pattern.toLowerCase());
}
function isServerHostPattern(value) {
  return isHostPattern(value) || typeof value === "string" && isLoopbackPattern(value);
}
function isSpecificServerHost(pattern) {
  if (isLoopbackPattern(pattern)) return true;
  const domain = bareDomain(pattern);
  const wildcard = pattern.startsWith("*.");
  if (wildcard && isPublicSuffix(domain)) return false;
  const owned = [...VENDOR_DOMAINS, ...trackerList.map((entry) => bareDomain(entry.host))];
  return !owned.some((vendor) => sameOrBelow(domain, vendor) || wildcard && sameOrBelow(vendor, domain));
}

// packages/expect/src/payment-providers.ts
var PAYMENT_PROVIDERS = [
  {
    id: "shopify-bogus",
    docs: "https://help.shopify.com/en/manual/checkout-settings/test-orders",
    cards: ["1", "2", "3"],
    expiry: "12/40",
    cvc: "123"
  },
  {
    id: "shopify-test",
    docs: "https://help.shopify.com/en/manual/payments/shopify-payments/testing-shopify-payments",
    cards: ["4242424242424242", "5555555555554444"],
    expiry: "12/40",
    cvc: "123"
  },
  {
    id: "fixture",
    docs: "https://github.com/alfhen/tagreeve/blob/main/fixtures/site/README.md",
    cards: ["4242424242424242"],
    expiry: "12/40",
    cvc: "123",
    loopbackOnly: true
  }
];
function findPaymentProvider(id) {
  return PAYMENT_PROVIDERS.find((p) => p.id === id);
}
function canonicalCard(provider, card) {
  const compact = card.replace(/[\s-]/g, "");
  return provider.cards.includes(compact) ? compact : void 0;
}

// packages/expect/src/scenario.ts
var consentFields = ["analytics", "ads", "adUserData", "adPersonalization"];
var VIEWPORT_MIN = 200;
var VIEWPORT_MAX = 4e3;
function isViewportSide(n) {
  return typeof n === "number" && Number.isInteger(n) && n >= VIEWPORT_MIN && n <= VIEWPORT_MAX;
}
function parseViewportText(text2) {
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(text2);
  if (!match) return void 0;
  const viewport = { width: Number(match[1]), height: Number(match[2]) };
  return isViewportSide(viewport.width) && isViewportSide(viewport.height) ? viewport : void 0;
}
var VIEWPORT_HINT = `a size such as 390x844, with each side from ${VIEWPORT_MIN} to ${VIEWPORT_MAX}`;
var BUILTIN_NAMES = ["unknownDestination", "sandboxPageUrl", "possibleRealData", "deniedIdentifiers", "earlyIdentifiers"];
var SEVERITIES = ["fail", "warn"];
var IDENTITY_FIELDS = ["firstName", "lastName", "email", "phone", "address1", "city", "zip", "country"];
var ScenarioError = class extends Error {
  issues;
  constructor(issues) {
    super(issues.join("\n"));
    this.name = "ScenarioError";
    this.issues = issues;
  }
};
var VENDOR_KEYS = /* @__PURE__ */ new Set(["vendor", "event", "page", "transport", "host", "outcome", "count", "before", "in", "after", "from", "sentBy"]);
var GROUP_KEYS = ["consent", "ids", "params", "identity", "body"];
var COOKIE_RULE_KEYS = ["cookie", "before", "in", "after", "from"];
var BODY_KEYS = ["has", "only", "ignore"];
var MAX_FIELD_NAME = 64;
var CONSENT_VALUES = ["granted", "denied", "unknown"];
var OUTCOMES = ["passed", "stubbed", "failed"];
var NETWORKS = ["stub", "server"];
var CONSENT_ANSWERS = ["accept", "reject", "none", "withdraw"];
var STEP_KINDS = ["visit", "click", "fill", "select", "consent", "wait", "addToCart", "evaluate", "checkpoint", "handoff", "payment"];
var TOP_KEYS = ["start", "vars", "identity", "steps", "expect", "options"];
var OPTION_KEYS = ["network", "seed", "consentTimeout", "graceWindow", "optionalTimeout", "allowUnknownDestination", "firstPartyHosts", "platformHosts", "cartRequest", "unloadGapIgnore", "builtins", "identifierFields", "serverHosts", "viewport"];
var HOST_HINT = ", each a host such as cdn.example.com or a wildcard such as *.example.com";
function isRegExp(source) {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}
function isHostList(v) {
  return Array.isArray(v) && v.every(isHostPattern);
}
function isMap(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function parseDuration(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : void 0;
  if (typeof value !== "string") return void 0;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(value.trim());
  if (!m) return void 0;
  const unit = m[2] ?? "ms";
  return Number(m[1]) * (unit === "m" ? 6e4 : unit === "s" ? 1e3 : 1);
}
function parseCount(value) {
  const text2 = String(value).trim();
  const m = /^(>=|<=|>|<|=)?\s*(\d+)$/.exec(text2);
  if (!m || typeof value !== "string" && typeof value !== "number") return void 0;
  return { op: m[1] ?? "=", n: Number(m[2]) };
}
function countHolds(count, actual) {
  switch (count.op) {
    case ">=":
      return actual >= count.n;
    case ">":
      return actual > count.n;
    case "<=":
      return actual <= count.n;
    case "<":
      return actual < count.n;
    case "=":
      return actual === count.n;
  }
}
function describeCount(count) {
  return count.op === "=" ? String(count.n) : `${count.op}${count.n}`;
}
function parseOptions(raw, path, fail, { keys = OPTION_KEYS, echo = true } = {}) {
  const options = {};
  if (!isMap(raw)) fail(path, "must be a mapping");
  else
    for (const [k, v] of Object.entries(raw)) {
      const p = [...path, k];
      if (!keys.includes(k)) fail(p, `unknown option, expected one of ${keys.join(", ")}`);
      else if (k === "network") {
        if (v === "live") fail(p, "live is not allowed in a scenario. Pass --network live on the command line.");
        else if (typeof v === "string" && NETWORKS.includes(v)) options.network = v;
        else fail(p, `must be one of ${NETWORKS.join(", ")}`);
      } else if (k === "seed") {
        if (typeof v === "number" && Number.isInteger(v)) options.seed = v;
        else fail(p, "must be an integer");
      } else if (k === "allowUnknownDestination") {
        if (typeof v === "boolean" || isHostList(v)) options.allowUnknownDestination = v;
        else fail(p, `must be true, false or a list of hosts${HOST_HINT}`);
      } else if (k === "platformHosts") {
        if (typeof v === "boolean") options.platformHosts = v;
        else fail(p, "must be true or false");
      } else if (k === "cartRequest") {
        if (typeof v === "string" && v !== "" && isRegExp(v)) options.cartRequest = v;
        else fail(p, 'must be a regular expression such as "/api/cart/add"');
      } else if (k === "unloadGapIgnore") {
        if (Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "")) options.unloadGapIgnore = v;
        else fail(p, "must be a list of event names or globs such as consent_*");
      } else if (k === "serverHosts") {
        if (!Array.isArray(v) || v.length === 0 || !v.every(isServerHostPattern)) fail(p, `must be a non-empty list of hosts${HOST_HINT}`);
        else {
          const bad = v.find((host) => !isSpecificServerHost(host));
          if (bad !== void 0) fail(p, `${echo ? `"${bad}"` : "a host in the list"} is a vendor host or a wildcard on a public suffix. List the server container's own host, such as sgtm.example.com or *.example.com`);
          else options.serverHosts = v;
        }
      } else if (k === "viewport") {
        if (isMap(v) && Object.keys(v).length === 2 && isViewportSide(v.width) && isViewportSide(v.height)) options.viewport = { width: v.width, height: v.height };
        else fail(p, `must be { width, height }, integers from ${VIEWPORT_MIN} to ${VIEWPORT_MAX}. The preset "mobile" does not exist`);
      } else if (k === "identifierFields") {
        if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x !== "")) fail(p, "must be a non-empty list of field names or globs such as user_data.*");
        else if (v.some((x) => x.length > MAX_FIELD_NAME)) fail(p, `field names are at most ${MAX_FIELD_NAME} characters`);
        else options.identifierFields = v;
      } else if (k === "builtins") {
        if (!isMap(v)) fail(p, `must be a mapping of check name to ${SEVERITIES.join(" or ")}`);
        else {
          const builtins = {};
          for (const [name, severity] of Object.entries(v)) {
            const bp = [...p, name];
            if (!BUILTIN_NAMES.includes(name)) fail(bp, `unknown builtin check, expected one of ${BUILTIN_NAMES.join(", ")}`);
            else if (typeof severity !== "string" || !SEVERITIES.includes(severity))
              fail(bp, `must be ${SEVERITIES.join(" or ")}`);
            else builtins[name] = severity;
          }
          options.builtins = builtins;
        }
      } else if (k === "firstPartyHosts") {
        if (isHostList(v)) options.firstPartyHosts = v;
        else fail(p, `must be a list of hosts${HOST_HINT}`);
      } else {
        const ms = parseDuration(v);
        if (ms === void 0) fail(p, "must be a duration such as 4s or 500ms");
        else if (k === "consentTimeout") options.consentTimeout = ms;
        else if (k === "optionalTimeout") {
          if (ms < 100 || ms > 3e4) fail(p, "must be from 100ms to 30s");
          else options.optionalTimeout = ms;
        } else options.graceWindow = ms;
      }
    }
  return options;
}
function parseScenario(text2, extraVendorKeys = []) {
  const lines = new LineCounter();
  const doc = parseDocument(text2, { lineCounter: lines, uniqueKeys: true });
  const issues = [];
  const lineOf = (path) => {
    for (let n = path.length; n >= 0; n--) {
      const node = doc.getIn(path.slice(0, n), true);
      if (node?.range) return lines.linePos(node.range[0] ?? 0).line;
    }
    return 1;
  };
  const fail = (path, message) => {
    const where2 = path.reduce((acc, p) => typeof p === "number" ? `${acc}[${p}]` : acc ? `${acc}.${p}` : p, "");
    issues.push(`line ${lineOf(path)}: ${where2 ? `${where2}: ` : ""}${message}`);
  };
  for (const e of doc.errors) issues.push(`line ${e.linePos?.[0].line ?? 1}: ${e.message.split("\n")[0]}`);
  if (issues.length) throw new ScenarioError(issues);
  const raw = doc.toJS();
  if (!isMap(raw)) throw new ScenarioError(["line 1: a scenario must be a YAML mapping"]);
  for (const key of Object.keys(raw)) if (!TOP_KEYS.includes(key)) fail([key], `unknown key, expected one of ${TOP_KEYS.join(", ")}`);
  let start = "";
  if (typeof raw.start !== "string" || !raw.start) fail(["start"], "required, a path such as /products/{product}");
  else start = raw.start;
  const vars = {};
  if (raw.vars !== void 0) {
    if (!isMap(raw.vars)) fail(["vars"], "must be a mapping of names to values");
    else
      for (const [k, v] of Object.entries(raw.vars)) {
        if (typeof v === "string" || typeof v === "number") vars[k] = String(v);
        else fail(["vars", k], "must be a string or number");
      }
  }
  const warnings = [];
  const identity = {};
  if (raw.identity !== void 0) {
    if (!isMap(raw.identity)) fail(["identity"], `must be a mapping of identity fields to values, from ${IDENTITY_FIELDS.join(", ")}`);
    else
      for (const [k, v] of Object.entries(raw.identity)) {
        if (!IDENTITY_FIELDS.includes(k)) fail(["identity", k], `unknown identity field, expected one of ${IDENTITY_FIELDS.join(", ")}`);
        else if (typeof v !== "string" || !v.trim()) fail(["identity", k], "must be a non-empty string");
        else {
          identity[k] = v;
        }
      }
    for (const [k, v] of Object.entries(identity)) {
      const problem = realDataWarning(v, identity.country);
      if (problem) warnings.push(`line ${lineOf(["identity", k])}: identity.${k}: ${problem}; do not write personal data in a scenario`);
    }
  }
  const checkVars = (value, path) => {
    for (const m of value.matchAll(/\{(\w+)\}/g)) {
      if (!Object.hasOwn(vars, m[1])) fail(path, `uses {${m[1]}} but vars has no "${m[1]}"`);
    }
  };
  if (start) checkVars(start, ["start"]);
  const steps = [];
  const stepLabels2 = /* @__PURE__ */ new Set(["start"]);
  if (raw.steps !== void 0) {
    if (!Array.isArray(raw.steps)) fail(["steps"], "must be a list");
    else raw.steps.forEach((item, i) => parseStep(item, i));
  }
  function parseStep(item, i) {
    const path = ["steps", i];
    const line = lineOf(path);
    const keys = isMap(item) ? Object.keys(item).filter((k) => k !== "label") : [];
    if (!isMap(item) || keys.length !== 1) {
      fail(path, `a step is a mapping with exactly one key, one of ${STEP_KINDS.join(", ")}, and an optional label`);
      return;
    }
    const kind = keys[0];
    const value = item[kind];
    let label = `${kind}-${i + 1}`;
    if (item.label !== void 0) {
      if (typeof item.label === "string" && /^[\w.-]+$/.test(item.label)) label = item.label;
      else fail([...path, "label"], "must be a string of letters, digits, dots, dashes and underscores");
    } else if (kind === "checkpoint" && typeof value === "string" && value) label = value;
    const add2 = (body) => {
      if (stepLabels2.has(label)) fail([...path, ...item.label === void 0 ? [kind] : ["label"]], `duplicate step label "${label}"`);
      stepLabels2.add(label);
      steps.push({ ...body, label, line });
    };
    const str3 = () => {
      if (typeof value === "string" && value) return value;
      fail([...path, kind], "must be a non-empty string");
      return void 0;
    };
    const locator = (v = value, at = [...path, kind]) => {
      if (typeof v === "string" && v) return v;
      if (!isMap(v)) {
        fail(at, "must be a non-empty selector or a mapping with role and name, or any");
        return void 0;
      }
      const keys2 = Object.keys(v);
      if (keys2.includes("any")) {
        const list2 = v.any;
        if (keys2.length > 1) fail(at, "any cannot be combined with other keys");
        else if (!Array.isArray(list2) || list2.length === 0 || !list2.every((x) => typeof x === "string" && x !== "")) {
          fail([...at, "any"], "must be a non-empty list of selectors");
        } else return { any: list2 };
        return void 0;
      }
      const unknown = keys2.find((k) => !["role", "name", "exact"].includes(k));
      if (unknown !== void 0) fail([...at, unknown], "unknown key, expected role, name, exact or any");
      else if (typeof v.role !== "string" || !/^[a-z]+$/.test(v.role)) fail([...at, "role"], "must be a role name such as button or radio");
      else if (v.name !== void 0 && (typeof v.name !== "string" || v.name === "")) fail([...at, "name"], "must be a non-empty string");
      else if (v.exact !== void 0 && typeof v.exact !== "boolean") fail([...at, "exact"], "must be true or false");
      else if (v.exact !== void 0 && v.name === void 0) fail([...at, "exact"], "needs a name");
      else {
        return {
          role: v.role,
          ...v.name !== void 0 ? { name: v.name } : {},
          ...v.exact !== void 0 ? { exact: v.exact } : {}
        };
      }
      return void 0;
    };
    const urlMatcher = (v, at) => {
      if (typeof v === "string" && v) return { glob: v };
      if (isMap(v) && Object.keys(v).length === 1 && "matches" in v) {
        if (typeof v.matches !== "string" || !v.matches) fail([...at, "matches"], "must be a non-empty regular expression");
        else
          try {
            new RegExp(v.matches);
            return { matches: v.matches };
          } catch {
            fail([...at, "matches"], `"${v.matches}" is not a valid regular expression`);
          }
        return void 0;
      }
      fail(at, 'must be a path glob such as "/thank-you*" or a mapping with matches');
      return void 0;
    };
    const condition = (v, at) => {
      if (!isMap(v)) {
        fail(at, "must be a mapping with url, or a locator (role and name, any, or selector)");
        return void 0;
      }
      if ("url" in v) {
        if (Object.keys(v).length > 1) fail(at, "url cannot be combined with other keys");
        else {
          const url = urlMatcher(v.url, [...at, "url"]);
          if (url) return { url };
        }
        return void 0;
      }
      if ("selector" in v) {
        if (Object.keys(v).length > 1) fail(at, "selector cannot be combined with other keys");
        else if (typeof v.selector !== "string" || !v.selector) fail([...at, "selector"], "must be a non-empty selector");
        else return { locator: v.selector };
        return void 0;
      }
      const l = locator(v, at);
      return l === void 0 ? void 0 : { locator: l };
    };
    switch (kind) {
      case "visit": {
        const v = str3();
        if (v !== void 0) {
          checkVars(v, [...path, kind]);
          add2({ kind, value: v });
        }
        return;
      }
      case "click": {
        const v = locator();
        if (v !== void 0) add2({ kind, value: v });
        return;
      }
      case "addToCart":
      case "evaluate":
      case "checkpoint": {
        const v = str3();
        if (v !== void 0) add2({ kind, value: v });
        return;
      }
      case "handoff": {
        if (!isMap(value)) {
          const v = str3();
          if (v !== void 0) add2({ kind, value: v });
          return;
        }
        const at = [...path, kind];
        const unknown = Object.keys(value).find((k) => !["text", "until", "settle", "timeout"].includes(k));
        if (unknown !== void 0) {
          fail([...at, unknown], "unknown key, expected text, until, settle or timeout");
          return;
        }
        const errors = issues.length;
        if (typeof value.text !== "string" || !value.text) fail([...at, "text"], "must be a non-empty string");
        const until = value.until === void 0 ? void 0 : condition(value.until, [...at, "until"]);
        const duration = (key) => {
          if (value[key] === void 0) return void 0;
          const ms = parseDuration(value[key]);
          if (ms === void 0) fail([...at, key], "must be a duration such as 4s, 500ms or 10m");
          return ms;
        };
        const settle = duration("settle");
        const timeout = duration("timeout");
        if (value.settle !== void 0 && value.until === void 0) fail([...at, "settle"], "needs until");
        if (issues.length > errors) return;
        add2({
          kind,
          value: value.text,
          ...until ? { until, settle: settle ?? 5e3 } : {},
          ...timeout !== void 0 ? { timeout } : {}
        });
        return;
      }
      case "payment": {
        const at = [...path, kind];
        if (!isMap(value)) {
          fail(at, "must be a mapping with provider and card");
          return;
        }
        const unknown = Object.keys(value).find((k) => !["provider", "card"].includes(k));
        if (unknown !== void 0) {
          fail([...at, unknown], "unknown key, expected provider or card");
          return;
        }
        const provider = typeof value.provider === "string" ? findPaymentProvider(value.provider) : void 0;
        if (!provider) {
          fail([...at, "provider"], `must be one of ${PAYMENT_PROVIDERS.map((p) => p.id).join(", ")}`);
          return;
        }
        const card = typeof value.card === "string" || typeof value.card === "number" ? canonicalCard(provider, String(value.card)) : void 0;
        if (card === void 0) {
          fail([...at, "card"], `is not a documented test value of ${provider.id}, see ${provider.docs}`);
          return;
        }
        add2({ kind, value: { provider: provider.id, card } });
        return;
      }
      case "select": {
        if (!isMap(value) || Object.keys(value).length === 0) {
          fail([...path, kind], "must be a mapping of selector to option value or label");
          return;
        }
        const fields2 = {};
        for (const [sel, v] of Object.entries(value)) {
          if (typeof v === "string" && v) fields2[sel] = v;
          else if (typeof v === "number") fail([...path, kind, sel], `must be a string, so quote it ("${v}") to keep leading zeros`);
          else fail([...path, kind, sel], "must be a non-empty string");
        }
        add2({ kind, value: fields2 });
        return;
      }
      case "fill": {
        if (!isMap(value) || Object.keys(value).length === 0) {
          fail([...path, kind], "must be a mapping of selector to value");
          return;
        }
        const fields2 = {};
        const optional = [];
        for (const [sel, raw2] of Object.entries(value)) {
          let v = raw2;
          if (isMap(raw2)) {
            const extra = Object.keys(raw2).filter((key) => key !== "value" && key !== "optional");
            if (extra.length || typeof raw2.value !== "string" || !raw2.value || raw2.optional !== true) {
              fail([...path, kind, sel], "must be a string, or { value: <string>, optional: true }");
              continue;
            }
            v = raw2.value;
            optional.push(sel);
          }
          if (typeof v === "string" && v) {
            fields2[sel] = v;
            const problem = SECRET_FIELD.test(sel) ? void 0 : realDataWarning(v, identity.country);
            if (problem) warnings.push(`line ${lineOf([...path, "fill", sel])}: steps[${i}].fill.${sel}: ${problem}; fill uses the run identity, so do not write personal data in a scenario`);
          } else fail([...path, kind, sel], "must be a non-empty string");
        }
        add2(optional.length ? { kind, value: fields2, optional } : { kind, value: fields2 });
        return;
      }
      case "consent": {
        if (typeof value === "string" && CONSENT_ANSWERS.includes(value)) add2({ kind, value });
        else fail([...path, kind], `must be one of ${CONSENT_ANSWERS.join(", ")}`);
        return;
      }
      case "wait": {
        const ms = parseDuration(value);
        if (ms !== void 0) add2({ kind, value: ms });
        else if (typeof value === "string" && /^\s*\d/.test(value)) fail([...path, kind], `"${value}" is not a duration such as 4s, 500ms or 2m`);
        else if (typeof value === "string" && value.trim()) add2({ kind, value: { selector: value } });
        else if (isMap(value) && "url" in value) {
          if (Object.keys(value).length > 1) fail([...path, kind], "url cannot be combined with other keys");
          else {
            const url = urlMatcher(value.url, [...path, kind, "url"]);
            if (url) add2({ kind, value: { url } });
          }
        } else if (isMap(value)) {
          const v = locator();
          if (v !== void 0) add2({ kind, value: { selector: v } });
        } else fail([...path, kind], "must be a duration such as 4s, 500ms or 2m, a selector, or a locator mapping");
        return;
      }
      default:
        fail([...path, kind], `unknown step "${kind}", expected one of ${STEP_KINDS.join(", ")}`);
    }
  }
  const expectOut = { must: [], mustNot: [] };
  if (raw.expect !== void 0) {
    if (!isMap(raw.expect)) fail(["expect"], "must be a mapping with must and mustNot lists");
    else {
      for (const key of Object.keys(raw.expect)) if (key !== "must" && key !== "mustNot") fail(["expect", key], "unknown key, expected must or mustNot");
      for (const kind of ["must", "mustNot"]) {
        const list2 = raw.expect[kind];
        if (list2 === void 0) continue;
        if (!Array.isArray(list2)) fail(["expect", kind], "must be a list");
        else
          list2.forEach((entry, i) => {
            const rule = parseRule(kind, entry, ["expect", kind, i]);
            if (rule) expectOut[kind].push(rule);
          });
      }
    }
  }
  function parseRule(kind, entry, path) {
    if (!isMap(entry)) {
      fail(path, "must be a mapping of filters and rule keys");
      return void 0;
    }
    const before = issues.length;
    const flat = {};
    for (const [k, v] of Object.entries(entry)) {
      if (GROUP_KEYS.includes(k) && isMap(v)) {
        for (const [sub, sv2] of Object.entries(v)) flat[`${k}.${sub}`] = sv2;
      } else flat[k] = v;
    }
    const filter = { consent: {}, ids: {}, params: {} };
    const rule = { kind, description: JSON.stringify(entry), line: lineOf(path), filter };
    const list2 = (key, v, allowed) => {
      const items = Array.isArray(v) ? v : [v];
      if (items.length === 0 || !items.every((x) => typeof x === "string" && x)) {
        fail([...path, key], "must be a string or a list of strings");
        return void 0;
      }
      const out = items;
      const bad = allowed ? out.find((x) => !allowed.includes(x)) : void 0;
      if (bad !== void 0) {
        fail([...path, key], `"${bad}" is not valid, expected one of ${allowed.join(", ")}`);
        return void 0;
      }
      return out;
    };
    for (const [k, v] of Object.entries(flat)) {
      const p = [...path, k];
      if (k.startsWith("consent.")) {
        const field = k.slice(8);
        if (!consentFields.includes(field)) fail(p, `unknown consent field, expected one of ${consentFields.join(", ")}`);
        else if (typeof v === "string" && CONSENT_VALUES.includes(v)) filter.consent[field] = v;
        else fail(p, `must be one of ${CONSENT_VALUES.join(", ")}`);
      } else if (k.startsWith("ids.")) {
        const name = k.slice(4);
        if (/^hashes(?:\.|$)/.test(name) && !/^hashes(?:\.[^.]+(?:\.matchesIdentity)?)?$/.test(name)) {
          fail(p, "is not valid, expected ids.hashes, ids.hashes.<param> or ids.hashes.<param>.matchesIdentity");
        } else if (v === true) filter.ids[k.slice(4)] = "present";
        else if (v === false) filter.ids[k.slice(4)] = "absent";
        else if (typeof v === "string" || typeof v === "number") filter.ids[k.slice(4)] = String(v);
        else fail(p, "must be present, absent or a value");
      } else if (k.startsWith("params.")) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") filter.params[k.slice(7)] = String(v);
        else fail(p, "must be a string or number");
      } else if (k === "identity.hashesMatch") {
        if (v !== true) fail(p, "must be true");
        else if (kind === "mustNot") fail(p, "is only valid under must");
        else rule.hashesMatch = true;
      } else if (k.startsWith("body.")) {
        const key = k.slice(5);
        if (!BODY_KEYS.includes(key)) fail(p, `unknown key, expected one of ${BODY_KEYS.map((b) => `body.${b}`).join(", ")}`);
        else if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x !== "")) fail(p, "must be a non-empty list of field names");
        else if (v.some((x) => x.length > MAX_FIELD_NAME)) fail(p, `field names are at most ${MAX_FIELD_NAME} characters`);
        else if (v.some((x) => x === "**.")) fail(p, '"**." needs a name after the dot');
        else (rule.body ??= {})[key] = v;
      } else if (k === "cookie") {
        const l = list2(k, v);
        if (l?.some((name) => name.length > MAX_FIELD_NAME)) fail(p, `cookie names are at most ${MAX_FIELD_NAME} characters`);
        else if (l) rule.cookie = l;
      } else if (k === "vendor") {
        const l = list2(k, v, [...vendorKeys, ...trackerVendorKeys, ...extraVendorKeys]);
        if (l) filter.vendor = l;
      } else if (k === "event" || k === "transport" || k === "host") {
        const l = list2(k, v);
        if (l) filter[k] = l;
      } else if (k === "sentBy") {
        if (v === "browser" || v === "server") filter.sentBy = v;
        else fail(p, "must be browser or server");
      } else if (k === "outcome") {
        const l = list2(k, v, OUTCOMES);
        if (l) filter.outcome = l;
      } else if (k === "page") {
        if (typeof v === "string" && v) filter.page = { equals: v };
        else if (isMap(v) && Object.keys(v).length === 1 && typeof v.matches === "string") {
          try {
            new RegExp(v.matches);
            filter.page = { matches: v.matches };
          } catch (e) {
            fail(p, `invalid regular expression: ${e.message}`);
          }
        } else fail(p, "must be a string or { matches: <regex> }");
      } else if (k === "count") {
        const c = parseCount(v);
        if (!c) fail(p, 'must be a number or a comparison such as ">=2", "0" or "<3"');
        else if (kind === "mustNot") fail(p, "is only valid under must; mustNot means none");
        else rule.count = c;
      } else if (k === "before") {
        if (v === "consent") rule.before = "consent";
        else fail(p, 'must be "consent"');
      } else if (k === "in") {
        const m = typeof v === "string" ? /^epoch\(\s*([\w=]+)\s*\)$/.exec(v) : null;
        if (m && validEpochSelector(m[1])) rule.inEpoch = m[1];
        else fail(p, "must be epoch(undecided), epoch(granted), epoch(denied), epoch(<field>=<value>) or epoch(label=<label>)");
      } else if (k === "after") {
        if (typeof v !== "string" || !v) fail(p, "must be a step label");
        else if (!stepLabels2.has(v)) fail(p, `"${v}" is not a step label, defined labels: ${[...stepLabels2].join(", ") || "none"}`);
        else rule.after = v;
      } else if (k === "from") {
        if (typeof v !== "string" || !v) fail(p, "must be a step label");
        else if (!stepLabels2.has(v)) fail(p, `"${v}" is not a step label, defined labels: ${[...stepLabels2].join(", ") || "none"}`);
        else rule.from = v;
      } else if (VENDOR_KEYS.has(k)) {
        fail(p, "invalid");
      } else {
        fail(p, "unknown key");
      }
    }
    if (rule.cookie) {
      const mixed = Object.keys(flat).filter((k) => !COOKIE_RULE_KEYS.includes(k));
      if (mixed.length) fail(path, `cookie cannot be combined with ${mixed.join(", ")}; it only takes before, in, after and from`);
    }
    if (rule.from && rule.after) fail(path, "use either from or after, not both");
    if (rule.before && rule.inEpoch) fail(path, "use either before or in, not both");
    if (rule.body?.has && rule.body.only) fail(path, "body.has and body.only cannot be in the same entry");
    if (rule.body && rule.hashesMatch) fail(path, "identity.hashesMatch cannot be combined with body.has or body.only");
    if (rule.body?.ignore && !rule.body.only) fail(path, "body.ignore is only valid with body.only");
    return issues.length === before ? rule : void 0;
  }
  const options = raw.options === void 0 ? {} : parseOptions(raw.options, ["options"], fail);
  if (issues.length) throw new ScenarioError(issues);
  return { start, vars, identity, steps, expect: expectOut, options, warnings };
}
var EPOCH_LABELS = ["undecided", "granted", "denied", "mixed", "withdrawn"];
function validEpochSelector(selector) {
  if (["undecided", "granted", "denied"].includes(selector)) return true;
  const m = /^(\w+)=(\w+)$/.exec(selector);
  if (m?.[1] === "label") return EPOCH_LABELS.includes(m[2]);
  return !!m && consentFields.includes(m[1]) && CONSENT_VALUES.includes(m[2]);
}
var RESERVED_EMAIL_DOMAIN = /(?:^|\.)(?:example\.(?:com|net|org)|[^.]+\.(?:test|invalid|example|localhost))$/i;
var SECRET_FIELD = /card|cvc|cvv|iban|password|cc-/i;
var PHONE_SHAPE = /^(?:\+\d{8,15}|\+?[\d\s]*\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\+?\d{0,3}[-.\s]?\d{3}[-.\s]\d{3}[-.\s]\d{4})$/;
var FICTIONAL_PHONE = [
  /^1\d{3}55501\d\d$/,
  /^4670174(?:060[5-9]|06[1-9]\d)$/,
  /^447700900\d{3}$/,
  /^442079460\d{3}$/,
  /^441632960\d{3}$/,
  /^493023125\d{3}$/,
  /^4917139200\d{2}$/,
  /^49176040690\d{2}$/,
  /^44(?:113|114|115|116|117|118|121|131|141|151|161)4960\d{3}$/
];
function looksLikeRealData(value) {
  const email = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(value.trim());
  if (email) return RESERVED_EMAIL_DOMAIN.test(email[1]) ? void 0 : "email";
  const text2 = value.trim();
  if (!PHONE_SHAPE.test(text2)) return void 0;
  const digits = text2.replace(/\D/g, "");
  const international = digits.length > 10 || text2.startsWith("+");
  const nationalUs = !international && /^\d{3}55501\d\d$/.test(digits);
  return nationalUs || FICTIONAL_PHONE.some((range) => range.test(digits)) ? void 0 : "phone";
}
var REAL_MOBILE_PREFIX = { DE: /^49(?:15|16|17)/, GB: /^447/, SE: /^467/ };
var DIAL_CODE_COUNTRY = [["49", "DE"], ["46", "SE"], ["44", "GB"], ["1", "US"]];
function phoneWarning(value, declaredCountry) {
  const digits = value.replace(/\D/g, "");
  const international = value.trim().startsWith("+");
  const fromDialCode = international ? DIAL_CODE_COUNTRY.find(([code]) => digits.startsWith(code))?.[1] : void 0;
  const country = fromDialCode ?? (international ? void 0 : declaredCountry?.toUpperCase() ?? "US");
  const reasons = ["it is not in a fictional range"];
  if (country && REAL_MOBILE_PREFIX[country]?.test(digits)) reasons.push("its mobile prefix is a real one");
  const hint = country && FICTIONAL_PHONE_HINT[country];
  const range = hint ? `use ${hint}` : "no fictional range is known for it";
  return `looks like a real phone (${reasons.join(" and ")}${country ? ` for ${country}` : ""}); ${range}`;
}
function realDataWarning(value, country) {
  const kind = looksLikeRealData(value);
  return kind === "phone" ? phoneWarning(value, country) : kind && `looks like a real ${kind}`;
}

// packages/expect/src/evaluate.ts
var DEFAULT_GRACE_MS = 50;
var MAX_LISTED = 5;
var MAX_NAMES = 12;
var GOOGLE_VENDORS = /* @__PURE__ */ new Set(["ga4", "google-ads"]);
function evaluate(records, scenario, options = {}) {
  const runRecord = records.find((r) => r.type === "run");
  const runId = runRecord?.id ?? records.find((r) => "runId" in r)?.runId ?? newId("run");
  const allHits = records.filter((r) => r.type === "hit");
  const allRequests = new Map(records.filter((r) => r.type === "request").map((r) => [r.id, r]));
  const index = judgeIndex(allHits, allRequests);
  const ctx = {
    hits: allHits,
    requests: allRequests,
    index,
    serverHitIds: new Set(allHits.filter((h) => isServerHit(h, index)).map((h) => h.id)),
    epochs: records.filter((r) => r.type === "consentEpoch").sort((a, b) => a.startT - b.startT),
    steps: records.filter((r) => r.type === "step"),
    responses: records.filter((r) => r.type === "response"),
    checkpoints: records.filter((r) => r.type === "checkpoint"),
    networkMode: runRecord?.networkMode,
    grace: options.graceWindowMs ?? scenario.options.graceWindow ?? DEFAULT_GRACE_MS,
    identity: options.identity ?? identityOf(runRecord)
  };
  const results = [];
  const add2 = (expectation2, pass, evidence, message, severity, note, timeJudged = false) => {
    const settled = settleServerSends(pass, evidence, severity, note, timeJudged, ctx);
    results.push({
      type: "result",
      id: newId("result"),
      runId,
      expectation: expectation2,
      pass,
      evidence,
      message,
      ...settled.severity && { severity: settled.severity },
      ...settled.note && { note: settled.note }
    });
  };
  for (const kind of ["mustNot", "must"])
    for (const rule of scenario.expect[kind]) {
      const outcome = evaluateRule(rule, ctx);
      const { pass, evidence, message } = outcome;
      const passes = (c) => evaluateRuleHits(rule, c).pass;
      const scoped = isScoped(rule);
      const note = outcome.note ?? (pass && scoped && passRestsOnProbableLink(ctx, passes) ? "serverSendProbableLink" : void 0);
      add2(`${kind}: ${rule.description}`, pass, evidence, message, void 0, note, scoped && (pass || failureRestsOnProbableLink(ctx, passes)));
    }
  builtInChecks(records, scenario, ctx, add2);
  return results;
}
var isScoped = (rule) => Boolean(rule.before || rule.inEpoch || rule.after || rule.from || consentFields.some((f) => rule.filter.consent[f]));
function ruleWindowStart(rule, ctx) {
  const label = rule.from ?? rule.after;
  if (!label) return void 0;
  const step = ctx.steps.find((s) => s.label === label);
  if (!step) {
    const known = ctx.steps.map((s) => s.label).join(", ") || "none";
    return { pass: false, evidence: [], message: `Expected a step labelled "${label}", but the run has steps: ${known}.` };
  }
  return rule.from ? { at: step.startedAt, text: `from ${label}` } : { at: step.endedAt ?? step.startedAt, text: `after ${label}` };
}
function evaluateRule(rule, ctx) {
  const outcome = evaluateRuleHits(rule, ctx);
  if (rule.cookie || !isScoped(rule)) return outcome;
  const unjudged = ctx.hits.filter((h) => isUnlinkedServerHit(h, ctx.index) && matchesFilter(h, { ...rule.filter, consent: {} }, ctx));
  if (unjudged.length === 0) return outcome;
  if (rule.kind === "mustNot") {
    if (!outcome.pass) return outcome;
  } else if (evaluateRuleHits(rule, { ...ctx, anywhere: new Set(unjudged.map((h) => h.id)) }).pass === outcome.pass) {
    return outcome;
  }
  return {
    pass: false,
    evidence: [...outcome.evidence, ...unjudged.map((h) => h.id)],
    message: `${outcome.message} Cannot evaluate: ${unjudged.length} server container hit${unjudged.length === 1 ? " has" : "s have"} no link to a browser hit, so no consent state or time applies to ${unjudged.length === 1 ? "it" : "them"}.`,
    note: "serverSendUnlinked"
  };
}
function asBrowserHits(ctx, hits) {
  const requests = new Map(ctx.requests);
  for (const h of hits) {
    const request = requests.get(h.requestId);
    if (!request) continue;
    const own = { ...request };
    delete own.captured;
    requests.set(h.requestId, own);
  }
  return { ...ctx, requests, index: judgeIndex(ctx.hits, requests) };
}
function passRestsOnProbableLink(ctx, passes) {
  const probable = ctx.hits.filter((h) => h.via?.confidence === "probable" && viaHitOf(h, ctx.index) !== void 0);
  return probable.length > 0 && !passes(asBrowserHits(ctx, probable));
}
function failureRestsOnProbableLink(ctx, passes) {
  const probable = ctx.hits.filter((h) => h.via?.confidence === "probable" && viaHitOf(h, ctx.index) !== void 0);
  if (probable.length === 0) return false;
  const ids = new Set(probable.map((h) => h.id));
  return passes(asBrowserHits(ctx, probable)) || passes({ ...ctx, hits: ctx.hits.filter((h) => !ids.has(h.id)) });
}
function evaluateRuleHits(rule, ctx) {
  if (rule.cookie) return evaluateCookieRule(rule, rule.cookie, ctx);
  const anywhere = (h) => ctx.anywhere?.has(h.id) ?? false;
  let hits = ctx.hits.filter((h) => matchesFilter(h, anywhere(h) ? { ...rule.filter, consent: {} } : rule.filter, ctx));
  const total2 = hits.length;
  const narrowed = [];
  if (rule.before) {
    hits = hits.filter((h) => anywhere(h) || isBeforeConsent(h, ctx));
    narrowed.push("before consent");
  }
  if (rule.inEpoch) {
    const selector = rule.inEpoch;
    hits = hits.filter((h) => anywhere(h) || inEpoch(h, selector, ctx));
    narrowed.push(`in epoch(${selector})`);
  }
  const windowStart = ruleWindowStart(rule, ctx);
  if (windowStart && "message" in windowStart) return windowStart;
  if (windowStart) {
    const { at: start, text: text2 } = windowStart;
    hits = hits.filter((h) => {
      if (anywhere(h)) return true;
      const at = judgedAt(h, ctx.index);
      return at !== void 0 && at >= start;
    });
    narrowed.push(text2);
  }
  const where2 = narrowed.length ? ` ${narrowed.join(", ")}` : "";
  const vacuous = rule.before ? vacuousBeforeConsent(rule, ctx) : void 0;
  if (rule.body) return evaluateBodyRule(rule, rule.body, hits, where2, total2, vacuous);
  const ids = hits.map((h) => h.id);
  const found = `found ${hits.length} matching hit${hits.length === 1 ? "" : "s"}${narrowed.length ? ` (${total2} before narrowing)` : ""}`;
  if (rule.kind === "mustNot") {
    return {
      pass: hits.length === 0,
      evidence: ids,
      message: (hits.length === 0 ? `Expected no matching hits${where2}, found none.` : `Expected no matching hits${where2}, ${found}.`) + (vacuous ? ` ${vacuous}` : "")
    };
  }
  const count = rule.count ?? { op: ">=", n: 1 };
  const pass = countHolds(count, hits.length);
  const message = `Expected ${describeCount(count)} matching hits${where2}, ${found}.${vacuous ? ` ${vacuous}` : ""}`;
  if (pass && rule.hashesMatch && hits.length > 0) {
    const check = checkHashes(hits, ctx);
    if (check.pass) return { pass: true, evidence: check.evidence, message: `${message} ${check.message}` };
    const matched = `${hits.length} hit${hits.length === 1 ? "" : "s"} matched ${describeSelector(rule.filter)}${where2}`;
    const headline = check.headline ?? (countHolds(count, 0) ? UNMATCHED_HEADLINE : `Expected ${describeCount(count)} hits matching all conditions, found 0.`);
    return { pass: false, evidence: check.evidence, message: `${headline} ${matched}, but identity.hashesMatch failed: ${check.message}` };
  }
  return { pass, evidence: ids, message };
}
var STUB_NO_COOKIES = "stub mode: stubbed endpoints set no cookies";
function cookieSightings(matchers, ctx) {
  const out = [];
  const wanted = (name) => matchers.some((m) => m.test(name));
  for (const response of ctx.responses) {
    const request = ctx.requests.get(response.requestId);
    const t = request?.t;
    const host = request && hostOf(request.url);
    for (const name of response.setCookieNames) if (wanted(name)) out.push({ name, evidence: response.requestId, t, source: "Set-Cookie", ...host && { host } });
  }
  for (const checkpoint of ctx.checkpoints)
    for (const cookie of checkpoint.cookies) if (wanted(cookie.name)) out.push({ name: cookie.name, evidence: checkpoint.id, t: checkpoint.t, source: `checkpoint "${checkpoint.label}"` });
  return out;
}
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return void 0;
  }
}
function domainMatches(host, cookieDomain) {
  const domain = cookieDomain.replace(/^\./, "").toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}
var STORAGE_MARGIN_MS = 50;
var STORED_RANK = { stored: 3, notStored: 2, alreadySet: 1, unknown: 0 };
function storedState(sighting, ctx) {
  if (sighting.t === void 0 || !sighting.host) return "unknown";
  const t = sighting.t;
  const host = sighting.host;
  const holds = (c) => c.cookies.some((k) => k.name === sighting.name && domainMatches(host, k.domain));
  const before = ctx.checkpoints.filter((c) => c.t !== void 0 && c.t < t).sort((a, b) => b.t - a.t)[0];
  if (before && holds(before)) return "alreadySet";
  const later = ctx.checkpoints.filter((c) => c.t !== void 0 && c.t > t + STORAGE_MARGIN_MS);
  if (later.length === 0) return "unknown";
  return later.some(holds) ? "stored" : "notStored";
}
var STORED_TEXT = { stored: "stored by the browser", notStored: "no later checkpoint has it", alreadySet: "the cookie was already set before this response" };
function storageText(sightings, ctx) {
  const byName = /* @__PURE__ */ new Map();
  for (const sighting of sightings.filter((x) => x.source === "Set-Cookie")) {
    const state = storedState(sighting, ctx);
    const previous = byName.get(sighting.name);
    if (previous === void 0 || STORED_RANK[state] > STORED_RANK[previous]) byName.set(sighting.name, state);
  }
  const named = (want) => [...byName].filter(([, state]) => state === want).map(([name]) => guardFieldName(name)).sort();
  const stored = named("stored");
  const notStored = named("notStored");
  const alreadySet = named("alreadySet");
  const groups = [
    { state: "stored", names: stored, mixed: "stored by the browser" },
    { state: "notStored", names: notStored, mixed: "no later checkpoint has" },
    { state: "alreadySet", names: alreadySet, mixed: "the cookie was already set before this response" }
  ];
  const present = groups.filter((g) => g.names.length);
  if (!present.length) return void 0;
  const text2 = present.length === 1 ? STORED_TEXT[present[0].state] : present.map((g) => `${g.mixed}: ${listNames(g.names)}`).join("; ");
  return { text: text2, notStored: notStored.length > 0 };
}
function beforeConsentAt(t, ctx) {
  const epoch = epochForHit(ctx.epochs, t, ctx.grace);
  return !epoch || epoch === ctx.epochs[0] && epoch.label === "undecided";
}
function inEpochAt(t, selector, ctx) {
  const epoch = epochForHit(ctx.epochs, t, ctx.grace);
  if (selector === "undecided") return !epoch || epoch.label === "undecided";
  if (!epoch) return false;
  if (selector.startsWith("label=")) return epoch.label === selector.slice("label=".length);
  if (selector === "granted" || selector === "denied") return (epoch.outcome ?? epoch.label) === selector;
  return stateMatches(epoch.state, selector);
}
function evaluateCookieRule(rule, patterns, ctx) {
  let sightings = cookieSightings(patterns.map((p) => globToRegExp(p)), ctx);
  const total2 = sightings.length;
  const narrowed = [];
  const windowStart = ruleWindowStart(rule, ctx);
  if (windowStart && "message" in windowStart) return windowStart;
  const timed = rule.before || rule.inEpoch || windowStart !== void 0;
  const unplaced = timed ? sightings.filter((s) => s.t === void 0) : [];
  if (timed) sightings = sightings.filter((s) => s.t !== void 0);
  const keep = (test) => {
    sightings = sightings.filter((s) => test(s.t));
  };
  if (rule.before) {
    keep((t) => beforeConsentAt(t, ctx));
    narrowed.push("before consent");
  }
  if (rule.inEpoch) {
    const selector = rule.inEpoch;
    keep((t) => inEpochAt(t, selector, ctx));
    narrowed.push(`in epoch(${selector})`);
  }
  if (windowStart) {
    keep((t) => t >= windowStart.at);
    narrowed.push(windowStart.text);
  }
  const where2 = narrowed.length ? ` ${narrowed.join(", ")}` : "";
  const headerNames = new Set(sightings.filter((s) => s.source === "Set-Cookie").map((s) => s.name));
  sightings = sightings.filter((s) => s.source === "Set-Cookie" || !headerNames.has(s.name));
  const evidence = [...new Set(sightings.map((s) => s.evidence))];
  const wantedCount = rule.kind === "must" ? { op: ">=", n: 1 } : { op: "=", n: 0 };
  const low = countHolds(wantedCount, sightings.length);
  if (low !== countHolds(wantedCount, sightings.length + unplaced.length)) {
    return {
      pass: false,
      evidence: unplaced.map((s) => s.evidence),
      message: `cannot evaluate: ${unplaced.length} matching cookie${unplaced.length === 1 ? "" : "s"} in a checkpoint with no time${where2}.`
    };
  }
  const names = [...new Set(sightings.map((s) => guardFieldName(s.name)))].sort();
  const sources = [...new Set(sightings.map((s) => s.source))];
  const headerOnly = sources.length === 1 && sources[0] === "Set-Cookie";
  const requests = new Set(sightings.map((s) => s.evidence)).size;
  const storage = sightings.length ? storageText(sightings, ctx) : void 0;
  const count = headerOnly ? `${requests} request${requests === 1 ? "" : "s"}` : `${total2} before narrowing`;
  const found = sightings.length ? `found ${listNames(names)} from ${sources.join(" and ")} (${count})${storage ? `; ${storage.text}` : ""}${sources.some((s) => s !== "Set-Cookie") ? ". A checkpoint shows the cookie was present then, not when it was set" : ""}` : `found no matching cookie (${total2} before narrowing)`;
  const expected = rule.kind === "must" ? `Expected a matching cookie${where2}` : `Expected no matching cookie${where2}`;
  const stubbed = low && rule.kind === "mustNot" && ctx.networkMode === "stub";
  return {
    pass: low,
    evidence,
    message: `${expected}, ${found}.${stubbed ? ` ${STUB_NO_COOKIES}` : ""}`,
    ...stubbed && { note: "stubNoCookies" },
    ...storage?.notStored && { note: "cookieNotStored" }
  };
}
var NOT_RECORDED = "cannot evaluate: field names not recorded";
var BODY_CUT = "cannot evaluate: body not fully recorded";
var VENDOR_IGNORE = { ga4: GA4_BODY_ONLY_IGNORE, meta: META_BODY_ONLY_IGNORE, "meta-capi": META_CAPI_BODY_ONLY_IGNORE, sgtm: SGTM_BODY_ONLY_IGNORE };
function listNames(names) {
  return names.length > MAX_NAMES ? `${names.slice(0, MAX_NAMES).join(", ")} and ${names.length - MAX_NAMES} more` : names.join(", ");
}
function cannotEvaluate(unreadable, where2) {
  const notRecorded = unreadable.some((h) => !h.fields);
  return {
    pass: false,
    evidence: unreadable.map((h) => h.id),
    message: `${notRecorded ? NOT_RECORDED : BODY_CUT}: ${unreadable.length} selected hit${unreadable.length === 1 ? "" : "s"}${where2}.`,
    note: notRecorded ? "fieldsNotRecorded" : "cannotEvaluateBody"
  };
}
function fieldGlob(pattern) {
  if (!pattern.startsWith("**.")) return globToRegExp(pattern);
  return new RegExp(`^(?:.*\\.)?${globToRegExp(pattern.slice(3)).source.slice(1, -1)}$`);
}
function nestedNames(plain, hits) {
  const wanted = new Set(plain);
  const found = /* @__PURE__ */ new Set();
  for (const hit of hits)
    for (const field of hit.fields ?? []) if (field.includes(".") && wanted.has(field.slice(field.lastIndexOf(".") + 1))) found.add(guardFieldName(field));
  return [...found].sort();
}
function evaluateBodyRule(rule, body, selected, where2, total2, vacuous) {
  const tail = vacuous ? ` ${vacuous}` : "";
  const narrowed = `${selected.length} selected hit${selected.length === 1 ? "" : "s"}${where2}`;
  if (body.has) {
    const matchers = body.has.map(fieldGlob);
    const unreadable2 = [];
    const matching = [];
    for (const hit of selected) {
      if (!hit.fields) {
        unreadable2.push(hit);
        continue;
      }
      const names2 = hit.fields.filter((f) => matchers.some((m) => m.test(f)));
      if (names2.length) matching.push({ hit, names: names2 });
      else if (hit.fieldsComplete === false) unreadable2.push(hit);
    }
    const count = rule.kind === "must" ? rule.count ?? { op: ">=", n: 1 } : { op: "=", n: 0 };
    const low = countHolds(count, matching.length);
    const undecided = Array.from({ length: unreadable2.length }, (_, k) => countHolds(count, matching.length + k + 1)).some((holds) => holds !== low);
    if (undecided) return cannotEvaluate(unreadable2, where2);
    const names = [...new Set(matching.flatMap((m) => m.names))].sort();
    const evidence = matching.map((m) => m.hit.id);
    const found = matching.length ? `found ${matching.length} hit${matching.length === 1 ? "" : "s"} with body.has fields: ${listNames(names)}` : "found no hit with the body.has fields";
    const expected = rule.kind === "must" ? `Expected ${describeCount(count)} hits with body.has fields${where2}` : `Expected no hit with body.has fields${where2}`;
    const nested = matching.length ? [] : nestedNames(body.has.filter((n) => !n.includes("*")), selected);
    const nestedText = nested.length ? `; no top-level match; nested fields with this name: ${listNames(nested)}` : "";
    return { pass: low, evidence, message: `${expected}, ${found} (${total2} before narrowing)${nestedText}.${tail}`, ...nested.length && { note: "nestedNameOnly" } };
  }
  const only = body.only;
  const allowed = [...only, ...body.ignore ?? []].map(fieldGlob);
  if (rule.kind === "must") {
    const count = rule.count ?? { op: ">=", n: 1 };
    if (!countHolds(count, selected.length))
      return { pass: false, evidence: selected.map((h) => h.id), message: `Expected ${describeCount(count)} matching hits${where2}, found ${selected.length}.${tail}` };
  }
  const unreadable = [];
  const offenders = [];
  for (const hit of selected) {
    if (!hit.fields) {
      unreadable.push(hit);
      continue;
    }
    const vendorIgnore = VENDOR_IGNORE[hit.vendor] ?? [];
    const outside = hit.fields.filter((f) => !allowed.some((m) => m.test(f)) && !matchesIgnoreList(f, vendorIgnore));
    if (outside.length) offenders.push({ hit, outside });
    else if (hit.fieldsComplete === false) unreadable.push(hit);
  }
  if (offenders.length) {
    const lines = offenders.slice(0, MAX_LISTED).map((o) => `${o.hit.id} has fields outside body.only: ${listNames(o.outside)} (${o.outside.length} of ${o.hit.fields.length})`);
    const more = offenders.length > MAX_LISTED ? ` and ${offenders.length - MAX_LISTED} more hits` : "";
    return { pass: false, evidence: offenders.map((o) => o.hit.id), message: `${lines.join("; ")}${more}.${tail}` };
  }
  if (unreadable.length) return cannotEvaluate(unreadable, where2);
  return { pass: true, evidence: selected.map((h) => h.id), message: `All ${narrowed} have only fields allowed by body.only.${tail}` };
}
function describeSelector(filter) {
  const parts = [
    filter.vendor && "vendor",
    filter.event && "event",
    filter.host && "host",
    filter.transport && "transport",
    filter.page && "page",
    filter.outcome && "outcome",
    filter.sentBy && "sentBy",
    Object.keys(filter.ids).length > 0 && "ids",
    Object.keys(filter.params).length > 0 && "params",
    Object.keys(filter.consent).length > 0 && "consent"
  ].filter((p) => !!p);
  if (parts.length === 0) return "the selector";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
function vacuousBeforeConsent(rule, ctx) {
  const vendors = rule.filter.vendor;
  if (!vendors || vendors.some((v) => GOOGLE_VENDORS.has(v))) return void 0;
  const first = ctx.epochs[0];
  const state = first?.label === "undecided" ? first.state : void 0;
  const blocked = consentFields.filter((f) => {
    const want = rule.filter.consent[f];
    return want !== void 0 && (state?.[f] ?? "unknown") !== want;
  });
  if (!blocked.length) return void 0;
  return `This rule cannot match: before consent, ${vendors.join(", ")} hits take the undecided state, where ${blocked.join(", ")} is not ${rule.filter.consent[blocked[0]]}.`;
}
function matchesFilter(hit, f, ctx) {
  if (f.vendor && !f.vendor.includes(hit.vendor)) return false;
  if (f.event && (hit.event === null || !f.event.includes(hit.event))) return false;
  const effective = effectiveConsent(hit, ctx);
  for (const field of consentFields) {
    const want = f.consent[field];
    if (want && effective[field] !== want) return false;
  }
  for (const [name, want] of Object.entries(f.ids)) {
    const have = idValue(hit, name, ctx);
    const compared = name.endsWith(".matchesIdentity");
    const present = compared ? have === true : have !== void 0 && have !== false;
    const absent = compared ? have === false : !present;
    if (want === "present") {
      if (!present) return false;
    } else if (want === "absent") {
      if (!absent) return false;
    } else if (String(have) !== want) return false;
  }
  if (f.page) {
    if (hit.page === null) return false;
    if ("equals" in f.page ? hit.page !== f.page.equals : !new RegExp(f.page.matches).test(hit.page)) return false;
  }
  if (f.sentBy && ctx.serverHitIds.has(hit.id) !== (f.sentBy === "server")) return false;
  if (f.transport && !f.transport.includes(hit.transport)) return false;
  for (const [name, want] of Object.entries(f.params)) if (hit.params[name] !== want) return false;
  if (f.host || f.outcome) {
    const request = ctx.requests.get(hit.requestId);
    if (!request) return false;
    if (f.host && !hostForms(request.url).some((form) => f.host.includes(form))) return false;
    if (f.outcome && !f.outcome.includes(request.outcome)) return false;
  }
  return true;
}
function idValue(hit, name, ctx) {
  if (name === "hashes") return Object.values(hit.ids.hashes ?? {}).some((h) => h.present);
  if (Object.hasOwn(hit.ids, name)) {
    const flat = hit.ids[name];
    if (typeof flat !== "object") return flat;
  }
  const [head, field, prop, ...rest] = name.split(".");
  if (head !== "hashes" || !field || rest.length) return void 0;
  const hash = hit.ids.hashes && Object.hasOwn(hit.ids.hashes, field) ? hit.ids.hashes[field] : void 0;
  if (!hash) return void 0;
  if (prop === void 0) return hash.present;
  return prop === "matchesIdentity" ? hash.matchesIdentity ?? capiMatchesIdentity(hit, field, ctx.identity) : void 0;
}
function hostForms(url) {
  try {
    const { host, hostname: hostname2 } = new URL(url);
    return [host, hostname2, hostname2.replace(/^\[|\]$/g, "")];
  } catch {
    return [""];
  }
}
function revokes(prev, next) {
  if (next.label === "withdrawn") return true;
  const before = prev.state;
  const after = next.state;
  return !!before && !!after && consentFields.some((f) => before[f] === "granted" && after[f] === "denied");
}
function epochForHit(epochs, t, graceMs = DEFAULT_GRACE_MS) {
  let found;
  epochs.forEach((e, i) => {
    const start = i === 0 ? e.label === "undecided" ? -Infinity : e.startT : revokes(epochs[i - 1], e) ? e.startT : e.startT - graceMs;
    if (t >= start) found = e;
  });
  return found;
}
function judgeIndex(hits, requests) {
  return {
    hits: new Map(hits.map((h) => [h.id, h])),
    requests: requests instanceof Map ? requests : new Map(requests.map((r) => [r.id, r]))
  };
}
function isServerHit(hit, index) {
  return index.requests.get(hit.requestId)?.captured === "serverContainer";
}
function viaHitOf(hit, index) {
  if (!hit.via || !isServerHit(hit, index)) return void 0;
  const via = index.hits.get(hit.via.hitId);
  return via && !isServerHit(via, index) ? via : void 0;
}
function isUnlinkedServerHit(hit, index) {
  return isServerHit(hit, index) && !viaHitOf(hit, index);
}
function judgedAt(hit, index) {
  if (!isServerHit(hit, index)) return hit.t;
  return viaHitOf(hit, index)?.t;
}
function epochOf(hit, ctx) {
  const t = judgedAt(hit, ctx.index);
  return t === void 0 ? void 0 : epochForHit(ctx.epochs, t, ctx.grace);
}
function onlyProbableServerHits(evidence, ctx) {
  return evidence.length > 0 && evidence.every((id) => {
    const hit = ctx.index.hits.get(id);
    return hit?.via?.confidence === "probable" && viaHitOf(hit, ctx.index) !== void 0;
  });
}
function settleServerSends(pass, evidence, severity, note, timeJudged, ctx) {
  if (!pass && note === "serverSendUnlinked") return { severity: "warn", note };
  if (note || !timeJudged) return { severity, note };
  const judged = evidence.filter((id) => {
    const hit = ctx.index.hits.get(id);
    return !hit || !isUnlinkedServerHit(hit, ctx.index);
  });
  if (!onlyProbableServerHits(judged, ctx)) return { severity, note };
  if (judged.length < evidence.length && !pass) return { severity: "warn", note: "serverSendUnlinked" };
  return { severity: pass ? severity : "warn", note: "serverSendProbableLink" };
}
function effectiveConsent(hit, ctx) {
  return effectiveConsentAt(hit, ctx.epochs, ctx.grace, ctx.index);
}
function effectiveConsentAt(hit, epochs, graceMs, index) {
  const t = index ? judgedAt(hit, index) : hit.t;
  if (t === void 0) return { analytics: "unknown", ads: "unknown", adUserData: "unknown", adPersonalization: "unknown" };
  const source = index && viaHitOf(hit, index) || hit;
  const base2 = epochForHit(epochs, t, graceMs)?.state;
  const own = GOOGLE_VENDORS.has(source.vendor) && consentFields.some((f) => source.consent[f] !== "unknown");
  const pick2 = (f) => {
    if (own) return source.consent[f];
    return base2 ? base2[f] : "unknown";
  };
  return {
    analytics: pick2("analytics"),
    ads: pick2("ads"),
    adUserData: pick2("adUserData"),
    adPersonalization: pick2("adPersonalization")
  };
}
function stateMatches(state, selector) {
  if (selector === "undecided") return false;
  if (selector === "granted" || selector === "denied") {
    const known = consentFields.map((f) => state[f]).filter((v) => v !== "unknown");
    return known.length > 0 && known.every((v) => v === selector);
  }
  const [field, value] = selector.split("=");
  return state[field] === value;
}
function inUndecidedEpoch(hit, ctx) {
  if (isUnlinkedServerHit(hit, ctx.index)) return false;
  const epoch = epochOf(hit, ctx);
  return !epoch || epoch.label === "undecided";
}
function isBeforeConsent(hit, ctx) {
  if (isUnlinkedServerHit(hit, ctx.index)) return false;
  const epoch = epochOf(hit, ctx);
  return !epoch || epoch === ctx.epochs[0] && epoch.label === "undecided";
}
function inEpoch(hit, selector, ctx) {
  if (isUnlinkedServerHit(hit, ctx.index)) return false;
  if (selector === "undecided") return inUndecidedEpoch(hit, ctx);
  if (selector.startsWith("label=")) return epochOf(hit, ctx)?.label === selector.slice("label=".length);
  if ((selector === "granted" || selector === "denied") && !GOOGLE_VENDORS.has(hit.vendor)) {
    const epoch = epochOf(hit, ctx);
    return (epoch?.outcome ?? epoch?.label) === selector;
  }
  return stateMatches(effectiveConsent(hit, ctx), selector);
}
var UNMATCHED_HEADLINE = "Expected every hashed identity value to match the run identity.";
var EMAIL_PARAM = /^(?:em|ud\[em\]|hashedEmail|sha256_email_address|user_data\.email_address)$/;
var PHONE_PARAM = /^(?:ph|ud\[ph\]|hashedPhone|sha256_phone_number|user_data\.phone_number)$/;
var FIELD_PARAMS = {
  "user_data.first_name": (i) => i.firstName,
  "user_data.last_name": (i) => i.lastName,
  "user_data.street": (i) => i.address1,
  "user_data.city": (i) => i.city,
  "user_data.postal_code": (i) => i.zip,
  "user_data.country": (i) => i.country
};
var FIELD_LABELS = {
  "user_data.first_name": "first name",
  "user_data.last_name": "last name",
  "user_data.street": "street",
  "user_data.city": "city",
  "user_data.postal_code": "postal code",
  "user_data.country": "country"
};
function fieldLabel(name) {
  return EMAIL_PARAM.test(name) ? "email" : PHONE_PARAM.test(name) ? "phone" : FIELD_LABELS[name] ?? name;
}
function joinLabels(labels) {
  const all = [...labels];
  return all.length > 1 ? `${all.slice(0, -1).join(", ")} and ${all.at(-1)}` : all[0] ?? "";
}
var PLAIN_ADDRESS_PARAMS = /* @__PURE__ */ new Set(["user_data.city", "user_data.postal_code", "user_data.country"]);
var PLAIN_ADDRESS_VENDORS = /* @__PURE__ */ new Set(["sgtm"]);
var DIGEST_SHAPE = /^(?:[0-9a-f]{64}|[A-Za-z0-9+/_-]{43}=?)$/i;
function allForms(h) {
  return [h.hex, h.base64, h.base64url];
}
function identityParamName(vendor, name) {
  return vendor === "meta-capi" ? metaCapiBaseParam(name) : name;
}
function hashJudge(identity) {
  const emailHashes = new Set(allForms(hashEmail(identity.email)));
  const phone = hashPhone(identity.phone);
  const phoneHashes = /* @__PURE__ */ new Set([...allForms(phone), ...allForms(sha256(identity.phone.replace(/\D/g, "")))]);
  const plain = /* @__PURE__ */ new Set([identity.email.toLowerCase(), identity.phone.toLowerCase(), identity.phone.replace(/\D/g, "")]);
  const extra = identity.extra ?? [];
  return (vendor, rawName, value) => {
    const name = identityParamName(vendor, rawName);
    const field = FIELD_PARAMS[name]?.(identity);
    const accepted = field === void 0 ? [] : [field, ...extra];
    const known = EMAIL_PARAM.test(name) ? emailHashes : PHONE_PARAM.test(name) ? phoneHashes : field !== void 0 ? fieldHashes(...accepted) : void 0;
    if (!known || !value) return void 0;
    if (PLAIN_ADDRESS_PARAMS.has(name) && PLAIN_ADDRESS_VENDORS.has(vendor) && !DIGEST_SHAPE.test(value)) return "plain";
    if (known.has(value)) return "match";
    const typed = value.trim().toLowerCase();
    if (plain.has(typed) || accepted.some((v) => v.trim().toLowerCase() === typed)) return "unhashed";
    return PLAIN_ADDRESS_PARAMS.has(name) && vendor === "meta-capi" && !DIGEST_SHAPE.test(value) ? "plain" : "wrong";
  };
}
function capiMatchesIdentity(hit, field, identity) {
  const base2 = Object.hasOwn(META_CAPI_PARAM_NAMES, field) ? META_CAPI_PARAM_NAMES[field] : void 0;
  if (hit.vendor !== "meta-capi" || !identity || !base2) return null;
  const judge2 = hashJudge(identity);
  const verdicts2 = Object.entries(hit.params).filter(([name]) => metaCapiBaseParam(name) === base2).map(([name, value]) => judge2(hit.vendor, name, value)).filter((v) => v !== void 0);
  return verdicts2.length === 0 ? null : verdicts2.every((v) => v === "match");
}
function checkHashes(hits, ctx) {
  const identity = ctx.identity;
  if (!identity) {
    return {
      pass: false,
      evidence: hits.map((h) => h.id),
      headline: "Expected every hashed identity value to match the run identity, but it could not be checked.",
      message: "no run identity was given, so the hashes could not be checked."
    };
  }
  const judge2 = hashJudge(identity);
  const withHash = [];
  const wrong = [];
  const unhashed = [];
  const plainCapi = [];
  const wrongFields = /* @__PURE__ */ new Set();
  const wrongParams = /* @__PURE__ */ new Set();
  const matchedFields = /* @__PURE__ */ new Set();
  const unhashedFields = /* @__PURE__ */ new Set();
  const plainCapiFields = /* @__PURE__ */ new Set();
  const plainAddressFields = /* @__PURE__ */ new Set();
  const uncheckedFields = /* @__PURE__ */ new Set();
  for (const hit of hits) {
    let seen = false;
    let bad = false;
    let raw = false;
    let plainHit = false;
    if (hit.vendor === "meta") {
      for (const id of Object.keys(hit.ids)) if (id !== "hashedEmail" && id !== "hashedPhone") uncheckedFields.add(guardFieldName(id));
    }
    for (const [name, value] of Object.entries(hit.params)) {
      const verdict = judge2(hit.vendor, name, value);
      if (!verdict) continue;
      const label = fieldLabel(identityParamName(hit.vendor, name));
      if (verdict === "plain") {
        if (hit.vendor === "meta-capi") {
          plainCapiFields.add(label);
          plainHit = true;
        } else plainAddressFields.add(label);
        continue;
      }
      seen = true;
      if (verdict === "match") {
        matchedFields.add(label);
        continue;
      }
      bad = true;
      if (verdict === "unhashed") {
        raw = true;
        unhashedFields.add(label);
      } else {
        wrongFields.add(label);
        wrongParams.add(name);
      }
    }
    if (seen) withHash.push(hit.id);
    if (bad) wrong.push(hit.id);
    if (raw) unhashed.push(hit.id);
    if (plainHit) plainCapi.push(hit.id);
  }
  const several = hits.length > 1;
  const they = several ? "they" : "it";
  const of = (n) => several ? ` (${n} of ${hits.length} hits)` : "";
  if (unhashed.length) {
    return { pass: false, evidence: unhashed, headline: UNMATCHED_HEADLINE, message: `${they} carried an unhashed ${joinLabels(unhashedFields)}${of(unhashed.length)}.` };
  }
  if (wrong.length) {
    const matching = new Set([...matchedFields].filter((f) => !wrongFields.has(f)));
    const message = `the hashed ${joinLabels(wrongFields)} values ${they} carried do not match the run identity${of(wrong.length)}. Not matching: ${[...wrongParams].join(", ")}.` + (matching.size ? ` Matching: ${joinLabels(matching)}.` : "");
    return { pass: false, evidence: wrong, headline: UNMATCHED_HEADLINE, message };
  }
  if (plainCapi.length) {
    return {
      pass: false,
      evidence: plainCapi,
      headline: UNMATCHED_HEADLINE,
      message: `${they} carried a plain ${joinLabels(plainCapiFields)}, not a hash${of(plainCapi.length)}. The Conversions API takes these hashed.`
    };
  }
  if (!withHash.length && uncheckedFields.size) {
    return {
      pass: false,
      evidence: hits.map((h) => h.id),
      message: `${several ? "none of the hits carried a" : "the hit carried no"} hashed email or phone, only ${joinLabels(uncheckedFields)} that Tagreeve does not check.`
    };
  }
  if (!withHash.length && plainAddressFields.size) {
    return {
      pass: false,
      evidence: hits.map((h) => h.id),
      message: `${several ? "none of the hits carried a" : "the hit carried no"} hashed identity field, only plain ${joinLabels(plainAddressFields)} that Tagreeve does not check.`
    };
  }
  if (!withHash.length) {
    return {
      pass: false,
      evidence: hits.map((h) => h.id),
      message: `${several ? "none of the hits carried any" : "the hit carried no"} identity fields (no hashed or plain email, phone, name or address); matching done server side, for example by a conversions API, is not visible to Tagreeve.`
    };
  }
  return { pass: true, evidence: withHash, message: `Hashed values in ${withHash.length} hit(s) match the run identity.` };
}
function pageWithoutQuery(page2) {
  if (!page2) return "";
  try {
    const url = new URL(page2.startsWith("//") ? `http:${page2}` : page2);
    return `${url.host}${maskValuePath(url.pathname, "(other)")}`;
  } catch {
    return maskValuePath(page2.split(/[?#]/)[0], "(other)");
  }
}
function flagHost(flag2, ctx) {
  const urls = [ctx.requests.get(flag2.recordIds[0] ?? "")?.url, /\s(\S+)$/.exec(flag2.detail)?.[1]];
  for (const url of urls) {
    try {
      if (url) return new URL(url).hostname;
    } catch {
      continue;
    }
  }
  return "";
}
function countByHost(flags2, ctx) {
  const counts = /* @__PURE__ */ new Map();
  for (const f of flags2) {
    const host = flagHost(f, ctx) || "(unknown host)";
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts].map(([host, n]) => `${host} x${n}`).join(", ");
}
var DEFAULT_SEVERITY = { earlyIdentifiers: "warn" };
function builtInChecks(records, scenario, ctx, addResult) {
  const add2 = (name, pass, evidence2, message, note, timeJudged = false) => addResult(
    `builtin: ${name}`,
    pass,
    evidence2,
    message,
    scenario.options.builtins?.[name] ?? DEFAULT_SEVERITY[name] ?? "fail",
    note,
    timeJudged
  );
  const flags2 = records.filter((r) => r.type === "flag");
  const unknown = flags2.filter((f) => f.kind === "unknownDestination");
  const allow = scenario.options.allowUnknownDestination;
  const allowedHosts = Array.isArray(allow) ? allow : [];
  const isAllowed = (f) => allow === true || hostMatches4(flagHost(f, ctx), allowedHosts);
  const blocked = unknown.filter((f) => !isAllowed(f));
  const allowedCount = unknown.length - blocked.length;
  add2(
    "unknownDestination",
    blocked.length === 0,
    blocked.length === 0 ? unknown.map((f) => f.id) : blocked.flatMap((f) => [f.id, ...f.recordIds]),
    blocked.length > 0 ? `Expected no requests to unknown destinations, found ${blocked.length}: ${countByHost(blocked, ctx)}.` : unknown.length > 0 ? `Unknown destinations allowed by the scenario; ${allowedCount} flagged.` : "Expected no requests to unknown destinations, found none."
  );
  const sandboxed = ctx.hits.filter((h) => isSandboxPageUrl(h.page));
  add2(
    "sandboxPageUrl",
    sandboxed.length === 0,
    sandboxed.map((h) => h.id),
    sandboxed.length === 0 ? "Expected no hit to carry a sandbox URL as its page, found none." : `Expected no hit to carry a sandbox URL as its page, found ${sandboxed.length}: ${pageWithoutQuery(sandboxed[0].page)}.`
  );
  for (const check of [deniedIdentifiersCheck, earlyIdentifiersCheck]) {
    const passes = (c) => {
      let pass = true;
      check(scenario, c, (_name, p, _evidence, _message, note) => void (pass = p || note === "serverSendUnlinked"));
      return pass;
    };
    check(
      scenario,
      ctx,
      (name, pass, evidence2, message, note) => add2(name, pass, evidence2, message, note ?? (pass && passRestsOnProbableLink(ctx, passes) ? "serverSendProbableLink" : void 0), pass || failureRestsOnProbableLink(ctx, passes))
    );
  }
  const real = flags2.filter((f) => f.kind === "possibleRealData");
  const flagged = new Set(real.flatMap((f) => f.recordIds));
  const leaks = ctx.identity ? findForeignData(ctx.requests.values(), ctx.hits, ctx.identity).filter((l) => !flagged.has(l.requestId)) : [];
  const evidence = [...real.flatMap((f) => [f.id, ...f.recordIds]), ...leaks.flatMap((l) => l.evidence)];
  const problems = [...real.map((f) => f.detail), ...leaks.map((l) => l.detail)];
  const shown2 = problems.slice(0, MAX_LISTED).join("; ");
  const more = problems.length > MAX_LISTED ? `; and ${problems.length - MAX_LISTED} more` : "";
  if (!ctx.identity && real.length === 0) {
    add2(
      "possibleRealData",
      false,
      [],
      "Cannot check for data that is not from the run identity: no identity was given and no possibleRealData flags exist."
    );
    return;
  }
  add2(
    "possibleRealData",
    problems.length === 0,
    evidence,
    problems.length === 0 ? "Expected no data that is not from the run identity, found none." : `Expected no data that is not from the run identity, found ${problems.length}: ${shown2}${more}.`
  );
}
var DENIABLE = ["analytics", "ads", "adUserData"];
function unjudgedIdentifiers(ctx) {
  return ctx.hits.filter((h) => isUnlinkedServerHit(h, ctx.index) && (!h.idFields || !h.fields || h.idFields.length > 0 || h.fieldsComplete === false));
}
function cannotJudgeUnlinked(hits, when) {
  const n = hits.length;
  return {
    evidence: hits.map((h) => h.id),
    message: `Cannot evaluate: ${n} server container hit${n === 1 ? " has" : "s have"} no link to a browser hit and carr${n === 1 ? "ies" : "y"} identifiers, so no consent state applies to ${n === 1 ? "it" : "them"} ${when}.`
  };
}
function identifierClasses(idFields, fields2, extra) {
  const classes = new Map(idFields.map((n) => [n, identifierClass(n)]));
  for (const n of fields2) if (!classes.has(n) && extra.some((re) => re.test(n))) classes.set(n, "analytics");
  return classes;
}
function deniedIdentifiersCheck(scenario, ctx, add2) {
  const extra = (scenario.options.identifierFields ?? []).map(globToRegExp);
  const leaking = [];
  const unreadable = [];
  const found = /* @__PURE__ */ new Map();
  for (const hit of ctx.hits) {
    const state = effectiveConsent(hit, ctx);
    if (!DENIABLE.some((f) => state[f] === "denied")) continue;
    if (!hit.idFields || !hit.fields) {
      unreadable.push(hit);
      continue;
    }
    const classes = identifierClasses(hit.idFields, hit.fields, extra);
    let flagged = false;
    for (const [name, cls] of classes) {
      const signal = identifierSignal(cls, state);
      if (signal.value !== "denied") continue;
      flagged = true;
      const key = `${hit.vendor}\0${signal.field}`;
      found.set(key, (found.get(key) ?? /* @__PURE__ */ new Set()).add(name));
    }
    if (flagged) leaking.push(hit);
    else if (hit.fieldsComplete === false) unreadable.push(hit);
  }
  if (leaking.length > 0) {
    const groups = [...found].map(([key, names]) => {
      const [vendor, signal] = key.split("\0");
      return `${vendor} ${listNames([...names].sort())} (${signal} denied)`;
    });
    const shown2 = groups.slice(0, MAX_LISTED).join(", ");
    const more = groups.length > MAX_LISTED ? `, and ${groups.length - MAX_LISTED} more` : "";
    const cut = unreadable.length > 0 ? ` ${unreadable.length} more hit${unreadable.length === 1 ? "" : "s"} could not be read.` : "";
    const unjudged = unjudgedIdentifiers(ctx);
    add2(
      "deniedIdentifiers",
      false,
      [...leaking.map((h) => h.id), ...unjudged.map((h) => h.id)],
      `${leaking.length} hit${leaking.length === 1 ? " carries" : "s carry"} identifiers while consent is denied: ${shown2}${more}.${cut}${unjudged.length > 0 ? ` ${cannotJudgeUnlinked(unjudged, "for denied consent").message}` : ""}`
    );
  } else if (unreadable.length > 0) {
    const unjudged = unjudgedIdentifiers(ctx);
    const notRecorded = unreadable.some((h) => !h.idFields || !h.fields);
    add2(
      "deniedIdentifiers",
      false,
      [...unreadable.map((h) => h.id), ...unjudged.map((h) => h.id)],
      `${notRecorded ? NOT_RECORDED : BODY_CUT}: ${unreadable.length} hit${unreadable.length === 1 ? "" : "s"} sent while consent is denied.${unjudged.length > 0 ? ` ${cannotJudgeUnlinked(unjudged, "for denied consent").message}` : ""}`,
      notRecorded ? "fieldsNotRecorded" : "cannotEvaluateBody"
    );
  } else if (unjudgedIdentifiers(ctx).length > 0) {
    const unjudged = unjudgedIdentifiers(ctx);
    const { evidence, message } = cannotJudgeUnlinked(unjudged, "for denied consent");
    add2("deniedIdentifiers", false, evidence, message, "serverSendUnlinked");
  } else {
    add2("deniedIdentifiers", true, [], "Expected no identifiers on hits sent while consent is denied, found none.");
  }
}
function earlyIdentifiersCheck(scenario, ctx, add2) {
  const extra = (scenario.options.identifierFields ?? []).map(globToRegExp);
  const early = [];
  const unreadable = [];
  const found = /* @__PURE__ */ new Map();
  for (const hit of ctx.hits) {
    if (!isBeforeConsent(hit, ctx)) continue;
    if (!hit.idFields || !hit.fields) {
      unreadable.push(hit);
      continue;
    }
    const state = effectiveConsent(hit, ctx);
    let flagged = false;
    for (const [name, cls] of identifierClasses(hit.idFields, hit.fields, extra)) {
      const signal = identifierSignal(cls, state);
      if (signal.value !== "unknown") continue;
      flagged = true;
      const key = `${hit.vendor}\0${signal.field}`;
      found.set(key, (found.get(key) ?? /* @__PURE__ */ new Set()).add(name));
    }
    if (flagged) early.push(hit);
    else if (hit.fieldsComplete === false) unreadable.push(hit);
  }
  const hitsWord = (n) => `hit${n === 1 ? "" : "s"}`;
  if (early.length > 0) {
    const groups = [...found].map(([key, names]) => {
      const [vendor, signal] = key.split("\0");
      return `${vendor} ${listNames([...names].sort())} (${signal} unknown)`;
    });
    const shown2 = groups.slice(0, MAX_LISTED).join(", ");
    const more = groups.length > MAX_LISTED ? `, and ${groups.length - MAX_LISTED} more` : "";
    const cut = unreadable.length > 0 ? ` ${unreadable.length} more ${hitsWord(unreadable.length)} could not be read.` : "";
    const unjudged = unjudgedIdentifiers(ctx);
    add2(
      "earlyIdentifiers",
      false,
      [...early.map((h) => h.id), ...unjudged.map((h) => h.id)],
      `${early.length} ${hitsWord(early.length)} ${early.length === 1 ? "carries" : "carry"} identifiers before the consent answer: ${shown2}${more}.${cut}${unjudged.length > 0 ? ` ${cannotJudgeUnlinked(unjudged, "before the consent answer").message}` : ""}`
    );
  } else if (unreadable.length > 0) {
    const unjudged = unjudgedIdentifiers(ctx);
    const notRecorded = unreadable.some((h) => !h.idFields || !h.fields);
    add2(
      "earlyIdentifiers",
      false,
      [...unreadable.map((h) => h.id), ...unjudged.map((h) => h.id)],
      `${notRecorded ? NOT_RECORDED : BODY_CUT}: ${unreadable.length} ${hitsWord(unreadable.length)} sent before the consent answer.${unjudged.length > 0 ? ` ${cannotJudgeUnlinked(unjudged, "before the consent answer").message}` : ""}`,
      notRecorded ? "fieldsNotRecorded" : "cannotEvaluateBody"
    );
  } else if (unjudgedIdentifiers(ctx).length > 0) {
    const unjudged = unjudgedIdentifiers(ctx);
    const { evidence, message } = cannotJudgeUnlinked(unjudged, "before the consent answer");
    add2("earlyIdentifiers", false, evidence, message, "serverSendUnlinked");
  } else {
    add2("earlyIdentifiers", true, [], "Expected no identifiers on hits sent before the consent answer, found none.");
  }
}
function identityOf(run) {
  const id = run?.identity;
  if (!id) return void 0;
  const fields2 = ["firstName", "lastName", "email", "phone", "address1", "city", "zip", "country"];
  const values = id;
  return fields2.every((f) => typeof values[f] === "string") ? id : void 0;
}
function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}
var ASSET_TYPES = /* @__PURE__ */ new Set(["image", "script", "stylesheet", "font", "media"]);
var HASH_FILE_SEGMENT = /\/[0-9a-f]{64}\.[a-z0-9]{1,5}(?=$|\/)/gi;
var NAMED_HASH_IN_SEGMENT = /(?<=\/[^/=;]+[-_.])[0-9a-f]{64}(?=\.[a-z0-9]{1,8}(?:$|\/))/gi;
var NAMED_HASH_NOT_GIF = /(?<=\/[^/=;]+[-_.])[0-9a-f]{64}(?=\.(?!gif(?:$|\/))[a-z0-9]{1,8}(?:$|\/))/gi;
var NAMED_HASH_TYPES = /* @__PURE__ */ new Set(["script", "stylesheet", "font", "media", "fetch", "xhr"]);
var HEX64 = /^[0-9a-f]{64}$/i;
var isObject3 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function blankOperation(op) {
  if (!isObject3(op)) return;
  for (const key of Object.keys(op)) {
    if (/^(?:id|sha256hash)$/i.test(key) && typeof op[key] === "string" && HEX64.test(op[key])) op[key] = "";
  }
  const extensions = typeof op.extensions === "string" ? parseJson(op.extensions) : op.extensions;
  if (isObject3(extensions) && isObject3(extensions.persistedQuery)) {
    const pq = extensions.persistedQuery;
    if (typeof pq.sha256Hash === "string" && HEX64.test(pq.sha256Hash)) pq.sha256Hash = "";
    if (typeof op.extensions === "string") op.extensions = JSON.stringify(extensions);
  }
}
function parseJson(text2) {
  try {
    return JSON.parse(text2);
  } catch {
    return void 0;
  }
}
function blankedJson(text2) {
  const parsed = parseJson(text2);
  if (parsed === void 0 || typeof parsed !== "object" || parsed === null) return text2;
  for (const op of Array.isArray(parsed) ? parsed : [parsed]) blankOperation(op);
  return JSON.stringify(parsed);
}
function blankedExtensions(text2) {
  const parsed = parseJson(text2);
  if (parsed === void 0) return text2;
  const wrapper = { extensions: parsed };
  blankOperation(wrapper);
  return JSON.stringify(wrapper.extensions);
}
function blankedParams(params) {
  const out = new URLSearchParams();
  const blanked = /* @__PURE__ */ new Set();
  for (const [key, value] of params) {
    const name = key.toLowerCase();
    if ((name === "id" || name === "sha256hash") && HEX64.test(value) && !blanked.has(name)) {
      blanked.add(name);
      out.append(key, "");
    } else if (key === "extensions") out.append(key, blankedExtensions(value));
    else out.append(key, value);
  }
  return out;
}
function withoutPersistedQueryIds(url, postData) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { url, postData };
  }
  if (!/\/graphql/i.test(parsed.pathname)) return { url, postData };
  if (!/persisted/i.test(parsed.pathname) && !/persistedQuery/.test(parsed.search + postData)) return { url, postData };
  parsed.search = blankedParams(parsed.searchParams).toString();
  let body = postData;
  if (/^\s*[[{]/.test(postData)) body = blankedJson(postData);
  else if (postData.includes("=")) body = blankedParams(new URLSearchParams(postData)).toString();
  return { url: parsed.href, postData: body };
}
function scannedUrl(request, url, isHit) {
  try {
    const parsed = new URL(url);
    if (!isHit) {
      if (NAMED_HASH_TYPES.has(request.resourceType)) parsed.pathname = parsed.pathname.replace(NAMED_HASH_IN_SEGMENT, "");
      else if (request.resourceType === "image") parsed.pathname = parsed.pathname.replace(NAMED_HASH_NOT_GIF, "");
    }
    if (ASSET_TYPES.has(request.resourceType)) parsed.pathname = parsed.pathname.replace(HASH_FILE_SEGMENT, "/");
    return parsed.href;
  } catch {
    return url;
  }
}
function pathSegments(url) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return [];
  }
}
var BINARY_CONTENT_TYPE = /^(?:application\/(?:octet-stream|gzip|x-gzip|zip|zlib|x-protobuf|protobuf|grpc|msgpack|x-msgpack)|image\/(?!svg\+xml)[^;\s]+|audio\/[^;\s]+|video\/[^;\s]+)\s*(?:;|$)/i;
var BINARY_SHARE = 0.1;
var BINARY_MIN_LENGTH = 16;
function headersSayBinary(headers) {
  const header = (name) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1]?.trim().toLowerCase() ?? "";
  const encoding = header("content-encoding");
  if (encoding !== "" && encoding !== "identity") return true;
  return BINARY_CONTENT_TYPE.test(header("content-type"));
}
function isBinaryBody(headers, body) {
  if (headersSayBinary(headers)) return true;
  return isBinaryText(body);
}
function isBinaryText(body) {
  if (body.length < BINARY_MIN_LENGTH) return false;
  return binaryShare(body) >= BINARY_SHARE;
}
function leafTexts(text2) {
  const out = [];
  const isJson = /^\s*[{[]/.test(text2);
  if (!isJson) {
    for (const segment of text2.split("&")) {
      const eq = segment.indexOf("=");
      if (eq < 0 || eq === segment.length - 1) continue;
      const rawName = segment.slice(0, eq).replace(/\[\]|%5B%5D/gi, "");
      const [decoded] = new URLSearchParams(segment).keys();
      out.push({ text: `${rawName}${segment.slice(eq)}`, where: decoded ? guardFieldName(decoded) : "the body", leaf: true });
    }
    return out;
  }
  const { entries, parsed } = bodyEntries({ postData: text2 });
  if (parsed) {
    for (const { name, value } of entries) {
      const path = name.split(".");
      path[path.length - 1] = path[path.length - 1].replace(/\[\]/g, "");
      const where2 = guardFieldName(name);
      if (path.length > 1) out.push({ text: path.slice(0, -1).join("."), where: where2, leaf: true, name: true });
      out.push({ text: `${path[path.length - 1]}=${value}`, where: where2, leaf: true });
    }
  }
  return out;
}
function withoutBinaryParts(split, wholeIsBinary) {
  const cut = (part) => wholeIsBinary && isBinaryBody(part.headers, part.body);
  return split.chunks.map(({ raw, part }) => part && cut(part) ? raw.slice(0, part.bodyStart) : raw).join(`--${split.boundary}`);
}
function withoutBinaryLines(body) {
  if (!isBinaryText(body)) return body;
  return body.split(/(?<=\n)/).filter((line) => !isBinaryText(line.replace(/\r?\n$/, ""))).join("");
}
function bodyTexts(headers, body) {
  if (body === "" || headersSayBinary(headers)) return [];
  const split = splitMultipart(body, headers);
  if (split?.parts.length) {
    const wholeIsBinary = isBinaryText(body);
    const named = split.parts.flatMap((part) => {
      const name = multipartPartName(part);
      if (wholeIsBinary && isBinaryBody(part.headers, part.body)) return [];
      return name === void 0 ? leafTexts(part.body) : [{ text: `${name}=${part.body}`, where: guardFieldName(name), leaf: true }];
    });
    return [{ text: withoutBinaryParts(split, wholeIsBinary), where: "the body" }, ...named];
  }
  const isJson = /^\s*[{[]/.test(body) && bodyEntries({ postData: body }).parsed;
  if (!isJson && /[\r\n]/.test(body.trim())) {
    const lines = body.split(/\r?\n/).filter((line) => line.trim() !== "" && !isBinaryText(line));
    return [{ text: withoutBinaryLines(body), where: "the body" }, ...lines.flatMap(leafTexts)];
  }
  return isBinaryText(body) ? [] : [{ text: body, where: "the body" }, ...leafTexts(body)];
}
function isEdgeShift(a, b, bodies) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!long.includes(short)) return false;
  return bodies.every((raw) => {
    const text2 = raw.replace(/\[\]|%5B%5D/gi, "");
    const covered = [];
    for (let i = text2.indexOf(long); i >= 0; i = text2.indexOf(long, i + 1)) covered.push([i, i + long.length]);
    for (let i = text2.indexOf(short); i >= 0; i = text2.indexOf(short, i + 1)) {
      if (!covered.some(([from, to]) => i >= from && i + short.length <= to)) return false;
    }
    return true;
  });
}
function mergeEdgeReadings(found, bodies) {
  const best = (f) => Math.min(...f.where.values());
  const valueOf2 = (key, kind) => key.slice(kind.length + 1);
  const fields2 = [...found].filter(([, f]) => best(f) < 2);
  for (const [key, f] of [...found]) {
    if (best(f) < 2 || [...f.where.keys()].some((w) => w !== "the body")) continue;
    const value = valueOf2(key, f.kind);
    const twin = fields2.find(([k, other]) => other.kind === f.kind && isEdgeShift(valueOf2(k, other.kind), value, bodies));
    if (!twin) continue;
    for (const [w, tier] of f.where) twin[1].where.set(w, Math.min(tier, twin[1].where.get(w) ?? tier));
    found.delete(key);
  }
}
function findForeignData(requests, hits, identity) {
  const byRequest = /* @__PURE__ */ new Map();
  const slot = (key, stepId) => {
    let entry = byRequest.get(key);
    if (!entry) byRequest.set(key, entry = { texts: [], hitIds: [], stepId });
    return entry;
  };
  const hitRequests = new Set(hits.map((h) => h.requestId));
  for (const request of requests) {
    if (request.resourceType === "script" && isLibraryLoadPath(pathOf(request.url))) continue;
    const persisted = withoutPersistedQueryIds(request.url, request.postData ?? "");
    const url = scannedUrl(request, persisted.url, hitRequests.has(request.id));
    const texts = slot(request.id, request.stepId).texts;
    for (const text2 of [url, ...pathSegments(url)]) texts.push({ text: text2, where: "the URL" });
    for (const text2 of bodyTexts(request.headers, persisted.postData)) texts.push(text2);
  }
  for (const hit of hits) {
    const entry = slot(hit.requestId, hit.stepId);
    entry.hitIds.push(hit.id);
    for (const [key, value] of Object.entries(hit.params)) entry.texts.push({ text: `${key}=${value}`, where: guardFieldName(key) });
  }
  const stableHashes = findStableHashes(
    [...byRequest].flatMap(([requestId, entry]) => entry.texts.map(({ text: text2 }) => ({ requestId, text: text2 })))
  );
  const out = [];
  for (const [requestId, entry] of byRequest) {
    const found = /* @__PURE__ */ new Map();
    for (const { text: text2, where: where2, leaf, name } of entry.texts) {
      const tier = where2 === "the URL" || where2 === "the body" ? 2 : leaf ? 1 : 0;
      for (const m of scan(text2, identity, { stableHashes })) {
        if (name && m.kind === "phone") continue;
        const key = `${m.kind}:${m.value}`;
        const seen = found.get(key) ?? { kind: m.kind, where: /* @__PURE__ */ new Map() };
        seen.where.set(where2, Math.min(tier, seen.where.get(where2) ?? tier));
        found.set(key, seen);
      }
    }
    if (found.size === 0) continue;
    mergeEdgeReadings(
      found,
      entry.texts.filter((t) => t.where === "the body" && !t.leaf).map((t) => t.text)
    );
    const kinds = [...new Set([...found.values()].map((f) => f.kind))].join(", ");
    const places = /* @__PURE__ */ new Set();
    for (const { where: where2 } of found.values()) {
      const best = Math.min(...where2.values());
      for (const [w, tier] of where2) if (tier === best) places.add(w);
    }
    const shown2 = [...places].sort();
    const in_ = shown2.length > 5 ? `${shown2.slice(0, 5).join(", ")} and ${shown2.length - 5} more` : shown2.join(", ");
    const step = entry.stepId ? ` in step ${entry.stepId}` : "";
    out.push({
      requestId,
      detail: `request ${requestId}${step} carries ${found.size} ${kinds} value(s) that are not from the run identity, in ${in_}`,
      evidence: [requestId, ...entry.hitIds, ...entry.stepId ? [entry.stepId] : []]
    });
  }
  return out;
}

// packages/expect/src/diff.ts
var NO_EPOCH = "none";
var SERVER_UNLINKED = "server";
function diffRuns(a, b, options = {}) {
  const result = { warnings: [], added: [], removed: [], changed: [], countMismatches: [], flags: [] };
  const versionA = a.run.recordSchemaVersion ?? 0;
  const versionB = b.run.recordSchemaVersion ?? 0;
  if (versionA !== versionB) {
    result.warnings.push(
      `The runs have different record schema versions (${versionA} and ${versionB}). The diff may show changes that are only differences in the record shape.`
    );
  }
  const stepsA = stepLabels(a);
  const stepsB = stepLabels(b);
  const groupsA = groupHits(a, options);
  const groupsB = groupHits(b, options);
  const ids = [.../* @__PURE__ */ new Set([...groupsA.keys(), ...groupsB.keys()])].sort();
  for (const id of ids) {
    const ga = groupsA.get(id);
    const gb = groupsB.get(id);
    const key = (ga ?? gb).key;
    const hitsA = ga?.hits ?? [];
    const hitsB = gb?.hits ?? [];
    if (hitsA.length !== hitsB.length) result.countMismatches.push({ key, a: hitsA.length, b: hitsB.length });
    const paired = Math.min(hitsA.length, hitsB.length);
    for (let i = 0; i < paired; i++) {
      const ha = hitsA[i];
      const hb = hitsB[i];
      const consent = consentChanges(ha, hb);
      const idChanges = idPresenceChanges(ha.ids, hb.ids);
      if (consent.length || idChanges.length) {
        result.changed.push({ key, a: ref(ha, stepsA), b: ref(hb, stepsB), consent, ids: idChanges });
      }
    }
    for (const h of hitsA.slice(paired)) result.removed.push({ key, ...ref(h, stepsA) });
    for (const h of hitsB.slice(paired)) result.added.push({ key, ...ref(h, stepsB) });
  }
  result.flags = flagChanges(a, b);
  return result;
}
function hitShape(run, options = {}) {
  const out = [];
  const groups = groupHits(run, options);
  for (const id of [...groups.keys()].sort()) {
    const group = groups.get(id);
    const tuples = /* @__PURE__ */ new Map();
    for (const hit of group.hits) {
      const fields2 = shapeFields(hit);
      const tupleId2 = JSON.stringify(fields2);
      const tuple = tuples.get(tupleId2) ?? { ...fields2, count: 0 };
      tuple.count += 1;
      tuples.set(tupleId2, tuple);
    }
    out.push({ key: group.key, tuples: [...tuples].sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0).map(([, t]) => t) });
  }
  return out;
}
function shapeFields(hit) {
  const consent = {};
  for (const f of consentFields) consent[f] = hit.consent[f];
  for (const f of ["gcs", "gcd"]) consent[f] = hit.consent.raw[f] ?? "";
  const ids = [...idPresence(hit.ids)].filter(([, present]) => present).map(([name]) => name).sort();
  return { consent, ids };
}
var keyId = (k) => JSON.stringify([k.epoch, k.vendor, k.event, k.page ?? null]);
var groupId = (k) => JSON.stringify([k.vendor, k.event, k.page ?? null]);
var tupleId = (t) => JSON.stringify([Object.entries(t.consent).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0), t.ids]);
var total = (k) => (k?.tuples ?? []).reduce((n, t) => n + t.count, 0);
function tupleCounts(k) {
  const out = /* @__PURE__ */ new Map();
  for (const t of k?.tuples ?? []) out.set(tupleId(t), (out.get(tupleId(t)) ?? 0) + t.count);
  return out;
}
function contains(big, small) {
  for (const [id, n] of small) if ((big.get(id) ?? 0) < n) return false;
  return true;
}
function surplusByIds(k, other) {
  const out = /* @__PURE__ */ new Map();
  const rest = tupleCounts(other);
  for (const t of k?.tuples ?? []) {
    const id = tupleId(t);
    const used = Math.min(rest.get(id) ?? 0, t.count);
    rest.set(id, (rest.get(id) ?? 0) - used);
    const extra = t.count - used;
    if (extra > 0) out.set(JSON.stringify(t.ids), (out.get(JSON.stringify(t.ids)) ?? 0) + extra);
  }
  return out;
}
function sameCounts(x, y) {
  return x.size === y.size && contains(x, y) && contains(y, x);
}
function findMove(epochs, order) {
  const changed = [...epochs].filter(([, e]) => total(e.a) !== total(e.b));
  if (changed.length !== 2) return void 0;
  const [[e1, v1], [e2, v2]] = changed;
  const d1 = total(v1.b) - total(v1.a);
  if (d1 + total(v2.b) - total(v2.a) !== 0) return void 0;
  const [from, to] = d1 < 0 ? [[e1, v1], [e2, v2]] : [[e2, v2], [e1, v1]];
  const i = order.indexOf(from[0]);
  const j = order.indexOf(to[0]);
  if (i < 0 || j < 0 || Math.abs(i - j) !== 1) return void 0;
  if (order.filter((l) => l === from[0] || l === to[0]).length !== 2) return void 0;
  if (!contains(tupleCounts(from[1].a), tupleCounts(from[1].b))) return void 0;
  if (!contains(tupleCounts(to[1].b), tupleCounts(to[1].a))) return void 0;
  if (!sameCounts(surplusByIds(from[1].a, from[1].b), surplusByIds(to[1].b, to[1].a))) return void 0;
  return { from: from[0], to: to[0], count: Math.abs(d1) };
}
function diffShapes(a, b, options = {}) {
  const result = { added: [], removed: [], countChanges: [], moved: [], drift: false };
  const ia = new Map(a.map((k) => [keyId(k.key), k]));
  const ib = new Map(b.map((k) => [keyId(k.key), k]));
  const groups = /* @__PURE__ */ new Map();
  for (const [side, index] of [["a", ia], ["b", ib]]) {
    for (const k of index.values()) {
      const epochs = groups.get(groupId(k.key)) ?? /* @__PURE__ */ new Map();
      epochs.set(k.key.epoch, { ...epochs.get(k.key.epoch), [side]: k });
      groups.set(groupId(k.key), epochs);
    }
  }
  const skipped = /* @__PURE__ */ new Set();
  for (const epochs of groups.values()) {
    const move = findMove(epochs, options.epochOrder ?? []);
    if (!move) continue;
    const key = (epochs.get(move.from).a ?? epochs.get(move.from).b).key;
    result.moved.push({ vendor: key.vendor, event: key.event, ...key.page === void 0 ? {} : { page: key.page }, ...move });
    for (const label of [move.from, move.to]) skipped.add(keyId({ ...key, epoch: label }));
  }
  for (const id of [.../* @__PURE__ */ new Set([...ia.keys(), ...ib.keys()])].sort()) {
    if (skipped.has(id)) continue;
    const ka = ia.get(id);
    const kb = ib.get(id);
    const key = (ka ?? kb).key;
    const ta = new Map((ka?.tuples ?? []).map((t) => [tupleId(t), t]));
    const tb = new Map((kb?.tuples ?? []).map((t) => [tupleId(t), t]));
    for (const [tid, t] of tb) {
      const before = ta.get(tid);
      if (!before) result.added.push({ key, consent: t.consent, ids: t.ids, wholeKey: !ka });
      else if (before.count !== t.count) result.countChanges.push({ key, consent: t.consent, ids: t.ids, a: before.count, b: t.count });
    }
    for (const [tid, t] of ta) {
      if (!tb.has(tid)) result.removed.push({ key, consent: t.consent, ids: t.ids, wholeKey: !kb });
    }
  }
  result.drift = result.added.length > 0 || result.removed.length > 0;
  return result;
}
function ref(h, steps) {
  return { hitId: h.id, t: h.t, step: h.stepId ? steps.get(h.stepId) ?? "" : "", page: h.page };
}
function stepLabels(run) {
  return new Map(run.steps.map((s) => [s.id, s.label]));
}
function groupHits(run, options) {
  const epochs = [...run.consentEpochs].sort((x, y) => x.startT - y.startT);
  const frames = new Map(run.requests.map((r) => [r.id, r.frameUrl]));
  const index = judgeIndex(run.hits, run.requests);
  const placedAt = new Map(run.hits.map((h) => [h, judgedAt(h, index)]));
  const groups = /* @__PURE__ */ new Map();
  for (const hit of [...run.hits].sort((x, y) => (placedAt.get(x) ?? Infinity) - (placedAt.get(y) ?? Infinity) || x.t - y.t)) {
    const at = placedAt.get(hit);
    const key = {
      epoch: at === void 0 ? SERVER_UNLINKED : epochForHit(epochs, at)?.label ?? NO_EPOCH,
      vendor: hit.vendor,
      event: hit.event ?? ""
    };
    if (options.byPage) key.page = pagePath(hit.page ?? frames.get(hit.requestId) ?? null);
    const id = JSON.stringify(key);
    const group = groups.get(id) ?? { key, hits: [] };
    group.hits.push(hit);
    groups.set(id, group);
  }
  return groups;
}
function pagePath(page2) {
  if (page2 === null) return "";
  let path;
  try {
    path = stripSandboxPrefix(new URL(page2).pathname);
  } catch {
    path = stripSandboxPrefix(page2);
  }
  return maskValuePath(path, "*");
}
function consentChanges(a, b) {
  const changes = [];
  for (const f of consentFields) {
    if (a.consent[f] !== b.consent[f]) changes.push({ field: f, a: a.consent[f], b: b.consent[f] });
  }
  for (const f of ["gcs", "gcd"]) {
    const va = a.consent.raw[f];
    const vb = b.consent.raw[f];
    if (va !== vb) changes.push({ field: f, a: va ?? "", b: vb ?? "" });
  }
  return changes;
}
function idPresence(ids) {
  const out = /* @__PURE__ */ new Map();
  for (const [name, value] of Object.entries(ids)) {
    if (typeof value === "boolean") out.set(name, value);
    else if (name === "hashes" && value) {
      for (const [hash, h] of Object.entries(value)) out.set(`hashes.${hash}`, h.present);
    }
  }
  return out;
}
function idPresenceChanges(a, b) {
  const pa = idPresence(a);
  const pb = idPresence(b);
  const names = [.../* @__PURE__ */ new Set([...pa.keys(), ...pb.keys()])].sort();
  const changes = [];
  for (const name of names) {
    const va = pa.get(name) ?? false;
    const vb = pb.get(name) ?? false;
    if (va !== vb) changes.push({ field: name, a: va ? "present" : "absent", b: vb ? "present" : "absent" });
  }
  return changes;
}
function hostOf2(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
function allowedFlagIds(run) {
  const platform = run.flags.filter((f) => f.kind === "platformHost").map((f) => f.id);
  const check = run.results.find((r) => r.expectation === "builtin: unknownDestination");
  if (!check) return new Set(platform);
  const unknown = run.flags.filter((f) => f.kind === "unknownDestination").map((f) => f.id);
  const blocked = new Set(check.pass ? [] : check.evidence);
  return /* @__PURE__ */ new Set([...platform, ...unknown.filter((id) => !blocked.has(id))]);
}
function flagCounts(run) {
  const requestHosts = new Map(run.requests.map((r) => [r.id, hostOf2(r.url)]));
  const hitHosts = new Map(run.hits.map((h) => [h.id, requestHosts.get(h.requestId) ?? ""]));
  const allowedIds = allowedFlagIds(run);
  const counts = /* @__PURE__ */ new Map();
  for (const flag2 of run.flags) {
    const host = flag2.recordIds.map((id) => requestHosts.get(id) ?? hitHosts.get(id)).find((h) => h) ?? "";
    const key = JSON.stringify([host, flag2.kind]);
    const count = counts.get(key) ?? { n: 0, allowed: true };
    count.n += 1;
    count.allowed &&= allowedIds.has(flag2.id);
    counts.set(key, count);
  }
  return counts;
}
function flagChanges(a, b) {
  const ca = flagCounts(a);
  const cb = flagCounts(b);
  const changes = [];
  for (const key of [.../* @__PURE__ */ new Set([...ca.keys(), ...cb.keys()])].sort()) {
    const na = ca.get(key);
    const nb = cb.get(key);
    if ((na?.n ?? 0) === (nb?.n ?? 0)) continue;
    const [host, kind] = JSON.parse(key);
    const allowed = (!na || na.allowed) && (!nb || nb.allowed);
    changes.push({ host, kind, a: na?.n ?? 0, b: nb?.n ?? 0, allowed });
  }
  return changes;
}

// packages/expect/src/project-config.ts
import { LineCounter as LineCounter2, isAlias, isMap as isYamlMap, isPair, isScalar, parseDocument as parseDocument2, visit } from "yaml";
var configSchemaVersion = 1;
var ProjectConfigError = class extends Error {
  /** One per problem. Each names the file, the line and the key, never a value. */
  issues;
  constructor(issues) {
    super(issues.join("\n"));
    this.name = "ProjectConfigError";
    this.issues = issues;
  }
};
var CONFIG_KEYS = ["configSchemaVersion", "site", "out", "options"];
var CONFIG_OPTION_KEYS = ["allowUnknownDestination", "builtins", "firstPartyHosts", "platformHosts", "serverHosts", "unloadGapIgnore", "identifierFields"];
var REFUSED_KEYS = ["network", "serverContainer", "serverContainerConfig", "allowTestPayment", "gtmOverride"];
function isMap2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function validSite(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}
function parseProjectConfig(text2, file) {
  const lines = new LineCounter2();
  const doc = parseDocument2(text2, { lineCounter: lines, uniqueKeys: true, logLevel: "silent" });
  const issues = [];
  const lineAt = (node) => node?.range ? lines.linePos(node.range[0]).line : 1;
  const lineOf = (path) => {
    for (let n = path.length; n >= 0; n--) {
      const node = doc.getIn(path.slice(0, n), true);
      if (node?.range) return lineAt(node);
    }
    return 1;
  };
  const keyLine = (parent, key) => {
    const map = parent.length ? doc.getIn(parent, true) : doc.contents;
    if (isYamlMap(map)) {
      for (const pair of map.items) if (isPair(pair) && isScalar(pair.key) && pair.key.value === key) return lineAt(pair.key);
    }
    return lineOf(parent);
  };
  const report = (line, where2, message) => {
    issues.push(`${file}: line ${line}${where2 ? `, ${where2}` : ""}: ${message}`);
  };
  const fail = (path, message) => report(lineOf(path), path.join("."), message);
  for (const e of doc.errors) issues.push(`${file}: line ${e.linePos?.[0].line ?? 1}: not valid YAML`);
  if (issues.length) throw new ProjectConfigError(issues);
  const refuse = (node) => {
    report(lineAt(node), "", "anchors, aliases, tags and merge keys are not allowed in the project config");
    return visit.BREAK;
  };
  visit(doc, {
    Pair(_, pair) {
      const key = pair.key;
      if (!isScalar(key) || typeof key.value !== "string" || key.value === "<<") return refuse(isScalar(key) || isAlias(key) ? key : key);
    },
    Node(_, node) {
      if (isAlias(node) || node.anchor || node.tag) return refuse(node);
    }
  });
  if (issues.length) throw new ProjectConfigError(issues);
  let raw;
  try {
    raw = doc.toJS({ logLevel: "silent" });
  } catch {
    throw new ProjectConfigError([`${file}: line 1: not valid YAML`]);
  }
  if (!isMap2(raw)) throw new ProjectConfigError([`${file}: line 1: the project config must be a YAML mapping`]);
  const checkKeys = (map, parent, allowed) => {
    for (const key of Object.keys(map)) {
      const where2 = [...parent, key].join(".");
      if (REFUSED_KEYS.includes(key)) report(keyLine(parent, key), where2, "not allowed in the project config. Pass it on the command line.");
      else if (!allowed.includes(key)) report(keyLine(parent, key), where2, `unknown key, expected one of ${allowed.join(", ")}`);
    }
  };
  checkKeys(raw, [], CONFIG_KEYS);
  if (raw.configSchemaVersion === void 0) report(1, "configSchemaVersion", `required, ${configSchemaVersion}`);
  else if (raw.configSchemaVersion !== configSchemaVersion) fail(["configSchemaVersion"], `must be ${configSchemaVersion}`);
  const config = { options: {} };
  if (raw.site !== void 0) {
    if (validSite(raw.site)) config.site = raw.site;
    else fail(["site"], "must be an http or https URL with no user name or password");
  }
  if (raw.out !== void 0) {
    if (typeof raw.out === "string" && raw.out !== "") config.out = raw.out;
    else fail(["out"], "must be a folder path");
  }
  if (raw.options !== void 0) {
    if (isMap2(raw.options)) {
      checkKeys(raw.options, ["options"], CONFIG_OPTION_KEYS);
      const known = Object.fromEntries(Object.entries(raw.options).filter(([k]) => CONFIG_OPTION_KEYS.includes(k)));
      config.options = parseOptions(known, ["options"], fail, { keys: CONFIG_OPTION_KEYS, echo: false });
    } else fail(["options"], "must be a mapping");
  }
  if (issues.length) throw new ProjectConfigError(issues);
  return config;
}
function mergeOptions(config, scenario) {
  const merged = { ...config, ...scenario };
  if (config.builtins || scenario.builtins) merged.builtins = { ...config.builtins, ...scenario.builtins };
  return merged;
}

// packages/recorder/src/stub.ts
var GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
function corsHeaders(headers) {
  const out = {
    "access-control-allow-origin": headers.origin ?? "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "Origin"
  };
  const requested = headers["access-control-request-headers"];
  if (requested) out["access-control-allow-headers"] = requested;
  return out;
}
var CAPI_ANSWER = Buffer.from('{"events_received":1,"messages":[],"fbtrace_id":"pw-fixture"}');
function stubResponse(req) {
  const cors = corsHeaders(req.headers);
  if (req.url !== void 0 && isMetaCapiEndpoint({ url: req.url })) {
    return { status: 200, headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" }, body: CAPI_ANSWER };
  }
  switch (req.resourceType) {
    case "image":
      return { status: 200, headers: { ...cors, "content-type": "image/gif", "cache-control": "no-store" }, body: GIF };
    case "script":
      return { status: 200, headers: { ...cors, "content-type": "application/javascript", "cache-control": "no-store" }, body: Buffer.alloc(0) };
    case "document":
      return { status: 200, headers: { ...cors, "content-type": "text/html", "cache-control": "no-store" }, body: Buffer.alloc(0) };
    default:
      return { status: 204, headers: cors };
  }
}
var LOADS2 = /* @__PURE__ */ new Set(["script", "stylesheet", "font", "document"]);
var VENDOR_HOST = /(^|\.)(facebook\.com|facebook\.net|doubleclick\.net|googleadservices\.com|googlesyndication\.com|googletagmanager\.com)$|^(www\.)?google\.com$/;
var COLLECTION_PATH = /^\/(?:tr|pagead\/(?:viewthroughconversion|conversion|1p-[\w-]+)|rmkt|ccm|td)(?:\/|$)/;
var SITE_FUNCTION_PATH = /^\/(?:recaptcha|maps|plugins|dialog|login)(?:\/|$)/;
function isKnownVendorCollection(req) {
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return false;
  }
  if (!VENDOR_HOST.test(url.hostname)) return false;
  if (isLibraryLoadPath(url.pathname)) return false;
  if (COLLECTION_PATH.test(url.pathname)) return true;
  if (SITE_FUNCTION_PATH.test(url.pathname)) return false;
  return !LOADS2.has(req.resourceType);
}
var bareHost = (h) => h.replace(/^\[|\]$/g, "");
function isServerHostUrl(url, serverHosts) {
  try {
    return hostMatches4(bareHost(new URL(url).hostname), serverHosts.map(bareHost));
  } catch {
    return false;
  }
}
function isServerContainerRequest(req, serverHosts) {
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol) || !isServerHostUrl(req.url, serverHosts)) return false;
  return !isLibraryLoadPath(url.pathname) && !LOADS2.has(req.resourceType);
}
function isStubbedCollection(req, options) {
  if (!isCollectionEndpoint(req, options.trackers) && !isKnownVendorCollection(req)) return false;
  if (options.networkMode !== "server") return true;
  return !isServerHostUrl(req.url, options.serverHosts ?? []);
}
function setCookieNamesOf(headers) {
  return Object.entries(headers).filter(([name]) => name.toLowerCase() === "set-cookie").flatMap(([, value]) => value.split("\n")).flatMap((c) => setCookieNameOf(c));
}
function setCookieNameOf(line) {
  const pair = line.split(";")[0];
  const eq = pair.indexOf("=");
  const name = eq > 0 ? pair.slice(0, eq).trim() : "";
  return name ? [name] : [];
}

// packages/recorder/src/collector.ts
var MAX_BODY_BYTES = 64 * 1024;
var MAX_SOURCE_LENGTH = 64;
function parseCollectorBody(body) {
  if (!body) return { ok: false, error: "empty body" };
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return { ok: false, error: `body over ${MAX_BODY_BYTES} bytes` };
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: "body is not JSON" };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const payload = json;
  const source = payload.source;
  if (typeof source !== "string" || source === "" || source.length > MAX_SOURCE_LENGTH) {
    return { ok: false, error: `"source" must be a string of 1 to ${MAX_SOURCE_LENGTH} characters` };
  }
  return { ok: true, source, payload };
}
function parseCollectorRequest(method, url, body) {
  if (method === "POST") return { parsed: parseCollectorBody(body), body: body ?? "" };
  return { parsed: { ok: false, error: `${method} request, reports must be POST` }, body: url };
}
async function routeCollector(context, handler, now) {
  await context.route(`${COLLECTOR_ORIGIN}/**`, async (route) => {
    const request = route.request();
    if (request.method() !== "OPTIONS") {
      const { parsed, body } = parseCollectorRequest(request.method(), request.url(), request.postData());
      handler()(parsed, body, now());
    }
    await route.fulfill({ status: 204, headers: corsHeaders(request.headers()) });
  });
}

// packages/recorder/src/datalayer.ts
var DATALAYER_BINDING = "__tagreeveDataLayer";
var dataLayerInitScript = `(() => {
  const binding = ${JSON.stringify(DATALAYER_BINDING)};
  const MAX = 10000;
  const clock = () => performance.timeOrigin + performance.now();
  const plain = (k, v) => (typeof v === 'function' || v instanceof Node ? undefined : v);
  // Keeps the top levels, so the event name and ids survive a large push. Deeper values become a marker.
  const shrink = (value, depth, max) => {
    if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) : value;
    if (typeof value !== 'object' || value === null || value instanceof Node) return value;
    if (depth >= max) return '[truncated]';
    if (Array.isArray(value)) return value.map((item) => shrink(item, depth + 1, max));
    const out = {};
    for (const key of Object.keys(value)) out[key] = shrink(value[key], depth + 1, max);
    return out;
  };
  const safe = (args) => {
    try {
      const text = JSON.stringify(args, plain);
      if (text.length <= MAX) return text;
      for (const max of [6, 4, 3, 2]) {
        const smaller = JSON.stringify(shrink(args, 0, max), plain);
        if (smaller.length <= MAX) return smaller;
      }
      return JSON.stringify(['[truncated]']);
    } catch {
      return JSON.stringify(['[unserializable]']);
    }
  };
  const report = (item) => {
    const isArgs = Object.prototype.toString.call(item) === '[object Arguments]';
    const send = window[binding];
    if (typeof send !== 'function') return;
    send({ t: clock(), args: safe(isArgs ? Array.from(item) : [item]) }).catch(() => {});
  };
  const hook = (layer) => {
    if (!Array.isArray(layer) || layer.__tagreeveHooked) return;
    Object.defineProperty(layer, '__tagreeveHooked', { value: true });
    const push = layer.push;
    layer.push = function (...items) {
      for (const item of items) report(item);
      return push.apply(this, items);
    };
    for (const item of layer) report(item);
  };
  let current = window.dataLayer;
  hook(current);
  Object.defineProperty(window, 'dataLayer', {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (value) => {
      current = value;
      hook(value);
    },
  });
})();`;
function isConsentCommand(args) {
  return args[0] === "consent" && (args[1] === "default" || args[1] === "update");
}
function eventName(args) {
  if (args[0] === "event" && typeof args[1] === "string") return args[1];
  const first = args[0];
  if (typeof first === "object" && first !== null && !Array.isArray(first)) {
    const name = first.event;
    return typeof name === "string" ? name : null;
  }
  return null;
}
function uniqueEventId(args) {
  const first = args[0];
  if (typeof first !== "object" || first === null) return null;
  const id = first["gtm.uniqueEventId"];
  return typeof id === "number" ? id : null;
}
function dataLayerEventFromPayload(payload, runId, offset, frame) {
  let args;
  try {
    args = JSON.parse(payload.args);
  } catch {
    return void 0;
  }
  if (!Array.isArray(args) || typeof payload.t !== "number") return void 0;
  const t = pageTimeToEpoch(payload.t, offset);
  return {
    type: "dataLayerEvent",
    id: newId("dataLayerEvent"),
    runId,
    stepId: null,
    t,
    event: eventName(args),
    gtmUniqueEventId: uniqueEventId(args),
    args,
    isConsentCommand: isConsentCommand(args),
    frame: { main: frame.main, n: frame.n }
  };
}

// packages/recorder/src/flags.ts
import { getDomain } from "tldts";
var ALWAYS_DATA = /* @__PURE__ */ new Set(["fetch", "xhr", "ping", "beacon"]);
var DATA_WITH_PAYLOAD = /* @__PURE__ */ new Set(["image", "other"]);
function parse(url) {
  try {
    return new URL(url);
  } catch {
    return void 0;
  }
}
function isFirstPartyHost(host, { siteHost, firstPartyHosts = [] }) {
  if (host === siteHost || hostMatches4(host, firstPartyHosts)) return true;
  const domain = getDomain(siteHost, { allowPrivateDomains: true });
  return domain !== null && getDomain(host, { allowPrivateDomains: true }) === domain;
}
function undecodedDataHost(req, trackers) {
  const url = parse(req.url);
  if (!url || !/^https?:$/.test(url.protocol)) return void 0;
  if (decoders.some((d) => d.match(req)) || isCollectionEndpoint(req, trackers) || isKnownVendorCollection(req)) return void 0;
  const carriesData2 = ALWAYS_DATA.has(req.resourceType) || DATA_WITH_PAYLOAD.has(req.resourceType) && (url.search.length > 1 || !!req.postData);
  return carriesData2 ? url.hostname : void 0;
}
function isUnknownDestination(req, scope, trackers = trackerList) {
  const host = undecodedDataHost(req, trackers);
  return host !== void 0 && !isFirstPartyHost(host, typeof scope === "string" ? { siteHost: scope } : scope);
}
function isFirstPartySubdomain(req, scope, trackers = trackerList) {
  const host = undecodedDataHost(req, trackers);
  return host !== void 0 && host !== scope.siteHost && isFirstPartyHost(host, scope);
}
function flag(runId, kind, recordIds, detail) {
  return { type: "flag", id: newId("flag"), runId, kind, recordIds, detail };
}
function buildFlags({ runId, networkMode, siteUrl, firstPartyHosts, trackers = trackerList, platformHosts: platformHosts2 = true, requests, hits, identity, routedRequestIds, responses = [], handedToChromium = /* @__PURE__ */ new Set(), redirectHeaderWithoutRedirect = /* @__PURE__ */ new Set() }) {
  const answered = new Set(responses.map((r) => r.requestId));
  const scope = { siteHost: parse(siteUrl)?.hostname ?? "", firstPartyHosts };
  const flags2 = [];
  for (const req of requests) {
    const fromContainer = req.captured === "serverContainer";
    const unknown = fromContainer ? undecodedDataHost(req, trackers) !== void 0 : isUnknownDestination(req, scope, trackers);
    if (unknown) {
      const kind = !fromContainer && platformHosts2 && platformHostFor(req) ? "platformHost" : "unknownDestination";
      flags2.push(flag(runId, kind, [req.id], `${fromContainer ? "from the server container: " : ""}${req.method} ${req.url}`));
    } else if (!fromContainer && isFirstPartySubdomain(req, scope, trackers)) {
      flags2.push(flag(runId, "firstPartySubdomain", [req.id], `${req.method} ${req.url}`));
    }
    if (!fromContainer && networkMode !== "live" && !routedRequestIds.has(req.id) && (isCollectionEndpoint(req, trackers) || isKnownVendorCollection(req))) {
      const why = req.initiator === "redirect" ? "It followed a redirect" : "It was not routed";
      flags2.push(flag(runId, "stubBypass", [req.id], `${why}, so it was not stubbed: ${req.url}`));
    }
    if (networkMode !== "live" && handedToChromium.has(req.id)) {
      const failedUnanswered = req.outcome === "failed" && req.failure === "net::ERR_FAILED" && !answered.has(req.id);
      if (failedUnanswered || redirectHeaderWithoutRedirect.has(req.id)) {
        const why = failedUnanswered ? "It failed with no response" : "Its response carries a Location header but is not a redirect";
        flags2.push(flag(runId, "possibleRedirectHop", [req.id], `${why}; Chromium may have followed a redirect that was not recorded and not stubbed: ${req.url}`));
      }
    }
  }
  for (const hit of hits) {
    if (isSandboxPageUrl(hit.page)) {
      flags2.push(flag(runId, "sandboxPageUrl", [hit.id, hit.requestId], `${hit.vendor} received ${hit.page} as the page`));
    }
  }
  if (identity) {
    for (const leak of findForeignData(requests, hits, identity)) flags2.push(flag(runId, "possibleRealData", leak.evidence, leak.detail));
  }
  return flags2;
}
var UNLOAD_GAP_WINDOW_MS = 1e4;
var UNLOAD_GAP_SLACK_MS = 1e3;
var GA4_EVENTS = /* @__PURE__ */ new Set([
  "add_payment_info",
  "add_shipping_info",
  "add_to_cart",
  "add_to_wishlist",
  "begin_checkout",
  "generate_lead",
  "login",
  "purchase",
  "refund",
  "remove_from_cart",
  "search",
  "select_content",
  "select_item",
  "select_promotion",
  "share",
  "sign_up",
  "view_cart",
  "view_item",
  "view_item_list",
  "view_promotion"
]);
var GA4_ALIASES = {
  product_added_to_cart: "add_to_cart",
  product_removed_from_cart: "remove_from_cart",
  product_viewed: "view_item",
  collection_viewed: "view_item_list",
  cart_viewed: "view_cart",
  checkout_started: "begin_checkout",
  payment_info_submitted: "add_payment_info",
  checkout_shipping_info_submitted: "add_shipping_info",
  checkout_completed: "purchase",
  search_submitted: "search"
};
function sameFrame(a, b) {
  if (!b) return false;
  if (a.id !== null && b.id !== null) return a.id === b.id;
  return a.url !== null && a.url === b.url;
}
function unloadGapAdvice(networkMode) {
  return networkMode === "live" ? "which is not captured without --net-log" : "which stub mode cannot capture. Add the name to options.unloadGapIgnore if the hit is not needed, or check it in a live run with --network live --net-log";
}
function buildUnloadGapFlags({ runId, networkMode, events, hits, navigations, runEnd, eventFrames, requestFrames, ignore = [] }) {
  const ignored = ignore.map(globToRegExp);
  const ga4Hits = hits.filter((h) => h.vendor === "ga4");
  const unloadPoints = runEnd === void 0 ? navigations : [...navigations, runEnd];
  const flags2 = [];
  for (const event of events) {
    const name = event.event;
    if (name === null || event.isConsentCommand || name.startsWith("gtm.") || ignored.some((re) => re.test(name))) continue;
    const navigation = unloadPoints.find((n) => n >= event.t);
    if (navigation === void 0 || navigation - event.t > UNLOAD_GAP_WINDOW_MS) continue;
    const expected = GA4_ALIASES[name] ?? name;
    const ga4Name = GA4_EVENTS.has(expected);
    const literalGa4Name = GA4_EVENTS.has(name);
    if (!literalGa4Name && !hits.some((h) => h.event === name)) continue;
    if (!literalGa4Name && ga4Hits.length === 0) continue;
    const covered = (h) => h.t >= event.t && h.t <= navigation + UNLOAD_GAP_SLACK_MS && h.event === name;
    if (ga4Hits.length === 0 && hits.some(covered)) continue;
    if (ga4Hits.some((h) => h.t >= event.t && h.t <= navigation + UNLOAD_GAP_SLACK_MS && h.event !== null && (h.event === name || h.event === expected || !ga4Name && GA4_EVENTS.has(h.event)))) continue;
    const eventFrame = eventFrames?.get(event.id);
    if (eventFrame !== void 0 && ga4Hits.some((h) => h.t >= event.t && h.t <= navigation + UNLOAD_GAP_SLACK_MS && sameFrame(eventFrame, requestFrames?.get(h.requestId)))) continue;
    const seconds = ((navigation - event.t) / 1e3).toFixed(1);
    const unload = navigation === runEnd && !navigations.includes(navigation) ? "the run ended" : "the page navigated";
    flags2.push(
      flag(
        runId,
        "unloadGap",
        [event.id],
        `A frame pushed "${name}" ${seconds} s before ${unload} and no ga4 hit for it was recorded after it. The frame may have sent the hit while unloading, ${unloadGapAdvice(networkMode)} (design \xA75.3).`
      )
    );
  }
  return flags2;
}

// packages/recorder/src/selftest.ts
import { randomUUID } from "node:crypto";
var RESEND_MS = 200;
var repeat = (send) => `${send} setInterval(() => { ${send} }, ${RESEND_MS});`;
var beacon = (source) => `navigator.sendBeacon('${COLLECTOR_ORIGIN}/report', JSON.stringify({ source: '${source}' }));`;
function selfTestPage(sources) {
  const iframeScript = `addEventListener('load', () => setTimeout(() => { ${repeat(beacon(sources.iframe))} }, 100));`;
  const workerScript = `const send = () => fetch('${COLLECTOR_ORIGIN}/report', { method: 'POST', mode: 'no-cors', body: JSON.stringify({ source: '${sources.dedicatedWorker}' }) }); send(); setInterval(send, ${RESEND_MS});`;
  return `<!doctype html><meta charset="utf-8"><title>Tagreeve self-test</title>
<script>
${repeat(beacon(sources.page))}
new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerScript)}], { type: 'text/javascript' })));
</script>
<iframe sandbox="allow-scripts" srcdoc="${`<script>${iframeScript}</script>`.replaceAll('"', "&quot;")}"></iframe>`;
}
async function runSelfTest(context, setCollectorHandler, timeoutMs = 1e4) {
  const sourcePrefix = `selftest:${randomUUID()}:`;
  const SOURCES = { page: `${sourcePrefix}page`, iframe: `${sourcePrefix}iframe`, dedicatedWorker: `${sourcePrefix}worker` };
  const seen = /* @__PURE__ */ new Set();
  let done = () => void 0;
  const allSeen = new Promise((resolve4) => done = resolve4);
  setCollectorHandler((parsed) => {
    if (parsed.ok) seen.add(parsed.source);
    if (Object.values(SOURCES).every((s) => seen.has(s))) done();
  });
  const route = (url) => url.origin === SELFTEST_ORIGIN;
  await context.route(route, (r) => r.fulfill({ status: 200, contentType: "text/html", body: selfTestPage(SOURCES) }));
  const page2 = await context.newPage();
  try {
    await page2.goto(`${SELFTEST_ORIGIN}/`);
    const timer = setTimeout(done, timeoutMs);
    await allSeen;
    clearTimeout(timer);
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const before = nodeNow();
      const pageTime = await page2.evaluate(pageNowExpression);
      samples.push({ before, page: pageTime, after: nodeNow() });
    }
    return {
      coverage: {
        page: seen.has(SOURCES.page),
        iframe: seen.has(SOURCES.iframe),
        dedicatedWorker: seen.has(SOURCES.dedicatedWorker),
        serviceWorker: "chromium-only"
      },
      clockOffset: bestPageOffset(samples),
      sourcePrefix
    };
  } finally {
    await page2.close();
    await context.unroute(route);
  }
}

// packages/recorder/src/recorder.ts
import { mkdtemp as mkdtemp2, readFile } from "node:fs/promises";
import { tmpdir as tmpdir3 } from "node:os";
import { join as join5 } from "node:path";

// packages/recorder/src/handoff-overlay.ts
import { randomUUID as randomUUID2 } from "node:crypto";
var HANDOFF_STATE_BINDING = "__pwHandoffState";
var HANDOFF_DONE_BINDING = "__pwHandoffDone";
var HANDOFF_HOST_ID = "tagreeve-handoff";
var HANDOFF_WAKE_EVENT = "tagreeve-handoff-wake";
var HANDOFF_REMINDER_MS = 6e4;
var HANDOFF_WAKE_LIMIT_MS = 2e3;
var HandoffGate = class {
  nonce = randomUUID2();
  text = null;
  finish = null;
  begin(text2) {
    this.text = text2;
    return new Promise((resolve4) => {
      this.finish = resolve4;
    });
  }
  end() {
    this.text = null;
    this.finish = null;
  }
  state() {
    return { waiting: this.text !== null, text: this.text ?? "" };
  }
  done(nonce) {
    if (typeof nonce !== "string" || nonce !== this.nonce || !this.finish) return false;
    this.finish();
    return true;
  }
};
async function boundedWake(wake, limitMs = HANDOFF_WAKE_LIMIT_MS) {
  let timer;
  const limit = new Promise((resolve4) => {
    timer = setTimeout(resolve4, limitMs);
  });
  try {
    await Promise.race([wake(), limit]);
  } catch {
  } finally {
    clearTimeout(timer);
  }
}
async function waitForHandoff(wait) {
  const abort = new AbortController();
  const timers = [];
  const after = (ms, value) => new Promise((resolve4) => {
    timers.push(setTimeout(() => resolve4(value), ms));
  });
  const reminder = setInterval(() => wait.print(`Still waiting for the handoff: ${wait.text}`), wait.reminderMs ?? HANDOFF_REMINDER_MS);
  const fromButton = wait.gate.begin(wait.text);
  try {
    if (wait.wake) void boundedWake(wait.wake);
    const person = [fromButton.then(() => "done"), wait.resolver(wait.text, abort.signal).then(() => "enter")];
    const matched = wait.until ? wait.until.then(() => "until", () => new Promise(() => {
    })) : void 0;
    const first = await Promise.race([
      ...person,
      ...matched ? [matched] : [],
      ...wait.timeoutMs === void 0 ? [] : [after(wait.timeoutMs, "timeout")]
    ]);
    if (first !== "until") return first;
    if (!wait.settleMs) return "until";
    return await Promise.race([...person, after(wait.settleMs, "until")]);
  } finally {
    clearInterval(reminder);
    for (const timer of timers) clearTimeout(timer);
    abort.abort();
    wait.gate.end();
  }
}
function handoffOverlayScript(nonce) {
  return `(() => {
  if (window.top !== window) return;
  const NONCE = ${JSON.stringify(nonce)};
  const HOST_ID = ${JSON.stringify(HANDOFF_HOST_ID)};
  const WAKE = ${JSON.stringify(HANDOFF_WAKE_EVENT)};
  const stateFn = window[${JSON.stringify(HANDOFF_STATE_BINDING)}];
  const doneFn = window[${JSON.stringify(HANDOFF_DONE_BINDING)}];
  if (typeof stateFn !== 'function' || typeof doneFn !== 'function') return;
  const IMPORTANT = {
    all: 'initial', position: 'fixed', right: '16px', bottom: '16px', left: 'auto', top: 'auto',
    display: 'block', visibility: 'visible', opacity: '1', 'pointer-events': 'auto',
    width: 'max-content', 'max-width': 'min(420px, calc(100vw - 32px))', height: 'auto', margin: '0', transform: 'none',
    'z-index': '2147483647',
  };
  const STOPPED = ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu', 'auxclick', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress'];
  let host = null;
  let label = null;
  let dropped = null;
  const toText = String;
  const uncurry = Function.prototype.bind.bind(Function.prototype.call);
  const addListener = uncurry(EventTarget.prototype.addEventListener);
  const getter = (proto, name) => Object.getOwnPropertyDescriptor(proto, name).get;
  const setter = (proto, name) => Object.getOwnPropertyDescriptor(proto, name).set;
  const setText = uncurry(setter(Node.prototype, 'textContent'));
  const setTitle = uncurry(setter(HTMLElement.prototype, 'title'));
  const getStyle = uncurry(getter(HTMLElement.prototype, 'style'));
  const setProp = uncurry(CSSStyleDeclaration.prototype.setProperty);
  const appendChild = uncurry(Element.prototype.append);
  const appendToRoot = uncurry(DocumentFragment.prototype.append);
  const removeNode = uncurry(Element.prototype.remove);
  const getRoot = uncurry(getter(Document.prototype, 'documentElement'));
  const getParent = uncurry(getter(Node.prototype, 'parentNode'));
  const getBox = uncurry(Element.prototype.getBoundingClientRect);
  const getTarget = uncurry(getter(Event.prototype, 'target'));
  const getX = uncurry(getter(MouseEvent.prototype, 'clientX'));
  const getY = uncurry(getter(MouseEvent.prototype, 'clientY'));
  const getPointerId = uncurry(getter(PointerEvent.prototype, 'pointerId'));
  const stopPropagation = uncurry(Event.prototype.stopPropagation);
  const capture = uncurry(Element.prototype.setPointerCapture);
  const trustedOf = uncurry(Object.getOwnPropertyDescriptor(new Event('x'), 'isTrusted').get);
  const trusted = (event) => { try { return trustedOf(event) === true; } catch { return false; } };
  const apply = (el, styles) => { const style = getStyle(el); for (const k in styles) setProp(style, k, styles[k], 'important'); };
  const build = () => {
    host = document.createElement('div');
    host.id = HOST_ID;
    apply(host, IMPORTANT);
    const root = host.attachShadow({ mode: 'closed' });
    const pill = document.createElement('div');
    label = document.createElement('span');
    const button = document.createElement('button');
    button.type = 'button';
    setText(button, 'Done');
    appendChild(pill, label, button);
    appendToRoot(root, pill);
    apply(pill, { display: 'flex', 'align-items': 'center', gap: '10px', padding: '6px 6px 6px 12px', background: '#1d2530', color: '#fff', font: '13px/1.3 system-ui, sans-serif', 'border-radius': '999px', 'box-sizing': 'border-box', 'max-width': '100%', 'box-shadow': '0 2px 10px rgba(0,0,0,.35)', cursor: 'grab', 'user-select': 'none', 'touch-action': 'none' });
    apply(label, { overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'max-width': '300px', 'min-width': '0' });
    apply(button, { all: 'unset', 'box-sizing': 'border-box', background: '#2f7d4f', color: '#fff', padding: '4px 14px', 'border-radius': '999px', 'font-weight': '600', cursor: 'pointer', 'flex-shrink': '0' });
    addListener(button, 'click', (event) => {
      if (!trusted(event)) return;
      Promise.resolve(doneFn(NONCE)).catch(() => {});
    });
    let grab = null;
    addListener(pill, 'pointerdown', (event) => {
      if (getTarget(event) === button) return;
      const box = getBox(host);
      grab = { dx: getX(event) - box.left, dy: getY(event) - box.top };
      capture(pill, getPointerId(event));
    });
    addListener(pill, 'pointermove', (event) => {
      if (!grab) return;
      const box = getBox(host);
      const left = Math.min(Math.max(0, getX(event) - grab.dx), Math.max(0, innerWidth - box.width));
      const top = Math.min(Math.max(0, getY(event) - grab.dy), Math.max(0, innerHeight - box.height));
      dropped = { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' };
      apply(host, dropped);
    });
    const release = () => { grab = null; };
    addListener(pill, 'pointerup', release);
    addListener(pill, 'pointercancel', release);
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }');
      root.adoptedStyleSheets = [sheet];
    } catch {}
    const stop = (event) => stopPropagation(event);
    for (const type of STOPPED) {
      addListener(root, type, stop);
      addListener(host, type, stop);
    }
  };
  const show = (text) => {
    setText(label, text);
    setTitle(label, text);
    apply(host, IMPORTANT);
    if (dropped) apply(host, dropped);
    const parent = getRoot(document);
    if (parent && getParent(host) !== parent) appendChild(parent, host);
  };
  const hide = () => { if (host && getParent(host)) removeNode(host); };
  let timer = null;
  const stopPolling = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
  let generation = 0;
  const tick = async () => {
    const began = generation;
    let state;
    try { state = await stateFn(); } catch { return; }
    if (state && state.waiting) {
      show(toText(state.text));
      return;
    }
    if (began !== generation) return;
    hide();
    stopPolling();
  };
  const start = () => {
    generation++;
    if (timer === null) timer = setInterval(tick, 500);
    tick();
  };
  build();
  addListener(window, WAKE, start);
  start();
})();`;
}

// packages/consent/src/rules.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join as join2 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var require2 = createRequire(import.meta.url);
var bundledFixtureRules = fileURLToPath2(new URL("./rules/fixture-site.json", import.meta.url));
var fixtureRulesPath = existsSync2(bundledFixtureRules) ? bundledFixtureRules : fileURLToPath2(new URL("../rules/fixture-site.json", import.meta.url));
function readRuleFile(path) {
  const parsed = JSON.parse(readFileSync2(path, "utf8"));
  if (!parsed || !Array.isArray(parsed.autoconsent)) {
    throw new Error(`Rule file ${path} must be a JSON object with an "autoconsent" array of rules`);
  }
  return parsed.autoconsent;
}
function bundledRules() {
  return require2("@duckduckgo/autoconsent/rules/rules.json").autoconsent;
}
function contentScriptSource() {
  const entry = require2.resolve("@duckduckgo/autoconsent");
  return readFileSync2(join2(dirname(entry), "autoconsent.playwright.js"), "utf8");
}
function mergeRules(extra, bundled) {
  const names = new Set(extra.map((rule) => rule.name));
  return [...extra, ...bundled.filter((rule) => !names.has(rule.name))];
}

// packages/consent/src/driver.ts
var ConsentDriver = class {
  #frames = /* @__PURE__ */ new WeakMap();
  #listeners = /* @__PURE__ */ new Set();
  #rules;
  #config;
  #detectWindowMs;
  options;
  /** Names of the rules sent to autoconsent, one per rule. */
  ruleNames;
  constructor(options) {
    this.options = {
      ruleFiles: options.ruleFiles ?? [],
      fixtureRules: options.fixtureRules !== false,
      detectRetries: options.detectRetries ?? 10,
      disabledCmps: options.disabledCmps ?? []
    };
    const extra = [
      ...options.fixtureRules === false ? [] : readRuleFile(fixtureRulesPath),
      ...(options.ruleFiles ?? []).flatMap(readRuleFile)
    ];
    const rules = mergeRules(extra, bundledRules());
    this.ruleNames = rules.map((rule) => String(rule.name));
    this.#rules = JSON.stringify({ autoconsent: rules });
    this.#detectWindowMs = (options.detectRetries ?? 10) * 500 + 1e3;
    this.#config = JSON.stringify({
      enabled: true,
      autoAction: null,
      disabledCmps: options.disabledCmps ?? [],
      enablePrehide: false,
      enableCosmeticRules: false,
      detectRetries: options.detectRetries ?? 10
    });
  }
  async install(context) {
    await context.exposeBinding(
      "autoconsentSendMessage",
      (source2, msg) => this.#onMessage(source2.frame, msg)
    );
    const source = contentScriptSource();
    await context.addInitScript({ content: source });
    const frames = context.pages().flatMap((page2) => page2.frames());
    await Promise.all(frames.map((frame) => frame.evaluate(source).catch(() => {
    })));
  }
  /** True once autoconsent's content script has started in the frame. */
  isRunningIn(frame) {
    return (this.#frames.get(frame)?.detectT ?? 0) > 0;
  }
  async #onMessage(frame, msg) {
    const state = this.#state(frame);
    switch (msg.type) {
      case "init":
        this.#frames.set(frame, {
          detected: false,
          cmp: null,
          shownT: null,
          acted: false,
          detectT: Date.now(),
          resultSeq: 0,
          result: null
        });
        await frame.evaluate(`autoconsentReceiveMessage({ type: 'initResp', config: ${this.#config}, rules: ${this.#rules} })`).catch(() => {
        });
        this.#notify();
        return;
      case "cmpDetected":
        state.detected = true;
        state.cmp = msg.cmp ?? null;
        break;
      case "popupFound":
        if (state.shownT === null) state.cmp = msg.cmp ?? state.cmp;
        state.shownT = Date.now();
        break;
      case "optInResult":
      case "optOutResult":
        state.resultSeq += 1;
        state.result = msg.result ?? false;
        break;
      case "eval": {
        const result = await frame.evaluate(msg.code ?? "false").catch(() => false);
        await frame.evaluate(
          `autoconsentReceiveMessage({ id: ${JSON.stringify(msg.id)}, type: 'evalResp', result: ${JSON.stringify(result)} })`
        ).catch(() => {
        });
        return;
      }
      default:
        return;
    }
    this.#notify();
  }
  #notify() {
    for (const listener of this.#listeners) listener();
  }
  #state(frame) {
    let state = this.#frames.get(frame);
    if (!state) {
      state = { detected: false, cmp: null, shownT: null, acted: false, detectT: 0, resultSeq: 0, result: null };
      this.#frames.set(frame, state);
    }
    return state;
  }
  async #waitUntil(find, timeoutMs) {
    const found = find();
    if (found !== void 0) return found;
    return new Promise((resolve4) => {
      const done = (value) => {
        clearTimeout(timer);
        this.#listeners.delete(check);
        resolve4(value);
      };
      const check = () => {
        const value = find();
        if (value !== void 0) done(value);
      };
      const timer = setTimeout(() => done(void 0), timeoutMs);
      this.#listeners.add(check);
    });
  }
  #shownFrame(frames) {
    let best;
    for (const frame of frames()) {
      const shownT = this.#frames.get(frame)?.shownT;
      if (shownT != null && (!best || shownT > best.shownT)) best = { frame, shownT };
    }
    return best?.frame;
  }
  // Autoconsent reports a popup once per document and gives up looking after its detection
  // retries. Running detection again (rules are already loaded, so none are sent) reports a
  // banner that opened later, or that was reopened after an action.
  async #redetect(frames) {
    const now = Date.now();
    await Promise.all(
      frames.map(async (frame) => {
        const state = this.#frames.get(frame);
        if (!state?.detectT || state.shownT != null) return;
        if (!state.acted && now - state.detectT < this.#detectWindowMs) return;
        state.acted = false;
        state.detectT = now;
        await frame.evaluate(`autoconsentReceiveMessage({ type: 'initResp', config: ${this.#config}, rules: null })`).catch(() => {
        });
      })
    );
  }
  async #waitForBanner(frames, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (; ; ) {
      await this.#redetect(frames());
      const remaining2 = deadline - Date.now();
      const found = await this.#waitUntil(() => this.#shownFrame(frames), Math.max(0, Math.min(remaining2, 1e3)));
      if (found || remaining2 <= 1e3) return found;
    }
  }
  async answer(target, action, timeoutMs) {
    const frames = () => "frames" in target ? target.frames() : target.pages().flatMap((p) => p.frames());
    const shownFrame = await this.#waitForBanner(frames, timeoutMs);
    if (!shownFrame) {
      const now = Date.now();
      const running = frames().some((f) => this.isRunningIn(f));
      const detected = frames().map((f) => this.#frames.get(f)).filter((s) => s?.detected);
      return {
        detected: detected.length > 0,
        shown: false,
        cmp: detected[0]?.cmp ?? null,
        action,
        result: "banner not shown",
        ...running ? {} : { note: "autoconsent did not start in any frame" },
        t: now,
        tEnd: now
      };
    }
    const state = this.#state(shownFrame);
    const base2 = { detected: true, shown: true, cmp: state.cmp, action };
    if (action === "none") return { ...base2, result: "ok", t: state.shownT ?? Date.now(), tEnd: state.shownT ?? Date.now() };
    const before = state.resultSeq;
    state.shownT = null;
    state.acted = true;
    const message = action === "accept" ? "optIn" : "optOut";
    let t;
    const sentAt = Date.now();
    try {
      t = await shownFrame.evaluate(
        `(() => { autoconsentReceiveMessage({ type: '${message}' }); return performance.timeOrigin + performance.now(); })()`
      );
    } catch {
      const failedT = Date.now();
      return { ...base2, result: "failed", note: "the action could not be sent to the page", t: failedT, tEnd: failedT };
    }
    const reported = await this.#waitUntil(() => {
      const current = this.#frames.get(shownFrame);
      if (current !== state) return false;
      return state.resultSeq > before ? state.result : void 0;
    }, timeoutMs);
    return {
      ...base2,
      result: reported ? "ok" : "failed",
      ...reported ? {} : { note: "autoconsent reported no successful result" },
      t,
      tEnd: t + (Date.now() - sentAt)
    };
  }
};
var drivers = /* @__PURE__ */ new WeakMap();
async function installConsent(context, options = {}) {
  const existing = drivers.get(context);
  if (existing) {
    assertSameOptions(existing, options);
    return existing;
  }
  const driver = new ConsentDriver(options);
  drivers.set(context, driver);
  await driver.install(context);
  return driver;
}
function assertSameOptions(driver, options) {
  for (const key of ["ruleFiles", "fixtureRules", "detectRetries", "disabledCmps"]) {
    const wanted = options[key];
    if (wanted !== void 0 && JSON.stringify(wanted) !== JSON.stringify(driver.options[key])) {
      throw new Error(
        `Consent is already installed on this context with a different "${key}" option; set options once in installConsent`
      );
    }
  }
}

// packages/consent/src/consent-mode.ts
var unknownConsent = {
  analytics: "unknown",
  ads: "unknown",
  adUserData: "unknown",
  adPersonalization: "unknown"
};
var signalToField = {
  analytics_storage: "analytics",
  ad_storage: "ads",
  ad_user_data: "adUserData",
  ad_personalization: "adPersonalization"
};
function toValue(raw) {
  return raw === "granted" || raw === "denied" ? raw : "unknown";
}
function consentModeChanges(pushes, firstDecisionT = Infinity) {
  const changes = [];
  let state = unknownConsent;
  let updated = false;
  const isUpdate = (push) => Array.isArray(push.args) && push.args[1] === "update";
  for (const push of [...pushes].sort((a, b) => a.t - b.t || Number(isUpdate(a)) - Number(isUpdate(b)))) {
    if (!Array.isArray(push.args)) continue;
    const [name, command, signals] = push.args;
    if (name !== "consent" || command !== "default" && command !== "update") continue;
    if (typeof signals !== "object" || signals === null) continue;
    if (command === "default" && "region" in signals) continue;
    if (command === "default" && (updated || push.t > firstDecisionT)) continue;
    if (command === "update") updated = true;
    const delta = {};
    for (const [signal, field] of Object.entries(signalToField)) {
      if (signal in signals) delta[field] = toValue(signals[signal]);
    }
    state = { ...state, ...delta };
    changes.push({ t: push.t, command, state, signals: delta });
  }
  return changes;
}

// packages/consent/src/epochs.ts
var DEFAULT_LEAD_WINDOW_MS = 50;
var DEFAULT_PAIR_WINDOW_MS = 2e3;
function labelOf(state) {
  const known = Object.values(state).filter((v) => v !== "unknown");
  if (known.length > 0 && known.every((v) => v === "granted")) return "granted";
  if (known.length > 0 && known.every((v) => v === "denied")) return "denied";
  return "mixed";
}
function stateOf(action) {
  const v = action === "accept" ? "granted" : "denied";
  return { analytics: v, ads: v, adUserData: v, adPersonalization: v };
}
function bannerFor(banners, t, pairWindowMs, leadWindowMs) {
  const before = banners.findLastIndex((b) => b.t <= t && t <= (b.tEnd ?? b.t) + pairWindowMs);
  if (before >= 0) return before;
  return banners.findIndex((b) => b.t > t && b.t - t <= leadWindowMs);
}
function mergeChanges(banners, updates, pairWindowMs, leadWindowMs) {
  const sortedBanners = [...banners].sort((a, b) => a.t - b.t);
  const owned = sortedBanners.map(() => []);
  const changes = [];
  for (const update of updates) {
    const i = bannerFor(sortedBanners, update.t, pairWindowMs, leadWindowMs);
    if (i >= 0) owned[i].push(update);
    else changes.push({ t: update.t, source: "consentMode", state: update.state, label: labelOf(update.state), decision: false });
  }
  sortedBanners.forEach((banner, i) => {
    const own = owned[i];
    const bannerT = banner.tEnd ?? banner.t;
    const firstUpdateT = own[0]?.t ?? Infinity;
    changes.push({
      t: Math.min(bannerT, firstUpdateT),
      source: firstUpdateT < bannerT ? "consentMode" : "banner",
      state: own[own.length - 1]?.state ?? stateOf(banner.action),
      label: labelOf(stateOf(banner.action)),
      decision: true
    });
  });
  return changes.sort((a, b) => a.t - b.t);
}
function buildEpochs(banners, modeChanges, options) {
  const sorted = [...modeChanges].sort((a, b) => a.t - b.t || Number(a.command === "update") - Number(b.command === "update"));
  const firstUpdateT = sorted.find((c) => c.command === "update")?.t ?? Infinity;
  const firstDecisionT = Math.min(firstUpdateT, ...banners.map((b) => b.t));
  let initial = unknownConsent;
  let running = unknownConsent;
  const updates = [];
  for (const change of sorted) {
    if (change.command === "default") {
      if (change.t > firstDecisionT) continue;
      initial = running = { ...running, ...change.signals };
    } else {
      running = { ...running, ...change.signals };
      updates.push({ ...change, state: running });
    }
  }
  const pairWindowMs = options.pairWindowMs ?? DEFAULT_PAIR_WINDOW_MS;
  const epochs = [
    { startT: options.startT, endT: null, source: "start", state: initial, label: "undecided" }
  ];
  for (const change of mergeChanges(banners, updates, pairWindowMs, options.leadWindowMs ?? DEFAULT_LEAD_WINDOW_MS)) {
    const current = epochs[epochs.length - 1];
    const label = change.label;
    if (current.label === "undecided" && !change.decision && !Object.values(change.state).includes("granted")) {
      current.state = change.state;
      continue;
    }
    const sameState = JSON.stringify(current.state) === JSON.stringify(change.state);
    if (!change.decision && sameState) continue;
    if (sameState && current.label === label) continue;
    current.endT = change.t;
    epochs.push({ startT: change.t, endT: null, source: change.source, state: change.state, label });
  }
  return markWithdrawals(epochs);
}
function markWithdrawals(epochs) {
  const granted = /* @__PURE__ */ new Set();
  for (const epoch of epochs) {
    if (epoch.label === "undecided" || epoch.label === "withdrawn") continue;
    const signals = Object.entries(epoch.state);
    if (signals.some(([signal, value]) => value === "denied" && granted.has(signal))) {
      epoch.outcome = epoch.label;
      epoch.label = "withdrawn";
    }
    for (const [signal, value] of signals) if (value === "granted") granted.add(signal);
  }
  return epochs;
}

// packages/recorder/src/recorder.ts
import {
  chromium,
  request as playwrightRequest
} from "playwright";

// packages/recorder/src/redact.ts
var REDACTED_HEADERS = /* @__PURE__ */ new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "access-token", "x-api-key"]);
var REDACTED = "[redacted]";
function redactHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, REDACTED_HEADERS.has(k.toLowerCase()) ? REDACTED : v])
  );
}
var SECRET_VALUE_NAMES = ["access_token", "appsecret_proof"];
var NAMES = SECRET_VALUE_NAMES.join("|");
var IN_URL = new RegExp(`([?&;])(${NAMES})=[^&#]*`, "gi");
var IN_FORM = new RegExp(`(^|&)(${NAMES})=[^&]*`, "gi");
var IN_JSON = new RegExp(`("(?:${NAMES})"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|[^,}\\]\\s]+)`, "gi");
function redactSecretsInUrl(url) {
  return url.replace(IN_URL, `$1$2=${REDACTED}`);
}
function redactSecretsInBody(body) {
  return body.replace(IN_JSON, `$1"${REDACTED}"`).replace(IN_FORM, `$1$2=${REDACTED}`);
}

// packages/recorder/src/netlog-dir.ts
import { rmSync } from "node:fs";

// packages/recorder/src/terminate.ts
var SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
function onTerminate(handler, raise = (signal) => void process.kill(process.pid, signal)) {
  const listeners = [];
  const remove = () => listeners.forEach(([signal, listener]) => process.off(signal, listener));
  for (const signal of SIGNALS) {
    const listener = () => {
      remove();
      void Promise.resolve().then(() => handler(signal)).catch(() => void 0).finally(() => {
        if (process.listenerCount(signal) === 0) raise(signal);
      });
    };
    listeners.push([signal, listener]);
    process.on(signal, listener);
  }
  return remove;
}

// packages/recorder/src/netlog-dir.ts
function watchNetLogDir(dir) {
  const remove = () => {
    process.off("exit", remove);
    stopWatching();
    rmSync(dir, { recursive: true, force: true });
  };
  const stopWatching = onTerminate(remove);
  process.on("exit", remove);
  return remove;
}

// packages/recorder/src/netlog.ts
function parseFile(text2) {
  try {
    return JSON.parse(text2);
  } catch {
    return JSON.parse(text2.replace(/,?\s*$/, "") + "]}");
  }
}
function headerMap(lines) {
  const out = {};
  if (!Array.isArray(lines)) return out;
  for (const line of lines) {
    if (typeof line !== "string") continue;
    const at = line.indexOf(":");
    if (at > 0) out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return out;
}
function parseNetLog(text2) {
  const { constants: constants2, events } = parseFile(text2);
  const types = constants2.logEventTypes;
  const errorNames = new Map(Object.entries(constants2.netError).map(([name, code]) => [code, name]));
  const offset = Number(constants2.timeTickOffset);
  const bySource = /* @__PURE__ */ new Map();
  for (const event of events) {
    const params = event.params ?? {};
    const id = event.source.id;
    if (event.type === types.URL_REQUEST_START_JOB && typeof params.url === "string") {
      const method = typeof params.method === "string" ? params.method : "GET";
      if (bySource.has(id) || method === "OPTIONS") continue;
      bySource.set(id, {
        t: Number(event.time) + offset,
        method,
        url: params.url,
        headers: {},
        status: null,
        failure: null
      });
      continue;
    }
    const entry = bySource.get(id);
    if (!entry) continue;
    if (event.type === types.HTTP_TRANSACTION_SEND_REQUEST_HEADERS) {
      entry.headers = headerMap(params.headers);
    } else if (event.type === types.HTTP_TRANSACTION_READ_RESPONSE_HEADERS && Array.isArray(params.headers)) {
      const status = /^HTTP\/\S+\s+(\d{3})/.exec(String(params.headers[0]));
      if (status) entry.status = Number(status[1]);
    } else if (typeof params.net_error === "number" && params.net_error !== 0 && entry.failure === null) {
      const name = errorNames.get(params.net_error);
      if (name) entry.failure = `net::${name}`;
    }
  }
  return [...bySource.values()];
}
var UNLOAD_WINDOW_MS = 5e3;
var COMMIT_SLACK_MS = 1500;
var inUnloadWindow = (windows, t) => windows.some((w) => t >= w.from && t <= (w.to === null ? w.from + UNLOAD_WINDOW_MS : w.to + COMMIT_SLACK_MS));
var NavigationWindows = class {
  first;
  windows = /* @__PURE__ */ new Map();
  start(request, t) {
    let root = request;
    for (let prev = root.redirectedFrom(); prev; prev = root.redirectedFrom()) root = prev;
    this.first ??= root;
    if (root !== this.first) this.windows.set(request, { from: t, to: null });
  }
  respond(request, t) {
    const window2 = this.windows.get(request);
    if (window2) window2.to = t;
  }
  list() {
    return [...this.windows.values()];
  }
};
function mergeNetLog(entries, recorded, steps, trackers, runId, navigations = []) {
  const seen = /* @__PURE__ */ new Map();
  for (const r of recorded) {
    const key = `${r.method} ${r.url}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const requests = [];
  const responses = [];
  for (const entry of entries) {
    if (entry.method === "OPTIONS") continue;
    const key = `${entry.method} ${entry.url}`;
    const count = seen.get(key) ?? 0;
    if (count > 0) {
      seen.set(key, count - 1);
      continue;
    }
    const candidate = { method: entry.method, url: entry.url, resourceType: "other", postData: null };
    if (!/^https?:/.test(entry.url) || !(isCollectionEndpoint(candidate, trackers) || isKnownVendorCollection(candidate))) continue;
    const step = steps.findLast((s) => s.startedAt <= entry.t);
    const record = {
      type: "request",
      id: newId("request"),
      runId,
      stepId: step?.id ?? null,
      t: entry.t,
      method: entry.method,
      url: entry.url,
      resourceType: "other",
      frameUrl: null,
      initiator: inUnloadWindow(navigations, entry.t) ? "unload" : "netlog",
      headers: redactHeaders(entry.headers),
      postData: null,
      outcome: entry.failure ? "failed" : "passed",
      captured: "netlog",
      ...entry.failure ? { failure: entry.failure } : {}
    };
    requests.push(record);
    if (entry.status !== null) responses.push({ type: "response", id: newId("response"), requestId: record.id, status: entry.status, setCookieNames: [] });
  }
  return { requests, responses };
}

// packages/recorder/src/server-container/capture.ts
import { tmpdir as tmpdir2 } from "node:os";

// packages/recorder/src/guard.ts
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
var SENSITIVE_NAME = /card|cvc|cvv|iban|password/i;
function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}
var TEST_LOOPBACK_IS_HOSTED_ENV = "TAGREEVE_TEST_LOOPBACK_IS_HOSTED";
function loopbackIsHostedForTests() {
  return process.env[TEST_LOOPBACK_IS_HOSTED_ENV] === "1";
}
function isGuardExemptHost(host) {
  return !loopbackIsHostedForTests() && isLoopbackHost(host);
}
function isSensitiveField(field) {
  const autocomplete = (field.autocomplete ?? "").toLowerCase().split(/\s+/);
  return autocomplete.some((token) => token.startsWith("cc-")) || (field.type ?? "").toLowerCase() === "password" || SENSITIVE_NAME.test(field.name ?? "") || SENSITIVE_NAME.test(field.id ?? "");
}
var HANDOFF_REQUIRED = "Payments and log-ins must be handoff steps on any site that is not on this machine.";
var SENSITIVE_WRITE_TRAP = `(() => {
  const name = new RegExp(${JSON.stringify(SENSITIVE_NAME.source)}, 'i');
  const sensitive = (e) => {
    const autocomplete = (e.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/);
    return autocomplete.some((t) => t.startsWith('cc-')) || (e.getAttribute('type') || '').toLowerCase() === 'password' ||
      name.test(e.getAttribute('name') || '') || name.test(e.getAttribute('id') || '');
  };
  const state = { blocked: false };
  const restores = [];
  const refuse = () => { state.blocked = true; throw new Error('card and password fields cannot be set by a script'); };
  for (const proto of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
    for (const prop of ['value', 'defaultValue']) {
      const original = Object.getOwnPropertyDescriptor(proto, prop);
      if (!original || !original.set) continue;
      Object.defineProperty(proto, prop, { ...original, set(v) { if (sensitive(this)) refuse(); original.set.call(this, v); } });
      restores.push(() => Object.defineProperty(proto, prop, original));
    }
  }
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (attr, v) {
    const isField = this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement;
    if (isField && /^value$/i.test(String(attr)) && sensitive(this)) refuse();
    if (isField && /^type$/i.test(String(attr)) && /^password$/i.test(String(v))) refuse();
    return setAttribute.call(this, attr, v);
  };
  restores.push(() => { Element.prototype.setAttribute = setAttribute; });
  const setAttributeNS = Element.prototype.setAttributeNS;
  Element.prototype.setAttributeNS = function (ns, attr, v) {
    const isField = this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement;
    if (isField && /^(?:[^:]*:)?value$/i.test(String(attr)) && sensitive(this)) refuse();
    return setAttributeNS.call(this, ns, attr, v);
  };
  restores.push(() => { Element.prototype.setAttributeNS = setAttributeNS; });
  const attrValue = Object.getOwnPropertyDescriptor(Attr.prototype, 'value');
  if (attrValue && attrValue.set) {
    Object.defineProperty(Attr.prototype, 'value', { ...attrValue, set(v) {
      const owner = this.ownerElement;
      const isField = owner instanceof HTMLInputElement || owner instanceof HTMLTextAreaElement;
      if (isField && this.name.toLowerCase() === 'value' && sensitive(owner)) refuse();
      attrValue.set.call(this, v);
    } });
    restores.push(() => Object.defineProperty(Attr.prototype, 'value', attrValue));
  }
  window.__tagreeveTrap = { state, release: () => restores.forEach((r) => r()) };
})()`;

// packages/recorder/src/server-container/ca.ts
import { generateKeyPairSync, randomBytes as randomBytes2 } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync as rmSync2, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join as join3 } from "node:path";
import forge from "node-forge";
var DAY_MS = 24 * 60 * 60 * 1e3;
function serial() {
  const bytes = randomBytes2(16);
  bytes[0] = (bytes[0] ?? 0) & 127;
  return bytes.toString("hex");
}
function newKeyPair() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const priv = forge.pki.privateKeyFromPem(privateKey.export({ type: "pkcs1", format: "pem" }).toString());
  return { privateKey: priv, publicKey: forge.pki.rsa.setPublicKey(priv.n, priv.e) };
}
function createRunCa(tempRoot) {
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(join3(tempRoot, "tagreeve-ca-"));
  chmodSync(dir, 493);
  const caKeys = newKeyPair();
  const leafKeys = newKeyPair();
  const leafKeyPem = forge.pki.privateKeyToPem(leafKeys.privateKey);
  const now = Date.now();
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = serial();
  caCert.validity.notBefore = new Date(now - 60 * 60 * 1e3);
  caCert.validity.notAfter = new Date(now + 2 * DAY_MS);
  const caName = [{ name: "commonName", value: `Tagreeve run CA ${randomBytes2(4).toString("hex")}` }];
  caCert.setSubject(caName);
  caCert.setIssuer(caName);
  caCert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" }
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(caCert);
  const certPath = join3(dir, "ca.pem");
  writeFileSync(certPath, certPem, { mode: 420 });
  chmodSync(certPath, 420);
  const leaves = /* @__PURE__ */ new Map();
  function leafFor(host) {
    const name = host.toLowerCase();
    const cached = leaves.get(name);
    if (cached) return cached;
    const cert = forge.pki.createCertificate();
    cert.publicKey = leafKeys.publicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(now - 60 * 60 * 1e3);
    cert.validity.notAfter = new Date(now + 2 * DAY_MS);
    cert.setSubject([{ name: "commonName", value: name.slice(0, 64) }]);
    cert.setIssuer(caCert.subject.attributes);
    const altName = isIP(name) ? { type: 7, ip: name } : { type: 2, value: name };
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [altName] }
    ]);
    cert.sign(caKeys.privateKey, forge.md.sha256.create());
    const leaf = { certPem: forge.pki.certificateToPem(cert), keyPem: leafKeyPem };
    leaves.set(name, leaf);
    return leaf;
  }
  return {
    certPath,
    certPem,
    leafFor,
    close() {
      rmSync2(dir, { recursive: true, force: true });
    }
  };
}

// packages/recorder/src/server-container/proxy.ts
import { createHash as createHash2, randomBytes as randomBytes3, timingSafeEqual } from "node:crypto";
import http from "node:http";
import tls from "node:tls";

// packages/recorder/src/server-container/forward-list.ts
var forwardList = [
  { class: "serverjs", host: "www.googletagmanager.com", path: "/static/serverjs/", match: "prefix" },
  { class: "config", host: "www.googletagmanager.com", path: "/server.js", match: "exact" },
  { class: "destination", host: "www.googletagmanager.com", path: "/s/gtag/destination", match: "exact" }
];
var FORWARD_METHODS = /* @__PURE__ */ new Set(["GET", "HEAD"]);
function isUnsafePath(pathname) {
  return /(^|\/)(\.|%2e){1,2}(\/|$)/i.test(pathname) || pathname.includes("\\") || /%2f|%5c/i.test(pathname);
}
function classifyForward(method, url) {
  if (!FORWARD_METHODS.has(method)) return void 0;
  if (url.protocol !== "https:") return void 0;
  if (url.port !== "" && url.port !== "443") return void 0;
  if (isUnsafePath(url.pathname)) return void 0;
  for (const row of forwardList) {
    if (url.hostname !== row.host) continue;
    const hit = row.match === "exact" ? url.pathname === row.path : url.pathname.startsWith(row.path);
    if (hit) return row.class;
  }
  return void 0;
}

// packages/recorder/src/server-container/proxy.ts
var USERNAME = "tagreeve";
var MAX_BODY_BYTES2 = 1024 * 1024;
var IDLE_TIMEOUT_MS = 3e4;
var UNSPECIFIED_ADDRESSES = /* @__PURE__ */ new Set(["0.0.0.0", "::", "::ffff:0.0.0.0"]);
function isUnspecifiedHost(host) {
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare === "") return true;
  try {
    const normalized = new URL(`http://${bare.includes(":") ? `[${bare}]` : bare}`).hostname.replace(/^\[|\]$/g, "");
    return UNSPECIFIED_ADDRESSES.has(normalized) || normalized === "::ffff:0:0";
  } catch {
    return false;
  }
}
function digest(value) {
  return createHash2("sha256").update(value).digest();
}
function parseConnectTarget(authority) {
  if (!authority) return void 0;
  try {
    const u = new URL(`https://${authority}`);
    if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) return void 0;
    const port = u.port === "" ? "443" : u.port;
    const hostname2 = u.hostname.replace(/^\[|\]$/g, "");
    if (hostname2 === "") return void 0;
    return { hostname: hostname2, origin: `https://${u.hostname}${port === "443" ? "" : `:${port}`}` };
  } catch {
    return void 0;
  }
}
async function createRecordingProxy(options) {
  if (isUnspecifiedHost(options.host)) throw new Error("The proxy must not listen on a wildcard address.");
  const credential = randomBytes3(24).toString("base64url");
  const expected = digest(`Basic ${Buffer.from(`${USERNAME}:${credential}`).toString("base64")}`);
  const idleMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const maxBody = options.maxBodyBytes ?? MAX_BODY_BYTES2;
  const counts = { serverjs: 0, config: 0, destination: 0 };
  let refusedCount = 0;
  const sockets = /* @__PURE__ */ new Set();
  const tunnelTargets = /* @__PURE__ */ new WeakMap();
  const contexts = /* @__PURE__ */ new Map();
  function track(socket) {
    sockets.add(socket);
    socket.setTimeout?.(idleMs);
    socket.on("timeout", () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  }
  function authorized(headers) {
    const given = headers["proxy-authorization"];
    if (typeof given !== "string") return false;
    return timingSafeEqual(digest(given), expected);
  }
  function reject407(res) {
    refusedCount += 1;
    res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="tagreeve"', "Content-Length": "0", Connection: "close" });
    res.end();
  }
  async function readBody(req) {
    const chunks = [];
    let size = 0;
    let complete = true;
    for await (const chunk of req) {
      if (size >= maxBody) {
        complete = false;
        continue;
      }
      const room = maxBody - size;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) complete = false;
      chunks.push(part);
      size += part.length;
    }
    return { body: Buffer.concat(chunks), complete };
  }
  async function dispatch(req, res, url) {
    const receivedAt = Date.now();
    const { body, complete } = await readBody(req);
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    const request = {
      method: req.method ?? "GET",
      url: url.href,
      headers,
      body,
      bodyComplete: complete,
      receivedAt
    };
    let answer;
    try {
      const forwardClass = classifyForward(request.method, url);
      if (forwardClass) {
        counts[forwardClass] += 1;
        answer = await options.forward(request);
      } else {
        answer = await options.handler(request);
      }
    } catch {
      answer = { status: 502 };
    }
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  }
  function onPlainRequest(req, res) {
    if (!authorized(req.headers)) {
      reject407(res);
      return;
    }
    let url;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400, { "Content-Length": "0" }).end();
      return;
    }
    if (url.protocol !== "http:") {
      res.writeHead(400, { "Content-Length": "0" }).end();
      return;
    }
    dispatch(req, res, url).catch(() => res.destroy());
  }
  function onTunnelRequest(req, res) {
    const target = tunnelTargets.get(req.socket);
    if (!target || !req.url?.startsWith("/")) {
      res.writeHead(400, { "Content-Length": "0" }).end();
      return;
    }
    let url;
    try {
      url = new URL(target.origin + req.url);
    } catch {
      res.writeHead(400, { "Content-Length": "0" }).end();
      return;
    }
    if (url.origin !== target.origin) {
      res.writeHead(400, { "Content-Length": "0" }).end();
      return;
    }
    dispatch(req, res, url).catch(() => res.destroy());
  }
  function secureContextFor(hostname2) {
    let context = contexts.get(hostname2);
    if (!context) {
      const leaf = options.ca.leafFor(hostname2);
      context = tls.createSecureContext({ key: leaf.keyPem, cert: leaf.certPem });
      contexts.set(hostname2, context);
    }
    return context;
  }
  const tunnelServer = http.createServer(onTunnelRequest);
  const server = http.createServer(onPlainRequest);
  server.on("connect", (req, socket, head) => {
    track(socket);
    if (!authorized(req.headers)) {
      refusedCount += 1;
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="tagreeve"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const target = parseConnectTarget(req.url);
    if (!target) {
      socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) socket.unshift(head);
    const secure = new tls.TLSSocket(socket, {
      isServer: true,
      secureContext: secureContextFor(target.hostname)
    });
    tunnelTargets.set(secure, target);
    track(secure);
    tunnelServer.emit("connection", secure);
  });
  server.on("connection", (socket) => track(socket));
  await new Promise((resolve4, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve4();
    });
  });
  const address = server.address();
  if (address && typeof address === "object" && isUnspecifiedHost(address.address)) {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve4) => server.close(() => resolve4()));
    throw new Error("The proxy must not listen on a wildcard address.");
  }
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    host: options.host,
    port,
    username: USERNAME,
    credential,
    passThrough: () => ({ ...counts }),
    refused: () => refusedCount,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve4) => server.close(() => resolve4()));
    }
  };
}

// packages/recorder/src/server-container/runner.ts
import { spawn } from "node:child_process";
import { randomBytes as randomBytes4 } from "node:crypto";
import { readFileSync as readFileSync3, statSync } from "node:fs";
import http2 from "node:http";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { hostname } from "node:os";
import { isAbsolute } from "node:path";

// packages/recorder/src/gtm-scrub.ts
var REDACTED2 = "[redacted]";
var MAX_DEPTH2 = 8;
var BASE64_TOKEN2 = /[A-Za-z0-9+/_-]{8,}={0,2}/g;
var QUERY_LIKE = /^[\w.[\]-]+=[^&\s]*(?:&[\w.[\]-]+=[^&\s]*)*$/;
function decodeBase64Text2(value) {
  const v = value.replace(/ /g, "+");
  if (v.length < 4 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) return void 0;
  const bare = v.replace(/=+$/, "");
  if (bare.length % 4 === 1) return void 0;
  return Buffer.from(bare.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
}
function urlDecode(text2) {
  try {
    return decodeURIComponent(text2);
  } catch {
    return text2;
  }
}
function queryValues(text2) {
  const query = text2.includes("?") ? text2.slice(text2.indexOf("?") + 1) : text2;
  return query.split("&").flatMap((pair) => pair.includes("=") ? [pair.slice(pair.indexOf("=") + 1)] : []);
}
function containsSecret(text2, secret, depth = 0) {
  if (text2.length < secret.length) return false;
  if (text2.includes(secret)) return true;
  if (depth >= MAX_DEPTH2) return false;
  const next = depth + 1;
  const decoded = urlDecode(text2);
  if (decoded !== text2 && containsSecret(decoded, secret, next)) return true;
  const whole = decodeBase64Text2(text2);
  if (whole !== void 0 && containsSecret(whole, secret, next)) return true;
  if (/[?&=]/.test(text2)) {
    for (const value of queryValues(text2)) {
      if (value !== text2 && containsSecret(value, secret, next)) return true;
    }
  }
  for (const token of text2.match(BASE64_TOKEN2) ?? []) {
    if (token === text2) continue;
    const inner = decodeBase64Text2(token);
    if (inner !== void 0 && containsSecret(inner, secret, next)) return true;
  }
  return false;
}
var Scrubber = class {
  constructor(secret) {
    this.secret = secret;
  }
  secret;
  /** The whole string becomes `[redacted]` if any decoded layer holds the secret. */
  value(text2) {
    return containsSecret(text2, this.secret) ? REDACTED2 : text2;
  }
  pairs(query) {
    return query.split("&").map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return this.value(pair);
      return containsSecret(pair.slice(eq + 1), this.secret) ? `${pair.slice(0, eq + 1)}${REDACTED2}` : pair;
    }).join("&");
  }
  /** Each query value that holds the secret is redacted. A secret anywhere else in the URL redacts the whole URL. */
  url(url) {
    const hash = url.indexOf("#");
    const base2 = hash < 0 ? url : url.slice(0, hash);
    const q = base2.indexOf("?");
    const out = q < 0 ? url : `${base2.slice(0, q)}?${this.pairs(base2.slice(q + 1))}${hash < 0 ? "" : url.slice(hash)}`;
    return this.value(out);
  }
  /** Flag detail ends with a URL. A whole-redacted URL keeps its origin so the host can still be reported. */
  flagDetail(detail) {
    const split = /^(.*\s)(https?:\/\/\S+)$/s.exec(detail);
    if (!split) return this.value(detail);
    const url = this.url(split[2]);
    if (url !== REDACTED2) return this.value(split[1]) + url;
    try {
      const origin = new URL(split[2]).origin;
      return this.value(split[1]) + (containsSecret(origin, this.secret) ? REDACTED2 : `${origin}/${REDACTED2}`);
    } catch {
      return REDACTED2;
    }
  }
  /** A form-encoded body (one or more lines) loses only the values that hold the secret. Any other body is redacted whole. */
  body(body) {
    const lines = body.split("\n");
    if (lines.every((line) => line === "" || QUERY_LIKE.test(line))) {
      return lines.map((line) => line === "" ? line : this.pairs(line)).join("\n");
    }
    return this.value(body);
  }
  /** Free text such as CLI output: occurrences are replaced, and a line that still holds the secret in a decoded layer is redacted. */
  text(text2) {
    return text2.split("\n").map((line) => this.value(line.split(this.secret).join(REDACTED2))).join("\n");
  }
  deep(input) {
    if (typeof input === "string") return this.value(input);
    if (Array.isArray(input)) return input.map((item) => this.deep(item));
    if (typeof input === "object" && input !== null) {
      return Object.fromEntries(Object.entries(input).map(([k, v]) => [this.value(k), this.deep(v)]));
    }
    return input;
  }
  records(records) {
    const { requests, flags: flags2, ...rest } = records;
    return {
      ...this.deep(rest),
      flags: flags2.map((f) => ({ ...this.deep({ ...f, detail: "" }), detail: this.flagDetail(f.detail) })),
      requests: requests.map((r) => ({
        ...this.deep({ ...r, url: "", postData: null }),
        url: this.url(r.url),
        postData: r.postData === null ? null : this.body(r.postData)
      }))
    };
  }
};

// packages/recorder/src/server-container/image.ts
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join4 } from "node:path";
var GOOGLE_IMAGE = "gcr.io/cloud-tagging-10302018/gtm-cloud-image@sha256:5ebac98d14121e2f9f64556648edf075d534826ca57dbbe47b60716690c97536";
var NODE_BUILD_IMAGE = "node:24@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413";
var DISTROLESS_IMAGE = "gcr.io/distroless/nodejs24-debian12@sha256:61f4f4341db81820c24ce771b83d202eb6452076f58628cd536cc7d94a10978b";
var BASE_ENV = "TAGREEVE_SERVER_CONTAINER_BASE";
var IMAGE_REPOSITORY = "tagreeve-sgtm";
var NAME_PREFIX = "tagreeve-sgtm-";
var OWNER_PID_LABEL = "tagreeve.owner.pid";
var OWNER_HOST_LABEL = "tagreeve.owner.host";
var DIGEST_REFERENCE = /^[a-z0-9][a-z0-9./_:-]*@sha256:[0-9a-f]{64}$/;
function isDigestReference(reference) {
  return DIGEST_REFERENCE.test(reference);
}
var DOCKERFILE = `ARG GOOGLE_IMAGE=${GOOGLE_IMAGE}
FROM --platform=linux/amd64 \${GOOGLE_IMAGE} AS google

FROM ${NODE_BUILD_IMAGE} AS build
WORKDIR /app
COPY --from=google /app/package.json /app/server_bin.js /app/health_checker_bin.js ./
COPY --from=google /app/node_modules ./node_modules
RUN npm rebuild re2

FROM ${DISTROLESS_IMAGE}
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
CMD ["server_bin.js"]
`;
var NODE_BIN = "/nodejs/bin/node";
var RELAY_SCRIPT = `const net = require('node:net');
for (const entry of String(process.env.RELAY_MAP || '').split(',')) {
  const [listen, target] = entry.split('=');
  const cut = target.lastIndexOf(':');
  const host = target.slice(0, cut);
  const port = Number(target.slice(cut + 1));
  net.createServer((client) => {
    const upstream = net.connect(port, host);
    client.pipe(upstream);
    upstream.pipe(client);
    const end = () => { client.destroy(); upstream.destroy(); };
    client.on('error', end);
    upstream.on('error', end);
    client.on('close', end);
    upstream.on('close', end);
  }).listen(Number(listen), '0.0.0.0');
}
`;
var PROBE_HOST = "www.googletagmanager.com";
var PROBE_SCRIPT = `const net = require('node:net');
const dns = require('node:dns');
const result = { connect: false, dns: false };
const connect = new Promise((resolve) => {
  const socket = net.connect({ host: process.argv[1], port: 443, timeout: 4000 });
  socket.on('connect', () => { result.connect = true; socket.destroy(); resolve(); });
  socket.on('timeout', () => { socket.destroy(); resolve(); });
  socket.on('error', () => resolve());
});
const lookup = new Promise((resolve) => {
  dns.lookup(${JSON.stringify(PROBE_HOST)}, (error) => { result.dns = !error; resolve(); });
});
Promise.all([connect, lookup]).then(() => { console.log(JSON.stringify(result)); process.exit(0); });
`;
function runDocker(args, options = {}) {
  return new Promise((resolve4) => {
    execFile("docker", [...args], { env: options.env ?? process.env, timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        resolve4({ code: 0, stdout, stderr, missing: false });
        return;
      }
      const code = error.code;
      resolve4({ code: typeof code === "number" ? code : 1, stdout, stderr, missing: code === "ENOENT" });
    });
  });
}
var DOCKER_INSTALL_URL = "https://docs.docker.com/get-docker/";
var DOCKER_NEEDED_MESSAGE = `Docker is needed for --server-container. Install it from ${DOCKER_INSTALL_URL}`;
async function checkDockerPresent(env) {
  const version = await runDocker(["version", "--format", "{{.Server.Version}}"], { env, timeoutMs: 3e4 });
  const ok = !version.missing && version.code === 0;
  return { ok, serverVersion: ok ? version.stdout.trim() : "" };
}
function imageTag(version) {
  return `${IMAGE_REPOSITORY}:${version}`;
}
function baseImage(env) {
  const override = env[BASE_ENV];
  if (override === void 0 || override === "") return GOOGLE_IMAGE;
  if (!isDigestReference(override)) throw new Error(`${BASE_ENV} must be an image reference with a digest (name@sha256:<64 hex>).`);
  return override;
}
async function buildImage(options) {
  const env = options.env ?? process.env;
  const base2 = baseImage(env);
  if ((options.arch ?? process.arch) !== "arm64") return { status: "not-needed", image: base2 };
  if (!(await checkDockerPresent(env)).ok) return { status: "dockerMissing", message: DOCKER_NEEDED_MESSAGE };
  const tag = imageTag(options.version);
  const dir = await mkdtemp(join4(options.tempRoot ?? tmpdir(), "tagreeve-image-"));
  try {
    await writeFile(join4(dir, "Dockerfile"), DOCKERFILE);
    const built = await runDocker(["build", "--platform", "linux/arm64", "--build-arg", `GOOGLE_IMAGE=${base2}`, "--tag", tag, dir], { env });
    if (built.missing) return { status: "dockerMissing", message: DOCKER_NEEDED_MESSAGE };
    if (built.code !== 0) return { status: "failed", message: built.stderr.trim().split("\n").slice(-10).join("\n") };
    const inspected = await runDocker(["image", "inspect", "--format", "{{.Id}}", tag], { env });
    return { status: "built", tag, imageId: inspected.code === 0 ? inspected.stdout.trim() : tag };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// packages/recorder/src/server-container/runner.ts
var CONFIG_ENV = "TAGREEVE_SERVER_CONTAINER_CONFIG";
var TEST_COMMAND_ENV = "TAGREEVE_TEST_SERVER_CONTAINER_CMD";
var ServerContainerError = class extends Error {
  errorClass;
  constructor(errorClass, message) {
    super(message);
    this.name = "ServerContainerError";
    this.errorClass = errorClass;
  }
};
var ServerContainerUsageError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ServerContainerUsageError";
  }
};
var RELAY_PROXY_PORT = 3128;
var CONTAINER_PORT = 8080;
var CA_MOUNT = "/tagreeve/ca.pem";
var READY_TIMEOUT_MS = 6e4;
var READY_POLL_MS = 500;
var LOG_LINES = 20;
var MIN_ENGINE_MAJOR = 26;
function loadContainerConfig(source, env = process.env) {
  let raw;
  if (source.kind === "file") {
    try {
      const stat7 = statSync(source.path);
      if (!stat7.isFile()) throw new Error("not a file");
      if (process.platform !== "win32" && (stat7.mode & 63) !== 0) {
        throw new ServerContainerError("configRejected", "The server container config file must be mode 0600. Run: chmod 600 <file>");
      }
      raw = readFileSync3(source.path, "utf8");
    } catch (error) {
      if (error instanceof ServerContainerError) throw error;
      throw new ServerContainerError("configRejected", "The server container config file cannot be read.");
    }
  } else {
    raw = env[CONFIG_ENV];
  }
  const config = (raw ?? "").trim();
  if (authPartOf(config) === void 0) {
    throw new ServerContainerError("configRejected", "The server container config is not the base64 of id=GTM-...&env=N&auth=...");
  }
  return config;
}
function optionalConfig(source, env) {
  try {
    return loadContainerConfig(source, env);
  } catch {
    return "";
  }
}
function authPartOf(config) {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(config)) return void 0;
  const params = new URLSearchParams(Buffer.from(config.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  if (!params.get("id")?.startsWith("GTM-")) return void 0;
  return params.get("auth") ?? "";
}
function createLogScrubber(secrets) {
  const scrubbers = secrets.filter((s) => s.length > 0).map((s) => new Scrubber(s));
  return (line) => {
    const cut = line.replace(/https?:\/\/[^\s"'<>]+/g, (url) => {
      try {
        return `${new URL(url).origin}/...`;
      } catch {
        return "[url]";
      }
    });
    return scrubbers.reduce((text2, scrubber) => scrubber.text(text2), cut);
  };
}
function resolveStandInCommand(env, serverHosts) {
  const value = env[TEST_COMMAND_ENV];
  if (value === void 0 || value === "") return void 0;
  const reject = (reason) => {
    throw new ServerContainerUsageError(`${TEST_COMMAND_ENV} is not usable: ${reason}.`);
  };
  if (!isAbsolute(value)) reject("it must be an absolute path");
  let mode;
  try {
    const stat7 = statSync(value);
    if (!stat7.isFile()) reject("it must be a regular file");
    mode = stat7.mode;
  } catch (error) {
    if (error instanceof ServerContainerUsageError) throw error;
    return reject("the file does not exist");
  }
  if ((mode & 2) !== 0) reject("the file must not be world-writable");
  if (!serverHosts.every(isLoopbackHost)) reject("it works only when every serverHosts host is loopback");
  return value;
}
function pickFreePort() {
  return new Promise((resolve4, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve4(port));
    });
  });
}
async function findProxyListenHost(env = process.env, platform = process.platform) {
  if (platform !== "linux") return "127.0.0.1";
  const result = await runDocker(["network", "inspect", "bridge", "--format", "{{range .IPAM.Config}}{{.Gateway}} {{end}}"], { env });
  if (result.missing) throw new ServerContainerError("dockerMissing", "Docker is needed for --server-container.");
  const gateway = result.stdout.split(/\s+/).find((part) => net.isIPv4(part));
  if (result.code !== 0 || !gateway) throw new ServerContainerError("notReady", "The Docker bridge address could not be found.");
  return gateway;
}
function ownerLabels() {
  return ["--label", `${OWNER_PID_LABEL}=${process.pid}`, "--label", `${OWNER_HOST_LABEL}=${hostname()}`];
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
var OBJECT_FORMAT = `{{.ID}}	{{.Label "${OWNER_PID_LABEL}"}}	{{.Label "${OWNER_HOST_LABEL}"}}`;
async function sweepOrphans(options = {}) {
  const host = options.host ?? hostname();
  const alive = options.isAlive ?? pidAlive;
  const removed = [];
  const kinds = [
    { list: ["ps", "-a"], remove: ["rm", "-f"] },
    { list: ["network", "ls"], remove: ["network", "rm"] }
  ];
  for (const kind of kinds) {
    const listing = await runDocker([...kind.list, "--filter", `label=${OWNER_PID_LABEL}`, "--format", OBJECT_FORMAT], { env: options.env });
    if (listing.code !== 0) continue;
    for (const line of listing.stdout.split("\n")) {
      const [id, pidText, ownerHost] = line.split("	");
      if (!id || !pidText || ownerHost !== host || !/^\d+$/.test(pidText)) continue;
      const pid = Number(pidText);
      if (pid === process.pid || alive(pid)) continue;
      const result = await runDocker([...kind.remove, id], { env: options.env });
      if (result.code === 0) removed.push(id);
    }
  }
  return removed;
}
async function resolveIPv4(host) {
  return (await lookup(host, { family: 4 })).address;
}
function probeHealth(origin) {
  return new Promise((resolve4) => {
    const req = http2.get(`${origin}/healthz`, { timeout: 2e3 }, (res) => {
      res.resume();
      resolve4(res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve4(false));
  });
}
function followOutput(child, push) {
  let ended = false;
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach(push);
    });
    stream?.on("end", () => {
      if (pending) push(pending);
    });
  }
  child.on("exit", () => {
    ended = true;
  });
  child.on("error", () => {
    ended = true;
  });
  return { process: child, ended: () => ended };
}
async function checkServerContainerHost(options) {
  const env = options.env ?? process.env;
  const docker = await checkDockerPresent(env);
  if (!docker.ok) throw new ServerContainerError("dockerMissing", DOCKER_NEEDED_MESSAGE);
  const major = Number(/^(\d+)\./.exec(docker.serverVersion)?.[1]);
  if (Number.isInteger(major) && major < MIN_ENGINE_MAJOR) {
    throw new ServerContainerError("egressOpen", `Docker Engine ${docker.serverVersion} forwards DNS from internal networks (CVE-2024-29018). Upgrade Docker to ${MIN_ENGINE_MAJOR} or newer.`);
  }
  if ((await runDocker(["image", "inspect", "--format", "{{.Id}}", options.image], { env })).code !== 0) {
    throw new ServerContainerError("imageMissing", await imageMissingMessage(options.image, env));
  }
}
async function imageMissingMessage(image, env) {
  const plain = `The image ${image} is not available. Run: tagreeve server-container build`;
  if (!image.startsWith(`${IMAGE_REPOSITORY}:`)) return plain;
  const list2 = await runDocker(["image", "ls", "--format", "{{.Tag}}", IMAGE_REPOSITORY], { env, timeoutMs: 3e4 });
  if (list2.code !== 0) return plain;
  const tags = list2.stdout.split("\n").map((line) => line.trim()).filter((tag) => tag !== "" && tag !== "<none>");
  return `The image ${image} is not available. Local ${IMAGE_REPOSITORY} images: ${tags.length > 0 ? tags.join(", ") : "none"}. Run: tagreeve server-container build`;
}
async function startServerContainer(options) {
  const env = options.env ?? process.env;
  const standIn = resolveStandInCommand(env, options.serverHosts);
  const config = standIn === void 0 ? loadContainerConfig(options.configSource, env) : optionalConfig(options.configSource, env);
  const username = options.proxyUsername ?? "tagreeve";
  const authPart = authPartOf(config);
  const scrub2 = createLogScrubber([config, authPart ?? "", options.proxyCredential]);
  const lines = [];
  const push = (line) => {
    lines.push(scrub2(line));
    if (lines.length > LOG_LINES) lines.shift();
  };
  const tail = () => lines.length > 0 ? `
Last lines of the container log:
${lines.join("\n")}` : "";
  const pickPort = options.pickPort ?? pickFreePort;
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const pollMs = options.pollMs ?? READY_POLL_MS;
  const baseEnv = { ...env };
  delete baseEnv[CONFIG_ENV];
  const cleanups = [];
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => void 0);
  };
  const checkAborted = () => {
    if (options.signal?.aborted) throw new ServerContainerError("notReady", "The start was cancelled.");
  };
  async function waitReady(origin, follower) {
    const deadline = Date.now() + readyTimeoutMs;
    for (; ; ) {
      checkAborted();
      if (await probeHealth(origin)) return;
      if (follower.ended()) throw new ServerContainerError("exited", `The server container exited before it was ready.${tail()}`);
      if (Date.now() >= deadline) throw new ServerContainerError("notReady", `The server container was not ready after ${Math.round(readyTimeoutMs / 1e3)} s.${tail()}`);
      await new Promise((resolve4) => setTimeout(resolve4, pollMs));
    }
  }
  try {
    if (standIn !== void 0) {
      const port = await pickPort();
      const proxyUrl2 = `http://${username}:${options.proxyCredential}@${options.proxyHost ?? "127.0.0.1"}:${options.proxyPort}`;
      const child2 = spawn(standIn, [], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: env.PATH ?? "", HTTP_PROXY: proxyUrl2, NODE_EXTRA_CA_CERTS: options.caPath, PORT: String(port) }
      });
      const follower2 = followOutput(child2, push);
      cleanups.push(async () => void child2.kill("SIGKILL"));
      const origin2 = `http://127.0.0.1:${port}`;
      await waitReady(origin2, follower2);
      return { origin: origin2, logTail: () => [...lines], hasExited: follower2.ended, stop };
    }
    const docker = (args, extraEnv = {}, timeoutMs) => runDocker(args, { env: { ...baseEnv, ...extraEnv }, timeoutMs });
    await checkServerContainerHost({ image: options.image, env: baseEnv });
    await sweepOrphans({ env: baseEnv });
    const runId = options.runId ?? randomBytes4(4).toString("hex");
    const names = {
      network: `${NAME_PREFIX}net-${runId}`,
      probe: `${NAME_PREFIX}probe-${runId}`,
      relay: `${NAME_PREFIX}relay-${runId}`,
      container: `${NAME_PREFIX}${runId}`
    };
    const labels = ownerLabels();
    const created = await docker(["network", "create", "--internal", ...labels, names.network]);
    if (created.code !== 0) throw new ServerContainerError("notReady", "The internal Docker network could not be created.");
    cleanups.push(async () => void await docker(["network", "rm", names.network]));
    checkAborted();
    let probeAddress;
    try {
      probeAddress = await (options.resolveProbeHost ?? resolveIPv4)(PROBE_HOST);
    } catch {
      throw new ServerContainerError("notReady", `${PROBE_HOST} could not be resolved here, so the egress check cannot run. The container was not started.`);
    }
    if (!net.isIPv4(probeAddress)) throw new ServerContainerError("notReady", `${PROBE_HOST} did not resolve to an IPv4 address. The container was not started.`);
    const probe = await docker(["run", "--rm", "--name", names.probe, "--network", names.network, ...labels, "--entrypoint", NODE_BIN, options.image, "-e", PROBE_SCRIPT, probeAddress], {}, 6e4);
    checkAborted();
    let outcome;
    try {
      outcome = JSON.parse(probe.stdout.trim().split("\n").pop() ?? "");
    } catch {
      outcome = void 0;
    }
    if (!outcome || outcome.connect !== false || outcome.dns !== false) {
      throw new ServerContainerError("egressOpen", `The internal network is not closed: a direct connection or a DNS lookup of ${PROBE_HOST} got out, or the check did not finish. The container was not started.`);
    }
    const publishedPort = await pickPort();
    const relay = await docker([
      "run",
      "-d",
      "--rm",
      "--name",
      names.relay,
      ...labels,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-p",
      `127.0.0.1:${publishedPort}:${CONTAINER_PORT}`,
      "-e",
      `RELAY_MAP=${RELAY_PROXY_PORT}=host.docker.internal:${options.proxyPort},${CONTAINER_PORT}=${names.container}:${CONTAINER_PORT}`,
      "--entrypoint",
      NODE_BIN,
      options.image,
      "-e",
      RELAY_SCRIPT
    ]);
    if (relay.code !== 0) throw new ServerContainerError("notReady", "The relay container could not be started.");
    cleanups.push(async () => void await docker(["rm", "-f", names.relay]));
    checkAborted();
    const joined = await docker(["network", "connect", names.network, names.relay]);
    if (joined.code !== 0) throw new ServerContainerError("notReady", "The relay container could not join the internal network.");
    const proxyUrl = `http://${username}:${options.proxyCredential}@${names.relay}:${RELAY_PROXY_PORT}`;
    const started = await docker(
      [
        "run",
        "-d",
        "--rm",
        "--name",
        names.container,
        "--network",
        names.network,
        ...labels,
        "-e",
        "CONTAINER_CONFIG",
        "-e",
        "HTTP_PROXY",
        "-e",
        `NODE_EXTRA_CA_CERTS=${CA_MOUNT}`,
        "-v",
        `${options.caPath}:${CA_MOUNT}:ro`,
        options.image
      ],
      { CONTAINER_CONFIG: config, HTTP_PROXY: proxyUrl }
    );
    if (started.code !== 0) throw new ServerContainerError("notReady", `The server container could not be started.
${started.stderr.split("\n").map(scrub2).slice(-LOG_LINES).join("\n")}`);
    cleanups.push(async () => void await docker(["rm", "-f", names.container]));
    checkAborted();
    const child = spawn("docker", ["logs", "--follow", names.container], { shell: false, stdio: ["ignore", "pipe", "pipe"], env: baseEnv });
    const follower = followOutput(child, push);
    cleanups.push(async () => void child.kill("SIGKILL"));
    const origin = `http://127.0.0.1:${publishedPort}`;
    await waitReady(origin, follower);
    return { origin, logTail: () => [...lines], hasExited: follower.ended, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
function defaultServerContainerImage(version, env = process.env, arch = process.arch) {
  if (arch === "arm64") return imageTag(version);
  try {
    return baseImage(env);
  } catch (error) {
    throw new ServerContainerUsageError(error.message);
  }
}
async function describeImage(image, env) {
  if (isDigestReference(image)) return image;
  const inspected = await runDocker(["image", "inspect", "--format", "{{.Id}}", image], { env });
  const id = inspected.stdout.trim();
  return inspected.code === 0 && id ? `${image}@${id}` : image;
}

// packages/recorder/src/server-container/capture.ts
var TEST_UPSTREAM_ENV = "TAGREEVE_TEST_SERVER_CONTAINER_UPSTREAM";
var GOOGLE_ORIGIN = "https://www.googletagmanager.com";
var QUIET_MS = 1e3;
var MAX_QUIET_WAIT_MS = 5e3;
var FORWARD_TIMEOUT_MS = 3e4;
var STAND_IN_IMAGE = "stand-in";
function flattenHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === void 0) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}
function captureServerContainerCall(call, context) {
  const text2 = call.body.length === 0 ? null : call.body.toString("utf8");
  return {
    type: "request",
    id: newId("request"),
    runId: context.runId,
    stepId: context.stepId,
    t: call.receivedAt,
    method: call.method,
    url: redactSecretsInUrl(call.url),
    resourceType: "fetch",
    frameUrl: null,
    initiator: "serverContainer",
    headers: redactHeaders(flattenHeaders(call.headers)),
    postData: text2 === null ? null : redactSecretsInBody(text2).slice(0, MAX_POST_DATA),
    outcome: "stubbed",
    captured: "serverContainer"
  };
}
function serverContainerAnswer(request) {
  const stub = stubResponse({ resourceType: "fetch", headers: {}, url: request.url });
  return { status: stub.status, headers: stub.headers, ...stub.body ? { body: stub.body } : {} };
}
function resolveUpstreamOrigin(env, serverHosts) {
  const value = env[TEST_UPSTREAM_ENV];
  if (value === void 0 || value === "") return GOOGLE_ORIGIN;
  const reject = (reason) => {
    throw new ServerContainerUsageError(`${TEST_UPSTREAM_ENV} is not usable: ${reason}.`);
  };
  if (resolveStandInCommand(env, serverHosts) === void 0) reject(`it works only with ${TEST_COMMAND_ENV}`);
  let url;
  try {
    url = new URL(value);
  } catch {
    return reject("it must be an http:// origin");
  }
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) reject("it must be an http:// origin");
  if (!isLoopbackHost(url.hostname.replace(/^\[|\]$/g, ""))) reject("it must be a loopback origin");
  return url.origin;
}
function createForward(origin, doFetch = fetch) {
  return async (request) => {
    const matched = new URL(request.url);
    const response = await doFetch(`${origin}${matched.pathname}${matched.search}`, {
      method: request.method,
      headers: { accept: "*/*" },
      redirect: "manual",
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS)
    });
    const headers = {};
    for (const name of ["content-type", "cache-control"]) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return { status: response.status, headers, body: new Uint8Array(await response.arrayBuffer()) };
  };
}
async function waitForQuiet(lastCallAt, options = {}) {
  const { quietMs = QUIET_MS, maxMs = MAX_QUIET_WAIT_MS, now = Date.now, sleep = (ms) => new Promise((resolve4) => setTimeout(resolve4, ms)) } = options;
  const start = now();
  for (; ; ) {
    const at = now();
    const remaining2 = Math.max(lastCallAt(), start) + quietMs - at;
    if (remaining2 <= 0 || at >= start + maxMs) return;
    await sleep(Math.min(remaining2, start + maxMs - at));
  }
}
async function startServerContainerSession(options) {
  const env = options.env ?? process.env;
  const standIn = resolveStandInCommand(env, options.serverHosts) !== void 0;
  const upstream = resolveUpstreamOrigin(env, options.serverHosts);
  let ca;
  let proxy;
  let container;
  let recording = true;
  let captured = 0;
  let lastCallAt = 0;
  try {
    const listenHost = standIn ? "127.0.0.1" : await findProxyListenHost(env);
    ca = createRunCa(options.tempRoot ?? tmpdir2());
    proxy = await createRecordingProxy({
      host: listenHost,
      port: 0,
      ca,
      forward: createForward(upstream),
      handler: (call) => {
        const answer = serverContainerAnswer({ url: call.url });
        if (recording) {
          const request = captureServerContainerCall(call, { runId: options.runId, stepId: options.currentStepId() });
          const response = { type: "response", id: newId("response"), requestId: request.id, status: answer.status, setCookieNames: [] };
          captured += 1;
          lastCallAt = Date.now();
          options.onCapture(request, response);
        }
        return answer;
      }
    });
    container = await startServerContainer({
      configSource: options.configSource,
      proxyPort: proxy.port,
      proxyHost: listenHost,
      proxyCredential: proxy.credential,
      proxyUsername: proxy.username,
      caPath: ca.certPath,
      image: options.image,
      serverHosts: options.serverHosts,
      env,
      ...options.signal && { signal: options.signal }
    });
    const image = standIn ? STAND_IN_IMAGE : await describeImage(options.image, env);
    const startedAt = nodeNow();
    const running = { ca, proxy, container };
    return {
      origin: container.origin,
      image,
      startedAt,
      standIn,
      captured: () => captured,
      lastCallAt: () => lastCallAt,
      containerExited: () => running.container.hasExited(),
      stopRecording: () => {
        recording = false;
      },
      passThrough: () => running.proxy.passThrough(),
      refused: () => running.proxy.refused(),
      async stop() {
        await running.container.stop().catch(() => void 0);
        await running.proxy.close().catch(() => void 0);
        running.ca.close();
      }
    };
  } catch (error) {
    await container?.stop().catch(() => void 0);
    await proxy?.close().catch(() => void 0);
    ca?.close();
    throw error;
  }
}

// packages/recorder/src/server-container/link.ts
var MIN_VALUE_LENGTH = 8;
var CLIENT_ID_NAMES = /* @__PURE__ */ new Set(["cid", "client_id", "clientid", "fbp"]);
function eventIdOf(hit) {
  return hit.params.eventId ?? hit.params.eid ?? hit.params.event_id;
}
function collectNamed(value, names, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectNamed(item, names, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (names.has(key.toLowerCase()) && (typeof item === "string" || typeof item === "number")) out.add(String(item));
      else collectNamed(item, names, out);
    }
  }
}
function clientIdsOf(request) {
  const found = /* @__PURE__ */ new Set();
  const addQuery = (query) => {
    for (const [key, value] of query) if (CLIENT_ID_NAMES.has(key.toLowerCase().replace(/^ud\[(.*)\]$/, "$1"))) found.add(value);
  };
  try {
    addQuery(new URL(request.url).searchParams);
  } catch {
  }
  const body = request.postData;
  if (body) {
    try {
      collectNamed(JSON.parse(body), CLIENT_ID_NAMES, found);
    } catch {
      for (const line of body.split(/\r?\n/)) addQuery(new URLSearchParams(line));
    }
  }
  return new Set([...found].filter((v) => v.length >= MIN_VALUE_LENGTH));
}
function holdsIdentity(request, identity) {
  if (!identity?.email) return false;
  const email = identity.email.trim().toLowerCase();
  const values = [email, hashEmail(identity.email).hex].filter((v) => v.length >= MIN_VALUE_LENGTH);
  const raw = `${request.url}
${request.postData ?? ""}`;
  let decoded = "";
  try {
    decoded = decodeURIComponent(raw);
  } catch {
  }
  const text2 = `${raw}
${decoded}`.toLowerCase();
  return values.some((v) => text2.includes(v));
}
function sharedKind(server, browser) {
  if (server.eventId && server.eventId.length >= MIN_VALUE_LENGTH && server.eventId === browser.eventId) return "eventId";
  for (const id of server.clientIds) if (browser.clientIds.has(id)) return "clientId";
  if (server.identity && browser.identity) return "identity";
  return void 0;
}
function linkServerHits({ hits, requests, serverHosts, identity, inFlight }) {
  const byId = new Map(requests.map((r) => [r.id, r]));
  const facts = hits.map((hit) => {
    const request = byId.get(hit.requestId);
    const onServerHost = request ? isServerHostUrl(request.url, serverHosts) : false;
    return {
      hit,
      request,
      eventId: eventIdOf(hit),
      clientIds: request ? clientIdsOf(request) : /* @__PURE__ */ new Set(),
      identity: request ? holdsIdentity(request, identity) : false,
      onServerHost
    };
  });
  const isServer = (f) => f.request?.captured === "serverContainer";
  const browser = facts.filter((f) => !isServer(f));
  return facts.map((f) => {
    if (!isServer(f)) return f.hit;
    const exact = f.eventId === void 0 ? [] : browser.filter((b) => b.eventId === f.eventId && b.hit.event === f.hit.event);
    if (exact.length === 1) return { ...f.hit, via: { hitId: exact[0].hit.id, by: "eventId", confidence: "exact" } };
    const callAt = f.request?.t;
    const sameKey = callAt === void 0 || f.hit.event === null ? [] : browser.filter((b) => {
      if (!b.onServerHost || b.hit.event !== f.hit.event) return false;
      const sentAt = inFlight?.get(b.hit.requestId)?.sentAt ?? b.hit.t;
      if (sentAt > callAt) return false;
      for (const id of f.clientIds) if (b.clientIds.has(id)) return true;
      return false;
    });
    const only = sameKey.length === 1 ? sameKey[0] : void 0;
    const window2 = only && inFlight?.get(only.hit.requestId);
    if (only && window2 && callAt !== void 0 && callAt < window2.answeredAt) {
      return { ...f.hit, via: { hitId: only.hit.id, by: "clientId", confidence: "exact" } };
    }
    const earlier = browser.flatMap((b) => {
      const by = b.hit.t <= f.hit.t ? sharedKind(f, b) : void 0;
      return by ? [{ b, by }] : [];
    });
    const pool = earlier.some((c) => c.b.onServerHost) ? earlier.filter((c) => c.b.onServerHost) : earlier;
    const latest = pool.reduce((best, c) => best === void 0 || c.b.hit.t >= best.b.hit.t ? c : best, void 0);
    return latest ? { ...f.hit, via: { hitId: latest.b.hit.id, by: latest.by, confidence: "probable" } } : f.hit;
  });
}

// packages/recorder/src/unload.ts
var UNLOAD_BINDING = "__tagreeveUnloadSend";
var UNLOAD_FLUSH = "__tagreeveFlushUnload";
var unloadInitScript = `(() => {
  const binding = ${JSON.stringify(UNLOAD_BINDING)};
  const STORE = '__tagreeveUnloadQueue';
  let leaving = false;
  const isLeaving = () => leaving || document.visibilityState === 'hidden';
  addEventListener('pagehide', () => { leaving = true; }, true);
  addEventListener('beforeunload', () => { leaving = true; }, true);
  addEventListener('pageshow', () => { leaving = false; }, true);
  const load = () => {
    try { return JSON.parse(sessionStorage.getItem(STORE) || '[]'); } catch { return []; }
  };
  const save = (queue) => {
    try { sessionStorage.setItem(STORE, JSON.stringify(queue)); } catch {}
  };
  const deliver = (entry) => {
    const send = window[binding];
    if (typeof send !== 'function') return;
    send(entry).then(() => save(load().filter((e) => e.key !== entry.key)), () => {});
  };
  window.${UNLOAD_FLUSH} = () => { for (const entry of load()) deliver(entry); };
  const serialise = (body) => {
    if (typeof body === 'string') return { postData: body, headers: {} };
    if (body == null) return { postData: null, headers: {} };
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const boundary = '----tagreeve' + Math.random().toString(36).slice(2);
      let text = '';
      for (const [name, value] of body) {
        const file = typeof value === 'string' ? null : value;
        text += '--' + boundary + '\\r\\nContent-Disposition: form-data; name="' + name + '"' +
          (file ? '; filename="' + file.name + '"\\r\\nContent-Type: ' + (file.type || 'application/octet-stream') : '') +
          '\\r\\n\\r\\n' + (file ? '[file]' : value) + '\\r\\n';
      }
      return { postData: text + '--' + boundary + '--\\r\\n', headers: { 'content-type': 'multipart/form-data; boundary=' + boundary } };
    }
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return { postData: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' } };
    }
    return { postData: '[non-text body]', headers: {} };
  };
  const enqueue = (method, url, resourceType, body, contentType) => {
    const { postData, headers } = serialise(body);
    if (contentType && !(typeof FormData !== 'undefined' && body instanceof FormData)) headers['content-type'] = contentType;
    const entry = {
      key: Math.random().toString(36).slice(2) + Date.now().toString(36),
      method,
      url: new URL(String(url), location.href).href,
      resourceType,
      postData,
      headers,
      frameUrl: location.href,
      queuedAt: Date.now(),
    };
    save([...load(), entry]);
    deliver(entry);
  };
  const beacon = navigator.sendBeacon;
  navigator.sendBeacon = function (url, data) {
    if (!isLeaving()) return beacon.call(this, url, data);
    enqueue('POST', url, 'ping', data, null);
    return true;
  };
  // A Request body is a stream that cannot be read synchronously while the page unloads, so the constructor keeps the source body.
  const requestBodies = new WeakMap();
  const NativeRequest = window.Request;
  window.Request = new Proxy(NativeRequest, {
    construct(target, args, newTarget) {
      const request = Reflect.construct(target, args, newTarget);
      const init = args[1];
      const body = init && init.body != null ? init.body : args[0] instanceof NativeRequest ? requestBodies.get(args[0]) : undefined;
      if (body !== undefined) requestBodies.set(request, body);
      return request;
    },
  });
  const nativeClone = NativeRequest.prototype.clone;
  NativeRequest.prototype.clone = function () {
    const copy = nativeClone.call(this);
    if (requestBodies.has(this)) requestBodies.set(copy, requestBodies.get(this));
    return copy;
  };
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const keepalive = (init && init.keepalive) || (input instanceof Request && input.keepalive);
    if (!keepalive || !isLeaving()) return nativeFetch.apply(this, arguments);
    const url = input instanceof Request ? input.url : input;
    const method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
    let contentType = null;
    try { contentType = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined)).get('content-type'); } catch {}
    const body = init && init.body != null ? init.body : input instanceof Request ? requestBodies.get(input) ?? (input.body ? input.body : null) : null;
    enqueue(method.toUpperCase(), url, 'fetch', body, contentType);
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  window.${UNLOAD_FLUSH}();
})();`;

// packages/recorder/src/gtm-override.ts
import { getDomain as getDomain2 } from "tldts";
var GTM_ORIGIN = "https://www.googletagmanager.com";
var TEST_GTM_ORIGIN_ENV = "TAGREEVE_TEST_GTM_ORIGIN";
var CONTAINER = /^GTM-[A-Z0-9]+$/;
var AUTH = /^[A-Za-z0-9_-]+$/;
var PREVIEW = /^env-\d+$/;
var GtmOverrideError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "GtmOverrideError";
  }
};
function parseGtmOverride(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new GtmOverrideError("the GTM override must be a JSON object");
  const o = input;
  const known = /* @__PURE__ */ new Set(["container", "gtmAuth", "gtmPreview", "expectedTags", "loader"]);
  if (Object.keys(o).some((k) => !known.has(k))) {
    throw new GtmOverrideError("the GTM override has unknown fields. Allowed: container, gtmAuth, gtmPreview, expectedTags, loader");
  }
  if (typeof o.container !== "string" || !CONTAINER.test(o.container)) {
    throw new GtmOverrideError("container must be a string that matches ^GTM-[A-Z0-9]+$");
  }
  if (typeof o.gtmAuth !== "string" || !AUTH.test(o.gtmAuth)) {
    throw new GtmOverrideError('gtmAuth must be a non-empty string of letters, digits, "-" and "_"');
  }
  if (typeof o.gtmPreview !== "string" || !PREVIEW.test(o.gtmPreview)) {
    throw new GtmOverrideError("gtmPreview must look like env-12");
  }
  const expectedTags = [];
  if (o.expectedTags !== void 0) {
    if (!Array.isArray(o.expectedTags)) throw new GtmOverrideError("expectedTags must be a list");
    for (const [i, tag] of o.expectedTags.entries()) {
      const t = tag;
      if (typeof t !== "object" || t === null || typeof t.id !== "string" || t.id === "") {
        throw new GtmOverrideError(`expectedTags[${i}] needs a string id`);
      }
      if (t.name !== void 0 && t.name !== null && typeof t.name !== "string") {
        throw new GtmOverrideError(`expectedTags[${i}].name must be a string`);
      }
      expectedTags.push({ id: t.id, name: typeof t.name === "string" ? t.name : null });
    }
  }
  const result = { container: o.container, gtmAuth: o.gtmAuth, gtmPreview: o.gtmPreview, expectedTags };
  if (o.loader !== void 0) result.loader = parseLoader(o.loader);
  return result;
}
function parseLoader(input) {
  const bad = (m) => new GtmOverrideError(m);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw bad('loader must be an object like {"replace": "<script URL>"} or {"match": "<regex>"}');
  }
  const l = input;
  if (Object.keys(l).some((k) => k !== "replace" && k !== "match")) throw bad("loader has unknown fields. Allowed: replace, match");
  if (l.replace === void 0 && l.match === void 0) throw bad("loader needs replace (a script URL) or match (a regex)");
  const result = {};
  if (l.replace !== void 0) {
    if (typeof l.replace !== "string") throw bad("loader.replace must be a script URL");
    let url;
    try {
      url = new URL(l.replace);
    } catch {
      throw bad("loader.replace must be an absolute http or https URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw bad("loader.replace must be an absolute http or https URL");
    result.replace = url.href;
  }
  if (l.match !== void 0) {
    if (typeof l.match !== "string" || l.match === "") throw bad("loader.match must be a non-empty regular expression string");
    try {
      new RegExp(l.match);
    } catch {
      throw bad("loader.match is not a valid regular expression");
    }
    result.match = l.match;
  }
  return result;
}
function parseTestGtmOrigin(value) {
  if (value === void 0 || value === "") return void 0;
  const bad = () => new GtmOverrideError(`${TEST_GTM_ORIGIN_ENV} must be http://localhost, http://127.0.0.1 or http://[::1], with an optional port and nothing else`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw bad();
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "http:" || !loopback || /[?#@]/.test(value) || url.username || url.password || url.pathname !== "/") throw bad();
  return url.origin;
}
function isGtmJsUrl(url) {
  try {
    const u = new URL(url);
    return u.origin === GTM_ORIGIN && u.pathname === "/gtm.js";
  } catch {
    return false;
  }
}
function matchesGtmContainer(url, container) {
  return isGtmJsUrl(url) && new URL(url).searchParams.get("id") === container;
}
function matchesLoaderContainer(inner, container) {
  try {
    const u = new URL(inner);
    return u.pathname === "/gtm.js" && u.searchParams.get("id") === container;
  } catch {
    return false;
  }
}
function previewFetchUrl(override, origin = GTM_ORIGIN, pageParams) {
  const q = new URLSearchParams({ id: override.container, gtm_auth: override.gtmAuth, gtm_preview: override.gtmPreview, gtm_cookies_win: "x" });
  for (const name of ["l", "gtm_debug"]) {
    const value = pageParams?.get(name);
    if (value) q.set(name, value);
  }
  return `${origin}/gtm.js?${q.toString()}`;
}
function sameUrl(a, b) {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}
function matchGtmRequest(liveUrl, record, override) {
  if (matchesGtmContainer(liveUrl, override.container)) {
    return { applied: { way: "direct", url: record.url }, pageParams: new URL(liveUrl).searchParams };
  }
  const replaced = override.loader?.replace !== void 0 && sameUrl(liveUrl, override.loader.replace) || matchesLoaderPattern(liveUrl, record.resourceType, override.loader);
  if (replaced) {
    return {
      applied: { way: "replace", url: record.url, loses: "everything the loader does beyond fetching the container" },
      pageParams: new URL(liveUrl).searchParams
    };
  }
  const inner = unwrapStapeLoader({ ...record, url: liveUrl });
  if (inner && matchesLoaderContainer(inner.url, override.container)) {
    return {
      applied: { way: "loader", loader: "stape", url: record.url, loses: "nothing known; the loader script runs unchanged" },
      pageParams: new URL(inner.url).searchParams
    };
  }
  return void 0;
}
function testOriginUrl(requestUrl, origin) {
  const u = new URL(requestUrl);
  return `${origin}${u.pathname}${u.search}`;
}
function matchesLoaderPattern(url, resourceType, loader) {
  return resourceType === "script" && loader?.match !== void 0 && new RegExp(loader.match).test(url);
}
var GOOGLE_HOST = /(^|\.)(googletagmanager|google-analytics|googleadservices|doubleclick)\.(com|net)$/;
function isLoaderCandidate(url, resourceType) {
  if (resourceType !== "script") return false;
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && !GOOGLE_HOST.test(u.hostname) && u.pathname.endsWith(".js") && u.search !== "";
  } catch {
    return false;
  }
}
function isSameOrigin(url, site) {
  try {
    return new URL(url).origin === new URL(site).origin;
  } catch {
    return false;
  }
}
function isCrossOriginLoaderCandidate(url, resourceType, site) {
  return isLoaderCandidate(url, resourceType) && !isSameOrigin(url, site);
}
function isSniffableLoader(url, resourceType, site, firstPartyHosts = []) {
  return isCrossOriginLoaderCandidate(url, resourceType, site) && isLoaderHost(url, site, firstPartyHosts);
}
function isLoaderHost(url, site, firstPartyHosts = []) {
  try {
    const siteHost = new URL(site).hostname;
    const host = new URL(url).hostname;
    const loopback = (h) => ["localhost", "127.0.0.1", "[::1]"].includes(h);
    if (loopback(siteHost)) return loopback(host);
    if (hostMatches4(host, firstPartyHosts)) return true;
    const domain = getDomain2(siteHost, { allowPrivateDomains: true });
    return domain !== null && getDomain2(host, { allowPrivateDomains: true }) === domain;
  } catch {
    return false;
  }
}
function bodyHasContainer(body, container) {
  if (!body.includes("google_tag_manager")) return false;
  const escaped = container.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(body);
}
function withoutQueryValues(url) {
  try {
    const u = new URL(url);
    const keys = [...new Set(u.searchParams.keys())];
    return `${u.origin}${u.pathname}${keys.length ? `?${keys.map((k) => `${k}=\u2026`).join("&")}` : ""}`;
  } catch {
    return "(unparsable URL)";
  }
}
var REPLACE_OR_MATCH = '"loader": {"replace": "<script URL>"} or {"match": "<regex>"}';
function loaderHint(sniffed, seen) {
  const checked = new Set(sniffed.map(withoutQueryValues));
  const urls = [...new Set([...sniffed, ...seen].map(withoutQueryValues))].slice(0, 10);
  if (urls.length === 0) return `. If the page uses a custom loader, add ${REPLACE_OR_MATCH} to the override file`;
  const unchecked = urls.some((u) => !checked.has(u));
  const advice = unchecked ? "; to have the default way check a host automatically, add it to options.firstPartyHosts" : "";
  return `. Cross-origin scripts that were not the container (query values hidden): ${urls.join(", ")}. If one is your loader, add ${REPLACE_OR_MATCH} to the override file${advice}`;
}
function gtmFailureMessage(override, applied, fetchError, hint = "") {
  const { container } = override;
  const replace = override.loader?.replace;
  if (applied.length === 0) {
    return `no container request matched: the page never requested https://www.googletagmanager.com/gtm.js?id=${container}, a Stape-style loader for it${replace ? `, or ${replace}` : ""}, and no loader script held the container${hint}`;
  }
  const bad = applied.find((a) => a.status !== 200);
  if (bad) {
    if (bad.status === 0) return `the preview build of ${container} could not be fetched${fetchError ? `: ${fetchError}` : ""}`;
    const note = bad.status === 404 ? " (the environment may have no version)" : "";
    return `the preview build of ${container} returned status ${bad.status}${note}`;
  }
  if (replace && !applied.some((a) => a.way === "replace")) return `loader.replace was set but the page never requested ${replace}`;
  return void 0;
}

// packages/recorder/src/recorder.ts
var TAGREEVE_VERSION = readVersion();
var REDACTED_VALUE = "[redacted]";
function redactRefererQuery(headers) {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, /^(?:referer|origin)$/i.test(k) ? redactQuery(v) : v]));
}
function redactQuery(url) {
  try {
    const parsed = new URL(url);
    for (const key of new Set(parsed.searchParams.keys())) parsed.searchParams.set(key, REDACTED_VALUE);
    return parsed.href;
  } catch {
    return url;
  }
}
var MAX_FOLLOWED_HOPS = 10;
function isTopLevelFrameRequest(request) {
  try {
    return request.frame().parentFrame() === null;
  } catch {
    return false;
  }
}
function frameUrlOf(request) {
  try {
    return request.frame().url();
  } catch {
    return null;
  }
}
function initiatorOf(request) {
  if (request.redirectedFrom()) return "redirect";
  return request.serviceWorker() ? "serviceWorker" : null;
}
var Recorder = class _Recorder {
  constructor(options, browser, context, gtmOverride, testGtmOrigin, netLogPath, removeNetLogDir) {
    this.options = options;
    this.browser = browser;
    this.context = context;
    this.gtmOverride = gtmOverride;
    this.testGtmOrigin = testGtmOrigin;
    this.netLogPath = netLogPath;
    this.removeNetLogDir = removeNetLogDir;
    this.trackers = [...options.trackerList ?? [], ...trackerList];
  }
  options;
  browser;
  context;
  gtmOverride;
  testGtmOrigin;
  netLogPath;
  removeNetLogDir;
  runId = newId("run");
  coverage;
  consent;
  run;
  clockOffset = 0;
  selfTestPrefix = "";
  collectorHandler = () => void 0;
  requests = /* @__PURE__ */ new Map();
  extraRequests = [];
  unloadKeys = /* @__PURE__ */ new Set();
  routed = /* @__PURE__ */ new Set();
  /** Memory only: never a record field. */
  containerFlights = /* @__PURE__ */ new Map();
  handedToChromium = /* @__PURE__ */ new Set();
  redirectHeaderWithoutRedirect = /* @__PURE__ */ new Set();
  selfRecorded = /* @__PURE__ */ new WeakSet();
  responses = [];
  dataLayerEvents = [];
  mainFrameEventIds = /* @__PURE__ */ new Set();
  eventFrames = /* @__PURE__ */ new Map();
  frameNumbers = /* @__PURE__ */ new WeakMap();
  frameNavigations = /* @__PURE__ */ new WeakMap();
  frameCount = 0;
  navigationSeen = /* @__PURE__ */ new WeakSet();
  requestFrameIds = /* @__PURE__ */ new Map();
  collectorReports = [];
  pending = /* @__PURE__ */ new Set();
  steps = [];
  checkpoints = [];
  bannerEvents = [];
  currentStepId = null;
  handoffWindows = [];
  handoff = new HandoffGate();
  closed = false;
  fetchErrors = [];
  loaderCandidates = /* @__PURE__ */ new Map();
  crossOriginScripts = /* @__PURE__ */ new Set();
  trackers;
  stubRecorded = /* @__PURE__ */ new Set();
  navigations = [];
  navigationWindows = new NavigationWindows();
  session;
  sessionStopped;
  removeSignalHandlers;
  /** Why the container did not start. Set by `launch`; `recordScenario` ends the run when it is. */
  containerFailure;
  static async launch(options) {
    const testGtmOrigin = parseTestGtmOrigin(process.env[TEST_GTM_ORIGIN_ENV]);
    const gtmOverride = options.gtmOverride === void 0 ? void 0 : parseGtmOverride(options.gtmOverride);
    if (options.networkMode === "server" && !options.serverHosts?.length) {
      throw new Error('networkMode "server" needs serverHosts: the hosts whose requests pass through.');
    }
    if (options.serverContainer && options.networkMode !== "server") {
      throw new Error('serverContainer needs networkMode "server": the hits to the serverHosts are what the container receives.');
    }
    if (options.netLog && options.networkMode !== "live") {
      throw new Error('netLog needs networkMode "live": in stub mode the requests a frame sends while it unloads would leave the machine.');
    }
    let netLogPath;
    let removeNetLogDir;
    if (options.netLog) {
      const dir = await mkdtemp2(join5(tmpdir3(), "tagreeve-netlog-"));
      netLogPath = join5(dir, "netlog.json");
      removeNetLogDir = watchNetLogDir(dir);
    }
    let browser;
    try {
      browser = await chromium.launch({
        channel: "chromium",
        headless: !options.headed,
        ...netLogPath ? { args: [`--log-net-log=${netLogPath}`] } : {},
        // Playwright's handlers exit the process once the browser is closed, before the containers are removed.
        ...options.serverContainer ? { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false } : {}
      });
    } catch (error) {
      removeNetLogDir?.();
      throw error;
    }
    try {
      const context = await browser.newContext({
        userAgent: options.userAgentOverride ?? chromeUserAgent(browser.version()),
        serviceWorkers: options.serviceWorkers ?? "allow",
        ...options.viewport ? { viewport: options.viewport } : {}
      });
      const recorder = new _Recorder(options, browser, context, gtmOverride, testGtmOrigin, netLogPath, removeNetLogDir);
      await recorder.init();
      await recorder.startContainer();
      return recorder;
    } catch (error) {
      try {
        await browser.close();
      } catch {
      } finally {
        removeNetLogDir?.();
      }
      throw error;
    }
  }
  async init() {
    const { context } = this;
    await context.route("**/*", (route) => this.handleRoute(route));
    await routeCollector(context, () => this.collectorHandler, nodeNow);
    const selfTest = await runSelfTest(context, (h) => this.collectorHandler = h);
    this.coverage = selfTest.coverage;
    this.clockOffset = selfTest.clockOffset;
    this.selfTestPrefix = selfTest.sourcePrefix;
    this.collectorHandler = (parsed, body, t) => this.storeReport(parsed, body, t);
    this.run = {
      type: "run",
      id: this.runId,
      scenario: this.options.scenario ?? "visit",
      site: this.options.site,
      startedAt: nodeNow(),
      recordSchemaVersion: RECORD_SCHEMA_VERSION,
      pingwrightVersion: TAGREEVE_VERSION,
      browser: { name: "chromium", version: this.browser.version() },
      networkMode: this.options.networkMode,
      gtmOverride: this.gtmOverride ? {
        container: this.gtmOverride.container,
        gtmPreview: this.gtmOverride.gtmPreview,
        gtmAuth: "[redacted]",
        expectedTags: this.gtmOverride.expectedTags ?? [],
        applied: []
      } : null,
      ...this.testGtmOrigin ? { testGtmOrigin: this.testGtmOrigin } : {},
      containerVersions: {},
      identity: null,
      coverage: selfTest.coverage,
      ...this.options.graceWindowMs !== void 0 ? { graceWindowMs: this.options.graceWindowMs } : {},
      ...this.options.viewport ? { viewport: { ...this.options.viewport } } : {},
      ...loopbackIsHostedForTests() ? { testLoopbackHosted: true } : {}
    };
    await context.exposeBinding(DATALAYER_BINDING, (source, payload) => {
      const isMain = source.frame === source.page.mainFrame();
      this.frameDocumentId(source.frame);
      const event = dataLayerEventFromPayload(payload, this.runId, this.clockOffset, { main: isMain, n: this.frameNumbers.get(source.frame) });
      if (!event) return;
      this.dataLayerEvents.push({ ...event, stepId: this.currentStepId });
      if (isMain) this.mainFrameEventIds.add(event.id);
      else this.eventFrames.set(event.id, { id: this.frameDocumentId(source.frame), url: source.frame.url() });
    });
    await context.addInitScript(dataLayerInitScript);
    this.consent = await installConsent(context, this.options.autoconsent);
    if (this.options.networkMode !== "live") {
      await context.exposeBinding(UNLOAD_BINDING, (source, payload) => this.recordUnloadSend(payload, this.frameDocumentId(source.frame)));
      await context.addInitScript(unloadInitScript);
    }
    if (this.options.handoffOverlay) {
      await context.exposeBinding(HANDOFF_STATE_BINDING, (source) => source.frame === source.page.mainFrame() ? this.handoff.state() : { waiting: false, text: "" });
      await context.exposeBinding(HANDOFF_DONE_BINDING, (source, nonce) => {
        if (source.frame === source.page.mainFrame()) this.handoff.done(nonce);
      });
      await context.addInitScript(handoffOverlayScript(this.handoff.nonce));
    }
    context.on("request", (request) => void this.recordFor(request));
    context.on("requestfailed", (request) => {
      const record = this.recordFor(request);
      if (!record) return;
      if (record.outcome === "passed") record.outcome = "failed";
      const errorText = request.failure()?.errorText;
      if (errorText) record.failure = errorText;
    });
    context.on("response", (response) => this.track(this.recordResponse(response)));
  }
  async startContainer() {
    const { serverContainer } = this.options;
    if (!serverContainer) return;
    const abort = new AbortController();
    const starting = startServerContainerSession({
      configSource: serverContainer.configSource,
      image: serverContainer.image,
      serverHosts: this.options.serverHosts ?? [],
      runId: this.runId,
      signal: abort.signal,
      currentStepId: () => this.currentStepId,
      onCapture: (request, response) => {
        this.extraRequests.push(this.redactForHandoff(request, request.t, QUIET_MS));
        this.responses.push(response);
      }
    });
    this.removeSignalHandlers = onTerminate(async () => {
      abort.abort();
      await this.browser.close().catch(() => void 0);
      const started = await starting.catch(() => void 0);
      if (started) this.session ??= started;
      await this.stopSession();
    });
    try {
      this.session = await starting;
    } catch (error) {
      this.removeSignalHandlers();
      this.removeSignalHandlers = void 0;
      if (!(error instanceof ServerContainerError)) throw error;
      this.containerFailure = { errorClass: error.errorClass, message: error.message };
      return;
    }
    if (this.session.standIn) this.run.testServerContainer = true;
  }
  /** Stops the container, the proxy and the CA once. Safe to call from `close` and from a signal. */
  stopSession() {
    this.removeSignalHandlers?.();
    this.removeSignalHandlers = void 0;
    this.sessionStopped ??= (async () => {
      await this.session?.stop();
    })();
    return this.sessionStopped;
  }
  storeReport(parsed, body, t) {
    if (this.closed) return;
    if (parsed.ok && parsed.source.startsWith(this.selfTestPrefix)) return;
    if (parsed.ok) {
      this.collectorReports.push({
        type: "collectorReport",
        id: newId("collectorReport"),
        runId: this.runId,
        t,
        source: parsed.source,
        payload: parsed.payload
      });
    } else {
      this.collectorReports.push({
        type: "invalidReport",
        id: newId("collectorReport"),
        runId: this.runId,
        t,
        error: parsed.error,
        body: body.slice(0, MAX_POST_DATA)
      });
    }
  }
  track(promise) {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
  }
  /** A frame document is the frame plus how many navigation requests the frame has started. Held in memory only. */
  frameDocumentId(frame) {
    let number = this.frameNumbers.get(frame);
    if (number === void 0) {
      number = this.frameCount++;
      this.frameNumbers.set(frame, number);
    }
    return `${number}.${this.frameNavigations.get(frame) ?? 0}`;
  }
  countNavigation(request) {
    if (this.navigationSeen.has(request) || !request.isNavigationRequest()) return;
    this.navigationSeen.add(request);
    try {
      const frame = request.frame();
      this.frameNavigations.set(frame, (this.frameNavigations.get(frame) ?? 0) + 1);
    } catch {
    }
  }
  requestFrameId(request) {
    try {
      return this.frameDocumentId(request.frame());
    } catch {
      return null;
    }
  }
  /** Created on first sight, from either the request event or the route handler, whichever comes first. */
  recordFor(request) {
    const existing = this.requests.get(request);
    if (existing) return existing;
    this.countNavigation(request);
    const url = request.url();
    if (!/^https?:/.test(url) || url.startsWith(COLLECTOR_ORIGIN) || url.startsWith(SELFTEST_ORIGIN)) return void 0;
    const body = request.postData();
    let record = {
      type: "request",
      id: newId("request"),
      runId: this.runId,
      stepId: this.currentStepId,
      t: nodeNow(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      frameUrl: frameUrlOf(request),
      initiator: initiatorOf(request),
      headers: redactHeaders(request.headers()),
      postData: body === null ? null : body.slice(0, MAX_POST_DATA),
      outcome: "passed"
    };
    record = this.redactForHandoff(record);
    this.requests.set(request, record);
    const frameId = this.requestFrameId(request);
    if (frameId !== null) this.requestFrameIds.set(record.id, frameId);
    if (request.isNavigationRequest() && isTopLevelFrameRequest(request)) {
      this.navigationWindows.start(request, record.t);
      this.navigations.push(record.t);
    }
    return record;
  }
  /** A person is typing during a handoff, so only requests that decode as tracking hits keep their body and query. */
  redactForHandoff(record, at = Date.now(), graceMs = 0) {
    if (!this.duringHandoff(at, graceMs)) return record;
    if (isCollectionEndpoint(record, this.trackers) || isKnownVendorCollection(record) || decodeRequest(record, void 0, this.trackers).length > 0) return record;
    return {
      ...record,
      url: redactQuery(record.url),
      frameUrl: record.frameUrl === null ? null : redactQuery(record.frameUrl),
      headers: redactRefererQuery(record.headers),
      postData: record.postData === null ? null : REDACTED_VALUE,
      redacted: "handoff"
    };
  }
  duringHandoff(at, graceMs) {
    return this.handoffWindows.some((w) => at >= w.from && (w.to === null || at <= w.to + graceMs));
  }
  /** Requests sent while a handoff is active, including unload sends queued then and replayed later, are stored without their typed values. */
  setHandoff(active) {
    if (active) this.handoffWindows.push({ from: Date.now(), to: null });
    else {
      const open2 = this.handoffWindows.find((w) => w.to === null && !w.hold);
      if (open2) open2.to = Date.now();
    }
  }
  /** Opens a redaction window that setHandoff(false) never closes. It lasts until the run ends. */
  holdRedaction() {
    this.handoffWindows.push({ from: Date.now(), to: null, hold: true });
  }
  recordUnloadSend(payload, frameId) {
    if (this.closed || this.unloadKeys.has(payload.key)) return;
    this.unloadKeys.add(payload.key);
    let record = {
      type: "request",
      id: newId("request"),
      runId: this.runId,
      stepId: this.currentStepId,
      t: nodeNow(),
      method: payload.method,
      url: payload.url,
      resourceType: payload.resourceType,
      frameUrl: payload.frameUrl,
      initiator: "unload",
      headers: redactHeaders(payload.headers ?? {}),
      postData: payload.postData === null ? null : payload.postData.slice(0, MAX_POST_DATA),
      outcome: "stubbed"
    };
    record = this.redactForHandoff(record, payload.queuedAt);
    this.requestFrameIds.set(record.id, frameId);
    this.routed.add(record.id);
    this.extraRequests.push(record);
    this.responses.push({ type: "response", id: newId("response"), requestId: record.id, status: 204, setCookieNames: [] });
  }
  async readNetLog() {
    if (!this.netLogPath) return void 0;
    try {
      return parseNetLog(await readFile(this.netLogPath, "utf8"));
    } catch {
      return void 0;
    } finally {
      this.removeNetLogDir?.();
    }
  }
  async recordResponse(response) {
    if (this.selfRecorded.has(response.request())) return;
    const record = this.recordFor(response.request());
    if (!record) return;
    this.navigationWindows.respond(response.request(), nodeNow());
    if (this.stubRecorded.has(record.id)) return;
    let setCookieNames = [];
    try {
      if (response.status() !== 201 && (response.status() < 300 || response.status() >= 400) && await response.headerValue("location") !== null) this.redirectHeaderWithoutRedirect.add(record.id);
      setCookieNames = (await response.headerValues("set-cookie")).flatMap(setCookieNameOf);
    } catch {
    }
    this.responses.push({
      type: "response",
      id: newId("response"),
      requestId: record.id,
      status: response.status(),
      setCookieNames
    });
  }
  async handleRoute(route) {
    const record = this.recordFor(route.request());
    if (record) this.routed.add(record.id);
    if (record && await this.routeGtm(route, record)) return;
    if (record && this.session && isServerContainerRequest(record, this.options.serverHosts ?? [])) {
      await this.routeToContainer(route, record, this.session.origin);
      return;
    }
    if (record && this.options.networkMode !== "live" && this.isStubbedCollection(record)) {
      record.outcome = "stubbed";
      const stub = stubResponse(record);
      this.stubRecorded.add(record.id);
      this.recordResponseFor(record, stub.status, setCookieNamesOf(stub.headers));
      await route.fulfill({ status: stub.status, headers: stub.headers, body: stub.body });
      return;
    }
    if (record && this.options.networkMode !== "live") {
      await this.routeWithRedirectCheck(route, record);
      return;
    }
    if (record) this.handedToChromium.add(record.id);
    await route.continue();
  }
  /** Answers a non-load request to a `serverHosts` host with the local container's response. It never reaches the remote host. */
  async routeToContainer(route, record, origin) {
    const original = route.request();
    const live = new URL(original.url());
    const { host: _host, ...headers } = await original.allHeaders();
    void _host;
    record.outcome = "stubbed";
    this.stubRecorded.add(record.id);
    let client;
    try {
      client = await playwrightRequest.newContext();
      const sentAt = nodeNow();
      const response = await client.fetch(`${origin}${live.pathname}${live.search}`, {
        method: original.method(),
        headers,
        data: original.postDataBuffer() ?? void 0,
        maxRedirects: 0
      });
      this.containerFlights.set(record.id, { sentAt, answeredAt: nodeNow() });
      this.recordApiResponse(record, response);
      await route.fulfill({ response });
    } catch (error) {
      record.outcome = "failed";
      record.failure = abortCode(error);
      await route.abort(abortCode(error));
    } finally {
      await client?.dispose().catch(() => void 0);
    }
  }
  isStubbedCollection(record) {
    return isStubbedCollection(record, {
      networkMode: this.options.networkMode,
      serverHosts: this.options.serverHosts,
      trackers: this.trackers
    });
  }
  /** Answers a gtm.js request, directly or through a loader, with the preview build, or from the test origin. Returns false when the request is not one of those. */
  async routeGtm(route, record) {
    const { gtmOverride, testGtmOrigin } = this;
    const liveUrl = route.request().url();
    let match = gtmOverride === void 0 ? void 0 : matchGtmRequest(liveUrl, record, gtmOverride);
    if (!match && gtmOverride && isCrossOriginLoaderCandidate(liveUrl, record.resourceType, this.options.site)) this.crossOriginScripts.add(liveUrl);
    if (!match && gtmOverride && !gtmOverride.loader && this.isUnseenLoaderCandidate(liveUrl, record)) {
      const sniff = await this.sniffLoader(route, liveUrl, gtmOverride.container);
      if (!sniff) return false;
      if (!sniff.matched) {
        await route.fulfill({ response: sniff.response });
        return true;
      }
      match = {
        applied: { way: "loader", loader: "stape", url: record.url, loses: "everything the loader does beyond fetching the container" },
        pageParams: new URL(liveUrl).searchParams
      };
    }
    const applied = match?.applied;
    if (!applied && !(testGtmOrigin && isGtmJsUrl(liveUrl))) return false;
    const target = applied ? previewFetchUrl(gtmOverride, testGtmOrigin, match.pageParams) : testOriginUrl(liveUrl, testGtmOrigin);
    let response;
    try {
      response = await route.fetch({ url: target });
    } catch (error) {
      if (applied) this.run.gtmOverride.applied.push({ ...applied, status: 0 });
      this.fetchErrors.push(error instanceof Error ? error.message : String(error));
      await route.abort("failed");
      return true;
    }
    if (applied) this.run.gtmOverride.applied.push({ ...applied, status: response.status() });
    await route.fulfill({ response });
    return true;
  }
  isUnseenLoaderCandidate(liveUrl, record) {
    if (this.loaderCandidates.get(liveUrl) === false) return false;
    if (!isSniffableLoader(liveUrl, record.resourceType, this.options.site, this.options.firstPartyHosts)) return false;
    return !isCollectionEndpoint(record, this.trackers) && !isKnownVendorCollection(record);
  }
  /** Fetches a script that may be a Stape loader and checks whether it is the container. Returns undefined when the fetch fails. A redirect is handed back unchanged, so Chromium follows it and the recorder sees every hop without a second request. */
  async sniffLoader(route, liveUrl, container) {
    try {
      const response = await route.fetch({ maxRedirects: 0 });
      if (response.status() >= 300 && response.status() < 400) {
        this.loaderCandidates.set(liveUrl, false);
        return { response, matched: false };
      }
      const matched = response.ok() && bodyHasContainer(await response.text(), container);
      this.loaderCandidates.set(liveUrl, matched);
      return { response, matched };
    } catch {
      return void 0;
    }
  }
  recordServerContainer(requests, hits, counts, flags2) {
    const options = this.options.serverContainer;
    if (!options) return;
    const fromContainer = new Set(requests.filter((r) => r.captured === "serverContainer").map((r) => r.id));
    const failure = this.containerFailure;
    this.run.serverContainer = {
      image: this.session?.image ?? options.image,
      startedAt: this.session?.startedAt ?? nodeNow(),
      requests: fromContainer.size,
      passThrough: counts?.passThrough ?? { serverjs: 0, config: 0, destination: 0 },
      refused: counts?.refused ?? 0,
      unlinked: hits.filter((h) => fromContainer.has(h.requestId) && h.via === void 0).length,
      ...failure ? { error: failure.errorClass } : {}
    };
    if (failure) {
      flags2.push({ type: "flag", id: newId("flag"), runId: this.runId, kind: "serverContainerFailed", recordIds: [], detail: `The server container did not run: ${failure.errorClass}.` });
    }
  }
  gtmFailure() {
    const applied = this.run.gtmOverride?.applied;
    if (!applied || !this.gtmOverride) return void 0;
    const hint = applied.length === 0 ? loaderHint([...this.loaderCandidates.keys()], [...this.crossOriginScripts]) : "";
    return gtmFailureMessage(this.gtmOverride, applied, this.fetchErrors[0], hint);
  }
  /**
   * Playwright never routes the hops of a redirect chain, so a redirect to a collection endpoint would reach the
   * network in stub mode. Only same-origin, non-navigation requests of the top-level frame are fetched here, and
   * hops are followed only while they stay on that origin: Playwright's request client would otherwise send
   * cookies and Authorization across origins and keep Set-Cookie where Chromium would not.
   * Playwright's request client keeps its own cookie jar, which matches Chromium's rules only for the top-level
   * frame (a sandboxed child frame has an opaque origin, so its requests are cross-site for cookies), and a
   * fulfilled document loses its loopback address space. Everything else goes to Chromium untouched, and a
   * redirect from it to a collection endpoint can still leave the machine (flagged `stubBypass`). The first
   * collection hop gets the stub. A fetch with credentials: 'omit' cannot be seen from Playwright, so it is fetched
   * with the jar cookies (design §5.3).
   */
  async routeWithRedirectCheck(route, first) {
    const original = route.request();
    if (!this.isFetchableRequest(original)) {
      this.handedToChromium.add(first.id);
      await route.continue();
      return;
    }
    let method = first.method;
    let postData = original.postDataBuffer();
    let headers = original.headers();
    let url = first.url;
    let response;
    let current = first;
    this.selfRecorded.add(original);
    try {
      response = await route.fetch({ maxRedirects: 0, timeout: 0 });
    } catch (error) {
      await route.abort(abortCode(error));
      return;
    }
    this.recordApiResponse(current, response);
    for (let hops = 0; hops <= MAX_FOLLOWED_HOPS; hops++) {
      const location = response.headers().location;
      const status = response.status();
      if (!location || status < 300 || status >= 400) break;
      let next = null;
      try {
        next = new URL(location, url);
      } catch {
      }
      if (!next || !/^https?:$/.test(next.protocol)) break;
      const toGet = [301, 302].includes(status) ? method === "POST" : status === 303 && method !== "HEAD";
      if (toGet) {
        if (method !== "GET") headers = withoutMethodChangeHeaders(headers);
        method = "GET";
        postData = null;
      }
      const hop = this.hopRecord(first, next.href, method, headers, postData);
      if (this.isStubbedCollection(hop)) {
        hop.outcome = "stubbed";
        this.routed.add(hop.id);
        this.extraRequests.push(hop);
        const stub = stubResponse(first);
        this.recordResponseFor(hop, stub.status, setCookieNamesOf(stub.headers));
        await route.fulfill({ status: stub.status, headers: stub.headers, body: stub.body });
        return;
      }
      if (hops === MAX_FOLLOWED_HOPS || !this.isSameOriginUrl(next.href)) break;
      this.extraRequests.push(hop);
      this.routed.add(hop.id);
      current = hop;
      try {
        response = postData === null ? await this.context.request.fetch(next.href, { method, headers, maxRedirects: 0, timeout: 0 }) : await route.fetch({ url: next.href, method, headers, postData, maxRedirects: 0, timeout: 0 });
      } catch (error) {
        await route.abort(abortCode(error));
        return;
      }
      url = next.href;
      this.recordApiResponse(current, response);
    }
    const isRedirect = response.status() >= 300 && response.status() < 400;
    await route.fulfill(method !== first.method && isRedirect ? { response, status: 303 } : { response });
  }
  isSameOriginUrl(url) {
    try {
      return new URL(url).origin === new URL(this.options.site).origin;
    } catch {
      return false;
    }
  }
  isFetchableRequest(request) {
    if (request.isNavigationRequest() || !isTopLevelFrameRequest(request)) return false;
    const frame = frameUrlOf(request);
    if (frame === null || !this.isSameOriginUrl(request.url())) return false;
    return frame === "about:blank" || this.isSameOriginUrl(frame);
  }
  hopRecord(first, url, method, headers, postData) {
    const body = postData === null ? null : postData.toString("utf8").slice(0, MAX_POST_DATA);
    const record = this.redactForHandoff({
      ...first,
      id: newId("request"),
      t: nodeNow(),
      method,
      url,
      initiator: "redirect",
      headers: redactHeaders(headers),
      postData: body,
      outcome: "passed"
    });
    const frameId = this.requestFrameIds.get(first.id);
    if (frameId !== void 0) this.requestFrameIds.set(record.id, frameId);
    return record;
  }
  recordResponseFor(record, status, setCookieNames) {
    this.responses.push({ type: "response", id: newId("response"), requestId: record.id, status, setCookieNames });
  }
  recordApiResponse(record, response) {
    const setCookieNames = response.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").flatMap((h) => setCookieNameOf(h.value));
    this.recordResponseFor(record, response.status(), setCookieNames);
  }
  get site() {
    return this.options.site;
  }
  setIdentity(identity) {
    this.run.identity = { ...identity };
    this.run.identitySeed = identity.seed;
  }
  /** Requests, hits and dataLayer events recorded from now on carry this step's id, until the next step begins. */
  beginStep(label, index) {
    const step = { type: "step", id: newId("step"), runId: this.runId, index, label, startedAt: nodeNow(), endedAt: null };
    this.steps.push(step);
    this.currentStepId = step.id;
    return step;
  }
  /** What the recorder has seen so far while the step ran. */
  stepActivity(step) {
    const requests = [...this.requests.values(), ...this.extraRequests].filter((r) => r.stepId === step.id);
    const ids = new Set(requests.map((r) => r.id));
    return {
      requests,
      responses: this.responses.filter((r) => ids.has(r.requestId)),
      dataLayerEvents: this.dataLayerEvents.filter((e) => e.stepId === step.id)
    };
  }
  endStep(step, error) {
    step.endedAt = nodeNow();
    if (error !== void 0) step.error = error;
  }
  /** Keeps a banner action for the run's epochs. Only actions that were carried out count. Banner times are page-clock readings. */
  recordBanner(result) {
    if (result.result !== "ok" || result.action === "none") return;
    this.bannerEvents.push({
      t: pageTimeToEpoch(result.t, this.clockOffset),
      tEnd: pageTimeToEpoch(result.tEnd, this.clockOffset),
      action: result.action
    });
  }
  buildConsentEpochs() {
    const mainFrameEvents = this.dataLayerEvents.filter((e) => this.mainFrameEventIds.has(e.id));
    const drafts = buildEpochs(this.bannerEvents, consentModeChanges(mainFrameEvents, Math.min(...this.bannerEvents.map((b) => b.t))), { startT: this.run.startedAt });
    return drafts.map((epoch) => ({
      type: "consentEpoch",
      id: newId("consentEpoch"),
      runId: this.runId,
      ...epoch
    }));
  }
  async checkpoint(label, step) {
    const host = new URL(this.options.site).hostname;
    const cookies = (await this.context.cookies()).map((c) => {
      const domain = c.domain.replace(/^\./, "");
      return {
        name: c.name,
        domain: c.domain,
        expires: c.expires > 0 ? c.expires * 1e3 : null,
        firstParty: host === domain || host.endsWith(`.${domain}`)
      };
    });
    const checkpoint = {
      type: "checkpoint",
      id: newId("checkpoint"),
      runId: this.runId,
      stepId: step?.id ?? this.currentStepId,
      label,
      t: nodeNow(),
      consentState: null,
      cookies
    };
    this.checkpoints.push(checkpoint);
    return checkpoint;
  }
  async visit(url) {
    const page2 = await this.context.newPage();
    await page2.goto(url, { waitUntil: "load" });
    return page2;
  }
  async wait(ms) {
    await new Promise((resolve4) => setTimeout(resolve4, ms));
  }
  async flushUnloadQueues() {
    const script = `window.${UNLOAD_FLUSH}?.()`;
    for (const page2 of this.context.pages()) {
      await page2.evaluate(script).catch(() => void 0);
    }
    await this.wait(50);
  }
  noteContainerExit() {
    if (this.session?.containerExited() && !this.containerFailure) {
      this.containerFailure = { errorClass: "exited", message: "The server container ended during the run." };
    }
  }
  /** Closes the browser, decodes the requests and writes `<outDir>/<runId>.jsonl`. */
  async close() {
    const closeStartedAt = nodeNow();
    this.noteContainerExit();
    if (this.options.networkMode !== "live") await this.flushUnloadQueues();
    if (this.session) {
      const session = this.session;
      await waitForQuiet(() => session.lastCallAt());
      session.stopRecording();
      this.noteContainerExit();
    }
    this.closed = true;
    try {
      await this.browser.close();
    } catch (error) {
      this.removeNetLogDir?.();
      await this.stopSession();
      throw error;
    }
    await Promise.allSettled([...this.pending]);
    const containerCounts = this.session && { passThrough: this.session.passThrough(), refused: this.session.refused() };
    await this.stopSession();
    const netLog = await this.readNetLog();
    if (netLog) {
      const { requests: added, responses } = mergeNetLog(netLog, [...this.requests.values(), ...this.extraRequests], this.steps, this.trackers, this.runId, this.navigationWindows.list());
      this.extraRequests.push(...added);
      this.responses.push(...responses);
    }
    const requests = [...this.requests.values(), ...this.extraRequests];
    let hits = requests.flatMap((r) => decodeRequest(r, void 0, this.trackers));
    if (this.session) hits = linkServerHits({ hits, requests, serverHosts: this.options.serverHosts ?? [], identity: this.run.identity, inFlight: this.containerFlights });
    const flags2 = buildFlags({
      runId: this.runId,
      networkMode: this.options.networkMode,
      siteUrl: this.options.site,
      firstPartyHosts: this.options.firstPartyHosts,
      platformHosts: this.options.platformHosts,
      trackers: this.trackers,
      requests,
      hits,
      identity: this.run.identity,
      routedRequestIds: this.routed,
      responses: this.responses,
      handedToChromium: this.handedToChromium,
      redirectHeaderWithoutRedirect: this.redirectHeaderWithoutRedirect
    });
    if (!this.netLogPath) {
      const embedded = this.dataLayerEvents.filter((e) => !this.mainFrameEventIds.has(e.id));
      flags2.push(...buildUnloadGapFlags({ runId: this.runId, networkMode: this.options.networkMode, events: embedded, hits, navigations: this.navigations, runEnd: closeStartedAt, eventFrames: this.eventFrames, requestFrames: new Map(requests.map((r) => [r.id, { id: this.requestFrameIds.get(r.id) ?? null, url: r.frameUrl }])), ignore: this.options.unloadGapIgnore }));
    } else if (!netLog) {
      flags2.push({ type: "flag", id: newId("flag"), runId: this.runId, kind: "netLogUnreadable", recordIds: [], detail: "The net log could not be read, so requests sent while a frame unloads may be missing." });
    }
    this.recordServerContainer(requests, hits, containerCounts, flags2);
    const consentEpochs = this.buildConsentEpochs();
    let records = {
      run: this.run,
      steps: this.steps,
      requests,
      responses: this.responses,
      hits,
      dataLayerEvents: this.dataLayerEvents,
      tagReports: [],
      consentEpochs,
      checkpoints: this.checkpoints,
      results: [],
      flags: flags2,
      collectorReports: this.collectorReports.filter((r) => r.type === "collectorReport"),
      invalidReports: this.collectorReports.filter((r) => r.type === "invalidReport")
    };
    const gtmOverrideFailure = this.gtmFailure();
    const scrubber = this.gtmOverride ? new Scrubber(this.gtmOverride.gtmAuth) : void 0;
    if (scrubber) records = scrubber.records(records);
    const writer = await RunWriter.create(this.options.outDir, records.run);
    try {
      for (const record of [
        ...records.requests,
        ...records.steps,
        ...records.checkpoints,
        ...records.responses,
        ...records.hits,
        ...records.dataLayerEvents,
        ...records.consentEpochs,
        ...records.collectorReports,
        ...records.invalidReports,
        ...records.flags
      ]) {
        await writer.append(record);
      }
    } finally {
      await writer.close();
    }
    const failure = gtmOverrideFailure && scrubber ? scrubber.text(gtmOverrideFailure) : gtmOverrideFailure;
    return { path: writer.path, records, ...failure ? { gtmOverrideFailure: failure } : {} };
  }
};
function launchRecorder(options) {
  return Recorder.launch(options);
}
function abortCode(error) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("ERR_CONNECTION_REFUSED") || message.includes("ECONNREFUSED")) return "connectionrefused";
  if (message.includes("ERR_NAME_NOT_RESOLVED") || message.includes("ENOTFOUND")) return "namenotresolved";
  if (message.includes("ETIMEDOUT") || message.includes("ERR_TIMED_OUT")) return "timedout";
  if (message.includes("ECONNRESET") || message.includes("ERR_CONNECTION_RESET")) return "connectionreset";
  return "failed";
}
var BODY_HEADERS = /* @__PURE__ */ new Set(["content-type", "content-length", "content-encoding", "content-language", "content-location", "origin"]);
function withoutMethodChangeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !BODY_HEADERS.has(name.toLowerCase())));
}

// packages/recorder/src/steps.ts
import { createInterface as createInterface2 } from "node:readline/promises";

// packages/recorder/src/conditions.ts
var POLL_MS = 100;
function urlMatches(matcher, href) {
  if ("matches" in matcher) return new RegExp(matcher.matches).test(href);
  try {
    const url = new URL(href);
    return globToRegExp(matcher.glob).test(`${url.pathname}${url.search}`);
  } catch {
    return false;
  }
}
async function locatorShown(page2, locator) {
  const shown2 = (selector) => page2.locator(selector).first().isVisible();
  if (typeof locator === "string") return shown2(locator);
  if ("any" in locator) {
    for (const selector of locator.any) if (await shown2(selector)) return true;
    return false;
  }
  const options = locator.name === void 0 ? {} : { name: locator.name, ...locator.exact === void 0 ? {} : { exact: locator.exact } };
  return page2.getByRole(locator.role, options).first().isVisible();
}
async function conditionHolds(context, condition) {
  for (const page2 of context.pages()) {
    try {
      if ("url" in condition ? urlMatches(condition.url, page2.url()) : await locatorShown(page2, condition.locator)) return true;
    } catch {
    }
  }
  return false;
}
async function watchCondition(context, condition, signal) {
  while (!signal.aborted) {
    if (await conditionHolds(context, condition)) return;
    await new Promise((resolve4) => setTimeout(resolve4, POLL_MS));
  }
  await new Promise(() => {
  });
}
function describeCondition(condition) {
  if ("url" in condition) return "glob" in condition.url ? condition.url.glob : `matches ${condition.url.matches}`;
  const l = condition.locator;
  if (typeof l === "string") return l;
  if ("any" in l) return `any of ${l.any.join(", ")}`;
  return l.name === void 0 ? l.role : `${l.role} "${l.name}"`;
}
function formatDuration(ms) {
  if (ms >= 6e4 && ms % 6e4 === 0) return `${ms / 6e4}m`;
  if (ms >= 1e3 && ms % 1e3 === 0) return `${ms / 1e3}s`;
  return `${ms}ms`;
}

// packages/recorder/src/locators.ts
var ROLE_FAMILIES = ["button", "radio", "checkbox", "link", "tab", "option"];
var MAX_LISTED2 = 10;
var MAX_NAME = 60;
var POLL_MS2 = 100;
async function resolveLocator(page2, locator, timeout) {
  if (typeof locator === "string") return { locator: page2.locator(locator).first() };
  if (!("any" in locator)) {
    const options = locator.name === void 0 ? {} : { name: locator.name, ...locator.exact === void 0 ? {} : { exact: locator.exact } };
    return { locator: page2.getByRole(locator.role, options).first() };
  }
  const deadline = Date.now() + timeout;
  for (; ; ) {
    for (const [index, selector] of locator.any.entries()) {
      if (await page2.locator(selector).count() > 0) return { locator: page2.locator(selector).first(), index };
    }
    if (Date.now() >= deadline) {
      const error = new Error(`no selector of the list matched within ${timeout} ms.`);
      error.name = "TimeoutError";
      throw error;
    }
    await new Promise((resolve4) => setTimeout(resolve4, POLL_MS2));
  }
}
var EMAIL_LIKE = /@/;
var DIGIT_RUN = /\d(?:[\s().+-]?\d){5,}/;
var HEX_TOKEN2 = /[0-9a-fA-F]{32,}/;
var DIGEST_TOKEN2 = /(?=\S*[A-Z])(?=\S*[a-z])(?=\S*\d)[A-Za-z0-9_+/-]{22,}={0,2}/;
function visibleName(name) {
  if (EMAIL_LIKE.test(name) || DIGIT_RUN.test(name) || HEX_TOKEN2.test(name) || DIGEST_TOKEN2.test(name)) return "(hidden)";
  return name.length > MAX_NAME ? `${name.slice(0, MAX_NAME)}...` : name;
}
var SNAPSHOT_KEY = /^\s*- (?:'((?:[^']|'')*)'|(.*))/;
var CONTROL_KEY = new RegExp(`^(${ROLE_FAMILIES.join("|")}) "((?:[^"\\\\]|\\\\.)*)"`);
function parseControls(snapshot) {
  const found = [];
  for (const line of snapshot.split("\n")) {
    const k = SNAPSHOT_KEY.exec(line);
    if (!k) continue;
    const m = CONTROL_KEY.exec(k[1] === void 0 ? k[2] : k[1].replaceAll("''", "'"));
    if (!m) continue;
    try {
      found.push({ role: m[1], name: JSON.parse(`"${m[2]}"`) });
    } catch {
      continue;
    }
  }
  return found;
}
function controlsFromSnapshot(snapshot) {
  return parseControls(snapshot).slice(0, MAX_LISTED2).map((c) => `${c.role} "${visibleName(c.name)}"`);
}
var words = (text2) => text2.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
function sharedWords(a, b) {
  const bag = new Set(words(b));
  return [...new Set(words(a))].filter((w) => bag.has(w)).length;
}
function sharedPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}
function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
function rankByName(controls, wanted) {
  const target = wanted.toLowerCase();
  return controls.map((control, index) => {
    const name = control.name.toLowerCase();
    return { control, index, words: sharedWords(name, target), prefix: sharedPrefix(name, target), distance: editDistance(name, target) };
  }).sort((x, y) => y.words - x.words || y.prefix - x.prefix || x.distance - y.distance || x.index - y.index).map((r) => r.control);
}
async function timeoutMessage(page2, firstLine, requested) {
  try {
    const snapshot = await page2.locator("body").ariaSnapshot({ timeout: 5e3 });
    const general = controlsFromSnapshot(snapshot);
    const generalLine = general.length === 0 ? firstLine : `${firstLine} Controls on the page: ${general.join(", ")}.`;
    if (!requested || !ROLE_FAMILIES.includes(requested.role)) return generalLine;
    const ofRole = parseControls(snapshot).filter((c) => c.role === requested.role);
    if (ofRole.length === 0) return `${firstLine} No ${requested.role} controls on the page.${general.length === 0 ? "" : ` Controls on the page: ${general.join(", ")}.`}`;
    const ranked = requested.name === void 0 ? ofRole : rankByName(ofRole, requested.name);
    return `${firstLine} Closest ${requested.role} controls: ${ranked.slice(0, MAX_LISTED2).map((c) => `"${visibleName(c.name)}"`).join(", ")}.`;
  } catch {
    return firstLine;
  }
}
function readBlockingControls() {
  const found = [];
  const validationText = 'input, select, textarea, option, [role="alert"], [aria-live], [aria-invalid="true"], [aria-errormessage], .error, .invalid, .error-message';
  const messageIds = /* @__PURE__ */ new Set();
  for (const holder of document.querySelectorAll("[aria-errormessage], [aria-describedby]")) {
    for (const id of `${holder.getAttribute("aria-errormessage") ?? ""} ${holder.getAttribute("aria-describedby") ?? ""}`.split(/\s+/)) if (id) messageIds.add(id);
  }
  const cleanText = (source) => {
    if (messageIds.has(source.id) || source.matches(validationText)) return "";
    const copy = source.cloneNode(true);
    copy.querySelectorAll(validationText).forEach((n) => n.remove());
    copy.querySelectorAll("[id]").forEach((n) => messageIds.has(n.id) && n.remove());
    return copy.textContent ?? "";
  };
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria?.trim()) return aria;
    const ids = el.getAttribute("aria-labelledby");
    if (ids) {
      const text2 = ids.split(/\s+/).map((id) => {
        const source = document.getElementById(id);
        return source ? cleanText(source) : "";
      }).join(" ").trim();
      if (text2) return text2;
    }
    const labels = el.labels;
    if (labels && labels.length > 0) {
      const text2 = [...labels].map(cleanText).join(" ").replace(/\s+/g, " ").trim();
      if (text2) return text2;
    }
    return el.getAttribute("name") ?? "";
  };
  for (const el of document.querySelectorAll('input, select, textarea, [aria-invalid="true"]')) {
    if (el instanceof HTMLInputElement && (el.type === "hidden" || el.type === "submit" || el.type === "button" || el.type === "reset" || el.type === "image")) continue;
    const input = el;
    const checkbox = el instanceof HTMLInputElement && el.type === "checkbox";
    let reason;
    if (checkbox && !input.checked && input.willValidate && (input.required || el.getAttribute("aria-required") === "true")) reason = "required, not ticked";
    else if ("validity" in el && input.willValidate && input.validity.valid === false) reason = "invalid";
    else if (el.getAttribute("aria-invalid") === "true") reason = "aria-invalid";
    if (!reason) continue;
    const kind = el instanceof HTMLInputElement ? el.type : el.getAttribute("role") ?? el.tagName.toLowerCase();
    found.push({ kind, name: nameOf(el), reason });
    if (found.length >= 10) break;
  }
  return found;
}
var DIAGNOSTIC_DEADLINE_MS = 3e3;
function withDeadline(work, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("diagnostic timed out")), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
async function blockingControls(context) {
  const listed = [];
  for (const page2 of context.pages()) {
    try {
      const controls = await withDeadline(page2.evaluate(readBlockingControls), DIAGNOSTIC_DEADLINE_MS);
      for (const c of controls) {
        const name = visibleName(String(c.name));
        listed.push(`${c.kind}${name ? ` "${name}"` : ""} (${c.reason})`);
      }
    } catch {
    }
    if (listed.length >= MAX_LISTED2) break;
  }
  return listed.slice(0, MAX_LISTED2);
}

// packages/recorder/src/payment.ts
var SHOPIFY_CARD_HOST = "checkout.pci.shopifyinc.com";
var documentPath = (name) => new RegExp(`/${name}-(ltr|rtl)\\.html$`);
var shopifyFields = [
  { kind: "number", frame: 'iframe[title*="Card number" i]', input: 'input[autocomplete="cc-number"], input[name="number"]', path: documentPath("number") },
  { kind: "expiry", frame: 'iframe[title*="Expiration" i]', input: 'input[autocomplete="cc-exp"], input[name="expiry"]', path: documentPath("expiry") },
  { kind: "cvc", frame: 'iframe[title*="Security code" i]', input: 'input[autocomplete="cc-csc"], input[name="verification_value"]', path: documentPath("verification_value") },
  { kind: "name", frame: 'iframe[title*="Name on card" i]', input: 'input[autocomplete="cc-name"], input[name="name"]', path: documentPath("name") }
];
var fixturePath = (legacy, shopify) => new RegExp(`^/card-frame(-${legacy}|-extra-input)?$|/${shopify}-(ltr|rtl)\\.html$`);
var RUNTIME = {
  "shopify-bogus": { marker: "text=Bogus Gateway", cardHost: SHOPIFY_CARD_HOST, fields: shopifyFields },
  "shopify-test": { marker: "text=/test mode/i", cardHost: SHOPIFY_CARD_HOST, fields: shopifyFields },
  fixture: {
    marker: "#pw-test-mode",
    cardHost: "127.0.0.1",
    fields: [
      { kind: "number", frame: "#card-frame, #card-frame-number", input: 'input[autocomplete="cc-number"], input[name="number"]', path: fixturePath("number", "number") },
      { kind: "expiry", frame: "#card-frame, #card-frame-exp", input: 'input[autocomplete="cc-exp"], input[name="expiry"]', path: fixturePath("exp", "expiry") },
      { kind: "cvc", frame: "#card-frame, #card-frame-csc", input: 'input[autocomplete="cc-csc"], input[name="verification_value"]', path: fixturePath("csc", "verification_value") }
    ]
  }
};
var MARKER_TIMEOUT_MS = 5e3;
function normalizeHost(host) {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "");
}
function providerBlockedOnSite(providerId, siteHost) {
  const provider = findPaymentProvider(providerId);
  if (!provider) return `unknown payment provider ${providerId}`;
  if (provider.loopbackOnly && !isLoopbackHost(normalizeHost(siteHost))) {
    return `the ${provider.id} test payment provider is only for loopback sites`;
  }
  return void 0;
}
function hostOf3(url) {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return "";
  }
}
function pathOf2(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}
async function cardFrameServed(page2, field, cardHost, deadline) {
  let reason = "not found";
  for (; ; ) {
    try {
      let hidden = false;
      let elsewhere = false;
      let otherPath;
      for (const element of await page2.locator(field.frame).elementHandles()) {
        const frame = await element.contentFrame();
        if (!frame) continue;
        if (hostOf3(frame.url()) !== cardHost) {
          elsewhere = true;
        } else if (!field.path.test(pathOf2(frame.url()))) {
          otherPath = pathOf2(frame.url());
        } else if (await element.isVisible()) {
          return { element, frame };
        } else {
          hidden = true;
        }
      }
      reason = hidden ? "not visible" : otherPath !== void 0 ? `served from another path: ${otherPath}` : elsewhere ? "served from another host" : "not found";
    } catch {
      return reason;
    }
    if (Date.now() >= deadline) return reason;
    await new Promise((resolve4) => setTimeout(resolve4, 100));
  }
}
async function markerInCardContainer(frames, marker, timeout) {
  try {
    const container = await frames[0].evaluateHandle((first, all) => {
      let node = first.parentElement;
      while (node && !all.every((f) => node.contains(f))) node = node.parentElement;
      return node;
    }, frames);
    const element = container.asElement();
    if (!element) return false;
    await element.waitForSelector(marker, { state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}
function valueOf(kind, provider, card, identity) {
  if (kind === "number") return card;
  if (kind === "expiry") return provider.expiry;
  if (kind === "cvc") return provider.cvc;
  return `${identity.firstName} ${identity.lastName}`;
}
async function runPayment(page2, recorder, value, identity, testPayment, record, timeout, siteHost) {
  const provider = findPaymentProvider(value.provider);
  const runtime = RUNTIME[value.provider];
  const card = provider ? canonicalCard(provider, value.card) : void 0;
  if (!provider || !runtime || card === void 0) throw new Error("payment step is not a documented test payment");
  if (!testPayment) throw new Error("test payments are not allowed in this run");
  const blocked = providerBlockedOnSite(provider.id, siteHost);
  if (blocked) throw new Error(blocked);
  const allowed = normalizeHost(testPayment.host);
  if (hostOf3(page2.url()) !== allowed || normalizeHost(siteHost) !== allowed) {
    throw new Error("test mode not detected (the page is not on the allowed test payment host)");
  }
  const declared = testPayment.declaredProviders?.includes(provider.id) === true;
  const wait = Math.min(timeout, MARKER_TIMEOUT_MS);
  const deadline = Date.now() + wait;
  const found = [];
  for (const field of runtime.fields) {
    const result = await cardFrameServed(page2, field, runtime.cardHost, deadline);
    if (typeof result === "string") throw new Error(`card frame not found (${field.kind}): ${result}`);
    found.push(result);
  }
  if (!declared && !await markerInCardContainer(found.map((f) => f.element), runtime.marker, wait)) throw new Error("test mode not detected");
  recorder.holdRedaction();
  const typed = typedValues(provider, card, identity);
  for (const [index, field] of runtime.fields.entries()) {
    try {
      await fillVerified(found[index].element, field, runtime.cardHost, valueOf(field.kind, provider, card, identity), timeout, typed);
    } catch (error) {
      throw new Error(`card field ${field.kind} could not be filled: ${reasonOf(error, typed)}`);
    }
    if (index === 0) record.payment = { provider: provider.id, mode: "test", testMode: declared ? "declared" : "marker" };
  }
}
var GONE_FRAME = "the card frame is gone or not served from the card host";
async function frameStillServed(element, cardHost, field) {
  const frame = await element.contentFrame();
  if (!frame || hostOf3(frame.url()) !== cardHost || !field.path.test(pathOf2(frame.url()))) {
    throw new OwnReason(GONE_FRAME);
  }
  return frame;
}
var FILL_TRY_MS = 500;
async function fillVerified(element, field, cardHost, value, timeout, typed) {
  const deadline = Date.now() + timeout;
  const tryMs = () => Math.max(1, Math.min(FILL_TRY_MS, deadline - Date.now()));
  for (; ; ) {
    const frame = await frameStillServed(element, cardHost, field);
    const inputs = frame.locator(field.input).filter({ visible: true });
    const count = await inputs.count();
    if (count === 1) {
      try {
        const handle = await inputs.elementHandle({ timeout: tryMs() });
        await frameStillServed(element, cardHost, field);
        await handle.fill(value, { timeout: tryMs() });
        return;
      } catch (error) {
        if (!(error instanceof Error && error.name === "TimeoutError") || Date.now() >= deadline) throw error;
        continue;
      }
    }
    if (Date.now() >= deadline) {
      const current = await frameStillServed(element, cardHost, field).catch(() => void 0);
      throw new OwnReason(current ? await countReason(current, count, typed) : GONE_FRAME);
    }
    await new Promise((resolve4) => setTimeout(resolve4, 100));
  }
}
async function countReason(frame, count, typed) {
  const attribute = (v) => scrub((v ?? "").replace(/\s+/g, " "), typed).slice(0, 40);
  let inputs = " none visible";
  try {
    const seen = await frame.locator("input").filter({ visible: true }).evaluateAll((all) => all.map((e) => ({ name: e.getAttribute("name"), autocomplete: e.getAttribute("autocomplete"), type: e.getAttribute("type") })));
    if (seen.length > 0) inputs = seen.map((i) => ` [name=${attribute(i.name)} autocomplete=${attribute(i.autocomplete)} type=${attribute(i.type)}]`).join("");
  } catch {
    inputs = " inputs not readable";
  }
  return `${count} visible inputs match in ${pathOf2(frame.url())}:${inputs}`;
}
function typedValues(provider, card, identity) {
  const values = [card, provider.expiry, provider.cvc, identity.firstName, identity.lastName, `${identity.firstName} ${identity.lastName}`];
  return values.filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
}
var OwnReason = class extends Error {
};
function reasonOf(error, typed) {
  if (error instanceof OwnReason) return error.message;
  return scrub((error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "", typed) || "unknown error";
}
function scrub(text2, typed) {
  const pattern = (value) => {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(value.length < 4 ? `(?<!\\d)${escaped}(?!\\d)` : escaped, "g");
  };
  return typed.reduce((out, value) => out.replace(pattern(value), "[value]"), text2).trim();
}

// packages/recorder/src/steps.ts
var bannerConsentHandler = async (answer, { recorder, page: page2, timeoutMs }) => {
  const result = await recorder.consent.answer(page2, answer === "withdraw" ? "reject" : answer, timeoutMs ?? 1e4);
  if (result.result === "banner not shown") {
    throw new Error(answer === "withdraw" ? "banner not shown (withdraw needs the banner reopened first)" : "banner not shown");
  }
  if (result.result === "failed") throw new Error(`consent ${answer} failed`);
  recorder.recordBanner(result);
};
var CART_WRITE_PATH = /\/cart\/(?:add|change|update)(?:\.js)?(?:\/|$)|\/cart\/?$/i;
var CART_ADD_PATH = /\/cart\/add(?:\.js)?(?:\/|$)/i;
var CART_AJAX = /(?:^|[?&])wc-ajax=add_to_cart(?:&|$)/;
var CART_MUTATION = /cart(?:Create|LinesAdd)/;
var CART_EVENT = /^(?:add_to_cart|addToCart)$/i;
function isCartRequest(r) {
  const url = new URL(r.url);
  return CART_AJAX.test(url.search) || (r.method === "GET" ? CART_ADD_PATH.test(url.pathname) : CART_WRITE_PATH.test(url.pathname) || CART_MUTATION.test(r.postData ?? ""));
}
function createCartCheck(pattern) {
  const custom = pattern === void 0 ? void 0 : new RegExp(pattern);
  return ({ requests, responses, dataLayerEvents }) => {
    const accepted = (r) => {
      const statuses = responses.filter((x) => x.requestId === r.id).map((x) => x.status);
      return statuses.some((status) => status >= 200 && status < 400);
    };
    return dataLayerEvents.some((e) => e.event !== null && CART_EVENT.test(e.event)) || requests.some((r) => (isCartRequest(r) || custom?.test(r.url) === true) && accepted(r));
  };
}
var defaultCartCheck = createCartCheck();
var StepError = class extends Error {
  constructor(label, message) {
    super(`step "${label}": ${message}`);
    this.label = label;
    this.name = "StepError";
  }
  label;
  /** Set by `recordScenario`: the run written up to the failure. */
  run;
};
var GtmOverrideFailure = class extends Error {
  constructor(message, run) {
    super(message);
    this.run = run;
    this.name = "GtmOverrideFailure";
  }
  run;
};
var ServerContainerFailure = class extends Error {
  constructor(message, run) {
    super(message);
    this.run = run;
    this.name = "ServerContainerFailure";
  }
  run;
};
var DEFAULT_OPTIONAL_TIMEOUT_MS = 2e3;
var HANDOFF_REMINDER = "Use test accounts and test cards only. Never enter real personal or payment details.";
function hasHandoff(scenario) {
  return scenario.steps.some((s) => s.kind === "handoff");
}
function hasPayment(scenario) {
  return scenario.steps.some((s) => s.kind === "payment");
}
function fillValue(value, identity) {
  return IDENTITY_FIELDS.includes(value) ? identity[value] : value;
}
function resolveSitePath(path, site, vars) {
  const base2 = new URL(site);
  const filled = path.replace(/\{(\w+)\}/g, (_m, name) => vars[name] ?? `{${name}}`);
  const url = new URL(filled, base2);
  if (url.origin !== base2.origin) throw new Error(`"${path}" leaves the site ${base2.origin}`);
  return url.href;
}
async function stdinResolver(_message, signal) {
  const rl = createInterface2({ input: process.stdin, output: process.stdout });
  try {
    await rl.question("Press Enter when done. ", { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    rl.close();
  }
}
async function activePage(recorder) {
  const pages = recorder.context.pages();
  return pages[pages.length - 1] ?? recorder.context.newPage();
}
async function inspectField(page2, selector, timeout) {
  const field = page2.locator(selector).first();
  const inspected = await field.evaluate(
    (el) => {
      const describe = (e) => ({
        autocomplete: e.getAttribute("autocomplete"),
        name: e.getAttribute("name"),
        id: e.getAttribute("id"),
        type: e.getAttribute("type")
      });
      const isControl = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      const labelled = el instanceof HTMLLabelElement ? el : isControl || el.isContentEditable ? null : el.closest("label");
      const control = labelled?.control ?? null;
      return {
        tag: (control ?? el).tagName.toLowerCase(),
        host: el.ownerDocument.location.hostname,
        fields: control ? [describe(el), describe(control)] : [describe(el)]
      };
    },
    void 0,
    { timeout }
  );
  const sensitive = inspected.fields.some(isSensitiveField);
  if (sensitive && !isGuardExemptHost(inspected.host)) {
    throw new Error(`${selector} is a card or password field. ${HANDOFF_REQUIRED}`);
  }
  return { field, tag: inspected.tag, sensitive };
}
async function isPresent(page2, selector, timeout) {
  try {
    await page2.locator(selector).first().waitFor({ state: "visible", timeout });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return false;
    throw error;
  }
}
async function fillField(page2, selector, value, timeout) {
  const { field, tag, sensitive } = await inspectField(page2, selector, timeout);
  if (tag === "select") await field.selectOption(value, { timeout });
  else await field.fill(value, { timeout });
  return sensitive;
}
async function selectOption(page2, selector, wanted, timeout) {
  const { field, tag, sensitive } = await inspectField(page2, selector, timeout);
  if (tag !== "select") throw new Error(`${selector} is not a select`);
  const options = await field.evaluate(
    (el) => {
      const select = el instanceof HTMLSelectElement ? el : el.closest("label")?.control;
      if (!(select instanceof HTMLSelectElement)) return null;
      return [...select.options].map((o) => ({ value: o.value, label: o.label.trim() }));
    },
    void 0,
    { timeout }
  );
  if (!options) throw new Error(`${selector} is not a select`);
  const byValue = options.findIndex((o) => o.value === wanted);
  const chosen = byValue >= 0 ? byValue : options.findIndex((o) => o.label === wanted.trim());
  if (chosen < 0) throw new Error(`${selector} has no option with value or label "${wanted}"`);
  await field.selectOption({ index: chosen }, { timeout });
  const now = await field.evaluate((el) => {
    const select = el instanceof HTMLSelectElement ? el : el.closest("label").control;
    return { index: select.selectedIndex, label: select.selectedOptions[0]?.label.trim() ?? "" };
  }, void 0, { timeout });
  if (now.index !== chosen) throw new Error(`value not applied (still: ${now.label})`);
  return { sensitive, ...options[chosen] };
}
async function withControlList(page2, recorder, locator, action) {
  try {
    return await action();
  } catch (error) {
    const handoff = recorder.handoff?.state().waiting === true;
    if (error instanceof Error && error.name === "TimeoutError" && !handoff) {
      throw new Error(await timeoutMessage(page2, error.message.split("\n")[0], typeof locator === "object" && "role" in locator ? locator : void 0));
    }
    throw error;
  }
}
function remaining(deadline) {
  return Math.max(1, deadline - Date.now());
}
async function locate(page2, recorder, locator, record, timeout) {
  return withControlList(page2, recorder, locator, async () => {
    const resolved = await resolveLocator(page2, locator, timeout);
    if (resolved.index !== void 0) record.locator = resolved.index;
    return resolved.locator;
  });
}
function hostedFrames(page2) {
  return page2.frames().filter((frame) => !isGuardExemptHost(new URL(frame.url() || "about:blank", "http://invalid.invalid").hostname));
}
async function rememberFieldValues(frame) {
  await frame.evaluate(() => {
    const initial = /* @__PURE__ */ new WeakMap();
    for (const e of document.querySelectorAll("input, textarea")) initial.set(e, e.value);
    window.__tagreeveInitial = initial;
  }).catch(() => void 0);
}
async function changedSensitiveFields(frame) {
  const fields2 = await frame.evaluate(() => {
    const initial = window.__tagreeveInitial;
    delete window.__tagreeveInitial;
    return [...document.querySelectorAll("input, textarea")].map((e, index) => ({
      autocomplete: e.getAttribute("autocomplete"),
      name: e.getAttribute("name"),
      id: e.getAttribute("id"),
      type: e.getAttribute("type"),
      index,
      value: e.value,
      initial: initial ? initial.get(e) ?? "" : e.defaultValue
    }));
  }).catch(() => []);
  return fields2.filter((field) => isSensitiveField(field) && field.value !== "" && field.value !== field.initial);
}
async function evaluateGuarded(page2, script) {
  const hosted = hostedFrames(page2);
  const trapped = [];
  for (const frame of hosted) {
    if (await frame.evaluate(SENSITIVE_WRITE_TRAP).then(() => true, () => false)) trapped.push(frame);
    await rememberFieldValues(frame);
  }
  let scriptError;
  try {
    await page2.evaluate(script);
  } catch (error) {
    scriptError = error;
  }
  let blocked = false;
  for (const frame of trapped) {
    const hit = await frame.evaluate(() => {
      const trap = window.__tagreeveTrap;
      trap.release();
      return trap.state.blocked;
    }).catch(() => false);
    blocked ||= hit;
  }
  const changed = [];
  for (const frame of hostedFrames(page2)) {
    for (const { index } of await changedSensitiveFields(frame)) changed.push({ frame, index });
  }
  for (const { frame, index } of changed) {
    await frame.evaluate((i) => document.querySelectorAll("input, textarea")[i].value = "", index).catch(() => void 0);
  }
  if (blocked || changed.length > 0) throw new Error(`the script set a card or password field. ${HANDOFF_REQUIRED}`);
  if (scriptError) throw scriptError;
}
async function waitForUrl(recorder, url, timeout) {
  const condition = { url };
  const deadline = Date.now() + timeout;
  while (!await conditionHolds(recorder.context, condition)) {
    if (Date.now() >= deadline) {
      const message = `page did not reach ${describeCondition(condition)} within ${formatDuration(timeout)}`;
      const blocking = await blockingControls(recorder.context);
      throw new Error(blocking.length === 0 ? message : `${message}. Blocking controls: ${blocking.join(", ")}.`);
    }
    await recorder.wait(100);
  }
}
async function waitForCart(recorder, record, scenario, options) {
  const check = options.cartCheck ?? createCartCheck(scenario.options.cartRequest);
  const deadline = Date.now() + (options.cartTimeoutMs ?? 5e3);
  while (!check(recorder.stepActivity(record))) {
    if (Date.now() >= deadline) throw new Error("click did not add to cart");
    await recorder.wait(100);
  }
}
async function runStep(step, recorder, scenario, identity, options, record) {
  const timeout = options.actionTimeoutMs ?? 3e4;
  const page2 = await activePage(recorder);
  switch (step.kind) {
    case "visit":
      await page2.goto(resolveSitePath(step.value, recorder.site, scenario.vars), { waitUntil: "load", timeout });
      return;
    case "click": {
      const deadline = Date.now() + timeout;
      const target = await locate(page2, recorder, step.value, record, timeout);
      await withControlList(page2, recorder, step.value, () => target.click({ timeout: remaining(deadline) }));
      return;
    }
    case "addToCart":
      await page2.locator(step.value).first().click({ timeout });
      await waitForCart(recorder, record, scenario, options);
      return;
    case "fill":
      for (const [selector, value] of Object.entries(step.value)) {
        if (step.optional?.includes(selector) && !await isPresent(page2, selector, scenario.options.optionalTimeout ?? DEFAULT_OPTIONAL_TIMEOUT_MS)) {
          record.skippedFields = [...record.skippedFields ?? [], selector];
          continue;
        }
        const typed = fillValue(value, identity);
        const sensitive = await fillField(page2, selector, typed, timeout);
        if (sensitive || SECRET_FIELD.test(selector) || typed !== value) continue;
        identity.extra = [.../* @__PURE__ */ new Set([...identity.extra ?? [], typed])];
        recorder.setIdentity(identity);
      }
      return;
    case "select":
      for (const [selector, wanted] of Object.entries(step.value)) {
        const chosen = await selectOption(page2, selector, wanted, timeout);
        if (chosen.sensitive || SECRET_FIELD.test(selector)) continue;
        identity.extra = [...new Set([...identity.extra ?? [], chosen.value, chosen.label].filter((v) => v !== ""))];
        recorder.setIdentity(identity);
      }
      return;
    case "wait":
      if (typeof step.value === "number") await recorder.wait(step.value);
      else if ("url" in step.value) await waitForUrl(recorder, step.value.url, timeout);
      else {
        const deadline = Date.now() + timeout;
        const target = await locate(page2, recorder, step.value.selector, record, timeout);
        await withControlList(page2, recorder, step.value.selector, () => target.waitFor({ state: "attached", timeout: remaining(deadline) }));
      }
      return;
    case "evaluate":
      await evaluateGuarded(page2, step.value);
      return;
    case "checkpoint":
      await recorder.checkpoint(step.value, record);
      return;
    case "consent":
      await (options.consent ?? bannerConsentHandler)(step.value, { recorder, page: page2, timeoutMs: scenario.options.consentTimeout });
      return;
    case "payment":
      await runPayment(page2, recorder, step.value, identity, options.testPayment, record, timeout, new URL(recorder.site).hostname);
      return;
    case "handoff": {
      const print = options.print ?? ((text2) => process.stdout.write(`${text2}
`));
      print(`
Handoff: ${step.value}
${HANDOFF_REMINDER}
Recording continues until you are done.`);
      recorder.setHandoff(true);
      const watching = new AbortController();
      let end;
      try {
        end = await waitForHandoff({
          text: step.value,
          gate: recorder.handoff,
          resolver: options.handoffResolver ?? stdinResolver,
          print,
          wake: () => wakeOverlay(recorder),
          ...step.until ? { until: watchCondition(recorder.context, step.until, watching.signal), settleMs: step.settle ?? 5e3 } : {},
          ...step.timeout === void 0 ? {} : { timeoutMs: step.timeout }
        });
      } finally {
        watching.abort();
        recorder.setHandoff(false);
      }
      record.handoffEnd = end;
      if (end === "timeout") {
        const limit = formatDuration(step.timeout);
        throw new Error(step.until ? `handoff did not reach ${describeCondition(step.until)} within ${limit}` : `handoff timed out after ${limit}`);
      }
      if (end === "until" && step.until) print(`Handoff ended: reached ${describeCondition(step.until)}`);
      return;
    }
  }
}
async function wakeOverlay(recorder) {
  await Promise.all(
    recorder.context.pages().map(async (p) => {
      try {
        await p.evaluate((name) => window.dispatchEvent(new Event(name)), HANDOFF_WAKE_EVENT);
      } catch {
      }
    })
  );
}
function scenarioIdentity(scenario, seed) {
  const declared = scenario.identity.country;
  const country = declared && /^[a-z]{2}$/i.test(declared) ? declared.toUpperCase() : declared;
  return { ...createIdentity(seed, { country }), ...scenario.identity, ...country && { country } };
}
async function playScenario(recorder, scenario, options = {}) {
  const identity = scenarioIdentity(scenario, options.seed ?? scenario.options.seed ?? Math.floor(Math.random() * 2 ** 31));
  recorder.setIdentity(identity);
  if (!hasCountryFormat(identity.country)) {
    options.warn?.(`identity.country ${identity.country} has no local format; name, address, zip and phone are US-shaped`);
  }
  const steps = [{ kind: "visit", value: scenario.start, label: "start", line: 0 }, ...scenario.steps];
  for (const [index, step] of steps.entries()) {
    const record = recorder.beginStep(step.label, index);
    try {
      await runStep(step, recorder, scenario, identity, options, record);
      if (step.kind !== "checkpoint") await recorder.checkpoint(step.label, record);
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      recorder.endStep(record, message);
      throw new StepError(step.label, message);
    }
    recorder.endStep(record);
  }
  return identity;
}
async function recordScenario(options) {
  const { parsed, launch = launchRecorder, ...rest } = options;
  const recorder = await launch({ ...rest, headed: rest.headed || hasHandoff(parsed), handoffOverlay: hasHandoff(parsed) });
  if (recorder.containerFailure) {
    const { message } = recorder.containerFailure;
    throw new ServerContainerFailure(message, await recorder.close());
  }
  try {
    await playScenario(recorder, parsed, rest);
  } catch (error) {
    const result2 = await recorder.close().catch(() => void 0);
    if (error instanceof StepError) {
      if (result2) error.run = result2;
      if (rest.gtmOverride) {
        const scrubber = new Scrubber(rest.gtmOverride.gtmAuth);
        error.message = scrubber.text(error.message);
        if (error.stack) error.stack = scrubber.text(error.stack);
      }
    }
    throw error;
  }
  const result = await recorder.close();
  if (result.gtmOverrideFailure) throw new GtmOverrideFailure(result.gtmOverrideFailure, result);
  const lost = recorder.containerFailure;
  if (lost) throw new ServerContainerFailure(lost.message, result);
  return result;
}

// packages/cli/src/args.ts
import { parseArgs } from "node:util";

// packages/cli/src/out-dir.ts
import { readdir } from "node:fs/promises";
import { join as join6 } from "node:path";
function resolveOutDir({ out, now, label, base: base2 = "tagreeve/runs" }) {
  if (out !== void 0) return out;
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return join6(base2, label === void 0 ? date : `${date}-${label}`);
}
var LABEL_PATTERN = /^[a-z0-9-]{1,40}$/;
var OLD_RUNS_NOTICE = "Note: records now go to tagreeve/runs/<date>/. ./runs/ holds older records; pass --out runs to keep using it.\n";
async function oldRunsNotice(cwd) {
  let names;
  try {
    names = await readdir(join6(cwd, "runs"));
  } catch {
    return void 0;
  }
  return names.some((n) => /^run_.*\.jsonl$/.test(n) || n.startsWith("suite_")) ? OLD_RUNS_NOTICE : void 0;
}

// packages/cli/src/args.ts
var UsageError = class extends Error {
  command;
  constructor(message, command) {
    super(message);
    this.name = "UsageError";
    this.command = command;
  }
};
var COMMANDS = ["run", "suite", "diff", "baseline", "report", "init", "install-browser", "server-container"];
function usageHint(command) {
  return `Run tagreeve ${command ? `${command} ` : ""}--help for the options.`;
}
var PUBLISHED_VARIANT = "published";
var VARIANT_NAME = /^[a-z0-9][a-z0-9_-]*$/;
var USAGE = `Usage:
  tagreeve run <scenario.yml> [--site <url>] [options]
  tagreeve diff <a.jsonl> <b.jsonl> [--by-page] [--all-flags] [--json]
  tagreeve baseline save <run.jsonl> [<baseline.json>] [--by-page]
  tagreeve report <run.jsonl | suite-dir> --html <out.html>
  tagreeve suite [<dir>] [--site <url> | --stores <stores.json>] [--variant published] [--variant name=override.json] [options]
  tagreeve init
  tagreeve server-container build
  tagreeve install-browser
  tagreeve --version

Run "tagreeve run --help" for the options of run.

server-container build: builds the image for the server container feature on arm64 (Apple silicon) from Google's image. It needs Docker, pulls large images and never pushes. On amd64 it prints the image to use.

Options for suite:
  --site <url>               The site to test. Without --site and --stores, site in tagreeve/config.yml is used, or else tagreeve/stores.json
  --stores <file>            A stores.json file: run every scenario against each store (instead of --site). Default: tagreeve/stores.json
  --variant <name[=file]>    A GTM build to test (repeatable). "published" is the live container; name=file serves an override file. Default: published
  --with-handoff             Also run scenarios with handoff steps, last, headed
  --with-test-payment        Also run scenarios with a payment step. Needs --allow-test-payment
  --allow-test-payment <host> The host that may run test payments. It must equal the --site host and be in the test-payment-hosts.json allowlist
  --config <file>            The project config, instead of tagreeve/config.yml
  --baseline [<folder>]      Compare each cell with its baseline file in the folder (default: tagreeve/baselines) and fail on drift. Bare, put it last
  --network, --out, --label, --seed, --viewport, --var, --tracker-list, --autoconsent-rules, --server-container, --server-container-config, --json work as in run

Options for run:
  --site <url>               The site to test. Without it, site in tagreeve/config.yml is used
  --config <file>            The project config, instead of tagreeve/config.yml
  --network stub|server|live stub (default) answers tracking requests locally; server also passes through the hosts in options.serverHosts; live sends them
  --out <dir>                Directory for the JSONL record (default: tagreeve/runs/<date>)
  --label <name>             Name this run: 1 to 40 lowercase letters, digits or hyphens. Stored on the record and added to the default folder name
  --seed <n>                 Seed for the fake identity
  --headed                   Show the browser window
  --viewport <W>x<H>         Browser viewport in CSS pixels, such as 390x844. Overrides options.viewport. The user agent stays desktop
  --allow-test-payment <host> Let a payment step type a provider's documented test card. The host must equal the --site host and be in the test-payment-hosts.json allowlist
  --net-log                  Capture collection requests no browser hook reports (unload sends, early sandboxed srcdoc sends) from Chromium's net log (needs --network live)
  --autoconsent-rules <file> Extra autoconsent rules (repeatable). Default: tagreeve/autoconsent/*.json
  --gtm-override <file>      Serve a GTM workspace build (JSON with container, gtmAuth, gtmPreview, optional loader.replace or loader.match)
  --tracker-list <file>      Extra tracker hosts to stub and decode (JSON array of entries). Default: tagreeve/trackers.json
  --server-container         Run your own server container in Docker and record the calls it makes to vendors. Needs --network server and options.serverHosts. See docs/cli.md
  --server-container-config <file> The container config (mode 0600). Or set TAGREEVE_SERVER_CONTAINER_CONFIG
  --baseline [<file>]        Compare the hits with a baseline file and fail on drift. Bare, put it last: tagreeve/baselines/<scenario>.json
  --var <k=v>                Scenario variable (repeatable)
  --json                     Print a JSON summary on stdout
`;
var RUN_USAGE = `Usage: tagreeve run <scenario.yml> [--site <url>] [options]

Plays the scenario in Chromium, records every request, checks the expectations
and writes one JSONL record.

Options:
  --site <url>               The site to test. Without it, site in tagreeve/config.yml is used
  --config <file>            The project config, instead of tagreeve/config.yml
  --network stub|server|live stub (default) answers tracking requests locally; server also passes through the hosts in options.serverHosts; live sends them
  --out <dir>                Directory for the JSONL record (default: tagreeve/runs/<date>)
  --label <name>             Name this run: 1 to 40 lowercase letters, digits or hyphens. Stored on the record and added to the default folder name
  --seed <n>                 Seed for the fake identity
  --headed                   Show the browser window
  --viewport <W>x<H>         Browser viewport in CSS pixels, such as 390x844. Overrides options.viewport. The user agent stays desktop
  --allow-test-payment <host> Let a payment step type a provider's documented test card. The host must equal the --site host and be in the test-payment-hosts.json allowlist
  --net-log                  Capture collection requests no browser hook reports (unload sends, early sandboxed srcdoc sends) from Chromium's net log (needs --network live)
  --autoconsent-rules <file> Extra autoconsent rules (repeatable). Default: tagreeve/autoconsent/*.json
  --gtm-override <file>      Serve a GTM workspace build (JSON with container, gtmAuth, gtmPreview, optional loader.replace or loader.match)
  --tracker-list <file>      Extra tracker hosts to stub and decode (JSON array of entries). Default: tagreeve/trackers.json
  --server-container         Run your own server container in Docker and record the calls it makes to vendors. Needs --network server and options.serverHosts. See docs/cli.md
  --server-container-config <file> The container config (mode 0600). Or set TAGREEVE_SERVER_CONTAINER_CONFIG
  --baseline [<file>]        Compare the hits with a baseline file made by "tagreeve baseline save" and fail on drift. Bare, put it last: tagreeve/baselines/<scenario>.json
  --var <k=v>                Scenario variable (repeatable)
  --json                     Print a JSON summary on stdout
  -h, --help                 Show this help

Exit codes: 0 pass, 1 failed expectations, 2 usage or run error.

Scenario format: https://github.com/alfhen/tagreeve/blob/main/docs/design.md#11-expectations
`;
var SUITE_USAGE = `Usage: tagreeve suite [<dir>] [--site <url> | --stores <stores.json>] [options]

Runs every scenario in <dir> (default: tagreeve/scenarios) and writes one record per run plus a suite.json.

Options:
${USAGE.slice(USAGE.indexOf("  --site <url>               The site to test. Without"), USAGE.indexOf("\nOptions for run:")).trimEnd()}
  -h, --help                 Show this help
`;
var DIFF_USAGE = `Usage: tagreeve diff <a.jsonl> <b.jsonl> [options]

Compares the hits of two run records. It exits 0 whether or not they differ.

Options:
  --by-page                  Add the page path to each key
  --all-flags                Also show flag count changes for hosts allowed by allowUnknownDestination and for platform hosts (hidden by default)
  --json                     Print the full diff result as JSON
  -h, --help                 Show this help
`;
var BASELINE_USAGE = `Usage: tagreeve baseline save <run.jsonl> [<baseline.json>] [options]

Saves the hit tuples of a run as a baseline file. Without <baseline.json> the file is tagreeve/baselines/<scenario>[.<store>][.<variant>].json. Pass it to "tagreeve run --baseline" or "tagreeve suite --baseline".

Options:
  --by-page                  Add the page path to each key
  -h, --help                 Show this help
`;
var REPORT_USAGE = `Usage: tagreeve report <run.jsonl | suite-dir> --html <out.html>

Writes an HTML report for a run record or a suite directory.

Options:
  --html <file>              The report file to write (required)
  -h, --help                 Show this help
`;
var INIT_USAGE = `Usage: tagreeve init

Makes tagreeve/scenarios/ and tagreeve/baselines/ in the current directory, and adds /tagreeve/runs/ to ./.gitignore unless the work tree already ignores it. It writes no scenario, never overwrites a file and says what it did or skipped. It takes no options.

Options:
  -h, --help                 Show this help
`;
var INSTALL_BROWSER_USAGE = `Usage: tagreeve install-browser

Installs the Chromium that Tagreeve drives. It takes no options.

Options:
  -h, --help                 Show this help
`;
var SERVER_CONTAINER_USAGE = `Usage: tagreeve server-container build

Builds the image for the server container feature on arm64 (Apple silicon) from Google's image. It needs Docker, pulls large images and never pushes. On amd64 it prints the image to use.

Options:
  -h, --help                 Show this help
`;
var HELP_TEXT = {
  run: RUN_USAGE,
  suite: SUITE_USAGE,
  diff: DIFF_USAGE,
  baseline: BASELINE_USAGE,
  report: REPORT_USAGE,
  init: INIT_USAGE,
  "install-browser": INSTALL_BROWSER_USAGE,
  "server-container": SERVER_CONTAINER_USAGE
};
function helpText(topic) {
  return topic ? HELP_TEXT[topic] : USAGE;
}
var NET_LOG_NEEDS_LIVE = "--net-log needs --network live. In stub mode it would let the requests a frame sends while it unloads leave the machine.";
function parseVariants(entries) {
  const variants2 = [];
  for (const entry of entries.length ? entries : [PUBLISHED_VARIANT]) {
    const eq = entry.indexOf("=");
    const name = eq < 0 ? entry : entry.slice(0, eq);
    const file = eq < 0 ? void 0 : entry.slice(eq + 1);
    if (!VARIANT_NAME.test(name)) throw new UsageError(`--variant name must match ${VARIANT_NAME.source}, got "${name}"`);
    if (name === PUBLISHED_VARIANT && file !== void 0) throw new UsageError(`--variant "${PUBLISHED_VARIANT}" is reserved for no override and takes no file`);
    if (name !== PUBLISHED_VARIANT && !file) throw new UsageError(`--variant ${name} needs an override file: ${name}=<file>`);
    if (variants2.some((v) => v.name === name)) throw new UsageError(`--variant "${name}" is given twice`);
    variants2.push(file === void 0 ? { name } : { name, file });
  }
  return variants2;
}
var OPTIONS = {
  site: { type: "string" },
  stores: { type: "string" },
  config: { type: "string" },
  network: { type: "string" },
  out: { type: "string" },
  label: { type: "string" },
  seed: { type: "string" },
  headed: { type: "boolean" },
  viewport: { type: "string" },
  "net-log": { type: "boolean" },
  "autoconsent-rules": { type: "string", multiple: true },
  "gtm-override": { type: "string" },
  "tracker-list": { type: "string" },
  "server-container": { type: "boolean" },
  "server-container-config": { type: "string" },
  baseline: { type: "string" },
  variant: { type: "string", multiple: true },
  "with-handoff": { type: "boolean" },
  "with-test-payment": { type: "boolean" },
  "allow-test-payment": { type: "string" },
  var: { type: "string", multiple: true },
  json: { type: "boolean" },
  html: { type: "string" },
  "by-page": { type: "boolean" },
  "all-flags": { type: "boolean" },
  version: { type: "boolean" },
  help: { type: "boolean", short: "h" }
};
function commandOf(argv) {
  const { tokens } = parseArgs({ args: argv, allowPositionals: true, strict: false, options: OPTIONS, tokens: true });
  const isCommand = (word) => COMMANDS.includes(word);
  let skip = false;
  let skipped;
  for (const token of tokens) {
    if (token.kind === "option") {
      skip = !(token.name in OPTIONS) && token.value === void 0;
    } else if (token.kind === "positional") {
      if (!skip) return isCommand(token.value) ? token.value : skipped;
      if (skipped === void 0 && isCommand(token.value)) skipped = token.value;
      skip = false;
    }
  }
  return skipped;
}
function parseCli(argv) {
  try {
    return parseCommand(argv);
  } catch (error) {
    if (error instanceof UsageError && error.command === void 0) {
      const command = commandOf(argv);
      if (command !== void 0) error.command = command;
    }
    throw error;
  }
}
var BARE_BASELINE = "\0bare";
function markBareBaseline(argv) {
  const end = argv.indexOf("--");
  return argv.map((token, i) => token === "--baseline" && (end < 0 || i < end) && (i === argv.length - 1 || argv[i + 1].startsWith("-")) ? `--baseline=${BARE_BASELINE}` : token);
}
function parseCommand(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: markBareBaseline(argv),
      allowPositionals: true,
      options: OPTIONS
    });
  } catch (error) {
    const unknown = error instanceof Error && /^Unknown option '(-[^']*)'/.exec(error.message);
    if (unknown) throw new UsageError(`Unknown option ${unknown[1]}.`);
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  const baseline = { bare: values.baseline === BARE_BASELINE, value: values.baseline === BARE_BASELINE ? void 0 : values.baseline };
  if (values.version) return { command: "version" };
  const [command, ...rest] = positionals;
  if (values.help && command !== void 0 && COMMANDS.includes(command)) {
    return { command: "help", topic: command };
  }
  if (values.help || command === void 0) return { command: "help" };
  if (command === "init") {
    if (rest.length) throw new UsageError("init takes no arguments");
    return { command: "init" };
  }
  if (command === "install-browser") {
    if (rest.length) throw new UsageError("install-browser takes no arguments");
    return { command: "install-browser" };
  }
  if (command === "server-container") {
    if (rest[0] !== "build") throw new UsageError("server-container needs a subcommand: build");
    if (rest.length !== 1) throw new UsageError("server-container build takes no arguments");
    return { command: "server-container", action: "build" };
  }
  if (command === "diff") {
    if (rest.length !== 2) throw new UsageError("diff takes two JSONL files");
    return { command: "diff", a: rest[0], b: rest[1], byPage: values["by-page"] ?? false, allFlags: values["all-flags"] ?? false, json: values.json ?? false };
  }
  if (command === "baseline") {
    if (rest[0] !== "save") throw new UsageError("baseline needs a subcommand: save");
    if (rest.length !== 2 && rest.length !== 3) throw new UsageError("baseline save takes a JSONL file and an optional baseline file");
    return { command: "baseline", input: rest[1], ...rest[2] !== void 0 && { output: rest[2] }, byPage: values["by-page"] ?? false };
  }
  if (command === "report") {
    if (rest.length !== 1) throw new UsageError("report takes one JSONL file or one suite directory");
    if (!values.html) throw new UsageError("report needs --html <file>");
    return { command: "report", input: rest[0], html: values.html };
  }
  if (command !== "run" && command !== "suite") throw new UsageError(`Unknown command "${command}"`);
  if (command === "run" ? rest.length !== 1 : rest.length > 1) throw new UsageError(command === "run" ? "run takes one scenario file" : "suite takes at most one scenario directory");
  if (command === "suite") {
    if (values.site !== void 0 && values.stores !== void 0) throw new UsageError("--site and --stores cannot be used together");
  }
  if (values.site !== void 0) {
    try {
      const url = new URL(values.site);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      throw new UsageError(`--site must be an http or https URL, got "${values.site}"`);
    }
  }
  const network = values.network;
  if (network !== void 0 && network !== "stub" && network !== "server" && network !== "live") {
    throw new UsageError(`--network must be stub, server or live, got "${network}"`);
  }
  let seed;
  if (values.seed !== void 0) {
    seed = Number(values.seed);
    if (!Number.isInteger(seed) || seed < 0) throw new UsageError(`--seed must be a non-negative integer, got "${values.seed}"`);
  }
  let viewport;
  if (values.viewport !== void 0) {
    viewport = parseViewportText(values.viewport);
    if (!viewport) throw new UsageError(`--viewport must be ${VIEWPORT_HINT}, got "${values.viewport}"`);
  }
  if (values.label !== void 0 && !LABEL_PATTERN.test(values.label)) {
    throw new UsageError(`--label must be 1 to 40 lowercase letters, digits or hyphens, got "${values.label}"`);
  }
  if (values["server-container-config"] !== void 0 && !values["server-container"]) {
    throw new UsageError("--server-container-config needs --server-container");
  }
  const vars = {};
  for (const entry of values.var ?? []) {
    const eq = entry.indexOf("=");
    if (eq < 1) throw new UsageError(`--var must look like name=value, got "${entry}"`);
    vars[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  if (command === "suite") {
    for (const flag2 of ["gtm-override", "headed", "net-log"]) {
      if (values[flag2] !== void 0) throw new UsageError(`--${flag2} is not an option of suite`);
    }
    return {
      command: "suite",
      ...rest[0] !== void 0 && { dir: rest[0] },
      ...values.site !== void 0 && { site: values.site },
      ...values.stores !== void 0 && { stores: values.stores },
      ...values.config !== void 0 && { config: values.config },
      variants: parseVariants(values.variant ?? []),
      network,
      out: values.out,
      ...values.label !== void 0 && { label: values.label },
      seed,
      withHandoff: values["with-handoff"] ?? false,
      withTestPayment: values["with-test-payment"] ?? false,
      ...values["allow-test-payment"] !== void 0 && { allowTestPayment: values["allow-test-payment"] },
      ...viewport && { viewport },
      autoconsentRules: values["autoconsent-rules"] ?? [],
      trackerList: values["tracker-list"],
      ...baseline.value !== void 0 && { baseline: baseline.value },
      ...baseline.bare && { baselineDefault: true },
      ...values["server-container"] && { serverContainer: true },
      ...values["server-container-config"] !== void 0 && { serverContainerConfig: values["server-container-config"] },
      vars,
      json: values.json ?? false
    };
  }
  for (const flag2 of ["variant", "with-handoff", "with-test-payment", "stores"]) {
    if (values[flag2] !== void 0) throw new UsageError(`--${flag2} is not an option of run`);
  }
  return {
    command: "run",
    scenario: rest[0],
    ...values.site !== void 0 && { site: values.site },
    ...values.config !== void 0 && { config: values.config },
    network,
    out: values.out,
    ...values.label !== void 0 && { label: values.label },
    seed,
    headed: values.headed ?? false,
    ...viewport && { viewport },
    ...values["allow-test-payment"] !== void 0 && { allowTestPayment: values["allow-test-payment"] },
    netLog: values["net-log"] ?? false,
    autoconsentRules: values["autoconsent-rules"] ?? [],
    gtmOverride: values["gtm-override"],
    trackerList: values["tracker-list"],
    baseline: baseline.value,
    ...baseline.bare && { baselineDefault: true },
    ...values["server-container"] && { serverContainer: true },
    ...values["server-container-config"] !== void 0 && { serverContainerConfig: values["server-container-config"] },
    vars,
    json: values.json ?? false
  };
}

// packages/cli/src/baseline.ts
import { mkdir as mkdir2, readFile as readFile2, writeFile as writeFile2 } from "node:fs/promises";
import { join as join7 } from "node:path";

// packages/cli/src/defaults.ts
import { readdir as readdir2, stat } from "node:fs/promises";
var DEFAULT_SCENARIOS = "tagreeve/scenarios";
var DEFAULT_TRACKER_LIST = "tagreeve/trackers.json";
var DEFAULT_AUTOCONSENT_DIR = "tagreeve/autoconsent";
var DEFAULT_STORES = "tagreeve/stores.json";
var DEFAULT_BASELINES = "tagreeve/baselines";
var SETTING_TEXT = {
  scenarios: "scenario folder",
  trackerList: "tracker list",
  autoconsentRules: "autoconsent rules",
  stores: "stores",
  baseline: "baseline"
};
async function isKind(path, kind) {
  try {
    const info = await stat(path);
    return kind === "file" ? info.isFile() : info.isDirectory();
  } catch {
    return false;
  }
}
async function defaultScenarioDir(used) {
  if (!await isKind(DEFAULT_SCENARIOS, "directory")) return void 0;
  used.push({ setting: "scenarios", path: DEFAULT_SCENARIOS });
  return DEFAULT_SCENARIOS;
}
async function resolveTrackerList(flag2, used) {
  if (flag2 !== void 0) return flag2;
  if (!await isKind(DEFAULT_TRACKER_LIST, "file")) return void 0;
  used.push({ setting: "trackerList", path: DEFAULT_TRACKER_LIST });
  return DEFAULT_TRACKER_LIST;
}
async function resolveAutoconsentRules(flags2, used) {
  if (flags2?.length) return flags2;
  let names;
  try {
    names = (await readdir2(DEFAULT_AUTOCONSENT_DIR)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const paths = [];
  for (const name of names) {
    const path = `${DEFAULT_AUTOCONSENT_DIR}/${name}`;
    if (await isKind(path, "file")) paths.push(path);
  }
  for (const path of paths) used.push({ setting: "autoconsentRules", path });
  return paths;
}
async function defaultStores(used) {
  if (!await isKind(DEFAULT_STORES, "file")) return void 0;
  used.push({ setting: "stores", path: DEFAULT_STORES });
  return DEFAULT_STORES;
}
function formatDefaultsLine(defaults) {
  if (!defaults?.length) return void 0;
  return `Defaults: ${defaults.map((d) => `${d.path} (${SETTING_TEXT[d.setting]})`).join(", ")}`;
}

// packages/cli/src/baseline.ts
var BASELINE_SCHEMA_VERSION = 1;
var BaselineError = class extends Error {
};
function hostOf4(site) {
  try {
    return new URL(site).hostname;
  } catch {
    return "";
  }
}
function buildBaseline(records, byPage) {
  return {
    baselineSchemaVersion: BASELINE_SCHEMA_VERSION,
    scenario: records.run.scenario,
    site: hostOf4(records.run.site),
    byPage,
    keys: hitShape(records, { byPage })
  };
}
var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
function validKey(k) {
  if (!isRecord(k) || !isRecord(k.key) || !Array.isArray(k.tuples)) return false;
  const { epoch, vendor, event, page: page2 } = k.key;
  if (typeof epoch !== "string" || typeof vendor !== "string" || typeof event !== "string") return false;
  if (page2 !== void 0 && typeof page2 !== "string") return false;
  return k.tuples.every(
    (t) => isRecord(t) && isRecord(t.consent) && Object.values(t.consent).every((v) => typeof v === "string") && isStringArray(t.ids) && Number.isInteger(t.count) && t.count >= 1
  );
}
function parseBaseline(text2, label) {
  let json;
  try {
    json = JSON.parse(text2);
  } catch {
    throw new BaselineError(`${label} is not valid JSON`);
  }
  if (!isRecord(json) || json.baselineSchemaVersion === void 0) throw new BaselineError(`${label} is not a baseline file`);
  if (json.baselineSchemaVersion !== BASELINE_SCHEMA_VERSION) {
    const found = typeof json.baselineSchemaVersion === "number" ? json.baselineSchemaVersion : "?";
    throw new BaselineError(`${label} has baselineSchemaVersion ${found}, and this Tagreeve reads ${BASELINE_SCHEMA_VERSION}`);
  }
  if (typeof json.scenario !== "string" || typeof json.site !== "string" || typeof json.byPage !== "boolean" || !Array.isArray(json.keys) || !json.keys.every(validKey)) {
    throw new BaselineError(`${label} is not a valid baseline file`);
  }
  return json;
}
async function readBaseline(path) {
  let text2;
  try {
    text2 = await readFile2(path, "utf8");
  } catch (error) {
    throw new BaselineError(`Cannot read ${path}: ${error.code ?? "unknown error"}`);
  }
  return parseBaseline(text2, path);
}
function keyLabel(key) {
  const page2 = key.page === void 0 ? "" : `, page ${key.page || "(none)"}`;
  return `${key.vendor} ${key.event || "(no event)"} [epoch ${key.epoch}${page2}]`;
}
function tupleLabel(t) {
  const consent = Object.entries(t.consent).map(([k, v]) => `${k}=${v || "-"}`).join(" ");
  return `${consent}; ids: ${t.ids.length ? t.ids.join(", ") : "none"}`;
}
function describeDiff(diff) {
  const lines = [];
  for (const c of diff.added) lines.push(c.wholeKey ? `added ${keyLabel(c.key)}: ${tupleLabel(c)}` : `added tuple ${keyLabel(c.key)}: ${tupleLabel(c)}`);
  for (const c of diff.removed) lines.push(c.wholeKey ? `removed ${keyLabel(c.key)}: ${tupleLabel(c)}` : `removed tuple ${keyLabel(c.key)}: ${tupleLabel(c)}`);
  for (const c of diff.countChanges) lines.push(`count ${keyLabel(c.key)}: ${tupleLabel(c)}: ${c.a} -> ${c.b} (not drift)`);
  return lines;
}
function describeMove(m) {
  const page2 = m.page === void 0 ? "" : ` on page ${m.page || "(none)"}`;
  const hits = m.count > 1 ? ` (${m.count} hits)` : "";
  const early = m.to === "undecided" ? " The hit now fires before the consent answer." : "";
  return `moved ${m.vendor} ${m.event || "(no event)"} from ${m.from} to ${m.to}${page2}${hits}. This is not drift.${early}`;
}
var scenarioName = (name) => name.replace(/\.ya?ml$/, "");
function baselineFileName(scenario, store, variant) {
  return [scenarioName(scenario), store, variant === PUBLISHED_VARIANT ? void 0 : variant].filter(Boolean).join(".") + ".json";
}
function defaultBaselineName(run) {
  if (run.variant !== void 0 && (run.recordSchemaVersion ?? 0) < 4) {
    throw new BaselineError("This record is from a suite and was made before record schema version 4, so it does not name its store. Give the baseline path.");
  }
  return baselineFileName(run.scenario, run.store, run.variant);
}
function compareBaseline(baseline, records) {
  const warnings = [];
  if (scenarioName(baseline.scenario) !== scenarioName(records.run.scenario)) {
    warnings.push(`The baseline is from scenario ${baseline.scenario}, and this run is ${records.run.scenario}.`);
  }
  const host = hostOf4(records.run.site);
  if (baseline.site !== host) warnings.push(`The baseline is from site ${baseline.site || "(none)"}, and this run is ${host || "(none)"}.`);
  const epochOrder = [...records.consentEpochs].sort((x, y) => x.startT - y.startT).map((e) => e.label);
  const diff = diffShapes(baseline.keys, hitShape(records, { byPage: baseline.byPage }), { epochOrder });
  warnings.push(...diff.moved.map(describeMove));
  return {
    drift: diff.drift,
    added: diff.added.length,
    removed: diff.removed.length,
    countChanges: diff.countChanges.length,
    warnings,
    changes: describeDiff(diff)
  };
}
async function baselineCommand(args, io) {
  let records;
  try {
    records = await readRun(args.input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.includes(args.input) ? message : `Cannot read ${args.input}: ${message}`);
  }
  if (records.truncatedAtLine) {
    io.stderr(`Warning: ${args.input} is truncated at line ${records.truncatedAtLine}. The baseline lacks the later records.
`);
  }
  const baseline = buildBaseline(records, args.byPage);
  let output = args.output;
  if (output === void 0) {
    output = join7(DEFAULT_BASELINES, defaultBaselineName(records.run));
    await mkdir2(DEFAULT_BASELINES, { recursive: true });
  }
  await writeFile2(output, `${JSON.stringify(baseline, null, 2)}
`);
  const hits = baseline.keys.reduce((n, k) => n + k.tuples.reduce((m, t) => m + t.count, 0), 0);
  io.stdout(`Baseline ${output}: ${baseline.keys.length} keys, ${hits} hits
`);
  return 0;
}

// packages/cli/src/diff.ts
function pathOf3(page2) {
  try {
    return new URL(page2).pathname;
  } catch {
    return page2;
  }
}
function where(key, step, rawPage) {
  const raw = rawPage && key.page && pathOf3(rawPage) !== key.page ? `, recorded as ${rawPage}` : "";
  const parts = [step && `step "${step}"`, key.page && `page ${key.page}${raw}`].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}
function recordedPages(c) {
  if (!c.key.page || c.a.page === null && c.b.page === null) return "";
  const differs = [c.a.page, c.b.page].some((p) => p !== null && pathOf3(p) !== c.key.page);
  return differs ? `, recorded as ${c.a.page ?? "(none)"} -> ${c.b.page ?? "(none)"}` : "";
}
function add(tree, key, line) {
  const event = key.event || "(no event)";
  const vendors = tree.get(key.epoch) ?? /* @__PURE__ */ new Map();
  const events = vendors.get(key.vendor) ?? /* @__PURE__ */ new Map();
  const lines = events.get(event) ?? [];
  lines.push(line);
  events.set(event, lines);
  vendors.set(key.vendor, events);
  tree.set(key.epoch, vendors);
}
function flagChangeLabel(f) {
  return `${f.host ? `${f.kind} ${f.host}` : f.kind}: ${f.a} -> ${f.b}`;
}
function formatDiff(result, a, b, options = {}) {
  const tree = /* @__PURE__ */ new Map();
  for (const h of result.added) add(tree, h.key, `added${where(h.key, h.step, h.page)}: ${h.hitId}`);
  for (const h of result.removed) add(tree, h.key, `removed${where(h.key, h.step, h.page)}: ${h.hitId}`);
  for (const c of result.changed) {
    const changes = [...c.consent, ...c.ids].map((v) => `${v.field} ${v.a} -> ${v.b}`).join(", ");
    const moved = c.a.step === c.b.step ? "" : `, step "${c.a.step}" -> "${c.b.step}"`;
    const step = c.a.step === c.b.step ? c.a.step : "";
    add(tree, c.key, `changed${where(c.key, step)}${moved}${recordedPages(c)}: ${changes} (${c.a.hitId} -> ${c.b.hitId})`);
  }
  for (const m of result.countMismatches) add(tree, m.key, `count ${m.a} -> ${m.b}${where(m.key, "")} (pairing by order)`);
  const shownFlags = options.allFlags ? result.flags : result.flags.filter((f) => !f.allowed);
  const hiddenFlags = result.flags.length - shownFlags.length;
  const out = [`Diff ${a} -> ${b}`];
  for (const warning of result.warnings) out.push(`Warning: ${warning}`);
  if (tree.size === 0 && shownFlags.length === 0) out.push("No differences.");
  for (const [epoch, vendors] of [...tree].sort(([x], [y]) => x.localeCompare(y))) {
    out.push("", `Epoch ${epoch}`);
    for (const [vendor, events] of [...vendors].sort(([x], [y]) => x.localeCompare(y))) {
      out.push(`  ${vendor}`);
      for (const [event, lines] of [...events].sort(([x], [y]) => x.localeCompare(y))) {
        out.push(`    ${event}`);
        for (const line of lines) out.push(`      ${line}`);
      }
    }
  }
  if (shownFlags.length) {
    out.push("", "Flags");
    for (const f of shownFlags) out.push(`  ${flagChangeLabel(f)}`);
  }
  if (hiddenFlags) out.push("", `${hiddenFlags} flag count change${hiddenFlags === 1 ? "" : "s"} for hosts allowed by allowUnknownDestination or platform hosts not shown (use --all-flags)`);
  return `${out.join("\n")}
`;
}
async function load(path) {
  try {
    return await readRun(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.includes(path) ? message : `Cannot read ${path}: ${message}`);
  }
}
async function diffCommand(args, io) {
  const [a, b] = await Promise.all([load(args.a), load(args.b)]);
  const result = diffRuns(a, b, { byPage: args.byPage });
  for (const [path, run] of [[args.a, a], [args.b, b]]) {
    if (run.truncatedAtLine) result.warnings.push(`${path}: truncated at line ${run.truncatedAtLine}; later records are missing from the diff`);
  }
  io.stdout(args.json ? `${JSON.stringify(result, null, 2)}
` : formatDiff(result, args.a, args.b, { allFlags: args.allFlags }));
  return 0;
}

// packages/cli/src/init.ts
import { appendFile, mkdir as mkdir3, readFile as readFile3, stat as stat3 } from "node:fs/promises";
import { join as join9 } from "node:path";

// packages/cli/src/git-ignore.ts
import { execFile as execFile2 } from "node:child_process";
import { stat as stat2 } from "node:fs/promises";
import { dirname as dirname2, join as join8, resolve } from "node:path";
var GIT_TIMEOUT_MS = 5e3;
async function nearestExistingDir(path) {
  let dir = resolve(path);
  for (; ; ) {
    try {
      if ((await stat2(dir)).isDirectory()) return dir;
    } catch {
    }
    const parent = dirname2(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}
function checkIgnoreExit(cwd, path) {
  return new Promise((resolveCode) => {
    execFile2("git", ["-c", "core.fsmonitor=false", "-C", cwd, "check-ignore", "-q", path], { timeout: GIT_TIMEOUT_MS }, (error) => {
      if (!error) return resolveCode(0);
      const code = error.code;
      resolveCode(typeof code === "number" ? code : void 0);
    });
  });
}
async function gitIgnoreStatus(path) {
  const absolute = resolve(path);
  const existing = await nearestExistingDir(absolute);
  const probe = absolute === existing ? absolute : join8(absolute, "probe");
  const code = await checkIgnoreExit(existing, probe);
  return code === 0 ? "ignored" : code === 1 ? "unignored" : "unknown";
}
async function isUnignoredInWorkTree(path) {
  return await gitIgnoreStatus(path) === "unignored";
}
async function warnIfNotIgnored(folder, stderr) {
  if (await isUnignoredInWorkTree(folder)) {
    stderr(`Warning: ${folder} is not in .gitignore. Records hold full request bodies; do not commit them. Run tagreeve init or add the folder to .gitignore.
`);
  }
}

// packages/cli/src/init.ts
var IGNORE_LINE = "/tagreeve/runs/";
var FOLDERS = ["tagreeve/scenarios", "tagreeve/baselines"];
async function exists(path) {
  try {
    await stat3(path);
    return true;
  } catch {
    return false;
  }
}
async function ensureIgnoreLine(cwd) {
  const file = join9(cwd, ".gitignore");
  let current;
  try {
    current = await readFile3(file, "utf8");
  } catch {
    current = void 0;
  }
  if (current?.split(/\r?\n/).some((line) => line.trim() === IGNORE_LINE)) return `Skipped .gitignore: it already has ${IGNORE_LINE}`;
  if (await gitIgnoreStatus(join9(cwd, "tagreeve/runs")) === "ignored") return "Skipped .gitignore: git already ignores tagreeve/runs/";
  const prefix = current === void 0 || current === "" || current.endsWith("\n") ? "" : "\n";
  await appendFile(file, `${prefix}${IGNORE_LINE}
`);
  return current === void 0 ? `Created .gitignore with ${IGNORE_LINE}` : `Added ${IGNORE_LINE} to .gitignore`;
}
async function initCommand(io, cwd = process.cwd()) {
  const lines = [];
  for (const folder of FOLDERS) {
    if (await exists(join9(cwd, folder))) {
      lines.push(`Skipped ${folder}/: it exists`);
      continue;
    }
    await mkdir3(join9(cwd, folder), { recursive: true });
    lines.push(`Created ${folder}/`);
  }
  lines.push(await ensureIgnoreLine(cwd));
  io.stdout(`${lines.join("\n")}
`);
  return 0;
}

// packages/cli/src/install-browser.ts
import { spawn as spawn2 } from "node:child_process";
import { createRequire as createRequire2 } from "node:module";
import { dirname as dirname3, join as join10 } from "node:path";
function installBrowser() {
  const cli = join10(dirname3(createRequire2(import.meta.url).resolve("playwright/package.json")), "cli.js");
  return new Promise((resolve4, reject) => {
    const child = spawn2(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve4(code ?? 1));
  });
}

// packages/cli/src/report/index.ts
import { mkdir as mkdir5, stat as stat6, writeFile as writeFile5 } from "node:fs/promises";
import { dirname as dirname5, join as join15, resolve as resolve3 } from "node:path";

// packages/cli/src/report/model.ts
var NOTE_TEXT = {
  stubNoCookies: "stub mode: stubbed endpoints set no cookies, so this pass says nothing about server cookies",
  cannotEvaluateBody: "cannot evaluate: body not fully recorded",
  fieldsNotRecorded: "cannot evaluate: field names not recorded",
  cookieNotStored: "the server set this cookie, but no later checkpoint shows the browser holding it",
  nestedNameOnly: "a plain name matches a top-level field only; use **.name to match at any depth",
  serverSendProbableLink: "a server container hit is placed by a probable link to a browser hit, which cannot fail a run",
  serverSendUnlinked: "cannot evaluate: a server container hit has no link to a browser hit, so no consent state applies"
};
var WORST_FIRST = ["leak", "unchecked", "mixed", "early", "full", "ping"];
var CONSENT_FIELDS = ["analytics", "ads", "adUserData", "adPersonalization"];
var MAX_EVIDENCE = 5;
var MAX_VALUE = 80;
var SHOWN_VALUE_KEYS = /* @__PURE__ */ new Set(["vendor", "event", "in", "before", "after", "from", "host", "count", "outcome", "transport", "sentBy", "cookie"]);
var MIXED_HIT = "some signals denied";
function flatten2(entry) {
  const flat = {};
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [sub, inner] of Object.entries(value)) flat[`${key}.${sub}`] = inner;
    } else flat[key] = value;
  }
  return flat;
}
function consentScoped(entry) {
  const flat = flatten2(entry);
  const where2 = flat.in;
  if (typeof where2 === "string" && /^epoch\(\s*(?:label=)?(?:denied|withdrawn)\s*\)$|^epoch\(\s*\w+=denied\s*\)$/.test(where2)) return true;
  if (flat.before === "consent") return true;
  return Object.entries(flat).some(([key, value]) => key.startsWith("consent.") && value === "denied");
}
function parseEntry2(result) {
  const m = /^(must|mustNot): ([\s\S]*)$/.exec(result.expectation);
  if (!m) return void 0;
  try {
    const entry = JSON.parse(m[2]);
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return void 0;
    return { kind: m[1], entry };
  } catch {
    return void 0;
  }
}
function scalar(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : void 0;
}
function shown(value) {
  const one = scalar(value);
  if (one !== void 0) return one.slice(0, MAX_VALUE);
  if (Array.isArray(value) && value.every((v) => scalar(v) !== void 0)) return value.map(scalar).join("|").slice(0, MAX_VALUE);
  return void 0;
}
function valueFreeForm(kind, entry) {
  const parts = Object.entries(flatten2(entry)).map(([key, value]) => {
    const keepsValue = SHOWN_VALUE_KEYS.has(key) || key.startsWith("body.") || key.startsWith("consent.") && ["granted", "denied", "unknown"].includes(String(value));
    const text2 = keepsValue ? shown(value) : void 0;
    return text2 === void 0 ? key : `${key}: ${text2}`;
  });
  return parts.length ? `${kind}: ${parts.join(", ")}` : kind;
}
function expectationView(result) {
  const severity = result.severity === "warn" ? "warn" : "fail";
  const parsed = parseEntry2(result);
  let kind = "rule";
  let text2 = "rule";
  if (parsed) {
    kind = parsed.kind;
    text2 = valueFreeForm(parsed.kind, parsed.entry);
  } else if (/^builtin: [A-Za-z]+$/.test(result.expectation)) {
    kind = "builtin";
    text2 = result.expectation;
  }
  const cannot = !result.pass && (result.note === "cannotEvaluateBody" || result.note === "fieldsNotRecorded" || result.note === "serverSendUnlinked");
  const status = cannot ? "CANNOT EVALUATE" : result.pass ? "PASS" : severity === "warn" ? "WARN" : "FAIL";
  return {
    status,
    kind,
    text: text2,
    ...!result.pass && { severity },
    note: result.note ? NOTE_TEXT[result.note] : void 0,
    evidence: result.evidence.slice(0, MAX_EVIDENCE),
    evidenceCount: result.evidence.length
  };
}
var RULE_LEAK = "named by a failed consent-scoped rule";
var IDENTIFIER_LEAK = "identifiers sent while denied";
var IDENTIFIER_EARLY = "identifiers sent before an answer";
function namedLeaks(results) {
  const named = /* @__PURE__ */ new Map();
  for (const result of results) {
    if (result.pass || result.note === "cannotEvaluateBody" || result.note === "fieldsNotRecorded" || result.note === "serverSendUnlinked") continue;
    let label;
    if (result.expectation === "builtin: deniedIdentifiers") label = IDENTIFIER_LEAK;
    else if (result.expectation === "builtin: earlyIdentifiers") label = IDENTIFIER_EARLY;
    else {
      const parsed = parseEntry2(result);
      if (parsed?.kind !== "mustNot" || !consentScoped(parsed.entry)) continue;
      label = RULE_LEAK;
    }
    for (const id of result.evidence) {
      const have = named.get(id);
      if (have !== IDENTIFIER_LEAK && !(have === IDENTIFIER_EARLY && label === RULE_LEAK)) named.set(id, label);
    }
  }
  return named;
}
var NO_LINK = "no link to a browser hit";
function judge(hit, state, undecided, named, unlinked = false) {
  if (unlinked) {
    return hit.idFields === void 0 || hit.idFields.length > 0 ? { mark: "unchecked", label: `${NO_LINK}, consent state unknown` } : { mark: "full", label: NO_LINK };
  }
  const known = CONSENT_FIELDS.map((f) => state[f]).filter((v) => v !== "unknown");
  const denied = known.includes("denied");
  const granted = known.includes("granted");
  const idFields = hit.idFields;
  const flagged = (idFields ?? []).some((name) => identifierSignal(identifierClass(name), state).value === "denied");
  if (flagged) return { mark: "leak", label: IDENTIFIER_LEAK };
  const why = named.get(hit.id);
  if (why) return { mark: "leak", label: why };
  if (denied && (hit.fieldsComplete === false || idFields === void 0)) return { mark: "unchecked", label: "body not fully recorded" };
  if (denied && granted) return { mark: "mixed", label: MIXED_HIT };
  if (denied) {
    return idFields.length > 0 ? { mark: "unchecked", label: "identifier names, consent signal unknown" } : { mark: "ping", label: "hit sent while denied, no identifiers recorded" };
  }
  if (granted) return { mark: "full", label: "" };
  if (undecided) return { mark: "early", label: "before an answer" };
  return { mark: "full", label: "consent state unknown" };
}
function segmentOf(verdicts2) {
  if (verdicts2.length === 0) return { mark: "nothing", label: "", hits: 0 };
  const hits = verdicts2.length;
  const has = (m) => verdicts2.some((v) => v.mark === m);
  const mark = WORST_FIRST.find(has);
  if ((mark === "full" || mark === "early") && has("full") && has("ping")) return { mark: "mixed", label: "granted and denied hits", hits };
  const own = verdicts2.filter((v) => v.mark === mark);
  let label = own.every((v) => v.label === own[0].label) ? own[0].label : "";
  if (!label && own.every((v) => v.label === IDENTIFIER_LEAK || v.label === IDENTIFIER_EARLY)) label = IDENTIFIER_LEAK;
  if (mark === "mixed") label = MIXED_HIT;
  return { mark, label, hits };
}
function hostOf5(url) {
  try {
    return new URL(url).host || void 0;
  } catch {
    return void 0;
  }
}
function flagViews(records) {
  const hostByRecord = /* @__PURE__ */ new Map();
  for (const r of records.requests) {
    const host = hostOf5(r.url);
    if (host) hostByRecord.set(r.id, host);
  }
  for (const h of records.hits) {
    const host = hostByRecord.get(h.requestId);
    if (host) hostByRecord.set(h.id, host);
  }
  const byKind = /* @__PURE__ */ new Map();
  for (const flag2 of records.flags) {
    const entry = byKind.get(flag2.kind) ?? { count: 0, hosts: /* @__PURE__ */ new Map() };
    entry.count++;
    for (const id of flag2.recordIds) {
      const host = hostByRecord.get(id);
      if (host) entry.hosts.set(host, (entry.hosts.get(host) ?? 0) + 1);
    }
    byKind.set(flag2.kind, entry);
  }
  return [...byKind].map(([kind, { count, hosts }]) => {
    const names = [...hosts.keys()].sort();
    return {
      kind,
      count,
      hosts: names,
      ...kind === "platformHost" && { hostCounts: names.map((host) => ({ host, count: hosts.get(host) })) }
    };
  }).sort((a, b) => a.kind.localeCompare(b.kind));
}
function buildReportModel(records) {
  const { run } = records;
  const graceMs = run.graceWindowMs ?? DEFAULT_GRACE_MS;
  const epochs = [...records.consentEpochs].sort((a, b) => a.startT - b.startT);
  const named = namedLeaks(records.results);
  const index = judgeIndex(records.hits, records.requests);
  const placed = records.hits.map((hit) => {
    const server = isServerHit(hit, index);
    const at = judgedAt(hit, index);
    const unlinked = at === void 0;
    const epoch = unlinked ? void 0 : epochForHit(epochs, at, graceMs);
    const state = effectiveConsentAt(hit, epochs, graceMs, index);
    const column = unlinked ? epochs.length : epoch ? epochs.indexOf(epoch) : -1;
    const probable = server && hit.via?.confidence === "probable";
    return { hit, state, column, server, unlinked, probable, verdict: judge(hit, state, !unlinked && (!epoch || epoch.label === "undecided"), named, unlinked) };
  });
  const synthetic = epochs.length === 0 || placed.some((p) => p.column < 0);
  const offset = synthetic ? 1 : 0;
  const hasUnlinked = placed.some((p) => p.unlinked);
  const columns = [
    ...synthetic ? [{ label: "undecided", index: 0 }] : [],
    ...epochs.map((e, i) => ({ label: e.label, index: i + offset })),
    ...hasUnlinked ? [{ label: "unlinked", index: epochs.length + offset }] : []
  ];
  const vendors = [...new Set(records.hits.map((h) => h.vendor))].sort();
  const rows = vendors.flatMap(
    (vendor) => [false, true].flatMap((server) => {
      const own = placed.filter((p) => p.hit.vendor === vendor && p.server === server);
      if (own.length === 0) return [];
      return [
        {
          vendor,
          ...server && { server: true },
          hits: own.length,
          segments: columns.map((col) => {
            const here = own.filter((p) => p.column + offset === col.index);
            const segment = segmentOf(here.map((p) => p.verdict));
            const probable = here.filter((p) => p.probable).length;
            return probable > 0 ? { ...segment, probable } : segment;
          })
        }
      ];
    })
  );
  const serverHits = placed.filter((p) => p.server);
  const serverContainer = serverHits.length ? {
    hits: serverHits.length,
    exact: serverHits.filter((p) => !p.unlinked && !p.probable).length,
    probable: serverHits.filter((p) => p.probable && !p.unlinked).length,
    unlinked: serverHits.filter((p) => p.unlinked).length
  } : void 0;
  const version = run.recordSchemaVersion ?? 0;
  let fields2;
  if (version >= 2) {
    fields2 = vendors.map((vendor) => {
      const names = /* @__PURE__ */ new Set();
      for (const p of placed) {
        if (p.hit.vendor !== vendor || !CONSENT_FIELDS.some((f) => p.state[f] === "denied")) continue;
        for (const name of p.hit.fields ?? []) names.add(guardFieldName(name));
      }
      return { vendor, names: [...names].sort() };
    }).filter((v) => v.names.length > 0);
  }
  return {
    header: {
      scenario: run.scenario,
      variant: run.variant,
      ...run.label !== void 0 && { label: run.label },
      runId: run.id,
      startedAt: new Date(run.startedAt).toISOString(),
      networkMode: run.networkMode,
      ...run.viewport && { viewport: `${run.viewport.width}x${run.viewport.height}` },
      host: hostOf5(run.site) ?? "",
      pingwrightVersion: run.pingwrightVersion,
      schemaVersion: version
    },
    columns,
    rows,
    expectations: records.results.map(expectationView),
    flags: flagViews(records),
    fields: fields2,
    skippedFields: (records.steps ?? []).flatMap((s) => (s.skippedFields ?? []).map((selector) => ({ step: s.label, selector }))),
    ...serverContainer && { serverContainer }
  };
}

// packages/cli/src/report/names.ts
var VENDOR_NAMES = {
  ga4: "Google Analytics 4",
  "google-ads": "Google Ads",
  meta: "Meta",
  "meta-capi": "Meta Conversions API",
  pinterest: "Pinterest",
  sgtm: "server container",
  linkedin: "LinkedIn",
  "microsoft-uet": "Microsoft UET",
  reddit: "Reddit"
};
function vendorName(key) {
  return Object.hasOwn(VENDOR_NAMES, key) ? VENDOR_NAMES[key] : key;
}
function vendorLabel(key) {
  const name = vendorName(key);
  return name === key ? key : `${name} (${key})`;
}
var byVendorName = (a, b) => vendorName(a).localeCompare(vendorName(b)) || a.localeCompare(b);
function rowLabel(row) {
  return row.server ? `${vendorLabel(row.vendor)}, sent by the server container` : vendorLabel(row.vendor);
}

// packages/cli/src/report/verdict.ts
function emptyFindings() {
  return { hits: /* @__PURE__ */ new Map(), identifiers: /* @__PURE__ */ new Map(), failed: 0, warned: 0, failedChecks: /* @__PURE__ */ new Map(), warnedChecks: /* @__PURE__ */ new Map(), unchecked: 0, unlinkedServerHits: 0, probableServerHits: 0 };
}
function addFindings(into, model) {
  into.unlinkedServerHits += model.serverContainer?.unlinked ?? 0;
  into.probableServerHits += model.serverContainer?.probable ?? 0;
  const namedHere = /* @__PURE__ */ new Set();
  for (const row of model.rows) {
    row.segments.forEach((segment, i) => {
      if (segment.mark !== "leak") return;
      const target = segment.label === IDENTIFIER_LEAK || segment.label === IDENTIFIER_EARLY ? into.identifiers : into.hits;
      if (segment.label === IDENTIFIER_LEAK) namedHere.add("deniedIdentifiers");
      if (segment.label === IDENTIFIER_EARLY) namedHere.add("earlyIdentifiers");
      const label = model.columns[i].label;
      const vendors = target.get(label) ?? /* @__PURE__ */ new Set();
      vendors.add(row.vendor);
      target.set(label, vendors);
    });
  }
  const failedHere = /* @__PURE__ */ new Set();
  const warnedHere = /* @__PURE__ */ new Set();
  for (const e of model.expectations) {
    if (e.status === "CANNOT EVALUATE") into.unchecked++;
    else if (e.status === "FAIL" || e.status === "WARN") {
      const failing = e.status === "FAIL";
      if (e.kind === "builtin") {
        const name = e.text.replace(/^builtin: /, "");
        if (!namedHere.has(name)) (failing ? failedHere : warnedHere).add(name);
      } else if (failing) into.failed++;
      else into.warned++;
    }
  }
  for (const name of failedHere) into.failedChecks.set(name, (into.failedChecks.get(name) ?? 0) + 1);
  for (const name of warnedHere) into.warnedChecks.set(name, (into.warnedChecks.get(name) ?? 0) + 1);
}
function list(names) {
  const all = [...names].sort(byVendorName).map(vendorName);
  return all.length < 2 ? all.join("") : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
}
var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function checkParts(checks, verb, inRuns) {
  return [...checks].sort(([a], [b]) => a.localeCompare(b)).map(([name, runs]) => `built-in check ${name} ${verb}${inRuns ? ` in ${plural(runs, "run")}` : ""}`);
}
function findingsSentence(f, inRuns = false) {
  const parts = [];
  for (const [label, vendors] of [...f.hits].sort(([a], [b]) => a.localeCompare(b))) parts.push(`${list(vendors)} ${vendors.size === 1 ? "sends" : "send"} hits in the ${label} state`);
  for (const [label, vendors] of [...f.identifiers].sort(([a], [b]) => a.localeCompare(b))) parts.push(`identifiers go out to ${list(vendors)} in the ${label} state`);
  if (parts.length === 0 && f.unchecked === 0) parts.push("no leaks");
  if (f.failed > 0) parts.push(`${plural(f.failed, "rule")} failed`);
  parts.push(...checkParts(f.failedChecks, "failed", inRuns));
  if (f.unchecked > 0) parts.push(`${plural(f.unchecked, "expectation")} could not be checked`);
  if (f.warned > 0) parts.push(`${plural(f.warned, "rule")} warned`);
  parts.push(...checkParts(f.warnedChecks, "warned", inRuns));
  if (f.unlinkedServerHits > 0) parts.push(`${plural(f.unlinkedServerHits, "server container hit")} could not be linked to a browser hit`);
  if (f.probableServerHits > 0) parts.push(`${plural(f.probableServerHits, "server container hit")} placed by a probable link`);
  return parts.join("; ");
}
function runVerdict(model) {
  const findings = emptyFindings();
  addFindings(findings, model);
  return `Verdict: ${findingsSentence(findings)}.`;
}

// packages/cli/src/report/render.ts
var CSP = "default-src 'none'; style-src 'unsafe-inline'";
var ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(text2) {
  return text2.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}
var MARK_NAME = {
  full: "full",
  ping: "ping",
  nothing: "nothing",
  leak: "leak",
  unchecked: "unchecked",
  mixed: "mixed",
  early: "early"
};
var LEGEND = {
  full: "hits sent with every known signal granted, or with no consent signal known after an answer",
  early: "hit sent before the person answered, with no consent default set",
  ping: "hit sent while denied, no identifiers recorded",
  nothing: "no hit",
  leak: "identifier names sent while their signal was denied or before any answer, or named by a failed consent-scoped mustNot",
  unchecked: "denied, but the body was not fully recorded, or identifier names whose consent signal is unknown, so the hit cannot be called clean",
  mixed: "some signals denied, or granted and denied hits in one segment"
};
var GLYPHS = {
  full: '<circle cx="7" cy="7" r="5.5" fill="currentColor"/>',
  ping: '<circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/>',
  nothing: '<line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="2"/>',
  leak: '<polygon points="7,1 13,13 1,13" fill="currentColor"/>',
  unchecked: '<polygon points="7,1 13,7 7,13 1,7" fill="none" stroke="currentColor" stroke-width="2"/>',
  early: '<polygon points="1,1 13,1 7,13" fill="none" stroke="currentColor" stroke-width="2"/>',
  mixed: '<path d="M7 1.5a5.5 5.5 0 0 0 0 11z" fill="currentColor"/><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/>'
};
function glyph(mark) {
  return `<svg class="glyph" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">${GLYPHS[mark]}</svg>`;
}
function segmentCell(segment) {
  const label = segment.label ? `<span class="why">${escapeHtml(segment.label)}</span>` : "";
  const count = segment.hits ? `<span class="count">${segment.hits} hit${segment.hits === 1 ? "" : "s"}${segment.probable ? `, ${segment.probable} by probable link` : ""}</span>` : "";
  return `<td class="m-${segment.mark}">${glyph(segment.mark)}<span class="name">${MARK_NAME[segment.mark]}</span>${count}${label}</td>`;
}
var SERVER_CAVEAT = "Server container rows show what the local container sent on. Stape-only features, tags that need the hosting layer, unpublished workspaces and calls that no decoder matched are not shown. Hits with no link to a browser hit are in the unlinked column.";
function timeline(model) {
  if (model.rows.length === 0) return '<p class="empty">No vendor hits were recorded.</p>';
  const head = model.columns.map((c) => `<th scope="col">${escapeHtml(c.label)}</th>`).join("");
  const body = [...model.rows].sort((a, b) => byVendorName(a.vendor, b.vendor) || Number(a.server ?? false) - Number(b.server ?? false)).map((row) => `<tr><th scope="row">${escapeHtml(rowLabel(row))}</th>${row.segments.map(segmentCell).join("")}</tr>`).join("");
  const legend = Object.keys(LEGEND).map((m) => `<li class="m-${m}">${glyph(m)}<strong>${m}</strong> ${escapeHtml(LEGEND[m])}</li>`).join("");
  const server = model.serverContainer ? `<p class="empty">${escapeHtml(SERVER_CAVEAT)}</p>` : "";
  return `<div class="scroll"><table class="timeline"><thead><tr><th scope="col">Vendor</th>${head}</tr></thead><tbody>${body}</tbody></table></div><ul class="legend">${legend}</ul>${server}`;
}
function expectation(e) {
  const status = e.status.toLowerCase().replace(" ", "-");
  const evidence = e.evidenceCount ? `<span class="evidence">evidence: ${e.evidence.map(escapeHtml).join(", ")}${e.evidenceCount > e.evidence.length ? ` and ${e.evidenceCount - e.evidence.length} more` : ""} (${e.evidenceCount})</span>` : "";
  const note = e.note ? `<span class="note">${escapeHtml(e.note)}</span>` : "";
  const severity = e.severity ? `<span class="severity">on failure: ${escapeHtml(e.severity)}</span>` : "";
  return `<li class="s-${status}"><span class="status">${escapeHtml(e.status)}</span><code>${escapeHtml(e.text)}</code>${severity}${note}${evidence}</li>`;
}
function expectations(model) {
  if (model.expectations.length === 0) return '<p class="empty">The scenario has no expectations.</p>';
  return `<ul class="results">${model.expectations.map(expectation).join("")}</ul>`;
}
function flagHosts(f) {
  if (!f.hostCounts) return f.hosts.map(escapeHtml).join(", ");
  const items = f.hostCounts.map((h) => `<li>${escapeHtml(h.host)}: ${h.count}</li>`).join("");
  return `<details><summary>${f.hostCounts.length} ${f.hostCounts.length === 1 ? "host" : "hosts"}</summary><ul>${items}</ul></details>`;
}
function flags(model) {
  if (model.flags.length === 0) return '<p class="empty">No flags.</p>';
  const rows = model.flags.map((f) => `<tr><td>${escapeHtml(f.kind)}</td><td>${f.count}</td><td>${flagHosts(f)}</td></tr>`).join("");
  return `<div class="scroll"><table><thead><tr><th scope="col">Kind</th><th scope="col">Count</th><th scope="col">Hosts</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function fields(model) {
  if (!model.fields) return `<p class="empty">not recorded (record schema version ${model.header.schemaVersion})</p>`;
  if (model.fields.length === 0) return '<p class="empty">No hit was sent while a signal was denied.</p>';
  const items = [...model.fields].sort((a, b) => byVendorName(a.vendor, b.vendor)).map((v) => `<li><strong>${escapeHtml(vendorLabel(v.vendor))}</strong> ${v.names.map((n) => `<code>${escapeHtml(n)}</code>`).join(" ")}</li>`).join("");
  return `<ul class="fields">${items}</ul>`;
}
function skippedFields(model, level) {
  if (model.skippedFields.length === 0) return "";
  const items = model.skippedFields.map((f) => `<li>${escapeHtml(f.step)}: SKIPPED FIELD <code>${escapeHtml(f.selector)}</code> (not present)</li>`).join("");
  return `
<${level}>Skipped fields</${level}>
<ul class="fields">${items}</ul>`;
}
var STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f24;--muted:#57606a;--line:#d0d7de;--card:#f6f8fa;--full:#1a7f37;--ping:#9a6700;--nothing:#6e7781;--leak:#cf222e;--unchecked:#8250df;--mixed:#bc4c00;--early:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--card:#161b22;--full:#3fb950;--ping:#d29922;--nothing:#8b949e;--leak:#ff7b72;--unchecked:#d2a8ff;--mixed:#ffa657;--early:#58a6ff}}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:960px;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 4px}
h2{font-size:1.15rem;margin:32px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
dl.header{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;margin:12px 0;color:var(--muted)}
dl.header dd{margin:0;color:var(--fg);overflow-wrap:anywhere}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
thead th{background:var(--card)}
td .name{font-weight:600;margin-left:6px}
td .count,td .why{display:block;color:var(--muted);font-size:.85rem}
.glyph{vertical-align:-2px}
.m-full{color:var(--full)}.m-ping{color:var(--ping)}.m-nothing{color:var(--nothing)}.m-leak{color:var(--leak)}.m-unchecked{color:var(--unchecked)}.m-mixed{color:var(--mixed)}.m-early{color:var(--early)}
.legend{list-style:none;padding:0;margin:12px 0;display:grid;gap:4px;font-size:.9rem}
.legend strong{margin:0 4px}
.legend li{color:var(--fg)}
.legend .glyph{color:inherit}
.results,.fields{list-style:none;padding:0;margin:0;display:grid;gap:8px}
.results li,.fields li{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px 10px;overflow-wrap:anywhere}
.results .status{font-weight:700;margin-right:8px}
.s-pass .status{color:var(--full)}.s-warn .status{color:var(--ping)}.s-fail .status{color:var(--leak)}.s-cannot-evaluate .status{color:var(--unchecked)}
.results .note,.results .evidence,.results .severity{display:block;color:var(--muted);font-size:.85rem}
code{font:13px ui-monospace,monospace}
.verdict{font-size:1.05rem;font-weight:600;margin:12px 0}
.verdicts{padding-left:20px}
.empty{color:var(--muted)}
.caveat{color:var(--muted);font-size:.85rem;margin-top:32px}
.warn-box{color:var(--ping);border:1px solid var(--line);border-radius:6px;padding:8px 10px;background:var(--card);margin:8px 0}
h3{font-size:1rem;margin:20px 0 6px}
h4{font-size:.95rem;margin:16px 0 6px;color:var(--muted)}
`;
function definitionList(pairs) {
  return `<dl class="header">${pairs.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>`;
}
function runHeader(h) {
  const header = [
    ["Run", h.runId],
    ["Started", h.startedAt],
    ["Network mode", h.networkMode],
    ["Site host", h.host],
    ["Tagreeve", h.pingwrightVersion],
    ["Record schema", String(h.schemaVersion)]
  ];
  if (h.viewport) header.splice(3, 0, ["Viewport", h.viewport]);
  if (h.label) header.splice(1, 0, ["Label", h.label]);
  if (h.variant) header.splice(1, 0, ["Variant", h.variant]);
  return header;
}
function runSections(model, level) {
  return `<${level}>Timeline per vendor</${level}>
${timeline(model)}
<${level}>Expectations</${level}>
${expectations(model)}
<${level}>Flags</${level}>
${flags(model)}
<${level}>Fields seen while a signal was denied</${level}>
${fields(model)}${skippedFields(model, level)}`;
}
function page(body, title) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
<p class="caveat">Names and counts only. A mark describes what Tagreeve recorded. It is not a statement of legal compliance.</p>
</main>
</body>
</html>
`;
}
var dayOf = (iso) => iso.slice(0, 10);
function runTitle(h) {
  return `Tagreeve run: ${h.scenario}${h.host ? ` on ${h.host}` : ""}, ${dayOf(h.startedAt)}`;
}
function renderReport(model) {
  const title = runTitle(model.header);
  return page(`<h1>${escapeHtml(title)}</h1>
${definitionList(runHeader(model.header))}
<p class="verdict">${escapeHtml(runVerdict(model))}</p>
${runSections(model, "h2")}`, title);
}

// packages/cli/src/report/suite.ts
import { readdir as readdir4, readFile as readFile9 } from "node:fs/promises";
import { basename as basename3, join as join14 } from "node:path";

// packages/cli/src/suite.ts
import { mkdir as mkdir4, readdir as readdir3, readFile as readFile8, writeFile as writeFile4 } from "node:fs/promises";
import { basename as basename2, extname, join as join13 } from "node:path";

// packages/cli/src/project-config.ts
import { readFile as readFile4 } from "node:fs/promises";
var DEFAULT_CONFIG = "tagreeve/config.yml";
var ProjectConfigLoadError = class extends Error {
};
async function loadProjectConfig(flag2) {
  const path = flag2 ?? DEFAULT_CONFIG;
  let text2;
  try {
    text2 = await readFile4(path, "utf8");
  } catch (error) {
    const code = error instanceof Error ? error.code : void 0;
    if (flag2 === void 0 && code === "ENOENT") return void 0;
    throw new ProjectConfigLoadError(`Cannot read ${path}: ${code ?? "unknown error"}`);
  }
  try {
    const config = parseProjectConfig(text2, path);
    return { path, config, ...flag2 === void 0 && { defaultUsed: { setting: "config", path: DEFAULT_CONFIG } } };
  } catch (error) {
    if (!(error instanceof ProjectConfigError)) throw error;
    throw new ProjectConfigLoadError(`${path} is not a valid project config:
${error.issues.map((i) => `  ${i}`).join("\n")}`);
  }
}
function formatDefaults(defaults) {
  if (!defaults?.length) return void 0;
  const config = defaults.filter((d) => d.setting === "config");
  const rest = formatDefaultsLine(defaults.filter((d) => d.setting !== "config"))?.slice("Defaults: ".length);
  const parts = [...config.map((d) => `${d.path} (project config)`), ...rest ? [rest] : []];
  return `Defaults: ${parts.join(", ")}`;
}
function siteMissingMessage(config) {
  return config ? `--site is required. Give --site or set site in ${config.path}.` : "--site is required";
}
var ALLOW_TEST_PAYMENT_NEEDS_SITE = "--allow-test-payment needs --site on the command line. A site from the project config never supplies the host a test payment runs on.";

// packages/cli/src/stores.ts
import { constants } from "node:fs";
import { access, readFile as readFile5, stat as stat4 } from "node:fs/promises";
import { dirname as dirname4, resolve as resolve2 } from "node:path";
var STORE_NAME = /^[a-z0-9][a-z0-9_-]*$/;
var MAX_STORES = 50;
var STORE_KEYS = ["name", "site", "vars", "country", "autoconsentRules"];
var StoresError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "StoresError";
  }
};
var isMap3 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
async function readStores(path) {
  let text2;
  try {
    text2 = await readFile5(path, "utf8");
  } catch (error) {
    throw new StoresError(`Cannot read ${path}: ${error.code ?? "unknown error"}`);
  }
  let json;
  try {
    json = JSON.parse(text2);
  } catch {
    throw new StoresError(`${path} is not valid JSON.`);
  }
  if (!isMap3(json)) throw new StoresError(`${path} must be a JSON object with storesSchemaVersion and stores.`);
  if (json.storesSchemaVersion !== 1) throw new StoresError(`${path}: storesSchemaVersion must be 1.`);
  const list2 = json.stores;
  if (!Array.isArray(list2) || list2.length < 1 || list2.length > MAX_STORES) {
    throw new StoresError(`${path}: stores must be a list of 1 to ${MAX_STORES} stores.`);
  }
  const names = /* @__PURE__ */ new Set();
  const stores = list2.map((entry, index) => {
    const fail = (reason) => {
      throw new StoresError(`${path}: store ${index} ${reason}.`);
    };
    if (!isMap3(entry)) return fail("must be an object");
    for (const key of Object.keys(entry)) if (!STORE_KEYS.includes(key)) fail("has an unknown field");
    const { name, site, vars, country, autoconsentRules } = entry;
    if (typeof name !== "string" || !STORE_NAME.test(name)) return fail(`needs a name that matches ${STORE_NAME.source}`);
    if (names.has(name)) return fail("has a name that another store has");
    names.add(name);
    if (typeof site !== "string") return fail("needs a site");
    try {
      const protocol = new URL(site).protocol;
      if (protocol !== "http:" && protocol !== "https:") throw new Error();
    } catch {
      return fail("needs a site that is an http or https URL");
    }
    const storeVars = {};
    if (vars !== void 0) {
      if (!isMap3(vars)) return fail("has vars that are not an object");
      for (const [key, value] of Object.entries(vars)) {
        if (typeof value !== "string") return fail("has a var that is not a string");
        storeVars[key] = value;
      }
    }
    if (country !== void 0 && (typeof country !== "string" || !country.trim())) return fail("has a country that is not a non-empty string");
    if (autoconsentRules !== void 0 && (typeof autoconsentRules !== "string" || !autoconsentRules)) return fail("has autoconsentRules that are not a path");
    return {
      name,
      site,
      vars: storeVars,
      ...country !== void 0 && { country },
      ...autoconsentRules !== void 0 && { autoconsentRules: resolve2(dirname4(path), autoconsentRules) }
    };
  });
  for (const [index, store] of stores.entries()) {
    if (store.autoconsentRules === void 0) continue;
    const rules = store.autoconsentRules;
    const readable = await stat4(rules).then(
      async (s) => s.isFile() && await access(rules, constants.R_OK).then(() => true, () => false),
      () => false
    );
    if (!readable) throw new StoresError(`${path}: store ${index} has autoconsentRules that are not a readable file.`);
  }
  return stores;
}

// packages/cli/src/test-payment-hosts.ts
import { readFile as readFile6, stat as stat5 } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute as isAbsolute2, join as join11 } from "node:path";
var FILE_NAME = "test-payment-hosts.json";
function testPaymentHostsPath(env = process.env, home = homedir()) {
  const xdg = env.XDG_CONFIG_HOME;
  const base2 = xdg && isAbsolute2(xdg) ? xdg : join11(home, ".config");
  return join11(base2, "tagreeve", FILE_NAME);
}
function acceptsDeclaration(host, testMode, loopbackHosted = loopbackIsHostedForTests()) {
  const loopback = isLoopbackHost(normalizeHost(host));
  if (testMode === "fixture") return loopback && loopbackHosted;
  return !loopback;
}
function entryError(path, index, reason) {
  return new Error(`${path}: entry ${index} ${reason}.`);
}
function parseEntry3(path, entry, index, loopbackHosted) {
  if (typeof entry === "string") return { host: normalizeHost(entry) };
  const keys = entry && typeof entry === "object" && !Array.isArray(entry) ? Object.keys(entry) : [];
  const { host, testMode } = entry ?? {};
  if (typeof host !== "string" || typeof testMode !== "string" || keys.length !== 2) {
    throw entryError(path, index, 'must be a host name or an object with only "host" and "testMode"');
  }
  const normalized = normalizeHost(host);
  if (!findPaymentProvider(testMode)) throw entryError(path, index, "names a testMode that is not a payment provider");
  if (!acceptsDeclaration(normalized, testMode, loopbackHosted)) {
    throw entryError(path, index, "declares a loopback host or the fixture provider, which only tests may do");
  }
  return { host: normalized, testMode };
}
async function readTestPaymentHosts(path, loopbackHosted = loopbackIsHostedForTests()) {
  let mode;
  try {
    mode = (await stat5(path)).mode;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${path} does not exist. Create it with a JSON array of the hosts that may run test payments.`);
    throw new Error(`Cannot read ${path}.`);
  }
  if (process.platform !== "win32" && (mode & 18) !== 0) {
    throw new Error(`${path} must not be writable by group or others. Run: chmod go-w ${path}.`);
  }
  let json;
  try {
    json = JSON.parse(await readFile6(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  if (!Array.isArray(json)) throw new Error(`${path} must be a JSON array of host names or { "host", "testMode" } objects.`);
  return json.map((entry, index) => parseEntry3(path, entry, index, loopbackHosted));
}
async function checkTestPaymentGates(parsed, site, allow, env = process.env) {
  const payments = parsed.steps.filter((s) => s.kind === "payment");
  if (payments.length === 0) return { ok: true };
  const siteHost = normalizeHost(new URL(site).hostname);
  for (const step of payments) {
    const blocked = step.kind === "payment" ? providerBlockedOnSite(step.value.provider, siteHost) : void 0;
    if (blocked) return { ok: false, error: `${blocked}.` };
  }
  if (allow === void 0) {
    return { ok: false, error: `The scenario has a payment step. Test payments need --allow-test-payment ${siteHost}.` };
  }
  if (normalizeHost(allow) !== siteHost) {
    return { ok: false, error: `--allow-test-payment must name the --site host (${siteHost}).` };
  }
  let entries;
  try {
    entries = await readTestPaymentHosts(testPaymentHostsPath(env));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const own = entries.filter((e) => e.host === siteHost);
  if (own.length === 0) {
    return { ok: false, error: `${siteHost} is not in ${testPaymentHostsPath(env)}.` };
  }
  const declaredProviders = own.flatMap((e) => e.testMode ? [e.testMode] : []);
  return { ok: true, testPayment: { host: siteHost, ...declaredProviders.length && { declaredProviders } } };
}

// packages/cli/src/run.ts
import { appendFile as appendFile2, readFile as readFile7, rename, writeFile as writeFile3 } from "node:fs/promises";
import { basename, join as join12 } from "node:path";

// packages/cli/src/summary.ts
var EVIDENCE_CAP = 5;
var PATH_EXAMPLES = 3;
var SANDBOX_PATH_EXAMPLES = 1;
var PURPOSE_ORDER = ["telemetry", "checkout", "payments", "cdn"];
var GROUPED_KINDS = /* @__PURE__ */ new Set(["unknownDestination", "firstPartySubdomain"]);
function countHits(hits) {
  const out = {};
  for (const hit of hits) {
    const events = out[hit.vendor] ??= {};
    const name = hit.event ?? "(no event)";
    events[name] = (events[name] ?? 0) + 1;
  }
  return out;
}
function stateName(state) {
  const known = Object.values(state).filter((v) => v !== "unknown");
  if (known.length === 0) return "unknown";
  return known.every((v) => v === known[0]) ? known[0] : "mixed";
}
function testPaymentOf(records) {
  const payment = (records.steps ?? []).find((s) => s.payment)?.payment;
  return payment && { provider: payment.provider, host: new URL(records.run.site).hostname, testMode: payment.testMode ?? "marker" };
}
function serverContainerOf(records) {
  const container = records.run.serverContainer;
  if (!container) return void 0;
  const index = judgeIndex(records.hits, records.requests);
  const sent = records.hits.filter((h) => isServerHit(h, index));
  const linked = sent.filter((h) => viaHitOf(h, index));
  const { serverjs, config, destination } = container.passThrough;
  return {
    calls: sent.length,
    exact: linked.filter((h) => h.via?.confidence === "exact").length,
    probable: linked.filter((h) => h.via?.confidence === "probable").length,
    unlinked: sent.length - linked.length,
    forwarded: serverjs + config + destination,
    ...container.error && { error: container.error }
  };
}
function buildSummary(records, results, path) {
  const testPayment = testPaymentOf(records);
  const serverContainer = serverContainerOf(records);
  return {
    runId: records.run.id,
    ...records.run.label !== void 0 && { label: records.run.label },
    path,
    pass: results.every((r) => r.pass),
    ok: results.every(passesGate),
    hits: countHits(records.hits),
    epochs: records.consentEpochs.map((e) => ({ label: e.label, state: stateName(e.state), startT: e.startT, endT: e.endT })),
    flags: records.flags.map((f) => ({ kind: f.kind, detail: redactFlagDetail(f.detail) })),
    ...testPayment && { testPayment },
    ...records.run.testServerContainer && { testServerContainer: true },
    ...serverContainer && { serverContainer },
    skippedFields: (records.steps ?? []).flatMap((s) => (s.skippedFields ?? []).map((selector) => ({ step: s.label, selector }))),
    results: results.map((r) => ({ expectation: r.expectation, pass: r.pass, message: r.message, ...r.note && { note: r.note }, evidence: r.evidence, severity: r.severity ?? "fail" }))
  };
}
function applyBaseline(summary, baseline) {
  summary.baseline = baseline;
  if (baseline.drift) {
    summary.pass = false;
    summary.ok = false;
  }
}
function passesGate(r) {
  return r.pass || r.severity === "warn";
}
function exitCodeFor(results) {
  return results.every(passesGate) ? 0 : 1;
}
function formatFlags(flags2) {
  const lines = [];
  const groups = /* @__PURE__ */ new Map();
  let realData = 0;
  for (const f of flags2) {
    if (f.kind === "possibleRealData") {
      realData += 1;
      continue;
    }
    if (f.kind === "platformHost" && platformOf(f)) continue;
    const target = groupTarget(f);
    if (!target) {
      lines.push(`  ${f.kind}: ${f.detail}`);
      continue;
    }
    const { label, url } = target;
    const key = `${f.kind} ${label}`;
    const group = groups.get(key) ?? { kind: f.kind, host: label, count: 0, paths: /* @__PURE__ */ new Set() };
    group.count += 1;
    group.paths.add(url.pathname);
    groups.set(key, group);
  }
  for (const { kind, host, count, paths } of groups.values()) {
    const shown2 = [...paths].slice(0, kind === "sandboxPageUrl" ? SANDBOX_PATH_EXAMPLES : PATH_EXAMPLES);
    const more = paths.size - shown2.length;
    lines.push(`  ${kind}: ${host} x${count} (${shown2.join(", ")}${more > 0 ? ` and ${more} more` : ""})`);
  }
  if (realData > 0) lines.push(`  possibleRealData: x${realData}`);
  lines.push(...platformHostLines(flags2));
  return lines;
}
var URL_TOKEN = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;
var URL_PARTS = /^(?:(?:([a-z][a-z0-9+.-]*:)?\/\/)([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#.*)?$/is;
var RECEIVED_PAGE = /^(\S+ received )(.+)( as the page)$/s;
var URL_AT_END = /^(.*?(?:\b[A-Z]+ |: ))((?:[a-z][a-z0-9+.-]*:)?\/\/.*|\/.*)$/s;
function queryName(pair) {
  const eq = pair.indexOf("=");
  return eq < 0 ? OTHER_NAME : guardFieldName(pair.slice(0, eq));
}
function redactUrl(raw) {
  const [, scheme = "", authority, path = "", query] = URL_PARTS.exec(raw);
  const origin = authority === void 0 ? "" : `${scheme}//${authority.slice(authority.lastIndexOf("@") + 1).replace(/\s/g, "")}`;
  const names = new Set((query ?? "").split("&").filter(Boolean).map(queryName));
  return `${origin}${maskValuePath(path.replace(/\s/g, "%20"), OTHER_NAME)}${names.size > 0 ? `?${[...names].join("&")}` : ""}`;
}
function redactFlagDetail(detail) {
  const page2 = RECEIVED_PAGE.exec(detail);
  if (page2) return `${page2[1]}${redactUrl(page2[2])}${page2[3]}`;
  const tail = URL_AT_END.exec(detail);
  if (tail) return `${tail[1]}${redactUrl(tail[2])}`;
  return detail.replace(URL_TOKEN, redactUrl);
}
function groupTarget(flag2) {
  if (GROUPED_KINDS.has(flag2.kind)) {
    const url = parseUrl2(/\s(\S+)$/.exec(flag2.detail)?.[1]);
    return url && { label: url.host, url };
  }
  if (flag2.kind === "sandboxPageUrl") {
    const match = /^(\S+) received (\S+) as the page$/.exec(flag2.detail);
    const url = parseUrl2(match?.[2]);
    return match && url ? { label: match[1], url } : void 0;
  }
  return void 0;
}
function parseUrl2(text2) {
  try {
    return text2 ? new URL(text2) : void 0;
  } catch {
    return void 0;
  }
}
function formatDuration2(ms) {
  const rounded = Math.round(ms);
  return rounded < 1e3 ? `${rounded} ms` : `${(ms / 1e3).toFixed(1)} s`;
}
var SERVER_CONTAINER_LIMITS = "  Not shown: Stape-only features, tags that need the hosting layer, unpublished workspaces, calls no decoder matched (flagged unknown)";
function serverContainerLines(summary) {
  const { serverContainer: c, testServerContainer } = summary;
  const head = testServerContainer ? "stand-in container (test seam)" : c?.error ? `failed (${c.error})` : "image ok";
  if (!c) return testServerContainer ? [`Server container: ${head}`] : [];
  const error = testServerContainer && c.error ? `, failed (${c.error})` : "";
  const calls = `${c.calls} vendor call${c.calls === 1 ? "" : "s"}, ${c.exact} linked exactly, ${c.probable} probable, ${c.unlinked} unlinked`;
  return [`Server container: ${head}${error}; ${calls}; ${c.forwarded} request${c.forwarded === 1 ? "" : "s"} forwarded to Google`, SERVER_CONTAINER_LIMITS];
}
function formatSummary(summary) {
  const lines = [];
  if (summary.label !== void 0) lines.push(`Label: ${summary.label}`);
  const defaultsLine = formatDefaults(summary.defaults);
  if (defaultsLine) lines.push(defaultsLine);
  if (summary.testPayment) {
    const { provider, host, testMode } = summary.testPayment;
    lines.push(`TEST PAYMENT: ${provider} on ${host} (test mode ${testMode === "declared" ? "declared" : "on page"})`);
  }
  lines.push(...serverContainerLines(summary));
  lines.push("Hits");
  const vendors = Object.entries(summary.hits);
  if (vendors.length === 0) lines.push("  none");
  for (const [vendor, events] of vendors) {
    lines.push(`  ${vendor}: ${Object.entries(events).map(([e, n]) => `${e} x${n}`).join(", ")}`);
  }
  lines.push("Consent epochs");
  for (const e of summary.epochs) {
    const label = e.label === "withdrawn" && e.state ? `withdrawn, ${e.state}` : e.label;
    lines.push(`  ${label} (${e.endT === null ? "to end" : formatDuration2(e.endT - e.startT)})`);
  }
  lines.push("Flags");
  if (summary.flags.length === 0) lines.push("  none");
  lines.push(...formatFlags(summary.flags));
  if (summary.skippedFields?.length) {
    lines.push("Skipped fields");
    for (const step of new Set(summary.skippedFields.map((f) => f.step))) {
      lines.push(`  ${step}`);
      for (const f of summary.skippedFields) if (f.step === step) lines.push(`    SKIPPED FIELD ${f.selector} (not present)`);
    }
  }
  lines.push("Expectations");
  for (const r of summary.results) {
    lines.push(`  ${r.pass ? "PASS" : r.severity === "warn" ? "WARN" : "FAIL"} ${r.expectation}`);
    if (r.note) lines.push(`       note: ${NOTE_TEXT[r.note]}`);
    if (!r.pass && r.message) lines.push(`       ${r.message}`);
    if (r.evidence.length) {
      const shown2 = r.evidence.slice(0, EVIDENCE_CAP);
      const more = r.evidence.length - shown2.length;
      lines.push(`       evidence: ${shown2.join(", ")}${more > 0 ? ` and ${more} more` : ""}`);
    }
  }
  if (summary.baseline) {
    const b = summary.baseline;
    lines.push(`Baseline: ${b.drift ? "drift" : "no drift"} (${b.added} added, ${b.removed} removed, ${b.countChanges} count changes)`);
    for (const w of b.warnings) lines.push(`  Warning: ${w}`);
    for (const c of b.changes) lines.push(`  ${c}`);
  }
  const failed = summary.results.filter((r) => !passesGate(r)).length;
  const warned = summary.results.filter((r) => !r.pass && passesGate(r)).length;
  const warnings = warned > 0 ? ` with ${warned} warning${warned === 1 ? "" : "s"}` : "";
  if (failed === 0 && summary.baseline?.drift) lines.push(`Result: fail (baseline drift)${warnings}`);
  else lines.push(failed === 0 ? `Result: pass${warnings}` : `Result: fail (${failed} of ${summary.results.length})${warnings}`);
  lines.push(`Record: ${summary.path}`);
  return lines.join("\n");
}
function platformOf(flag2) {
  const url = parseUrl2(/\s(\S+)$/.exec(flag2.detail)?.[1]);
  const entry = url && platformHostFor({ url: url.href });
  return url && entry ? { url, entry } : void 0;
}
function platformHostLines(flags2) {
  const byPlatform = /* @__PURE__ */ new Map();
  for (const f of flags2) {
    if (f.kind !== "platformHost") continue;
    const found = platformOf(f);
    if (!found) continue;
    const { url, entry } = found;
    const group = byPlatform.get(entry.platform) ?? { requests: 0, hosts: /* @__PURE__ */ new Set(), purposes: /* @__PURE__ */ new Map() };
    group.requests += 1;
    group.hosts.add(url.host);
    group.purposes.set(entry.purpose, (group.purposes.get(entry.purpose) ?? 0) + 1);
    byPlatform.set(entry.platform, group);
  }
  return [...byPlatform].map(([platform, { requests, hosts, purposes }]) => {
    const parts = PURPOSE_ORDER.filter((p) => purposes.has(p)).map((p) => `${p} ${purposes.get(p)}`);
    return `  platformHost: ${platform}, ${requests} ${requests === 1 ? "request" : "requests"} to ${hosts.size} ${hosts.size === 1 ? "host" : "hosts"} (${parts.join(", ")})`;
  });
}

// packages/cli/src/run.ts
var MISSING_BROWSER = /Executable doesn't exist|playwright install/i;
function allRecords(records) {
  const { run, truncatedAtLine, ...rest } = records;
  void truncatedAtLine;
  return [run, ...Object.values(rest).flat()];
}
async function readGtmOverride(path, label = path) {
  let text2;
  try {
    text2 = await readFile7(path, "utf8");
  } catch (error) {
    throw new GtmOverrideError(`Cannot read ${label}: ${error instanceof Error ? error.code : "unknown error"}`);
  }
  let json;
  try {
    json = JSON.parse(text2);
  } catch {
    throw new GtmOverrideError(`${label} is not valid JSON`);
  }
  return parseGtmOverride(json);
}
async function readTrackerList(path) {
  let text2;
  try {
    text2 = await readFile7(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let json;
  try {
    json = JSON.parse(text2);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  try {
    return parseTrackerList(json);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function resolveNetwork(args, parsed, io, configPath) {
  const where2 = configPath === void 0 ? "in the scenario" : `in the scenario or in ${configPath}`;
  const networkMode = args.network ?? parsed.options.network ?? "stub";
  const serverHosts = parsed.options.serverHosts ?? [];
  if (args.serverContainer && networkMode !== "server") {
    io.stderr(`--server-container needs --network server and options.serverHosts ${where2}: the hits to those hosts are what the container receives.
`);
    return void 0;
  }
  if (networkMode === "server") {
    if (serverHosts.length === 0) {
      io.stderr(`Network mode "server" needs options.serverHosts ${where2}: the hosts whose requests pass through, such as sgtm.example.com.
`);
      return void 0;
    }
    const hosted = serverHosts.filter((host) => !isLoopbackPattern(host));
    if (hosted.length) io.stderr(`Warning: server mode. Requests to ${hosted.join(", ")} reach the network.
`);
  }
  if (args.netLog && networkMode !== "live") {
    io.stderr(`${NET_LOG_NEEDS_LIVE}
`);
    return void 0;
  }
  if (networkMode === "live") io.stderr("Warning: live mode. Hits reach real vendor accounts.\n");
  return networkMode;
}
async function prepareServerContainer(args, serverHosts, io, env = process.env) {
  if (!args.serverContainer) return null;
  const configSource = args.serverContainerConfig !== void 0 ? { kind: "file", path: args.serverContainerConfig } : { kind: "env" };
  try {
    const standIn = resolveStandInCommand(env, serverHosts);
    resolveUpstreamOrigin(env, serverHosts);
    if (standIn === void 0) {
      if (configSource.kind === "env" && !env[CONFIG_ENV]) {
        io.stderr(`--server-container needs the container config: give --server-container-config <file> or set ${CONFIG_ENV}.
`);
        return void 0;
      }
      loadContainerConfig(configSource, env);
    }
    const image = defaultServerContainerImage(readVersion(), env);
    if (standIn === void 0) await checkServerContainerHost({ image, env });
    return { configSource, image };
  } catch (error) {
    if (error instanceof ServerContainerError || error instanceof ServerContainerUsageError) {
      io.stderr(`${error.message}
`);
      return void 0;
    }
    throw error;
  }
}
function warnTestLoopbackHosted(io) {
  if (loopbackIsHostedForTests()) {
    io.stderr(`Warning: ${TEST_LOOPBACK_IS_HOSTED_ENV} is set. The fill, select and evaluate guards treat loopback hosts as hosted. This is for tests only.
`);
  }
}
function warnTestGtmOrigin(io) {
  const origin = parseTestGtmOrigin(process.env[TEST_GTM_ORIGIN_ENV]);
  if (origin) io.stderr(`Warning: ${TEST_GTM_ORIGIN_ENV} is set. gtm.js is fetched from ${origin}. This is for tests only.
`);
}
async function labelRecord(path, spec) {
  const { label, store, variant, out } = spec;
  if (label === void 0 && store === void 0 && !variant) return path;
  const text2 = await readFile7(path, "utf8");
  const newline = text2.indexOf("\n");
  const run = {
    ...JSON.parse(text2.slice(0, newline)),
    ...label !== void 0 && { label },
    ...store !== void 0 && { store },
    ...variant && { variant: variant.name }
  };
  await writeFile3(path, `${JSON.stringify(run)}${text2.slice(newline)}`);
  if (!variant) return path;
  const target = join12(out, `${variant.fileStem}.${variant.name}.jsonl`);
  await rename(path, target);
  return target;
}
function markerNotDetected(message) {
  return /test mode not detected(?! \()/.test(message);
}
function declarationHint(spec, label) {
  if (!spec.testPayment) return void 0;
  const payments = spec.parsed.steps.flatMap((s) => s.kind === "payment" ? [s] : []);
  const failed = label === void 0 ? void 0 : payments.find((s) => s.label === label);
  const providers = failed ? [failed.value.provider] : [...new Set(payments.map((s) => s.value.provider))];
  const host = spec.testPayment.host;
  const hints = providers.filter((provider) => acceptsDeclaration(host, provider)).map((provider) => `{ "host": "${host}", "testMode": "${provider}" }`);
  if (hints.length === 0) return void 0;
  return `Declare it in ${testPaymentHostsPath()} with ${hints.join(" or ")} if this store is in test mode.`;
}
async function executeRun(spec, rawIo) {
  const { parsed, gtmOverride, variant } = spec;
  let io = rawIo;
  const scrubber = gtmOverride ? new Scrubber(gtmOverride.gtmAuth) : void 0;
  if (scrubber) {
    io = { stdout: (t) => rawIo.stdout(scrubber.text(t)), stderr: (t) => rawIo.stderr(scrubber.text(t)) };
  }
  const failed = (error) => {
    io.stderr(error);
    return { code: 2, error: scrubber ? scrubber.text(error) : error };
  };
  let records;
  let path;
  try {
    const result = await recordScenario({
      networkMode: spec.network,
      serverHosts: parsed.options.serverHosts,
      outDir: spec.out,
      site: spec.site,
      scenario: spec.scenarioName,
      parsed,
      firstPartyHosts: parsed.options.firstPartyHosts,
      platformHosts: parsed.options.platformHosts,
      unloadGapIgnore: parsed.options.unloadGapIgnore,
      graceWindowMs: parsed.options.graceWindow ?? DEFAULT_GRACE_MS,
      seed: spec.seed,
      headed: spec.headed,
      viewport: spec.viewport ?? parsed.options.viewport,
      netLog: spec.netLog,
      autoconsent: spec.autoconsentRules.length ? { ruleFiles: spec.autoconsentRules } : void 0,
      gtmOverride,
      warn: (text2) => io.stderr(`Warning: ${text2}
`),
      trackerList: spec.trackers,
      ...spec.testPayment && { testPayment: spec.testPayment },
      ...spec.serverContainer && { serverContainer: spec.serverContainer },
      userAgentOverride: process.env.TAGREEVE_TEST_USER_AGENT || void 0
    });
    records = result.records;
    path = result.path;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (MISSING_BROWSER.test(message)) return failed("Chromium is not installed. Run `tagreeve install-browser`.\n");
    const prefix = error instanceof GtmOverrideFailure ? "GTM override: " : error instanceof ServerContainerFailure ? "Server container: " : "";
    let text2 = `Run failed: ${prefix}${message}
`;
    const declareHint = spec.testPayment && markerNotDetected(message) && declarationHint(spec, error instanceof StepError ? error.label : void 0);
    if (declareHint) text2 += `${declareHint}
`;
    const written = (error instanceof StepError || error instanceof GtmOverrideFailure || error instanceof ServerContainerFailure) && error.run ? error.run.path : void 0;
    if (written) {
      const kept = await labelRecord(written, spec);
      text2 += `Record: ${kept}
`;
      return { ...failed(text2), path: kept };
    }
    return failed(text2);
  }
  path = await labelRecord(path, spec);
  if (spec.label !== void 0) records.run.label = spec.label;
  if (spec.store !== void 0) records.run.store = spec.store;
  if (variant) records.run.variant = variant.name;
  let results = evaluate(allRecords(records), parsed);
  if (scrubber) results = scrubber.deep(results);
  await appendFile2(path, results.map((r) => JSON.stringify(r) + "\n").join(""));
  return { code: exitCodeFor(results), path, summary: buildSummary(records, results, path) };
}
async function loadConfigOrReport(flag2, io) {
  try {
    return { ok: true, loaded: await loadProjectConfig(flag2) };
  } catch (error) {
    if (!(error instanceof ProjectConfigLoadError)) throw error;
    io.stderr(`${error.message}
`);
    return { ok: false };
  }
}
async function runCommand(args, io) {
  if (args.allowTestPayment !== void 0 && args.site === void 0) {
    io.stderr(`${ALLOW_TEST_PAYMENT_NEEDS_SITE}
`);
    return 2;
  }
  const config = await loadConfigOrReport(args.config, io);
  if (!config.ok) return 2;
  const loaded = config.loaded;
  const site = args.site ?? loaded?.config.site;
  if (site === void 0) throw new UsageError(siteMissingMessage(loaded), "run");
  let text2;
  try {
    text2 = await readFile7(args.scenario, "utf8");
  } catch (error) {
    io.stderr(`Cannot read ${args.scenario}: ${error instanceof Error ? error.message : String(error)}
`);
    return 2;
  }
  const defaults = [];
  const trackerListPath = await resolveTrackerList(args.trackerList, defaults);
  const autoconsentRules = await resolveAutoconsentRules(args.autoconsentRules, defaults);
  let trackers = [];
  if (trackerListPath !== void 0) {
    try {
      trackers = await readTrackerList(trackerListPath);
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}
`);
      return 2;
    }
  }
  let parsed;
  try {
    parsed = parseScenario(text2, trackers.map((t) => t.vendor));
  } catch (error) {
    if (!(error instanceof ScenarioError)) throw error;
    io.stderr(`${args.scenario} is not a valid scenario:
${error.issues.map((i) => `  ${i}`).join("\n")}
`);
    return 2;
  }
  if (loaded) parsed.options = mergeOptions(loaded.config.options, parsed.options);
  for (const warning of parsed.warnings) io.stderr(`Warning: ${warning}
`);
  const undeclared = Object.keys(args.vars).filter((name) => !Object.hasOwn(parsed.vars, name));
  if (undeclared.length) {
    io.stderr(`--var ${undeclared.join(", ")} not declared in the scenario's vars. --var only overrides declared variables.
`);
    return 2;
  }
  parsed.vars = { ...parsed.vars, ...args.vars };
  const network = resolveNetwork(args, parsed, io, loaded?.path);
  if (!network) return 2;
  const serverContainer = await prepareServerContainer(args, parsed.options.serverHosts ?? [], io);
  if (serverContainer === void 0) return 2;
  const gates = await checkTestPaymentGates(parsed, site, args.allowTestPayment);
  if (!gates.ok) {
    io.stderr(`${gates.error}
`);
    return 2;
  }
  let baseline;
  let baselinePath = args.baseline;
  if (args.baselineDefault) {
    baselinePath = `${DEFAULT_BASELINES}/${baselineFileName(basename(args.scenario))}`;
    defaults.push({ setting: "baseline", path: baselinePath });
  }
  if (baselinePath !== void 0) {
    try {
      baseline = await readBaseline(baselinePath);
    } catch (error) {
      if (!(error instanceof BaselineError)) throw error;
      io.stderr(`${error.message}
`);
      return 2;
    }
  }
  let gtmOverride;
  try {
    parseTestGtmOrigin(process.env[TEST_GTM_ORIGIN_ENV]);
    if (args.gtmOverride !== void 0) gtmOverride = await readGtmOverride(args.gtmOverride);
  } catch (error) {
    if (!(error instanceof GtmOverrideError)) throw error;
    io.stderr(`${error.message}
`);
    return 2;
  }
  warnTestGtmOrigin(io);
  warnTestLoopbackHosted(io);
  const out = resolveOutDir({ out: args.out, now: /* @__PURE__ */ new Date(), label: args.label, base: loaded?.config.out });
  if (args.out === void 0 && loaded?.config.out === void 0) {
    const notice = await oldRunsNotice(process.cwd());
    if (notice) io.stderr(notice);
  }
  await warnIfNotIgnored(out, io.stderr);
  const outcome = await executeRun(
    {
      parsed,
      scenarioName: basename(args.scenario),
      network,
      site,
      out,
      ...args.label !== void 0 && { label: args.label },
      seed: args.seed,
      headed: args.headed,
      viewport: args.viewport,
      netLog: args.netLog,
      autoconsentRules,
      trackers,
      gtmOverride,
      ...gates.testPayment && { testPayment: gates.testPayment },
      ...serverContainer && { serverContainer }
    },
    io
  );
  if (!outcome.summary) return outcome.code;
  const listed = [...loaded?.defaultUsed ? [loaded.defaultUsed] : [], ...defaults];
  if (listed.length) outcome.summary.defaults = listed;
  let code = outcome.code === 1 ? 1 : 0;
  if (baseline && outcome.path) {
    applyBaseline(outcome.summary, compareBaseline(baseline, await readRun(outcome.path)));
    if (outcome.summary.baseline?.drift) code = 1;
  }
  const output = args.json ? `${JSON.stringify(outcome.summary, null, 2)}
` : `${formatSummary(outcome.summary)}
`;
  io.stdout(gtmOverride ? new Scrubber(gtmOverride.gtmAuth).text(output) : output);
  return code;
}

// packages/cli/src/suite.ts
var SCENARIO_EXTENSIONS = /* @__PURE__ */ new Set([".yml", ".yaml"]);
function suiteExitCode(cells) {
  return cells.some((c) => c.exitCode === 2) ? 2 : cells.some((c) => c.exitCode === 1) ? 1 : 0;
}
function statusOf(outcome) {
  const summary = outcome.summary;
  if (!summary) return "error";
  return !summary.ok ? "fail" : summary.pass ? "pass" : "warn";
}
function failedOf(outcome, status) {
  if (status !== "fail" && status !== "warn") return void 0;
  const severity = status === "fail" ? "fail" : "warn";
  const checks = /* @__PURE__ */ new Set();
  let rules = 0;
  for (const r of outcome.summary.results) {
    if (r.pass || r.severity !== severity) continue;
    const name = /^builtin: ([A-Za-z]+)$/.exec(r.expectation)?.[1];
    if (name) checks.add(name);
    else rules++;
  }
  return { rules, checks: [...checks] };
}
function cellText(cell) {
  if (cell.status === "error") return `ERROR (exit ${cell.exitCode})`;
  const label = cell.status.toUpperCase();
  const { rules = 0, checks = [] } = cell.failed ?? {};
  const drift = cell.baseline?.drift === true;
  const parts = [rules > 0 && `${rules} rule${rules === 1 ? "" : "s"}`, ...checks, drift && "baseline drift"].filter(Boolean);
  if (drift && parts.length === 1) return `${label} (baseline drift)`;
  return parts.length ? `${label}: ${parts.join(", ")}` : label;
}
function diffText(d) {
  if (!d) return "";
  const parts = [
    d.added && `+${d.added} added`,
    d.removed && `-${d.removed} removed`,
    d.changed && `${d.changed} changed`,
    d.flagsChanged && `${d.flagsChanged} flag change${d.flagsChanged === 1 ? "" : "s"}`
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no change";
}
function cellName(cell) {
  return [cell.scenario, cell.labels.store, cell.variant].filter(Boolean).join(" ");
}
function formatSuiteTable(manifest, dir) {
  const [first, ...others] = manifest.variants;
  const scenarios = [...new Set(manifest.cells.map((c) => c.scenario))];
  const stores = manifest.stores.map((s) => s.name);
  const header = ["scenario", ...stores.length ? ["store"] : [], ...manifest.variants, ...others.map((v) => `diff (${first} -> ${v})`)];
  const rows = scenarios.flatMap(
    (scenario) => (stores.length ? stores : [void 0]).map((store) => [
      scenario,
      ...store === void 0 ? [] : [store],
      ...manifest.variants.map((v) => cellText(manifest.cells.find((c) => c.scenario === scenario && c.labels.store === store && c.variant === v))),
      ...others.map((v) => diffText(manifest.diffs.find((d) => d.scenario === scenario && d.store === store && d.to === v)))
    ])
  );
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols) => cols.map((c, i) => i === cols.length - 1 ? c : c.padEnd(widths[i] + 3)).join("").trimEnd();
  const out = [line(header), ...rows.map(line)];
  const defaultsLine = formatDefaults(manifest.defaults);
  if (defaultsLine) out.push("", defaultsLine);
  const records = manifest.cells.filter((c) => c.record);
  if (records.length) out.push("", "Records", ...records.map((c) => `  ${cellName(c)}: ${join13(dir, c.record)}`));
  const drifted = manifest.cells.filter((c) => c.baseline?.drift);
  if (drifted.length) {
    out.push("", "Baseline drift", ...drifted.map((c) => `  ${cellName(c)}: ${c.baseline.file}: ${c.baseline.added} added, ${c.baseline.removed} removed, ${c.baseline.countChanges} count changes`));
  }
  const unfinished = manifest.cells.filter((c) => c.exitCode === 2);
  if (unfinished.length) {
    out.push("", "Errors", ...unfinished.map((c) => `  ${cellName(c)}: run did not finish (exit 2), ${c.record ? `details in ${join13(dir, c.record)}` : "details in the stderr above"}`));
  }
  out.push("", `Manifest: ${join13(dir, "suite.json")}`);
  return `${out.join("\n")}
`;
}
async function scan2(dir, trackers, configOptions, io) {
  let names;
  try {
    const entries = await readdir3(dir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && SCENARIO_EXTENSIONS.has(extname(e.name))).map((e) => e.name).sort();
  } catch (error) {
    io.stderr(`Cannot read ${dir}: ${error instanceof Error ? error.code : "unknown error"}
`);
    return void 0;
  }
  if (!names.length) {
    io.stderr(`${dir} has no .yml or .yaml scenario files
`);
    return void 0;
  }
  const loaded = [];
  const problems = [];
  const seen = /* @__PURE__ */ new Set();
  for (const file of names) {
    const name = basename2(file, extname(file));
    if (seen.has(name)) problems.push(`${file}: another file has the scenario name "${name}"`);
    seen.add(name);
    try {
      const parsed = parseScenario(await readFile8(join13(dir, file), "utf8"), trackers.map((t) => t.vendor));
      parsed.options = mergeOptions(configOptions, parsed.options);
      for (const warning of parsed.warnings) io.stderr(`Warning: ${file}: ${warning}
`);
      loaded.push({ name, parsed, handoff: hasHandoff(parsed), payment: hasPayment(parsed) });
    } catch (error) {
      if (!(error instanceof ScenarioError)) throw error;
      problems.push(`${file} is not a valid scenario:
${error.issues.map((i) => `    ${i}`).join("\n")}`);
    }
  }
  if (problems.length) {
    io.stderr(`${problems.map((p) => `  ${p}`).join("\n")}
`);
    return void 0;
  }
  return loaded;
}
async function readOverrides(args, io) {
  const overrides = /* @__PURE__ */ new Map();
  try {
    parseTestGtmOrigin(process.env[TEST_GTM_ORIGIN_ENV]);
    for (const variant of args.variants) {
      if (variant.file !== void 0) overrides.set(variant.name, await readGtmOverride(variant.file, `the override file of variant "${variant.name}"`));
    }
  } catch (error) {
    if (!(error instanceof GtmOverrideError)) throw error;
    io.stderr(`${error.message}
`);
    return void 0;
  }
  return overrides;
}
async function diffPairs(cells, variants2, stores, dir) {
  const diffs = [];
  const [first, ...others] = variants2;
  const recordOf = (scenario, store, variant) => cells.find((c) => c.scenario === scenario && c.labels.store === store && c.variant === variant)?.record;
  for (const scenario of [...new Set(cells.map((c) => c.scenario))]) {
    for (const store of stores.length ? stores : [void 0]) {
      const from = recordOf(scenario, store, first);
      if (!from) continue;
      const a = await readRun(join13(dir, from));
      for (const to of others) {
        const record = recordOf(scenario, store, to);
        if (!record) continue;
        const result = diffRuns(a, await readRun(join13(dir, record)));
        diffs.push({
          scenario,
          ...store !== void 0 && { store },
          from: first,
          to,
          added: result.added.length,
          removed: result.removed.length,
          changed: result.changed.length,
          flagsChanged: result.flags.filter((f) => !f.allowed).length
        });
      }
    }
  }
  return diffs;
}
function undeclaredVars(scenarios, vars) {
  return Object.keys(vars).filter((name) => !scenarios.some((s) => Object.hasOwn(s.parsed.vars, name)));
}
function scenarioFor(s, store, argVars, io) {
  const overrides = { ...store?.vars, ...argVars };
  const declared = Object.fromEntries(Object.entries(overrides).filter(([name]) => Object.hasOwn(s.parsed.vars, name)));
  const identity = { ...s.parsed.identity };
  if (store?.country !== void 0) {
    if (identity.country !== void 0 && identity.country !== store.country) {
      io.stderr(`Warning: ${s.name}: identity.country differs from the country of store "${store.name}". The store's country is used.
`);
    }
    identity.country = store.country;
  }
  return { ...s.parsed, vars: { ...s.parsed.vars, ...declared }, identity };
}
async function loadStores(path, io) {
  if (path === void 0) return [];
  try {
    return await readStores(path);
  } catch (error) {
    if (!(error instanceof StoresError)) throw error;
    io.stderr(`${error.message}
`);
    return void 0;
  }
}
async function suiteCommand(args, io, deps = { run: executeRun }) {
  if (args.allowTestPayment !== void 0 && args.site === void 0 && args.stores === void 0) {
    io.stderr("--allow-test-payment needs --site or --stores on the command line. A default file never supplies the host a test payment runs on.\n");
    return 2;
  }
  const config = await loadConfigOrReport(args.config, io);
  if (!config.ok) return 2;
  const loaded = config.loaded;
  const defaults = [];
  const scenarioDir = args.dir ?? await defaultScenarioDir(defaults);
  if (scenarioDir === void 0) {
    io.stderr("suite needs a scenario folder: give <dir> or create tagreeve/scenarios.\n");
    return 2;
  }
  const trackerListPath = await resolveTrackerList(args.trackerList, defaults);
  const autoconsentRules = await resolveAutoconsentRules(args.autoconsentRules, defaults);
  let trackers = [];
  if (trackerListPath !== void 0) {
    try {
      trackers = await readTrackerList(trackerListPath);
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}
`);
      return 2;
    }
  }
  const configSite = args.site === void 0 && args.stores === void 0 ? loaded?.config.site : void 0;
  const site = args.site ?? configSite;
  let storesPath;
  if (site === void 0) {
    storesPath = args.stores ?? await defaultStores(defaults);
  } else if (configSite !== void 0 && await defaultStores([]) !== void 0) {
    io.stderr(`${loaded.path} sets site and ${DEFAULT_STORES} exists. Give --site or --stores to say which one to use.
`);
    return 2;
  }
  if (site === void 0 && storesPath === void 0) {
    io.stderr("suite needs a site: give --site or --stores, or create tagreeve/stores.json.\n");
    return 2;
  }
  const stores = await loadStores(storesPath, io);
  if (!stores) return 2;
  const scenarios = await scan2(scenarioDir, trackers, loaded?.config.options ?? {}, io);
  if (!scenarios) return 2;
  const undeclared = undeclaredVars(scenarios, args.vars);
  if (undeclared.length) {
    io.stderr(`--var ${undeclared.join(", ")} not declared in the vars of any scenario. --var only overrides declared variables.
`);
    return 2;
  }
  for (const store of stores) {
    const missing = undeclaredVars(scenarios, store.vars);
    if (missing.length) {
      io.stderr(`Store "${store.name}": var ${missing.join(", ")} not declared in the vars of any scenario. Store vars only override declared variables.
`);
      return 2;
    }
  }
  const networks = /* @__PURE__ */ new Map();
  for (const s of scenarios) {
    const network = resolveNetwork({ network: args.network, netLog: false, serverContainer: args.serverContainer }, s.parsed, io, loaded?.path);
    if (!network) return 2;
    networks.set(s.name, network);
  }
  const serverHosts = [...new Set(scenarios.flatMap((s) => s.parsed.options.serverHosts ?? []))];
  const serverContainer = await prepareServerContainer(args, serverHosts, io);
  if (serverContainer === void 0) return 2;
  const overrides = await readOverrides(args, io);
  if (!overrides) return 2;
  warnTestGtmOrigin(io);
  warnTestLoopbackHosted(io);
  if (args.out === void 0 && loaded?.config.out === void 0) {
    const notice = await oldRunsNotice(process.cwd());
    if (notice) io.stderr(notice);
  }
  const targets = stores.length ? stores.map((store) => ({ store, site: store.site })) : [{ store: void 0, site }];
  const allowedHost = args.allowTestPayment === void 0 ? void 0 : normalizeHost(args.allowTestPayment);
  const paymentKey = (scenario, store) => JSON.stringify([scenario, store?.name]);
  const testPayments = /* @__PURE__ */ new Map();
  if (args.withTestPayment && args.allowTestPayment !== void 0) {
    if (stores.length && scenarios.some((x) => x.payment) && !targets.some((t) => normalizeHost(new URL(t.site).hostname) === allowedHost)) {
      io.stderr(`--allow-test-payment ${allowedHost}: no store in the stores file has that host.
`);
      return 2;
    }
    for (const s of scenarios.filter((x) => x.payment)) {
      for (const { store, site: site2 } of targets) {
        if (store && normalizeHost(new URL(site2).hostname) !== allowedHost) continue;
        const gates = await checkTestPaymentGates(s.parsed, site2, args.allowTestPayment);
        if (!gates.ok) {
          io.stderr(`${s.name}${store ? ` on ${store.name}` : ""}: ${gates.error}
`);
          return 2;
        }
        if (gates.testPayment) testPayments.set(paymentKey(s.name, store), gates.testPayment);
      }
    }
  }
  const baselineDir = args.baseline ?? (args.baselineDefault ? DEFAULT_BASELINES : void 0);
  if (args.baselineDefault) defaults.push({ setting: "baseline", path: DEFAULT_BASELINES });
  const baselines = /* @__PURE__ */ new Map();
  const baselineFor = (scenario, store, variant) => baselineFileName(scenario, store?.name, variant);
  if (baselineDir !== void 0) {
    const missing = [];
    const unreadable = [];
    for (const s of scenarios) {
      for (const { store } of targets) {
        if (s.handoff && !args.withHandoff || s.payment && !testPayments.has(paymentKey(s.name, store))) continue;
        for (const variant of args.variants.map((v) => v.name)) {
          const file = baselineFor(s.name, store, variant);
          if (baselines.has(file) || missing.includes(join13(baselineDir, file))) continue;
          try {
            baselines.set(file, await readBaseline(join13(baselineDir, file)));
          } catch (error) {
            if (!(error instanceof BaselineError)) throw error;
            (error.message.includes("ENOENT") ? missing : unreadable).push(error.message.includes("ENOENT") ? join13(baselineDir, file) : error.message);
          }
        }
      }
    }
    if (missing.length || unreadable.length) {
      io.stderr(`${[...missing.length ? ["Baseline files missing:", ...missing.map((m) => `  ${m}`)] : [], ...unreadable].join("\n")}
Save them with "tagreeve baseline save <record>", or run the suite without --baseline.
`);
      return 2;
    }
  }
  const id = `suite_${ulid()}`;
  const outFolder = resolveOutDir({ out: args.out, now: /* @__PURE__ */ new Date(), label: args.label, base: loaded?.config.out });
  await warnIfNotIgnored(outFolder, io.stderr);
  const dir = join13(outFolder, id);
  await mkdir4(dir, { recursive: true });
  const startedAt = Date.now();
  const variants2 = args.variants.map((v) => v.name);
  const cells = [];
  const ordered = [...scenarios.filter((s) => !s.handoff), ...scenarios.filter((s) => s.handoff)];
  for (const s of ordered) {
    const seed = args.seed ?? s.parsed.options.seed ?? Math.floor(Math.random() * 2 ** 31);
    for (const { store, site: site2 } of targets) {
      const key = paymentKey(s.name, store);
      const parsed = scenarioFor(s, store, args.vars, io);
      for (const variant of variants2) {
        const cell = { scenario: s.name, variant, labels: store ? { store: store.name } : {} };
        if (s.handoff && !args.withHandoff) {
          cells.push({ ...cell, status: "skipped", exitCode: 0 });
          continue;
        }
        if (s.payment && !testPayments.has(key)) {
          cells.push({ ...cell, status: "skipped", exitCode: 0 });
          continue;
        }
        io.stderr(`Running ${s.name}${store ? ` on ${store.name}` : ""} (${variant})
`);
        const outcome = await deps.run(
          {
            parsed,
            scenarioName: s.name,
            network: networks.get(s.name),
            site: site2,
            out: dir,
            ...args.label !== void 0 && { label: args.label },
            ...store && { store: store.name },
            seed,
            headed: false,
            viewport: args.viewport,
            netLog: false,
            autoconsentRules: [...autoconsentRules, ...store?.autoconsentRules ? [store.autoconsentRules] : []],
            trackers,
            gtmOverride: overrides.get(variant),
            ...serverContainer && { serverContainer },
            ...testPayments.has(key) && { testPayment: testPayments.get(key) },
            variant: { name: variant, fileStem: store ? `${s.name}.${store.name}` : s.name }
          },
          io
        );
        let status = statusOf(outcome);
        let failed = failedOf(outcome, status);
        let exitCode = outcome.code;
        let compared;
        const expected = baselines.get(baselineFor(s.name, store, variant));
        if (expected && outcome.path) {
          const result = compareBaseline(expected, await readRun(outcome.path));
          for (const warning of result.warnings) io.stderr(`Warning: ${cellName(cell)}: ${warning}
`);
          compared = { file: baselineFor(s.name, store, variant), drift: result.drift, added: result.added, removed: result.removed, countChanges: result.countChanges };
          if (result.drift && status !== "error") {
            if (status === "warn") failed = void 0;
            status = "fail";
            if (exitCode === 0) exitCode = 1;
          }
        }
        cells.push({ ...cell, status, exitCode, ...failed && { failed }, ...outcome.path && { record: basename2(outcome.path) }, ...compared && { baseline: compared } });
      }
    }
  }
  const storeNames = stores.map((st) => st.name);
  const position = (c) => (scenarios.findIndex((s) => s.name === c.scenario) * Math.max(storeNames.length, 1) + Math.max(storeNames.indexOf(c.labels.store ?? ""), 0)) * variants2.length + variants2.indexOf(c.variant);
  cells.sort((a, b) => position(a) - position(b));
  const listed = [...loaded?.defaultUsed ? [loaded.defaultUsed] : [], ...defaults];
  const manifest = {
    suiteSchemaVersion: 3,
    id,
    ...args.label !== void 0 && { label: args.label },
    startedAt,
    site: new URL(targets[0].site).origin,
    stores: stores.map((st) => ({ name: st.name, site: new URL(st.site).origin })),
    variants: variants2,
    cells,
    diffs: await diffPairs(cells, variants2, storeNames, dir),
    exitCode: suiteExitCode(cells),
    ...listed.length > 0 && { defaults: listed }
  };
  await writeFile4(join13(dir, "suite.json"), `${JSON.stringify(manifest, null, 2)}
`);
  io.stdout(args.json ? `${JSON.stringify(manifest, null, 2)}
` : formatSuiteTable(manifest, dir));
  return manifest.exitCode;
}

// packages/cli/src/report/suite.ts
var recordKey = (scenario, variant, store) => JSON.stringify(store === void 0 ? [scenario, variant] : [scenario, variant, store]);
function hostOf6(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
function diffView(scenario, store, from, to, a, b) {
  const result = diffRuns(a, b);
  const rows = /* @__PURE__ */ new Map();
  const rowOf = (key) => {
    const id = JSON.stringify([key.epoch, key.vendor, key.event]);
    let row = rows.get(id);
    if (!row) rows.set(id, row = { epoch: key.epoch, vendor: key.vendor, event: key.event || "(no event)", added: 0, removed: 0, changed: 0, countMismatches: 0 });
    return row;
  };
  for (const h of result.added) rowOf(h.key).added++;
  for (const h of result.removed) rowOf(h.key).removed++;
  for (const c of result.changed) rowOf(c.key).changed++;
  for (const m of result.countMismatches) rowOf(m.key).countMismatches++;
  return {
    scenario,
    ...store !== void 0 && { store },
    from,
    to,
    warnings: result.warnings,
    rows: [...rows.values()].sort((x, y) => x.epoch.localeCompare(y.epoch) || x.vendor.localeCompare(y.vendor) || x.event.localeCompare(y.event)),
    flags: result.flags.filter((f) => !f.allowed).map((f) => ({ kind: f.kind, host: f.host, a: f.a, b: f.b }))
  };
}
function buildSuiteModel(manifest, records) {
  const warnings = [];
  const names = [...new Set(manifest.cells.map((c) => c.scenario))];
  const storeNames = manifest.stores.map((s) => s.name);
  const storeAxis = storeNames.length ? storeNames : [void 0];
  const scenarios = names.map((name) => ({
    name,
    cells: storeAxis.flatMap(
      (store) => manifest.variants.flatMap((variant) => {
        const cell = manifest.cells.find((c) => c.scenario === name && c.labels?.store === store && c.variant === variant);
        if (!cell) return [];
        const label = `${name}${store === void 0 ? "" : ` on ${store}`} (${variant})`;
        const loaded = records.get(recordKey(name, variant, store));
        if (!loaded && cell.status !== "skipped") warnings.push(`${label}: no record, so the run is not in this report`);
        if (loaded?.truncatedAtLine) warnings.push(`${label}: record is truncated at line ${loaded.truncatedAtLine}, so later records are missing from this report`);
        return [{ ...store !== void 0 && { store }, variant, status: cell.status, exitCode: cell.exitCode, ...cell.failed && { failed: cell.failed }, ...cell.baseline && { baseline: cell.baseline }, model: loaded && buildReportModel(loaded) }];
      })
    )
  }));
  const [first, ...others] = manifest.variants;
  const diffs = [];
  for (const name of names) {
    for (const store of storeAxis) {
      const a = records.get(recordKey(name, first, store));
      for (const to of others) {
        const b = records.get(recordKey(name, to, store));
        if (a && b) diffs.push(diffView(name, store, first, to, a, b));
      }
    }
  }
  return {
    header: {
      id: manifest.id,
      ...manifest.label !== void 0 && { label: manifest.label },
      startedAt: new Date(manifest.startedAt).toISOString(),
      host: hostOf6(manifest.site),
      stores: storeNames,
      variants: manifest.variants,
      exitCode: manifest.exitCode
    },
    warnings,
    scenarios,
    diffs
  };
}
function isFailedField(value) {
  if (value === void 0) return true;
  if (typeof value !== "object" || value === null) return false;
  const f = value;
  return typeof f.rules === "number" && Number.isFinite(f.rules) && f.rules >= 0 && Array.isArray(f.checks) && f.checks.every((x) => typeof x === "string");
}
function isStoreList(value) {
  return Array.isArray(value) && value.every((s) => {
    const store = s;
    return typeof store === "object" && store !== null && typeof store.name === "string" && typeof store.site === "string";
  });
}
function isLabels(value) {
  return value === void 0 || typeof value === "object" && value !== null && Object.values(value).every((v) => typeof v === "string");
}
function isBaselineField(value) {
  if (value === void 0) return true;
  const b = value;
  return typeof b === "object" && b !== null && typeof b.file === "string" && typeof b.drift === "boolean" && [b.added, b.removed, b.countChanges].every((n) => typeof n === "number");
}
function isManifest(value) {
  if (typeof value !== "object" || value === null) return false;
  const m = value;
  return (m.suiteSchemaVersion === 1 || m.suiteSchemaVersion === 2 || m.suiteSchemaVersion === 3) && typeof m.id === "string" && (m.label === void 0 || typeof m.label === "string") && typeof m.startedAt === "number" && Number.isFinite(m.startedAt) && typeof m.site === "string" && typeof m.exitCode === "number" && (m.suiteSchemaVersion === 1 || isStoreList(m.stores)) && Array.isArray(m.variants) && m.variants.every((v) => typeof v === "string") && Array.isArray(m.cells) && m.cells.every((c) => {
    const cell = c;
    return typeof cell === "object" && cell !== null && typeof cell.scenario === "string" && typeof cell.variant === "string" && typeof cell.status === "string" && typeof cell.exitCode === "number" && isFailedField(cell.failed) && isLabels(cell.labels) && isBaselineField(cell.baseline);
  });
}
async function hasManifest(dir) {
  return readFile9(join14(dir, "suite.json")).then(
    () => true,
    () => false
  );
}
async function resolveSuiteDir(dir, note) {
  if (await hasManifest(dir)) return dir;
  const entries = await readdir4(dir, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (entry.isDirectory() && entry.name.startsWith("suite_") && await hasManifest(join14(dir, entry.name))) found.push(entry.name);
  }
  if (found.length === 0) return dir;
  if (found.length > 1) throw new Error(`${dir} holds ${found.length} suites: ${found.join(", ")}. Pass one of them.`);
  const child = join14(dir, found[0]);
  note(`Using suite ${child}
`);
  return child;
}
async function loadSuite(dir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile9(join14(dir, "suite.json"), "utf8"));
  } catch {
    throw new Error(`${dir} has no readable suite.json. report reads one .jsonl run record or a suite directory.`);
  }
  if (!isManifest(manifest)) throw new Error(`${join14(dir, "suite.json")} is not a suite manifest`);
  manifest.stores ??= [];
  for (const cell of manifest.cells) cell.labels ??= {};
  const records = /* @__PURE__ */ new Map();
  for (const cell of manifest.cells) {
    const name = cell.record;
    if (typeof name !== "string" || name !== basename3(name)) continue;
    records.set(recordKey(cell.scenario, cell.variant, cell.labels.store), await readRun(join14(dir, name)).catch(() => void 0));
  }
  return { manifest, records };
}
function diffTable(d) {
  const heading = `<h3>${escapeHtml(d.scenario)}${d.store === void 0 ? "" : ` on ${escapeHtml(d.store)}`}: ${escapeHtml(d.from)} to ${escapeHtml(d.to)}</h3>`;
  const warnings = d.warnings.map((w) => `<p class="warn-box">${escapeHtml(w)}</p>`).join("");
  if (d.rows.length === 0 && d.flags.length === 0) return `${heading}${warnings}<p class="empty">No differences.</p>`;
  const flags2 = d.flags.length ? `<ul class="fields">${d.flags.map((f) => `<li>flag ${escapeHtml(flagChangeLabel(f))}</li>`).join("")}</ul>` : "";
  const body = d.rows.map((r) => `<tr><td>${escapeHtml(r.epoch)}</td><td>${escapeHtml(r.vendor)}</td><td>${escapeHtml(r.event)}</td><td>${r.added}</td><td>${r.removed}</td><td>${r.changed}</td><td>${r.countMismatches}</td></tr>`).join("");
  const table = d.rows.length ? `<div class="scroll"><table class="diff"><thead><tr><th scope="col">Epoch</th><th scope="col">Vendor</th><th scope="col">Event</th><th scope="col">Added</th><th scope="col">Removed</th><th scope="col">Changed</th><th scope="col">Count differs</th></tr></thead><tbody>${body}</tbody></table></div>` : "";
  return `${heading}${warnings}${table}${flags2}`;
}
function verdicts(model) {
  const items = (model.header.stores.length ? model.header.stores : [void 0]).flatMap(
    (store) => model.header.variants.map((variant) => {
      const findings = emptyFindings();
      let unfinished = 0;
      let noRecord = 0;
      for (const s of model.scenarios) {
        const cell = s.cells.find((c) => c.store === store && c.variant === variant);
        if (cell?.status === "error") unfinished++;
        else if (cell?.model) addFindings(findings, cell.model);
        else if (cell?.status === "fail" || cell?.status === "warn") noRecord++;
      }
      const sentence = findingsSentence(findings, true);
      const base2 = noRecord && sentence === "no leaks" ? "leaks not known" : sentence;
      const tail = (unfinished ? `; ${unfinished} run${unfinished === 1 ? "" : "s"} did not finish` : "") + (noRecord ? `; ${noRecord} run${noRecord === 1 ? " has" : "s have"} no record` : "");
      return `<li><strong>${escapeHtml(store === void 0 ? variant : `${store}, ${variant}`)}:</strong> ${escapeHtml(base2 + tail)}</li>`;
    })
  );
  return `<ul class="verdicts">${items.join("")}</ul>`;
}
function overview(model) {
  const stores = model.header.stores;
  const head = model.header.variants.map((v) => `<th scope="col">${escapeHtml(v)}</th>`).join("");
  const rows = model.scenarios.flatMap(
    (s) => (stores.length ? stores : [void 0]).map((store) => {
      const cells = model.header.variants.map((v) => {
        const cell = s.cells.find((c) => c.store === store && c.variant === v);
        return `<td>${cell ? escapeHtml(cellText({ status: cell.status, exitCode: cell.exitCode, failed: cell.failed, baseline: cell.baseline })) : ""}</td>`;
      });
      return `<tr><th scope="row">${escapeHtml(s.name)}</th>${store === void 0 ? "" : `<td>${escapeHtml(store)}</td>`}${cells.join("")}</tr>`;
    })
  ).join("");
  return `<div class="scroll"><table><thead><tr><th scope="col">Scenario</th>${stores.length ? '<th scope="col">Store</th>' : ""}${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function suiteTitle(h) {
  const where2 = h.stores.length ? ` on ${h.stores.join(", ")}` : h.host ? ` on ${h.host}` : "";
  return `Tagreeve suite: ${h.variants.join(" vs ")}${where2}, ${h.startedAt.slice(0, 10)}`;
}
function renderSuiteReport(model) {
  const h = model.header;
  const title = suiteTitle(h);
  const warnings = model.warnings.map((w) => `<p class="warn-box">Warning: ${escapeHtml(w)}</p>`).join("");
  const scenarios = model.scenarios.map((s) => {
    const cells = s.cells.map((c) => {
      const where2 = c.store === void 0 ? `${s.name} (${c.variant})` : `${s.name} on ${c.store}, ${c.variant}`;
      const title2 = `<h3>${escapeHtml(where2)}: ${escapeHtml(c.status.toUpperCase())}</h3>${c.baseline?.drift ? `<p class="warn-box">Baseline drift from ${escapeHtml(c.baseline.file)}: ${c.baseline.added} added, ${c.baseline.removed} removed, ${c.baseline.countChanges} count changes.</p>` : ""}`;
      if (!c.model) return `${title2}<p class="empty">${c.status === "skipped" ? "Skipped." : "No record to show."}</p>`;
      return `${title2}${definitionList(runHeader(c.model.header))}${runSections(c.model, "h4")}`;
    }).join("");
    return `<section><h2>${escapeHtml(s.name)}</h2>${cells}</section>`;
  }).join("");
  const diffs = model.diffs.length ? model.diffs.map(diffTable).join("") : '<p class="empty">No variant pair has two records to compare.</p>';
  return page(`<h1>${escapeHtml(title)}</h1>
${definitionList([
    ["Suite", h.id],
    ...h.label === void 0 ? [] : [["Label", h.label]],
    ["Started", h.startedAt],
    ["Site host", h.host],
    ...h.stores.length ? [["Stores", h.stores.join(", ")]] : [],
    ["Variants", h.variants.join(", ")],
    ["Exit code", String(Number(h.exitCode))]
  ])}
${warnings}
<h2>Verdict</h2>
${verdicts(model)}
<h2>Results</h2>
${overview(model)}
${scenarios}
<h2>Diff per variant pair</h2>
${diffs}`, title);
}

// packages/cli/src/report/index.ts
async function load2(path) {
  try {
    return await readRun(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.includes(path) ? message : `Cannot read ${path}: ${message}`);
  }
}
async function isSameFile(a, b) {
  if (resolve3(a) === resolve3(b)) return true;
  const [sa, sb] = await Promise.all([stat6(a).catch(() => void 0), stat6(b).catch(() => void 0)]);
  return sa !== void 0 && sb !== void 0 && sa.dev === sb.dev && sa.ino === sb.ino;
}
async function refuseOverwrite(html, inputs) {
  for (const input of inputs) if (await isSameFile(input, html)) throw new Error(`--html must not be ${input}`);
}
async function write(args, html, io) {
  await mkdir5(dirname5(args.html), { recursive: true });
  await writeFile5(args.html, html);
  io.stdout(`Wrote ${args.html}
`);
  return 0;
}
async function reportCommand(args, io) {
  if ((await stat6(args.input).catch(() => void 0))?.isDirectory()) {
    const suiteDir = await resolveSuiteDir(args.input, io.stderr);
    const { manifest, records: records2 } = await loadSuite(suiteDir);
    const recordFiles = manifest.cells.flatMap((c) => typeof c.record === "string" ? [join15(suiteDir, c.record)] : []);
    await refuseOverwrite(args.html, [join15(suiteDir, "suite.json"), ...recordFiles]);
    return write(args, renderSuiteReport(buildSuiteModel(manifest, records2)), io);
  }
  await refuseOverwrite(args.html, [args.input]);
  const records = await load2(args.input);
  if (records.truncatedAtLine) io.stderr(`Warning: ${args.input} is truncated at line ${records.truncatedAtLine}; later records are missing from the report
`);
  return write(args, renderReport(buildReportModel(records)), io);
}

// packages/cli/src/main.ts
var processIo = {
  stdout: (text2) => void process.stdout.write(text2),
  stderr: (text2) => void process.stderr.write(text2)
};
async function buildCommand(io) {
  const result = await buildImage({ version: readVersion() });
  switch (result.status) {
    case "not-needed":
      io.stdout(`No build is needed on this machine. Pull Google's image and use it as it is:
  ${result.image}
`);
      return 0;
    case "built":
      io.stdout(`Built ${result.tag}
Image ID: ${result.imageId}
`);
      return 0;
    case "dockerMissing":
      io.stderr(`${result.message}
`);
      return 2;
    case "failed":
      io.stderr(`The image build failed.
${result.message}
`);
      return 2;
  }
}
async function main(argv, io = processIo) {
  try {
    const command = parseCli(argv);
    switch (command.command) {
      case "version":
        io.stdout(`${readVersion()}
`);
        return 0;
      case "help":
        io.stdout(helpText(command.topic));
        return 0;
      case "init":
        return await initCommand(io);
      case "install-browser":
        return await installBrowser() === 0 ? 0 : 2;
      case "baseline":
        return await baselineCommand(command, io);
      case "diff":
        return await diffCommand(command, io);
      case "report":
        return await reportCommand(command, io);
      case "suite":
        return await suiteCommand(command, io);
      case "server-container":
        return await buildCommand(io);
      case "run":
        return await runCommand(command, io);
    }
  } catch (error) {
    if (error instanceof UsageError) io.stderr(`${error.message}
${usageHint(error.command)}
`);
    else io.stderr(`${error instanceof Error ? error.message : String(error)}
`);
    return 2;
  }
}

// packages/cli/src/bin.ts
process.exitCode = await main(process.argv.slice(2));
