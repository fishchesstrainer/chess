// Find the 8×8 playing area of a chessboard in any picture (photo at an angle, screenshot,
// diagram), without machine learning. A port of vision/board_detect.py (the Python original,
// in the parent workspace); see that file for the full explanation. In short:
//
// 1. X-corners: points where four squares meet look like a saddle (light, dark, light, dark
//    around a circle); the ChESS detector finds them.
// 2. Hypotheses of one board square from a corner, two neighbouring corners and the fourth
//    corner where it should be; each gives a homography grid → image. Kept if the square is
//    lighter (or darker) than all four neighbours, then refitted to every corner on its grid.
// 3. Every 8×8 placement of each grid is scored by how checkerboard-like it is: across the 112
//    borders between squares the brightness changes with alternating sign. Best one wins.
// 4. The winner is refitted to all corners inside it.
//
// Pure functions on {data, width, height} RGBA images: no DOM, so it also runs under Node.

const WORK_SIZE = 1000;   // longest image side used for detection
const MIN_SCORE = 0.45;   // checkerboard score below this means "no board"
const S = 24;             // pixels per square in the scoring warp

// ------------------------------------------------------------------ 3×3 matrices (row-major)

export function mul(A, B) {
  const C = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  }
  return C;
}

export function inv(A) {
  const [a, b, c, d, e, f, g, h, i] = A;
  const co = [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f,
    d * h - e * g, b * g - a * h, a * e - b * d];
  const det = a * co[0] + b * co[3] + c * co[6];
  return co.map(v => v / det);
}

export function apply(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

const det3 = A => A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
const translate = (ox, oy) => [1, 0, ox, 0, 1, oy, 0, 0, 1];

/** Homography mapping the unit square (0,0),(1,0),(1,1),(0,1) onto quad q = [[x,y] × 4]. */
export function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  let den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-9) den = 1e-9;
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

/** Homography board coordinates (0..8)² → image for a board given by its 4 corners. */
export function boardHomography(corners) {
  return mul(squareToQuad(corners), [1 / 8, 0, 0, 0, 1 / 8, 0, 0, 0, 1]);
}

/** Solve the n×n system A x = b (A as array of rows), Gaussian elimination with pivoting. */
function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

/** Least-squares homography src → dst ([[x,y]...], ≥ 4 points), with Hartley normalisation. */
export function fitHomography(src, dst) {
  const norm = pts => {
    let mx = 0, my = 0;
    for (const [x, y] of pts) { mx += x; my += y; }
    mx /= pts.length; my /= pts.length;
    let d = 0;
    for (const [x, y] of pts) d += Math.hypot(x - mx, y - my);
    const s = Math.SQRT2 / Math.max(d / pts.length, 1e-9);
    return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
  };
  const T1 = norm(src), T2 = norm(dst);
  const AtA = [...Array(8)].map(() => new Array(8).fill(0)), Atb = new Array(8).fill(0);
  for (let i = 0; i < src.length; i++) {
    const [x, y] = apply(T1, src[i][0], src[i][1]), [u, v] = apply(T2, dst[i][0], dst[i][1]);
    for (const [row, rhs] of [[[x, y, 1, 0, 0, 0, -u * x, -u * y], u], [[0, 0, 0, x, y, 1, -v * x, -v * y], v]]) {
      for (let a = 0; a < 8; a++) {
        if (row[a] === 0) continue;
        Atb[a] += row[a] * rhs;
        for (let b = 0; b < 8; b++) AtA[a][b] += row[a] * row[b];
      }
    }
  }
  const h = solve(AtA, Atb);
  if (!h || !h.every(Number.isFinite)) return null;
  return mul(inv(T2), mul([...h, 1], T1));
}

// ------------------------------------------------------------------ image basics

function grayOf({ data, width, height }) {
  const g = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = (data[j] * 4899 + data[j + 1] * 9617 + data[j + 2] * 1868 + 8192) >> 14;   // OpenCV's weights
  }
  return g;
}

/** Area-average resize (OpenCV INTER_AREA with fx = fy = scale ≤ 1: each output pixel covers 1/scale input pixels). */
function resizeArea(src, w, h, nw, nh, scale) {
  const taps = (n, nn) => {
    const step = 1 / scale, list = [];
    for (let i = 0; i < nn; i++) {
      const a = i * step, b = a + step, t = [];
      let total = 0;
      for (let p = Math.floor(a); p < b && p < n; p++) {
        const o = Math.min(b, p + 1) - Math.max(a, p);
        if (o > 1e-9) { t.push(p, o); total += o; }
      }
      for (let k = 1; k < t.length; k += 2) t[k] /= total;
      list.push(t);
    }
    return list;
  };
  const cx = taps(w, nw), cy = taps(h, nh);
  const tmp = new Float32Array(nw * h), out = new Uint8Array(nw * nh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < nw; x++) {
      let s = 0;
      const t = cx[x];
      for (let k = 0; k < t.length; k += 2) s += src[y * w + t[k]] * t[k + 1];
      tmp[y * nw + x] = s;
    }
  }
  for (let y = 0; y < nh; y++) {
    const t = cy[y];
    for (let x = 0; x < nw; x++) {
      let s = 0;
      for (let k = 0; k < t.length; k += 2) s += tmp[t[k] * nw + x] * t[k + 1];
      out[y * nw + x] = Math.round(s);
    }
  }
  return out;
}

/** Contrast-limited adaptive histogram equalisation (like cv2.createCLAHE(2.0, (8, 8))). */
function clahe(src, w, h, clip = 2, tiles = 8) {
  const tw = Math.ceil(w / tiles), th = Math.ceil(h / tiles);
  const luts = [];
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const hist = new Int32Array(256);
      const x0 = Math.min(tx * tw, w - 1), y0 = Math.min(ty * th, h - 1);
      const x1 = Math.min(x0 + tw, w), y1 = Math.min(y0 + th, h);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[src[y * w + x]]++;
      const area = Math.max(1, (x1 - x0) * (y1 - y0));
      const limit = Math.max(1, Math.floor(clip * area / 256));
      let excess = 0;
      for (let i = 0; i < 256; i++) if (hist[i] > limit) { excess += hist[i] - limit; hist[i] = limit; }
      const batch = Math.floor(excess / 256), residual = excess - batch * 256;
      for (let i = 0; i < 256; i++) hist[i] += batch;
      if (residual) {
        const step = Math.max(1, Math.floor(256 / residual));
        for (let i = 0, r = residual; i < 256 && r > 0; i += step, r--) hist[i]++;
      }
      const lut = new Uint8Array(256);
      let sum = 0;
      for (let i = 0; i < 256; i++) { sum += hist[i]; lut[i] = Math.min(255, Math.round(sum * 255 / area)); }
      luts.push(lut);
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = y / th - 0.5, y1 = Math.floor(fy), ya = fy - y1;
    const ty1 = Math.max(0, y1), ty2 = Math.min(tiles - 1, y1 + 1);
    for (let x = 0; x < w; x++) {
      const fx = x / tw - 0.5, x1 = Math.floor(fx), xa = fx - x1;
      const tx1 = Math.max(0, x1), tx2 = Math.min(tiles - 1, x1 + 1);
      const v = src[y * w + x];
      const top = luts[ty1 * tiles + tx1][v] * (1 - xa) + luts[ty1 * tiles + tx2][v] * xa;
      const bot = luts[ty2 * tiles + tx1][v] * (1 - xa) + luts[ty2 * tiles + tx2][v] * xa;
      out[y * w + x] = Math.round(top * (1 - ya) + bot * ya);
    }
  }
  return out;
}

const reflect101 = (i, n) => (i < 0 ? -i : i >= n ? 2 * n - i - 2 : i);
const reflect = (i, n) => (i < 0 ? -i - 1 : i >= n ? 2 * n - i - 1 : i);

/** Separable Gaussian blur, BORDER_REFLECT_101, float output. */
function gaussian(src, w, h, sigma) {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * src[y * w + reflect101(x + i, w)];
      tmp[y * w + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * tmp[reflect101(y + i, h) * w + x];
      out[y * w + x] = s;
    }
  }
  return out;
}

/** Bilinear sample of a float/uint8 plane; NaN outside. */
function bilinear(img, w, h, x, y) {
  if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return NaN;
  const x0 = Math.min(Math.floor(x), w - 2), y0 = Math.min(Math.floor(y), h - 2);
  const ax = x - x0, ay = y - y0, i = y0 * w + x0;
  return (img[i] * (1 - ax) + img[i + 1] * ax) * (1 - ay) + (img[i + w] * (1 - ax) + img[i + w + 1] * ax) * ay;
}

// ------------------------------------------------------------------ X-corners

/** ChESS response on a circle of radius r: positive where the surroundings go light/dark/light/dark. */
function chessResponse(gray, w, h, r) {
  const img = gaussian(gray, w, h, 0.7 + r / 6);
  const offs = [];
  for (let n = 0; n < 16; n++) {
    const a = n * Math.PI / 8;
    offs.push([Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a))]);
  }
  const resp = new Float32Array(w * h), ring = new Float32Array(16);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let mean = 0;
      for (let n = 0; n < 16; n++) {
        ring[n] = img[reflect(y + offs[n][1], h) * w + reflect(x + offs[n][0], w)];
        mean += ring[n];
      }
      let sr = 0, dr = 0;
      for (let n = 0; n < 4; n++) sr += Math.abs(ring[n] + ring[n + 8] - ring[n + 4] - ring[(n + 12) % 16]);
      for (let n = 0; n < 8; n++) dr += Math.abs(ring[n] - ring[n + 8]);
      let local = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) local += img[reflect101(y + dy, h) * w + reflect101(x + dx, w)];
      }
      resp[y * w + x] = sr - dr - 16 * Math.abs(mean / 16 - local / 9);
    }
  }
  return resp;
}

/** Refine a saddle point to sub-pixel accuracy (cv2.cornerSubPix, window 7×7). */
function cornerSubPix(img, w, h, x, y) {
  const win = 3, n = 2 * win + 1, mask = [];
  for (let i = -win; i <= win; i++) mask.push(Math.exp(-(i * i) / (win * win)));
  let cx = x, cy = y;
  for (let iter = 0; iter < 20; iter++) {
    let a = 0, b = 0, c = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const px = cx + j - win, py = cy + i - win;
        const gx = bilinear(img, w, h, px + 1, py) - bilinear(img, w, h, px - 1, py);
        const gy = bilinear(img, w, h, px, py + 1) - bilinear(img, w, h, px, py - 1);
        if (!Number.isFinite(gx) || !Number.isFinite(gy)) continue;
        const m = mask[i] * mask[j];
        const gxx = gx * gx * m, gxy = gx * gy * m, gyy = gy * gy * m;
        a += gxx; b += gxy; c += gyy;
        b1 += gxx * (j - win) + gxy * (i - win);
        b2 += gxy * (j - win) + gyy * (i - win);
      }
    }
    const det = a * c - b * b;
    if (Math.abs(det) <= 1e-12) break;
    const dx = (c * b1 - b * b2) / det, dy = (a * b2 - b * b1) / det;
    cx += dx;
    cy += dy;
    if (dx * dx + dy * dy <= 0.05 * 0.05) break;
  }
  return Math.hypot(cx - x, cy - y) < 2.5 ? [cx, cy] : [x, y];
}

function xCorners(gray, w, h, maxPoints = 400) {
  const r3 = chessResponse(gray, w, h, 3), r6 = chessResponse(gray, w, h, 6);
  const resp = new Float32Array(w * h);
  for (let i = 0; i < resp.length; i++) resp[i] = Math.max(r3[i], r6[i]);
  // non-maximum suppression: 7×7 max filter
  const tmp = new Float32Array(w * h), mx = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let k = Math.max(0, x - 3); k <= Math.min(w - 1, x + 3); k++) m = Math.max(m, resp[y * w + k]);
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let k = Math.max(0, y - 3); k <= Math.min(h - 1, y + 3); k++) m = Math.max(m, tmp[k * w + x]);
      mx[y * w + x] = m;
    }
  }
  const peaks = [];
  for (let i = 0; i < resp.length; i++) if (resp[i] > 40 && resp[i] === mx[i]) peaks.push(i);
  peaks.sort((a, b) => resp[b] - resp[a]);
  return peaks.slice(0, maxPoints).map(i => cornerSubPix(gray, w, h, i % w, Math.floor(i / w)));
}

// ------------------------------------------------------------------ grid hypotheses

/** How much lighter/darker than its 4 neighbours the unit square under H is (0 if inconsistent). */
function squareContrast(blur, w, h, H) {
  const t = [0.3, 0.5, 0.7], d = [0, 0, 0, 0];
  const sides = [[0.2, null, -0.4], [0.8, null, 0.4], [null, 0.2, -0.4], [null, 0.8, 0.4]];
  for (let s = 0; s < 4; s++) {
    const [fx, fy, off] = sides[s];
    let vin = 0, vout = 0;
    for (const v of t) {
      const gx = fx ?? v, gy = fy ?? v;
      const [ix, iy] = apply(H, gx, gy);
      const [ox, oy] = apply(H, fx === null ? gx : gx + off, fy === null ? gy : gy + off);
      if (!(ix >= 0 && ix < w && iy >= 0 && iy < h && ox >= 0 && ox < w && oy >= 0 && oy < h)) return 0;
      vin += blur[Math.floor(iy) * w + Math.floor(ix)];
      vout += blur[Math.floor(oy) * w + Math.floor(ox)];
    }
    d[s] = (vin - vout) / 3;
  }
  if (!(d.every(v => v > 0) || d.every(v => v < 0))) return 0;
  return Math.min(...d.map(Math.abs));
}

function countInliers(Hi, pts, tol = 0.15, reach = 3.5) {
  let n = 0;
  for (const [x, y] of pts) {
    const w = Hi[6] * x + Hi[7] * y + Hi[8];
    const gx = (Hi[0] * x + Hi[1] * y + Hi[2]) / w, gy = (Hi[3] * x + Hi[4] * y + Hi[5]) / w;
    if (Math.abs(gx - Math.round(gx)) < tol && Math.abs(gy - Math.round(gy)) < tol &&
        Math.abs(gx - 0.5) < reach && Math.abs(gy - 0.5) < reach) n++;
  }
  return n;
}

/** Points on integer grid positions under H: [{g: [i, j], p: [x, y]}], one per position (strongest). */
function gridMatches(H, pts, accept) {
  if (Math.abs(det3(H)) < 1e-12) return [];
  const Hi = inv(H), seen = new Set(), out = [];
  for (const p of pts) {
    const [gx, gy] = apply(Hi, p[0], p[1]);
    const i = Math.round(gx), j = Math.round(gy);
    if (!Number.isFinite(gx) || !accept(gx, gy, i, j)) continue;
    const key = i + "," + j;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ g: [i, j], p });
  }
  return out;
}

/** Refit H to inlier corners, letting the trusted region grow outward. */
function growFit(H, pts) {
  let labels = null;
  for (const [reach, tol] of [[2.6, 0.2], [4.6, 0.17], [8.6, 0.15], [12, 0.15]]) {
    const m = gridMatches(H, pts, (gx, gy, i, j) => Math.abs(gx - i) < tol && Math.abs(gy - j) < tol &&
      Math.abs(gx - 0.5) < reach && Math.abs(gy - 0.5) < reach);
    if (m.length < 5) return null;
    const xs = m.map(e => e.g[0]), ys = m.map(e => e.g[1]);
    if (Math.max(...xs) === Math.min(...xs) || Math.max(...ys) === Math.min(...ys)) return null;
    const Hn = fitHomography(m.map(e => e.g), m.map(e => e.p));
    if (!Hn) return null;
    H = Hn;
    labels = m.map(e => e.g);
  }
  return { count: labels.length, H, labels };
}

function cornerGrids(gray, w, h, pts, keep = 8) {
  const n = pts.length;
  if (n < 6) return [];
  const blur = gaussian(gray, w, h, 1.1);
  // k nearest neighbours (brute force; n ≤ 400)
  const k = Math.min(16, n - 1), nb = [];
  for (let i = 0; i < n; i++) {
    const d = [];
    for (let j = 0; j < n; j++) if (j !== i) d.push([(pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2, j]);
    d.sort((a, b) => a[0] - b[0]);
    nb.push(d.slice(0, k).map(e => e[1]));
  }
  // bucket grid for nearest-point lookups
  const cell = 8, gw = Math.ceil(w / cell) + 1, buckets = new Map();
  pts.forEach(([x, y], i) => {
    const key = Math.floor(y / cell) * gw + Math.floor(x / cell);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  });
  const nearest = (x, y, maxD) => {
    let best = -1, bd = maxD * maxD;
    const r = Math.ceil(maxD / cell), cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let by = cy - r; by <= cy + r; by++) {
      for (let bx = cx - r; bx <= cx + r; bx++) {
        for (const i of buckets.get(by * gw + bx) || []) {
          const d = (pts[i][0] - x) ** 2 + (pts[i][1] - y) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
      }
    }
    return best;
  };
  const hyps = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    for (let a = 0; a < k; a++) {
      for (let b = a + 1; b < k; b++) {
        const q1 = pts[nb[i][a]], q2 = pts[nb[i][b]];
        const ux = q1[0] - p[0], uy = q1[1] - p[1], vx = q2[0] - p[0], vy = q2[1] - p[1];
        const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
        if (Math.min(lu, lv) <= 4 || lu / lv >= 3 || lv / lu >= 3) continue;
        if (Math.abs(ux * vx + uy * vy) / (lu * lv) >= 0.82) continue;
        const f = nearest(p[0] + ux + vx, p[1] + uy + vy, 0.2 * Math.min(lu, lv));
        if (f < 0) continue;
        const H = squareToQuad([p, q1, pts[f], q2]);
        if (squareContrast(blur, w, h, H) <= 6) continue;
        hyps.push(H);
      }
    }
  }
  const scored = hyps.map(H => [Math.abs(det3(H)) > 1e-12 ? countInliers(inv(H), pts) : 0, H]);
  scored.sort((a, b) => b[0] - a[0]);
  const fits = [];
  for (const [, H] of scored.slice(0, 30)) {
    const fit = growFit(H, pts);
    if (fit) fits.push(fit);
  }
  return distinct(fits, keep);
}

function distinct(fits, keep) {
  fits.sort((a, b) => b.count - a.count);
  const seen = [], out = [];
  for (const fit of fits) {
    const cx = fit.labels.reduce((s, g) => s + g[0], 0) / fit.labels.length;
    const cy = fit.labels.reduce((s, g) => s + g[1], 0) / fit.labels.length;
    const sig = [...apply(fit.H, cx, cy), ...apply(fit.H, cx + 1, cy + 1)];
    if (seen.some(s => s.every((v, i) => Math.abs(v - sig[i]) < 4))) continue;
    seen.push(sig);
    out.push(fit);
    if (out.length >= keep) break;
  }
  return out;
}

// ------------------------------------------------------------------ checkerboard score

/** Score in [0, 1] (or -1): how much the 8×8 area H maps (0..8)² to looks like a checkerboard. */
function checkerScore(gray, w, h, H) {
  const N = 8 * S, img = new Float32Array(N * N), inside = new Uint8Array(N * N);
  let count = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const [sx, sy] = apply(H, x / S, y / S);
      const rx = Math.round(sx), ry = Math.round(sy);
      if (rx >= 0 && ry >= 0 && rx < w && ry < h) {
        inside[y * N + x] = 1;
        count++;
        img[y * N + x] = bilinear(gray, w, h, Math.min(Math.max(sx, 0), w - 1), Math.min(Math.max(sy, 0), h - 1));
      }
    }
  }
  if (count < 0.9 * N * N) return -1;
  const g = 2, sw = S / 4, m = Math.floor(S / 5);
  const signed = [];
  let valid = 0;
  for (const transposed of [false, true]) {
    const at = (row, col) => (transposed ? col * N + row : row * N + col);
    for (let r = 0; r < 8; r++) {
      // band: mean over the square row's inner rows, for every column
      const band = new Float32Array(N), bandIn = new Uint8Array(N).fill(1);
      for (let x = 0; x < N; x++) {
        let s = 0;
        for (let y = r * S + m; y < (r + 1) * S - m; y++) {
          s += img[at(y, x)];
          if (!inside[at(y, x)]) bandIn[x] = 0;
        }
        band[x] = s / (S - 2 * m);
      }
      for (let k = 1; k < 8; k++) {
        const x = k * S;
        let left = 0, right = 0, ok = true;
        for (let i = 0; i < sw; i++) {
          left += band[x - g - sw + i];
          right += band[x + g + i];
        }
        for (let i = x - g - sw; i < x + g + sw; i++) if (!bandIn[i]) ok = false;
        if (!ok) continue;
        valid++;
        signed.push(((right - left) / sw) * ((r + k) % 2 ? -1 : 1));
      }
    }
  }
  if (valid < 90) return -1;
  const abs = signed.map(Math.abs).sort((a, b) => a - b);
  const pos = 0.75 * (abs.length - 1), lo = Math.floor(pos);
  const p75 = abs[lo] + (abs[Math.min(lo + 1, abs.length - 1)] - abs[lo]) * (pos - lo);
  const contrast = Math.max(12, p75);
  let sum = 0;
  for (const v of signed) sum += Math.max(-1, Math.min(1, v / (0.5 * contrast)));
  return Math.abs(sum) / 112;
}

function convex(c) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = c[i], [bx, by] = c[(i + 1) % 4], [cx, cy] = c[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (cross === 0) return false;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

const cornersOf = H => [[0, 0], [8, 0], [8, 8], [0, 8]].map(([x, y]) => apply(H, x, y));

const SHEARS = [[1, 0, 0, 1], [1, 1, 0, 1], [1, -1, 0, 1], [1, 0, 1, 1], [1, 0, -1, 1]];  // [a b; c d]

/** Shortest unit steps at grid point `at` (Lagrange-Gauss lattice reduction). */
function reduceBasis(H, at) {
  const p0 = apply(H, at[0], at[1]), p1 = apply(H, at[0] + 1, at[1]), p2 = apply(H, at[0], at[1] + 1);
  let u = [p1[0] - p0[0], p1[1] - p0[1]], v = [p2[0] - p0[0], p2[1] - p0[1]];
  let M = [[1, 0], [0, 1]];                                // columns: grid steps of the new axes
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  if (![...u, ...v].every(Number.isFinite) || dot(u, u) < 1e-6 || dot(v, v) < 1e-6) return H;
  for (let it = 0; it < 10; it++) {
    if (dot(u, u) > dot(v, v)) {
      [u, v] = [v, u];
      M = [[M[0][1], M[0][0]], [M[1][1], M[1][0]]];
    }
    const k = Math.round(dot(u, v) / dot(u, u));
    if (k === 0) break;
    v = [v[0] - k * u[0], v[1] - k * u[1]];
    M = [[M[0][0], M[0][1] - k * M[0][0]], [M[1][0], M[1][1] - k * M[1][0]]];
  }
  return mul(H, [M[0][0], M[0][1], 0, M[1][0], M[1][1], 0, 0, 0, 1]);
}

function bestWindow(gray, w, h, H, labels) {
  const n = labels.length;
  H = reduceBasis(H, [labels.reduce((s, g) => s + g[0], 0) / n, labels.reduce((s, g) => s + g[1], 0) / n]);
  let best = null;
  for (const [a, b, c, d] of SHEARS) {
    const det = a * d - b * c, ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
    // labels in the sheared axes: inv(M) · label
    const lab = labels.map(([x, y]) => [Math.round(ia * x + ib * y), Math.round(ic * x + id * y)]);
    const cand = bestPlacement(gray, w, h, mul(H, [a, b, 0, c, d, 0, 0, 0, 1]), lab);
    if (cand && (!best || cand.score > best.score)) best = cand;
  }
  return best;
}

function bestPlacement(gray, w, h, H, labels) {
  const ranges = [0, 1].map(i => {
    const lo = Math.min(...labels.map(g => g[i])), hi = Math.max(...labels.map(g => g[i]));
    const a = Math.min(hi - 8, lo), b = Math.max(hi - 8, lo);
    return [a - 1, b + 1];
  });
  let best = null;
  for (let ox = ranges[0][0]; ox <= ranges[0][1]; ox++) {
    for (let oy = ranges[1][0]; oy <= ranges[1][1]; oy++) {
      const Hb = mul(H, translate(ox, oy));
      const c = cornersOf(Hb);
      if (!c.flat().every(Number.isFinite)) continue;
      const xs = c.map(p => p[0]), ys = c.map(p => p[1]);
      if (Math.min(...xs) < -0.03 * w || Math.max(...xs) > 1.03 * w ||
          Math.min(...ys) < -0.03 * h || Math.max(...ys) > 1.03 * h || !convex(c)) continue;
      const score = checkerScore(gray, w, h, Hb);
      if (!best || score > best.score) best = { H: Hb, score };
    }
  }
  return best;
}

/** Least-squares fit to the X-corners on the board's 49 inner grid points (outliers dropped). */
function fitToCorners(H, pts) {
  for (const tol of [0.2, 0.12]) {
    let m = gridMatches(H, pts, (gx, gy, i, j) => Math.abs(gx - i) < tol && Math.abs(gy - j) < tol &&
      i >= 1 && i <= 7 && j >= 1 && j <= 7);
    const spread = k => Math.max(...m.map(e => e.g[k])) - Math.min(...m.map(e => e.g[k]));
    if (m.length < 12 || spread(0) < 3 || spread(1) < 3) return null;
    let Hn = null;
    for (let round = 0; round < 3; round++) {
      Hn = fitHomography(m.map(e => e.g), m.map(e => e.p));
      if (!Hn) return null;
      const kept = m.filter(e => {
        const [x, y] = apply(Hn, e.g[0], e.g[1]);
        return Math.hypot(x - e.p[0], y - e.p[1]) < 2;
      });
      if (kept.length === m.length || kept.length < 8) break;
      m = kept;
    }
    H = Hn;
  }
  return H;
}

/** Relabel so corner 0 is the top-left-most one and the corners run clockwise in the image. */
function orient(H) {
  let best = null;
  const swap = [0, 1, 0, 1, 0, 0, 0, 0, 1], rot = [0, -1, 8, 1, 0, 0, 0, 0, 1];
  for (const M0 of [[1, 0, 0, 0, 1, 0, 0, 0, 1], swap]) {
    let M = M0;
    for (let r = 0; r < 4; r++) {
      const Hm = mul(H, M), c = cornersOf(Hm);
      const d0 = [c[1][0] - c[0][0], c[1][1] - c[0][1]], d1 = [c[2][0] - c[1][0], c[2][1] - c[1][1]];
      if (d0[0] * d1[1] - d0[1] * d1[0] > 0) {
        const key = c[0][0] + c[0][1];
        if (!best || key < best.key) best = { key, H: Hm };
      }
      M = mul(M, rot);
    }
  }
  return best.H.map(v => v / best.H[8]);
}

// ------------------------------------------------------------------ public

/**
 * Find the main chessboard's 8×8 area in an RGBA image {data, width, height}.
 * `extraBoxes` are other candidates [{x, y, w, h}] in image pixels (from another detector) to
 * score alongside. Returns {corners: [[x,y] × 4] clockwise from the top-left, score} or null.
 */
export function detectBoard(image, extraBoxes = []) {
  const scale = Math.min(1, WORK_SIZE / Math.max(image.width, image.height));
  const w = Math.max(1, Math.round(image.width * scale)), h = Math.max(1, Math.round(image.height * scale));
  let gray = grayOf(image);
  if (scale < 1) gray = resizeArea(gray, image.width, image.height, w, h, scale);
  gray = clahe(gray, w, h);

  const pts = xCorners(gray, w, h);
  let best = null;
  for (const fit of cornerGrids(gray, w, h, pts)) {
    const cand = bestWindow(gray, w, h, fit.H, fit.labels);
    if (cand && (!best || cand.score > best.score)) best = cand;
  }
  for (const box of extraBoxes) {
    const corners = [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]];
    const H = boardHomography(corners.map(([x, y]) => [x * scale, y * scale]));
    const score = checkerScore(gray, w, h, H);
    if (!best || score > best.score) best = { H, score };
  }
  if (!best || best.score < MIN_SCORE) return null;

  const polished = fitToCorners(best.H, pts);
  if (polished) {
    const s2 = checkerScore(gray, w, h, polished);
    if (s2 >= best.score - 0.02) best = { H: polished, score: Math.max(best.score, s2) };
  }
  const H = orient(mul([1 / scale, 0, 0, 0, 1 / scale, 0, 0, 0, 1], best.H));
  return { corners: cornersOf(H), score: best.score };
}

/**
 * Cut the 64 squares out of the image like the training pipeline does (warp at 64 px per
 * square, bilinear; grayscale; 2×2 average to 32×32). Returns {pixels: Uint8Array(64·32·32),
 * rings: [[r,g,b] × 64]} (rings: median colour near each square's edge), row by row.
 */
export function cutSquares(image, corners) {
  const H = boardHomography(corners), W = 64, { data, width, height } = image;
  const pixels = new Uint8Array(64 * 32 * 32), rings = [];
  const sq = new Uint8Array(W * W * 3), gray = new Uint8Array(W * W);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      for (let y = 0; y < W; y++) {
        for (let x = 0; x < W; x++) {
          const [sx, sy] = apply(H, c + x / W, r + y / W);
          const o = (y * W + x) * 3;
          const x0 = Math.floor(sx), y0 = Math.floor(sy), ax = sx - x0, ay = sy - y0;
          for (let ch = 0; ch < 3; ch++) {
            // bilinear, pixels outside the image count as black (cv2.BORDER_CONSTANT)
            const px = (xx, yy) => (xx >= 0 && yy >= 0 && xx < width && yy < height ? data[(yy * width + xx) * 4 + ch] : 0);
            const v = (px(x0, y0) * (1 - ax) + px(x0 + 1, y0) * ax) * (1 - ay) +
              (px(x0, y0 + 1) * (1 - ax) + px(x0 + 1, y0 + 1) * ax) * ay;
            sq[o + ch] = Math.round(v);
          }
          gray[y * W + x] = (sq[o] * 4899 + sq[o + 1] * 9617 + sq[o + 2] * 1868 + 8192) >> 14;
        }
      }
      const base = (r * 8 + c) * 1024;
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
          const i = 2 * y * W + 2 * x;
          pixels[base + y * 32 + x] = (gray[i] + gray[i + 1] + gray[i + W] + gray[i + W + 1] + 2) >> 2;
        }
      }
      const ring = [[], [], []];
      for (let y = 2; y < W - 2; y++) {
        for (let x = 2; x < W - 2; x++) {
          if (y < 8 || y >= W - 8 || x < 8 || x >= W - 8) for (let ch = 0; ch < 3; ch++) ring[ch].push(sq[(y * W + x) * 3 + ch]);
        }
      }
      rings.push(ring.map(v => v.sort((a, b) => a - b)[v.length >> 1]));
    }
  }
  return { pixels, rings };
}

