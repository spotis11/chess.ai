# Engines — drop-in builds

The extension ships with **Stockfish 19 Lite** (bundled), so it always works on
a fresh install. The other four engines are registered and selectable from the
popup, but their binaries are **not** included in the zip (they are large and
licensed separately).

When a selected engine has no build on disk, the manager logs it and falls back
to the bundled Stockfish 19 Lite automatically. Nothing breaks.

## Where files go

```
engines/
  registry.js              roster (already included)
  engine-manager.js        transports (already included)
  maia3/                   lc0 build + Maia 3 net
    lc0.js
    lc0.wasm
    maia3-79m.pb.gz
  stockfish18/
    stockfish.js
    stockfish.wasm
  komododragon/            native build (bridge)
    komodo.exe             (Windows)  / komodo (Linux/macOS)
  rodent4/                 native build (bridge)
    rodent.exe             (Windows)  / rodent (Linux/macOS)
```

`engines/<id>/` files are fetched as Blobs by `engines/engine-manager.js` and
run in a Web Worker, because MV3 content scripts cannot create a worker
directly from a `chrome-extension://` URL.

## Browser engines (no extra software)

| Engine | Files | Notes |
| --- | --- | --- |
| Maia 3 | `engines/maia3/lc0.js`, `lc0.wasm`, `maia3-79m.pb.gz` | lc0-format net. Single-threaded WASM build. |
| Stockfish 18 | `engines/stockfish18/stockfish.js`, `stockfish.wasm` | Single-threaded WASM (chess.com sends no COOP/COEP, so SharedArrayBuffer threads are unavailable in-page). |

## Native engines (bridge)

Komodo Dragon and Rodent IV have no browser build. Run the local bridge and
point it at the binaries:

```
node bridge/uci-bridge.js          # ws://127.0.0.1:8765/
node bridge/uci-bridge.js 9000     # custom port (set it in the popup)
```

The bridge has **zero npm dependencies**. Binary lookup order:

1. `engines/<id>/<name>.exe` (Windows)
2. `engines/<id>/<name>` (Linux/macOS)
3. `<name>` on `PATH`

| Engine | Expected binary | Why |
| --- | --- | --- |
| Komodo Dragon | `komodo` / `komodo.exe` | NNUE + MCTS, no WASM build. |
| Rodent IV | `rodent` / `rodent.exe` | personality engine, native only. |
| Maia 3 (native lc0) | `lc0` / `lc0.exe` | optional: faster than the WASM build. |

The bridge is reached through the extension's service worker, so the host
page's `connect-src` CSP cannot block the socket.

## Strength and options

Each engine declares its own `setoption` list in `engines/registry.js`
(the single source of truth for the popup, the content script and the bridge).
The popup renders those controls automatically: integer/float spinners,
checkboxes, and selects. Values are clamped to the declared range before they
are sent, and unknown keys are dropped.
