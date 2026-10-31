# Changelog

## 0.3.0

<!-- T05 -->

<!-- T01 -->

### Terminal notes

- The text summary prints the note under a result, passing or failing, for example that a plain name matches a top-level field only. `--json` has the note code in `note` (#510, #520).

- A `cookie` rule no longer says a cookie was stored by the browser when it was already set before the response. The message reads `the cookie was already set before this response`, with no `cookieNotStored` note. A checkpoint taken within 50 ms after the request no longer counts as evidence. (#470, #485, #518)

## 0.3.0-rc.2

Release candidate. Install it with `npm i -g pingwright@next`.

### Report marks and severity

- A hit with unknown consent before the first answer now has its own mark, `early`, ranked above `full`. A hit on a page with a denied Consent Mode default is still `ping` (#378).
- The marks table says that `unchecked` covers identifier names whose consent signal is unknown, and that a hit with both granted and denied signals shows `mixed` (#448).
- The report shows `on failure: fail` or `on failure: warn` on a failed or warned result only. A passing result shows no severity (#458).
- Every result in `--json` has `severity`. A rule with none recorded reads `fail` (#349).

### Suite and report layout

- A suite cell says what failed: `FAIL: 5 rules, deniedIdentifiers` or `WARN: 1 rule`. It counts the failed rules and names the failed built-in checks, and never prints a rule or a message. A run that did not finish stays `ERROR (exit 2)`. The terminal table and the report use the same text (#457).
- The report starts with a plain-language verdict, then the results table, the per-run vendor timelines and the diff tables last. The verdict names vendors, consent states and counts per variant. A single-run report has the same verdict line at the top (#459).
- `diff` and the suite diff tables print `unloadGap: 0 -> 1` for a flag with no host. "(no host)" is gone (#348).

### Cookie and body rules

- A `cookie` rule that finds a `Set-Cookie` header now says whether the browser kept the cookie: `found _dcid from Set-Cookie (7 requests); stored by the browser`, or `no later checkpoint has it` with `note: cookieNotStored`. The rule still fails on the attempt. The message shows names and counts only (#461).
- `body.has` and `body.only` take a leaf name, `**.email`, which matches `email` at any depth. A plain name still matches a top-level field only. When it matches nothing but a nested field has that name, the result says so and has `note: nestedNameOnly` (#462).

### Fixed

- `serverHosts` uses the Public Suffix List (`tldts`) to reject wildcards on public suffixes. `*.police.uk`, `*.uk.com`, `*.fly.dev` and `*.onrender.com` are now rejected, and `*.abc.de` is no longer rejected. `*.wordpress.com` stays rejected through a short local list (#427).
- A `click` or `wait` on a `{ role, name }` locator that times out now lists the closest controls of that role, ranked by name, for example `Closest radio controls: "White (01)", "Black (02)".` If the page has none of that role, the error says so first (#460).
- The Done pill calls the DOM accessors it needs at show and hide time from copies taken at document start, so a page that patches `textContent`, `style`, `getRootNode`, `String`, `Function.prototype.call` or `Event.prototype.stopPropagation` never sees the label or the host. The Done click reads `isTrusted` from a captured getter and treats a throw as untrusted (#446, #494, #398, #492).
- The Done pill is at most the viewport width minus 32 px, and a long handoff text shrinks before the Done button does (#464).

### Handoff

- A late "not waiting" answer no longer stops the Done pill polling after a wake, so the pill hides when the second handoff ends (#444).
- A stale "not waiting" answer no longer hides the Done pill while a handoff is waiting (#502, #500).
- A page that cannot answer the wake no longer blocks Enter or Done from ending a handoff (#445).
- Tests now show the pill stops asking for the handoff state when none is waiting, and asks again on the next handoff (#443).

### Docs

- The README says the 0.3 sections need `npm i -g pingwright@next`, and that the plain install gives 0.2.0 (#450, #481).
- The Shopify guide says a handoff ends when the person clicks Done or presses Enter (#449).
- The handoff docs say a `body` rule does not hide the Done pill, because the host is a sibling of `<body>`. A rule such as `html { display: none }` can still hide it (#454, #480).
- The docs no longer say Enter always works (#451).
- Design section 11 lists `deniedIdentifiers` as a built-in check (#455).
- `docs/cli.md` says only a `--net-log` POST hit has no body (#479).

### Known in 0.3.0-rc.2

Not in rc.2:

- Opt-in test payment steps for unattended checkout runs (#463).
- Server-container visibility, baselines for CI drift checks, one scenario across several stores, WebKit support and an MCP server (#358 to #362).
- A better release setup (#144).

Known issues in rc.2:

- The recorder sometimes misses a redirect response and the cross-origin hop after it. In `stub` mode such a hop can reach the network with no record and no `stubBypass` flag (#180).
- The `country` option does not localise zip, phone or address (#32).
- With `--net-log`, requests seen only in the net log are all labelled with initiator `unload`, and early `srcdoc` requests can be labelled `unload` (#256, #323).
- `unloadGap` compares dataLayer event names to hit names literally (#261).
- A cookie set by a response still in flight at the last checkpoint can read as `cookieNotStored` (#485).
- In the report, a segment with `early`, granted and denied hits shows `early` and not `mixed` (#496).
- The report legend for `unchecked` does not mention identifier names whose consent signal is unknown (#497).
- The verdict says "send" for a single vendor (#505).
- A hand-edited `suite.json` with a malformed failed cell makes `report` throw instead of saying it is not a suite manifest (#506).
- `docs/cli.md` says a locator timeout lists only controls of the requested role, but roles outside button, radio, checkbox, link, tab and option get the general list (#490).

## 0.3.0-rc.1

Release candidate. Install it with `npm i -g pingwright@next`.

### Exit codes can change

The new `deniedIdentifiers` check is on by default and its severity is `fail`. A run that sent an identifier on a denied hit passed in 0.2 and now exits 1. Identifiers are `user_id`, `uid`, hashed `user_data` fields, client-ID hashes, and any field with a 64-character hex value. To keep exit code 0 while you fix the cause, set the check to `warn`:

```yaml
options:
  builtins: { deniedIdentifiers: warn }
```

The check also fails when a denied hit has a body that was not fully recorded: cut at 64 KiB, JSON that did not parse, or a `--net-log` hit with no body. `cid`, `client_id`, `fbp` and click IDs are not flagged. See "deniedIdentifiers" in [docs/cli.md](docs/cli.md).

### Record schema version 2

- `Run.recordSchemaVersion` is 2. 0.2 readers warn on it. Version 1 records still read.
- New optional fields: `Hit.fields` (names of non-empty payload fields), `Hit.fieldsComplete`, `Hit.idFields`, `Checkpoint.t`, `Run.graceWindowMs`, `Run.variant`, `Result.note` and `Step.locator`. They hold names and numbers, never values.
- A rule that needs field names and finds a version 1 record, or a body cut at 64 KiB, reports `cannot evaluate` and does not pass, unless the recorded fields already decide the rule.

### New rules and checks

- `body.has`, `body.only` and `body.ignore` check the field names of a hit, with `*` globs. `body.only` applies to every selected hit.
- `cookie` checks cookie names with `before`, `in` and `after`. In `stub` mode a pass carries the note `stubNoCookies`.
- `deniedIdentifiers` is a built-in check. `options.identifierFields` adds names to it.

### New commands

- `pingwright suite <dir> --site <url>` runs every scenario once per variant (`--variant published`, `--variant name=override.json`), prints a table with the diff between variants, and writes `suite.json`. Scenarios with a `handoff` step are skipped unless `--with-handoff` is given.
- `pingwright report <run.jsonl | suite dir> --html <out.html>` writes one HTML file with names and counts only. It has no script and makes no request.

### New steps and handoff

- `click` and `wait` accept `{ role, name }` and `{ any: [selectors] }`. A timeout lists the closest controls on the page.
- `select` chooses an option by value, then by label, and reads it back.
- A headed handoff shows a Done button in the page. Enter in the terminal still works.

### Server network mode

`--network server` is `stub` plus pass-through for the hosts in `options.serverHosts`. Every other collection request is still stubbed. It exists so that cookies set by a server container can be seen. Sends a page makes while it unloads are still answered in the page, also to server hosts.

Known in 0.3.0-rc.1, fixed in 0.3.0-rc.2:

- `diff` prints `unloadGap (no host)` for flags without a host (#348).
- In `--json` output, `expect` results have no `severity` (#349).
- Enter in the terminal can fail to end a handoff when a page does not answer the wake call (#445).

## 0.2.0

Added a GTM workspace override (`--gtm-override`, also through a Stape-style custom loader), `pingwright diff`, a Pinterest decoder, a curated tracker list that is stubbed and decoded, `--net-log`, the `builtins` severity option, and a Shopify checkout pattern.

Notes:

- In `stub` mode, a hit that a sandboxed frame without `allow-same-origin` (such as a Shopify custom pixel) sends while it unloads is not recorded. Pingwright raises an `unloadGap` warning. To record it, run with `--network live --net-log`. Unload sends from other frames are answered in the page and recorded, unless the tab goes to another origin.
- For Shopify custom pixels, set `builtins: { sandboxPageUrl: warn }`. The pixel runs in a sandboxed iframe, and a vendor that receives the sandbox URL as the page URL is a defect to report, not to fail on.
- A failed `identity.hashesMatch` names the params that do not match and the fields that do (#347).

Known in 0.2.0:

- `diff` prints `unloadGap (no host)` for flags without a host (#348).
- In `--json` output, `expect` results have no `severity`, so a script reads `null` (#349).
