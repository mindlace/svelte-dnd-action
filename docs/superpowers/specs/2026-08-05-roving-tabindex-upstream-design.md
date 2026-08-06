# Roving tabindex + at-rest navigation — upstream PR design

Answers upstream **issue [#460](https://github.com/isaacHagoel/svelte-dnd-action/issues/460)**,
"Remove tabindex of DndZone items", with code. Roadmap item 3.

Status: **design, pre-implementation.** Ethan reviews before any PR is opened.

## The problem, in the reporters' words

`@iyj6707` opened #460 wanting item tabindex gone so Tab would reach the next text box.
`@gyurielf` reframed it in the form that matches ours:

> I have a button, which is a child of the dnd zone item... when I tabulate it jumps to the dnd
> item first (since it has tabindex=0 by default) then the next tab will jump to the button.

Isaac replied with the constraint any answer must satisfy —

> The draggable item itself has to be tabbable for accessibility (to allow keyboard based drag
> and drop).

— and then asked:

> how can it be avoided if we want to support keyboard dnd?

**That question is the last comment on the thread.** Nobody answered it; the issue went quiet and
was closed. This PR is the answer.

The answer is the WAI-ARIA composite-widget pattern: keep every item tabbable, but expose only
**one** of them to the Tab sequence at a time, and navigate between them with the arrow keys.
Both constraints hold simultaneously. N items become 1 tab stop, and keyboard drag still works
because the item under focus is still a real, tabbable, grabbable item.

## Two acceptance criteria

1. **Palatable given Isaac's stated concerns.** No behaviour change for anyone who does not opt
   in; satisfies his tabbability constraint; small surface.
2. **planafoot consumes it as-is** once upstreamed — configuration only, no wrapper re-implementing
   navigation, no patch-level shim.

Criterion 2 is what forces the scope decision below. Getting it wrong means the fork survives.

## Design decisions

### 1. Scope: one tab stop per **type**, not per zone

A board is several zones sharing a `type`. The tab stop is board-wide: exactly one item across
every opted-in zone of the type is tabbable.

Rationale: **upstream already treats a type as one drag universe** — Tab moves a live grab between
zones of a type. Navigation adopting the scope dragging already has is the coherent position.

This also *is* the single-zone answer, not a superset of it. A lone list is the degenerate case:
one zone of a type yields one tab stop, which is exactly what #460 asks for. There is no separate
"in-zone" feature to build.

### 2. Opt-in: a per-zone `navigationMode` option

```js
navigationMode: "roving" | "default"; // default: "default"
```

Per-zone, not a global setter. Every other tabindex behaviour upstream is already a per-zone
option (`zoneTabIndex`, `zoneItemTabIndex`); a global would force roving onto every type on the
page, including an unrelated sortable list, and could not be expressed per board.

**Mixed opt-in is predictable.** A zone governs its own items' tabindex. A zone of the type that
did not opt in keeps upstream's per-item tab stops untouched, and arrow navigation does not cross
into it. No zone can reach into a non-participating zone and rewrite its tabindexes.

### 3. Arrow keys — axes inferred from how the zones are arranged

Neither axis can be assigned a fixed job. A kanban board is vertical lists arranged side by side;
a stack of horizontal lists is the transpose, and **both axes invert at once**. Hardcoding
"left/right hops zones" gets the second layout exactly backwards — `ArrowRight` would jump to the
zone *below*, and `ArrowDown` would walk along a list that runs sideways.

So the mapping is derived, not fixed:

> **The cross-zone axis is the axis the zones of the type are separated along. The within-zone axis
> is the perpendicular one.**

| Layout                              | Zones arranged | Cross-zone | Within-zone |
| ----------------------------------- | -------------- | ---------- | ----------- |
| Kanban — vertical lists side by side | horizontally   | `←` `→`    | `↑` `↓`     |
| Stack of horizontal lists            | vertically     | `↑` `↓`    | `←` `→`     |
| Single zone                          | *none*         | *none*     | both axes   |

**Inference rule.** Across the opted-in zones of the type, compare the spread of `rect.left`
against the spread of `rect.top` (using the rects already computed for ordering). The larger spread
is the cross-zone axis; ties resolve to horizontal, matching the kanban default. Zones are ordered
along that axis. Zones arranged in a 2D grid resolve to their dominant axis — imperfect, but
deterministic and documented.

**The single-zone row is the general rule, not a special case.** With no second zone there is no
cross-zone axis, so both axes move within the list — correct for a lone vertical *or* horizontal
list, and it **mirrors what upstream already does mid-drag**, where `ArrowRight`→`ArrowDown` and
`ArrowLeft`→`ArrowUp` are aliased precisely so horizontal lists work.

`Home` / `End` focus the first / last item **of the current zone**, on either layout.

Two consequences worth stating plainly:

- **No `orientation` option.** The layout already expresses its orientation; asking the consumer to
  restate it in config invites the two to disagree, and a wrong value breaks navigation with no
  visible cause. Inference is also self-correcting when a responsive layout reflows lanes from
  side-by-side to stacked. The PR carries exactly one new option.
- **Cross-zone movement is not optional garnish.** With one tab stop for the whole board it is the
  only way to reach a second zone. It ships with roving, or roving is unusable.

`Home`/`End` stay zone-scoped while arrows are board-scoped. Deliberate: Home/End are list-relative
in every APG listbox pattern, and a board-wide Home that silently jumped zones would surprise.

### 4. Position preservation across zones

A cross-zone move preserves the item's index within its zone, clamped to the target zone's item
count. Moving from position 4 of a 5-item zone into a 2-item zone lands on position 2, not 4. This
holds on either axis.

### 5. Composition with `zoneItemTabIndex`

The active item receives **its own zone's configured `zoneItemTabIndex`**, not a hardcoded `0`;
every other item in an opted-in zone gets `-1`. So `zoneItemTabIndex: 3` yields `[3, -1, -1]`.

This matters for palatability: silently overriding a documented option would be a near-automatic
rejection, and this pre-empts it.

### 6. Lifecycle: the tab stop survives re-renders

The active item is re-asserted on every `configure()`, so a consumer `$effect` or a list re-render
cannot leave the board with zero tab stops or several. Rules:

- If the previously active item is still contained by an opted-in zone of the type, keep it.
- Otherwise fall back to the first item of the first opted-in zone of the type that has items.
- If the type has no items at all, there is no tab stop.

After a drop, upstream already calls `triggerAllDzsUpdate()`, so this runs then too and the dragged
item retains focus.

### 7. Silent

At-rest navigation makes **no screen-reader announcements**. The newly focused item is read by the
screen reader because it is focused; announcing on top of that would double-speak. No new aria
string keys, so `setAriaStrings` and `src/helpers/aria.js` are untouched by this PR.

## What this PR does NOT contain

Deliberately excluded, and none of it is load-bearing for the above:

- **Item 2** — Escape cancel-to-origin, the `cancelled` key.
- **Item 4** — tentative-until-drop, `pendingMove`, `handleDrop`'s commit flag. **Drag semantics are
  entirely unchanged: every keyboard move still finalizes immediately**, preserving the no-limbo
  guarantee Isaac defended in #321.
- **Item 5** — cross-lane arrow move *during a grab*, the `movedToZone` key.

Verified orthogonal: every at-rest path is gated on `!isDragging`, and none of it reads or writes
`pendingMove`, `grabOrigin`, or the commit flag. The entanglement in `keyboardAction.js` is textual
adjacency, not data flow.

## Why this should be palatable

- **Zero behaviour change when the option is absent.** At rest, upstream's arrow handlers currently
  begin `if (!isDragging) return;` — they do nothing. We fill a branch that is empty today. With
  `navigationMode` unset, `configure()` keeps upstream's `isDragging ? -1 : zoneItemTabIndex` line
  verbatim.
- **It satisfies his stated constraint.** Every item stays tabbable; only Tab *exposure* changes.
- **It extends a behaviour he already ships.** Upstream already runs a roving tabindex *during* a
  drag: `isDragging ? -1 : …` plus keeping the grabbed item tabbable means exactly one item is
  tabbable mid-drag. This applies the same idea at rest.
- **It answers an open question on a dead thread**, rather than reopening a settled debate.
- **Small surface**: one new option, one new value.

## planafoot adoption (criterion 2)

Adding `navigationMode: "roving"` to each lane's `dndzone` config. That is the entire change — no
wrapper, no shim.

The fork's two hard constraints are met by the feature as specified: `docs/manual/shortcuts.svx`
promises "Tab in, Tab out; the board never traps your focus" (one tab stop per board ✓), and cards
containing their own buttons no longer multiply tab stops (✓).

**This does not by itself retire the fork** — items 2, 4 and 5 keep `planafoot` alive. It removes
item 3's share of the diff.

## Implementation sketch

All in `src/keyboardAction.js`. Against upstream:

1. Module-level `activeItemEl` pointer, plus helpers `setRovingTabindex`, `focusCard`, and
   `navigateToAdjacentZone`. Ported from the fork.
2. **New, not in the fork:** `crossZoneAxis(type)`, returning `"x" | "y" | null` by comparing the
   spread of zone `rect.left` against `rect.top` (null when fewer than two opted-in zones). The
   fork's `orderedZonesOfType` becomes `orderedZonesOfType(type, axis)`, sorting along the inferred
   axis rather than always left-then-top. Arrow dispatch consults the axis to decide whether a key
   moves within the zone or across zones.
3. Split upstream's two aliased arrow cases into four independent cases, keeping the existing
   `isDragging` bodies **byte-identical** and filling only the at-rest branch. Add `Home`/`End`.
4. Gate every at-rest branch on the zone's `navigationMode === "roving"`.
5. In `configure()`, branch the per-item tabindex line on `navigationMode`, and add the
   re-assertion block described in §6.
6. `validateOptions` accepts `navigationMode`; typings gain the option; README documents it,
   including the inferred-axis rule.

`zoneHoldingItem` and the `grabIsLive`/`grabIsAlive` split stay in the fork — they serve items 2
and 5 only.

## Test plan

Port the fork's `keyboardRovingTabindex.spec.js` (15 tests, all passing, no dependency on items
2/4/5), adapted to set the option. Coverage: one tab stop per type; type boundary isolation;
re-assertion on update; fallback when the active item is removed; `zoneItemTabIndex` composition;
arrow navigation with clamping in all four directions; `Home`/`End`; and no `consider` events fired
while navigating at rest.

Note the fork's existing arrow tests assume the kanban layout, so they must be re-read as testing
the *inferred* axis rather than a fixed one; the spec already lays its zones out side by side via
`zoneStyle`.

New tests this design requires beyond the fork's:

- `navigationMode` absent → upstream tabindex behaviour is byte-for-byte unchanged (the
  no-regression guard, and the most important test in the PR).
- Mixed opt-in: a non-participating zone of the same type keeps its per-item tab stops, and arrow
  navigation does not cross into it.
- **Axis inference, all three layouts**: zones side by side → `←`/`→` cross zones and `↑`/`↓` move
  within; zones stacked → `↑`/`↓` cross zones and `←`/`→` move within; a single zone → both axes
  move within. The stacked case is the one the fork has never exercised and the one that motivated
  the rule, so it gets the most cases.
- Position preservation and clamping on a cross-zone move along **either** axis.

## Sequencing

The roadmap says to open a discussion issue on #460 before building. Ethan's call is to **answer
with code instead** — the thread died on an unanswered question, and a working implementation is a
better answer than another question. Build it, then decide at review whether the PR opens cold or
is preceded by a comment on #460.

## Resolved during planning

- **Post-drop focus.** The PR must point `activeItemEl` at the grabbed item's replacement node
  during `configure()`. `handleDrop` ends with `triggerAllDzsUpdate()`, so `configure()` runs on
  the drop; without this the fallback cannot find the pre-drag element after the consumer
  re-renders and hands the board's tab stop back to the **first** item — dropping a card would
  silently throw focus to the top of the board. Covered by plan Task 7.
- **Option shape.** `navigationMode: "default" | "roving"`, a named-value string rather than a
  boolean `rovingTabIndex`, matching `keyboardDragTrigger`'s precedent and leaving room for future
  modes without a second option.
