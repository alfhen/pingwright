import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

const requestingRels = new Set(['stylesheet', 'preload', 'modulepreload', 'prefetch', 'icon', 'apple-touch-icon']);
const external = /^(?:https?:)?\/\//i;

export function findExternalRefs(file: string, content: string): string[] {
  const found: string[] = [];
  if (content.includes('fonts.googleapis.com')) found.push('fonts.googleapis.com');
  if (file.endsWith('.html')) {
    for (const tag of content.match(/<[^>]+>/g) ?? []) {
      for (const m of tag.matchAll(/\s(?:src|poster)\s*=\s*["']([^"']+)["']/gi)) {
        if (external.test(m[1]!)) found.push(`src ${m[1]}`);
      }
      for (const m of tag.matchAll(/\ssrcset\s*=\s*["']([^"']+)["']/gi)) {
        for (const candidate of m[1]!.split(',')) {
          const url = candidate.trim().split(/\s+/)[0];
          if (url && external.test(url)) found.push(`srcset ${url}`);
        }
      }
      if (/^<link\b/i.test(tag)) {
        const rel = /\srel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1] ?? '';
        const href = /\shref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
        if (href && external.test(href) && rel.toLowerCase().split(/\s+/).some((r) => requestingRels.has(r))) {
          found.push(`link ${href}`);
        }
      }
    }
  }
  if (file.endsWith('.css') || file.endsWith('.html')) {
    for (const m of content.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      if (external.test(m[1]!)) found.push(`url() ${m[1]}`);
    }
    for (const m of content.matchAll(/@import\s+["']([^"']+)["']/gi)) {
      if (external.test(m[1]!)) found.push(`@import ${m[1]}`);
    }
  }
  return found;
}

const decode = (text: string): string => {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, code: string) =>
    code[0] === '#'
      ? String.fromCodePoint(code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1)))
      : (named[code] ?? whole),
  );
};

/** The tags of a page, without the text of its scripts, which can hold markup that is not on the page. */
const tagsOf = (html: string): string[] => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').match(/<[a-z][^>]*>/gi) ?? [];

function idsOf(html: string): Set<string> {
  const ids = new Set<string>();
  for (const tag of tagsOf(html)) {
    for (const m of tag.matchAll(/\s(?:id|name)\s*=\s*["']([^"']*)["']/gi)) ids.add(decode(m[1]!));
  }
  return ids;
}

/** The URL path a built file is served at: `docs/cli.html` is `/docs/cli`, `index.html` is `/`. */
const servedPath = (file: string): string => `/${file.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '')}`;

/** The built file a URL path resolves to, as the static host and `astro preview` serve them. */
function fileFor(path: string, files: ReadonlySet<string>): string | undefined {
  const bare = path.replace(/^\//, '');
  const candidates = bare === '' || bare.endsWith('/') ? [`${bare}index.html`] : [bare, `${bare}.html`, `${bare}/index.html`];
  return candidates.find((candidate) => files.has(candidate));
}

/**
 * Every internal `href` and `src` on the built pages must point at a built file, and every `#fragment`
 * at an id on the target page. `pages` maps a dist-relative HTML path to its content; `files` holds
 * every dist-relative path.
 */
export function findDeadLinks(pages: ReadonlyMap<string, string>, files: ReadonlySet<string>): string[] {
  const ids = new Map([...pages].map(([file, html]) => [file, idsOf(html)]));
  const dead: string[] = [];
  for (const [file, html] of pages) {
    const base = new URL(servedPath(file), 'http://site.invalid');
    for (const tag of tagsOf(html)) {
      if (!/^<(?:a|link|img|script|source|iframe)\b/i.test(tag)) continue;
      for (const m of tag.matchAll(/\s(?:href|src)\s*=\s*["']([^"']*)["']/gi)) {
        const raw = decode(m[1]!);
        if (!raw || /^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//')) continue;
        const url = new URL(raw, base);
        const target = fileFor(decodeURIComponent(url.pathname), files);
        if (!target) {
          dead.push(`${file}: ${raw} (no such page or file)`);
          continue;
        }
        const fragment = decodeURIComponent(url.hash.slice(1));
        if (fragment && target.endsWith('.html') && !ids.get(target)?.has(fragment)) {
          dead.push(`${file}: ${raw} (no #${fragment} on ${servedPath(target)})`);
        }
      }
    }
  }
  return dead;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

function main(dist: string): number {
  let bad = 0;
  const pages = new Map<string, string>();
  const files = new Set<string>();
  for (const path of walk(dist)) {
    const file = relative(dist, path).split(sep).join(posix.sep);
    files.add(file);
    if (!/\.(html|css|js)$/.test(file)) continue;
    const content = readFileSync(path, 'utf8');
    if (file.endsWith('.html')) pages.set(file, content);
    for (const ref of findExternalRefs(file, content)) {
      console.error(`${path}: ${ref}`);
      bad++;
    }
  }
  if (bad) console.error(`${bad} external reference(s) in ${dist}`);
  const dead = findDeadLinks(pages, files);
  for (const line of dead) console.error(`dead link in ${line}`);
  if (dead.length) console.error(`${dead.length} dead internal link(s) in ${dist}`);
  return bad || dead.length ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv[2] ?? 'site/dist'));
