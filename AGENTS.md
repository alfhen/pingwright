# Working on Pingwright

This file is for coding agents and the people who run them. It says how a change gets from an idea to `main`, and the rules every change follows.

The spec is [docs/design.md](docs/design.md). The current plan is the newest `docs/plan-*.md`. Read both before you change code.

## Rules for every change

- **No real data.** Never put real personal data, real store data, real container IDs or secrets in the repo, an issue or a PR. Fixtures use fake identities and fake IDs only: GA4 `G-PWTEST0001`, Google Ads `AW-000000001`, Meta pixel `100000000000001`, GTM `GTM-PWTEST1` and `GTM-PWNOVER`.
- **The `gtmAuth` value**, in any form, never appears in a record, a log line, an error message or test output.
- **Payments and log-ins** are always `handoff` steps for a person on any hosted site. Only loopback hosts (`localhost`, `127.0.0.1`, `::1`), such as the fixture site, may be automated through payment.
- **No hosted service.** Pingwright never calls the GTM API. Each user runs their own sink.
- **Tests stay local.** E2E tests run only against `fixtures/site` in `stub` mode. Never use a real store as an e2e target.
- **Browser.** Use context-level hooks only (`context.route`, `context.on('request')`, `context.addInitScript`, `context.exposeBinding`). Send a normal Chrome user agent, never one containing `HeadlessChrome`. No browser flags in the default launch. `--net-log` (opt-in) adds Chromium's `--log-net-log`, and nothing else uses a CDP session or a flag. CDP auto-attach on every target was measured and does not see unload-time requests (design §5.3).
- **Third-party code.** `@duckduckgo/autoconsent` (MPL-2.0) is an unmodified dependency. Never copy or patch its files. Tracker Radar, EasyPrivacy and Disconnect are not sources: never ship them or derive tracker entries from them. Tracker entries link to the vendor's own docs.
- **Releases.** Never publish to npm or create a GitHub release without the maintainer's say-so. Never force-push `main`.

## Toolchain

- Node 22.18 or newer. pnpm 10.34.7 through corepack (`COREPACK_ENABLE_DOWNLOAD_PROMPT=0`).
- Playwright 1.64.1 exactly. `@duckduckgo/autoconsent` 16.51.0 exactly.
- New dependencies get an exact version that is at least two weeks old.
- Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e`.
- Browsers can fail to launch inside an agent's command sandbox. Run browser commands outside it.

## Writing

- Docs, commits and PR text use plain, short sentences.
- Code comments are rare. Write one only for a reason the code can't show: why it is this way, a hidden constraint, or a property a refactor must keep. Design reasoning goes in the PR.
- Diagrams are Mermaid code blocks (` ```mermaid `) in the markdown, with a one-line text summary under each. No images of diagrams.
- Match the style of the code around you.

## How a change is made

Each change is one PR on its own branch from `main`. Big work is split into a plan first (see `docs/plan-0.2.md`): each entry has a **Touches** line and an **Acceptance** line, and entries in the same wave touch different files so they can be built in parallel.

Every PR goes through the same loop. Each step is a separate agent, so no agent checks its own work.

1. **Implement.** An agent builds the plan entry on its branch, with unit tests and the e2e test named in the Acceptance line. It runs every check until it passes, and makes sure the e2e test fails when the feature is broken. It pushes the branch. It does not open the PR.
2. **Test from a clean clone.** A second agent clones the branch fresh and runs `pnpm install --frozen-lockfile`, `pnpm exec playwright install chromium` (add `--with-deps` on a machine without the system libraries, as CI does), lint, typecheck, unit tests and e2e. It checks the acceptance test exists and really ran. It changes no code.
3. **Adversarial review.** A third agent, on a stronger model, reviews the diff against the design doc and the plan entry. It looks for bugs, spec drift, privacy and security problems, scope creep, broken rules, and tests that pass for the wrong reason. It ranks each finding as blocker, major or minor.
4. **Fix.** If the tests failed or there are blockers or majors, a fix agent fixes them on the same branch, adding commits, never force-pushing. If it thinks a finding is wrong, it says why, with evidence. Then steps 2 and 3 run again. The loop stops when there are no blockers or majors, or after four rounds, when a person decides.
5. **Open the PR and handle the bots.** An agent opens a ready PR, which says how it was tested and how many review rounds it took. It files each minor finding as a GitHub issue with the label `review-minor`. It waits for CI and for the review bots (CodeRabbit and Gitar), and replies on every bot thread: it fixes the point, or says why not.
6. **Merge.** A PR is merged when CI passes on the head commit and Gitar or CodeRabbit has approved it. Merges are squash merges. The branch is deleted only after GitHub shows the PR as merged.

PR bodies put each `Closes #N` on its own line. GitHub closes only the first issue on a line like `Closes #1, #2`.

## Fixing review-minor issues

Open `review-minor` issues are fixed in batches between plan waves. Batches are grouped by the files they touch, so they can run in parallel. Each batch goes through the same loop as above. A batch that can't fully fix an issue leaves it open with a comment saying what is left.

## Releasing

Releases are git tags with a built `dist/`, made on `main` by `scripts/release.sh <version>`. The script refuses to run unless HEAD is `origin/main`, the tree is clean and `package.json` has the same version. It makes a release commit that only the tag points at, and that is never merged to `main`. Push the tag, then check it installs:

```bash
npm i -g --install-links github:alfhen/pingwright#v<version>
pingwright --version
```

Release candidates (`-rc.N`) are field-tested on a real store before the final release. That is a supervised run in `stub` mode, outside the e2e suite, with a person at every payment and log-in handoff.
