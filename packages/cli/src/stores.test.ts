import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readStores, StoresError } from './stores.ts';

async function write(content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pw-stores-'));
  const path = join(dir, 'stores.json');
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

const store = (extra: Record<string, unknown> = {}) => ({ name: 'a', site: 'https://shop.example.com', ...extra });
const file = (stores: unknown[]) => ({ storesSchemaVersion: 1, stores });

test('reads stores with vars, country and a rules path relative to the file', async () => {
  const path = await write(file([store({ vars: { product: 'tee' }, country: 'SE', autoconsentRules: 'rules/a.json' }), store({ name: 'b-2' })]));
  await mkdir(join(path, '..', 'rules'));
  await writeFile(join(path, '..', 'rules', 'a.json'), '{}');
  const stores = await readStores(path);
  expect(stores).toHaveLength(2);
  expect(stores[0]).toMatchObject({ name: 'a', site: 'https://shop.example.com', vars: { product: 'tee' }, country: 'SE' });
  expect(stores[0]!.autoconsentRules).toBe(join(path, '..', 'rules/a.json'));
  expect(stores[1]).toEqual({ name: 'b-2', site: 'https://shop.example.com', vars: {} });
});

const SECRET = 'pw-secret-value-0001';

test.each<[string, unknown, string]>([
  ['not an object', [1], 'must be a JSON object'],
  ['wrong version', { storesSchemaVersion: 2, stores: [store()] }, 'storesSchemaVersion must be 1'],
  ['no stores', file([]), 'stores must be a list of 1 to 50 stores'],
  ['51 stores', file(Array.from({ length: 51 }, (_, i) => store({ name: `s${i}` }))), 'stores must be a list of 1 to 50 stores'],
  ['store not an object', file([store(), 5]), 'store 1 must be an object'],
  ['bad name', file([store({ name: 'Bad Name' })]), 'store 0 needs a name'],
  ['duplicate name', file([store(), store()]), 'store 1 has a name that another store has'],
  ['site missing', file([{ name: 'a' }]), 'store 0 needs a site'],
  ['site not http', file([store({ site: `ftp://${SECRET}.example.com` })]), 'store 0 needs a site that is an http or https URL'],
  ['site not a URL', file([store({ site: SECRET })]), 'store 0 needs a site that is an http or https URL'],
  ['vars not an object', file([store({ vars: [SECRET] })]), 'store 0 has vars that are not an object'],
  ['var not a string', file([store({ vars: { a: 1 } })]), 'store 0 has a var that is not a string'],
  ['country empty', file([store({ country: ' ' })]), 'store 0 has a country'],
  ['rules not a path', file([store({ autoconsentRules: 7 })]), 'store 0 has autoconsentRules'],
  ['unknown field', file([store({ [SECRET]: 1 })]), 'store 0 has an unknown field'],
])('error: %s names the file and the index, never a value', async (_name, content, message) => {
  const path = await write(content);
  const error = await readStores(path).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(StoresError);
  const text = (error as Error).message;
  expect(text).toContain(path);
  expect(text).toContain(message);
  expect(text).not.toContain(SECRET);
});

test('invalid JSON and a missing file are errors that hold no content', async () => {
  const bad = await write(`{ "storesSchemaVersion": 1, "x": "${SECRET}"`);
  await expect(readStores(bad)).rejects.toThrow(`${bad} is not valid JSON.`);
  await expect(readStores(join(bad, '..', 'nope.json'))).rejects.toThrow(/Cannot read .*: ENOENT/);
});

test('a missing autoconsentRules file is an error that names the file and the store, not the path', async () => {
  const path = await write(file([store(), store({ name: 'b', autoconsentRules: 'missing-rules.json' })]));
  const error = (await readStores(path).catch((e: unknown) => e)) as Error;
  expect(error).toBeInstanceOf(StoresError);
  expect(error.message).toContain(path);
  expect(error.message).toContain('store 1 has autoconsentRules');
  expect(error.message).not.toContain('missing-rules.json');
});

test('an autoconsentRules path that is a directory is an error', async () => {
  const path = await write(file([store({ autoconsentRules: '.' })]));
  await expect(readStores(path)).rejects.toThrow('store 0 has autoconsentRules');
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an autoconsentRules file without read access is an error that does not name the path', async () => {
  const path = await write(file([store({ autoconsentRules: 'denied-rules.json' })]));
  const rules = join(path, '..', 'denied-rules.json');
  await writeFile(rules, '{}');
  await chmod(rules, 0o000);
  const error = (await readStores(path).catch((e: unknown) => e)) as Error;
  expect(error).toBeInstanceOf(StoresError);
  expect(error.message).toContain('store 0 has autoconsentRules');
  expect(error.message).not.toContain('denied-rules.json');
});
