# Changelog

## 0.3.0-rc.2

<!-- S06 -->

<!-- S08 -->

### Cookie and body rules

- A `cookie` rule that finds a `Set-Cookie` header now says whether the browser kept the cookie: `found _dcid from Set-Cookie (7 requests); stored by the browser`, or `no later checkpoint has it` with `note: cookieNotStored`. The rule still fails on the attempt. The message shows names and counts only (#461).
- `body.has` and `body.only` take a leaf name, `**.email`, which matches `email` at any depth. A plain name still matches a top-level field only. When it matches nothing but a nested field has that name, the result says so and has `note: nestedNameOnly` (#462).

<!-- S03 -->

### Fixed

- `serverHosts` uses the Public Suffix List (`tldts`) to reject wildcards on public suffixes. `*.police.uk`, `*.uk.com`, `*.fly.dev` and `*.onrender.com` are now rejected, and `*.abc.de` is no longer rejected. `*.wordpress.com` stays rejected through a short local list (#427).

<!-- S04 -->

<!-- S05 -->

<!-- S07 -->

### Docs

- The README says the 0.3 sections need `npm i -g pingwright@next`, and that the plain install gives 0.2.0 (#450).
- The Shopify guide says a handoff ends when the person clicks Done or presses Enter (#449).
- The handoff docs say a `body` rule does not hide the Done pill, because the host is a sibling of `<body>`. Use `html { display: none }` (#454).
- The docs no longer say Enter always works (#451).
- Design section 11 lists `deniedIdentifiers` as a built-in check (#455).

<!-- S09 -->

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
