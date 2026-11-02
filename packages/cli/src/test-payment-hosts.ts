import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Scenario } from '@tagreeve/expect';
import { findPaymentProvider } from '@tagreeve/expect';
import { isLoopbackHost, loopbackIsHostedForTests, normalizeHost, providerBlockedOnSite, type TestPayment } from '@tagreeve/recorder';

const FILE_NAME = 'test-payment-hosts.json';

export function testPaymentHostsPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.config');
  return join(base, 'tagreeve', FILE_NAME);
}

export interface AllowlistEntry {
  host: string;
  /** A provider id the user declares to be in test mode on this host. */
  testMode?: string;
}

/** Whether the allowlist file accepts this host and provider pair. */
export function acceptsDeclaration(host: string, testMode: string, loopbackHosted: boolean = loopbackIsHostedForTests()): boolean {
  const loopback = isLoopbackHost(normalizeHost(host));
  if (testMode === 'fixture') return loopback && loopbackHosted;
  return !loopback;
}

function entryError(path: string, index: number, reason: string): Error {
  return new Error(`${path}: entry ${index} ${reason}.`);
}

function parseEntry(path: string, entry: unknown, index: number, loopbackHosted: boolean): AllowlistEntry {
  if (typeof entry === 'string') return { host: normalizeHost(entry) };
  const keys = entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.keys(entry) : [];
  const { host, testMode } = (entry ?? {}) as Record<string, unknown>;
  if (typeof host !== 'string' || typeof testMode !== 'string' || keys.length !== 2) {
    throw entryError(path, index, 'must be a host name or an object with only "host" and "testMode"');
  }
  const normalized = normalizeHost(host);
  if (!findPaymentProvider(testMode)) throw entryError(path, index, 'names a testMode that is not a payment provider');
  if (!acceptsDeclaration(normalized, testMode, loopbackHosted)) {
    throw entryError(path, index, 'declares a loopback host or the fixture provider, which only tests may do');
  }
  return { host: normalized, testMode };
}

/** The entries of the user-level allowlist. Throws a message that names the file and an entry index, never other content. */
export async function readTestPaymentHosts(path: string, loopbackHosted: boolean = loopbackIsHostedForTests()): Promise<AllowlistEntry[]> {
  let mode: number;
  try {
    mode = (await stat(path)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${path} does not exist. Create it with a JSON array of the hosts that may run test payments.`);
    throw new Error(`Cannot read ${path}.`);
  }
  if (process.platform !== 'win32' && (mode & 0o022) !== 0) {
    throw new Error(`${path} must not be writable by group or others. Run: chmod go-w ${path}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  if (!Array.isArray(json)) throw new Error(`${path} must be a JSON array of host names or { "host", "testMode" } objects.`);
  return json.map((entry, index) => parseEntry(path, entry, index, loopbackHosted));
}

export type TestPaymentGates = { ok: true; testPayment?: TestPayment } | { ok: false; error: string };

/**
 * Gates 1 and 2 for a scenario with a `payment` step: `--allow-test-payment` names the exact `--site` host, and that host is in the allowlist file.
 * A scenario without a payment step passes and needs neither. Gate 3 runs at the step.
 */
export async function checkTestPaymentGates(
  parsed: Scenario,
  site: string,
  allow: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TestPaymentGates> {
  const payments = parsed.steps.filter((s) => s.kind === 'payment');
  if (payments.length === 0) return { ok: true };
  const siteHost = normalizeHost(new URL(site).hostname);
  for (const step of payments) {
    const blocked = step.kind === 'payment' ? providerBlockedOnSite(step.value.provider, siteHost) : undefined;
    if (blocked) return { ok: false, error: `${blocked}.` };
  }
  if (allow === undefined) {
    return { ok: false, error: `The scenario has a payment step. Test payments need --allow-test-payment ${siteHost}.` };
  }
  if (normalizeHost(allow) !== siteHost) {
    return { ok: false, error: `--allow-test-payment must name the --site host (${siteHost}).` };
  }
  let entries: AllowlistEntry[];
  try {
    entries = await readTestPaymentHosts(testPaymentHostsPath(env));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const own = entries.filter((e) => e.host === siteHost);
  if (own.length === 0) {
    return { ok: false, error: `${siteHost} is not in ${testPaymentHostsPath(env)}.` };
  }
  const declaredProviders = own.flatMap((e) => (e.testMode ? [e.testMode] : []));
  return { ok: true, testPayment: { host: siteHost, ...(declaredProviders.length && { declaredProviders }) } };
}
