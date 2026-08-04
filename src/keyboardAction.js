import {
    decrementActiveDropZoneCount,
    incrementActiveDropZoneCount,
    DEFAULT_KEYBOARD_DRAG_TRIGGER,
    ITEM_ID_KEY,
    KEYBOARD_DRAG_TRIGGER_KEYS,
    SOURCES,
    TRIGGERS
} from "./constants";
import {styleActiveDropZones, styleInactiveDropZones} from "./helpers/styler";
import {dispatchConsiderEvent, dispatchFinalizeEvent} from "./helpers/dispatcher";
import {initAria, announceToScreenReader, destroyAria} from "./helpers/aria";
import {toString} from "./helpers/util";
import {printDebug} from "./constants";

const DEFAULT_DROP_ZONE_TYPE = "--any--";
const DEFAULT_DROP_TARGET_STYLE = {
    outline: "rgba(255, 255, 102, 0.7) solid 2px"
};

let isDragging = false;
// Tentative-until-drop: set by any mid-grab arrow/Tab step (including Escape's restore
// relocate), cleared at the drop. It tells handleDrop whether the grab moved at all — a grab
// that never moved writes nothing. Escape's own zero-write behavior comes from handleDrop's
// `commit: false`, not from this flag: `pendingMove` is still true after a restore.
let pendingMove = false;
let draggedItemType;
let focusedDz;
let focusedDzLabel = "";
let focusedItem;
let focusedItemId;
let focusedItemLabel = "";
// At-rest (not-dragging) board-wide active card pointer. Drives the roving
// tabindex: exactly one card per board (the zones sharing a type) gets its zone's
// configured zoneItemTabIndex (default 0), the rest -1. Re-asserted on every
// configure() so the library — not a consumer $effect — owns the tabindex and
// there's no thrash.
let activeItemEl = null;
// Captured on grab so Escape can restore the card to where it was picked up.
let grabOrigin = null;
const allDragTargets = new WeakSet();
const elToKeyDownListeners = new WeakMap();
const elToFocusListeners = new WeakMap();
const dzToHandles = new Map();
const dzToConfig = new Map();
const typeToDropZones = new Map();

/* TODO (potentially)
 * what's the deal with the black border of voice-reader not following focus?
 * maybe keep focus on the last dragged item upon drop?
 */

let INSTRUCTION_IDs;

/* drop-zones registration management */
function registerDropZone(dropZoneEl, type) {
    printDebug(() => "registering drop-zone if absent");
    if (typeToDropZones.size === 0) {
        printDebug(() => "adding global keydown and click handlers");
        INSTRUCTION_IDs = initAria();
        window.addEventListener("keydown", globalKeyDownHandler);
        window.addEventListener("click", globalClickHandler);
    }
    if (!typeToDropZones.has(type)) {
        typeToDropZones.set(type, new Set());
    }
    if (!typeToDropZones.get(type).has(dropZoneEl)) {
        typeToDropZones.get(type).add(dropZoneEl);
        incrementActiveDropZoneCount();
    }
}
function unregisterDropZone(dropZoneEl, type) {
    printDebug(() => "unregistering drop-zone");
    if (isDragging && focusedDz === dropZoneEl) {
        handleDrop();
    }
    const dropZones = typeToDropZones.get(type);
    if (!dropZones || !dropZones.delete(dropZoneEl)) return;
    decrementActiveDropZoneCount();
    if (dropZones.size === 0) {
        typeToDropZones.delete(type);
    }
    if (typeToDropZones.size === 0) {
        printDebug(() => "removing global keydown and click handlers");
        window.removeEventListener("keydown", globalKeyDownHandler);
        window.removeEventListener("click", globalClickHandler);
        INSTRUCTION_IDs = undefined;
        destroyAria();
    }
}

function globalKeyDownHandler(e) {
    if (!isDragging) return;
    switch (e.key) {
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
            // The card is in no zone at all: there is no move left to restore. The silence
            // that follows is deliberate, not an oversight — with no move left to cancel,
            // no announcement is made. End the grab the way a cancel does — `commit: false`,
            // no string.
            if (!grabIsLive()) {
                handleDrop(true, true, false);
                break;
            }
            const autoAriaDisabled = dzToConfig.get(focusedDz).autoAriaDisabled;
            if (grabOrigin && focusedDz !== grabOrigin.dz) {
                relocateToZone(grabOrigin.dz, grabOrigin.index);
            }
            announce("cancelled", autoAriaDisabled, {
                index: grabOrigin ? grabOrigin.index : 0,
                count: focusedDz ? dzToConfig.get(focusedDz).items.length : 0,
                zoneLabel: focusedDz ? focusedDz.getAttribute("aria-label") || "" : ""
            });
            // The restore above moved the card home via tentative considers — there is nothing
            // to commit, and nothing to compensate for. `commit: false` (#535).
            handleDrop(true, true, false);
            break;
        }
    }
}

function globalClickHandler() {
    if (!isDragging) return;
    if (!allDragTargets.has(document.activeElement)) {
        printDebug(() => "clicked outside of any draggable");
        handleDrop();
    }
}

function getActiveDragTabIndex(dropZoneEl, config) {
    return dropZoneEl === focusedDz || focusedItem.contains(dropZoneEl) || config.dropFromOthersDisabled || config.type !== draggedItemType ? -1 : 0;
}

function refreshActiveDragTabIndices() {
    dzToConfig.forEach((config, dropZoneEl) => {
        dropZoneEl.tabIndex = getActiveDragTabIndex(dropZoneEl, config);
    });
}

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

/* ─── at-rest keyboard navigation + roving tabindex (board a11y) ─── */

// The zones of a given type, ordered left-to-right then top-to-bottom by their
// on-screen rect — this is the lane order the arrow keys navigate.
function orderedZonesOfType(type) {
    const set = typeToDropZones.get(type);
    if (!set) return [];
    return Array.from(set).sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.left - rb.left || ra.top - rb.top;
    });
}

// The zone of `type` whose items currently include `itemId` (or null). Used to
// re-sync the stale focusedDz pointer after an intervening re-render.
function zoneHoldingItem(type, itemId) {
    for (const dz of orderedZonesOfType(type)) {
        const cfg = dzToConfig.get(dz);
        if (cfg && cfg.items.some(item => item[ITEM_ID_KEY] === itemId)) return dz;
    }
    return null;
}

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

// Move at-rest focus to `el`, make it the board's single tab stop, and focus it.
function focusCard(type, el) {
    if (!el) return;
    activeItemEl = el;
    setRovingTabindex(type, el);
    el.focus();
}

// Announcement seam (board a11y). Every grab-lifecycle announcement goes through the
// aria string table, so a consumer that wants different copy — a translation, or wording
// tuned to a board rather than a list — installs it once with `setAriaStrings` instead of
// re-implementing the announcements. `autoAriaDisabled` stays the coarse off-switch.
// `index` is 0-based internally; the string table speaks in 1-based `position`.
function announce(key, autoAriaDisabled, ctx) {
    if (autoAriaDisabled) return;
    const {index, zoneLabel, ...rest} = ctx || {};
    announceToScreenReader(key, {
        itemLabel: focusedItemLabel,
        zoneLabel: zoneLabel !== undefined ? zoneLabel : focusedDzLabel,
        position: (index !== undefined ? index : 0) + 1,
        // No `count` stand-in: every callsite passes one and the string table's types promise
        // it, so a default here would only let a callsite that forgot announce "3 of 0" —
        // plausible and wrong — instead of an obviously-broken "3 of undefined".
        // key-specific extras (ex: dragStarted's canMoveBetweenZones) pass straight through
        ...rest
    });
}

// Splice the grabbed item out of its origin zone and insert it into `targetDz` at
// `atIndex`, then dispatch the dual consider (origin DRAGGED_LEFT + target
// DRAGGED_ENTERED). Shared by the focus-driven (Tab) and arrow-driven cross-lane
// moves. Returns the announcement context for the caller to emit.
function relocateToZone(targetDz, atIndex) {
    focusedDzLabel = targetDz.getAttribute("aria-label") || "";
    const {items: originItems} = dzToConfig.get(focusedDz);
    const originIdx = originItems.findIndex(item => item[ITEM_ID_KEY] === focusedItemId);
    const itemToMove = originItems.splice(originIdx, 1)[0];
    const {items: targetItems} = dzToConfig.get(targetDz);
    const clampedIdx = Math.max(0, Math.min(atIndex, targetItems.length));
    targetItems.splice(clampedIdx, 0, itemToMove);
    const dzFrom = focusedDz;
    // Capture the moved id and re-point focusedDz (and pendingMove) BEFORE dispatching: a
    // synchronous consumer handler may destroy either zone, and no dispatch — nor a teardown
    // re-entering handleDrop — may observe half-updated state.
    const movedItemId = focusedItemId;
    pendingMove = true;
    focusedDz = targetDz;
    // TENTATIVE-UNTIL-DROP (#535): while the grab is live, a step is a *consider*, not a
    // finalize. The consumer moves the card in its working copy and commits nothing; the
    // single finalize is dispatched by handleDrop.
    dispatchConsiderEvent(dzFrom, originItems, {trigger: TRIGGERS.DRAGGED_LEFT, id: movedItemId, source: SOURCES.KEYBOARD});
    // The origin's consider may have torn the target zone down; don't dispatch into a dead zone.
    if (dzToConfig.has(targetDz)) {
        dispatchConsiderEvent(targetDz, targetItems, {trigger: TRIGGERS.DRAGGED_ENTERED, id: movedItemId, source: SOURCES.KEYBOARD});
    }
    return {index: clampedIdx, count: targetItems.length, zoneLabel: focusedDzLabel};
}

function handleZoneFocus(e) {
    printDebug(() => "zone focus");
    if (!isDragging) return;
    const newlyFocusedDz = e.currentTarget;
    if (newlyFocusedDz === focusedDz) return;

    // Upstream's liveness guard (#694): if a consumer re-render dropped the grabbed item
    // out of its origin zone, drop rather than relocate a phantom. Deliberately no
    // zoneHoldingItem() re-sync here (unlike Escape and relocateToAdjacentLane below) —
    // this is upstream's path and keeps upstream's policy as-is, so a Tab-to-zone may end
    // a grab that Escape or an arrow key would have repaired.
    if (!grabIsAlive()) return;

    const toEnd =
        newlyFocusedDz.getBoundingClientRect().top < focusedDz.getBoundingClientRect().top ||
        newlyFocusedDz.getBoundingClientRect().left < focusedDz.getBoundingClientRect().left;
    const {items: targetItems, autoAriaDisabled} = dzToConfig.get(newlyFocusedDz);
    const atIndex = toEnd ? targetItems.length : 0;
    const ctx = relocateToZone(newlyFocusedDz, atIndex);
    announce(toEnd ? "movedToZoneEnd" : "movedToZoneStart", autoAriaDisabled, ctx);
}

function triggerAllDzsUpdate() {
    dzToHandles.forEach(({update}, dz) => update(dzToConfig.get(dz)));
}

function handleDrop(dispatchConsider = true, suppressAnnounce = false, commit = true) {
    if (!isDragging || !focusedDz) return;
    printDebug(() => "drop");
    const droppedDz = focusedDz;
    const droppedConfig = dzToConfig.get(droppedDz);
    const droppedItemId = focusedItemId;
    const droppedItemType = draggedItemType;
    const droppedOrigin = grabOrigin;
    const shouldCommit = commit && pendingMove;
    if (!droppedConfig) return;

    if (!suppressAnnounce) {
        const items = droppedConfig.items;
        const idx = items.findIndex(item => item[ITEM_ID_KEY] === droppedItemId);
        announce("dropped", droppedConfig.autoAriaDisabled, {
            index: idx < 0 ? 0 : idx,
            count: items.length,
            zoneLabel: droppedDz.getAttribute("aria-label") || ""
        });
    }
    if (allDragTargets.has(document.activeElement)) {
        document.activeElement.blur();
    }
    // Clear global drag state before dispatching ANY event. A synchronous handler may destroy
    // the focused zone, and unregisterDropZone must not recursively enter handleDrop — hence
    // the captured `dropped*` locals below.
    focusedItem = null;
    focusedItemId = null;
    focusedItemLabel = "";
    draggedItemType = null;
    focusedDz = null;
    focusedDzLabel = "";
    isDragging = false;
    grabOrigin = null;
    pendingMove = false;

    // TENTATIVE-UNTIL-DROP (#535): the grab's steps only dispatched considers, so THIS is the
    // one and only commit. Two events when the card changed zones — the origin zone settles
    // first (DROPPED_INTO_ANOTHER, no move payload), then the destination (DROPPED_INTO_ZONE,
    // which is the one carrying the move). That order is the one consumers already rely on.
    // What this fork guarantees: no finalize at all when `commit` is false (Escape), and none
    // when the grab never stepped (`pendingMove` still false). It does NOT guarantee a
    // net-zero grab is write-free: a ROUND-TRIP (e.g. ArrowRight then ArrowLeft home) sets
    // `pendingMove` and DOES finalize. Suppressing that no-op write is the consumer's job —
    // it can compare the finalized order against its own source.
    if (shouldCommit && dzToConfig.has(droppedDz)) {
        const originDz = droppedOrigin && droppedOrigin.dz !== droppedDz ? droppedOrigin.dz : null;
        if (originDz && dzToConfig.has(originDz)) {
            dispatchFinalizeEvent(originDz, dzToConfig.get(originDz).items, {
                trigger: TRIGGERS.DROPPED_INTO_ANOTHER,
                id: droppedItemId,
                source: SOURCES.KEYBOARD
            });
        }
        // The origin's finalize may have torn the destination down; don't dispatch into a dead zone.
        if (dzToConfig.has(droppedDz)) {
            dispatchFinalizeEvent(droppedDz, dzToConfig.get(droppedDz).items, {
                trigger: TRIGGERS.DROPPED_INTO_ZONE,
                id: droppedItemId,
                source: SOURCES.KEYBOARD
            });
        }
    }

    if (dispatchConsider) {
        dispatchConsiderEvent(droppedDz, droppedConfig.items, {
            trigger: TRIGGERS.DRAG_STOPPED,
            id: droppedItemId,
            source: SOURCES.KEYBOARD
        });
    }
    const dropZones = typeToDropZones.get(droppedItemType);
    if (dropZones) {
        styleInactiveDropZones(
            dropZones,
            dz => dzToConfig.get(dz).dropTargetStyle,
            dz => dzToConfig.get(dz).dropTargetClasses
        );
    }
    triggerAllDzsUpdate();
}
//////
export function dndzone(node, options) {
    let destroyed = false;
    const config = {
        items: undefined,
        type: undefined,
        dragDisabled: false,
        zoneTabIndex: 0,
        zoneItemTabIndex: 0,
        dropFromOthersDisabled: false,
        dropTargetStyle: DEFAULT_DROP_TARGET_STYLE,
        dropTargetClasses: [],
        autoAriaDisabled: false,
        keyboardDragTrigger: DEFAULT_KEYBOARD_DRAG_TRIGGER
    };

    function swap(arr, i, j) {
        if (arr.length <= 1) return;
        arr.splice(j, 1, arr.splice(i, 1, arr[j])[0]);
    }

    // At-rest: move focus to the adjacent lane (left/right) at the same row index,
    // clamped to that lane's card count. Returns true if it navigated.
    function navigateToAdjacentLane(currentCard, dir) {
        const zones = orderedZonesOfType(config.type);
        const myZoneIdx = zones.indexOf(node);
        const targetZone = zones[myZoneIdx + dir];
        if (!targetZone || targetZone.children.length === 0) return false;
        const row = Array.from(node.children).indexOf(currentCard);
        const targetRow = Math.max(0, Math.min(row, targetZone.children.length - 1));
        focusCard(config.type, targetZone.children[targetRow]);
        return true;
    }

    // Grab-mode: relocate the grabbed card to the adjacent lane (left/right) at the
    // same row index, then re-focus it and announce the move.
    function relocateToAdjacentLane(dir) {
        const zones = orderedZonesOfType(config.type);
        // Re-sync to the zone that actually holds the grabbed item (an intervening
        // committed move + re-render can leave focusedDz stale).
        const liveDz = zoneHoldingItem(config.type, focusedItemId);
        if (liveDz) focusedDz = liveDz;
        // Re-sync repairs a stale pointer; this catches the case it cannot — the card is
        // in no zone at all. Upstream's policy for that is to end the grab (#694), via
        // grabIsAlive's default handleDrop(commit: true) — the same policy handleZoneFocus
        // uses above, so an arrow relocate onto a vanished card commits its pending step
        // just like a Tab does. Escape is the one deliberate exception: a cancel must not
        // commit, so it branches on the bare grabIsLive() instead and calls
        // handleDrop(true, true, false).
        if (!grabIsAlive()) return;
        const myZoneIdx = zones.indexOf(focusedDz);
        const targetZone = zones[myZoneIdx + dir];
        if (!targetZone || dzToConfig.get(targetZone).dropFromOthersDisabled) return;
        const fromItems = dzToConfig.get(focusedDz).items;
        const row = fromItems.findIndex(item => item[ITEM_ID_KEY] === focusedItemId);
        const ctx = relocateToZone(targetZone, row);
        announce("movedToZone", config.autoAriaDisabled, ctx);
    }

    function handleKeyDown(e) {
        printDebug(() => ["handling key down", e.key]);
        switch (e.key) {
            case "Enter":
            case " ": {
                // keys outside the configured trigger belong to the consumer - don't claim them in any way
                if (!KEYBOARD_DRAG_TRIGGER_KEYS[config.keyboardDragTrigger].includes(e.key)) {
                    return;
                }
                // we don't want to affect nested input elements or clickable elements
                if ((e.target.disabled !== undefined || e.target.href || e.target.isContentEditable) && !allDragTargets.has(e.target)) {
                    return;
                }
                e.preventDefault(); // preventing scrolling on spacebar
                e.stopPropagation();
                if (isDragging) {
                    handleDrop();
                } else {
                    handleDragStart(e);
                }
                break;
            }
            case "ArrowDown": {
                e.preventDefault(); // prevent scrolling
                e.stopPropagation();
                if (!isDragging) {
                    // at-rest: focus the next card in this lane (clamp at end)
                    const children = Array.from(node.children);
                    const idx = children.indexOf(e.currentTarget);
                    if (idx < children.length - 1) focusCard(config.type, children[idx + 1]);
                    break;
                }
                arrowReorder(1);
                break;
            }
            case "ArrowUp": {
                e.preventDefault();
                e.stopPropagation();
                if (!isDragging) {
                    const children = Array.from(node.children);
                    const idx = children.indexOf(e.currentTarget);
                    if (idx > 0) focusCard(config.type, children[idx - 1]);
                    break;
                }
                arrowReorder(-1);
                break;
            }
            case "ArrowRight": {
                e.preventDefault();
                e.stopPropagation();
                if (!isDragging) {
                    navigateToAdjacentLane(e.currentTarget, 1);
                    break;
                }
                relocateToAdjacentLane(1);
                break;
            }
            case "ArrowLeft": {
                e.preventDefault();
                e.stopPropagation();
                if (!isDragging) {
                    navigateToAdjacentLane(e.currentTarget, -1);
                    break;
                }
                relocateToAdjacentLane(-1);
                break;
            }
            case "Home": {
                if (isDragging) return;
                e.preventDefault();
                e.stopPropagation();
                if (node.children.length > 0) focusCard(config.type, node.children[0]);
                break;
            }
            case "End": {
                if (isDragging) return;
                e.preventDefault();
                e.stopPropagation();
                if (node.children.length > 0) focusCard(config.type, node.children[node.children.length - 1]);
                break;
            }
        }
    }

    // Grab-mode within-lane reorder by one slot (dir: -1 up, +1 down). Swaps in place and
    // reports the step as a tentative consider; the drop is what commits.
    function arrowReorder(dir) {
        const {items} = dzToConfig.get(focusedDz);
        // Derive the current index from `items`, NOT from the DOM position of focusedItem.
        // Upstream reads the DOM here, which is sound for upstream because every arrow step
        // finalizes: the consumer must honour it, so the DOM is re-rendered before the next
        // keypress. Our steps are tentative considers (#535), and a consumer is entitled to
        // ignore them and render only on the drop — so mid-grab the DOM can be one or more
        // steps behind while `items` (which we swap in place, and which configure() replaces
        // wholesale on write-back) is correct either way. Reading the DOM here made a second
        // arrow press in the same direction swap the card straight back to where it came from.
        const curIdx = items.findIndex(item => item[ITEM_ID_KEY] === focusedItemId);
        const nextIdx = curIdx + dir;
        if (curIdx < 0 || nextIdx < 0 || nextIdx > items.length - 1) return;
        announce("movedToPosition", config.autoAriaDisabled, {index: nextIdx, count: items.length, zoneLabel: focusedDzLabel});
        swap(items, curIdx, nextIdx);
        // TENTATIVE-UNTIL-DROP (#535): a within-lane step is a consider too. Making only the
        // cross-lane steps tentative would not work — a within-lane finalize carries the
        // destination zone's items and the grabbed card's id, so it would commit the pending
        // cross-lane position mid-gesture, which is exactly what #535 is about.
        dispatchConsiderEvent(focusedDz, items, {
            trigger: TRIGGERS.DRAGGED_OVER_INDEX,
            id: focusedItemId,
            source: SOURCES.KEYBOARD
        });
        pendingMove = true;
    }
    function handleDragStart(e) {
        printDebug(() => "drag start");
        setCurrentFocusedItem(e.currentTarget);
        focusedDz = node;
        focusedDzLabel = node.getAttribute("aria-label") || "";
        draggedItemType = config.type;
        isDragging = true;
        pendingMove = false;
        const {items: startItems} = dzToConfig.get(node);
        const startIdx = startItems.findIndex(item => item[ITEM_ID_KEY] === focusedItemId);
        // Capture grab origin so Escape can restore the card to where it was lifted.
        grabOrigin = {dz: node, index: startIdx < 0 ? 0 : startIdx, itemId: focusedItemId};
        const dropTargets = Array.from(typeToDropZones.get(config.type)).filter(dz => dz === focusedDz || !dzToConfig.get(dz).dropFromOthersDisabled);
        styleActiveDropZones(
            dropTargets,
            dz => dzToConfig.get(dz).dropTargetStyle,
            dz => dzToConfig.get(dz).dropTargetClasses
        );
        announce("dragStarted", config.autoAriaDisabled, {
            index: grabOrigin.index,
            count: startItems.length,
            zoneLabel: focusedDzLabel,
            canMoveBetweenZones: dropTargets.length > 1
        });
        dispatchConsiderEvent(node, dzToConfig.get(node).items, {trigger: TRIGGERS.DRAG_STARTED, id: focusedItemId, source: SOURCES.KEYBOARD});
        triggerAllDzsUpdate();
    }

    function handleClick(e) {
        if (!isDragging) return;
        if (e.currentTarget === focusedItem) return;
        e.stopPropagation();
        handleDrop(false);
        handleDragStart(e);
    }
    function setCurrentFocusedItem(draggableEl) {
        const {items} = dzToConfig.get(node);
        const children = Array.from(node.children);
        const focusedItemIdx = children.indexOf(draggableEl);
        focusedItem = draggableEl;
        focusedItem.tabIndex = config.zoneItemTabIndex;
        focusedItemId = items[focusedItemIdx][ITEM_ID_KEY];
        focusedItemLabel = children[focusedItemIdx].getAttribute("aria-label") || "";
    }

    function configure({
        items = [],
        type: newType = DEFAULT_DROP_ZONE_TYPE,
        dragDisabled = false,
        zoneTabIndex = 0,
        zoneItemTabIndex = 0,
        dropFromOthersDisabled = false,
        dropTargetStyle = DEFAULT_DROP_TARGET_STYLE,
        dropTargetClasses = [],
        autoAriaDisabled = false,
        keyboardDragTrigger = DEFAULT_KEYBOARD_DRAG_TRIGGER
    }) {
        config.items = [...items];
        config.dragDisabled = dragDisabled;
        config.dropFromOthersDisabled = dropFromOthersDisabled;
        config.zoneTabIndex = zoneTabIndex;
        config.zoneItemTabIndex = zoneItemTabIndex;
        config.dropTargetStyle = dropTargetStyle;
        config.dropTargetClasses = dropTargetClasses;
        config.autoAriaDisabled = autoAriaDisabled;
        config.keyboardDragTrigger = keyboardDragTrigger;
        if (config.type && newType !== config.type) {
            unregisterDropZone(node, config.type);
        }
        config.type = newType;
        registerDropZone(node, newType);
        if (!autoAriaDisabled) {
            node.setAttribute("role", "list");
            node.setAttribute("aria-describedby", dragDisabled ? INSTRUCTION_IDs.DND_ZONE_DRAG_DISABLED : INSTRUCTION_IDs.DND_ZONE_ACTIVE);
        }
        dzToConfig.set(node, config);

        let itemMovedToThisZone = false;
        if (isDragging) {
            itemMovedToThisZone =
                config.type === draggedItemType && config.items.some(item => item[ITEM_ID_KEY] === focusedItemId) && node !== focusedDz;
            if (itemMovedToThisZone) {
                focusedDz = node;
                focusedDzLabel = node.getAttribute("aria-label") || "";
            }
            node.tabIndex = getActiveDragTabIndex(node, config);
        } else {
            node.tabIndex = config.zoneTabIndex;
        }

        node.addEventListener("focus", handleZoneFocus);

        for (let i = 0; i < node.children.length; i++) {
            const draggableEl = node.children[i];
            allDragTargets.add(draggableEl);
            // Roving tabindex: default every card to -1 here; the board's single active
            // tab stop (its zone's configured zoneItemTabIndex, default 0) is asserted by
            // setRovingTabindex below (at rest) or set on the grabbed card (while dragging).
            // This yields exactly one tab stop per board and is re-asserted on every
            // configure(), so no consumer $effect needs to fight tabindex thrash.
            draggableEl.tabIndex = -1;
            if (!autoAriaDisabled) {
                draggableEl.setAttribute("role", "listitem");
            }
            draggableEl.removeEventListener("keydown", elToKeyDownListeners.get(draggableEl));
            draggableEl.removeEventListener("click", elToFocusListeners.get(draggableEl));
            if (!dragDisabled) {
                draggableEl.addEventListener("keydown", handleKeyDown);
                elToKeyDownListeners.set(draggableEl, handleKeyDown);
                draggableEl.addEventListener("click", handleClick);
                elToFocusListeners.set(draggableEl, handleClick);
            }
            if (isDragging && config.type === draggedItemType && config.items[i]?.[ITEM_ID_KEY] === focusedItemId) {
                printDebug(() => ["focusing on", {i, focusedItemId}]);
                // if it is a nested dropzone, it was re-rendered and we need to refresh our pointer
                focusedItem = draggableEl;
                focusedItem.tabIndex = config.zoneItemTabIndex;
                activeItemEl = draggableEl;
                // without this the element loses focus if it moves backwards in the list
                draggableEl.focus();
            }
        }
        if (itemMovedToThisZone) {
            // Nested actions are configured before their parent action. Refresh only
            // after focusedItem points at the replacement so nested zones stay untabbable.
            refreshActiveDragTabIndices();
        }

        if (!isDragging) {
            // Re-assert the board's single tab stop. If the tracked active card is
            // still in the DOM (within a zone of this type), keep it; otherwise fall
            // back to the first card of the first zone in rect order.
            const zones = orderedZonesOfType(config.type);
            const activeStillPresent = activeItemEl && zones.some(dz => dz.contains(activeItemEl));
            let active = activeStillPresent ? activeItemEl : null;
            if (!active) {
                const firstZoneWithCards = zones.find(dz => dz.children.length > 0);
                active = firstZoneWithCards ? firstZoneWithCards.children[0] : null;
            }
            activeItemEl = active;
            if (active) setRovingTabindex(config.type, active);
        }
    }
    configure(options);

    const handles = {
        update: newOptions => {
            printDebug(() => `keyboard dndzone will update newOptions: ${toString(newOptions)}`);
            configure(newOptions);
        },
        destroy: () => {
            if (destroyed) return;
            destroyed = true;
            printDebug(() => "keyboard dndzone will destroy");
            node.removeEventListener("focus", handleZoneFocus);
            for (const draggableEl of node.children) {
                draggableEl.removeEventListener("keydown", elToKeyDownListeners.get(draggableEl));
                draggableEl.removeEventListener("click", elToFocusListeners.get(draggableEl));
            }
            unregisterDropZone(node, config.type);
            dzToConfig.delete(node);
            dzToHandles.delete(node);
        }
    };
    dzToHandles.set(node, handles);
    return handles;
}
