/**
 * xorshift32 PRNG — deterministic, seeded, serializable.
 *
 * Used by the rules kernel for dice, shuffles, and any other randomness.
 * Determinism is a hard requirement: same seed + same call sequence must
 * produce identical results on every machine, so replays and replays of
 * snapshots are bit-exact. NO Math.random anywhere in this package, ever.
 *
 * All arithmetic is forced into unsigned 32-bit space. The `<<`/`>>>` ops in
 * JS already operate on 32-bit integers; where an intermediate multiplication
 * would be needed we use Math.imul (none required for xorshift32 itself).
 */

export interface RngSnapshot {
  seed: number;
  /** Number of draws consumed since creation (restore replays this many). */
  cursor: number;
}

/**
 * One xorshift32 step. `prev` is treated as an unsigned 32-bit state;
 * returns the next unsigned 32-bit state.
 *
 * Shifts: 13, 17, 5 (Marsaglia's classic triplet).
 */
export function nextU32(prev: number): number {
  let x = prev >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

/** Fallback state when seed is 0 (xorshift32 is stuck at all-zero state). */
const DEFAULT_STATE = 0x6d2b79f5;

export class Rng {
  /** Current internal state (post last draw). */
  private state: number;
  /** Seed as given at creation (after >>>0 normalization), for restore. */
  private readonly seedNorm: number;
  /** Number of draws consumed (warmup draw NOT counted — counts from 0). */
  private cursor: number;

  private constructor(state: number, seedNorm: number, cursor: number) {
    this.state = state;
    this.seedNorm = seedNorm;
    this.cursor = cursor;
  }

  /**
   * Create an RNG from a seed. State = ((seed >>> 0) || DEFAULT_STATE),
   * then one warmup nextU32 step (not counted in the cursor).
   */
  static create(seed: number): Rng {
    const seedNorm = seed >>> 0;
    const initial = (seedNorm || DEFAULT_STATE) >>> 0;
    return new Rng(nextU32(initial), seedNorm, 0);
  }

  /**
   * Draw an integer in [0, maxExclusive). Consumes exactly one draw.
   *
   * NOTE: `state % maxExclusive` has a modulo bias when maxExclusive does not
   * divide 2^32. The bias is at most 1/2^32 per outcome — negligible for v1
   * game use (dice, card picks). If we ever need cryptographic uniformity,
   * switch to rejection sampling here; callers must not assume it.
   */
  int(maxExclusive: number): number {
    if (
      !Number.isInteger(maxExclusive) ||
      maxExclusive <= 0 ||
      maxExclusive > 2 ** 32
    ) {
      throw new RangeError("Rng.int: maxExclusive must be in (0, 2^32]");
    }
    this.state = nextU32(this.state);
    this.cursor += 1;
    return this.state % maxExclusive;
  }

  /** Pick one element. Consumes exactly one draw. */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new RangeError("pick: empty array");
    return arr[this.int(arr.length)];
  }

  /**
   * Fisher-Yates shuffle. Returns a NEW array; input is not mutated.
   *
   * Draw count: exactly arr.length draws are consumed (one int() per index
   * i from arr.length-1 down to 0, including the trivial last draw). Keeping
   * the count fixed at arr.length — rather than the classic arr.length-1 —
   * makes replay/draw accounting trivially predictable.
   */
  shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i >= 0; i--) {
      const j = this.int(i + 1);
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  /** Serializable snapshot: seed + draw count. */
  snapshot(): RngSnapshot {
    return { seed: this.seedNorm, cursor: this.cursor };
  }

  /**
   * Restore by replaying `cursor` draws from the seed. Deterministic and
   * O(cursor) — fine for game-length sequences (thousands of draws).
   */
  static restore(s: RngSnapshot): Rng {
    const rng = Rng.create(s.seed);
    // Replay draws cheaply: advance state without re-validating bounds.
    for (let i = 0; i < s.cursor; i++) {
      rng.state = nextU32(rng.state);
    }
    rng.cursor = s.cursor;
    return rng;
  }
}
