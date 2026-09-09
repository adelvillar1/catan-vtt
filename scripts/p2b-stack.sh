#!/bin/bash
# Start a fresh 3-player stack for one M3-P2(b1) browser proof run.
# Prints the room code on stdout (line 1) so the caller can pass it to node.
set -u
cd /Users/alejandrodelvillar/Projects/catan

pkill -f "server-main" 2>/dev/null
pkill -f "cli.ts" 2>/dev/null
sleep 1

ROOM_PORT=4273 ROOM_SEED=20260908 ROOM_PLAYERS=3 \
  node --import tsx/esm apps/room/src/server-main.ts > /tmp/p2b-room.log 2>&1 &
SRV=$!
sleep 2.5

RC=$(grep -oE "room [A-Za-z0-9]{6}" /tmp/p2b-room.log | head -1 | awk '{print $2}')
if [ -z "$RC" ]; then echo "NO_ROOM_CODE"; cat /tmp/p2b-room.log; exit 1; fi
echo "$RC"

node --import tsx/esm apps/room/src/cli.ts --url ws://127.0.0.1:4273 --room "$RC" \
  --seat 0 --name Bot0 --auto --timeout 900000 --seed 20260908 > /tmp/p2b-bot0.log 2>&1 &
node --import tsx/esm apps/room/src/cli.ts --url ws://127.0.0.1:4273 --room "$RC" \
  --seat 1 --name Bot1 --auto --timeout 900000 --seed 20260908 > /tmp/p2b-bot1.log 2>&1 &
sleep 2
