<script setup lang="ts">
import { ref } from 'vue';

const prompt = `Set up Pingwright to test the tracking and the cookie consent on my website.

Pingwright is a command-line tool. It opens my site in a real browser, acts as a visitor, records every tracking request and checks the requests against rules that I write. The docs are at https://pingwright.dev.

1. Install it with \`npm i -g pingwright@next\`, then run \`pingwright install-browser\`. Check that \`pingwright --version\` works.
2. Read https://pingwright.dev/docs/guide/first-run and https://pingwright.dev/docs/cli before you write a scenario. Use \`pingwright run --help\` for the flags. Do not guess flags or step names.
3. Ask me for the address of my site and the tracking tools it uses, for example GA4, Google Ads, Meta or Pinterest.
4. Write three scenarios in a \`pingwright/\` folder: the visitor ignores the cookie banner (\`consent: none\`), accepts it (\`consent: accept\`) and rejects it (\`consent: reject\`). Each scenario opens the home page and one product or content page. Add rules: no Meta or Google Ads hit before consent, no marketing hit after a reject, and the analytics hits that I expect after an accept.
5. Run each scenario with \`pingwright run <file> --site <address>\`. Keep the default network mode, \`stub\`, so no tracking hit leaves my machine.
6. Show me a short table: the scenario, the result, and each failed rule with its evidence IDs. Explain each failure in plain words. Tell me if it looks like a real problem on my site or a rule that needs a change.

Rules for you:
- Never type real personal data. Pingwright makes a fake visitor for each run.
- Never automate a payment or a log-in. Use a \`handoff\` step and ask me to do that part.
- Do not use \`--network live\` unless I ask for it.
- Keep the \`runs/\` folder on my machine. Do not commit it or upload it.`;

const status = ref('');
let clearTimer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
  try {
    await navigator.clipboard.writeText(prompt);
    status.value = 'Copied';
  } catch {
    status.value = 'Copy did not work. Select the prompt below and copy it.';
  }
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => (status.value = ''), 4000);
}
</script>

<template>
  <div class="get-started-prompt">
    <button type="button" class="get-started-copy" @click="copy">Copy get started prompt</button>
    <span class="get-started-status" role="status" aria-live="polite">{{ status }}</span>
    <details class="get-started-details">
      <summary>Read the prompt</summary>
      <pre class="get-started-text">{{ prompt }}</pre>
    </details>
  </div>
</template>
