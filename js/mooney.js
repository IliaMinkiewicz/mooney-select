/* Процедура Van de Cruys et al. (2021): серое -> гауссово размытие -> порог Оцу.
   Вычисления повторяют исходный код на Python (numpy, scipy.ndimage, scikit-image, Pillow) до пикселя. */
const Mooney = (() => {
  const REF = 375;          // короткая сторона исходников Van de Cruys, px
  const PB = 22;            // точность коэффициентов Pillow (PRECISION_BITS)

  // Серое: 0.299 R + 0.587 G + 0.114 B с отбрасыванием дробной части (как np.uint8(np.dot(...)))
  function toGray(rgba, n) {
    const g = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (rgba[j] * 0.299 + rgba[j + 1] * 0.587) + rgba[j + 2] * 0.114;
    return g;
  }
  function channel(rgba, n) {
    const g = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = rgba[j];
    return g;
  }

  // Изменение размера фильтром Ланцоша, как Image.resize(..., Image.LANCZOS) в Pillow
  function sinc(x) { if (x === 0) return 1; x *= Math.PI; return Math.sin(x) / x; }
  function lanczos(x) { return (-3 <= x && x < 3) ? sinc(x) * sinc(x / 3) : 0; }
  function coeffs(inSize, outSize) {
    const scale = inSize / outSize, fscale = scale < 1 ? 1 : scale;
    const support = 3 * fscale, ksize = Math.ceil(support) * 2 + 1, ss = 1 / fscale;
    const kk = new Float64Array(outSize * ksize), bounds = new Int32Array(outSize * 2);
    for (let xx = 0; xx < outSize; xx++) {
      const center = (xx + 0.5) * scale;
      let xmin = Math.trunc(center - support + 0.5); if (xmin < 0) xmin = 0;
      let xmax = Math.trunc(center + support + 0.5); if (xmax > inSize) xmax = inSize;
      xmax -= xmin;
      let ww = 0;
      const o = xx * ksize;
      for (let x = 0; x < xmax; x++) { const w = lanczos((x + xmin - center + 0.5) * ss); kk[o + x] = w; ww += w; }
      for (let x = 0; x < xmax; x++) if (ww !== 0) kk[o + x] /= ww;
      bounds[xx * 2] = xmin; bounds[xx * 2 + 1] = xmax;
    }
    const k = new Int32Array(kk.length);
    for (let i = 0; i < kk.length; i++) k[i] = Math.trunc(kk[i] < 0 ? -0.5 + kk[i] * (1 << PB) : 0.5 + kk[i] * (1 << PB));
    return { k, bounds, ksize };
  }
  function clip8(v) { return v >= (1 << 30) ? 255 : v <= 0 ? 0 : v >> PB; }
  function resize(src, w, h, ow, oh) {
    if (ow === w && oh === h) return src.slice();
    const H = coeffs(w, ow), V = coeffs(h, oh);
    let img = src, iw = w, ih = h, vb = V.bounds;
    if (ow !== w) {
      const y0 = V.bounds[0], y1 = V.bounds[oh * 2 - 2] + V.bounds[oh * 2 - 1];
      vb = V.bounds.slice(); for (let i = 0; i < oh; i++) vb[i * 2] -= y0;
      const tmp = new Uint8Array(ow * (y1 - y0));
      for (let y = 0; y < y1 - y0; y++) {
        const row = (y + y0) * w;
        for (let xx = 0; xx < ow; xx++) {
          const xmin = H.bounds[xx * 2], xmax = H.bounds[xx * 2 + 1], o = xx * H.ksize;
          let s = 1 << (PB - 1);
          for (let x = 0; x < xmax; x++) s += src[row + x + xmin] * H.k[o + x];
          tmp[y * ow + xx] = clip8(s);
        }
      }
      img = tmp; iw = ow; ih = y1 - y0;
    }
    if (oh === h) return img;
    const out = new Uint8Array(iw * oh);
    for (let yy = 0; yy < oh; yy++) {
      const ymin = vb[yy * 2], ymax = vb[yy * 2 + 1], o = yy * V.ksize;
      for (let xx = 0; xx < iw; xx++) {
        let s = 1 << (PB - 1);
        for (let y = 0; y < ymax; y++) s += img[(y + ymin) * iw + xx] * V.k[o + y];
        out[yy * iw + xx] = clip8(s);
      }
    }
    return out;
  }
  function crop(src, w, x0, y0, x1, y1) {
    const cw = x1 - x0, ch = y1 - y0, out = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) out.set(src.subarray((y + y0) * w + x0, (y + y0) * w + x1), y * cw);
    return out;
  }

  // Гауссово размытие, как scipy.ndimage.gaussian_filter(img, sigma, mode='nearest') для 8-битного изображения
  function pairwiseSum(a, i0, n) {
    if (n < 8) { let r = 0; for (let i = 0; i < n; i++) r += a[i0 + i]; return r; }
    if (n <= 128) {
      const r = new Float64Array(8);
      for (let j = 0; j < 8; j++) r[j] = a[i0 + j];
      let i = 8;
      for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[i0 + i + j];
      let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
      for (; i < n; i++) res += a[i0 + i];
      return res;
    }
    let n2 = Math.floor(n / 2); n2 -= n2 % 8;
    return pairwiseSum(a, i0, n2) + pairwiseSum(a, i0 + n2, n - n2);
  }
  function gaussWeights(sigma) {
    const lw = Math.trunc(4 * sigma + 0.5), a = -0.5 / (sigma * sigma), w = new Float64Array(2 * lw + 1);
    for (let i = 0; i <= 2 * lw; i++) { const x = i - lw; w[i] = Math.exp(a * (x * x)); }
    const s = pairwiseSum(w, 0, w.length);
    for (let i = 0; i < w.length; i++) w[i] = w[i] / s;
    return { w, lw };
  }
  function blur1d(src, dst, len, count, step, stride, w, lw) {
    const buf = new Float64Array(len + 2 * lw);
    for (let c = 0; c < count; c++) {
      const base = c * stride;
      for (let i = 0; i < len; i++) buf[lw + i] = src[base + i * step];
      for (let i = 0; i < lw; i++) { buf[i] = src[base]; buf[lw + len + i] = src[base + (len - 1) * step]; }
      for (let i = 0; i < len; i++) {
        const p = lw + i;
        let acc = buf[p] * w[lw];
        for (let j = -lw; j < 0; j++) acc += (buf[p + j] + buf[p - j]) * w[lw + j];
        dst[base + i * step] = acc > 255 ? 255 : acc;          // отбрасывание дробной части, как при записи в uint8
      }
    }
  }
  function gauss(src, w, h, sigma) {
    const { w: k, lw } = gaussWeights(sigma);
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    blur1d(src, tmp, h, w, w, 1, k, lw);      // по столбцам (ось 0)
    blur1d(tmp, out, w, h, 1, w, k, lw);      // по строкам (ось 1)
    return out;
  }

  // Порог Оцу, как skimage.filters.threshold_otsu для 8-битного изображения
  function otsu(img) {
    let mn = 255, mx = 0;
    for (let i = 0; i < img.length; i++) { const v = img[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mn === mx) return img[0];
    const n = mx - mn + 1, c = new Float64Array(n);
    for (let i = 0; i < img.length; i++) c[img[i] - mn]++;
    const w1 = new Float64Array(n), w2 = new Float64Array(n), m1 = new Float64Array(n), m2 = new Float64Array(n);
    let sw = 0, sv = 0;
    for (let i = 0; i < n; i++) { sw += c[i]; sv += c[i] * (i + mn); w1[i] = sw; m1[i] = sv / sw; }
    sw = 0; sv = 0;
    for (let i = n - 1; i >= 0; i--) { sw += c[i]; sv += c[i] * (i + mn); w2[i] = sw; m2[i] = sv / sw; }
    let best = -1, idx = 0;
    for (let i = 0; i < n - 1; i++) {
      const d = m1[i] - m2[i + 1], v = (w1[i] * w2[i + 1]) * (d * d);
      if (v > best) { best = v; idx = i; }
    }
    return idx + mn;
  }

  // Число крупных пятен (обоих цветов, не меньше 0,2 % площади), как в отборе стимулов
  function pyRound(x) { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r; }
  function patches(bw, w, h) {
    const k = 350 / Math.min(w, h), nw = pyRound(w * k), nh = pyRound(h * k);
    const src = new Uint8Array(w * h); for (let i = 0; i < src.length; i++) src[i] = bw[i] ? 255 : 0;
    const r = resize(src, w, h, nw, nh), N = nw * nh, lim = 0.002 * nh * nw;
    const seen = new Uint8Array(N), stack = new Int32Array(N);
    let count = 0;
    for (let s = 0; s < N; s++) {
      if (seen[s]) continue;
      const col = r[s] >= 128; let top = 0, size = 0;
      stack[top++] = s; seen[s] = 1;
      while (top) {
        const p = stack[--top]; size++;
        const x = p % nw;
        if (x > 0 && !seen[p - 1] && (r[p - 1] >= 128) === col) { seen[p - 1] = 1; stack[top++] = p - 1; }
        if (x < nw - 1 && !seen[p + 1] && (r[p + 1] >= 128) === col) { seen[p + 1] = 1; stack[top++] = p + 1; }
        if (p >= nw && !seen[p - nw] && (r[p - nw] >= 128) === col) { seen[p - nw] = 1; stack[top++] = p - nw; }
        if (p < N - nw && !seen[p + nw] && (r[p + nw] >= 128) === col) { seen[p + nw] = 1; stack[top++] = p + nw; }
      }
      if (size >= lim) count++;
    }
    return count;
  }

  /* gray: серое всего фото (w x h).
     Без обрезки (box = null): размытие σ в пикселях фото, ровно как в коде Van de Cruys.
     С обрезкой: рамка box = [x0, y0, x1, y1] приводится к fw x fh, σ задан для фото с короткой стороной 375 px. */
  // Порог по заданной доле белого: уровень, при котором доля пикселей не темнее порога ближе всего к цели
  function byWhite(img, frac) {
    const c = new Float64Array(256); for (let i = 0; i < img.length; i++) c[img[i]]++;
    let best = 0, err = Infinity, above = 0;
    for (let t = 255; t >= 0; t--) { above += c[t]; const e = Math.abs(above / img.length - frac); if (e < err) { err = e; best = t; } }
    return best;
  }

  /* thr: { method: "otsu" } (по умолчанию), { method: "manual", value: 0..255 } или { method: "white", value: 0..1 } */
  function make(gray, w, h, sigma, box, fw, fh, thr) {
    let g = gray, ow = w, oh = h, s = sigma;
    if (box) {
      const [x0, y0, x1, y1] = box;
      g = resize(crop(gray, w, x0, y0, x1, y1), x1 - x0, y1 - y0, fw, fh);
      ow = fw; oh = fh;
      s = sigma * (fw / (x1 - x0)) * Math.min(w, h) / REF;
    }
    const blurred = s > 0 ? gauss(g, ow, oh, s) : g.slice(), m = (thr && thr.method) || "otsu";
    const t = m === "manual" ? thr.value : m === "white" ? byWhite(blurred, thr.value) : otsu(blurred), bw = new Uint8Array(ow * oh);
    let white = 0;
    for (let i = 0; i < bw.length; i++) { bw[i] = blurred[i] >= t ? 1 : 0; white += bw[i]; }
    return { gray: g, blurred, bw, w: ow, h: oh, sigmaPx: s, threshold: t, method: m, white: white / bw.length };
  }


  // Контраст и гамма серого перед размытием; при значениях 1 изображение не меняется
  function adjust(g, con, gam) {
    if (con === 1 && gam === 1) return g;
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      const x = ((Math.pow(v / 255, gam) - 0.5) * con + 0.5) * 255;
      lut[v] = x < 0 ? 0 : x > 255 ? 255 : Math.round(x);
    }
    const out = new Uint8Array(g.length);
    for (let i = 0; i < g.length; i++) out[i] = lut[g[i]];
    return out;
  }

  // Пятна (связные области одного цвета) меньше minArea пикселей перекрашиваются в цвет окружения
  function despeckle(bw, w, h, minArea) {
    if (!minArea) return bw;
    const N = w * h, out = bw.slice(), seen = new Uint8Array(N), stack = new Int32Array(N), comp = new Int32Array(N);
    for (let s = 0; s < N; s++) {
      if (seen[s]) continue;
      const col = bw[s]; let top = 0, n = 0;
      stack[top++] = s; seen[s] = 1;
      while (top) {
        const p = stack[--top]; comp[n++] = p;
        const x = p % w;
        if (x > 0 && !seen[p - 1] && bw[p - 1] === col) { seen[p - 1] = 1; stack[top++] = p - 1; }
        if (x < w - 1 && !seen[p + 1] && bw[p + 1] === col) { seen[p + 1] = 1; stack[top++] = p + 1; }
        if (p >= w && !seen[p - w] && bw[p - w] === col) { seen[p - w] = 1; stack[top++] = p - w; }
        if (p < N - w && !seen[p + w] && bw[p + w] === col) { seen[p + w] = 1; stack[top++] = p + w; }
      }
      if (n < minArea && n < N) for (let i = 0; i < n; i++) out[comp[i]] = 1 - col;
    }
    return out;
  }

  // Поворот на 0, 90, 180, 270 градусов по часовой стрелке и зеркальное отражение по горизонтали
  function orient(a, w, h, rot, flip) {
    rot = ((rot % 360) + 360) % 360;
    if (!rot && !flip) return { a, w, h };
    const sw = rot % 180 ? h : w, sh = rot % 180 ? w : h, out = new Uint8Array(a.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let X, Y;
      if (rot === 90) { X = h - 1 - y; Y = x; } else if (rot === 180) { X = w - 1 - x; Y = h - 1 - y; }
      else if (rot === 270) { X = y; Y = w - 1 - x; } else { X = x; Y = y; }
      if (flip) X = sw - 1 - X;
      out[Y * sw + X] = a[y * w + x];
    }
    return { a: out, w: sw, h: sh };
  }

  /* Полная обработка по параметрам p:
     src = { gray, W, H } — серое исходного фото; box = [x0, y0, x1, y1] или null (весь кадр без обрезки);
     sp — σ в пикселях итогового изображения на единицу σ, если исходного фото нет. */
  function render(src, p, sp) {
    const [fw, fh] = p.fmt.split("x").map(Number);
    let g, w, h, s;
    if (p.b) {
      const [x0, y0, x1, y1] = p.b;
      g = resize(crop(src.gray, src.W, x0, y0, x1, y1), x1 - x0, y1 - y0, fw, fh);
      w = fw; h = fh;
      s = p.sigma * (fw / (x1 - x0)) * Math.min(src.W, src.H) / REF;
    } else {
      g = src.gray; w = src.W; h = src.H;
      s = p.sigma * (sp || Math.min(w, h) / REF);
    }
    g = adjust(g, p.con, p.gam);
    const blurred = s > 0 ? gauss(g, w, h, s) : g.slice();
    const t = p.thr.m === "manual" ? p.thr.v : p.thr.m === "white" ? byWhite(blurred, p.thr.v) : otsu(blurred);
    let bw = new Uint8Array(w * h);
    for (let i = 0; i < bw.length; i++) bw[i] = blurred[i] >= t ? 1 : 0;
    bw = despeckle(bw, w, h, p.speck);
    if (p.inv) for (let i = 0; i < bw.length; i++) bw[i] = 1 - bw[i];
    let white = 0;
    for (let i = 0; i < bw.length; i++) white += bw[i];
    const big = patches(bw, w, h);
    const ob = orient(bw, w, h, p.rot, p.flip), og = orient(g, w, h, p.rot, p.flip);
    return { bw: ob.a, gray: og.a, w: ob.w, h: ob.h, sigmaPx: s, threshold: t, white: white / bw.length, patches: big };
  }

  return { toGray, channel, resize, crop, gauss, gaussWeights, otsu, byWhite, patches, make, render, REF };
})();
