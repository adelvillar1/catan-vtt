/**
 * opLabel.ts — human-readable labels for the server's legalMoves.
 *
 * P1: read-only text in the overlay. P2 turns each entry into a button —
 * the shape returned here (`{ key, op, label }`) is what P2 binds to, so the
 * list identity stays stable and the label never has to be recomputed.
 */
import type { Op, Resource } from "@catan-vtt/shared";

export interface LabeledMove {
  /** Stable React key: op type + its target. */
  key: string;
  /** The verbatim op to hand to sendOp (P2). */
  op: Op;
  /** One-line human label. */
  label: string;
  /** Optional longer detail (trade contents, discard cards…). */
  detail?: string;
}

function list(rs: Resource[]): string {
  return rs.join(", ");
}

function cards(rs: readonly Resource[]): string {
  const counts = new Map<Resource, number>();
  for (const r of rs) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts].map(([r, n]) => (n > 1 ? `${n}×${r}` : r)).join(", ");
}

/** Label one op. Exhaustive over OpSchema's 20 variants. */
export function opLabel(op: Op): string {
  switch (op.type) {
    case "roll":
      return "Roll dice";
    case "endTurn":
      return "End turn";
    case "placeSetupPiece":
      return op.kind === "settlement" ? "Place settlement (setup)" : "Place road (setup)";
    case "buildRoad":
      return "Build road";
    case "buildSettlement":
      return "Build settlement";
    case "buildCity":
      return "Upgrade to city";
    case "buyDevCard":
      return "Buy development card";
    case "playKnight":
      return "Play knight";
    case "claimVictory":
      return "Claim victory";
    case "moveRobber":
      return "Move robber";
    case "stealCard":
      return "Steal a card";
    case "discardSeven":
      return "Discard (7 rolled)";
    case "tradeBank":
      return "Trade with bank";
    case "tradePort":
      return "Trade via port";
    case "tradeOffer":
      return "Offer a trade";
    case "tradeAccept":
      return "Accept trade";
    case "tradeReject":
      return "Reject trade";
    case "playMonopoly":
      return "Play monopoly";
    case "playRoadBuilding":
      return "Play road building";
    case "playYearOfPlenty":
      return "Play year of plenty";
    default: {
      const _never: never = op;
      void _never;
      return "Unknown move";
    }
  }
}

/** Detail line for ops that carry payloads worth showing. */
function opDetail(op: Op): string | undefined {
  switch (op.type) {
    case "buildRoad":
      return op.edgeId;
    case "playRoadBuilding":
      return op.edgeIds.join(" + ");
    case "buildSettlement":
    case "buildCity":
      return op.vertexId;
    case "tradePort":
      return op.portVertexId;
    case "placeSetupPiece":
      return op.kind === "settlement" ? op.vertexId : op.edgeId;
    case "moveRobber":
      return `hex ${op.hexId}`;
    case "stealCard":
      return `from seat ${op.victimSeat}`;
    case "discardSeven":
      return cards(op.cards);
    case "tradeBank":
    case "tradePort":
      return op.offer !== undefined ? `give ${op.offer} → get ${op.demand}` : undefined;
    case "tradeOffer":
      return `seat ${op.with}: give ${list(op.give)} → want ${list(op.want)}`;
    case "playMonopoly":
      return op.resource;
    case "playYearOfPlenty":
      return cards(op.cards);
    default:
      return undefined;
  }
}

/** Stable key so P2 can key buttons without re-deriving identity. */
export function moveKey(op: Op, index: number): string {
  const target =
    ("vertexId" in op && op.vertexId) ||
    ("edgeId" in op && op.edgeId) ||
    ("hexId" in op && op.hexId) ||
    ("portVertexId" in op && op.portVertexId) ||
    ("edgeIds" in op && Array.isArray(op.edgeIds) && op.edgeIds.join("+")) ||
    "";
  return `${op.type}:${String(target)}:${index}`;
}

/** Label a whole legalMoves array (the shape the overlay renders). */
export function labelMoves(moves: readonly Op[]): LabeledMove[] {
  return moves.map((op, i) => {
    const detail = opDetail(op);
    return {
      key: moveKey(op, i),
      op,
      label: opLabel(op),
      ...(detail === undefined ? {} : { detail }),
    };
  });
}
