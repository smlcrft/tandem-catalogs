(function () {
  const peer = window.__peer || {};
  const isAnon = peer.is_anon === "1" || !peer.user_id;

  const urlSfi = new URLSearchParams(location.search).get("sfi") || "";
  const withSfi = (u) => !urlSfi ? u : u + (u.includes("?") ? "&" : "?") + "sfi=" + encodeURIComponent(urlSfi);

  const $ = (id) => document.getElementById(id);

  // ----- Anonymous gate ------------------------------------------------------------------
  if (isAnon) {
    document.body.innerHTML =
      '<div class="note"><i class="ph-light ph-lock-simple icon-sm"></i> ' +
      'Garden Gnome is a private frame. Sign in to view this garden.</div>';
    return;
  }

  // ----- State ---------------------------------------------------------------------------
  let state = {
    prefs: { location: "", soil: "loamy", plants: [] },
    soil_types: [],
    plant_types: [],
    weather: null,
    statuses: [],
    is_owner: false,
  };
  // working copy used while the settings dialog is open
  let draft = null;

  // ----- Helpers -------------------------------------------------------------------------
  function escapeHTML(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function describeScore(channel, score, value) {
    let word;
    if (score < -1.5) word = "very under";
    else if (score < -1) word = "well under";
    else if (score < -0.5) word = "below center";
    else if (score <= 0.5) word = "in the sweet spot";
    else if (score <= 1) word = "above center";
    else if (score <= 1.5) word = "well over";
    else word = "very over";
    const label =
      channel === "water" ? `Water: ${word} (${value.toFixed(2)}" in soil)` :
      channel === "temp"  ? `Temperature: ${word} (${value.toFixed(1)}°F weighted)` :
                            `Sunlight: ${word} (UV ${value.toFixed(1)} weighted)`;
    return label;
  }

  // Risk badges map to a small accent palette + a phosphor icon. The pieces are kept
  // in JS so we can derive the chip class from the risk key without a CSS dictionary.
  const RISK_STYLES = {
    "FREEZE RISK":  { tone: "cold",    icon: "ph-snowflake" },
    "HEAT STRESS":  { tone: "hot",     icon: "ph-fire" },
    "DROUGHT RISK": { tone: "dry",     icon: "ph-drop-half" },
    "WATERLOGGED":  { tone: "soaked",  icon: "ph-cloud-rain" },
  };

  // ----- Render --------------------------------------------------------------------------
  function renderHeader() {
    const chip = $("weather-chip");
    if (state.weather) {
      const w = state.weather.summary;
      const name = state.weather.resolved_name;
      const now = Math.round(w.current_temp_f);
      const lo  = Math.round(w.forecast_24h_min_temp);
      const hi  = Math.round(w.forecast_24h_max_temp);
      // Show incoming rain when there's anything meaningful (>0.05" rolled up over 24h).
      // Sub-trace amounts add noise without telling the gardener anything actionable.
      const rainAhead = w.forecast_24h_rain;
      const rainPart = rainAhead >= 0.05
        ? ' + <i class="ph-light ph-cloud-rain icon-sm"></i> ' +
          rainAhead.toFixed(rainAhead >= 1 ? 1 : 2) + '"'
        : '';
      // Icon hints at whether rain is happening *now*, vs just somewhere in the next 24h.
      const headIcon = w.current_precip_in > 0.01 ? 'ph-cloud-rain' : 'ph-sun';
      chip.classList.remove("hidden");
      chip.innerHTML =
        `<i class="ph-light ${headIcon} icon-sm"></i> ` +
        escapeHTML(name) + ' · ' +
        now + '°F · ' +
        'next 24h: ' + lo + '–' + hi + '°F' +
        rainPart;
    } else {
      chip.classList.add("hidden");
    }
  }

  function renderSetupNote() {
    const note = $("setup-note");
    const txt  = $("setup-text");
    if (!state.prefs.location) {
      note.classList.remove("hidden");
      txt.textContent = "Set your location in settings to start fetching weather.";
    } else if (!state.weather) {
      note.classList.remove("hidden");
      txt.textContent = `Couldn't find weather for "${state.prefs.location}". Try a different city or zip in settings.`;
    } else {
      note.classList.add("hidden");
    }
  }

  function spectrumMarker(channel, score, value) {
    // Continuous mapping: score -2 → 4%, score 0 → 50%, score +2 → 96%.
    // Margins keep the marker glyph from clipping the rounded ends of the bar.
    const clamped = Math.max(-2, Math.min(2, score));
    const pct = 50 + (clamped * 23);
    const iconByChannel = {
      water: "ph-drop",
      temp:  "ph-thermometer",
      sun:   "ph-sun",
    };
    const cls = `marker ch-${channel}`;
    const tooltip = describeScore(channel, score, value);
    return `<span class="${cls}" style="left:${pct.toFixed(2)}%" title="${escapeHTML(tooltip)}" aria-label="${escapeHTML(tooltip)}">` +
      `<i class="ph-light ${iconByChannel[channel]}"></i></span>`;
  }

  function riskBadgeHtml(risk) {
    const style = RISK_STYLES[risk.key] || { tone: "warn", icon: "ph-warning" };
    // Visible state is just the colored icon chip; the label + advice spans are hidden
    // by default and revealed by the .expanded class (click) or surfaced via the title
    // attribute as a native hover tooltip.
    const tip = `${risk.key} — ${risk.advice}`;
    return (
      `<button type="button" class="risk-badge risk--${style.tone}" ` +
        `title="${escapeHTML(tip)}" aria-label="${escapeHTML(tip)}">` +
        `<i class="ph-light ${escapeHTML(style.icon)}" aria-hidden="true"></i>` +
        `<span class="risk-label">${escapeHTML(risk.key)}</span>` +
        `<span class="risk-advice">${escapeHTML(risk.advice)}</span>` +
      '</button>'
    );
  }

  function plantCardHtml(s) {
    const ticks =
      '<span class="tick" style="left:25%"></span>' +
      '<span class="tick tick-mid" style="left:50%"></span>' +
      '<span class="tick" style="left:75%"></span>';
    const risks = Array.isArray(s.risks) && s.risks.length
      ? `<span class="risk-row">${s.risks.map(riskBadgeHtml).join("")}</span>`
      : "";
    return (
      '<article class="plant-card">' +
        '<div class="plant-head">' +
          `<span class="plant-icon"><i class="ph-light ${escapeHTML(s.icon)} icon-sm"></i></span>` +
          `<span class="plant-name">${escapeHTML(s.label)}</span>` +
          risks +
        '</div>' +
        '<span class="spectrum"><div class="spectrum_bg"></div>' +
          ticks +
          spectrumMarker("water", s.water, s.water_value) +
          spectrumMarker("temp",  s.temp,  s.temp_value)  +
          spectrumMarker("sun",   s.sun,   s.sun_value)   +
        '</span>' +
      '</article>'
    );
  }

  // Click-to-expand: tapping a badge opens it inline; tapping again or another badge
  // on the same card collapses the prior one. Mouse users still get the native title
  // tooltip on hover, so this is primarily for touch + explicit-click flows.
  function wireRiskBadgeClicks(container) {
    container.querySelectorAll(".risk-badge").forEach((badge) => {
      badge.addEventListener("click", () => {
        const wasExpanded = badge.classList.contains("expanded");
        const card = badge.closest(".plant-card");
        if (card) card.querySelectorAll(".risk-badge.expanded").forEach((b) => b.classList.remove("expanded"));
        if (!wasExpanded) badge.classList.add("expanded");
      });
    });
  }

  function renderPlants() {
    const container = $("plants");
    const empty = $("empty-note");
    if (!state.weather || state.statuses.length === 0) {
      container.innerHTML = "";
      const noPlantsPicked = state.prefs.plants.length === 0;
      if (state.prefs.location && state.weather && noPlantsPicked) {
        empty.classList.remove("hidden");
      } else {
        empty.classList.add("hidden");
      }
      return;
    }
    empty.classList.add("hidden");
    container.innerHTML = state.statuses.map(plantCardHtml).join("");
    wireRiskBadgeClicks(container);
  }

  function render() {
    renderHeader();
    renderSetupNote();
    renderPlants();
  }

  // ----- Settings dialog -----------------------------------------------------------------
  function renderSoilOptions() {
    const list = $("cfg-soil");
    list.innerHTML = state.soil_types.map((s) => (
      '<label class="soil-option' + (s.key === draft.soil ? ' checked' : '') + '">' +
        `<input type="radio" name="cfg-soil-radio" value="${escapeHTML(s.key)}"${s.key === draft.soil ? ' checked' : ''}>` +
        '<span class="soil-text">' +
          `<span class="soil-label">${escapeHTML(s.label)}</span>` +
          `<span class="soil-desc">${escapeHTML(s.description)}</span>` +
        '</span>' +
      '</label>'
    )).join("");
    list.querySelectorAll('input[type="radio"]').forEach((el) => {
      el.addEventListener("change", () => {
        draft.soil = el.value;
        list.querySelectorAll(".soil-option").forEach((o) => o.classList.remove("checked"));
        el.closest(".soil-option").classList.add("checked");
      });
    });
  }

  function renderPlantOptions() {
    const grid = $("cfg-plants");
    const set = new Set(draft.plants);
    grid.innerHTML = state.plant_types.map((p) => (
      '<label class="plant-option' + (set.has(p.key) ? ' checked' : '') + '">' +
        `<input type="checkbox" value="${escapeHTML(p.key)}"${set.has(p.key) ? ' checked' : ''}>` +
        `<span class="plant-icon"><i class="ph-light ${escapeHTML(p.icon)} icon-sm"></i></span>` +
        `<span class="plant-label">${escapeHTML(p.label)}</span>` +
      '</label>'
    )).join("");
    grid.querySelectorAll('input[type="checkbox"]').forEach((el) => {
      el.addEventListener("change", () => {
        const key = el.value;
        const present = draft.plants.indexOf(key);
        if (el.checked && present === -1) draft.plants.push(key);
        if (!el.checked && present !== -1) draft.plants.splice(present, 1);
        el.closest(".plant-option").classList.toggle("checked", el.checked);
      });
    });
  }

  function openSettings() {
    draft = {
      location: state.prefs.location,
      soil: state.prefs.soil,
      plants: state.prefs.plants.slice(),
    };
    $("cfg-location").value = draft.location;
    renderSoilOptions();
    renderPlantOptions();
    $("settings-overlay").classList.remove("hidden");
  }
  function closeSettings() {
    $("settings-overlay").classList.add("hidden");
    draft = null;
  }
  async function saveSettings() {
    if (!draft) return closeSettings();
    draft.location = $("cfg-location").value.trim().slice(0, 120);
    try {
      const res = await fetch(withSfi("./api/save"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert("Couldn't save: " + (err.error || res.status));
        return;
      }
      closeSettings();
      await loadState();
    } catch (e) {
      alert("Couldn't save: " + (e && e.message ? e.message : String(e)));
    }
  }

  // ----- Bootstrap + push --------------------------------------------------------------
  async function loadState() {
    try {
      const res = await fetch(withSfi("./api/state"));
      if (!res.ok) {
        if (res.status === 403) {
          document.body.innerHTML =
            '<div class="note"><i class="ph-light ph-lock-simple icon-sm"></i> Forbidden.</div>';
          return;
        }
        throw new Error("state failed: " + res.status);
      }
      state = await res.json();
      render();
    } catch (e) {
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

  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "settings_changed") loadState();
  });

  // Refresh weather/statuses every 5 minutes — backend cache is 15min so most refreshes
  // are cheap, but this keeps the dial honest as forecasts roll forward.
  setInterval(loadState, 5 * 60 * 1000);

  loadState();
})();
