/**
 * @catan-vtt/shared — CATAN rules kernel.
 *
 * Hard rule (AGENTS.md): applyAction is the ONLY state mutation path.
 * Rules authority: Hermes skill `catan-board-game`.
 */

export * from "./rng.js";
export * from "./board.js";
export * from "./state.js";
export * from "./setup.js";
export * from "./actions.js";
export * from "./road.js";
export * from "./turn.js";

export const KERNEL_VERSION = "0.2.0";
