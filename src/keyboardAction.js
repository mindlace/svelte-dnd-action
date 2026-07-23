import {decrementActiveDropZoneCount, incrementActiveDropZoneCount, ITEM_ID_KEY, SOURCES, TRIGGERS} from "./constants";
import {styleActiveDropZones, styleInactiveDropZones} from "./helpers/styler";
import {dispatchConsiderEvent, dispatchFinalizeEvent} from "./helpers/dispatcher";
import {initAria, alertToScreenReader, destroyAria} from "./helpers/aria";
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
// tabindex: exactly one card per board (the zones sharing a type) is tabIndex 0,
// the rest -1. Re-asserted on every configure() so the library — not a consumer
// $effect — owns the tabindex and there's no thrash.
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
    if (focusedDz === dropZoneEl) {
        handleDrop();
    }
    typeToDropZones.get(type).delete(dropZoneEl);
    decrementActiveDropZoneCount();
    if (typeToDropZones.get(type).size === 0) {
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
            const autoAriaDisabled = dzToConfig.get(focusedDz).autoAriaDisabled;
            if (grabOrigin && focusedDz !== grabOrigin.dz) {
                relocateToZone(grabOrigin.dz, grabOrigin.index);
            }
            announce("cancel", autoAriaDisabled, () => `Stopped dragging item ${focusedItemLabel}`, {
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

// One tab stop per board: activeEl gets tabIndex 0, every other card across the
// type's zones gets -1.
function setRovingTabindex(type, activeEl) {
    for (const dz of orderedZonesOfType(type)) {
        for (const child of dz.children) {
            child.tabIndex = child === activeEl ? 0 : -1;
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

// Announcement seam (board a11y). When the active drag's config supplies an
// `onAnnounce` callback, emit a structured event and SUPPRESS the built-in
// fixed-string `alertToScreenReader` (the app owns the copy). When it's absent,
// fall back to the stock string (additive — non-opted consumers unchanged).
// `autoAriaDisabled` stays the coarse off-switch (no announcement either way).
function announce(type, autoAriaDisabled, buildString, ctx) {
    if (autoAriaDisabled) return;
    const onAnnounce = focusedDz && dzToConfig.get(focusedDz) && dzToConfig.get(focusedDz).onAnnounce;
    if (onAnnounce) {
        onAnnounce({
            type,
            itemId: focusedItemId,
            itemLabel: focusedItemLabel,
            zoneLabel: ctx && ctx.zoneLabel !== undefined ? ctx.zoneLabel : focusedDzLabel,
            index: ctx && ctx.index !== undefined ? ctx.index : 0,
            count: ctx && ctx.count !== undefined ? ctx.count : 0
        });
        return;
    }
    alertToScreenReader(buildString());
}

// Splice the grabbed item out of its origin zone and insert it into `targetDz` at
// `atIndex`, then dispatch the dual consider (origin DRAGGED_LEFT + target
// DRAGGED_ENTERED). Shared by the focus-driven (Tab) and arrow-driven cross-lane
// moves. Returns the announcement context for the caller to emit.
function relocateToZone(targetDz, atIndex) {
    focusedDzLabel = targetDz.getAttribute("aria-label") || "";
    const {items: originItems} = dzToConfig.get(focusedDz);
    const originIdx = originItems.findIndex(item => item[ITEM_ID_KEY] === focusedItemId);
    // Defensive: if the grabbed item is no longer in its origin zone's items (an
    // intervening consumer re-render under load can transiently desync the bound items
    // from focusedDz), DON'T splice — `splice(-1, 1)` would remove the wrong element and
    // insert `undefined` into the target, vanishing the card from both zones. Abort the
    // relocate as a no-op; the next keydown (or the drop) operates on settled state.
    if (originIdx < 0) {
        return {index: 0, count: dzToConfig.get(targetDz).items.length, zoneLabel: focusedDzLabel};
    }
    const itemToMove = originItems.splice(originIdx, 1)[0];
    const {items: targetItems} = dzToConfig.get(targetDz);
    const clampedIdx = Math.max(0, Math.min(atIndex, targetItems.length));
    targetItems.splice(clampedIdx, 0, itemToMove);
    const dzFrom = focusedDz;
    // TENTATIVE-UNTIL-DROP (#535): while the grab is live, a step is a *consider*, not a
    // finalize. The consumer moves the card in its working copy and commits nothing; the
    // single finalize is dispatched by handleDrop. `grabActive` stays on the info object so
    // consumers can tell a keyboard grab's tentative frames from a pointer drag's.
    dispatchConsiderEvent(dzFrom, originItems, {trigger: TRIGGERS.DRAGGED_LEFT, id: focusedItemId, source: SOURCES.KEYBOARD, grabActive: true});
    dispatchConsiderEvent(targetDz, targetItems, {trigger: TRIGGERS.DRAGGED_ENTERED, id: focusedItemId, source: SOURCES.KEYBOARD, grabActive: true});
    pendingMove = true;
    focusedDz = targetDz;
    return {index: clampedIdx, count: targetItems.length, zoneLabel: focusedDzLabel};
}

function handleZoneFocus(e) {
    printDebug(() => "zone focus");
    if (!isDragging) return;
    const newlyFocusedDz = e.currentTarget;
    if (newlyFocusedDz === focusedDz) return;

    const toEnd =
        newlyFocusedDz.getBoundingClientRect().top < focusedDz.getBoundingClientRect().top ||
        newlyFocusedDz.getBoundingClientRect().left < focusedDz.getBoundingClientRect().left;
    const {items: targetItems, autoAriaDisabled} = dzToConfig.get(newlyFocusedDz);
    const atIndex = toEnd ? targetItems.length : 0;
    const ctx = relocateToZone(newlyFocusedDz, atIndex);
    announce("move", autoAriaDisabled, () =>
        toEnd
            ? `Moved item ${focusedItemLabel} to the end of the list ${ctx.zoneLabel}`
            : `Moved item ${focusedItemLabel} to the beginning of the list ${ctx.zoneLabel}`,
        ctx
    );
}

function triggerAllDzsUpdate() {
    dzToHandles.forEach(({update}, dz) => update(dzToConfig.get(dz)));
}

function handleDrop(dispatchConsider = true, suppressAnnounce = false, commit = true) {
    printDebug(() => "drop");
    if (!suppressAnnounce) {
        const autoAriaDisabled = dzToConfig.get(focusedDz).autoAriaDisabled;
        const items = dzToConfig.get(focusedDz).items;
        const idx = items.findIndex(item => item[ITEM_ID_KEY] === focusedItemId);
        announce("drop", autoAriaDisabled, () => `Stopped dragging item ${focusedItemLabel}`, {
            index: idx < 0 ? 0 : idx,
            count: items.length,
            zoneLabel: focusedDz.getAttribute("aria-label") || ""
        });
    }
    // TENTATIVE-UNTIL-DROP (#535): the grab's steps only dispatched considers, so THIS is the
    // one and only commit. Two events when the card changed zones — the origin zone settles
    // first (DROPPED_INTO_ANOTHER, no move payload), then the destination (DROPPED_INTO_ZONE,
    // which is the one carrying the move). That order is the one consumers already rely on.
    // What this fork guarantees: no finalize at all when `commit` is false (Escape), and none
    // when the grab never stepped (`pendingMove` still false). It does NOT guarantee a
    // net-zero grab is write-free: a ROUND-TRIP (e.g. ArrowRight then ArrowLeft home) sets
    // `pendingMove` and DOES finalize. Suppressing that no-op write is the consumer's job —
    // it can compare the finalized order against its own source.
    if (commit && pendingMove && focusedDz && dzToConfig.has(focusedDz)) {
        const originDz = grabOrigin && grabOrigin.dz !== focusedDz ? grabOrigin.dz : null;
        if (originDz && dzToConfig.has(originDz)) {
            dispatchFinalizeEvent(originDz, dzToConfig.get(originDz).items, {trigger: TRIGGERS.DROPPED_INTO_ANOTHER, id: focusedItemId, source: SOURCES.KEYBOARD, grabActive: false});
        }
        dispatchFinalizeEvent(focusedDz, dzToConfig.get(focusedDz).items, {trigger: TRIGGERS.DROPPED_INTO_ZONE, id: focusedItemId, source: SOURCES.KEYBOARD, grabActive: false});
    }
    pendingMove = false;
    if (allDragTargets.has(document.activeElement)) {
        document.activeElement.blur();
    }
    if (dispatchConsider) {
        dispatchConsiderEvent(focusedDz, dzToConfig.get(focusedDz).items, {
            trigger: TRIGGERS.DRAG_STOPPED,
            id: focusedItemId,
            source: SOURCES.KEYBOARD
        });
    }
    styleInactiveDropZones(
        typeToDropZones.get(draggedItemType),
        dz => dzToConfig.get(dz).dropTargetStyle,
        dz => dzToConfig.get(dz).dropTargetClasses
    );
    focusedItem = null;
    focusedItemId = null;
    focusedItemLabel = "";
    draggedItemType = null;
    focusedDz = null;
    focusedDzLabel = "";
    isDragging = false;
    grabOrigin = null;
    triggerAllDzsUpdate();
}
//////
export function dndzone(node, options) {
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
        onActivate: undefined,
        onAnnounce: undefined
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
        const myZoneIdx = zones.indexOf(focusedDz);
        const targetZone = zones[myZoneIdx + dir];
        if (!targetZone || dzToConfig.get(targetZone).dropFromOthersDisabled) return;
        const fromItems = dzToConfig.get(focusedDz).items;
        const row = fromItems.findIndex(item => item[ITEM_ID_KEY] === focusedItemId);
        const ctx = relocateToZone(targetZone, row < 0 ? 0 : row);
        announce("move", config.autoAriaDisabled, () =>
            `Moved item ${focusedItemLabel} to the list ${ctx.zoneLabel}`,
            ctx
        );
    }

    function handleKeyDown(e) {
        printDebug(() => ["handling key down", e.key]);
        switch (e.key) {
            case "Enter": {
                // we don't want to affect nested input elements or clickable elements
                if ((e.target.disabled !== undefined || e.target.href || e.target.isContentEditable) && !allDragTargets.has(e.target)) {
                    return;
                }
                // Split activation: when the consumer opts in with onActivate and the
                // card is not grabbed, Enter yields to the app (e.g. open editor) and
                // does NOT grab. Otherwise Enter keeps the stock grab/drop behavior.
                if (!isDragging && config.onActivate) {
                    e.preventDefault();
                    e.stopPropagation();
                    setCurrentFocusedItem(e.currentTarget);
                    config.onActivate(focusedItemId);
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                if (isDragging) {
                    handleDrop();
                } else {
                    handleDragStart(e);
                }
                break;
            }
            case " ": {
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
        const children = Array.from(focusedDz.children);
        const idx = children.findIndex(c => allDragTargets.has(c) && c === focusedItem);
        const curIdx = idx < 0 ? items.findIndex(item => item[ITEM_ID_KEY] === focusedItemId) : idx;
        const nextIdx = curIdx + dir;
        if (nextIdx < 0 || nextIdx > children.length - 1) return;
        announce("move", config.autoAriaDisabled, () =>
            `Moved item ${focusedItemLabel} to position ${nextIdx + 1} in the list ${focusedDzLabel}`,
            {index: nextIdx, count: items.length, zoneLabel: focusedDzLabel}
        );
        swap(items, curIdx, nextIdx);
        // TENTATIVE-UNTIL-DROP (#535): a within-lane step is a consider too. Making only the
        // cross-lane steps tentative would not work — a within-lane finalize carries the
        // destination zone's items and the grabbed card's id, so it would commit the pending
        // cross-lane position mid-gesture, which is exactly what #535 is about.
        dispatchConsiderEvent(focusedDz, items, {trigger: TRIGGERS.DRAGGED_OVER_INDEX, id: focusedItemId, source: SOURCES.KEYBOARD, grabActive: true});
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
        announce("grab", config.autoAriaDisabled, () => {
            let msg = `Started dragging item ${focusedItemLabel}. Use the arrow keys to move it within its list ${focusedDzLabel}`;
            if (dropTargets.length > 1) {
                msg += `, or tab to another list in order to move the item into it`;
            }
            return msg;
        }, {index: grabOrigin.index, count: startItems.length, zoneLabel: focusedDzLabel});
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
        onActivate = undefined,
        onAnnounce = undefined
    }) {
        config.items = [...items];
        config.dragDisabled = dragDisabled;
        config.dropFromOthersDisabled = dropFromOthersDisabled;
        config.zoneTabIndex = zoneTabIndex;
        config.zoneItemTabIndex = zoneItemTabIndex;
        config.dropTargetStyle = dropTargetStyle;
        config.dropTargetClasses = dropTargetClasses;
        config.autoAriaDisabled = autoAriaDisabled;
        config.onActivate = onActivate;
        config.onAnnounce = onAnnounce;
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

        if (isDragging) {
            node.tabIndex =
                node === focusedDz ||
                focusedItem.contains(node) ||
                config.dropFromOthersDisabled ||
                (focusedDz && config.type !== dzToConfig.get(focusedDz).type)
                    ? -1
                    : 0;
        } else {
            node.tabIndex = config.zoneTabIndex;
        }

        node.addEventListener("focus", handleZoneFocus);

        for (let i = 0; i < node.children.length; i++) {
            const draggableEl = node.children[i];
            allDragTargets.add(draggableEl);
            // Roving tabindex: default every card to -1 here; the board's single
            // active tab stop (tabIndex 0) is asserted by setRovingTabindex below
            // (at rest) or set on the grabbed card (while dragging). This yields
            // exactly one tab stop per board and is re-asserted on every configure(),
            // so no consumer $effect needs to fight tabindex thrash.
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
            if (isDragging && config.items[i][ITEM_ID_KEY] === focusedItemId) {
                printDebug(() => ["focusing on", {i, focusedItemId}]);
                // if it is a nested dropzone, it was re-rendered and we need to refresh our pointer
                focusedItem = draggableEl;
                focusedItem.tabIndex = config.zoneItemTabIndex;
                activeItemEl = draggableEl;
                // without this the element loses focus if it moves backwards in the list
                draggableEl.focus();
            }
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
            printDebug(() => "keyboard dndzone will destroy");
            unregisterDropZone(node, config.type);
            dzToConfig.delete(node);
            dzToHandles.delete(node);
        }
    };
    dzToHandles.set(node, handles);
    return handles;
}
