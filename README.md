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
- **Analyze position** tab: set up any position (piece palette, drag pieces, right-click or drag
  off the board to remove, load/paste a FEN, copy the game position), choose White or Black to
  move, and Stockfish shows the best move (arrow) and its top 1–5 lines at full strength.
  "Play this position against Stockfish" starts a game from there.
- **Read a position from an image**: paste a screenshot (Ctrl+V), drop an image or pick a file
  with "Read from image…". Works with 2D boards (lichess, chess.com, diagrams, this app). The
  preview shows the detected grid and pieces; drag a box if the board wasn't found, then fix
  any misread square in the editor.
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

### iPhone Home Screen icon

`apple-touch-icon.png` is the 180×180 PNG made from the supplied green pawn and graduation
cap picture. `index.html` links it using `rel="apple-touch-icon"` with a relative URL so it
also works under the GitHub Pages `/chess/` path.

After publishing the updated files, open the website in Safari and choose **Share → Add to
Home Screen**. If an existing shortcut still shows the old icon, remove that shortcut and
add the website again.

### Files

| Path | What |
|---|---|
| `index.html`, `style.css`, `app.js` | The app |
| `vision.js`, `vision/` | Board recognition from images (see below); template credits in [vision/LICENSES.md](vision/LICENSES.md) |
| `vendor/stockfish/` | [Stockfish.js](https://github.com/nmrugg/stockfish.js) 19.0.1, single-threaded builds: lite and full |
| `vendor/chess.js/` | [chess.js](https://github.com/jhlywa/chess.js) 1.4.0 (move generation, PGN) |
| `pieces/` | Piece images from [lichess](https://github.com/lichess-org/lila/tree/master/public/piece) |

Only single-threaded builds are used: the multi-threaded ones need cross-origin-isolation
headers, which GitHub Pages can't send. Lite (≈1.8 MB) is the default; it uses a smaller
network than Full but is still far stronger than any human. Full (≈99 MB) is downloaded only
when picked in the Engine list, once per page load for both engines, and then comes from the
browser cache. The choice is remembered.

## How "Read from image" works

No server: it all runs in the browser.

1. **Find the board** (`vision/board.js`). Works on photos taken at an angle as well as screenshots.
   It finds the points where four squares meet, fits a grid to them, and keeps the 8×8 placement
   that looks most like a checkerboard. The older screenshot detector in `vision.js` adds one more
   candidate. If the grid is off, drag its corners or drag a box around the board.
2. **Read each square** (`vision/cnn.js`). Each of the 64 squares is straightened, turned to gray
   and shrunk to 32×32. A small neural network then names it: empty or one of the 12 pieces. The
   network was trained on 33 piece styles; its weights are in `vision/piece_cnn.json` and
   `vision/piece_cnn.bin` (141 KB). Squares it is unsure about are shown in orange.
3. **Guess the rest.** If White's pieces sit mostly at the top, the board is assumed to be seen
   from Black's side. The side to move comes from a last-move highlight, when there is one.

The detector and the network are trained and exported from the Python code in the parent
workspace (`vision/train_pieces.py`, `vision/export_web_model.py`).

## Licences

- Stockfish is GPLv3 — see [vendor/stockfish/Copying.txt](vendor/stockfish/Copying.txt); source at
  [official-stockfish/Stockfish](https://github.com/official-stockfish/Stockfish) and
  [nmrugg/stockfish.js](https://github.com/nmrugg/stockfish.js).
- chess.js is BSD-2-Clause — see [vendor/chess.js/LICENSE](vendor/chess.js/LICENSE).
- Piece sets: see [pieces/README.md](pieces/README.md) (some are CC BY-NC-SA 4.0, non-commercial use);
  the image-recognition templates: see [vision/LICENSES.md](vision/LICENSES.md).
