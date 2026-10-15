# Chess Trainer

Play and train against Stockfish in your browser: **https://hraeichess.github.io/chess/**

A static web app (no server, no build step). Stockfish 19 runs locally in your browser as
WebAssembly, so it works offline once loaded and nothing is sent anywhere.

## Features

- Drag-and-drop or click-to-move, legal-move dots, last-move and check highlights
- Play as White, Black or Random; flip board
- Engine: Stockfish 19 **Lite** (1.8 MB, default) or **Full** (99 MB download, strongest; only fetched when chosen)
- Stockfish strength: Skill Level 0–20 or an Elo limit (1320–3190), adjustable think time
- Undo (takes back your move and Stockfish's reply)
- Training aids: Hint arrow with its own adjustable strength (Skill Level 0–20 or Elo; 20 = best move),
  full-strength evaluation bar
- Move list, save/copy PGN, copy FEN
- Appearance: 7 piece sets (default "maestro", see [pieces/README.md](pieces/README.md)) plus Unicode,
  and 4 board colours (default chess.com-style green)
- Settings are remembered in the browser

Shortcuts: <kbd>N</kbd> new game, <kbd>Z</kbd> / <kbd>Ctrl+Z</kbd> undo, <kbd>H</kbd> hint, <kbd>F</kbd> flip.

## Run locally

Web Workers and WebAssembly don't load from `file://`, so serve the folder over HTTP:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Layout

| Path | What |
|---|---|
| `index.html`, `style.css`, `app.js` | The app |
| `vendor/stockfish/` | [Stockfish.js](https://github.com/nmrugg/stockfish.js) 19.0.1, single-threaded builds: lite and full |
| `vendor/chess.js/` | [chess.js](https://github.com/jhlywa/chess.js) 1.4.0 (move generation, PGN) |
| `pieces/` | Piece images from [lichess](https://github.com/lichess-org/lila/tree/master/public/piece) |

Only single-threaded builds are used: the multi-threaded ones need cross-origin-isolation
headers, which GitHub Pages can't send. Lite (≈1.8 MB) is the default; it uses a smaller
network than Full but is still far stronger than any human. Full (≈99 MB) is downloaded only
when picked in the Engine list, once per page load for both engines, and then comes from the
browser cache. The choice is remembered.

## Licences

- Stockfish is GPLv3 — see [vendor/stockfish/Copying.txt](vendor/stockfish/Copying.txt); source at
  [official-stockfish/Stockfish](https://github.com/official-stockfish/Stockfish) and
  [nmrugg/stockfish.js](https://github.com/nmrugg/stockfish.js).
- chess.js is BSD-2-Clause — see [vendor/chess.js/LICENSE](vendor/chess.js/LICENSE).
- Piece sets: see [pieces/README.md](pieces/README.md) (some are CC BY-NC-SA 4.0, non-commercial use).
