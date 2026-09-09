ROOM_PORT=4399 ROOM_SEED=20260908 ROOM_PLAYERS=3 node --import tsx/esm src/server-main.ts
# server prints: room MQx61x listening on ws://127.0.0.1:4399 (players=3, seed=20260908)

node --import tsx/esm src/cli.ts --url ws://127.0.0.1:4399 --room MQx61x --seat 0 --name "Hector" --auto --seed 20260908   # -> /tmp/cli_s0.log
node --import tsx/esm src/cli.ts --url ws://127.0.0.1:4399 --room MQx61x --seat 1 --name "Brick"  --auto --seed 20260908   # -> /tmp/cli_s1.log
node --import tsx/esm src/cli.ts --url ws://127.0.0.1:4399 --room MQx61x --seat 2 --name "Wheat"  --auto --seed 20260908   # -> /tmp/cli_s2.log

npm run demo   # parent re-verified: ROOM_PORT=4377 npm tsx src/demo/demo.ts --port 4377 --seed 20260908 --players 3 -> exit 0, winner set = 2, three WINNER lines
