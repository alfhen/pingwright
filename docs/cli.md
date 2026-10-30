# CLI

## Install

```bash
npm i -g --install-links github:alfhen/pingwright#v<version>
pingwright install-browser
```

`--install-links` is needed because without it npm 10 links the global package to a temporary clone that it then deletes.

Or build a tarball in a checkout and install that:

```bash
pnpm install && pnpm build && pnpm pack
npm i -g ./pingwright-<version>.tgz
```

Installing from a branch such as main does not work. Only release tags carry a built `dist/`.

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
| `--autoconsent-rules <file>` | Extra autoconsent rules. Can be repeated. |
| `--var <k=v>` | Overrides a variable the scenario declares under `vars`. A name the scenario does not declare exits 2. Can be repeated. |
| `--json` | Prints a JSON summary on stdout instead of the text summary. |

`pingwright run --help` prints this command's own help.

The text summary lists hits per vendor and event, consent epochs, flags (`unknownDestination` and `firstPartySubdomain` grouped by host, with a count and up to three example paths; the `--json` summary keeps every flag), each expectation with PASS or FAIL (failures show the message; every expectation shows up to five evidence IDs and a count of the rest), and the path of the JSONL file. The `result` records are appended to that file.

First-party hosts: the registrable domain of `--site` is first party, so `--site https://www.shop.co.uk` does not flag `shop.co.uk` or `*.shop.co.uk` as `unknownDestination`. Data-carrying requests to those subdomains that no decoder matches are listed as `firstPartySubdomain` and do not fail the run. IP addresses and `localhost` are first party only as the exact `--site` host. Scenario options:

| Option | Meaning |
| --- | --- |
| `firstPartyHosts` | List of hosts or `*.domain` wildcards that are also first party, for example `['i.guim.co.uk', '*.shopifycdn.com']`. A wildcard matches subdomains, not the bare domain. |
| `allowUnknownDestination` | `true` allows every unknown destination. A list of hosts or wildcards allows only those, and every other unknown destination still fails. |

To withdraw consent, reopen the banner with a `click` on the site's cookie settings link, then answer it with `consent: reject` (`consent: withdraw` is the same answer). Without the click the step fails with "banner not shown (withdraw needs the banner reopened first)".

```yaml
steps:
  - consent: accept
  - click: "#pw-cookie-settings"
  - consent: withdraw
```

`addToCart` clicks the selector and then needs proof that the cart changed: a cart request such as a POST to `/cart/add`, or an `add_to_cart` dataLayer event. Without it the step fails with "click did not add to cart", for example when the click only opened a variant picker. Through the library, `cartCheck` and `cartTimeoutMs` in the play options replace the check and the 5 s wait.

During a `handoff` step, requests that are not tracking hits are stored without their body and query values (`redacted: handoff`), so passwords typed by the person are not kept.

Payments and log-ins are handoff steps on any host other than `localhost`, `127.0.0.1` or `::1`. Filling a card or password field on another host fails the run.

### `pingwright install-browser`

Installs Chromium with the Playwright version Pingwright depends on.

### `pingwright --version`

Prints the version.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every expectation and built-in check passed. |
| 1 | At least one expectation or built-in check failed. |
| 2 | Usage error, invalid scenario, or the run failed (for example the banner was not shown, or a card field was filled on a non-loopback host). If Chromium is missing, the message says to run `pingwright install-browser`. |

The JSONL file is still written when a step fails, up to the failing step.
