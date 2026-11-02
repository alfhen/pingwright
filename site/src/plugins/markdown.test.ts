import { markdownToHtml } from 'satteri';
import { describe, expect, it } from 'vitest';
import { PROMPT } from '../lib/prompt.ts';
import { getStartedPrompt } from './get-started-prompt.ts';
import { mermaidFences } from './mermaid.ts';
import { repoLinks, rewriteRepoLink } from './repo-links.ts';
import { themedPictures } from './themed-pictures.ts';

const repo = 'https://github.com/alfhen/tagreeve';
const root = new URL('file:///repo/');

const render = async (markdown: string, file: string) =>
  (await markdownToHtml(markdown, { mdastPlugins: [repoLinks({ root, repo }), themedPictures, mermaidFences, getStartedPrompt], fileURL: new URL(file, root) })).html;

describe('rewriteRepoLink', () => {
  it('turns relative .md links into page URLs and keeps the fragment', () => {
    expect(rewriteRepoLink('../cli.md#exit-codes', 'docs/guide/first-run.md', repo)).toBe('/docs/cli#exit-codes');
    expect(rewriteRepoLink('./reading-results.md', 'docs/guide/first-run.md', repo)).toBe('/docs/guide/reading-results');
    expect(rewriteRepoLink('docs/cli.md', 'README.md', repo)).toBe('/docs/cli');
    expect(rewriteRepoLink('../../README.md', 'docs/guide/first-run.md', repo)).toBe('/readme');
  });

  it('sends LICENSE and CHANGELOG.md to GitHub', () => {
    expect(rewriteRepoLink('LICENSE', 'README.md', repo)).toBe(`${repo}/blob/main/LICENSE`);
    expect(rewriteRepoLink('../CHANGELOG.md#030', 'docs/cli.md', repo)).toBe(`${repo}/blob/main/CHANGELOG.md#030`);
  });

  it('leaves outside links, fragments and site paths alone', () => {
    for (const url of ['https://tagreeve.dev/docs/cli', 'mailto:a@example.com', '#install', '/docs/cli']) {
      expect(rewriteRepoLink(url, 'docs/cli.md', repo)).toBe(url);
    }
  });

  it('keeps a site URL for a link to nothing the site publishes, so the dead link check sees it', () => {
    expect(rewriteRepoLink('./does-not-exist', 'docs/guide/first-run.md', repo)).toBe('/docs/guide/does-not-exist');
  });
});

describe('the markdown plugins', () => {
  it('rewrite inline and reference links in a docs page', async () => {
    const html = await render('[cli](../cli.md#exit-codes) and [ref][r].\n\n[r]: ./first-run.md\n', 'docs/guide/x.md');
    expect(html).toContain('<a href="/docs/cli#exit-codes">cli</a>');
    expect(html).toContain('<a href="/docs/guide/first-run">ref</a>');
  });

  it('turn the README picture into a light and a dark image from the site root', async () => {
    const readme =
      '<h1>\n  <picture>\n    <source media="(prefers-color-scheme: dark)" srcset="brand/lockup-dark.svg">\n' +
      '    <img alt="Tagreeve" src="brand/lockup.svg" width="284" height="64">\n  </picture>\n</h1>\n';
    const html = await render(readme, 'README.md');
    expect(html).not.toContain('<picture>');
    expect(html).toContain('<img class="theme-light" alt="Tagreeve" src="/lockup.svg"');
    expect(html).toContain('<img class="theme-dark" alt="Tagreeve" src="/lockup-dark.svg"');
  });

  it('turn a mermaid fence into a diagram element that still shows its source', async () => {
    const html = await render('```mermaid\nflowchart LR\n  A --> B\n```\n', 'docs/design.md');
    expect(html).toContain(`data-code="${encodeURIComponent('flowchart LR\n  A --> B')}"`);
    expect(html).toContain('<pre class="mermaid-source"><code>flowchart LR\n  A --&gt; B</code></pre>');
  });

  it('replace <GetStartedPrompt /> with the copy button and the prompt text', async () => {
    const html = await render('Intro.\n\n<GetStartedPrompt />\n\n## Install\n', 'docs/guide/first-run.md');
    expect(html).not.toContain('<GetStartedPrompt');
    expect(html).toContain('<button type="button" class="get-started-copy" data-copy-from="get-started-text"');
    const text = /<pre class="get-started-text" id="get-started-text">([\s\S]*?)<\/pre>/.exec(html)?.[1];
    expect(text?.replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')).toBe(PROMPT);
  });
});
