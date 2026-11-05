import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { root } from './docs-test-helpers.ts';

const design = readFileSync(join(root, 'docs/design.md'), 'utf8');

function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  expect(start, `${from} exists`).toBeGreaterThanOrEqual(0);
  expect(end, `${to} follows ${from}`).toBeGreaterThan(start);
  return text.slice(start, end);
}

const current = design.slice(0, design.indexOf('### 15.1 ')) + design.slice(design.indexOf('### 15.6 '));
const section8 = between(design, '## 8. GTM', '## 9. Collector and run store');

describe('design: the reporters, no sink, no preview header', () => {
  test('the history sections exist, so the checks below skip only them', () => {
    expect(design.indexOf('### 15.1 ')).toBeGreaterThan(0);
    expect(design.indexOf('### 15.1 ')).toBeLessThan(design.indexOf('### 15.6 '));
  });

  test('section 8 plans no preview header and no run token', () => {
    expect(section8).not.toMatch(/run token/i);
    expect(section8).not.toMatch(/hmac/i);
    expect(section8).toMatch(/header is not planned/);
  });

  test('8.3 names the recording proxy', () => {
    expect(between(design, '### 8.3 ', '### 8.4 ')).toMatch(/recording proxy/);
  });

  test('8.1 names callInWindow and no gallery shipping', () => {
    const s81 = between(design, '### 8.1 ', '### 8.2 ');
    expect(s81).toContain('callInWindow');
    expect(s81).toMatch(/not in the Community Template Gallery/);
    expect(s81).not.toMatch(/published to the Community Template Gallery/);
    expect(s81).not.toMatch(/debug cookie/i);
  });

  test('outside the history sections there is no planned sink, run token or HMAC', () => {
    expect(current).not.toMatch(/run token/i);
    expect(current).not.toMatch(/HMAC/);
    expect(current).not.toMatch(/\bsink\b/i);
  });

  test('the section 3 diagram has no sink node', () => {
    const diagram = between(design, '## 3. Architecture', '## 4. Data model');
    expect(diagram).toContain('```mermaid');
    expect(diagram).not.toMatch(/sink/i);
  });
});
