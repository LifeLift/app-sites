# app-sites

Public static web pages for LifeLift Software apps — privacy policies, account-deletion
instructions, the developer landing site — served by GitHub Pages. Hand-written HTML and
one CSS file. No build, no JavaScript, no test suite, no external assets.

## Branches

- `develop` — integration. All PRs target this. Merges deploy nothing.
- `main` — production: **it is the live site.** Never merge or push to it outside a
  `develop → main` promotion PR that carries `needs-prod-review` and passes the required
  checks; the merge itself is the owner's.

## Verifying your work

- `npm run precommit` — run before claiming a change is verified. It runs
  `scripts/check-html.js` / `scripts/check-css.js` on the changed pages (well-formedness,
  balanced tags, one `<h1>`, `alt` on images, no external assets, no `<script>`) and the
  can't-fail detector.
- `node scripts/check-html.js --all` — every tracked page at once.
- **NOT AVAILABLE here, and may not be cited as a completed check:** lint, test_unit,
  test_real, build (all `null` in `agent-loop.manifest.json`). A page "renders fine" is
  not a verification — no environment here observes a rendered page (`ENVIRONMENTS.md`).

## Tripwires

- Every word under `wickstacks/privacy/` and `wickstacks/delete-account/` is a statement to
  the public about what the app does. Change it only on evidence from the app's source
  (`kaiserguy/daily-nonogram`, `develop`) and never invent a legal fact: anything only the
  owner knows stays as an `[[OWNER: …]]` marker until the owner fills it. Those pages reach
  `main` only on owner sign-off.
- High-risk paths carry `needs-prod-review` and are for humans. Classify with
  `node gates/carve-out-paths.js {file}` — positional; run it, do not eyeball the path.
- Governance files are out of scope for autonomous change or auto-merge:
  `CLAUDE.md`, `claude-*.md`, `.claude/hooks/**`, `.claude/settings.json`,
  `agent-loop.manifest.json`, `prompts/**`. The loop does not rewrite the rules that bind it.
- Work only in your own worktree under `.claude/worktrees/`. Never aim a mutating git verb
  at the shared clone root (`repo.shared_clone` in the manifest) — concurrent sessions
  share it. `.claude/hooks/block-shared-clone-git.js` refuses such verbs.

## Publishing

- `main` is the live GitHub Pages site (source: branch `main`, path `/`). `develop` is
  staging with no deploy — nothing on it is visible anywhere.
- The `CNAME` file names the custom domain `wickstacks.lifelift.app` for the Wickstacks
  pages. Until that DNS record exists and the Pages custom domain is accepted, the site
  root is served on the org's default Pages domain (`lifelift.github.io/app-sites/`).
  Absolute links between pages must therefore be **relative** — they have to work under
  both a `/app-sites/` prefix and a bare custom domain.
- Privacy and account-deletion text merges to `main` only on owner sign-off
  (`needs-prod-review`, `escalation.human_gate_scope: production`).
- `app-ads.txt` here serves the subdomain only; the IAB-required copy at the registrable
  root `https://lifelift.app/app-ads.txt` is hosted elsewhere and is not this repo's.

## Local facts an agent cannot derive

- **Prompts are inherited at run time from the pack pin; no copy is committed here.**
  Every scheduled role renders the pack template at `pack_version` (0.9.1) with that
  tag's own renderer, against this manifest:
  `node <pack clone>/bootstrap/render.js prompts/<role>.md --manifest ./agent-loop.manifest.json --pin`.
  A rule local to this repo goes in the manifest as a `render_overrides` entry, never as
  an edited copy. `pack-sync` is off for the same reason: the update path is a pin bump.
- The app these pages describe lives in `kaiserguy/daily-nonogram` (`develop`); its
  privacy-relevant surface as of 2026-08-17: anonymous Firebase Auth uid with optional
  Sign in with Apple link (`src/firebase/authClient.ts`), public-read leaderboard entries
  at `leaderboard/{dateKey}/entries/{uid}` (`docs/FIRESTORE-SCHEMA.md`), Google AdMob
  banner + interstitial with UMP consent and non-personalised requests (`src/ads/`), an
  ATT prompt after the first solve (`src/att/`), device-only AsyncStorage keys
  (`src/persistence/`). **It has no in-app account-deletion or sign-out route** (grep for
  `deleteUser|signOut|deleteAccount` in `src/`, `App.tsx`: none) — the deletion page
  documents a support-email route for that reason. Re-verify against the source before
  changing either page.
- The gates' only dependency is `js-yaml`; run `npm install --no-audit --no-fund` before
  `gates/verify-affordances.js` in a fresh clone.
- On this Windows host `gh` is not on the Bash tool's `PATH`; it is installed and
  authenticated at `C:\Program Files\GitHub CLI\gh.exe` — call it by full path.

Add a line here when something costs an hour to rediscover: an environment quirk, a
convention with no trace in the code, a hazard that is invisible until it fires. State
the fact and, where possible, the incident that established it. Name credential
VARIABLES and point at the document that owns their location — never the location, and
never the value.

## Where the procedures live

Do not work from a summary — read the file that owns the procedure:

- The pack's `prompts/loop-monitor.md` — the autonomous loop — rendered at this repo's pin
  (see "Local facts"); no copy is committed here.
- The pack's `prompts/director-weekly.md` — the weekly governance pass — likewise.
- `ENVIRONMENTS.md` — which environment can observe what.
