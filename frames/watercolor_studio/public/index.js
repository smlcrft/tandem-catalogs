// ----------------------------------------------------------------------------------------
// Watercolor Studio UI.
//
// A painting is an ordered list of *vector* strokes. Each stroke carries a brush, a mixed
// pigment color, a dilution amount, a list of normalized [x,y,width] points, and an integer
// seed. Rendering replays every stroke through a SEEDED watercolor engine, so the painting
// is byte-identical on every peer while the wire payload stays tiny.
//
// The watercolor look comes from three things working together:
//   1. Organic blobs — each "stamp" along a stroke is a polygon deformed by recursive
//      midpoint displacement (Tyler-Hobbs style), so edges are ragged and natural.
//   2. Subtractive glazing — stamps are composited with `multiply`, so overlapping washes
//      darken and layer the way real translucent pigment does.
//   3. Paper + grain — a procedural fibre texture under the paint, and a faint multiply
//      grain over it, so pigment looks settled into the tooth of the paper.
//
// Color is chosen from a tray of real watercolor pans, mixed SUBTRACTIVELY in a mixing well
// (weighted geometric mean of reflectance — blue + yellow → green, complements → mud).
//
// Read-only viewers (anon FAT + Viewer-role members) replay the painting and receive live
// updates, but no /api/* mutation fires.
// ----------------------------------------------------------------------------------------
import { frame, applyChannel } from "/lib/js/framelib.js";

(() => {
  const app = document.getElementById("app");
  const peer = window.__peer || {};
  const isOwner = !!peer.is_owner;
  const canEdit = !!peer.is_sfi_editor;
  const myUserId = peer.user_id || "";
  const mySfi = peer.sfi_id || "";

  // --------------------------------------------------------------------------------------
  // Pigments — a limited, traditional watercolor palette (named pans, not RGB dots).
  // Hexes lean a touch light so the `multiply` glaze reads as the pigment, not as ink.
  // --------------------------------------------------------------------------------------
  const PIGMENTS = [
    { id: "lemon",    name: "Lemon Yellow",       hex: "#f2dd4e" },
    { id: "cadyellow",name: "Cadmium Yellow",     hex: "#f4b223" },
    { id: "ochre",    name: "Yellow Ochre",       hex: "#c98f30" },
    { id: "sienna",   name: "Burnt Sienna",       hex: "#a24e2a" },
    { id: "cadred",   name: "Cadmium Red",        hex: "#df3b2f" },
    { id: "alizarin", name: "Alizarin Crimson",   hex: "#9d2c3c" },
    { id: "rose",     name: "Quinacridone Rose",  hex: "#c24a7e" },
    { id: "violet",   name: "Dioxazine Violet",   hex: "#5a3c8c" },
    { id: "ultra",    name: "Ultramarine Blue",   hex: "#2f4b9b" },
    { id: "cerulean", name: "Cerulean Blue",      hex: "#2f8fc2" },
    { id: "phthalo",  name: "Phthalo Green",      hex: "#1d7a6c" },
    { id: "sap",      name: "Sap Green",          hex: "#5d7d33" },
    { id: "payne",    name: "Payne's Gray",       hex: "#3a4654" },
    { id: "sepia",    name: "Sepia",              hex: "#5a4636" },
    // Neutrals — mainly for mixing (white tints a mix paler, black deepens/shades it).
    // Watercolor white is transparent, so a pure-white wash stays very faint on the paper.
    { id: "white",    name: "Chinese White",      hex: "#f4f4f1" },
    { id: "black",    name: "Ivory Black",        hex: "#262524" },
  ];
  const PIGMENT_BY_ID = Object.fromEntries(PIGMENTS.map((p) => [p.id, p]));

  // --------------------------------------------------------------------------------------
  // Brushes — each maps a feel to render parameters.
  //   radiusFrac  base radius as a fraction of the sheet's short side
  //   spacing     stamp spacing as a fraction of radius (smaller = denser, wetter)
  //   layers      translucent deformed polygons stacked per stamp (more = softer build-up)
  //   alpha       per-layer opacity (before dilution)
  //   ragged      edge displacement variance (higher = more feathered)
  //   rim         edge-darkening strength (pigment pooling at the boundary)
  //   sides/depth base polygon resolution + midpoint-displacement passes
  //   flat        ellipse flatness (1 = round); flat brushes lay a chiselled band
  // --------------------------------------------------------------------------------------
  // depth = midpoint-displacement passes. LOW depth → coarse organic lobes (watercolor
  // blooms). High depth → fine woolly fuzz (felt), so we keep it modest. ragged controls
  // lobe amplitude; rim is the crisp darker boundary where pigment pools as the wash dries.
  // layers/depth are the two exponential cost knobs: `depth` doubles a stamp polygon's
  // vertex count per pass, `layers` multiplies the number of fills per stamp. They are kept
  // deliberately modest — every peer runs this same code, so replay stays consistent.
  const BRUSHES = {
    wash:   { radiusFrac: 0.085, spacing: 0.22, layers: 4, alpha: 0.066, ragged: 0.30, rim: 0.14, sides: 13, depth: 2, flat: 1.0 },
    round:  { radiusFrac: 0.038, spacing: 0.22, layers: 3, alpha: 0.090, ragged: 0.26, rim: 0.18, sides: 12, depth: 2, flat: 1.0 },
    flat:   { radiusFrac: 0.052, spacing: 0.20, layers: 3, alpha: 0.090, ragged: 0.18, rim: 0.16, sides: 11, depth: 2, flat: 0.34 },
    dry:    { radiusFrac: 0.044, spacing: 0.52, layers: 3, alpha: 0.086, ragged: 0.60, rim: 0.06, sides: 11, depth: 3, flat: 0.85 },
    detail: { radiusFrac: 0.0065, spacing: 0.22, layers: 3, alpha: 0.150, ragged: 0.16, rim: 0.22, sides: 10, depth: 2, flat: 1.0 },
    lift:   { radiusFrac: 0.050, spacing: 0.40, layers: 1, alpha: 0,     ragged: 0.34, rim: 0,    sides: 10, depth: 3, flat: 1.0 },
  };
  const BRUSH_LIST = ["wash", "round", "flat", "dry", "detail", "lift"];
  const BRUSH_ICON = {
    wash: "ph-paint-brush-broad", round: "ph-paint-brush", flat: "ph-paint-brush-household",
    dry: "ph-broom", detail: "ph-pen-nib", lift: "ph-eraser",
  };
  const BRUSH_LABEL = {
    wash: "Wash", round: "Round", flat: "Flat", dry: "Dry brush", detail: "Detail", lift: "Lift (clean water)",
  };

  // Brush size multiplier (folded into per-point width at paint time).
  const SIZE_MUL = { s: 0.465, m: 1.0, l: 1.65 };
  // Water / dilution levels — wetter = paler & more bleed.
  const WATER_LEVELS = { loaded: 0.18, medium: 0.52, watery: 0.86 };

  // --------------------------------------------------------------------------------------
  // Paper definitions — base tint + procedural fibre tooth (feTurbulence data-URI).
  // --------------------------------------------------------------------------------------
  const PAPERS = {
    coldpress: { label: "Cold-press", bg: "#fbfaf6", freq: 0.9, grain: 0.05 },
    hotpress:  { label: "Hot-press",  bg: "#fdfdfb", freq: 1.6, grain: 0.022 },
    rough:     { label: "Rough",      bg: "#f7f3ea", freq: 0.55, grain: 0.075 },
    kraft:     { label: "Kraft",      bg: "#e7dabf", freq: 0.8, grain: 0.06 },
    dusk:      { label: "Dusk",       bg: "#d7dee6", freq: 0.9, grain: 0.055 },
  };
  const PAPER_LIST = ["coldpress", "hotpress", "rough", "kraft", "dusk"];

  const ASPECTS = { landscape: 3 / 2, portrait: 2 / 3, square: 1 };
  const ASPECT_LIST = ["landscape", "portrait", "square"];

  // --------------------------------------------------------------------------------------
  // Guide outlines — original CC0 line-art, drawn faintly under the paint so new painters
  // can trace. Authored in a 0..1000 square; preserveAspectRatio keeps them undistorted.
  // --------------------------------------------------------------------------------------
  const GUIDES = {
    none: [],
    pear: [
      "M500,320 C566,320 600,386 600,452 C600,566 560,712 500,712 C440,712 400,566 400,452 C400,386 434,320 500,320 Z",
      "M500,322 C498,288 506,262 540,244",
    ],
    teacup: [
      "M372,452 L688,452 C688,592 600,664 530,664 C460,664 372,592 372,452 Z",
      "M688,486 C758,486 760,580 696,590",
      "M322,696 C322,734 740,734 740,696",
      "M455,452 C455,510 480,556 530,556 C580,556 605,510 605,452",
    ],
    leaf: [
      "M500,300 C622,388 622,572 500,704 C378,572 378,388 500,300 Z",
      "M500,330 L500,672",
      "M500,402 L566,366 M500,470 L584,432 M500,540 L566,512",
      "M500,402 L434,366 M500,470 L416,432 M500,540 L434,512",
      "M500,704 L500,760",
    ],
    mountain: [
      "M250,602 L770,602",
      "M262,560 L406,372 L508,486 L632,316 L760,560",
      "M644,272 m-44,0 a44,44 0 1,0 88,0 a44,44 0 1,0 -88,0",
      "M320,640 L700,640 M360,672 L660,672",
    ],
    koi: [
      "M338,506 C402,428 584,428 662,500 C584,576 402,576 338,506 Z",
      "M662,500 C714,470 736,442 768,452 M662,506 C714,540 736,566 768,556",
      "M404,486 m-12,0 a12,12 0 1,0 24,0 a12,12 0 1,0 -24,0",
      "M470,452 C500,500 540,500 566,456 M470,560 C500,512 540,512 566,556",
    ],
    tulip: [
      "M430,366 C426,300 482,282 500,338 C518,282 574,300 570,366 C570,430 500,470 500,470 C500,470 430,430 430,366 Z",
      "M470,356 L496,452 M530,356 L504,452",
      "M500,470 L500,724",
      "M500,604 C440,566 416,640 500,664 M500,560 C560,524 588,596 500,624",
    ],
  };

  // --------------------------------------------------------------------------------------
  // State
  // --------------------------------------------------------------------------------------
  let prefs = { title: "Watercolor Studio", paper: "coldpress", guide: "none", aspect: "landscape" };

  // strokes indexed by id, rendered in `order`
  const strokes = new Map();
  let order = [];

  let brush = canEdit ? "round" : "round";
  let size = "m";
  let water = "medium";

  // Palette: the mixing well holds parts of pigments. activeHex is the resolved paint.
  let mix = [];                 // [{ id, parts }]
  let activeHex = null;

  let tmpCounter = 0;
  const myStack = [];           // own stroke ids (for undo)

  // --------------------------------------------------------------------------------------
  // DOM scaffolding
  // --------------------------------------------------------------------------------------
  app.className = "ws-root";
  app.innerHTML = `
    <div class="ws-accent"></div>
    <div class="ws-stage" id="ws-stage">
      <div class="ws-sheet" id="ws-sheet">
        <svg class="ws-guide" id="ws-guide" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid meet"></svg>
        <canvas class="ws-paint" id="ws-paint"></canvas>
        <canvas class="ws-live" id="ws-live"></canvas>
        <div class="ws-grain" id="ws-grain"></div>
      </div>

      <div class="ws-utility" id="ws-utility">
        <input class="ws-title-input" id="ws-title-input" type="text" maxlength="80" placeholder="Watercolor Studio" ${canEdit ? "" : "disabled"} />
        <span class="ws-meta" id="ws-meta"></span>
        <button class="ws-util-btn" id="ws-settings-btn" title="Settings" hidden><i class="ph-light ph-dots-three"></i></button>
      </div>
      <div class="ws-settings-pop" id="ws-settings-pop"></div>
    </div>

    <div class="ws-dock" id="ws-dock">
      <div class="ws-tools" id="ws-tools"></div>
      <div class="ws-palette" id="ws-palette"></div>
      ${!canEdit ? `<div class="ws-readonly-tag"><i class="ph-light ph-eye"></i> view only</div>` : ""}
    </div>
  `;

  const stage = document.getElementById("ws-stage");
  const sheet = document.getElementById("ws-sheet");
  const guideSvg = document.getElementById("ws-guide");
  const paint = document.getElementById("ws-paint");
  const live = document.getElementById("ws-live");
  const grain = document.getElementById("ws-grain");
  const titleInput = document.getElementById("ws-title-input");
  const metaEl = document.getElementById("ws-meta");
  const settingsBtn = document.getElementById("ws-settings-btn");
  const settingsPop = document.getElementById("ws-settings-pop");
  const toolsEl = document.getElementById("ws-tools");
  const paletteEl = document.getElementById("ws-palette");

  const paintCtx = paint.getContext("2d");
  const liveCtx = live.getContext("2d");

  if (isOwner) settingsBtn.hidden = false;

  function applySpaceColor() {
    applyChannel(document.querySelector(".ws-root"), peer.space_color);
  }

  // --------------------------------------------------------------------------------------
  // Seeded PRNG (mulberry32) — the heart of deterministic replay.
  // --------------------------------------------------------------------------------------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // --------------------------------------------------------------------------------------
  // Subtractive color mixing (weighted geometric mean of reflectance).
  // Blue + yellow → green; complements → mud — the way real pigment behaves.
  // --------------------------------------------------------------------------------------
  const MIX_EPS = 0.018;
  function hexToRgb01(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function hexToRgb255(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgb01ToHex(r, g, b) {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
    return `#${c(r)}${c(g)}${c(b)}`;
  }
  function mixColor(parts) {
    if (!parts.length) return null;
    let tot = 0;
    const acc = [0, 0, 0];
    for (const p of parts) {
      const pig = PIGMENT_BY_ID[p.id];
      if (!pig) continue;
      const rgb = hexToRgb01(pig.hex);
      const w = p.parts;
      for (let c = 0; c < 3; c++) acc[c] += w * Math.log(Math.max(rgb[c], MIX_EPS));
      tot += w;
    }
    if (tot <= 0) return null;
    return rgb01ToHex(Math.exp(acc[0] / tot), Math.exp(acc[1] / tot), Math.exp(acc[2] / tot));
  }
  function recomputeActive() {
    activeHex = mixColor(mix);
  }

  // --------------------------------------------------------------------------------------
  // Paper texture (procedural fibre tooth + over-paint grain)
  // --------------------------------------------------------------------------------------
  function grainDataUri(freq, alpha) {
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140' viewBox='0 0 140 140'>` +
      `<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='${freq}' numOctaves='2' stitchTiles='stitch'/>` +
      `<feColorMatrix type='saturate' values='0'/></filter>` +
      `<rect width='140' height='140' filter='url(#n)' opacity='${alpha}'/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }
  function applyPaper() {
    const p = PAPERS[prefs.paper] || PAPERS.coldpress;
    sheet.style.background = p.bg;
    sheet.style.backgroundImage = grainDataUri(p.freq, p.grain);
    // Over-paint grain (settled pigment): a touch finer, kept subtle so it reads as the
    // tooth of the paper rather than a woolly overlay.
    grain.style.backgroundImage = grainDataUri(p.freq * 1.5, Math.min(0.06, p.grain * 0.8));
  }

  // --------------------------------------------------------------------------------------
  // Guide outline rendering
  // --------------------------------------------------------------------------------------
  const SVGNS = "http://www.w3.org/2000/svg";
  function applyGuide() {
    guideSvg.innerHTML = "";
    const paths = GUIDES[prefs.guide] || [];
    for (const d of paths) {
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", d);
      p.setAttribute("class", "ws-guide-path");
      guideSvg.appendChild(p);
    }
    guideSvg.style.display = paths.length ? "block" : "none";
  }

  // --------------------------------------------------------------------------------------
  // Sheet layout — fit a paper rectangle of the chosen aspect inside the stage.
  // --------------------------------------------------------------------------------------
  // Watercolor is soft, so a high device-pixel-ratio buys almost nothing visually while
  // squaring the blended-pixel area. Cap at 1.5 — the single biggest fill-rate lever.
  const DPR = Math.min(1.5, window.devicePixelRatio || 1);
  let lastLayoutW = 0, lastLayoutH = 0;
  function layoutSheet(animated) {
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    if (sw < 2 || sh < 2) return;
    const margin = Math.max(8, Math.round(Math.min(sw, sh) * 0.05));
    const availW = sw - margin * 2;
    const availH = sh - margin * 2;
    const ar = ASPECTS[prefs.aspect] || ASPECTS.landscape;
    let w, h;
    if (availW / availH > ar) { h = availH; w = h * ar; }
    else { w = availW; h = w / ar; }
    w = Math.round(w); h = Math.round(h);
    // A resize that doesn't change the sheet's pixel size would otherwise re-rasterize the
    // entire painting for nothing — skip it. (Aspect changes DO change w/h, so they pass.)
    if (w === lastLayoutW && h === lastLayoutH && !animated) return;
    lastLayoutW = w; lastLayoutH = h;
    sheet.style.width = `${w}px`;
    sheet.style.height = `${h}px`;
    sheet.style.left = `${Math.round((sw - w) / 2)}px`;
    sheet.style.top = `${Math.round((sh - h) / 2)}px`;
    for (const cv of [paint, live]) {
      cv.width = Math.max(1, Math.round(w * DPR));
      cv.height = Math.max(1, Math.round(h * DPR));
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    }
    if (animated) replayAnimated(); else repaintAll();
  }

  // --------------------------------------------------------------------------------------
  // Watercolor engine
  // --------------------------------------------------------------------------------------

  // Deform a polygon by recursive midpoint displacement → organic, ragged watercolor edge.
  function deform(rng, cx, cy, rx, ry, ang, sides, depth, variance) {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    let pts = [];
    for (let i = 0; i < sides; i++) {
      const t = (i / sides) * Math.PI * 2;
      const jitter = 0.82 + rng() * 0.34;
      const lx = Math.cos(t) * rx * jitter;
      const ly = Math.sin(t) * ry * jitter;
      pts.push([cx + lx * ca - ly * sa, cy + lx * sa + ly * ca]);
    }
    for (let d = 0; d < depth; d++) {
      const v = variance * Math.pow(0.6, d);
      const np = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        np.push(a);
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const len = Math.hypot(dx, dy) || 1;
        const disp = (rng() * 2 - 1) * len * v;
        np.push([mx + (-dy / len) * disp, my + (dx / len) * disp]);
      }
      pts = np;
    }
    return pts;
  }
  function polyPath(pts) {
    const path = new Path2D();
    path.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
    path.closePath();
    return path;
  }

  // Walk the polyline and place evenly-spaced stamps, interpolating width + direction.
  const MAX_STAMPS_PER_STROKE = 600;
  function stampPositions(points, baseR, spacing, W, H) {
    const pts = points.map(([nx, ny, w]) => [nx * W, ny * H, w]);
    const out = [];
    const push = (x, y, w, ang) => out.push({ x, y, r: baseR * w, ang });
    if (pts.length === 1) {
      push(pts[0][0], pts[0][1], pts[0][2], 0);
      return out;
    }
    // Floor the spacing so a tiny brush (e.g. `detail`) can't emit a stamp every ~2px, and
    // cap the absolute count so one long stroke can't spawn thousands of multi-layer fills.
    // Both bound the per-stroke render cost; each stamp is the expensive unit.
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    let step = Math.max(2 * DPR, baseR * spacing);
    if (total / step > MAX_STAMPS_PER_STROKE) step = total / MAX_STAMPS_PER_STROKE;
    let carry = 0;
    push(pts[0][0], pts[0][1], pts[0][2], Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]));
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const segLen = Math.hypot(dx, dy);
      if (segLen < 1e-3) continue;
      const ang = Math.atan2(dy, dx);
      let d = carry;
      while (d < segLen) {
        const f = d / segLen;
        push(a[0] + dx * f, a[1] + dy * f, a[2] + (b[2] - a[2]) * f, ang);
        d += step;
      }
      carry = d - segLen;
    }
    return out;
  }

  // One reused offscreen buffer. A stroke is rendered here in isolation with NORMAL
  // compositing, then glazed onto the painting in a SINGLE `multiply` blit. This replaces
  // thousands of per-fill multiply blends (the heaviest cost) with one composite per stroke.
  let scratch = null, scratchCtx = null;
  function getScratch(w, h) {
    if (!scratch) {
      scratch = document.createElement("canvas");
      scratchCtx = scratch.getContext("2d");
    }
    if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
    return scratchCtx;
  }

  function renderStroke(ctx, stroke, preview) {
    const B = BRUSHES[stroke.brush] || BRUSHES.round;
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const minSide = Math.min(W, H);
    const baseR = Math.max(0.6, B.radiusFrac * minSide);
    const rng = mulberry32(stroke.seed >>> 0);
    const stamps = stampPositions(stroke.points, baseR, B.spacing, W, H);

    // Lift = clean water pulling pigment back UP. It must act on the live painting, so it
    // composites directly onto the target rather than through the isolated buffer.
    if (stroke.brush === "lift") {
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      const liftStrength = 0.30 + 0.45 * (stroke.water ?? 0.5);
      for (const st of stamps) {
        const g = ctx.createRadialGradient(st.x, st.y, 0, st.x, st.y, st.r);
        g.addColorStop(0, `rgba(0,0,0,${liftStrength})`);
        g.addColorStop(0.7, `rgba(0,0,0,${liftStrength * 0.5})`);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      return;
    }

    // Render the stroke body into the isolated buffer with normal (source-over) compositing.
    const sctx = getScratch(W, H);
    sctx.clearRect(0, 0, W, H);
    sctx.save();
    sctx.lineJoin = "round";
    const [pr, pg, pb] = hexToRgb255(stroke.pigment || "#333333");
    const dilute = stroke.water ?? 0.5;
    const alphaMul = 1.25 - 0.85 * dilute;        // wetter → paler
    const raggedMul = 1 + 0.55 * dilute;          // wetter → blooms more
    const layers = preview ? Math.max(2, Math.round(B.layers * 0.6)) : B.layers;
    const a = B.alpha * alphaMul;
    const fillStyle = `rgba(${pr},${pg},${pb},${a.toFixed(4)})`;

    for (const st of stamps) {
      // Dry brush skips stamps for broken, tooth-revealing coverage.
      if (stroke.brush === "dry" && rng() < 0.42) {
        // still consume rng to keep replay deterministic regardless of skip
        rng(); rng();
        continue;
      }
      const flatY = st.r * B.flat;
      const ang = stroke.brush === "flat" ? st.ang + Math.PI / 2 : st.ang;
      sctx.fillStyle = fillStyle;
      // Keep the layers in a tight band near full radius so the body reads as solid pigment
      // ending in a defined edge — not a fading fibrous halo (which looks like felt).
      let outer = null;
      for (let l = 0; l < layers; l++) {
        const grow = 0.90 + (l / Math.max(1, layers)) * 0.14 + rng() * 0.05;
        const poly = deform(rng, st.x, st.y, st.r * grow, flatY * grow, ang,
          B.sides, B.depth, B.ragged * raggedMul);
        sctx.fill(polyPath(poly));
        outer = poly;
      }
      // Edge-darkening rim — pigment migrates to the drying boundary and pools there, the
      // single most "watercolor" cue. Trace the outermost layer with a denser pass.
      if (B.rim > 0 && outer) {
        const rimAlpha = Math.min(0.45, a * (1.2 + 4 * B.rim) * (1 - 0.4 * dilute));
        sctx.strokeStyle = `rgba(${pr},${pg},${pb},${rimAlpha.toFixed(4)})`;
        sctx.lineWidth = Math.max(0.75, st.r * 0.05);
        sctx.stroke(polyPath(outer));
      }
    }
    sctx.restore();

    // Glaze the finished stroke onto the painting in one multiply composite.
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }

  // Bumped on every full repaint so an in-flight animated replay cancels itself.
  let replayGen = 0;

  // True while a chunked repaint is spread across frames — addStroke defers to it so a stroke
  // arriving mid-repaint isn't drawn twice (the in-flight loop will reach it).
  let repaintInFlight = false;

  function repaintAll() {
    const gen = ++replayGen;
    clearUndoCache();   // the canvas is being rebuilt from scratch; snapshots no longer align
    repaintInFlight = true;
    paintCtx.clearRect(0, 0, paint.width, paint.height);
    renderMeta();
    let i = 0;
    const step = () => {
      if (gen !== replayGen) return;          // a newer repaint/replay took over
      const start = performance.now();
      while (i < order.length) {
        const s = strokes.get(order[i++]);
        if (s) renderStroke(paintCtx, s, false);
        if (performance.now() - start > 8) break;   // keep each chunk within one frame
      }
      if (i < order.length) { requestAnimationFrame(step); return; }
      repaintInFlight = false;
    };
    step();
  }

  // Replay strokes one at a time with a short pause, so opening a painting feels like
  // watching it be painted. Any repaintAll() (resize, delete, clear) cancels it.
  function replayAnimated() {
    const gen = ++replayGen;
    clearUndoCache();
    repaintInFlight = true;
    paintCtx.clearRect(0, 0, paint.width, paint.height);
    renderMeta();
    if (!order.length) { repaintInFlight = false; return; }
    let i = 0;
    const tick = () => {
      if (gen !== replayGen) return;        // a newer repaint took over
      const s = strokes.get(order[i++]);
      if (s) renderStroke(paintCtx, s, false);
      if (i < order.length) { setTimeout(tick, 50); return; }
      repaintInFlight = false;
    };
    tick();
  }

  // --------------------------------------------------------------------------------------
  // Undo snapshots — keep up to 2 canvas states so a quick succession of undos can pop the
  // top strokes back off without re-rendering the whole painting. A snapshot is the paint
  // canvas as it stood *just before* a stroke was glazed on; it is only valid while that
  // stroke is still the tail of `order`, so any full repaint/clear/resize discards the stack.
  // --------------------------------------------------------------------------------------
  const UNDO_CACHE_MAX = 3;   // how many recent strokes can be undone without a full repaint
  let undoCache = [];   // [{ bitmap: <canvas>, strokeId }] — oldest first, newest last
  function clearUndoCache() { undoCache = []; }
  function pushUndoSnapshot(strokeId) {
    const snap = document.createElement("canvas");
    snap.width = paint.width; snap.height = paint.height;
    snap.getContext("2d").drawImage(paint, 0, 0);
    undoCache.push({ bitmap: snap, strokeId });
    while (undoCache.length > UNDO_CACHE_MAX) undoCache.shift();
  }

  function addStroke(stroke) {
    if (strokes.has(stroke.id)) return;
    // While a chunked repaint/replay is rebuilding the canvas, just append — that loop will
    // draw this stroke. Painting it here too would double-glaze it and spoil the snapshot.
    if (repaintInFlight) {
      strokes.set(stroke.id, stroke);
      order.push(stroke.id);
      renderMeta();
      return;
    }
    pushUndoSnapshot(stroke.id);   // capture BEFORE the stroke is glazed on
    strokes.set(stroke.id, stroke);
    order.push(stroke.id);
    renderStroke(paintCtx, stroke, false);
    renderMeta();
  }
  function removeStroke(id) {
    if (!strokes.has(id)) return;
    strokes.delete(id);
    order = order.filter((x) => x !== id);
    repaintAll();
  }
  function strokeBySeed(seed) {
    for (const s of strokes.values()) if (s.seed === seed) return s;
    return null;
  }
  function reconcileId(oldId, newId) {
    if (oldId === newId || !strokes.has(oldId)) return;
    const s = strokes.get(oldId);
    strokes.delete(oldId);
    s.id = newId;
    strokes.set(newId, s);
    const oi = order.indexOf(oldId);
    if (oi >= 0) order[oi] = newId;
    const si = myStack.indexOf(oldId);
    if (si >= 0) myStack[si] = newId;
    for (const c of undoCache) if (c.strokeId === oldId) c.strokeId = newId;
  }

  // --------------------------------------------------------------------------------------
  // API helper
  // --------------------------------------------------------------------------------------
  async function api(method, path, body) {
    const json = await frame.api("." + path, body === undefined ? undefined : body, method);
    return json || {};
  }

  async function commitStroke(payload) {
    const tempId = `tmp_${++tmpCounter}`;
    const local = {
      ...payload,
      id: tempId,
      created_by_user_id: myUserId,
      created_by_user_name: peer.user_name || "anon",
      created_at: Date.now(),
    };
    addStroke(local);            // optimistic — render immediately, no flicker
    myStack.push(tempId);
    try {
      const res = await api("POST", "/api/stroke/add", payload);
      if (res.stroke && res.stroke.id) reconcileId(tempId, res.stroke.id);
    } catch (e) {
      removeStroke(tempId);
      const si = myStack.indexOf(tempId);
      if (si >= 0) myStack.splice(si, 1);
      toast(e.status === 409 ? "sheet is full" : "save failed");
    }
  }

  async function undo() {
    let id = null;
    while (myStack.length && !id) {
      const candidate = myStack.pop();
      if (strokes.has(candidate)) id = candidate;
    }
    if (!id) return;
    if (id.startsWith("tmp_")) { toast("still saving…"); myStack.push(id); return; }
    // Fast path: if this stroke is still the top of the stack and we cached the canvas from
    // just before it was painted, restore that snapshot instead of repainting everything.
    const top = undoCache[undoCache.length - 1];
    if (order.length && order[order.length - 1] === id && top && top.strokeId === id) {
      undoCache.pop();
      strokes.delete(id);
      order.pop();
      paintCtx.clearRect(0, 0, paint.width, paint.height);
      paintCtx.drawImage(top.bitmap, 0, 0);
      renderMeta();
    } else {
      removeStroke(id);   // buried under later strokes — full (chunked) repaint
    }
    try { await api("POST", "/api/stroke/delete", { ids: [id] }); }
    catch (e) { toast("undo failed"); }
  }

  // --------------------------------------------------------------------------------------
  // Toast
  // --------------------------------------------------------------------------------------
  let toastEl = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "ws-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove("show"), 1800);
  }

  function renderMeta() {
    titleInput.value = prefs.title;
    metaEl.textContent = canEdit
      ? `${order.length} stroke${order.length === 1 ? "" : "s"}`
      : "view only";
  }

  // --------------------------------------------------------------------------------------
  // Pointer painting
  // --------------------------------------------------------------------------------------
  let painting = null;   // { raw: [{x,y,t}], seed, brush, pigment, water }
  let pointerId = null;
  let rafPending = false;

  function clientToNorm(clientX, clientY) {
    const r = sheet.getBoundingClientRect();
    return [(clientX - r.left) / r.width, (clientY - r.top) / r.height];
  }

  function computeWidths(raw) {
    const mul = SIZE_MUL[size] || 1;
    const out = [];
    let smoothed = 0;
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i];
      let speed = 0;
      if (i > 0) {
        const q = raw[i - 1];
        const dt = Math.max(1, p.t - q.t);
        speed = Math.hypot(p.x - q.x, p.y - q.y) / dt;   // normalized units / ms
      }
      smoothed = i === 0 ? speed : smoothed * 0.6 + speed * 0.4;
      const fast = Math.max(0, Math.min(1, smoothed / 0.0016));
      const factor = 1.32 - 0.66 * fast;                  // slow → thick, fast → thin
      out.push([+p.x.toFixed(4), +p.y.toFixed(4), +(factor * mul).toFixed(3)]);
    }
    return out;
  }

  function scheduleLiveRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!painting) return;
      liveCtx.clearRect(0, 0, live.width, live.height);
      const pts = computeWidths(painting.raw);
      if (pts.length) {
        renderStroke(liveCtx, {
          brush: painting.brush, pigment: painting.pigment, water: painting.water,
          points: pts, seed: painting.seed,
        }, true);
      }
    });
  }

  live.addEventListener("pointerdown", (e) => {
    if (!canEdit || pointerId !== null) return;
    if (brush !== "lift" && !activeHex) { toast("pick a color first"); return; }
    pointerId = e.pointerId;
    live.setPointerCapture(e.pointerId);
    const [x, y] = clientToNorm(e.clientX, e.clientY);
    painting = {
      raw: [{ x, y, t: performance.now() }],
      seed: (Math.random() * 0x7fffffff) | 0,
      brush,
      pigment: activeHex || "#333333",
      water: WATER_LEVELS[water] ?? 0.5,
    };
    scheduleLiveRender();
  });

  live.addEventListener("pointermove", (e) => {
    if (pointerId !== e.pointerId || !painting) return;
    const [x, y] = clientToNorm(e.clientX, e.clientY);
    const last = painting.raw[painting.raw.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < 0.0015) return;
    if (painting.raw.length >= 2000) return;
    painting.raw.push({ x, y, t: performance.now() });
    scheduleLiveRender();
  });

  function endPaint(e) {
    if (pointerId !== e.pointerId || !painting) return;
    try { live.releasePointerCapture(pointerId); } catch {}
    pointerId = null;
    const job = painting;
    painting = null;
    liveCtx.clearRect(0, 0, live.width, live.height);
    const pts = computeWidths(job.raw);
    if (!pts.length) return;
    const payload = {
      brush: job.brush, water: job.water, points: pts, seed: job.seed,
    };
    if (job.brush !== "lift") payload.pigment = job.pigment;
    commitStroke(payload);
  }
  live.addEventListener("pointerup", endPaint);
  live.addEventListener("pointercancel", endPaint);

  // --------------------------------------------------------------------------------------
  // Tools dock (brushes + size + undo) — bottom-left
  // --------------------------------------------------------------------------------------
  function renderTools() {
    toolsEl.innerHTML = "";
    if (!canEdit) { toolsEl.style.display = "none"; return; }

    for (const b of BRUSH_LIST) {
      const btn = document.createElement("button");
      btn.className = "ws-tool-btn";
      btn.title = BRUSH_LABEL[b];
      btn.dataset.brush = b;
      btn.setAttribute("aria-pressed", b === brush ? "true" : "false");
      btn.innerHTML = `<i class="ph-light ${BRUSH_ICON[b]}"></i>`;
      btn.addEventListener("click", () => setBrush(b));
      toolsEl.appendChild(btn);
    }

    const sep = document.createElement("div");
    sep.className = "ws-tool-sep";
    toolsEl.appendChild(sep);

    // Size — three graduated dots
    const sizeWrap = document.createElement("div");
    sizeWrap.className = "ws-size";
    for (const s of ["s", "m", "l"]) {
      const b = document.createElement("button");
      b.className = "ws-size-btn";
      b.dataset.size = s;
      b.title = `Size ${s.toUpperCase()}`;
      b.setAttribute("aria-pressed", s === size ? "true" : "false");
      const dot = document.createElement("span");
      const px = s === "s" ? 5 : s === "m" ? 9 : 14;
      dot.style.width = `${px}px`; dot.style.height = `${px}px`;
      b.appendChild(dot);
      b.addEventListener("click", () => { size = s; renderTools(); });
      sizeWrap.appendChild(b);
    }
    toolsEl.appendChild(sizeWrap);

    const sep2 = document.createElement("div");
    sep2.className = "ws-tool-sep";
    toolsEl.appendChild(sep2);

    const undoBtn = document.createElement("button");
    undoBtn.className = "ws-tool-btn";
    undoBtn.title = "Undo my last stroke";
    undoBtn.innerHTML = `<i class="ph-light ph-arrow-counter-clockwise"></i>`;
    undoBtn.addEventListener("click", undo);
    toolsEl.appendChild(undoBtn);
  }

  function setBrush(b) {
    brush = b;
    for (const btn of toolsEl.querySelectorAll(".ws-tool-btn[data-brush]")) {
      btn.setAttribute("aria-pressed", btn.dataset.brush === b ? "true" : "false");
    }
    sheet.classList.toggle("lifting", b === "lift");
  }

  // --------------------------------------------------------------------------------------
  // Palette dock (pans + mixing well + water) — bottom-right
  // --------------------------------------------------------------------------------------
  function renderPalette() {
    paletteEl.innerHTML = "";
    if (!canEdit) { paletteEl.style.display = "none"; return; }

    const pans = document.createElement("div");
    pans.className = "ws-pans";
    for (const pig of PIGMENTS) {
      const b = document.createElement("button");
      b.className = "ws-pan";
      b.title = pig.name;
      b.dataset.pid = pig.id;
      b.style.setProperty("--pan", pig.hex);
      b.addEventListener("click", () => addToMix(pig.id));
      pans.appendChild(b);
    }
    paletteEl.appendChild(pans);

    const mixer = document.createElement("div");
    mixer.className = "ws-mixer";
    mixer.innerHTML = `
      <div class="ws-recipe" id="ws-recipe"></div>
      <div class="ws-well-wrap">
        <div class="ws-well" id="ws-well" title="Active paint"></div>
        <button class="ws-rinse" id="ws-rinse" title="Rinse the well"><i class="ph-light ph-drop"></i></button>
      </div>
      <div class="ws-water" id="ws-water"></div>
    `;
    paletteEl.appendChild(mixer);

    const waterEl = mixer.querySelector("#ws-water");
    const WATER_TITLE = { loaded: "Loaded (little water)", medium: "Medium", watery: "Watery (pale wash)" };
    for (const w of ["loaded", "medium", "watery"]) {
      const b = document.createElement("button");
      b.className = "ws-water-btn";
      b.dataset.water = w;
      b.title = WATER_TITLE[w];
      b.setAttribute("aria-pressed", w === water ? "true" : "false");
      const px = w === "loaded" ? 9 : w === "medium" ? 12 : 15;
      b.innerHTML = `<i class="ph-light ph-drop" style="font-size:${px}px"></i>`;
      b.addEventListener("click", () => {
        water = w;
        for (const x of waterEl.querySelectorAll(".ws-water-btn")) {
          x.setAttribute("aria-pressed", x.dataset.water === w ? "true" : "false");
        }
      });
      waterEl.appendChild(b);
    }

    mixer.querySelector("#ws-rinse").addEventListener("click", () => {
      mix = [];
      recomputeActive();
      renderWell();
    });

    renderWell();
  }

  function addToMix(id) {
    const existing = mix.find((m) => m.id === id);
    if (existing) existing.parts += 1;
    else mix.push({ id, parts: 1 });
    recomputeActive();
    renderWell();
    // flash the pan
    const pans = paletteEl.querySelectorAll(".ws-pan");
    const idx = PIGMENTS.findIndex((p) => p.id === id);
    if (pans[idx]) {
      pans[idx].classList.remove("flash");
      void pans[idx].offsetWidth;
      pans[idx].classList.add("flash");
    }
  }

  function renderWell() {
    const well = document.getElementById("ws-well");
    const recipe = document.getElementById("ws-recipe");
    if (!well || !recipe) return;
    if (activeHex) {
      well.style.background = activeHex;
      well.classList.remove("empty");
    } else {
      well.style.background = "transparent";
      well.classList.add("empty");
    }
    recipe.innerHTML = "";
    if (!mix.length) {
      const hint = document.createElement("span");
      hint.className = "ws-recipe-hint";
      hint.textContent = "tap a pan";
      recipe.appendChild(hint);
      return;
    }
    for (const m of mix) {
      const pig = PIGMENT_BY_ID[m.id];
      const chip = document.createElement("span");
      chip.className = "ws-recipe-chip";
      chip.style.setProperty("--pan", pig.hex);
      chip.title = `${pig.name} ×${m.parts}`;
      if (m.parts > 1) chip.dataset.parts = String(m.parts);
      recipe.appendChild(chip);
    }
  }

  // --------------------------------------------------------------------------------------
  // Settings (owner only) — title is in the utility bar; this is paper/guide/aspect/clear
  // --------------------------------------------------------------------------------------
  function renderSettingsPop() {
    if (!isOwner) return;
    settingsPop.innerHTML = `
      <div class="ws-set-row">
        <span class="ws-set-label">Paper</span>
        <div class="ws-seg" id="ws-set-paper"></div>
      </div>
      <div class="ws-set-row">
        <span class="ws-set-label">Sheet</span>
        <div class="ws-seg" id="ws-set-aspect"></div>
      </div>
      <div class="ws-set-row">
        <span class="ws-set-label">Guide outline</span>
        <div class="ws-seg ws-seg-wrap" id="ws-set-guide"></div>
      </div>
      <button class="ws-clear-btn" id="ws-clear-btn"><i class="ph-light ph-trash"></i> Clear sheet</button>
    `;

    const paperSeg = settingsPop.querySelector("#ws-set-paper");
    for (const p of PAPER_LIST) {
      const b = document.createElement("button");
      b.className = "ws-seg-btn";
      b.textContent = PAPERS[p].label;
      b.setAttribute("aria-pressed", p === prefs.paper ? "true" : "false");
      b.addEventListener("click", () => saveSettings({ paper: p }));
      paperSeg.appendChild(b);
    }

    const aspectSeg = settingsPop.querySelector("#ws-set-aspect");
    const ASPECT_LABEL = { landscape: "Landscape", portrait: "Portrait", square: "Square" };
    for (const aRatio of ASPECT_LIST) {
      const b = document.createElement("button");
      b.className = "ws-seg-btn";
      b.textContent = ASPECT_LABEL[aRatio];
      b.setAttribute("aria-pressed", aRatio === prefs.aspect ? "true" : "false");
      b.addEventListener("click", () => saveSettings({ aspect: aRatio }));
      aspectSeg.appendChild(b);
    }

    const guideSeg = settingsPop.querySelector("#ws-set-guide");
    const GUIDE_LABEL = { none: "None", pear: "Pear", teacup: "Teacup", leaf: "Leaf", mountain: "Mountains", koi: "Koi", tulip: "Tulip" };
    for (const g of Object.keys(GUIDES)) {
      const b = document.createElement("button");
      b.className = "ws-seg-btn";
      b.textContent = GUIDE_LABEL[g];
      b.setAttribute("aria-pressed", g === prefs.guide ? "true" : "false");
      b.addEventListener("click", () => saveSettings({ guide: g }));
      guideSeg.appendChild(b);
    }

    settingsPop.querySelector("#ws-clear-btn").addEventListener("click", async () => {
      if (!(await frame.confirm("Clear the entire sheet? This cannot be undone.", { danger: true }))) return;
      api("POST", "/api/clear", {}).catch((e) => toast("clear failed"));
      settingsPop.classList.remove("open");
    });
  }

  function saveSettings(patch) {
    const next = { title: prefs.title, paper: prefs.paper, guide: prefs.guide, aspect: prefs.aspect, ...patch };
    api("POST", "/api/settings", next).catch((e) => toast("settings failed"));
  }

  settingsBtn.addEventListener("click", () => {
    if (!isOwner) return;
    renderSettingsPop();
    settingsPop.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (settingsPop.classList.contains("open")) {
      if (e.target === settingsBtn || settingsBtn.contains(e.target)) return;
      if (settingsPop.contains(e.target)) return;
      settingsPop.classList.remove("open");
    }
  });

  // Title editing (owner)
  titleInput.addEventListener("blur", () => {
    const next = titleInput.value.trim().slice(0, 80);
    if (next && next !== prefs.title) saveSettings({ title: next });
  });
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); }
    if (e.key === "Escape") { titleInput.value = prefs.title; titleInput.blur(); }
  });

  // --------------------------------------------------------------------------------------
  // Keyboard shortcuts
  // --------------------------------------------------------------------------------------
  window.addEventListener("keydown", (e) => {
    if (document.activeElement instanceof HTMLInputElement) return;
    if (!canEdit) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); undo(); return; }
    const map = { "1": "wash", "2": "round", "3": "flat", "4": "dry", "5": "detail", e: "lift" };
    if (map[e.key]) { setBrush(map[e.key]); return; }
    if (e.key === "[") { size = size === "l" ? "m" : "s"; renderTools(); }
    if (e.key === "]") { size = size === "s" ? "m" : "l"; renderTools(); }
  });

  // --------------------------------------------------------------------------------------
  // Realtime push handlers
  // --------------------------------------------------------------------------------------
  window.addEventListener("message", (e) => {
    const d = e.data || {};
    if (d.sfi_id && mySfi && d.sfi_id !== mySfi) return;
    if (d.type === "ws_add" && d.stroke) {
      const dup = strokes.has(d.stroke.id) ? strokes.get(d.stroke.id) : strokeBySeed(d.stroke.seed);
      if (dup) {
        // our own optimistic echo — adopt the authoritative id if we still hold a temp
        if (dup.id.startsWith("tmp_")) reconcileId(dup.id, d.stroke.id);
        return;
      }
      addStroke(d.stroke);
    } else if (d.type === "ws_delete" && Array.isArray(d.ids)) {
      let changed = false;
      for (const id of d.ids) {
        if (strokes.has(id)) { strokes.delete(id); changed = true; }
      }
      if (changed) { order = order.filter((id) => strokes.has(id)); repaintAll(); }
    } else if (d.type === "ws_clear") {
      strokes.clear(); order = []; myStack.length = 0; repaintAll();
    } else if (d.type === "ws_prefs" && d.prefs) {
      const prev = prefs;
      prefs = d.prefs;
      renderMeta();
      if (prev.paper !== prefs.paper) applyPaper();
      if (prev.guide !== prefs.guide) applyGuide();
      if (prev.aspect !== prefs.aspect) layoutSheet();
      if (isOwner && settingsPop.classList.contains("open")) renderSettingsPop();
    }
  });

  // --------------------------------------------------------------------------------------
  // Boot
  // --------------------------------------------------------------------------------------
  async function load() {
    try {
      const data = await api("GET", "/api/state");
      prefs = data.prefs || prefs;
      const list = Array.isArray(data.strokes) ? data.strokes : [];
      strokes.clear(); order = [];
      for (const s of list) { strokes.set(s.id, s); order.push(s.id); }

      // Seed the well with a pleasant starting pigment so painting works immediately.
      mix = [{ id: "ultra", parts: 1 }];
      recomputeActive();

      applySpaceColor();
      applyPaper();
      applyGuide();
      renderTools();
      renderPalette();
      setBrush(brush);
      renderMeta();
      layoutSheet(true);   // size canvases, then replay the painting stroke-by-stroke
    } catch (e) {
      app.textContent = `failed to load: ${e.message}`;
    }
  }

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layoutSheet, 90);
  });

  load();
})();
