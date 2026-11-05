import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parseCli } from '../packages/cli/src/args.ts';
import { dist, root } from './docs-test-helpers.ts';

const guide = readFileSync(join(root, 'docs/guide/server-container.md'), 'utf8');

function tagreeveCommands(markdown: string): string[] {
  const commands: string[] = [];
  for (const block of markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    for (const line of block[1]!.replace(/(?<!\\)((?:\\\\)*)\\\n/g, '$1 ').split('\n')) {
      if (line.trim().startsWith('tagreeve ')) commands.push(line.trim());
    }
  }
  return commands;
}

const allowedTarget = /^(~\/|\$HOME\/|\/dev\/null$)/;

export function unsafeFileTargets(markdown: string): string[] {
  const fence = /(```|~~~)[a-z]*\n([\s\S]*?)\1/g;
  const snippets = [...markdown.matchAll(fence)].map((m) => m[2]!);
  const prose = markdown.replace(fence, '');
  snippets.push(...[...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!));
  const targets: string[] = [];
  for (const snippet of snippets) {
    const text = snippet.replace(/\\\n/g, ' ').replace(/\d*>&(?:\d+|-)/g, ' ');
    for (const m of text.matchAll(/(?:^|[^<>])>[>|]?\s*([^\s;|&)<>]+)/g)) targets.push(m[1]!);
    for (const m of text.matchAll(/(?:^|[\s;|(])>&\s*([^\s;|&)<>]+)/g)) targets.push(m[1]!);
    for (const m of text.matchAll(/\btee\s+([^;|&)<>\n]+)/g)) {
      targets.push(...m[1]!.trim().split(/\s+/).filter((w) => !/^-/.test(w)));
    }
    for (const m of text.matchAll(/\bchmod\s+([^;|&)\n]+)/g)) {
      const words = m[1]!.trim().split(/\s+/);
      while (words.length && /^(-[RvcfHLP]+|--[a-z-]+(=.*)?)$/.test(words[0]!)) words.shift();
      targets.push(...words.slice(1));
    }
  }
  return targets.filter((t) => !allowedTarget.test(t) || /(^|\/)\.\.(\/|$)/.test(t));
}

const base64Like = /[A-Za-z0-9+/=_-]{40,}/;
const gtmAuthValue = /gtm_auth=\S/;
const fakeConfig = 'ZmFrZS1jb25maWctZm9yLXRlc3Rz'.repeat(2);
const planted = `${guide}\nconfig ${fakeConfig}\nhttps://example.test/?gtm_auth=FAKEAUTH0001\n`;

test('every tagreeve command in the guide parses', () => {
  const commands = tagreeveCommands(guide);
  expect(commands.length).toBeGreaterThan(1);
  expect(commands.some((c) => c.includes('--server-container-config'))).toBe(true);
  for (const command of commands) {
    const argv = command.split(/\s+/).slice(1);
    expect(() => parseCli(argv), command).not.toThrow();
  }
});

test('the guide holds no long base64 string and no gtm_auth value', () => {
  expect(guide).not.toMatch(base64Like);
  expect(guide).not.toMatch(gtmAuthValue);
});

test('the secret checks fail on a copy with a planted fake config and gtm_auth value', () => {
  expect(planted).toMatch(base64Like);
  expect(planted).toMatch(gtmAuthValue);
});

test('the config file is saved outside the working directory', () => {
  const runs = tagreeveCommands(guide).filter((c) => c.includes('--server-container-config'));
  expect(runs.length).toBeGreaterThan(0);
  for (const run of runs) expect(run).toMatch(/--server-container-config ~\//);
});

test('every redirect and chmod target in the guide is under the home folder', () => {
  expect(unsafeFileTargets(guide)).toEqual([]);
  expect(guide).toContain('> ~/.config/tagreeve/sgtm-workspace-config.txt');
  expect(guide).toContain('> ~/.config/tagreeve/plain.txt');
  expect(guide).toContain('chmod 600 ~/.config/tagreeve/sgtm-config.txt');
});

test.each([
  ['a relative redirect in a fence', '```bash\n(umask 077; cat > sgtm-config.txt)\n```', ['sgtm-config.txt']],
  ['a relative redirect in inline code', 'run `(umask 077; pbpaste > sgtm-config.txt)` now', ['sgtm-config.txt']],
  ['an appending redirect', '```bash\necho x >> out.txt\n```', ['out.txt']],
  ['a relative chmod in inline code', 'run `chmod 600 sgtm-config.txt`', ['sgtm-config.txt']],
  ['a relative chmod in a fence', '```bash\nchmod -R 600 a.txt ~/ok.txt\n```', ['a.txt']],
  ['a relative chmod whose mode starts with a dash', '```bash\nchmod -w sgtm-config.txt\n```', ['sgtm-config.txt']],
  ['a relative encode target', '```bash\n(umask 077; tr -d x < plain.txt | base64 > workspace.txt)\n```', ['workspace.txt']],
  ['a tilde fence', '~~~bash\ncat > sgtm-config.txt\n~~~', ['sgtm-config.txt']],
  ['a redirect with >&', '```bash\ncat >&sgtm-config.txt\n```', ['sgtm-config.txt']],
  ['a chmod after a continuation', '```bash\nchmod \\\n  600 sgtm-config.txt\n```', ['sgtm-config.txt']],
  ['a clobber redirect', '```bash\necho x >| out.txt\n```', ['out.txt']],
  ['a redirect with >& and a space', '```bash\ncat >& sgtm-config.txt\n```', ['sgtm-config.txt']],
  ['an absolute target outside home', '```bash\nbase64 > /tmp/sgtm-workspace-config.txt\n```', ['/tmp/sgtm-workspace-config.txt']],
  ['an absolute repo target', '```bash\ncat > /repo/checkout/sgtm-config.txt\n```', ['/repo/checkout/sgtm-config.txt']],
  ['a tee target', '```bash\npbpaste | tee sgtm-config.txt\n```', ['sgtm-config.txt']],
  ['a tee target after a flag', '```bash\npbpaste | tee -a ~/ok.txt out.txt\n```', ['out.txt']],
  ['a -> redirect', '```bash\ncat -> sgtm-config.txt\n```', ['sgtm-config.txt']],
  ['a /../ escape under home', '```bash\ncat > ~/../work/x\n```', ['~/../work/x']],
  ['a $HOME target with /../', '```bash\ncat > $HOME/a/../../x\n```', ['$HOME/a/../../x']],
  ['home, /dev/null and stderr redirects', '```bash\ncat > ~/a 2>/dev/null\ntee $HOME/b < ~/a > /dev/null\n```', []],
  ['home targets and stderr redirects', '```bash\ncat > ~/a 2>&1\nchmod 600 ~/a\n```', []],
])('the target check catches %s', (_name, markdown, expected) => {
  expect(unsafeFileTargets(markdown)).toEqual(expected);
});

test('the guide explains the workspace preview config with placeholders only', () => {
  expect(guide).toContain('## Test an unpublished workspace');
  expect(guide).toContain('preview environment');
  expect(guide).toContain('quick preview');
  expect(guide.match(/id=GTM-PWTEST1&env=<env id>&auth=<auth>/g)?.length).toBe(2);
  expect(guide).toContain('| Where `<env id>` and `<auth>` come from |');
  expect(guide).toContain('gtm_preview');
  expect(guide).toContain('gtm_auth');
  expect(guide).toContain("tr -d '\\r\\n' < ~/.config/tagreeve/plain.txt | base64 > ~/.config/tagreeve/sgtm-workspace-config.txt");
  expect(guide).toContain('umask 077');
  for (const line of guide.split('\n')) {
    if (/\b(tagreeve|base64|echo|printf)\b/.test(line)) expect(line, line).not.toMatch(/auth=/);
  }
  for (const id of guide.match(/\bGTM-[A-Z0-9]+/g) ?? []) expect(id).toBe('GTM-PWTEST1');
});

test('the sidebar links to the built page', () => {
  const config = readFileSync(join(root, 'site/astro.config.mjs'), 'utf8');
  expect(config).toContain("link: '/docs/guide/server-container'");
  expect(existsSync(join(dist, 'docs/guide/server-container.html'))).toBe(true);
});

test('a continuation joins only after an odd number of backslashes', () => {
  expect(tagreeveCommands('```bash\ntagreeve run \\\n  --site x\n```')).toEqual(['tagreeve run    --site x']);
  expect(tagreeveCommands('```bash\ntagreeve run \\\\\n  --site x\n```')).toEqual(['tagreeve run \\\\']);
});
