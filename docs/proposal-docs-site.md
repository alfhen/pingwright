# Proposal for a docs site on pingwright.dev

Status: proposal (#224). Nothing is built yet. If it is accepted, the PR plan in §9 follows from it.

## 1. Goal and non-goals

**Goal.** Publish the README and `docs/*.md` as a static site at `https://pingwright.dev`. The Markdown files in the repo stay the only source. The site has a sidebar and a search box, and it rebuilds when `main` changes.

**Non-goals**

- No analytics, no cookies, no forms, no third-party scripts, no fonts from a CDN.
- No Pingwright-hosted service. The site is documentation only.
- Nothing in `packages/` points at `pingwright.dev`. The collector origin stays `collector.pingwright.invalid`.
- No new content in this work. Pages are the existing files.
- No change to how releases are made. The site does not publish anything to npm.

## 2. Hosting

### 2.1 GitHub Pages, deployed by a workflow

The site is built by a GitHub Actions workflow and published with `actions/deploy-pages`. The Pages source is "GitHub Actions", not a branch. The repo is public, so Pages costs nothing.

With a workflow deploy, GitHub creates no `CNAME` file and ignores one if it exists. The custom domain lives in the repo's Pages settings. The PRs add no `CNAME` file and no `.nojekyll` file.

### 2.2 DNS records on Cloudflare

The zone is already on Cloudflare (`audrey` and `edward.ns.cloudflare.com`). It has no records yet. Add these, all with the proxy **off** ("DNS only", grey cloud) and TTL Auto:

| Type | Name | Content |
| --- | --- | --- |
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| AAAA | `@` | `2606:50c0:8000::153` |
| AAAA | `@` | `2606:50c0:8001::153` |
| AAAA | `@` | `2606:50c0:8002::153` |
| AAAA | `@` | `2606:50c0:8003::153` |
| CNAME | `www` | `alfhen.github.io` |
| TXT | `_github-pages-challenge-alfhen` | the value GitHub shows (§2.4) |

The addresses are from GitHub's "Managing a custom domain" page, checked on 2026-10-30. The `www` record points at `alfhen.github.io`, without the repo name, as GitHub asks. The site's domain is the apex, `pingwright.dev`. GitHub redirects `www` to it once both names resolve.

No wildcard records. GitHub warns that a wildcard such as `*.pingwright.dev` allows a takeover even of a verified domain.

### 2.3 Cloudflare proxy: off

The proxy stays off for three reasons:

- **Certificates.** GitHub checks that the records point at its own addresses, then gets a Let's Encrypt certificate for the domain. A proxied record resolves to Cloudflare's addresses, so the check sees the wrong host, and issue and renewal can fail.
- **Cookies and scripts.** A proxied zone can set cookies (`__cf_bm` with Bot Fight Mode, `cf_clearance` after a challenge) and inject scripts (Web Analytics, email obfuscation). Each is a dashboard setting away. With DNS only, none of them can reach the site.
- **One TLS hop.** GitHub terminates TLS. There is no Cloudflare SSL mode to get wrong.

What we give up: Cloudflare's cache and firewall. GitHub Pages already serves through a CDN, and a static docs site needs no firewall.

### 2.4 Domain verification

Verify `pingwright.dev` for the `alfhen` account before anything points at GitHub. Verification means only repos owned by `alfhen` can publish to `pingwright.dev` and its immediate subdomains, such as `www`. Without it, a takeover is possible whenever Pages is off but the DNS records still point at GitHub.

The steps are in account settings, not repo settings: **Settings → Pages → Add a domain**. GitHub shows a TXT record for `_github-pages-challenge-alfhen.pingwright.dev`. Add it on Cloudflare, check it with `dig _github-pages-challenge-alfhen.pingwright.dev TXT +short`, then click **Verify**. Keep the TXT record for good: removing it ends the verification.

GitHub's order: add the custom domain in the repo's Pages settings **before** adding the A, AAAA and CNAME records.

If the site is ever turned off, delete the A, AAAA and `www` records the same day.

### 2.5 HTTPS

`.dev` is on the HSTS preload list, so browsers only use HTTPS. Until GitHub has a certificate, browsers show a certificate error for `pingwright.dev`. Nothing links to the domain yet, so this gap is harmless. The README gets a link only after HTTPS works (§9, D5).

GitHub says a certificate can take up to an hour after the DNS check passes, and the **Enforce HTTPS** box up to 24 hours. Tick it as soon as it is available. Browsers don't need it, but `curl` and other plain HTTP clients do. If the certificate is stuck, remove the domain in the Pages settings and add it again.

If a CAA record is ever added, it must allow `letsencrypt.org`, or GitHub can't issue certificates.

### 2.6 Compared with Cloudflare Pages

| | GitHub Pages | Cloudflare Pages |
| --- | --- | --- |
| Deploy credential | None. The workflow's OIDC token, scoped to one job. | A Cloudflare API token stored as a repo secret, or the Cloudflare GitHub app with access to the repo. |
| Proxy | Off, so no cookies or injected scripts can appear. | Always proxied. Web Analytics is one click, and Cloudflare then adds its script to every page on the next deploy. |
| Apex DNS | Eight address records, set by hand. | Automatic, because the zone is on the same account. |
| PR previews | No. | Yes, per branch. |
| Response headers | Fixed by GitHub. No custom CSP header. | Set with a `_headers` file. |
| Accounts | GitHub only. | GitHub and Cloudflare. |

Cloudflare Pages would save the DNS setup and add previews and headers. It costs a long-lived secret, a second place where the site can change outside the repo, and a proxy that can add cookies and scripts. For a site whose one rule is "no tracking", that is the wrong trade. **GitHub Pages it is.**

## 3. Generator

### 3.1 Criteria

1. Builds from `README.md` and `docs/*.md` where they are, without copying them or adding front matter.
2. No client-side tracking and no CDN fonts by default.
3. Search that works from static files, with no hosted search service.
4. A small dependency tree.
5. Fits the pnpm and Node 22 workspace.
6. An exact version at least two weeks old (`pnpm-workspace.yaml` already sets `minimumReleaseAge: 20160`, 14 days, for every package in the tree).

### 3.2 Candidates

Checked on 2026-10-30 with `npm view <pkg> time --json`, `npm audit`, and each tool's docs. Package counts are from an npm lockfile and include optional platform binaries.

| | Uses files in place | Fonts and tracking | Search | Tree | Toolchain | Version |
| --- | --- | --- | --- | --- | --- | --- |
| **VitePress 2** | Yes: `srcDir` is the repo root, `rewrites` maps `README.md` to `index.md`, `.md` links resolve, the first `#` heading is the title. | No telemetry. Inter files are bundled, not fetched. `theme-without-fonts` drops them. | Local, MiniSearch, index built at build time. | 130 packages | Node | `2.0.0-alpha.20` (2026-09-04). 0 audit findings. |
| VitePress 1 | As above. | As above. | As above. | 173 packages | Node | `1.6.4` (2025-08-05). Last release over a year ago. On Vite 5, with open Vite and esbuild dev-server advisories (1 high, 2 moderate). |
| Astro Starlight | No. Content lives in `src/content/docs/` unless we write our own loader, every page needs a `title` in front matter, and `.md` links need a remark plugin. | System fonts. The Astro CLI sends usage telemetry unless `ASTRO_TELEMETRY_DISABLED` is set. | Pagefind, static. | 354 packages | Node | `0.42.6` with `astro` `7.3.8`. 0 audit findings. |
| MkDocs Material | No. `docs_dir` is one folder, so the README needs a copy or a plugin. | Loads Google Fonts unless `theme.font: false`. | Built-in, static. | Python | Python | `9.8.0`. In maintenance mode, with fixes only until 2027-05-05. |
| Jekyll on Pages | Yes. GitHub's default plugins make the README the index, read files without front matter and rewrite `.md` links. | Depends on the theme. Some load Google Fonts. | None built in. | Ruby | Ruby | Set by the `github-pages` gem. |
| None | Yes, with our own script. | Ours to keep clean. | Ours to write. | Small | Node | We maintain it. |

### 3.3 Recommendation: VitePress `2.0.0-alpha.20`

VitePress is the only Node option that reads the files where they are with no changes. It has static local search and no telemetry. Its build fails on a dead internal link by default (`ignoreDeadLinks: false`), which is half the link check for free.

Version 2 is still an alpha, after more than a year of alphas. Version 1 is stable in name, but it has not had a release since 2025-08, and it pins Vite 5 with dev-server advisories that won't be fixed there. They only affect `vitepress dev`, but that is what a contributor runs to preview a page. An exact pin on a 2 alpha is the smaller risk. The site has no users who depend on it, and a broken upgrade shows up as a failed build in its own PR.

Settings:

- `srcDir: '.'`, with `srcExclude` for everything that is not a page: `node_modules`, `.claude`, `packages`, `fixtures`, `e2e`, `scripts`, `dist`, `AGENTS.md`, `CLAUDE.md`.
- `rewrites: { 'README.md': 'index.md' }`. The README's relative links (`docs/cli.md`) stay correct, because `docs/` is not rewritten.
- A small markdown-it rule turns links to repo files that are not pages (today only `LICENSE`) into `https://github.com/alfhen/pingwright/blob/main/<path>`. Links to github.com are plain links, not requests.
- Theme from `vitepress/theme-without-fonts`, with the system font stack. `useWebFonts: false`, set explicitly. Its default is already false, except in web containers, where it would load Inter from Google Fonts.
- `themeConfig.search: { provider: 'local' }`.
- `cleanUrls: true`. GitHub Pages serves `/docs/cli.html` at `/docs/cli` without a redirect.
- No `sitemap` and no `hostname`, so the config does not need the domain either.
- An explicit sidebar. The build fails if it emits a page that is not in the sidebar, so a new Markdown file elsewhere in the repo is never published by accident.

Today the README and docs have no raw HTML tags and no `{{ }}` outside code, so VitePress (which compiles Markdown through Vue) builds them as they are. If a future doc adds one, the build fails and says where.

**Runner-up: Astro Starlight `0.42.6`.** It is well maintained, uses system fonts and has good static search. It loses on the first criterion: each doc would need a `title` front matter block (which GitHub shows as a table at the top of the file) or our own loader, plus a link plugin. Its tree is almost three times bigger, and its CLI telemetry has to be turned off. If the maintainer won't pin an alpha, take Starlight, not VitePress 1.

## 4. Build and deploy

One new workflow, `.github/workflows/docs.yml`. It runs on PRs and pushes that touch the README, `docs/`, `.vitepress/`, the check script, the workflow, `package.json` or `pnpm-lock.yaml`, and on `workflow_dispatch`.

- The `build` job runs on PRs and on `main`. It builds, checks links, runs the dogfood check (§6), and uploads the Pages artifact only on `main`.
- The `deploy` job runs only on a push to `main`. It needs `build`.
- Top-level permissions are `contents: read`. Only `deploy` gets `pages: write` and `id-token: write`.
- Every action is pinned to a commit SHA, with the tag in a comment. All are releases at least two weeks old.
- `actions/configure-pages` is not used. The site's base is `/`, so there is nothing for it to set.

```yaml
permissions:
  contents: read
concurrency:
  group: docs-${{ github.ref }}
  cancel-in-progress: false
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with: { node-version: 22 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm docs:build
      - uses: lycheeverse/lychee-action@e7477775783ea5526144ba13e8db5eec57747ce8 # v2.9.0
        with:
          args: --offline --include-fragments --root-dir ${{ github.workspace }}/.vitepress/dist --fallback-extensions html --no-progress .vitepress/dist
      # dogfood check, §6
      - if: github.event_name == 'push' && github.ref == 'refs/heads/main'
        uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0
        with: { path: .vitepress/dist }
  deploy:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    needs: build
    runs-on: ubuntu-24.04
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1
```

**Link checks.**

- Internal page links: the VitePress build fails on a dead one.
- Anchors and links inside the built HTML: `lychee --offline` on every PR. It blocks the merge. It makes no network calls.
- External links: a weekly scheduled `lychee` run without `--offline`. It reports and does not block, because other people's sites go down.

**After a deploy**, a last step checks the live site with `curl`: `https://pingwright.dev/` answers 200, sends no `Set-Cookie` header and has `server: GitHub.com`; `http://pingwright.dev/` redirects to HTTPS. A `cf-ray` header fails it, which catches the Cloudflare proxy being turned on by mistake.

**A guard on the code.** A step in `ci.yml` fails if `pingwright.dev` appears anywhere under `packages/` or `fixtures/`. It lives in `ci.yml`, not `docs.yml`, because `docs.yml` does not run on a PR that only touches code.

## 5. Versions

**Recommendation: docs for `main` only.**

- There are few releases, and only release candidates so far. Most readers want the newest docs.
- VitePress has no version switcher. Per-tag docs would mean building every tag into its own path (`/v0.2/`) and keeping old configs building.
- The docs of any release are already readable on GitHub at its tag: `github.com/alfhen/pingwright/tree/v<version>`.

A line under each page (the theme's `doc-footer-before` slot) says "Docs for main. For the docs of a release, open the repo at its tag." The README's status block already marks what is not built yet.

Revisit this at 1.0.

## 6. Dogfooding

A Pingwright run checks the built site in CI, on every docs PR and before every deploy. It is not part of `pnpm e2e`: e2e tests run only against `fixtures/site`, and this check keeps its own job step.

**What runs.**

1. Build Pingwright from the checkout (`pnpm build`) and run `node dist/cli.js install-browser`. This is the only step that downloads anything.
2. Inside a network namespace that has only loopback, start `vitepress preview --host 127.0.0.1` on the built site and run:

   ```yaml
   # scripts/docs-site.yml
   start: /
   steps:
     - wait: 2s
     - visit: /docs/cli
     - click: ".VPNavBarSearch button"
     - wait: 2s
     - visit: /docs/design
     - wait: 2s
   options: { seed: 1 }
   ```

   ```bash
   node dist/cli.js run scripts/docs-site.yml --site http://127.0.0.1:4173 --json
   ```

3. `scripts/check-docs-site.ts` reads the JSONL file and fails unless:
   - there are no hits and no flags;
   - every request went to `127.0.0.1:4173` and none failed;
   - no response has a `Set-Cookie` header (`setCookieNames` is empty);
   - every checkpoint has an empty `cookies` list.

The built-in `unknownDestination` check also fails the run if a page sends data to another host.

**No network beyond the site.** Stub mode answers known collection endpoints, but it lets unknown hosts through. So the run itself goes inside `sudo unshare --net`, with `ip link set lo up` and then a drop back to the runner user. A request to any other host fails at once, and the check reports it as a failed request. If `unshare` turns out not to work for Chromium on the runner **(verify)**, the fallback is `docker run --network none` with the same steps.

**It must fail when it should.** The PR that adds it shows two red runs: one with a test-only `<script>document.cookie='pw=1'</script>` in the page head, and one with an `<img>` to an outside host.

**Storage.** Pingwright records cookies, not Web Storage. VitePress writes UI preferences to `localStorage`: `vitepress:local-search-detailed-list` when search opens, and `vitepress-theme-appearance` when someone uses the theme toggle. They never leave the browser. See §10.

## 7. Steps for the maintainer

These need account or DNS access. No PR can do them, and no agent should.

| # | When | Step |
| --- | --- | --- |
| M1 | Any time, first | Verify `pingwright.dev` for the `alfhen` account (§2.4). Add the TXT record on Cloudflare and keep it. |
| M2 | Before D2 merges | Repo **Settings → Pages → Source: GitHub Actions**. |
| M3 | After M2 | **Settings → Environments → github-pages**: check that deployment branches are limited to `main`. |
| M4 | After M2 and M1 | **Settings → Pages → Custom domain**: `pingwright.dev`, save. Then add the A, AAAA and `www` CNAME records on Cloudflare, proxy off (§2.2). |
| M5 | When it appears | Tick **Enforce HTTPS**. |
| M6 | Optional | Cloudflare zone hygiene, outside the site: a null MX (`0 .`), SPF `v=spf1 -all` and DMARC `v=DMARC1; p=reject`, so nobody can send mail as `pingwright.dev`. |
| M7 | After M5 | A CAA record `0 issue "letsencrypt.org"` on the apex. |

What PRs do: the VitePress config, the workflow, the dogfood check, the post-deploy check, and the README link.

## 8. Rules for the docs PRs

- Docs only. No analytics, cookies, forms, third-party scripts or CDN fonts. The dogfood check enforces this.
- No `CNAME` file. No domain in `packages/` or `fixtures/`.
- Exact versions at least two weeks old. Actions pinned to SHAs.
- The site's dependencies are root `devDependencies`. They never enter the CLI's `dist/` or its tarball (`files` is `dist`, `README.md` and `LICENSE`).
- `.vitepress/cache` and `.vitepress/dist` go in `.gitignore`.

## 9. PR plan

Each entry is one small PR, as in `docs/plan-0.2.md`.

**D1. VitePress site.**
Touches: `package.json`, `pnpm-lock.yaml`, `.vitepress/config.ts`, `.vitepress/theme/index.ts`, `.gitignore`, `tsconfig.json` if needed, `.github/workflows/ci.yml` (the domain guard).
The site uses the logo and favicons in `brand/`.
Acceptance: `pnpm docs:build` builds the README as `/` and every published doc. A dead link in a doc fails the build. The build output contains no `fonts.googleapis.com` and no `http` URL in a `src`, a stylesheet `href` or a CSS `url()`. Search finds a word from `docs/cli.md` in `pnpm docs:preview`.

**D2. Docs workflow, build and deploy.** Needs D1 and M2.
Touches: `.github/workflows/docs.yml`.
Acceptance: on a PR, the build and offline link check run and the deploy job is skipped. After merge and M4, the site is live at `pingwright.dev`, and `alfhen.github.io/pingwright` redirects there. The site's base is `/`, so it only works on the custom domain.

**D3. Dogfood check.** Needs D2.
Touches: `scripts/check-docs-site.ts`, `scripts/docs-site.yml`, `.github/workflows/docs.yml`.
Acceptance: the check passes on the site and fails on the two broken builds in §6. The run makes no request outside loopback.

**D4. Post-deploy check and weekly external links.** Needs D2 and M5.
Touches: `.github/workflows/docs.yml`.
Acceptance: the `curl` checks in §4 pass on the live site. The weekly job runs and reports.

**D5. Link the site.** Needs M5.
Touches: `README.md`, `docs/release.md`.
Acceptance: the README links to `https://pingwright.dev`. The release steps say the site follows `main`.

D3 and D4 both touch the workflow, so they go one after the other.

## 10. Decisions

- **VitePress `2.0.0-alpha.20`**, pinned exactly. Bump it on purpose, never by range.
- **User docs only:** the README, `cli.md`, `shopify-checkout.md`, `design.md` and `release.md`. Plans, proposals and `AGENTS.md` stay in the repo.
- **Web Storage is allowed** for the two VitePress UI keys (`vitepress:local-search-detailed-list`, `vitepress-theme-appearance`). They never leave the browser. The dogfood check still fails on any cookie.
- **A CSP is a later PR.** VitePress adds inline scripts, so a `<meta>` policy needs their hashes **(verify)**.
- **`ci.yml` gets SHA-pinned actions in its own PR.** Dependabot for actions comes with it.
- **CAA:** add `0 issue "letsencrypt.org"` as a maintainer step (M7), after the first certificate is issued.
