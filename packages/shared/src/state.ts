/**
 * state.ts — zod state schema for the CATAN rules kernel.
 *
 * Every schema exports both the zod validator and its inferred type.
 * State is PLAIN JSON ONLY: no class instances, no functions, no Maps/Sets.
 * Serialization (save/replay/network) is therefore just JSON.stringify.
 *
 * Hard rule (AGENTS.md): applyAction is the ONLY mutation path. These
 * schemas describe the shape; they do not enforce legality of transitions.
 */
import { z } from "zod";
import type { IslandTopology } from "./board.js";

// ---------------------------------------------------------------------------
// Resources & terrain
// ---------------------------------------------------------------------------

export const ResourceSchema = z.enum([
  "wood",
  "brick",
  "wool",
  "wheat",
  "ore",
]);
export type Resource = z.infer<typeof ResourceSchema>;

export const TerrainSchema = z.enum([
  "forest",
  "hills",
  "pasture",
  "fields",
  "mountains",
  "desert",
]);
export type Terrain = z.infer<typeof TerrainSchema>;

const TERRAIN_RESOURCE: Record<Terrain, Resource | null> = {
  forest: "wood",
  hills: "brick",
  pasture: "wool",
  fields: "wheat",
  mountains: "ore",
  desert: null,
};

/** Resource produced by a terrain, or null for desert. */
export function terrainResource(t: Terrain): Resource | null {
  return TERRAIN_RESOURCE[t];
}

// ---------------------------------------------------------------------------
// Development cards
// ---------------------------------------------------------------------------

export const DevCardTypeSchema = z.enum([
  "knight",
  "victoryPoint",
  "monopoly",
  "roadBuilding",
  "yearOfPlenty",
]);
export type DevCardType = z.infer<typeof DevCardTypeSchema>;

/** Official base-game deck composition: 25 cards. */
export const DECK_COMPOSITION: Record<DevCardType, number> = {
  knight: 14,
  victoryPoint: 5,
  monopoly: 2,
  roadBuilding: 2,
  yearOfPlenty: 2,
};

// ---------------------------------------------------------------------------
// Ports, slots, number discs
// ---------------------------------------------------------------------------

export const PortTypeSchema = z.union([ResourceSchema, z.literal("generic")]);
export type PortType = z.infer<typeof PortTypeSchema>;

export const NumberDiscSchema = z.number().int().min(2).max(12);
export type NumberDisc = z.infer<typeof NumberDiscSchema>;

export const SlotSchema = z
  .object({
    hexId: z.string(),
    terrain: TerrainSchema,
    /** null on the desert (and only the desert). */
    numberDisc: NumberDiscSchema.nullable(),
  })
  .strict();
export type Slot = z.infer<typeof SlotSchema>;

export const PortSchema = z
  .object({
    vertexId: z.string(),
    type: PortTypeSchema,
  })
  .strict();
export type Port = z.infer<typeof PortSchema>;

// ---------------------------------------------------------------------------
// Config (the board layout chosen at setup; immutable for the game)
// ---------------------------------------------------------------------------

export const GameConfigSchema = z
  .object({
    slots: SlotSchema.array().length(19),
    ports: PortSchema.array().length(9),
    // DECISION: topology is typed-but-not-validated (z.unknown cast). Full
    // structural validation of the 19/72/54 topology lives in board.test.ts
    // against buildIsland(); re-walking ~250 refs through zod on every state
    // parse is pure overhead since topology is built once and never mutates.
    topology: z.unknown() as z.ZodType<IslandTopology>,
  })
  .strict();
export type GameConfig = z.infer<typeof GameConfigSchema>;

// ---------------------------------------------------------------------------
// Player state
// ---------------------------------------------------------------------------

/** Five-key resource counter (explicit keys, strict — NOT a free record). */
const ResourceCounterSchema = z
  .object({
    wood: z.number().int().min(0),
    brick: z.number().int().min(0),
    wool: z.number().int().min(0),
    wheat: z.number().int().min(0),
    ore: z.number().int().min(0),
  })
  .strict();
export type ResourceCounter = z.infer<typeof ResourceCounterSchema>;

export const PlayerStateSchema = z
  .object({
    seat: z.number().int(),
    name: z.string(),
    color: z.string(),
    hand: ResourceCounterSchema,
    devHand: z.array(DevCardTypeSchema),
    devPlayedThisTurn: z.boolean(),
    /**
     * Wave 3: the dev card drawn by buyDevCard this turn (null otherwise).
     * The bought card may not be played the same turn; with duplicates, an
     * identical OLDER card may be played instead. Cleared at endTurn by the
     * completing seat. Defaulted so pre-wave-3 state literals still parse.
     */
    devBoughtLast: z.nullable(DevCardTypeSchema).default(null),
    roadsLeft: z.number().int().min(0),
    settlementsLeft: z.number().int().min(0),
    citiesLeft: z.number().int().min(0),
    knightsPlayed: z.number().int().min(0),
  })
  .strict();
export type PlayerState = z.infer<typeof PlayerStateSchema>;

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

export const PhaseSchema = z.enum(["setup", "play", "ended"]);
export type Phase = z.infer<typeof PhaseSchema>;

export const SetupStageSchema = z
  .object({
    round: z.union([z.literal(1), z.literal(2)]),
    seatQueue: z.array(z.number().int()),
    justPlacedVertex: z.string().nullable(),
  })
  .strict();
export type SetupStage = z.infer<typeof SetupStageSchema>;

export const BuildingSchema = z
  .object({
    kind: z.enum(["settlement", "city"]),
    owner: z.number().int(),
  })
  .strict();
export type Building = z.infer<typeof BuildingSchema>;

export const AwaitingSevenSchema = z
  .object({
    roller: z.number().int(),
    /**
     * true while at least one seat still owes a discardSeven op
     * (discardQueue non-empty). false once all discards are done — and
     * from the start for a knight activation (knights skip discards).
     */
    pendingDiscard: z.boolean(),
    /**
     * true immediately after a roll of 7 or a knight-card activation —
     * the robber move is mandatory and cannot be skipped.
     */
    mustMoveRobber: z.boolean(),
    /**
     * Seats still owing discard cards, in deterministic seat order.
     * Each entry's count = how many cards that seat must discard.
     * Only discardQueue[0].seat may discard next (discardSeven).
     */
    discardQueue: z.array(
      z
        .object({
          seat: z.number().int(),
          count: z.number().int().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type AwaitingSeven = z.infer<typeof AwaitingSevenSchema>;

/**
 * Root game-state schema.
 *
 * applyAction (turn.ts) is the ONLY legal mutator; consumers must treat
 * GameState as immutable.
 */
export const GameStateSchema = z
  .object({
    config: GameConfigSchema,
    phase: PhaseSchema,
    players: PlayerStateSchema.array().min(2).max(4),
    currentSeat: z.number().int(),
    setupStage: SetupStageSchema.nullable(),
    bank: ResourceCounterSchema,
    deck: z.array(DevCardTypeSchema),
    discardPile: z.array(DevCardTypeSchema),
    robberHexId: z.string(),
    buildings: z.record(z.string(), BuildingSchema),
    roads: z.record(z.string(), z.object({ owner: z.number().int() }).strict()),
    longestRoad: z
      .object({
        holder: z.number().int().nullable(),
        length: z.number().int().min(0),
      })
      .strict(),
    largestArmy: z
      .object({
        holder: z.number().int().nullable(),
        count: z.number().int().min(0),
      })
      .strict(),
    hasRolled: z.boolean(),
    /**
     * Wave 3: a live domestic trade offer. Only the CURRENT seat may offer
     * (tradeOffer); only pendingTrade.offeree may tradeAccept/tradeReject.
     * Cleared on accept/reject/endTurn. Frozen (not cleared) while
     * awaitingSeven is non-null — a 7 rolled between offer and accept
     * suspends the offer until the window resolves.
     */
    pendingTrade: z
      .nullable(
        z
          .object({
            offeror: z.number().int(),
            offeree: z.number().int(),
            give: z.array(ResourceSchema).min(1),
            want: z.array(ResourceSchema).min(1),
          })
          .strict(),
      )
      .default(null),
    awaitingSeven: AwaitingSevenSchema.nullable(),
    lastRoll: z.number().int().min(2).max(12).nullable(),
    rollLog: z.array(z.number().int()),
    winner: z.number().int().nullable(),
    finalPoints: z.number().int().nullable(),
    rngSeed: z.number().int(),
    rngCursor: z.number().int().min(0),
    version: z.literal(1),
  })
  .strict();
export type GameState = z.infer<typeof GameStateSchema>;
