import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const external = /^(?:https?:)?\/\//i;

export function findExternalRefs(file: string, content: string): string[] {
  const found: string[] = [];
  if (content.includes('fonts.googleapis.com')) found.push('fonts.googleapis.com');
  if (file.endsWith('.html')) {
    for (const tag of content.match(/<[^>]+>/g) ?? []) {
      for (const m of tag.matchAll(/\ssrc\s*=\s*["']([^"']+)["']/gi)) {
        if (external.test(m[1]!)) found.push(`src ${m[1]}`);
      }
      if (/^<link\b/i.test(tag) && /rel\s*=\s*["']?stylesheet/i.test(tag)) {
        const href = /\shref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
        if (href && external.test(href)) found.push(`stylesheet ${href}`);
      }
    }
  }
  if (file.endsWith('.css') || file.endsWith('.html')) {
    for (const m of content.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      if (external.test(m[1]!)) found.push(`url() ${m[1]}`);
    }
  }
  return found;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(html|css|js)$/.test(entry.name)) yield path;
  }
}

function main(dist: string): number {
  let bad = 0;
  for (const file of walk(dist)) {
    for (const ref of findExternalRefs(file, readFileSync(file, 'utf8'))) {
      console.error(`${file}: ${ref}`);
      bad++;
    }
  }
  if (bad) console.error(`${bad} external reference(s) in ${dist}`);
  return bad ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv[2] ?? '.vitepress/dist'));
