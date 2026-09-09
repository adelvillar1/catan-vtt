/**
 * demo.ts — one-command scripted demo: boot a room server in-process, then
 * run N real `cli.ts --auto` clients against it as CHILD PROCESSES (the same
 * wire path a human would use), and report the winner every client printed.
 *
 *   node --import tsx/esm src/demo/demo.ts [--port 4399] [--seed 20260908] [--players 3]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { startServer } from "../server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, "..", "cli.ts");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const port = Number(arg("--port", "4399"));
const seed = Number(arg("--seed", "20260908"));
const players = Number(arg("--players", "3")) === 4 ? 4 : 3;

const { server, roomCode } = await startServer({
  port,
  seed,
  playerCount: players as 3 | 4,
});
console.log(`[demo] room ${roomCode} on ${port} seed=${seed} players=${players}`);

const names = ["Hector", "Brick", "Wheat", "Ore"];
const procs = [];
for (let seat = 0; seat < players; seat++) {
  const p = spawn(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      CLI,
      "--url",
      `ws://127.0.0.1:${port}`,
      "--room",
      roomCode,
      "--seat",
      String(seat),
      "--name",
      names[seat]!,
      "--auto",
      "--seed",
      String(seed),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const tail: string[] = [];
  const keep = (buf: Buffer): void => {
    for (const line of buf.toString().split("\n")) {
      if (!line) continue;
      tail.push(line);
      if (tail.length > 12) tail.shift();
    }
  };
  p.stdout.on("data", keep);
  p.stderr.on("data", keep);
  procs.push({ seat, p, tail });
}

const results = await Promise.all(
  procs.map(
    ({ seat, p, tail }) =>
      new Promise<{ seat: number; code: number | null; tail: string[] }>((resolve) => {
        p.on("exit", (code) => resolve({ seat, code, tail: [...tail] }));
      }),
  ),
);

for (const r of results) {
  console.log(`\n----- client seat ${r.seat} (exit ${r.code}) last lines -----`);
  for (const l of r.tail) console.log(`  s${r.seat}| ${l}`);
}
const winners = new Set(
  results.map((r) => r.tail.find((l) => l.includes("WINNER"))?.match(/seat (\d+)/)?.[1] ?? "?"),
);
console.log(`\n[demo] winner set = ${[...winners].join(",")}`);
await server.close();
process.exit(results.every((r) => r.code === 0) && winners.size === 1 ? 0 : 1);
