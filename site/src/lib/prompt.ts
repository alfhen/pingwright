export const PROMPT = `Set up Tagreeve to test the tracking and the cookie consent on my website.

Tagreeve is a command-line tool. It opens my site in a real browser, acts as a visitor, records every tracking request and checks the requests against rules that I write. The docs are at https://tagreeve.dev.

1. Install it with \`npm i -g tagreeve@next\`, then run \`tagreeve install-browser\`. Check that \`tagreeve --version\` works.
2. Read https://tagreeve.dev/docs/guide/first-run and https://tagreeve.dev/docs/cli before you write a scenario. Use \`tagreeve run --help\` for the flags. Do not guess flags or step names.
3. Ask me for the address of my site and the tracking tools it uses, for example GA4, Google Ads, Meta or Pinterest.
4. Run \`tagreeve init\` in my project folder. Write three scenarios in \`tagreeve/scenarios/\`: the visitor ignores the cookie banner (\`consent: none\`), accepts it (\`consent: accept\`) and rejects it (\`consent: reject\`). Each scenario opens the home page and one product or content page. Add rules: no Meta or Google Ads hit before consent, no marketing hit after a reject, and the analytics hits that I expect after an accept.
5. Run each scenario with \`tagreeve run <file> --site <address>\`. Keep the default network mode, \`stub\`, so no tracking hit leaves my machine.
6. Show me a short table: the scenario, the result, and each failed rule with its evidence IDs. Explain each failure in plain words. Tell me if it looks like a real problem on my site or a rule that needs a change.

Rules for you:
- Never type real personal data. Tagreeve makes a fake visitor for each run.
- Never automate a payment or a log-in. Use a \`handoff\` step and ask me to do that part.
- Do not use \`--network live\` unless I ask for it.
- Keep the \`tagreeve/runs/\` folder on my machine. Do not commit it or upload it.`;

export const INSTALL_COMMAND = 'npm i -g tagreeve@next';
