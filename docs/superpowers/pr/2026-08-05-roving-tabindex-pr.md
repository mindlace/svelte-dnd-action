Re: #460.

In #460 you asked a question that never got answered:

> how can it be avoided if we want to support keyboard dnd?

and named the constraint any answer has to satisfy:

> The draggable item itself has to be tabbable for accessibility (to allow keyboard based drag and drop).

This is an attempt at that answer. It keeps every item tabbable and changes only how many of them sit in the Tab sequence.

### What it does

A new per-zone option, `tabGroup`. Zones that share a `tabGroup` string share a **single item tab stop** between them instead of one per item, and the arrow keys move it.

This is the technique the ARIA Authoring Practices Guide calls [managing focus within components using a roving tabindex](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/#kbd_roving_tabindex), applied to a composite — "a discrete UI component that contains multiple focusable elements" — where "the tab and shift + tab keys move focus from one UI component to another while other keys, primarily the arrow keys, move focus inside of components". Concretely: the item in the tab sequence keeps the zone's `zoneItemTabIndex`, every other item gets `tabindex="-1"`, and an arrow key swaps which one that is.

So @gyurielf's case in #460 —

> I have a button, which is a child of the dnd zone item... when i tabulate it's jumps to the dnd item first (since it has tabindex=0 by default) then the next tab will jump to the button

— becomes one stop for the list plus that button, rather than one per item plus one per button. And @iyj6707's original case (Tab should reach the next text box) works because a list of N items is a single stop on the way there.

Keyboard dragging is untouched: the item under the tab stop is a normal, tabbable, grabbable item, so space/enter grabs it and every existing drag behaviour applies.

### Why I think this is safe to take

- **Nothing changes unless the option is set.** At rest, the arrow handlers currently begin `if (!isDragging) return;` — they do nothing. This fills that branch, and only for zones that opted in. With the option absent, tabindex, key handling, event consumption and drag behaviour are all identical to today.
- **Drag semantics are completely unchanged.** Every keyboard move still finalizes immediately; the no-limbo guarantee is untouched. The two aliased arrow cases had to be split into four to give each key its own at-rest branch, but each resulting `isDragging` body is byte-for-byte what it was — including the `printDebug("arrow down")` in the `ArrowRight` path, kept rather than tidied so the split is provably behaviour-preserving.
- **It extends something the library already does.** During a drag, `draggableEl.tabIndex = isDragging ? -1 : config.zoneItemTabIndex` plus the grabbed item staying tabbable already means exactly one item is tabbable. This applies the same idea at rest.
- **It composes with `zoneItemTabIndex`** rather than overriding it — the active item gets its own zone's configured value, so `zoneItemTabIndex: 3` gives `[3, -1, -1]`.
- **One new option**, and only `src/keyboardAction.js` gains behaviour. The diff against `master` removes five lines in total; everything else is additive.

### One rule for the arrow keys

Lists side by side and lists stacked want opposite things from the same two key pairs, so neither pair can have a fixed job. Rather than add an `orientation` option or infer one from the layout, the rule is directional:

> **Move to the zone in that direction if the group has one there; otherwise move within the current zone.**

`ArrowRight` means "the zone to the right", and if there isn't one it means "the next item". That single rule covers every arrangement for the same reason: side-by-side lists have nothing below, so up/down walk the list; stacked lists have nothing to the right, so left/right walk the list; a grid of single-slot zones has a neighbour in every direction, so every arrow moves a slot. Nothing has to know what shape the layout is.

Choosing the zone follows the approach [CSS Spatial Navigation](https://www.w3.org/TR/css-nav-1/) specifies — candidates must lie in the direction of travel, ones whose extent overlaps the source rank ahead of diagonal ones, and the nearest wins. Zones that are empty or `display: none` are skipped during selection, so an arrow looks past them rather than dying on one.

### Known limits, all documented in the README

- **Within a zone, this navigates a list, not a grid.** The arrow keys step in list order, which is the movement model the library already has — `swap(items, idx ± 1)`, with both axes aliased to it — so a zone whose own items wrap into a grid gets the same list-style movement at rest that it already gets while dragging. Doing that properly means the APG grid pattern, which I think is a separate feature rather than something to fold in here.
- Where multi-item zones are themselves arranged in 2-D, an arrow that has a zone in its direction leaves the current zone rather than moving within it. Grids of single-slot zones — the case this is most useful for — are unaffected.
- A mistyped group name silently creates a second group. That is the cost of an explicit identifier.
- Zone containers keep their own `zoneTabIndex` and so remain tab stops; the reduction is N items → 1, not the whole group → 1. Pass `zoneTabIndex: -1` for that.
- A `dragDisabled` zone stays out of the group entirely — it has no key handling to move a tab stop off itself, so including it would make it a keyboard trap.
- Keys pressed inside an item's own controls (input, textarea, select, link, button, contenteditable) are left to that control, mirroring what the space/enter handler already does.

### Tests

54 cases in `cypress/integration/keyboardRovingTabindex.spec.js`, including explicit guards that behaviour is unchanged with the option absent, that a zone without a `tabGroup` is never touched or crossed into, that zones in different groups stay independent, that arrow reordering during a live drag still works with the option on, that keys inside nested controls are left alone, and that a 4x4 arrangement of zones navigates correctly in all four directions. Full suite green.

Happy to change any of the naming, or to split this differently if you would rather take it in smaller pieces.
