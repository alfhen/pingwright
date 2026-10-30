# CLI

## Install

```bash
npm i -g pingwright@next
pingwright install-browser
```

`@next` is the newest release candidate. Pingwright needs Node 22.18 or later.

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
| `--network stub\|live` | `stub` (default) answers known collection endpoints locally. `live` lets every hit through and warns on stderr that hits reach real vendor accounts. Overrides `options.network` in the scenario. |
| `--out <dir>` | Directory for the record, `runs` by default. The file is `<dir>/run_<id>.jsonl`. |
| `--seed <n>` | Seed for the fake identity. Overrides `options.seed`. |
| `--headed` | Show the browser window. Scenarios with a `handoff` step are always headed. |
| `--net-log` | Launches Chromium with `--log-net-log` and records collection requests that a frame sends while it unloads, which no browser hook reports. They carry `captured: "netlog"` and no body. Needs `--network live`: the command refuses it in `stub` mode with exit code 2, because those requests would leave the machine. Off by default. See design §5.3. |
| `--autoconsent-rules <file>` | Extra autoconsent rules. Can be repeated. |
| `--gtm-override <file>` | Runs the page against an unpublished GTM workspace build. See below. |
| `--tracker-list <file>` | Adds tracker entries to the built-in list. See below. |
| `--var <k=v>` | Overrides a variable the scenario declares under `vars`. A name the scenario does not declare exits 2. Can be repeated. |
| `--json` | Prints a JSON summary on stdout instead of the text summary. |

`pingwright run --help` prints this command's own help.

The text summary lists hits per vendor and event, consent epochs, flags (`unknownDestination` and `firstPartySubdomain` grouped by host, and `sandboxPageUrl` grouped by vendor, each with a count and up to three example paths; the `--json` summary keeps every flag), each expectation with PASS or FAIL (failures show the message; every expectation shows up to five evidence IDs and a count of the rest), and the path of the JSONL file. The `result` records are appended to that file.

Tracker list: `--tracker-list <file>` takes a JSON array of `{ "vendor", "host", "paths"?, "source" }` entries, with the same checks as the built-in list. `vendor` is a lowercase key that is not a built-in decoder key (`ga4`, `google-ads`, `meta`, `pinterest`, `sgtm`), `host` is an exact host or `*.domain`, `paths` are path prefixes and `source` is an https link to the vendor's docs. In `stub` mode, a request to a listed path is stubbed for every resource type, and a request to a listed host without paths is stubbed unless it is a script, stylesheet, font or document load. A whole-host image or other request with no query and no body is stubbed but gives no hit. Each other such request becomes a minimal hit with the entry's vendor, the event and page when the URL has a common parameter for them, unknown consent and transport `tracker-list`. A listed vendor is a valid `vendor:` key in the scenario, and its requests are not flagged as `unknownDestination`. A request that a built-in decoder matches stays with that decoder. The file is read before the scenario, and a bad file exits 2.

First-party hosts: the registrable domain of `--site` is first party, so `--site https://www.shop.co.uk` does not flag `shop.co.uk` or `*.shop.co.uk` as `unknownDestination`. Data-carrying requests to those subdomains that no decoder matches are listed as `firstPartySubdomain` and do not fail the run. IP addresses and `localhost` are first party only as the exact `--site` host. Scenario options:

| Option | Meaning |
| --- | --- |
| `cartRequest` | Regular expression matched against request URLs. In an `addToCart` step, a matching request counts as a cart change, for a site whose cart endpoint the built-in check does not know. |
| `firstPartyHosts` | List of hosts or `*.domain` wildcards that are also first party, for example `['i.guim.co.uk', '*.shopifycdn.com']`. A wildcard matches subdomains, not the bare domain. |
| `unloadGapIgnore` | List of dataLayer event names or `*` globs, for example `['consent_*']`, that the `unloadGap` warning never reports. Use it for custom events that are not meant to produce a hit. |
| `allowUnknownDestination` | `true` allows every unknown destination. A list of hosts or wildcards allows only those, and every other unknown destination still fails. |
| `builtins` | Severity per built-in check: `fail` (the default) or `warn`. The names are `unknownDestination`, `sandboxPageUrl` and `possibleRealData`. Any other name or severity is a scenario error. See [Exit codes](#exit-codes). |

Run identity: a run has a seeded fake identity (name, email, phone, address). In `fill`, a value that is an identity field name (`email`, `firstName`, `lastName`, `phone`, `address1`, `city`, `zip`, `country`) types the generated value. Any other value is typed as written, and it joins the run identity as an extra value. Its hash is then not reported as `possibleRealData`, and it can match a hashed name or address value in `identity.hashesMatch`, for example a city such as `Berlin` that the generated address cannot replace. An extra value never matches a hashed email or phone. Values typed into card and password fields are not added. A scenario can also set identity fields itself with a top-level `identity` key. It replaces the generated value, so `fill` and `identity.hashesMatch` use it:

```yaml
identity:
  phone: "+46701740620"
```

Use fictional numbers and `example.com` emails only. Values that a person types during a `handoff` step are unknown to Pingwright. To have them count as the run identity, declare the same value under `identity`, or the run reports their hashes as `possibleRealData`.

`identity.hashesMatch` reads hashed email and phone values from Meta and from the server container's data client (`sgtm`). On an `sgtm` hit it reads `user_data` (`email_address`, `phone_number`, `first_name`, `last_name`, `street`, `city`, `postal_code`, `country`, at the top level or under `address`) and shows each as the hit param `user_data.<field>`.

To withdraw consent, reopen the banner with a `click` on the site's cookie settings link, then answer it with `consent: reject` (`consent: withdraw` is the same answer). Without the click the step fails with "banner not shown (withdraw needs the banner reopened first)".

```yaml
steps:
  - consent: accept
  - click: "#pw-cookie-settings"
  - consent: withdraw
```

`addToCart` clicks the selector and then needs proof that the cart changed: a cart request, or an `add_to_cart` dataLayer event. Cart requests it knows are a Shopify POST to `/cart/add`, `/cart/change` or `/cart/update` and a GET of `/cart/add?id=`, a POST to `/cart` (Hydrogen), Magento `/checkout/cart/add/...`, WooCommerce `?wc-ajax=add_to_cart` and a Storefront `cartCreate` or `cartLinesAdd` mutation. A request counts once its response arrived with a 2xx or 3xx status (a form POST often answers with a redirect). A request that is still pending, failed or got a 4xx or 5xx response does not count. Without proof the step fails with "click did not add to cart", for example when the click only opened a variant picker. For a cart endpoint it does not know, set the `cartRequest` option, or use a plain `click` step, which checks nothing. Through the library, `cartCheck` and `cartTimeoutMs` in the play options replace the check and the 5 s wait.

During a `handoff` step, requests that are not tracking hits are stored without their body and query values (`redacted: handoff`), so passwords typed by the person are not kept. For those requests the query values of the frame URL and of the `Referer` and `Origin` headers are redacted too. Later requests that are not redacted keep the page URL as it is.

Payments and log-ins are handoff steps on any host other than `localhost`, `127.0.0.1` or `::1`. Filling a card or password field on another host fails the run.

A `host:` rule in `expect` matches the request's host with its port (`127.0.0.1:4173`) or its bare hostname (`127.0.0.1`). It is an exact, case-sensitive match on one of the two forms. `ids.hashes` matches a hit with any hashed ID present, and `ids.hashes.<param>` and `ids.hashes.<param>.matchesIdentity` read one hashed parameter. Any other name under `ids.hashes` is a scenario error. A `possibleRealData` failure lists the first five findings and a count of the rest.

### GTM override

`--gtm-override <file>` takes JSON with the values of a GTM preview. Pingwright never calls the GTM API, so you supply them.

```json
{"container": "GTM-XXXXXXX", "gtmAuth": "…", "gtmPreview": "env-12", "expectedTags": [{"id": "45", "name": "GA4 - Purchase"}]}
```

`container` must match `^GTM-[A-Z0-9]+$`. `expectedTags` is stored in the run record and not evaluated yet.

When the page requests `https://www.googletagmanager.com/gtm.js?id=<container>`, Pingwright fetches `gtm.js?id=<container>&gtm_auth=<gtmAuth>&gtm_preview=<gtmPreview>&gtm_cookies_win=x` and answers the page with that build. The page's own request URL is not changed. If the page's request has `l=<name>` (a data layer that is not `dataLayer`) or `gtm_debug`, they are copied to the preview fetch. The override applies to that run in the test browser only. It applies when the page loads the container script itself, and when a Stape-style custom loader fetches it. In the loader case the loader script stays in place and its request is answered with the preview build; the record says `way: "loader"`. A real Stape custom loader script has a URL like `https://load.<sgtm host>/<random>.js?<key>=<obfuscated>`, and nothing in the URL names the container. For a cross-origin script request with a `.js` path and a query to the site's registrable domain or a `firstPartyHosts` host (on a loopback site, any loopback host), Pingwright fetches the script and, if its body holds the container ID, answers with the preview build instead. The record says `way: "loader"`, with a `loses` note, because the loader script is replaced. Query values are never listed in messages, since they may hold per-site keys. That fetch runs in Playwright's request client, not Chromium, so it uses the Playwright cookie jar and stores any `Set-Cookie` from the script response. A script that answers with a redirect is not fetched further: Chromium follows it, and a hop to a collection endpoint is stubbed or flagged `stubBypass` as usual. Scripts on other hosts are left to Chromium. Scripts served from the site's own origin are neither sniffed nor listed.

To replace a loader yourself, add `"loader": {"replace": "<script URL>"}` to the override file. The request for exactly that URL is then answered with the preview build, and the record says `way: "replace"`, with a `loses` note. To reuse one rule across stores, add `"loader": {"match": "<regex>"}` instead: any script request (resource type `script` only) whose URL matches the regular expression is answered the same way and recorded as `way: "replace"`. Each match is listed in `run.gtmOverride.applied` as `{way, url, status}`. Passing `gtm_auth` and `gtm_preview` through the loader is not built.

The run fails with exit 2 if no request matched ("no container request matched"; the message lists the cross-origin script URLs it checked, without query values, and suggests `loader.replace` or `loader.match`), or if the preview fetch did not return 200, or if `loader.replace` is set and the page never requested that URL. A 404 usually means the environment has no version. The JSONL is still written, and `run.gtmOverride.applied` lists each match with its status.

The `gtmAuth` value is removed from the record and from all output, in any form: plain, URL-encoded, or inside nested URL-encoding and base64 layers, up to 8 layers (each URL-decode, base64 decode or query-value step counts as one). A base64 value glued to unseparated text, such as `abc<base64>xyz`, may not be decoded. A request URL parameter, a request body, a result record, a step error or any other string that holds it in any decoded form becomes `[redacted]`. The record keeps `gtmAuth: "[redacted]"`.

Tests can set `PINGWRIGHT_TEST_GTM_ORIGIN` to a loopback origin (`http://localhost`, `http://127.0.0.1` or `http://[::1]`, with an optional port, and no path) to fetch every `gtm.js` from there instead of from `www.googletagmanager.com`. Any other value is an error. The run records it as `testGtmOrigin` and the CLI prints a warning. It is not read from the scenario or the override file.

### `pingwright diff <a.jsonl> <b.jsonl>`

Compares two runs of the same scenario, for example one with a GTM override and one without. It does not open a browser.

| Option | Meaning |
| --- | --- |
| `--by-page` | Adds the page path to the key that pairs hits, so the same event on two pages is compared page by page. For a Shopify custom pixel the `/web-pixels@<hash>/.../sandbox/<mode>` prefix is stripped from the key, so runs on different Shopify deploys still pair. The record keeps the raw page. Added and removed lines show it as `recorded as <page>` when it differs from the key, and the JSON result has it as `page` on each added, removed and changed hit. A hit with no page uses the URL of the frame that sent it, or an empty page if there is none. |
| `--json` | Prints the full diff result as JSON instead of the text summary. |

The text summary is grouped by consent epoch label, then vendor, then event. Under each event it lists hits that were added (only in the second run), removed (only in the first), and changed. A changed hit is one that pairs up but differs in a consent field, in `gcs` or `gcd`, or in whether an ID is present. Hits are paired by epoch label, vendor and event (and the page path with `--by-page`), in time order: the first hit of a group in one run with the first in the other, and so on. The step is not part of the match, so a hit that lands in a different step in the two runs still pairs. Each line shows the step of the hit, and a changed line shows `step "a" -> "b"` when the step differs. A hit left over in a group after pairing is reported as added or removed. When a group has a different number of hits in the two runs, its event also gets a line such as `count 2 -> 1 (pairing by order)`, because the pairing may then match the wrong hits. A line at the end lists flag counts that changed per host.

Exit codes: `diff` exits 0 whether or not the runs differ. A file that is missing, is not JSONL, or does not start with a `run` record exits 2 with a message that names the file. A run record with a newer schema version than Pingwright knows prints a warning and the diff goes on. A file whose last line is cut off (a crashed run) is read up to that line, and the diff prints a warning that names the file and the line.

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
