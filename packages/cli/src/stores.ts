import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const STORE_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_STORES = 50;
const STORE_KEYS = ['name', 'site', 'vars', 'country', 'autoconsentRules'];

export interface Store {
  name: string;
  site: string;
  vars: Record<string, string>;
  country?: string;
  /** Resolved against the stores file. */
  autoconsentRules?: string;
}

export class StoresError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoresError';
  }
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Errors name the file and the store index, never a value from the file. */
export async function readStores(path: string): Promise<Store[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new StoresError(`Cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new StoresError(`${path} is not valid JSON.`);
  }
  if (!isMap(json)) throw new StoresError(`${path} must be a JSON object with storesSchemaVersion and stores.`);
  if (json.storesSchemaVersion !== 1) throw new StoresError(`${path}: storesSchemaVersion must be 1.`);
  const list = json.stores;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_STORES) {
    throw new StoresError(`${path}: stores must be a list of 1 to ${MAX_STORES} stores.`);
  }
  const names = new Set<string>();
  return list.map((entry, index): Store => {
    const fail = (reason: string): never => {
      throw new StoresError(`${path}: store ${index} ${reason}.`);
    };
    if (!isMap(entry)) return fail('must be an object');
    for (const key of Object.keys(entry)) if (!STORE_KEYS.includes(key)) fail('has an unknown field');
    const { name, site, vars, country, autoconsentRules } = entry;
    if (typeof name !== 'string' || !STORE_NAME.test(name)) return fail(`needs a name that matches ${STORE_NAME.source}`);
    if (names.has(name)) return fail('has a name that another store has');
    names.add(name);
    if (typeof site !== 'string') return fail('needs a site');
    try {
      const protocol = new URL(site).protocol;
      if (protocol !== 'http:' && protocol !== 'https:') throw new Error();
    } catch {
      return fail('needs a site that is an http or https URL');
    }
    const storeVars: Record<string, string> = {};
    if (vars !== undefined) {
      if (!isMap(vars)) return fail('has vars that are not an object');
      for (const [key, value] of Object.entries(vars)) {
        if (typeof value !== 'string') return fail('has a var that is not a string');
        storeVars[key] = value;
      }
    }
    if (country !== undefined && (typeof country !== 'string' || !country.trim())) return fail('has a country that is not a non-empty string');
    if (autoconsentRules !== undefined && (typeof autoconsentRules !== 'string' || !autoconsentRules)) return fail('has autoconsentRules that are not a path');
    return {
      name,
      site,
      vars: storeVars,
      ...(country !== undefined && { country: country as string }),
      ...(autoconsentRules !== undefined && { autoconsentRules: resolve(dirname(path), autoconsentRules as string) }),
    };
  });
}
