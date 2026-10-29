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
   - The recorder matches the container request at `www.googletagmanager.com/gtm.js`, as §8.2 says. It also matches a configurable loader pattern, so a site that loads GTM through a custom loader can be tested. One option is to replace the loader response with the preview build from `www.googletagmanager.com`. Another is to pass the preview values through the loader, if the loader forwards them **(verify)**. Either option loses what the loader adds beyond fetching the container, and the run record must say so.
   - The override applies to the run only, and the record stores it as `gtmOverride`.
   - Acceptance: the fixture site serves two container builds. One run with the override and one without show different hits.

2. **`pingwright diff <a> <b>`** (design §15, already planned for 0.2).
   - The diff groups hits by consent epoch label, then vendor, then event.
   - It reports hits that were added or removed, and hits whose consent or IDs changed (for example `gcs` G100 → G111, or `user_id` present → absent).
   - It also reports changes in flags per host and kind.
   - Text and `--json` output. Exit 0 always. A diff is a report, not a check.
   - Acceptance: a diff of two fixture runs shows a known added hit and a known consent change.

3. **`pinterest` decoder** (design §15, already planned for 0.2).
   - Decodes `ct.pinterest.com/v3/` and `/user/` requests: event, `tid`, page (`ad.loc`), event ID, and hashed `em` presence.
   - Stubs Pinterest collection hosts in `stub` mode.
   - Acceptance: synthetic fixtures for init, pagevisit, addtocart and checkout, and a Pinterest rule that fails in an e2e run.

4. **Fix the checks that fail on every real run.**
   - #46: decode Stape data-client POST requests (JSON body, event in the query string), and stub them. In 0.1 they reach the real server container.
   - #114: `possibleRealData` must not flag random IDs or hashed client IDs.
   - #112: subdomains of the site are not third party by default.

5. **Withdrawal epochs** (#119). Label a denied epoch that follows a granted epoch as `withdrawn`, and accept `epoch(withdrawn)` in rules. Withdrawal is where trigger-group setups break.

### 3.2 Should have

6. **Shopify checkout scenario** (a part of design §10.1, moved forward from 0.4).
   - A documented scenario pattern: product, add to cart, checkout, fill with the fake identity, set the delivery country explicitly, then a `handoff` step for payment.
   - The thank-you page gets its own step, so purchase hits can be matched with `after:`.
   - `identity.hashesMatch` runs on the purchase hits.
   - No new automation of payment. The handoff rule in §5.4 stays as it is.

7. **Usable output on real sites.**
   - #116: group flags by host in the text summary.
   - #115: record why a request failed.
   - #117: `addToCart` checks that something was added to the cart.
   - #118: `run --help` shows the options for `run`.

### 3.3 Moved out of 0.2

- **MCP server** moves to 0.3. The CLI with `--json` and the JSONL record served an agent well in the field test. With `diff`, the CLI covers the main job. The MCP schema benefits from what `diff` and the override teach us first.
- **`microsoft-uet` decoder** moves to 0.3. No field test has needed it yet.

## 4. Milestones after this change

1. **0.1:** as released.
2. **0.2:** GTM override (web, including custom loaders), `diff`, `pinterest` decoder, withdrawal epochs, the field-test fixes, Shopify checkout pattern.
3. **0.3:** MCP server (schema frozen first), web tag-firing reporter, expected tag lists, `microsoft-uet` decoder.
4. **0.4:** Shopify custom pixel bridge, collector origin bridge.
5. **0.5:** `server` mode, server reporter, sink reader, server workspace preview header.

## 5. How we know 0.2 is done

- Every item in §3.1 has its acceptance test passing in CI against the fixture site.
- A field run like the one in §1 can do this with no scripts outside Pingwright:
  1. Run the four scenarios against the published container.
  2. Run them again with `--gtm-override` for a changed workspace.
  3. `pingwright diff` each pair, and read the change per consent state.
  4. Fail on rules such as "GA4 page_view fires while undecided at G100 with no `user_id`" and "no Meta or Pinterest hit in `epoch(denied)` or `epoch(withdrawn)`".
- On a real storefront, the built-in checks fail only for real findings.

## 6. Open questions

- Do Stape custom loaders forward `gtm_auth` and `gtm_preview` to the container request? If they do, the override can keep the loader in place.
- Should `diff` match hits by event order, or only compare counts per group? Counts are simpler and probably enough for 0.2.
- Is a Pinterest decoder enough, or does 0.2 need a generic decoder for "pixel-style GET with an event parameter", so new vendors become rules without new code?
