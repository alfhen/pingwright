import { readdir, stat } from 'node:fs/promises';

export type DefaultSetting = 'scenarios' | 'trackerList' | 'autoconsentRules' | 'stores' | 'baseline';

/** A file or folder used because its flag was not given. `path` is a fixed relative name; a baseline path ends in the scenario's file name. */
export interface DefaultUsed {
  setting: DefaultSetting;
  path: string;
}

export const DEFAULT_SCENARIOS = 'tagreeve/scenarios';
export const DEFAULT_TRACKER_LIST = 'tagreeve/trackers.json';
export const DEFAULT_AUTOCONSENT_DIR = 'tagreeve/autoconsent';
export const DEFAULT_STORES = 'tagreeve/stores.json';
export const DEFAULT_BASELINES = 'tagreeve/baselines';

const SETTING_TEXT: Record<DefaultSetting, string> = {
  scenarios: 'scenario folder',
  trackerList: 'tracker list',
  autoconsentRules: 'autoconsent rules',
  stores: 'stores',
  baseline: 'baseline',
};

function isAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// The message names the fixed relative path only; the OS message would add an absolute one.
function unreadable(path: string, error: unknown): Error {
  const code = (error as { code?: unknown }).code;
  return new Error(`Cannot read ${path}${typeof code === 'string' ? ` (${code})` : ''}. Fix its permissions or remove it.`);
}

async function isKind(path: string, kind: 'file' | 'directory'): Promise<boolean> {
  try {
    const info = await stat(path);
    return kind === 'file' ? info.isFile() : info.isDirectory();
  } catch (error) {
    if (isAbsent(error)) return false;
    throw unreadable(path, error);
  }
}

export async function defaultScenarioDir(used: DefaultUsed[]): Promise<string | undefined> {
  if (!(await isKind(DEFAULT_SCENARIOS, 'directory'))) return undefined;
  used.push({ setting: 'scenarios', path: DEFAULT_SCENARIOS });
  return DEFAULT_SCENARIOS;
}

export async function resolveTrackerList(flag: string | undefined, used: DefaultUsed[]): Promise<string | undefined> {
  if (flag !== undefined) return flag;
  if (!(await isKind(DEFAULT_TRACKER_LIST, 'file'))) return undefined;
  used.push({ setting: 'trackerList', path: DEFAULT_TRACKER_LIST });
  return DEFAULT_TRACKER_LIST;
}

export async function resolveAutoconsentRules(flags: string[] | undefined, used: DefaultUsed[]): Promise<string[]> {
  if (flags?.length) return flags;
  let names: string[];
  try {
    names = (await readdir(DEFAULT_AUTOCONSENT_DIR)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (isAbsent(error)) return [];
    throw unreadable(DEFAULT_AUTOCONSENT_DIR, error);
  }
  const paths: string[] = [];
  for (const name of names) {
    const path = `${DEFAULT_AUTOCONSENT_DIR}/${name}`;
    if (await isKind(path, 'file')) paths.push(path);
  }
  for (const path of paths) used.push({ setting: 'autoconsentRules', path });
  return paths;
}

export async function defaultStores(used: DefaultUsed[]): Promise<string | undefined> {
  if (!(await isKind(DEFAULT_STORES, 'file'))) return undefined;
  used.push({ setting: 'stores', path: DEFAULT_STORES });
  return DEFAULT_STORES;
}

export function formatDefaultsLine(defaults: readonly DefaultUsed[] | undefined): string | undefined {
  if (!defaults?.length) return undefined;
  return `Defaults: ${defaults.map((d) => `${d.path} (${SETTING_TEXT[d.setting]})`).join(', ')}`;
}
