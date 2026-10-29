# Proposal for milestone 0.2

Status: proposal. This document suggests a new scope for 0.2, based on the first field test of 0.1.0-rc.1. If it is accepted, design §15 and a `plan-0.2.md` checklist follow from it.

## 1. What the field test showed

We ran 0.1.0-rc.1 against a real Shopify staging store with `--network stub`. The store uses a consent management platform (CMP), a web GTM container loaded from a Shopify custom pixel through a Stape custom loader, and a server GTM container. We ran four scenarios: undecided, accept, reject, and accept then withdraw. Each scenario has a product page, a colour pick, an add to cart and a collection page.

What worked:

- Every run finished. autoconsent found and answered the CMP banner each time, including a reopened banner for the withdrawal.
- Recording covered the sandboxed custom pixel iframe.
- GA4 hits through the server container were decoded with their consent state (`gcs`, `gcd`) and `user_id` presence.
- Consent epochs had sensible timing. The withdrawal made a third epoch.
- Expectations failed with record IDs as evidence.
- The runs found a real defect: Meta, Pinterest and the GA4 `user_id` keep going after a withdrawal.

What blocked a full answer:

- We can't test a change before we publish it. This store loads the container through a custom loader, and no 0.1 option can override that.
- Comparing two runs needs a script over the JSONL files.
- Pinterest was one of the main offenders, but it appeared only as `unknownDestination` flags. No rule could name it.
- The purchase path was not covered.
- Two checks failed on every run for reasons that were not defects (#114, and the stub leak in #46). This hides real failures.

Issues from the test: #46 (comment), #88 (comment), #114 to #119.

## 2. The question 0.2 should answer

> Here is a GTM change. Run the same scenarios against the published container and against the changed workspace. Show what changed per vendor, event and consent state, and fail if a rule is broken.

This is the main job an agent or a reviewer has when they change a tag setup. 0.1 answers half of it: it can record the published container. 0.2 should answer all of it.

## 3. Proposed scope

### 3.1 Must have

1. **GTM override per run, including custom loaders** (moved forward from 0.3, design §8.2).
   - `--gtm-override <file>` takes the JSON in §8.2: container, `gtmAuth`, `gtmPreview`, and optional `expectedTags`.
   - 0.2 stores `expectedTags` in the record but does not evaluate it. "Did not fire" needs the web tag-firing reporter, which stays in 0.3.
   - The recorder matches the container request at `www.googletagmanager.com/gtm.js`, as §8.2 says. It also handles sites that load GTM through a custom loader. There are three ways, from narrowest to widest:
     1. **Rewrite the decoded container request.** A Stape loader fetches the container as a disguised request (`/<id>?<key>=<base64 of /gtm.js?id=…>`), and the `stape-custom-loader` decoder already decodes it. The recorder matches the decoded `gtm.js` request and answers it with the preview build, fetched with `route.fetch`. The loader script itself stays in place. This is the preferred way.
     2. Pass the preview values through the loader, if the loader forwards them **(verify)**.
     3. Replace the whole loader response with the preview build from `www.googletagmanager.com`. This loses what the loader adds beyond fetching the container.
   - The run record states which way was used and what it may lose.
   - The override applies to the run only, and the record stores it as `gtmOverride`. `gtmAuth` is a credential for the preview build, so the record stores it as `"[redacted]"`. The same rule applies to `gtm_auth` in any recorded request URL, in request headers such as `Referer`, and in any preview or debug beacon the preview build sends. Design §13 adds `gtmAuth` to "Secrets are always redacted".
   - Acceptance:
     - The fixture site serves two container builds. One run with the override and one without show different hits.
     - This is tested three times: with a direct `gtm.js` load, with a load through a Stape-style custom loader, and with that loader running inside a sandboxed iframe like a Shopify custom pixel.
     - The record of each loader run states the way used.
     - No JSONL line contains the `gtmAuth` value.

2. **`pingwright diff <a> <b>`** (design §15, already planned for 0.2).
   - The diff groups hits by consent epoch label, then vendor, then event.
   - It pairs hits across the two runs by a match key: epoch label, vendor, event and step label. An option adds the page path to the key, for steps that visit more than one page. Inside one key, it pairs hits in time order: the first with the first, the second with the second. An unpaired hit is reported as added or removed.
   - The `Run` record gets a record schema version. `diff` warns when the two runs have different versions.
   - For each pair, it reports a change in consent (for example `gcs` G100 → G111) or in ID presence (for example `user_id` present → absent).
   - Pairing by order is a heuristic. A scenario that sends the same event a different number of times in one step can pair the wrong hits. The output says which keys had different counts, so a reader can check them.
   - It also reports changes in flags per host and kind.
   - Text and `--json` output. Exit 0 always. A diff is a report, not a check.
   - Acceptance: a diff of two fixture runs shows a known added hit, a known removed hit and a known consent change on a paired hit.

3. **`pinterest` decoder** (design §15, already planned for 0.2).
   - Decodes `ct.pinterest.com/v3/` and `/user/` requests: event, `tid`, page (`ad.loc`), event ID, and hashed `em` presence.
   - Stubs Pinterest collection hosts in `stub` mode.
   - Acceptance: synthetic fixtures for init, pagevisit, addtocart and checkout, and a Pinterest rule that fails in an e2e run.

4. **Stub known tracker hosts that have no decoder.** In 0.1, `stub` mode lets every vendor without a decoder through. The field test showed this with Pinterest: real hits reached it, and no rule could name it. A decoder fixes one vendor at a time. This item fixes the leak for all of them.
   - In `stub` mode, the recorder also stubs data-carrying requests that are not script, stylesheet, font or document loads, to hosts on a list of known tracker hosts. DuckDuckGo Tracker Radar (design §16) can supply the list, pinned to a version and shipped with Pingwright. Library loads still pass, so vendor scripts run.
   - These requests are recorded with `outcome: stubbed` and the tracker's name, even with no decoder.
   - A host-based rule can name them, for example `{ host: ct.pinterest.com, before: consent }`.
   - Acceptance: a fixture page sends a pixel request to a listed tracker host that has no decoder. The request is `stubbed`, a host rule matches it, and its script load still passes.

5. **Fix the checks that fail on every real run.** These fixes and those in item 8 are already in progress as issue batches. They ship first in `0.1.0-rc.2`, ahead of 0.2, because #46 is a stub-mode leak in a tagged release. 0.2 inherits them.
   - #46: decode Stape data-client POST requests (JSON body, event in the query string), and stub them. In 0.1 they reach the real server container.
   - #114: `possibleRealData` must not flag random IDs or hashed client IDs.
   - #112: subdomains of the site are not third party by default.
   - Acceptance:
     - #46: a fixture page sends a Stape-style `POST /data` with a JSON body through a custom loader. The run makes a `sgtm` hit with the event name, and the request has `outcome: stubbed`.
     - #114: a fixture page sends a random 64-character hex ID and a hashed client ID in non-identity fields. `possibleRealData` passes. A SHA-256 of an email that is not the run identity, sent as `em`, still fails it.
     - #112: a request to a subdomain of `--site` is not flagged as `unknownDestination`. A request to a different registrable domain still is.

6. **Withdrawal epochs** (#119). Withdrawal is where trigger-group setups break.
   - `withdrawn` is a label, not a new consent state. Withdrawal is defined per signal: an epoch gets the label `withdrawn` when it denies at least one signal that any earlier epoch in the run granted. Its state keeps the consent values, for example `denied` or `mixed`.
   - `ConsentEpoch.label` already exists and today holds values such as `denied` and `mixed`. For a withdrawal, `withdrawn` replaces that label.
   - The rule covers every way back from a grant:
     - granted then denied;
     - granted then mixed (a partial withdrawal);
     - mixed then denied, for example a visitor who accepts only analytics and then rejects everything;
     - granted, mixed, then denied, where both later epochs are `withdrawn`;
     - granted, denied, granted, denied, where both denied epochs are `withdrawn`.
   - `in: epoch(denied)` keeps its meaning from design §7.3: it matches by state, so it matches withdrawn epochs too.
   - A new selector, `in: epoch(label=<label>)`, matches by label. `label` is a reserved name, so it can't be mistaken for a consent field such as `analytics`.
   - `diff` groups by label, so a withdrawn epoch is not compared with a first reject.
   - Acceptance: in an accept-then-withdraw fixture run, the last epoch has state `denied` and label `withdrawn`. A Meta hit sent after withdrawal fails `mustNot: { vendor: meta, in: epoch(label=withdrawn) }`. The same hit fails `mustNot: { vendor: meta, in: epoch(denied) }`. In a reject-only run, `epoch(label=withdrawn)` matches nothing. Unit tests cover each sequence in the list above, including mixed then denied.

### 3.2 Should have

7. **Shopify checkout scenario** (a part of design §10.1, moved forward from 0.4).
   - A documented scenario pattern: product, add to cart, checkout, fill with the fake identity, set the delivery country explicitly, then a `handoff` step for payment.
   - The thank-you page gets its own step, so purchase hits can be matched with `after:`.
   - `identity.hashesMatch` runs on the purchase hits.
   - No new automation of payment. The handoff rule in §5.4 stays as it is.
   - The payment handoff waits for a person, so this pattern can't run unattended in CI or from an agent session. It is a field-run pattern. Its fixture-site version, which pays on localhost, runs in CI.

8. **Usable output on real sites.** In progress, and ships in `0.1.0-rc.2` (see item 5).
   - #116: group flags by host in the text summary.
   - #115: record why a request failed.
   - #117: `addToCart` checks that something was added to the cart.
   - #118: `run --help` shows the options for `run`.

### 3.3 Moved out of 0.2

- **MCP server** moves to 0.3. The CLI with `--json` and the JSONL record served an agent well in the field test. With `diff`, the CLI covers the main job. The MCP schema benefits from what `diff` and the override teach us first.
- **`microsoft-uet` decoder** moves to 0.3. No field test has needed it yet.

## 4. Milestones after this change

1. **0.1:** as released in `0.1.0-rc.1`. `0.1.0-rc.2` adds the field-test fixes (items 5 and 8) and the other open issue fixes.
2. **0.2:** GTM override (web, including custom loaders), `diff`, `pinterest` decoder, stubbing of known tracker hosts, withdrawal epochs, Shopify checkout pattern.
3. **0.3:** MCP server (schema frozen first), web tag-firing reporter, expected tag lists, `microsoft-uet` decoder.
4. **0.4:** Shopify custom pixel bridge, collector origin bridge.
5. **0.5:** `server` mode, server reporter, sink reader, server workspace preview header.

## 5. How we know 0.2 is done

- Every item in §3.1 has its acceptance test passing in CI against the fixture site.
- A field run like the one in §1 can do this with no scripts outside Pingwright:
  1. Run the four scenarios against the published container.
  2. Run them again with `--gtm-override` for a changed workspace.
  3. `pingwright diff` each pair, and read the change per consent state.
  4. Fail on rules such as "GA4 page_view fires while undecided at G100 with no `user_id`" and "no Meta or Pinterest hit in `epoch(denied)`". That rule covers both a reject and a withdrawal.
- A field-run checklist, not a CI test: on a real storefront, the built-in checks fail only for real findings.

## 6. Open questions

- Do Stape custom loaders forward `gtm_auth` and `gtm_preview` to the container request? If they do, option 2 in item 1 works. Option 1 does not depend on the answer.
- Is pairing by time order inside a match key good enough for `diff`, or do some vendors need a stronger key, such as an event ID that stays the same across runs?
- When should Pingwright get a generic decoder for "pixel-style GET with an event parameter", so new vendors become rules without new code? Item 4 stops the leak for undecoded vendors in 0.2, and host rules can name them. A generic decoder can wait until after 0.3.
