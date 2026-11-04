# CLI

## Install

```bash
npm i -g tagreeve
tagreeve install-browser
```

`npm i -g tagreeve` installs the newest release. The current release is `0.5.0`. The first Tagreeve release was 0.4.0-rc.1. Versions up to 0.3.0 were published under the old name, as the README explains. Tagreeve needs Node 22.18 or later.

You can also install a release from its git tag:

```bash
npm i -g --install-links github:alfhen/tagreeve#v<version>
```

Tags before `v0.4.0-rc.1` install the old command name, not `tagreeve`. `--install-links` is needed because without it npm 10 links the global package to a temporary clone that it then deletes. Installing from a branch such as main does not work. Only release tags carry a built `dist/`.

Or build a tarball in a checkout and install that:

```bash
pnpm install && pnpm build && pnpm pack
npm i -g ./tagreeve-<version>.tgz
```

`install-browser` runs the Playwright CLI that ships with Tagreeve, so the Chromium revision matches.

## Commands

### `tagreeve run <scenario.yml> --site <url>`

Plays the scenario in Chromium, records every request, decodes the hits, checks the expectations and writes one JSONL file.

| Option | Meaning |
| --- | --- |
| `--site <url>` | The site to test. Scenario paths are resolved against it. Without `--site`, `site` from `tagreeve/config.yml` is used. With neither, `run` exits 2 with `--site is required`. |
| `--config <file>` | Reads the project config from this file instead of `tagreeve/config.yml`. A file that does not exist exits 2. See "Project config". |
| `--network stub\|server\|live` | `stub` (default) answers known collection endpoints locally. `server` is `stub`, except that collection requests to the hosts in `options.serverHosts` pass through (see Rules on cookies). Sends from a page while it unloads are still answered in the page, also to those hosts. `live` lets every hit through and warns on stderr that hits reach real vendor accounts. Overrides `options.network` in the scenario. `live` is only allowed here: a scenario that sets `network: live` is an error, also when the command line passes `--network live`. |
| `--label <name>` | Names the run: 1 to 40 lowercase letters, digits or hyphens, such as `ca-307-live`. Anything else exits 2. Without `--out`, the folder is `tagreeve/runs/<YYYY-MM-DD>-<label>/`. With `--out`, the folder is used as given and the label is still stored in `Run.label`. The text summary starts with a `Label: <label>` line, and `--json` has `label`. Without a label there is no line and no key. |
| `--out <dir>` | Directory for the record. The default is `tagreeve/runs/<YYYY-MM-DD>/`, with the local date, and Tagreeve makes it when it does not exist. An `out` in the project config replaces `tagreeve/runs` and still gets the date and the label: `<out>/<YYYY-MM-DD>[-<label>]/`. The file is `<dir>/run_<id>.jsonl`. Without `--out`, if `./runs/` holds a `run_*.jsonl` file or a `suite_*` folder, `run` prints one note on stderr that records now go to the new folder. Pass `--out runs` to keep using the old one. |
| `--seed <n>` | Seed for the fake identity. Overrides `options.seed`. |
| `--headed` | Show the browser window. Scenarios with a `handoff` step are always headed. |
| `--viewport <W>x<H>` | Sets the browser viewport in CSS pixels, such as `390x844`. Each side is an integer from 200 to 4000. Anything else, including `mobile`, exits 2. Overrides `options.viewport`. It sets the window size only: the user agent and the client hints stay desktop, so a narrow viewport does not make the browser report itself as a mobile device. A site that checks the user agent or the hints still serves its desktop tags. The record has `Run.viewport` and the report header shows `Viewport`. |
| `--allow-test-payment <host>` | Lets a `payment` step type a payment provider's documented test card. The host must equal the `--site` host and be in the allowlist file. See Test payments. It needs `--site` on the command line: a `site` from the project config is not enough, and `run` exits 2 and names the flag. |
| `--net-log` | Launches Chromium with `--log-net-log` and records collection requests that no browser hook reports: sends from a frame while it unloads, and early sends from a sandboxed `srcdoc` iframe while it loads. They carry `captured: "netlog"` and no body. The initiator is `unload` when the request started after a navigation request (not the first page load or its redirects) and up to 1.5 s after its response, and `netlog` otherwise. An early `srcdoc` send on a later page can still be labelled `unload`. This is a guess from timing. Needs `--network live` on the command line: the command refuses it in `stub` mode with exit code 2, because those requests would leave the machine. The log is written to a private temporary directory, not the output directory, and removed when the run ends, including on SIGINT and SIGTERM. Off by default. See design §5.3. |
| `--autoconsent-rules <file>` | Extra autoconsent rules. Can be repeated. Without it, `tagreeve/autoconsent/*.json` is used, sorted by name, when the folder has `.json` files. The flag replaces them. |
| `--gtm-override <file>` | Runs the page against an unpublished GTM workspace build. See below. |
| `--tracker-list <file>` | Adds tracker entries to the built-in list. See below. Without it, `tagreeve/trackers.json` is used when it exists. The flag replaces it. |
| `--server-container` | Runs your own server container in Docker and records the calls it makes to vendors. Needs `--network server` (or `options.network: server`) and `options.serverHosts`, or it exits 2. Every non-load request to a `serverHosts` host goes to the local container instead of the live one. These requests are recorded with `outcome: stubbed`, and their response is the local container's. Its vendor calls are decoded and checked like browser hits, answered locally and never sent on, apart from three Google requests that it needs to load its configuration. Each call is a request with `captured: "serverContainer"`, and a hit decoded from it has `via` when it links to a browser hit. The run waits up to 5 s after the last step for late calls. If the container does not start or ends during the run, the record is written with `Run.serverContainer.error` and the flag `serverContainerFailed`, and the exit code is 2. Build the image first on arm64 with `tagreeve server-container build`. |
| `--server-container-config <file>` | The container config for `--server-container`, in a file with mode 0600. Without it the config is read from `TAGREEVE_SERVER_CONTAINER_CONFIG`. The config is a secret: Tagreeve never prints it or records it. |
| `--baseline <file>` | Compares the hits of the run with a baseline file made by `tagreeve baseline save`, after the expectations. A key or tuple on one side only is drift and makes the exit code 1. Hits that moved across one consent answer are a warning, not drift. A missing or invalid file exits 2 before the browser starts. See `tagreeve baseline`. |
| `--var <k=v>` | Overrides a variable the scenario declares under `vars`. A name the scenario does not declare exits 2. Can be repeated. |
| `--json` | Prints a JSON summary on stdout instead of the text summary. |

`tagreeve run --help` prints this command's own help.

With `--server-container`, the text summary has a `Server container` line, for example `Server container: image ok; 7 vendor calls, 5 linked exactly, 1 probable, 1 unlinked; 3 requests forwarded to Google`, followed by what the local container does not show. A failed container reads `failed (<error class>)`, and the stand-in container of the test seam reads `stand-in container (test seam)`. `--json` has `serverContainer` with `calls`, `exact`, `probable`, `unlinked`, `forwarded` and, when the container failed, `error`. The text summary lists hits per vendor and event, consent epochs, flags (`unknownDestination` and `firstPartySubdomain` grouped by host, `platformHost` as one line per platform with the request count, the host count and the request count by purpose, and `sandboxPageUrl` grouped by vendor, each with a count and up to three example paths, or one for `sandboxPageUrl`; `possibleRealData` is one line with a count; the `--json` summary keeps every flag), each expectation with PASS, FAIL or WARN (failures show the message; every expectation shows up to five evidence IDs and a count of the rest), and the path of the JSONL file. When a result has a note, a `note:` line with fixed text follows its `PASS`, `WARN` or `FAIL` line. The `--json` summary has the note code in `note` on that result. The text holds no field values. A flag's request, in the text and in `--json`, reads `METHOD scheme://host/path?name&name`: query names only, never values, and a value-like query name or a bare query item reads `(other)`, and so does a path segment that looks like a value, such as an email, a phone number or a hash. The URL can be absolute, protocol-relative or relative. The URL runs to the end of the detail, or to ` as the page` in a `<vendor> received <url> as the page` detail, so a space inside it does not end it. The record keeps the full flag detail. The `result` records are appended to that file.

Tracker list: `--tracker-list <file>` takes a JSON array of `{ "vendor", "host", "paths"?, "source" }` entries, with the same checks as the built-in list. `vendor` is a lowercase key that is not a built-in decoder key (`ga4`, `google-ads`, `meta`, `meta-capi`, `pinterest`, `sgtm`), `host` is an exact host or `*.domain`, `paths` are path prefixes and `source` is an https link to the vendor's docs. In `stub` mode, a request to a listed path is stubbed for every resource type, and a request to a listed host without paths is stubbed unless it is a script, stylesheet, font or document load. A whole-host image or other request with no query and no body is stubbed but gives no hit. Each other such request becomes a minimal hit with the entry's vendor, the event and page when the URL has a common parameter for them, unknown consent and transport `tracker-list`. A listed vendor is a valid `vendor:` key in the scenario, and its requests are not flagged as `unknownDestination`. A request that a built-in decoder matches stays with that decoder. The file is read before the scenario, and a bad file exits 2.

First-party hosts: the registrable domain of `--site` is first party, so `--site https://www.shop.co.uk` does not flag `shop.co.uk` or `*.shop.co.uk` as `unknownDestination`. Data-carrying requests to those subdomains that no decoder matches are listed as `firstPartySubdomain` and do not fail the run. IP addresses and `localhost` are first party only as the exact `--site` host. Scenario options:

| Option | Meaning |
| --- | --- |
| `cartRequest` | Regular expression matched against request URLs. In an `addToCart` step, a matching request counts as a cart change, for a site whose cart endpoint the built-in check does not know. |
| `network` | `stub` or `server`, the same as `--network`, which wins. `live` is not allowed in a scenario (it is a scenario error that names `--network live`), so a committed scenario cannot send hits to real vendor accounts. |
| `viewport` | `{ width, height }`, integers from 200 to 4000. The same as `--viewport`, which wins. See the `--viewport` row for what it does not change. |
| `firstPartyHosts` | List of hosts or `*.domain` wildcards that are also first party, for example `['i.guim.co.uk', '*.shopifycdn.com']`. A wildcard matches subdomains, not the bare domain. |
| `platformHosts` | `false` flags requests to known platform hosts (Shopify's CDN and telemetry hosts, and the hosts of Shop Pay: `cdn.shopify.com`, `monorail-edge.shopifysvc.com`, `*.shopifysvc.com`, `cdn.shopifycloud.com`, `pay.shopify.com` and `shop.app`) as `unknownDestination` again. The default is `true`: they get the flag `platformHost`, which is listed in the summary and the report and never fails a run. |
| `unloadGapIgnore` | List of dataLayer event names or `*` globs, for example `['consent_*']`, that the `unloadGap` warning never reports. The warning covers frame pushes shortly before a navigation and before the run ends. Use it for custom events that are not meant to produce a hit. |
| `serverHosts` | List of hosts or `*.domain` wildcards for `--network server`. Collection requests to them pass through, and every other one is still stubbed. A host other than `localhost`, `127.0.0.1` or `::1` prints a warning on stderr. A wildcard on a public suffix (`*.com`), a vendor host (Google, Meta, Pinterest) and a tracker-list host are scenario errors. `server` mode without `serverHosts` exits 2. A `pagehide` or `visibilitychange` send to a server host is answered in the page, so the cookies it would set are not seen. A passing cookie rule in `server` mode can miss them. |
| `allowUnknownDestination` | `true` allows every unknown destination. A list of hosts or wildcards allows only those, and every other unknown destination still fails. |
| `builtins` | Severity per built-in check: `fail` (the default) or `warn`. The names are `unknownDestination`, `sandboxPageUrl`, `possibleRealData`, `deniedIdentifiers` and `earlyIdentifiers`. `earlyIdentifiers` is `warn` by default and every other check is `fail`. Any other name or severity is a scenario error. See [Exit codes](#exit-codes). |
| `identifierFields` | List of field names or `*` globs, for example `['visitor_key', 'x_*']`, that `deniedIdentifiers` and `earlyIdentifiers` treat as analytics identifiers, matched against the field names of each hit. |

Locators: `click` and `wait` take a selector string, or a mapping:

```yaml
- click: { role: radio, name: "White (01)" }
- click: { any: ['[role=radio][title$="White (01)"]', 'text=White (01)'] }
- wait: { role: button, name: "Add to cart" }
```

`role` and `name` are Playwright's `getByRole(role, { name })`. `exact: true` (with a `name`) matches the whole name. `any` is a list of selectors. The step uses the first one that matches an element within the step timeout, and the step record stores its position in `locator` (the step label is not changed). `any` cannot be combined with `role`. `fill`, `select` and `addToCart` take selector strings only. When a `click` or `wait` times out, the error lists up to ten buttons, radios, checkboxes, links, tabs and options on the page, as role and accessible name cut at 60 characters, for example `Controls on the page: button "White (01)", button "Black (02)".` The names are accessible names from the accessibility tree, and for a button or link that is usually its visible text. No other page text and no form value is listed. A name that is an email, has a run of 6 or more digits or looks like a hash is printed as `(hidden)`. For a `role` locator with the role button, radio, checkbox, link, tab or option, the list holds only the controls of that role, closest name first, for example `Closest radio controls: "White (01)", "Black (02)".` The order uses shared words, then shared prefix length, then edit distance, and ties keep page order. If the page has no control of that role, the error says `No radio controls on the page.` and then gives the general list. Any other role, such as `textbox`, gets the general list. No list is made while a handoff is waiting.

`wait` also takes a URL: `wait: { url: "*/thank-you*" }` waits up to the step timeout for the top-level URL of a page to match. A string is a path glob (`*` is any run of characters), matched against the path and query. `{ url: { matches: "^https://.*/thank-you$" } }` is a regular expression matched against the whole URL. The URL of any open page can match, not only the first, like `handoff until`, so a checkout that opens payment in a popup still works. When the step times out, the message ends with the controls that block submission on those pages, for example `page did not reach /thank-you* within 30s. Blocking controls: checkbox "I agree to the terms and conditions" (required, not ticked).` The reasons are `required, not ticked` (a required checkbox that is not ticked), `invalid` (the control fails its `validity`) and `aria-invalid`. Each entry shows the role or input type, the name and the reason, never the value, placeholder or error text, and at most ten are listed. Only the top-level document of each page is read, never a frame. Tagreeve does not tick the checkbox.

A `fill` entry can be optional: `"input[name=phone]": { value: phone, optional: true }`. If the field is not attached and visible within `options.optionalTimeout` (default 2s, from 100ms to 30s), the step skips it and goes on. The record lists the selectors in `Step.skippedFields`, never a value. The text summary prints `SKIPPED FIELD <selector> (not present)` under the step, and `--json` has `skippedFields`. A field that is present but cannot be filled (disabled, read-only, wrong type) still fails the step. Only `fill` has the optional form.

`select` chooses an option of a `<select>`: `select: { "select[name=countryCode]": DE }`. It matches the option value first, then the option label. Quote a number (`"01"`), because YAML drops leading zeros and the step is refused otherwise. After the change it reads the select back. If the option is not selected, the step fails with `value not applied (still: <option label>)`. A select that is a card field (for example `autocomplete=cc-exp-month`) fails with the same handoff message as `fill` on a site that is not on this machine. The chosen option value and label join the run identity as extra values under the rule below, so a hashed country can match in `identity.hashesMatch`. `fill` on a select still works as before.

Run identity: a run has a seeded fake identity (name, email, phone, address). In `fill`, a value that is an identity field name (`email`, `firstName`, `lastName`, `phone`, `address1`, `city`, `zip`, `country`) types the generated value. Any other value is typed as written, and it joins the run identity as an extra value. Its hash is then not reported as `possibleRealData`, and it can match a hashed name or address value in `identity.hashesMatch`, for example a city such as `Berlin` that the generated address cannot replace. An extra value never matches a hashed email or phone. A value joins the run identity only after it is typed into a field that is not a card or password field, whatever the selector: Tagreeve checks the field when it fills it. If the run stops before that, the value is not in the run record. A scenario can also set identity fields itself with a top-level `identity` key. It replaces the generated value, so `fill` and `identity.hashesMatch` use it:

```yaml
identity:
  country: SE
  phone: "+46701740620"
```

`identity.country` picks the format of the generated name, address, zip and phone. A two-letter value is upper-cased. US, SE, GB and DE have a format. Any other country keeps US-shaped data under its label, and the run prints `Warning: identity.country DK has no local format; name, address, zip and phone are US-shaped`. Zips come from Faker patterns (GB from a UK postcode pattern) and can be real postcodes. A postcode alone is not personal data.

Use fictional numbers and `example.com` emails only. A phone number inside one of these ranges set aside for fiction gets no warning, and any other number does. The warning says why the number looks real and which range to use for the country, for example `looks like a real phone (it is not in a fictional range and its mobile prefix is a real one for DE); use +49 30 23125000 to 23125999`. The warning never fails a run:

- US: 555-0100 to 555-0199, from [NANPA](https://www.nationalnanpa.com/).
- Sweden: 070-174 06 05 to 070-174 06 99, from [PTS](https://pts.se/).
- Germany: 030 23125 000 to 999, from the [Bundesnetzagentur drama numbers](https://www.bundesnetzagentur.de/DE/Fachthemen/Telekommunikation/Nummerierung/DramaNumbers/artikel.html).
- UK, from the [Ofcom drama numbers](https://www.ofcom.org.uk/phones-and-broadband/phone-numbers/numbers-for-drama): 07700 900000 to 900999, 020 7946 0000 to 0999, 01632 960000 to 960999, and 0xxx 496 0000 to 0999 for Leeds, Sheffield, Nottingham, Leicester, Bristol, Reading, Birmingham, Edinburgh, Glasgow, Liverpool and Manchester.

The warning covers numbers written as `+` and digits, and the common US shapes. Values that a person types during a `handoff` step are unknown to Tagreeve. To have them count as the run identity, declare the same value under `identity`, or the run reports their hashes as `possibleRealData`.

`identity.hashesMatch` reads hashed email and phone values from Meta, Meta Conversions API events (`meta-capi`) and the server container's data client (`sgtm`), and hashed email values from Pinterest. A Conversions API field with several values, such as `em: [a, b]`, is checked value by value: the first is the hit param `hashedEmail` and the others are `hashedEmail.1`, `hashedEmail.2` and so on. The other Conversions API fields (`fn`, `ln`, `ct`, `zp`, `country`) are indexed the same way, for example `user_data.city.1`. On a `meta-capi` hit, a filter on `ids.hashes.<field>.matchesIdentity` is computed from the run identity and the record keeps null; it is true when every value of the field matches the run identity, and false when one does not. Only `sgtm` may send city, postal code and country as plain text; on a Conversions API event a plain `ct`, `zp` or `country` fails the check. On an `sgtm` hit it reads `user_data` (`email_address`, `phone_number`, `first_name`, `last_name`, `street`, `city`, `postal_code`, `country`, at the top level or under `address`) and shows each as the hit param `user_data.<field>`.

When a hit carries no identity field at all, the message says so, and that matching done server side, for example by a conversions API, is not visible to Tagreeve. A hit with fields that do not match keeps `Not matching: <field>`. When a hit carries only plain city, postal code or country, the message says it carried no hashed identity field. When a Meta hit carries only other fields, such as `fn` or `ln`, it says the hit carried no hashed email or phone, and names those fields. Tagreeve does not check them.

`identity.hashesMatch` cannot be in the same entry as `body.has` or `body.only`. Use two entries.

On an sgtm hit, every hashed user_data field that the hit sends must match the run identity, not only email and phone. On a `meta-capi` hit, `em`, `ph`, `fn`, `ln`, `ct`, `zp` and `country` are all checked, and a plain `ct`, `zp` or `country` fails. On a Meta hit, only the hashed email and phone are checked. On a Pinterest hit, only the hashed email is. A field that the hit sends empty, or does not send, is skipped. On an `sgtm` hit, a city, postal code or country sent as plain text is skipped, because Google's user data format allows that. If one field is wrong, the rule fails, and the message names the hit params that do not match and the fields that do, for example `Not matching: user_data.country. Matching: email, first name and last name.` A field name that looks like a value, such as an email address, a phone number or a long digit run, is shown as `(other)`, so no value is printed. A site can add a value that the scenario did not type, such as the country of its default market. Declare that value under `identity`, for example `identity: { country: SE }`, so that its hash matches.

To withdraw consent, reopen the banner with a `click` on the site's cookie settings link, then answer it with `consent: reject` (`consent: withdraw` is the same answer). Without the click the step fails with "banner not shown (withdraw needs the banner reopened first)".

```yaml
steps:
  - consent: accept
  - click: "#pw-cookie-settings"
  - consent: withdraw
```

`addToCart` clicks the selector and then needs proof that the cart changed: a cart request, or an `add_to_cart` dataLayer event. Cart requests it knows are a Shopify POST to `/cart/add`, `/cart/change` or `/cart/update` and a GET of `/cart/add?id=`, a POST to `/cart` (Hydrogen), Magento `/checkout/cart/add/...`, WooCommerce `?wc-ajax=add_to_cart` and a Storefront `cartCreate` or `cartLinesAdd` mutation. A request counts once its response arrived with a 2xx or 3xx status (a form POST often answers with a redirect). A request that is still pending, failed or got a 4xx or 5xx response does not count. Without proof the step fails with "click did not add to cart", for example when the click only opened a variant picker. For a cart endpoint it does not know, set the `cartRequest` option, or use a plain `click` step, which checks nothing. Through the library, `cartCheck` and `cartTimeoutMs` in the play options replace the check and the 5 s wait.

A `handoff` step waits for a person. In the headed window a small pill with the handoff text and a **Done** button sits in a corner of the top document. Click Done, or press Enter in the terminal: the first of the two ends the wait. The pill is a closed shadow root on one element, `#tagreeve-handoff`, installed by a context init script. It is not drawn in sandboxed iframes, it survives navigations during the handoff, and it makes no network request. While the wait lasts, the terminal prints `Still waiting for the handoff: <text>` every 60 seconds. The host is a child of `<html>`, a sibling of `<body>`, and its styles are inline with `!important`, so `body { display: none }` does not hide it. The pill is part of the page, so a page can still hide it (a script that edits the element, or a rule such as `html { display: none }`), and a capture-phase listener on `window` or `document` sees a click on it. The pill is at most the viewport width minus 32 px wide: a long text is cut with an ellipsis and the Done button stays whole. It does not move when a page control is under it, but you can drag it. Enter in the terminal is the fallback when the pill is hidden.

A handoff can end by itself. Write it as a mapping:

```yaml
- handoff:
    text: "Pay with the test card."
    until: { url: "/thank-you*" }      # or { role: heading, name: "Thank you" }, { selector: "#order" }
    settle: 10s
    timeout: 10m
```

`until` takes the URL forms of `wait`, or a locator (`role` and `name`, `any`, or `selector`) that must be attached and visible on any open page. When it holds, recording goes on for `settle` (5 s by default), the terminal prints `Handoff ended: reached <until as written>`, and the step ends. Done and Enter still work, also during `settle`. `settle` needs `until`. `timeout` has no default and also works without `until`. When it runs out, the step fails with `handoff did not reach <until> within 10m` (`handoff timed out after 10m` without `until`). The step record's `handoffEnd` is `done`, `enter`, `until` or `timeout`. The string form `handoff: "text"` is unchanged.

During a `handoff` step, requests that are not tracking hits are stored without their body and query values (`redacted: handoff`), so passwords typed by the person are not kept. For those requests the query values of the frame URL and of the `Referer` and `Origin` headers are redacted too. Later requests that are not redacted keep the page URL as it is.

Payments and log-ins are handoff steps on any host other than `localhost`, `127.0.0.1` or `::1`. Filling a card or password field on another host fails the run.

**Test payments.** One opt-in exception: a `payment` step may type a payment provider's documented test card on a hosted store. Log-ins are never automated.

```yaml
- payment: { provider: shopify-bogus, card: "1" }
- click: { role: button, name: "Pay now" }
- wait: { url: "*/thank-you*" }
```

The providers are `shopify-bogus` (cards `1`, `2`, `3`), `shopify-test` (the test card numbers in Shopify's docs) and `fixture` (Tagreeve's own fixture shop, loopback sites only). Any other card value is a scenario error. Expiry and CVC are fixed values from the provider's docs. The name on the card is the run's fake name. These checks all pass before anything is typed, or the run exits 2 or the step fails:

1. `--allow-test-payment <host>` names the exact `--site` host. A scenario with a `payment` step and no flag, or with a flag for another host, exits 2 before the browser starts.
2. The host is in the user-level file `$XDG_CONFIG_HOME/tagreeve/test-payment-hosts.json`, or `~/.config/tagreeve/test-payment-hosts.json`. It is a JSON array. Each entry is an exact host, or an object `{ "host": "shop.example.com", "testMode": "shopify-test" }` that declares the store to be in test mode for that provider. The file may mix both. A declaration applies to that host and that provider only. An unknown provider id, a loopback host or the `fixture` provider in a declaration is an error that names the file and the entry number. The file must not be writable by group or others. Otherwise the run exits 2 before the browser starts.
3. At the step, the page is on the allowed host and each card frame is served from the provider's card host. Then, with no declaration for the host and the provider, the provider's test-mode marker must be visible inside the nearest element that holds every card frame. Text elsewhere on the page does not count. Otherwise the step fails with `test mode not detected` or `card frame not found (<field>): <reason>`, where the reason is `not found`, `not visible`, `served from another host` or `served from another path`. After `test mode not detected` the error adds a line that shows the declaration to write in the allowlist file. The line names the provider of the step that failed, and appears only when the allowlist file would accept that entry. When the failed step cannot be identified, the line lists each distinct provider of the scenario's `payment` steps that the allowlist would accept, joined with ` or `.

The step types into the first matching card iframe that is visible and served from the card host at the document path of that field (on Shopify, `number-ltr.html`, `expiry-ltr.html`, `verification_value-ltr.html` or `name-ltr.html`, with `-rtl` accepted), and into the one visible input in that frame that has the field's `autocomplete` or `name`. A frame with the right title and host but another path is skipped, and the step fails with `card frame not found (<field>): served from another path: /build/<hash>/foo.html`. It resolves the input first and checks the frame's host and path again before each short fill try, so a frame that navigates during the fill gets no typing. If the frame has moved to another host or path when the input count is reported, the reason is `the card frame is gone or not served from the card host`. If a field does not have exactly one matching visible input at the step deadline, the step does not guess: it fails with `card field <field> could not be filled: 2 visible inputs match in /build/<hash>/number-ltr.html: [name=number autocomplete=cc-number type=text] [name=number-copy autocomplete=cc-number type=text]`. The number is the count of visible inputs that match the field's selector. The list shows every visible input in the frame, so it can hold inputs that do not match. For each one it gives the `name`, `autocomplete` and `type`, never a value, and a typed value inside an attribute is replaced with `[value]`. Any other fill error keeps its first line as the reason, with every typed value removed.

The step has its own code path. `fill`, `select` and `evaluate` still refuse card fields on hosted pages. From the first key until the run ends, every request that is not a tracking hit is stored without its body and query values (`redacted: handoff`), including the card submit that the later Pay click sends. No card number, expiry or CVC goes into a record, a message, the summary or the report. The step record has `payment: { provider, mode: "test", testMode }`, set after the first key is typed, where `testMode` is `declared` or `marker`. The text summary prints `TEST PAYMENT: <provider> on <host> (test mode declared)` or `(test mode on page)`, and `--json` has `testPayment: { provider, host, testMode }`. The gates stop mistakes. They do not stop a person who sets all three on purpose.

A `host:` rule in `expect` matches the request's host with its port (`127.0.0.1:4173`) or its bare hostname (`127.0.0.1`). It is an exact, case-sensitive match on one of these forms. An IPv6 host may be written with or without brackets (`::1`, `[::1]`, `[::1]:4173`). `ids.hashes` matches a hit with any hashed ID present, and `ids.hashes.<param>` and `ids.hashes.<param>.matchesIdentity` read one hashed parameter. Any other name under `ids.hashes` is a scenario error. A `possibleRealData` failure lists the first five findings and a count of the rest. Each finding names where the value was found: the hit parameter path (for example `user_data.country`), `the URL` or `the body`. A JSON or form body is scanned leaf by leaf, and a finding names the path (for example `customerHashed.country`). A body that is plain text, or a form body with names only, is `the body`. A multipart body is split into parts, and a text field is scanned and named by its field name. A binary part is skipped only when the body is binary as a whole. In a body that is text as a whole, every part is scanned, whatever its own content type says. Any other body with several lines is checked line by line. A path segment that looks like a value prints as `(other)`. A name that holds an email- or phone-shaped value prints whole as `(other)`. A finding never holds the value. A body or part is skipped when it has a `content-encoding` other than `identity`, a binary content type, or 10% or more control or replacement characters in 16 or more characters, whatever its content type. A text body padded with many control characters is skipped for that reason, which is a known trade-off. The URL is still scanned.

### Rules on payload fields

`body.has`, `body.only` and `body.ignore` check which fields a hit sent. They read the names of the non-empty fields in the whole decoded payload: the query string, a JSON or form body, and the decoded `dtdc` object. The keys are called `body.*` even so. Only names are read and shown. A value never appears in a rule, a message or the evidence.

```yaml
expect:
  mustNot:
    - { vendor: sgtm, body.has: [email, phone, "user_data.*", "cookie*"], in: epoch(denied) }
  must:
    - { vendor: sgtm, event: page_view, body.only: [event_name, page_location, page_title, page_referrer] }
```

- `body.has` is a list of field names. A hit matches when it has any of them. Nested names use dots (`user_data.email_address`) and array items collapse to `[]` (`items[].price`). A name may use `*` for zero or more characters, so `cookie*` matches `cookie` and `cookie_data`. A name that starts with `**.` is a leaf name: `**.email` matches `email`, `customerHashed.email` and `a.b.email`, on a dot boundary, so not `useremail`. This differs from `*.email`, which needs a dot and misses a top-level `email`.
- A plain name with no `*` matches a top-level field only. When it matches nothing, but a nested field ends in that name, the message adds `no top-level match; nested fields with this name: customerHashed.email` and the result has `note: nestedNameOnly`. The outcome does not change. Use `**.email` to match at any depth. The other keys of the entry (`vendor`, `event`, `in`, `before`, `after`, `count` and so on) select the hits first.
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
| `meta-capi` | `event_name`, `event_time`, `event_id`, `event_source_url`, `action_source` |
| `sgtm` | `v`, `tid`, `event`, `en`, `dtdc` |

The lists are exported from `@tagreeve/decoders` as `GA4_BODY_ONLY_IGNORE`, `META_BODY_ONLY_IGNORE`, `META_CAPI_BODY_ONLY_IGNORE` and `SGTM_BODY_ONLY_IGNORE`.

### Rules by sender

With `--server-container`, the container's own calls to vendors are decoded as hits too. `sentBy` in a hit rule picks who sent the hit.

```yaml
expect:
  mustNot:
    - { vendor: ga4, host: region1.google-analytics.com, sentBy: browser }
  must:
    - { vendor: ga4, host: region1.google-analytics.com, sentBy: server }
```

- `sentBy: browser` matches hits from requests the browser sent. `sentBy: server` matches hits decoded from a server container call. Without `sentBy` a rule matches both. Any other value is a scenario error that names the rule.
- It works in `must` and `mustNot`, with every other filter key. Cookie rules do not take it.
- Without `--server-container` no hit comes from the container, so `sentBy: server` matches nothing.
- A `sentBy: browser` rule never judges a server container call, so the notes `serverSendUnlinked` and `serverSendProbableLink` do not apply to it.

### Rules from a step

`after: <step label>` and `from: <step label>` limit a rule to hits and cookies from a labelled step on. `after` starts when the step ends. `from` starts when the step starts, so it includes what the step does itself. For a `visit` step, the page-load hits belong to `from` only:

```yaml
steps:
  - visit: /products/fake-tee
    label: product
expect:
  must:
    - { vendor: ga4, event: page_view, from: product }
    - { vendor: ga4, event: page_view, after: product, count: 0 }
```

A rule takes one of `from` and `after`, not both: that is a scenario error that names the rule. Both keys work on cookie rules and on server hits the way `after` always did.

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
- The entry stands alone. It takes `before: consent`, `in: epoch(...)`, `after: <step label>` and `from: <step label>` as a hit rule does, and nothing else. `vendor`, `event`, `count`, `body.*` and the other hit keys are scenario errors.
- Two sources count. A `Set-Cookie` header on any response, from any host, is placed at its request's time, and the evidence is that request ID. A cookie in a checkpoint (set by a script, or earlier) is placed at the checkpoint's time and the evidence is the checkpoint ID. A checkpoint only shows that the cookie was present then, not when it was set, and the message says so. To test a script cookie before consent, add a `checkpoint` step before the consent step. When a header and a checkpoint show the same name, the result cites the request.
- When the evidence is a `Set-Cookie` header, the message says what the checkpoints show, with a count of requests: `found _dcid from Set-Cookie (7 requests); stored by the browser`. A checkpoint taken after the request was sent holds a cookie with that name, and its domain matches the response host by RFC 6265 domain-match (`Domain=example.com` set by `sgtm.example.com` counts). A checkpoint counts only if it was taken more than 50 ms after the request was sent, so one that ran while the response was still arriving is ignored. If the last checkpoint taken before the request already holds a same-named cookie, the message says `the cookie was already set before this response`. It makes no claim about storage and has no `cookieNotStored` note. Otherwise, if a later checkpoint exists and none holds the cookie, the message says `no later checkpoint has it` and the result has `note: cookieNotStored`. The rule still fails: the server tried to set the cookie. With no checkpoint after the request, the message says nothing about storage. A response still in flight at the last checkpoint can read as not stored. When one name has several `Set-Cookie` responses, the text ranks stored, then not stored, then already set, then unknown. When names differ, each group is listed: `stored by the browser: a; the cookie was already set before this response: b`. A consent tool can delete a stored cookie, so the text reports the checkpoints and makes no claim about the browser. Only names and counts are shown, never a value.
- A time is placed in an epoch like a hit's, with the same grace window. A cookie set less than the grace window before the consent answer counts after it. Wait before the consent step when a test depends on it.
- A rule with `before`, `in`, `after` or `from` that matches a checkpoint without a time (a record from before 0.3) cannot be placed. The result is `cannot evaluate` and never passes.
- Cookie names are guarded like field names: a name that looks like a value is shown as `(other)`.

In `stub` mode a stubbed endpoint sets no cookies. A cookie rule can pass for that reason, so a passing result in `stub` mode ends with `stub mode: stubbed endpoints set no cookies` and has `note: stubNoCookies`. To see the cookies of a server container, run with `--network server` and list its host in `options.serverHosts`, or use `--network live`. In `server` mode a send from `pagehide` or `visibilitychange` to a server host is still answered in the page, so a cookie that such a send would set is not seen, and a passing cookie rule can miss it.

### GTM override

`--gtm-override <file>` takes JSON with the values of a GTM preview. Tagreeve never calls the GTM API, so you supply them.

```json
{"container": "GTM-XXXXXXX", "gtmAuth": "…", "gtmPreview": "env-12", "expectedTags": [{"id": "45", "name": "GA4 - Purchase"}]}
```

`container` must match `^GTM-[A-Z0-9]+$`. `expectedTags` is stored in the run record and not evaluated, because nothing yet reports which tags fired. See [design §8.5](design.md#85-what-the-server-container-sends-on).

When the page requests `https://www.googletagmanager.com/gtm.js?id=<container>`, Tagreeve fetches `gtm.js?id=<container>&gtm_auth=<gtmAuth>&gtm_preview=<gtmPreview>&gtm_cookies_win=x` and answers the page with that build. The page's own request URL is not changed. If the page's request has `l=<name>` (a data layer that is not `dataLayer`) or `gtm_debug`, they are copied to the preview fetch. The override applies to that run in the test browser only. It applies when the page loads the container script itself, and when a Stape-style custom loader fetches it. In the loader case the loader script stays in place and its request is answered with the preview build; the record says `way: "loader"`. A real Stape custom loader script has a URL like `https://load.<sgtm host>/<random>.js?<key>=<obfuscated>`, and nothing in the URL names the container. For a cross-origin script request with a `.js` path and a query to the site's registrable domain or a `firstPartyHosts` host (on a loopback site, loopback hosts only), Tagreeve fetches the script and, if its body holds the container ID, answers with the preview build instead. The record says `way: "loader"`, with a `loses` note, because the loader script is replaced. Query values are never listed in messages, since they may hold per-site keys. That fetch runs in Playwright's request client, not Chromium, so it uses the Playwright cookie jar and stores any `Set-Cookie` from the script response. A script that answers with a redirect is not fetched further: Chromium follows it, and a hop to a collection endpoint is stubbed or flagged `stubBypass` as usual. Scripts on other hosts are left to Chromium. Scripts served from the site's own origin are neither sniffed nor listed.

To replace a loader yourself, add `"loader": {"replace": "<script URL>"}` to the override file. The request for exactly that URL is then answered with the preview build, and the record says `way: "replace"`, with a `loses` note. To reuse one rule across stores, add `"loader": {"match": "<regex>"}` instead: any script request (resource type `script` only) whose URL matches the regular expression is answered the same way and recorded as `way: "replace"`. On the replace way, `l` and `gtm_debug` are copied only if the replaced script URL carries them. Each match is listed in `run.gtmOverride.applied` as `{way, url, status}`. Passing `gtm_auth` and `gtm_preview` through the loader is not built. Tagreeve also sniffs unknown loader scripts for the container ID, but only when the override file has no `loader` key.

The run fails with exit 2 if no request matched ("no container request matched"; the message lists the cross-origin script URLs it checked, without query values, and suggests `loader.replace` or `loader.match`), or if the preview fetch did not return 200, or if `loader.replace` is set and the page never requested that URL. A 404 usually means the environment has no version. The JSONL is still written, and `run.gtmOverride.applied` lists each match with its status.

The `gtmAuth` value is removed from the record and from all output, in any form: plain, URL-encoded, or inside nested URL-encoding and base64 layers, up to 8 layers (each URL-decode, base64 decode or query-value step counts as one). A base64 value glued to unseparated text, such as `abc<base64>xyz`, may not be decoded. A request URL parameter, a request body, a result record, a step error or any other string that holds it in any decoded form becomes `[redacted]`. The record keeps `gtmAuth: "[redacted]"`.

Tests can set `TAGREEVE_TEST_GTM_ORIGIN` to a loopback origin (`http://localhost`, `http://127.0.0.1` or `http://[::1]`, with an optional port, and no path) to fetch every `gtm.js` from there instead of from `www.googletagmanager.com`. Any other value is an error. The run records it as `testGtmOrigin` and the CLI prints a warning. It is not read from the scenario or the override file.

### `tagreeve diff <a.jsonl> <b.jsonl>`

Compares two runs of the same scenario, for example one with a GTM override and one without. It does not open a browser.

| Option | Meaning |
| --- | --- |
| `--by-page` | Adds the page path to the key that pairs hits, so the same event on two pages is compared page by page. For a Shopify custom pixel the `/web-pixels@<hash>/.../sandbox/<mode>` prefix is stripped from the key, so runs on different Shopify deploys still pair. A path segment becomes `*` when it is over 64 characters, holds `@` or a percent-encoded byte, reads as an email, phone number or hash, is a run of 32 or more hex digits, holds 6 or more digits in a row (or is mostly digits), or is a token of 22 or more letters, digits, `_` or `-` with upper case, lower case and a digit. The digit, hex and token rules also run on the segment with its dashes removed, which is why a UUID is masked. So `/checkouts/cn/<token>` is keyed as `/checkouts/cn/*`, and a product slug over 64 characters is keyed as `*`. A plain lower-case token with few digits is kept. The record keeps the raw page. Added and removed lines show it as `recorded as <page>` when it differs from the key, and the JSON result has it as `page` on each added, removed and changed hit. A hit with no page uses the URL of the frame that sent it, or an empty page if there is none. |
| `--all-flags` | Shows flag count changes for hosts the scenario allows with `allowUnknownDestination`, and for platform hosts (`platformHost` flags), which never fail a run. They are hidden by default, because platform telemetry hosts often change by one between identical runs, and the summary says how many it hid. The JSON result always has them, with `allowed: true`. |
| `--json` | Prints the full diff result as JSON instead of the text summary. |

The text summary is grouped by consent epoch label, then vendor, then event. Under each event it lists hits that were added (only in the second run), removed (only in the first), and changed. A changed hit is one that pairs up but differs in a consent field, in `gcs` or `gcd`, or in whether an ID is present. Hits are paired by epoch label, vendor and event (and the page path with `--by-page`), in time order: the first hit of a group in one run with the first in the other, and so on. The step is not part of the match, so a hit that lands in a different step in the two runs still pairs. Each line shows the step of the hit. A changed line shows `step "a" -> "b"` when the step differs, and with `--by-page` it shows `recorded as <page a> -> <page b>` when either raw page differs from the key. A hit left over in a group after pairing is reported as added or removed. When a group has a different number of hits in the two runs, its event also gets a line such as `count 2 -> 1 (pairing by order)`, which with `--by-page` also shows the page, because the pairing may then match the wrong hits. A line at the end lists flag counts that changed per host.

Exit codes: `diff` exits 0 whether or not the runs differ. A file that is missing, is not JSONL, or does not start with a `run` record exits 2 with a message that names the file. A run record with a newer schema version than Tagreeve knows prints a warning and the diff goes on. A file whose last line is cut off (a crashed run) is read up to that line, and the diff prints a warning that names the file and the line.

### `tagreeve baseline save <run.jsonl> <baseline.json>`

Writes the shape of one run to a small file you can commit, so a later run can be checked for drift in CI. It does not open a browser.

| Option | Meaning |
| --- | --- |
| `--by-page` | Adds the page path to each key, as in `diff`. The path only: no query, no host. Segments that look like a value are stored as `*`, by the same rules as in `diff`. The baseline holds no per-order token of those shapes. |

The file holds `baselineSchemaVersion`, the `scenario` name, the `site` host (no scheme, port or path), `byPage` and a sorted list of keys. A key is the consent epoch label, the vendor and the event. Under each key are the tuples seen: the four consent states, the raw `gcs` and `gcd` values, the names of the IDs that are present, and a hit count. It holds no hit ID, time, URL, query, cookie or value. There is no `approve` command: to accept a change, save the baseline again and review the file diff in the pull request.

Then check a new run against it:

```bash
tagreeve run checkout.yml --site https://shop.example --baseline baselines/checkout.json
```

Drift is a key or tuple that is on one side only. A changed consent field or ID presence shows as one tuple removed and one added. A count change is listed and is not drift. The summary gets a `Baseline` block, and the `--json` summary gets a `baseline` field with `drift`, the counts of added, removed and count changes, `warnings` and the `changes` lines. Drift sets `ok` and `pass` to false and the exit code to at least 1. Hits that moved across one consent answer are not drift. This holds when the total for a vendor and event (and page, with `--by-page`) is the same and only two neighbouring consent epochs differ, in either direction. Each move is a warning, for example `moved meta PageView from undecided to granted. This is not drift.` When the hit moves into `undecided`, the warning says it now fires before the consent answer. The moved hits may differ in consent fields but not in ID presence. A move across two answers, a changed total or a changed ID is drift. Scenario names are compared without `.yml` or `.yaml`. A baseline from another scenario name or another site host prints a warning and the compare goes on. The run is shaped as the baseline was, so `--by-page` is the file's choice.

`baseline` and `diff` answer different questions. `diff` pairs the hits of a key in order and reports each one. A baseline compares sets of tuples, so a reordering of hits is not drift and a new tuple inside a key is.

### `tagreeve suite [<dir>] [--site <url> | --stores <stores.json>]`

Runs every scenario in a directory, once for each GTM build you name, and prints one table. It reads `*.yml` and `*.yaml` files in `<dir>` (not subdirectories). Without `<dir>`, it uses `tagreeve/scenarios/` when that folder exists. Every file is parsed first. If one is not a valid scenario, the command lists the problems and exits 2 before a browser opens.

```bash
tagreeve suite scenarios/ --site https://staging.example.com \
  --variant published --variant workspace=override.json
```

| Option | Meaning |
| --- | --- |
| `--site <url>` | The site to test. Never together with `--stores`. The site comes from `--site`, then `--stores`, then `site` in the project config, then `tagreeve/stores.json`. With none of them, `suite` exits 2 and names the options. When the config has `site` and `tagreeve/stores.json` exists, `suite` exits 2 and asks for `--site` or `--stores`. |
| `--config <file>` | As in `run`. |
| `--stores <file>` | A stores file: run every scenario against each store. See "Several stores". Without `--site` and `--stores`, `tagreeve/stores.json` is used when it exists. |
| `--variant <name[=file]>` | A GTM build to test. Can be repeated. `published` means no override and takes no file. `name=file` serves an override file in the `--gtm-override` format. The name matches `^[a-z0-9][a-z0-9_-]*$`, and a name given twice exits 2. Default: `published`. |
| `--with-handoff` | Also runs scenarios that have a `handoff` step, after all others, in a headed window with a person at each handoff. Without it they are `SKIPPED`, which counts as a pass. |
| `--with-test-payment` | Also runs scenarios that have a `payment` step. It needs `--allow-test-payment <host>` too, as in `run`. Without both they are `SKIPPED`, which counts as a pass. With both, a failed gate exits 2 before any run. |
| `--allow-test-payment <host>` | As in `run`. It needs `--site` or `--stores` on the command line. Without them `suite` exits 2 and names the flag, also when `tagreeve/stores.json` holds the host, because a default file never supplies the host a test payment runs on. A `site` from the project config does not count either. |
| `--network`, `--out`, `--label`, `--seed`, `--viewport`, `--var`, `--tracker-list`, `--autoconsent-rules`, `--server-container`, `--server-container-config`, `--json` | As in `run`. Without `--out`, the `suite_<id>/` folder goes in `tagreeve/runs/<YYYY-MM-DD>/` (`<YYYY-MM-DD>-<label>/` with `--label`), and `suite` prints the same note about an older `./runs/`. `--server-container` starts one container for each run, not one for the suite, because each run needs its own capture window. A suite with it is slow. Every scenario must be in server mode. `--gtm-override`, `--headed` and `--net-log` are not options of `suite`. A `--var` that no scenario declares exits 2. |

The runs go one after another, with one browser at a time. The variants of one scenario use the same seed, so they have the same fake identity. Output goes to `<out>/suite_<id>/`: one record per run, named `<scenario>.<variant>.jsonl` (with `--stores`, `<scenario>.<store>.<variant>.jsonl`, see Several stores; each has `Run.variant` set, and `Run.label` with `--label`; with `--stores` it also has `Run.store`), and the manifest `suite.json`. The manifest has the site origin, the variants, one cell per scenario and variant (with `--stores`, per scenario, store and variant) with its status, exit code and record file name, the failed rule count and the failed built-in check names on a failed or warned cell, and the diff counts. It holds no path, no query value, no override file path and no run message.

When a scenario has two or more variants, the suite compares the first variant with each other one, with the same engine as `diff`. The table shows the counts per pair:

```
scenario        published   workspace      diff (published -> workspace)
checkout        PASS        FAIL: 1 rule   +1 added, 1 changed
consent-reject  PASS        PASS        no change
checkout-pay    SKIPPED     SKIPPED
```

A difference between variants is not a failure. Your rules decide. A run that exits 2 (for example, the banner was not shown) shows `ERROR (exit 2)` and does not stop the suite. A failed or warned cell says what failed: `FAIL: 5 rules, deniedIdentifiers` counts the failed rules and names the failed built-in checks, and `WARN: 1 rule` does the same for warnings. It never prints a rule or a message. The report uses the same text. The suite's exit code is the worst cell, in this order: 2, then 1, then 0. With `--json`, stdout is the manifest instead of the table.

#### Several stores

`--stores` runs the same scenarios against more than one storefront, such as one store per market. The file is JSON:

```json
{
  "storesSchemaVersion": 1,
  "stores": [
    { "name": "us", "site": "https://shop.example.com" },
    { "name": "se", "site": "https://shop.example.se", "country": "SE", "vars": { "product": "tee-se" }, "autoconsentRules": "rules-se.json" }
  ]
}
```

A file holds 1 to 50 stores. `name` matches `^[a-z0-9][a-z0-9_-]*$` and is unique. `site` is an http or https URL. `vars` override the vars a scenario declares, and `--var` overrides both. A store var that no scenario declares exits 2 and names the store and the var. `country` sets `identity.country`. A scenario that sets another country gets a warning, and the store's country is used. `autoconsentRules` is a path relative to the stores file, added to `--autoconsent-rules` for that store. A file that is missing, not a file or not readable is an error when the stores file is read, before any run. An error names the file and the store index, never a value.

Every scenario runs once per store and variant, with one seed. Records are named `<scenario>.<store>.<variant>.jsonl`. Each cell has `labels: { "store": "<name>" }`. The table gets a `store` column after `scenario`, with one row per scenario and store. Diffs compare the variants within one store. Tagreeve does not compare stores with each other.

`--allow-test-payment <host>` still names one host. A payment scenario runs only for the store whose host equals it, and its cells for the other stores are `SKIPPED`. If no store has that host and a payment scenario would run, `suite` exits 2 and the message names the flag.

`suite.json` has `suiteSchemaVersion: 3`, `label` when `--label` is given, `defaults` and `stores`, a list of `{ name, site }` with the origin only. A diff has a `store`. Store vars are not written. Without `--stores`, `stores` is `[]`, cells have empty `labels` and nothing else changes.

`defaults` lists each file or folder used because its flag was not given, as `{ setting, path }` with a fixed relative path such as `tagreeve/trackers.json`. The settings are `scenarios`, `trackerList`, `autoconsentRules` (one entry per file) and `stores`. The key is absent when no default was used. The text table and the text summary of `run` show one line, such as `Defaults: tagreeve/trackers.json (tracker list)`, and the `--json` summary of `run` has the same `defaults` list.

### `tagreeve report <run.jsonl | suite dir> --html <out.html>`

Writes one HTML file that people can read without knowing JSONL. It opens no browser and reads no network. `--html` is required, and the command refuses to overwrite its own input. A missing file, or a file that is not a run record, exits 2, as `diff` does.

The input is one record, or a suite directory from `suite`. A suite directory needs its `suite.json`. The `--out` folder of `suite` also works when it holds exactly one `suite_*` folder with a `suite.json`: `report` uses it and names it on stderr. With several, the error lists them. A record that the manifest names and that is missing becomes a warning in the page.

A run report has these parts:

- **Title.** `Tagreeve run: <scenario> on <host>, <date>`. It is also the page `<title>`.
- **Header.** Variant, label (when the run has one), run ID, date, network mode, viewport (when the run set one), site host, Tagreeve version and record schema version.
- **Verdict.** One plain-language line built from the marks and counts. It names the vendors that send hits or identifiers, by plain name such as Google Analytics 4 or server container, and the consent state. Then it counts the failed rules (`must`, `mustNot` and unreadable rules) and names each failed or warned built-in check, for example `no leaks; 1 rule failed; built-in check sandboxPageUrl failed`. A result that cannot be evaluated reads `could not be checked`. `deniedIdentifiers` and `earlyIdentifiers` are each left out of a run only when that run's own report already names that check's identifier findings, so a failed `deniedIdentifiers` stays in the line when only early identifiers are named, and the reverse. In a suite verdict this is decided per run: a run that names the finding does not hide the same check failing in another run. `no leaks` when there are none. It holds no value.
- **Timeline per vendor.** One row per vendor, headed `Name (key)`, and one segment per consent epoch, each with a mark and a hit count. The mark also has a text label, so it reads without colour.
- **Expectations.** Each result as PASS, WARN, FAIL or CANNOT EVALUATE, with the rule's key names, up to five evidence IDs and, on a failed or warned result, `on failure: fail` or `on failure: warn`. A passing result shows no severity.
- **Flags** and **fields.** The flag kinds with counts and hosts, and the field names seen on denied hits.

A run with `--server-container` also shows each vendor that the server container sent on as its own timeline row, for example `Google Ads (google-ads), sent by the server container`. The row places a hit in the epoch of the browser hit it links to, and marks a segment that rests on a probable link (`1 hit, 1 by probable link`). Hits with no link are in an `unlinked` column after the last epoch. A short note under the timeline says what the local container does not show. The verdict counts hits that could not be linked and hits placed by a probable link. A result with the note `serverSendUnlinked` reads CANNOT EVALUATE.

A suite report has these parts, in this order: a title such as `Tagreeve suite: published vs workspace on shop.example.com, 2026-10-31`, a header with the suite ID, the label (when the suite has one), the variants and the exit code, a verdict per variant, which adds the number of runs to a built-in check (`built-in check sandboxPageUrl failed in 4 runs`), a results table, the run sections for each scenario and variant, and last a diff section per variant pair. A flag change with no host reads `unloadGap: 0 -> 1`. `report` reads suite manifests of version 1, 2 and 3. For a suite with stores, the results table has a Store column and a row per scenario and store, the run sections are headed `<scenario> on <store>, <variant>`, the verdict has one line per store and variant, and each diff section names its store.

The marks, worst first:

| Mark | Meaning |
| --- | --- |
| `leak` | A hit that `deniedIdentifiers` flags, or that is in the evidence of a failed `deniedIdentifiers` result at either severity, or of a failed `mustNot` with a consent scope (`in: epoch(denied)`, `in: epoch(withdrawn)`, `before: consent` or a `consent.<field>: denied` filter). A failed `mustNot` with no consent scope does not mark a hit. |
| `unchecked` | A hit with a denied signal whose body was not fully recorded, or that has identifier names whose own consent signal is unknown. A result that cannot be evaluated also gives `unchecked`, never `leak`. Tagreeve cannot call it clean. |
| `mixed` | Granted and denied hits in one segment, or a hit with some signals granted and some denied. A hit with any denied signal is never shown as plain `full`. |
| `early` | A hit with unknown consent in the undecided epoch, with the label "before an answer". The page set no Consent Mode default, so the hit fired before the person answered. A page with a denied default gives `ping` instead. |
| `full` | Hits with every known signal granted, or with no signal known after an answer. |
| `ping` | Hits sent while consent is denied, with no identifier names recorded. `cid`, `fbp` and click IDs are not identifiers here. |
| `nothing` | No hit. |

Only names and counts are shown: no request URL, query value, body, page path, cookie value, hash, identity value or result message. A result's `note` is shown as a fixed sentence, for example "stub mode: stubbed endpoints set no cookies, so this pass says nothing about server cookies". A scenario's `params`, `ids` and `page` keys show their names and never their values. Every string from the records is escaped. The file has no script, no link, no image and no font, one inline style and a `Content-Security-Policy` meta tag. It does not claim that a site complies with a law.

```bash
tagreeve report runs/run_<id>.jsonl --html report.html
tagreeve report runs/suite_<id> --html suite-report.html
```

`report` for a record from before schema version 2 shows `not recorded` where field names are missing.

### `tagreeve server-container build`

```bash
tagreeve server-container build
```

On arm64 it builds the Docker image that the server container feature runs, and tags it `tagreeve-sgtm:<tagreeve version>`. It prints the image ID. It needs Docker and pulls large images, so it is a command of its own: a run never builds an image. It exits 2 when `TAGREEVE_SERVER_CONTAINER_BASE` is set and is not a digest reference. On arm64 it first asks Docker for its version. If Docker is missing or its daemon does not answer, it exits 2 and says `Docker is needed for --server-container. Install it from https://docs.docker.com/get-docker/`. It also exits 2 when the build fails. On amd64 it builds nothing and does not call Docker. With a valid or unset override it exits 0 and prints the image reference: the override, or Google's default.

On an arm64 machine (Apple silicon) the image is built here from Google's image, which is amd64 only. The build copies Google's app files and `node_modules` into a Node 24 distroless image and rebuilds the native `re2` module for arm64. Tagreeve holds the Dockerfile in its own code, writes it to a temporary folder and builds from that folder. It pulls Google's image under Google's terms, never pushes an image, and never puts a file of Google's in a place other than your Docker. On an amd64 machine no build is needed: the command prints the image reference to pull and use as it is.

The Google image and the base images are pinned by digest. `TAGREEVE_SERVER_CONTAINER_BASE` overrides the Google image reference. It must be a digest reference (`name@sha256:<64 hex>`).

### `tagreeve init`

Sets up the folders in the current directory. It makes `tagreeve/scenarios/` and `tagreeve/baselines/`, and adds `/tagreeve/runs/` to `./.gitignore`. It skips the line when git already ignores `tagreeve/runs/`, or when `.gitignore` already has it. It writes no scenario and no config file, never overwrites a file, and prints what it created or skipped. It exits 0.

`run` and `suite` print one warning on stderr when the record folder is inside a git work tree and git does not ignore it: `Warning: <folder> is not in .gitignore. Records hold full request bodies; do not commit them. Run tagreeve init or add the folder to .gitignore.` The warning never fails a run. It is silent outside a git work tree, or when `git` is not installed.

### `tagreeve install-browser`

Installs Chromium with the Playwright version Tagreeve depends on.

### `tagreeve --version`

Prints the version.

## Project config

`tagreeve/config.yml` holds the settings that every run of a project shares. `run` and `suite` read it from the current directory only, never from a parent folder. `--config <file>` reads another file instead. A `--config` file that does not exist exits 2. Without the flag, a missing `tagreeve/config.yml` is fine.

```yaml
configSchemaVersion: 1
site: https://staging.example.com
out: records
options:
  allowUnknownDestination: [cdn.example.com]
  firstPartyHosts: ['*.example.com']
  builtins:
    earlyIdentifiers: fail
```

| Key | Meaning |
| --- | --- |
| `configSchemaVersion` | Required. Always `1`. |
| `site` | An http or https URL with no user name or password. Used when `--site` is not given. |
| `out` | A folder. Records go to `<out>/<YYYY-MM-DD>[-<label>]/`, as the default folder does. Only `--out` is used exactly as given. |
| `options` | `allowUnknownDestination`, `builtins`, `firstPartyHosts`, `platformHosts`, `serverHosts`, `unloadGapIgnore` and `identifierFields`. Each is checked like the same option in a scenario. |

The config never overrides a scenario. A scenario's own option wins, and a list in the scenario replaces the config's list. `builtins` merges per check, and the scenario wins for a check it sets. A flag on the command line wins over both.

`serverHosts` says which hosts are your server. It does not turn server mode on. Server mode still comes from `--network server` or a scenario's `network: server`. A scenario with `network: server` and no `serverHosts` takes the hosts from the config.

The config cannot widen what a run may do, and it never holds a secret. These keys exit 2, at the top level and in `options`: `network`, `serverContainer`, `serverContainerConfig`, `allowTestPayment` and `gtmOverride`. So does any key that is not in the table. The error names the file, the key and the line, and never the value:

```text
tagreeve/config.yml: line 3, gtmOverride: not allowed in the project config. Pass it on the command line.
```

`--allow-test-payment` needs `--site` on the command line (or `--stores` for `suite`). A `site` in the config is not enough, because the flag names the host of the `--site`.

When the file comes from the default path, the text summary lists it on the `Defaults:` line, and `--json` has `{ "setting": "config", "path": "tagreeve/config.yml" }` in `defaults`. A `--config` path is not listed.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every expectation and built-in check passed, or failed only as a `warn` check. |
| 1 | At least one expectation or built-in check failed, or `--baseline` found drift. |
| 2 | Usage error, invalid scenario, a missing or invalid `--baseline` file, a `payment` step without `--allow-test-payment <host>` for the `--site` host or without that host in the allowlist file, an invalid stores file, `--site` together with `--stores`, a store variable that no scenario declares, `server-container build` with a `TAGREEVE_SERVER_CONTAINER_BASE` that is not a digest reference (on any arch), or on arm64 without Docker or with a failed build, or the run failed (for example the banner was not shown, or a card field was filled on a non-loopback host). If Chromium is missing, the message says to run `tagreeve install-browser`. |

A usage error prints its message and one line, `Run tagreeve <command> --help for the options.`, on stderr. It does not print the full help. `--help` prints it. The line names the command when the arguments name one, also when an option comes before the command. An unknown option prints one short message, for example `Unknown option --bogus.`. Every command takes `--help` and prints its own options, for example `tagreeve diff --help`.

The JSONL file is still written when a step fails, up to the failing step.

A built-in check can be set to `warn` with `options.builtins`. A warned check still runs. Its `result` record keeps the evidence and has `severity: "warn"`. The text summary shows it as `WARN` with its message. It does not change the exit code. `expect` rules are not affected. Use it for a failure you accept, such as `sandboxPageUrl` on a Shopify custom pixel, so that a clean run exits 0 in CI:

```yaml
options:
  builtins: { sandboxPageUrl: warn }
```

The `--json` summary has `severity` on every result, `expect` rules included. A rule with no recorded severity reads `fail`, which is what the exit code uses. `pass` is true when every result passed, warnings included, and the run shows no baseline drift. `ok` is true when no result failed at `fail` severity and there is no baseline drift, which is when the exit code is 0. A CI script can read `ok`.

A CI job can gate on the exit code, or on `ok` in the `--json` summary:

```bash
tagreeve run checkout.yml --site https://staging.example.com
tagreeve run checkout.yml --site https://staging.example.com --json | jq -e .ok
```

### deniedIdentifiers

The `deniedIdentifiers` check fails when a hit carries an identifier field while the consent signal for that field's class is denied. It reads the field names that the decoders record in `Hit.idFields`. It never reads or prints a value. Google hits (`ga4`, `google-ads`) are judged by their own `gcs` and `gcd`. Every other hit, a server hit included, is judged by the consent epoch it falls in. An unknown signal is not flagged. The check reads hit fields only, not the `Cookie` header of a request, so an identifier that goes out only in a cookie header is left to the [cookie rules](#rules-on-cookies).

| Class | Field names | Signal that must not be denied |
| --- | --- | --- |
| Analytics id | `user_id`, `uid`, `up.user_id`, any other field with a 64-character hex value, and the names in `identifierFields` | `analytics` |
| Ads identity | `external_id`, `ud`, `ud[*]`, `user_data`, `user_data.*`, `em`, `ph`, `hashed_email`, `customer_hashed`, `cookieData` | `adUserData`, or `ads` when `adUserData` is unknown (Google hits with `gcs` but no `gcd`, and hits in an epoch that has no `adUserData`) |
| Client-ID hash | `clientIdHash`, `client_id_hash`, `cid_hash` | `analytics` |

These are not flagged on purpose: `cid`, `client_id`, `_ga`, `fbp`, `fbc` and `gclid`. GA4 cookieless pings carry a random `cid`.

The result lists vendor, field names and the denied signal, and its evidence is the hit IDs. If a hit sent while consent is denied has no recorded field names (a version 1 record) or a body that was cut, the check reports `cannot evaluate` and fails, with `note` set to `fieldsNotRecorded` or `cannotEvaluateBody`. The same holds for a denied hit whose body was not fully recorded: cut at 64 KiB, JSON that did not parse, or a `--net-log` POST hit, which has no body.

Upgrading to 0.3 can change exit codes. The check is `fail` by default, like the other built-in checks, so a run that sent a hashed custom parameter on a denied hit now exits 1. To keep the old exit code while you fix it, set the check to `warn`:

```yaml
options:
  builtins: { deniedIdentifiers: warn }
```

### earlyIdentifiers

The `earlyIdentifiers` check warns when a hit sent before the first consent answer carries an identifier field and the consent signal for that field's class is unknown. This is the case on a page with no Consent Mode default, where a tag can send a hashed email before the visitor sees the banner. It uses the same field classes, signals and ignored names as [deniedIdentifiers](#deniedidentifiers), and it reads field names only.

Both checks read the fields of decoded hits. They do not read the `Cookie` header of a request. An identifier that travels only in a cookie header is not seen: a Pinterest hit sent before consent can pass `earlyIdentifiers` because its identifiers are in the `Cookie` header. The [cookie rules](#rules-on-cookies) cover those.

A field is never reported by both checks. A field whose signal is denied belongs to `deniedIdentifiers`, so a hit with one denied and one unknown identifier is in both results. A granted signal, and any hit after an answer, is not flagged. A hit with only `cid`, `fbp`, `fbc` or `gclid` is not flagged.

The default severity is `warn`, so the exit code does not change. The result reads `1 hit carries identifiers before the consent answer: meta ud[em] (ads unknown).` The field names are the ones the decoder recorded, and the signal is `ads` when `adUserData` is unknown. The evidence is the hit IDs. A hit before the answer with no recorded field names or a body that was cut reports `cannot evaluate`, like `deniedIdentifiers`. To make the check fail a run, set it to `fail`:

```yaml
options:
  builtins: { earlyIdentifiers: fail }
```

In the report, a flagged hit gets the `leak` mark with the label `identifiers sent before an answer`, judged per field: a hit with `em` is `leak`, and a hit with only `fbp` stays `early`. The label `identifiers sent while denied` wins when a hit is in both checks. The verdict reads `identifiers go out to <vendor> in the undecided state`.

