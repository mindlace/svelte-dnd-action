import {dndzone} from "../../src/keyboardAction";
import {TRIGGERS} from "../../src/constants";

describe("keyboardAction escape-to-cancel", () => {
    const actions = [];
    const zones = [];

    function createZone(items, options = {}) {
        const zone = document.createElement("div");
        items.forEach(() => zone.appendChild(document.createElement("div")));
        document.body.appendChild(zone);
        zones.push(zone);
        const action = dndzone(zone, {items, ...options});
        actions.push(action);
        return {zone, action, children: Array.from(zone.children)};
    }

    // The library dispatches the LIVE items array, which it keeps mutating, so every
    // recorded event has to be snapshotted at dispatch time.
    function track(zone) {
        const record = {considers: [], finalizes: []};
        zone.addEventListener("consider", e => record.considers.push({trigger: e.detail.info.trigger, ids: ids(e.detail.items)}));
        zone.addEventListener("finalize", e => record.finalizes.push({trigger: e.detail.info.trigger, ids: ids(e.detail.items)}));
        return record;
    }

    function ids(items) {
        return items.map(item => item.id);
    }

    function lastConsider(record) {
        return record.considers[record.considers.length - 1];
    }

    function key(el, k) {
        el.dispatchEvent(new KeyboardEvent("keydown", {key: k, bubbles: true, cancelable: true}));
    }

    function grab(item) {
        item.focus();
        key(item, " ");
    }

    function escape() {
        // Escape is handled by the module's window-level handler, not by the card's.
        window.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    }

    // The library alerts through a single hidden live region shared by all zones.
    function alertText() {
        return document.getElementById("dnd-action-aria-alert")?.textContent ?? "";
    }

    afterEach(() => {
        actions
            .splice(0)
            .reverse()
            .forEach(action => action.destroy());
        zones.splice(0).forEach(zone => zone.remove());
    });

    it("returns a cross-zone grabbed card to its origin zone at its original index", () => {
        const {
            zone: zoneA,
            children: [, cardB]
        } = createZone([{id: "a"}, {id: "b"}, {id: "c"}]);
        const {zone: zoneZ} = createZone([{id: "x"}]);
        const recordA = track(zoneA);
        const recordZ = track(zoneZ);

        grab(cardB);
        key(cardB, "ArrowRight");

        expect(lastConsider(recordZ).ids, "should tentatively land in the other zone").to.deep.equal(["x", "b"]);
        expect(lastConsider(recordA).ids, "should tentatively leave the origin zone").to.deep.equal(["a", "c"]);

        escape();

        expect(lastConsider(recordA).trigger, "should stop the drag in the origin zone").to.equal(TRIGGERS.DRAG_STOPPED);
        expect(lastConsider(recordA).ids, "should restore the card at its original index").to.deep.equal(["a", "b", "c"]);
        expect(lastConsider(recordZ).ids, "should take the card back out of the other zone").to.deep.equal(["x"]);
    });

    it("ends the grab when escape is pressed after moving only within the origin zone", () => {
        const {
            zone: zoneA,
            children: [cardA]
        } = createZone([{id: "a"}, {id: "b"}, {id: "c"}]);
        const record = track(zoneA);

        grab(cardA);
        key(cardA, "ArrowDown");
        expect(lastConsider(record).ids, "should tentatively reorder within the lane").to.deep.equal(["b", "a", "c"]);

        escape();

        expect(lastConsider(record).trigger, "should end the grab").to.equal(TRIGGERS.DRAG_STOPPED);
        // relocateToZone only runs when the card left its origin zone, so the tentative
        // in-lane order is NOT un-swapped. The cancel is expressed by the absence of a
        // finalize (below) — the consumer drops its tentative copy and keeps its own source.
        expect(lastConsider(record).ids, "should not re-order the tentative items back").to.deep.equal(["b", "a", "c"]);
        expect(record.finalizes, "should not commit an in-lane cancel").to.be.empty;

        // The grab really is over: a second escape does nothing more.
        const considersAfterDrop = record.considers.length;
        escape();
        expect(record.considers.length, "should be no longer dragging").to.equal(considersAfterDrop);
    });

    it("dispatches no finalize at all on escape, however far the card moved", () => {
        const {
            zone: zoneA,
            children: [cardA]
        } = createZone([{id: "a"}, {id: "b"}]);
        const {zone: zoneZ, children: zCards} = createZone([{id: "x"}, {id: "y"}]);
        const recordA = track(zoneA);
        const recordZ = track(zoneZ);

        grab(cardA);
        key(cardA, "ArrowRight");
        key(cardA, "ArrowDown");
        key(zCards[0], "ArrowLeft");
        key(cardA, "ArrowRight");

        expect(recordA.considers.length + recordZ.considers.length, "should have stepped the grab several times").to.be.greaterThan(4);

        escape();

        expect(recordA.finalizes, "should not finalize the origin zone").to.be.empty;
        expect(recordZ.finalizes, "should not finalize the zone the card was in").to.be.empty;
        // sanity: the same grab WITHOUT escape does finalize, so the assertions above are not vacuous
        const cardAfterCancel = zoneA.children[0];
        grab(cardAfterCancel);
        key(cardAfterCancel, "ArrowRight");
        key(cardAfterCancel, " ");
        expect(recordA.finalizes.length + recordZ.finalizes.length, "should finalize a committed grab").to.be.greaterThan(0);
    });

    it("re-syncs a stale focusedDz before restoring on escape", () => {
        const {
            zone: zoneA,
            action: actionA,
            children: [cardA]
        } = createZone([{id: "a"}, {id: "b"}]);
        const {zone: zoneZ} = createZone([]);
        const recordA = track(zoneA);
        const recordZ = track(zoneZ);

        grab(cardA);
        key(cardA, "ArrowRight");
        expect(lastConsider(recordZ).ids, "should move the card to the other zone").to.deep.equal(["a"]);

        // A consumer re-render pass that runs over the origin zone only: first with a copy
        // that still holds the grabbed card (which re-points the module's focusedDz at the
        // origin zone), then with the settled copy that no longer holds it. The module's
        // focusedDz now lags behind the zone that actually holds the card.
        actionA.update({items: [{id: "a"}, {id: "b"}]});
        actionA.update({items: [{id: "b"}]});
        // The active-drag tab indices mirror focusedDz: the focused zone is the untabbable one.
        expect(zoneA.tabIndex, "should have left focusedDz pointing at the origin zone").to.equal(-1);
        expect(zoneZ.tabIndex, "should no longer point at the zone holding the card").to.equal(0);

        escape();

        expect(lastConsider(recordA).trigger, "should drop in the zone the card was restored to").to.equal(TRIGGERS.DRAG_STOPPED);
        expect(lastConsider(recordA).ids, "should restore the card to its origin zone").to.deep.equal(["a", "b"]);
        expect(lastConsider(recordZ).ids, "should not leave the card behind in the other zone").to.deep.equal([]);
        expect(recordA.finalizes.concat(recordZ.finalizes), "should still not commit").to.be.empty;
    });

    it("re-syncs a stale focusedDz before an arrow move across lanes", () => {
        const {
            zone: zoneA,
            action: actionA,
            children: [cardA]
        } = createZone([{id: "a"}, {id: "b"}]);
        const {zone: zoneZ} = createZone([]);
        const recordA = track(zoneA);
        const recordZ = track(zoneZ);

        grab(cardA);
        key(cardA, "ArrowRight");
        actionA.update({items: [{id: "a"}, {id: "b"}]});
        actionA.update({items: [{id: "b"}]});
        expect(zoneA.tabIndex, "should have left focusedDz pointing at the origin zone").to.equal(-1);
        expect(zoneZ.tabIndex, "should no longer point at the zone holding the card").to.equal(0);

        // Without the re-sync in relocateToAdjacentLane this reads the origin zone as the
        // current lane and walks off the left edge of the board, leaving the card behind.
        key(cardA, "ArrowLeft");

        expect(lastConsider(recordA).ids, "should bring the card back into the origin lane").to.deep.equal(["a", "b"]);
        expect(lastConsider(recordZ).ids, "should take the card out of the other lane").to.deep.equal([]);
    });

    it("does nothing when escape is pressed with no card grabbed", () => {
        const {zone: zoneA, children} = createZone([{id: "a"}, {id: "b"}]);
        const record = track(zoneA);

        escape();

        expect(record.considers, "should not dispatch a consider").to.be.empty;
        expect(record.finalizes, "should not dispatch a finalize").to.be.empty;

        // and the board is still usable afterwards
        grab(children[0]);
        expect(
            record.considers.map(c => c.trigger),
            "should still be able to grab"
        ).to.deep.equal([TRIGGERS.DRAG_STARTED]);
    });

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

    it("commits the pending step when an arrow relocate finds the card gone (unlike escape, which cancels)", () => {
        const {
            zone: zoneA,
            action: actionA,
            children: [cardA]
        } = createZone([{id: "a"}, {id: "b"}]);
        const {zone: zoneZ, action: actionZ} = createZone([{id: "c"}]);
        const recordA = track(zoneA);
        const recordZ = track(zoneZ);

        grab(cardA);
        key(cardA, "ArrowDown");
        expect(lastConsider(recordA).ids, "should tentatively reorder within the lane (pendingMove)").to.deep.equal(["b", "a"]);

        // A consumer re-render that removes the grabbed card outright: every zone settles
        // without it.
        zoneA.removeChild(cardA);
        actionA.update({items: [{id: "b"}]});
        actionZ.update({items: [{id: "c"}]});

        key(cardA, "ArrowRight");

        expect(lastConsider(recordA).trigger, "the grab must end rather than silently no-op").to.equal(TRIGGERS.DRAG_STOPPED);
        // Unlike escape (which never commits), an arrow relocate onto a vanished card uses
        // upstream's policy (grabIsAlive -> handleDrop with its default commit: true), so
        // the pending step from ArrowDown above IS committed here.
        expect(recordA.finalizes.concat(recordZ.finalizes), "the pending step must be committed, not cancelled").to.not.be.empty;
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
});
