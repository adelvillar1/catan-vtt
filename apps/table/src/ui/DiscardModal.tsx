/**
 * DiscardModal.tsx — the "you rolled a 7, shed half your hand" gate.
 *
 * WHAT THE KERNEL ACTUALLY SHIPS (read from packages/shared/src/turn.ts,
 * legalMoves, lines ~1418-1429 — reading is not importing; this file still
 * consumes only the wire):
 *
 *   if (aw.pendingDiscard) {
 *     const front = aw.discardQueue[0];
 *     if (seat !== front.seat) return [];
 *     return multisetCombinations(debtor.hand, front.count)
 *       .map((cards) => ({ type: "discardSeven", seat, cards }));
 *   }
 *
 * i.e. the server ships ONE discardSeven op per distinct multiset of size
 * `count` drawable from the debtor's hand — NOT a single deterministic op.
 * A 12-card hand owing 6 can produce HUNDREDS of near-identical ops, so
 * rendering one button per shipped op (the naive "shipped buttons" reading)
 * is unusable.
 *
 * RULING (mirrors TradePanel's IMPORTANT-1 precedent as closely as the shape
 * allows): the UI lets the player COMPOSE the card multiset by clicking
 * resource chips, then looks the composed multiset up in the SET of shipped
 * discardSeven ops and sends the MATCHING op object verbatim. The shipped
 * ops remain the sole legality authority — a composition that is not in the
 * set can never be submitted, so no hand-built `{type:"discardSeven"}` ever
 * leaves this file. If the kernel ever ships exactly one op with a fixed
 * auto-minimum card set, the same code path renders it as a single enabled
 * button (count reached, selection prefilled) — no branch needed.
 */
import { useMemo, useState } from "react";
import type { GameState, Op, Resource } from "@catan-vtt/shared"; // type-only
import { pickAll } from "./hudLogic.js";
import { RESOURCES, RESOURCE_ABBR } from "./hudLogic.js";
import { toggleDiscardPick } from "./hudLogic.js";
import { discardCardsKey } from "../scene/targetSet.js";

export interface DiscardModalProps {
  state: GameState;
  seat: number | null;
  legalMoves: readonly Op[];
  sendOp: (op: Op) => boolean;
}

export function DiscardModal({
  state,
  seat,
  legalMoves,
  sendOp,
}: DiscardModalProps): React.JSX.Element | null {
  const [picked, setPicked] = useState<Resource[]>([]);

  // Visible iff the server says THIS seat owes a discard right now.
  const aw = state.awaitingSeven;
  const front = aw?.discardQueue[0];
  const active = aw !== null && front !== undefined && seat !== null && front.seat === seat;

  // Shipped discardSeven ops, indexed by multiset — the legality authority.
  // Keys use the SAME canonical encoding as targetSet.discardCombinationKeys
  // (resource-name-sorted "wood:2,wool:1"), so the pure index test and this
  // component cannot drift.
  const { byKey, count } = useMemo(() => {
    const shipped = pickAll(legalMoves, "discardSeven");
    const map = new Map<string, Op>();
    for (const op of shipped) map.set(discardCardsKey(op.cards), op);
    return { byKey: map, count: shipped[0]?.cards.length ?? 0 };
  }, [legalMoves]);

  // Reset the picker on window CHANGE (review minor-5): keying only on the
  // owed count kept a stale selection across two different windows with the
  // same count (e.g. I submit, the queue moves away — modal hidden — then a
  // later 7 reopens for me at the same count). The window identity is
  // (debtor, count); being hidden IS an identity (null), so submitting a
  // discard also clears the slate. This is React's legal
  // reset-state-on-prop-change pattern (adjust during render, not in effect).
  const winKey = active ? `${front!.seat}:${count}` : null;
  const [lastWin, setLastWin] = useState<string | null>(null);
  if (lastWin !== winKey) {
    setLastWin(winKey);
    setPicked([]);
  }

  if (!active) return null;

  const hand = state.players.find((p) => p.seat === seat)?.hand ?? null;
  const remainingOf = (r: Resource): number => {
    if (hand === null) return 0;
    const held = hand[r] ?? 0;
    return held - picked.filter((c) => c === r).length;
  };

  const full = picked.length === count;
  const match = full ? byKey.get(discardCardsKey(picked)) : undefined;
  const canSend = match !== undefined;

  // Click rule lives in hudLogic.toggleDiscardPick (PURE, node-tested):
  // picked is a MULTISET — clicks accumulate up to the hand/owed ceilings and
  // then hand cards back. The P3(c) AC2 demo caught the previous set-toggle
  // deadlocking a {wood:2, ore:6} hand owing 4: no reachable selection could
  // ever reach count, so submit could never enable.
  const toggle = (r: Resource): void => {
    setPicked((prev) => toggleDiscardPick(prev, r, hand, count));
  };

  return (
    <div className="discard-modal" role="dialog" aria-label="discard" id="discard-modal">
      <div className="discard-card">
        <h2>Discard {count} card{count === 1 ? "" : "s"}</h2>
        <p className="hint">
          A 7 was rolled. Pick {count} card{count === 1 ? "" : "s"} to discard — the table only
          accepts combinations the server shipped.
        </p>

        <div className="discard-chips" role="group" aria-label="choose cards">
          {RESOURCES.map((r) => {
            const left = remainingOf(r);
            return (
              <button
                key={r}
                type="button"
                className="chip-btn"
                disabled={left <= 0 && !picked.includes(r)}
                onClick={() => toggle(r)}
              >
                {RESOURCE_ABBR[r]} · {r}
                <span className="chip-count">{left}</span>
              </button>
            );
          })}
        </div>

        <div className="discard-selected" aria-live="polite">
          selected {picked.length}/{count}
          {picked.length > 0 ? ` — ${picked.join(", ")}` : ""}
        </div>

        <div className="discard-actions">
          <button type="button" onClick={() => setPicked([])} disabled={picked.length === 0}>
            Clear
          </button>
          <button
            type="button"
            className="btn-primary"
            id="discard-submit"
            disabled={!canSend}
            onClick={() => {
              if (match !== undefined) sendOp(match); // THE shipped op, verbatim
            }}
          >
            {canSend ? "Discard" : `Pick ${count}`}
          </button>
        </div>
      </div>
    </div>
  );
}
