import { describe, expect, it } from 'vitest';
import { findExternalRefs } from './check-docs-dist.ts';

describe('findExternalRefs', () => {
  it('passes local references', () => {
    const html = '<script src="/assets/app.js"></script><link rel="stylesheet" href="/assets/a.css"><a href="https://github.com/x">x</a>';
    expect(findExternalRefs('a.html', html)).toEqual([]);
  });

  it('flags an external script src', () => {
    expect(findExternalRefs('a.html', '<script src="https://cdn.example.com/a.js"></script>')).toHaveLength(1);
  });

  it('flags an external stylesheet href', () => {
    expect(findExternalRefs('a.html', '<link rel="stylesheet" href="//cdn.example.com/a.css">')).toHaveLength(1);
  });

  it('flags an external CSS url()', () => {
    expect(findExternalRefs('a.css', '@font-face{src:url(https://cdn.example.com/f.woff2)}')).toHaveLength(1);
    expect(findExternalRefs('a.css', 'a{background:url(/local.png)}')).toEqual([]);
  });

  it('flags Google Fonts anywhere', () => {
    expect(findExternalRefs('a.js', 'x="fonts.googleapis.com"')).toEqual(['fonts.googleapis.com']);
  });
});
