/**
 * @catan-vtt/shared — CATAN rules kernel.
 *
 * Placeholder index. The rules-kernel plan
 * (docs/plans/2026-09-08-rules-kernel.md) fills this out:
 *   state.ts  setup.ts  actions.ts  turn.ts (applyAction)
 *   validate.ts  scoring.ts  redact.ts
 *
 * Hard rule: applyAction is the ONLY state mutation path.
 * Rules authority: Hermes skill `catan-board-game`.
 */

export const KERNEL_VERSION = "0.0.0-scaffold";
