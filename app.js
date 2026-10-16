// Chess trainer: play against Stockfish in the browser.
// Browser port of chess_gui.py — chess.js handles the rules and PGN, and Stockfish runs
// as a WebAssembly UCI engine in Web Workers (vendor/, see README.md).

import { Chess } from "./vendor/chess.js/chess.js";

// Board colour themes: [light, dark, light highlight, dark highlight]
const THEMES = {
  Green: ["#eeeed2", "#769656", "#f5f682", "#b9ca43"],
  Brown: ["#f0d9b5", "#b58863", "#cdd26a", "#aaa23a"],
  Blue: ["#dee3e6", "#8ca2ad", "#c3d887", "#92b166"],
  Gray: ["#e8e8e8", "#a0a0a0", "#f2f28c", "#c8c85a"],
};
const CHECK = "#e8493f";
const ARROW = "rgba(21, 120, 27, 0.65)";

// Piece images live in pieces/<set>/{w,b}{K,Q,R,B,N,P}.png (sets from lichess.org, see pieces/README.md).
const PIECE_SETS = ["alpha", "cardinal", "cburnett", "fresca", "maestro", "merida", "staunty"];
const UNICODE_SET = "unicode";
const DEFAULT_PIECE_SET = "maestro";
// Solid glyphs are used as the piece body, outline glyphs as the border of white pieces.
// U+FE0E asks for the text (not emoji) presentation of the pawn.
const SOLID = { p: "♟︎", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" };
const OUTLINE = { p: "♙", n: "♘", b: "♗", r: "♖", q: "♕", k: "♔" };
const PIECE_NAMES = { k: "King", q: "Queen", r: "Rook", b: "Bishop", n: "Knight", p: "Pawn" };
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Stockfish.js 19 builds (vendor/stockfish), with their .wasm sizes. Full is only fetched when chosen.
const ENGINES = {
  lite: { url: "vendor/stockfish/stockfish-19-lite-single.js", size: 1845971 },
  full: { url: "vendor/stockfish/stockfish-19-single.js", size: 99169054 },
};
const FULL_STRENGTH = { UCI_LimitStrength: false, "Skill Level": 20 };
const ELO_MIN = 1320, ELO_MAX = 3190;  // UCI_Elo range of Stockfish 19
const SETTINGS_KEY = "chess-trainer:settings";

const $ = id => document.getElementById(id);

function shade(color, factor) {
  const [r, g, b] = [1, 3, 5].map(i => Math.floor(parseInt(color.slice(i, i + 2), 16) * factor));
  return `rgb(${r}, ${g}, ${b})`;
}

/** Turn a white-POV engine score into [white share of the bar, label]. */
function scoreToBar(score) {
  if (score.type === "mate") return [score.value > 0 ? 1 : 0, `M${Math.abs(score.value)}`];
  const cp = score.value;
  return [1 / (1 + 10 ** (-cp / 400)), `${cp >= 0 ? "+" : ""}${(cp / 100).toFixed(1)}`];
}

function whitePov(score, turn) {
  if (!score) return null;
  return turn === "w" ? score : { type: score.type, value: -score.value };
}

// ------------------------------------------------------------- engine

/** A Stockfish Web Worker speaking UCI. Jobs run one at a time, like the locks in the desktop app. */
class Engine {
  /** url: the engine's .js file; wasm: promise of a URL for its .wasm (the worker starts once it resolves). */
  constructor(url, hash, wasm) {
    this.name = "Stockfish";
    this.listeners = new Set();
    this.ready = wasm.then(wasmUrl => this._start(url, wasmUrl, hash));
    this.chain = this.ready;
  }

  _start(url, wasmUrl, hash) {
    if (this.error) throw this.error;
    // Stockfish.js takes the location of its .wasm from the worker URL's hash.
    this.worker = new Worker(`${url}#${encodeURIComponent(wasmUrl)}`);
    this.worker.onmessage = e => {
      if (typeof e.data === "string") this.listeners.forEach(f => f(e.data));
    };
    this.worker.onerror = e => {
      e.preventDefault();
      this._fail(new Error(e.message || "could not load the engine"));
    };
    return this._init(hash);
  }

  _fail(error) {
    this.error ??= error;
    this.listeners.forEach(f => f(null));
  }

  terminate() {
    this.worker?.terminate();
    this._fail(new Error("engine closed"));
  }

  send(cmd) { this.worker?.postMessage(cmd); }

  /** Resolve with the first line starting with prefix; onLine sees every line until then. */
  waitFor(prefix, onLine) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const listener = line => {
        if (line === null) {
          this.listeners.delete(listener);
          reject(this.error);
          return;
        }
        onLine?.(line);
        if (line.startsWith(prefix)) {
          this.listeners.delete(listener);
          resolve(line);
        }
      };
      this.listeners.add(listener);
    });
  }

  async _init(hash) {
    const uciok = this.waitFor("uciok", line => {
      if (line.startsWith("id name ")) this.name = line.slice(8);
    });
    this.send("uci");
    await uciok;
    this.send(`setoption name Hash value ${hash}`);
    await this.isReady();
  }

  isReady() {
    const ok = this.waitFor("readyok");
    this.send("isready");
    return ok;
  }

  configure(options) {
    for (const [name, value] of Object.entries(options)) this.send(`setoption name ${name} value ${value}`);
  }

  /** Queue job(engine) behind the engine's other jobs. */
  run(job) {
    const result = this.chain.then(() => job(this));
    this.chain = result.catch(() => {});
    return result;
  }

  /** Search position {fen, moves} for movetime ms; returns {move, score} (score from side to move). */
  async go({ fen, moves }, movetime) {
    let score = null;
    const done = this.waitFor("bestmove", line => {
      const m = line.match(/^info .*\bscore (cp|mate) (-?\d+)/);
      if (m && !/\b(lower|upper)bound\b/.test(line)) score = { type: m[1], value: Number(m[2]) };
    });
    this.send(`position fen ${fen}${moves.length ? " moves " + moves.join(" ") : ""}`);
    this.send(`go movetime ${Math.round(movetime)}`);
    const best = (await done).split(" ")[1];
    return { move: best && best !== "(none)" ? best : null, score };
  }

  /** Search a FEN for movetime ms, calling onInfo({multipv, depth, score, pv}) as lines come in; returns the best move. */
  async analyse(fen, movetime, onInfo) {
    const done = this.waitFor("bestmove", line => {
      if (!line.startsWith("info ") || !line.includes(" pv ") || /\b(lower|upper)bound\b/.test(line)) return;
      const score = line.match(/\bscore (cp|mate) (-?\d+)/);
      if (!score) return;
      const field = name => Number((line.match(new RegExp(`\\b${name} (\\d+)`)) || [])[1] || 0);
      onInfo({
        multipv: field("multipv") || 1,
        depth: field("depth"),
        score: { type: score[1], value: Number(score[2]) },
        pv: line.split(" pv ")[1].trim().split(/\s+/),
      });
    });
    this.send(`position fen ${fen}`);
    this.send(`go movetime ${Math.round(movetime)}`);
    const best = (await done).split(" ")[1];
    return best && best !== "(none)" ? best : null;
  }

  stop() { this.send("stop"); }

  newGame() {
    this.stop();
    this.run(e => { e.send("ucinewgame"); return e.isReady(); }).catch(() => {});
  }
}

// ---------------------------------------------------------------- state

const game = new Chess();
let userColor = "w";
let flipped = false;
let selected = null;     // square name of the selected piece
let drag = null;         // {x, y} pointer position (canvas pixels) while dragging
let hintMove = null;     // {from, to}
let thinking = false;
let evalInfo = [0.5, "0.0"];
let status = "";
let promoCancel = null;  // set while the promotion picker is open
let pieceImages = {};    // "wK" -> loaded HTMLImageElement
// Bumped on new game / undo so results of searches already in flight are dropped.
let gen = 0;
let mode = "play";       // "play" or "analyze" (the position editor tab)

// Position editor ("Analyze position" tab)
let editPieces = {};     // square -> {color, type}
let editTurn = "w";
let editCastling = "KQkq"; // castling rights of the loaded FEN; editFenString() drops any that no longer fit
let editFlipped = false;
let editTool = "move";   // "move", "erase" or a piece code such as "wq"
let editDrag = null;     // {from, piece, x, y} while dragging a piece with the Move tool
let paintTool = null;    // tool being painted with while the pointer is held down
let editCheck = null;    // king square to highlight when the side to move is in check
let editStatus = "";
let analysis = null;     // {fen, turn, lines: [{multipv, depth, score, pv}], done}
let editEval = [0.5, ""];
let hoverLine = null;    // index of the analysis line under the mouse
let anaGen = 0;          // bumped whenever the edited position changes
let anaTimer = null;

// Two engines: the opponent plays at the chosen strength; the coach runs the
// eval bar at full strength and hints at the hint strength. See startEngines().
let opponent = null;
let coach = null;

const ui = {
  canvas: $("board"),
  status: $("status"),
  engineName: $("engineName"),
  eval: $("eval"),
  evalWhite: $("evalWhite"),
  evalLabel: $("evalLabel"),
  moves: $("moves"),
  promo: $("promo"),
  promoBox: $("promoBox"),
  gameOver: $("gameOver"),
  gameOverText: $("gameOverText"),
  engine: $("engine"),
  thinkTime: $("thinkTime"),
  pieceSet: $("pieceSet"),
  theme: $("theme"),
  showEval: $("showEval"),
  showMoves: $("showMoves"),
  tabPlay: $("tabPlay"),
  tabAnalyze: $("tabAnalyze"),
  playPanel: $("playPanel"),
  analyzePanel: $("analyzePanel"),
  palette: $("palette"),
  editFen: $("editFen"),
  anaLines: $("anaLines"),
  anaTime: $("anaTime"),
  anaList: $("anaList"),
  anaInfo: $("anaInfo"),
  imageDialog: $("imageDialog"),
  imageCanvas: $("imageCanvas"),
  imageMsg: $("imageMsg"),
  imageFlipped: $("imageFlipped"),
  imageUse: $("imageUse"),
  imageFile: $("imageFile"),
  watchPanel: $("watchPanel"),
  watchCanvas: $("watchCanvas"),
  watchVideo: $("watchVideo"),
  watchFen: $("watchFen"),
  watchTime: $("watchTime"),
  watchMsg: $("watchMsg"),
  watchFollow: $("watchFollow"),
};
const ctx = ui.canvas.getContext("2d");
let sq = 0;  // square size in canvas pixels

const oppStrength = strengthControls("opp");
const hintStrength = strengthControls("hint");

// ------------------------------------------------------------------- UI

function strengthControls(prefix) {
  const level = $(`${prefix}Level`), limit = $(`${prefix}Limit`), elo = $(`${prefix}Elo`), out = $(`${prefix}LevelOut`);
  const sync = () => {
    out.textContent = level.value;
    level.disabled = limit.checked;
    elo.disabled = !limit.checked;
  };
  level.addEventListener("input", sync);
  limit.addEventListener("change", sync);
  elo.addEventListener("change", () => {
    elo.value = Math.max(ELO_MIN, Math.min(ELO_MAX, parseInt(elo.value, 10) || 1500));
  });
  return { level, limit, elo, sync };
}

/** UCI options and a short label for a set of strength controls. */
function strengthOptions({ level, limit, elo }) {
  if (limit.checked) {
    const value = Math.max(ELO_MIN, Math.min(ELO_MAX, parseInt(elo.value, 10) || 1500));
    return [{ UCI_LimitStrength: true, UCI_Elo: value }, `Elo ${value}`];
  }
  return [{ UCI_LimitStrength: false, "Skill Level": Number(level.value) }, `level ${level.value}`];
}

function opponentLabel() {
  return `${opponent.name} (${strengthOptions(oppStrength)[1]})`;
}

function buildUi() {
  for (const name of [...PIECE_SETS, UNICODE_SET]) ui.pieceSet.add(new Option(name, name));
  for (const name of Object.keys(THEMES)) ui.theme.add(new Option(name, name));
  ui.pieceSet.value = DEFAULT_PIECE_SET;
  ui.theme.value = "Green";
  loadEditFen(START_FEN, false);
  loadSettings();
  updateEvalVisibility();
  oppStrength.sync();
  hintStrength.sync();

  $("newGame").onclick = newGame;
  $("undo").onclick = undo;
  $("flip").onclick = flip;
  $("savePgn").onclick = savePgn;
  $("copyFen").onclick = () => copyText(game.fen(), "FEN copied to clipboard.");
  $("copyPgn").onclick = () => copyText(buildPgn(), "PGN copied to clipboard.");
  $("hint").onclick = showHint;
  ui.pieceSet.onchange = loadPieceImages;
  ui.theme.onchange = redraw;
  ui.showMoves.onchange = redraw;
  ui.showEval.onchange = onShowEval;
  ui.gameOver.addEventListener("close", () => {
    if (ui.gameOver.returnValue === "new") newGame();
  });
  document.querySelector(".panel").addEventListener("change", saveSettings);

  ui.tabPlay.onclick = () => setMode("play");
  ui.tabAnalyze.onclick = () => setMode("analyze");
  $("editStart").onclick = () => loadEditFen(START_FEN);
  $("editClear").onclick = () => { editPieces = {}; positionEdited(); };
  $("editFlip").onclick = flip;
  $("editFromGame").onclick = () => loadEditFen(game.fen());
  $("editLoadFen").onclick = () => loadEditFen(ui.editFen.value);
  ui.editFen.addEventListener("keydown", e => { if (e.key === "Enter") loadEditFen(ui.editFen.value); });
  $("playFromHere").onclick = playFromHere;
  for (const radio of document.querySelectorAll("input[name=editTurn]")) {
    radio.onchange = () => { editTurn = radio.value; positionEdited(); };
  }
  ui.anaLines.onchange = positionEdited;
  ui.anaTime.onchange = positionEdited;
  ui.anaList.addEventListener("mouseleave", () => { hoverLine = null; redraw(); });
  $("editFromImage").onclick = () => ui.imageFile.click();
  ui.imageFile.onchange = () => {
    readFromImage(ui.imageFile.files[0]);
    ui.imageFile.value = "";
  };
  document.addEventListener("paste", onPaste);
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("dragleave", e => { if (!e.relatedTarget) document.body.classList.remove("dropping"); });
  document.addEventListener("drop", onDrop);
  ui.imageCanvas.addEventListener("pointerdown", onImagePress);
  ui.imageCanvas.addEventListener("pointermove", onImageMotion);
  ui.imageCanvas.addEventListener("pointerup", onImageRelease);
  ui.imageDialog.addEventListener("close", () => {
    const read = imageRead;
    imageRead = null;
    const use = ui.imageDialog.returnValue === "use";
    if (read?.watchSetup) {
      if (use && read.result) startWatching(read);
      else if (!watch?.board) stopWatch();      // cancelled before watching started
    } else if (use) {
      applyImageResult(read);
    }
  });
  $("watchScreen").onclick = () => startWatch("screen");
  $("watchCamera").onclick = () => startWatch("camera");
  $("watchStop").onclick = stopWatch;
  $("watchAdjust").onclick = () => watch && openImageDialog(vision.grabFrame(watch.video), true);
  $("watchCopy").onclick = () => watch?.fen && navigator.clipboard?.writeText(watch.fen);

  ui.canvas.addEventListener("pointerdown", e => (mode === "play" ? onPress : onEditPress)(e));
  ui.canvas.addEventListener("pointermove", e => (mode === "play" ? onMotion : onEditMotion)(e));
  ui.canvas.addEventListener("pointerup", e => (mode === "play" ? onRelease : onEditRelease)(e));
  ui.canvas.addEventListener("pointercancel", () => { drag = editDrag = paintTool = null; redraw(); });
  ui.canvas.addEventListener("contextmenu", onEditContextMenu);
  ui.engine.onchange = switchEngine;
  document.addEventListener("keydown", onKey);
  new ResizeObserver(resizeBoard).observe(ui.canvas);
  startEngines();
}

/** Fetch a .wasm into memory, reporting bytes loaded; resolves with a blob: URL. */
async function downloadWasm(url, signal, onProgress) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`);
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded);
  }
  return URL.createObjectURL(new Blob(chunks, { type: "application/wasm" }));
}

let wasmDownload = null;  // AbortController of the current engine download

/** (Re)start both engines with the build chosen in the Engine list. */
function startEngines() {
  const { url, size } = ENGINES[ui.engine.value] || ENGINES.lite;
  opponent?.terminate();
  coach?.terminate();
  wasmDownload?.abort();
  wasmDownload = new AbortController();
  ui.engineName.textContent = "Loading Stockfish…";
  // Download the .wasm once and give both workers the same in-memory copy.
  const mb = n => Math.round(n / 1e6);
  let shownMb = -1;
  const wasm = downloadWasm(url.replace(/\.js$/, ".wasm"), wasmDownload.signal, loaded => {
    if (engine !== opponent || loaded >= size || mb(loaded) === shownMb) return;
    shownMb = mb(loaded);
    ui.engineName.textContent = `Downloading Stockfish… ${shownMb} / ${mb(size)} MB`;
  });
  const engine = opponent = new Engine(url, 32, wasm);
  coach = new Engine(url, 64, wasm);
  Promise.allSettled([opponent.ready, coach.ready]).then(() => wasm.then(URL.revokeObjectURL, () => {}));
  engine.ready.then(() => {
    if (engine === opponent) ui.engineName.textContent = engine.name;
  }, err => {
    if (engine !== opponent) return;
    ui.engineName.textContent = "Engine failed to load";
    setStatus(`Could not start Stockfish: ${err.message}`);
  });
}

/** Swap engines mid-game: searches in flight are dropped and Stockfish moves again if it is its turn. */
function switchEngine() {
  gen++;
  thinking = false;
  startEngines();
  if (outcome()) requestEval();
  else afterPositionChange();
  if (mode === "analyze") positionEdited();
}

function onKey(e) {
  if (promoCancel) {
    if (e.key === "Escape") promoCancel();
    return;
  }
  const t = e.target;
  if (t.matches?.("input[type=number], input[type=text], select, textarea") || ui.gameOver.open || ui.imageDialog.open) return;
  const key = e.key.toLowerCase();
  if (mode === "analyze") {
    if (key === "f" && !(e.ctrlKey || e.metaKey || e.altKey)) {
      e.preventDefault();
      flip();
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && key === "z") {
    e.preventDefault();
    undo();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const action = { n: newGame, z: undo, u: undo, h: showHint, f: flip }[key];
  if (action) {
    e.preventDefault();
    action();
  }
}

function setStatus(text) {
  status = text;
  if (mode === "play") ui.status.textContent = text;
}

function setEditStatus(text) {
  editStatus = text;
  if (mode === "analyze") ui.status.textContent = text;
}

function colors() {
  return THEMES[ui.theme.value] || THEMES.Green;
}

function loadPieceImages() {
  const set = ui.pieceSet.value;
  pieceImages = {};
  if (set !== UNICODE_SET) {
    const images = {};
    for (const color of "wb") {
      for (const type of "kqrbnp") {
        const img = new Image();
        img.onload = () => { if (ui.pieceSet.value === set) redraw(); };
        img.src = pieceSrc(set, color, type);
        images[color + type] = img;
      }
    }
    pieceImages = images;
  }
  buildPalette();
  redraw();
}

function pieceSrc(set, color, type) {
  return `pieces/${set}/${color}${type.toUpperCase()}.png`;
}

function updateEvalVisibility() {
  ui.eval.hidden = mode === "play" && !ui.showEval.checked;
}

function onShowEval() {
  updateEvalVisibility();
  if (ui.showEval.checked) requestEval();
}

// -------------------------------------------------------------- settings

const SETTING_IDS = ["engine", "oppLevel", "oppLimit", "oppElo", "thinkTime", "hintLevel", "hintLimit", "hintElo",
  "showEval", "showMoves", "pieceSet", "theme", "anaLines", "anaTime"];

function loadSettings() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return;
  }
  for (const id of SETTING_IDS) {
    const el = $(id);
    if (!(id in saved)) continue;
    if (el.type === "checkbox") el.checked = !!saved[id];
    else if (el.tagName !== "SELECT" || [...el.options].some(o => o.value === saved[id])) el.value = saved[id];
  }
  const radio = document.querySelector(`input[name=playAs][value="${saved.playAs}"]`);
  if (radio) radio.checked = true;
  if (saved.editFen) loadEditFen(saved.editFen, false);
  if (saved.tab === "analyze") mode = "analyze";
}

function saveSettings() {
  const saved = {
    playAs: document.querySelector("input[name=playAs]:checked").value,
    tab: mode,
    editFen: editFenString(),
  };
  for (const id of SETTING_IDS) {
    const el = $(id);
    saved[id] = el.type === "checkbox" ? el.checked : el.value;
  }
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved));
  } catch {
    // storage unavailable (private mode etc.): settings just are not remembered
  }
}

// --------------------------------------------------------------- drawing

function resizeBoard() {
  const size = Math.round(ui.canvas.clientWidth * (window.devicePixelRatio || 1));
  if (!size) return;
  ui.canvas.width = ui.canvas.height = size;
  sq = size / 8;
  redraw();
}

const fileOf = square => square.charCodeAt(0) - 97;
const rankOf = square => Number(square[1]) - 1;
const squareName = (file, rank) => String.fromCharCode(97 + file) + (rank + 1);

function boardFlipped() {
  return mode === "play" ? flipped : editFlipped;
}

function squareCell(square) {
  const file = fileOf(square), rank = rankOf(square);
  return boardFlipped() ? [7 - file, rank] : [file, 7 - rank];
}

/** Pixel rectangle [x, y, w, h] of a board cell; rounded so neighbouring squares meet exactly. */
function cellRect(col, row) {
  const x = Math.round(col * sq), y = Math.round(row * sq);
  return [x, y, Math.round((col + 1) * sq) - x, Math.round((row + 1) * sq) - y];
}

function squareCenter(square) {
  const [col, row] = squareCell(square);
  return [(col + 0.5) * sq, (row + 0.5) * sq];
}

function squareAt(x, y) {
  const col = Math.floor(x / sq), row = Math.floor(y / sq);
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  return boardFlipped() ? squareName(7 - col, row) : squareName(col, 7 - row);
}

function isLightSquare(square) {
  return (fileOf(square) + rankOf(square)) % 2 === 1;
}

function lastMove() {
  const history = game.history({ verbose: true });
  return history[history.length - 1] || null;
}

function squareColor(square, highlights) {
  const [light, dark, lightHl, darkHl] = colors();
  const light_ = isLightSquare(square);
  if (highlights.has(square)) return light_ ? lightHl : darkHl;
  return light_ ? light : dark;
}

function drawPiece(piece, cx, cy) {
  const img = pieceImages[piece.color + piece.type];
  if (img) {
    if (img.complete && img.naturalWidth) ctx.drawImage(img, cx - sq / 2, cy - sq / 2, sq, sq);
    return;
  }
  ctx.font = `${sq * 0.78}px "DejaVu Sans", "Segoe UI Symbol", "Noto Sans Symbols 2", "Apple Symbols", serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const y = cy + sq * 0.03;  // glyphs sit slightly high in their box
  if (piece.color === "w") {
    ctx.fillStyle = "#ffffff";
    ctx.fillText(SOLID[piece.type], cx, y);
    ctx.fillStyle = "#000000";
    ctx.fillText(OUTLINE[piece.type], cx, y);
  } else {
    ctx.fillStyle = "#000000";
    ctx.fillText(SOLID[piece.type], cx, y);
  }
}

function drawArrow(from, to) {
  const [x1, y1] = squareCenter(from), [x2, y2] = squareCenter(to);
  const length = Math.hypot(x2 - x1, y2 - y1);
  const half = sq * 0.08, headLength = sq * 0.38, headHalf = sq * 0.22;
  ctx.save();
  ctx.translate(x1, y1);
  ctx.rotate(Math.atan2(y2 - y1, x2 - x1));
  ctx.beginPath();
  ctx.moveTo(0, -half);
  ctx.lineTo(length - headLength, -half);
  ctx.lineTo(length - headLength, -headHalf);
  ctx.lineTo(length, 0);
  ctx.lineTo(length - headLength, headHalf);
  ctx.lineTo(length - headLength, half);
  ctx.lineTo(0, half);
  ctx.closePath();
  ctx.fillStyle = ARROW;
  ctx.fill();
  ctx.restore();
}

/** What the board shows in play mode. */
function playView() {
  const last = lastMove();
  return {
    pieces: game.board().flat().filter(Boolean),
    highlights: new Set([selected, last?.from, last?.to].filter(Boolean)),
    check: game.inCheck() ? game.findPiece({ type: "k", color: game.turn() })[0] : null,
    targets: selected && ui.showMoves.checked ? game.moves({ square: selected, verbose: true }) : [],
    arrow: hintMove,
    drag: drag && selected ? { from: selected, piece: game.get(selected), x: drag.x, y: drag.y } : null,
  };
}

/** What the board shows in the position editor. */
function editView() {
  const line = analysis?.lines[hoverLine ?? 0];
  const move = line?.pv[0];
  return {
    pieces: Object.entries(editPieces).map(([square, piece]) => ({ square, ...piece })),
    highlights: new Set(editDrag ? [editDrag.from] : []),
    check: editCheck,
    targets: [],
    arrow: move ? { from: move.slice(0, 2), to: move.slice(2, 4) } : null,
    drag: editDrag,
  };
}

function redraw() {
  if (!sq) return;
  ctx.imageSmoothingQuality = "high";
  const view = mode === "play" ? playView() : editView();

  for (let file = 0; file < 8; file++) {
    for (let rank = 0; rank < 8; rank++) {
      const square = squareName(file, rank);
      const [x, y, w, h] = cellRect(...squareCell(square));
      ctx.fillStyle = squareColor(square, view.highlights);
      ctx.fillRect(x, y, w, h);
      if (square === view.check) {
        const g = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, w * 0.6);
        g.addColorStop(0, CHECK);
        g.addColorStop(0.55, CHECK);
        g.addColorStop(1, "rgba(232, 73, 63, 0)");
        ctx.fillStyle = g;
        ctx.fillRect(x, y, w, h);
      }
    }
  }

  const [light, dark] = colors();
  const flip_ = boardFlipped();
  ctx.font = `bold ${Math.max(9, sq / 6.5)}px system-ui, "DejaVu Sans", sans-serif`;
  for (let i = 0; i < 8; i++) {
    const fileChar = "abcdefgh"[flip_ ? 7 - i : i];
    const rankChar = String(flip_ ? i + 1 : 8 - i);
    // Top-left square is always light, so bottom-row cell i is light when i is odd.
    ctx.fillStyle = i % 2 ? dark : light;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(fileChar, (i + 1) * sq - sq * 0.05, 8 * sq - sq * 0.02);
    ctx.fillStyle = i % 2 ? light : dark;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(rankChar, sq * 0.05, i * sq + sq * 0.04);
  }

  for (const move of view.targets) {
    const [cx, cy] = squareCenter(move.to);
    const color = shade(squareColor(move.to, view.highlights), 0.8);
    ctx.beginPath();
    if (move.captured) {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(3, sq / 12);
      ctx.arc(cx, cy, sq * 0.46 - ctx.lineWidth / 2, 0, 2 * Math.PI);
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.arc(cx, cy, sq * 0.15, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  for (const piece of view.pieces) {
    if (view.drag && piece.square === view.drag.from) continue;
    drawPiece(piece, ...squareCenter(piece.square));
  }

  if (view.arrow) drawArrow(view.arrow.from, view.arrow.to);
  if (view.drag) drawPiece(view.drag.piece, view.drag.x, view.drag.y);
}

function drawEvalBar() {
  const [frac, label] = mode === "play" ? evalInfo : editEval;
  const flipped = boardFlipped();
  ui.eval.classList.toggle("flipped", flipped);
  ui.evalWhite.style.height = `${frac * 100}%`;
  // The label sits at the end of the side that is ahead.
  const whiteAhead = frac >= 0.5;
  const atBottom = whiteAhead !== flipped;
  ui.evalLabel.textContent = label;
  ui.evalLabel.style.top = atBottom ? "auto" : "0";
  ui.evalLabel.style.bottom = atBottom ? "0" : "auto";
  ui.evalLabel.style.color = whiteAhead ? "#333333" : "#f5f5f5";
}

function updateMoveList() {
  const sans = game.history();
  const start = enginePosition().fen.split(" ");
  // A game set up with Black to move starts with an empty White slot ("1. … Nf6").
  const slots = start[1] === "b" ? ["…", ...sans] : sans;
  const firstNumber = Number(start[5]) || 1;
  const items = [];
  for (let i = 0; i < slots.length; i += 2) {
    const li = document.createElement("li");
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = `${firstNumber + i / 2}.`;
    li.append(num);
    for (const j of [i, i + 1]) {
      const span = document.createElement("span");
      span.textContent = slots[j] || "";
      if (j === slots.length - 1) span.className = "last";
      li.append(span);
    }
    items.push(li);
  }
  ui.moves.replaceChildren(...items);
  ui.moves.scrollTop = ui.moves.scrollHeight;
}

// ------------------------------------------------------------ user input

function userCanMove() {
  return !thinking && !promoCancel && game.turn() === userColor && !game.isGameOver();
}

function legalTargets(square) {
  return new Set(game.moves({ square, verbose: true }).map(m => m.to));
}

function canvasPoint(e) {
  const r = ui.canvas.getBoundingClientRect();
  const scale = ui.canvas.width / r.width;
  return { x: (e.clientX - r.left) * scale, y: (e.clientY - r.top) * scale };
}

function onPress(e) {
  if (e.button !== 0) return;
  const point = canvasPoint(e);
  const square = squareAt(point.x, point.y);
  if (!square || !userCanMove()) return;
  if (selected && legalTargets(selected).has(square)) {
    tryMove(selected, square);
    return;
  }
  const piece = game.get(square);
  if (piece && piece.color === game.turn()) {
    selected = square;
    drag = point;
    ui.canvas.setPointerCapture(e.pointerId);
    ui.canvas.style.cursor = "grabbing";
    redraw();
  } else if (selected) {
    selected = null;
    redraw();
  }
}

function onMotion(e) {
  const point = canvasPoint(e);
  if (drag) {
    drag = point;
    redraw();
    return;
  }
  const square = squareAt(point.x, point.y);
  const piece = square && game.get(square);
  const movable = userCanMove() && ((piece && piece.color === game.turn()) || (selected && legalTargets(selected).has(square)));
  ui.canvas.style.cursor = movable ? "pointer" : "default";
}

function onRelease(e) {
  if (!drag) return;
  drag = null;
  ui.canvas.style.cursor = "default";
  const point = canvasPoint(e);
  const square = squareAt(point.x, point.y);
  if (square && square !== selected && legalTargets(selected).has(square)) {
    tryMove(selected, square);
  } else {
    redraw();  // snap the piece back; it stays selected for click-to-move
  }
}

async function tryMove(from, to) {
  const candidates = game.moves({ square: from, verbose: true }).filter(m => m.to === to);
  if (!candidates.length) return;
  let promotion;
  if (candidates.some(m => m.promotion)) {  // one candidate per piece type
    redraw();
    promotion = await askPromotion(game.turn());
    if (!promotion) {
      selected = null;
      redraw();
      return;
    }
  }
  selected = null;
  drag = null;
  hintMove = null;
  game.move({ from, to, promotion });
  afterPositionChange();
}

/** Show the promotion picker; resolves with "q"/"r"/"b"/"n", or null if cancelled. */
function askPromotion(color) {
  return new Promise(resolve => {
    const finish = piece => {
      ui.promo.hidden = true;
      promoCancel = null;
      resolve(piece);
    };
    const buttons = ["q", "r", "b", "n"].map(type => {
      const button = document.createElement("button");
      button.type = "button";
      button.title = PIECE_NAMES[type];
      button.style.background = colors()[0];
      if (ui.pieceSet.value === UNICODE_SET) {
        button.textContent = color === "w" ? OUTLINE[type] : SOLID[type];
      } else {
        const img = document.createElement("img");
        img.src = pieceSrc(ui.pieceSet.value, color, type);
        img.alt = PIECE_NAMES[type];
        button.append(img);
      }
      button.onclick = e => { e.stopPropagation(); finish(type); };
      return button;
    });
    ui.promoBox.replaceChildren(...buttons);
    ui.promo.onclick = () => finish(null);  // clicking off the pieces cancels the move
    promoCancel = () => finish(null);
    ui.promo.hidden = false;
    buttons[0].focus();
  });
}

// ------------------------------------------------------------- game flow

function newGame() {
  const choice = document.querySelector("input[name=playAs]:checked").value;
  userColor = choice === "random" ? (Math.random() < 0.5 ? "w" : "b") : (choice === "white" ? "w" : "b");
  startGame(START_FEN);
}

/** Start a game from fen with the user playing userColor. */
function startGame(fen) {
  gen++;
  promoCancel?.();
  if (ui.gameOver.open) ui.gameOver.close();
  flipped = userColor === "b";
  game.load(fen);
  selected = null;
  drag = null;
  hintMove = null;
  thinking = false;
  evalInfo = [0.5, "0.0"];
  setStatus("");
  opponent.newGame();
  coach.newGame();
  drawEvalBar();
  afterPositionChange();
}

function afterPositionChange() {
  redraw();
  updateMoveList();
  requestEval();
  const result = outcome();
  if (result) {
    showGameOver(result);
  } else if (game.turn() !== userColor) {
    engineMove();
  } else {
    const side = userColor === "w" ? "White" : "Black";
    const prefix = status.startsWith("Stockfish played") ? status : "";
    const text = `Your move (${side})` + (game.inCheck() ? " — you are in check!" : "");
    setStatus(prefix ? `${prefix} ${text}` : text);
  }
}

function undo() {
  if (!game.history().length || promoCancel) return;
  gen++;
  thinking = false;
  opponent.stop();
  game.undo();
  while (game.history().length && game.turn() !== userColor) game.undo();
  selected = null;
  hintMove = null;
  setStatus("Move taken back.");
  afterPositionChange();
}

function flip() {
  if (mode === "play") flipped = !flipped;
  else editFlipped = !editFlipped;
  redraw();
  drawEvalBar();
}

/** {winner: "w" | "b" | null, reason} once the game is over (draws are claimed automatically), else null. */
function outcome() {
  if (game.isCheckmate()) return { winner: game.turn() === "w" ? "b" : "w", reason: "checkmate" };
  if (game.isStalemate()) return { winner: null, reason: "stalemate" };
  if (game.isInsufficientMaterial()) return { winner: null, reason: "insufficient material" };
  if (game.isThreefoldRepetition()) return { winner: null, reason: "repetition" };
  if (game.isDrawByFiftyMoves()) return { winner: null, reason: "50-move rule" };
  return null;
}

function resultString() {
  const result = outcome();
  if (!result) return "*";
  return result.winner === null ? "1/2-1/2" : (result.winner === "w" ? "1-0" : "0-1");
}

function showGameOver({ winner, reason }) {
  let text;
  if (winner === null) text = `Draw by ${reason}.`;
  else if (winner === userColor) text = `You win by ${reason}!`;
  else text = `Stockfish wins by ${reason}.`;
  setStatus(`Game over — ${text}  (${resultString()})`);
  const token = gen;
  setTimeout(() => {
    if (token !== gen || ui.gameOver.open || mode !== "play") return;
    ui.gameOverText.textContent = text;
    ui.gameOver.returnValue = "";
    ui.gameOver.showModal();
  }, 400);
}

// --------------------------------------------------- engine (background)

function token() {
  return `${gen}:${game.history().length}`;
}

/** The game as the engine sees it: the starting FEN plus the moves played (UCI). */
function enginePosition() {
  const history = game.history({ verbose: true });
  return { fen: history.length ? history[0].before : game.fen(), moves: history.map(m => m.lan) };
}

/** Run task(engine) in the engine's queue; callback(result) runs only if the position hasn't changed meanwhile. */
function runBg(engine, task, callback) {
  const started = token();
  const stale = () => started !== token();
  engine.run(e => (stale() ? undefined : task(e)))
    .then(result => {
      if (!stale() && result !== undefined) callback(result);
    })
    .catch(err => {
      if (stale()) return;
      thinking = false;
      setStatus(`Engine error: ${err?.message || err}`);
    });
}

function engineMove() {
  thinking = true;
  setStatus("Stockfish is thinking…");
  const position = enginePosition();
  const [options] = strengthOptions(oppStrength);
  const movetime = parseFloat(ui.thinkTime.value) * 1000;
  runBg(opponent, async e => {
    e.configure(options);
    return (await e.go(position, movetime)).move;
  }, onEngineMove);
}

function onEngineMove(uci) {
  thinking = false;
  if (!uci) return;
  const move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  setStatus(`Stockfish played ${move.san}.`);
  afterPositionChange();
}

function requestEval() {
  if (!ui.showEval.checked) return;
  const result = outcome();
  if (result) {
    if (result.winner === null) evalInfo = [0.5, "½"];
    else evalInfo = result.winner === "w" ? [1, "1-0"] : [0, "0-1"];
    drawEvalBar();
    return;
  }
  const position = enginePosition(), turn = game.turn();
  runBg(coach, async e => {
    e.configure(FULL_STRENGTH);
    const { score } = await e.go(position, 300);
    return whitePov(score, turn);
  }, score => {
    if (!score) return;
    evalInfo = scoreToBar(score);
    drawEvalBar();
  });
}

function showHint() {
  if (!userCanMove()) return;
  setStatus("Coach is thinking…");
  const position = enginePosition(), turn = game.turn();
  const [options, label] = strengthOptions(hintStrength);
  const full = !options.UCI_LimitStrength && options["Skill Level"] === 20;
  runBg(coach, async e => {
    // Skill Level / UCI_Elo only weaken the move Stockfish plays (its reported
    // score stays full strength), so only show the score at full strength.
    e.configure(options);
    const { move, score } = await e.go(position, 1000);
    return { move, score: full ? whitePov(score, turn) : null, label };
  }, onHint);
}

function onHint({ move, score, label }) {
  if (!move) return;
  const legal = game.moves({ verbose: true }).find(m => m.lan === move);
  if (!legal) return;
  hintMove = { from: legal.from, to: legal.to };
  let text = `Hint (${label}): ${legal.san}`;
  if (score) {
    evalInfo = scoreToBar(score);
    drawEvalBar();
    text += `  (eval ${evalInfo[1]})`;
  }
  redraw();
  setStatus(text);
}

// ------------------------------------------------------------- tabs

function setMode(next) {
  if (mode === next) return;
  promoCancel?.();
  mode = next;
  const analyze = mode === "analyze";
  ui.tabPlay.setAttribute("aria-selected", String(!analyze));
  ui.tabAnalyze.setAttribute("aria-selected", String(analyze));
  ui.playPanel.hidden = analyze;
  ui.analyzePanel.hidden = !analyze;
  drag = editDrag = paintTool = null;
  ui.canvas.style.cursor = "default";
  updateEvalVisibility();
  if (analyze) {
    positionEdited();
  } else {
    stopAnalysis();
    ui.status.textContent = status;
    drawEvalBar();
    redraw();
    requestEval();
  }
  saveSettings();
}

// ------------------------------------------------------- position editor

function buildPalette() {
  const tools = [["move", "Move"], ..."kqrbnp".split("").map(t => ["w" + t]),
    ["erase", "Erase"], ..."kqrbnp".split("").map(t => ["b" + t])];
  const buttons = tools.map(([tool, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.tool = tool;
    if (label) {
      button.className = "tool";
      button.textContent = label;
      button.title = tool === "move" ? "Drag pieces to move them" : "Click pieces to remove them";
    } else {
      const [color, type] = tool;
      button.title = `${color === "w" ? "White" : "Black"} ${PIECE_NAMES[type].toLowerCase()}`;
      button.style.background = colors()[0];
      if (ui.pieceSet.value === UNICODE_SET) {
        button.textContent = color === "w" ? OUTLINE[type] : SOLID[type];
      } else {
        const img = document.createElement("img");
        img.src = pieceSrc(ui.pieceSet.value, color, type);
        img.alt = button.title;
        button.append(img);
      }
    }
    button.onclick = () => selectTool(tool);
    return button;
  });
  ui.palette.replaceChildren(...buttons);
  selectTool(editTool);
}

function selectTool(tool) {
  editTool = tool;
  for (const button of ui.palette.children) button.classList.toggle("active", button.dataset.tool === tool);
}

function editFenString() {
  const rows = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = "", empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = editPieces[squareName(file, rank)];
      if (!piece) {
        empty++;
        continue;
      }
      if (empty) row += empty;
      empty = 0;
      row += piece.color === "w" ? piece.type.toUpperCase() : piece.type;
    }
    rows.push(row + (empty || ""));
  }
  // Keep the loaded castling rights whose king and rook still stand on their original squares.
  const at = (square, code) => {
    const piece = editPieces[square];
    return piece && piece.color + piece.type === code;
  };
  const home = { K: ["e1", "h1", "w"], Q: ["e1", "a1", "w"], k: ["e8", "h8", "b"], q: ["e8", "a8", "b"] };
  let castling = "";
  for (const [right, [king, rook, color]] of Object.entries(home)) {
    if (editCastling.includes(right) && at(king, color + "k") && at(rook, color + "r")) castling += right;
  }
  return `${rows.join("/")} ${editTurn} ${castling || "-"} - 0 1`;
}

/** Parse the board and side to move of a FEN; throws with a readable message. */
function parseFen(text) {
  const [placement, turn = "w", castling = "KQkq"] = text.trim().split(/\s+/);
  const rows = (placement || "").split("/");
  if (rows.length !== 8) throw new Error("A FEN needs 8 ranks separated by \"/\".");
  const pieces = {};
  rows.forEach((row, i) => {
    let file = 0;
    for (const ch of row) {
      if (/[1-8]/.test(ch)) {
        file += Number(ch);
      } else if (/[pnbrqk]/i.test(ch)) {
        if (file > 7) break;
        pieces[squareName(file, 7 - i)] = { color: ch === ch.toUpperCase() ? "w" : "b", type: ch.toLowerCase() };
        file++;
      } else {
        throw new Error(`Unexpected "${ch}" in the FEN.`);
      }
    }
    if (file !== 8) throw new Error(`Rank ${8 - i} of the FEN doesn't add up to 8 squares.`);
  });
  if (!/^[wb]$/.test(turn)) throw new Error("The side to move must be \"w\" or \"b\".");
  return { pieces, turn, castling: castling === "-" ? "" : castling };
}

function loadEditFen(text, edited = true) {
  try {
    const { pieces, turn, castling } = parseFen(text);
    editPieces = pieces;
    editTurn = turn;
    editCastling = castling;
    document.querySelector(`input[name=editTurn][value="${turn}"]`).checked = true;
  } catch (err) {
    if (edited) setEditStatus(err.message);
    return;
  }
  if (edited) positionEdited();
}

/** Check the edited position; returns {fen, chess} or {fen, error}. */
function validateEdit() {
  const fen = editFenString();
  const pieces = Object.entries(editPieces);
  const count = (color, type) => pieces.filter(([, p]) => p.color === color && (!type || p.type === type)).length;
  for (const [color, name] of [["w", "White"], ["b", "Black"]]) {
    if (count(color, "k") !== 1) return { fen, error: `${name} needs exactly one king.` };
    if (count(color, "p") > 8) return { fen, error: `${name} has more than 8 pawns.` };
    if (count(color) > 16) return { fen, error: `${name} has more than 16 pieces.` };
  }
  if (pieces.some(([square, p]) => p.type === "p" && (square[1] === "1" || square[1] === "8"))) {
    return { fen, error: "Pawns can't stand on the first or last rank." };
  }
  let chess;
  try {
    chess = new Chess(fen);
  } catch (err) {
    return { fen, error: err.message };
  }
  const waiting = editTurn === "w" ? "b" : "w";
  const waitingKing = chess.findPiece({ type: "k", color: waiting })[0];
  if (chess.isAttacked(waitingKing, editTurn)) {
    const [mover, other] = editTurn === "w" ? ["White", "Black"] : ["Black", "White"];
    return { fen, error: `${other} is in check while it's ${mover}'s move — that can't happen in a real game.` };
  }
  return { fen, chess };
}

/** Called after every change to the edited position: redraw and re-analyse. */
function positionEdited() {
  if (mode !== "analyze") return;
  const { fen, chess, error } = validateEdit();
  if (document.activeElement !== ui.editFen) ui.editFen.value = fen;
  editCheck = chess?.inCheck() ? chess.findPiece({ type: "k", color: editTurn })[0] : null;
  stopAnalysis();
  analysis = null;
  hoverLine = null;
  renderAnalysis();
  saveSettings();
  if (error) {
    editEval = [0.5, ""];
    drawEvalBar();
    redraw();
    setEditStatus(error);
    return;
  }
  const side = editTurn === "w" ? "White" : "Black";
  if (chess.isCheckmate()) {
    editEval = editTurn === "w" ? [0, "0-1"] : [1, "1-0"];
    setEditStatus(`${side} is checkmated.`);
  } else if (chess.isStalemate()) {
    editEval = [0.5, "½"];
    setEditStatus(`${side} has no legal moves — stalemate.`);
  } else {
    setEditStatus(`${side} to move — analysing…`);
    anaTimer = setTimeout(() => runAnalysis(fen), 250);
  }
  drawEvalBar();
  redraw();
}

function stopAnalysis() {
  anaGen++;
  clearTimeout(anaTimer);
  if (analysis && !analysis.done) coach?.stop();
}

function runAnalysis(fen) {
  const myGen = anaGen;
  const stale = () => myGen !== anaGen || mode !== "analyze";
  const turn = fen.split(" ")[1];
  const multipv = Number(ui.anaLines.value);
  analysis = { fen, turn, lines: [], done: false };
  let pending = false;
  const scheduleRender = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; if (!stale()) renderAnalysis(); });
  };
  coach.run(async e => {
    if (stale()) return;
    e.configure({ ...FULL_STRENGTH, MultiPV: multipv });
    try {
      await e.analyse(fen, Number(ui.anaTime.value) * 1000, info => {
        if (stale()) return;
        analysis.lines[info.multipv - 1] = info;
        scheduleRender();
      });
    } finally {
      e.configure({ MultiPV: 1 });
    }
  }).then(() => {
    if (stale()) return;
    analysis.done = true;
    renderAnalysis();
  }, err => {
    if (!stale()) setEditStatus(`Engine error: ${err?.message || err}`);
  });
}

function formatScore(score) {
  if (score.type === "mate") return `#${score.value}`;
  return `${score.value >= 0 ? "+" : ""}${(score.value / 100).toFixed(2)}`;
}

/** SAN with move numbers for the first `max` moves of a UCI principal variation. */
function pvToSan(fen, pv, max = 12) {
  const chess = new Chess(fen);
  const parts = [];
  for (const uci of pv.slice(0, max)) {
    const turn = chess.turn(), number = chess.moveNumber();
    let move;
    try {
      move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      break;
    }
    if (turn === "w") parts.push(`${number}. ${move.san}`);
    else parts.push(parts.length ? move.san : `${number}… ${move.san}`);
  }
  return parts;
}

function renderAnalysis() {
  const lines = (analysis?.lines || []).filter(Boolean);
  const items = lines.map((line, i) => {
    const score = whitePov(line.score, analysis.turn);
    const li = document.createElement("li");
    const badge = document.createElement("span");
    badge.className = score.value < 0 ? "score black" : "score";
    badge.textContent = formatScore(score);
    const pv = document.createElement("span");
    pv.className = "pv";
    const [first, ...rest] = pvToSan(analysis.fen, line.pv);
    const b = document.createElement("b");
    b.textContent = first || "";
    pv.append(b, rest.length ? " " + rest.join(" ") : "");
    li.append(badge, pv);
    li.onmouseenter = () => { hoverLine = i; redraw(); };
    return li;
  });
  ui.anaList.replaceChildren(...items);
  if (!analysis) {
    ui.anaInfo.textContent = "";
    return;
  }
  const best = lines[0];
  const depth = Math.max(0, ...lines.map(l => l.depth));
  ui.anaInfo.textContent = best
    ? `Depth ${depth} · ${coach.name}${analysis.done ? "" : " · thinking…"} · eval from White's side`
    : "Thinking…";
  if (best) {
    const side = analysis.turn === "w" ? "White" : "Black";
    const score = whitePov(best.score, analysis.turn);
    const san = pvToSan(analysis.fen, best.pv, 1)[0]?.replace(/^\d+(\.|…) /, "");
    editEval = scoreToBar(score);
    setEditStatus(`${side} to move — best move: ${san} (${formatScore(score)})`);
    drawEvalBar();
  }
  redraw();
}

function editPoint(e) {
  const point = canvasPoint(e);
  return { point, square: squareAt(point.x, point.y) };
}

function samePiece(piece, tool) {
  return piece && piece.color + piece.type === tool;
}

function paint(square) {
  if (paintTool === "erase") {
    if (!editPieces[square]) return;
    delete editPieces[square];
  } else {
    if (samePiece(editPieces[square], paintTool)) return;
    editPieces[square] = { color: paintTool[0], type: paintTool[1] };
  }
  positionEdited();
}

function onEditPress(e) {
  if (e.button !== 0) return;
  const { point, square } = editPoint(e);
  if (!square) return;
  ui.canvas.setPointerCapture(e.pointerId);
  if (editTool === "move") {
    const piece = editPieces[square];
    if (piece) {
      editDrag = { from: square, piece, x: point.x, y: point.y };
      ui.canvas.style.cursor = "grabbing";
      redraw();
    }
    return;
  }
  // Clicking a square that already holds the chosen piece clears it.
  paintTool = editTool !== "erase" && samePiece(editPieces[square], editTool) ? "erase" : editTool;
  paint(square);
}

function onEditMotion(e) {
  const { point, square } = editPoint(e);
  if (editDrag) {
    editDrag.x = point.x;
    editDrag.y = point.y;
    redraw();
  } else if (paintTool) {
    if (square) paint(square);
  } else {
    const grab = editTool === "move" && square && editPieces[square];
    ui.canvas.style.cursor = editTool === "move" ? (grab ? "grab" : "default") : "crosshair";
  }
}

function onEditRelease(e) {
  paintTool = null;
  if (!editDrag) return;
  const { square } = editPoint(e);
  const { from, piece } = editDrag;
  editDrag = null;
  ui.canvas.style.cursor = "default";
  if (square === from) {
    redraw();
    return;
  }
  delete editPieces[from];
  if (square) editPieces[square] = piece;  // dropped off the board: removed
  positionEdited();
}

function onEditContextMenu(e) {
  if (mode !== "analyze") return;
  e.preventDefault();
  const { square } = editPoint(e);
  if (square && editPieces[square]) {
    delete editPieces[square];
    positionEdited();
  }
}

// --------------------------------------------------- position from image

let vision = null;      // vision.js, loaded on first use
let imageRead = null;   // {image, source, box, result, drawing} while the image dialog is open

function onPaste(e) {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
  if (!item) return;
  e.preventDefault();
  readFromImage(item.getAsFile());
}

function onDragOver(e) {
  if (!e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  document.body.classList.add("dropping");
}

function onDrop(e) {
  document.body.classList.remove("dropping");
  const file = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith("image/"));
  if (!file) return;
  e.preventDefault();
  readFromImage(file);
}

async function readFromImage(blob) {
  if (!blob?.type?.startsWith("image/")) return;
  setMode("analyze");
  let image;
  try {
    vision ??= await import("./vision.js");
    image = await vision.loadImage(blob);
  } catch (err) {
    setEditStatus(`Couldn't read that image: ${err.message}`);
    return;
  }
  openImageDialog(image);
}

/** Show the image dialog for a picture: find the board, read it, let the user check it.
 *  watchSetup: the picture is the first frame of a watched screen/camera. */
async function openImageDialog(image, watchSetup = false) {
  setMode("analyze");
  // Keep a canvas copy of the picture for drawing the preview.
  const source = document.createElement("canvas");
  source.width = image.width;
  source.height = image.height;
  source.getContext("2d").putImageData(image, 0, 0);
  imageRead = { image, source, board: null, result: null, drawing: null, corner: -1, watchSetup };
  ui.imageUse.textContent = watchSetup ? `Start watching (every ${WATCH_SECONDS} s)` : "Use this position";
  const read = imageRead;
  const scale = Math.min(1, 1400 / Math.max(read.image.width, read.image.height));
  ui.imageCanvas.width = Math.round(read.image.width * scale);
  ui.imageCanvas.height = Math.round(read.image.height * scale);
  ui.imageMsg.textContent = "Finding the board…";
  ui.imageUse.disabled = true;
  ui.imageDialog.returnValue = "";
  if (!ui.imageDialog.open) ui.imageDialog.showModal();
  drawImagePreview();
  await nextPaint();
  read.board = vision.detectBoard(read.image);
  if (read !== imageRead) return;
  drawImagePreview();
  await recognise();
}

/** Let the browser repaint before a long computation. */
const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

async function recognise() {
  const read = imageRead;
  read.result = null;
  ui.imageUse.disabled = true;
  ui.imageMsg.textContent = "Reading the board…";
  drawImagePreview();
  await nextPaint();
  const result = read.board ? await vision.readBoard(read.image, read.board) : null;
  if (read !== imageRead) return;
  read.result = result;
  if (result) {
    ui.imageFlipped.checked = result.flipped;
    document.querySelector(`input[name=imageTurn][value="${result.turn}"]`).checked = true;
  }
  ui.imageUse.disabled = !result;
  ui.imageMsg.textContent = result
    ? "Check the letters against the picture. If the grid is off, drag its corners, or drag a box around " +
      "the board's 64 squares. Orange squares are uncertain; you can fix any mistake in the editor afterwards."
    : "Couldn't find a board in this picture. Drag a box around the board's 64 squares.";
  drawImagePreview();
}

function drawImagePreview() {
  const read = imageRead;
  if (!read) return;
  const c = ui.imageCanvas, g = c.getContext("2d");
  const k = c.width / read.image.width;
  g.imageSmoothingQuality = "high";
  g.drawImage(read.source, 0, 0, c.width, c.height);
  const line = Math.max(1, c.width / 500);
  if (read.drawing) {
    const { x, y, w, h } = read.drawing;
    g.setLineDash([6 * line, 4 * line]);
    g.strokeStyle = "#e8493f";
    g.lineWidth = 2 * line;
    g.strokeRect(x * k, y * k, w * k, h * k);
    g.setLineDash([]);
    return;
  }
  if (!read.board) return;
  const at = (x, y) => vision.boardPoint(read.board, x, y).map(v => v * k);
  const path = points => {
    g.beginPath();
    points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  };
  g.strokeStyle = "rgba(21, 120, 27, 0.9)";
  g.lineWidth = line;
  for (let i = 0; i <= 8; i++) {
    path([at(i, 0), at(i, 8)]);
    g.stroke();
    path([at(0, i), at(8, i)]);
    g.stroke();
  }
  // corner handles (drag to adjust the grid)
  g.fillStyle = "rgba(21, 120, 27, 0.9)";
  for (const [x, y] of read.board.corners) {
    g.beginPath();
    g.arc(x * k, y * k, 5 * line, 0, 2 * Math.PI);
    g.fill();
  }
  if (!read.result) return;
  g.textAlign = "center";
  g.textBaseline = "middle";
  read.result.grid.forEach((cells, row) => cells.forEach((code, col) => {
    const quad = [at(col, row), at(col + 1, row), at(col + 1, row + 1), at(col, row + 1)];
    if (read.result.confidence[row][col] < 0.6) {
      const inset = (p, f) => [p[0] + (quad[0][0] + quad[2][0]) / 2 * f - p[0] * f, p[1] + (quad[0][1] + quad[2][1]) / 2 * f - p[1] * f];
      path(quad.map(p => inset(p, 0.08)));
      g.closePath();
      g.strokeStyle = "#ff9800";
      g.lineWidth = 3 * line;
      g.stroke();
    }
    if (!code) return;
    // A badge in the corner: white letter on black for Black's pieces, and vice versa.
    const r = 0.2 * Math.min(Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]),
      Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]));
    const [bx, by] = at(col + 0.25, row + 0.25);
    g.font = `bold ${r * 1.3}px system-ui, sans-serif`;
    g.beginPath();
    g.arc(bx, by, r, 0, 2 * Math.PI);
    g.fillStyle = code[0] === "w" ? "#ffffff" : "#222222";
    g.fill();
    g.strokeStyle = code[0] === "w" ? "#222222" : "#ffffff";
    g.lineWidth = line;
    g.stroke();
    g.fillStyle = code[0] === "w" ? "#222222" : "#ffffff";
    g.fillText(code[1], bx, by + r * 0.05);
  }));
}

function imagePoint(e) {
  const rect = ui.imageCanvas.getBoundingClientRect();
  const scale = imageRead.image.width / rect.width;
  return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale, scale };
}

function onImagePress(e) {
  if (!imageRead || e.button !== 0) return;
  ui.imageCanvas.setPointerCapture(e.pointerId);
  const p = imagePoint(e);
  // Near a corner of the grid: drag that corner; elsewhere: draw a new box.
  const corners = imageRead.board?.corners || [];
  const near = corners.map(([x, y]) => Math.hypot(x - p.x, y - p.y) / p.scale);
  const i = near.indexOf(Math.min(...near));
  if (i >= 0 && near[i] < 16) {
    imageRead.corner = i;
    return;
  }
  imageRead.anchor = p;
  imageRead.drawing = { x: p.x, y: p.y, w: 0, h: 0 };
}

function onImageMotion(e) {
  const read = imageRead;
  if (!read) return;
  const p = imagePoint(e);
  if (read.corner >= 0) {
    const corners = read.board.corners.map(c => c.slice());
    corners[read.corner] = [p.x, p.y];
    read.board = { corners };
    read.result = null;
    drawImagePreview();
    return;
  }
  if (!read.drawing) return;
  const a = read.anchor;
  read.drawing = { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) };
  drawImagePreview();
}

function onImageRelease() {
  const read = imageRead;
  if (!read) return;
  if (read.corner >= 0) {
    read.corner = -1;
    recognise();
    return;
  }
  if (!read.drawing) return;
  const box = read.drawing;
  read.drawing = null;
  if (box.w < 16 || box.h < 16) {
    drawImagePreview();
    return;
  }
  read.board = vision.boardFromBox(box);
  recognise();
}

function applyImageResult(read = imageRead) {
  const result = read?.result;
  if (!result) return;
  const flippedBoard = ui.imageFlipped.checked;
  const turn = document.querySelector("input[name=imageTurn]:checked").value;
  editFlipped = flippedBoard;  // show the position the way the picture did
  loadEditFen(`${vision.placementFen(result.grid, flippedBoard)} ${turn} KQkq - 0 1`);
}

// --------------------------------------------------- watch a window or camera
// The board is found once (in the image dialog); after that only the pieces are read again,
// every WATCH_SECONDS, from the same place in the picture.

const WATCH_SECONDS = 10;
let watch = null;   // {stream, video, board, flipped, turn, grid, fen, next, timer, busy}

async function startWatch(kind) {
  stopWatch();
  let stream;
  try {
    vision ??= await import("./vision.js");
    stream = kind === "screen"
      ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      : await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "environment" }, audio: false });
  } catch (err) {
    setEditStatus(`Couldn't start ${kind === "screen" ? "screen sharing" : "the camera"}: ${err.message}`);
    return;
  }
  const video = ui.watchVideo;
  video.srcObject = stream;
  watch = { stream, video, board: null };
  stream.getVideoTracks()[0].addEventListener("ended", stopWatch);   // "Stop sharing" in the browser
  try {
    await video.play();
    for (let i = 0; i < 100 && !video.videoWidth; i++) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => setTimeout(r, 300));   // the first frames are often blank
  } catch (err) {
    setEditStatus(`Couldn't show the video: ${err.message}`);
    stopWatch();
    return;
  }
  if (!watch || !video.videoWidth) return;
  openImageDialog(vision.grabFrame(video), true);
}

/** The image dialog was confirmed: remember the board and read it every WATCH_SECONDS. */
function startWatching(read) {
  if (!watch) return;
  clearInterval(watch.timer);
  watch.board = read.board;
  watch.flipped = ui.imageFlipped.checked;
  watch.turn = document.querySelector("input[name=imageTurn]:checked").value;
  watch.grid = read.result.grid;
  watch.fen = null;
  ui.watchPanel.hidden = false;
  showWatchResult(read.result.grid, watch.turn);
  watch.next = Date.now() + WATCH_SECONDS * 1000;
  watch.timer = setInterval(watchTick, 1000);
  watchTick();
}

async function watchTick() {
  const w = watch;
  if (!w?.board) return;
  drawWatchPreview();
  const left = Math.ceil((w.next - Date.now()) / 1000);
  if (w.busy || left > 0) {
    ui.watchMsg.textContent = w.busy ? "Reading…" : `Next read in ${left} s`;
    return;
  }
  w.busy = true;
  ui.watchMsg.textContent = "Reading…";
  try {
    const result = await vision.readBoard(vision.grabFrame(w.video), w.board);
    if (w !== watch) return;
    w.turn = moverTurn(w.grid, result.grid) ?? w.turn;
    w.grid = result.grid;
    showWatchResult(result.grid, w.turn);
  } catch (err) {
    ui.watchMsg.textContent = `Couldn't read the board: ${err.message}`;
  } finally {
    w.busy = false;
    w.next = Date.now() + WATCH_SECONDS * 1000;
  }
}

/** Side to move after a change: the opposite of the colour whose pieces appeared on new squares. */
function moverTurn(before, after) {
  const colors = new Set();
  after.forEach((cells, r) => cells.forEach((code, c) => {
    if (code && code !== before[r][c]) colors.add(code[0]);
  }));
  return colors.size === 1 ? (colors.has("w") ? "b" : "w") : null;
}

function showWatchResult(grid, turn) {
  const fen = `${vision.placementFen(grid, watch.flipped)} ${turn} - - 0 1`;
  ui.watchTime.textContent = `read at ${new Date().toLocaleTimeString()}`;
  if (fen === watch.fen) return;
  watch.fen = fen;
  ui.watchFen.textContent = fen;
  if (ui.watchFollow.checked && mode === "analyze") {
    editFlipped = watch.flipped;   // show the position the way the picture does
    loadEditFen(fen);
  }
}

/** Small live view of the watched picture with the board's outline. */
function drawWatchPreview() {
  const { video, board } = watch;
  const c = ui.watchCanvas, g = c.getContext("2d"), k = c.width / vision.IMAGE_SIZE;
  const r = vision.fitRect(video.videoWidth, video.videoHeight);
  g.fillStyle = "#000";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(video, r.x * k, r.y * k, r.w * k, r.h * k);
  g.strokeStyle = "#3bd13b";
  g.lineWidth = 2;
  g.beginPath();
  board.corners.forEach(([x, y], i) => (i ? g.lineTo(x * k, y * k) : g.moveTo(x * k, y * k)));
  g.closePath();
  g.stroke();
}

function stopWatch() {
  if (!watch) return;
  clearInterval(watch.timer);
  watch.stream.getTracks().forEach(t => t.stop());
  watch.video.srcObject = null;
  watch = null;
  ui.watchPanel.hidden = true;
}

function playFromHere() {
  const { fen, chess, error } = validateEdit();
  if (error) {
    setEditStatus(error);
    return;
  }
  if (chess.isGameOver()) {
    setEditStatus("That position is already over — there is nothing to play.");
    return;
  }
  userColor = editTurn;
  setMode("play");
  startGame(fen);
}

// ---------------------------------------------------------------- export

function buildPgn() {
  const pgn = new Chess(enginePosition().fen);  // sets the SetUp/FEN headers for custom positions
  const you = "You", engine = opponentLabel();
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  pgn.setHeader("Event", "Training game");
  pgn.setHeader("Site", "Chess Trainer");
  pgn.setHeader("Date", `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`);
  pgn.setHeader("White", userColor === "w" ? you : engine);
  pgn.setHeader("Black", userColor === "w" ? engine : you);
  pgn.setHeader("Result", resultString());
  for (const san of game.history()) pgn.move(san);
  return pgn.pgn();
}

function savePgn() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  const name = `game_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.pgn`;
  const url = URL.createObjectURL(new Blob([buildPgn() + "\n"], { type: "application/x-chess-pgn" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`Saved ${name}`);
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older browsers / insecure contexts: fall back to a hidden textarea.
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) {
      setStatus("Could not copy to the clipboard.");
      return;
    }
  }
  setStatus(message);
}

// ------------------------------------------------------------------ start

buildUi();
loadPieceImages();
newGame();
if (mode === "analyze") {
  mode = "play";
  setMode("analyze");
}
