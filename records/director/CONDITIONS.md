# Register of pre-registered conditions — app-sites

Repo-added mechanisms, metrics and experiments register here **before they earn inertia**,
each with the observable outcomes under which it is amended or retired, and its remedy.
The Director sweeps every row every week: CHECKED-OK, TRIGGERED or NOT-YET-DUE, with a
history line. A row whose kill criteria are met is retired in place (row moves to the
Retired section with the reason), never silently dropped. The pack's fixed conditions
(C1–C17) live in the rendered Director prompt, not here.

## Active rows

### R1 — rendered-page / live-serving gap
- **What:** no environment here or in CI renders a page, and nothing monitors the live
  site from outside. A structurally-valid page that renders broken, or a serving/DNS/cert
  failure, reaches the public unnoticed. (ENVIRONMENTS.md; named as the week's ungated
  class, W35.)
- **Check, weekly:** does a render-capable check or an external uptime/content monitor
  now exist? Until one does, this row records the standing risk.
- **Remedy when TRIGGERED (a silent breakage is discovered):** treat as a C-class
  incident: fix forward on `develop`, promote via the human gate, and the mechanism that
  would have caught it becomes this row's replacement.
- **Kill criteria:** retired when (a) a render/uptime check exists in CI or externally,
  or (b) the owner explicitly accepts the risk — then re-presented quarterly instead of
  weekly.
- **History:** W35 CHECKED-OK — risk stands, presented to owner as an option (record,
  owner action list); no monitor exists yet. W36 CHECKED-OK — still no monitor; the
  3-day host outage sharpened the case: Pages kept serving because it is independent of
  the host, and for the same reason nothing anywhere watched it (2026-W36 record).

### R2 — Apple-credential retention spot-check
- **What:** the privacy page states Firebase retains the Apple user identifier plus
  provided-or-relay email — documented behavior; **no live Apple-provider user existed to
  verify against** (checked 2026-08-28, PR #3 flag).
- **Check, weekly (cheap):** has a first real Sign-in-with-Apple user appeared? (Owner
  holds console access; the loop/Director can only ask.)
- **Remedy when due:** owner compares the console user record to the page's sentence;
  a mismatch is a privacy-page correction PR under the content tripwire (evidence from
  the app's source/console, owner sign-off to reach `main`).
- **Kill criteria:** retired once verified against one real record (result logged here).
- **History:** W35 NOT-YET-DUE — no Apple-provider user known to exist. W36 NOT-YET-DUE
  — unchanged.

### R3 — legal review before scale
- **What:** regional-rights and breach-notification wording is minimal generic text,
  owner-accepted pending real legal review (PR #3, owner answers 2026-08-28).
- **Check:** quarterly re-present to the owner (next: ~2026-11-23, W48); immediately
  TRIGGERED if a scale/marketing push is observed before review.
- **Remedy when TRIGGERED:** escalate as an owner question with its age; the pages carry
  the owner-accepted wording until the owner's counsel changes it.
- **Kill criteria:** retired when legal review happens (wording confirmed or replaced).
- **History:** W35 NOT-YET-DUE — accepted 1 day ago; no scale activity. W36 NOT-YET-DUE
  — no scale activity; next re-present ~W48.

### R4 — loop cadence right-sizing
- **What:** daily loop against a 1-issue backlog is generous; premature to act on one
  week of data (and the week was wedged — see R5).
- **Check, weekly:** after #4 closes, count consecutive no-op runs (Stage 1/2/3 all
  no-ops, queue empty).
- **Remedy when TRIGGERED (3 consecutive no-op runs on an empty queue):** Director halves
  the cadence (daily → every 2–3 days) — cheap, reversible, Director authority; recorded
  in that week's file.
- **Kill criteria:** retired if the backlog grows to a steady 3+ open issues (cadence is
  then earning itself) or after a cadence change is made and scored for two weeks.
- **History:** W35 NOT-YET-DUE — queue is 1 issue and the loop was blocked all week.
  W36 NOT-YET-DUE — queue still 1 issue (#4, owner-gated); the three missed days were
  host outage, not no-op runs, and do not count toward the trigger (2026-W36 record).

## Retired rows

### R5 — model-routing fix verification (RETIRED W36 — verified)
- **What it was:** PR #7 set `model.current: claude-sonnet-5` per DELIVERY-PROCESS §3;
  the loop renders from `origin/develop` at run time, so the next run should clear the
  attribution block with no scheduler change. Self-retiring on first verification.
- **Result:** verified twice. Loop run 3 (2026-08-29, log on #1) executed as
  `claude-sonnet-5`, authored a real commit and PR (#9) under a matching trailer with no
  block, and closed #5 under the close rule stated on that issue; run 4 (2026-09-02)
  re-confirmed on a second day and merged #9. Retired per kill criteria (2026-W36
  record).
- **History:** W35 NOT-YET-DUE — fix merged that pass; first eligible run 2026-08-30.
  W36 RETIRED — verified as above.

## Register retirement row

If this register runs **8 consecutive weeks** with every row NOT-YET-DUE and zero new
registrations, the Director asks whether the register is earning its sweep and proposes
folding survivors into the weekly record. The register does not get to be furniture.
