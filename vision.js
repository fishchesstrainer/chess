// Read a chess position from a picture: a photo of a board at any angle, a screenshot or a diagram.
//
// 1. Find the board (vision/board.js, a port of the Python detector in the workspace's vision/):
//    X-corners where four squares meet -> grid hypotheses -> the 8x8 placement that looks most
//    like a checkerboard. The older detector for flat screenshots (long, evenly spaced edge
//    lines) is kept below and its box competes as one more candidate.
// 2. Cut out the 64 squares (warp at 64 px per square, grayscale, 32x32) and classify each
//    with a small CNN (vision/cnn.js, weights in vision/piece_cnn.*, trained on 33 piece styles).

import { detectBoard as detectQuad, cutSquares, boardHomography, apply } from "./vision/board.js";
import { loadModel, classify } from "./vision/cnn.js";

const DETECT_SIZE = 1200;       // longest side used by the screenshot detector
let modelPromise = null;

// ------------------------------------------------------------------ pixels

export const IMAGE_SIZE = 640;  // every picture is read at IMAGE_SIZE × IMAGE_SIZE

/**
 * Decode an image File/Blob into {data, width, height} (RGBA), scaled to fit IMAGE_SIZE ×
 * IMAGE_SIZE without distortion and centred on black.
 */
export async function loadImage(blob) {
  const bitmap = await createImageBitmap(blob);
  const image = fitToSquare(bitmap, bitmap.width, bitmap.height);
  bitmap.close?.();
  return image;
}

/** The current frame of a playing <video>, prepared like loadImage(). */
export function grabFrame(video) {
  return fitToSquare(video, video.videoWidth, video.videoHeight);
}

/** Where a width × height picture lands in the IMAGE_SIZE square: {x, y, w, h}. */
export function fitRect(width, height) {
  const scale = IMAGE_SIZE / Math.max(width, height);
  const w = Math.round(width * scale), h = Math.round(height * scale);
  return { x: Math.floor((IMAGE_SIZE - w) / 2), y: Math.floor((IMAGE_SIZE - h) / 2), w, h };
}

function fitToSquare(source, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = IMAGE_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, IMAGE_SIZE, IMAGE_SIZE);
  const r = fitRect(width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, r.x, r.y, r.w, r.h);
  return ctx.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE);
}

/** Split RGBA data into float planes [r, g, b, luminance]. */
function planes({ data, width, height }) {
  const n = width * height;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), y = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    r[i] = data[j];
    g[i] = data[j + 1];
    b[i] = data[j + 2];
    y[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }
  return { r, g, b, y, width, height };
}

// ------------------------------------------------------------- detection

/**
 * Find the board; returns {corners: [[x, y] x 4]} in image pixels (clockwise from the top-left
 * corner of the board as seen), or null.
 */
export function detectBoard(image) {
  const box = detectScreenshotBox(image);
  const found = detectQuad(image, box ? [box] : []);
  if (found) return { corners: found.corners };
  // A tightly cropped, almost square picture is probably just the board.
  const ratio = image.width / image.height;
  if (ratio > 0.95 && ratio < 1.05) return boardFromBox({ x: 0, y: 0, w: image.width, h: image.height });
  return null;
}

/** A board given by an axis-aligned box {x, y, w, h}. */
export function boardFromBox({ x, y, w, h }) {
  return { corners: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] };
}

/** Image position of board coordinates (x, y), each 0..8 (0, 0 = corners[0]). */
export function boardPoint(board, x, y) {
  board.H ??= boardHomography(board.corners);
  return apply(board.H, x, y);
}

/** The flat-screenshot detector: box {x, y, w, h} of a board drawn axis-aligned, or null. */
function detectScreenshotBox(image) {
  const scale = Math.min(1, DETECT_SIZE / Math.max(image.width, image.height));
  const small = scale < 1 ? downscale(image, scale) : image;
  const found = detectGrid(planes(small));
  return found && { x: found.x / scale, y: found.y / scale, w: found.w / scale, h: found.h / scale };
}

function downscale(image, scale) {
  const src = document.createElement("canvas");
  src.width = image.width;
  src.height = image.height;
  src.getContext("2d").putImageData(image, 0, 0);
  const dst = document.createElement("canvas");
  dst.width = Math.max(1, Math.round(image.width * scale));
  dst.height = Math.max(1, Math.round(image.height * scale));
  const ctx = dst.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, dst.width, dst.height);
  return ctx.getImageData(0, 0, dst.width, dst.height);
}

function boxBlur3(plane, W, H) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      tmp[i] = (plane[i - (x > 0)] + plane[i] + plane[i + (x < W - 1)]) / 3;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      out[i] = (tmp[i - (y > 0) * W] + tmp[i] + tmp[i + (y < H - 1) * W]) / 3;
    }
  }
  return out;
}

function detectGrid({ r, g, b, width: W, height: H }) {
  const [R, G, B] = [r, g, b].map(p => boxBlur3(p, W, H));
  const EDGE = 36;  // colour difference (sum over RGB) that counts as an edge
  const diff = (i, j) => Math.abs(R[i] - R[j]) + Math.abs(G[i] - G[j]) + Math.abs(B[i] - B[j]);
  // vEdge: colour changes left-right (vertical lines); hEdge: changes top-bottom.
  const vEdge = new Uint8Array(W * H), hEdge = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      vEdge[i] = diff(i + 1, i - 1) > EDGE;
      hEdge[i] = diff(i + W, i - W) > EDGE;
    }
  }
  const minLen = Math.max(40, 0.12 * Math.min(W, H));
  const vLines = lineCandidates(W, H, (p, c) => vEdge[c * W + p], minLen);
  const hLines = lineCandidates(H, W, (p, c) => hEdge[p * W + c], minLen);
  const v = bestProgression(vLines), h = bestProgression(hLines);
  if (!v || !h) return null;

  // Lines between ranks run exactly across the board's width, and vice versa.
  const median = list => list.slice().sort((a, b) => a - b)[list.length >> 1];
  const left = median(h.lines.map(l => l.start)), right = median(h.lines.map(l => l.end));
  const top = median(v.lines.map(l => l.start)), bottom = median(v.lines.map(l => l.end));
  const x = fitGrid(v.lines, left, right), y = fitGrid(h.lines, top, bottom);
  if (!x || !y) return null;
  if (Math.abs(x.step - y.step) > 0.1 * Math.max(x.step, y.step)) return null;
  return { x: x.origin, y: y.origin, w: 8 * x.step, h: 8 * y.step };
}

/** For each position along an axis, the longest (gap-tolerant) run of edge pixels across it. */
function lineCandidates(length, across, isEdge, minLen) {
  const GAP = 6;
  const runs = [];
  for (let p = 1; p < length - 1; p++) {
    let best = 0, bestStart = 0, start = 0, last = -1e9;
    for (let c = 0; c < across; c++) {
      if (!isEdge(p, c)) continue;
      if (c - last > GAP + 1) start = c;
      last = c;
      if (c - start + 1 > best) {
        best = c - start + 1;
        bestStart = start;
      }
    }
    runs.push({ pos: p, start: bestStart, end: bestStart + best, len: best });
  }
  // Keep the strongest position of each group of neighbouring long runs.
  const lines = [];
  for (const run of runs) {
    if (run.len < minLen) continue;
    const last = lines[lines.length - 1];
    if (last && run.pos - last.pos <= 2) {
      if (run.len > last.len) lines[lines.length - 1] = run;
    } else {
      lines.push(run);
    }
  }
  return lines;
}

/** The best set of ≥6 lines that sit on one 9-line grid with equal spacing. */
function bestProgression(lines) {
  let best = null;
  const near = (pos, tol) => {
    let lo = 0, hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].pos < pos) lo = mid + 1;
      else hi = mid;
    }
    let found = null;
    for (const k of [lo - 1, lo]) {
      const line = lines[k];
      if (line && Math.abs(line.pos - pos) <= tol && (!found || line.len > found.len)) found = line;
    }
    return found;
  };
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      // Lines of one board span (roughly) the same stretch.
      if (Math.abs(a.start - b.start) > 0.15 * a.len || Math.abs(a.end - b.end) > 0.15 * a.len) continue;
      for (let m = 1; m <= 8; m++) {
        const step = (b.pos - a.pos) / m;
        if (step < 8) break;
        if (a.len < 4.5 * step || a.len > 9 * step) continue;
        const tol = Math.max(1.5, 0.04 * step);
        const hits = [];
        for (let t = -8; t <= 8; t++) {
          const line = near(a.pos + t * step, tol);
          hits.push(line && line.len >= 4.5 * step && Math.abs(line.start - a.start) < 0.15 * a.len ? line : null);
        }
        for (let t0 = 0; t0 + 9 <= hits.length; t0++) {
          const window = hits.slice(t0, t0 + 9).filter(Boolean);
          if (window.length < 6) continue;
          const score = window.length * 1000 + window.reduce((s, l) => s + l.len, 0) / step;
          if (!best || score > best.score) best = { score, step, lines: window };
        }
      }
    }
  }
  return best;
}

/** Least-squares fit of line positions to origin + k·step, with k from the board's extent. */
function fitGrid(lines, start, end) {
  const step0 = (end - start) / 8;
  if (step0 < 8) return null;
  const pts = [];
  for (const line of lines) {
    const k = Math.round((line.pos + 0.5 - start) / step0);
    if (k >= 0 && k <= 8 && Math.abs(line.pos + 0.5 - (start + k * step0)) < 0.2 * step0) pts.push([k, line.pos + 0.5]);
  }
  if (pts.length < 5) return null;
  const n = pts.length;
  const sk = pts.reduce((s, [k]) => s + k, 0), sp = pts.reduce((s, [, p]) => s + p, 0);
  const skk = pts.reduce((s, [k]) => s + k * k, 0), skp = pts.reduce((s, [k, p]) => s + k * p, 0);
  const step = (n * skp - sk * sp) / (n * skk - sk * sk);
  const origin = (sp - step * sk) / n;
  return { origin, step };
}

// ------------------------------------------------------------- recognition

function loadPieceModel() {
  modelPromise ??= (async () => {
    const [meta, bin] = await Promise.all([
      fetch(new URL("vision/piece_cnn.json", import.meta.url)).then(r => r.json()),
      fetch(new URL("vision/piece_cnn.bin", import.meta.url)).then(r => r.arrayBuffer()),
    ]);
    return loadModel(meta, bin);
  })();
  return modelPromise;
}

const CODE = { P: "wP", N: "wN", B: "wB", R: "wR", Q: "wQ", K: "wK", p: "bP", n: "bN", b: "bB", r: "bR", q: "bQ", k: "bK" };

/**
 * Recognise the pieces on a board {corners} found in the image.
 * Returns {grid, confidence, flipped, turn}: grid[row][col] is "" or a code such as "wN",
 * as displayed (row 0 at the top); confidence is the model's probability; flipped and turn
 * are guesses.
 */
export async function readBoard(image, board) {
  const model = await loadPieceModel();
  const { pixels, rings } = cutSquares(image, board.corners);
  const grid = [...Array(8)].map(() => Array(8).fill(""));
  const confidence = [...Array(8)].map(() => Array(8).fill(1));
  const ring = [...Array(8)].map(() => Array(8));
  const classes = model.meta.classes, n = classes.length;
  for (let row = 0; row < 8; row++) {
    // one rank at a time, giving the page a chance to repaint in between
    await new Promise(resolve => setTimeout(resolve, 0));
    const probs = classify(model, pixels.subarray(row * 8 * 1024, (row + 1) * 8 * 1024), 8);
    for (let col = 0; col < 8; col++) {
      const p = probs.subarray(col * n, (col + 1) * n);
      let best = 0;
      for (let k = 1; k < n; k++) if (p[k] > p[best]) best = k;
      grid[row][col] = classes[best] === "." ? "" : CODE[classes[best]];
      confidence[row][col] = p[best];
      ring[row][col] = rings[row * 8 + col];
    }
  }
  return { grid, confidence, flipped: guessFlipped(grid), turn: guessTurn(grid, ring) };
}

/** Viewed from Black's side if White's pieces sit mostly at the top. */
function guessFlipped(grid) {
  let score = 0;
  grid.forEach((cells, row) => cells.forEach(code => {
    if (!code) return;
    const weight = code[1] === "K" ? 3 : code[1] === "P" ? 2 : 1;
    score += (code[0] === "w" ? 1 : -1) * (row >= 4 ? 1 : -1) * weight;
  }));
  return score < 0;
}

/**
 * Side to move, from a last-move highlight: two squares whose colour differs from the
 * other squares of their shade, one of them now holding the piece that just moved.
 */
function guessTurn(grid, ring) {
  const shades = [[], []];
  ring.forEach((cells, row) => cells.forEach((rgb, col) => shades[(row + col) % 2].push({ row, col, rgb })));
  const highlighted = [];
  for (const squares of shades) {
    const med = [0, 1, 2].map(c => squares.map(s => s.rgb[c]).sort((a, b) => a - b)[squares.length >> 1]);
    for (const s of squares) {
      if (s.rgb.reduce((sum, v, c) => sum + Math.abs(v - med[c]), 0) > 45) highlighted.push(s);
    }
  }
  if (highlighted.length !== 2) return "w";
  const pieces = highlighted.map(s => grid[s.row][s.col]).filter(Boolean);
  if (pieces.length !== 1) return "w";
  return pieces[0][0] === "w" ? "b" : "w";
}

/** FEN piece placement for a grid as displayed (rotated when the board was seen from Black's side). */
export function placementFen(grid, flipped) {
  const rows = flipped ? grid.slice().reverse().map(r => r.slice().reverse()) : grid;
  return rows.map(cells => {
    let out = "", empty = 0;
    for (const code of cells) {
      if (!code) {
        empty++;
        continue;
      }
      if (empty) out += empty;
      empty = 0;
      out += code[0] === "w" ? code[1] : code[1].toLowerCase();
    }
    return out + (empty || "");
  }).join("/");
}
