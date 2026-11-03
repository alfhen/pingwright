import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findPages, pageId, pageSource, splitTitle } from './docs-pages.ts';

describe('findPages', () => {
  it('publishes the README and the user docs, and no plan, proposal, goals or release page', () => {
    const pages = findPages(fileURLToPath(new URL('../../../', import.meta.url)));
    expect(pages).toEqual([
      'README.md',
      'docs/cli.md',
      'docs/design.md',
      'docs/guide/first-run.md',
      'docs/guide/project-layout.md',
      'docs/guide/reading-results.md',
      'docs/guide/server-container.md',
      'docs/guide/what-it-checks.md',
      'docs/shopify-checkout.md',
    ]);
  });
});

describe('pageId and pageSource', () => {
  it('map the README to readme and a doc to its path', () => {
    expect(pageId('README.md')).toBe('readme');
    expect(pageId('docs/guide/first-run.md')).toBe('docs/guide/first-run');
    expect(pageSource('readme')).toBe('README.md');
    expect(pageSource('docs/cli')).toBe('docs/cli.md');
  });
});

describe('splitTitle', () => {
  it('takes the first # heading as the title and removes it from the body', () => {
    expect(splitTitle('# Your first run\n\nText.\n\n# Later\n', 'x')).toEqual({ title: 'Your first run', body: '\nText.\n\n# Later\n' });
  });

  it('skips a # line inside a code fence', () => {
    const markdown = '<h1>logo</h1>\n\n```yaml\n# scenarios/a.yml\nstart: /\n```\n';
    expect(splitTitle(markdown, 'README')).toEqual({ title: 'README', body: markdown });
  });

  it('does not take a ## heading', () => {
    expect(splitTitle('## Install\n', 'fallback').title).toBe('fallback');
  });
});
