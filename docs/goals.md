# Goals

Tagreeve is an agent-first CLI that tests a website's tracking and consent: it plays a visitor in a real browser, records every hit, and checks it against expectations. It is for coding agents, CI jobs and the people who run tracking setups.

## Goals

- Record what a site sends to each tracking vendor, for a scripted visitor, at each consent state.
- Report which tag manager tags fired or failed, per event, without a signed-in person. Report which expected tags did not fire, when the caller gives the container's tag list.
- Test an unpublished GTM workspace before publishing it, in the test browser only.
- Express expected behaviour as data, and report pass or fail with evidence.
- Compare two runs, or a run against a saved baseline, per vendor and per event.
- Expose all of this to agents through the CLI, with stable, structured `--json` results.
- Be safe by default: fake identities, no real payments, known collection endpoints stubbed, and every unknown destination flagged.
- A new user starts with one simple setup prompt to their agent. The first run shows where the setup likely breaks consent rules (for example a hit before consent), what to fix first, and other likely issues.
- Make it easy to change a GTM config reliably. Every change gets trusted signals that tracking still works as intended.

## Non-goals

- Production monitoring of real visitor traffic. Tools such as Trackingplan do this.
- A schema registry for product events. Tools such as Avo do this.
- Explaining why a tag did not fire. GTM exposes no trigger evaluation data outside its own debugger.
- Changing GTM containers. Agents use a GTM API client for that. Tagreeve only takes the values it needs as input.
- Legal advice or legal responsibility. Tagreeve shows what is sent and flags likely problems. People decide what is allowed, stay responsible for compliance, and check the output.
- A hosted service. Every part runs on infrastructure the user controls.
- Output tuned for people first. Output is designed for agents to read. People get the HTML report, but readability for people never wins over a stable `--json`.
- A second interface. Tagreeve is a CLI only, with no MCP server. Agents run the CLI and read `--json`. This changes only with the maintainer's say-so (#362).

## Users

- Tracking professionals who already know GTM and tracking well, in-house or at an agency, and are tired of testing changes by hand. They want trusted signals that tracking and consent still work after each GTM change. Shopify stores come first: Shopify is the only checkout platform Tagreeve supports today.
- Coding agents that run Tagreeve for those professionals. They set it up from one prompt, run scenarios, read `--json`, and report what to fix.
- CI jobs that run a suite or a baseline on each change, and fail the build on a regression.

## How to change this file

Only the maintainer changes the goals and non-goals, in a PR of their own. Plans are checked against this file before anything is built.
