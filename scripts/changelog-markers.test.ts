import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const markerLine = /^<!-- [A-Z]\d{2} -->$/;

export function markerProblems(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('## '));
  if (start === -1) return [];
  const next = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  const end = next === -1 ? lines.length : next;
  const problems: string[] = [];
  for (let i = start + 1; i < end; i++) {
    if (!markerLine.test(lines[i]!)) continue;
    const before = lines[i - 1];
    const after = lines[i + 1];
    if (before !== undefined && before.trim() !== '') {
      problems.push(`line ${i + 1}: ${lines[i]} has no blank line before it`);
    }
    if (after !== undefined && after.trim() !== '') {
      problems.push(`line ${i + 1}: ${lines[i]} has no blank line after it`);
    }
  }
  return problems;
}

describe('markerProblems', () => {
  it('accepts markers with blank lines around them', () => {
    expect(
      markerProblems('# Changelog\n\n## 1.0.0\n\n<!-- A01 -->\n\n<!-- B01 -->\n\n## 0.9.0\n'),
    ).toEqual([]);
  });

  it('accepts a section with no markers', () => {
    expect(markerProblems('# Changelog\n\n## 1.0.0\n\n- A change.\n')).toEqual([]);
  });

  it('flags a marker glued to the line above', () => {
    const problems = markerProblems('## 1.0.0\n\n- A change.\n<!-- A01 -->\n\n- Next.\n');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('before');
  });

  it('flags a marker glued to the line below', () => {
    const problems = markerProblems('## 1.0.0\n\n<!-- A01 -->\n- A change.\n');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('after');
  });

  it('flags two markers on neighbouring lines', () => {
    expect(markerProblems('## 1.0.0\n\n<!-- A01 -->\n<!-- B01 -->\n\n## 0.9.0\n')).toHaveLength(2);
  });

  it('ignores markers in older sections', () => {
    expect(markerProblems('## 1.0.0\n\n- A.\n\n## 0.9.0\n- B.\n<!-- A01 -->\n- C.\n')).toEqual([]);
  });
});

describe('CHANGELOG.md', () => {
  it('has blank lines around every marker in the newest section', () => {
    const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    expect(markerProblems(text)).toEqual([]);
  });
});
