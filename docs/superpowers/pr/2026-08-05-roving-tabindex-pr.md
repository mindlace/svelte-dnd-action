Closes #460.

In #460 you asked a question that never got answered:

> how can it be avoided if we want to support keyboard dnd?

and named the constraint any answer has to satisfy:

> The draggable item itself has to be tabbable for accessibility (to allow keyboard based drag and drop).

This is an attempt at that answer. It keeps every item tabbable and changes only how many of them sit in the Tab sequence.

### What it does

A new per-zone option, `navigationMode: "roving"`. When set, all the opted-in zones of a `type` share a **single item tab stop** between them instead of one per item, and the arrow keys move it.

This is the technique the ARIA Authoring Practices Guide calls [managing focus within components using a roving tabindex](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/#kbd_roving_tabindex), applied to a composite — "a discrete UI component that contains multiple focusable elements" — where "the tab and shift + tab keys move focus from one UI component to another while other keys, primarily the arrow keys, move focus inside of components". Concretely: the item in the tab sequence has the zone's `zoneItemTabIndex`, every other item has `tabindex="-1"`, and an arrow key swaps which one that is.

So @gyurielf's case in #460 —

> I have a button, which is a child of the dnd zone item... when i tabulate it's jumps to the dnd item first (since it has tabindex=0 by default) then the next tab will jump to the button

— becomes one stop for the list plus that button, rather than one per item plus one per button. And @iyj6707's original case (Tab should reach the next text box) works because a list of N items is a single stop on the way there.

Keyboard dragging is untouched: the item under the tab stop is a normal, tabbable, grabbable item, so space/enter grabs it and every existing drag behaviour applies.

### Why I think this is safe to take

- **Nothing changes unless the option is set.** At rest, the arrow handlers currently begin `if (!isDragging) return;` — they do nothing. This fills that branch, and only for zones that opted in. With the option absent, tabindex, key handling, event consumption and drag behaviour are all byte-identical to today.
- **Drag semantics are completely unchanged.** Every keyboard move still finalizes immediately; the no-limbo guarantee is untouched. The two aliased arrow cases had to be split into four to give each key its own at-rest branch, but each resulting `isDragging` body is byte-for-byte what it was (including the `printDebug("arrow down")` in the `ArrowRight` path, kept rather than tidied so the split is provably behaviour-preserving).
- **It extends something the library already does.** During a drag, `draggableEl.tabIndex = isDragging ? -1 : config.zoneItemTabIndex` plus the grabbed item staying tabbable already means exactly one item is tabbable. This applies the same idea at rest.
- **It composes with `zoneItemTabIndex`** rather than overriding it — the active item gets its own zone's configured value, so `zoneItemTabIndex: 3` gives `[3, -1, -1]`.
- **One new option**, one new value.

### Scope: per type, not per zone

The tab stop is shared across all the opted-in zones of a `type`, because a `type` is already the unit a keyboard drag moves through — Tab moves a live grab between zones of a type. A single zone is just the degenerate case, which is why this covers #460's single-list reporters as well as a multi-lane board.

Cross-zone movement isn't a bonus feature here: with one tab stop for the whole board, it's the only way to reach a second zone.

### The axes are inferred, not configured

A board of vertical lists side by side and a stack of horizontal lists invert both axes, so neither key pair can have a fixed job. Rather than add an `orientation` option, the axis is read off the layout:

- the axis the zones are separated along moves **between** zones
- the perpendicular axis moves **within** a zone
- with a single zone there's no cross-zone axis, so both axes move within it — which also matches what you already do mid-drag, aliasing `ArrowRight`→`ArrowDown` so horizontal lists work

`Home`/`End` go to the first/last item of the current zone, matching [the listbox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/#keyboardinteraction), where they move focus to the first/last option of that list rather than across lists.

### Known limits, documented in the README

- The inference assumes the zones of a type form a single row or a single column. A 2x2 grid of zones resolves to an arbitrary axis.
- Cross-zone movement is geometric while within-zone movement is DOM order, so RTL or reversed-flex layouts can make the two disagree.
- Zone containers keep their own `zoneTabIndex` and so remain tab stops; the reduction is N items → 1, not the whole board → 1. Pass `zoneTabIndex: -1` for that.
- A `dragDisabled` zone stays out of the roving group entirely — it has no key handling to move a tab stop off itself, so including it would make it a keyboard trap.
- Keys pressed inside an item's own controls (input, textarea, select, link, button, contenteditable) are left to that control, mirroring what the space/enter handler already does.

### Tests

46 new cases in `cypress/integration/keyboardRovingTabindex.spec.js`, including explicit guards that behaviour is unchanged with the option absent, that a non-opted-in zone of the same type is never touched or crossed into, that arrow reordering during a live drag still works with roving on, and that keys inside nested controls are left alone. Full suite green.

Happy to change any of the naming or split this differently if you'd rather take it in smaller pieces.
