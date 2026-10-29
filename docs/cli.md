# CLI

## Install

```bash
npm i -g github:alfhen/pingwright#<tag>
pingwright install-browser
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
| `--autoconsent-rules <file>` | Extra autoconsent rules. Can be repeated. |
| `--var <k=v>` | Sets a scenario variable. Can be repeated. |
| `--json` | Prints a JSON summary on stdout instead of the text summary. |

The text summary lists hits per vendor and event, consent epochs, flags, each expectation with PASS or FAIL (failures show the message and evidence IDs), and the path of the JSONL file. The `result` records are appended to that file.

Payments and log-ins are handoff steps on any host that is not on this machine. Filling a card or password field on another host fails the run.

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
