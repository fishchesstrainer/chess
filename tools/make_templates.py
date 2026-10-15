#!/usr/bin/env python3
"""Build vision/templates.png: the piece sets "Read from image" compares squares against.

One row per set, one 64×64 cell per piece (wP wN wB wR wQ wK bP bN bB bR bQ bK).
Sets come from pieces/ (this repo) and from a checkout of lichess-org/lila (public/piece),
using only sets whose licence allows redistribution (see vision/LICENSES.md).

    git clone --depth 1 --filter=blob:none --sparse https://github.com/lichess-org/lila
    (cd lila && git sparse-checkout set public/piece)
    python3 tools/make_templates.py lila/public/piece
"""
import io
import json
import sys
from pathlib import Path

import cairosvg
from PIL import Image

CELL = 64
CODES = ["wP", "wN", "wB", "wR", "wQ", "wK", "bP", "bN", "bB", "bR", "bQ", "bK"]
REPO = Path(__file__).resolve().parent.parent
OWN = ["alpha", "cardinal", "cburnett", "fresca", "maestro", "merida", "staunty"]  # pieces/
LICHESS = ["anarcandy", "caliente", "california", "celtic", "chessnut", "cooke", "dubrovny", "fantasy",
           "firi", "gioco", "horsey", "icpieces", "kiwen-suwi", "letter", "minimal-warmth", "monarchy",
           "mpchess", "papercut", "pirouetti", "pixel", "rhosgfx", "shapes", "spatial", "tatiana",
           "totoy", "xkcd"]


def load(path):
    if path.suffix == ".svg":
        png = cairosvg.svg2png(url=str(path), output_width=CELL, output_height=CELL)
        return Image.open(io.BytesIO(png)).convert("RGBA")
    return Image.open(path).convert("RGBA").resize((CELL, CELL), Image.LANCZOS)


def main():
    lichess = Path(sys.argv[1])
    rows = [(name, REPO / "pieces" / name) for name in OWN] + [(name, lichess / name) for name in LICHESS]
    atlas = Image.new("RGBA", (CELL * len(CODES), CELL * len(rows)))
    for r, (name, folder) in enumerate(rows):
        for c, code in enumerate(CODES):
            path = next(p for p in folder.iterdir() if p.stem.lower() == code.lower())
            atlas.paste(load(path), (c * CELL, r * CELL))
    out = REPO / "vision"
    atlas.save(out / "templates.png", optimize=True)
    (out / "templates.json").write_text(json.dumps({"cell": CELL, "codes": CODES, "sets": [n for n, _ in rows]}, indent=1) + "\n")
    print(f"{len(rows)} sets -> {out / 'templates.png'} ({(out / 'templates.png').stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
