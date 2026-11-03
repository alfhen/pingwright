import { defineMdastPlugin } from 'satteri';
import { escapeHtml } from '../lib/html.ts';

/** The source stays readable without JavaScript. site/src/scripts/mermaid.ts draws it. */
export function mermaidHtml(source: string): string {
  return `<div class="mermaid-diagram" data-code="${escapeHtml(encodeURIComponent(source))}"><pre class="mermaid-source"><code>${escapeHtml(source)}</code></pre></div>`;
}

export const mermaidFences = defineMdastPlugin({
  name: 'tagreeve-mermaid',
  code: (node) => (node.lang === 'mermaid' ? { type: 'html', value: mermaidHtml(node.value) } : undefined),
});
