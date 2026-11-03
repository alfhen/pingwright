import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const markerLine = /^<!-- [A-Z]\d{2} -->$/;
const versionHeading = /^## (\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

type Version = [number, number, number, number];

// A final release sorts after its own release candidates.
function parseVersion(match: RegExpMatchArray): Version {
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])];
}

function isOlder(a: Version, b: Version): boolean {
  for (let i = 0; i < 4; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return false;
}

export function markerProblems(text: string, packageVersion: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('## '));
  if (start === -1) return ['no ## version heading'];
  const heading = versionHeading.exec(lines[start]!);
  if (!heading) return [`line ${start + 1}: ${lines[start]} is not a version heading`];
  const pkg = versionHeading.exec(`## ${packageVersion}`);
  if (!pkg) return [`package version ${packageVersion} is not a version`];
  if (isOlder(parseVersion(heading), parseVersion(pkg))) {
    return [`line ${start + 1}: ${lines[start]} is older than package version ${packageVersion}`];
  }
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
  const v = '1.0.0';

  it('accepts markers with blank lines around them', () => {
    expect(
      markerProblems('# Changelog\n\n## 1.0.0\n\n<!-- A01 -->\n\n<!-- B01 -->\n\n## 0.9.0\n', v),
    ).toEqual([]);
  });

  it('accepts a section with no markers', () => {
    expect(markerProblems('# Changelog\n\n## 1.0.0\n\n- A change.\n', v)).toEqual([]);
  });

  it('flags a marker glued to the line above', () => {
    const problems = markerProblems('## 1.0.0\n\n- A change.\n<!-- A01 -->\n\n- Next.\n', v);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('before');
  });

  it('flags a marker glued to the line below', () => {
    const problems = markerProblems('## 1.0.0\n\n<!-- A01 -->\n- A change.\n', v);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('after');
  });

  it('flags two markers on neighbouring lines', () => {
    expect(markerProblems('## 1.0.0\n\n<!-- A01 -->\n<!-- B01 -->\n\n## 0.9.0\n', v)).toHaveLength(2);
  });

  it('flags a changelog with no ## heading', () => {
    expect(markerProblems('# Changelog\n\n- A.\n', v)).toHaveLength(1);
  });

  it('reads CRLF line endings', () => {
    expect(markerProblems('## 1.0.0\r\n\r\n<!-- A01 -->\r\n\r\n- A.\r\n', v)).toEqual([]);
    expect(markerProblems('## 1.0.0\r\n\r\n<!-- A01 -->\r\n- A.\r\n', v)).toHaveLength(1);
  });

  it('ignores markers in older sections', () => {
    expect(markerProblems('## 1.0.0\n\n- A.\n\n## 0.9.0\n- B.\n<!-- A01 -->\n- C.\n', v)).toEqual([]);
  });

  describe('first heading', () => {
    it('accepts the package version', () => {
      expect(markerProblems('## 1.0.0-rc.1\n\n<!-- A01 -->\n', '1.0.0-rc.1')).toEqual([]);
    });

    it('accepts a later version', () => {
      expect(markerProblems('## 1.0.0-rc.2\n\n<!-- A01 -->\n', '1.0.0-rc.1')).toEqual([]);
      expect(markerProblems('## 1.0.0\n\n<!-- A01 -->\n', '1.0.0-rc.9')).toEqual([]);
    });

    it('flags an older version', () => {
      const problems = markerProblems('## 1.0.0-rc.1\n\n<!-- A01 -->\n', '1.0.0');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('older');
    });

    it('flags a heading that is not a version', () => {
      const problems = markerProblems('## Unreleased\n\n<!-- A01 -->\n', v);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('not a version heading');
    });

    it('flags a heading with trailing text', () => {
      expect(markerProblems('## 1.0.0 (draft)\n\n<!-- A01 -->\n', v)).toHaveLength(1);
    });
  });
});

describe('CHANGELOG.md', () => {
  const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

  it('starts with a real version section and has blank lines around every marker', () => {
    expect(markerProblems(text, pkg.version)).toEqual([]);
  });
});
