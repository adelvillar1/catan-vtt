/**
 * useRoom.ts — the table's ONLY door to the room server.
 *
 * Wire discipline (copied from apps/room/src/cli.ts, the reference client):
 *  - every inbound frame → ServerMsgSchema.safeParse (via routeRawFrame);
 *    a violation is console.error + close + status "error", never a shrug;
 *  - the client NEVER computes legality. It renders the server's legalMoves
 *    and sends ops verbatim. No applyAction/legalMoves/redactForSeat import
 *    anywhere in apps/table (plan AC3, grep-provable).
 *
 * STATE SHAPE (review I-1): React StrictMode double-invokes updater
 * functions, so ws.send() must NEVER run inside a setRoom(prev => ...)
 * updater — ops would hit the wire twice. The ref is the source of truth:
 * frames are routed against it OUTSIDE React, and setState only mirrors.
 *
 * seatToken lives in localStorage keyed by room code and is OVERWRITTEN on
 * every welcome — the server rotates it on each join/rejoin. "Leave room"
 * forgets it (I-10): you are not planning to rejoin the seat you just left.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GameState, Op } from "@catan-vtt/shared";
import {
  buildJoinMessage,
  buildOpMessage,
  buildRematchMessage,
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
  /**
   * Open a socket (to `req.url ?? hook url`) and join. No-op once a socket
   * is live — the server allows exactly one join per socket. Returns false
   * when nothing was sent (already connected or bad url).
   */
  connect(req: JoinRequest & { url?: string }): boolean;
  /**
   * Send an op. Requires an OPEN socket AND a live projection (never act
   * on a stale/absent move list). Returns false (and warns) when dropped —
   * the UI surfaces it (I-2: no silent drops).
   */
  sendOp(op: Op): boolean;
  /**
   * Ask the room for a fresh game on the same seats (M3-P3(b)). Server-side
   * this is seat 0 + phase "ended" only — a refusal comes back as an
   * error{notHost}/error{badPhase} note and the room keeps running. Returns
   * false (and warns) when nothing was sent, same discipline as sendOp.
   */
  sendRematch(): boolean;
  /** Close the socket, drop the token, and return to idle. */
  disconnect(): void;
  /** URL currently in use (VITE_ROOM_URL ?? default) for display. */
  url: string;
}

export function useRoom(roomUrl?: string): UseRoom {
  const url = useMemo(
    () => roomUrl && roomUrl.trim() !== "" ? roomUrl : import.meta.env.VITE_ROOM_URL ?? DEFAULT_ROOM_URL,
    [roomUrl],
  );
  const [room, setRoom] = useState<RoomState>(initialRoomState);
  const stateRef = useRef<RoomState>(room);
  const wsRef = useRef<WebSocket | null>(null);
  /** Room code of the live socket (for token clearing on leave). */
  const roomCodeRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  mountedRef.current = true;

  /** Mirror the ref into React state (pure setState value, never an updater). */
  const commit = useCallback((next: RoomState): void => {
    stateRef.current = next;
    if (mountedRef.current) setRoom(next);
  }, []);

  const disconnect = useCallback((): void => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (roomCodeRef.current !== null) {
      forgetSeatToken(roomCodeRef.current); // "leave" = not coming back to this seat
      roomCodeRef.current = null;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close(1000, "client disconnect");
    }
    commit({ ...stateRef.current, status: "closed" });
  }, [commit]);

  const connect = useCallback(
    (req: JoinRequest & { url?: string }): boolean => {
      if (wsRef.current !== null) return false; // already live — one join per socket
      const target = req.url && req.url.trim() !== "" ? req.url : url;

      // Rotation-aware: reuse the stored token if the caller didn't supply one.
      const stored = req.seatToken ?? safeReadSeatToken(req.roomCode);
      const { url: _omit, ...joinReq }: JoinRequest & { url?: string } = req;
      void _omit;

      let ws: WebSocket;
      try {
        ws = new WebSocket(target);
      } catch (err) {
        commit({
          ...stateRef.current,
          status: "error",
          error: { code: "socket", message: `connect failed: ${String(err)}` },
        });
        return false;
      }
      commit({ ...stateRef.current, status: "connecting", error: null, fatal: false });
      wsRef.current = ws;
      roomCodeRef.current = req.roomCode;

      ws.addEventListener("open", () => {
        commit({ ...stateRef.current, status: "joining" });
        ws.send(encodeClientMessage(buildJoinMessage({ ...joinReq, ...(stored ? { seatToken: stored } : {}) })));
      });

      ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
        const raw = typeof ev.data === "string" ? String(ev.data) : String(ev.data);
        // Route OUTSIDE the updater: updaters must stay pure (StrictMode).
        const next = routeRawFrame(stateRef.current, raw);
        if (next.fatal) {
          // Parse-or-die: log once, close once. Same reflex as cli.ts #die().
          console.error(`[useRoom] fatal frame — closing socket. ${next.error?.message ?? ""}`);
          ws.close(4002, "bad frame");
        }
        if (next.welcome?.seatToken && next.welcome.roomCode) {
          safeStoreSeatToken(next.welcome.roomCode, next.welcome.seatToken);
        }
        commit(next);
      });

      ws.addEventListener("error", () => {
        commit({
          ...stateRef.current,
          status: "error",
          error: { code: "socket", message: `socket error on ${target}` },
        });
      });

      ws.addEventListener("close", (ev: CloseEvent) => {
        wsRef.current = null;
        const prev = stateRef.current;
        commit({
          ...prev,
          status: prev.status === "error" ? prev.status : "closed",
          ...(prev.status === "error" || prev.error !== null
            ? {}
            : {
                error: {
                  code: "socket" as const,
                  message: `closed (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ""})`,
                },
              }),
        });
      });
      return true;
    },
    [url, commit],
  );

  const sendOp = useCallback(
    (op: Op): boolean => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn("[useRoom] sendOp dropped: socket not open");
        return false;
      }
      if (!stateRef.current.projection) {
        console.warn("[useRoom] sendOp dropped: no projection yet");
        return false;
      }
      // Plain statement — never inside a setRoom updater (StrictMode I-1).
      ws.send(encodeClientMessage(buildOpMessage(op)));
      return true;
    },
    [],
  );

  const sendRematch = useCallback((): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn("[useRoom] sendRematch dropped: socket not open");
      return false;
    }
    if (!stateRef.current.projection) {
      console.warn("[useRoom] sendRematch dropped: no projection yet");
      return false;
    }
    // No seed argument — the room derives game 2's seed server-side.
    ws.send(encodeClientMessage(buildRematchMessage()));
    return true;
  }, []);

  // Unmount: stop commits, close the socket. (commit() is mounted-guarded, so
  // the late close/error listener callbacks can never setState after unmount.)
  // Setup MUST re-arm the flag: StrictMode simulates unmount+remount in dev,
  // and a one-way latch would leave the app frozen after the second mount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      wsRef.current?.close(1000, "unmount");
      wsRef.current = null;
    };
  }, []);

  return {
    room,
    state: room.projection,
    legalMoves: room.legalMoves,
    seat: room.welcome?.seat ?? null,
    connect,
    sendOp,
    sendRematch,
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
