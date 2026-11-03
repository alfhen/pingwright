import { defineMdastPlugin } from 'satteri';
import { escapeHtml } from '../lib/html.ts';
import { PROMPT } from '../lib/prompt.ts';

/** site/src/scripts/copy-prompt.ts makes the button copy the text of the `pre`. */
export const getStartedPromptHtml = `<div class="get-started-prompt">
<button type="button" class="get-started-copy" data-copy-from="get-started-text" data-copy-status="get-started-status">Copy get started prompt</button>
<span class="get-started-status" id="get-started-status" role="status" aria-live="polite"></span>
<details class="get-started-details"><summary>Read the prompt</summary><pre class="get-started-text" id="get-started-text">${escapeHtml(PROMPT)}</pre></details>
</div>`;

export const getStartedPrompt = defineMdastPlugin({
  name: 'tagreeve-get-started-prompt',
  html: (node) => (/^<GetStartedPrompt\s*\/>$/.test(node.value.trim()) ? { ...node, value: getStartedPromptHtml } : undefined),
});
