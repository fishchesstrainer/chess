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

No machine learning and no server — it all runs in the browser in a fraction of a second:

1. **Find the board.** On a checkerboard every line between two files (or ranks) separates
   different colours along the whole board, so the picture is scanned for 7–9 long, evenly
   spaced edge lines in each direction.
2. **Recognise each square.** Every square is compared with the 12 pieces of 33 piece styles
   (`vision/templates.png`), each pasted onto that square's own background colour (so
   highlighted squares and white-on-light pieces compare fairly).
3. **Use the whole board.** Squares that look identical (the same piece on the same shade) are
   labelled together, and chess rules keep the counts plausible: one king per side, at most 8
   pawns and never on the first or last rank, normally no more than two rooks, bishops or knights.
4. **Guess the rest.** The board is assumed to be seen from Black's side if White's pieces sit
   mostly at the top; the side to move comes from a last-move highlight when there is one.

Measured on test boards: the board was found in every image (including full-page screenshots
and textured boards) and the orientation was always right; squares were read correctly 99% of
the time for styles in the templates and about 92% for styles it has never seen. Misread squares
are fixed in the editor with a click.

To add a piece style, put its 12 images in a folder and add it to `tools/make_templates.py`, then
rerun that script (CPU only, a few seconds).

## Licences

- Stockfish is GPLv3 — see [vendor/stockfish/Copying.txt](vendor/stockfish/Copying.txt); source at
  [official-stockfish/Stockfish](https://github.com/official-stockfish/Stockfish) and
  [nmrugg/stockfish.js](https://github.com/nmrugg/stockfish.js).
- chess.js is BSD-2-Clause — see [vendor/chess.js/LICENSE](vendor/chess.js/LICENSE).
- Piece sets: see [pieces/README.md](pieces/README.md) (some are CC BY-NC-SA 4.0, non-commercial use);
  the image-recognition templates: see [vision/LICENSES.md](vision/LICENSES.md).
