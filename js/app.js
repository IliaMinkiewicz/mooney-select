"use strict";

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const pct = v => v == null ? "—" : Math.round(v * 100) + " %";
const ru = (a, b) => a.localeCompare(b, "ru");

const DL = { "да": "берём", "?": "под вопросом", "нет": "нет" };
const DL_BACK = { "берём": "да", "под вопросом": "?", "нет": "нет", "да": "да", "?": "?" };
const PREV_CLS = { "взят": "ok", "на замену": "q", "отклонён": "no", "не выбран": "" };
const FORMATS = ["350x250", "250x350", "350x350"];
const SOURCES = ["Open Images", "Megalith", "THINGS-Mooney", "Pexels", "Van de Cruys", "Wikimedia Commons", "Openverse"];

let CAT = null;
const OBJ = new Map(), FRK = new Map();
let FR = [];
let DEC = LS.get("ms.dec", {}), FOUND = LS.get("ms.found", []), OTHER = LS.get("ms.other", {});
const UI = Object.assign({ obj: "", st: "all", sort: "name", src: [], prev: "all", mine: "all", show: "m", ts: 210, q: "" }, LS.get("ms.ui", {}));
const LOCAL = new Map();
let VISIBLE = [];

const saveUI = () => LS.set("ms.ui", UI);
const saveDec = () => { if (!LS.set("ms.dec", DEC)) toast("Браузер не дал сохранить решения. Выгрузите их в Excel, чтобы не потерять."); };

function toast(msg, ms = 3500) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- кадры ----------
function mine(f) { return DEC[f.k]?.d || null; }
function eff(f) {
  const d = mine(f); if (d) return d;
  if (f.prev?.s === "взят") return "да";
  if (f.prev?.s === "отклонён") return "нет";
  return null;
}
function unseen(f) { return !f.prev && !f.gd && !mine(f) && !f.found; }
function isOpen(f) { return !eff(f) && !f.prev && !f.gd; }
function localFor(f, kind) {
  if (!f.loc) return null;
  const s = String(f.loc).toLowerCase();
  const stems = kind === "g" ? [s + "_gray", s + "gs"] : kind === "m" ? [s + "_mooney", s + "tt"] : [];
  for (const x of stems) if (LOCAL.has(x)) return LOCAL.get(x);
  return null;
}
const grayURL = f => f.g ? `img/g/${f.k}.jpg` : f.found ? f.url : localFor(f, "g");
const mooneyURL = f => f.m ? `img/m/${f.k}.png` : localFor(f, "m");
const photoURL = f => f.ph ? `img/p/${f.k}.jpg` : f.found ? f.url : null;

function defParams(f) {
  return { fmt: f.fmt || "350x350", b: f.box ? f.box.slice(2) : null, sigma: 2, thr: { m: "otsu", v: 0.5 },
           con: 1, gam: 1, inv: false, rot: 0, flip: false, speck: 0 };
}
function getParams(f) {
  const p = defParams(f), s = DEC[f.k]?.p;
  return s ? { ...p, ...JSON.parse(JSON.stringify(s)) } : p;
}
const edited = f => !!DEC[f.k]?.p;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function maxFrame(W, H, fw, fh) {
  return W / H > fw / fh ? [Math.max(1, Math.round(H * fw / fh)), H] : [W, Math.max(1, Math.round(W * fh / fw))];
}
function boxAt(W, H, fmt, size, cx, cy) {
  const [fw, fh] = fmt.split("x").map(Number), [mw, mh] = maxFrame(W, H, fw, fh);
  const cw = Math.max(8, Math.round(mw * size)), ch = Math.max(8, Math.round(mh * size));
  const x0 = Math.min(Math.max(Math.round(cx - cw / 2), 0), W - cw), y0 = Math.min(Math.max(Math.round(cy - ch / 2), 0), H - ch);
  return [x0, y0, x0 + cw, y0 + ch];
}
function bestFmt(W, H) {
  let best = FORMATS[0], loss = 2;
  for (const f of ["350x350", "350x250", "250x350"]) {
    const [fw, fh] = f.split("x").map(Number), b = maxFrame(W, H, fw, fh), l = 1 - (b[0] * b[1]) / (W * H);
    if (l < loss - 1e-9) { loss = l; best = f; }
  }
  return best;
}

// ---------- обработка ----------
function isGrayFile(b) {
  if (b[0] === 0xFF && b[1] === 0xD8) {
    let i = 2;
    while (i + 9 < b.length && b[i] === 0xFF) {
      const m = b[i + 1];
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      if ((m >= 0xC0 && m <= 0xCF) && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return b[i + 9] === 1;
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return false;
  }
  if (b[0] === 0x89 && b[1] === 0x50) return b[25] === 0;
  return false;
}
const SRC_CACHE = new Map();
function loadGray(url) {
  if (!SRC_CACHE.has(url)) {
    const pr = (async () => {
      const r = await fetch(url, { mode: "cors" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const blob = await r.blob();
      const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none", imageOrientation: "from-image" });
      const W = bmp.width, H = bmp.height, c = document.createElement("canvas");
      c.width = W; c.height = H;
      const x = c.getContext("2d", { willReadFrequently: true });
      x.drawImage(bmp, 0, 0);
      const rgba = x.getImageData(0, 0, W, H).data;
      const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
      const gray = isGrayFile(head) ? Mooney.channel(rgba, W * H) : Mooney.toGray(rgba, W * H);
      const k = Math.min(1, 900 / Math.max(W, H));
      const preview = await createImageBitmap(bmp, { resizeWidth: Math.max(1, Math.round(W * k)), resizeHeight: Math.max(1, Math.round(H * k)), resizeQuality: "high" });
      bmp.close();
      return { gray, W, H, preview };
    })();
    pr.catch(() => SRC_CACHE.delete(url));
    SRC_CACHE.set(url, pr);
    if (SRC_CACHE.size > 16) SRC_CACHE.delete(SRC_CACHE.keys().next().value);
  }
  return SRC_CACHE.get(url);
}
async function renderFrame(f, p) {
  const ph = photoURL(f);
  if (ph) {
    const src = await loadGray(ph);
    if (!p.b) p.b = boxAt(src.W, src.H, p.fmt, 1, src.W / 2, src.H / 2);
    return { ...Mooney.render(src, p), src, photo: true };
  }
  const g = grayURL(f);
  if (!g) throw new Error("нет изображения");
  const src = await loadGray(g);
  return { ...Mooney.render(src, { ...p, b: null }, f.sp), src, photo: false };
}
function paint(c, r, mode) {
  c.width = r.w; c.height = r.h;
  const x = c.getContext("2d"), im = x.createImageData(r.w, r.h), d = im.data;
  for (let i = 0, j = 0; i < r.bw.length; i++, j += 4) {
    const v = mode === "g" ? r.gray[i] : mode === "o" ? (r.gray[i] + (r.bw[i] ? 255 : 0)) >> 1 : r.bw[i] ? 255 : 0;
    d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255;
  }
  x.putImageData(im, 0, 0);
  return c;
}

// очередь отрисовки плиток с изменёнными настройками
const queue = [];
let busy = false;
const io = new IntersectionObserver(es => {
  for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); queue.push(e.target); }
  pump();
}, { rootMargin: "300px" });
async function pump() {
  if (busy) return; busy = true;
  while (queue.length) {
    const el = queue.shift(), f = FRK.get(el.dataset.k);
    if (!f || !el.isConnected) continue;
    try {
      const r = await renderFrame(f, getParams(f));
      const show = el.dataset.show, cm = paint(document.createElement("canvas"), r, "m");
      el.querySelectorAll("canvas,img,.ph").forEach(n => n.remove());
      if (show === "g" || show === "mg") el.prepend(paint(document.createElement("canvas"), r, "g"));
      if (show !== "g") el.append(cm);
    } catch (e) {
      el.querySelector(".ph")?.replaceChildren("Не удалось загрузить изображение");
    }
    await new Promise(r => setTimeout(r, 0));
  }
  busy = false;
}

// ---------- загрузка ----------
async function init() {
  try {
    CAT = await (await fetch("data/catalog.json")).json();
  } catch (e) {
    document.querySelector("main").innerHTML = '<p class="empty">Не удалось загрузить каталог кадров.</p>';
    return;
  }
  for (const o of CAT.objects) OBJ.set(o.id, o);
  FR = CAT.frames.slice();
  for (const f of FOUND) if (OBJ.has(f.o)) FR.push(f);
  for (const f of FR) FRK.set(f.k, f);
  $("who").value = LS.get("ms.who", "");
  buildSrcChips(); bindUI(); fillSearchObjects();
  route();
}
function addFound(f) {
  if (FRK.has(f.k)) return FRK.get(f.k);
  FOUND.push(f); LS.set("ms.found", FOUND);
  FR.push(f); FRK.set(f.k, f);
  buildSrcChips();
  return f;
}
function removeFound(k) {
  FOUND = FOUND.filter(f => f.k !== k); LS.set("ms.found", FOUND);
  FR = FR.filter(f => f.k !== k); FRK.delete(k);
  delete DEC[k]; saveDec();
}

// ---------- маршрут ----------
function route() {
  const t = (location.hash || "#otbor").slice(1);
  const tab = ["otbor", "poisk", "stat"].includes(t) ? t : "otbor";
  for (const v of ["otbor", "poisk", "stat"]) $("v-" + v).hidden = v !== tab;
  document.querySelectorAll(".tabs a").forEach(a => a.setAttribute("aria-current", a.dataset.tab === tab ? "page" : "false"));
  if (tab === "otbor") { renderObjs(); renderGrid(); }
  if (tab === "stat") renderStats();
  if (tab === "poisk" && !$("s-q").value) prefillSearch();
}
addEventListener("hashchange", route);

// ---------- список объектов ----------
function objCounts(o) {
  let n = 0, yes = 0, q = 0, open = 0;
  for (const f of FR) if (f.o === o.id) {
    n++;
    const e = eff(f);
    if (e === "да") yes++; else if (e === "?") q++; else if (isOpen(f)) open++;
  }
  return { n, yes, q, open };
}
function renderObjs() {
  const q = UI.q.trim().toLowerCase();
  let list = CAT.objects.map(o => ({ o, c: objCounts(o) }))
    .filter(({ o }) => (UI.st === "all" || o.st === UI.st) && (!q || o.name.toLowerCase().includes(q) || o.en.toLowerCase().includes(q)));
  if (UI.sort === "n") list.sort((a, b) => b.c.n - a.c.n || ru(a.o.name, b.o.name));
  else if (UI.sort === "open") list.sort((a, b) => (a.c.yes > 0) - (b.c.yes > 0) || ru(a.o.name, b.o.name));
  else list.sort((a, b) => ru(a.o.name, b.o.name));
  const total = FR.length;
  const html = [`<li><button type="button" data-o="" aria-current="${UI.obj === ""}"><span></span><span class="nm all">Все объекты</span><span class="n">${total}</span></button></li>`];
  for (const { o, c } of list) {
    const dot = c.yes ? "ok" : o.st === "отклонён" ? "rej" : c.q ? "q" : o.st === "на замену" ? "open" : "";
    html.push(`<li><button type="button" data-o="${esc(o.id)}" aria-current="${UI.obj === o.id}" title="${esc(o.name)}: кандидатов ${c.n}, берём ${c.yes}${c.q ? ", под вопросом " + c.q : ""}">` +
      `<span class="dot ${dot}"></span><span class="nm">${esc(o.name)}</span><span class="n">${c.n}${c.yes ? " · ✓" + c.yes : ""}</span></button></li>`);
  }
  $("objs").innerHTML = html.join("");
}

// ---------- сетка ----------
function buildSrcChips() {
  const have = new Set(FR.map(f => f.src));
  $("src-chips").innerHTML = SOURCES.filter(s => have.has(s))
    .map(s => `<button type="button" data-v="${esc(s)}" aria-pressed="${UI.src.includes(s)}">${esc(s)}</button>`).join("");
}
function passes(f) {
  if (UI.obj && f.o !== UI.obj) return false;
  if (UI.src.length && !UI.src.includes(f.src)) return false;
  const pv = UI.prev;
  if (pv === "g-yes" && f.gd !== "взять") return false;
  if (pv === "g-no" && f.gd !== "отклонить") return false;
  if (pv === "new" && !unseen(f)) return false;
  if (!["all", "g-yes", "g-no", "new"].includes(pv) && f.prev?.s !== pv) return false;
  const m = UI.mine, d = mine(f);
  if (m === "none" && d) return false;
  if (["да", "?", "нет"].includes(m) && d !== m) return false;
  if (m === "diff" && !Object.values(OTHER).some(o => o[f.k]?.d && o[f.k].d !== eff(f))) return false;
  return true;
}
function rank(f) {
  const e = eff(f);
  return f.prev?.s === "взят" ? 0 : e === "да" ? 1 : e === "?" ? 2 : e === "нет" ? 5 : unseen(f) ? 3 : 4;
}
function sortFrames(a, b) {
  return (UI.obj ? 0 : ru(OBJ.get(a.o).name, OBJ.get(b.o).name)) || rank(a) - rank(b) || (b.of ?? 0) - (a.of ?? 0) || (a.k < b.k ? -1 : 1);
}
function renderHead() {
  const el = $("obj-head");
  if (!UI.obj) {
    el.innerHTML = `<h1>Все объекты</h1><span class="en">${CAT.objects.length} объектов</span>`;
    return;
  }
  const o = OBJ.get(UI.obj), c = objCounts(o);
  const st = { "взят": ["ok", "взят на обсуждении"], "на замену": ["q", "на замену"], "отклонён": ["no", "отклонён на обсуждении"] }[o.st] || ["", o.st];
  const notes = [`<span class="pill ${st[0]}">${st[1]}</span>`];
  notes.push(c.yes ? `<span class="pill ok">берём: ${c.yes}</span>` : `<span class="pill">кадр не выбран</span>`);
  if (o.zam) notes.push(`<span class="pill q" title="Помета обсуждения и замечания">помета: ${esc(o.zam)}</span>`);
  if (o.dup) notes.push(`<span class="pill no">в исходной базе есть «${esc(o.dup)}»</span>`);
  if (o.res) notes.push(`<span class="pill">ещё ${o.res} кадров Megalith ждут подготовки</span>`);
  el.innerHTML = `<h1>${esc(o.name)}</h1><span class="en">${esc(o.en)}</span>` +
    `<button type="button" class="btn ghost" id="b-find-obj">Искать фото</button><div class="notes">${notes.join("")}</div>`;
  $("b-find-obj").onclick = () => { $("s-obj").value = o.id; $("s-q").value = o.en; location.hash = "#poisk"; };
}
function tileHTML(f) {
  const d = mine(f), e = eff(f), show = UI.show;
  const marks = [];
  if (f.prev) {
    const t = [f.prev.d && "обсуждение: " + f.prev.d, f.prev.r, f.prev.c].filter(Boolean).join("; ");
    marks.push(`<span class="pill ${PREV_CLS[f.prev.s] ?? ""}" title="${esc(t)}">№${f.prev.n} · ${esc(f.prev.s)}</span>`);
  }
  if (f.gd) marks.push(`<span class="pill ${f.gd === "взять" ? "prev" : ""}" title="${esc(f.gc)}">галерея: ${f.gd === "взять" ? "взять" : "нет"}</span>`);
  if (/^порция 7/.test(f.why || "")) marks.push(`<span class="pill">порция 7</span>`);
  if (f.found) marks.push(`<span class="pill prev">найдено</span>`);
  if (unseen(f)) marks.push(`<span class="pill">новый</span>`);
  for (const [who, o] of Object.entries(OTHER)) if (o[f.k]?.d) marks.push(`<span class="pill ${o[f.k].d !== e ? "no" : ""}" title="${esc(o[f.k].c || "")}">${esc(who)}: ${DL[o[f.k].d]}</span>`);
  const ed = edited(f), two = show === "mg";
  let pics;
  if (ed || (!mooneyURL(f) && (photoURL(f) || grayURL(f)))) {
    pics = `<span class="ph">…</span>`;
  } else if (!mooneyURL(f) && !grayURL(f)) {
    pics = `<span class="ph">${f.loc ? "Кадр не публикуется. Откройте папку с ним кнопкой «Кадры с диска»." : "Нет изображения"}</span>`;
  } else {
    const g = grayURL(f), m = mooneyURL(f);
    pics = (show !== "m" && g ? `<img loading="lazy" decoding="async" alt="" src="${esc(g)}">` : "") + (show !== "g" && m ? `<img loading="lazy" decoding="async" alt="" src="${esc(m)}">` : "");
  }
  const meta = [f.src, f.fmt?.replace("x", "×"), f.wh != null && !ed ? "белого " + pct(f.wh) : "", f.of ? "объект " + pct(f.of) : ""].filter(Boolean);
  const cls = d === "да" || (!d && e === "да") ? "d-yes" : d === "?" ? "d-q" : d === "нет" ? "d-no" : "";
  return `<figure class="tile ${cls}" data-k="${esc(f.k)}">` +
    `<button type="button" class="pics ${two ? "two" : ""}" data-k="${esc(f.k)}" data-show="${show}" data-render="${pics.startsWith('<span class="ph">…') ? 1 : 0}" aria-label="Открыть ${esc(OBJ.get(f.o).name)} в редакторе">${pics}${ed ? '<span class="edited">изменён</span>' : ""}</button>` +
    `<div class="marks">${marks.join("")}</div>` +
    `<div class="meta">${meta.map(esc).map(s => `<span>${s}</span>`).join("")}<span class="k">${esc(f.k)}</span></div>` +
    (DEC[f.k]?.c ? `<p class="com">${esc(DEC[f.k].c)}</p>` : "") +
    `<div class="dec">${["да", "?", "нет"].map(v => `<button type="button" data-d="${v}" class="${v === "да" ? "d-yes" : v === "?" ? "d-q" : "d-no"}" aria-pressed="${d === v}">${v === "да" ? "Берём" : v === "?" ? "?" : "Нет"}</button>`).join("")}</div>` +
    `</figure>`;
}
function renderGrid() {
  renderHead();
  document.querySelectorAll("#st-chips button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === UI.st)));
  document.querySelectorAll("#show button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === UI.show)));
  document.querySelectorAll("#src-chips button").forEach(b => b.setAttribute("aria-pressed", String(UI.src.includes(b.dataset.v))));
  $("f-prev").value = UI.prev; $("f-mine").value = UI.mine; $("o-sort").value = UI.sort; $("tile-size").value = UI.ts; $("q-obj").value = UI.q;
  document.querySelectorAll(".grid").forEach(g => g.style.setProperty("--ts", UI.ts + "px"));
  VISIBLE = FR.filter(passes).sort(sortFrames);
  const parts = [];
  let last = null;
  for (const f of VISIBLE) {
    if (!UI.obj && f.o !== last) {
      last = f.o;
      parts.push(`<h3 class="grp"><button type="button" data-o="${esc(f.o)}">${esc(OBJ.get(f.o).name)}</button><span class="hint">${esc(OBJ.get(f.o).st)}</span></h3>`);
    }
    parts.push(tileHTML(f));
  }
  const grid = $("grid");
  grid.innerHTML = parts.join("") || `<p class="empty">Под эти условия кадров нет.</p>`;
  grid.querySelectorAll('.pics[data-render="1"]').forEach(el => io.observe(el));
  const yes = VISIBLE.filter(f => eff(f) === "да").length;
  $("count").textContent = `Показано кадров: ${VISIBLE.length}` + (yes ? ` · берём: ${yes}` : "");
}
function refreshTile(k) {
  const f = FRK.get(k);
  document.querySelectorAll(`.tile[data-k="${CSS.escape(k)}"]`).forEach(t => {
    const tmp = document.createElement("div"); tmp.innerHTML = tileHTML(f);
    const n = tmp.firstElementChild; t.replaceWith(n);
    const p = n.querySelector('.pics[data-render="1"]'); if (p) io.observe(p);
  });
}
function setDec(k, d) {
  const cur = DEC[k] || {};
  const nd = cur.d === d ? null : d;
  const next = { ...cur, d: nd, t: Date.now() };
  if (!next.d) delete next.d;
  if (!next.d && !next.c && !next.p) delete DEC[k]; else DEC[k] = next;
  saveDec();
  refreshTile(k);
  if (!$("v-otbor").hidden) { renderObjs(); renderHead(); }
}

// ---------- редактор ----------
const ED = { list: [], i: 0, f: null, p: null, r: null, show: "m", t: 0, seq: 0 };
function openEditor(k, list) {
  ED.list = list && list.includes(k) ? list : [k];
  ED.i = ED.list.indexOf(k);
  $("ed").hidden = false; document.body.style.overflow = "hidden";
  loadEditor();
}
function closeEditor() {
  $("ed").hidden = true; document.body.style.overflow = "";
  if (ED.f) refreshTile(ED.f.k);
  if (!$("v-otbor").hidden) renderObjs();
  if (!$("v-stat").hidden) renderStats();
}
function loadEditor() {
  const prevK = ED.f?.k;
  if (prevK) refreshTile(prevK);
  const f = FRK.get(ED.list[ED.i]); ED.f = f; ED.p = getParams(f); ED.r = null;
  const o = OBJ.get(f.o);
  $("ed-title").textContent = `${o.name} · ${f.k}` + (ED.list.length > 1 ? ` (${ED.i + 1} из ${ED.list.length})` : "");
  $("ed-prev").disabled = ED.i === 0; $("ed-next").disabled = ED.i >= ED.list.length - 1;
  $("ed-com").value = DEC[f.k]?.c || "";
  syncDecButtons();
  syncControls();
  renderInfo();
  $("ed-photo-box").hidden = !photoURL(f);
  ["ed-fmt", "ed-size-row"].forEach(id => $(id).classList.toggle("off", !photoURL(f)));
  document.querySelectorAll("#ed-fmt button").forEach(b => b.disabled = !photoURL(f));
  $("ed-size").disabled = !photoURL(f);
  update(0);
}
function syncDecButtons() {
  const d = mine(ED.f);
  document.querySelectorAll("#ed-dec button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === d)));
}
function syncControls() {
  const p = ED.p;
  document.querySelectorAll("#ed-fmt button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === p.fmt)));
  document.querySelectorAll("#ed-thr button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === p.thr.m)));
  document.querySelectorAll("#ed-show button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === ED.show)));
  $("ed-sigma").value = p.sigma; $("ed-sigma-v").textContent = p.sigma.toFixed(1);
  $("ed-con").value = p.con; $("ed-con-v").textContent = p.con.toFixed(2);
  $("ed-gam").value = p.gam; $("ed-gam-v").textContent = p.gam.toFixed(2);
  $("ed-speck").value = p.speck; $("ed-speck-v").textContent = p.speck;
  $("ed-flip").setAttribute("aria-pressed", String(p.flip)); $("ed-inv").setAttribute("aria-pressed", String(p.inv));
  const tv = $("ed-thrv");
  $("ed-thrv-row").hidden = p.thr.m === "otsu";
  if (p.thr.m === "white") { tv.min = 0.05; tv.max = 0.95; tv.step = 0.01; $("ed-thrv-l").textContent = "Доля белого"; tv.value = p.thr.v; $("ed-thrv-v").textContent = pct(p.thr.v); }
  if (p.thr.m === "manual") { tv.min = 0; tv.max = 255; tv.step = 1; $("ed-thrv-l").textContent = "Порог"; tv.value = p.thr.v; $("ed-thrv-v").textContent = p.thr.v; }
}
function sizeOf() {
  const r = ED.r; if (!r?.photo || !ED.p.b) return 1;
  const [fw, fh] = ED.p.fmt.split("x").map(Number), [mw] = maxFrame(r.src.W, r.src.H, fw, fh);
  return (ED.p.b[2] - ED.p.b[0]) / mw;
}
function update(delay = 0) {
  clearTimeout(ED.t);
  ED.t = setTimeout(async () => {
    const seq = ++ED.seq, f = ED.f;
    let r;
    try { r = await renderFrame(f, ED.p); } catch (e) {
      $("ed-read").textContent = f.loc ? "Кадр не публикуется. Откройте папку с ним кнопкой «Кадры с диска»." : "Не удалось загрузить изображение: " + e.message;
      $("ed-c1").width = $("ed-c1").height = 0; $("ed-c2").hidden = true;
      return;
    }
    if (seq !== ED.seq || f !== ED.f) return;
    ED.r = r;
    draw();
    const s = sizeOf();
    $("ed-size").value = Math.round(s * 100); $("ed-size-v").textContent = Math.round(s * 100) + " %";
    $("ed-read").innerHTML = [`${r.w}×${r.h}`, `σ = ${ED.p.sigma.toFixed(1)} → ${r.sigmaPx.toFixed(2)} px`, `порог ${r.threshold}`, `белого ${pct(r.white)}`, `крупных пятен ${r.patches}`, r.photo ? "из исходного фото" : "из серой версии"].map(x => `<span>${x}</span>`).join("");
    persist();
  }, delay);
}
function persist() {
  const f = ED.f, def = defParams(f), p = JSON.parse(JSON.stringify(ED.p)), r = ED.r;
  if (!def.b && r?.photo) def.b = boxAt(r.src.W, r.src.H, def.fmt, 1, r.src.W / 2, r.src.H / 2);
  const cur = DEC[f.k] || {};
  const isDef = same(def, p);
  if (isDef && !cur.p) return;
  const next = { ...cur, t: Date.now() };
  if (isDef) delete next.p; else next.p = p;
  if (!next.d && !next.c && !next.p) delete DEC[f.k]; else DEC[f.k] = next;
  saveDec();
}
function draw() {
  const r = ED.r; if (!r) return;
  const c1 = $("ed-c1"), c2 = $("ed-c2"), st = $("ed-stage");
  const mode = ED.show;
  paint(c1, r, mode === "s" ? "g" : mode);
  c2.hidden = mode !== "s";
  if (mode === "s") paint(c2, r, "m");
  st.classList.toggle("two", mode === "s");
  const k = mode === "s" ? 1 : Math.max(1, Math.min(2, Math.floor(560 / Math.max(r.w, r.h) * 10) / 10));
  c1.style.width = r.w * k + "px"; c2.style.width = r.w * k + "px";
  drawPhoto();
}
function drawPhoto() {
  const r = ED.r, c = $("ed-photo");
  if (!r?.photo) return;
  const pv = r.src.preview, maxW = Math.min(c.parentElement.clientWidth || 600, 720), k = Math.min(maxW / pv.width, 340 / pv.height, 1);
  c.width = Math.round(pv.width * k); c.height = Math.round(pv.height * k);
  const x = c.getContext("2d"); x.drawImage(pv, 0, 0, c.width, c.height);
  const s = c.width / r.src.W, [x0, y0, x1, y1] = ED.p.b;
  x.save(); x.fillStyle = "rgba(0,0,0,.5)";
  x.beginPath(); x.rect(0, 0, c.width, c.height); x.rect(x0 * s, y0 * s, (x1 - x0) * s, (y1 - y0) * s); x.fill("evenodd");
  x.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#b8460f";
  x.lineWidth = 2; x.strokeRect(x0 * s + 1, y0 * s + 1, (x1 - x0) * s - 2, (y1 - y0) * s - 2); x.restore();
}
function setBox(cx, cy, size, fmt) {
  const r = ED.r; if (!r?.photo) return;
  ED.p.fmt = fmt || ED.p.fmt;
  ED.p.b = boxAt(r.src.W, r.src.H, ED.p.fmt, Math.min(1, Math.max(0.1, size)), cx, cy);
}
function center() { const b = ED.p.b; return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
function renderInfo() {
  const f = ED.f, o = OBJ.get(f.o), rows = [];
  const add = (k, v) => { if (v) rows.push(`<dt>${k}</dt><dd>${v}</dd>`); };
  add("Объект", esc(o.name) + (o.en ? ` <span class="hint">(${esc(o.en)})</span>` : ""));
  add("Источник", esc(f.src));
  add("Лицензия", esc(f.lic));
  add("Автор", esc(f.au));
  if (f.pg) add("Страница", `<a href="${esc(f.pg)}" target="_blank" rel="noopener">${esc(f.pg.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60))}</a>`);
  if (f.prev) add("Ранее", `№${f.prev.n} · ${esc(f.prev.s)} · ${esc(f.prev.who)}` + [f.prev.d && "обсуждение: " + f.prev.d, f.prev.r, f.prev.c].filter(Boolean).map(s => `<br><span class="hint">${esc(s)}</span>`).join(""));
  if (f.gd) add("Галерея", esc(f.gd) + (f.gc ? ` · ${esc(f.gc)}` : ""));
  add("Отбор", esc(f.why));
  for (const [who, x] of Object.entries(OTHER)) if (x[f.k]?.d) add(esc(who), esc(DL[x[f.k].d]) + (x[f.k].c ? ` · ${esc(x[f.k].c)}` : ""));
  if (f.found) add("", `<button type="button" class="btn ghost" id="ed-unfound">Убрать из найденных</button>`);
  $("ed-info").innerHTML = rows.join("");
  if (f.found) $("ed-unfound").onclick = () => {
    const k = f.k; ED.list = ED.list.filter(x => x !== k); removeFound(k); closeEditor(); renderGrid(); toast("Кадр убран из найденных");
  };
}
function savePNG(kind) {
  const r = ED.r; if (!r) return;
  const c = paint(document.createElement("canvas"), r, kind);
  c.toBlob(b => download(b, `${OBJ.get(ED.f.o).name}_${ED.f.k}_${kind === "m" ? "mooney" : "gray"}.png`), "image/png");
}
function download(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------- поиск ----------
const SR = { prov: "wm", q: "", page: 0, items: [] };
function fillSearchObjects() {
  $("s-obj").innerHTML = CAT.objects.slice().sort((a, b) => ru(a.name, b.name))
    .map(o => `<option value="${esc(o.id)}">${esc(o.name)}${o.st === "на замену" ? " · на замену" : ""}</option>`).join("");
}
function prefillSearch() {
  const o = OBJ.get(UI.obj) || CAT.objects.find(x => x.st === "на замену");
  if (o) { $("s-obj").value = o.id; $("s-q").value = o.en; }
}
function licClass(l) {
  const s = String(l || "").toLowerCase();
  if (/\bnc\b|-nc|\bnd\b|-nd/.test(s)) return null;
  if (/cc0|public domain|^pd\b|pdm|no restrictions/.test(s)) return "pd";
  if (/by-sa|by sa/.test(s)) return "sa";
  if (/cc[ -]by\b|attribution/.test(s)) return "by";
  return null;
}
const stripHTML = h => new DOMParser().parseFromString(String(h || ""), "text/html").body.textContent.trim();
async function doSearch(more) {
  const lics = [...document.querySelectorAll(".lic input:checked")].map(i => i.value);
  if (!lics.length) { $("s-status").textContent = "Отметьте хотя бы одну лицензию."; return; }
  if (!more) { SR.page = 0; SR.items = []; $("s-grid").innerHTML = ""; }
  SR.q = $("s-q").value.trim(); SR.prov = $("s-prov").value;
  $("s-status").textContent = "Ищу…"; $("s-more").hidden = true;
  let items = [], hasMore = false;
  try {
    if (SR.prov === "wm") {
      const u = "https://commons.wikimedia.org/w/api.php?" + new URLSearchParams({
        action: "query", format: "json", formatversion: "2", origin: "*", generator: "search", gsrnamespace: "6",
        gsrsearch: SR.q + " filetype:bitmap", gsrlimit: "40", gsroffset: String(SR.page * 40), prop: "imageinfo",
        iiprop: "url|size|extmetadata", iiurlwidth: "960", iiextmetadatafilter: "LicenseShortName|Artist|UsageTerms" });
      const d = await (await fetch(u)).json();
      hasMore = !!d.continue;
      items = (d.query?.pages || []).sort((a, b) => a.index - b.index).map(p => {
        const ii = p.imageinfo?.[0]; if (!ii) return null;
        const m = ii.extmetadata || {};
        return { k: "wm_" + p.pageid, title: p.title.replace(/^File:/, ""), au: stripHTML(m.Artist?.value), lic: m.LicenseShortName?.value || m.UsageTerms?.value || "",
                 pg: ii.descriptionurl, url: ii.thumburl || ii.url, W: ii.thumbwidth || ii.width, H: ii.thumbheight || ii.height, src: "Wikimedia Commons" };
      }).filter(Boolean);
    } else {
      const map = { pd: "cc0,pdm", by: "by", sa: "by-sa" };
      const u = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(SR.q)}&license=${lics.map(l => map[l]).join(",")}&page_size=40&page=${SR.page + 1}&mature=false`;
      const r = await fetch(u);
      if (!r.ok) throw new Error("Openverse ответил " + r.status);
      const d = await r.json();
      hasMore = d.page < d.page_count;
      items = (d.results || []).map(x => ({ k: "ov_" + x.id, title: x.title || "", au: x.creator || "",
        lic: x.license === "cc0" ? "CC0" : x.license === "pdm" ? "PDM" : `CC ${x.license.toUpperCase()} ${x.license_version || ""}`.trim(),
        pg: x.foreign_landing_url, url: x.thumbnail, W: x.width, H: x.height, src: "Openverse" }));
    }
  } catch (e) {
    $("s-status").textContent = (SR.prov === "ov" ? "Openverse сейчас не отвечает. Попробуйте позже или выберите Wikimedia Commons. " : "Поиск не удался. ") + (e.message || "");
    return;
  }
  items = items.filter(x => lics.includes(licClass(x.lic)) && x.url && x.W && x.H);
  SR.items.push(...items); SR.page++;
  const grid = $("s-grid"), oid = $("s-obj").value, oname = OBJ.get(oid)?.name || "";
  grid.insertAdjacentHTML("beforeend", items.map(x => {
    const added = FRK.has(x.k);
    return `<figure class="tile s-card" data-k="${esc(x.k)}"><div class="pics two" data-sk="${esc(x.k)}"><img alt="" crossorigin="anonymous" loading="lazy" src="${esc(x.url)}"><span class="ph">…</span></div>` +
      `<div class="meta"><span>${esc(x.title.slice(0, 70))}</span><span>${esc(x.au.slice(0, 50))}</span><span>${esc(x.lic)}</span><a href="${esc(x.pg)}" target="_blank" rel="noopener">страница</a></div>` +
      `<div class="acts"><button type="button" class="btn ghost" data-act="add" ${added ? "disabled" : ""}>${added ? "Добавлен" : "Добавить к «" + esc(oname) + "»"}</button><button type="button" class="btn ghost" data-act="open">В редактор</button></div></figure>`;
  }).join(""));
  grid.querySelectorAll(".pics[data-sk]").forEach(el => { if (!el.dataset.q) { el.dataset.q = 1; sio.observe(el); } });
  $("s-status").textContent = SR.items.length ? `Найдено с подходящей лицензией: ${SR.items.length}` : "Ничего не найдено. Попробуйте другое слово или другой источник.";
  $("s-more").hidden = !hasMore;
}
const squeue = [];
let sbusy = false;
const sio = new IntersectionObserver(es => {
  for (const e of es) if (e.isIntersecting) { sio.unobserve(e.target); squeue.push(e.target); }
  spump();
}, { rootMargin: "200px" });
async function spump() {
  if (sbusy) return; sbusy = true;
  while (squeue.length) {
    const el = squeue.shift(), x = SR.items.find(i => i.k === el.dataset.sk);
    if (!x || !el.isConnected) continue;
    try {
      const fake = { k: x.k, url: x.url, found: 1, fmt: bestFmt(x.W, x.H) };
      const r = await renderFrame(fake, defParams(fake));
      el.querySelector(".ph")?.replaceWith(paint(document.createElement("canvas"), r, "m"));
    } catch { el.querySelector(".ph")?.replaceChildren("не загрузилось"); }
    await new Promise(r => setTimeout(r, 0));
  }
  sbusy = false;
}
function foundFrom(x, oid) {
  return { k: x.k, o: oid, src: x.src, lic: x.lic, au: x.au, pg: x.pg, url: x.url, fmt: bestFmt(x.W, x.H), title: x.title, found: 1, why: "найдено в поиске: " + SR.q, t: Date.now() };
}

// ---------- статистика ----------
function computeStats() {
  const objs = CAT.objects.map(o => {
    const fr = FR.filter(f => f.o === o.id);
    const c = { n: fr.length, yes: 0, q: 0, no: 0, open: 0, mineYes: 0 };
    for (const f of fr) {
      const e = eff(f);
      if (e === "да") { c.yes++; if (mine(f) === "да") c.mineYes++; } else if (e === "?") c.q++; else if (e === "нет") c.no++; else if (isOpen(f)) c.open++;
    }
    return { o, c };
  });
  const covered = objs.filter(x => x.c.yes > 0);
  const repl = objs.filter(x => x.o.st === "на замену");
  const all = FR.length, mineN = { "да": 0, "?": 0, "нет": 0 };
  for (const f of FR) { const d = mine(f); if (d) mineN[d]++; }
  return {
    objs, covered: covered.length,
    coveredPrev: covered.filter(x => x.o.st === "взят").length,
    coveredNew: covered.filter(x => x.o.st !== "взят").length,
    qOnly: objs.filter(x => !x.c.yes && x.c.q).length,
    repl: repl.length, replYes: repl.filter(x => x.c.yes).length, replQ: repl.filter(x => !x.c.yes && x.c.q).length,
    replOpen: repl.filter(x => !x.c.yes && !x.c.q && x.c.open).length,
    replNone: repl.filter(x => !x.c.yes && !x.c.q && !x.c.open).length,
    replReserve: repl.filter(x => !x.c.yes && !x.c.q && !x.c.open && x.o.res).length,
    frames: all, unseen: FR.filter(unseen).length, mineN, edited: FR.filter(edited).length, found: FR.filter(f => f.found).length,
  };
}
function renderStats() {
  if (!CAT) return;
  const S = computeStats(), [g1, g2] = CAT.goal, max = Math.max(g2 + 10, CAT.objects.length);
  const yesF = FR.filter(f => eff(f) === "да");
  const bars = (rows, total) => `<div class="bars">${rows.map(([k, n, y]) => `<div class="bar"><span>${esc(k)}</span><span class="tr"><i class="ok" style="width:${total ? (y / total) * 100 : 0}%"></i><i style="width:${total ? ((n - y) / total) * 100 : 0}%;opacity:.25"></i></span><span class="v">${y === n ? n : y + " / " + n}</span></div>`).join("")}</div>`;
  const bySrc = SOURCES.map(s => [s, FR.filter(f => f.src === s).length, yesF.filter(f => f.src === s).length]).filter(r => r[1]);
  const maxSrc = Math.max(...bySrc.map(r => r[1]));
  const byFmt = FORMATS.map(f => [f.replace("x", "×"), yesF.filter(x => (DEC[x.k]?.p?.fmt || x.fmt) === f).length]);
  const wh = yesF.filter(f => f.wh != null && !edited(f)).map(f => f.wh);
  const bins = Array(16).fill(0); for (const v of wh) bins[Math.min(15, Math.max(0, Math.floor((v - 0.3) / 0.025)))]++;
  const hb = Math.max(1, ...bins);
  const others = Object.entries(OTHER).map(([who, o]) => {
    let both = 0, agree = 0;
    for (const [k, x] of Object.entries(o)) { const f = FRK.get(k); if (!f || !x.d) continue; const e = eff(f); if (e) { both++; if (e === x.d) agree++; } }
    return `<dt>${esc(who)}: решений</dt><dd>${Object.values(o).filter(x => x.d).length}</dd><dt>совпадает с моими</dt><dd>${agree} из ${both}</dd>`;
  }).join("");
  const rows = S.objs.slice().sort((a, b) => ru(a.o.name, b.o.name)).map(({ o, c }) =>
    `<tr><td><button type="button" data-o="${esc(o.id)}">${esc(o.name)}</button></td><td>${esc(o.st)}</td><td class="num">${c.n}</td><td class="num">${c.open}</td><td class="num">${c.yes}</td><td class="num">${c.q}</td><td class="num">${c.no}</td><td class="num">${o.res || ""}</td><td>${o.dup ? "есть «" + esc(o.dup) + "»" : ""}</td></tr>`).join("");
  $("stat").innerHTML = `
  <section class="card"><h2>Новые объекты с выбранным кадром</h2>
    <div class="big">${S.covered} <small>из цели ${g1}–${g2}</small></div>
    <div class="goal"><div class="fill q" style="width:${((S.covered + S.qOnly) / max) * 100}%"></div><div class="fill" style="width:${(S.covered / max) * 100}%"></div>
      <div class="tick" style="left:${(g1 / max) * 100}%"><span>${g1}</span></div><div class="tick" style="left:${(g2 / max) * 100}%"><span>${g2}</span></div></div>
    <dl class="kv"><dt>взяты на обсуждении</dt><dd>${S.coveredPrev}</dd><dt>добавлены сейчас</dt><dd>${S.coveredNew}</dd><dt>ещё под вопросом</dt><dd>${S.qOnly}</dd><dt>не хватает до ${g1}</dt><dd>${Math.max(0, g1 - S.covered)}</dd></dl>
  </section>
  <section class="card"><h2>Объекты на замену: ${S.repl}</h2>
    <dl class="kv"><dt>выбран кадр</dt><dd>${S.replYes}</dd><dt>под вопросом</dt><dd>${S.replQ}</dd><dt>есть кадры без решения</dt><dd>${S.replOpen}</dd><dt>кандидатов здесь нет</dt><dd>${S.replNone}</dd><dt>из них с запасом Megalith на втором компьютере</dt><dd>${S.replReserve}</dd></dl>
  </section>
  <section class="card"><h2>Кадры</h2>
    <dl class="kv"><dt>всего на сайте</dt><dd>${S.frames}</dd><dt>ещё не просмотрены</dt><dd>${S.unseen}</dd><dt>мои решения: берём</dt><dd>${S.mineN["да"]}</dd><dt>под вопросом</dt><dd>${S.mineN["?"]}</dd><dt>нет</dt><dd>${S.mineN["нет"]}</dd><dt>изменены настройки</dt><dd>${S.edited}</dd><dt>найдено в поиске</dt><dd>${S.found}</dd>${others}</dl>
  </section>
  <section class="card"><h2>Источники: выбрано из всех</h2>${bars(bySrc, maxSrc)}</section>
  <section class="card"><h2>Форматы выбранных кадров</h2>${bars(byFmt.map(([k, n]) => [k, n, n]), Math.max(1, ...byFmt.map(r => r[1])))}
    <h2 style="margin-top:18px">Доля белого у выбранных</h2>
    <div class="hist">${bins.map((n, i) => `<div style="height:${(n / hb) * 100}%" title="${(30 + i * 2.5).toFixed(1)}–${(32.5 + i * 2.5).toFixed(1)} %: ${n}"></div>`).join("")}</div>
    <div class="hist-x"><span>30 %</span><span>50 %</span><span>70 %</span></div>
    <p class="hint">По кадрам со стандартными настройками (σ = 2, порог Оцу): ${wh.length}.</p></section>
  <section class="card"><h2>Пересечения с исходной базой</h2>
    <dl class="kv">${CAT.objects.filter(o => o.dup).map(o => `<dt>${esc(o.name)}</dt><dd>«${esc(o.dup)}»</dd>`).join("") || "<dt>нет</dt><dd></dd>"}</dl>
    <p class="hint" style="margin-top:10px">Исходная база: ${CAT.base.length} стимулов.</p></section>
  <section class="card wide"><h2>По объектам</h2><div class="tbl-wrap"><table class="t">
    <thead><tr><th>Объект</th><th>Ранее</th><th>Кадров</th><th>Без решения</th><th>Берём</th><th>?</th><th>Нет</th><th>Запас</th><th>Исходная база</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  $("stat").querySelectorAll("button[data-o]").forEach(b => b.onclick = () => { UI.obj = b.dataset.o; saveUI(); location.hash = "#otbor"; });
}

// ---------- Excel ----------
async function excelReady() {
  for (let i = 0; i < 100 && !window.ExcelJS; i++) await new Promise(r => setTimeout(r, 100));
  if (!window.ExcelJS) throw new Error("не загрузилась библиотека Excel");
}
function exportList(what) {
  const pick = {
    yes: f => mine(f) === "да", yesq: f => mine(f) === "да" || mine(f) === "?",
    mine: f => !!mine(f), eff: f => eff(f) === "да",
  }[what];
  return FR.filter(pick).sort((a, b) => ru(OBJ.get(a.o).name, OBJ.get(b.o).name) || rank(a) - rank(b));
}
function thumb(r, mode) {
  const c = paint(document.createElement("canvas"), r, mode), k = Math.min(130 / r.w, 124 / r.h);
  const t = document.createElement("canvas"); t.width = Math.round(r.w * k); t.height = Math.round(r.h * k);
  const x = t.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(c, 0, 0, t.width, t.height);
  return { data: t.toDataURL(mode === "m" ? "image/png" : "image/jpeg", 0.85), w: t.width, h: t.height };
}
async function exportExcel(what, withImg) {
  await excelReady();
  const list = exportList(what), who = $("who").value.trim();
  if (!list.length) { toast("Нет кадров для выгрузки"); return; }
  const wb = new ExcelJS.Workbook(); wb.creator = who; wb.created = new Date();
  const ws = wb.addWorksheet("Кадры", { views: [{ state: "frozen", ySplit: 1, xSplit: 2 }] });
  ws.columns = [
    ["№", "n", 5], ["Объект", "o", 16], ["Решение", "d", 12], ["Комментарий", "c", 26], ["Серое", "ig", 20], ["Mooney", "im", 20],
    ["Ранее", "ps", 12], ["№ в сводной", "pn", 8], ["Обсуждение", "pd", 18], ["Замечания", "pr", 26],
    ["Источник", "src", 15], ["Лицензия", "lic", 13], ["Автор", "au", 20], ["Страница", "pg", 34],
    ["Формат", "fmt", 9], ["σ", "sg", 5], ["σ, px", "sp", 7], ["Порог", "thr", 13], ["Доля белого", "wh", 8], ["Крупных пятен", "pt", 8],
    ["Рамка: x0 y0 x1 y1", "b", 18], ["Поворот", "rot", 8], ["Отражение", "fl", 9], ["Инверсия", "inv", 9], ["Контраст", "con", 8], ["Гамма", "gam", 7], ["Убрать пятна < px", "spk", 9],
    ["Настройки изменены", "ed", 9], ["Ключ", "k", 30], ["Параметры (JSON)", "pj", 40], ["Отбирал", "who", 12],
  ].map(([header, key, width]) => ({ header, key, width }));
  const hr = ws.getRow(1); hr.font = { bold: true }; hr.alignment = { vertical: "middle", wrapText: true }; hr.height = 32;
  hr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDE9E1" } };
  const btn = $("xl-go");
  for (let i = 0; i < list.length; i++) {
    const f = list[i], p = getParams(f), d = mine(f);
    btn.textContent = `Готовлю ${i + 1} из ${list.length}…`;
    let r = null;
    try { r = await renderFrame(f, p); } catch { r = null; }
    const thrTxt = r ? (p.thr.m === "otsu" ? `Оцу: ${r.threshold}` : p.thr.m === "white" ? `белого ${pct(p.thr.v)}: ${r.threshold}` : `вручную: ${r.threshold}`) : "";
    const pj = { ...p, ...(f.found ? { found: { o: f.o, src: f.src, lic: f.lic, au: f.au, pg: f.pg, url: f.url, title: f.title } } : {}) };
    const row = ws.addRow({
      n: i + 1, o: OBJ.get(f.o).name, d: d ? DL[d] : eff(f) === "да" ? "взят ранее" : "", c: DEC[f.k]?.c || "",
      ps: f.prev?.s || (f.found ? "найдено" : ""), pn: f.prev?.n || "", pd: f.prev?.d || "", pr: [f.prev?.r, f.prev?.c].filter(Boolean).join("; "),
      src: f.src, lic: f.lic, au: f.au, pg: f.pg ? { text: f.pg, hyperlink: f.pg } : "",
      fmt: r ? `${r.w}x${r.h}` : f.fmt, sg: p.sigma, sp: r ? +r.sigmaPx.toFixed(3) : "", thr: thrTxt,
      wh: r ? +r.white.toFixed(3) : "", pt: r ? r.patches : "", b: p.b ? p.b.join(" ") : "", rot: p.rot || 0,
      fl: p.flip ? "да" : "", inv: p.inv ? "да" : "", con: p.con, gam: p.gam, spk: p.speck || "",
      ed: edited(f) ? "да" : "", k: f.k, pj: JSON.stringify(pj), who,
    });
    row.alignment = { vertical: "middle", wrapText: true };
    if (withImg && r) {
      row.height = 100;
      for (const [mode, col] of [["g", 4], ["m", 5]]) {
        const t = thumb(r, mode), id = wb.addImage({ base64: t.data, extension: mode === "m" ? "png" : "jpeg" });
        ws.addImage(id, { tl: { col: col + 0.04, row: row.number - 1 + 0.04 }, ext: { width: t.w, height: t.h }, editAs: "oneCell" });
      }
    }
    if (i % 5 === 4) await new Promise(r => setTimeout(r, 0));
  }
  ws.autoFilter = { from: "A1", to: { row: 1, column: ws.columnCount } };

  const S = computeStats();
  const ws2 = wb.addWorksheet("Итог", { views: [{ state: "frozen", ySplit: 1 }] });
  ws2.columns = [["Объект", "o", 18], ["English", "en", 16], ["Ранее", "st", 12], ["Берём", "y", 40], ["Под вопросом", "q", 30], ["Кадров", "n", 8], ["Без решения", "op", 9], ["Запас на втором компьютере", "res", 11], ["Исходная база", "dup", 14], ["Помета обсуждения", "zam", 30]]
    .map(([header, key, width]) => ({ header, key, width }));
  ws2.getRow(1).font = { bold: true };
  for (const { o, c } of S.objs.slice().sort((a, b) => ru(a.o.name, b.o.name))) {
    const fr = FR.filter(f => f.o === o.id);
    ws2.addRow({ o: o.name, en: o.en, st: o.st, y: fr.filter(f => eff(f) === "да").map(f => f.prev?.n ? `№${f.prev.n}` : f.k).join(", "),
      q: fr.filter(f => eff(f) === "?").map(f => f.prev?.n ? `№${f.prev.n}` : f.k).join(", "), n: c.n, op: c.open, res: o.res || "", dup: o.dup, zam: o.zam });
  }
  const ws3 = wb.addWorksheet("Статистика");
  ws3.columns = [{ header: "Показатель", key: "k", width: 52 }, { header: "Значение", key: "v", width: 12 }];
  ws3.getRow(1).font = { bold: true };
  [["Новых объектов с выбранным кадром", S.covered], ["из них взяты на обсуждении", S.coveredPrev], ["из них добавлены сейчас", S.coveredNew],
   ["Объектов только под вопросом", S.qOnly], [`Цель`, `${CAT.goal[0]}–${CAT.goal[1]}`],
   ["Объектов на замену", S.repl], ["на замену: выбран кадр", S.replYes], ["на замену: под вопросом", S.replQ],
   ["на замену: есть кадры без решения", S.replOpen], ["на замену: кандидатов на сайте нет", S.replNone],
   ["Кадров на сайте", S.frames], ["Ещё не просмотрены", S.unseen], ["Мои решения: берём", S.mineN["да"]], ["Мои решения: под вопросом", S.mineN["?"]],
   ["Мои решения: нет", S.mineN["нет"]], ["Изменены настройки", S.edited], ["Найдено в поиске", S.found], ["Отбирал", who], ["Дата выгрузки", new Date().toLocaleString("ru-RU")]]
    .forEach(([k, v]) => ws3.addRow({ k, v }));

  const buf = await wb.xlsx.writeBuffer();
  const date = new Date().toISOString().slice(0, 10);
  download(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `Mooney_отбор_${who || "без имени"}_${date}.xlsx`);
  toast(`Выгружено кадров: ${list.length}`);
}
function exportJSON() {
  const who = $("who").value.trim();
  const blob = new Blob([JSON.stringify({ who, dec: DEC, found: FOUND, date: new Date().toISOString() }, null, 1)], { type: "application/json" });
  download(blob, `Mooney_решения_${who || "без имени"}_${new Date().toISOString().slice(0, 10)}.json`);
}
async function importFile(file) {
  let who = "", dec = {}, found = [];
  try {
    if (/\.json$/i.test(file.name)) {
      const d = JSON.parse(await file.text()); who = d.who || ""; dec = d.dec || {}; found = d.found || [];
    } else {
      await excelReady();
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await file.arrayBuffer());
      const ws = wb.getWorksheet("Кадры"); if (!ws) throw new Error("в файле нет листа «Кадры»");
      const col = {}; ws.getRow(1).eachCell((c, i) => { col[String(c.value).trim()] = i; });
      const val = (row, name) => { const v = col[name] ? row.getCell(col[name]).value : ""; return v && typeof v === "object" ? (v.text ?? v.result ?? "") : (v ?? ""); };
      ws.eachRow((row, i) => {
        if (i === 1) return;
        const k = String(val(row, "Ключ")).trim(); if (!k) return;
        who = who || String(val(row, "Отбирал")).trim();
        const d = DL_BACK[String(val(row, "Решение")).trim()] || null, c = String(val(row, "Комментарий") || "");
        let p = null;
        try { p = JSON.parse(val(row, "Параметры (JSON)") || "null"); } catch { p = null; }
        if (p?.found) { found.push({ k, ...p.found, fmt: p.fmt, found: 1, why: "найдено в поиске", t: Date.now() }); delete p.found; }
        dec[k] = { ...(d ? { d } : {}), ...(c ? { c } : {}), ...(p && String(val(row, "Настройки изменены")).trim() === "да" ? { p } : {}) };
      });
    }
  } catch (e) { toast("Не удалось прочитать файл: " + e.message, 6000); return; }
  who = who || file.name.replace(/\.[^.]+$/, "");
  let nf = 0;
  for (const f of found) if (!FRK.has(f.k) && OBJ.has(f.o)) { addFound(f); nf++; }
  const me = $("who").value.trim();
  const n = Object.values(dec).filter(x => x.d).length;
  if (me && who === me) {
    for (const [k, x] of Object.entries(dec)) if (FRK.has(k) && !DEC[k]?.d) DEC[k] = { ...DEC[k], ...x };
    saveDec(); toast(`Восстановлены мои решения из файла: ${n}` + (nf ? `, найденных кадров: ${nf}` : ""));
  } else {
    OTHER[who] = Object.fromEntries(Object.entries(dec).filter(([, x]) => x.d).map(([k, x]) => [k, { d: x.d, c: x.c || "" }]));
    LS.set("ms.other", OTHER);
    toast(`Загружены решения «${who}»: ${n}` + (nf ? `, найденных кадров: ${nf}` : "") + ". Они показаны на плитках рядом с вашими.", 6000);
  }
  route();
}

// ---------- события ----------
function bindUI() {
  $("who").onchange = () => LS.set("ms.who", $("who").value.trim());
  $("q-obj").oninput = () => { UI.q = $("q-obj").value; saveUI(); renderObjs(); };
  $("st-chips").onclick = e => { const b = e.target.closest("button"); if (!b) return; UI.st = b.dataset.v; saveUI(); renderObjs(); renderGrid(); };
  $("o-sort").onchange = () => { UI.sort = $("o-sort").value; saveUI(); renderObjs(); };
  $("objs").onclick = e => { const b = e.target.closest("button[data-o]"); if (!b) return; UI.obj = b.dataset.o; saveUI(); renderObjs(); renderGrid(); scrollTo({ top: 0 }); };
  $("src-chips").onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    const v = b.dataset.v; UI.src = UI.src.includes(v) ? UI.src.filter(x => x !== v) : [...UI.src, v]; saveUI(); renderGrid();
  };
  $("f-prev").onchange = () => { UI.prev = $("f-prev").value; saveUI(); renderGrid(); };
  $("f-mine").onchange = () => { UI.mine = $("f-mine").value; saveUI(); renderGrid(); };
  $("show").onclick = e => { const b = e.target.closest("button"); if (!b) return; UI.show = b.dataset.v; saveUI(); renderGrid(); };
  $("tile-size").oninput = () => { UI.ts = +$("tile-size").value; saveUI(); document.querySelectorAll(".grid").forEach(g => g.style.setProperty("--ts", UI.ts + "px")); };
  $("grid").onclick = e => {
    const g = e.target.closest(".grp button"); if (g) { UI.obj = g.dataset.o; saveUI(); renderObjs(); renderGrid(); scrollTo({ top: 0 }); return; }
    const d = e.target.closest("button[data-d]"); if (d) { setDec(d.closest(".tile").dataset.k, d.dataset.d); return; }
    const p = e.target.closest(".pics"); if (p) openEditor(p.dataset.k, VISIBLE.map(f => f.k));
  };

  // редактор
  $("ed-close").onclick = closeEditor;
  $("ed").onclick = e => { if (e.target === $("ed")) closeEditor(); };
  $("ed-prev").onclick = () => { if (ED.i > 0) { ED.i--; loadEditor(); } };
  $("ed-next").onclick = () => { if (ED.i < ED.list.length - 1) { ED.i++; loadEditor(); } };
  $("ed-dec").onclick = e => { const b = e.target.closest("button"); if (!b) return; setDec(ED.f.k, b.dataset.v); syncDecButtons(); };
  $("ed-com").onchange = () => {
    const k = ED.f.k, c = $("ed-com").value.trim(), cur = { ...(DEC[k] || {}), t: Date.now() };
    if (c) cur.c = c; else delete cur.c;
    if (!cur.d && !cur.c && !cur.p) delete DEC[k]; else DEC[k] = cur;
    saveDec(); refreshTile(k);
  };
  $("ed-show").onclick = e => { const b = e.target.closest("button"); if (!b) return; ED.show = b.dataset.v; syncControls(); draw(); };
  $("ed-fmt").onclick = e => {
    const b = e.target.closest("button"); if (!b || !ED.r?.photo) return;
    const [cx, cy] = center(); setBox(cx, cy, sizeOf(), b.dataset.v); syncControls(); update(0);
  };
  $("ed-size").oninput = () => { if (!ED.r?.photo) return; const [cx, cy] = center(); setBox(cx, cy, $("ed-size").value / 100); $("ed-size-v").textContent = $("ed-size").value + " %"; drawPhoto(); update(120); };
  const num = (id, key, fmt) => { $(id).oninput = () => { ED.p[key] = +$(id).value; $(id + "-v").textContent = fmt(ED.p[key]); update(90); }; };
  num("ed-sigma", "sigma", v => v.toFixed(1)); num("ed-con", "con", v => v.toFixed(2)); num("ed-gam", "gam", v => v.toFixed(2)); num("ed-speck", "speck", v => v);
  $("ed-thr").onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    const m = b.dataset.v;
    ED.p.thr = { m, v: m === "white" ? (ED.r ? +ED.r.white.toFixed(2) : 0.5) : m === "manual" ? (ED.r ? ED.r.threshold : 128) : 0.5 };
    syncControls(); update(0);
  };
  $("ed-thrv").oninput = () => { ED.p.thr.v = +$("ed-thrv").value; $("ed-thrv-v").textContent = ED.p.thr.m === "white" ? pct(ED.p.thr.v) : ED.p.thr.v; update(90); };
  $("ed-rotl").onclick = () => { ED.p.rot = (ED.p.rot + 270) % 360; update(0); };
  $("ed-rotr").onclick = () => { ED.p.rot = (ED.p.rot + 90) % 360; update(0); };
  $("ed-flip").onclick = () => { ED.p.flip = !ED.p.flip; syncControls(); update(0); };
  $("ed-inv").onclick = () => { ED.p.inv = !ED.p.inv; syncControls(); update(0); };
  $("ed-reset").onclick = () => { ED.p = defParams(ED.f); syncControls(); update(0); };
  $("ed-png-m").onclick = () => savePNG("m");
  $("ed-png-g").onclick = () => savePNG("g");
  const ph = $("ed-photo"); let drag = null;
  ph.addEventListener("pointerdown", e => { if (!ED.r?.photo) return; ph.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, c: center() }; });
  ph.addEventListener("pointermove", e => {
    if (!drag) return;
    const s = ph.getBoundingClientRect().width / ED.r.src.W;
    setBox(drag.c[0] + (e.clientX - drag.x) / s, drag.c[1] + (e.clientY - drag.y) / s, sizeOf()); drawPhoto(); update(140);
  });
  ph.addEventListener("pointerup", () => { if (drag) { drag = null; update(0); } });
  ph.addEventListener("wheel", e => {
    if (!ED.r?.photo) return; e.preventDefault();
    const [cx, cy] = center(); setBox(cx, cy, sizeOf() * (e.deltaY > 0 ? 1.04 : 0.96)); drawPhoto(); update(140);
  }, { passive: false });
  ph.addEventListener("keydown", e => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d || !ED.r?.photo) return;
    e.preventDefault(); e.stopPropagation();
    const [cx, cy] = center(), st = (ED.p.b[2] - ED.p.b[0]) * 0.03; setBox(cx + d[0] * st, cy + d[1] * st, sizeOf()); drawPhoto(); update(140);
  });
  addEventListener("keydown", e => {
    if (!$("xl").hidden && e.key === "Escape") { $("xl").hidden = true; return; }
    if ($("ed").hidden) return;
    const tag = document.activeElement?.tagName;
    if (e.key === "Escape") { closeEditor(); return; }
    if (tag === "TEXTAREA" || (tag === "INPUT" && document.activeElement.type !== "range")) return;
    if (["1", "2", "3"].includes(e.key)) { setDec(ED.f.k, ["да", "?", "нет"][+e.key - 1]); syncDecButtons(); }
    if (tag === "INPUT") return;
    if (e.key === "ArrowLeft") $("ed-prev").click();
    if (e.key === "ArrowRight") $("ed-next").click();
  });
  addEventListener("resize", () => { if (!$("ed").hidden) drawPhoto(); });

  // поиск
  $("s-form").onsubmit = e => { e.preventDefault(); doSearch(false); };
  $("s-more").onclick = () => doSearch(true);
  $("s-obj").onchange = () => { const o = OBJ.get($("s-obj").value); if (o) $("s-q").value = o.en; };
  $("s-grid").onclick = e => {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const k = b.closest(".tile").dataset.k, x = SR.items.find(i => i.k === k); if (!x) return;
    const oid = $("s-obj").value;
    const f = FRK.get(k) || addFound(foundFrom(x, oid));
    b.closest(".tile").querySelector('[data-act="add"]').disabled = true;
    b.closest(".tile").querySelector('[data-act="add"]').textContent = "Добавлен";
    if (b.dataset.act === "open") openEditor(f.k, [f.k]);
    else toast(`Кадр добавлен к объекту «${OBJ.get(f.o).name}»`);
  };

  // файлы
  $("b-local").onclick = () => $("f-local").click();
  $("f-local").onchange = e => {
    let n = 0;
    for (const file of e.target.files) {
      if (!/\.(jpe?g|png)$/i.test(file.name)) continue;
      const stem = file.name.replace(/\.[^.]+$/, "").toLowerCase();
      if (!LOCAL.has(stem)) { LOCAL.set(stem, URL.createObjectURL(file)); n++; }
    }
    const hit = FR.filter(f => f.loc && (localFor(f, "g") || localFor(f, "m"))).length;
    toast(`Открыто файлов: ${n}. Совпало с кадрами Pexels и Van de Cruys: ${hit}.`);
    e.target.value = ""; route();
  };
  $("b-import").onclick = () => $("f-import").click();
  $("f-import").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) importFile(f); };
  $("b-excel").onclick = () => {
    const counts = ["yes", "yesq", "mine", "eff"].map(w => exportList(w).length);
    document.querySelectorAll('input[name="xl-what"]').forEach((r, i) => { r.nextSibling.textContent = r.nextSibling.textContent.replace(/ \(\d+\)$/, "") + ` (${counts[i]})`; });
    $("xl-note").textContent = "Миниатюры строятся с вашими настройками для каждого кадра. Параметры обработки записываются в таблицу, по ним стимул можно воспроизвести.";
    $("xl").hidden = false;
  };
  $("xl-cancel").onclick = () => { $("xl").hidden = true; };
  $("xl-json").onclick = exportJSON;
  $("xl-form").onsubmit = async e => {
    e.preventDefault();
    const what = document.querySelector('input[name="xl-what"]:checked').value, btn = $("xl-go");
    btn.disabled = true;
    try { await exportExcel(what, $("xl-img").checked); $("xl").hidden = true; }
    catch (err) { toast("Выгрузка не удалась: " + err.message, 6000); }
    finally { btn.disabled = false; btn.textContent = "Выгрузить"; }
  };
}

init();
