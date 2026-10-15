// Read a chess position from a picture of a 2D board (a screenshot or a diagram).
//
// No machine learning:
// 1. The board is found from the lines between squares: on a checkerboard every
//    boundary between two files (or ranks) separates different colours along the whole
//    board, so we look for 7-9 long, evenly spaced edge lines in each direction.
// 2. Each square is compared with many piece sets (vision/templates.png, built by
//    tools/make_templates.py), each piece composited onto that square's own background
//    colour, and the closest match (or "empty") wins.

const N = 32;                   // squares are compared at N×N pixels
const SCALES = [0.8, 0.9, 1];   // piece size as a fraction of the square
const INNER = 3;                // ignore this many pixels at the square edges (coordinates, misalignment)
const DETECT_SIZE = 1200;       // longest side used for board detection

let templatesPromise = null;

// ------------------------------------------------------------------ pixels

/** Decode an image File/Blob into {data, width, height} (RGBA). */
export async function loadImage(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
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

/**
 * Area-average resample of the rectangle (x0, y0, w, h) of each plane to N×N.
 * Pixels outside the image are clamped to the edge, or treated as 0 when zeroOutside is set.
 */
function resample(planeList, width, height, x0, y0, w, h, zeroOutside = false) {
  const weights = (start, size, limit) => {
    const step = size / N, list = [];
    for (let i = 0; i < N; i++) {
      const a = start + i * step, b = a + step, taps = [];
      for (let p = Math.floor(a); p < b; p++) {
        const overlap = Math.min(b, p + 1) - Math.max(a, p);
        if (overlap <= 0) continue;
        const inside = p >= 0 && p < limit;
        if (!inside && zeroOutside) continue;
        taps.push([Math.min(limit - 1, Math.max(0, p)), overlap / step]);
      }
      list.push(taps);
    }
    return list;
  };
  const cols = weights(x0, w, width), rows = weights(y0, h, height);
  return planeList.map(plane => {
    const out = new Float32Array(N * N);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        let sum = 0;
        for (const [y, wy] of rows[i]) {
          const base = y * width;
          for (const [x, wx] of cols[j]) sum += plane[base + x] * wy * wx;
        }
        out[i * N + j] = sum;
      }
    }
    return out;
  });
}

// ------------------------------------------------------------- detection

/** Find the board; returns {x, y, w, h} in image pixels, or null. */
export function detectBoard(image) {
  const scale = Math.min(1, DETECT_SIZE / Math.max(image.width, image.height));
  const small = scale < 1 ? downscale(image, scale) : image;
  const found = detectGrid(planes(small));
  if (found) {
    return { x: found.x / scale, y: found.y / scale, w: found.w / scale, h: found.h / scale };
  }
  // A tightly cropped, almost square picture is probably just the board.
  const ratio = image.width / image.height;
  if (ratio > 0.95 && ratio < 1.05) return { x: 0, y: 0, w: image.width, h: image.height };
  return null;
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

// ------------------------------------------------------------- templates

/** Load vision/templates.png: one row per piece set, one cell per piece. */
function loadTemplates() {
  templatesPromise ??= (async () => {
    const meta = await (await fetch(new URL("vision/templates.json", import.meta.url))).json();
    const img = new Image();
    img.src = new URL("vision/templates.png", import.meta.url).href;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const size = meta.cell, templates = [];
    meta.sets.forEach((set, row) => meta.codes.forEach((code, col) => {
      const { data } = ctx.getImageData(col * size, row * size, size, size);
      const alpha = new Float32Array(size * size), lum = new Float32Array(size * size);
      for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
        alpha[i] = data[j + 3] / 255;
        lum[i] = alpha[i] * (0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]);
      }
      // The piece fills `scale` of the square, centred: sample a larger window around it.
      for (const scale of SCALES) {
        const window = size / scale, offset = (size - window) / 2;
        const [a, v] = resample([alpha, lum], size, size, offset, offset, window, window, true);
        templates.push({ set, code, scale, a, v });
      }
    }));
    return templates;
  })();
  return templatesPromise;
}

// ------------------------------------------------------------ recognition

/** Median of the pixels of a plane in a ring just inside the square's edge. */
function ringMedian(plane) {
  const values = [];
  for (let i = 1; i < N - 1; i++) {
    for (let j = 1; j < N - 1; j++) {
      if (i <= 2 || i >= N - 3 || j <= 2 || j >= N - 3) values.push(plane[i * N + j]);
    }
  }
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

/** Sum of squared differences between the square and template t (shifted by dx, dy) on background bg. */
function distance(x, bg, t, dx, dy, limit) {
  let d = 0;
  for (let i = INNER; i < N - INNER; i++) {
    const ti = i - dy;
    for (let j = INNER; j < N - INNER; j++) {
      const tj = j - dx;
      let expected = bg;
      if (ti >= 0 && ti < N && tj >= 0 && tj < N) {
        const k = ti * N + tj;
        expected = t.v[k] + (1 - t.a[k]) * bg;
      }
      const e = expected - x[i * N + j];
      d += e * e;
    }
    if (d > limit) return d;
  }
  return d;
}

function emptyDistance(x, bg) {
  let d = 0;
  for (let i = INNER; i < N - INNER; i++) {
    for (let j = INNER; j < N - INNER; j++) {
      const e = bg - x[i * N + j];
      d += e * e;
    }
  }
  return d;
}

/** Distance from the square to every piece code ("" = empty), each minimised over sets, sizes and shifts. */
function matchSquare(lum, bg, templates) {
  const empty = emptyDistance(lum, bg);
  const byCode = { "": empty };
  // Every template as is, then the closest few again shifted by up to a pixel.
  let best = empty;
  const coarse = templates.map(t => {
    const d = distance(lum, bg, t, 0, 0, best * 4);
    best = Math.min(best, d);
    byCode[t.code] = Math.min(byCode[t.code] ?? Infinity, d);
    return [d, t];
  }).sort((a, b) => a[0] - b[0]);
  for (const [, t] of coarse.slice(0, 16)) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx || dy) byCode[t.code] = Math.min(byCode[t.code], distance(lum, bg, t, dx, dy, byCode[t.code]));
      }
    }
  }
  return byCode;
}

/** Share of the square's inner pixels that differ clearly from its background. */
function foreground(lum, bg) {
  let count = 0, total = 0;
  for (let i = INNER; i < N - INNER; i++) {
    for (let j = INNER; j < N - INNER; j++) {
      total++;
      if (Math.abs(lum[i * N + j] - bg) > 24) count++;
    }
  }
  return count / total;
}

/** How different two squares look (0 = identical), allowing a one-pixel shift. */
function squareDifference(a, b) {
  let best = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      let d = 0;
      for (let i = INNER; i < N - INNER; i++) {
        for (let j = INNER; j < N - INNER; j++) {
          const e = (a.lum[i * N + j] - a.bg) - (b.lum[(i + dy) * N + j + dx] - b.bg);
          d += e * e;
        }
      }
      best = Math.min(best, d);
    }
  }
  return best / Math.max(1, Math.min(a.energy, b.energy));
}

const PIECE_CODES = ["wP", "wN", "wB", "wR", "wQ", "wK", "bP", "bN", "bB", "bR", "bQ", "bK"];
const USUAL_MAX = { P: 8, N: 2, B: 2, R: 2, Q: 1, K: 1 };

/** Penalty for piece counts no real game (or hardly any) has. */
function rulePenalty(groups, labels) {
  const count = {};
  let penalty = 0;
  groups.forEach((group, i) => {
    const code = labels[i];
    if (!code) return;
    count[code] = (count[code] || 0) + group.squares.length;
    if (code[1] === "P" && group.squares.some(s => s.row === 0 || s.row === 7)) penalty += 1e6;
  });
  for (const color of "wb") {
    const kings = count[color + "K"] || 0;
    penalty += 4 * Math.abs(kings - 1);
    if ((count[color + "P"] || 0) > 8) penalty += 4 * (count[color + "P"] - 8);
    for (const type of "NBRQ") penalty += 1.5 * Math.max(0, (count[color + type] || 0) - USUAL_MAX[type]);
  }
  return penalty;
}

/**
 * Recognise the board inside box {x, y, w, h} of an image.
 * Returns {grid, confidence, flipped, turn}: grid[row][col] is "" or a code such as "wN",
 * as displayed (row 0 at the top); flipped and turn are guesses.
 */
export async function readBoard(image, box, { sets } = {}) {
  let templates = await loadTemplates();
  if (sets) templates = templates.filter(t => sets.includes(t.set));
  const all = planes(image);
  const step = box.w / 8, stepY = box.h / 8;
  const squares = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const [r, g, b, lum] = resample([all.r, all.g, all.b, all.y], all.width, all.height,
        box.x + col * step, box.y + row * stepY, step, stepY);
      const bg = ringMedian(lum);
      const dist = matchSquare(lum, bg, templates);
      // Cost of each code relative to the best one (0 = best), on a log scale.
      const best = Math.min(...Object.values(dist));
      const cost = Object.fromEntries(Object.entries(dist).map(([code, d]) => [code, Math.log((d + 1) / (best + 1))]));
      const fg = foreground(lum, bg);
      // Almost no foreground can't be a piece. Plenty of it is a piece even if no template
      // says so, provided an identical square elsewhere confirms it (see below), since
      // arrows and other markings also add foreground.
      const occupied = fg >= 0.04 && (cost[""] > 0 || fg > 0.3);
      const doubtful = !occupied && fg > 0.12;
      squares.push({ row, col, lum, bg, cost, occupied, doubtful, energy: dist[""],
        ring: [ringMedian(r), ringMedian(g), ringMedian(b)] });
    }
  }

  // Group occupied squares that look identical (same piece on the same shade of square).
  let groups = [];
  for (const sq of squares.filter(s => s.occupied || s.doubtful)) {
    const group = groups.find(g => (g.squares[0].row + g.squares[0].col) % 2 === (sq.row + sq.col) % 2 &&
      squareDifference(g.squares[0], sq) < 0.12);
    if (group) group.squares.push(sq);
    else groups.push({ squares: [sq] });
  }
  groups = groups.filter(g => g.squares.length > 1 || g.squares[0].occupied);
  for (const group of groups) {
    group.cost = Object.fromEntries(PIECE_CODES.map(code => [code, group.squares.reduce((s, q) => s + q.cost[code], 0)]));
  }

  // Label the groups: best template match, adjusted so that piece counts stay plausible.
  const labels = groups.map(g => PIECE_CODES.reduce((a, b) => (g.cost[a] <= g.cost[b] ? a : b)));
  const total = () => groups.reduce((s, g, i) => s + g.cost[labels[i]], 0) + rulePenalty(groups, labels);
  for (let round = 0; round < 10; round++) {
    let changed = false;
    groups.forEach((group, i) => {
      let bestCode = labels[i], bestTotal = total();
      for (const code of PIECE_CODES) {
        labels[i] = code;
        const t = total();
        if (t < bestTotal - 1e-9) {
          bestTotal = t;
          bestCode = code;
        }
      }
      if (labels[i] !== bestCode) changed = true;
      labels[i] = bestCode;
    });
    if (!changed) break;
  }

  const grid = [...Array(8)].map(() => Array(8).fill(""));
  const confidence = [...Array(8)].map(() => Array(8).fill(1));
  const ring = [...Array(8)].map(() => Array(8));
  for (const sq of squares) {
    ring[sq.row][sq.col] = sq.ring;
    // Confidence: how clearly the best piece beats the runner-up (or empty vs. piece).
    const sorted = Object.values(sq.cost).sort((a, b) => a - b);
    confidence[sq.row][sq.col] = Math.min(1, sorted[1] * 2);
  }
  groups.forEach((group, i) => group.squares.forEach(sq => {
    grid[sq.row][sq.col] = labels[i];
    const others = PIECE_CODES.filter(c => c !== labels[i]).map(c => sq.cost[c] - sq.cost[labels[i]]);
    confidence[sq.row][sq.col] = Math.max(0, Math.min(1, Math.min(...others) * 2, group.squares.length > 1 ? 1 : 0.6));
  }));
  const flipped = guessFlipped(grid);
  return { grid, confidence, flipped, turn: guessTurn(grid, ring) };
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
