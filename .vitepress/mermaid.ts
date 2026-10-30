import type MarkdownIt from 'markdown-it';

// The theme loads the mermaid package only when a page has one of these components.
export function mermaidFences(md: MarkdownIt) {
  const fallback = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    if (token.info.trim() === 'mermaid') {
      return `<Mermaid code="${md.utils.escapeHtml(encodeURIComponent(token.content))}" />\n`;
    }
    return fallback(tokens, idx, options, env, self);
  };
}
