/**
 * actions.ts — the Op discriminated union (every legal player intent) plus
 * the ActionError surface thrown by applyAction (turn.ts) on illegal ops.
 *
 * Ops are PLAIN JSON (serializable over the wire and into replays), each
 * validated by OpSchema before applyAction touches the state.
 *
 * Turn structure (official 6th Ed): a turn has a production phase
 * (optionally play ≤1 dev card, then roll) followed by an action phase
 * (build/buy, then endTurn). The seven-response ops (discardSeven,
 * moveRobber, stealCard) carry the seat of the DEBTOR or ROLLER, not
 * necessarily state.currentSeat — applyAction checks those seats per-op.
 */
import { z } from "zod";
import { ResourceSchema } from "./state.js";
// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const ActionErrorCodeSchema = z.enum([
  "notYourTurn",
  "wrongPhase",
  "badSeat",
  "vertexOccupied",
  "distanceRule",
  "notConnected",
  "roadBlocked",
  "noEdge",
  "noSettlementsLeft",
  "noRoadsLeft",
  "noCitiesLeft",
  "insufficientHand",
  "insufficientBank",
  "alreadyRolled",
  "notRolledYet",
  "awaitingSeven",
  "wrongDiscardSeat",
  "robberSameHex",
  "noVictim",
  "noOwnSettlementThere",
  "devAlreadyPlayed",
  "noDevCard",
  "deckEmpty",
  "tradePendingExists",
  "noPendingTrade",
  "notTradeCounterparty",
  "tradeSameResource",
  "portResourceMismatch",
  "noPortThere",
  "illegalSetupStage",
  "victoryInsufficient",
  "badOp",
]);
export type ActionErrorCode = z.infer<typeof ActionErrorCodeSchema>;

export class ActionError extends Error {
  readonly code: ActionErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(
    code: ActionErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ActionError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Op schemas
// ---------------------------------------------------------------------------

const SeatSchema = z.number().int().min(0);

const Common = { seat: SeatSchema } as const;

export const PlaceSetupPieceOpSchema = z
  .object({
    type: z.literal("placeSetupPiece"),
    ...Common,
    kind: z.enum(["settlement", "road"]),
    /** Required iff kind === 'settlement'. */
    vertexId: z.string().optional(),
    /** Required iff kind === 'road'. */
    edgeId: z.string().optional(),
  })
  .strict();
export type PlaceSetupPieceOp = z.infer<typeof PlaceSetupPieceOpSchema>;

export const RollOpSchema = z
  .object({ type: z.literal("roll"), ...Common })
  .strict();
export type RollOp = z.infer<typeof RollOpSchema>;

export const DiscardSevenOpSchema = z
  .object({
    type: z.literal("discardSeven"),
    ...Common,
    /** Exactly `count` cards (multiset as an array, order irrelevant). */
    cards: z.array(ResourceSchema).min(1),
  })
  .strict();
export type DiscardSevenOp = z.infer<typeof DiscardSevenOpSchema>;

export const MoveRobberOpSchema = z
  .object({
    type: z.literal("moveRobber"),
    ...Common,
    hexId: z.string(),
  })
  .strict();
export type MoveRobberOp = z.infer<typeof MoveRobberOpSchema>;

export const StealCardOpSchema = z
  .object({
    type: z.literal("stealCard"),
    ...Common,
    victimSeat: SeatSchema,
  })
  .strict();
export type StealCardOp = z.infer<typeof StealCardOpSchema>;

export const BuildRoadOpSchema = z
  .object({ type: z.literal("buildRoad"), ...Common, edgeId: z.string() })
  .strict();
export type BuildRoadOp = z.infer<typeof BuildRoadOpSchema>;

export const BuildSettlementOpSchema = z
  .object({
    type: z.literal("buildSettlement"),
    ...Common,
    vertexId: z.string(),
  })
  .strict();
export type BuildSettlementOp = z.infer<typeof BuildSettlementOpSchema>;

export const BuildCityOpSchema = z
  .object({ type: z.literal("buildCity"), ...Common, vertexId: z.string() })
  .strict();
export type BuildCityOp = z.infer<typeof BuildCityOpSchema>;

export const PlayKnightOpSchema = z
  .object({ type: z.literal("playKnight"), ...Common })
  .strict();
export type PlayKnightOp = z.infer<typeof PlayKnightOpSchema>;

export const EndTurnOpSchema = z
  .object({ type: z.literal("endTurn"), ...Common })
  .strict();
export type EndTurnOp = z.infer<typeof EndTurnOpSchema>;

/**
 * Wave 4: declare victory. Legal any time during your own turn (official:
 * "during your turn" — no hasRolled gate), awaitingSeven must be resolved,
 * and the ledger must total ≥ 10 (VP_TO_WIN).
 */
export const ClaimVictoryOpSchema = z
  .object({ type: z.literal("claimVictory"), ...Common })
  .strict();
export type ClaimVictoryOp = z.infer<typeof ClaimVictoryOpSchema>;

// ---------------------------------------------------------------------------
// Wave 3: trades
// ---------------------------------------------------------------------------

export const TradeBankOpSchema = z
  .object({
    type: z.literal("tradeBank"),
    ...Common,
    offer: ResourceSchema,
    demand: ResourceSchema,
  })
  .strict();
export type TradeBankOp = z.infer<typeof TradeBankOpSchema>;

export const TradePortOpSchema = z
  .object({
    type: z.literal("tradePort"),
    ...Common,
    portVertexId: z.string(),
    offer: ResourceSchema,
    demand: ResourceSchema,
  })
  .strict();
export type TradePortOp = z.infer<typeof TradePortOpSchema>;

export const TradeOfferOpSchema = z
  .object({
    type: z.literal("tradeOffer"),
    ...Common,
    with: SeatSchema,
    give: z.array(ResourceSchema).min(1),
    want: z.array(ResourceSchema).min(1),
  })
  .strict();
export type TradeOfferOp = z.infer<typeof TradeOfferOpSchema>;

export const TradeAcceptOpSchema = z
  .object({ type: z.literal("tradeAccept"), ...Common })
  .strict();
export type TradeAcceptOp = z.infer<typeof TradeAcceptOpSchema>;

export const TradeRejectOpSchema = z
  .object({ type: z.literal("tradeReject"), ...Common })
  .strict();
export type TradeRejectOp = z.infer<typeof TradeRejectOpSchema>;

// ---------------------------------------------------------------------------
// Wave 3: development cards
// ---------------------------------------------------------------------------

export const BuyDevCardOpSchema = z
  .object({ type: z.literal("buyDevCard"), ...Common })
  .strict();
export type BuyDevCardOp = z.infer<typeof BuyDevCardOpSchema>;

export const PlayMonopolyOpSchema = z
  .object({
    type: z.literal("playMonopoly"),
    ...Common,
    resource: ResourceSchema,
  })
  .strict();
export type PlayMonopolyOp = z.infer<typeof PlayMonopolyOpSchema>;

export const PlayRoadBuildingOpSchema = z
  .object({
    type: z.literal("playRoadBuilding"),
    ...Common,
    edgeIds: z.array(z.string()).min(1).max(2),
  })
  .strict();
export type PlayRoadBuildingOp = z.infer<typeof PlayRoadBuildingOpSchema>;

export const PlayYearOfPlentyOpSchema = z
  .object({
    type: z.literal("playYearOfPlenty"),
    ...Common,
    cards: z.tuple([ResourceSchema, ResourceSchema]),
  })
  .strict();
export type PlayYearOfPlentyOp = z.infer<typeof PlayYearOfPlentyOpSchema>;

export const OpSchema = z.discriminatedUnion("type", [
  PlaceSetupPieceOpSchema,
  RollOpSchema,
  DiscardSevenOpSchema,
  MoveRobberOpSchema,
  StealCardOpSchema,
  BuildRoadOpSchema,
  BuildSettlementOpSchema,
  BuildCityOpSchema,
  PlayKnightOpSchema,
  EndTurnOpSchema,
  ClaimVictoryOpSchema,
  TradeBankOpSchema,
  TradePortOpSchema,
  TradeOfferOpSchema,
  TradeAcceptOpSchema,
  TradeRejectOpSchema,
  BuyDevCardOpSchema,
  PlayMonopolyOpSchema,
  PlayRoadBuildingOpSchema,
  PlayYearOfPlentyOpSchema,
]);
export type Op = z.infer<typeof OpSchema>;
