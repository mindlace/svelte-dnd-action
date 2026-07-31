# Prune the planafoot fork against upstream — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove fork code that upstream already provides or that nothing consumes, and refactor what remains onto upstream's own helpers.

**Architecture:** Three independent changes to `src/keyboardAction.js` plus one line in the consuming app. Each is small, separately revertable, and gated by Cypress component tests. The fork's `zoneHoldingItem` re-sync stays — upstream's `configure()` sync claims `focusedDz` but never releases it, which is a real gap.

**Tech Stack:** Plain ES modules, no build step. Cypress component tests (`yarn test`). Prettier for formatting; `.eslintignore` excludes everything outside `/src/`, so `cypress/` is not linted.

**Spec:** `docs/superpowers/specs/2026-07-30-prune-fork-against-upstream-design.md`

## Global Constraints

- Work in the worktree `/Users/mindlace/Projects/svelte-dnd-action/.claude/worktrees/prune-upstream` on branch `prune/upstream-alignment`.
- `cypress/integration/keyboardAction.spec.js` is deliberately kept a clean subset of upstream's file. **Do not add fork-specific tests to it.** Fork behaviour lives in `keyboardCancel.spec.js`, `keyboardRovingTabindex.spec.js`, `keyboardTentativeCommit.spec.js`.
- Husky's `husky-run` binary is not installed in this worktree, so the pre-commit hook errors out rather than running a check. Commit with `git commit --no-verify`.
- Run the suite with `yarn test` (`cypress run`). To run one spec: `yarn cypress run --spec cypress/integration/<file>.spec.js`.
- Conventional Commits for every commit message.
- Never delete or weaken the two tests named `re-syncs a stale focusedDz …` in `keyboardCancel.spec.js`. They are the evidence that `zoneHoldingItem` is load-bearing.

## Plan refinement vs. the spec

The spec says to call upstream's `grabIsAlive()` at both new call sites. `grabIsAlive()` ends the grab via `handleDrop()` with its default `commit = true`, which is wrong on the Escape path — a cancel must not commit. Task 1 therefore splits upstream's helper into a pure predicate (`grabIsLive`) plus the existing drop-on-false wrapper (`grabIsAlive`, unchanged in behaviour), uses the wrapper on the arrow path where upstream's policy fits, and uses the bare predicate on the Escape path followed by the cancel's own `handleDrop(true, true, false)`. `handleZoneFocus` is untouched.

Two smaller deviations from the spec, both deliberate:
- The spec puts the new liveness tests in `keyboardAction.spec.js`. That file is deliberately a clean subset of upstream's, so they go in `keyboardCancel.spec.js` instead.
- The spec lists four commits, with the new tests as their own. TDD keeps a test with the change it gates, so Task 1 lands both in one commit — three implementation commits total.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/keyboardAction.js` | keyboard grab lifecycle | Modify — all three changes |
| `typings/index.d.ts` | public types | Modify — drop `grabActive` |
| `cypress/integration/keyboardCancel.spec.js` | Escape / cancel-to-origin | Modify — add 2 liveness tests + `alertText` helper |
| `cypress/integration/keyboardTentativeCommit.spec.js` | commit semantics | Modify — drop `grabActive` assertions |
| `cypress/integration/keyboardRovingTabindex.spec.js` | tab stop + at-rest nav | Modify — add `zoneItemTabIndex` test |
| `/Users/mindlace/Projects/planafoot/src/lib/client/lanes/dnd/dnd-coordinator.spec.ts` | app fixture | Modify — drop dead field (separate repo) |

---

### Task 1: Replace the bespoke origin guard with upstream's liveness check

**Files:**
- Modify: `src/keyboardAction.js` (`grabIsAlive` ~131-137, Escape case ~86-108, `relocateToZone` ~207-218, `relocateToAdjacentLane` ~385-398)
- Test: `cypress/integration/keyboardCancel.spec.js`

**Interfaces:**
- Produces: `grabIsLive(): boolean` — module-scope, no side effects, true when `focusedDz`'s config currently holds `focusedItemId`.
- Produces: `grabIsAlive(): boolean` — unchanged signature and behaviour; now delegates its check to `grabIsLive()`.

- [ ] **Step 1: Add an `alertText` helper to `keyboardCancel.spec.js`**

Insert after the existing `escape()` helper (before `afterEach`):

```js
    // The library alerts through a single hidden live region shared by all zones.
    function alertText() {
        return document.getElementById("dnd-action-aria-alert")?.textContent ?? "";
    }
```

- [ ] **Step 2: Write the two failing tests**

Append inside the `describe("keyboardAction escape-to-cancel", …)` block, after the last existing test:

```js
    it("ends the grab when an arrow relocate finds the grabbed card gone from every zone", () => {
        const {
            zone: zoneA,
            action: actionA,
            children: [cardA]
        } = createZone([{id: "a"}, {id: "b"}]);
        createZone([{id: "c"}]);
        const recordA = track(zoneA);

        grab(cardA);
        // A consumer re-render that removes the grabbed card outright: it is now in no
        // zone of this type, so the re-sync has nothing to re-point focusedDz at.
        zoneA.removeChild(cardA);
        actionA.update({items: [{id: "b"}]});

        key(cardA, "ArrowRight");

        expect(lastConsider(recordA).trigger, "the grab must end rather than silently no-op").to.equal(TRIGGERS.DRAG_STOPPED);
    });

    it("does not announce a cancel for a card that is gone from every zone", () => {
        const {
            zone: zoneA,
            action: actionA,
            children: [cardA]
        } = createZone([{id: "a"}, {id: "b"}]);
        const {zone: zoneZ, action: actionZ} = createZone([]);
        const recordA = track(zoneA);
        const recordZ = track(zoneZ);

        grab(cardA);
        key(cardA, "ArrowRight");
        // The relocate spliced the card into zoneZ's LIVE items array, so clearing the
        // origin alone would leave it findable. Both zones have to settle without it for
        // the card to be gone from the board.
        actionA.update({items: [{id: "b"}]});
        actionZ.update({items: []});
        const before = alertText();

        escape();

        expect(alertText(), "there is no move left to cancel").to.equal(before);
        expect(recordA.finalizes.concat(recordZ.finalizes), "escape still must not commit").to.be.empty;
    });
```

- [ ] **Step 3: Run the two tests and confirm they fail**

Run: `yarn cypress run --spec cypress/integration/keyboardCancel.spec.js`

Expected: both new tests FAIL, every pre-existing test in the file PASSES.
- "ends the grab when an arrow relocate…" fails because `relocateToZone`'s `originIdx < 0` branch returns silently, so no `DRAG_STOPPED` is ever dispatched and `lastConsider` is still `DRAG_STARTED`.
- "does not announce a cancel…" fails because the Escape case announces `cancelled` unconditionally, so `alertText()` changes to `"Stopped dragging item "`.

If either passes, stop and report — the premise of this task is wrong.

- [ ] **Step 4: Extract the pure predicate**

In `src/keyboardAction.js`, replace:

```js
function grabIsAlive() {
    const focusedConfig = dzToConfig.get(focusedDz);
    if (focusedConfig?.items.some(item => item[ITEM_ID_KEY] === focusedItemId)) return true;
    printDebug(() => "dragged item is gone, dropping");
    handleDrop();
    return false;
}
```

with:

```js
// Is the grabbed item still in the zone focusedDz points at? Pure — callers that want
// upstream's "it's gone, end the grab" policy use grabIsAlive below; callers that need a
// different ending (ex: Escape, which must not commit) branch on this directly.
function grabIsLive() {
    const focusedConfig = dzToConfig.get(focusedDz);
    return !!focusedConfig?.items.some(item => item[ITEM_ID_KEY] === focusedItemId);
}

function grabIsAlive() {
    if (grabIsLive()) return true;
    printDebug(() => "dragged item is gone, dropping");
    handleDrop();
    return false;
}
```

- [ ] **Step 5: Guard the arrow relocate**

In `relocateToAdjacentLane`, after the existing re-sync lines and before `const myZoneIdx`:

```js
    function relocateToAdjacentLane(dir) {
        const zones = orderedZonesOfType(config.type);
        // Re-sync to the zone that actually holds the grabbed item (an intervening
        // committed move + re-render can leave focusedDz stale).
        const liveDz = zoneHoldingItem(config.type, focusedItemId);
        if (liveDz) focusedDz = liveDz;
        // Re-sync repairs a stale pointer; this catches the case it cannot — the card is
        // in no zone at all. Upstream's policy for that is to end the grab (#694).
        if (!grabIsAlive()) return;
        const myZoneIdx = zones.indexOf(focusedDz);
```

- [ ] **Step 6: Guard the Escape cancel**

In `globalKeyDownHandler`'s `Escape` case, replace the re-sync lines and the line after them so the block reads:

```js
        case "Escape": {
            // Cancel-to-origin: relocate the grabbed card back to where it was
            // picked up, announce the cancel, then drop without a further consider
            // string. If it never left its origin zone, just drop.
            // Re-sync focusedDz to the zone that actually holds the grabbed item —
            // an intervening committed move + re-render can leave the module's
            // focusedDz pointer stale, which would make relocateToZone splice from
            // the wrong (empty) origin and silently no-op.
            const liveDz = draggedItemType ? zoneHoldingItem(draggedItemType, focusedItemId) : null;
            if (liveDz) focusedDz = liveDz;
            // The card is in no zone at all: there is no move left to restore and nothing
            // to announce. End the grab the way a cancel does — `commit: false`, no string.
            if (!grabIsLive()) {
                handleDrop(true, true, false);
                break;
            }
            const autoAriaDisabled = dzToConfig.get(focusedDz).autoAriaDisabled;
```

Leave the rest of the case (the `grabOrigin` restore, the `announce`, the final `handleDrop(true, true, false)`) exactly as it is.

- [ ] **Step 7: Delete the bespoke guard from `relocateToZone`**

Both call sites are now preceded by a liveness check, and `handleZoneFocus` has had `grabIsAlive()` since upstream #694, so `originIdx` can no longer be negative. Remove the early return:

```js
function relocateToZone(targetDz, atIndex) {
    focusedDzLabel = targetDz.getAttribute("aria-label") || "";
    const {items: originItems} = dzToConfig.get(focusedDz);
    const originIdx = originItems.findIndex(item => item[ITEM_ID_KEY] === focusedItemId);
    const itemToMove = originItems.splice(originIdx, 1)[0];
```

That is: delete the six-line `// Defensive:` comment block and the `if (originIdx < 0) { … }` statement. Keep everything below `const itemToMove` untouched.

- [ ] **Step 8: Run the full suite**

Run: `yarn test`

Expected: PASS, including both new tests and both `re-syncs a stale focusedDz …` tests. If a re-sync test fails, the change removed its subject — stop and report.

- [ ] **Step 9: Commit**

```bash
git add src/keyboardAction.js cypress/integration/keyboardCancel.spec.js
git commit --no-verify -m "refactor(keyboard): use upstream's liveness check instead of a bespoke origin guard" -m "relocateToZone answered a vanished grabbed item with a silent no-op, a third policy for a condition upstream already answers with grabIsAlive. Both fork call sites now check liveness first — the arrow relocate takes upstream's end-the-grab policy, Escape ends the grab as a cancel (commit: false, no announcement) — so originIdx can no longer be negative and the guard goes."
```

---

### Task 2: Drop the unread `grabActive` event field

**Files:**
- Modify: `src/keyboardAction.js` (5 dispatch sites), `typings/index.d.ts`
- Test: `cypress/integration/keyboardTentativeCommit.spec.js`

**Interfaces:**
- Removes: `DndEventInfo.grabActive`. No replacement — no consumer read it.

- [ ] **Step 1: Strip the assertions from `keyboardTentativeCommit.spec.js`**

In the `track` helper, drop the field from both recorders:

```js
                considers.push({zone: name, trigger: e.detail.info.trigger, items: e.detail.items})
```
```js
                finalizes.push({zone: name, trigger: e.detail.info.trigger, items: e.detail.items})
```

Then delete these four assertions entirely (they are the only references left):

- `expect(steps[0].grabActive, "mid-grab considers are flagged grabActive").to.equal(true);`
- the three-line `expect(steps.map(s => s.grabActive), "both halves of the relocate are flagged grabActive").to.deep.equal([true, true]);`
- the three-line `expect(finalizes.map(f => f.grabActive), "the commit is not part of a live grab").to.deep.equal([false, false]);`
- both single-line `expect(finalizes[0].grabActive).to.equal(false);`

Verify none remain: `grep -n grabActive cypress/integration/keyboardTentativeCommit.spec.js` must print nothing.

The surrounding tests keep their real subject — that steps are considers and the drop is the single finalize — so coverage of the tentative-until-drop contract is unchanged.

- [ ] **Step 2: Remove the field from the five dispatch sites**

In `src/keyboardAction.js`, delete `grabActive: true` / `grabActive: false` (and the now-dangling trailing commas) from:

1. `relocateToZone`'s `DRAGGED_LEFT` consider
2. `relocateToZone`'s `DRAGGED_ENTERED` consider
3. `arrowReorder`'s `DRAGGED_OVER_INDEX` consider
4. `handleDrop`'s `DROPPED_INTO_ANOTHER` finalize
5. `handleDrop`'s `DROPPED_INTO_ZONE` finalize

Sites 2, 4 and 5 collapse back to a single line once the field is gone; let Prettier decide (Step 4).

- [ ] **Step 3: Fix the comments that explain the field**

In `relocateToZone`, the `TENTATIVE-UNTIL-DROP (#535)` comment ends with a sentence about `grabActive`. Keep the first two sentences, drop the third:

```js
    // TENTATIVE-UNTIL-DROP (#535): while the grab is live, a step is a *consider*, not a
    // finalize. The consumer moves the card in its working copy and commits nothing; the
    // single finalize is dispatched by handleDrop.
```

`arrowReorder`'s and `handleDrop`'s `TENTATIVE-UNTIL-DROP` comments do not mention the field — leave them alone.

- [ ] **Step 4: Remove the type and reformat**

In `typings/index.d.ts`, delete the four-line comment and the `grabActive?: boolean;` line from `DndEventInfo`, leaving:

```ts
export interface DndEventInfo {
    trigger: TRIGGERS; // the type of dnd event that took place
    id: string;
    source: SOURCES; // the type of interaction that the user used to perform the dnd operation
}
```

Then run: `yarn format`

- [ ] **Step 5: Confirm the field is gone from the library**

Run: `grep -rn grabActive src/ typings/ cypress/`

Expected: no output.

- [ ] **Step 6: Run the full suite**

Run: `yarn test`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/keyboardAction.js typings/index.d.ts cypress/integration/keyboardTentativeCommit.spec.js
git commit --no-verify -m "chore(keyboard): drop the unread grabActive event field" -m "Added so a consumer holding an optimistic working copy could tell a mid-grab step from a terminal drop. No consumer ever read it. The tentative-until-drop contract it described is still covered by the tests that assert steps are considers and the drop is the single finalize."
```

---

### Task 3: Honour `zoneItemTabIndex` in the roving tabindex

**Files:**
- Modify: `src/keyboardAction.js` (`setRovingTabindex` ~165-171)
- Test: `cypress/integration/keyboardRovingTabindex.spec.js`

**Interfaces:**
- `setRovingTabindex(type, activeEl)` keeps its signature. It now reads each zone's own `zoneItemTabIndex` from `dzToConfig` rather than hardcoding `0`, so zones of the same type with different settings each get their own value.

- [ ] **Step 1: Write the failing test**

Append inside `describe("keyboardAction at-rest navigation and roving tabindex", …)`, in the `describe("roving tabindex", …)` sub-block:

```js
        it("gives the active card the configured zoneItemTabIndex, not a hardcoded 0", () => {
            const {
                children: [first, second]
            } = createZone([{id: "a"}, {id: "b"}, {id: "c"}], {zoneItemTabIndex: 3});

            expect(tabIndices(), "the active card takes the configured index").to.deep.equal([[3, -1, -1]]);

            key(first, "ArrowDown");

            expect(tabIndices(), "and keeps it as the tab stop moves").to.deep.equal([[-1, 3, -1]]);
            expect(document.activeElement, "focus follows the tab stop").to.equal(second);
        });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `yarn cypress run --spec cypress/integration/keyboardRovingTabindex.spec.js`

Expected: FAIL on the first assertion — actual `[[0, -1, -1]]`, expected `[[3, -1, -1]]`. Every other test in the file PASSES.

- [ ] **Step 3: Read each zone's own config**

Replace `setRovingTabindex`:

```js
// One tab stop per board: activeEl gets its zone's configured zoneItemTabIndex, every
// other card across the type's zones gets -1. Reading the index per zone rather than
// from the calling zone keeps upstream's option meaningful when zones of one type are
// configured differently.
function setRovingTabindex(type, activeEl) {
    for (const dz of orderedZonesOfType(type)) {
        const cfg = dzToConfig.get(dz);
        const activeTabIndex = cfg ? cfg.zoneItemTabIndex : 0;
        for (const child of dz.children) {
            child.tabIndex = child === activeEl ? activeTabIndex : -1;
        }
    }
}
```

`focusCard` delegates to this and needs no change.

- [ ] **Step 4: Run the spec**

Run: `yarn cypress run --spec cypress/integration/keyboardRovingTabindex.spec.js`

Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `yarn test`

Expected: PASS. Watch `keyboardAction.spec.js`'s "should restore the item tab index" (upstream's #694 test) — it asserts `0`, which is the default `zoneItemTabIndex`, so it must still pass.

- [ ] **Step 6: Commit**

```bash
git add src/keyboardAction.js cypress/integration/keyboardRovingTabindex.spec.js
git commit --no-verify -m "fix(keyboard): honour zoneItemTabIndex in the roving tabindex" -m "configure() already set the grabbed card's tabIndex from config.zoneItemTabIndex, but the at-rest roving scheme hardcoded 0, so a consumer setting the option got it while dragging and lost it at rest. setRovingTabindex now reads each zone's own configured value."
```

---

### Task 4: Remove the dead fixture field from the consuming app

**Files:**
- Modify: `/Users/mindlace/Projects/planafoot/src/lib/client/lanes/dnd/dnd-coordinator.spec.ts:25`

This task is in a **different repository** (`/Users/mindlace/Projects/planafoot`). It has its own git state; do not run the svelte-dnd-action commands here.

- [ ] **Step 1: Drop the field from the fixture**

Line 25 currently reads:

```ts
    detail: { items, info: { trigger, id, source: 'keyboard', grabActive: true } }
```

Change it to:

```ts
    detail: { items, info: { trigger, id, source: 'keyboard' } }
```

- [ ] **Step 2: Confirm nothing else references it**

Run: `grep -rn grabActive /Users/mindlace/Projects/planafoot/src`

Expected: no output.

- [ ] **Step 3: Run the app's test suite**

Run from `/Users/mindlace/Projects/planafoot`: `npm test`

Expected: PASS. The coordinator never branched on the field, so removing it from a synthetic event changes nothing.

- [ ] **Step 4: Commit in the app repo**

```bash
git -C /Users/mindlace/Projects/planafoot add src/lib/client/lanes/dnd/dnd-coordinator.spec.ts
git -C /Users/mindlace/Projects/planafoot commit -m "test(dnd): drop the grabActive fixture field" -m "svelte-dnd-action no longer dispatches grabActive; the coordinator never read it."
```

If the app repo is not on a suitable branch, stop and report rather than committing to its default branch.

---

## Verification before claiming completion

- [ ] `yarn test` passes in the worktree with no skipped specs.
- [ ] `grep -rn grabActive src/ typings/ cypress/` prints nothing.
- [ ] `grep -n "originIdx < 0" src/keyboardAction.js` prints nothing.
- [ ] `grep -n "zoneHoldingItem" src/keyboardAction.js` still prints three lines (the definition and its two call sites) — this code is deliberately kept.
- [ ] Both `re-syncs a stale focusedDz …` tests pass.
- [ ] `git log --oneline prune/upstream-alignment` shows the spec commit plus exactly three implementation commits.

## Out of scope — recorded in the spec, do not do here

- Adding the `zoneHoldingItem` re-sync to `handleZoneFocus` (upstream's path keeps upstream's policy).
- Reworking `handleDrop`'s three positional booleans, or collapsing the `Enter` / `" "` duplication.
- The app's `onAnnounce` → `setAriaStrings` migration.
- Filing the upstream issue about `configure()`'s claim-only `focusedDz` sync.
