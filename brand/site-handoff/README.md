# Handoff: tagreeve.dev redesign ("Proposal D")

## Overview
This is a new marketing site and docs for Tagreeve, the CLI that plays a visitor in a real browser, records every tracking hit before and after cookie consent, and checks the hits against rules. The site has to:
1. **Amaze first-time visitors.** Laptop visitors see a one-time, skippable intro the first time they visit. A colleague's "5-minute" request turns into a hopeless tag-manager session, notifications pile up faster and faster, and it ends with "wasted".
2. **Show the fix.** A coding agent gets the same question, runs `tagreeve`, reads the output and answers in plain words.
3. **Give people what they came for.** The setup prompt, the install command, the docs and the CLI reference.

Repo: `alfhen/tagreeve`. The site replaces the current VitePress site in `.vitepress/` and `docs/`.

## About the design files
The files in `design/` are **design references built in HTML**. They're prototypes that show the intended look and behaviour, not production code. **Recreate them** in the stack below, and don't ship the HTML. `design/Tagreeve Site.dc.html` opens directly in a browser (keep `support.js` next to it). It contains all three pages: use the pill at the bottom left to switch between Home, Docs and System, and press "▶ Intro" to replay the intro. Every style is inline, so you can read exact values straight from the markup.

`reference/demo-data.js` holds every constant from the prototype: the copy, the mock hits, the timings, the notification list, the tags table and the setup prompt.

## Fidelity
**High fidelity.** Final colours, type, spacing, copy and motion. Match it pixel for pixel. The intro's fake apps (desktop, mail, browser, tag manager) are **original parodies**. Don't use real Apple, Google or GTM assets, logos or names beyond the generic "GTM" mention.

## Stack (recommended)
- **Astro + Tailwind v4**, with **Starlight** for the docs. The existing `docs/**/*.md` move over unchanged. Keep the URLs `/docs/guide/first-run` and `/docs/cli`, because the setup prompt links to them.
- Two client islands: `<FirstVisitIntro>` and `<AgentDemo>`. Use Preact or Solid, or vanilla TS. Everything else is static.
- Fonts from Google Fonts: Geist (400/500/600/700), Geist Mono (400/500/600), and Anton (400, intro only).

## Design tokens
Dark is the default. A light theme is chosen with `[data-theme="light"]` and toggled from the header, and the choice persists in localStorage.

| Token | Dark | Light |
|---|---|---|
| bg | `#090B0B` | `#F5F7F6` |
| bg2 | `#0F1312` | `#ECF0EE` |
| panel | `#121716` | `#FFFFFF` |
| ink | `#E8EEEC` | `#0E1715` |
| muted | `#8A9794` | `#56625F` |
| line | `#1F2826` | `#DCE3E0` |
| mint (accent) | `oklch(0.82 0.12 175)` | `oklch(0.52 0.1 178)` |
| mintdim | mint / 0.14 | mint / 0.10 |
| fail | `oklch(0.72 0.16 25)` | `oklch(0.55 0.19 27)` |
| faildim | fail / 0.14 | fail / 0.10 |
| warn | `oklch(0.84 0.13 85)` | `oklch(0.6 0.13 75)` |
| onmint (text on mint) | `#06201C` | `#FFFFFF` |

The terminal panes stay dark in both themes. The agent terminal is bg `#0C0D0E`, text `#D6D6D2`, dim `#9A9DA2`, frame `#3A3C40`, spinner `#C9A86A`. The other code blocks are bg `#060807`, text `#D9E2DF`, comments `#6E7B78`.

These colours are intro-only and never appear on the site: office blue `#2F6FD6`, alert `#C5221F` / `#C9483B`, Mac mail blue `#007AFF`. The rule is that **Tagreeve's mint never appears inside the intro**, and the intro's notification style comes back exactly once, as Mads's thank-you.

**Type scale (Geist):** H1 `clamp(40px,5.4vw,76px)`, weight 600, line-height .95, letter-spacing −0.05em, `text-wrap:balance`. H2 48px/1, weight 600, −0.045em. Lede 19px/1.5 muted. Body 16–17px/1.55–1.65. Eyebrows are Geist Mono 12px weight 500 in mint, written comment-style (`// safe by default`). Mono UI text is 11–13px.

**Radii:** buttons 8px. Small chips 6px. Cards and panels 14px. Large callouts 18px. Pills 999px.

**Container:** max-width 1280px, side padding 28px. Section padding is 60–110px top.

**Tailwind v4:**
```css
@import "tailwindcss";
@custom-variant light (&:where([data-theme=light], [data-theme=light] *));
@theme {
  --font-sans: "Geist", ui-sans-serif; --font-mono: "Geist Mono", ui-monospace;
  --color-void:#090B0B; --color-void-2:#0F1312; --color-panel:#121716; --color-rule:#1F2826;
  --color-fg:#E8EEEC; --color-dim:#8A9794;
  --color-mint:oklch(0.82 0.12 175); --color-fail:oklch(0.72 0.16 25); --color-warn:oklch(0.84 0.13 85);
}
```
Implement the theme switch with CSS variables, as the prototype does, so every token swaps under `[data-theme=light]`.

## Screens

### 1. Header (sticky, 56px tall, bottom border `line`)
- **Left:** the mark (corner brackets plus a 6px mint pixel, 20px) and "tagreeve" in Geist Mono 600 16px.
- **Nav:** Docs · CLI reference · Design system. 14px, muted.
- **Right:** a theme toggle ("☀ light" / "☾ dark", mono 12px, bordered); a "github ↗" bordered button linking to `github.com/alfhen/tagreeve`; and "(★ star us)" in mint linking to `/stargazers`.
- **Below 860px:** the nav is replaced by a ☰ button that opens a stacked link list under the header.

### 2. Home
Sections in this order:

**Hero** (centred, padding 40px 28px 24px, gap 16px):
- A status pill: "0.4 release candidate · Chromium · MIT", with a 6px mint dot.
- H1: `"Should only take 5 minutes."` followed by `Now it does.` in mint. The prototype also has two alternative headlines behind a `headline` prop. Ship the default.
- Lede: "Tagreeve plays a visitor in a real browser, catches every tracking request, decodes it and checks it against your rules. Ask an agent Mads's question below, and watch it answer in under a minute."
- **Primary button:** "Copy the agent setup prompt" (mint). On click it copies the prompt (`PROMPT` in demo-data.js) and shows "Copied. Paste into your agent" for 2.2s.
- **Secondary button:** "$ npm i -g tagreeve@next" (mono). It copies the command and shows "✓ copied".
- **Text link:** "what does the prompt say?" toggles a `pre` showing the full prompt (max-height 300px, scrolls).

**Agent demo:** see *Interactions → AgentDemo*. A bordered card with radius 14px and a large soft shadow, containing:
- **A toolbar:** the label "agent tests a visitor who", a segmented picker with "ignores banner" / "rejects" / "accepts", a `t = Xs` clock, and "↺ replay".
- **A 3-column grid:** `1.05fr / 0.95fr / 1fr`, 520px tall.
  1. **Agent terminal.**
  2. **Browser preview:** a URL bar, a wireframe product page and a cookie banner that slides away. The footer reads "chromium · stub mode" and "epoch <state>".
  3. **Captured hits:** a list, newest first, and a verdict card at the bottom.
- **Below 860px:** the columns stack. Terminal 440px, browser 320px, hits at natural height.

**Commands** ("// for people, CI and agents"): H2 "Test before you publish. Diff after." On the left, four selectable rows: `tagreeve run`, `tagreeve diff`, `tagreeve suite`, `--json`. On the right, a dark code panel (min-height 380px) shows that command's exact output. The real CLI output formats are in `packages/cli/src/summary.ts`, `diff.ts` and `suite.ts`.

**Vendors:** three cells.
- "decoded": ga4, google-ads, meta, pinterest, sgtm, as mint chips.
- "stubbed & recorded": linkedin, microsoft-uet, reddit, plus "+ --tracker-list".
- "on the way": tag-firing reports, Firefox and WebKit, a mobile viewport preset, a Shopify bridge.

**Safe by default** ("// safe by default", H2 "Point it at production. Nothing leaks."): four cells, each with a mono code label, a title and a body.
- stub mode / Nothing reaches the vendor
- fake identity / Fake people only
- handoff / No log-ins, no real payments
- runs/*.jsonl / Your data stays yours

**Why "tagreeve"** (a two-column card):
- **Left:** H2 "There's a new sheriff in tag town." and two paragraphs: reeve → shire reeve → sheriff, then "it walks the beat… brings evidence".
- **Right:** a vertical word history, mono. "Old English: scīr + gerēfa" → "Middle English: shire reeve" → "Today: sheriff" → "Your stack: tag**reeve**" (reeve in mint, 30–44px). Below it: "Pronounced like 'tag reeve'. Formerly Pingwright."

**ASCII sign-off:** a block-letter "TAGREEVE" next to the bracket mark (`BANNER` in demo-data.js). The pixel and "REEVE" are mint. Font size is `clamp(6px,1.25vw,15px)`, line-height 1.05. The caption reads "the new tag sheriff in town".

**Footer:** "tagreeve · MIT · runs on infrastructure you control", and a "replay the 5-minute ticket" link.

### 3. Docs (Starlight theme matching these tokens)
- **Layout:** a 230px sidebar (search box, then "guides" and "reference" groups, with the active item as a mint-tinted pill) beside an 860px-max article.
- **Article:** the prototype shows "Reading a run's results". Build every guide from the existing markdown in `docs/`.
- **Special component — annotated summary:** a dark summary block on the left. Hovering a line highlights it and shows that part's explanation in a side panel. The data is `ANNOT` in demo-data.js.
- **Agent callout:** "// using an agent?", with the copy-prompt button.
- **Other components:** callouts with a mint left border (2px), a reference list (170px code column + description), and prev/next links.

### 4. Design system page
Optional. It's internal and doesn't have to ship. It shows the tokens, the type and the components, including the hit row, the agent session and the intro-world notification.

## Interactions & behaviour

### FirstVisitIntro
- **When it shows:** only if `localStorage['tagreeve.introSeen'] !== '1'`, the window is at least 860px wide, and `prefers-reduced-motion` isn't `reduce`. It's a fixed, full-viewport overlay (z 100), and `body` scrolling is locked while it's open.
- **Desktop:** a wallpaper of layered oklch radial gradients over `#3B4A7A`. A frosted menu bar, 28px tall, shows the active app name, the unread count, a battery that drains as notifications arrive, a clock (starts at Thu 16:47 and speeds up) and a "Skip intro →" pill. At the bottom there's a frosted dock.

**Stages:**
1. **`ask`.** A mail window shows Mads's email: subject "Quick favour? Meta numbers + consent", ending with **"Should only take 5 minutes."** Two buttons:
   - "↩ Reply: 'Sure, I'll take a look'" goes to `mess`.
   - "Not my job (skip)" calls `fly()`.
2. **`mess`.**
   - A dark browser window opens over the mail, which dims and scales to 0.97. Tabs: "Tags · TagMangler", "Events Manager · Ads", "consent_audit (2).xlsx", "why does consent mode not work - Search", "Consent banner settings".
   - The URL bar shows a long, deep workspace path.
   - The page is a generic tag manager: a workspace switcher, a "213" changes count, Preview/Submit, side nav, a tags table of 16 rows (click a row to select it), and a detail panel.
   - Preview opens a "Connecting to preview…" modal that never connects; "Try again" only increments the attempt counter.
   - **Notifications:** frosted cards, 330px wide, radius 18px. 13 of them arrive on delays of `[1300,1100,950,800,650,520,420,340,270,220,180,150,130]` ms.
     - The first 4 stack at the top right. The rest scatter, slightly rotated (positions are in `SCATTER`).
     - Mail-type notifications are also added to the top of the inbox list.
     - The "time on this ticket" counter grows quadratically.
     - From the 10th notification on, the window shakes (0.25s jitter).
3. **`wasted`** (600ms after the last notification).
   - The scene turns greyscale (contrast 1.15, brightness 0.8) and slowly zooms (4s, to 1.08 with −1° rotation).
   - A dark band slides in, then "wasted" appears in Anton, `clamp(72px,11vw,150px)`, colour `oklch(0.62 0.22 25)`, with a black text shadow. It scales from 1.5 to 1 while its letter-spacing tightens from .2em to .04em, over 1.1s.
   - Below it, in mono: "Xh Ym in the tag manager. Meta still fires before consent."
   - It holds for 2.4s.
4. **`shrink`** (0.75s): the overlay scales to 0.84 and its corners round to 22px, with a deep shadow.
5. **`fly`** (1.15s, `cubic-bezier(.65,0,.35,1)`): the overlay moves to `translateY(-105vh) scale(.84)` and fades to 0.4. At the same time the site animates in from `translateY(100vh) scale(.92)`. Then the overlay unmounts and scrolling unlocks.

**Seen flag and replay:** the seen flag is set when `fly` starts, so skipping counts as seen. Replay is from the footer link only; the "▶ Intro" pill is for review and doesn't ship.

### AgentDemo
- **Idle (initial state):**
  - A dimmed overlay covers the demo grid (`rgba(6,8,7,.55)` with a 2px blur).
  - On it sits a centred card near the top (max 620px wide, mint border plus a 4px mint glow). It shows "~/northwind — your coding agent", the prompt `> Meta numbers fell off a cliff…`, and an **"Ask the agent ⏎"** button with a pulsing ring.
  - The hits pane says "Hits will land here as the visitor browses."
  - Choosing a visitor while idle only changes the scenario. Once a run has started, choosing one restarts it.
- **Run.** One clock, `T` in ms, ticks every 80ms starting at `SEND_AT = 1450`. Let `t = T − OFF`, with `OFF = 2800`.

| When | Agent terminal | Browser & hits panes |
|---|---|---|
| T ≥ 1500 | The prompt moves from the input box into the conversation. A working line appears (spinner glyphs `· ✢ ✳ ✶ ✻ ✽` cycling every 160ms; label "Thinking…" / "Running tagreeve…" / "Reading the summary…"; "(Ns · esc to interrupt)"). The footer shows "stub mode · no hits leave this machine". | — |
| T > 1800 | ● plan text for the chosen scenario | — |
| T > OFF − 300 | ● `Bash(tagreeve run tagreeve/<file> --site https://staging.northwind.dk)`, then ⎿ "running… chromium · stub mode". The dot blinks while running and turns red when done. | — |
| t 1250 / 1600 | — | Page fades in; banner slides up |
| t ≈ 3000–3300 | — | Reject/Accept visibly "pressed", then the banner hides and the epoch changes |
| t at each hit's `at` value | — | Hit rows slide in, newest first, from `BASE` + `SC[k].after` |
| t > 5600 (END) | Shortened tool output: the first 3 summary lines, "… +N lines", the last 2 lines, "exit 1" | Verdict card appears |
| T > REPLY_AT (= OFF + 5600 + 700) | ● reply streams in at 0.16 chars per ms, paragraph by paragraph | — |
| reply end + 400 | ● "Want me to reply to Mads with this? (y/n)", with `y` typed at +1100 | — |
| reply end + 1400 | ⎿ "✓ Sent to Mads · cc Sofie (Legal) · evidence attached" | — |
| reply end + 2300 → +7300 | — | Mads's thank-you notification, top-left over the browser pane: "Wait, that took a minute?? Sending it to Sofie. Thank you!" |

- **Bottom-anchored terminal:** the terminal content is anchored to the bottom, with a 36px fade at the top, so older lines scroll up and out.
- **Hit rows:** a 3-column grid (36px time, vendor, event). The status chip ("before consent", "after reject", "gcs denied", "granted", "undecided") wraps onto its own second line. Hits that break a rule get a `fail` border, a `faildim` background and a solid fail chip.
- **Reduced motion:** clicking Ask jumps straight to the final state.
- **Replay:** "↺ replay" restarts the run from `SEND_AT`.

### Make the demo real (required before launch)
The prototype's hits, IDs and summary are hand-written. They follow the real format, but they aren't a recorded run.
1. Record one run per scenario against Tagreeve's test shop: `tagreeve run tagreeve/{undecided,accept,reject}.yml --site <test-shop> > demo/<s>.txt`. Commit `demo/<s>.jsonl` (the record) and `demo/<s>.txt` (stdout).
2. At build time, derive these from the record:
   - `hit` records give vendor, event, and time relative to the run start; scale to the demo's ~3s window.
   - `consentEpoch` records give the banner timing and the epoch label.
   - The stdout gives the shortened tool output.
3. The agent's plan and reply stay hand-written per scenario in `demo/<s>.reply.md`. Add a build check that **every number and every evidence ID in the reply exists in the record**, and fail the build otherwise.
4. Re-record whenever the CLI output format changes.

## State
- `intro`: `null` | `ask` | `mess` | `wasted` | `shrink` | `fly`. Also `mi` (how many notifications are showing), `selectedTag`, `previewOpen`, `attempt`.
- **Demo:** `armed`, `T`, `scenario` (`none` | `reject` | `accept`), `cmd` (`run` | `diff` | `suite` | `json`), `showPrompt`, `copied` / `npmCopied`.
- **Global:** `theme` (persisted), `narrow` (below 860px, updated on resize), `menuOpen`.
- **Docs:** `annotHover` for the annotated summary.

## Copy
All copy is final and lives in the design file and `reference/demo-data.js`:
- `PROMPT`, the agent setup prompt. It's the same as `.vitepress/theme/GetStartedPrompt.vue`, so keep the two in sync.
- `USER_PROMPT`, `PLANS`, `REPLIES`, `MTOASTS_RAW`, `MTAGS`.

Voice: plain, short sentences, matching the docs' style guide.

## Assets
- `assets/mark.svg`, `assets/mark-dark.svg`, `assets/favicon-32.svg`: the existing brand mark from `brand/`. The header uses a CSS version of the mark (corner brackets plus the mint pixel).
- There are no other images. The product shot in the browser pane is a striped placeholder, and the dock icons are gradient tiles. Keep them abstract.

## Files
- `design/Tagreeve Site.dc.html`: the full prototype (home, docs and design system, the intro and the demo). Open it in a browser.
- `design/support.js`: the prototype's runtime. Only needed to view the file.
- `reference/demo-data.js`: every constant, copy string and timing.
- `assets/`: the brand marks.

## Open items
- The CLI doesn't stream progress yet. If progress is added (to stderr, only when output goes to a terminal), the "running…" line could show real progress.
- The ASCII banner could also go in `tagreeve --help` / `--version`.
- There's no social proof yet. Once real users quote you, a single line could go between the demo and the commands section.
