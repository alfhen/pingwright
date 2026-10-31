#!/usr/bin/env node

// packages/cli/src/args.ts
import { parseArgs } from "node:util";
var UsageError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
};
var PUBLISHED_VARIANT = "published";
var VARIANT_NAME = /^[a-z0-9][a-z0-9_-]*$/;
var USAGE = `Usage:
  pingwright run <scenario.yml> --site <url> [options]
  pingwright diff <a.jsonl> <b.jsonl> [--by-page] [--all-flags] [--json]
  pingwright report <run.jsonl | suite-dir> --html <out.html>
  pingwright suite <dir> --site <url> [--variant published] [--variant name=override.json] [options]
  pingwright install-browser
  pingwright --version

Run "pingwright run --help" for the options of run.

Options for suite:
  --site <url>               The site to test (required)
  --variant <name[=file]>    A GTM build to test (repeatable). "published" is the live container; name=file serves an override file. Default: published
  --with-handoff             Also run scenarios with handoff steps, last, headed
  --network, --out, --seed, --var, --tracker-list, --autoconsent-rules, --json work as in run

Options for run:
  --site <url>               The site to test (required)
  --network stub|server|live stub (default) answers tracking requests locally; server also passes through the hosts in options.serverHosts; live sends them
  --out <dir>                Directory for the JSONL record (default: runs)
  --seed <n>                 Seed for the fake identity
  --headed                   Show the browser window
  --net-log                  Capture collection requests no browser hook reports (unload sends, early sandboxed srcdoc sends) from Chromium's net log (needs --network live)
  --autoconsent-rules <file> Extra autoconsent rules (repeatable)
  --gtm-override <file>      Serve a GTM workspace build (JSON with container, gtmAuth, gtmPreview, optional loader.replace or loader.match)
  --tracker-list <file>      Extra tracker hosts to stub and decode (JSON array of entries)
  --var <k=v>                Scenario variable (repeatable)
  --json                     Print a JSON summary on stdout
`;
var RUN_USAGE = `Usage: pingwright run <scenario.yml> --site <url> [options]

Plays the scenario in Chromium, records every request, checks the expectations
and writes one JSONL record.

Options:
  --site <url>               The site to test (required)
  --network stub|server|live stub (default) answers tracking requests locally; server also passes through the hosts in options.serverHosts; live sends them
  --out <dir>                Directory for the JSONL record (default: runs)
  --seed <n>                 Seed for the fake identity
  --headed                   Show the browser window
  --net-log                  Capture collection requests no browser hook reports (unload sends, early sandboxed srcdoc sends) from Chromium's net log (needs --network live)
  --autoconsent-rules <file> Extra autoconsent rules (repeatable)
  --gtm-override <file>      Serve a GTM workspace build (JSON with container, gtmAuth, gtmPreview, optional loader.replace or loader.match)
  --tracker-list <file>      Extra tracker hosts to stub and decode (JSON array of entries)
  --var <k=v>                Scenario variable (repeatable)
  --json                     Print a JSON summary on stdout
  -h, --help                 Show this help

Exit codes: 0 pass, 1 failed expectations, 2 usage or run error.

Scenario format: https://github.com/alfhen/pingwright/blob/main/docs/design.md#11-expectations
`;
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
function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        site: { type: "string" },
        network: { type: "string" },
        out: { type: "string" },
        seed: { type: "string" },
        headed: { type: "boolean" },
        "net-log": { type: "boolean" },
        "autoconsent-rules": { type: "string", multiple: true },
        "gtm-override": { type: "string" },
        "tracker-list": { type: "string" },
        variant: { type: "string", multiple: true },
        "with-handoff": { type: "boolean" },
        var: { type: "string", multiple: true },
        json: { type: "boolean" },
        html: { type: "string" },
        "by-page": { type: "boolean" },
        "all-flags": { type: "boolean" },
        version: { type: "boolean" },
        help: { type: "boolean", short: "h" }
      }
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.version) return { command: "version" };
  const [command, ...rest] = positionals;
  if (values.help && command === "run") return { command: "help", topic: "run" };
  if (values.help || command === void 0) return { command: "help" };
  if (command === "install-browser") {
    if (rest.length) throw new UsageError("install-browser takes no arguments");
    return { command: "install-browser" };
  }
  if (command === "diff") {
    if (rest.length !== 2) throw new UsageError("diff takes two JSONL files");
    return { command: "diff", a: rest[0], b: rest[1], byPage: values["by-page"] ?? false, allFlags: values["all-flags"] ?? false, json: values.json ?? false };
  }
  if (command === "report") {
    if (rest.length !== 1) throw new UsageError("report takes one JSONL file or one suite directory");
    if (!values.html) throw new UsageError("report needs --html <file>");
    return { command: "report", input: rest[0], html: values.html };
  }
  if (command !== "run" && command !== "suite") throw new UsageError(`Unknown command "${command}"`);
  if (rest.length !== 1) throw new UsageError(command === "run" ? "run takes one scenario file" : "suite takes one scenario directory");
  if (!values.site) throw new UsageError("--site is required");
  try {
    const url = new URL(values.site);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new UsageError(`--site must be an http or https URL, got "${values.site}"`);
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
      dir: rest[0],
      site: values.site,
      variants: parseVariants(values.variant ?? []),
      network,
      out: values.out ?? "runs",
      seed,
      withHandoff: values["with-handoff"] ?? false,
      autoconsentRules: values["autoconsent-rules"] ?? [],
      trackerList: values["tracker-list"],
      vars,
      json: values.json ?? false
    };
  }
  for (const flag2 of ["variant", "with-handoff"]) {
    if (values[flag2] !== void 0) throw new UsageError(`--${flag2} is not an option of run`);
  }
  return {
    command: "run",
    scenario: rest[0],
    site: values.site,
    network,
    out: values.out ?? "runs",
    seed,
    headed: values.headed ?? false,
    netLog: values["net-log"] ?? false,
    autoconsentRules: values["autoconsent-rules"] ?? [],
    gtmOverride: values["gtm-override"],
    trackerList: values["tracker-list"],
    vars,
    json: values.json ?? false
  };
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
var RECORD_SCHEMA_VERSION = 2;

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
import { Faker, base, en, en_US, sv } from "@faker-js/faker";
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
var COUNTRIES = { US, SE };
function createIdentity(seed, options = {}) {
  const country = options.country ?? "US";
  const format = COUNTRIES[country.toUpperCase()] ?? US;
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
  const digest = createHash("sha256").update(value, "utf8").digest();
  return {
    hex: digest.toString("hex"),
    base64: digest.toString("base64"),
    base64url: digest.toString("base64url")
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
function tryBase64Decode(token) {
  const bytes = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (bytes.length < 8) return void 0;
  const text2 = utf8Lenient.decode(bytes);
  const inner = bytes.length >= MIN_BYTES_FOR_EDGES ? [...text2].slice(EDGE, -EDGE) : [...text2];
  if (inner.length < 4) return void 0;
  let control = 0;
  for (const ch of inner) {
    const c = ch.codePointAt(0);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13 || c === 127 || c === 65533) control++;
  }
  return control / inner.length <= 0.05 ? text2 : void 0;
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
  const format = COUNTRIES[identity.country.toUpperCase()] ?? US;
  const extraEmails = extra.map(normalizeEmail).filter((v) => v.includes("@"));
  const extraPhones = extra.map((v) => v.replace(/\D/g, "")).filter((v) => v.length >= 8);
  return { email, phoneDigits, nationalDigits: format.nationalDigits(phoneDigits), hashes, extraEmails, extraPhones };
}
function scan(text2, identity, options = {}) {
  const own = ownValues(identity);
  const found = /* @__PURE__ */ new Map();
  const add2 = (kind, value) => {
    const key = `${kind}:${value}`;
    if (!found.has(key)) found.set(key, { kind, value });
  };
  for (const variant of variants(text2)) {
    for (const raw of hasUrlEscapes(variant) ? [] : variant.match(EMAIL) ?? []) {
      const m = raw.slice(raw.lastIndexOf("+") + 1);
      if (!m.includes("@") || FILE_EXTENSION.test(m) || normalizeEmail(m).includes(own.email) || own.extraEmails.includes(normalizeEmail(m))) continue;
      add2("email", m);
      if (raw !== m && raw.indexOf("+") === raw.lastIndexOf("+") && !raw.startsWith("+")) add2("email", raw);
    }
    for (const m of variant.match(PHONE) ?? []) {
      const digits = m.replace(/\D/g, "");
      if (digits.length < 8 || digits.length > 15) continue;
      if (/^\+\d+\+/.test(m) && !/^\+\d{1,3}\+/.test(m)) continue;
      if (!digits.includes(own.phoneDigits) && !digits.includes(own.nationalDigits) && !own.extraPhones.includes(digits)) add2("phone", m);
    }
    for (const m of hasUrlEscapes(variant) ? [] : variant.matchAll(HASH)) {
      const hash = m[0].toLowerCase();
      if (!own.hashes.has(hash) && !options.stableHashes?.has(hash) && !isNonPersonalKey(variant, m.index)) add2("hash", hash);
    }
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
    if (pkg.name === "pingwright" && pkg.version) return pkg.version;
  }
  throw new Error("Cannot find the pingwright package.json");
}

// packages/core/src/glob.ts
function globToRegExp(glob) {
  return new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

// packages/core/src/limits.ts
var MAX_POST_DATA = 64 * 1024;

// packages/decoders/src/decoder.ts
var defaultHitId = () => newId("hit");
var vendorKeys = ["ga4", "google-ads", "meta", "pinterest", "sgtm"];

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
function looksLikeValue(segment) {
  if (segment.length > 64 || !NAME_CHARS.test(segment)) return true;
  if (HEX_TOKEN.test(segment) || LONG_DIGITS.test(segment) || mostlyDigits(segment)) return true;
  return DIGEST_TOKEN.test(segment) && /[A-Z]/.test(segment) && /[a-z]/.test(segment) && /\d/.test(segment);
}
function guardFieldName(name) {
  if (name.includes("@")) return OTHER_NAME;
  return name.split(".").map((segment) => looksLikeValue(segment) ? OTHER_NAME : segment).join(".");
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
function multipartFields(body, boundary) {
  const fields2 = [];
  for (const part of body.split(`--${boundary}`)) {
    const split = /\r?\n\r?\n/.exec(part);
    if (!split) continue;
    const name = /content-disposition:[^\r\n]*?\bname="([^"]*)"/i.exec(part.slice(0, split.index))?.[1];
    if (name === void 0) continue;
    fields2.push([name, part.slice(split.index + split[0].length).replace(/\r?\n$/, "")]);
  }
  return fields2;
}
function bodyFields(req) {
  const body = req.postData ?? "";
  const contentType = Object.entries(req.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  const m = /multipart\/form-data;.*?boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = m?.[1] ?? m?.[2];
  return boundary ? multipartFields(body, boundary) : new URLSearchParams(body);
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
var str = (v) => typeof v === "string" && v !== "" ? v : void 0;
var hasId = (v) => str(v) !== void 0 || typeof v === "number" && Number.isFinite(v);
var USER_DATA_FIELDS = ["email_address", "phone_number", "first_name", "last_name", "street", "city", "postal_code", "country"];
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
var firstOf = (v) => Array.isArray(v) ? v.find((x) => str(x) !== void 0 || isObject(x)) : v;
function userData(...sources) {
  const out = {};
  for (const source of sources) {
    const hasUserData = isObject(source.user_data);
    const fields2 = hasUserData ? source.user_data : source;
    const addressValue = firstOf(fields2.address);
    const address = isObject(addressValue) ? addressValue : {};
    for (const field of USER_DATA_FIELDS) {
      const value = str(firstOf(fields2[field])) ?? str(firstOf(address[field]));
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
  if (str(body.event_name) && str(body.page_location)) return url;
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
    const hostname = str(dtdc.page_hostname) ?? str(body.page_hostname);
    if (hostname) params.page_hostname = hostname;
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
        event: p.get("event") ?? p.get("en") ?? str(dtdc.event_name) ?? str(body.event_name) ?? null,
        consent: decodeGa4Consent(p),
        ids,
        page: str(dtdc.page_location) ?? str(body.page_location) ?? null,
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
function hostMatches2(pattern, hostname) {
  if (pattern.startsWith("*.")) return hostname.endsWith(pattern.slice(1));
  return hostname === pattern;
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
var direct = [ga4, meta, pinterest, googleAds, sgtmDataClient];
var decoders = [...direct, createStapeCustomLoader(direct)];
function decodeRequest(req, newHitId, trackers = trackerList) {
  const matched = decoders.filter((d) => d.match(req));
  if (matched.length > 0) return matched.flatMap((d) => d.decode(req, newHitId));
  return decodeTracker(req, trackers, newHitId);
}
function isCollectionEndpoint(req, trackers = trackerList) {
  return decoders.some((d) => d.isCollectionEndpoint(req)) || trackerCollection(req, trackers) !== void 0;
}

// packages/expect/src/scenario.ts
import { LineCounter, parseDocument } from "yaml";

// packages/expect/src/hosts.ts
import { getPublicSuffix } from "tldts";
var HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
function isHostPattern(value) {
  return typeof value === "string" && HOST_PATTERN.test(value);
}
function hostMatches3(host, patterns) {
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

// packages/expect/src/scenario.ts
var consentFields = ["analytics", "ads", "adUserData", "adPersonalization"];
var BUILTIN_NAMES = ["unknownDestination", "sandboxPageUrl", "possibleRealData", "deniedIdentifiers"];
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
var VENDOR_KEYS = /* @__PURE__ */ new Set(["vendor", "event", "page", "transport", "host", "outcome", "count", "before", "in", "after"]);
var GROUP_KEYS = ["consent", "ids", "params", "identity", "body"];
var COOKIE_RULE_KEYS = ["cookie", "before", "in", "after"];
var BODY_KEYS = ["has", "only", "ignore"];
var MAX_FIELD_NAME = 64;
var CONSENT_VALUES = ["granted", "denied", "unknown"];
var OUTCOMES = ["passed", "stubbed", "failed"];
var NETWORKS = ["stub", "server", "live"];
var CONSENT_ANSWERS = ["accept", "reject", "none", "withdraw"];
var STEP_KINDS = ["visit", "click", "fill", "select", "consent", "wait", "addToCart", "evaluate", "checkpoint", "handoff"];
var TOP_KEYS = ["start", "vars", "identity", "steps", "expect", "options"];
var OPTION_KEYS = ["network", "seed", "consentTimeout", "graceWindow", "allowUnknownDestination", "firstPartyHosts", "cartRequest", "unloadGapIgnore", "builtins", "identifierFields", "serverHosts"];
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
          const kind = looksLikeRealData(v);
          if (kind) warnings.push(`line ${lineOf(["identity", k])}: identity.${k}: looks like a real ${kind}; do not write personal data in a scenario`);
        }
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
    const str2 = () => {
      if (typeof value === "string" && value) return value;
      fail([...path, kind], "must be a non-empty string");
      return void 0;
    };
    const locator = () => {
      if (typeof value === "string" && value) return value;
      if (!isMap(value)) {
        fail([...path, kind], "must be a non-empty selector or a mapping with role and name, or any");
        return void 0;
      }
      const keys2 = Object.keys(value);
      if (keys2.includes("any")) {
        const list2 = value.any;
        if (keys2.length > 1) fail([...path, kind], "any cannot be combined with other keys");
        else if (!Array.isArray(list2) || list2.length === 0 || !list2.every((x) => typeof x === "string" && x !== "")) {
          fail([...path, kind, "any"], "must be a non-empty list of selectors");
        } else return { any: list2 };
        return void 0;
      }
      const unknown = keys2.find((k) => !["role", "name", "exact"].includes(k));
      if (unknown !== void 0) fail([...path, kind, unknown], "unknown key, expected role, name, exact or any");
      else if (typeof value.role !== "string" || !/^[a-z]+$/.test(value.role)) fail([...path, kind, "role"], "must be a role name such as button or radio");
      else if (value.name !== void 0 && (typeof value.name !== "string" || value.name === "")) fail([...path, kind, "name"], "must be a non-empty string");
      else if (value.exact !== void 0 && typeof value.exact !== "boolean") fail([...path, kind, "exact"], "must be true or false");
      else if (value.exact !== void 0 && value.name === void 0) fail([...path, kind, "exact"], "needs a name");
      else {
        return {
          role: value.role,
          ...value.name !== void 0 ? { name: value.name } : {},
          ...value.exact !== void 0 ? { exact: value.exact } : {}
        };
      }
      return void 0;
    };
    switch (kind) {
      case "visit": {
        const v = str2();
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
      case "checkpoint":
      case "handoff": {
        const v = str2();
        if (v !== void 0) add2({ kind, value: v });
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
        for (const [sel, v] of Object.entries(value)) {
          if (typeof v === "string" && v) {
            fields2[sel] = v;
            const kind2 = SECRET_FIELD.test(sel) ? void 0 : looksLikeRealData(v);
            if (kind2) warnings.push(`line ${lineOf([...path, "fill", sel])}: steps[${i}].fill.${sel}: looks like a real ${kind2}; fill uses the run identity, so do not write personal data in a scenario`);
          } else fail([...path, kind, sel], "must be a non-empty string");
        }
        add2({ kind, value: fields2 });
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
        else if (isMap(value)) {
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
      } else if (VENDOR_KEYS.has(k)) {
        fail(p, "invalid");
      } else {
        fail(p, "unknown key");
      }
    }
    if (rule.cookie) {
      const mixed = Object.keys(flat).filter((k) => !COOKIE_RULE_KEYS.includes(k));
      if (mixed.length) fail(path, `cookie cannot be combined with ${mixed.join(", ")}; it only takes before, in and after`);
    }
    if (rule.before && rule.inEpoch) fail(path, "use either before or in, not both");
    if (rule.body?.has && rule.body.only) fail(path, "body.has and body.only cannot be in the same entry");
    if (rule.body && rule.hashesMatch) fail(path, "identity.hashesMatch cannot be combined with body.has or body.only");
    if (rule.body?.ignore && !rule.body.only) fail(path, "body.ignore is only valid with body.only");
    return issues.length === before ? rule : void 0;
  }
  const options = {};
  if (raw.options !== void 0) {
    if (!isMap(raw.options)) fail(["options"], "must be a mapping");
    else
      for (const [k, v] of Object.entries(raw.options)) {
        const p = ["options", k];
        if (!OPTION_KEYS.includes(k)) fail(p, `unknown option, expected one of ${OPTION_KEYS.join(", ")}`);
        else if (k === "network") {
          if (typeof v === "string" && NETWORKS.includes(v)) options.network = v;
          else fail(p, `must be one of ${NETWORKS.join(", ")}`);
        } else if (k === "seed") {
          if (typeof v === "number" && Number.isInteger(v)) options.seed = v;
          else fail(p, "must be an integer");
        } else if (k === "allowUnknownDestination") {
          if (typeof v === "boolean" || isHostList(v)) options.allowUnknownDestination = v;
          else fail(p, `must be true, false or a list of hosts${HOST_HINT}`);
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
            if (bad !== void 0) fail(p, `"${bad}" is a vendor host or a wildcard on a public suffix. List the server container's own host, such as sgtm.example.com or *.example.com`);
            else options.serverHosts = v;
          }
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
          else options.graceWindow = ms;
        }
      }
  }
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

// packages/expect/src/evaluate.ts
var DEFAULT_GRACE_MS = 50;
var MAX_LISTED = 5;
var MAX_NAMES = 12;
var GOOGLE_VENDORS = /* @__PURE__ */ new Set(["ga4", "google-ads"]);
function evaluate(records, scenario, options = {}) {
  const runRecord = records.find((r) => r.type === "run");
  const runId = runRecord?.id ?? records.find((r) => "runId" in r)?.runId ?? newId("run");
  const ctx = {
    hits: records.filter((r) => r.type === "hit"),
    requests: new Map(records.filter((r) => r.type === "request").map((r) => [r.id, r])),
    epochs: records.filter((r) => r.type === "consentEpoch").sort((a, b) => a.startT - b.startT),
    steps: records.filter((r) => r.type === "step"),
    responses: records.filter((r) => r.type === "response"),
    checkpoints: records.filter((r) => r.type === "checkpoint"),
    networkMode: runRecord?.networkMode,
    grace: options.graceWindowMs ?? scenario.options.graceWindow ?? DEFAULT_GRACE_MS,
    identity: options.identity ?? identityOf(runRecord)
  };
  const results = [];
  const add2 = (expectation2, pass, evidence, message, severity, note) => results.push({ type: "result", id: newId("result"), runId, expectation: expectation2, pass, evidence, message, ...severity && { severity }, ...note && { note } });
  for (const kind of ["mustNot", "must"])
    for (const rule of scenario.expect[kind]) {
      const { pass, evidence, message, note } = evaluateRule(rule, ctx);
      add2(`${kind}: ${rule.description}`, pass, evidence, message, void 0, note);
    }
  builtInChecks(records, scenario, ctx, add2);
  return results;
}
function evaluateRule(rule, ctx) {
  if (rule.cookie) return evaluateCookieRule(rule, rule.cookie, ctx);
  let hits = ctx.hits.filter((h) => matchesFilter(h, rule.filter, ctx));
  const total = hits.length;
  const narrowed = [];
  if (rule.before) {
    hits = hits.filter((h) => isBeforeConsent(h, ctx));
    narrowed.push("before consent");
  }
  if (rule.inEpoch) {
    const selector = rule.inEpoch;
    hits = hits.filter((h) => inEpoch(h, selector, ctx));
    narrowed.push(`in epoch(${selector})`);
  }
  if (rule.after) {
    const step = ctx.steps.find((s) => s.label === rule.after);
    if (!step) {
      const known = ctx.steps.map((s) => s.label).join(", ") || "none";
      return { pass: false, evidence: [], message: `Expected a step labelled "${rule.after}", but the run has steps: ${known}.` };
    }
    const from = step.endedAt ?? step.startedAt;
    hits = hits.filter((h) => h.t >= from);
    narrowed.push(`after ${rule.after}`);
  }
  const where2 = narrowed.length ? ` ${narrowed.join(", ")}` : "";
  const vacuous = rule.before ? vacuousBeforeConsent(rule, ctx) : void 0;
  if (rule.body) return evaluateBodyRule(rule, rule.body, hits, where2, total, vacuous);
  const ids = hits.map((h) => h.id);
  const found = `found ${hits.length} matching hit${hits.length === 1 ? "" : "s"}${narrowed.length ? ` (${total} before narrowing)` : ""}`;
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
function storedState(sighting, ctx) {
  if (sighting.t === void 0 || !sighting.host) return "unknown";
  const later = ctx.checkpoints.filter((c) => c.t !== void 0 && c.t > sighting.t);
  if (later.length === 0) return "unknown";
  const host = sighting.host;
  return later.some((c) => c.cookies.some((k) => k.name === sighting.name && domainMatches(host, k.domain))) ? "stored" : "notStored";
}
function storageText(sightings, ctx) {
  const byName = /* @__PURE__ */ new Map();
  for (const sighting of sightings.filter((x) => x.source === "Set-Cookie")) {
    const state = storedState(sighting, ctx);
    const previous = byName.get(sighting.name);
    if (!previous || previous === "unknown" || previous === "notStored" && state === "stored") byName.set(sighting.name, state);
  }
  const named = (want) => [...byName].filter(([, state]) => state === want).map(([name]) => guardFieldName(name)).sort();
  const stored = named("stored");
  const notStored = named("notStored");
  if (!stored.length && !notStored.length) return void 0;
  if (!notStored.length) return { text: "stored by the browser", notStored: false };
  if (!stored.length) return { text: "no later checkpoint has it", notStored: true };
  return { text: `stored by the browser: ${listNames(stored)}; no later checkpoint has: ${listNames(notStored)}`, notStored: true };
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
  const total = sightings.length;
  const narrowed = [];
  let from;
  if (rule.after) {
    const step = ctx.steps.find((s) => s.label === rule.after);
    if (!step) {
      const known = ctx.steps.map((s) => s.label).join(", ") || "none";
      return { pass: false, evidence: [], message: `Expected a step labelled "${rule.after}", but the run has steps: ${known}.` };
    }
    from = step.endedAt ?? step.startedAt;
  }
  const timed = rule.before || rule.inEpoch || from !== void 0;
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
  if (from !== void 0) {
    keep((t) => t >= from);
    narrowed.push(`after ${rule.after}`);
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
  const count = headerOnly ? `${requests} request${requests === 1 ? "" : "s"}` : `${total} before narrowing`;
  const found = sightings.length ? `found ${listNames(names)} from ${sources.join(" and ")} (${count})${storage ? `; ${storage.text}` : ""}${sources.some((s) => s !== "Set-Cookie") ? ". A checkpoint shows the cookie was present then, not when it was set" : ""}` : `found no matching cookie (${total} before narrowing)`;
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
var VENDOR_IGNORE = { ga4: GA4_BODY_ONLY_IGNORE, meta: META_BODY_ONLY_IGNORE, sgtm: SGTM_BODY_ONLY_IGNORE };
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
function evaluateBodyRule(rule, body, selected, where2, total, vacuous) {
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
    return { pass: low, evidence, message: `${expected}, ${found} (${total} before narrowing)${nestedText}.${tail}`, ...nested.length && { note: "nestedNameOnly" } };
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
    const have = idValue(hit, name);
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
function idValue(hit, name) {
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
  return prop === "matchesIdentity" ? hash.matchesIdentity : void 0;
}
function hostForms(url) {
  try {
    const { host, hostname } = new URL(url);
    return [host, hostname, hostname.replace(/^\[|\]$/g, "")];
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
function epochOf(hit, ctx) {
  return epochForHit(ctx.epochs, hit.t, ctx.grace);
}
function effectiveConsent(hit, ctx) {
  return effectiveConsentAt(hit, ctx.epochs, ctx.grace);
}
function effectiveConsentAt(hit, epochs, graceMs) {
  const base2 = epochForHit(epochs, hit.t, graceMs)?.state;
  const own = GOOGLE_VENDORS.has(hit.vendor) && consentFields.some((f) => hit.consent[f] !== "unknown");
  const pick2 = (f) => {
    if (own) return hit.consent[f];
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
  const epoch = epochOf(hit, ctx);
  return !epoch || epoch.label === "undecided";
}
function isBeforeConsent(hit, ctx) {
  const epoch = epochOf(hit, ctx);
  return !epoch || epoch === ctx.epochs[0] && epoch.label === "undecided";
}
function inEpoch(hit, selector, ctx) {
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
var DIGEST_SHAPE = /^(?:[0-9a-f]{64}|[A-Za-z0-9+/_-]{43}=?)$/i;
function allForms(h) {
  return [h.hex, h.base64, h.base64url];
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
  const emailHashes = new Set(allForms(hashEmail(identity.email)));
  const phone = hashPhone(identity.phone);
  const phoneHashes = /* @__PURE__ */ new Set([...allForms(phone), ...allForms(sha256(identity.phone.replace(/\D/g, "")))]);
  const plain = /* @__PURE__ */ new Set([identity.email.toLowerCase(), identity.phone.toLowerCase(), identity.phone.replace(/\D/g, "")]);
  const extra = identity.extra ?? [];
  const withHash = [];
  const wrong = [];
  const unhashed = [];
  const wrongFields = /* @__PURE__ */ new Set();
  const wrongParams = /* @__PURE__ */ new Set();
  const matchedFields = /* @__PURE__ */ new Set();
  const unhashedFields = /* @__PURE__ */ new Set();
  for (const hit of hits) {
    let seen = false;
    let bad = false;
    let raw = false;
    for (const [name, value] of Object.entries(hit.params)) {
      const field = FIELD_PARAMS[name]?.(identity);
      const accepted = field === void 0 ? [] : [field, ...extra];
      const known = EMAIL_PARAM.test(name) ? emailHashes : PHONE_PARAM.test(name) ? phoneHashes : field !== void 0 ? fieldHashes(...accepted) : void 0;
      if (!known || !value) continue;
      if (PLAIN_ADDRESS_PARAMS.has(name) && !DIGEST_SHAPE.test(value)) continue;
      seen = true;
      if (known.has(value)) {
        matchedFields.add(fieldLabel(name));
        continue;
      }
      bad = true;
      const typed = value.trim().toLowerCase();
      if (plain.has(typed) || accepted.some((v) => v.trim().toLowerCase() === typed)) {
        raw = true;
        unhashedFields.add(fieldLabel(name));
      } else {
        wrongFields.add(fieldLabel(name));
        wrongParams.add(name);
      }
    }
    if (seen) withHash.push(hit.id);
    if (bad) wrong.push(hit.id);
    if (raw) unhashed.push(hit.id);
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
  if (!withHash.length) {
    return { pass: false, evidence: hits.map((h) => h.id), message: `${several ? "none of them carried any" : "it carried no"} hashed email, phone, name or address value.` };
  }
  return { pass: true, evidence: withHash, message: `Hashed values in ${withHash.length} hit(s) match the run identity.` };
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
function builtInChecks(records, scenario, ctx, addResult) {
  const add2 = (name, pass, evidence2, message, note) => addResult(`builtin: ${name}`, pass, evidence2, message, scenario.options.builtins?.[name] ?? "fail", note);
  const flags2 = records.filter((r) => r.type === "flag");
  const unknown = flags2.filter((f) => f.kind === "unknownDestination");
  const allow = scenario.options.allowUnknownDestination;
  const allowedHosts = Array.isArray(allow) ? allow : [];
  const isAllowed = (f) => allow === true || hostMatches3(flagHost(f, ctx), allowedHosts);
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
    sandboxed.length === 0 ? "Expected no hit to carry a sandbox URL as its page, found none." : `Expected no hit to carry a sandbox URL as its page, found ${sandboxed.length}: ${sandboxed[0].page}.`
  );
  deniedIdentifiersCheck(scenario, ctx, add2);
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
    const classes = new Map(hit.idFields.map((n) => [n, identifierClass(n)]));
    for (const n of hit.fields) if (!classes.has(n) && extra.some((re) => re.test(n))) classes.set(n, "analytics");
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
    add2(
      "deniedIdentifiers",
      false,
      leaking.map((h) => h.id),
      `${leaking.length} hit${leaking.length === 1 ? " carries" : "s carry"} identifiers while consent is denied: ${shown2}${more}.${cut}`
    );
  } else if (unreadable.length > 0) {
    const notRecorded = unreadable.some((h) => !h.idFields || !h.fields);
    add2(
      "deniedIdentifiers",
      false,
      unreadable.map((h) => h.id),
      `${notRecorded ? NOT_RECORDED : BODY_CUT}: ${unreadable.length} hit${unreadable.length === 1 ? "" : "s"} sent while consent is denied.`,
      notRecorded ? "fieldsNotRecorded" : "cannotEvaluateBody"
    );
  } else {
    add2("deniedIdentifiers", true, [], "Expected no identifiers on hits sent while consent is denied, found none.");
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
var isObject2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function blankOperation(op) {
  if (!isObject2(op)) return;
  for (const key of Object.keys(op)) {
    if (/^(?:id|sha256hash)$/i.test(key) && typeof op[key] === "string" && HEX64.test(op[key])) op[key] = "";
  }
  const extensions = typeof op.extensions === "string" ? parseJson(op.extensions) : op.extensions;
  if (isObject2(extensions) && isObject2(extensions.persistedQuery)) {
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
    slot(request.id, request.stepId).texts.push(url, ...pathSegments(url), persisted.postData);
  }
  for (const hit of hits) {
    const entry = slot(hit.requestId, hit.stepId);
    entry.hitIds.push(hit.id);
    for (const [key, value] of Object.entries(hit.params)) entry.texts.push(`${key}=${value}`);
  }
  const stableHashes = findStableHashes(
    [...byRequest].flatMap(([requestId, entry]) => entry.texts.map((text2) => ({ requestId, text: text2 })))
  );
  const out = [];
  for (const [requestId, entry] of byRequest) {
    const found = /* @__PURE__ */ new Map();
    for (const text2 of entry.texts) for (const m of scan(text2, identity, { stableHashes })) found.set(`${m.kind}:${m.value}`, m.kind);
    if (found.size === 0) continue;
    const kinds = [...new Set(found.values())].join(", ");
    const step = entry.stepId ? ` in step ${entry.stepId}` : "";
    out.push({
      requestId,
      detail: `request ${requestId}${step} carries ${found.size} ${kinds} value(s) that are not from the run identity`,
      evidence: [requestId, ...entry.hitIds, ...entry.stepId ? [entry.stepId] : []]
    });
  }
  return out;
}

// packages/expect/src/diff.ts
var NO_EPOCH = "none";
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
function ref(h, steps) {
  return { hitId: h.id, t: h.t, step: h.stepId ? steps.get(h.stepId) ?? "" : "", page: h.page };
}
function stepLabels(run) {
  return new Map(run.steps.map((s) => [s.id, s.label]));
}
function groupHits(run, options) {
  const epochs = [...run.consentEpochs].sort((x, y) => x.startT - y.startT);
  const frames = new Map(run.requests.map((r) => [r.id, r.frameUrl]));
  const groups = /* @__PURE__ */ new Map();
  for (const hit of [...run.hits].sort((x, y) => x.t - y.t)) {
    const key = {
      epoch: epochForHit(epochs, hit.t)?.label ?? NO_EPOCH,
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
  try {
    return stripSandboxPrefix(new URL(page2).pathname);
  } catch {
    return stripSandboxPrefix(page2);
  }
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
  const check = run.results.find((r) => r.expectation === "builtin: unknownDestination");
  if (!check) return /* @__PURE__ */ new Set();
  const unknown = run.flags.filter((f) => f.kind === "unknownDestination").map((f) => f.id);
  const blocked = new Set(check.pass ? [] : check.evidence);
  return new Set(unknown.filter((id) => !blocked.has(id)));
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

// packages/cli/src/diff.ts
function pathOf2(page2) {
  try {
    return new URL(page2).pathname;
  } catch {
    return page2;
  }
}
function where(key, step, rawPage) {
  const raw = rawPage && key.page && pathOf2(rawPage) !== key.page ? `, recorded as ${rawPage}` : "";
  const parts = [step && `step "${step}"`, key.page && `page ${key.page}${raw}`].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}
function recordedPages(c) {
  if (!c.key.page || c.a.page === null && c.b.page === null) return "";
  const differs = [c.a.page, c.b.page].some((p) => p !== null && pathOf2(p) !== c.key.page);
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
  if (hiddenFlags) out.push("", `${hiddenFlags} flag count change${hiddenFlags === 1 ? "" : "s"} for hosts allowed by allowUnknownDestination not shown (use --all-flags)`);
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

// packages/cli/src/install-browser.ts
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join as join2 } from "node:path";
function installBrowser() {
  const cli = join2(dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");
  return new Promise((resolve2, reject) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve2(code ?? 1));
  });
}

// packages/cli/src/report/index.ts
import { mkdir as mkdir3, stat, writeFile as writeFile3 } from "node:fs/promises";
import { dirname as dirname3, join as join8, resolve } from "node:path";

// packages/cli/src/report/model.ts
var NOTE_TEXT = {
  stubNoCookies: "stub mode: stubbed endpoints set no cookies, so this pass says nothing about server cookies",
  cannotEvaluateBody: "cannot evaluate: body not fully recorded",
  fieldsNotRecorded: "cannot evaluate: field names not recorded",
  cookieNotStored: "the server set this cookie, but no later checkpoint shows the browser holding it",
  nestedNameOnly: "a plain name matches a top-level field only; use **.name to match at any depth"
};
var WORST_FIRST = ["leak", "unchecked", "mixed", "early", "full", "ping"];
var CONSENT_FIELDS = ["analytics", "ads", "adUserData", "adPersonalization"];
var MAX_EVIDENCE = 5;
var MAX_VALUE = 80;
var SHOWN_VALUE_KEYS = /* @__PURE__ */ new Set(["vendor", "event", "in", "before", "after", "host", "count", "outcome", "transport", "cookie"]);
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
  const cannot = !result.pass && (result.note === "cannotEvaluateBody" || result.note === "fieldsNotRecorded");
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
function namedLeaks(results) {
  const named = /* @__PURE__ */ new Map();
  for (const result of results) {
    if (result.pass || result.note === "cannotEvaluateBody" || result.note === "fieldsNotRecorded") continue;
    let label;
    if (result.expectation === "builtin: deniedIdentifiers") label = IDENTIFIER_LEAK;
    else {
      const parsed = parseEntry2(result);
      if (parsed?.kind !== "mustNot" || !consentScoped(parsed.entry)) continue;
      label = RULE_LEAK;
    }
    for (const id of result.evidence) if (named.get(id) !== IDENTIFIER_LEAK) named.set(id, label);
  }
  return named;
}
function judge(hit, state, undecided, named) {
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
  if (mark === "full" && has("ping")) return { mark: "mixed", label: "granted and denied hits", hits };
  const own = verdicts2.filter((v) => v.mark === mark);
  let label = own.every((v) => v.label === own[0].label) ? own[0].label : "";
  if (mark === "mixed") label = MIXED_HIT;
  return { mark, label, hits };
}
function hostOf3(url) {
  try {
    return new URL(url).host || void 0;
  } catch {
    return void 0;
  }
}
function flagViews(records) {
  const hostByRecord = /* @__PURE__ */ new Map();
  for (const r of records.requests) {
    const host = hostOf3(r.url);
    if (host) hostByRecord.set(r.id, host);
  }
  for (const h of records.hits) {
    const host = hostByRecord.get(h.requestId);
    if (host) hostByRecord.set(h.id, host);
  }
  const byKind = /* @__PURE__ */ new Map();
  for (const flag2 of records.flags) {
    const entry = byKind.get(flag2.kind) ?? { count: 0, hosts: /* @__PURE__ */ new Set() };
    entry.count++;
    for (const id of flag2.recordIds) {
      const host = hostByRecord.get(id);
      if (host) entry.hosts.add(host);
    }
    byKind.set(flag2.kind, entry);
  }
  return [...byKind].map(([kind, { count, hosts }]) => ({ kind, count, hosts: [...hosts].sort() })).sort((a, b) => a.kind.localeCompare(b.kind));
}
function buildReportModel(records) {
  const { run } = records;
  const graceMs = run.graceWindowMs ?? DEFAULT_GRACE_MS;
  const epochs = [...records.consentEpochs].sort((a, b) => a.startT - b.startT);
  const named = namedLeaks(records.results);
  const placed = records.hits.map((hit) => {
    const epoch = epochForHit(epochs, hit.t, graceMs);
    const state = effectiveConsentAt(hit, epochs, graceMs);
    const column = epoch ? epochs.indexOf(epoch) : -1;
    return { hit, state, column, verdict: judge(hit, state, !epoch || epoch.label === "undecided", named) };
  });
  const synthetic = epochs.length === 0 || placed.some((p) => p.column < 0);
  const offset = synthetic ? 1 : 0;
  const columns = [
    ...synthetic ? [{ label: "undecided", index: 0 }] : [],
    ...epochs.map((e, i) => ({ label: e.label, index: i + offset }))
  ];
  const vendors = [...new Set(records.hits.map((h) => h.vendor))].sort();
  const rows = vendors.map((vendor) => {
    const own = placed.filter((p) => p.hit.vendor === vendor);
    return {
      vendor,
      hits: own.length,
      segments: columns.map((col) => segmentOf(own.filter((p) => p.column + offset === col.index).map((p) => p.verdict)))
    };
  });
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
      runId: run.id,
      startedAt: new Date(run.startedAt).toISOString(),
      networkMode: run.networkMode,
      host: hostOf3(run.site) ?? "",
      pingwrightVersion: run.pingwrightVersion,
      schemaVersion: version
    },
    columns,
    rows,
    expectations: records.results.map(expectationView),
    flags: flagViews(records),
    fields: fields2
  };
}

// packages/cli/src/report/verdict.ts
function emptyFindings() {
  return { hits: /* @__PURE__ */ new Map(), identifiers: /* @__PURE__ */ new Map(), failed: 0, warned: 0, unchecked: 0 };
}
function addFindings(into, model) {
  for (const row of model.rows) {
    row.segments.forEach((segment, i) => {
      if (segment.mark !== "leak") return;
      const target = segment.label === IDENTIFIER_LEAK ? into.identifiers : into.hits;
      const label = model.columns[i].label;
      const vendors = target.get(label) ?? /* @__PURE__ */ new Set();
      vendors.add(row.vendor);
      target.set(label, vendors);
    });
  }
  for (const e of model.expectations) {
    if (e.status === "FAIL") into.failed++;
    else if (e.status === "WARN") into.warned++;
    else if (e.status === "CANNOT EVALUATE") into.unchecked++;
  }
}
function list(names) {
  const all = [...names].sort();
  return all.length < 2 ? all.join("") : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
}
var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function findingsSentence(f) {
  const parts = [];
  for (const [label, vendors] of [...f.hits].sort(([a], [b]) => a.localeCompare(b))) parts.push(`${list(vendors)} send hits in the ${label} state`);
  for (const [label, vendors] of [...f.identifiers].sort(([a], [b]) => a.localeCompare(b))) parts.push(`identifiers go out to ${list(vendors)} in the ${label} state`);
  if (parts.length === 0 && f.unchecked === 0) parts.push("no leaks");
  if (f.failed > 0) parts.push(plural(f.failed, "failed expectation"));
  if (f.unchecked > 0) parts.push(`${plural(f.unchecked, "expectation")} could not be checked`);
  if (f.warned > 0) parts.push(plural(f.warned, "accepted warning"));
  return parts.join(", ");
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
  leak: "identifier names sent while their signal was denied, or named by a failed consent-scoped mustNot",
  unchecked: "denied, but the body was not fully recorded, so the hit cannot be called clean",
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
  const count = segment.hits ? `<span class="count">${segment.hits} hit${segment.hits === 1 ? "" : "s"}</span>` : "";
  return `<td class="m-${segment.mark}">${glyph(segment.mark)}<span class="name">${MARK_NAME[segment.mark]}</span>${count}${label}</td>`;
}
function timeline(model) {
  if (model.rows.length === 0) return '<p class="empty">No vendor hits were recorded.</p>';
  const head = model.columns.map((c) => `<th scope="col">${escapeHtml(c.label)}</th>`).join("");
  const body = model.rows.map((row) => `<tr><th scope="row">${escapeHtml(row.vendor)}</th>${row.segments.map(segmentCell).join("")}</tr>`).join("");
  const legend = Object.keys(LEGEND).map((m) => `<li class="m-${m}">${glyph(m)}<strong>${m}</strong> ${escapeHtml(LEGEND[m])}</li>`).join("");
  return `<div class="scroll"><table class="timeline"><thead><tr><th scope="col">Vendor</th>${head}</tr></thead><tbody>${body}</tbody></table></div><ul class="legend">${legend}</ul>`;
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
function flags(model) {
  if (model.flags.length === 0) return '<p class="empty">No flags.</p>';
  const rows = model.flags.map((f) => `<tr><td>${escapeHtml(f.kind)}</td><td>${f.count}</td><td>${f.hosts.map(escapeHtml).join(", ")}</td></tr>`).join("");
  return `<div class="scroll"><table><thead><tr><th scope="col">Kind</th><th scope="col">Count</th><th scope="col">Hosts</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function fields(model) {
  if (!model.fields) return `<p class="empty">not recorded (record schema version ${model.header.schemaVersion})</p>`;
  if (model.fields.length === 0) return '<p class="empty">No hit was sent while a signal was denied.</p>';
  const items = model.fields.map((v) => `<li><strong>${escapeHtml(v.vendor)}</strong> ${v.names.map((n) => `<code>${escapeHtml(n)}</code>`).join(" ")}</li>`).join("");
  return `<ul class="fields">${items}</ul>`;
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
    ["Pingwright", h.pingwrightVersion],
    ["Record schema", String(h.schemaVersion)]
  ];
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
${fields(model)}`;
}
function page(body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pingwright report</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
<p class="caveat">Names and counts only. A mark describes what Pingwright recorded. It is not a statement of legal compliance.</p>
</main>
</body>
</html>
`;
}
function renderReport(model) {
  return page(`<h1>${escapeHtml(model.header.scenario)}</h1>
${definitionList(runHeader(model.header))}
<p class="verdict">${escapeHtml(runVerdict(model))}</p>
${runSections(model, "h2")}`);
}

// packages/cli/src/report/suite.ts
import { readFile as readFile4 } from "node:fs/promises";
import { basename as basename3, join as join7 } from "node:path";

// packages/cli/src/suite.ts
import { mkdir as mkdir2, readdir, readFile as readFile3, writeFile as writeFile2 } from "node:fs/promises";
import { basename as basename2, extname, join as join6 } from "node:path";

// packages/recorder/src/origins.ts
var COLLECTOR_ORIGIN = "https://collector.pingwright.invalid";
var SELFTEST_ORIGIN = "https://selftest.pingwright.invalid";

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
function stubResponse(req) {
  const cors = corsHeaders(req.headers);
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
function isStubbedCollection(req, options) {
  if (!isCollectionEndpoint(req, options.trackers) && !isKnownVendorCollection(req)) return false;
  if (options.networkMode !== "server") return true;
  let host;
  try {
    host = new URL(req.url).hostname;
  } catch {
    return true;
  }
  const bare = (h) => h.replace(/^\[|\]$/g, "");
  return !hostMatches3(bare(host), (options.serverHosts ?? []).map(bare));
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
var DATALAYER_BINDING = "__pingwrightDataLayer";
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
    if (!Array.isArray(layer) || layer.__pingwrightHooked) return;
    Object.defineProperty(layer, '__pingwrightHooked', { value: true });
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
function dataLayerEventFromPayload(payload, runId, offset) {
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
    isConsentCommand: isConsentCommand(args)
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
  if (host === siteHost || hostMatches3(host, firstPartyHosts)) return true;
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
function buildFlags({ runId, networkMode, siteUrl, firstPartyHosts, trackers = trackerList, requests, hits, identity, routedRequestIds }) {
  const scope = { siteHost: parse(siteUrl)?.hostname ?? "", firstPartyHosts };
  const flags2 = [];
  for (const req of requests) {
    if (isUnknownDestination(req, scope, trackers)) {
      flags2.push(flag(runId, "unknownDestination", [req.id], `${req.method} ${req.url}`));
    } else if (isFirstPartySubdomain(req, scope, trackers)) {
      flags2.push(flag(runId, "firstPartySubdomain", [req.id], `${req.method} ${req.url}`));
    }
    if (networkMode !== "live" && !routedRequestIds.has(req.id) && (isCollectionEndpoint(req, trackers) || isKnownVendorCollection(req))) {
      const why = req.initiator === "redirect" ? "It followed a redirect" : "It was not routed";
      flags2.push(flag(runId, "stubBypass", [req.id], `${why}, so it was not stubbed: ${req.url}`));
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
function unloadGapAdvice(networkMode) {
  return networkMode === "live" ? "which is not captured without --net-log" : "which stub mode cannot capture. Add the name to options.unloadGapIgnore if the hit is not needed, or check it in a live run with --network live --net-log";
}
function buildUnloadGapFlags({ runId, networkMode, events, hits, navigations, ignore = [] }) {
  const ignored = ignore.map(globToRegExp);
  const ga4Hits = hits.filter((h) => h.vendor === "ga4");
  const flags2 = [];
  for (const event of events) {
    const name = event.event;
    if (name === null || event.isConsentCommand || name.startsWith("gtm.") || ignored.some((re) => re.test(name))) continue;
    const navigation = navigations.find((n) => n >= event.t);
    if (navigation === void 0 || navigation - event.t > UNLOAD_GAP_WINDOW_MS) continue;
    const expected = GA4_ALIASES[name] ?? name;
    const ga4Name = GA4_EVENTS.has(expected);
    const literalGa4Name = GA4_EVENTS.has(name);
    if (!literalGa4Name && !hits.some((h) => h.event === name)) continue;
    if (!literalGa4Name && ga4Hits.length === 0) continue;
    const covered = (h) => h.t >= event.t && h.t <= navigation + UNLOAD_GAP_SLACK_MS && h.event === name;
    if (ga4Hits.length === 0 && hits.some(covered)) continue;
    if (ga4Hits.some((h) => h.t >= event.t && h.t <= navigation + UNLOAD_GAP_SLACK_MS && h.event !== null && (h.event === name || h.event === expected || !ga4Name && GA4_EVENTS.has(h.event)))) continue;
    const seconds = ((navigation - event.t) / 1e3).toFixed(1);
    flags2.push(
      flag(
        runId,
        "unloadGap",
        [event.id],
        `A frame pushed "${name}" ${seconds} s before the page navigated and no ga4 hit for it was recorded after it. The frame may have sent the hit while unloading, ${unloadGapAdvice(networkMode)} (design \xA75.3).`
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
  return `<!doctype html><meta charset="utf-8"><title>Pingwright self-test</title>
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
  const allSeen = new Promise((resolve2) => done = resolve2);
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
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join4 } from "node:path";

// packages/recorder/src/handoff-overlay.ts
import { randomUUID as randomUUID2 } from "node:crypto";
var HANDOFF_STATE_BINDING = "__pwHandoffState";
var HANDOFF_DONE_BINDING = "__pwHandoffDone";
var HANDOFF_HOST_ID = "pingwright-handoff";
var HANDOFF_WAKE_EVENT = "pingwright-handoff-wake";
var HANDOFF_REMINDER_MS = 6e4;
var HANDOFF_WAKE_LIMIT_MS = 2e3;
var HandoffGate = class {
  nonce = randomUUID2();
  text = null;
  finish = null;
  begin(text2) {
    this.text = text2;
    return new Promise((resolve2) => {
      this.finish = resolve2;
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
  const limit = new Promise((resolve2) => {
    timer = setTimeout(resolve2, limitMs);
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
  const reminder = setInterval(() => wait.print(`Still waiting for the handoff: ${wait.text}`), wait.reminderMs ?? HANDOFF_REMINDER_MS);
  const fromButton = wait.gate.begin(wait.text);
  try {
    if (wait.wake) void boundedWake(wait.wake);
    await Promise.race([fromButton, wait.resolver(wait.text, abort.signal)]);
  } finally {
    clearInterval(reminder);
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
import { createRequire as createRequire2 } from "node:module";
import { dirname as dirname2, join as join3 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var require2 = createRequire2(import.meta.url);
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
  return readFileSync2(join3(dirname2(entry), "autoconsent.playwright.js"), "utf8");
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
    return new Promise((resolve2) => {
      const done = (value) => {
        clearTimeout(timer);
        this.#listeners.delete(check);
        resolve2(value);
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
  chromium
} from "playwright";

// packages/recorder/src/redact.ts
var REDACTED_HEADERS = /* @__PURE__ */ new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);
function redactHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, REDACTED_HEADERS.has(k.toLowerCase()) ? "[redacted]" : v])
  );
}

// packages/recorder/src/netlog-dir.ts
import { rmSync } from "node:fs";
function watchNetLogDir(dir) {
  const remove = () => {
    process.off("exit", remove);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    rmSync(dir, { recursive: true, force: true });
  };
  const onSignal = (signal) => {
    remove();
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  process.on("exit", remove);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
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
  const { constants, events } = parseFile(text2);
  const types = constants.logEventTypes;
  const errorNames = new Map(Object.entries(constants.netError).map(([name, code]) => [code, name]));
  const offset = Number(constants.timeTickOffset);
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

// packages/recorder/src/unload.ts
var UNLOAD_BINDING = "__pingwrightUnloadSend";
var UNLOAD_FLUSH = "__pingwrightFlushUnload";
var unloadInitScript = `(() => {
  const binding = ${JSON.stringify(UNLOAD_BINDING)};
  const STORE = '__pingwrightUnloadQueue';
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
      const boundary = '----pingwright' + Math.random().toString(36).slice(2);
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
var TEST_GTM_ORIGIN_ENV = "PINGWRIGHT_TEST_GTM_ORIGIN";
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
    if (hostMatches3(host, firstPartyHosts)) return true;
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

// packages/recorder/src/gtm-scrub.ts
var REDACTED = "[redacted]";
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
    return containsSecret(text2, this.secret) ? REDACTED : text2;
  }
  pairs(query) {
    return query.split("&").map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return this.value(pair);
      return containsSecret(pair.slice(eq + 1), this.secret) ? `${pair.slice(0, eq + 1)}${REDACTED}` : pair;
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
    if (url !== REDACTED) return this.value(split[1]) + url;
    try {
      const origin = new URL(split[2]).origin;
      return this.value(split[1]) + (containsSecret(origin, this.secret) ? REDACTED : `${origin}/${REDACTED}`);
    } catch {
      return REDACTED;
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
    return text2.split("\n").map((line) => this.value(line.split(this.secret).join(REDACTED))).join("\n");
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

// packages/recorder/src/recorder.ts
var PINGWRIGHT_VERSION = readVersion();
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
  selfRecorded = /* @__PURE__ */ new WeakSet();
  responses = [];
  dataLayerEvents = [];
  mainFrameEventIds = /* @__PURE__ */ new Set();
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
  static async launch(options) {
    const testGtmOrigin = parseTestGtmOrigin(process.env[TEST_GTM_ORIGIN_ENV]);
    const gtmOverride = options.gtmOverride === void 0 ? void 0 : parseGtmOverride(options.gtmOverride);
    if (options.networkMode === "server" && !options.serverHosts?.length) {
      throw new Error('networkMode "server" needs serverHosts: the hosts whose requests pass through.');
    }
    if (options.netLog && options.networkMode !== "live") {
      throw new Error('netLog needs networkMode "live": in stub mode the requests a frame sends while it unloads would leave the machine.');
    }
    let netLogPath;
    let removeNetLogDir;
    if (options.netLog) {
      const dir = await mkdtemp(join4(tmpdir(), "pingwright-netlog-"));
      netLogPath = join4(dir, "netlog.json");
      removeNetLogDir = watchNetLogDir(dir);
    }
    let browser;
    try {
      browser = await chromium.launch({
        channel: "chromium",
        headless: !options.headed,
        ...netLogPath ? { args: [`--log-net-log=${netLogPath}`] } : {}
      });
    } catch (error) {
      removeNetLogDir?.();
      throw error;
    }
    try {
      const context = await browser.newContext({
        userAgent: options.userAgentOverride ?? chromeUserAgent(browser.version()),
        serviceWorkers: options.serviceWorkers ?? "allow"
      });
      const recorder = new _Recorder(options, browser, context, gtmOverride, testGtmOrigin, netLogPath, removeNetLogDir);
      await recorder.init();
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
      pingwrightVersion: PINGWRIGHT_VERSION,
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
      ...this.options.graceWindowMs !== void 0 ? { graceWindowMs: this.options.graceWindowMs } : {}
    };
    await context.exposeBinding(DATALAYER_BINDING, (source, payload) => {
      const event = dataLayerEventFromPayload(payload, this.runId, this.clockOffset);
      if (!event) return;
      this.dataLayerEvents.push({ ...event, stepId: this.currentStepId });
      if (source.frame === source.page.mainFrame()) this.mainFrameEventIds.add(event.id);
    });
    await context.addInitScript(dataLayerInitScript);
    this.consent = await installConsent(context, this.options.autoconsent);
    if (this.options.networkMode !== "live") {
      await context.exposeBinding(UNLOAD_BINDING, (_source, payload) => this.recordUnloadSend(payload));
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
  /** Created on first sight, from either the request event or the route handler, whichever comes first. */
  recordFor(request) {
    const existing = this.requests.get(request);
    if (existing) return existing;
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
    if (request.isNavigationRequest() && isTopLevelFrameRequest(request)) {
      this.navigationWindows.start(request, record.t);
      this.navigations.push(record.t);
    }
    return record;
  }
  /** A person is typing during a handoff, so only requests that decode as tracking hits keep their body and query. */
  redactForHandoff(record, at = Date.now()) {
    if (!this.duringHandoff(at)) return record;
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
  duringHandoff(at) {
    return this.handoffWindows.some((w) => at >= w.from && (w.to === null || at <= w.to));
  }
  /** Requests sent while a handoff is active, including unload sends queued then and replayed later, are stored without their typed values. */
  setHandoff(active) {
    if (active) this.handoffWindows.push({ from: Date.now(), to: null });
    else {
      const open2 = this.handoffWindows.find((w) => w.to === null);
      if (open2) open2.to = Date.now();
    }
  }
  recordUnloadSend(payload) {
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
    await route.continue();
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
    await new Promise((resolve2) => setTimeout(resolve2, ms));
  }
  async flushUnloadQueues() {
    const script = `window.${UNLOAD_FLUSH}?.()`;
    for (const page2 of this.context.pages()) {
      await page2.evaluate(script).catch(() => void 0);
    }
    await this.wait(50);
  }
  /** Closes the browser, decodes the requests and writes `<outDir>/<runId>.jsonl`. */
  async close() {
    if (this.options.networkMode !== "live") await this.flushUnloadQueues();
    this.closed = true;
    try {
      await this.browser.close();
    } catch (error) {
      this.removeNetLogDir?.();
      throw error;
    }
    await Promise.allSettled([...this.pending]);
    const netLog = await this.readNetLog();
    if (netLog) {
      const { requests: added, responses } = mergeNetLog(netLog, [...this.requests.values(), ...this.extraRequests], this.steps, this.trackers, this.runId, this.navigationWindows.list());
      this.extraRequests.push(...added);
      this.responses.push(...responses);
    }
    const requests = [...this.requests.values(), ...this.extraRequests];
    const hits = requests.flatMap((r) => decodeRequest(r, void 0, this.trackers));
    const flags2 = buildFlags({
      runId: this.runId,
      networkMode: this.options.networkMode,
      siteUrl: this.options.site,
      firstPartyHosts: this.options.firstPartyHosts,
      trackers: this.trackers,
      requests,
      hits,
      identity: this.run.identity,
      routedRequestIds: this.routed
    });
    if (!this.netLogPath) {
      const embedded = this.dataLayerEvents.filter((e) => !this.mainFrameEventIds.has(e.id));
      flags2.push(...buildUnloadGapFlags({ runId: this.runId, networkMode: this.options.networkMode, events: embedded, hits, navigations: this.navigations, ignore: this.options.unloadGapIgnore }));
    } else if (!netLog) {
      flags2.push({ type: "flag", id: newId("flag"), runId: this.runId, kind: "netLogUnreadable", recordIds: [], detail: "The net log could not be read, so requests sent while a frame unloads may be missing." });
    }
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

// packages/recorder/src/guard.ts
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
var SENSITIVE_NAME = /card|cvc|cvv|iban|password/i;
function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
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
  window.__pingwrightTrap = { state, release: () => restores.forEach((r) => r()) };
})()`;

// packages/recorder/src/steps.ts
import { createInterface as createInterface2 } from "node:readline/promises";

// packages/recorder/src/locators.ts
var ROLE_FAMILIES = ["button", "radio", "checkbox", "link", "tab", "option"];
var MAX_LISTED2 = 10;
var MAX_NAME = 60;
var POLL_MS = 100;
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
    await new Promise((resolve2) => setTimeout(resolve2, POLL_MS));
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
var HANDOFF_REMINDER = "Use test accounts and test cards only. Never enter real personal or payment details.";
function hasHandoff(scenario) {
  return scenario.steps.some((s) => s.kind === "handoff");
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
  if (sensitive && !isLoopbackHost(inspected.host)) {
    throw new Error(`${selector} is a card or password field. ${HANDOFF_REQUIRED}`);
  }
  return { field, tag: inspected.tag, sensitive };
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
  return page2.frames().filter((frame) => !isLoopbackHost(new URL(frame.url() || "about:blank", "http://invalid.invalid").hostname));
}
async function rememberFieldValues(frame) {
  await frame.evaluate(() => {
    const initial = /* @__PURE__ */ new WeakMap();
    for (const e of document.querySelectorAll("input, textarea")) initial.set(e, e.value);
    window.__pingwrightInitial = initial;
  }).catch(() => void 0);
}
async function changedSensitiveFields(frame) {
  const fields2 = await frame.evaluate(() => {
    const initial = window.__pingwrightInitial;
    delete window.__pingwrightInitial;
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
      const trap = window.__pingwrightTrap;
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
    case "handoff": {
      const print = options.print ?? ((text2) => process.stdout.write(`${text2}
`));
      print(`
Handoff: ${step.value}
${HANDOFF_REMINDER}
Recording continues until you are done.`);
      recorder.setHandoff(true);
      try {
        await waitForHandoff({ text: step.value, gate: recorder.handoff, resolver: options.handoffResolver ?? stdinResolver, print, wake: () => wakeOverlay(recorder) });
      } finally {
        recorder.setHandoff(false);
      }
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
  return { ...createIdentity(seed), ...scenario.identity };
}
async function playScenario(recorder, scenario, options = {}) {
  const identity = scenarioIdentity(scenario, options.seed ?? scenario.options.seed ?? Math.floor(Math.random() * 2 ** 31));
  recorder.setIdentity(identity);
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
  return result;
}

// packages/cli/src/run.ts
import { appendFile, readFile as readFile2, rename, writeFile } from "node:fs/promises";
import { basename, join as join5 } from "node:path";

// packages/cli/src/summary.ts
var EVIDENCE_CAP = 5;
var PATH_EXAMPLES = 3;
var SANDBOX_PATH_EXAMPLES = 1;
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
function buildSummary(records, results, path) {
  return {
    runId: records.run.id,
    path,
    pass: results.every((r) => r.pass),
    ok: results.every(passesGate),
    hits: countHits(records.hits),
    epochs: records.consentEpochs.map((e) => ({ label: e.label, state: stateName(e.state), startT: e.startT, endT: e.endT })),
    flags: records.flags.map((f) => ({ kind: f.kind, detail: f.detail })),
    results: results.map((r) => ({ expectation: r.expectation, pass: r.pass, message: r.message, evidence: r.evidence, severity: r.severity ?? "fail" }))
  };
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
  return lines;
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
function formatDuration(ms) {
  const rounded = Math.round(ms);
  return rounded < 1e3 ? `${rounded} ms` : `${(ms / 1e3).toFixed(1)} s`;
}
function formatSummary(summary) {
  const lines = [];
  lines.push("Hits");
  const vendors = Object.entries(summary.hits);
  if (vendors.length === 0) lines.push("  none");
  for (const [vendor, events] of vendors) {
    lines.push(`  ${vendor}: ${Object.entries(events).map(([e, n]) => `${e} x${n}`).join(", ")}`);
  }
  lines.push("Consent epochs");
  for (const e of summary.epochs) {
    const label = e.label === "withdrawn" && e.state ? `withdrawn, ${e.state}` : e.label;
    lines.push(`  ${label} (${e.endT === null ? "to end" : formatDuration(e.endT - e.startT)})`);
  }
  lines.push("Flags");
  if (summary.flags.length === 0) lines.push("  none");
  lines.push(...formatFlags(summary.flags));
  lines.push("Expectations");
  for (const r of summary.results) {
    lines.push(`  ${r.pass ? "PASS" : r.severity === "warn" ? "WARN" : "FAIL"} ${r.expectation}`);
    if (!r.pass && r.message) lines.push(`       ${r.message}`);
    if (r.evidence.length) {
      const shown2 = r.evidence.slice(0, EVIDENCE_CAP);
      const more = r.evidence.length - shown2.length;
      lines.push(`       evidence: ${shown2.join(", ")}${more > 0 ? ` and ${more} more` : ""}`);
    }
  }
  const failed = summary.results.filter((r) => !passesGate(r)).length;
  const warned = summary.results.filter((r) => !r.pass && passesGate(r)).length;
  const warnings = warned > 0 ? ` with ${warned} warning${warned === 1 ? "" : "s"}` : "";
  lines.push(failed === 0 ? `Result: pass${warnings}` : `Result: fail (${failed} of ${summary.results.length})${warnings}`);
  lines.push(`Record: ${summary.path}`);
  return lines.join("\n");
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
    text2 = await readFile2(path, "utf8");
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
    text2 = await readFile2(path, "utf8");
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
function resolveNetwork(args, parsed, io) {
  const networkMode = args.network ?? parsed.options.network ?? "stub";
  const serverHosts = parsed.options.serverHosts ?? [];
  if (networkMode === "server") {
    if (serverHosts.length === 0) {
      io.stderr('Network mode "server" needs options.serverHosts in the scenario: the hosts whose requests pass through, such as sgtm.example.com.\n');
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
function warnTestGtmOrigin(io) {
  const origin = parseTestGtmOrigin(process.env[TEST_GTM_ORIGIN_ENV]);
  if (origin) io.stderr(`Warning: ${TEST_GTM_ORIGIN_ENV} is set. gtm.js is fetched from ${origin}. This is for tests only.
`);
}
async function labelRecord(path, variant, out) {
  const text2 = await readFile2(path, "utf8");
  const newline = text2.indexOf("\n");
  const run = { ...JSON.parse(text2.slice(0, newline)), variant: variant.name };
  const target = join5(out, `${variant.fileStem}.${variant.name}.jsonl`);
  await writeFile(path, `${JSON.stringify(run)}${text2.slice(newline)}`);
  await rename(path, target);
  return target;
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
      unloadGapIgnore: parsed.options.unloadGapIgnore,
      graceWindowMs: parsed.options.graceWindow ?? DEFAULT_GRACE_MS,
      seed: spec.seed,
      headed: spec.headed,
      netLog: spec.netLog,
      autoconsent: spec.autoconsentRules.length ? { ruleFiles: spec.autoconsentRules } : void 0,
      gtmOverride,
      trackerList: spec.trackers,
      userAgentOverride: process.env.PINGWRIGHT_TEST_USER_AGENT || void 0
    });
    records = result.records;
    path = result.path;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (MISSING_BROWSER.test(message)) return failed("Chromium is not installed. Run `pingwright install-browser`.\n");
    let text2 = `Run failed: ${error instanceof GtmOverrideFailure ? `GTM override: ${message}` : message}
`;
    const written = (error instanceof StepError || error instanceof GtmOverrideFailure) && error.run ? error.run.path : void 0;
    if (written) {
      const kept = variant ? await labelRecord(written, variant, spec.out) : written;
      text2 += `Record: ${kept}
`;
      return { ...failed(text2), path: kept };
    }
    return failed(text2);
  }
  if (variant) {
    path = await labelRecord(path, variant, spec.out);
    records.run.variant = variant.name;
  }
  let results = evaluate(allRecords(records), parsed);
  if (scrubber) results = scrubber.deep(results);
  await appendFile(path, results.map((r) => JSON.stringify(r) + "\n").join(""));
  return { code: exitCodeFor(results), path, summary: buildSummary(records, results, path) };
}
async function runCommand(args, io) {
  let text2;
  try {
    text2 = await readFile2(args.scenario, "utf8");
  } catch (error) {
    io.stderr(`Cannot read ${args.scenario}: ${error instanceof Error ? error.message : String(error)}
`);
    return 2;
  }
  let trackers = [];
  if (args.trackerList !== void 0) {
    try {
      trackers = await readTrackerList(args.trackerList);
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
  for (const warning of parsed.warnings) io.stderr(`Warning: ${warning}
`);
  const undeclared = Object.keys(args.vars).filter((name) => !Object.hasOwn(parsed.vars, name));
  if (undeclared.length) {
    io.stderr(`--var ${undeclared.join(", ")} not declared in the scenario's vars. --var only overrides declared variables.
`);
    return 2;
  }
  parsed.vars = { ...parsed.vars, ...args.vars };
  const network = resolveNetwork(args, parsed, io);
  if (!network) return 2;
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
  const outcome = await executeRun(
    {
      parsed,
      scenarioName: basename(args.scenario),
      network,
      site: args.site,
      out: args.out,
      seed: args.seed,
      headed: args.headed,
      netLog: args.netLog,
      autoconsentRules: args.autoconsentRules,
      trackers,
      gtmOverride
    },
    io
  );
  if (!outcome.summary) return outcome.code;
  const output = args.json ? `${JSON.stringify(outcome.summary, null, 2)}
` : `${formatSummary(outcome.summary)}
`;
  io.stdout(gtmOverride ? new Scrubber(gtmOverride.gtmAuth).text(output) : output);
  return outcome.code;
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
  const parts = [rules > 0 && `${rules} rule${rules === 1 ? "" : "s"}`, ...checks].filter(Boolean);
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
function formatSuiteTable(manifest, dir) {
  const [first, ...others] = manifest.variants;
  const scenarios = [...new Set(manifest.cells.map((c) => c.scenario))];
  const header = ["scenario", ...manifest.variants, ...others.map((v) => `diff (${first} -> ${v})`)];
  const rows = scenarios.map((scenario) => [
    scenario,
    ...manifest.variants.map((v) => cellText(manifest.cells.find((c) => c.scenario === scenario && c.variant === v))),
    ...others.map((v) => diffText(manifest.diffs.find((d) => d.scenario === scenario && d.to === v)))
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols) => cols.map((c, i) => i === cols.length - 1 ? c : c.padEnd(widths[i] + 3)).join("").trimEnd();
  const out = [line(header), ...rows.map(line)];
  const records = manifest.cells.filter((c) => c.record);
  if (records.length) out.push("", "Records", ...records.map((c) => `  ${c.scenario} ${c.variant}: ${join6(dir, c.record)}`));
  const unfinished = manifest.cells.filter((c) => c.exitCode === 2);
  if (unfinished.length) {
    out.push("", "Errors", ...unfinished.map((c) => `  ${c.scenario} ${c.variant}: run did not finish (exit 2), ${c.record ? `details in ${join6(dir, c.record)}` : "details in the stderr above"}`));
  }
  out.push("", `Manifest: ${join6(dir, "suite.json")}`);
  return `${out.join("\n")}
`;
}
async function scan2(dir, trackers, io) {
  let names;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
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
      const parsed = parseScenario(await readFile3(join6(dir, file), "utf8"), trackers.map((t) => t.vendor));
      for (const warning of parsed.warnings) io.stderr(`Warning: ${file}: ${warning}
`);
      loaded.push({ name, parsed, handoff: hasHandoff(parsed) });
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
async function diffPairs(cells, variants2, dir) {
  const diffs = [];
  const [first, ...others] = variants2;
  const recordOf = (scenario, variant) => cells.find((c) => c.scenario === scenario && c.variant === variant)?.record;
  for (const scenario of [...new Set(cells.map((c) => c.scenario))]) {
    const from = recordOf(scenario, first);
    if (!from) continue;
    const a = await readRun(join6(dir, from));
    for (const to of others) {
      const record = recordOf(scenario, to);
      if (!record) continue;
      const result = diffRuns(a, await readRun(join6(dir, record)));
      diffs.push({
        scenario,
        from: first,
        to,
        added: result.added.length,
        removed: result.removed.length,
        changed: result.changed.length,
        flagsChanged: result.flags.filter((f) => !f.allowed).length
      });
    }
  }
  return diffs;
}
function applyVars(scenarios, vars) {
  const used = /* @__PURE__ */ new Set();
  for (const s of scenarios) {
    const declared = Object.entries(vars).filter(([name]) => Object.hasOwn(s.parsed.vars, name));
    for (const [name] of declared) used.add(name);
    s.parsed.vars = { ...s.parsed.vars, ...Object.fromEntries(declared) };
  }
  return Object.keys(vars).filter((name) => !used.has(name));
}
async function suiteCommand(args, io, deps = { run: executeRun }) {
  let trackers = [];
  if (args.trackerList !== void 0) {
    try {
      trackers = await readTrackerList(args.trackerList);
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}
`);
      return 2;
    }
  }
  const scenarios = await scan2(args.dir, trackers, io);
  if (!scenarios) return 2;
  const undeclared = applyVars(scenarios, args.vars);
  if (undeclared.length) {
    io.stderr(`--var ${undeclared.join(", ")} not declared in the vars of any scenario. --var only overrides declared variables.
`);
    return 2;
  }
  const networks = /* @__PURE__ */ new Map();
  for (const s of scenarios) {
    const network = resolveNetwork({ network: args.network, netLog: false }, s.parsed, io);
    if (!network) return 2;
    networks.set(s.name, network);
  }
  const overrides = await readOverrides(args, io);
  if (!overrides) return 2;
  warnTestGtmOrigin(io);
  const id = `suite_${ulid()}`;
  const dir = join6(args.out, id);
  await mkdir2(dir, { recursive: true });
  const startedAt = Date.now();
  const variants2 = args.variants.map((v) => v.name);
  const cells = [];
  const ordered = [...scenarios.filter((s) => !s.handoff), ...scenarios.filter((s) => s.handoff)];
  for (const s of ordered) {
    const seed = args.seed ?? s.parsed.options.seed ?? Math.floor(Math.random() * 2 ** 31);
    for (const variant of variants2) {
      const cell = { scenario: s.name, variant, labels: {} };
      if (s.handoff && !args.withHandoff) {
        cells.push({ ...cell, status: "skipped", exitCode: 0 });
        continue;
      }
      io.stderr(`Running ${s.name} (${variant})
`);
      const outcome = await deps.run(
        {
          parsed: s.parsed,
          scenarioName: s.name,
          network: networks.get(s.name),
          site: args.site,
          out: dir,
          seed,
          headed: false,
          netLog: false,
          autoconsentRules: args.autoconsentRules,
          trackers,
          gtmOverride: overrides.get(variant),
          variant: { name: variant, fileStem: s.name }
        },
        io
      );
      const status = statusOf(outcome);
      const failed = failedOf(outcome, status);
      cells.push({ ...cell, status, exitCode: outcome.code, ...failed && { failed }, ...outcome.path && { record: basename2(outcome.path) } });
    }
  }
  const position = (c) => scenarios.findIndex((s) => s.name === c.scenario) * variants2.length + variants2.indexOf(c.variant);
  cells.sort((a, b) => position(a) - position(b));
  const manifest = {
    suiteSchemaVersion: 1,
    id,
    startedAt,
    site: new URL(args.site).origin,
    variants: variants2,
    cells,
    diffs: await diffPairs(cells, variants2, dir),
    exitCode: suiteExitCode(cells)
  };
  await writeFile2(join6(dir, "suite.json"), `${JSON.stringify(manifest, null, 2)}
`);
  io.stdout(args.json ? `${JSON.stringify(manifest, null, 2)}
` : formatSuiteTable(manifest, dir));
  return manifest.exitCode;
}

// packages/cli/src/report/suite.ts
var recordKey = (scenario, variant) => JSON.stringify([scenario, variant]);
function hostOf4(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
function diffView(scenario, from, to, a, b) {
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
  const scenarios = names.map((name) => ({
    name,
    cells: manifest.variants.flatMap((variant) => {
      const cell = manifest.cells.find((c) => c.scenario === name && c.variant === variant);
      if (!cell) return [];
      const loaded = records.get(recordKey(name, variant));
      if (!loaded && cell.status !== "skipped") warnings.push(`${name} (${variant}): no record, so the run is not in this report`);
      if (loaded?.truncatedAtLine) warnings.push(`${name} (${variant}): record is truncated at line ${loaded.truncatedAtLine}, so later records are missing from this report`);
      return [{ variant, status: cell.status, exitCode: cell.exitCode, ...cell.failed && { failed: cell.failed }, model: loaded && buildReportModel(loaded) }];
    })
  }));
  const [first, ...others] = manifest.variants;
  const diffs = [];
  for (const name of names) {
    const a = records.get(recordKey(name, first));
    for (const to of others) {
      const b = records.get(recordKey(name, to));
      if (a && b) diffs.push(diffView(name, first, to, a, b));
    }
  }
  return {
    header: {
      id: manifest.id,
      startedAt: new Date(manifest.startedAt).toISOString(),
      host: hostOf4(manifest.site),
      variants: manifest.variants,
      exitCode: manifest.exitCode
    },
    warnings,
    scenarios,
    diffs
  };
}
function isManifest(value) {
  if (typeof value !== "object" || value === null) return false;
  const m = value;
  return m.suiteSchemaVersion === 1 && typeof m.id === "string" && typeof m.startedAt === "number" && Number.isFinite(m.startedAt) && typeof m.site === "string" && typeof m.exitCode === "number" && Array.isArray(m.variants) && m.variants.every((v) => typeof v === "string") && Array.isArray(m.cells) && m.cells.every((c) => {
    const cell = c;
    return typeof cell === "object" && cell !== null && typeof cell.scenario === "string" && typeof cell.variant === "string" && typeof cell.status === "string" && typeof cell.exitCode === "number";
  });
}
async function loadSuite(dir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile4(join7(dir, "suite.json"), "utf8"));
  } catch {
    throw new Error(`${dir} has no readable suite.json. report reads one .jsonl run record or a suite directory.`);
  }
  if (!isManifest(manifest)) throw new Error(`${join7(dir, "suite.json")} is not a suite manifest`);
  const records = /* @__PURE__ */ new Map();
  for (const cell of manifest.cells) {
    const name = cell.record;
    if (typeof name !== "string" || name !== basename3(name)) continue;
    records.set(recordKey(cell.scenario, cell.variant), await readRun(join7(dir, name)).catch(() => void 0));
  }
  return { manifest, records };
}
function diffTable(d) {
  const heading = `<h3>${escapeHtml(d.scenario)}: ${escapeHtml(d.from)} to ${escapeHtml(d.to)}</h3>`;
  const warnings = d.warnings.map((w) => `<p class="warn-box">${escapeHtml(w)}</p>`).join("");
  if (d.rows.length === 0 && d.flags.length === 0) return `${heading}${warnings}<p class="empty">No differences.</p>`;
  const flags2 = d.flags.length ? `<ul class="fields">${d.flags.map((f) => `<li>flag ${escapeHtml(flagChangeLabel(f))}</li>`).join("")}</ul>` : "";
  const body = d.rows.map((r) => `<tr><td>${escapeHtml(r.epoch)}</td><td>${escapeHtml(r.vendor)}</td><td>${escapeHtml(r.event)}</td><td>${r.added}</td><td>${r.removed}</td><td>${r.changed}</td><td>${r.countMismatches}</td></tr>`).join("");
  const table = d.rows.length ? `<div class="scroll"><table class="diff"><thead><tr><th scope="col">Epoch</th><th scope="col">Vendor</th><th scope="col">Event</th><th scope="col">Added</th><th scope="col">Removed</th><th scope="col">Changed</th><th scope="col">Count differs</th></tr></thead><tbody>${body}</tbody></table></div>` : "";
  return `${heading}${warnings}${table}${flags2}`;
}
function verdicts(model) {
  const items = model.header.variants.map((variant) => {
    const findings = emptyFindings();
    let unfinished = 0;
    let noRecord = 0;
    for (const s of model.scenarios) {
      const cell = s.cells.find((c) => c.variant === variant);
      if (cell?.status === "error") unfinished++;
      else if (cell?.model) addFindings(findings, cell.model);
      else if (cell?.status === "fail" || cell?.status === "warn") noRecord++;
    }
    const sentence = findingsSentence(findings);
    const base2 = noRecord && sentence === "no leaks" ? "leaks not known" : sentence;
    const tail = (unfinished ? `, ${unfinished} run${unfinished === 1 ? "" : "s"} did not finish` : "") + (noRecord ? `, ${noRecord} run${noRecord === 1 ? " has" : "s have"} no record` : "");
    return `<li><strong>${escapeHtml(variant)}:</strong> ${escapeHtml(base2 + tail)}</li>`;
  });
  return `<ul class="verdicts">${items.join("")}</ul>`;
}
function overview(model) {
  const head = model.header.variants.map((v) => `<th scope="col">${escapeHtml(v)}</th>`).join("");
  const rows = model.scenarios.map((s) => {
    const cells = model.header.variants.map((v) => {
      const cell = s.cells.find((c) => c.variant === v);
      return `<td>${cell ? escapeHtml(cellText({ status: cell.status, exitCode: cell.exitCode, failed: cell.failed })) : ""}</td>`;
    });
    return `<tr><th scope="row">${escapeHtml(s.name)}</th>${cells.join("")}</tr>`;
  }).join("");
  return `<div class="scroll"><table><thead><tr><th scope="col">Scenario</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function renderSuiteReport(model) {
  const h = model.header;
  const warnings = model.warnings.map((w) => `<p class="warn-box">Warning: ${escapeHtml(w)}</p>`).join("");
  const scenarios = model.scenarios.map((s) => {
    const cells = s.cells.map((c) => {
      const title = `<h3>${escapeHtml(s.name)} (${escapeHtml(c.variant)}): ${escapeHtml(c.status.toUpperCase())}</h3>`;
      if (!c.model) return `${title}<p class="empty">${c.status === "skipped" ? "Skipped." : "No record to show."}</p>`;
      return `${title}${definitionList(runHeader(c.model.header))}${runSections(c.model, "h4")}`;
    }).join("");
    return `<section><h2>${escapeHtml(s.name)}</h2>${cells}</section>`;
  }).join("");
  const diffs = model.diffs.length ? model.diffs.map(diffTable).join("") : '<p class="empty">No variant pair has two records to compare.</p>';
  return page(`<h1>Suite ${escapeHtml(h.id)}</h1>
${definitionList([
    ["Started", h.startedAt],
    ["Site host", h.host],
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
${diffs}`);
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
  if (resolve(a) === resolve(b)) return true;
  const [sa, sb] = await Promise.all([stat(a).catch(() => void 0), stat(b).catch(() => void 0)]);
  return sa !== void 0 && sb !== void 0 && sa.dev === sb.dev && sa.ino === sb.ino;
}
async function refuseOverwrite(html, inputs) {
  for (const input of inputs) if (await isSameFile(input, html)) throw new Error(`--html must not be ${input}`);
}
async function write(args, html, io) {
  await mkdir3(dirname3(args.html), { recursive: true });
  await writeFile3(args.html, html);
  io.stdout(`Wrote ${args.html}
`);
  return 0;
}
async function reportCommand(args, io) {
  if ((await stat(args.input).catch(() => void 0))?.isDirectory()) {
    const { manifest, records: records2 } = await loadSuite(args.input);
    const recordFiles = manifest.cells.flatMap((c) => typeof c.record === "string" ? [join8(args.input, c.record)] : []);
    await refuseOverwrite(args.html, [join8(args.input, "suite.json"), ...recordFiles]);
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
async function main(argv, io = processIo) {
  try {
    const command = parseCli(argv);
    switch (command.command) {
      case "version":
        io.stdout(`${readVersion()}
`);
        return 0;
      case "help":
        io.stdout(command.topic === "run" ? RUN_USAGE : USAGE);
        return 0;
      case "install-browser":
        return await installBrowser() === 0 ? 0 : 2;
      case "diff":
        return await diffCommand(command, io);
      case "report":
        return await reportCommand(command, io);
      case "suite":
        return await suiteCommand(command, io);
      case "run":
        return await runCommand(command, io);
    }
  } catch (error) {
    if (error instanceof UsageError) io.stderr(`${error.message}

${USAGE}`);
    else io.stderr(`${error instanceof Error ? error.message : String(error)}
`);
    return 2;
  }
}

// packages/cli/src/bin.ts
process.exitCode = await main(process.argv.slice(2));
