#!/usr/bin/env node

// packages/cli/src/args.ts
import { parseArgs } from "node:util";
var UsageError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
};
var USAGE = `Usage:
  pingwright run <scenario.yml> --site <url> [options]
  pingwright install-browser
  pingwright --version

Options for run:
  --site <url>               The site to test (required)
  --network stub|live        stub (default) answers tracking requests locally; live sends them
  --out <dir>                Directory for the JSONL record (default: runs)
  --seed <n>                 Seed for the fake identity
  --headed                   Show the browser window
  --autoconsent-rules <file> Extra autoconsent rules (repeatable)
  --var <k=v>                Scenario variable (repeatable)
  --json                     Print a JSON summary on stdout
`;
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
        "autoconsent-rules": { type: "string", multiple: true },
        var: { type: "string", multiple: true },
        json: { type: "boolean" },
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
  if (values.help || command === void 0) return { command: "help" };
  if (command === "install-browser") {
    if (rest.length) throw new UsageError("install-browser takes no arguments");
    return { command: "install-browser" };
  }
  if (command !== "run") throw new UsageError(`Unknown command "${command}"`);
  if (rest.length !== 1) throw new UsageError("run takes one scenario file");
  if (!values.site) throw new UsageError("--site is required");
  try {
    const url = new URL(values.site);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new UsageError(`--site must be an http or https URL, got "${values.site}"`);
  }
  const network = values.network;
  if (network !== void 0 && network !== "stub" && network !== "live") {
    throw new UsageError(`--network must be stub or live, got "${network}"`);
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
  return {
    command: "run",
    scenario: rest[0],
    site: values.site,
    network,
    out: values.out ?? "runs",
    seed,
    headed: values.headed ?? false,
    autoconsentRules: values["autoconsent-rules"] ?? [],
    vars,
    json: values.json ?? false
  };
}

// packages/cli/src/install-browser.ts
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
function installBrowser() {
  const cli = join(dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

// packages/cli/src/run.ts
import { appendFile, readFile } from "node:fs/promises";
import { basename } from "node:path";

// packages/expect/src/scenario.ts
import { LineCounter, parseDocument } from "yaml";
var consentFields = ["analytics", "ads", "adUserData", "adPersonalization"];
var ScenarioError = class extends Error {
  issues;
  constructor(issues) {
    super(issues.join("\n"));
    this.name = "ScenarioError";
    this.issues = issues;
  }
};
var VENDOR_KEYS = /* @__PURE__ */ new Set(["vendor", "event", "page", "transport", "host", "outcome", "count", "before", "in", "after"]);
var GROUP_KEYS = ["consent", "ids", "params", "identity"];
var CONSENT_VALUES = ["granted", "denied", "unknown"];
var OUTCOMES = ["passed", "stubbed", "failed"];
var NETWORKS = ["stub", "server", "live"];
var CONSENT_ANSWERS = ["accept", "reject", "none", "withdraw"];
var STEP_KINDS = ["visit", "click", "fill", "consent", "wait", "addToCart", "evaluate", "checkpoint", "handoff"];
var TOP_KEYS = ["start", "vars", "steps", "expect", "options"];
var OPTION_KEYS = ["network", "seed", "consentTimeout", "graceWindow", "allowUnknownDestination"];
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
  const text = String(value).trim();
  const m = /^(>=|<=|>|<|=)?\s*(\d+)$/.exec(text);
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
function parseScenario(text) {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  const issues = [];
  const lineOf = (path) => {
    for (let n = path.length; n >= 0; n--) {
      const node = doc.getIn(path.slice(0, n), true);
      if (node?.range) return lines.linePos(node.range[0] ?? 0).line;
    }
    return 1;
  };
  const fail = (path, message) => {
    const where = path.reduce((acc, p) => typeof p === "number" ? `${acc}[${p}]` : acc ? `${acc}.${p}` : p, "");
    issues.push(`line ${lineOf(path)}: ${where ? `${where}: ` : ""}${message}`);
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
  const checkVars = (value, path) => {
    for (const m of value.matchAll(/\{(\w+)\}/g)) {
      if (!(m[1] in vars)) fail(path, `uses {${m[1]}} but vars has no "${m[1]}"`);
    }
  };
  if (start) checkVars(start, ["start"]);
  const steps = [];
  const stepLabels = /* @__PURE__ */ new Set(["start"]);
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
    const add = (body) => {
      if (stepLabels.has(label)) fail([...path, ...item.label === void 0 ? [kind] : ["label"]], `duplicate step label "${label}"`);
      stepLabels.add(label);
      steps.push({ ...body, label, line });
    };
    const str2 = () => {
      if (typeof value === "string" && value) return value;
      fail([...path, kind], "must be a non-empty string");
      return void 0;
    };
    switch (kind) {
      case "visit": {
        const v = str2();
        if (v !== void 0) {
          checkVars(v, [...path, kind]);
          add({ kind, value: v });
        }
        return;
      }
      case "click":
      case "addToCart":
      case "evaluate":
      case "checkpoint":
      case "handoff": {
        const v = str2();
        if (v !== void 0) add({ kind, value: v });
        return;
      }
      case "fill": {
        if (!isMap(value) || Object.keys(value).length === 0) {
          fail([...path, kind], "must be a mapping of selector to value");
          return;
        }
        const fields = {};
        for (const [sel, v] of Object.entries(value)) {
          if (typeof v === "string" && v) fields[sel] = v;
          else fail([...path, kind, sel], "must be a non-empty string");
        }
        add({ kind, value: fields });
        return;
      }
      case "consent": {
        if (typeof value === "string" && CONSENT_ANSWERS.includes(value)) add({ kind, value });
        else fail([...path, kind], `must be one of ${CONSENT_ANSWERS.join(", ")}`);
        return;
      }
      case "wait": {
        const ms = parseDuration(value);
        if (ms !== void 0) add({ kind, value: ms });
        else if (typeof value === "string" && value.trim()) add({ kind, value: { selector: value } });
        else fail([...path, kind], "must be a duration such as 4s, 500ms or 2m, or a selector");
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
        const list = raw.expect[kind];
        if (list === void 0) continue;
        if (!Array.isArray(list)) fail(["expect", kind], "must be a list");
        else
          list.forEach((entry, i) => {
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
        for (const [sub, sv] of Object.entries(v)) flat[`${k}.${sub}`] = sv;
      } else flat[k] = v;
    }
    const filter = { consent: {}, ids: {}, params: {} };
    const rule = { kind, description: JSON.stringify(entry), line: lineOf(path), filter };
    const list = (key, v, allowed) => {
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
        if (v === true) filter.ids[k.slice(4)] = "present";
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
      } else if (k === "vendor" || k === "event" || k === "transport" || k === "host") {
        const l = list(k, v);
        if (l) filter[k] = l;
      } else if (k === "outcome") {
        const l = list(k, v, OUTCOMES);
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
        else fail(p, "must be epoch(undecided), epoch(granted), epoch(denied) or epoch(<field>=<value>)");
      } else if (k === "after") {
        if (typeof v !== "string" || !v) fail(p, "must be a step label");
        else if (!stepLabels.has(v)) fail(p, `"${v}" is not a step label, defined labels: ${[...stepLabels].join(", ") || "none"}`);
        else rule.after = v;
      } else if (VENDOR_KEYS.has(k)) {
        fail(p, "invalid");
      } else {
        fail(p, "unknown key");
      }
    }
    if (rule.before && rule.inEpoch) fail(path, "use either before or in, not both");
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
          if (typeof v === "boolean") options.allowUnknownDestination = v;
          else fail(p, "must be true or false");
        } else {
          const ms = parseDuration(v);
          if (ms === void 0) fail(p, "must be a duration such as 4s or 500ms");
          else if (k === "consentTimeout") options.consentTimeout = ms;
          else options.graceWindow = ms;
        }
      }
  }
  if (issues.length) throw new ScenarioError(issues);
  return { start, vars, steps, expect: expectOut, options };
}
function validEpochSelector(selector) {
  if (["undecided", "granted", "denied"].includes(selector)) return true;
  const m = /^(\w+)=(\w+)$/.exec(selector);
  return !!m && consentFields.includes(m[1]) && CONSENT_VALUES.includes(m[2]);
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
var ID_PATTERN = new RegExp(`^[a-z]{3}_[${ALPHABET}]{26}$`);

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

// packages/core/src/store.ts
import { createReadStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join as join2 } from "node:path";
import { createInterface } from "node:readline";
function runFilePath(runsDir, runId) {
  return join2(runsDir, `${runId}.jsonl`);
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
    await writer.append(run);
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
async function readRun(path) {
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  let out;
  let lineNo = 0;
  for await (const line of lines) {
    lineNo++;
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`${path}:${lineNo}: invalid JSON`);
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new Error(`${path}:${lineNo}: record must be a JSON object`);
    }
    if (!out) {
      if (record.type !== "run") throw new Error(`${path}:${lineNo}: first record must be a run`);
      out = emptyRecords(record);
      continue;
    }
    switch (record.type) {
      case "run":
        throw new Error(`${path}:${lineNo}: more than one run record`);
      case "step":
        out.steps.push(record);
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
        out.consentEpochs.push(record);
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
  if (!out) throw new Error(`${path}: empty run file`);
  return out;
}

// packages/core/src/identity.ts
import { createHash } from "node:crypto";
import { Faker, base, en, en_US } from "@faker-js/faker";
function createIdentity(seed, options = {}) {
  const faker = new Faker({ locale: [en_US, en, base] });
  faker.seed(seed);
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const tag = faker.string.alphanumeric({ length: 4, casing: "lower" });
  const area = faker.number.int({ min: 201, max: 989 });
  const line = faker.number.int({ min: 100, max: 199 });
  return {
    seed,
    firstName,
    lastName,
    email: `${firstName}.${lastName}.${tag}@example.com`.toLowerCase().replace(/[^a-z0-9.@]/g, ""),
    phone: `+1${area}5550${line}`,
    address1: faker.location.streetAddress(),
    city: faker.location.city(),
    zip: faker.location.zipCode("#####"),
    country: options.country ?? "US"
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
var EMAIL = /[a-z0-9._+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
var FILE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|css|js|mjs|json|map|woff2?|ttf|otf|eot|wasm|webm)$/i;
var PHONE = /(?<![A-Za-z0-9+])\+\d{8,15}(?!\d)|\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g;
var HASH = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi;
var BASE64_TOKEN = /[A-Za-z0-9+/_-]{12,}={0,2}/g;
function tryUrlDecode(text) {
  if (!/%[0-9a-f]{2}/i.test(text)) return void 0;
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}
var utf8 = new TextDecoder("utf-8", { fatal: true });
function tryBase64Decode(token) {
  const bytes = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (bytes.length < 8) return void 0;
  let text;
  try {
    text = utf8.decode(bytes);
  } catch {
    return void 0;
  }
  let control = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13 || c === 127 || c === 65533) control++;
  }
  return control / text.length <= 0.05 ? text : void 0;
}
function hasUrlEscapes(text) {
  const decoded = tryUrlDecode(text);
  return decoded !== void 0 && decoded !== text;
}
function* base64Candidates(text) {
  for (const token of text.match(BASE64_TOKEN) ?? []) {
    yield token;
    if (token.includes("/")) {
      for (const piece of token.split("/")) if (piece.length >= 12) yield piece;
    }
  }
}
function* variants(text, depth = 0, seen = /* @__PURE__ */ new Set()) {
  if (seen.has(text)) return;
  seen.add(text);
  yield text;
  const url = tryUrlDecode(text);
  if (url !== void 0 && url !== text) yield* variants(url, depth, seen);
  if (depth >= MAX_DEPTH) return;
  for (const token of base64Candidates(text)) {
    const decoded = tryBase64Decode(token);
    if (decoded !== void 0) yield* variants(decoded, depth + 1, seen);
  }
}
function ownValues(identity) {
  const email = normalizeEmail(identity.email);
  const phone = normalizePhone(identity.phone);
  const hashes = /* @__PURE__ */ new Set();
  const fields = [
    email,
    phone,
    phone.slice(1),
    identity.firstName,
    identity.lastName,
    identity.address1,
    identity.city,
    identity.zip,
    identity.country
  ];
  for (const field of fields) {
    const lower = field.trim().toLowerCase();
    hashes.add(sha256(lower).hex);
    hashes.add(sha256(lower.replace(/[^\p{L}\p{N}]/gu, "")).hex);
  }
  return { email, phoneDigits: phone.slice(1), hashes };
}
function scan(text, identity) {
  const own = ownValues(identity);
  const found = /* @__PURE__ */ new Map();
  const add = (kind, value) => {
    const key = `${kind}:${value}`;
    if (!found.has(key)) found.set(key, { kind, value });
  };
  for (const variant of variants(text)) {
    for (const raw of hasUrlEscapes(variant) ? [] : variant.match(EMAIL) ?? []) {
      const m = raw.slice(raw.lastIndexOf("+") + 1);
      if (m.includes("@") && !FILE_EXTENSION.test(m) && normalizeEmail(m) !== own.email) add("email", m);
    }
    for (const m of variant.match(PHONE) ?? []) {
      const digits = m.replace(/\D/g, "");
      if (digits !== own.phoneDigits && digits !== own.phoneDigits.slice(1)) add("phone", m);
    }
    for (const m of variant.match(HASH) ?? []) {
      if (!own.hashes.has(m.toLowerCase())) add("hash", m.toLowerCase());
    }
  }
  return [...found.values()];
}

// packages/decoders/src/decoder.ts
var defaultHitId = () => newId("hit");

// packages/decoders/src/sandbox.ts
var SANDBOX_PATH = /\/(?:web-pixels|wpm)@[^/]+\/(?:[^/]+\/)*sandbox\//;
function isSandboxPageUrl(page) {
  if (!page) return false;
  try {
    return SANDBOX_PATH.test(new URL(page).pathname);
  } catch {
    return SANDBOX_PATH.test(page);
  }
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
  return url?.pathname === "/g/collect" && url.searchParams.get("v") === "2";
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
  if (!gcd) return void 0;
  const letters = gcd.match(/[a-z]/g);
  if (!letters || letters.length < 4) return void 0;
  return letters.slice(0, 4).map((l) => GCD_LETTERS[l] ?? "unknown");
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
    return eventLines(req).map((p) => {
      const ids = {};
      if (p.get("cid")) ids.client_id = true;
      if (p.get("uid")) ids.user_id = true;
      const tid = p.get("tid");
      return {
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
      };
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
function allParams(req) {
  const merged = new URLSearchParams(new URL(req.url).search);
  if (req.method === "POST" && req.postData) {
    for (const [k, v] of new URLSearchParams(req.postData)) merged.set(k, v);
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
    const em = p.get("ud[em]");
    if (em) {
      ids.hashedEmail = true;
      params.hashedEmail = em;
    }
    const ph = p.get("ud[ph]");
    if (ph) {
      ids.hashedPhone = true;
      params.hashedPhone = ph;
    }
    return [
      {
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
      }
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
var googleAds = {
  name: "google-ads",
  match: isAdsPing,
  isCollectionEndpoint: isAdsPing,
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
    return [
      {
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
      }
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
  const text = Buffer.from(bare.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return text.includes("\uFFFD") ? void 0 : text;
}

// packages/decoders/src/sgtm-data-client.ts
function dataRequest(req) {
  try {
    const url = new URL(req.url);
    return url.pathname === "/data" && url.searchParams.has("dtdc") ? url : void 0;
  } catch {
    return void 0;
  }
}
function parseDtdc(value) {
  const text = value ? decodeBase64Text(value) : void 0;
  if (!text) return {};
  try {
    const json = JSON.parse(text);
    return json !== null && typeof json === "object" && !Array.isArray(json) ? json : {};
  } catch {
    return {};
  }
}
var str = (v) => typeof v === "string" && v !== "" ? v : void 0;
var sgtmDataClient = {
  name: "sgtm-data-client",
  match: (req) => dataRequest(req) !== void 0,
  isCollectionEndpoint: (req) => dataRequest(req) !== void 0,
  decode(req, newHitId = defaultHitId) {
    const url = dataRequest(req);
    if (!url) return [];
    const p = url.searchParams;
    const dtdc = parseDtdc(p.get("dtdc"));
    const ids = {};
    if (p.get("cid")) ids.client_id = true;
    if (p.get("uid")) ids.user_id = true;
    const params = {};
    const tid = p.get("tid");
    if (tid) params.tid = tid;
    const hostname = str(dtdc.page_hostname);
    if (hostname) params.page_hostname = hostname;
    return [
      {
        type: "hit",
        id: newHitId(),
        runId: req.runId,
        stepId: req.stepId,
        requestId: req.id,
        t: req.t,
        vendor: "sgtm",
        event: p.get("event") ?? p.get("en") ?? str(dtdc.event_name) ?? null,
        consent: decodeGa4Consent(p),
        ids,
        page: str(dtdc.page_location) ?? null,
        transport: req.resourceType === "ping" ? "beacon" : req.resourceType,
        params
      }
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
      return real !== void 0 && inner.some((d) => d.match(real));
    },
    isCollectionEndpoint(req) {
      const real = unwrapStapeLoader(req);
      return real !== void 0 && inner.some((d) => d.isCollectionEndpoint(real));
    },
    decode(req, newHitId = defaultHitId) {
      const real = unwrapStapeLoader(req);
      if (!real) return [];
      return inner.filter((d) => d.match(real)).flatMap((d) => d.decode(real, newHitId)).map((hit) => ({ ...hit, transport: `${hit.transport} via ${STAPE_LOADER_TRANSPORT}` }));
    }
  };
}

// packages/decoders/src/registry.ts
var direct = [ga4, meta, googleAds, sgtmDataClient];
var decoders = [...direct, createStapeCustomLoader(direct)];
function decodeRequest(req, newHitId) {
  return decoders.filter((d) => d.match(req)).flatMap((d) => d.decode(req, newHitId));
}
function isCollectionEndpoint(req) {
  return decoders.some((d) => d.isCollectionEndpoint(req));
}

// packages/expect/src/evaluate.ts
var DEFAULT_GRACE_MS = 50;
var GOOGLE_VENDORS = /* @__PURE__ */ new Set(["ga4", "google-ads"]);
function evaluate(records, scenario, options = {}) {
  const runRecord = records.find((r) => r.type === "run");
  const runId = runRecord?.id ?? records.find((r) => "runId" in r)?.runId ?? newId("run");
  const ctx = {
    hits: records.filter((r) => r.type === "hit"),
    requests: new Map(records.filter((r) => r.type === "request").map((r) => [r.id, r])),
    epochs: records.filter((r) => r.type === "consentEpoch").sort((a, b) => a.startT - b.startT),
    steps: records.filter((r) => r.type === "step"),
    grace: options.graceWindowMs ?? scenario.options.graceWindow ?? DEFAULT_GRACE_MS,
    identity: options.identity ?? identityOf(runRecord)
  };
  const results = [];
  const add = (expectation, pass, evidence, message) => results.push({ type: "result", id: newId("result"), runId, expectation, pass, evidence, message });
  for (const kind of ["mustNot", "must"])
    for (const rule of scenario.expect[kind]) {
      const { pass, evidence, message } = evaluateRule(rule, ctx);
      add(`${kind}: ${rule.description}`, pass, evidence, message);
    }
  builtInChecks(records, scenario, ctx, add);
  return results;
}
function evaluateRule(rule, ctx) {
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
  const where = narrowed.length ? ` ${narrowed.join(", ")}` : "";
  const ids = hits.map((h) => h.id);
  const found = `found ${hits.length} matching hit${hits.length === 1 ? "" : "s"}${narrowed.length ? ` (${total} before narrowing)` : ""}`;
  if (rule.kind === "mustNot") {
    return {
      pass: hits.length === 0,
      evidence: ids,
      message: hits.length === 0 ? `Expected no matching hits${where}, found none.` : `Expected no matching hits${where}, ${found}.`
    };
  }
  const count = rule.count ?? { op: ">=", n: 1 };
  let pass = countHolds(count, hits.length);
  let message = `Expected ${describeCount(count)} matching hits${where}, ${found}.`;
  if (pass && rule.hashesMatch) {
    const check = checkHashes(hits, ctx);
    pass = check.pass;
    message += ` ${check.message}`;
    return { pass, evidence: check.evidence, message };
  }
  return { pass, evidence: ids, message };
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
    const have = hit.ids[name];
    const present = have !== void 0 && have !== false;
    if (want === "present") {
      if (!present) return false;
    } else if (want === "absent") {
      if (present) return false;
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
    if (f.host && !f.host.includes(hostOf(request.url))) return false;
    if (f.outcome && !f.outcome.includes(request.outcome)) return false;
  }
  return true;
}
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
function epochForHit(epochs, t, graceMs = DEFAULT_GRACE_MS) {
  let found;
  epochs.forEach((e, i) => {
    const start = i === 0 ? -Infinity : e.startT - graceMs;
    if (t >= start) found = e;
  });
  return found;
}
function epochOf(hit, ctx) {
  return epochForHit(ctx.epochs, hit.t, ctx.grace);
}
function effectiveConsent(hit, ctx) {
  const epoch = epochOf(hit, ctx);
  const base2 = epoch?.state;
  const own = GOOGLE_VENDORS.has(hit.vendor);
  const pick2 = (f) => {
    const carried = hit.consent[f];
    if (own && carried !== "unknown") return carried;
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
  if ((selector === "granted" || selector === "denied") && !GOOGLE_VENDORS.has(hit.vendor)) {
    return epochOf(hit, ctx)?.label === selector;
  }
  return stateMatches(effectiveConsent(hit, ctx), selector);
}
var EMAIL_PARAM = /^(?:em|ud\[em\]|hashedEmail|sha256_email_address)$/;
var PHONE_PARAM = /^(?:ph|ud\[ph\]|hashedPhone|sha256_phone_number)$/;
function allForms(h) {
  return [h.hex, h.base64, h.base64url];
}
function checkHashes(hits, ctx) {
  const identity = ctx.identity;
  if (!identity) return { pass: false, evidence: [], message: "Cannot check hashes: no run identity was given." };
  const emailHashes = new Set(allForms(hashEmail(identity.email)));
  const phone = hashPhone(identity.phone);
  const phoneHashes = /* @__PURE__ */ new Set([...allForms(phone), ...allForms(sha256(identity.phone.replace(/\D/g, "")))]);
  const plain = /* @__PURE__ */ new Set([identity.email.toLowerCase(), identity.phone.toLowerCase(), identity.phone.replace(/\D/g, "")]);
  const withHash = [];
  const wrong = [];
  const unhashed = [];
  for (const hit of hits) {
    let seen = false;
    let bad = false;
    let raw = false;
    for (const [name, value] of Object.entries(hit.params)) {
      const known = EMAIL_PARAM.test(name) ? emailHashes : PHONE_PARAM.test(name) ? phoneHashes : void 0;
      if (!known || !value) continue;
      seen = true;
      if (known.has(value)) continue;
      bad = true;
      if (plain.has(value.trim().toLowerCase())) raw = true;
    }
    if (seen) withHash.push(hit.id);
    if (bad) wrong.push(hit.id);
    if (raw) unhashed.push(hit.id);
  }
  if (unhashed.length) {
    return { pass: false, evidence: unhashed, message: `Email or phone sent unhashed in ${unhashed.length} hit(s).` };
  }
  if (wrong.length) {
    return { pass: false, evidence: wrong, message: `Hashed email or phone values in ${wrong.length} hit(s) do not match the run identity.` };
  }
  if (!withHash.length) {
    return { pass: false, evidence: [], message: "Expected hashed email or phone values matching the run identity, found no hashed values." };
  }
  return { pass: true, evidence: withHash, message: `Hashed values in ${withHash.length} hit(s) match the run identity.` };
}
function builtInChecks(records, scenario, ctx, add) {
  const flags = records.filter((r) => r.type === "flag");
  const unknown = flags.filter((f) => f.kind === "unknownDestination");
  if (scenario.options.allowUnknownDestination) {
    add("builtin: unknownDestination", true, unknown.map((f) => f.id), `Unknown destinations allowed by the scenario; ${unknown.length} flagged.`);
  } else {
    add(
      "builtin: unknownDestination",
      unknown.length === 0,
      unknown.flatMap((f) => [f.id, ...f.recordIds]),
      unknown.length === 0 ? "Expected no requests to unknown destinations, found none." : `Expected no requests to unknown destinations, found ${unknown.length}: ${unknown.map((f) => f.detail).join("; ")}.`
    );
  }
  const sandboxed = ctx.hits.filter((h) => isSandboxPageUrl(h.page));
  add(
    "builtin: sandboxPageUrl",
    sandboxed.length === 0,
    sandboxed.map((h) => h.id),
    sandboxed.length === 0 ? "Expected no hit to carry a sandbox URL as its page, found none." : `Expected no hit to carry a sandbox URL as its page, found ${sandboxed.length}: ${sandboxed[0].page}.`
  );
  const real = flags.filter((f) => f.kind === "possibleRealData");
  const leaks = ctx.identity ? scanForeignData(ctx, ctx.identity) : [];
  const evidence = [...real.flatMap((f) => [f.id, ...f.recordIds]), ...leaks.flatMap((l) => l.evidence)];
  const problems = [...real.map((f) => f.detail), ...leaks.map((l) => l.detail)];
  if (!ctx.identity && real.length === 0) {
    add(
      "builtin: possibleRealData",
      false,
      [],
      "Cannot check for data that is not from the run identity: no identity was given and no possibleRealData flags exist."
    );
    return;
  }
  add(
    "builtin: possibleRealData",
    problems.length === 0,
    evidence,
    problems.length === 0 ? "Expected no data that is not from the run identity, found none." : `Expected no data that is not from the run identity, found ${problems.length}: ${problems.join("; ")}.`
  );
}
function identityOf(run) {
  const id = run?.identity;
  if (!id) return void 0;
  const fields = ["firstName", "lastName", "email", "phone", "address1", "city", "zip", "country"];
  return fields.every((f) => typeof id[f] === "string") ? id : void 0;
}
var LIBRARY_LOAD = /(?:^|\/)(?:gtag\/js|fbevents\.js|signals\/config\/[^/]*)$/;
function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}
var ASSET_TYPES = /* @__PURE__ */ new Set(["image", "script", "stylesheet", "font", "media"]);
var HASH_FILE_SEGMENT = /\/[0-9a-f]{64}\.[a-z0-9]{1,5}(?=$|\/)/gi;
function scannedUrl(request) {
  if (!ASSET_TYPES.has(request.resourceType)) return request.url;
  try {
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(HASH_FILE_SEGMENT, "/");
    return url.href;
  } catch {
    return request.url;
  }
}
function scanForeignData(ctx, identity) {
  const byRequest = /* @__PURE__ */ new Map();
  const slot = (key, stepId) => {
    let entry = byRequest.get(key);
    if (!entry) byRequest.set(key, entry = { texts: [], hitIds: [], stepId });
    return entry;
  };
  for (const request of ctx.requests.values()) {
    if (request.resourceType === "script" && LIBRARY_LOAD.test(pathOf(request.url))) continue;
    slot(request.id, request.stepId).texts.push(scannedUrl(request), request.postData ?? "");
  }
  for (const hit of ctx.hits) {
    const entry = slot(hit.requestId, hit.stepId);
    entry.hitIds.push(hit.id);
    entry.texts.push(...Object.values(hit.params));
  }
  const out = [];
  for (const [requestId, entry] of byRequest) {
    const found = /* @__PURE__ */ new Map();
    for (const text of entry.texts) for (const m of scan(text, identity)) found.set(`${m.kind}:${m.value}`, m.kind);
    if (found.size === 0) continue;
    const kinds = [...new Set(found.values())].join(", ");
    const step = entry.stepId ? ` in step ${entry.stepId}` : "";
    out.push({
      detail: `request ${requestId}${step} carries ${found.size} ${kinds} value(s) that are not from the run identity`,
      evidence: [requestId, ...entry.hitIds, ...entry.stepId ? [entry.stepId] : []]
    });
  }
  return out;
}

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
var LOADS = /* @__PURE__ */ new Set(["script", "stylesheet", "font", "document"]);
var VENDOR_HOST = /(^|\.)(facebook\.com|facebook\.net|doubleclick\.net|googleadservices\.com|googlesyndication\.com|googletagmanager\.com)$|^(www\.)?google\.com$/;
var COLLECTION_PATH = /^\/(?:tr|pagead\/(?:viewthroughconversion|conversion|1p-[\w-]+)|rmkt|ccm|td)(?:\/|$)/;
var SITE_FUNCTION_PATH = /^\/(?:recaptcha|maps|plugins|dialog|login)(?:\/|$)/;
var LIBRARY_PATH = /(?:^|\/)(?:gtag\/js|fbevents\.js|signals\/config\/[^/]*)$/;
function isKnownVendorCollection(req) {
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return false;
  }
  if (!VENDOR_HOST.test(url.hostname)) return false;
  if (LIBRARY_PATH.test(url.pathname)) return false;
  if (COLLECTION_PATH.test(url.pathname)) return true;
  if (SITE_FUNCTION_PATH.test(url.pathname)) return false;
  return !LOADS.has(req.resourceType);
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
async function routeCollector(context, handler, now) {
  await context.route(`${COLLECTOR_ORIGIN}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postData() ?? "";
      handler()(parseCollectorBody(body), body, now());
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
  const safe = (args) => {
    try {
      const text = JSON.stringify(args, (k, v) => (typeof v === 'function' || v instanceof Node ? undefined : v));
      return text.length > MAX ? JSON.stringify(['[truncated]']) : text;
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
var ALWAYS_DATA = /* @__PURE__ */ new Set(["fetch", "xhr", "ping", "beacon"]);
var DATA_WITH_PAYLOAD = /* @__PURE__ */ new Set(["image", "other"]);
function parse(url) {
  try {
    return new URL(url);
  } catch {
    return void 0;
  }
}
function isUnknownDestination(req, siteHost) {
  const url = parse(req.url);
  if (!url || !/^https?:$/.test(url.protocol) || url.hostname === siteHost) return false;
  if (decoders.some((d) => d.match(req)) || isCollectionEndpoint(req)) return false;
  if (ALWAYS_DATA.has(req.resourceType)) return true;
  return DATA_WITH_PAYLOAD.has(req.resourceType) && (url.search.length > 1 || !!req.postData);
}
function flag(runId, kind, recordIds, detail) {
  return { type: "flag", id: newId("flag"), runId, kind, recordIds, detail };
}
function buildFlags({ runId, siteUrl, requests, hits, routedRequestIds }) {
  const siteHost = parse(siteUrl)?.hostname ?? "";
  const flags = [];
  for (const req of requests) {
    if (isUnknownDestination(req, siteHost)) {
      flags.push(flag(runId, "unknownDestination", [req.id], `${req.method} ${req.url}`));
    }
    if (!routedRequestIds.has(req.id) && isCollectionEndpoint(req)) {
      flags.push(
        flag(runId, "stubBypass", [req.id], `Collection request was not routed, so it was not stubbed: ${req.url}`)
      );
    }
  }
  for (const hit of hits) {
    if (isSandboxPageUrl(hit.page)) {
      flags.push(flag(runId, "sandboxPageUrl", [hit.id, hit.requestId], `${hit.vendor} received ${hit.page} as the page`));
    }
  }
  return flags;
}

// packages/recorder/src/selftest.ts
var SOURCES = { page: "selftest:page", iframe: "selftest:iframe", dedicatedWorker: "selftest:worker" };
var RESEND_MS = 200;
var repeat = (send) => `${send} setInterval(() => { ${send} }, ${RESEND_MS});`;
var beacon = (source) => `navigator.sendBeacon('${COLLECTOR_ORIGIN}/report', JSON.stringify({ source: '${source}' }));`;
var iframeScript = `addEventListener('load', () => setTimeout(() => { ${repeat(beacon(SOURCES.iframe))} }, 100));`;
var workerScript = `const send = () => fetch('${COLLECTOR_ORIGIN}/report', { method: 'POST', mode: 'no-cors', body: JSON.stringify({ source: '${SOURCES.dedicatedWorker}' }) }); send(); setInterval(send, ${RESEND_MS});`;
var selfTestPage = `<!doctype html><meta charset="utf-8"><title>Pingwright self-test</title>
<script>
${repeat(beacon(SOURCES.page))}
new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerScript)}], { type: 'text/javascript' })));
</script>
<iframe sandbox="allow-scripts" srcdoc="${`<script>${iframeScript}</script>`.replaceAll('"', "&quot;")}"></iframe>`;
async function runSelfTest(context, setCollectorHandler, timeoutMs = 1e4) {
  const seen = /* @__PURE__ */ new Set();
  let done = () => void 0;
  const allSeen = new Promise((resolve) => done = resolve);
  setCollectorHandler((parsed) => {
    if (parsed.ok) seen.add(parsed.source);
    if (Object.values(SOURCES).every((s) => seen.has(s))) done();
  });
  const route = (url) => url.origin === SELFTEST_ORIGIN;
  await context.route(route, (r) => r.fulfill({ status: 200, contentType: "text/html", body: selfTestPage }));
  const page = await context.newPage();
  try {
    await page.goto(`${SELFTEST_ORIGIN}/`);
    const timer = setTimeout(done, timeoutMs);
    await allSeen;
    clearTimeout(timer);
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const before = nodeNow();
      const pageTime = await page.evaluate(pageNowExpression);
      samples.push({ before, page: pageTime, after: nodeNow() });
    }
    return {
      coverage: {
        page: seen.has(SOURCES.page),
        iframe: seen.has(SOURCES.iframe),
        dedicatedWorker: seen.has(SOURCES.dedicatedWorker),
        serviceWorker: "chromium-only"
      },
      clockOffset: bestPageOffset(samples)
    };
  } finally {
    await page.close();
    await context.unroute(route);
  }
}

// packages/consent/src/rules.ts
import { existsSync, readFileSync } from "node:fs";
import { createRequire as createRequire2 } from "node:module";
import { dirname as dirname2, join as join3 } from "node:path";
import { fileURLToPath } from "node:url";
var require2 = createRequire2(import.meta.url);
var bundledFixtureRules = fileURLToPath(new URL("./rules/fixture-site.json", import.meta.url));
var fixtureRulesPath = existsSync(bundledFixtureRules) ? bundledFixtureRules : fileURLToPath(new URL("../rules/fixture-site.json", import.meta.url));
function readRuleFile(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
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
  return readFileSync(join3(dirname2(entry), "autoconsent.playwright.js"), "utf8");
}

// packages/consent/src/driver.ts
var ConsentDriver = class {
  #frames = /* @__PURE__ */ new WeakMap();
  #listeners = /* @__PURE__ */ new Set();
  #rules;
  #config;
  #detectWindowMs;
  options;
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
    const rules = [...extra, ...bundledRules()];
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
    const frames = context.pages().flatMap((page) => page.frames());
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
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        this.#listeners.delete(check);
        resolve(value);
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
      const remaining = deadline - Date.now();
      const found = await this.#waitUntil(() => this.#shownFrame(frames), Math.max(0, Math.min(remaining, 1e3)));
      if (found || remaining <= 1e3) return found;
    }
  }
  async answer(target, action, timeoutMs) {
    const frames = () => "frames" in target ? target.frames() : target.pages().flatMap((p) => p.frames());
    const shownFrame = await this.#waitForBanner(frames, timeoutMs);
    if (!shownFrame) {
      const now = Date.now();
      const detected = frames().map((f) => this.#frames.get(f)).filter((s) => s?.detected);
      return {
        detected: detected.length > 0,
        shown: false,
        cmp: detected[0]?.cmp ?? null,
        action,
        result: "banner not shown",
        t: now,
        tEnd: now
      };
    }
    const state = this.#state(shownFrame);
    const base2 = { detected: true, shown: true, cmp: state.cmp, action };
    if (action === "none") return { ...base2, result: "ok", t: state.shownT ?? Date.now(), tEnd: state.shownT ?? Date.now() };
    const before = state.resultSeq;
    const t = Date.now();
    state.shownT = null;
    state.acted = true;
    const message = action === "accept" ? "optIn" : "optOut";
    try {
      await shownFrame.evaluate(`autoconsentReceiveMessage({ type: '${message}' })`);
    } catch {
      return { ...base2, result: "failed", t, tEnd: t };
    }
    const reported = await this.#waitUntil(() => state.resultSeq > before ? state.result : void 0, 5e3);
    return { ...base2, result: reported ? "ok" : "failed", t, tEnd: Date.now() };
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
function consentModeChanges(pushes) {
  const changes = [];
  let state = unknownConsent;
  for (const push of [...pushes].sort((a, b) => a.t - b.t)) {
    if (!Array.isArray(push.args)) continue;
    const [name, command, signals] = push.args;
    if (name !== "consent" || command !== "default" && command !== "update") continue;
    if (typeof signals !== "object" || signals === null) continue;
    const next = { ...state };
    for (const [signal, field] of Object.entries(signalToField)) {
      if (signal in signals) next[field] = toValue(signals[signal]);
    }
    state = next;
    changes.push({ t: push.t, command, state });
  }
  return changes;
}

// packages/consent/src/epochs.ts
var DEFAULT_GRACE_MS2 = 50;
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
  const sorted = [...modeChanges].sort((a, b) => a.t - b.t);
  const updates = sorted.filter((c) => c.command === "update");
  const firstDecisionT = Math.min(updates[0]?.t ?? Infinity, ...banners.map((b) => b.t));
  const initial = sorted.findLast((c) => c.command === "default" && c.t < firstDecisionT)?.state ?? unknownConsent;
  const epochs = [
    { startT: options.startT, endT: null, source: "start", state: initial, label: "undecided" }
  ];
  for (const change of mergeChanges(banners, updates, options.pairWindowMs ?? DEFAULT_PAIR_WINDOW_MS, options.leadWindowMs ?? DEFAULT_GRACE_MS2)) {
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
  return epochs;
}

// packages/recorder/src/recorder.ts
import {
  chromium
} from "playwright";

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
  const enqueue = (method, url, resourceType, body) => {
    const postData = typeof body === 'string' ? body : body == null ? null : '[non-text body]';
    const entry = {
      key: Math.random().toString(36).slice(2) + Date.now().toString(36),
      method,
      url: new URL(String(url), location.href).href,
      resourceType,
      postData,
      frameUrl: location.href,
    };
    save([...load(), entry]);
    deliver(entry);
  };
  const beacon = navigator.sendBeacon;
  navigator.sendBeacon = function (url, data) {
    if (!isLeaving()) return beacon.call(this, url, data);
    enqueue('POST', url, 'ping', data);
    return true;
  };
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const keepalive = (init && init.keepalive) || (input instanceof Request && input.keepalive);
    if (!keepalive || !isLeaving()) return nativeFetch.apply(this, arguments);
    const url = input instanceof Request ? input.url : input;
    const method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
    enqueue(method.toUpperCase(), url, 'fetch', init && init.body);
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  window.${UNLOAD_FLUSH}();
})();`;

// packages/recorder/src/recorder.ts
var PINGWRIGHT_VERSION = "0.1.0-rc.1";
var MAX_POST_DATA = 64 * 1024;
var REDACTED_HEADERS = /* @__PURE__ */ new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);
function redactHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, REDACTED_HEADERS.has(k.toLowerCase()) ? "[redacted]" : v])
  );
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
  constructor(options, browser, context) {
    this.options = options;
    this.browser = browser;
    this.context = context;
  }
  options;
  browser;
  context;
  runId = newId("run");
  coverage;
  consent;
  run;
  clockOffset = 0;
  collectorHandler = () => void 0;
  requests = /* @__PURE__ */ new Map();
  unloadRequests = [];
  unloadKeys = /* @__PURE__ */ new Set();
  routed = /* @__PURE__ */ new Set();
  responses = [];
  dataLayerEvents = [];
  collectorReports = [];
  pending = /* @__PURE__ */ new Set();
  steps = [];
  checkpoints = [];
  bannerEvents = [];
  currentStepId = null;
  closed = false;
  static async launch(options) {
    const browser = await chromium.launch({ channel: "chromium", headless: !options.headed });
    try {
      const context = await browser.newContext({
        userAgent: options.userAgentOverride ?? chromeUserAgent(browser.version()),
        serviceWorkers: options.serviceWorkers ?? "allow"
      });
      const recorder = new _Recorder(options, browser, context);
      await recorder.init();
      return recorder;
    } catch (error) {
      await browser.close();
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
    this.collectorHandler = (parsed, body, t) => this.storeReport(parsed, body, t);
    this.run = {
      type: "run",
      id: this.runId,
      scenario: this.options.scenario ?? "visit",
      site: this.options.site,
      startedAt: nodeNow(),
      pingwrightVersion: PINGWRIGHT_VERSION,
      browser: { name: "chromium", version: this.browser.version() },
      networkMode: this.options.networkMode,
      gtmOverride: null,
      containerVersions: {},
      identity: null,
      coverage: selfTest.coverage
    };
    await context.exposeBinding(DATALAYER_BINDING, (_source, payload) => {
      const event = dataLayerEventFromPayload(payload, this.runId, this.clockOffset);
      if (event) this.dataLayerEvents.push({ ...event, stepId: this.currentStepId });
    });
    await context.addInitScript(dataLayerInitScript);
    this.consent = await installConsent(context, this.options.autoconsent);
    if (this.options.networkMode === "stub") {
      await context.exposeBinding(UNLOAD_BINDING, (_source, payload) => this.recordUnloadSend(payload));
      await context.addInitScript(unloadInitScript);
    }
    context.on("request", (request) => void this.recordFor(request));
    context.on("requestfailed", (request) => {
      const record = this.recordFor(request);
      if (record && record.outcome === "passed") record.outcome = "failed";
    });
    context.on("response", (response) => this.track(this.recordResponse(response)));
  }
  storeReport(parsed, body, t) {
    if (this.closed) return;
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
    const record = {
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
    this.requests.set(request, record);
    return record;
  }
  recordUnloadSend(payload) {
    if (this.closed || this.unloadKeys.has(payload.key)) return;
    this.unloadKeys.add(payload.key);
    const record = {
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
      headers: {},
      postData: payload.postData === null ? null : payload.postData.slice(0, MAX_POST_DATA),
      outcome: "stubbed"
    };
    this.routed.add(record.id);
    this.unloadRequests.push(record);
    this.responses.push({ type: "response", id: newId("response"), requestId: record.id, status: 204, setCookieNames: [] });
  }
  async recordResponse(response) {
    const record = this.recordFor(response.request());
    if (!record) return;
    let setCookieNames = [];
    try {
      setCookieNames = (await response.headerValues("set-cookie")).map((c) => c.split("=")[0].trim());
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
    if (record && this.options.networkMode === "stub" && (isCollectionEndpoint(record) || isKnownVendorCollection(record))) {
      record.outcome = "stubbed";
      const stub = stubResponse(record);
      await route.fulfill({ status: stub.status, headers: stub.headers, body: stub.body });
      return;
    }
    await route.continue();
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
  endStep(step, error) {
    step.endedAt = nodeNow();
    if (error !== void 0) step.error = error;
  }
  /** Keeps a banner action for the run's epochs. Only actions that were carried out count. */
  recordBanner(result) {
    if (result.result !== "ok" || result.action === "none") return;
    this.bannerEvents.push({ t: result.t, tEnd: result.tEnd, action: result.action });
  }
  buildConsentEpochs() {
    const drafts = buildEpochs(this.bannerEvents, consentModeChanges(this.dataLayerEvents), { startT: this.run.startedAt });
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
      consentState: null,
      cookies
    };
    this.checkpoints.push(checkpoint);
    return checkpoint;
  }
  async visit(url) {
    const page = await this.context.newPage();
    await page.goto(url, { waitUntil: "load" });
    return page;
  }
  async wait(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
  async flushUnloadQueues() {
    const script = `window.${UNLOAD_FLUSH}?.()`;
    for (const page of this.context.pages()) {
      await page.evaluate(script).catch(() => void 0);
    }
    await this.wait(50);
  }
  /** Closes the browser, decodes the requests and writes `<outDir>/<runId>.jsonl`. */
  async close() {
    if (this.options.networkMode === "stub") await this.flushUnloadQueues();
    this.closed = true;
    await this.browser.close();
    await Promise.allSettled([...this.pending]);
    const requests = [...this.requests.values(), ...this.unloadRequests];
    const hits = requests.flatMap((r) => decodeRequest(r));
    const flags = buildFlags({
      runId: this.runId,
      siteUrl: this.options.site,
      requests,
      hits,
      routedRequestIds: this.routed
    });
    const writer = await RunWriter.create(this.options.outDir, this.run);
    try {
      for (const record of [
        ...requests,
        ...this.steps,
        ...this.checkpoints,
        ...this.responses,
        ...hits,
        ...this.dataLayerEvents,
        ...this.buildConsentEpochs(),
        ...this.collectorReports,
        ...flags
      ]) {
        await writer.append(record);
      }
    } finally {
      await writer.close();
    }
    return { path: writer.path, records: await readRun(writer.path) };
  }
};
function launchRecorder(options) {
  return Recorder.launch(options);
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

// packages/recorder/src/steps.ts
import { createInterface as createInterface2 } from "node:readline/promises";
var bannerConsentHandler = async (answer, { recorder, page, timeoutMs }) => {
  const result = await recorder.consent.answer(page, answer === "withdraw" ? "reject" : answer, timeoutMs ?? 1e4);
  if (result.result === "banner not shown") throw new Error("banner not shown");
  if (result.result === "failed") throw new Error(`consent ${answer} failed`);
  recorder.recordBanner(result);
};
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
var IDENTITY_FIELDS = ["firstName", "lastName", "email", "phone", "address1", "city", "zip", "country"];
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
async function stdinResolver() {
  const rl = createInterface2({ input: process.stdin, output: process.stdout });
  try {
    await rl.question("Press Enter when done. ");
  } finally {
    rl.close();
  }
}
async function activePage(recorder) {
  const pages = recorder.context.pages();
  return pages[pages.length - 1] ?? recorder.context.newPage();
}
async function fillField(page, selector, value, timeout) {
  const field = page.locator(selector).first();
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
        tag: el.tagName.toLowerCase(),
        host: el.ownerDocument.location.hostname,
        fields: control ? [describe(el), describe(control)] : [describe(el)]
      };
    },
    void 0,
    { timeout }
  );
  if (inspected.fields.some(isSensitiveField) && !isLoopbackHost(inspected.host)) {
    throw new Error(`${selector} is a card or password field. ${HANDOFF_REQUIRED}`);
  }
  if (inspected.tag === "select") await field.selectOption(value, { timeout });
  else await field.fill(value, { timeout });
}
async function runStep(step, recorder, scenario, identity, options, record) {
  const timeout = options.actionTimeoutMs ?? 3e4;
  const page = await activePage(recorder);
  switch (step.kind) {
    case "visit":
      await page.goto(resolveSitePath(step.value, recorder.site, scenario.vars), { waitUntil: "load", timeout });
      return;
    case "click":
    case "addToCart":
      await page.locator(step.value).first().click({ timeout });
      return;
    case "fill":
      for (const [selector, value] of Object.entries(step.value)) await fillField(page, selector, fillValue(value, identity), timeout);
      return;
    case "wait":
      if (typeof step.value === "number") await recorder.wait(step.value);
      else await page.locator(step.value.selector).first().waitFor({ state: "attached", timeout });
      return;
    case "evaluate":
      await page.evaluate(step.value);
      return;
    case "checkpoint":
      await recorder.checkpoint(step.value, record);
      return;
    case "consent":
      await (options.consent ?? bannerConsentHandler)(step.value, { recorder, page, timeoutMs: scenario.options.consentTimeout });
      return;
    case "handoff": {
      const print = options.print ?? ((text) => process.stdout.write(`${text}
`));
      print(`
Handoff: ${step.value}
${HANDOFF_REMINDER}
Recording continues until you are done.`);
      await (options.handoffResolver ?? stdinResolver)(step.value);
      return;
    }
  }
}
async function playScenario(recorder, scenario, options = {}) {
  const identity = createIdentity(options.seed ?? scenario.options.seed ?? Math.floor(Math.random() * 2 ** 31));
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
  const { parsed, ...rest } = options;
  const recorder = await launchRecorder({ ...rest, headed: rest.headed || hasHandoff(parsed) });
  try {
    await playScenario(recorder, parsed, rest);
  } catch (error) {
    const result = await recorder.close().catch(() => void 0);
    if (error instanceof StepError && result) error.run = result;
    throw error;
  }
  return recorder.close();
}

// packages/cli/src/summary.ts
function countHits(hits) {
  const out = {};
  for (const hit of hits) {
    const events = out[hit.vendor] ??= {};
    const name = hit.event ?? "(no event)";
    events[name] = (events[name] ?? 0) + 1;
  }
  return out;
}
function buildSummary(records, results, path) {
  return {
    runId: records.run.id,
    path,
    pass: results.every((r) => r.pass),
    hits: countHits(records.hits),
    epochs: records.consentEpochs.map((e) => ({ label: e.label, startT: e.startT, endT: e.endT })),
    flags: records.flags.map((f) => ({ kind: f.kind, detail: f.detail })),
    results: results.map((r) => ({ expectation: r.expectation, pass: r.pass, message: r.message, evidence: r.evidence }))
  };
}
function exitCodeFor(results) {
  return results.every((r) => r.pass) ? 0 : 1;
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
    lines.push(`  ${e.label} (${e.endT === null ? "to end" : `${e.endT - e.startT} ms`})`);
  }
  lines.push("Flags");
  if (summary.flags.length === 0) lines.push("  none");
  for (const f of summary.flags) lines.push(`  ${f.kind}: ${f.detail}`);
  lines.push("Expectations");
  for (const r of summary.results) {
    lines.push(`  ${r.pass ? "PASS" : "FAIL"} ${r.expectation}`);
    if (!r.pass) {
      if (r.message) lines.push(`       ${r.message}`);
      if (r.evidence.length) lines.push(`       evidence: ${r.evidence.join(", ")}`);
    }
  }
  const failed = summary.results.filter((r) => !r.pass).length;
  lines.push(failed === 0 ? "Result: pass" : `Result: fail (${failed} of ${summary.results.length})`);
  lines.push(`Record: ${summary.path}`);
  return lines.join("\n");
}

// packages/cli/src/run.ts
var MISSING_BROWSER = /Executable doesn't exist|playwright install/i;
function allRecords(records) {
  const { run, ...rest } = records;
  return [run, ...Object.values(rest).flat()];
}
async function runCommand(args, io) {
  let text;
  try {
    text = await readFile(args.scenario, "utf8");
  } catch (error) {
    io.stderr(`Cannot read ${args.scenario}: ${error instanceof Error ? error.message : String(error)}
`);
    return 2;
  }
  let parsed;
  try {
    parsed = parseScenario(text);
  } catch (error) {
    if (!(error instanceof ScenarioError)) throw error;
    io.stderr(`${args.scenario} is not a valid scenario:
${error.issues.map((i) => `  ${i}`).join("\n")}
`);
    return 2;
  }
  parsed.vars = { ...parsed.vars, ...args.vars };
  const networkMode = args.network ?? parsed.options.network ?? "stub";
  if (networkMode === "server") {
    io.stderr('Network mode "server" is not available yet. Use stub or live.\n');
    return 2;
  }
  if (networkMode === "live") io.stderr("Warning: live mode. Hits reach real vendor accounts.\n");
  let records;
  let path;
  try {
    const result = await recordScenario({
      networkMode,
      outDir: args.out,
      site: args.site,
      scenario: basename(args.scenario),
      parsed,
      seed: args.seed,
      headed: args.headed,
      autoconsent: args.autoconsentRules.length ? { ruleFiles: args.autoconsentRules } : void 0,
      userAgentOverride: process.env.PINGWRIGHT_TEST_USER_AGENT || void 0
    });
    records = result.records;
    path = result.path;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (MISSING_BROWSER.test(message)) {
      io.stderr("Chromium is not installed. Run `pingwright install-browser`.\n");
    } else {
      io.stderr(`Run failed: ${message}
`);
      if (error instanceof StepError && error.run) io.stderr(`Record: ${error.run.path}
`);
    }
    return 2;
  }
  const results = evaluate(allRecords(records), parsed);
  await appendFile(path, results.map((r) => JSON.stringify(r) + "\n").join(""));
  const summary = buildSummary(records, results, path);
  io.stdout(args.json ? `${JSON.stringify(summary, null, 2)}
` : `${formatSummary(summary)}
`);
  return exitCodeFor(results);
}

// packages/cli/src/version.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function readVersion() {
  for (const rel of ["../package.json", "../../../package.json"]) {
    const file = fileURLToPath2(new URL(rel, import.meta.url));
    if (!existsSync2(file)) continue;
    const pkg = JSON.parse(readFileSync2(file, "utf8"));
    if (pkg.name === "pingwright" && pkg.version) return pkg.version;
  }
  throw new Error("Cannot find the pingwright package.json");
}

// packages/cli/src/main.ts
var processIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text)
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
        io.stdout(USAGE);
        return 0;
      case "install-browser":
        return await installBrowser() === 0 ? 0 : 2;
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
