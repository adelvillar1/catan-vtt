/**
 * actions.test.ts — OpSchema round-trip and rejection coverage, ActionError.
 */
import { describe, expect, it } from "vitest";
import {
  ActionError,
  ActionErrorCodeSchema,
  OpSchema,
} from "./actions.js";

describe("OpSchema", () => {
  it("round-trips every op type", () => {
    const ops = [
      { type: "placeSetupPiece", seat: 0, kind: "settlement", vertexId: "v" },
      { type: "placeSetupPiece", seat: 0, kind: "road", edgeId: "e" },
      { type: "roll", seat: 1 },
      { type: "discardSeven", seat: 2, cards: ["wood", "wood", "ore"] },
      { type: "moveRobber", seat: 0, hexId: "0,0" },
      { type: "stealCard", seat: 0, victimSeat: 2 },
      { type: "buildRoad", seat: 1, edgeId: "e1" },
      { type: "buildSettlement", seat: 1, vertexId: "v1" },
      { type: "buildCity", seat: 1, vertexId: "v1" },
      { type: "playKnight", seat: 3 },
      { type: "endTurn", seat: 3 },
    ] as const;
    for (const op of ops) {
      const parsed = OpSchema.parse(op);
      expect(parsed).toEqual(op);
      // JSON-serializable round-trip.
      expect(OpSchema.parse(JSON.parse(JSON.stringify(op)))).toEqual(op);
    }
  });

  it("rejects unknown op types", () => {
    expect(() => OpSchema.parse({ type: "chooseGrant", seat: 0 })).toThrow();
    expect(() => OpSchema.parse({ type: "resign", seat: 0 })).toThrow();
    expect(() => OpSchema.parse({ type: "trade", seat: 0 })).toThrow();
  });

  it("rejects extra keys (strict)", () => {
    expect(() =>
      OpSchema.parse({ type: "roll", seat: 0, sneaky: true }),
    ).toThrow();
  });

  it("rejects bad seats and malformed cards", () => {
    expect(() => OpSchema.parse({ type: "roll", seat: -1 })).toThrow();
    expect(() => OpSchema.parse({ type: "roll", seat: 1.5 })).toThrow();
    expect(() =>
      OpSchema.parse({ type: "discardSeven", seat: 0, cards: ["gold"] }),
    ).toThrow();
    expect(() =>
      OpSchema.parse({ type: "discardSeven", seat: 0, cards: [] }),
    ).toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() => OpSchema.parse({ type: "buildRoad", seat: 0 })).toThrow();
    expect(() =>
      OpSchema.parse({ type: "stealCard", seat: 0 }),
    ).toThrow();
  });
});

describe("ActionError", () => {
  it("carries code, message, details", () => {
    const err = new ActionError("notYourTurn", "nope", { seat: 3 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ActionError");
    expect(err.code).toBe("notYourTurn");
    expect(err.message).toBe("nope");
    expect(err.details).toEqual({ seat: 3 });
    expect(ActionErrorCodeSchema.parse(err.code)).toBe("notYourTurn");
  });

  it("every code in the union parses", () => {
    for (const code of ActionErrorCodeSchema.options) {
      expect(ActionErrorCodeSchema.parse(code)).toBe(code);
    }
  });
});
