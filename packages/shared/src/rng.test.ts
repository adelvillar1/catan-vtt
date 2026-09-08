import { describe, expect, it } from "vitest";
import { Rng, nextU32 } from "./rng.js";

describe("nextU32", () => {
  it("matches the xorshift32 recurrence (13/17/5) computed inline", () => {
    // Independently recompute one step from state 1.
    let x = 1;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    expect(nextU32(1)).toBe(x >>> 0);
  });

  it("returns unsigned 32-bit values", () => {
    let s = 0xdeadbeef;
    for (let i = 0; i < 100; i++) {
      s = nextU32(s);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(s)).toBe(true);
    }
  });
});

describe("Rng determinism", () => {
  it("same seed → identical 10,000-int sequence", () => {
    const a = Rng.create(12345);
    const b = Rng.create(12345);
    for (let i = 0; i < 10_000; i++) {
      expect(a.int(1_000_000)).toBe(b.int(1_000_000));
    }
  });

  it("different seeds diverge quickly", () => {
    const a = Rng.create(1);
    const b = Rng.create(2);
    let differences = 0;
    for (let i = 0; i < 100; i++) {
      if (a.int(1_000_000) !== b.int(1_000_000)) differences++;
    }
    expect(differences).toBeGreaterThan(90);
  });

  it("seed 0 is not stuck (fallback state applied)", () => {
    const rng = Rng.create(0);
    const seen = new Set<number>();
    for (let i = 0; i < 100; i++) seen.add(rng.int(1_000_000));
    expect(seen.size).toBeGreaterThan(90);
  });
});

describe("Rng snapshot / restore", () => {
  it("continuation after restore is identical to an uninterrupted run", () => {
    const straight = Rng.create(777);
    const prefix: number[] = [];
    for (let i = 0; i < 500; i++) prefix.push(straight.int(52));
    const snap = straight.snapshot();
    const restored = Rng.restore(snap);
    for (let i = 0; i < 500; i++) {
      expect(restored.int(52)).toBe(straight.int(52));
    }
    expect(prefix.length).toBe(500);
  });

  it("restore from cursor 0 reproduces the full sequence", () => {
    const a = Rng.create(42);
    const snap = a.snapshot();
    expect(snap).toEqual({ seed: 42, cursor: 0 });
    const b = Rng.restore(snap);
    for (let i = 0; i < 1_000; i++) expect(a.int(6)).toBe(b.int(6));
  });
});

describe("Rng shuffle", () => {
  it("returns a permutation and does not mutate the input", () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    const frozen = input.slice();
    const out = Rng.create(9).shuffle(input);
    expect(input).toEqual(frozen);
    expect(out.slice().sort((x, y) => x - y)).toEqual(frozen);
    expect(out).not.toBe(input);
  });

  it("is deterministic for a given seed and consumes exactly arr.length draws", () => {
    const input = Array.from({ length: 12 }, (_, i) => i);
    const a = Rng.create(555);
    const b = Rng.create(555);
    expect(a.shuffle(input)).toEqual(b.shuffle(input));
    expect(a.snapshot().cursor).toBe(input.length);
  });

  it("empty and singleton arrays are stable", () => {
    const rng = Rng.create(1);
    expect(rng.shuffle([])).toEqual([]);
    expect(rng.shuffle([7])).toEqual([7]);
  });
});

describe("Rng distribution", () => {
  it("int(6) over 20k draws is within ±2.5% of 1/6 per bucket", () => {
    const rng = Rng.create(2026);
    const counts = new Array(6).fill(0);
    const N = 20_000;
    for (let i = 0; i < N; i++) counts[rng.int(6)]++;
    const expected = N / 6;
    for (const c of counts) {
      expect(Math.abs(c - expected) / expected).toBeLessThanOrEqual(0.025);
    }
  });

  it("int throws on non-positive or non-integer bounds", () => {
    const rng = Rng.create(1);
    expect(() => rng.int(0)).toThrow(RangeError);
    expect(() => rng.int(-3)).toThrow(RangeError);
    expect(() => rng.int(2.5)).toThrow(RangeError);
  });
});
