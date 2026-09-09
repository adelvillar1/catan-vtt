/**
 * useRoom.ts — the table's ONLY door to the room server.
 *
 * Wire discipline (copied from apps/room/src/cli.ts, which is the working
 * reference client):
 *  - every inbound frame → ServerMsgSchema.safeParse (via routeRawFrame);
 *    a violation is console.error + close + status "error", never a shrug;
 *  - the client NEVER computes legality. It renders the server's legalMoves
 *    and sends ops verbatim. No import of applyAction / legalMoves /
 *    redactForSeat anywhere in apps/table (plan AC3, grep-provable).
 *
 * seatToken lives in localStorage keyed by room code and is OVERWRITTEN on
 * every welcome — the server rotates it on each join/rejoin.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GameState, Op } from "@catan-vtt/shared";
import {
  buildJoinMessage,
  buildOpMessage,
  clearSeatToken,
  encodeClientMessage,
  initialRoomState,
  readSeatToken,
  routeRawFrame,
  storeSeatToken,
  type JoinRequest,
  type RoomState,
} from "./adapter.js";

export const DEFAULT_ROOM_URL = "ws://localhost:4273";

export interface UseRoom {
  /** Live room state (welcome / projection / legalMoves / events / error). */
  room: RoomState;
  /** Convenience views used by the overlay. */
  state: GameState | null;
  legalMoves: Op[];
  seat: number | null;
  /** Open the socket and send a join. No-op once a socket is live. */
  connect(req: JoinRequest): void;
  /** Send an op. Requires a projection (never acts on a stale/absent move list). */
  sendOp(op: Op): void;
  /** Close the socket and drop back to idle. */
  disconnect(): void;
  /** URL actually in use (VITE_ROOM_URL ?? default). */
  url: string;
}

/**
 * Open a single WebSocket to the room server.
 *
 * One socket per hook instance; the room server allows exactly one join per
 * socket, so a rejoin means a new socket (or a fresh mount).
 */
export function useRoom(roomUrl?: string): UseRoom {
  const url = useMemo(
    () => roomUrl ?? import.meta.env.VITE_ROOM_URL ?? DEFAULT_ROOM_URL,
    [roomUrl],
  );
  const [room, setRoom] = useState<RoomState>(initialRoomState);
  const wsRef = useRef<WebSocket | null>(null);
  /** Room code of the live socket, so we can clear its token on teardown. */
  const roomCodeRef = useRef<string | null>(null);

  const disconnect = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close(1000, "client disconnect");
    }
    setRoom((prev) => ({ ...prev, status: "closed" }));
  }, []);

  const connect = useCallback(
    (req: JoinRequest) => {
      if (wsRef.current) return; // already live — one join per socket
      setRoom((prev) => ({ ...prev, status: "connecting", error: null, fatal: false }));

      // Rotation-aware: reuse the stored token if the caller didn't supply one.
      const stored = req.seatToken ?? safeReadSeatToken(req.roomCode);
      const joinReq: JoinRequest = { ...req, ...(stored ? { seatToken: stored } : {}) };

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        setRoom((prev) => ({
          ...prev,
          status: "error",
          error: { code: "socket", message: `connect failed: ${String(err)}` },
        }));
        return;
      }
      wsRef.current = ws;
      roomCodeRef.current = req.roomCode;

      ws.addEventListener("open", () => {
        setRoom((prev) => ({ ...prev, status: "joining" }));
        ws.send(encodeClientMessage(buildJoinMessage(joinReq)));
      });

      ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
        const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
        setRoom((prev) => {
          const next = routeRawFrame(prev, raw);
          if (next.fatal) {
            // Parse-or-die: log, then close. Same reflex as cli.ts #die().
            console.error(`[useRoom] fatal frame — closing socket. ${next.error?.message ?? ""}`);
            queueMicrotask(() => ws.close(4002, "bad frame"));
          }
          // Persist the (rotated) token on every welcome.
          if (next.welcome?.seatToken && next.welcome.roomCode) {
            safeStoreSeatToken(next.welcome.roomCode, next.welcome.seatToken);
          }
          return next;
        });
      });

      ws.addEventListener("error", () => {
        setRoom((prev) => ({
          ...prev,
          status: "error",
          error: { code: "socket", message: `socket error on ${url}` },
        }));
      });

      ws.addEventListener("close", (ev: CloseEvent) => {
        wsRef.current = null;
        setRoom((prev) => ({
          ...prev,
          status: prev.status === "error" ? prev.status : "closed",
          ...(prev.status === "error"
            ? {}
            : {
                error: prev.error ?? {
                  code: "socket" as const,
                  message: `closed (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ""})`,
                },
              }),
        }));
      });
    },
    [url],
  );

  const sendOp = useCallback((op: Op) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setRoom((prev) => {
      // Never act on a stale/absent move list: ops are only emitted once the
      // server has shipped a projection.
      if (!prev.projection) return prev;
      ws.send(encodeClientMessage(buildOpMessage(op)));
      return prev;
    });
  }, []);

  useEffect(
    () => () => {
      wsRef.current?.close(1000, "unmount");
      wsRef.current = null;
    },
    [],
  );

  return {
    room,
    state: room.projection,
    legalMoves: room.legalMoves,
    seat: room.welcome?.seat ?? null,
    connect,
    sendOp,
    disconnect,
    url,
  };
}

// localStorage is browser-only; guard so a non-DOM import never explodes.
function safeReadSeatToken(roomCode: string): string | null {
  try {
    return readSeatToken(window.localStorage, roomCode);
  } catch {
    return null;
  }
}

function safeStoreSeatToken(roomCode: string, token: string): void {
  try {
    storeSeatToken(window.localStorage, roomCode, token);
  } catch {
    /* storage disabled — rejoin just loses its credential */
  }
}

/** Exported for the UI: drop a stale token when the user leaves a room. */
export function forgetSeatToken(roomCode: string): void {
  try {
    clearSeatToken(window.localStorage, roomCode);
  } catch {
    /* noop */
  }
}
