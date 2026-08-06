# Roving Tabindex + At-Rest Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `navigationMode: "roving"` zone option to svelte-dnd-action that gives a whole board one tab stop instead of one per draggable item, with arrow-key navigation between items and zones.

**Architecture:** All changes are in `src/keyboardAction.js`, plus option plumbing in `src/action.js` and `typings/index.d.ts`. At rest (`!isDragging`), exactly one item across all opted-in zones of a `type` is tabbable; arrow keys move that tab stop. Which arrow axis moves *within* a zone versus *across* zones is inferred from how the zones are laid out, not declared. Drag semantics are completely untouched — every keyboard move still finalizes immediately.

**Tech Stack:** Vanilla JS (ES modules), Cypress + Mocha/Chai for tests (`cypress run`, no dev server — specs drive `dndzone()` on plain divs with synthetic `KeyboardEvent`s), ESLint + Prettier.

**Spec:** `docs/superpowers/specs/2026-08-05-roving-tabindex-upstream-design.md` on the `planafoot` branch.

## Global Constraints

- **Branch from `master`, not `planafoot`.** `master` tracks `isaacHagoel/svelte-dnd-action` exactly. Work in a fresh worktree on a branch cut from `master`.
- **`docs/` must NEVER be committed to this branch.** It is permanently fork-only. This branch touches only `src/`, `cypress/`, `typings/`, and `README.md`. Read the spec and plan from the `planafoot` worktree; never copy them across.
- **No behaviour change when `navigationMode` is absent.** This is the single most important property of the PR. Every existing test must pass untouched, and Task 2 adds an explicit guard for it.
- **Drag semantics are out of scope.** Do not touch `handleDragStart`, `handleDrop`, `handleZoneFocus`, `getActiveDragTabIndex`, `refreshActiveDragTabIndices`, or the `isDragging` bodies of the arrow cases. Every new code path is gated on `!isDragging`.
- **No new aria strings and no announcements.** At-rest navigation is silent; the focused item is read by the screen reader because it is focused. `src/helpers/aria.js` is not modified.
- **Exactly one new option.** No `orientation` option. The axis is inferred.
- **Commit style:** Conventional Commits. **No Claude trailers, footers, or co-author lines** — this is bound for upstream and is Ethan's sole authorship.
- **Formatting:** run `npx prettier --write` on changed files before each commit; `npm run lint` must exit 0.
- **Cypress caveat:** the pinned Cypress cannot match a RegExp in a `throw` assertion. Assert on substrings.

---

### Task 1: Plumb the `navigationMode` option

Adds the option end to end so it is accepted, validated, defaulted, and typed. It does nothing yet.

**Files:**
- Modify: `src/action.js` (jsdoc ~line 20, `validateOptions` destructure ~line 74, validation body ~line 102)
- Modify: `src/keyboardAction.js` (`config` literal ~line 216, `configure()` destructure ~line 348)
- Modify: `typings/index.d.ts` (`Options` interface ~line 55)
- Test: `cypress/integration/keyboardRovingTabindex.spec.js` (new file)

**Interfaces:**
- Consumes: nothing.
- Produces: `config.navigationMode` — the string `"roving"` or `"default"`, defaulting to `"default"`, readable from `dzToConfig.get(zone).navigationMode` in every later task.

- [ ] **Step 1: Write the failing test**

Create `cypress/integration/keyboardRovingTabindex.spec.js`:

```js
import {dndzone} from "../../src/keyboardAction";

describe("navigationMode option", () => {
    const actions = [];
    const zones = [];

    function createZone(items, options = {}, zoneStyle) {
        const zone = document.createElement("div");
        if (zoneStyle) Object.assign(zone.style, zoneStyle);
        items.forEach(() => {
            const card = document.createElement("div");
            card.style.height = "20px";
            zone.appendChild(card);
        });
        document.body.appendChild(zone);
        zones.push(zone);
        const action = dndzone(zone, {items, ...options});
        actions.push(action);
        return {zone, action, children: Array.from(zone.children)};
    }

    afterEach(() => {
        actions
            .splice(0)
            .reverse()
            .forEach(action => action.destroy());
        zones.splice(0).forEach(zone => zone.remove());
    });

    it("accepts navigationMode without warning about an unknown option", () => {
        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (...args) => warnings.push(args);
        try {
            createZone([{id: "a"}, {id: "b"}], {type: "board", navigationMode: "roving"});
        } finally {
            console.warn = originalWarn;
        }
        expect(warnings).to.be.empty;
    });

    it("rejects a navigationMode that is not a documented value", () => {
        expect(() => createZone([{id: "a"}], {navigationMode: "sideways"})).to.throw("navigationMode");
    });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx cypress run --spec "cypress/integration/keyboardRovingTabindex.spec.js"`
Expected: FAIL — the first test fails because `console.warn` fires `dndzone will ignore unknown options`; the second fails because nothing throws.

- [ ] **Step 3: Add the option to `validateOptions` in `src/action.js`**

Add `navigationMode` to the destructure list (after `zoneItemTabIndex`, ~line 74), then add this validation after the `zoneItemTabIndex` check (~line 104):

```js
    if (navigationMode !== undefined && navigationMode !== "default" && navigationMode !== "roving") {
        throw new Error(`navigationMode should be "default" or "roving" but instead it is ${toString(navigationMode)}`);
    }
```

Add the jsdoc line next to `zoneItemTabIndex` (~line 20):

```js
 * @property {string} [navigationMode] - "roving" gives all the zones of a type a single tab stop, navigable with the arrow keys. Defaults to "default".
```

- [ ] **Step 4: Default and store it in `src/keyboardAction.js`**

In the `config` literal (~line 216) add after `zoneItemTabIndex: 0,`:

```js
        navigationMode: "default",
```

In `configure()`'s destructure (~line 348) add after `zoneItemTabIndex = 0,`:

```js
        navigationMode = "default",
```

and in the assignment block after `config.zoneItemTabIndex = zoneItemTabIndex;`:

```js
        config.navigationMode = navigationMode;
```

- [ ] **Step 5: Add the type in `typings/index.d.ts`**

After the `zoneItemTabIndex` line (~line 55):

```ts
    navigationMode?: "default" | "roving"; // "roving" gives all zones of a type one tab stop, navigable with the arrow keys
```

- [ ] **Step 6: Run the test and verify it passes**

Run: `npx cypress run --spec "cypress/integration/keyboardRovingTabindex.spec.js"`
Expected: PASS, 2 passing.

- [ ] **Step 7: Verify nothing else broke, then commit**

```bash
npx cypress run
npm run lint
npx prettier --write src/action.js src/keyboardAction.js typings/index.d.ts cypress/integration/keyboardRovingTabindex.spec.js
git add src/action.js src/keyboardAction.js typings/index.d.ts cypress/integration/keyboardRovingTabindex.spec.js
git commit -m "feat: add the navigationMode option"
```

---

### Task 2: Roving tabindex at rest

One tab stop across all opted-in zones of a type, re-asserted on every update.

**Files:**
- Modify: `src/keyboardAction.js` (new module state + helpers; `configure()`'s item loop ~line 395 and its tail)
- Test: `cypress/integration/keyboardRovingTabindex.spec.js`

**Interfaces:**
- Consumes: `config.navigationMode` from Task 1.
- Produces:
  - `activeItemEl` — module-level `HTMLElement | null`, the board's single tab stop.
  - `rovingZonesOfType(type): HTMLElement[]` — unordered opted-in zones of a type.
  - `setRovingTabindex(type, activeEl): void`
  - `focusCard(type, el): void` — sets `activeItemEl`, re-asserts tabindexes, calls `el.focus()`.

- [ ] **Step 1: Write the failing tests**

Add to `cypress/integration/keyboardRovingTabindex.spec.js`. Add a `tabIndices()` helper next to `createZone`:

```js
    function tabIndices() {
        return zones.map(zone => Array.from(zone.children).map(child => child.tabIndex));
    }
```

Then a new describe block:

```js
    describe("roving tabindex", () => {
        it("keeps exactly one tab stop across every zone sharing a type", () => {
            createZone([{id: "a1"}, {id: "a2"}], {type: "board", navigationMode: "roving"});
            createZone([{id: "b1"}, {id: "b2"}, {id: "b3"}], {type: "board", navigationMode: "roving"});
            expect(tabIndices()).to.deep.equal([
                [0, -1],
                [-1, -1, -1]
            ]);
        });

        it("leaves a zone of another type alone", () => {
            createZone([{id: "a1"}, {id: "a2"}], {type: "board", navigationMode: "roving"});
            createZone([{id: "o1"}, {id: "o2"}], {type: "other", navigationMode: "roving"});
            expect(tabIndices()).to.deep.equal([
                [0, -1],
                [0, -1]
            ]);
        });

        it("does not touch a zone of the same type that did not opt in", () => {
            createZone([{id: "a1"}, {id: "a2"}], {type: "board", navigationMode: "roving"});
            createZone([{id: "b1"}, {id: "b2"}], {type: "board"});
            expect(tabIndices()).to.deep.equal([
                [0, -1],
                [0, 0]
            ]);
        });

        it("gives the active card the configured zoneItemTabIndex, not a hardcoded 0", () => {
            createZone([{id: "a1"}, {id: "a2"}], {type: "board", navigationMode: "roving", zoneItemTabIndex: 3});
            expect(tabIndices()).to.deep.equal([[3, -1]]);
        });

        it("re-asserts the existing tab stop on every update", () => {
            const {action} = createZone([{id: "a1"}, {id: "a2"}], {type: "board", navigationMode: "roving"});
            zones[0].children[0].tabIndex = 0;
            zones[0].children[1].tabIndex = 0;
            action.update({items: [{id: "a1"}, {id: "a2"}], type: "board", navigationMode: "roving"});
            expect(tabIndices()).to.deep.equal([[0, -1]]);
        });

        it("falls back to the first card when the active card is removed", () => {
            const {action} = createZone([{id: "a1"}, {id: "a2"}], {type: "board", navigationMode: "roving"});
            zones[0].removeChild(zones[0].children[0]);
            action.update({items: [{id: "a2"}], type: "board", navigationMode: "roving"});
            expect(tabIndices()).to.deep.equal([[0]]);
        });

        it("leaves tabindex exactly as upstream does when navigationMode is absent", () => {
            createZone([{id: "a1"}, {id: "a2"}, {id: "a3"}], {type: "board"});
            expect(tabIndices()).to.deep.equal([[0, 0, 0]]);
        });
    });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx cypress run --spec "cypress/integration/keyboardRovingTabindex.spec.js"`
Expected: the roving tests FAIL (every card still has tabIndex 0). The last test ("navigationMode is absent") should already PASS — it is the guard, and it must stay green through every remaining task.

- [ ] **Step 3: Add the module state and helpers**

In `src/keyboardAction.js`, next to the other module-level `let` declarations (~line 20), add:

```js
// At-rest board-wide active item pointer. Drives the roving tabindex: exactly one item
// across the opted-in zones of a type is tabbable, the rest are -1. Re-asserted on every
// configure() so the library - not a consumer effect - owns the tabindex.
let activeItemEl = null;
```

Add these helpers as module-level functions (after `refreshActiveDragTabIndices`, ~line 100):

```js
/* ─── at-rest navigation + roving tabindex ─── */

// The zones of a type that opted into roving. A zone that did not opt in is never touched.
function rovingZonesOfType(type) {
    const set = typeToDropZones.get(type);
    if (!set) return [];
    return Array.from(set).filter(dz => dzToConfig.get(dz)?.navigationMode === "roving");
}

// One tab stop per type: activeEl gets its own zone's configured zoneItemTabIndex, every
// other item across the type's opted-in zones gets -1. Reading the index per zone rather
// than from the calling zone keeps zoneItemTabIndex meaningful when zones differ.
function setRovingTabindex(type, activeEl) {
    for (const dz of rovingZonesOfType(type)) {
        const cfg = dzToConfig.get(dz);
        const activeTabIndex = cfg ? cfg.zoneItemTabIndex : 0;
        for (const child of dz.children) {
            child.tabIndex = child === activeEl ? activeTabIndex : -1;
        }
    }
}

// Move the board's single tab stop to el and focus it.
function focusCard(type, el) {
    if (!el) return;
    activeItemEl = el;
    setRovingTabindex(type, el);
    el.focus();
}
```

- [ ] **Step 4: Branch the tabindex assignment in `configure()`**

Replace the single line at ~395:

```js
            draggableEl.tabIndex = isDragging ? -1 : config.zoneItemTabIndex;
```

with:

```js
            // Under roving, the tab stop is assigned board-wide after this loop; default every
            // item to -1 here so a re-render can never leave two items tabbable.
            draggableEl.tabIndex = isDragging || config.navigationMode === "roving" ? -1 : config.zoneItemTabIndex;
```

- [ ] **Step 5: Add the re-assertion block**

In `configure()`, immediately after the `for` loop over `node.children` closes and before the `if (itemMovedToThisZone)` block, add:

```js
        if (!isDragging && config.navigationMode === "roving") {
            const zones = rovingZonesOfType(config.type);
            const stillPresent = activeItemEl && zones.some(dz => dz.contains(activeItemEl));
            let active = stillPresent ? activeItemEl : null;
            if (!active) {
                const firstZoneWithCards = zones.find(dz => dz.children.length > 0);
                active = firstZoneWithCards ? firstZoneWithCards.children[0] : null;
            }
            activeItemEl = active;
            setRovingTabindex(config.type, active);
        }
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `npx cypress run --spec "cypress/integration/keyboardRovingTabindex.spec.js"`
Expected: PASS, 9 passing.

- [ ] **Step 7: Verify the whole suite, then commit**

```bash
npx cypress run
npm run lint
npx prettier --write src/keyboardAction.js cypress/integration/keyboardRovingTabindex.spec.js
git add src/keyboardAction.js cypress/integration/keyboardRovingTabindex.spec.js
git commit -m "feat: give the zones of a type a single roving tab stop"
```

---

### Task 3: Infer the navigation axes from zone arrangement

**Files:**
- Modify: `src/keyboardAction.js` (new helpers next to `rovingZonesOfType`)
- Test: `cypress/integration/keyboardRovingTabindex.spec.js`

**Interfaces:**
- Consumes: `rovingZonesOfType` from Task 2.
- Produces: `orderedRovingZones(type): {zones: HTMLElement[], axis: "x" | "y" | null}` — zones ordered along the cross-zone axis, and that axis. `axis` is `null` when there are fewer than two opted-in zones.

- [ ] **Step 1: Add the layout helpers the later tasks need**

Add `createLanes` and `createRows` helpers next to `createZone`:

```js
    // Two zones side by side: the kanban layout. Cross-zone axis is x.
    function createLanes(itemsA, itemsB, options = {}) {
        const laneStyle = left => ({position: "absolute", top: "0px", left, width: "100px"});
        const a = createZone(itemsA, options, laneStyle("0px"));
        const b = createZone(itemsB, options, laneStyle("200px"));
        return {a, b};
    }

    // Two zones stacked: a stack of horizontal lists. Cross-zone axis is y.
    function createRows(itemsA, itemsB, options = {}) {
        const rowStyle = top => ({position: "absolute", left: "0px", top, height: "50px"});
        const a = createZone(itemsA, options, rowStyle("0px"));
        const b = createZone(itemsB, options, rowStyle("200px"));
        return {a, b};
    }
```

The axis is internal and has no observable effect until navigation exists, so **this task adds no
test of its own** — writing a filler assertion would be worse than none. It is covered by the
layout-specific navigation tests in Tasks 4 and 5, which exercise all three arrangements
(side-by-side, stacked, single zone). The helpers above are the deliverable; the existing suite
staying green is the check.

- [ ] **Step 2: Add the helpers**

In `src/keyboardAction.js`, after `rovingZonesOfType`:

```js
// Which axis are the zones of this type separated along? "x" when they sit side by side (a
// kanban board), "y" when they are stacked (a stack of horizontal lists), null when there is
// no second zone to move to. Inferred from layout rather than declared as an option: the two
// layouts invert both axes, and the DOM already knows which one this is.
function crossZoneAxis(zones) {
    if (zones.length < 2) return null;
    const rects = zones.map(dz => dz.getBoundingClientRect());
    const spread = key => Math.max(...rects.map(r => r[key])) - Math.min(...rects.map(r => r[key]));
    // A tie resolves to "x", the kanban default.
    return spread("top") > spread("left") ? "y" : "x";
}

// The opted-in zones of a type, ordered along the cross-zone axis, plus that axis.
function orderedRovingZones(type) {
    const zones = rovingZonesOfType(type);
    const axis = crossZoneAxis(zones);
    const sorted = [...zones].sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return axis === "y" ? ra.top - rb.top || ra.left - rb.left : ra.left - rb.left || ra.top - rb.top;
    });
    return {zones: sorted, axis};
}
```

- [ ] **Step 3: Use the ordered zones for the Task 2 fallback**

In `configure()`'s re-assertion block, replace `const zones = rovingZonesOfType(config.type);` with:

```js
            const {zones} = orderedRovingZones(config.type);
```

so the "first zone with cards" fallback follows layout order rather than registration order.

- [ ] **Step 4: Run the suite and verify it passes**

Run: `npx cypress run`
Expected: PASS, all green. No behaviour has changed yet — this task only adds helpers and makes the fallback order deterministic.

- [ ] **Step 5: Commit**

```bash
npm run lint
npx prettier --write src/keyboardAction.js cypress/integration/keyboardRovingTabindex.spec.js
git add src/keyboardAction.js cypress/integration/keyboardRovingTabindex.spec.js
git commit -m "feat: infer the cross-zone navigation axis from zone layout"
```

---

### Task 4: Within-zone arrow navigation

Splits upstream's two aliased arrow cases into four and fills the previously-empty at-rest branch.

**Files:**
- Modify: `src/keyboardAction.js` (`handleKeyDown` arrow cases ~lines 252-297)
- Test: `cypress/integration/keyboardRovingTabindex.spec.js`

**Interfaces:**
- Consumes: `focusCard` (Task 2), `orderedRovingZones` (Task 3).
- Produces: `moveWithinZone(currentCard, dir)` and `navigateAtRest(currentCard, keyAxis, dir)`, both closures inside `dndzone()`.

- [ ] **Step 1: Write the failing tests**

```js
    describe("at-rest arrow navigation within a zone", () => {
        it("moves the tab stop down the zone and clamps at the last item", () => {
            const {children} = createZone([{id: "a"}, {id: "b"}], {type: "board", navigationMode: "roving"});
            children[0].focus();
            key(children[0], "ArrowDown");
            expect(document.activeElement).to.equal(children[1]);
            expect(tabIndices()).to.deep.equal([[-1, 0]]);
            key(children[1], "ArrowDown");
            expect(document.activeElement).to.equal(children[1]);
        });

        it("moves the tab stop up the zone and clamps at the first item", () => {
            const {children} = createZone([{id: "a"}, {id: "b"}], {type: "board", navigationMode: "roving"});
            children[1].focus();
            key(children[1], "ArrowUp");
            expect(document.activeElement).to.equal(children[0]);
            key(children[0], "ArrowUp");
            expect(document.activeElement).to.equal(children[0]);
        });

        it("moves within the zone on left/right when there is no second zone", () => {
            const {children} = createZone([{id: "a"}, {id: "b"}], {type: "board", navigationMode: "roving"});
            children[0].focus();
            key(children[0], "ArrowRight");
            expect(document.activeElement).to.equal(children[1]);
            key(children[1], "ArrowLeft");
            expect(document.activeElement).to.equal(children[0]);
        });

        it("moves within the zone on up/down when the zones are stacked rows", () => {
            const {a} = createRows([{id: "a"}, {id: "b"}], [{id: "c"}], {type: "board", navigationMode: "roving"});
            a.children[0].focus();
            // Rows are stacked, so the cross-zone axis is y and left/right move within the row.
            key(a.children[0], "ArrowRight");
            expect(document.activeElement).to.equal(a.children[1]);
        });

        it("does not navigate at rest when navigationMode is absent", () => {
            const {children} = createZone([{id: "a"}, {id: "b"}], {type: "board"});
            children[0].focus();
            key(children[0], "ArrowDown");
            expect(document.activeElement).to.equal(children[0]);
        });

        it("fires no consider events while navigating at rest", () => {
            const {zone, children} = createZone([{id: "a"}, {id: "b"}], {type: "board", navigationMode: "roving"});
            const considers = [];
            zone.addEventListener("consider", e => considers.push(e.detail.info.trigger));
            children[0].focus();
            key(children[0], "ArrowDown");
            key(children[1], "ArrowUp");
            expect(considers).to.be.empty;
        });
    });
```

Add the `key` helper next to `createZone` if not already present:

```js
    function key(el, k) {
        const event = new KeyboardEvent("keydown", {key: k, bubbles: true, cancelable: true});
        el.dispatchEvent(event);
        return event;
    }
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx cypress run --spec "cypress/integration/keyboardRovingTabindex.spec.js"`
Expected: FAIL — arrows do nothing at rest, so `document.activeElement` never moves. The last two tests should already PASS.

- [ ] **Step 3: Add the navigation closures inside `dndzone()`**

Add next to `swap()` (~line 224):

```js
    function moveWithinZone(currentCard, dir) {
        const children = Array.from(node.children);
        const next = children.indexOf(currentCard) + dir;
        if (next >= 0 && next < children.length) focusCard(config.type, children[next]);
    }

    // keyAxis is the axis the pressed key belongs to: "y" for up/down, "x" for left/right.
    // A key on the cross-zone axis moves between zones; the other axis moves within the zone.
    // With no second zone there is no cross-zone axis, so both axes move within.
    function navigateAtRest(currentCard, keyAxis, dir) {
        const {axis} = orderedRovingZones(config.type);
        if (axis === keyAxis) {
            moveAcrossZones(currentCard, dir);
            return;
        }
        moveWithinZone(currentCard, dir);
    }
```

`moveAcrossZones` lands in Task 5. For this task, add a temporary stub immediately above `navigateAtRest` so the suite runs:

```js
    function moveAcrossZones() {
        // implemented in Task 5
    }
```

- [ ] **Step 4: Split the arrow cases**

Replace the whole `case "ArrowDown": case "ArrowRight":` block with two cases, and likewise for up/left. Keep the `isDragging` body **byte-identical** to what is there now — only the guard changes and an at-rest branch is added. `ArrowDown`:

```js
            case "ArrowDown": {
                if (!isDragging) {
                    if (config.navigationMode !== "roving") return;
                    e.preventDefault();
                    e.stopPropagation();
                    navigateAtRest(e.currentTarget, "y", 1);
                    return;
                }
                e.preventDefault(); // prevent scrolling
                e.stopPropagation();
                const {items} = dzToConfig.get(node);
                const children = Array.from(node.children);
                const idx = children.indexOf(e.currentTarget);
                printDebug(() => ["arrow down", idx]);
                if (idx < children.length - 1) {
                    if (!config.autoAriaDisabled) {
                        announceToScreenReader("movedToPosition", {
                            itemLabel: focusedItemLabel,
                            zoneLabel: focusedDzLabel,
                            position: idx + 2,
                            count: items.length
                        });
                    }
                    swap(items, idx, idx + 1);
                    dispatchFinalizeEvent(node, items, {trigger: TRIGGERS.DROPPED_INTO_ZONE, id: focusedItemId, source: SOURCES.KEYBOARD});
                }
                break;
            }
```

`ArrowRight` is the same block with `navigateAtRest(e.currentTarget, "x", 1)` in the at-rest branch. `ArrowUp` and `ArrowLeft` mirror the existing up/left body with `navigateAtRest(e.currentTarget, "y", -1)` and `navigateAtRest(e.currentTarget, "x", -1)` respectively.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx cypress run --spec "cypress/integration/keyboardRovingTabindex.spec.js"`
Expected: PASS. The stacked-rows test passes because with two stacked zones the axis is `"y"`, so `ArrowRight` takes the within-zone branch.

- [ ] **Step 6: Verify the whole suite, then commit**

```bash
npx cypress run
npm run lint
npx prettier --write src/keyboardAction.js cypress/integration/keyboardRovingTabindex.spec.js
git add src/keyboardAction.js cypress/integration/keyboardRovingTabindex.spec.js
git commit -m "feat: navigate within a zone with the arrow keys at rest"
```

---

### Task 5: Cross-zone arrow navigation

**Files:**
- Modify: `src/keyboardAction.js` (replace the Task 4 stub)
- Test: `cypress/integration/keyboardRovingTabindex.spec.js`

**Interfaces:**
- Consumes: `orderedRovingZones` (Task 3), `focusCard` (Task 2).
- Produces: `moveAcrossZones(currentCard, dir)` — real implementation.

- [ ] **Step 1: Write the failing tests**

```js
    describe("at-rest arrow navigation across zones", () => {
        it("moves to the adjacent lane at the same position with left/right", () => {
            const {a, b} = createLanes([{id: "a1"}, {id: "a2"}], [{id: "b1"}, {id: "b2"}], {
                type: "board",
                navigationMode: "roving"
            });
            a.children[1].focus();
            key(a.children[1], "ArrowRight");
            expect(document.activeElement).to.equal(b.children[1]);
            key(b.children[1], "ArrowLeft");
            expect(document.activeElement).to.equal(a.children[1]);
        });

        it("moves to the adjacent row with up/down when the zones are stacked", () => {
            const {a, b} = createRows([{id: "a1"}, {id: "a2"}], [{id: "b1"}, {id: "b2"}], {
                type: "board",
                navigationMode: "roving"
            });
            a.children[1].focus();
            key(a.children[1], "ArrowDown");
            expect(document.activeElement).to.equal(b.children[1]);
            key(b.children[1], "ArrowUp");
            expect(document.activeElement).to.equal(a.children[1]);
        });

        it("clamps the position to the target zone's item count", () => {
            const {a, b} = createLanes([{id: "a1"}, {id: "a2"}, {id: "a3"}], [{id: "b1"}], {
                type: "board",
                navigationMode: "roving"
            });
            a.children[2].focus();
            key(a.children[2], "ArrowRight");
            expect(document.activeElement).to.equal(b.children[0]);
        });

        it("does not navigate past the outermost zone", () => {
            const {a, b} = createLanes([{id: "a1"}], [{id: "b1"}], {type: "board", navigationMode: "roving"});
            b.children[0].focus();
            key(b.children[0], "ArrowRight");
            expect(document.activeElement).to.equal(b.children[0]);
            a.children[0].focus();
            key(a.children[0], "ArrowLeft");
            expect(document.activeElement).to.equal(a.children[0]);
        });

        it("does not cross into a zone of the same type that did not opt in", () => {
            const laneStyle = left => ({position: "absolute", top: "0px", left, width: "100px"});
            const a = createZone([{id: "a1"}], {type: "board", navigationMode: "roving"}, laneStyle("0px"));
            createZone([{id: "b1"}], {type: "board"}, laneStyle("200px"));
            a.children[0].focus();
            key(a.children[0], "ArrowRight");
            expect(document.activeElement).to.equal(a.children[0]);
        });
    });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx cypress run --spec "cypress/integration/keyboardRovingTabindex.spec.js"`
Expected: FAIL — `moveAcrossZones` is a no-op stub, so focus never leaves the starting zone. The last two tests should already PASS.

- [ ] **Step 3: Replace the stub**

```js
    // Move to the same position in the adjacent zone along the cross-zone axis, clamped to
    // that zone's item count. Staying put at the outermost zone is deliberate: there is
    // nowhere to go, and silently moving within the zone instead would be surprising.
    function moveAcrossZones(currentCard, dir) {
        const {zones} = orderedRovingZones(config.type);
        const target = zones[zones.indexOf(node) + dir];
        if (!target) return;
        const targetChildren = Array.from(target.children);
        if (!targetChildren.length) return;
        const position = Array.from(node.children).indexOf(currentCard);
        focusCard(config.type, targetChildren[Math.min(position, targetChildren.length - 1)]);
    }
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx cypress run --spec "cypress/integration/keyboardRovingTabindex.spec.js"`
Expected: PASS.

- [ ] **Step 5: Verify the whole suite, then commit**

```bash
npx cypress run
npm run lint
npx prettier --write src/keyboardAction.js cypress/integration/keyboardRovingTabindex.spec.js
git add src/keyboardAction.js cypress/integration/keyboardRovingTabindex.spec.js
git commit -m "feat: navigate between zones with the arrow keys at rest"
```

---

### Task 6: Home and End

**Files:**
- Modify: `src/keyboardAction.js` (`handleKeyDown`, new cases after the arrow cases)
- Test: `cypress/integration/keyboardRovingTabindex.spec.js`

**Interfaces:**
- Consumes: `focusCard` (Task 2).
- Produces: nothing consumed later.

- [ ] **Step 1: Write the failing tests**

```js
    describe("Home and End", () => {
        it("jumps to the first and last item of the current zone", () => {
            const {children} = createZone([{id: "a"}, {id: "b"}, {id: "c"}], {type: "board", navigationMode: "roving"});
            children[1].focus();
            key(children[1], "End");
            expect(document.activeElement).to.equal(children[2]);
            key(children[2], "Home");
            expect(document.activeElement).to.equal(children[0]);
        });

        it("stays within the current zone rather than the whole board", () => {
            const {a, b} = createLanes([{id: "a1"}, {id: "a2"}], [{id: "b1"}, {id: "b2"}], {
                type: "board",
                navigationMode: "roving"
            });
            b.children[1].focus();
            key(b.children[1], "Home");
            expect(document.activeElement).to.equal(b.children[0]);
            expect(document.activeElement).not.to.equal(a.children[0]);
        });

        it("ignores Home and End when navigationMode is absent", () => {
            const {children} = createZone([{id: "a"}, {id: "b"}], {type: "board"});
            children[1].focus();
            key(children[1], "Home");
            expect(document.activeElement).to.equal(children[1]);
        });
    });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx cypress run --spec "cypress/integration/keyboardRovingTabindex.spec.js"`
Expected: FAIL on the first two; the third passes already.

- [ ] **Step 3: Add the cases**

In `handleKeyDown`, after the four arrow cases:

```js
            case "Home":
            case "End": {
                // Zone-scoped, not board-scoped, matching Home/End in the APG listbox pattern.
                if (isDragging || config.navigationMode !== "roving") return;
                e.preventDefault();
                e.stopPropagation();
                const children = Array.from(node.children);
                if (!children.length) return;
                focusCard(config.type, e.key === "Home" ? children[0] : children[children.length - 1]);
                break;
            }
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx cypress run --spec "cypress/integration/keyboardRovingTabindex.spec.js"`
Expected: PASS.

- [ ] **Step 5: Verify the whole suite, then commit**

```bash
npx cypress run
npm run lint
npx prettier --write src/keyboardAction.js cypress/integration/keyboardRovingTabindex.spec.js
git add src/keyboardAction.js cypress/integration/keyboardRovingTabindex.spec.js
git commit -m "feat: jump to the first and last item with Home and End"
```

---

### Task 7: Keep the tab stop on the item that was just dropped

Resolves the spec's open question about post-drop focus. Without this, `handleDrop` ends with
`triggerAllDzsUpdate()` → `configure()`, whose fallback cannot find the pre-drag `activeItemEl`
(the consumer re-rendered the list, so the element is a fresh node) and hands the board's tab stop
back to the **first item**. Dropping a card would silently throw focus to the top of the board.

**Files:**
- Modify: `src/keyboardAction.js` (`configure()`, the existing `isDragging && config.type === draggedItemType && …` branch ~line 407)
- Test: `cypress/integration/keyboardRovingTabindex.spec.js`

**Interfaces:**
- Consumes: `activeItemEl` (Task 2).
- Produces: nothing consumed later.

- [ ] **Step 1: Write the failing test**

```js
    describe("focus after a drop", () => {
        it("leaves the tab stop on the dropped item, not the first item", () => {
            const items = [{id: "a"}, {id: "b"}, {id: "c"}];
            const {zone, action, children} = createZone(items, {type: "board", navigationMode: "roving"});
            children[2].focus();
            key(children[2], " "); // grab
            key(children[2], " "); // drop in place
            // The consumer re-renders with the same order; the elements are the same nodes here,
            // but configure() runs on the drop and must not reassign the tab stop.
            action.update({items, type: "board", navigationMode: "roving"});
            expect(Array.from(zone.children).map(c => c.tabIndex)).to.deep.equal([-1, -1, 0]);
        });
    });
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx cypress run --spec "cypress/integration/keyboardRovingTabindex.spec.js"`
Expected: FAIL — `[0, -1, -1]`, the tab stop having snapped back to the first item.

- [ ] **Step 3: Point `activeItemEl` at the grabbed item**

In `configure()`, inside the existing branch that refreshes the pointer to the grabbed item, add one
line after `focusedItem = draggableEl;`:

```js
                // Under roving, the item being dragged is also the board's tab stop; keep the
                // pointer on its replacement node so the drop does not hand the tab stop away.
                if (config.navigationMode === "roving") activeItemEl = draggableEl;
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx cypress run --spec "cypress/integration/keyboardRovingTabindex.spec.js"`
Expected: PASS.

- [ ] **Step 5: Verify the whole suite, then commit**

```bash
npx cypress run
npm run lint
npx prettier --write src/keyboardAction.js cypress/integration/keyboardRovingTabindex.spec.js
git add src/keyboardAction.js cypress/integration/keyboardRovingTabindex.spec.js
git commit -m "fix: keep the roving tab stop on the dropped item"
```

---

### Task 8: Document the option and verify against the drag trigger

**Files:**
- Modify: `README.md` (the options list)
- Test: `cypress/integration/keyboardRovingTabindex.spec.js`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

The roving layer must not claim keys the global `keyboardDragTrigger` has yielded. Add the import at the top of the spec:

```js
import {setKeyboardDragTrigger} from "../../src/keyboardDragTrigger";
```

Add `setKeyboardDragTrigger(null);` as the last line of the existing `afterEach` — the trigger is global module state and leaks across specs. Then:

```js
    describe("interaction with keyboardDragTrigger", () => {
        it("leaves Enter untouched under the roving layer when the trigger is 'space'", () => {
            setKeyboardDragTrigger("space");
            const {zone, children} = createZone([{id: "a"}, {id: "b"}], {type: "board", navigationMode: "roving"});
            const considers = [];
            zone.addEventListener("consider", e => considers.push(e.detail.info.trigger));
            children[0].focus();
            const event = key(children[0], "Enter");
            expect(considers, "Enter must not start a grab").to.be.empty;
            expect(event.defaultPrevented, "Enter must not be preventDefault-ed").to.be.false;
        });

        it("still grabs on Space under the roving layer when the trigger is 'space'", () => {
            setKeyboardDragTrigger("space");
            const {zone, children} = createZone([{id: "a"}, {id: "b"}], {type: "board", navigationMode: "roving"});
            const considers = [];
            zone.addEventListener("consider", e => considers.push(e.detail.info.trigger));
            children[0].focus();
            key(children[0], " ");
            expect(considers).to.deep.equal([TRIGGERS.DRAG_STARTED]);
        });
    });
```

Add the `TRIGGERS` import at the top: `import {TRIGGERS} from "../../src/constants";`

- [ ] **Step 2: Run the tests**

Run: `npx cypress run --spec "cypress/integration/keyboardRovingTabindex.spec.js"`
Expected: PASS without source changes — the roving layer never claims Enter or Space. If either fails, a roving branch is preventing default ahead of the trigger check; fix that rather than the test.

- [ ] **Step 3: Document the option in `README.md`**

In the options list, after the `zoneItemTabIndex` entry, add:

```markdown
##### navigationMode

Optional, defaults to `"default"`. Set to `"roving"` to give all the zones of a type a **single tab stop** instead of one per item — Tab moves into the board and straight out again, and the arrow keys move between items.

Every item stays focusable and draggable; only how many of them appear in the Tab sequence changes. Useful when items contain their own buttons or links, where one tab stop per item multiplies the tab sequence.

While roving is on, the arrow keys navigate at rest (they still reorder during a drag):

- The axis the zones of the type are laid out along moves **between zones**; the perpendicular axis moves **within a zone**. So on a board of side-by-side lists, left/right change list and up/down move within one; on a stack of horizontal lists it is the other way round. With a single zone, both axes move within it.
- `Home` / `End` jump to the first / last item of the current zone.

Opt in per zone. A zone of the same type that has not opted in keeps its own per-item tab stops, and arrow navigation will not cross into it.
```

- [ ] **Step 4: Full verification**

```bash
npx cypress run
npm run lint
```

Expected: all specs pass, lint exits 0. Confirm `git status` shows no `docs/` files staged or untracked on this branch.

- [ ] **Step 5: Commit**

```bash
npx prettier --write README.md cypress/integration/keyboardRovingTabindex.spec.js
git add README.md cypress/integration/keyboardRovingTabindex.spec.js
git commit -m "docs: document the navigationMode option"
```

---

## Definition of done

- `navigationMode: "roving"` gives all opted-in zones of a type one tab stop.
- Arrow keys navigate at rest on the inferred axes; `Home`/`End` are zone-scoped.
- With `navigationMode` absent, every tabindex and every key behaves exactly as upstream — verified by explicit tests in Tasks 2, 4 and 6.
- A drop leaves the tab stop on the dropped item.
- Drag semantics unchanged; no new aria strings; one new option.
- Full suite green, lint clean, no `docs/` on the branch.

## Deliberately not in this branch

Roadmap items 2 (Escape cancel-to-origin), 4 (tentative-until-drop) and 5 (cross-zone move *during* a grab). None are load-bearing for the above — every path added here is gated on `!isDragging`.
