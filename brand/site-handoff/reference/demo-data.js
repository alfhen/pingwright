// Extracted from "Proposal D - Wasted Intro.dc.html". Mock data and timing constants for the agent demo and intro.
// Replace hits/summary with real recorded runs (see README → "Make the demo real").

const PROMPT = `Set up Tagreeve to test the tracking and the cookie consent on my website.

Tagreeve is a command-line tool. It opens my site in a real browser, acts as a visitor, records every tracking request and checks the requests against rules that I write. The docs are at https://tagreeve.dev.

1. Install it with \`npm i -g tagreeve@next\`, then run \`tagreeve install-browser\`. Check that \`tagreeve --version\` works.
2. Read https://tagreeve.dev/docs/guide/first-run and https://tagreeve.dev/docs/cli before you write a scenario. Use \`tagreeve run --help\` for the flags. Do not guess flags or step names.
3. Ask me for the address of my site and the tracking tools it uses, for example GA4, Google Ads, Meta or Pinterest.
4. Write three scenarios in a \`tagreeve/\` folder: the visitor ignores the cookie banner (\`consent: none\`), accepts it (\`consent: accept\`) and rejects it (\`consent: reject\`). Each scenario opens the home page and one product or content page. Add rules: no Meta or Google Ads hit before consent, no marketing hit after a reject, and the analytics hits that I expect after an accept.
5. Run each scenario with \`tagreeve run <file> --site <address>\`. Keep the default network mode, \`stub\`, so no tracking hit leaves my machine.
6. Show me a short table: the scenario, the result, and each failed rule with its evidence IDs. Explain each failure in plain words. Tell me if it looks like a real problem on my site or a rule that needs a change.

Rules for you:
- Never type real personal data. Tagreeve makes a fake visitor for each run.
- Never automate a payment or a log-in. Use a \`handoff\` step and ask me to do that part.
- Do not use \`--network live\` unless I ask for it.
- Keep the \`runs/\` folder on my machine. Do not commit it or upload it.`;

const C = { fg: '#D9E2DF', dim: '#6E7B78', mint: 'oklch(0.82 0.12 175)', fail: 'oklch(0.72 0.16 25)', warn: 'oklch(0.84 0.13 85)' };
const BASE = [
  { at: 1900, v: 'ga4', e: 'page_view', why: '' },
  { at: 2300, v: 'meta', e: 'PageView', why: 'before' },
  { at: 2700, v: 'google-ads', e: 'page_view', why: 'before' },
];
const EV = ['hit_01M66G9M2S992B5DF1MZ15ZQ08', 'hit_01M66G9M2T97WBWV5AA85VFM3W', 'hit_01M66G9M2VCB4KHQ2ZD3ZQ9J4R', 'hit_01M66G9M2WQ0R3T8N7C1VHX2EA'];
const RECORD = 'runs/run_01M66G9DA0714WFS5QHQM5A0NX.jsonl';
const BUILTINS = ['builtin: unknownDestination', 'builtin: deniedIdentifiers', 'builtin: possibleRealData'].map(e => ({ e, pass: true }));
const SC = {
  none: { label: 'ignores banner', file: 'undecided.yml', action: null, epoch2: null,
    after: [{ at: 4300, v: 'ga4', e: 'page_view', why: '' }, { at: 4700, v: 'pinterest', e: 'pagevisit', why: 'before' }],
    rules: [
      { e: 'mustNot: {"vendor":["meta","google-ads","pinterest"],"before":"consent"}', pass: false, msg: 'Expected no matching hits before consent, found 3 matching hits (3 before narrowing).', ev: [EV[0], EV[1], EV[3]] },
      { e: 'must: {"vendor":"ga4","event":"page_view","count":">=2"}', pass: true },
    ],
    verdict: ['3 hits before consent', 'Meta, Google Ads and Pinterest fire while the banner is still open.', 'exit 1'] },
  reject: { label: 'rejects', file: 'reject.yml', action: 'reject', epoch2: 'denied',
    after: [{ at: 3900, v: 'ga4', e: 'page_view', why: 'denied' }, { at: 4300, v: 'ga4', e: 'page_view', why: 'denied' }, { at: 4700, v: 'meta', e: 'AddToCart', why: 'afterReject' }],
    rules: [
      { e: 'mustNot: {"vendor":["meta","google-ads"],"before":"consent"}', pass: false, msg: 'Expected no matching hits before consent, found 2 matching hits (2 before narrowing).', ev: [EV[0], EV[1]] },
      { e: 'mustNot: {"vendor":"meta","in":"epoch(denied)"}', pass: false, msg: 'Expected no matching hits in epoch(denied), found 1 matching hit (2 before narrowing).', ev: [EV[2]] },
    ],
    verdict: ['Meta ignores "Reject"', '2 hits before the answer, and 1 more after the visitor said no.', 'exit 1'] },
  accept: { label: 'accepts', file: 'accept.yml', action: 'accept', epoch2: 'granted',
    after: [{ at: 3900, v: 'ga4', e: 'page_view', why: 'granted' }, { at: 4300, v: 'meta', e: 'ViewContent', why: 'granted' }, { at: 4700, v: 'google-ads', e: 'conversion', why: 'granted' }],
    rules: [
      { e: 'mustNot: {"vendor":["meta","google-ads"],"before":"consent"}', pass: false, msg: 'Expected no matching hits before consent, found 2 matching hits (2 before narrowing).', ev: [EV[0], EV[1]] },
      { e: 'must: {"vendor":"meta","event":"ViewContent","in":"epoch(granted)"}', pass: true },
    ],
    verdict: ['Accept works. Waiting doesn\'t', 'Everything fires after Accept, but Meta and Ads jump the gun before it.', 'exit 1'] },
};
function summaryLines(sc) {
  const by = {};
  for (const h of [...BASE, ...sc.after].sort((a, b) => a.at - b.at)) { by[h.v] = by[h.v] || {}; by[h.v][h.e] = (by[h.v][h.e] || 0) + 1; }
  const L = [['Hits', 'fg']];
  for (const v of Object.keys(by)) L.push([`  ${v}: ${Object.entries(by[v]).map(([e, n]) => `${e} x${n}`).join(', ')}`, 'fg']);
  L.push(['Consent epochs', 'fg']);
  if (sc.action) L.push(['  undecided (3.3 s)', 'fg'], [`  ${sc.epoch2} (to end)`, 'fg']); else L.push(['  undecided (to end)', 'fg']);
  L.push(['Flags', 'fg'], ['  none', 'fg'], ['Expectations', 'fg']);
  const all = [...sc.rules, ...BUILTINS];
  for (const r of all) {
    L.push([`  ${r.pass ? 'PASS' : 'FAIL'} ${r.e}`, r.pass ? 'mint' : 'fail']);
    if (!r.pass && r.msg) L.push([`       ${r.msg}`, 'dim']);
    if (r.ev && r.ev.length) L.push([`       evidence: ${r.ev.join(', ')}`, 'dim']);
  }
  const failed = all.filter(r => !r.pass).length;
  L.push([failed ? `Result: fail (${failed} of ${all.length})` : 'Result: pass', failed ? 'fail' : 'mint'], [`Record: ${RECORD}`, 'dim']);
  return L;
}
function suiteLines() {
  const rows = [['accept', 'FAIL: 1 rule', 'PASS', '-2 removed'], ['reject', 'FAIL: 2 rules', 'PASS', '-3 removed'], ['undecided', 'FAIL: 1 rule', 'PASS', '-3 removed']];
  const header = ['scenario', 'published', 'workspace', 'diff (published -> workspace)'];
  const w = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = cols => cols.map((c, i) => (i === cols.length - 1 ? c : c.padEnd(w[i] + 3))).join('').trimEnd();
  const dir = 'runs/suite_01M66H2B7Q4K9X';
  return [
    ['$ tagreeve suite scenarios/ --site https://staging.northwind.dk --variant published --variant workspace=ws47.json', 'dim'],
    ...['accept', 'reject', 'undecided'].flatMap(s => [[`Running ${s} (published)`, 'dim'], [`Running ${s} (workspace)`, 'dim']]),
    [line(header), 'fg'], ...rows.map(r => [line(r), 'fg']),
    ['', 'fg'], ['Records', 'fg'],
    ...['accept', 'reject', 'undecided'].flatMap(s => [[`  ${s} published: ${dir}/${s}.published.jsonl`, 'fg'], [`  ${s} workspace: ${dir}/${s}.workspace.jsonl`, 'fg']]),
    ['', 'fg'], [`Manifest: ${dir}/suite.json`, 'fg'],
  ];
}
const CMDS = {
  run: { name: 'tagreeve run', desc: 'Play one scenario. Exit 0, 1 or 2.', lines: [['$ tagreeve run reject.yml --site https://staging.northwind.dk', 'dim'], ...summaryLines(SC.reject)] },
  diff: { name: 'tagreeve diff', desc: 'Compare two records, e.g. published vs. workspace.', lines: [['$ tagreeve diff runs/published/run_A.jsonl runs/workspace/run_B.jsonl', 'dim'], ['Diff runs/published/run_A.jsonl -> runs/workspace/run_B.jsonl', 'fg'], ['', 'fg'], ['Epoch undecided', 'fg'], ['  google-ads', 'fg'], ['    page_view', 'fg'], ['      removed (step "wait-2"): ' + EV[1], 'mint'], ['  meta', 'fg'], ['    PageView', 'fg'], ['      removed (step "wait-2"): ' + EV[0], 'mint']] },
  suite: { name: 'tagreeve suite', desc: 'A folder of scenarios × several GTM builds, for CI.', lines: suiteLines() },
  json: { name: '--json', desc: 'Stable JSON with evidence IDs, for agents and scripts.', lines: [["$ tagreeve run reject.yml --site … --json | jq '.results[0]'", 'dim'], ['{', 'fg'], ['  "expectation": "mustNot: {\\"vendor\\":[\\"meta\\",\\"google-ads\\"],\\"before\\":\\"consent\\"}",', 'fg'], ['  "pass": false,', 'fail'], ['  "severity": "fail",', 'fg'], ['  "message": "Expected no matching hits before consent, found 2 matching hits (2 before narrowing).",', 'fg'], ['  "evidence": [', 'fg'], ['    "hit_01M66G9M2S992B5DF1MZ15ZQ08",', 'fg'], ['    "hit_01M66G9M2T97WBWV5AA85VFM3W"', 'fg'], ['  ]', 'fg'], ['}', 'fg']] },
};
const LETTERS = {
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '], A: [' ███ ', '█   █', '█████', '█   █', '█   █'], G: [' ████', '█    ', '█  ██', '█   █', ' ████'],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'], E: ['█████', '█    ', '████ ', '█    ', '█████'], V: ['█   █', '█   █', '█   █', ' █ █ ', '  █  '],
};
const MARK = [['█▀▀▀     ▀▀▀█', '', ''], ['█      ', '██', '   █'], ['       ', '██', '    '], ['█           █', '', ''], ['█▄▄▄     ▄▄▄█', '', '']];
const BANNER = MARK.map(([a, px, b], i) => ({ m1: a, mpx: px, m2: b + '    ', w1: 'TAG'.split('').map(l => LETTERS[l][i]).join(' ') + ' ', w2: 'REEVE'.split('').map(l => LETTERS[l][i]).join(' ') }));
const ANNOT = [
  ['Hits', 'hits', 'Hits', 'Each vendor and event, and how many times it was sent.'],
  ['  ga4: page_view x3', 'hits'], ['  sgtm: (no event) x1', 'sgtm', 'sgtm', 'A server-side GTM container. (no event) means the hit had no event name.'], ['  meta: PageView x1', 'hits'],
  ['Consent epochs', 'epochs', 'Consent epochs', 'The periods of one consent state in the run. This run never answered the banner, so it ends undecided.'], ['  undecided (to end)', 'epochs'],
  ['Flags', 'flags', 'Flags', 'Things worth a look. Some fail the run, such as unknownDestination. Others only inform.'], ['  unknownDestination: 127.0.0.1:57305 x1', 'flags'],
  ['Expectations', 'exp', 'Expectations', 'Your rules and the built-in checks, each with PASS, FAIL or WARN.'],
  ['  FAIL mustNot: {"vendor":["meta","google-ads"],"before":"consent"}', 'exp'],
  ['       evidence: hit_01M66G9M2S992B5DF1MZ15ZQ08', 'ev', 'evidence', 'The IDs of the records behind the failure. grep the record file for one to see the whole hit.'],
  ['  PASS builtin: deniedIdentifiers', 'exp'],
  ['Result: fail (3 of 5)', 'res', 'Result', '3 of 5 checks passed. The exit code is 1.'],
  ['Record: runs/run_01M66G9DA0714WFS5QHQM5A0NX.jsonl', 'rec', 'Record', 'One JSON object per line: run, step, request, hit, consentEpoch, flag, result…'],
];
const END = 5600;
const OFF = 2800, RATE = 0.16, SEND_AT = 1450;
const REPLY_AT = OFF + 5600 + 700;
const USER_PROMPT = "Meta numbers fell off a cliff after Tuesday's publish, and Legal says Meta fires before people answer the cookie banner. Can you check staging.northwind.dk?";
const PLANS = {
  none: "I'll run Tagreeve as a visitor who sees the cookie banner but never answers it, and check what's sent while they're undecided.",
  reject: "I'll run Tagreeve as a visitor who rejects the cookie banner, then browses on. Stub mode, so no real hits reach Meta.",
  accept: "I'll run Tagreeve as a visitor who accepts the cookie banner, to see what fires before and after the answer.",
};
const REPLIES = {
  none: ["Legal is right. While the banner is still open, three marketing tags already fire: Meta PageView, Google Ads and Pinterest (3 hits, all before any answer).", "GA4 behaves: it sends page_view with consent denied, as it should.", "Evidence: hit_…ZQ08, hit_…FM3W, hit_…2EA. Most likely a Meta and an Ads tag on All Pages without a consent check."],
  reject: ["Found it. Two problems on staging:", "1. Meta and Google Ads fire before the visitor answers the banner (2 hits). That's what Legal is hearing about.\n2. After the visitor clicks Reject, Meta still sends AddToCart.", "No identifiers leak, and the fake visitor's data is clean. Evidence: hit_…ZQ08, hit_…FM3W, hit_…J4R."],
  accept: ["After Accept, everything works: GA4, Meta ViewContent and the Ads conversion all fire as expected.", "The problem is before the answer: Meta and Google Ads send hits while the banner is still open (2 hits). That explains Legal's complaints.", "Evidence: hit_…ZQ08, hit_…FM3W."],
};
for (const k of Object.keys(SC)) { SC[k].plan = PLANS[k]; SC[k].reply = REPLIES[k]; }
const replyEnd = sc => REPLY_AT + sc.reply.join('').length / RATE;
const TOTAL = REPLY_AT + Math.max(...Object.values(REPLIES).map(r => r.join('').length)) / RATE + 7600;
const P = (who, role, initial, color, text) => ({ who, role, initial, color, text });
const MADS = ['Mads', 'Performance', 'M', '#2F6FD6'], SOFIE = ['Sofie', 'Legal', 'S', '#7A5AF8'], JONAS = ['Jonas', 'Dev', 'J', '#0E9384'], KARIN = ['Karin', 'CMO', 'K', '#C4320A'], DPO = ['Henrik', 'DPO', 'H', '#475467'], AG = ['Pixel & Co', 'Agency', 'P', '#DD2590'];
const MTOASTS_RAW = [
  P(...SOFIE, 'Three complaints this week saying Meta loads before people answer the cookie banner.'),
  P(...JONAS, 'I didn\'t touch GTM. Maybe the agency\'s pixel?'),
  P(...MADS, 'Any luck? The ROAS dashboard is all red.'),
  P(...SOFIE, 'Looping in our DPO.'),
  P(...AG, 'We didn\'t change anything. Have you tried clearing your cache?'),
  P(...KARIN, 'Is this fixed?'),
  P(...DPO, 'Please send a list of every vendor that gets data before consent. Today.'),
  P(...JONAS, 'Preview mode doesn\'t load for me either'),
  P(...MADS, '??'),
  P(...KARIN, 'Board meeting in 20 minutes.'),
  P(...SOFIE, 'A customer has complained to the data protection authority.'),
  P(...MADS, 'hello?'),
  P(...AG, 'Our invoice for the "consent fix" is attached'),
  P(...KARIN, 'Call me.'),
  P(...DPO, 'Escalating.'),
  P(...JONAS, 'it\'s 23:40, going to bed'),
  P(...KARIN, 'CALL ME'),
];
const CHANNELS = ['mail', 'chat', 'chat', 'mail', 'mail', 'chat', 'mail', 'chat', 'chat', 'chat', 'mail', 'chat', 'mail', 'chat', 'mail', 'chat', 'chat'];
const SUBJECTS = ['FW: Complaint re. cookies', '', '', 'Consent audit, DPO cc', 'RE: RE: pixel', '', 'URGENT: vendor list', '', '', '', 'Complaint to the authority', '', 'Invoice #2302', '', 'Escalation', '', ''];
const MTOASTS = MTOASTS_RAW.map((m, i) => ({ ...m, channel: CHANNELS[i] || 'chat', subject: SUBJECTS[i] || m.text }));
const MDELAYS = [1300, 1100, 950, 800, 650, 520, 420, 340, 270, 220, 180, 150, 130];
const SCATTER = [['8%', '22%', '-3deg'], ['34%', '58%', '2deg'], ['52%', '14%', '-1deg'], ['14%', '64%', '4deg'], ['40%', '32%', '-5deg'], ['62%', '70%', '3deg'], ['22%', '42%', '-2deg'], ['48%', '48%', '6deg'], ['6%', '80%', '-4deg'], ['30%', '8%', '2deg'], ['56%', '38%', '-6deg'], ['18%', '30%', '5deg'], ['44%', '76%', '-3deg']];
const MTAGS = [
  { name: 'FB Pixel - OLD - do not delete', type: 'Custom HTML', trig: 'All Pages', ago: '3 yrs', consent: 'Not set', note: '"Removing this broke something in 2023" — K.' },
  { name: 'Meta CAPI v2 (copy) (copy)', type: 'Custom HTML', trig: 'DOM Ready - ALL', ago: '2 days', consent: 'Not set', note: 'Which copy is live? Both, apparently.' },
  { name: 'Meta - Purchase NEW', type: 'Template', trig: 'ce - purchase_v2', ago: '2 days', consent: 'ad_storage (maybe)', note: 'Is the email lowercased before hashing? Nobody knows.' },
  { name: 'GA4 config (Jonas test)', type: 'GA4 Config', trig: 'All Pages', ago: '5 mo', consent: 'Built-in', note: 'Test tag. In production.' },
  { name: 'consent fix?? 14.03', type: 'Custom HTML', trig: 'Consent Init - All', ago: '8 mo', consent: 'n/a', note: 'Sets ad_storage to granted. "TODO revert".' },
  { name: 'GAds Remarketing', type: 'Google Ads', trig: 'All Pages', ago: '1 yr', consent: 'Built-in', note: '' },
  { name: 'Pinterest base (agency)', type: 'Custom HTML', trig: 'Window Loaded', ago: '2 yrs', consent: 'Not set', note: 'Agency left in 2024.' },
  { name: 'CookieBanner listener v4 FINAL', type: 'Custom HTML', trig: 'Initialization', ago: '8 mo', consent: 'n/a', note: 'v5 is in "Unsorted".' },
  { name: 'Meta AddToCart (dupe?)', type: 'Template', trig: 'Click - Add btn', ago: '2 days', consent: 'Not set', note: '' },
  { name: 'TikTok – paused?', type: 'Custom HTML', trig: '—', ago: '1 yr', consent: 'Not set', note: '' },
  { name: 'sGTM forwarder (Stape)', type: 'GA4 Event', trig: 'All Events', ago: '6 mo', consent: 'Built-in', note: '' },
  { name: 'zz_temp_hotjar', type: 'Custom HTML', trig: 'All Pages', ago: '4 yrs', consent: 'Not set', note: '' },
  { name: 'Meta ViewContent', type: 'Template', trig: 'PDP - all', ago: '2 days', consent: 'Not set', note: '' },
  { name: 'LinkedIn Insight', type: 'Custom HTML', trig: 'All Pages', ago: '3 yrs', consent: 'Not set', note: '' },
  { name: 'Meta Lead (old form)', type: 'Custom HTML', trig: 'Form Submit', ago: '2 yrs', consent: 'Not set', note: '' },
  { name: 'Reddit pixel test', type: 'Custom HTML', trig: 'All Pages', ago: '7 mo', consent: 'Not set', note: '' },
];

