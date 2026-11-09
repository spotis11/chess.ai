# chess.ai — Chess.com Helper

> Free, open-source Chrome extension that brings the real **Stockfish 19** engine directly into [chess.com](https://chess.com). Best-move arrows, live evaluation, opponent prediction, and human-shaped strength control — all running locally in your browser.

<p align="center">
  <img src=".github/banner.png" alt="chess.ai banner" width="100%" />
</p>

<p align="center">
  <img src=".github/logo.png" alt="chess.ai logo" width="120" />
</p>

[![License: MIT](https://img.shields.io/badge/wrapper-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Stockfish: GPL-3.0](https://img.shields.io/badge/stockfish-GPL--3.0-green.svg)](https://www.gnu.org/licenses/gpl-3.0.html)
[![Manifest V3](https://img.shields.io/badge/manifest-v3-purple.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Version](https://img.shields.io/badge/version-4.1.0-fuchsia.svg)](#releases)

---

## What it does

chess.ai is a content script + Web Worker that injects Stockfish 19 analysis into any chess.com board. No cloud, no API keys, no telemetry — the engine runs entirely on your machine.

| Feature | Description |
|---|---|
| **Real Stockfish 19** | The actual Stockfish 19 WASM, running in a Web Worker. No fake "AI" wrappers. |
| **Best-move arrows** | Green = best move, blue = alternatives. Arrow brightness is weighted by relative move quality. |
| **Live evaluation** | Floating HUD with centipawn eval, depth, best line, and source (engine or opening book). |
| **Opponent prediction** | Searches the opponent's most likely replies (movetime-capped at 4s) so you see the next 2-3 plies. |
| **Lichess opening book** | Known book lines resolve instantly via the Lichess cloud-eval API — often 40+ depth before your engine finishes its first ply. |
| **Strength control** | UCI Skill Level (0–20) + UCI_Elo cap (1320–3190) so the engine plays like a real human at your target rating. |
| **MultiPV** | Top 3 principal variations shown side-by-side, ranked by quality. |
| **Configurable depth** | Push depth to 22 for tournament analysis, or drop to 8 for instant feedback during live games. |

## Install (7 steps, ~90 seconds)

> Works in any Chromium browser: Chrome, Edge, Brave, Arc.

1. **Download** the latest `chess-ai-helper-v4.0.4.zip` from [Releases](../../releases/latest), or `git clone` this repo.
2. **Unzip** to a stable folder (you can't delete it later — Chrome loads from this path on every launch).
3. Open `chrome://extensions` in your address bar.
4. Flip **Developer mode** on (top-right toggle).
5. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).
6. Click the puzzle-piece icon in Chrome's toolbar and **pin** "Chess AI Helper".
7. Open any game or analysis board on chess.com — the HUD panel and best-move arrows appear automatically.

### Required chess.com settings

Go to **chess.com → Settings → Game** and set:

| Setting | Value |
|---|---|
| Move animation | **None** |
| Notation | **Figurine** |

Without these, board detection breaks.

## How it works

```
chess.com  →  content.js  →  engine.js  →  Stockfish 19  →  HUD + arrows
   DOM         FEN builder     Web Worker      WASM engine       SVG overlay
```

1. The content script reads chess.com's React board, builds a 64-cell piece map, and infers side-to-move from the active clock.
2. The map + castling/en-passant rights are compiled into a standard FEN string.
3. The FEN is shipped to a Web Worker running the real Stockfish 19 WASM.
4. The engine returns best move, eval, and 3 principal variations.
5. Best lines render as SVG arrows + a draggable HUD panel.

**100% local · 0 server round-trips · 0 telemetry.**

## Repository structure

```
chess-ai-helper/
├── manifest.json              # Manifest V3 (4.1.0) — loads registry + manager before content.js
├── background.js              # Service worker (lifecycle, message routing, UCI bridge relay)
├── content.js                 # chess.com DOM probe, FEN builder, arrow renderer, EngineManager boot
├── engine.js                  # Legacy Web Worker bootstrap (bundled Stockfish loader)
├── stockfish.js               # Stockfish 19 lite (single-threaded, no COOP/COEP)
├── stockfish.wasm             # Stockfish WASM binary
├── popup.html                 # Settings UI (engine picker + per-engine options)
├── popup.js                   # Settings persistence + dynamic engine option controls
├── styles.css                 # HUD panel + arrow layer styles
├── engines/
│   ├── registry.js            # Engine metadata: IDs, transports, setoption defaults, Elo ranges
│   ├── engine-manager.js      # Transport layer — boots worker or bridge adapter, handles fallback
│   └── README.md              # Where to drop lc0, maia, stockfish18, komodo, rodent binaries
└── bridge/
    └── uci-bridge.js          # Zero-dep Node TCP→WebSocket relay for native UCI engines
```

## Privacy

- **No accounts.** No login, no sign-up, no API keys.
- **No telemetry.** No analytics, no tracking, no error reporting.
- **No network.** The only outbound request is to `lichess.org/api/cloud-eval` (optional, toggleable in settings) for opening book lookups. Everything else runs locally.
- **No data collection.** Your settings sync via Chrome's built-in `chrome.storage.sync` — that's it.

## Fair play warning

⚠️ **Autoplay (auto-making moves on chess.com) violates chess.com's Fair Play policy and will get your account banned.**

- Use autoplay only on a burner account.
- Raise delays to 1500–4000 ms.
- Enable the ELO cap.

Analysis-mode features (arrows + evaluation) are for **learning**. Using engine assistance during live rated games is at your own risk. The authors of chess.ai are not responsible for misuse.

## Licenses

This repository contains code under two licenses:

- **Wrapper code** (`background.js`, `content.js`, `engine.js`, `popup.*`, `styles.css`, `manifest.json`) — **MIT License**. See [LICENSE](./LICENSE).
- **Stockfish** (`stockfish.js`, `stockfish.wasm`) — **GPL-3.0-or-later**, copyright the Stockfish developers. See [STOCKFISH_LICENSE](./STOCKFISH_LICENSE) and <https://stockfishchess.org>.

The combination is distributed under GPL-3.0 to comply with Stockfish's license terms. See [LICENSE](./LICENSE) for the full text.

## Contributing

PRs welcome. The codebase is one file per layer — easy to navigate.

- **Found a bug?** Open an issue with the chess.com URL, the version from your popup, and the console log from the content script.
- **Want to improve it?** Fork, branch off `main`, open a PR.
- **Docs gap?** Even a typo fix helps the next person.

## Releases

| Version | Notes |
|---|---|
| 4.1.0 | Multi-engine support — `EngineManager` with worker + bridge transports; 5-engine picker (Stockfish 19 Lite, Maia 3, Stockfish 18, Komodo Dragon, Rodent IV); per-engine options; `uci-bridge.js` for native engines; automatic fallback to bundled SF19 Lite. |
| 4.0.5 | Castling fix — `toUiMove()` rewrites UCI castling (`e1h1`) to chess.com UI form (`e1g1`) before injection; castling now lands on both colors, kingside and queenside. |
| 4.0.4 | Autoplay moved-piece-but-turn-stayed fix; local-only move undo + real pointer drag fallback. |
| 4.0.3 | Turn inference rebuilt from board delta; one-shot `justPlayed` marker. |
| 4.0.0 | Stockfish 19 lite single-threaded; clock-based turn detection; en passant in FEN. |

See [Releases](../../releases) for full changelog and downloadable zips.

## Acknowledgements

- [Stockfish](https://stockfishchess.org) — the engine.
- [Lichess](https://lichess.org) — the cloud-eval opening book API.
- [chess.com](https://chess.com) — the board we hook into (not affiliated).

---

<p align="center">Built by chess players, for chess players. ♟️</p>
