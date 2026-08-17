# app-sites

Public web pages for **LifeLift Software** apps, served by GitHub Pages: privacy policies,
account-deletion instructions, and the developer landing site.

The first app covered is **Wickstacks — Daily Nonogram** (`wickstacks/`).

## Branches and promotion

- `main` — **production**. This branch *is* the live site: GitHub Pages serves it from `/`.
- `develop` — integration / staging. All PRs target `develop`. Nothing on `develop` is
  published anywhere.
- Promotion is a pull request `develop → main`, labelled `needs-prod-review`, merged only on
  owner sign-off. Privacy and account-deletion text is legally significant, so a human
  reads it before it goes live — no autonomous merge to `main`, ever.

## Layout

```
index.html                       developer site landing
wickstacks/index.html            Wickstacks app page
wickstacks/privacy/              privacy policy
wickstacks/delete-account/       account & data deletion instructions
assets/site.css                  shared stylesheet (no JS, no external assets)
app-ads.txt                      AdMob authorised-seller file (see note below)
CNAME                            GitHub Pages custom domain
```

## app-ads.txt

`app-ads.txt` here contains the AdMob line for LifeLift Software. The IAB app-ads.txt spec
requires the file at the **registrable root** — `https://lifelift.app/app-ads.txt` — which is
hosted elsewhere and is not managed by this repository. The copy here serves the
`wickstacks.lifelift.app` subdomain only.

## Agent tooling

This repo subscribes to the `agent-project-template` pack (see `agent-loop.manifest.json`
and `CLAUDE.md`). Prompts are inherited at run time from the pack pin; no copies are
committed here.
