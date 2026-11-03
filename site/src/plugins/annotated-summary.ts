import { fileURLToPath } from 'node:url';
import { defineMdastPlugin, type MdastPluginEntry } from 'satteri';
import { ANNOT, type Annotation } from '../lib/annotations.ts';
import { escapeHtml } from '../lib/html.ts';

function tone(line: string): string {
  if (line.includes('FAIL')) return 'fail';
  if (line.includes('PASS')) return 'pass';
  return /^[A-Z]/.test(line) ? 'head' : 'body';
}

/** Matches every fence line to its annotation by text. Throws on a line or an annotation that has no match. */
export function annotateLines(source: string, annotations: Annotation[]): { text: string; key: string }[] {
  const lines = source.split('\n');
  const owner = new Map<string, string>();
  for (const annotation of annotations) {
    for (const line of annotation.lines) {
      if (!lines.includes(line)) throw new Error(`Annotation "${annotation.key}" names a line that is not in the fence: ${JSON.stringify(line)}`);
      const other = owner.get(line);
      if (other) throw new Error(`Annotations "${other}" and "${annotation.key}" both name the line ${JSON.stringify(line)}`);
      owner.set(line, annotation.key);
    }
  }
  return lines.map((text) => {
    const key = owner.get(text);
    if (!key) throw new Error(`The fence line ${JSON.stringify(text)} has no annotation`);
    return { text, key };
  });
}

/** site/src/scripts/annotated-summary.ts moves the highlight and the shown note on hover, focus and the arrow keys. */
export function annotatedSummaryHtml(source: string, annotations: Annotation[]): string {
  const lines = annotateLines(source, annotations);
  const active = lines[0]!.key;
  const noteId = (key: string) => `annotated-note-${key}`;
  const lineHtml = lines.map(({ text, key }, index) => {
    const state = key === active ? ' is-active' : '';
    const tabindex = index === 0 ? '0' : '-1';
    return `<span class="annotated-line${state}" data-part="${escapeHtml(key)}" data-tone="${tone(text)}" tabindex="${tabindex}" aria-describedby="${noteId(key)}">${escapeHtml(text)}</span>`;
  });
  const notes = annotations.map(
    ({ key, title, body }) =>
      `<div class="annotated-note" id="${noteId(key)}" data-part="${escapeHtml(key)}"${key === active ? '' : ' hidden'}><span class="annotated-title">${escapeHtml(title)}</span><span class="annotated-body">${escapeHtml(body)}</span></div>`,
  );
  return `<div class="annotated-summary not-content"><div class="annotated-grid"><div class="annotated-code" role="group" aria-label="Sample summary. Move through the lines with the arrow keys to read what each part means.">${lineHtml.join('')}</div><div class="annotated-panel">${notes.join('')}</div></div></div>`;
}

const isAnnotated = (lang: string | null | undefined, meta: string | null | undefined) => lang === 'text' && (meta ?? '').split(/\s+/).includes('annotated');

export function annotatedSummary(annotations: Annotation[] = ANNOT): MdastPluginEntry {
  return defineMdastPlugin({
    name: 'tagreeve-annotated-summary',
    code: (node, context) => {
      if (!isAnnotated(node.lang, node.meta)) return undefined;
      try {
        return { type: 'html', value: annotatedSummaryHtml(node.value, annotations) };
      } catch (error) {
        const file = context.fileURL ? fileURLToPath(context.fileURL) : 'a markdown file';
        throw new Error(`${(error as Error).message}, in the annotated fence of ${file}. Make site/src/lib/annotations.ts match the fence.`);
      }
    },
  });
}
