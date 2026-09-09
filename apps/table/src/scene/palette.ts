/**
 * palette.ts — terrain + seat colors for the procedural island.
 *
 * Seat colors mirror the kernel's PLAYER_COLORS (packages/shared/src/setup.ts:
 * ["Red", "Blue", "Orange", "Brown"]) so the 3D table and the DOM overlay
 * agree with what the room server reports as player.color.
 */
import type { PortType, Terrain } from "@catan-vtt/shared";

/** Terrain → hex top color. Desert is sand, water is the surrounding plane. */
export const TERRAIN_COLORS: Record<Terrain, string> = {
  forest: "#1f5c33", // dark green
  hills: "#a2452c", // brick red-brown
  pasture: "#7fc45e", // light green
  fields: "#e0b96b", // gold wheat
  mountains: "#8a8f98", // grey
  desert: "#d8c48d", // sand
};

/** Water / frame colors. */
export const WATER_COLOR = "#123a63";
export const TABLE_BG = "#071726";

/** Player colors by seat (matches kernel PLAYER_COLORS naming). */
export const SEAT_COLORS: readonly string[] = ["#d94f3d", "#3d7fd9", "#e08a2e", "#8a5a3b"];

/** Seat → color. Unknown seats fall back to a neutral grey. */
export function seatColor(seat: number): string {
  return SEAT_COLORS[seat] ?? "#9aa0a6";
}

/** Seat → display name of its kernel color. */
export const SEAT_NAMES: readonly string[] = ["Red", "Blue", "Orange", "Brown"];

export function seatName(seat: number): string {
  return SEAT_NAMES[seat] ?? `Seat ${seat}`;
}

/** Port type → marker color (resource-tinted, generic = neutral). */
export const PORT_COLORS: Record<PortType, string> = {
  wood: "#2f7d46",
  brick: "#a2452c",
  wool: "#8fd06f",
  wheat: "#e0b96b",
  ore: "#8a8f98",
  generic: "#c9c4b8",
};

/** Port type → short label ("3:1", "2:1 wood", …). */
export function portLabel(type: PortType): string {
  return type === "generic" ? "3:1" : `2:1 ${type}`;
}

/** Number discs 6 and 8 are red in the real game. */
export function numberTokenColor(disc: number): string {
  return disc === 6 || disc === 8 ? "#c0392b" : "#22201c";
}
