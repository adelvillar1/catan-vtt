/**
 * server-main.ts — `npm start` entry for the CATAN room server.
 *
 * Env: ROOM_PORT (default 4273) · ROOM_SEED (default: crypto random) ·
 *      ROOM_PLAYERS (3|4, default 3). Prints the room code + port, then
 *      serves until SIGINT/SIGTERM.
 */
import { startServer } from "./server.js";

const port = Number(process.env["ROOM_PORT"] ?? 4273);
const seedEnv = process.env["ROOM_SEED"];
const players = Number(process.env["ROOM_PLAYERS"] ?? 3);

const { server, roomCode } = await startServer({
  port,
  ...(seedEnv === undefined ? {} : { seed: Number(seedEnv) }),
  playerCount: players === 4 ? 4 : 3,
});

console.log(`room ${roomCode} listening on ws://127.0.0.1:${port} (players=${players === 4 ? 4 : 3}, seed=${server.seed})`);
console.log(`clients: node --import tsx/esm src/cli.ts --url ws://127.0.0.1:${port} --room ${roomCode} --auto`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void server.close().then(() => process.exit(0));
  });
}
