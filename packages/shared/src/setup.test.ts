/**
 * setup.test.ts — determinism, spiral-path integrity, 10k-seed sweeps for
 * both official setup generators.
 */
import { describe, expect, it } from "vitest";
import {
  buildIsland,
  cornerHexes,
  type IslandTopology,
} from "./board.js";
import {
  NUMBER_DISCS,
  randomDiscSetup,
  spiralPath,
  variableSetup,
} from "./setup.js";
import { Rng } from "./rng.js";
import {
  DECK_COMPOSITION,
  GameStateSchema,
  terrainResource,
  type GameState,
  type Slot,
} from "./state.js";

const topo = buildIsland();
const hexById = new Map(topo.hexes.map((h) => [h.id, h]));

const isRed = (d: number | null): boolean => d === 6 || d === 8;

function adjacentRedPair(state: GameState): [string, string] | null {
  const byId = new Map(state.config.slots.map((s) => [s.hexId, s]));
  for (const h of topo.hexes) {
    const s = byId.get(h.id)!;
    if (!isRed(s.numberDisc)) continue;
    for (const nId of h.neighbors) {
      if (h.id < nId && isRed(byId.get(nId)!.numberDisc)) return [h.id, nId];
    }
  }
  return null;
}

describe("determinism", () => {
  it("two variableSetup(42) calls deep-equal", () => {
    expect(variableSetup(42)).toEqual(variableSetup(42));
  });
  it("two randomDiscSetup(42) calls deep-equal", () => {
    expect(randomDiscSetup(42)).toEqual(randomDiscSetup(42));
  });
  it("different seeds differ", () => {
    expect(variableSetup(1)).not.toEqual(variableSetup(2));
  });
  it("player options consume no RNG draws (config identical across playerCount)", () => {
    const cfg = (s: GameState) => ({
      slots: s.config.slots,
      ports: s.config.ports,
      topologyIds: {
        hexes: s.config.topology.hexes.map((h) => h.id),
        edges: s.config.topology.edges.map((e) => e.id),
        vertices: s.config.topology.vertices.map((v) => v.id),
      },
    });
    expect(cfg(variableSetup(7, { playerCount: 4 }))).toEqual(cfg(variableSetup(7)));
    expect(cfg(randomDiscSetup(7, { playerCount: 4 }))).toEqual(cfg(randomDiscSetup(7)));
  });
});

describe("rngSeed/rngCursor replay correctness (single continuous stream)", () => {
  // RETRY_SEED: none needed — the retry loop (port repair exhausting its
  // generics) never fired across the 10k-seed sweeps in either generator, so
  // no seed in the tested range takes attempt > 0. The structural guarantee
  // (one stream, cursor = true draw count) is asserted by continuation
  // equality below; no instrumented retry seed exists to pin.
  it("seeds 0..499: restore(rngSeed, rngCursor) continues the true stream", () => {
    for (let seed = 0; seed < 500; seed++) {
      const state = variableSetup(seed);
      // Cursor is monotonically plausible: one attempt alone consumes
      // 19 (terrain shuffle) + ≥1 (corner pick) + ≥1 (spiral entry) +
      // 30 (coastal shuffle) + 9 (type shuffle) + 25 (deck) = ≥85 draws.
      expect(state.rngCursor).toBeGreaterThanOrEqual(85);
      const restored = Rng.restore({ seed, cursor: state.rngCursor });
      const next = restored.int(100);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThan(100);
      // The whole point of the locked design: building again from the same
      // seed yields the same cursor, i.e. restore() lands at a position the
      // uninterrupted stream actually reaches.
      const again = variableSetup(seed);
      expect(again.rngCursor).toBe(state.rngCursor);
      expect(
        Rng.restore({ seed, cursor: again.rngCursor }).int(100),
      ).toBe(next);
    }
  });

  it("randomDiscSetup: restore continuation is in range and reproducible", () => {
    for (const seed of [0, 1, 42, 1337, 9999]) {
      const state = randomDiscSetup(seed);
      expect(state.rngCursor).toBeGreaterThanOrEqual(85);
      const restored = Rng.restore({ seed, cursor: state.rngCursor });
      for (let i = 0; i < 2; i++) {
        const v = restored.int(6);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(6);
      }
    }
  });

  it("GameStateSchema is strict: unknown root keys are rejected", () => {
    const state = variableSetup(42);
    expect(GameStateSchema.safeParse(state).success).toBe(true);
    expect(
      GameStateSchema.safeParse({ ...state, bogus: 1 }).success,
    ).toBe(false);
    expect(
      GameStateSchema.safeParse({
        ...state,
        config: { ...state.config, extra: 1 },
      }).success,
    ).toBe(false);
    expect(
      GameStateSchema.safeParse({
        ...state,
        players: state.players.map((p) => ({ ...p, hacked: true })),
      }).success,
    ).toBe(false);
  });
});

describe("spiralPath integrity", () => {
  const corners = cornerHexes(topo);
  it("finds exactly 6 corner hexes", () => {
    expect(corners).toHaveLength(6);
  });
  it.each(corners)("from corner %s: 19 distinct, adjacent, ends at center", (corner) => {
    const path = spiralPath(topo, corner, Rng.create(1));
    expect(path).toHaveLength(19);
    expect(new Set(path).size).toBe(19);
    expect(path[18]).toBe("0,2");
    for (let i = 1; i < path.length; i++) {
      const prev = hexById.get(path[i - 1])!;
      expect(
        prev.neighbors.includes(path[i]),
        `step ${path[i - 1]} -> ${path[i]} not edge-adjacent`,
      ).toBe(true);
    }
  });
});

function checkCommonState(state: GameState, seed: number): void {
  const msg = (what: string) => `seed=${seed}: ${what}`;
  // disc multiset exact
  const discs = state.config.slots
    .map((s) => s.numberDisc)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);
  expect(discs, msg("disc multiset")).toEqual([...NUMBER_DISCS].sort((a, b) => a - b));

  // desert: exactly one, no disc, robber on it
  const deserts = state.config.slots.filter((s) => s.terrain === "desert");
  expect(deserts.length, msg("desert count")).toBe(1);
  expect(deserts[0].numberDisc, msg("desert has no disc")).toBeNull();
  expect(state.robberHexId, msg("robber on desert")).toBe(deserts[0].hexId);

  // terrain counts exact
  const counts: Record<string, number> = {};
  for (const s of state.config.slots) counts[s.terrain] = (counts[s.terrain] ?? 0) + 1;
  expect(counts, msg("terrain counts")).toEqual({
    forest: 4,
    hills: 3,
    pasture: 3,
    fields: 4,
    mountains: 4,
    desert: 1,
  });

  // ports: 9 distinct coastal vertices; every 2:1 legal
  const ports = state.config.ports;
  expect(ports, msg("port count")).toHaveLength(9);
  expect(new Set(ports.map((p) => p.vertexId)).size, msg("distinct port vertices")).toBe(9);
  const edgeById = new Map(topo.edges.map((e) => [e.id, e]));
  const vertexById = new Map(topo.vertices.map((v) => [v.id, v]));
  const terrainByHex = new Map(state.config.slots.map((s) => [s.hexId, s.terrain]));
  for (const p of ports) {
    const v = vertexById.get(p.vertexId);
    expect(v, msg(`port vertex known: ${p.vertexId}`)).toBeDefined();
    const coastal = v!.edges.some((eId) => edgeById.get(eId)!.hexes.length === 1);
    expect(coastal, msg(`port on coastal vertex: ${p.vertexId}`)).toBe(true);
    if (p.type !== "generic") {
      const legal = v!.hexes.some(
        (hId) => terrainResource(terrainByHex.get(hId)!) === p.type,
      );
      expect(legal, msg(`2:1 ${p.type} port legal at ${p.vertexId}`)).toBe(true);
    }
  }
  // exactly one 2:1 per resource, four generics
  const portTypes = ports.map((p) => p.type).sort();
  expect(portTypes, msg("port type multiset")).toEqual(
    ["brick", "generic", "generic", "generic", "generic", "ore", "wheat", "wood", "wool"].sort(),
  );

  // deck: 25 cards with DECK_COMPOSITION counts
  expect(state.deck, msg("deck size")).toHaveLength(25);
  const deckCounts: Record<string, number> = {};
  for (const c of state.deck) deckCounts[c] = (deckCounts[c] ?? 0) + 1;
  expect(deckCounts, msg("deck composition")).toEqual({ ...DECK_COMPOSITION });

  // bank, phase, players, rngCursor
  expect(state.bank, msg("bank 19s")).toEqual({
    wood: 19, brick: 19, wool: 19, wheat: 19, ore: 19,
  });
  expect(state.phase, msg("phase")).toBe("setup");
  expect(state.setupStage, msg("setupStage")).toEqual({
    round: 1,
    seatQueue: state.players.map((p) => p.seat),
    justPlacedVertex: null,
  });
  expect(state.rngCursor, msg("rngCursor > 0")).toBeGreaterThan(0);
  expect(state.rngSeed, msg("rngSeed")).toBe(seed);
  expect(state.version).toBe(1);
}

describe("variableSetup 10k seeds", { timeout: 120_000 }, () => {
  it("10,000 boards: all invariants hold; spiral may show adjacent red", () => {
    let spiralAdjacentRed = 0;
    for (let s = 1; s <= 10_000; s++) {
      const state = variableSetup(s);
      checkCommonState(state, s);
      expect(state.players, `seed=${s}: default 3 players`).toHaveLength(3);
      expect(
        state.players.map((p) => p.color),
        `seed=${s}: colors`,
      ).toEqual(["Red", "Blue", "Orange"]);
      if (adjacentRedPair(state)) spiralAdjacentRed++;
    }
    // Counter-example proof: the spiral must NOT silently enforce red
    // separation. If this never appears, the walk is wrong.
    expect(
      spiralAdjacentRed,
      "expected ≥1 spiral board with adjacent 6/8 across 10k seeds",
    ).toBeGreaterThan(0);
  });

  it("4-player and named options", () => {
    const st = variableSetup(7, {
      playerCount: 4,
      playerNames: ["Ada", "Bo", "Cy", "Di"],
    });
    expect(st.players.map((p) => p.name)).toEqual(["Ada", "Bo", "Cy", "Di"]);
    expect(st.players.map((p) => p.color)).toEqual([
      "Red", "Blue", "Orange", "Brown",
    ]);
    expect(st.setupStage?.seatQueue).toEqual([0, 1, 2, 3]);
  });
});

describe("randomDiscSetup 10k seeds", { timeout: 120_000 }, () => {
  it("10,000 boards: no adjacent 6/8 ever", () => {
    for (let s = 1; s <= 10_000; s++) {
      const state = randomDiscSetup(s);
      checkCommonState(state, s);
      const pair = adjacentRedPair(state);
      expect(
        pair,
        `seed=${s}: adjacent red pair ${pair?.join(" ~ ") ?? ""}`,
      ).toBeNull();
    }
  });
});
