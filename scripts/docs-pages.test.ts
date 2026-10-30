import { describe, expect, it } from 'vitest';
import { unlistedPages } from '../.vitepress/page-guard.ts';

describe('unlistedPages', () => {
  it('accepts the published pages', () => {
    expect(unlistedPages(['README.md', 'docs/cli.md', 'docs/design.md'])).toEqual([]);
  });

  it('reports any other page', () => {
    expect(unlistedPages(['README.md', 'docs/notes.md', 'runs/x/report.md'])).toEqual(['docs/notes.md', 'runs/x/report.md']);
  });
});
