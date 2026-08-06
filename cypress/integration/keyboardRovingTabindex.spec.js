import {dndzone} from "../../src/keyboardAction";
import {TRIGGERS} from "../../src/constants";
import {setKeyboardDragTrigger} from "../../src/keyboardDragTrigger";

describe("keyboardAction at-rest navigation and roving tabindex", () => {
    const actions = [];
    const zones = [];

    // Zones are plain divs appended to body. orderedZonesOfType sorts by
    // getBoundingClientRect() left-then-top, so stacked divs sort in append order.
    // Pass `zoneStyle` to lay lanes out side by side for the left/right tests.
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

    // Two lanes, explicitly positioned so lane A sorts left of lane B.
    function createLanes(itemsA, itemsB, options = {}) {
        const laneStyle = left => ({position: "absolute", top: "0px", left, width: "100px"});
        const a = createZone(itemsA, options, laneStyle("0px"));
        const b = createZone(itemsB, options, laneStyle("200px"));
        return {a, b};
    }

    function key(el, k) {
        const event = new KeyboardEvent("keydown", {key: k, bubbles: true, cancelable: true});
        el.dispatchEvent(event);
        return event;
    }

    // The board's tabindex map: one entry per card, in zone-append order.
    function tabIndices() {
        return zones.map(zone => Array.from(zone.children).map(child => child.tabIndex));
    }

    afterEach(() => {
        actions
            .splice(0)
            .reverse()
            .forEach(action => action.destroy());
        zones.splice(0).forEach(zone => zone.remove());
        // The drag trigger is global module state, so a test that narrows it would otherwise
        // leak into every test after it — in this spec and in whichever spec runs next.
        setKeyboardDragTrigger(null);
    });

    describe("roving tabindex", () => {
        it("keeps exactly one tab stop across every zone sharing a type", () => {
            createZone([{id: "a1"}, {id: "a2"}], {type: "board"});
            createZone([{id: "b1"}, {id: "b2"}, {id: "b3"}], {type: "board"});

            expect(tabIndices()).to.deep.equal([
                [0, -1],
                [-1, -1, -1]
            ]);
        });

        it("does not give a zone of another type a tab stop from this board", () => {
            createZone([{id: "a1"}, {id: "a2"}], {type: "board"});
            const {zone: otherZone} = createZone([{id: "x1"}], {type: "other"});

            // Each type is its own board with its own single tab stop.
            expect(Array.from(otherZone.children).map(c => c.tabIndex)).to.deep.equal([0]);
            expect(tabIndices()[0]).to.deep.equal([0, -1]);
        });

        it("re-asserts the existing tab stop on every update", () => {
            const {
                a: {zone: laneA, children: cardsA},
                b: {action: actionB}
            } = createLanes([{id: "a1"}, {id: "a2"}], [{id: "b1"}], {type: "board"});

            key(cardsA[0], "ArrowDown");
            expect(cardsA[1].tabIndex, "arrow nav moves the tab stop").to.equal(0);

            // A consumer $effect clobbering tabindex must not survive the next configure().
            Array.from(laneA.children).forEach(c => (c.tabIndex = 0));
            actionB.update({items: [{id: "b1"}], type: "board"});

            expect(tabIndices()).to.deep.equal([[-1, 0], [-1]]);
        });

        it("falls back to the first card of the first zone when the active card is removed", () => {
            const {
                a: {children: cardsA},
                b: {zone: laneB, action: actionB, children: cardsB}
            } = createLanes([{id: "a1"}, {id: "a2"}], [{id: "b1"}], {type: "board"});

            key(cardsA[0], "ArrowRight");
            expect(cardsB[0].tabIndex, "the active card is now in lane B").to.equal(0);

            laneB.removeChild(cardsB[0]);
            actionB.update({items: [], type: "board"});

            expect(tabIndices()).to.deep.equal([[0, -1], []]);
        });

        it("gives the active card the configured zoneItemTabIndex, not a hardcoded 0", () => {
            const {
                children: [first, second]
            } = createZone([{id: "a"}, {id: "b"}, {id: "c"}], {zoneItemTabIndex: 3});

            expect(tabIndices(), "the active card takes the configured index").to.deep.equal([[3, -1, -1]]);

            key(first, "ArrowDown");

            expect(tabIndices(), "and keeps it as the tab stop moves").to.deep.equal([[-1, 3, -1]]);
            expect(document.activeElement, "focus follows the tab stop").to.equal(second);
        });
    });

    describe("at-rest arrow navigation", () => {
        it("moves the tab stop down the lane with ArrowDown", () => {
            const {
                children: [c0, c1, c2]
            } = createZone([{id: "a"}, {id: "b"}, {id: "c"}], {type: "board"});

            key(c0, "ArrowDown");
            expect(document.activeElement).to.equal(c1);
            expect([c0.tabIndex, c1.tabIndex, c2.tabIndex]).to.deep.equal([-1, 0, -1]);

            key(c1, "ArrowDown");
            expect(document.activeElement).to.equal(c2);
            expect([c0.tabIndex, c1.tabIndex, c2.tabIndex]).to.deep.equal([-1, -1, 0]);
        });

        it("clamps ArrowDown at the last card of the lane", () => {
            const {
                children: [c0, c1]
            } = createZone([{id: "a"}, {id: "b"}], {type: "board"});

            key(c0, "ArrowDown");
            key(c1, "ArrowDown");

            expect(document.activeElement).to.equal(c1);
            expect([c0.tabIndex, c1.tabIndex]).to.deep.equal([-1, 0]);
        });

        it("moves the tab stop up the lane with ArrowUp and clamps at the first card", () => {
            const {
                children: [c0, c1, c2]
            } = createZone([{id: "a"}, {id: "b"}, {id: "c"}], {type: "board"});

            key(c0, "ArrowDown");
            key(c1, "ArrowDown");
            key(c2, "ArrowUp");
            expect(document.activeElement).to.equal(c1);

            key(c1, "ArrowUp");
            expect(document.activeElement).to.equal(c0);
            expect([c0.tabIndex, c1.tabIndex, c2.tabIndex]).to.deep.equal([0, -1, -1]);

            key(c0, "ArrowUp");
            expect(document.activeElement, "clamped at the top of the lane").to.equal(c0);
            expect([c0.tabIndex, c1.tabIndex, c2.tabIndex]).to.deep.equal([0, -1, -1]);
        });

        it("moves to the adjacent lane at the same row with ArrowRight/ArrowLeft", () => {
            const {
                a: {children: cardsA},
                b: {children: cardsB}
            } = createLanes([{id: "a1"}, {id: "a2"}, {id: "a3"}], [{id: "b1"}, {id: "b2"}, {id: "b3"}], {type: "board"});

            key(cardsA[0], "ArrowDown");
            key(cardsA[1], "ArrowRight");

            expect(document.activeElement, "same row index in the next lane").to.equal(cardsB[1]);
            expect(cardsA.map(c => c.tabIndex)).to.deep.equal([-1, -1, -1]);
            expect(cardsB.map(c => c.tabIndex)).to.deep.equal([-1, 0, -1]);

            key(cardsB[1], "ArrowLeft");
            expect(document.activeElement).to.equal(cardsA[1]);
            expect(cardsA.map(c => c.tabIndex)).to.deep.equal([-1, 0, -1]);
            expect(cardsB.map(c => c.tabIndex)).to.deep.equal([-1, -1, -1]);
        });

        it("clamps the row index to the adjacent lane's card count", () => {
            const {
                a: {children: cardsA},
                b: {children: cardsB}
            } = createLanes([{id: "a1"}, {id: "a2"}, {id: "a3"}], [{id: "b1"}], {type: "board"});

            key(cardsA[0], "ArrowDown");
            key(cardsA[1], "ArrowDown");
            expect(document.activeElement).to.equal(cardsA[2]);

            key(cardsA[2], "ArrowRight");

            expect(document.activeElement, "clamped to the shorter lane's last card").to.equal(cardsB[0]);
            expect(cardsB[0].tabIndex).to.equal(0);
        });

        it("does not navigate past the outermost lane", () => {
            const {
                a: {children: cardsA},
                b: {children: cardsB}
            } = createLanes([{id: "a1"}], [{id: "b1"}], {type: "board"});

            cardsA[0].focus();
            key(cardsA[0], "ArrowLeft");
            expect(document.activeElement, "no lane to the left of the first").to.equal(cardsA[0]);
            expect(cardsA[0].tabIndex, "the tab stop stays put").to.equal(0);

            key(cardsA[0], "ArrowRight");
            key(cardsB[0], "ArrowRight");
            expect(document.activeElement, "no lane to the right of the last").to.equal(cardsB[0]);
            expect(cardsB[0].tabIndex).to.equal(0);
        });

        it("jumps to the first and last card of the lane with Home and End", () => {
            const {
                children: [c0, c1, c2]
            } = createZone([{id: "a"}, {id: "b"}, {id: "c"}], {type: "board"});

            key(c0, "End");
            expect(document.activeElement).to.equal(c2);
            expect([c0.tabIndex, c1.tabIndex, c2.tabIndex]).to.deep.equal([-1, -1, 0]);

            key(c2, "Home");
            expect(document.activeElement).to.equal(c0);
            expect([c0.tabIndex, c1.tabIndex, c2.tabIndex]).to.deep.equal([0, -1, -1]);
        });

        it("does not reorder the items while navigating at rest", () => {
            const items = [{id: "a"}, {id: "b"}, {id: "c"}];
            const {
                zone,
                children: [c0]
            } = createZone(items, {type: "board"});
            const considers = [];
            zone.addEventListener("consider", e => considers.push(e.detail.info.trigger));

            key(c0, "ArrowDown");
            key(c0, "End");

            expect(considers, "at-rest navigation is not a drag").to.be.empty;
            expect(items.map(i => i.id)).to.deep.equal(["a", "b", "c"]);
        });
    });

    // keyboardDragTrigger's own suite covers the setting against the stock zone. What matters
    // here is that this fork's roving-tabindex layer, which sits on top of the same
    // handleKeyDown, does not re-claim a key the trigger has yielded.
    describe("keyboardDragTrigger", () => {
        it("leaves Enter completely untouched under the roving layer when the trigger is 'space'", () => {
            setKeyboardDragTrigger("space");
            const {
                zone,
                children: [c0, c1]
            } = createZone([{id: "a"}, {id: "b"}], {type: "board"});
            const considers = [];
            zone.addEventListener("consider", e => considers.push(e.detail.info.trigger));
            const seenByConsumer = [];
            zone.addEventListener("keydown", e => seenByConsumer.push(e));

            c1.focus();
            const event = key(c1, "Enter");

            expect(considers, "Enter must not start a grab").to.be.empty;
            expect(seenByConsumer, "the event must reach the consumer").to.have.lengthOf(1);
            // The whole point of the option over a callback: the library does not consume the
            // key, so the consumer's own handler and the element's default both still run.
            expect(event.defaultPrevented, "Enter must not be preventDefault-ed").to.be.false;

            // Still at rest: ArrowDown navigates rather than reordering.
            key(c0, "ArrowDown");
            expect(document.activeElement).to.equal(c1);
            expect(considers).to.be.empty;
        });

        it("still grabs and drops on Space when the trigger is 'space'", () => {
            setKeyboardDragTrigger("space");
            const {
                zone,
                children: [c0]
            } = createZone([{id: "a"}, {id: "b"}], {type: "board"});
            const considers = [];
            zone.addEventListener("consider", e => considers.push(e.detail.info.trigger));

            c0.focus();
            key(c0, " ");
            expect(considers).to.deep.equal([TRIGGERS.DRAG_STARTED]);

            key(c0, " ");
            expect(considers).to.deep.equal([TRIGGERS.DRAG_STARTED, TRIGGERS.DRAG_STOPPED]);
        });

        it("keeps the stock grab behavior on Enter by default", () => {
            const {
                zone,
                children: [c0]
            } = createZone([{id: "a"}, {id: "b"}], {type: "board"});
            const considers = [];
            zone.addEventListener("consider", e => considers.push(e.detail.info.trigger));

            c0.focus();
            key(c0, "Enter");
            expect(considers).to.deep.equal([TRIGGERS.DRAG_STARTED]);

            key(c0, "Enter");
            expect(considers).to.deep.equal([TRIGGERS.DRAG_STARTED, TRIGGERS.DRAG_STOPPED]);
        });

        it("ignores Enter mid-grab when the trigger is 'space'", () => {
            setKeyboardDragTrigger("space");
            const {
                zone,
                children: [c0]
            } = createZone([{id: "a"}, {id: "b"}], {type: "board"});
            const considers = [];
            zone.addEventListener("consider", e => considers.push(e.detail.info.trigger));

            c0.focus();
            key(c0, " ");
            expect(considers).to.deep.equal([TRIGGERS.DRAG_STARTED]);

            // Unlike the old onActivate seam, which gated on !isDragging and let Enter fall
            // through to a drop, the trigger yields Enter unconditionally - the grab survives.
            const event = key(c0, "Enter");
            expect(considers, "Enter must not drop the grabbed card").to.deep.equal([TRIGGERS.DRAG_STARTED]);
            expect(event.defaultPrevented).to.be.false;
        });
    });
});
