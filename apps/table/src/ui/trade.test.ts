/**
 * trade.test.ts — form→op conversion against the REAL OpSchema union, plus
 * capability derivation from a server-shaped legalMoves list.
 *
 * The rule this locks down: the UI never invents op payloads — tradeFormToOp
 * output must parse through the same schema the room server will run it
 * through, or the form returns null and the button stays disabled.
 */
import { describe, expect, it } from "vitest";
import { OpSchema, legalMoves } from "@catan-vtt/shared";
import type { Op, Resource } from "@catan-vtt/shared";
import {
  pickAll,
  shippedTrades,
  tradeCapabilities,
  tradeDemandsFor,
  tradeFormToOp,
  tradeHint,
  tradeOffersFor,
} from "./hudLogic.js";
import { afterRoll, giveCards, SEATS, withPendingTrade } from "./testFixtures.js";

function schemaOk(op: Op | null) {
  expect(op).not.toBeNull();
  const parsed = OpSchema.safeParse(op);
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
}

describe("tradeFormToOp → OpSchema", () => {
  it("bank form produces exactly the wire shape (offer/demand, single res)", () => {
    const op = schemaOk(
      tradeFormToOp({ kind: "bank", give: ["wood"], want: ["ore"] }, 0),
    );
    expect(op).toEqual({ type: "tradeBank", seat: 0, offer: "wood", demand: "ore" });
  });

  it("port form carries the server-shipped vertex id", () => {
    const op = schemaOk(
      tradeFormToOp({ kind: "port", give: ["wool"], want: ["wheat"], portVertexId: "v:1,2" }, 2),
    );
    expect(op).toEqual({ type: "tradePort", seat: 2, portVertexId: "v:1,2", offer: "wool", demand: "wheat" });
  });

  it("offer form supports multi-give/multi-want and rejects self/unknown seats", () => {
    const op = schemaOk(
      tradeFormToOp({ kind: "offer", give: ["wood", "brick"], want: ["ore"], with: 1 }, 0),
    );
    expect(op).toEqual({ type: "tradeOffer", seat: 0, with: 1, give: ["wood", "brick"], want: ["ore"] });
    expect(tradeFormToOp({ kind: "offer", give: ["wood"], want: ["ore"], with: 0 }, 0)).toBeNull();
    // review minor: overlap guard — a resource on BOTH sides is tradeSameResource
    // in the kernel; the form must refuse to compose it.
    expect(tradeFormToOp({ kind: "offer", give: ["wood"], want: ["wood", "ore"], with: 1 }, 0)).toBeNull();
    expect(tradeFormToOp({ kind: "offer", give: ["wood"], want: ["ore"] }, 0)).toBeNull();
  });

  it("garbage in → null out (empty sides, same-resource, junk resources, port w/o vertex)", () => {
    expect(tradeFormToOp({ kind: "bank", give: [], want: ["ore"] }, 0)).toBeNull();
    expect(tradeFormToOp({ kind: "bank", give: ["wood"], want: ["wood"] }, 0)).toBeNull();
    expect(tradeFormToOp({ kind: "bank", give: ["cheese" as Resource], want: ["ore"] }, 0)).toBeNull();
    expect(tradeFormToOp({ kind: "port", give: ["wood"], want: ["ore"] }, 0)).toBeNull();
  });
});

describe("tradeCapabilities (server-shipped moves only)", () => {
  it("a rolled play-phase state with real cards ships bank trades to the mover", () => {
    let st = afterRoll();
    st = giveCards(st, st.currentSeat, ["wood", "wood", "wood", "wood"]);
    const seat = st.currentSeat;
    const moves = legalMoves(st, seat);
    const caps = tradeCapabilities(moves, st, seat);
    expect(moves.length).toBeGreaterThan(0);
    // PROBED kernel truth: legalMoves NEVER enumerates tradeOffer for ANYONE
    // (turn.ts JSDoc: "UI-composed by design; applyAction is the sole
    // authority") — the reviewer caught my old wrong rationale. So caps.bank
    // comes from shipped ops, caps.offer from STATE affordances instead.
    expect(moves.some((m) => m.type === "tradeOffer")).toBe(false);
    expect(caps.bank).toBe(true);
    expect(caps.offer).toBe(true); // own turn, rolled, no pending, no seven
    const bankOp = pickAll(moves, "tradeBank");
    expect(bankOp.length).toBeGreaterThan(0);
    expect(bankOp[0]!.seat).toBe(seat);
  });

  it("spectator (seat null) has no partners and a hint when no trades ship", () => {
    const st = afterRoll();
    const caps = tradeCapabilities([], st, null);
    expect(caps.partners).toEqual([]);
    expect(tradeHint(caps)).toContain("not legal");
    // A seat WITH shipped trades gets no hint:
    let st2 = giveCards(afterRoll(), 0, ["wood", "wood", "wood", "wood"]);
    st2 = { ...st2, currentSeat: 0 };
    const caps2 = tradeCapabilities(legalMoves(st2, 0), st2, 0);
    expect(caps2.bank).toBe(true);
    expect(tradeHint(caps2)).toBe("");
  });

  it("offer fixture: partners list every OTHER seat, ports only from shipped ops", () => {
    const { state, moves, offeree } = withPendingTrade();
    expect(moves.length).toBeGreaterThan(0); // non-vacuous: offeree shipped
    const caps = tradeCapabilities(moves, state, offeree);
    expect(caps.partners).toHaveLength(SEATS - 1);
    expect(caps.partners).not.toContain(offeree);
    // caps.ports is DERIVED from shipped tradePort ops — assert the identity
    // directly instead of an every() over a possibly-empty array (review min).
    expect(caps.ports).toEqual([...new Set(pickAll(moves, "tradePort").map((m) => m.portVertexId))]);
    // I-2 affordance gates, both directions:
    // offeree is NOT currentSeat (offer froze the turn) → no offer tab…
    expect(tradeCapabilities(moves, state, offeree).offer).toBe(false);
    expect(state.pendingTrade).not.toBeNull();
    // …and the offeror, though currentSeat, is blocked while pendingTrade lives.
    expect(tradeCapabilities(moves, state, state.pendingTrade!.offeror).offer).toBe(false);
  });
});

describe("shippedTrades (review I-1: options = server-shipped pairs)", () => {
  it("bank option space is exactly what the kernel enumerated for the mover", () => {
    let st = afterRoll();
    st = giveCards(st, st.currentSeat, ["wood", "wood", "wood", "wood"]);
    const seat = st.currentSeat;
    const moves = legalMoves(st, seat);
    const shipped = shippedTrades(moves);
    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.every((t) => t.kind === "bank" || t.kind === "port")).toBe(true);
    const offers = tradeOffersFor(shipped, "bank");
    expect(offers).toContain("wood"); // 4 wood shipped => wood is offerable
    // every demand listed for an offer is paired with THAT offer only:
    for (const o of offers) {
      const ds = tradeDemandsFor(shipped, "bank", o);
      expect(ds.length).toBeGreaterThan(0);
      expect(ds.every((d) => shipped.some((t) => t.kind === "bank" && t.offer === o && t.demand === d))).toBe(true);
    }
    // the shipped op objects round-trip to themselves (UI sends these verbatim):
    for (const t of shipped.slice(0, 5)) {
      expect(t.op.type).toBe(t.kind === "bank" ? "tradeBank" : "tradePort");
      expect((t.op as { seat: number }).seat).toBe(seat);
    }
  });
});
