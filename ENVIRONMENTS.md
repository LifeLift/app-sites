# ENVIRONMENTS — app-sites

The truth table for what each environment can and cannot observe. Same discipline as the
sibling repos: **no row without evidence** — every claim carries the command or event that
verified it and when. Other files (hooks, prompts, CLAUDE.md) POINT here; they never
restate these facts.

This is a static site: hand-written HTML + one CSS file, no build step, no JavaScript, no
test suite. `agent-loop.manifest.json` declares `lint`, `test_unit`, `test_real` and `build`
as `null` for that reason — there is nothing of that kind to run, and declaring a check that
does not exist is worse than declaring none.

| Environment | Exists? | Verified by | Can observe | Cannot observe |
|---|---|---|---|---|
| Local toolchain (any host with Node ≥ 18 and git) | yes | `npm run precommit` (path-aware gate, `gates/precommit.js`), `node scripts/check-html.js --all`, `node scripts/check-css.js assets/site.css`, self-tests `--self-test` on both — run at adoption 2026-08-17, exit 0 | HTML well-formedness (balanced tags, quoted attributes, doctype/lang/charset/viewport/title, one h1, img alt, non-empty hrefs, unique ids), self-containment (no external assets, no `<script>`), CSS brace/comment/string balance and self-containment, can't-fail-test detector, manifest ↔ capabilities reconciliation | a rendered page — layout, colours, link targets resolving, how a browser or screen reader actually presents it; nothing here executes HTML |
| CI (ubuntu-latest, `.github/workflows/ci.yml`) | yes | runs on every PR and on pushes to `develop`/`main` (first run: the v0 promotion PR, 2026-08-17) | the same gate as the local toolchain (`verify` job) plus `verify-affordances`, `check-capabilities`, `check-hook-pointers` (`gates` job); the `carve-out-label` workflow classifies every changed file and fails when a carve-out/governance surface changed without `needs-prod-review` | anything a browser would show; nothing in CI deploys |
| Integration (`develop`) | branch exists; deploys **nothing** | `branches.integration_deploys_to` in the manifest | — | nothing on `develop` is served anywhere; "it is on develop" is not "it is live" |
| Production (`main` → GitHub Pages) | yes — Pages enabled 2026-08-17 (source: branch `main`, path `/`) | `gh api repos/LifeLift/app-sites/pages` (see the adoption report for the exact response) | the live pages at the Pages URL, once a promotion PR has merged; whether the custom domain resolves is a DNS fact the owner controls | agents do not merge to `main`; no agent environment here can fetch and render the live site as evidence of correctness — a link check against the live URL is the only automated observation available and is not wired up |
| Custom domain `wickstacks.lifelift.app` | **yes** — live since the v0 promotion (2026-08-28) | `gh api repos/LifeLift/app-sites/pages` → `protected_domain_state: "verified"`, cert `approved` (expires 2026-11-25), `https_enforced: true`; `curl -sI` → the custom domain serves the site, the org default Pages domain (`lifelift.github.io/app-sites/`) returns `301 Moved Permanently` to it (both checked 2026-08-29, W35 Director pass) | that GitHub reports the domain verified and serving | still nothing automated fetches or renders the live site as evidence of correctness; the default domain no longer serves content (it redirects), so "works under `/app-sites/`" can no longer be spot-checked live |

## Adding a row

State the environment, run the command that proves what it observes, and record the
command, its output shape, and the date. A row you cannot attach evidence to is drift
waiting to happen — leave it out until you can.
