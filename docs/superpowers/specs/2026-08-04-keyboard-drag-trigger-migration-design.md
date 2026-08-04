# Adopt `keyboardDragTrigger`, retire `onActivate`

Date: 2026-08-04
Branch: `feat/adopt-keyboard-drag-trigger` (off `planafoot`)
Spans two repos: `svelte-dnd-action` (`planafoot` branch) and `planafoot` the app.

## Why

Upstream issue [#511](https://github.com/isaacHagoel/svelte-dnd-action/issues/511) asks for
_Enter_ to activate a focused item instead of starting a keyboard drag. The fork answered it
with `onActivate`, a callback the zone invokes on Enter — submitted as PR #701.

That PR is closed. PR [#702](https://github.com/isaacHagoel/svelte-dnd-action/pull/702) replaces
it with `keyboardDragTrigger`, on branch `feat/keyboard-drag-trigger` (`88608c9`), a single
commit on top of `master`.

The second framing is the better ask, for two reasons:

1. **Smaller surface.** A string option that narrows which keys the library claims is a
   configuration value. A callback is a new event surface the maintainer has to own forever.
2. **It yields the key completely.** `onActivate` still called `preventDefault()` and
   `stopPropagation()` on Enter and then handed the consumer an item id. `keyboardDragTrigger`
   returns before touching the event, so Enter behaves exactly as if the library were not
   installed. Consumers that want something other than "activate this item" — a menu, a
   nested control's own default — get it for free.

The option takes `"space"`, `"enter"`, or `"space_or_enter"` (the default, preserving today's
behavior). The fork and the app will use `"space"`.

## Scope

Three units of work, in order. Each is independently verifiable.

1. **Library** — merge `feat/keyboard-drag-trigger` into `planafoot`, then remove the
   `onActivate` delta.
2. **App** — swap the zone option, move the Enter handler into `Lane.svelte`, fix the stale
   aria string.
3. **Pin** — re-point the app at the new `planafoot` head.

---

## 1. Library: `planafoot` branch

### 1a. Merge

`feat/keyboard-drag-trigger` is `master` (`a0bb6ce`) plus one commit. `planafoot` is the same
`master` plus the fork's board-a11y layer. Only three files can collide:

| File | Collision |
| --- | --- |
| `src/action.js` | both add a key to the `validateOptions` destructure |
| `src/keyboardAction.js` | both touch the `case "Enter": case " "` block, the `config` defaults, and the update function |
| `typings/index.d.ts` | both add an `Options` member |

`src/constants.js`, `src/wrappers/withDragHandles.js`, `README.md`, and the new
`cypress/integration/keyboardDragTrigger.spec.js` arrive clean — the fork does not touch them.

Resolve by taking **both** sides in each case. In `handleKeyDown`, the incoming trigger guard
goes at the very top of the `case`, ahead of the fork's existing nested-element guard, matching
the order in `88608c9`:

```js
case "Enter":
case " ": {
    // keys outside the configured trigger belong to the consumer - don't claim them in any way
    if (!KEYBOARD_DRAG_TRIGGER_KEYS[config.keyboardDragTrigger].includes(e.key)) {
        return;
    }
    // ... fork's existing body
}
```

Hunk-for-hunk fidelity to `88608c9` matters. When #702 merges upstream, the next `master` →
`planafoot` merge should skip these hunks by patch-id rather than conflict — the same property
`9c66f71` bought for `onActivate`. Any gratuitous reformatting here costs that.

### 1b. Remove `onActivate`

A separate commit, so the merge stays a clean adoption of the upstream-bound shape.

Delete:

- `src/action.js` — `onActivate` from the `validateOptions` destructure (line ~83)
- `src/keyboardAction.js` — the `onActivate: undefined` config default (~371), the
  `config.onActivate = onActivate` assignment and its parameter (~589, ~599), and the split
  activation guard clause in `handleKeyDown` (~428-436)
- `typings/index.d.ts` — the `onActivate?: (itemId: string) => void` member (~77)
- `cypress/integration/keyboardRovingTabindex.spec.js` — the entire `describe("onActivate")`
  block (~245-299)

The three deleted Cypress cases are covered by the incoming `keyboardDragTrigger.spec.js`, with
one exception noted below.

### 1c. One new Cypress case

`keyboardDragTrigger.spec.js` exercises the option against the stock zone. The fork ships the
roving-tabindex layer on top, and that layer is what actually reaches the app. Add one case
proving Enter survives it untouched:

- create a zone via the fork's `createZone` helper with `keyboardDragTrigger: "space"`
- attach a `keydown` listener to the zone
- press Enter on a focused card
- assert: no `consider` fired, the listener received the event, and
  `event.defaultPrevented === false`

The `defaultPrevented` assertion is the point. It is the difference between the two designs, and
without it a future refactor could reintroduce a `preventDefault()` and no test would notice.

### 1d. Roadmap

`docs/upstreaming-roadmap.md` "In flight" currently describes item 1 as `onActivate` / PR #701.
Rewrite it for `keyboardDragTrigger` / PR #702, recording that #701 was closed in favour of it
and why (the two reasons under **Why** above). Update the `Last updated:` line and the
`planafoot` sha. The "Queued" items are unaffected — nothing in 2–5 depended on `onActivate`.

### Verification

- `npx eslint src` clean
- full Cypress suite green (97 cases before this change, plus the incoming
  `keyboardDragTrigger.spec.js`, minus the three removed `onActivate` cases, plus 1c)
- `git diff master...planafoot -- src/` no longer mentions `onActivate`

---

## 2. App: `planafoot`

### 2a. The zone option

`src/lib/client/lanes/Lane.svelte:230-241` — drop `onActivate` from the `use:dndzone` options
object, add `keyboardDragTrigger: 'space'`.

The `onActivate` **prop chain stays exactly as it is**: `Lane.svelte:73,94` ←
`LaneGrid.svelte:30,48,93` / `LaneSwiper.svelte:25,52,136` ← `quests/[questId]/+page.svelte:451`
and `support/+page.svelte:215,223`. It stops being a library option and becomes what it always
resembled — an ordinary app callback. Nothing above `Lane.svelte` changes.

The other two zones are untouched. `LaneCollapsedRail.svelte:64-73` is `dragDisabled: true` with
`zoneTabIndex: -1` and is not keyboard-reachable. `LaneSettingsPanel.svelte:243-249` has its own
unrelated arrow-key workaround (`:155-163`) and no Enter behavior.

### 2b. The Enter handler

On the card wrapper — the `role="listitem"` div at `Lane.svelte:250`, which is the element the
library makes the tab stop:

```svelte
onkeydown={(e) => {
  if (e.key !== 'Enter') return;
  if (e.target !== e.currentTarget) return;
  if (e.defaultPrevented) return;
  if (dndCoordinator.dragging) return;
  onActivate?.(item.id);
}}
```

Each guard replaces something the library was doing:

- **`e.target !== e.currentTarget`** replaces upstream's
  `e.target.disabled !== undefined || e.target.href || e.target.isContentEditable` check.
  `LaneCard` contains its own buttons and a `role="button"` title; without this, Enter on a
  nested control bubbles to the card and opens the editor as well. The identity check is
  stricter than upstream's and simpler to reason about: only Enter on the card *itself* counts.
- **`e.defaultPrevented`** yields to any inner handler that already consumed the key.
- **`dndCoordinator.dragging`** replaces the library's `!isDragging` gate. This is the one real
  behavioral difference between the two designs: `onActivate` only fired when not dragging,
  whereas `keyboardDragTrigger: 'space'` makes the library ignore Enter *unconditionally*,
  including mid-grab. Without this guard, Enter while holding a card would open the editor.

`dndCoordinator.dragging` (`dnd-coordinator.svelte.ts:42-50`, set at `:102`, cleared at
`:125`/`:140`) is a reactive boolean covering **any** drag, pointer or keyboard, with no
grabbed-item id. That is deliberately enough:

- during a keyboard grab it is true, which is the case we must suppress
- during a pointer drag the user is not pressing Enter on a focused card
- it cannot distinguish "card A is grabbed, Enter pressed on card B", but during a grab focus is
  on the grabbed card, so that is unreachable — and suppressing is the safe direction

Adding a `grabbedId` field to the coordinator for precision is **out of scope**. It is new
reactive state serving a case that cannot occur.

### 2c. The stale aria string

`messages/en.json:418` — `primitive_dnd_instruction_active` reads:

> "Tab to a card and press space or enter to pick it up"

Change to:

> "Tab to a card and press space to pick it up"

**This is a pre-existing defect, not one this change introduces.** The app has been yielding
Enter to `onActivate` for some time while this string kept telling screen-reader users that
Enter picks up a card. It is fixed here because it is the same seam, but it should not be read
as fallout from the migration.

`en.json` is the only locale file; there is no second translation to update.
`aria-strings.ts:29` maps the key and needs no change.

`docs/manual/shortcuts.svx:35-51` already documents Space-to-pick-up and
"Press **Enter** on a focused card to open it" correctly. No change.

### 2d. Tests

Existing coverage survives, because both tests assert behavior rather than mechanism and the
`onActivate` prop chain is intact:

- `e2e/keyboard-dnd.spec.ts:323-348` — "board: Enter opens the editor without grabbing" passes
  unchanged. Its comment naming "the fork's `onActivate` seam" needs a reword.
- `LaneSwiper.svelte.test.ts:287-303` — dispatches a real Enter keydown and expects `onActivate`
  to fire; the app-level handler satisfies it.

Add one case for the guard the library used to provide: **Enter while a card is grabbed must not
open the editor.** Place it in `e2e/keyboard-dnd.spec.ts` next to the existing Enter test — Space
to grab, Enter, assert the editor does not appear and the grab is still live.

### Verification

- `npm run lint` and `npm run check` clean
- `LaneSwiper.svelte.test.ts` and `keyboard-grab.svelte.test.ts` green
- `e2e/keyboard-dnd.spec.ts` and `e2e/board-a11y.spec.ts` green
- manual: Tab to a card, Enter opens the editor; Space grabs, Enter does nothing, Space drops

---

## 3. The pin

`package.json:190` currently reads
`"svelte-dnd-action": "git+https://github.com/mindlace/svelte-dnd-action.git#planafoot"`, with
`package-lock.json:11673-11679` resolving it to `7855c822`.

Re-pin to the new `planafoot` head and regenerate the lock entry.

> **This bump is wider than this feature.** `7855c822` predates the v0.9.77 upstream merge
> (`04d1387`), the `setAriaStrings` semantics change that came with it, and the `onActivate`
> collapse (`9c66f71`). Adopting `keyboardDragTrigger` therefore also adopts all of that. The
> aria change is documented as a no-op for this app — it installs a complete string table once
> from `+layout.svelte:69` — but if something regresses after the bump, the suspect list is the
> whole `7855c822..HEAD` range, not just this change.

Sequencing: land the library work and push `planafoot` before touching the app, so the lock file
resolves to a commit that exists on the remote.

## Out of scope

- A `grabbedId` signal on the coordinator (2b)
- Any change to `LaneCollapsedRail.svelte` or `LaneSettingsPanel.svelte`
- Roadmap items 2–5 — unaffected by this change
- Splitting the pin bump into intermediate steps to isolate the v0.9.77 merge
