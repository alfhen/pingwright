import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Scenario } from '@pingwright/expect';
import { normalizeHost, providerBlockedOnSite, type TestPayment } from '@pingwright/recorder';

const FILE_NAME = 'test-payment-hosts.json';

export function testPaymentHostsPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.config');
  return join(base, 'pingwright', FILE_NAME);
}

/** The exact hosts in the user-level allowlist. Throws a message that names the file, never its other content. */
export async function readTestPaymentHosts(path: string): Promise<string[]> {
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
  if (!Array.isArray(json) || !json.every((h) => typeof h === 'string')) throw new Error(`${path} must be a JSON array of host names.`);
  return json.map(normalizeHost);
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
  let hosts: string[];
  try {
    hosts = await readTestPaymentHosts(testPaymentHostsPath(env));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!hosts.includes(siteHost)) {
    return { ok: false, error: `${siteHost} is not in ${testPaymentHostsPath(env)}.` };
  }
  return { ok: true, testPayment: { host: siteHost } };
}
