import { frame } from "/lib/js/framelib.js";

(function () {
  const peer = window.__peer || {};
  const isAnon = peer.is_anon === "1" || !peer.user_id;

  const $ = (id) => document.getElementById(id);

  // ----- Anonymous gate ----------------------------------------------------------------
  if (isAnon) {
    document.body.innerHTML =
      '<div class="note"><i class="ph-light ph-lock-simple icon-sm"></i> ' +
      'Market Weather is a private frame. Sign in to view this market.</div>';
    return;
  }

  // ----- State -------------------------------------------------------------------------
  let state = { prefs: { location: "" }, weather: null, readings: [], weights: {}, is_owner: false };
  let draft = null;
  // Index into currentPeaks() that is currently being hovered in the card row. Drives
  // a chart redraw that glows the corresponding on-chart purple segment so the
  // card↔segment pairing is unambiguous.
  let hoveredPeakIdx = null;

  // ----- Helpers -----------------------------------------------------------------------
  function escapeHTML(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Day-of-week label using the LOCATION's local clock — the iso string is naive local
  // time, so parsing it as UTC and reading getUTCDay() gives the right answer even when
  // the viewer is in a different timezone.
  const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function localDate(iso) { return new Date(iso + "Z"); }
  function dayKey(iso) { return iso.slice(0, 10); }
  function fmtHour12(h) {
    const hr = h % 12 || 12;
    return hr + (h < 12 ? "am" : "pm");
  }
  function fmtRange12(h1, h2) {
    return fmtHour12(h1) + "–" + fmtHour12(h2);
  }

  // ----- Header ------------------------------------------------------------------------
  function renderHeader() {
    const chip = $("weather-chip");
    if (state.weather && state.readings.length) {
      const first = state.readings[0];
      const now = Math.round(first.t_f);
      const name = state.weather.resolved_name;
      const next24 = state.readings.slice(0, Math.min(24, state.readings.length));
      const lo = Math.round(Math.min.apply(null, next24.map(r => r.t_f)));
      const hi = Math.round(Math.max.apply(null, next24.map(r => r.t_f)));
      const rain24 = next24.reduce((s, r) => s + r.precip_in, 0);
      const rainPart = rain24 >= 0.05
        ? ' · <i class="ph-light ph-cloud-rain icon-sm"></i> ' + rain24.toFixed(rain24 >= 1 ? 1 : 2) + '"'
        : '';
      chip.classList.remove("hidden");
      chip.innerHTML = '<i class="ph-light ph-sun icon-sm"></i> ' +
        escapeHTML(name) + ' · ' + now + '°F · 24h ' + lo + '–' + hi + '°F' + rainPart;
    } else {
      chip.classList.add("hidden");
    }
  }

  function renderSetupNote() {
    const note = $("setup-note");
    const txt  = $("setup-text");
    if (!state.prefs.location) {
      note.classList.remove("hidden");
      txt.textContent = "Set your market's location in settings to see the turnout forecast.";
    } else if (!state.weather) {
      note.classList.remove("hidden");
      txt.textContent = 'Couldn\'t find weather for "' + state.prefs.location + '". Try a different city or zip.';
    } else {
      note.classList.add("hidden");
    }
  }

  // ----- Canvas chart ------------------------------------------------------------------
  // The chart is the focal element of the frame. Time on x, turnout 0..100% on y. Behind
  // the bold composite line we paint stacked overlay bands that show WHY the line moves:
  //
  //   - day/night         → pale yellow vs. light grey, full chart height
  //   - extreme temp      → red strip at the very top when temp comfort drops below -0.5
  //   - weekend bonus     → subtle green strip at the bottom for Sat/Sun hours
  //   - rain              → BOTTOM-anchored blue bars rising up from the baseline, height
  //                          proportional to precipitation rate. Bottom-anchored so the
  //                          "more rain = taller bar" mental model matches a rain gauge.
  //   - temp comfort line → faint red, mapped onto the same 0..100 axis
  //   - seasonal line     → faint purple, same axis
  //   - day boundaries    → vertical dashed lines + Sat/Sun/Mon labels
  //   - "now" marker      → vertical line at t=0
  //
  // Tooltip-bar correspondence: the same accent colors used for the bars (blue rain,
  // red extreme temp, green weekend, yellow daylight, purple seasonal) reappear as color
  // chips next to each factor in the hover tooltip, so the viewer immediately maps a
  // bar in the chart to a row in the tooltip without having to consult the legend.

  const PAD_L = 36, PAD_R = 12, PAD_T = 14, PAD_B = 32;
  let chartGeom = null;  // { x0, x1, y0, y1, t0, t1 } — pixel + time bounds for hit-testing

  function drawChart() {
    const canvas = $("chart");
    const wrap = canvas.parentElement;
    const cssW = wrap.clientWidth - 2 * parseFloat(getComputedStyle(wrap).paddingLeft || "0");
    const cssH = parseFloat(getComputedStyle(canvas).height) || 320;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.max(320, Math.floor(cssW * dpr));
    canvas.height = Math.max(220, Math.floor(cssH * dpr));
    canvas.style.height = cssH + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const readings = state.readings;
    if (!readings.length) return;

    const x0 = PAD_L, x1 = cssW - PAD_R;
    const y0 = cssH - PAD_B, y1 = PAD_T;
    const t0 = readings[0].ms;
    const t1 = readings[readings.length - 1].ms;
    const tSpan = Math.max(1, t1 - t0);
    chartGeom = { x0, x1, y0, y1, t0, t1, cssH, cssW };

    const xAt = (ms) => x0 + ((ms - t0) / tSpan) * (x1 - x0);
    const yAt = (pct) => y0 - (pct / 100) * (y0 - y1);

    // Hour-width in pixels — for any "fill the hour" band drawing we use the gap to the
    // next reading so the bars meet edge-to-edge without overlap rounding artifacts.
    const hourW = (x1 - x0) / Math.max(1, readings.length - 1);

    // --- background day/night strip (1) ---
    for (let i = 0; i < readings.length; i++) {
      const r = readings[i];
      const xL = xAt(r.ms) - hourW / 2;
      const xR = xL + hourW;
      ctx.fillStyle = r.is_day === 1
        ? "rgba(232, 184, 75, 0.13)"     // pale yellow
        : "rgba(120, 120, 130, 0.10)";   // very pale grey
      ctx.fillRect(xL, y1, xR - xL, y0 - y1);
    }

    // --- extreme temp strip at the top (2) — when temp factor drops below -0.5 ---
    // Sits at the top edge as a thin red strip so it reads as a "watch out, the
    // weather wants to keep people inside" header band over the affected hours.
    const EXTREME_BAND_H = 6;
    for (let i = 0; i < readings.length; i++) {
      const r = readings[i];
      if (r.factors.temp >= -0.5) continue;
      const intensity = Math.min(1, (-0.5 - r.factors.temp) / 0.5);
      const xL = xAt(r.ms) - hourW / 2;
      const xR = xL + hourW;
      ctx.fillStyle = "rgba(229, 105, 92, " + (0.30 + 0.50 * intensity).toFixed(2) + ")";
      ctx.fillRect(xL, y1, xR - xL, EXTREME_BAND_H);
    }

    // --- weekend strip at bottom (3) ---
    const WEEKEND_BAND_H = 8;
    for (let i = 0; i < readings.length; i++) {
      const r = readings[i];
      const dow = localDate(r.iso).getUTCDay();
      if (dow !== 0 && dow !== 6) continue;
      const xL = xAt(r.ms) - hourW / 2;
      const xR = xL + hourW;
      ctx.fillStyle = "rgba(90, 158, 111, 0.30)";
      ctx.fillRect(xL, y0 - WEEKEND_BAND_H, xR - xL, WEEKEND_BAND_H);
    }

    // --- rain bars rising from the bottom (4) — 0.1 in/hr saturates the strip ---
    // Bottom-anchored so the chart reads like a rain gauge: taller bar = more rain.
    // The bars overlap the weekend strip when both apply (rainy Saturday) — the
    // translucent blue over translucent green mixes to a readable teal-ish tone.
    const RAIN_BAND_H = 64;
    for (let i = 0; i < readings.length; i++) {
      const r = readings[i];
      if (r.precip_in <= 0.005) continue;
      const intensity = Math.min(1, r.precip_in / 0.1);
      const xL = xAt(r.ms) - hourW / 2;
      const xR = xL + hourW;
      const h = RAIN_BAND_H * (0.25 + 0.75 * intensity);
      ctx.fillStyle = "rgba(56, 145, 168, " + (0.30 + 0.45 * intensity).toFixed(2) + ")";
      ctx.fillRect(xL, y0 - h, xR - xL, h);
    }

    // --- grid + axis lines (5) ---
    ctx.strokeStyle = "rgba(0,0,0,0.08)";
    ctx.lineWidth = 1;
    [0, 25, 50, 75, 100].forEach((pct) => {
      const yy = yAt(pct);
      ctx.beginPath();
      ctx.moveTo(x0, yy);
      ctx.lineTo(x1, yy);
      ctx.stroke();
    });

    // --- faint factor traces (6) ---
    function plotFactorLine(getter, color, dash) {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      if (dash) ctx.setLineDash(dash); else ctx.setLineDash([]);
      for (let i = 0; i < readings.length; i++) {
        // Map factor score [-1..+1] onto the same 0..100 axis as turnout, so a +1
        // factor reaches the top and -1 reaches the bottom (visually comparable to
        // composite). 0 sits at the 50% gridline.
        const score = getter(readings[i]);
        const pct = 50 + score * 50;
        const px = xAt(readings[i].ms), py = yAt(pct);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    plotFactorLine((r) => r.factors.temp,     "rgba(229,105,92,0.55)");
    plotFactorLine((r) => r.factors.seasonal, "rgba(122,107,158,0.55)", [4, 3]);

    // --- day-boundary verticals + day-of-week labels (7) ---
    let prevDay = null;
    let dayLabelTrack = {};   // day → first x position (so we can also label every visible day)
    for (let i = 0; i < readings.length; i++) {
      const r = readings[i];
      const d = localDate(r.iso);
      const dk = dayKey(r.iso);
      if (dayLabelTrack[dk] === undefined) dayLabelTrack[dk] = xAt(r.ms);
      if (prevDay && dk !== prevDay) {
        const xx = xAt(r.ms);
        ctx.strokeStyle = "rgba(0,0,0,0.18)";
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(xx, y1);
        ctx.lineTo(xx, y0);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      prevDay = dk;
    }
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.font = "10px var(--os-font-mono, monospace)";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    Object.keys(dayLabelTrack).forEach((dk) => {
      const x = dayLabelTrack[dk];
      const d = new Date(dk + "T12:00Z");
      const label = DOW_SHORT[d.getUTCDay()] + " " + (d.getUTCMonth() + 1) + "/" + d.getUTCDate();
      ctx.fillText(label, Math.min(x1 - 60, x + 4), y0 + 14);
    });

    // --- y-axis labels (8) ---
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.font = "10px var(--os-font-mono, monospace)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    [0, 50, 100].forEach((pct) => {
      ctx.fillText(pct + "%", x0 - 4, yAt(pct));
    });
    ctx.save();
    ctx.translate(10, (y0 + y1) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillText("expected turnout", 0, 0);
    ctx.restore();

    // --- "now" marker (9) ---
    // First forecast hour might be slightly in the future. Anchor "now" to the first
    // reading's x position to keep things visually honest.
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xAt(readings[0].ms), y1);
    ctx.lineTo(xAt(readings[0].ms), y0);
    ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.font = "10px var(--os-font-mono, monospace)";
    ctx.textAlign = "left";
    ctx.fillText("now", xAt(readings[0].ms) + 3, y1 + 10);

    // --- composite line (10) — drawn last so it sits on top ---
    // Deliberately thinner than the peak overlay so the purple peak segments stand
    // out as obviously fatter highlights rather than a same-weight color swap.
    ctx.beginPath();
    ctx.strokeStyle = getComputedStyle(document.body).color || "#222";
    ctx.lineWidth = 1.8;
    ctx.lineJoin = "round";
    for (let i = 0; i < readings.length; i++) {
      const px = xAt(readings[i].ms);
      const py = yAt(readings[i].turnout_pct);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // --- peak-window highlight (11) — re-stroke the composite line through each peak
    // window in --os-c3 so the bold line visibly changes color exactly where the cards
    // below the chart say "open here". 4× the base line thickness so each peak reads
    // as a chunky purple highlight. When a card is hovered, that peak gets an extra
    // boost (wider stroke + glow) so the card↔segment pairing is unmistakable.
    const peakColor =
      (getComputedStyle(document.documentElement).getPropertyValue('--os-c3').trim()) ||
      '#7a6b9e';
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const peaks = currentPeaks();
    for (let pi = 0; pi < peaks.length; pi++) {
      const p = peaks[pi];
      const isHovered = hoveredPeakIdx === pi;
      ctx.save();
      if (isHovered) {
        // Canvas shadow gives a soft halo around the entire stroke, which reads as
        // "this is the one you're pointing at" without needing a second pass.
        ctx.shadowColor = peakColor;
        ctx.shadowBlur = 14;
      }
      ctx.strokeStyle = peakColor;
      ctx.lineWidth = isHovered ? 10.8 : 7.2;
      ctx.beginPath();
      for (let k = p.start; k <= p.end; k++) {
        const px = xAt(readings[k].ms);
        const py = yAt(readings[k].turnout_pct);
        if (k === p.start) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // ----- Tooltip -----------------------------------------------------------------------
  // Color tokens are duplicated here intentionally — they have to match the rgba()
  // fills used by the canvas overlays exactly so the user reads "blue chip in tooltip
  // = blue bar on chart" without thinking. If you tweak a bar color above, mirror it
  // here so the linkage stays correct.
  const FACTOR_SWATCH = {
    "temp comfort":  "rgba(229,105,92,0.85)",   // matches extreme-temp red strip
    "precipitation": "rgba(56,145,168,0.85)",   // matches rain bars
    "UV":            "rgba(232,184,75,0.85)",   // amber — sun
    "daylight":      "rgba(232,184,75,0.50)",   // matches day/night background tint
    "wind":          "rgba(120,120,130,0.70)",  // neutral grey
    "weekend":       "rgba(90,158,111,0.85)",   // matches weekend strip
    "time of day":   "rgba(120,120,130,0.70)",  // neutral grey
    "seasonal":      "rgba(122,107,158,0.85)",  // matches seasonal trace line
  };

  function describeFactor(name, value) {
    const v = Number(value) || 0;
    const cls = v > 0.15 ? "v-pos" : v < -0.15 ? "v-neg" : "v-zero";
    const sign = v > 0 ? "+" : "";
    const swatch = FACTOR_SWATCH[name] || "rgba(120,120,130,0.7)";
    return '<div class="t-factor">' +
      '<span class="f-name"><span class="f-dot" style="background:' + swatch + '"></span>' + escapeHTML(name) + '</span>' +
      '<span class="' + cls + '">' + sign + v.toFixed(2) + '</span>' +
      '</div>';
  }

  // Active-condition chips at the top of the tooltip. Each chip uses the SAME color
  // as the corresponding chart bar so the viewer's eye links "the blue bar I'm
  // hovering over" with "the blue 'RAIN' chip in the popup". Only conditions that
  // are currently in effect appear — no chip = no bar.
  function activeChipsHtml(r) {
    const chips = [];
    if (r.precip_in > 0.005) {
      chips.push({
        label: "RAIN " + r.precip_in.toFixed(2) + '"/hr',
        bg: "rgba(56,145,168,0.22)", bd: "rgba(56,145,168,0.85)",
      });
    }
    if (r.factors.temp < -0.5) {
      // The temp-comfort bell is centered at 68°F, so any score below -0.5 is
      // unambiguously cold (~50°F or colder) on one side or hot (~86°F or hotter)
      // on the other. Splitting the label at 60°F captures the human read.
      const label = r.t_f < 60 ? "EXTREME COLD " + Math.round(r.t_f) + "°F"
                               : "EXTREME HEAT " + Math.round(r.t_f) + "°F";
      chips.push({ label, bg: "rgba(229,105,92,0.22)", bd: "rgba(229,105,92,0.85)" });
    }
    const dow = localDate(r.iso).getUTCDay();
    if (dow === 0 || dow === 6) {
      chips.push({ label: "WEEKEND", bg: "rgba(90,158,111,0.22)", bd: "rgba(90,158,111,0.85)" });
    }
    if (r.is_day === 1) {
      chips.push({ label: "DAYTIME", bg: "rgba(232,184,75,0.22)", bd: "rgba(232,184,75,0.75)" });
    } else {
      chips.push({ label: "NIGHT",   bg: "rgba(120,120,130,0.22)", bd: "rgba(120,120,130,0.75)" });
    }
    if (!chips.length) return "";
    return '<div class="t-chips">' + chips.map((c) =>
      '<span class="t-chip" style="background:' + c.bg + ';border-color:' + c.bd + '">' +
        escapeHTML(c.label) +
      '</span>'
    ).join("") + '</div>';
  }

  function renderTooltipFor(idx, clientX, clientY) {
    const tooltip = $("tooltip");
    const r = state.readings[idx];
    if (!r) { tooltip.classList.add("hidden"); return; }
    const d = localDate(r.iso);
    const dow = DOW_SHORT[d.getUTCDay()];
    const h = d.getUTCHours();
    const head = dow + " " + (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + " · " + fmtHour12(h);
    tooltip.innerHTML =
      '<div class="t-head">' + escapeHTML(head) + '</div>' +
      '<div class="t-turnout">turnout ' + Math.round(r.turnout_pct) + '%</div>' +
      activeChipsHtml(r) +
      '<div class="t-row"><span>temp</span><span>' + Math.round(r.t_f) + '°F</span></div>' +
      '<div class="t-row"><span>rain</span><span>' + r.precip_in.toFixed(2) + '"/hr</span></div>' +
      '<div class="t-row"><span>UV</span><span>' + r.uv.toFixed(1) + '</span></div>' +
      '<div class="t-row"><span>wind</span><span>' + Math.round(r.wind_mph) + ' mph</span></div>' +
      '<div class="t-factors">' +
        describeFactor("temp comfort", r.factors.temp) +
        describeFactor("precipitation", r.factors.precip) +
        describeFactor("UV", r.factors.uv) +
        describeFactor("daylight", r.factors.daylight) +
        describeFactor("wind", r.factors.wind) +
        describeFactor("weekend", r.factors.weekend) +
        describeFactor("time of day", r.factors.hour) +
        describeFactor("seasonal", r.factors.seasonal) +
      '</div>';
    tooltip.classList.remove("hidden");

    // Position within the chart-wrap. Bias horizontally so the tooltip stays inside
    // the panel; bias upward so it sits above the cursor for cleaner reading.
    const wrap = $("chart").parentElement;
    const wrapRect = wrap.getBoundingClientRect();
    const tipW = tooltip.offsetWidth, tipH = tooltip.offsetHeight;
    let left = clientX - wrapRect.left + 12;
    let top  = clientY - wrapRect.top  - tipH - 12;
    if (left + tipW > wrapRect.width)  left = clientX - wrapRect.left - tipW - 12;
    if (top < 0) top = clientY - wrapRect.top + 14;
    tooltip.style.left = left + "px";
    tooltip.style.top  = top  + "px";
  }

  function attachChartInteraction() {
    const canvas = $("chart");
    const tooltip = $("tooltip");
    canvas.addEventListener("mousemove", (e) => {
      if (!chartGeom || !state.readings.length) return;
      const rect = canvas.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const { x0, x1, t0, t1 } = chartGeom;
      if (cssX < x0 || cssX > x1) { tooltip.classList.add("hidden"); return; }
      const frac = (cssX - x0) / (x1 - x0);
      const tMs = t0 + frac * (t1 - t0);
      // Nearest-reading lookup (readings are uniform spacing so a direct round works)
      let nearest = 0, bestDiff = Infinity;
      for (let i = 0; i < state.readings.length; i++) {
        const d = Math.abs(state.readings[i].ms - tMs);
        if (d < bestDiff) { bestDiff = d; nearest = i; }
      }
      renderTooltipFor(nearest, e.clientX, e.clientY);
    });
    canvas.addEventListener("mouseleave", () => $("tooltip").classList.add("hidden"));
  }

  // ----- Peaks ("best windows") --------------------------------------------------------
  // Slide a 3-hour window across the forecast, compute the mean turnout for each,
  // pick the top 5 non-overlapping windows. Helps a vendor answer "when should I
  // be open this weekend" without squinting at the chart.
  //
  // The chart highlights every selected window in --os-c3 on the composite line,
  // and the cards below the chart describe each window in order — so the same set
  // of windows must drive both. `currentPeaks()` is the single call site.
  const PEAK_WINDOW_H = 3;
  const PEAK_COUNT    = 4;
  function currentPeaks() {
    return findPeakWindows(state.readings, PEAK_WINDOW_H, PEAK_COUNT);
  }

  function findPeakWindows(readings, windowH, topN) {
    if (readings.length < windowH) return [];
    const scores = [];
    for (let i = 0; i + windowH - 1 < readings.length; i++) {
      let sum = 0;
      for (let j = 0; j < windowH; j++) sum += readings[i + j].turnout_pct;
      scores.push({ start: i, end: i + windowH - 1, mean: sum / windowH });
    }
    scores.sort((a, b) => b.mean - a.mean);
    const picks = [];
    const used = new Set();
    for (const s of scores) {
      // Discard windows that touch an already-picked window so we get distinct slots.
      let conflict = false;
      for (let k = s.start; k <= s.end; k++) { if (used.has(k)) { conflict = true; break; } }
      if (conflict) continue;
      for (let k = s.start; k <= s.end; k++) used.add(k);
      picks.push(s);
      if (picks.length >= topN) break;
    }
    return picks.sort((a, b) => a.start - b.start);
  }

  // ----- Peak card explainers --------------------------------------------------------
  // Two extra signals per card:
  //
  //   tier   — qualitative strength bucket (decent / nice / great) driven by the
  //            window's mean turnout %. The tier maps to a card background color so
  //            a vendor can scan the row of cards and see at a glance which slots
  //            are merely OK vs. genuinely worth opening for.
  //   why    — short, human-readable reason string ("weekend · ideal temps ·
  //            midday") derived from the top weighted positive factors averaged
  //            across the window. Surfaces WHICH inputs are doing the heavy
  //            lifting for this peak — a Saturday at noon with no rain reads
  //            very differently from a sunny Tuesday afternoon, even at the same
  //            turnout %.
  //
  // Daylight is excluded from the "why" string — every peak is during daytime by
  // definition (night carries a -1 daylight factor that no other factor recovers
  // from), so surfacing "daylight" on every card would be noise.

  function peakTier(meanPct) {
    if (meanPct >= 80) return "great";
    if (meanPct >= 65) return "nice";
    return "decent";
  }

  const FACTOR_LABELS = {
    weekend:  "weekend",
    temp:     "ideal temps",
    seasonal: "seasonally pleasant",
    hour:     "midday window",
    uv:       "good sun",
    wind:     "calm conditions",
    precip:   "dry conditions",
    daylight: "daylight",
  };
  const WHY_EXCLUDE = new Set(["daylight"]);

  function whyForPeak(p) {
    const slice = state.readings.slice(p.start, p.end + 1);
    if (!slice.length || !slice[0].factors) return "";
    const factorKeys = Object.keys(slice[0].factors);
    const weights = state.weights || {};
    // Mean factor score across the window, then weighted contribution (= what each
    // factor is actually pushing on the composite). Filter to positives only — a
    // peak window doesn't have negative-contributing reasons by construction.
    const contribs = factorKeys
      .filter((k) => !WHY_EXCLUDE.has(k))
      .map((k) => {
        const mean = slice.reduce((s, r) => s + (r.factors[k] || 0), 0) / slice.length;
        return { key: k, mean, contrib: mean * (weights[k] || 0) };
      })
      .filter((c) => c.mean > 0.1 && c.contrib > 0.05)
      .sort((a, b) => b.contrib - a.contrib)
      .slice(0, 3);
    if (!contribs.length) return "above-average conditions";
    return contribs.map((c) => FACTOR_LABELS[c.key] || c.key).join(" · ");
  }

  function renderPeaks() {
    const el = $("peaks");
    if (!state.readings.length) { el.classList.add("hidden"); return; }
    const picks = currentPeaks();
    if (!picks.length) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    el.innerHTML = picks.map((p) => {
      const first = state.readings[p.start];
      const last  = state.readings[p.end];
      const d1 = localDate(first.iso);
      const d2 = localDate(last.iso);
      const dow = DOW_SHORT[d1.getUTCDay()];
      const sameDay = dayKey(first.iso) === dayKey(last.iso);
      const dayLabel = dow + " " + (d1.getUTCMonth() + 1) + "/" + d1.getUTCDate();
      const range = sameDay
        ? fmtRange12(d1.getUTCHours(), d2.getUTCHours() + 1)
        : (fmtHour12(d1.getUTCHours()) + " → " + DOW_SHORT[d2.getUTCDay()] + " " + fmtHour12(d2.getUTCHours() + 1));
      const temps = state.readings.slice(p.start, p.end + 1).map(r => r.t_f);
      const tLo = Math.round(Math.min.apply(null, temps));
      const tHi = Math.round(Math.max.apply(null, temps));
      const rain = state.readings.slice(p.start, p.end + 1).reduce((s, r) => s + r.precip_in, 0);
      const note = (tLo === tHi ? tLo + "°F" : tLo + "–" + tHi + "°F") +
        (rain >= 0.05 ? " · " + rain.toFixed(2) + '" rain' : "");
      const tier = peakTier(p.mean);
      const why  = whyForPeak(p);
      return (
        '<article class="peak-card peak-card--' + tier + '">' +
          '<span class="p-day">' + escapeHTML(dayLabel) + '</span>' +
          '<span class="p-range">' + escapeHTML(range) + '</span>' +
          '<span class="p-why">' + escapeHTML(why) + '</span>' +
          '<span class="p-score">turnout ~' + Math.round(p.mean) + '% · ' + escapeHTML(tier) + '</span>' +
          '<span class="p-note">' + escapeHTML(note) + '</span>' +
        '</article>'
      );
    }).join("");

    // Card→chart hover linkage. mouseenter sets the hovered peak index and redraws
    // the chart so the matching purple segment fattens up with a halo; mouseleave
    // clears it. Pointer events on the card itself give a touch-friendly version
    // (a tap will trigger mouseenter on touch devices and stick until they tap
    // elsewhere — good enough for "show me where on the chart this card is").
    el.querySelectorAll(".peak-card").forEach((card, idx) => {
      card.addEventListener("mouseenter", () => {
        hoveredPeakIdx = idx;
        card.classList.add("peak-card--hovered");
        drawChart();
      });
      card.addEventListener("mouseleave", () => {
        if (hoveredPeakIdx === idx) hoveredPeakIdx = null;
        card.classList.remove("peak-card--hovered");
        drawChart();
      });
    });
  }

  // ----- View A: weekly events ---------------------------------------------------------
  // For each configured event, compute the NEXT occurrence in the location's local
  // clock. If the start is past the 72h forecast horizon → render a "pending" tile.
  // Otherwise pick the forecast hours that overlap the window, compute quartile stats
  // of turnout_pct across them, and render a tile with median + box plot + tier color.

  const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const HOUR_MS = 3600 * 1000;

  // Current view: "events" (default) | "detail"
  let currentView = "events";

  function locationOffsetMs() {
    return (state.weather && state.weather.utc_offset_seconds || 0) * 1000;
  }

  // Returns the next start instant for `ev` as a true UTC ms.
  function nextEventStartMs(ev) {
    const offsetMs = locationOffsetMs();
    const serverNow = state.now || Date.now();
    // Build a Date whose getUTC* methods read location-local fields.
    const localNow = new Date(serverNow + offsetMs);
    const currentDow = localNow.getUTCDay();
    const currentMinuteOfDay = localNow.getUTCHours() * 60 + localNow.getUTCMinutes();
    const endMinute = ev.end_hh * 60 + ev.end_mm;

    let daysAhead = (ev.day_of_week - currentDow + 7) % 7;
    // If today IS the event day but the event is already over, push to next week.
    if (daysAhead === 0 && currentMinuteOfDay >= endMinute) daysAhead = 7;

    const local = new Date(localNow.getTime());
    local.setUTCDate(local.getUTCDate() + daysAhead);
    local.setUTCHours(ev.start_hh, ev.start_mm, 0, 0);
    return local.getTime() - offsetMs;
  }

  function eventDurationMinutes(ev) {
    const s = ev.start_hh * 60 + ev.start_mm;
    const e = ev.end_hh * 60 + ev.end_mm;
    // Defensive: end ≤ start collapses to 1h (no negative or zero durations).
    return e > s ? (e - s) : 60;
  }

  function nextEventEndMs(ev) {
    return nextEventStartMs(ev) + eventDurationMinutes(ev) * 60 * 1000;
  }

  // Pick reading indices that overlap [startMs, endMs) — reading[i] covers [ms, ms+1h).
  function readingsOverlapping(startMs, endMs) {
    const out = [];
    for (let i = 0; i < state.readings.length; i++) {
      const r = state.readings[i];
      const rStart = r.ms;
      const rEnd = r.ms + HOUR_MS;
      if (rEnd > startMs && rStart < endMs) out.push(i);
    }
    return out;
  }

  // Linear-interpolated quantile on a pre-sorted array.
  function quantile(sortedAsc, p) {
    if (sortedAsc.length === 0) return 0;
    if (sortedAsc.length === 1) return sortedAsc[0];
    const idx = (sortedAsc.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
  }

  // 5-bucket spectrum across the 20–80% turnout range. Greens for strong, blues
  // for good, light gray neutral, yellow for soft, orange for very low. Each
  // bucket maps to a peak-card--<tier> CSS class (the existing peak card style)
  // so event tiles and peak tiles share their visual vocabulary.
  function eventTier(meanPct) {
    if (meanPct >= 80) return "great";   // green   — strong
    if (meanPct >= 60) return "nice";    // blue    — good
    if (meanPct >= 40) return "decent";  // gray    — neutral
    if (meanPct >= 20) return "low";     // yellow  — soft
    return "vlow";                        // orange  — very low
  }

  function tierLabel(tier) {
    return tier === "great"  ? "Strong turnout"
      :  tier === "nice"   ? "Good turnout"
      :  tier === "decent" ? "Moderate turnout"
      :  tier === "low"    ? "Light turnout"
      :                       "Very low turnout";
  }

  function fmtMinuteClock(hh, mm) {
    const m = String(mm).padStart(2, "0");
    if (hh === 0) return "12:" + m + "am";
    if (hh === 12) return "12:" + m + "pm";
    return (hh % 12) + ":" + m + (hh < 12 ? "am" : "pm");
  }

  function fmtEventDate(ms) {
    // Format in the LOCATION's local clock, not the viewer's.
    const d = new Date(ms + locationOffsetMs());
    return DOW_SHORT[d.getUTCDay()] + " " + (d.getUTCMonth() + 1) + "/" + d.getUTCDate();
  }

  function whyForReadingRange(indices) {
    // Reuse the same factor-aggregation as whyForPeak but for an arbitrary list of
    // reading indices. Returns a short human "why" string or "" if no positive
    // contributors stand out.
    if (!indices.length) return "";
    const start = indices[0], end = indices[indices.length - 1];
    return whyForPeak({ start, end });
  }

  function renderEvents() {
    const section = $("events-section");
    const grid = $("events-grid");
    const empty = $("events-empty");
    const events = (state.prefs && state.prefs.events) || [];

    if (currentView !== "events") { section.classList.add("hidden"); return; }
    if (!state.prefs || !state.prefs.location || !state.weather) {
      // Setup-note already explains; just leave the section hidden.
      section.classList.add("hidden");
      return;
    }
    section.classList.remove("hidden");

    if (events.length === 0) {
      empty.classList.remove("hidden");
      grid.innerHTML = "";
      return;
    }
    empty.classList.add("hidden");

    const horizonMs = state.now + 72 * HOUR_MS;
    const cards = events.slice().map((ev) => {
      const startMs = nextEventStartMs(ev);
      const endMs = nextEventEndMs(ev);
      const dayLabel = fmtEventDate(startMs);
      const timeLabel = fmtMinuteClock(ev.start_hh, ev.start_mm) + " – " + fmtMinuteClock(ev.end_hh, ev.end_mm);

      // Pending: start is past the forecast horizon.
      if (startMs > horizonMs) {
        const daysOut = Math.max(1, Math.ceil((startMs - state.now) / (24 * HOUR_MS)));
        return {
          startMs,
          html:
            '<article class="event-card event-card--pending">' +
              '<div class="p-day">' + escapeHTML(dayLabel) + ' · ' + escapeHTML(timeLabel) + '</div>' +
              '<div class="event-name">' + escapeHTML(ev.name || "(unnamed)") + '</div>' +
              '<div class="event-pending">' +
                '<i class="ph-light ph-clock-countdown icon-sm"></i> ' +
                'Forecast not yet available · ' + daysOut + 'd out' +
              '</div>' +
            '</article>',
        };
      }

      const overlap = readingsOverlapping(startMs, endMs);
      const turnouts = overlap.map((i) => state.readings[i].turnout_pct);
      // It's possible (rare) for the window to be partly past the horizon — that's fine,
      // we just have fewer hours to summarize. Flag it so the user knows.
      const expectedHours = Math.max(1, Math.ceil(eventDurationMinutes(ev) / 60));
      const partial = overlap.length < expectedHours;

      if (turnouts.length === 0) {
        // Window started but no readings overlap (e.g., entire window in the past by now).
        // Treat as pending-ish: the user might want to remove this event or wait for next.
        return {
          startMs,
          html:
            '<article class="event-card event-card--pending">' +
              '<div class="p-day">' + escapeHTML(dayLabel) + ' · ' + escapeHTML(timeLabel) + '</div>' +
              '<div class="event-name">' + escapeHTML(ev.name || "(unnamed)") + '</div>' +
              '<div class="event-pending">' +
                '<i class="ph-light ph-hourglass icon-sm"></i> No overlapping forecast hours' +
              '</div>' +
            '</article>',
        };
      }

      const sorted = turnouts.slice().sort((a, b) => a - b);
      const min = Math.round(sorted[0]);
      const max = Math.round(sorted[sorted.length - 1]);
      const med = Math.round(quantile(sorted, 0.5));
      const tier = eventTier(med);
      const why = whyForReadingRange(overlap);
      const partialNote = partial
        ? '<div class="event-partial"><i class="ph-light ph-warning-circle icon-sm"></i> Partial forecast: ' +
            overlap.length + ' of ' + expectedHours + ' hours covered</div>'
        : "";
      // If min and max collapse to the same value the window had a flat forecast —
      // skip the redundant "X–X%" line so the card reads cleaner.
      const rangeNote = (min !== max)
        ? '<div class="event-range">range ' + min + '% – ' + max + '%</div>'
        : "";

      return {
        startMs,
        html:
          '<article class="event-card peak-card peak-card--' + tier + '">' +
            '<div class="p-day">' + escapeHTML(dayLabel) + ' · ' + escapeHTML(timeLabel) + '</div>' +
            '<div class="event-name">' + escapeHTML(ev.name || "(unnamed)") + '</div>' +
            '<div class="event-figure">' +
              '<span class="event-pct">' + med + '<span class="event-pct-sign">%</span></span>' +
              '<span class="event-tier-label">' + tierLabel(tier) + '</span>' +
            '</div>' +
            rangeNote +
            (why ? '<div class="p-why">' + escapeHTML(why) + '</div>' : "") +
            partialNote +
          '</article>',
      };
    });

    // Sort upcoming-first so the next event is leftmost / topmost. Pending events at
    // the end of the list (further in time).
    cards.sort((a, b) => a.startMs - b.startMs);
    grid.innerHTML = cards.map((c) => c.html).join("");
  }

  // ----- View toggle -------------------------------------------------------------------
  function setView(v) {
    currentView = (v === "detail") ? "detail" : "events";
    const evBtn = $("view-events-btn");
    const dtBtn = $("view-detail-btn");
    evBtn.classList.toggle("active", currentView === "events");
    dtBtn.classList.toggle("active", currentView === "detail");
    evBtn.setAttribute("aria-selected", currentView === "events" ? "true" : "false");
    dtBtn.setAttribute("aria-selected", currentView === "detail" ? "true" : "false");
    // Re-render both views so visibility classes settle in one place.
    renderChartAndPeaks();
    renderEvents();
  }

  function renderChartAndPeaks() {
    // The chart and peak cards are two separate top-level sections; both must be
    // hidden together when View A is active so View B truly disappears.
    const section = $("chart-section");
    const peaks = $("peaks");
    if (currentView !== "detail" || !state.readings.length) {
      section.classList.add("hidden");
      peaks.classList.add("hidden");
      return;
    }
    section.classList.remove("hidden");
    drawChart();
    renderPeaks();
  }

  // ----- Render orchestrator -----------------------------------------------------------
  function render() {
    renderHeader();
    renderSetupNote();
    // Show the view toggle only when we actually have a forecast to show.
    const toggle = $("view-toggle");
    if (state.readings.length) toggle.classList.remove("hidden");
    else toggle.classList.add("hidden");
    renderChartAndPeaks();
    renderEvents();
  }

  // ----- Settings dialog ---------------------------------------------------------------
  // The settings dialog edits a `draft` copy of prefs; values are only committed when
  // the user clicks Save. Cancel discards the draft entirely.
  function openSettings() {
    draft = {
      location: state.prefs.location,
      // Deep-ish copy so editing the draft never mutates state.prefs.events.
      events: ((state.prefs && state.prefs.events) || []).map((e) => ({ ...e })),
    };
    $("cfg-location").value = draft.location;
    renderEventsEditor();
    $("settings-overlay").classList.remove("hidden");
    $("cfg-location").focus();
  }
  function closeSettings() {
    $("settings-overlay").classList.add("hidden");
    draft = null;
  }
  async function saveSettings() {
    if (!draft) return closeSettings();
    draft.location = $("cfg-location").value.trim().slice(0, 120);
    // Pull the latest editor values into the draft just before saving so the user
    // doesn't have to defocus a field to commit it.
    captureEventsFromEditor();
    try {
      await frame.api("api/save", { location: draft.location, events: draft.events });
      closeSettings();
      await loadState();
    } catch (e) {
      await frame.alert("Couldn't save: " + (e?.body || e?.message || String(e)));
    }
  }

  // ----- Events editor (inside settings dialog) ----------------------------------------
  function eventRowHtml(ev) {
    const dowOpts = DOW_LONG.map((label, idx) =>
      '<option value="' + idx + '"' + (idx === ev.day_of_week ? ' selected' : '') + '>' + label + '</option>'
    ).join("");
    const startStr = String(ev.start_hh).padStart(2, "0") + ":" + String(ev.start_mm).padStart(2, "0");
    const endStr = String(ev.end_hh).padStart(2, "0") + ":" + String(ev.end_mm).padStart(2, "0");
    return (
      '<div class="event-row" data-event-id="' + escapeHTML(ev.id) + '">' +
        '<input class="ev-name" type="text" maxlength="100" placeholder="Event name" value="' + escapeHTML(ev.name) + '">' +
        '<select class="ev-dow" aria-label="Day of week">' + dowOpts + '</select>' +
        '<input class="ev-start" type="time" value="' + startStr + '" aria-label="Start time">' +
        '<span class="ev-arrow">→</span>' +
        '<input class="ev-end" type="time" value="' + endStr + '" aria-label="End time">' +
        '<button class="ev-del ghost" type="button" aria-label="Remove event" title="Remove">' +
          '<i class="ph-light ph-x icon-sm"></i>' +
        '</button>' +
      '</div>'
    );
  }

  function renderEventsEditor() {
    const root = $("cfg-events");
    if (!draft) { root.innerHTML = ""; return; }
    root.innerHTML = draft.events.map(eventRowHtml).join("");
    // Wire delete buttons per row. We don't wire input changes — we capture the DOM
    // state once on save (see captureEventsFromEditor) rather than ferry every
    // keystroke into the draft, which keeps the editor responsive and avoids
    // re-render flicker.
    root.querySelectorAll(".ev-del").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = btn.closest(".event-row");
        const id = row && row.getAttribute("data-event-id");
        if (!id) return;
        // Capture current values BEFORE removing so unrelated edits aren't lost.
        captureEventsFromEditor();
        draft.events = draft.events.filter((e) => e.id !== id);
        renderEventsEditor();
      });
    });
  }

  function parseTimeStr(s) {
    // "HH:MM" → { hh, mm }. Invalid input collapses to 0:00.
    const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return { hh: 0, mm: 0 };
    const hh = Math.max(0, Math.min(23, parseInt(m[1], 10)));
    const mm = Math.max(0, Math.min(59, parseInt(m[2], 10)));
    return { hh, mm };
  }

  function captureEventsFromEditor() {
    if (!draft) return;
    const rows = $("cfg-events").querySelectorAll(".event-row");
    const next = [];
    rows.forEach((row) => {
      const id = row.getAttribute("data-event-id");
      const existing = draft.events.find((e) => e.id === id);
      if (!existing) return;
      const name = row.querySelector(".ev-name").value.trim().slice(0, 100);
      const dow = Math.max(0, Math.min(6, parseInt(row.querySelector(".ev-dow").value, 10) || 0));
      const start = parseTimeStr(row.querySelector(".ev-start").value);
      const end = parseTimeStr(row.querySelector(".ev-end").value);
      next.push({
        ...existing,
        name,
        day_of_week: dow,
        start_hh: start.hh, start_mm: start.mm,
        end_hh: end.hh, end_mm: end.mm,
      });
    });
    draft.events = next;
  }

  function addNewEvent() {
    if (!draft) return;
    captureEventsFromEditor();
    // Sensible default: next Saturday 10:00–14:00. Saturdays are the typical
    // outdoor-market day in this frame's domain.
    const newEv = {
      id: "ev_" + Date.now() + "_" + Math.floor(Math.random() * 1e6),
      name: "",
      day_of_week: 6,
      start_hh: 10, start_mm: 0,
      end_hh: 14, end_mm: 0,
    };
    draft.events.push(newEv);
    renderEventsEditor();
    // Focus the name field of the new row so the user can start typing immediately.
    const rows = $("cfg-events").querySelectorAll(".event-row");
    const last = rows[rows.length - 1];
    if (last) {
      const input = last.querySelector(".ev-name");
      if (input) input.focus();
    }
  }

  // ----- Bootstrap + push --------------------------------------------------------------
  async function loadState() {
    try {
      state = await frame.api("api/state");
      render();
    } catch (e) {
      if (e?.status === 403) {
        document.body.innerHTML =
          '<div class="note"><i class="ph-light ph-lock-simple icon-sm"></i> Forbidden.</div>';
        return;
      }
      console.error(e);
    }
  }

  $("settings-btn").addEventListener("click", openSettings);
  $("settings-close").addEventListener("click", closeSettings);
  $("settings-cancel").addEventListener("click", closeSettings);
  $("settings-save").addEventListener("click", saveSettings);
  $("settings-overlay").addEventListener("click", (e) => {
    if (e.target === $("settings-overlay")) closeSettings();
  });
  $("cfg-event-add").addEventListener("click", addNewEvent);
  $("view-events-btn").addEventListener("click", () => setView("events"));
  $("view-detail-btn").addEventListener("click", () => setView("detail"));

  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "settings_changed") loadState();
  });

  window.addEventListener("resize", () => {
    if (state.readings.length && currentView === "detail") drawChart();
  });

  attachChartInteraction();

  // Refresh every 5 minutes — backend cache is 15min so most refreshes are cheap but
  // this keeps the "now" marker honest as the day rolls forward.
  setInterval(loadState, 5 * 60 * 1000);

  loadState();
})();
