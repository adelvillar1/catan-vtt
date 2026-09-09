/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Room server WebSocket URL. Defaults to ws://localhost:4273. */
  readonly VITE_ROOM_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
