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
const PIECE_NAMES = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" };

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
  loadSettings();
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

  ui.canvas.addEventListener("pointerdown", onPress);
  ui.canvas.addEventListener("pointermove", onMotion);
  ui.canvas.addEventListener("pointerup", onRelease);
  ui.canvas.addEventListener("pointercancel", () => { drag = null; redraw(); });
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
}

function onKey(e) {
  if (promoCancel) {
    if (e.key === "Escape") promoCancel();
    return;
  }
  const t = e.target;
  if (t.matches?.("input[type=number], select, textarea") || ui.gameOver.open) return;
  const key = e.key.toLowerCase();
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
  ui.status.textContent = text;
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
  redraw();
}

function pieceSrc(set, color, type) {
  return `pieces/${set}/${color}${type.toUpperCase()}.png`;
}

function onShowEval() {
  ui.eval.hidden = !ui.showEval.checked;
  if (ui.showEval.checked) requestEval();
}

// -------------------------------------------------------------- settings

const SETTING_IDS = ["engine", "oppLevel", "oppLimit", "oppElo", "thinkTime", "hintLevel", "hintLimit", "hintElo",
  "showEval", "showMoves", "pieceSet", "theme"];

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
  ui.eval.hidden = !ui.showEval.checked;
}

function saveSettings() {
  const saved = { playAs: document.querySelector("input[name=playAs]:checked").value };
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

function squareCell(square) {
  const file = fileOf(square), rank = rankOf(square);
  return flipped ? [7 - file, rank] : [file, 7 - rank];
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
  return flipped ? squareName(7 - col, row) : squareName(col, 7 - row);
}

function isLightSquare(square) {
  return (fileOf(square) + rankOf(square)) % 2 === 1;
}

function lastMove() {
  const history = game.history({ verbose: true });
  return history[history.length - 1] || null;
}

function squareColor(square, last) {
  const [light, dark, lightHl, darkHl] = colors();
  const light_ = isLightSquare(square);
  if (square === selected || (last && (square === last.from || square === last.to))) return light_ ? lightHl : darkHl;
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

function redraw() {
  if (!sq) return;
  ctx.imageSmoothingQuality = "high";
  const last = lastMove();
  const checkSquare = game.inCheck() ? game.findPiece({ type: "k", color: game.turn() })[0] : null;

  for (let file = 0; file < 8; file++) {
    for (let rank = 0; rank < 8; rank++) {
      const square = squareName(file, rank);
      const [x, y, w, h] = cellRect(...squareCell(square));
      ctx.fillStyle = squareColor(square, last);
      ctx.fillRect(x, y, w, h);
      if (square === checkSquare) {
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
  ctx.font = `bold ${Math.max(9, sq / 6.5)}px system-ui, "DejaVu Sans", sans-serif`;
  for (let i = 0; i < 8; i++) {
    const fileChar = "abcdefgh"[flipped ? 7 - i : i];
    const rankChar = String(flipped ? i + 1 : 8 - i);
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

  if (selected && ui.showMoves.checked) {
    for (const move of game.moves({ square: selected, verbose: true })) {
      const [cx, cy] = squareCenter(move.to);
      ctx.beginPath();
      if (move.captured) {
        ctx.strokeStyle = shade(squareColor(move.to, last), 0.8);
        ctx.lineWidth = Math.max(3, sq / 12);
        ctx.arc(cx, cy, sq * 0.46 - ctx.lineWidth / 2, 0, 2 * Math.PI);
        ctx.stroke();
      } else {
        ctx.fillStyle = shade(squareColor(move.to, last), 0.8);
        ctx.arc(cx, cy, sq * 0.15, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }

  for (const row of game.board()) {
    for (const piece of row) {
      if (!piece || (drag && piece.square === selected)) continue;
      drawPiece(piece, ...squareCenter(piece.square));
    }
  }

  if (hintMove) drawArrow(hintMove.from, hintMove.to);
  if (drag && selected) drawPiece(game.get(selected), drag.x, drag.y);
}

function drawEvalBar() {
  const [frac, label] = evalInfo;
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
  const items = [];
  for (let i = 0; i < sans.length; i += 2) {
    const li = document.createElement("li");
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = `${i / 2 + 1}.`;
    li.append(num);
    for (const j of [i, i + 1]) {
      const span = document.createElement("span");
      span.textContent = sans[j] || "";
      if (j === sans.length - 1) span.className = "last";
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
  gen++;
  promoCancel?.();
  if (ui.gameOver.open) ui.gameOver.close();
  const choice = document.querySelector("input[name=playAs]:checked").value;
  userColor = choice === "random" ? (Math.random() < 0.5 ? "w" : "b") : (choice === "white" ? "w" : "b");
  flipped = userColor === "b";
  game.reset();
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
  flipped = !flipped;
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
    if (token !== gen || ui.gameOver.open) return;
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

// ---------------------------------------------------------------- export

function buildPgn() {
  const pgn = new Chess();
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
