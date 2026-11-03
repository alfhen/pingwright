import { readFileSync } from 'node:fs';
import { markdownToHtml } from 'satteri';
import { describe, expect, it } from 'vitest';
import { ANNOT, type Annotation } from '../lib/annotations.ts';
import { annotatedSummary, annotateLines } from './annotated-summary.ts';

const annotations: Annotation[] = [
  { key: 'hits', title: 'Hits', body: 'Each vendor & event.', lines: ['Hits', '  ga4: page_view x3'] },
  { key: 'exp', title: 'Expectations', body: 'Your rules.', lines: ['Expectations', '  FAIL mustNot: <x>', '  PASS builtin: deniedIdentifiers'] },
];
const fence = 'Hits\n  ga4: page_view x3\nExpectations\n  FAIL mustNot: <x>\n  PASS builtin: deniedIdentifiers';

const render = async (markdown: string, list = annotations) =>
  (await markdownToHtml(markdown, { mdastPlugins: [annotatedSummary(list)], fileURL: new URL('file:///repo/docs/guide/x.md') })).html;

describe('the annotated summary plugin', () => {
  it('turns a ```text annotated fence into one element per line, tagged with its part, and a note per part', async () => {
    const html = await render(`\`\`\`text annotated\n${fence}\n\`\`\`\n`);
    expect(html).not.toContain('<pre');
    const lines = [...html.matchAll(/<span class="annotated-line[^"]*" data-part="(\w+)" data-tone="(\w+)" tabindex="(-?\d)"[^>]*>([^<]*)<\/span>/g)];
    expect(lines.map((m) => [m[4], m[1], m[2], m[3]])).toEqual([
      ['Hits', 'hits', 'head', '0'],
      ['  ga4: page_view x3', 'hits', 'body', '-1'],
      ['Expectations', 'exp', 'head', '-1'],
      ['  FAIL mustNot: &lt;x&gt;', 'exp', 'fail', '-1'],
      ['  PASS builtin: deniedIdentifiers', 'exp', 'pass', '-1'],
    ]);
    expect(html).toContain('<div class="annotated-note" id="annotated-note-hits" data-part="hits"><span class="annotated-title">Hits</span><span class="annotated-body">Each vendor &amp; event.</span></div>');
    expect(html).toContain('<div class="annotated-note" id="annotated-note-exp" data-part="exp" hidden>');
  });

  it('leaves plain text fences and fences with another language alone', async () => {
    expect(await render(`\`\`\`text\n${fence}\n\`\`\`\n`)).toContain('<pre><code class="language-text">');
    expect(await render('```bash annotated\nls\n```\n')).toContain('<pre><code class="language-bash">');
  });

  it('fails when an annotation names a line that is not in the fence, and names the line and the file', async () => {
    const changed = [annotations[0]!, { ...annotations[1]!, lines: ['Expectations', '  FAIL mustNot: <y>', '  PASS builtin: deniedIdentifiers'] }];
    await expect(render(`\`\`\`text annotated\n${fence}\n\`\`\`\n`, changed)).rejects.toThrow(
      /Annotation "exp" names a line that is not in the fence: " {2}FAIL mustNot: <y>".*\/repo\/docs\/guide\/x\.md/,
    );
  });

  it('fails when a fence line has no annotation', () => {
    expect(() => annotateLines(`${fence}\nResult: fail (1 of 2)`, annotations)).toThrow('The fence line "Result: fail (1 of 2)" has no annotation');
  });

  it('fails when two annotations name the same line', () => {
    const twice = [...annotations, { key: 'more', title: 'More', body: 'Again.', lines: ['Hits'] }];
    expect(() => annotateLines(fence, twice)).toThrow('Annotations "hits" and "more" both name the line "Hits"');
  });

  it('covers every line of the annotated fence in docs/guide/reading-results.md', () => {
    const markdown = readFileSync(new URL('../../../docs/guide/reading-results.md', import.meta.url), 'utf8');
    const fences = [...markdown.matchAll(/^```text annotated\n([\s\S]*?)\n```$/gm)];
    expect(fences).toHaveLength(1);
    const lines = annotateLines(fences[0]![1]!, ANNOT);
    expect(new Set(lines.map((line) => line.key))).toEqual(new Set(ANNOT.map((annotation) => annotation.key)));
  });
});
