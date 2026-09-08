/**
 * state.test.ts — schema-level tests. No cross-file deps (imports only from
 * state.js) so this suite can run before sibling modules land.
 */
import { describe, expect, it } from "vitest";
import {
  DECK_COMPOSITION,
  DevCardTypeSchema,
  GameStateSchema,
  NumberDiscSchema,
  PlayerStateSchema,
  PortTypeSchema,
  ResourceSchema,
  SlotSchema,
  TerrainSchema,
  terrainResource,
  type DevCardType,
  type GameState,
  type PlayerState,
} from "./state.js";

describe("ResourceSchema / TerrainSchema", () => {
  it("accepts exactly the 5 resources", () => {
    for (const r of ["wood", "brick", "wool", "wheat", "ore"]) {
      expect(ResourceSchema.parse(r)).toBe(r);
    }
    expect(ResourceSchema.safeParse("sheep").success).toBe(false);
    expect(ResourceSchema.safeParse("gold").success).toBe(false);
  });

  it("terrainResource maps terrains per official base game", () => {
    expect(terrainResource("forest")).toBe("wood");
    expect(terrainResource("hills")).toBe("brick");
    expect(terrainResource("pasture")).toBe("wool");
    expect(terrainResource("fields")).toBe("wheat");
    expect(terrainResource("mountains")).toBe("ore");
    expect(terrainResource("desert")).toBeNull();
    // total producing terrains check
    expect(TerrainSchema.options).toHaveLength(6);
  });
});

describe("DevCardTypeSchema / DECK_COMPOSITION", () => {
  it("accepts exactly the 5 dev card types", () => {
    const types: DevCardType[] = [
      "knight",
      "victoryPoint",
      "monopoly",
      "roadBuilding",
      "yearOfPlenty",
    ];
    for (const t of types) expect(DevCardTypeSchema.parse(t)).toBe(t);
    expect(DevCardTypeSchema.safeParse("soldier").success).toBe(false);
  });

  it("deck composition is the official 25-card base deck", () => {
    expect(DECK_COMPOSITION).toEqual({
      knight: 14,
      victoryPoint: 5,
      monopoly: 2,
      roadBuilding: 2,
      yearOfPlenty: 2,
    });
    const total = Object.values(DECK_COMPOSITION).reduce((a, b) => a + b, 0);
    expect(total).toBe(25);
    // keys of composition cover every dev card type
    expect(Object.keys(DECK_COMPOSITION).sort()).toEqual(
      [...DevCardTypeSchema.options].sort(),
    );
  });
});

describe("NumberDiscSchema / PortTypeSchema / SlotSchema", () => {
  it("number discs are ints 2..12", () => {
    expect(NumberDiscSchema.safeParse(2).success).toBe(true);
    expect(NumberDiscSchema.safeParse(12).success).toBe(true);
    expect(NumberDiscSchema.safeParse(1).success).toBe(false);
    expect(NumberDiscSchema.safeParse(13).success).toBe(false);
    expect(NumberDiscSchema.safeParse(6.5).success).toBe(false);
  });

  it("port type is a resource or 'generic'", () => {
    expect(PortTypeSchema.parse("generic")).toBe("generic");
    expect(PortTypeSchema.parse("ore")).toBe("ore");
    expect(PortTypeSchema.safeParse("2:1").success).toBe(false);
  });

  it("slot numberDisc is nullable", () => {
    expect(
      SlotSchema.parse({ hexId: "0,2", terrain: "desert", numberDisc: null })
        .numberDisc,
    ).toBeNull();
    expect(
      SlotSchema.safeParse({
        hexId: "0,2",
        terrain: "forest",
        numberDisc: undefined,
      }).success,
    ).toBe(false);
  });
});

const VALID_PLAYER: PlayerState = {
  seat: 0,
  name: "Ada",
  color: "Red",
  hand: { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 },
  devHand: [],
  devPlayedThisTurn: false,
  devBoughtThisTurn: {
    knight: 0,
    victoryPoint: 0,
    monopoly: 0,
    roadBuilding: 0,
    yearOfPlenty: 0,
  },
  roadsLeft: 15,
  settlementsLeft: 5,
  citiesLeft: 4,
  knightsPlayed: 0,
};

describe("PlayerStateSchema", () => {
  it("accepts a full valid player literal", () => {
    expect(PlayerStateSchema.parse(VALID_PLAYER)).toEqual(VALID_PLAYER);
  });

  it("rejects negative piece counts and bad hand keys", () => {
    expect(
      PlayerStateSchema.safeParse({ ...VALID_PLAYER, roadsLeft: -1 }).success,
    ).toBe(false);
    expect(
      PlayerStateSchema.safeParse({
        ...VALID_PLAYER,
        hand: { wood: 0, brick: 0, wool: 0, wheat: 0 }, // missing ore
      }).success,
    ).toBe(false);
    expect(
      PlayerStateSchema.safeParse({
        ...VALID_PLAYER,
        hand: { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0, gold: 1 },
      }).success,
    ).toBe(false);
  });
});

function minimalGameState(overrides: Partial<GameState> = {}): unknown {
  const slot = { hexId: "0,0", terrain: "desert", numberDisc: null };
  const port = { vertexId: "v0", type: "generic" };
  return {
    config: {
      slots: Array(19).fill(slot),
      ports: Array(9).fill(port),
      topology: {},
    },
    phase: "setup",
    players: [VALID_PLAYER, { ...VALID_PLAYER, seat: 1, color: "Blue" }],
    currentSeat: 0,
    setupStage: { round: 1, seatQueue: [0, 1], justPlacedVertex: null },
    bank: { wood: 19, brick: 19, wool: 19, wheat: 19, ore: 19 },
    deck: [],
    discardPile: [],
    robberHexId: "0,0",
    buildings: {},
    roads: {},
    longestRoad: { holder: null, length: 0 },
    largestArmy: { holder: null, count: 0 },
    hasRolled: false,
    awaitingSeven: null,
    lastRoll: null,
    rollLog: [],
    winner: null,
    finalPoints: null,
    rngSeed: 1,
    rngCursor: 0,
    version: 1,
    ...overrides,
  };
}

describe("GameStateSchema", () => {
  it("accepts a minimal valid state", () => {
    expect(GameStateSchema.safeParse(minimalGameState()).success).toBe(true);
  });

  it("rejects a bogus phase string", () => {
    expect(
      GameStateSchema.safeParse(minimalGameState({ phase: "midgame" as never }))
        .success,
    ).toBe(false);
  });

  it("rejects a 20-slot config", () => {
    const bad = minimalGameState() as { config: { slots: unknown[] } };
    bad.config.slots = Array(20).fill(bad.config.slots[0]);
    expect(GameStateSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects wrong version and 5 players", () => {
    const badVersion = minimalGameState() as Record<string, unknown>;
    badVersion.version = 2;
    expect(GameStateSchema.safeParse(badVersion).success).toBe(false);

    const five = minimalGameState() as { players: unknown[] };
    five.players = [
      ...five.players,
      { ...VALID_PLAYER, seat: 2 },
      { ...VALID_PLAYER, seat: 3 },
      { ...VALID_PLAYER, seat: 4 },
    ];
    expect(GameStateSchema.safeParse(five).success).toBe(false);
  });

  it("rejects setupStage with round 3 and lastRoll out of range", () => {
    const bad1 = minimalGameState() as Record<string, unknown>;
    bad1.setupStage = { round: 3, seatQueue: [0], justPlacedVertex: null };
    expect(GameStateSchema.safeParse(bad1).success).toBe(false);

    const bad2 = minimalGameState() as Record<string, unknown>;
    bad2.lastRoll = 1;
    expect(GameStateSchema.safeParse(bad2).success).toBe(false);
  });
});
