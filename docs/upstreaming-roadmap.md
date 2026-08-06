# Upstreaming roadmap

**A living document.** Update it when a PR lands, when a decision changes, or when upstream
answers something. It exists so nobody has to re-derive "what's left" from the diff again.

Last updated: 2026-08-05, when `keyboardDragTrigger` merged upstream (#702, in v0.9.78) and
`planafoot` merged v0.9.78.

> **Consumer note.** planafoot the app is still pinned at `7855c822` and still passes
> `onActivate`, which no longer exists. Until the app is updated it will log
> `dndzone will ignore unknown options` and Enter will grab a card instead of opening it.
>
> The fix is **no longer a per-zone option** — upstream reworked the feature into a global
> setter before merging. The app must call `setKeyboardDragTrigger("space")` once from the root
> layout (next to its existing `setAriaStrings` call) and drop `onActivate` from every `dndzone`.
> See `docs/superpowers/specs/2026-08-04-keyboard-drag-trigger-migration-design.md` §2–3, whose
> per-zone-option shape is now superseded.

## Layout

| Branch      | What it is                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `master`    | Tracks `upstream/master` exactly. Never carries fork work. Cut every upstream PR branch from here.       |
| `planafoot` | The consuming fork: upstream plus the board-a11y layer. What planafoot the app pins (`git+…#planafoot`). |

`upstream` remote is `isaacHagoel/svelte-dnd-action`; `origin` is `mindlace/svelte-dnd-action`.

## The rule that governs sequencing

**One PR upstream at a time.** Don't stack. Two reasons:

1. Don't hand the maintainer several things to weigh at once.
2. Items 2 and 4 below both rewrite `handleDrop`'s signature. Serial means each rebases onto
   what he _actually accepted_, instead of us maintaining a speculative stack on a moving base.

## Shipped

### setAriaStrings — merged as upstream #698 (in v0.9.77)

Upstream then evolved it past what we had: each call now merges over the **defaults**, not over
the current table, so a call describes a whole locale and anything it omits reverts to English.
`planafoot` adopted upstream's semantics in the v0.9.77 merge. This is a no-op for planafoot the
app, which installs a complete table once from the root layout.

### 1. `keyboardDragTrigger` — merged as upstream [#702](https://github.com/isaacHagoel/svelte-dnd-action/pull/702) (in v0.9.78)

`keyboardDragTrigger: "space" | "enter" | "space_or_enter"` (default `"space_or_enter"`) narrows
which keys the library claims to start and stop a keyboard drag. Keys outside the trigger are
left **completely** untouched — no `preventDefault`, no `stopPropagation`, no callback. Fully
additive: the default is today's behaviour exactly.

Evidence: **#511 is open** and asks for Enter to activate rather than grab — @ulaas wants Enter
to play the focused playlist item. Isaac twice said he is open to a PR. The strongest framing is
that the reported workarounds (`tabindex="-1"` on everything plus custom listeners) are _less_
accessible than the library's own handling.

**Supersedes PR #701 (`onActivate`), now closed.** That version answered #511 with a callback the
zone invoked on Enter. Two reasons the option is the better ask:

1. **Smaller surface.** A string that narrows which keys the library claims is a configuration
   value. A callback is a new event surface the maintainer owns forever.
2. **It yields the key completely.** `onActivate` still consumed the event and handed back an
   item id, so the consumer got exactly one behaviour — "activate this item". Under the trigger,
   Enter behaves as if the library were not installed, so a menu, a nested control's own
   default, or anything else works too.

**What upstream changed before merging.** He took the behaviour but not the shape: it became a
**global** `setKeyboardDragTrigger(trigger)` in a new `src/keyboardDragTrigger.js` rather than a
per-zone `dndzone` option, and he made `zoneActiveInstruction` **trigger-aware** — it is now a
function receiving `{keyboardDragTrigger}`, so the spoken instruction names the right key. That
in turn split `setAriaStrings`' validation into three key lists (function-only, string-or-function,
string-only).

Two lessons for the queue below, both about *shape*:

1. **He prefers a global setter to a per-zone option** for anything that is a policy rather than
   a per-list fact. Item 3's `navigationMode` should be pitched that way, not as a zone option.
2. **He follows the feature through to the announcements.** A PR that adds a behaviour without
   updating what the screen reader says about it is half a PR to him.

`planafoot` merged v0.9.78 and now carries **zero** delta on the feature — `src/action.js`,
`src/index.js`, `src/constants.js`, and `src/keyboardDragTrigger.js` are byte-identical to
upstream. The only fork delta left in the aria layer is its two extra string keys (`cancelled`,
`movedToZone`) layered onto upstream's key lists.

## Queued

### 2. Escape cancel-to-origin + the `cancelled` aria key — **next up**

Restore the card to where it was lifted, announce the cancel, end the grab without committing.

Evidence: **#321**. Closed as completed, but the feature was _never built_ — it closed because
the reporter hacked it with `draggedLeftDocument`, which Isaac called "a bit of a hack". His
words: _"It should be possible and not difficult to make 'esc' (optionally i guess) trigger a
'revert' action... I'm open to a pull request."_ Note **"optionally"** — pitch it behind a flag.

Does **not** depend on item 4. Under upstream's finalize-per-step model a restore is just a real
move backward, which is still correct.

### 3. Roving tabindex + at-rest 2D navigation + Home/End

One tab stop per board instead of one per card, arrows for 2D movement.

Evidence: **#460** is the tab-stop-explosion complaint — @gyurielf: _"I have a button, which is
a child of the dnd zone item... when I tabulate it jumps to the dnd item first, then the next tab
jumps to the button."_ Isaac closed it asking **"how can it be avoided if we want to support
keyboard dnd?"** Roving tabindex is the answer to that question; that is the framing.

**Must be opt-in** (`navigationMode: 'roving'` or similar) — today a 5-item list has 5 tab stops
and this makes it 1. Our `zoneItemTabIndex` composition fix already pre-empts the "silently
overrides a documented option" objection, which would otherwise be near-automatic rejection.

Open a **discussion issue on #460 first, not a PR** — let him name the option before we build it.

### 4. Tentative-until-drop — hardest, may never go

Grab steps become `consider`s; one `finalize` at the drop.

**There is no upstream demand, and there is an explicit contrary position.** In #321 Isaac states
the design rationale for finalize-per-step: _"Currently every move with the keyboard is considered
a drop **in order to prevent the system from being in a limbo state**. Also it allows mixing mouse
and keyboard dnd operations."_ This overturns a position he has articulated and defended.

It is also the deepest break: `handleZoneFocus` goes from `dispatchFinalizeEvent` to
`dispatchConsiderEvent`, so every consumer relying on finalize-per-Tab-step breaks. Only viable
as opt-in preserving his no-limbo guarantee by default.

Two things in our diff are **consequences** of this, not independent bugs — do not submit them
as standalone fixes, they will not reproduce on stock upstream:

-   `arrowReorder` reading the index from `items` rather than the DOM
-   the `zoneHoldingItem` re-sync of a stale `focusedDz`

> ### Fix before this is ever submitted
>
> `src/keyboardAction.js` cites `(#535)` five times as the provenance for tentative-until-drop.
> **Upstream #535 is "Scrolling with nested dnd zones not working"** — closed, unrelated. Those
> comments claim an upstream mandate that does not exist. Strip or correct them; a maintainer
> will read it as fabricated justification.

### 5. Cross-lane arrow move (←/→ during a grab) + the `movedToZone` key

Weakest of the set. Upstream binds `ArrowRight`→`ArrowDown` and `ArrowLeft`→`ArrowUp` so
horizontal lists work; repurposing ←/→ silently breaks every horizontal-list consumer, and no
issue asks for it. Needs an `orientation` option, or it rides along with 3/4's opt-in.

## Permanently fork-only — never in an upstream PR

-   **`package.json` `src/` resolution** (`main`/`module`/`svelte`/`exports` → `src/index.js`).
    Build-free consumption for planafoot. Must never appear upstream.
-   **`docs/`** — this file and the superpowers plans/specs.

## Why the board a11y layer exists at all

Not aesthetics. Two hard constraints from planafoot:

1. **Focus escape.** `docs/manual/shortcuts.svx` promises "Tab in, Tab out; the board never traps
   your focus." Upstream's every-card-a-tab-stop makes a board of N cards N tab stops.
2. **Cards contain their own controls** (`Card.svelte` has buttons and a `role="button" tabindex="0"` title), so it is really N × M tab stops.

Note what is _not_ a divergence: **Tab-to-move-to-another-zone still works.** `handleZoneFocus`
and `getActiveDragTabIndex` are upstream's, untouched — ←/→ during a grab is additive alongside
Tab, never a replacement.
