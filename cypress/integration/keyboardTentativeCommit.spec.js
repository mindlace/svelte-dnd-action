import {dndzone} from "../../src/keyboardAction";
import {TRIGGERS} from "../../src/constants";

// Tentative-until-drop keyboard grabs (#535): every mid-grab step is a `consider`,
// the drop is the one and only commit. See the TENTATIVE-UNTIL-DROP comments in
// src/keyboardAction.js — these tests encode exactly the guarantees stated there.
describe("keyboardAction tentative-until-drop", () => {
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

    // Records every consider/finalize seen on the given zones, tagged with the zone
    // so we can assert both the event kind and where it landed.
    function track(named) {
        const considers = [];
        const finalizes = [];
        Object.entries(named).forEach(([name, zone]) => {
            zone.addEventListener("consider", e =>
                considers.push({zone: name, trigger: e.detail.info.trigger, grabActive: e.detail.info.grabActive, items: e.detail.items})
            );
            zone.addEventListener("finalize", e =>
                finalizes.push({zone: name, trigger: e.detail.info.trigger, grabActive: e.detail.info.grabActive, items: e.detail.items})
            );
        });
        return {considers, finalizes};
    }

    function key(el, k) {
        el.dispatchEvent(new KeyboardEvent("keydown", {key: k, bubbles: true, cancelable: true}));
    }

    function grab(item) {
        item.focus();
        key(item, " ");
    }

    function ids(items) {
        return items.map(item => item.id);
    }

    // Only the grab-lifecycle considers, i.e. everything the drop itself emits is excluded.
    function midGrab(considers) {
        return considers.filter(c => c.trigger !== TRIGGERS.DRAG_STARTED && c.trigger !== TRIGGERS.DRAG_STOPPED);
    }

    afterEach(() => {
        actions
            .splice(0)
            .reverse()
            .forEach(action => action.destroy());
        zones.splice(0).forEach(zone => zone.remove());
    });

    it("reports a within-lane arrow step as a consider and finalizes nothing until the drop", () => {
        const {
            zone,
            children: [item]
        } = createZone([{id: "a"}, {id: "b"}, {id: "c"}]);
        const {considers, finalizes} = track({zone});

        grab(item);
        key(item, "ArrowDown");

        const steps = midGrab(considers);
        expect(steps, "the arrow step should be a single consider").to.have.length(1);
        expect(steps[0].trigger).to.equal(TRIGGERS.DRAGGED_OVER_INDEX);
        expect(steps[0].grabActive, "mid-grab considers are flagged grabActive").to.equal(true);
        expect(ids(steps[0].items), "the consider carries the tentative order").to.deep.equal(["b", "a", "c"]);
        expect(finalizes, "nothing may be committed mid-grab").to.be.empty;
    });

    it("reports a cross-lane arrow step as a dual consider and finalizes nothing until the drop", () => {
        const {
            zone: zoneA,
            children: [itemA]
        } = createZone([{id: "a"}, {id: "b"}]);
        const {zone: zoneB} = createZone([{id: "c"}]);
        const {considers, finalizes} = track({A: zoneA, B: zoneB});

        grab(itemA);
        key(itemA, "ArrowRight");

        const steps = midGrab(considers);
        expect(steps.map(s => [s.zone, s.trigger])).to.deep.equal([
            ["A", TRIGGERS.DRAGGED_LEFT],
            ["B", TRIGGERS.DRAGGED_ENTERED]
        ]);
        expect(
            steps.map(s => s.grabActive),
            "both halves of the relocate are flagged grabActive"
        ).to.deep.equal([true, true]);
        expect(ids(steps[0].items), "the origin consider drops the card").to.deep.equal(["b"]);
        expect(ids(steps[1].items), "the destination consider receives it").to.deep.equal(["a", "c"]);
        expect(finalizes, "nothing may be committed mid-grab").to.be.empty;
    });

    it("commits a cross-lane grab exactly once, origin zone before destination", () => {
        const {
            zone: zoneA,
            children: [itemA]
        } = createZone([{id: "a"}, {id: "b"}]);
        const {zone: zoneB} = createZone([{id: "c"}]);
        const {finalizes} = track({A: zoneA, B: zoneB});

        grab(itemA);
        key(itemA, "ArrowRight");
        expect(finalizes, "still nothing before the drop").to.be.empty;

        key(itemA, " ");

        expect(finalizes.map(f => [f.zone, f.trigger])).to.deep.equal([
            ["A", TRIGGERS.DROPPED_INTO_ANOTHER],
            ["B", TRIGGERS.DROPPED_INTO_ZONE]
        ]);
        expect(
            finalizes.map(f => f.grabActive),
            "the commit is not part of a live grab"
        ).to.deep.equal([false, false]);
        expect(ids(finalizes[0].items)).to.deep.equal(["b"]);
        expect(ids(finalizes[1].items)).to.deep.equal(["a", "c"]);
    });

    it("commits a within-lane grab with a single finalize on the drop", () => {
        const {
            zone,
            children: [item]
        } = createZone([{id: "a"}, {id: "b"}, {id: "c"}]);
        const {finalizes} = track({zone});

        grab(item);
        key(item, "ArrowDown");
        expect(finalizes, "still nothing before the drop").to.be.empty;

        key(item, " ");

        expect(finalizes, "a same-zone drop commits once").to.have.length(1);
        expect(finalizes[0].trigger).to.equal(TRIGGERS.DROPPED_INTO_ZONE);
        expect(finalizes[0].grabActive).to.equal(false);
        expect(ids(finalizes[0].items)).to.deep.equal(["b", "a", "c"]);
    });

    it("writes nothing when a grab is dropped without ever stepping", () => {
        const {
            zone: zoneA,
            children: [itemA]
        } = createZone([{id: "a"}, {id: "b"}]);
        const {zone: zoneB} = createZone([{id: "c"}]);
        const {considers, finalizes} = track({A: zoneA, B: zoneB});

        grab(itemA);
        key(itemA, " ");

        expect(midGrab(considers), "a grab that never stepped has no tentative frames").to.be.empty;
        expect(finalizes, "a grab that never stepped commits nothing").to.be.empty;
        expect(considers.map(c => [c.zone, c.trigger])).to.deep.equal([
            ["A", TRIGGERS.DRAG_STARTED],
            ["A", TRIGGERS.DRAG_STOPPED]
        ]);
    });

    // Deliberate non-guarantee, spelled out in handleDrop's TENTATIVE-UNTIL-DROP comment:
    // a net-zero grab is NOT write-free. Suppressing the no-op write is the consumer's job.
    it("DOES finalize a round-trip that ends where it started (documented non-guarantee)", () => {
        const startItems = [{id: "a"}, {id: "b"}, {id: "c"}];
        const {zone, action, children} = createZone(startItems);
        const elById = new Map(startItems.map((item, i) => [item.id, children[i]]));
        const [item] = children;
        const {finalizes} = track({zone});

        // A realistic consumer writes the tentative order back, which also re-orders the DOM.
        zone.addEventListener("consider", e => {
            if (e.detail.info.trigger !== TRIGGERS.DRAGGED_OVER_INDEX) return;
            const next = e.detail.items;
            next.forEach(it => zone.appendChild(elById.get(it.id)));
            action.update({items: next});
        });

        grab(item);
        key(item, "ArrowDown");
        expect(ids([...zone.children].map(el => startItems[children.indexOf(el)])), "the card actually moved down").to.deep.equal(["b", "a", "c"]);

        key(document.activeElement, "ArrowUp");
        expect(ids([...zone.children].map(el => startItems[children.indexOf(el)])), "and came back home").to.deep.equal(["a", "b", "c"]);
        expect(finalizes, "still nothing before the drop").to.be.empty;

        key(document.activeElement, " ");

        expect(finalizes, "the round trip still commits — the consumer must dedupe it").to.have.length(1);
        expect(finalizes[0].trigger).to.equal(TRIGGERS.DROPPED_INTO_ZONE);
        expect(finalizes[0].grabActive).to.equal(false);
        expect(ids(finalizes[0].items), "with the original order").to.deep.equal(["a", "b", "c"]);
    });
});
