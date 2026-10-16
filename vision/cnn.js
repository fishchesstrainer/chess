// The square classifier (a small CNN trained in ../../vision/train_pieces.py), in plain JavaScript.
// Weights come from vision/piece_cnn.{json,bin} (export_web_model.py): float16, batch-norm folded
// into the convolutions. Input: 32×32 grayscale squares; output: probabilities of the 13 classes
// (meta.classes: "." empty, "PNBRQK" white, "pnbrqk" black).

/** Build a model from the JSON metadata and the raw .bin contents (ArrayBuffer). */
export function loadModel(meta, buffer) {
  const half = new Uint16Array(buffer);
  const weights = new Float32Array(half.length);
  for (let i = 0; i < half.length; i++) weights[i] = halfToFloat(half[i]);
  return { meta, weights };
}

function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

/**
 * Classify n squares: `pixels` holds n 32×32 grayscale images (0-255) one after another.
 * Returns a Float32Array of n×13 probabilities.
 */
export function classify(model, pixels, n) {
  const { meta } = model, size = meta.size, classes = meta.classes.length;
  const out = new Float32Array(n * classes);
  for (let k = 0; k < n; k++) {
    let x = new Float32Array(size * size);
    for (let i = 0; i < x.length; i++) x[i] = (pixels[k * size * size + i] / 255 - meta.mean) / meta.std;
    let channels = 1, side = size;
    for (const layer of meta.layers) {
      if (layer.type === "conv") {
        x = conv3x3(x, side, layer.cin, layer.cout, model.weights, layer.w, layer.b);
        channels = layer.cout;
      } else if (layer.type === "maxpool") {
        x = maxPool(x, side, channels);
        side >>= 1;
      } else if (layer.type === "gap") {
        const g = new Float32Array(channels), area = side * side;
        for (let c = 0; c < channels; c++) {
          let s = 0;
          for (let i = 0; i < area; i++) s += x[c * area + i];
          g[c] = s / area;
        }
        x = g;
      } else if (layer.type === "dense") {
        const y = new Float32Array(layer.cout);
        for (let o = 0; o < layer.cout; o++) {
          let s = model.weights[layer.b + o];
          for (let i = 0; i < layer.cin; i++) s += model.weights[layer.w + o * layer.cin + i] * x[i];
          y[o] = s;
        }
        x = y;
      }
    }
    // softmax
    let max = -Infinity, sum = 0;
    for (let c = 0; c < classes; c++) max = Math.max(max, x[c]);
    for (let c = 0; c < classes; c++) sum += out[k * classes + c] = Math.exp(x[c] - max);
    for (let c = 0; c < classes; c++) out[k * classes + c] /= sum;
  }
  return out;
}

/** 3×3 convolution with zero padding 1, plus bias and ReLU. x: [cin][side][side]. */
function conv3x3(x, side, cin, cout, W, wOff, bOff) {
  const area = side * side, y = new Float32Array(cout * area);
  for (let o = 0; o < cout; o++) {
    const yo = o * area;
    y.fill(W[bOff + o], yo, yo + area);
    for (let i = 0; i < cin; i++) {
      const xi = i * area, w = wOff + (o * cin + i) * 9;
      for (let ky = 0; ky < 3; ky++) {
        const dy = ky - 1, r0 = Math.max(0, -dy), r1 = Math.min(side, side - dy);
        for (let kx = 0; kx < 3; kx++) {
          const wt = W[w + ky * 3 + kx];
          if (wt === 0) continue;
          const dx = kx - 1, c0 = Math.max(0, -dx), c1 = Math.min(side, side - dx);
          for (let r = r0; r < r1; r++) {
            const yrow = yo + r * side, xrow = xi + (r + dy) * side + dx;
            for (let c = c0; c < c1; c++) y[yrow + c] += wt * x[xrow + c];
          }
        }
      }
    }
    for (let j = yo; j < yo + area; j++) if (y[j] < 0) y[j] = 0;
  }
  return y;
}

function maxPool(x, side, channels) {
  const half = side >> 1, y = new Float32Array(channels * half * half);
  for (let c = 0; c < channels; c++) {
    for (let r = 0; r < half; r++) {
      for (let q = 0; q < half; q++) {
        const i = c * side * side + 2 * r * side + 2 * q;
        y[c * half * half + r * half + q] = Math.max(x[i], x[i + 1], x[i + side], x[i + side + 1]);
      }
    }
  }
  return y;
}
