# Prune the planafoot fork against current upstream

**Date:** 2026-07-30
**Branch base:** `planafoot` @ `b35ec05`, which sits on `upstream/master` @ `b2f851b` (v0.9.76)
**Work branch:** `prune/upstream-alignment`

## Goal

Shrink the fork's delta against upstream to only what upstream does not provide.

Two rules, applied across the whole `b2f851b..planafoot` diff:

1. Anything upstream already solves should not be in our code.
2. Anything that can be refactored to reuse upstream code should be.

Non-goals: upstreaming any of this, changing the consuming app, or reworking the
tentative-until-drop design. Those are named at the end as follow-ups.

## Starting state

The delta is 1415 insertions / 94 deletions across 12 files. The substantive parts:

| File | Δ | Nature |
|---|---|---|
| `src/keyboardAction.js` | +429 −94 | board a11y + tentative-until-drop |
| `src/helpers/aria.js` | +116 | `setAriaStrings` table |
| `typings/index.d.ts` | +33 | `onActivate`, `AriaStrings`, `grabActive` |
| `package.json` | +10 −13 | git-install resolution |
| `cypress/integration/*.spec.js` | +~700 | fork behaviour coverage |
| `README.md` | +28 | `setAriaStrings` docs |
| `src/action.js`, `src/index.js` | +3 | option/export passthrough |

## Findings that shaped this spec

### Upstream's `focusedDz` sync is claim-only (so our re-sync stays)

Upstream PR #694 re-points `focusedDz` inside `configure()`:

```js
itemMovedToThisZone =
    config.type === draggedItemType && config.items.some(item => item[ITEM_ID_KEY] === focusedItemId) && node !== focusedDz;
if (itemMovedToThisZone) focusedDz = node;
```

A zone **claims** `focusedDz` when it gains the grabbed item. No zone ever
**releases** it when it loses one. A consumer re-render pass over the origin zone
alone — first re-declaring the pre-move items, then settling without them — leaves
`focusedDz` pointing at a zone that no longer holds the card, while the zone that
does hold it never re-runs `configure()` and so never re-claims. That two-pass
shape is what an optimistic working copy under tentative-until-drop produces.

`zoneHoldingItem()` closes that gap and is covered by two existing tests
("re-syncs a stale focusedDz before restoring on escape" / "…before an arrow move
across lanes"). **It stays.** This reverses an earlier reading that called it
redundant with #694.

### `grabActive` has no consumer

Added so a consumer holding an optimistic copy could tell a mid-grab step from a
terminal drop. The consuming app never reads it: `dnd-coordinator.svelte.ts`
branches only on `trigger`, `id` and `source`. Its sole appearance there is a
synthetic fixture in `dnd-coordinator.spec.ts:25` that sets the field and asserts
nothing about it.

### Three policies for one condition

"The grabbed item is not in `focusedDz`'s items" is currently answered three ways:

- `handleZoneFocus` → `grabIsAlive()` → end the grab (upstream's policy)
- Escape and `relocateToAdjacentLane` → `zoneHoldingItem()` re-sync, then
- `relocateToZone` → bespoke `originIdx < 0` early-return → silent no-op

The re-sync is the useful layer. The `originIdx < 0` no-op is a *third* answer to
the residual case (item in no zone at all), where upstream already has one.

### `zoneItemTabIndex` is honoured while dragging, ignored at rest

`configure()` sets `focusedItem.tabIndex = config.zoneItemTabIndex` for the grabbed
card, but the at-rest path sets every card to `-1` and `setRovingTabindex()` then
hardcodes `0` for the active one. A consumer setting `zoneItemTabIndex: 3` gets `3`
while dragging and `0` at rest. The inconsistency reads as an oversight, not a
decision. Currently unobserved: the consuming app never sets the option, and no
test pins a non-default value.

## Changes

### 1. Delete `grabActive`

- `src/keyboardAction.js`: drop the field from all five dispatch sites
  (`relocateToZone` ×2, `arrowReorder`, `handleDrop` ×2) and the three comment
  passages that explain it.
- `typings/index.d.ts`: drop the `grabActive?: boolean` field from `DndEventInfo`.
- `/Users/mindlace/Projects/planafoot/src/lib/client/lanes/dnd/dnd-coordinator.spec.ts:25`:
  drop `grabActive: true` from the fixture.

The comment in `relocateToZone` that currently explains `grabActive` still needs to
say that steps are considers and the drop is the single commit — keep that sentence,
drop the clause about the flag.

### 2. Replace the `originIdx < 0` no-op with upstream's `grabIsAlive()`

Remove the early-return from `relocateToZone`. Call `grabIsAlive()` at the two call
sites that lack it, immediately before the relocate, exactly as `handleZoneFocus`
already does:

- `globalKeyDownHandler`'s Escape case — after the `zoneHoldingItem` re-sync, before
  the `grabOrigin` restore.
- `relocateToAdjacentLane` — after the re-sync, before computing `myZoneIdx`.

Order matters: re-sync first (it repairs the recoverable case), `grabIsAlive()`
second (it ends the grab in the unrecoverable one). After both, `originIdx` cannot
be negative, so `relocateToZone` keeps its plain `findIndex` + `splice`.

`grabIsAlive()` calls `handleDrop()` internally, so both call sites must return
without further work when it returns `false`. On the Escape path that means no
announcement and no second `handleDrop` — `grabIsAlive`'s own drop already announced
and dispatched.

After this, `handleZoneFocus` is the one relocate path with `grabIsAlive()` but no
`zoneHoldingItem()` re-sync, so a Tab-to-zone can end a grab that Escape or an arrow
key would have repaired. That asymmetry is left in place deliberately:
`handleZoneFocus` is upstream's own path with upstream's own policy, and adding the
re-sync there widens the change beyond the agreed scope. Recorded here so it reads as
a decision rather than an oversight.

### 3. Honour `zoneItemTabIndex` in the roving scheme

`setRovingTabindex(type, activeEl)` takes the active card's tab index as a third
argument and assigns it instead of a hardcoded `0`; non-active cards stay `-1`.
Callers pass `config.zoneItemTabIndex`. Default `0` keeps every current behaviour.

`focusCard()` forwards it too, since it delegates to `setRovingTabindex`.

## Testing

Each change is verified before it is claimed done. The suite is Cypress component
tests (`yarn test`), which the fork already uses.

**`grabActive` removal** — no new test. Deleting a field nothing reads is proven by
the existing suite staying green, plus the consuming app's `vitest` suite staying
green after the fixture line goes.

**`grabIsAlive()` substitution** — this changes observable behaviour in the residual
case (silent no-op → grab ends), so it needs coverage. Two new tests in
`cypress/integration/keyboardAction.spec.js`, one per call site:

- Escape with the grabbed card removed from every zone: asserts a `DRAG_STOPPED`
  consider is dispatched and no finalize is.
- ArrowLeft/Right with the grabbed card removed from every zone: same assertions,
  and that no item is spliced out of any zone.

Both must be written to fail against the current `originIdx < 0` no-op before the
substitution lands — that failure is what demonstrates the change is real.

**`zoneItemTabIndex`** — one new test: a zone configured with `zoneItemTabIndex: 3`,
at rest, has its active card at `3` and the rest at `-1`; after `ArrowDown` the new
active card is `3` and the previous one `-1`.

**Regression guard** — the two `re-syncs a stale focusedDz` tests must stay green
throughout. They are the evidence that `zoneHoldingItem` is load-bearing; if a
refactor makes them pass trivially, the refactor removed their subject.

## Commit structure

Four commits on `prune/upstream-alignment`, each independently revertable:

1. `test(keyboard): cover grab liveness at the escape and arrow relocate call sites` — the two failing tests
2. `refactor(keyboard): use upstream's grabIsAlive instead of a bespoke origin guard`
3. `chore(keyboard): drop the unread grabActive event field`
4. `fix(keyboard): honour zoneItemTabIndex in the roving tabindex`

The consuming app's fixture line is a separate one-line commit in that repo,
landing with or after (3).

## Follow-ups — named, not done here

- **Upstream bug report.** `configure()`'s claim-only `focusedDz` sync (#694) is a
  genuine upstream defect: a zone that loses the grabbed item never releases the
  pointer. Worth an issue with the two-pass-update reproduction, independent of
  whether our board features ever go upstream.
- **`onAnnounce` removal vs. the app.** `bc423c9` removed `onAnnounce` from the
  library; `Lane.svelte:233` still passes it into `use:dndzone`. The app's migration
  to `setAriaStrings` is pending and is separate work.
- **`setAriaStrings` duplication.** `planafoot` carries its own copy of the stack
  that `feat/aria-strings-i18n` proposes upstream. Keep those commits as a clean
  rebase-droppable prefix so the fork's `aria.js` / `index.js` / README delta goes to
  zero if that PR lands. Residual would be the two fork-only keys `movedToZone` and
  `cancelled` — worth proposing into that PR now so the residual is zero.
- **Deliberate divergences, not prunable.** Tentative-until-drop (considers per
  step, one finalize on drop) is the point of the fork and diverges hardest from
  upstream. `package.json` pointing at `src/` is irreducible for the git-install
  pin; a `prepare` script building `dist/` would zero that diff but adds rollup and
  lint to every consumer install.
- **Deferred cleanups.** `handleDrop(dispatchConsider, suppressAnnounce, commit)`
  takes three positional booleans with one non-default call site; the `Enter` and
  `" "` cases duplicate the nested-input guard block. Both were considered and
  scoped out to keep this change reviewable.
