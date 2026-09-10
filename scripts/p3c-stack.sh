#!/bin/bash
# Start a fresh 3-player stack for ONE M3-P3(c) full-game browser run.
#
# Differences from p2b-stack.sh (which stays untouched):
#   * NO bots — three browser tabs claim seats 0,1,2 and the room starts as
#     soon as every seat is claimed.
#   * It ALSO starts the Vite dev server on :4274 (the demo is one command:
#     `bash scripts/p3c-stack.sh` then `RC=<code> node scripts/m3-fullgame.mjs`).
#   * ROOM_SEED / ROOM_PLAYERS / ROOM_PORT are passthrough env (parent dials).
#
# stdout line 1 = the 6-char room code (the driver needs it as RC=).
# stdout line 2 = READY once the room WS is up AND :4274 answers HTTP 200.
set -u
cd /Users/alejandrodelvillar/Projects/catan

ROOM_PORT="${ROOM_PORT:-4273}"
ROOM_SEED="${ROOM_SEED:-20260908}"
ROOM_PLAYERS="${ROOM_PLAYERS:-3}"

# Scoped to THIS project by the subpath — which appears in the cmdline
# whether the launcher used an absolute or a repo-relative path (a "catan/"
# prefix MISSES relative-form launches, e.g. `cd repo && node ... apps/room/
# src/server-main.ts` — the EADDRINUSE this script once caused).
# -9 because a plain TERM of a tsx child can leave the LISTEN socket held.
pkill -9 -f "apps/room/src/server-main" 2>/dev/null
pkill -9 -f "apps/table.*vite" 2>/dev/null
sleep 1.5

ROOM_PORT="$ROOM_PORT" ROOM_SEED="$ROOM_SEED" ROOM_PLAYERS="$ROOM_PLAYERS" \
  node --import tsx/esm apps/room/src/server-main.ts > /tmp/p3c-room.log 2>&1 &
SRV=$!

# Vite dev server (the P2(b1) sibling deliberately did not start one; the
# full-game demo is three real browser tabs, so the table must be served).
( cd apps/table && npm run dev > /tmp/p3c-dev.log 2>&1 ) &
DEV=$!

sleep 2.5

RC=$(grep -oE "room [A-Za-z0-9]{6}" /tmp/p3c-room.log | head -1 | awk '{print $2}')
if [ -z "$RC" ]; then echo "NO_ROOM_CODE"; cat /tmp/p3c-room.log; exit 1; fi
echo "$RC"

# Wait for the dev server to answer on :4274 (30s cap) before declaring READY.
# Vite binds ::1 (IPv6 loopback) here, so probe localhost, not 127.0.0.1.
for i in $(seq 1 30); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:4274/" 2>/dev/null || true)
  if [ "$CODE" = "200" ]; then
    echo "READY (room $RC on ws://127.0.0.1:$ROOM_PORT seed=$ROOM_SEED players=$ROOM_PLAYERS, table http://127.0.0.1:4274, srv=$SRV dev=$DEV)"
    exit 0
  fi
  sleep 1
done

echo "DEV_NOT_READY"
tail -20 /tmp/p3c-dev.log 2>/dev/null
exit 1
