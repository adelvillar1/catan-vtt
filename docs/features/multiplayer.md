# Multiplayer Protocol (feature doc)

> Stub — written when the room server lands (plan `YYYY-MM-DD-room-server`).

Kernel authority: `packages/shared`. This doc will specify:
- WS frame shapes (client ops ⊂ `ActionSchema` enum; server frames: `joined|seat|state|error|chat|ping`)
- Seat-token auth & host/guest rules (mahjong-vtt pattern; viewers browse, cannot act)
- Server-side RNG and rehydrate/resync on reconnect
- Trade offer flow (proposer → broadcast → accept/counter; timeouts)
- The "new-op touch list" checklist per dnd-vtt lesson

Related: `docs/features/rules-kernel.md`, `docs/architecture/overview.md`.
