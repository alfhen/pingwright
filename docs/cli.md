# CLI

## Install

```bash
npm i -g pingwright
pingwright install-browser
```

`npm i -g pingwright@next` installs the newest release candidate, `0.3.0-rc.1` at the time of writing. Pingwright needs Node 22.18 or later.

You can also install a release from its git tag:

```bash
npm i -g --install-links github:alfhen/pingwright#v<version>
```

`--install-links` is needed because without it npm 10 links the global package to a temporary clone that it then deletes. Installing from a branch such as main does not work. Only release tags carry a built `dist/`.

Or build a tarball in a checkout and install that:

```bash
pnpm install && pnpm build && pnpm pack
npm i -g ./pingwright-<version>.tgz
```

`install-browser` runs the Playwright CLI that ships with Pingwright, so the Chromium revision matches.

## Commands

### `pingwright run <scenario.yml> --site <url>`

Plays the scenario in Chromium, records every request, decodes the hits, checks the expectations and writes one JSONL file.

| Option | Meaning |
| --- | --- |
| `--site <url>` | The site to test. Required. Scenario paths are resolved against it. |
| `--network stub\|server\|live` | `stub` (default) answers known collection endpoints locally. `server` is `stub`, except that collection requests to the hosts in `options.serverHosts` pass through (see Rules on cookies). Sends from a page while it unloads are still answered in the page, also to those hosts. `live` lets every hit through and warns on stderr that hits reach real vendor accounts. Overrides `options.network` in the scenario. |
| `--out <dir>` | Directory for the record, `runs` by default. The file is `<dir>/run_<id>.jsonl`. |
| `--seed <n>` | Seed for the fake identity. Overrides `options.seed`. |
| `--headed` | Show the browser window. Scenarios with a `handoff` step are always headed. |
| `--net-log` | Launches Chromium with `--log-net-log` and records collection requests that no browser hook reports: sends from a frame while it unloads, and early sends from a sandboxed `srcdoc` iframe while it loads. They carry `captured: "netlog"` and no body. The initiator is `unload` when the request started after a navigation request (not the first page load or its redirects) and up to 1.5 s after its response, and `netlog` otherwise. An early `srcdoc` send on a later page can still be labelled `unload`. This is a guess from timing. Needs live network, from `--network live` or the scenario's `options.network: live`: the command refuses it in `stub` mode with exit code 2, because those requests would leave the machine. The log is written to a private temporary directory, not the output directory, and removed when the run ends, including on SIGINT and SIGTERM. Off by default. See design §5.3. |
| `--autoconsent-rules <file>` | Extra autoconsent rules. Can be repeated. |
| `--gtm-override <file>` | Runs the page against an unpublished GTM workspace build. See below. |
| `--tracker-list <file>` | Adds tracker entries to the built-in list. See below. |
| `--var <k=v>` | Overrides a variable the scenario declares under `vars`. A name the scenario does not declare exits 2. Can be repeated. |
| `--json` | Prints a JSON summary on stdout instead of the text summary. |

`pingwright run --help` prints this command's own help.

The text summary lists hits per vendor and event, consent epochs, flags (`unknownDestination` and `firstPartySubdomain` grouped by host, and `sandboxPageUrl` grouped by vendor, each with a count and up to three example paths, or one for `sandboxPageUrl`; `possibleRealData` is one line with a count; the `--json` summary keeps every flag), each expectation with PASS, FAIL or WARN (failures show the message; every expectation shows up to five evidence IDs and a count of the rest), and the path of the JSONL file. The `result` records are appended to that file.

Tracker list: `--tracker-list <file>` takes a JSON array of `{ "vendor", "host", "paths"?, "source" }` entries, with the same checks as the built-in list. `vendor` is a lowercase key that is not a built-in decoder key (`ga4`, `google-ads`, `meta`, `pinterest`, `sgtm`), `host` is an exact host or `*.domain`, `paths` are path prefixes and `source` is an https link to the vendor's docs. In `stub` mode, a request to a listed path is stubbed for every resource type, and a request to a listed host without paths is stubbed unless it is a script, stylesheet, font or document load. A whole-host image or other request with no query and no body is stubbed but gives no hit. Each other such request becomes a minimal hit with the entry's vendor, the event and page when the URL has a common parameter for them, unknown consent and transport `tracker-list`. A listed vendor is a valid `vendor:` key in the scenario, and its requests are not flagged as `unknownDestination`. A request that a built-in decoder matches stays with that decoder. The file is read before the scenario, and a bad file exits 2.

First-party hosts: the registrable domain of `--site` is first party, so `--site https://www.shop.co.uk` does not flag `shop.co.uk` or `*.shop.co.uk` as `unknownDestination`. Data-carrying requests to those subdomains that no decoder matches are listed as `firstPartySubdomain` and do not fail the run. IP addresses and `localhost` are first party only as the exact `--site` host. Scenario options:

| Option | Meaning |
| --- | --- |
| `cartRequest` | Regular expression matched against request URLs. In an `addToCart` step, a matching request counts as a cart change, for a site whose cart endpoint the built-in check does not know. |
| `firstPartyHosts` | List of hosts or `*.domain` wildcards that are also first party, for example `['i.guim.co.uk', '*.shopifycdn.com']`. A wildcard matches subdomains, not the bare domain. |
| `unloadGapIgnore` | List of dataLayer event names or `*` globs, for example `['consent_*']`, that the `unloadGap` warning never reports. Use it for custom events that are not meant to produce a hit. |
| `serverHosts` | List of hosts or `*.domain` wildcards for `--network server`. Collection requests to them pass through, and every other one is still stubbed. A host other than `localhost`, `127.0.0.1` or `::1` prints a warning on stderr. A wildcard on a public suffix (`*.com`), a vendor host (Google, Meta, Pinterest) and a tracker-list host are scenario errors. `server` mode without `serverHosts` exits 2. A `pagehide` or `visibilitychange` send to a server host is answered in the page, so the cookies it would set are not seen. A passing cookie rule in `server` mode can miss them. |
| `allowUnknownDestination` | `true` allows every unknown destination. A list of hosts or wildcards allows only those, and every other unknown destination still fails. |
| `builtins` | Severity per built-in check: `fail` (the default) or `warn`. The names are `unknownDestination`, `sandboxPageUrl`, `possibleRealData` and `deniedIdentifiers`. Any other name or severity is a scenario error. See [Exit codes](#exit-codes). |
| `identifierFields` | List of field names or `*` globs, for example `['visitor_key', 'x_*']`, that `deniedIdentifiers` treats as analytics identifiers, matched against the field names of each hit. |

Locators: `click` and `wait` take a selector string, or a mapping:

```yaml
- click: { role: radio, name: "White (01)" }
- click: { any: ['[role=radio][title$="White (01)"]', 'text=White (01)'] }
- wait: { role: button, name: "Add to cart" }
```

`role` and `name` are Playwright's `getByRole(role, { name })`. `exact: true` (with a `name`) matches the whole name. `any` is a list of selectors. The step uses the first one that matches an element within the step timeout, and the step record stores its position in `locator` (the step label is not changed). `any` cannot be combined with `role`. `fill`, `select` and `addToCart` take selector strings only. When a `click` or `wait` times out, the error lists up to ten buttons, radios, checkboxes, links, tabs and options on the page, as role and accessible name cut at 60 characters, for example `Controls on the page: button "White (01)", button "Black (02)".` The names are accessible names from the accessibility tree, and for a button or link that is usually its visible text. No other page text and no form value is listed. A name that is an email, has a run of 6 or more digits or looks like a hash is printed as `(hidden)`. No list is made while a handoff is waiting.

`select` chooses an option of a `<select>`: `select: { "select[name=countryCode]": DE }`. It matches the option value first, then the option label. Quote a number (`"01"`), because YAML drops leading zeros and the step is refused otherwise. After the change it reads the select back. If the option is not selected, the step fails with `value not applied (still: <option label>)`. A select that is a card field (for example `autocomplete=cc-exp-month`) fails with the same handoff message as `fill` on a site that is not on this machine. The chosen option value and label join the run identity as extra values under the rule below, so a hashed country can match in `identity.hashesMatch`. `fill` on a select still works as before.

Run identity: a run has a seeded fake identity (name, email, phone, address). In `fill`, a value that is an identity field name (`email`, `firstName`, `lastName`, `phone`, `address1`, `city`, `zip`, `country`) types the generated value. Any other value is typed as written, and it joins the run identity as an extra value. Its hash is then not reported as `possibleRealData`, and it can match a hashed name or address value in `identity.hashesMatch`, for example a city such as `Berlin` that the generated address cannot replace. An extra value never matches a hashed email or phone. A value joins the run identity only after it is typed into a field that is not a card or password field, whatever the selector: Pingwright checks the field when it fills it. If the run stops before that, the value is not in the run record. A scenario can also set identity fields itself with a top-level `identity` key. It replaces the generated value, so `fill` and `identity.hashesMatch` use it:

```yaml
identity:
  phone: "+46701740620"
```

Use fictional numbers and `example.com` emails only. A phone number inside one of these ranges set aside for fiction gets no warning, and any other number does:

- US: 555-0100 to 555-0199, from [NANPA](https://www.nationalnanpa.com/).
- Sweden: 070-174 06 05 to 070-174 06 99, from [PTS](https://pts.se/).
- UK, from the [Ofcom drama numbers](https://www.ofcom.org.uk/phones-and-broadband/phone-numbers/numbers-for-drama): 07700 900000 to 900999, 020 7946 0000 to 0999, 01632 960000 to 960999, and 0xxx 496 0000 to 0999 for Leeds, Sheffield, Nottingham, Leicester, Bristol, Reading, Birmingham, Edinburgh, Glasgow, Liverpool and Manchester.

The warning covers numbers written as `+` and digits, and the common US shapes. Values that a person types during a `handoff` step are unknown to Pingwright. To have them count as the run identity, declare the same value under `identity`, or the run reports their hashes as `possibleRealData`.

`identity.hashesMatch` reads hashed email and phone values from Meta, Pinterest and from the server container's data client (`sgtm`). On an `sgtm` hit it reads `user_data` (`email_address`, `phone_number`, `first_name`, `last_name`, `street`, `city`, `postal_code`, `country`, at the top level or under `address`) and shows each as the hit param `user_data.<field>`.

`identity.hashesMatch` cannot be in the same entry as `body.has` or `body.only`. Use two entries.

On an sgtm hit, every hashed user_data field that the hit sends must match the run identity, not only email and phone. On any other vendor's hit (Meta, Pinterest), only the hashed email and phone are checked. A field that the hit sends empty, or does not send, is skipped. A city, postal code or country sent as plain text is skipped, because Google's user data format allows that. If one field is wrong, the rule fails, and the message names the hit params that do not match and the fields that do, for example `Not matching: user_data.country. Matching: email, first name and last name.` A site can add a value that the scenario did not type, such as the country of its default market. Declare that value under `identity`, for example `identity: { country: SE }`, so that its hash matches.

To withdraw consent, reopen the banner with a `click` on the site's cookie settings link, then answer it with `consent: reject` (`consent: withdraw` is the same answer). Without the click the step fails with "banner not shown (withdraw needs the banner reopened first)".

```yaml
steps:
  - consent: accept
  - click: "#pw-cookie-settings"
  - consent: withdraw
```

`addToCart` clicks the selector and then needs proof that the cart changed: a cart request, or an `add_to_cart` dataLayer event. Cart requests it knows are a Shopify POST to `/cart/add`, `/cart/change` or `/cart/update` and a GET of `/cart/add?id=`, a POST to `/cart` (Hydrogen), Magento `/checkout/cart/add/...`, WooCommerce `?wc-ajax=add_to_cart` and a Storefront `cartCreate` or `cartLinesAdd` mutation. A request counts once its response arrived with a 2xx or 3xx status (a form POST often answers with a redirect). A request that is still pending, failed or got a 4xx or 5xx response does not count. Without proof the step fails with "click did not add to cart", for example when the click only opened a variant picker. For a cart endpoint it does not know, set the `cartRequest` option, or use a plain `click` step, which checks nothing. Through the library, `cartCheck` and `cartTimeoutMs` in the play options replace the check and the 5 s wait.

A `handoff` step waits for a person. In the headed window a small pill with the handoff text and a **Done** button sits in a corner of the top document. Click Done, or press Enter in the terminal: the first of the two ends the wait. The pill is a closed shadow root on one element, `#pingwright-handoff`, installed by a context init script. It is not drawn in sandboxed iframes, it survives navigations during the handoff, and it makes no network request. While the wait lasts, the terminal prints `Still waiting for the handoff: <text>` every 60 seconds. The host is a child of `<html>`, a sibling of `<body>`, and its styles are inline with `!important`, so `body { display: none }` does not hide it. The pill is part of the page, so a page can still hide it (a script that edits the element, or a rule such as `html { display: none }`), and a capture-phase listener on `window` or `document` sees a click on it. Enter in the terminal is the fallback when the pill is hidden.

During a `handoff` step, requests that are not tracking hits are stored without their body and query values (`redacted: handoff`), so passwords typed by the person are not kept. For those requests the query values of the frame URL and of the `Referer` and `Origin` headers are redacted too. Later requests that are not redacted keep the page URL as it is.

Payments and log-ins are handoff steps on any host other than `localhost`, `127.0.0.1` or `::1`. Filling a card or password field on another host fails the run.

A `host:` rule in `expect` matches the request's host with its port (`127.0.0.1:4173`) or its bare hostname (`127.0.0.1`). It is an exact, case-sensitive match on one of these forms. An IPv6 host may be written with or without brackets (`::1`, `[::1]`, `[::1]:4173`). `ids.hashes` matches a hit with any hashed ID present, and `ids.hashes.<param>` and `ids.hashes.<param>.matchesIdentity` read one hashed parameter. Any other name under `ids.hashes` is a scenario error. A `possibleRealData` failure lists the first five findings and a count of the rest.

### Rules on payload fields

`body.has`, `body.only` and `body.ignore` check which fields a hit sent. They read the names of the non-empty fields in the whole decoded payload: the query string, a JSON or form body, and the decoded `dtdc` object. The keys are called `body.*` even so. Only names are read and shown. A value never appears in a rule, a message or the evidence.

```yaml
expect:
  mustNot:
    - { vendor: sgtm, body.has: [email, phone, "user_data.*", "cookie*"], in: epoch(denied) }
  must:
    - { vendor: sgtm, event: page_view, body.only: [event_name, page_location, page_title, page_referrer] }
```

- `body.has` is a list of field names. A hit matches when it has any of them. Nested names use dots (`user_data.email_address`) and array items collapse to `[]` (`items[].price`). A name may use `*` for zero or more characters, so `cookie*` matches `cookie` and `cookie_data`. The other keys of the entry (`vendor`, `event`, `in`, `before`, `after`, `count` and so on) select the hits first.
- `body.only` is an allowlist. It is not part of the match. The other keys select the hits, and the entry fails if any selected hit has a field outside the list and outside the default ignore list of its vendor. This holds under `must` and under `mustNot`. Under `must`, no selected hit (or too few for `count`) also fails. The message names the hit and the fields, for example `hit_x has fields outside body.only: email, phone (2 of 14)`.
- `body.ignore` adds names to the ignore list of one `body.only` entry. It is only valid with `body.only`.
- Each is a non-empty list of names of at most 64 characters. `body.has` and `body.only` cannot be in the same entry. Anything else is a scenario error with a line number.
- A rule without these keys never reads fields.

A rule that cannot see the whole payload does not pass. If a selected hit has no recorded field names (a record from before schema version 2), the result is `cannot evaluate: field names not recorded`. If a selected hit has a body that was cut at 64 KiB, or a JSON body that did not parse, the result is `cannot evaluate: body not fully recorded`. This applies to `must` and `mustNot` alike, unless a field that is visible already decides the rule (a listed field in a cut body is a plain failure). The result carries `note: fieldsNotRecorded` or `note: cannotEvaluateBody`.

Default ignore lists for `body.only`, by vendor of the hit. A vendor that is not listed has no default list. A name may use `*`.

| Vendor | Ignored fields |
| --- | --- |
| `ga4` | `v`, `tid`, `gtm`, `_p`, `_s`, `sid`, `sct`, `seg`, `dl`, `dr`, `dt`, `en`, `cid`, `ul`, `sr`, `_eu`, `_et`, `gcs`, `gcd`, `npa`, `dma`, `dma_cps`, `are`, `frm`, `pscdl`, `tfd`, `ec`, `uaa`, `uab`, `uafvl`, `uam`, `uamb`, `uap`, `uapv`, `uaw`, `_ss`, `_fv`, `_nsi`, `_c`, `_ee`, `_z`, `_gaz`, `tag_exp`, `_tu`, `ngs` |
| `meta` | `id`, `ev`, `dl`, `rl`, `if`, `ts`, `sw`, `sh`, `v`, `r`, `ec`, `o`, `fbp`, `it`, `coo`, `rqm`, `ler`, `cdl`, `plt`, `pmd[*]`, `expv2[*]`, `cs_est`, `a` |
| `sgtm` | `v`, `tid`, `event`, `en`, `dtdc` |

The lists are exported from `@pingwright/decoders` as `GA4_BODY_ONLY_IGNORE`, `META_BODY_ONLY_IGNORE` and `SGTM_BODY_ONLY_IGNORE`.

### Rules on cookies

`cookie` checks which cookies were set, by name. A value is never read, recorded or shown.

```yaml
expect:
  mustNot:
    - { cookie: _dcid, before: consent }
    - { cookie: "_ga*", in: epoch(denied) }
  must:
    - { cookie: pw_consent, in: epoch(granted) }
```

- `cookie` is a name or a glob (`*` matches zero or more characters, so `_ga*` matches `_ga` and `_ga_PWTEST`), or a list of them. Names of at most 64 characters.
- The entry stands alone. It takes `before: consent`, `in: epoch(...)` and `after: <step label>` as a hit rule does, and nothing else. `vendor`, `event`, `count`, `body.*` and the other hit keys are scenario errors.
- Two sources count. A `Set-Cookie` header on any response, from any host, is placed at its request's time, and the evidence is that request ID. A cookie in a checkpoint (set by a script, or earlier) is placed at the checkpoint's time and the evidence is the checkpoint ID. A checkpoint only shows that the cookie was present then, not when it was set, and the message says so. To test a script cookie before consent, add a `checkpoint` step before the consent step. When a header and a checkpoint show the same name, the result cites the request.
- A time is placed in an epoch like a hit's, with the same grace window. A cookie set less than the grace window before the consent answer counts after it. Wait before the consent step when a test depends on it.
- A rule with `before`, `in` or `after` that matches a checkpoint without a time (a record from before 0.3) cannot be placed. The result is `cannot evaluate` and never passes.
- Cookie names are guarded like field names: a name that looks like a value is shown as `(other)`.

In `stub` mode a stubbed endpoint sets no cookies. A cookie rule can pass for that reason, so a passing result in `stub` mode ends with `stub mode: stubbed endpoints set no cookies` and has `note: stubNoCookies`. To see the cookies of a server container, run with `--network server` and list its host in `options.serverHosts`, or use `--network live`. In `server` mode a send from `pagehide` or `visibilitychange` to a server host is still answered in the page, so a cookie that such a send would set is not seen, and a passing cookie rule can miss it.

### GTM override

`--gtm-override <file>` takes JSON with the values of a GTM preview. Pingwright never calls the GTM API, so you supply them.

```json
{"container": "GTM-XXXXXXX", "gtmAuth": "…", "gtmPreview": "env-12", "expectedTags": [{"id": "45", "name": "GA4 - Purchase"}]}
```

`container` must match `^GTM-[A-Z0-9]+$`. `expectedTags` is stored in the run record and not evaluated yet.

When the page requests `https://www.googletagmanager.com/gtm.js?id=<container>`, Pingwright fetches `gtm.js?id=<container>&gtm_auth=<gtmAuth>&gtm_preview=<gtmPreview>&gtm_cookies_win=x` and answers the page with that build. The page's own request URL is not changed. If the page's request has `l=<name>` (a data layer that is not `dataLayer`) or `gtm_debug`, they are copied to the preview fetch. The override applies to that run in the test browser only. It applies when the page loads the container script itself, and when a Stape-style custom loader fetches it. In the loader case the loader script stays in place and its request is answered with the preview build; the record says `way: "loader"`. A real Stape custom loader script has a URL like `https://load.<sgtm host>/<random>.js?<key>=<obfuscated>`, and nothing in the URL names the container. For a cross-origin script request with a `.js` path and a query to the site's registrable domain or a `firstPartyHosts` host (on a loopback site, loopback hosts only), Pingwright fetches the script and, if its body holds the container ID, answers with the preview build instead. The record says `way: "loader"`, with a `loses` note, because the loader script is replaced. Query values are never listed in messages, since they may hold per-site keys. That fetch runs in Playwright's request client, not Chromium, so it uses the Playwright cookie jar and stores any `Set-Cookie` from the script response. A script that answers with a redirect is not fetched further: Chromium follows it, and a hop to a collection endpoint is stubbed or flagged `stubBypass` as usual. Scripts on other hosts are left to Chromium. Scripts served from the site's own origin are neither sniffed nor listed.

To replace a loader yourself, add `"loader": {"replace": "<script URL>"}` to the override file. The request for exactly that URL is then answered with the preview build, and the record says `way: "replace"`, with a `loses` note. To reuse one rule across stores, add `"loader": {"match": "<regex>"}` instead: any script request (resource type `script` only) whose URL matches the regular expression is answered the same way and recorded as `way: "replace"`. On the replace way, `l` and `gtm_debug` are copied only if the replaced script URL carries them. Each match is listed in `run.gtmOverride.applied` as `{way, url, status}`. Passing `gtm_auth` and `gtm_preview` through the loader is not built. Pingwright also sniffs unknown loader scripts for the container ID, but only when the override file has no `loader` key.

The run fails with exit 2 if no request matched ("no container request matched"; the message lists the cross-origin script URLs it checked, without query values, and suggests `loader.replace` or `loader.match`), or if the preview fetch did not return 200, or if `loader.replace` is set and the page never requested that URL. A 404 usually means the environment has no version. The JSONL is still written, and `run.gtmOverride.applied` lists each match with its status.

The `gtmAuth` value is removed from the record and from all output, in any form: plain, URL-encoded, or inside nested URL-encoding and base64 layers, up to 8 layers (each URL-decode, base64 decode or query-value step counts as one). A base64 value glued to unseparated text, such as `abc<base64>xyz`, may not be decoded. A request URL parameter, a request body, a result record, a step error or any other string that holds it in any decoded form becomes `[redacted]`. The record keeps `gtmAuth: "[redacted]"`.

Tests can set `PINGWRIGHT_TEST_GTM_ORIGIN` to a loopback origin (`http://localhost`, `http://127.0.0.1` or `http://[::1]`, with an optional port, and no path) to fetch every `gtm.js` from there instead of from `www.googletagmanager.com`. Any other value is an error. The run records it as `testGtmOrigin` and the CLI prints a warning. It is not read from the scenario or the override file.

### `pingwright diff <a.jsonl> <b.jsonl>`

Compares two runs of the same scenario, for example one with a GTM override and one without. It does not open a browser.

| Option | Meaning |
| --- | --- |
| `--by-page` | Adds the page path to the key that pairs hits, so the same event on two pages is compared page by page. For a Shopify custom pixel the `/web-pixels@<hash>/.../sandbox/<mode>` prefix is stripped from the key, so runs on different Shopify deploys still pair. The record keeps the raw page. Added and removed lines show it as `recorded as <page>` when it differs from the key, and the JSON result has it as `page` on each added, removed and changed hit. A hit with no page uses the URL of the frame that sent it, or an empty page if there is none. |
| `--all-flags` | Shows flag count changes for hosts the scenario allows with `allowUnknownDestination`. They are hidden by default, because platform telemetry hosts often change by one between identical runs, and the summary says how many it hid. The JSON result always has them, with `allowed: true`. |
| `--json` | Prints the full diff result as JSON instead of the text summary. |

The text summary is grouped by consent epoch label, then vendor, then event. Under each event it lists hits that were added (only in the second run), removed (only in the first), and changed. A changed hit is one that pairs up but differs in a consent field, in `gcs` or `gcd`, or in whether an ID is present. Hits are paired by epoch label, vendor and event (and the page path with `--by-page`), in time order: the first hit of a group in one run with the first in the other, and so on. The step is not part of the match, so a hit that lands in a different step in the two runs still pairs. Each line shows the step of the hit. A changed line shows `step "a" -> "b"` when the step differs, and with `--by-page` it shows `recorded as <page a> -> <page b>` when either raw page differs from the key. A hit left over in a group after pairing is reported as added or removed. When a group has a different number of hits in the two runs, its event also gets a line such as `count 2 -> 1 (pairing by order)`, which with `--by-page` also shows the page, because the pairing may then match the wrong hits. A line at the end lists flag counts that changed per host.

Exit codes: `diff` exits 0 whether or not the runs differ. A file that is missing, is not JSONL, or does not start with a `run` record exits 2 with a message that names the file. A run record with a newer schema version than Pingwright knows prints a warning and the diff goes on. A file whose last line is cut off (a crashed run) is read up to that line, and the diff prints a warning that names the file and the line.

### `pingwright suite <dir> --site <url>`

Runs every scenario in a directory, once for each GTM build you name, and prints one table. It reads `*.yml` and `*.yaml` files in `<dir>` (not subdirectories). Every file is parsed first. If one is not a valid scenario, the command lists the problems and exits 2 before a browser opens.

```bash
pingwright suite scenarios/ --site https://staging.example.com \
  --variant published --variant workspace=override.json
```

| Option | Meaning |
| --- | --- |
| `--site <url>` | The site to test. Required. |
| `--variant <name[=file]>` | A GTM build to test. Can be repeated. `published` means no override and takes no file. `name=file` serves an override file in the `--gtm-override` format. The name matches `^[a-z0-9][a-z0-9_-]*$`, and a name given twice exits 2. Default: `published`. |
| `--with-handoff` | Also runs scenarios that have a `handoff` step, after all others, in a headed window with a person at each handoff. Without it they are `SKIPPED`, which counts as a pass. |
| `--network`, `--out`, `--seed`, `--var`, `--tracker-list`, `--autoconsent-rules`, `--json` | As in `run`. `--gtm-override`, `--headed` and `--net-log` are not options of `suite`. A `--var` that no scenario declares exits 2. |

The runs go one after another, with one browser at a time. The variants of one scenario use the same seed, so they have the same fake identity. Output goes to `<out>/suite_<id>/`: one record per run, named `<scenario>.<variant>.jsonl` (each has `Run.variant` set), and the manifest `suite.json`. The manifest has the site origin, the variants, one cell per scenario and variant with its status, exit code and record file name, and the diff counts. It holds no path, no query value, no override file path and no run message.

When a scenario has two or more variants, the suite compares the first variant with each other one, with the same engine as `diff`. The table shows the counts per pair:

```
scenario        published   workspace   diff (published -> workspace)
checkout        PASS        FAIL        +1 added, 1 changed
consent-reject  PASS        PASS        no change
checkout-pay    SKIPPED     SKIPPED
```

A difference between variants is not a failure. Your rules decide. A run that exits 2 (for example, the banner was not shown) shows `ERROR` and does not stop the suite. The suite's exit code is the worst cell, in this order: 2, then 1, then 0. With `--json`, stdout is the manifest instead of the table.

### `pingwright report <run.jsonl | suite dir> --html <out.html>`

Writes one HTML file that people can read without knowing JSONL. It opens no browser and reads no network. `--html` is required, and the command refuses to overwrite its own input. A missing file, or a file that is not a run record, exits 2, as `diff` does.

The input is one record, or a suite directory from `suite`. A suite directory needs its `suite.json`. A record that the manifest names and that is missing becomes a warning in the page.

A run report has these parts:

- **Header.** Scenario, variant, run ID, date, network mode, site host, Pingwright version and record schema version.
- **Timeline per vendor.** One row per vendor and one segment per consent epoch, each with a mark and a hit count. The mark also has a text label, so it reads without colour.
- **Expectations.** Each result as PASS, WARN, FAIL or CANNOT EVALUATE, with the rule's key names, the severity and up to five evidence IDs.
- **Flags** and **fields.** The flag kinds with counts and hosts, and the field names seen on denied hits.

A suite report has a header with the variants and the exit code, a results table, a diff section per variant pair, and the run sections for each scenario and variant.

The marks, worst first:

| Mark | Meaning |
| --- | --- |
| `leak` | A hit that `deniedIdentifiers` flags, or that is in the evidence of a failed `deniedIdentifiers` result at either severity, or of a failed `mustNot` with a consent scope (`in: epoch(denied)`, `in: epoch(withdrawn)`, `before: consent` or a `consent.<field>: denied` filter). A failed `mustNot` with no consent scope does not mark a hit. |
| `unchecked` | A hit with a denied signal whose body was not fully recorded, or that has identifier names whose own consent signal is not denied. Pingwright cannot call it clean. |
| `mixed` | Granted and denied hits in one segment, or a hit with some signals granted and some denied. |
| `full` | Hits with consent granted. A hit with unknown consent before the first answer also shows `full`, with the label "before an answer". |
| `ping` | Hits sent while consent is denied, with no identifier names recorded. `cid`, `fbp` and click IDs are not identifiers here. |
| `nothing` | No hit. |

Only names and counts are shown: no request URL, query value, body, page path, cookie value, hash, identity value or result message. A result's `note` is shown as a fixed sentence, for example "stub mode: stubbed endpoints set no cookies, so this pass says nothing about server cookies". A scenario's `params`, `ids` and `page` keys show their names and never their values. Every string from the records is escaped. The file has no script, no link, no image and no font, one inline style and a `Content-Security-Policy` meta tag. It does not claim that a site complies with a law.

```bash
pingwright report runs/run_<id>.jsonl --html report.html
pingwright report runs/suite_<id> --html suite-report.html
```

`report` for a record from before schema version 2 shows `not recorded` where field names are missing.

### `pingwright install-browser`

Installs Chromium with the Playwright version Pingwright depends on.

### `pingwright --version`

Prints the version.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every expectation and built-in check passed, or failed only as a `warn` check. |
| 1 | At least one expectation or built-in check failed. |
| 2 | Usage error, invalid scenario, or the run failed (for example the banner was not shown, or a card field was filled on a non-loopback host). If Chromium is missing, the message says to run `pingwright install-browser`. |

The JSONL file is still written when a step fails, up to the failing step.

A built-in check can be set to `warn` with `options.builtins`. A warned check still runs. Its `result` record keeps the evidence and has `severity: "warn"`. The text summary shows it as `WARN` with its message. It does not change the exit code. `expect` rules are not affected. Use it for a failure you accept, such as `sandboxPageUrl` on a Shopify custom pixel, so that a clean run exits 0 in CI:

```yaml
options:
  builtins: { sandboxPageUrl: warn }
```

The `--json` summary has `severity` on each built-in result. `pass` is true when every result passed, warnings included. `ok` is true when the exit code is 0, so a CI script can read `ok`.

A CI job can gate on the exit code, or on `ok` in the `--json` summary:

```bash
pingwright run checkout.yml --site https://staging.example.com
pingwright run checkout.yml --site https://staging.example.com --json | jq -e .ok
```

### deniedIdentifiers

The `deniedIdentifiers` check fails when a hit carries an identifier field while the consent signal for that field's class is denied. It reads the field names that the decoders record in `Hit.idFields`. It never reads or prints a value. Google hits (`ga4`, `google-ads`) are judged by their own `gcs` and `gcd`. Every other hit, a server hit included, is judged by the consent epoch it falls in. An unknown signal is not flagged.

| Class | Field names | Signal that must not be denied |
| --- | --- | --- |
| Analytics id | `user_id`, `uid`, `up.user_id`, any other field with a 64-character hex value, and the names in `identifierFields` | `analytics` |
| Ads identity | `external_id`, `ud`, `ud[*]`, `user_data`, `user_data.*`, `em`, `ph`, `hashed_email`, `customer_hashed`, `cookieData` | `adUserData`, or `ads` when `adUserData` is unknown (Google hits with `gcs` but no `gcd`, and hits in an epoch that has no `adUserData`) |
| Client-ID hash | `clientIdHash`, `client_id_hash`, `cid_hash` | `analytics` |

These are not flagged on purpose: `cid`, `client_id`, `_ga`, `fbp`, `fbc` and `gclid`. GA4 cookieless pings carry a random `cid`.

The result lists vendor, field names and the denied signal, and its evidence is the hit IDs. If a hit sent while consent is denied has no recorded field names (a version 1 record) or a body that was cut, the check reports `cannot evaluate` and fails, with `note` set to `fieldsNotRecorded` or `cannotEvaluateBody`. The same holds for a denied hit whose body was not fully recorded: cut at 64 KiB, JSON that did not parse, or a `--net-log` hit, which has no body.

Upgrading to 0.3 can change exit codes. The check is `fail` by default, like the other built-in checks, so a run that sent a hashed custom parameter on a denied hit now exits 1. To keep the old exit code while you fix it, set the check to `warn`:

```yaml
options:
  builtins: { deniedIdentifiers: warn }
```

