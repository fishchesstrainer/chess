# Piece sets

Rendered to 256×256 PNG from the SVGs in [lichess-org/lila](https://github.com/lichess-org/lila/tree/master/public/piece).
Licences (from lila's COPYING.md); all allow personal, non-commercial use:

| Set | Author | Licence |
|---|---|---|
| cburnett | Colin M.L. Burnett | GPLv2+ |
| merida | Armando Hernandez Marroquin | GPLv2+ |
| maestro, cardinal, fresca, staunty | sadsnake1 | CC BY-NC-SA 4.0 |
| alpha | Eric Bentzen | free for personal non-commercial use |

To add your own set, create `pieces/<name>/` containing `wK.png wQ.png wR.png wB.png wN.png wP.png`
and `bK.png … bP.png` (square, transparent background), then add `<name>` to `PIECE_SETS` in `app.js`.
