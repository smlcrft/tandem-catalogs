// ----------------------------------------------------------------------------------------
// Space Radio UI. Renders one of:
//   • Loading placeholder (initial)
//   • Private-frame notice (non-member, /api/state returned 403)
//   • Player shell (member) — station dropdown + transport + local-only volume / mute
//
// Shared state (station + playing) flows over /api/state and pushed radio_state events.
// Local state (volume + mute) is persisted server-side via /api/local-set, keyed by
// (sfi_id, device_id), so each user's preferences travel with their device and survive
// app restarts (the Tauri webview's localStorage doesn't reliably survive those).
// ----------------------------------------------------------------------------------------
(() => {
  const app = document.getElementById("app");
  const peer = window.__peer || {};
  const isSfiMember = peer.is_sfi_member === "1";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));

  let stations = [];
  let stationById = new Map();
  let playstate = { station_id: null, playing: false, updated_at: 0, updated_by_name: "" };

  // ---------------------------------------------------------------------------------------
  // LOCAL (per-user) STATE — persisted on the frame backend, keyed by (sfi_id, device_id).
  // The Tauri webview's localStorage doesn't reliably survive app restarts, so we round-trip
  // through /api/state (read) + /api/local-set (write, debounced). lastVolume is purely
  // in-memory — it just lets unmute restore the pre-mute level within a session.
  // First-run default is intentionally quiet (15%) — a radio that blasts on first play is
  // a worse first impression than one a user has to turn up. Server-side persisted state
  // overrides this on every subsequent load.
  // ---------------------------------------------------------------------------------------
  let volume = 15;
  let lastVolume = 15;
  let muted = false;

  // ---------------------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------------------
  function renderPrivate() {
    app.className = "sr-private";
    app.innerHTML = `
      <i class="ph-light ph-radio"></i>
      <div class="sr-private-title">Space Radio</div>
      <div class="sr-private-sub">This radio is private to the space. Ask the owner to invite you to the space to listen along.</div>
    `;
  }

  async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    const txt = await res.text();
    let json = null;
    try { json = txt ? JSON.parse(txt) : null; } catch { /* ignore */ }
    if (!res.ok) throw new Error((json && json.error) || `HTTP ${res.status}`);
    return json || {};
  }

  async function load() {
    if (!isSfiMember) { renderPrivate(); return; }
    let data;
    try {
      data = await fetchJson("./api/state");
    } catch (err) {
      if (String(err && err.message || "").indexOf("private frame") >= 0) {
        renderPrivate();
        return;
      }
      throw err;
    }
    stations = Array.isArray(data.stations) ? data.stations : [];
    stationById = new Map(stations.map((s) => [s.id, s]));
    playstate = { ...playstate, ...(data.playstate || {}) };

    // Apply server-persisted local volume/mute for this device. Server already clamped
    // and defaulted; we re-clamp defensively in case of an old/edited record on disk.
    const local = data.local || {};
    if (typeof local.volume === "number" && Number.isFinite(local.volume)) {
      volume = Math.max(0, Math.min(100, Math.trunc(local.volume)));
    }
    muted = local.muted === true;
    lastVolume = volume > 0 ? volume : 15;

    renderShell();
    applyAudioFromState({ resetSrc: true });
  }

  // Debounced write-back of this device's local volume/mute to the frame backend. Multiple
  // rapid +/− or mute clicks coalesce into a single POST after the user has stopped.
  let _localSaveTimer = null;
  function scheduleLocalSave() {
    clearTimeout(_localSaveTimer);
    _localSaveTimer = setTimeout(async () => {
      _localSaveTimer = null;
      try {
        await fetchJson("./api/local-set", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ volume, muted }),
        });
      } catch {
        // Best-effort persistence — failure just means next reload starts from defaults.
      }
    }, 600);
  }
  // Flush any pending local-state save when the page/iframe is being torn down so the
  // last volume tap before app close still reaches disk. sendBeacon is fire-and-forget
  // and survives unload, unlike a regular fetch.
  function flushLocalSaveOnExit() {
    if (_localSaveTimer === null) return;
    clearTimeout(_localSaveTimer);
    _localSaveTimer = null;
    try {
      const blob = new Blob([JSON.stringify({ volume, muted })], { type: "application/json" });
      navigator.sendBeacon("./api/local-set", blob);
    } catch { /* ignore */ }
  }
  window.addEventListener("pagehide", flushLocalSaveOnExit);
  window.addEventListener("beforeunload", flushLocalSaveOnExit);

  // ---------------------------------------------------------------------------------------
  // SHELL
  // ---------------------------------------------------------------------------------------
  function renderShell() {
    app.className = "sr-root";
    app.innerHTML = `
      <div class="sr-accent"></div>
      <div class="sr-topline">
        <span class="sr-title"><i class="ph-light ph-radio"></i> Space Radio</span>
        <span class="sr-spacer"></span>
        <span class="sr-live"><span class="dot"></span><span class="label">idle</span></span>
      </div>
      <div class="sr-body">
        <div class="sr-station">
          <select class="sr-station-select" id="sr-station">
            ${renderStationOptions()}
          </select>
        </div>
        <div class="sr-transport">
          <button class="sr-play" id="sr-play" title="play / pause" aria-label="play / pause">
            <i class="ph-light ph-play"></i>
          </button>
        </div>
        <div class="sr-meta" id="sr-meta"></div>
        <div class="sr-volume" id="sr-volume">
          <button class="sr-mute"   id="sr-mute"   title="mute / unmute" aria-label="mute"><i class="ph-light ph-speaker-high"></i></button>
          <button class="sr-voldn"  id="sr-voldn"  title="volume down"   aria-label="volume down"><i class="ph-light ph-minus"></i></button>
          <span class="sr-vol-readout" id="sr-vol-readout">--</span>
          <button class="sr-volup"  id="sr-volup"  title="volume up"     aria-label="volume up"><i class="ph-light ph-plus"></i></button>
        </div>
      </div>
      <div class="sr-footer">play state is shared — volume is yours alone</div>
      <audio id="sr-audio" preload="none"></audio>
    `;

    // Member-only: enable transport. Non-members already get the renderPrivate() branch
    // before we get here, but keep this explicit so future read-only modes are easy to add.
    const sel = document.getElementById("sr-station");
    sel.disabled = !isSfiMember;
    document.getElementById("sr-play").disabled = !isSfiMember;

    // Once <audio> emits `playing`, mark the session as autoplay-allowed and clear any
    // leftover hint. Subsequent play() rejections must then be non-autoplay causes, so
    // the enable-audio affordance suppresses itself for the rest of the session.
    const audioEl = document.getElementById("sr-audio");
    audioEl.addEventListener("playing", () => {
      audioHasEverPlayed = true;
      hideHint();
    });

    wireDropdown();
    wirePlay();
    wireVolume();
    syncDropdown();
    syncVolumeUi();
    renderMeta();
    renderLive();
  }

  function renderStationOptions() {
    if (stations.length === 0) return `<option value="">no stations</option>`;
    const byGenre = new Map();
    for (const s of stations) {
      const g = s.genre || "Other";
      if (!byGenre.has(g)) byGenre.set(g, []);
      byGenre.get(g).push(s);
    }
    let out = `<option value="">— choose a station —</option>`;
    for (const [genre, list] of byGenre.entries()) {
      out += `<optgroup label="${esc(genre)}">`;
      for (const s of list) {
        out += `<option value="${esc(s.id)}">${esc(s.name)}</option>`;
      }
      out += `</optgroup>`;
    }
    return out;
  }

  function syncDropdown() {
    const sel = document.getElementById("sr-station");
    if (!sel) return;
    sel.value = playstate.station_id || "";
  }

  function renderMeta() {
    const el = document.getElementById("sr-meta");
    if (!el) return;
    if (!playstate.station_id) {
      el.innerHTML = `<div class="sr-station-name">No station selected</div>
                      <div class="sr-by">${isSfiMember ? "pick a station to play it for everyone" : ""}</div>`;
      return;
    }
    const s = stationById.get(playstate.station_id);
    const name = s ? s.name : playstate.station_id;
    const verb = playstate.playing ? "playing" : "paused";
    const by = playstate.updated_by_name ? ` · ${verb} by ${esc(playstate.updated_by_name)}` : "";
    // sr-hint is a dual-purpose slot:
    //   • plain text errors (transient, hide after 4s) via showHint(msg)
    //   • an "enable audio" affordance when autoplay was blocked but the room is playing;
    //     clicking it retries audio.play() under a user gesture WITHOUT touching the
    //     shared room state (otherwise local-vs-room would flip-flop on every click).
    el.innerHTML = `<div class="sr-station-name">${esc(name)}</div>
                    <div class="sr-by">${verb}${by}</div>
                    <div class="sr-hint" id="sr-hint" hidden></div>`;
  }

  function renderLive() {
    const root = document.querySelector(".sr-root");
    if (!root) return;
    root.classList.toggle("is-playing", !!playstate.playing && !!playstate.station_id);
    const playBtn = document.getElementById("sr-play");
    if (playBtn) {
      playBtn.innerHTML = playstate.playing
        ? `<i class="ph-light ph-pause"></i>`
        : `<i class="ph-light ph-play"></i>`;
    }
    const liveLabel = document.querySelector(".sr-live .label");
    if (liveLabel) liveLabel.textContent = playstate.playing && playstate.station_id ? "live" : "idle";
  }

  // ---------------------------------------------------------------------------------------
  // TRANSPORT — every change pushes through /api/set so the backend broadcasts to peers.
  // ---------------------------------------------------------------------------------------
  function wireDropdown() {
    const sel = document.getElementById("sr-station");
    sel.addEventListener("change", async () => {
      if (!isSfiMember) return;
      const id = sel.value || null;
      // Changing the station auto-starts playback (the natural expectation for radio).
      // Empty selection clears + stops.
      try {
        await fetchJson("./api/set", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ station_id: id, playing: !!id }),
        });
      } catch (err) {
        // Snap dropdown back to authoritative state on failure.
        sel.value = playstate.station_id || "";
        showHint(err.message || "change failed");
      }
    });
  }

  function wirePlay() {
    const btn = document.getElementById("sr-play");
    btn.addEventListener("click", async () => {
      if (!isSfiMember) return;
      if (!playstate.station_id) return;
      const nextPlaying = !playstate.playing;
      try {
        await fetchJson("./api/set", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ playing: nextPlaying }),
        });
      } catch (err) {
        showHint(err.message || "toggle failed");
      }
    });
  }

  function wireVolume() {
    document.getElementById("sr-voldn").addEventListener("click", () => bumpVolume(-5));
    document.getElementById("sr-volup").addEventListener("click", () => bumpVolume(+5));
    document.getElementById("sr-mute").addEventListener("click", () => toggleMute());
  }

  function bumpVolume(delta) {
    // Bumping volume implicitly unmutes — matches every other player.
    muted = false;
    volume = Math.max(0, Math.min(100, volume + delta));
    if (volume > 0) lastVolume = volume;
    applyVolumeToAudio();
    syncVolumeUi();
    scheduleLocalSave();
  }

  function toggleMute() {
    if (muted) {
      muted = false;
      if (volume === 0) volume = lastVolume || 50;
    } else {
      muted = true;
      if (volume > 0) lastVolume = volume;
    }
    applyVolumeToAudio();
    syncVolumeUi();
    scheduleLocalSave();
  }

  function syncVolumeUi() {
    const wrap = document.getElementById("sr-volume");
    if (!wrap) return;
    wrap.classList.toggle("muted", muted);
    const readout = document.getElementById("sr-vol-readout");
    if (readout) readout.textContent = muted ? "muted" : (volume + "%");
    const muteBtn = document.getElementById("sr-mute");
    if (muteBtn) {
      const iconName = muted ? "speaker-x" : volume === 0 ? "speaker-x" : volume < 40 ? "speaker-low" : "speaker-high";
      muteBtn.innerHTML = `<i class="ph-light ph-${iconName}"></i>`;
    }
  }

  // ---------------------------------------------------------------------------------------
  // AUDIO — only this device's <audio> element makes sound. We apply playstate by:
  //   • setting src when station_id changes (or on first apply)
  //   • play() / pause() per playing flag
  //   • volume + muted always from local state
  // Browser autoplay restrictions can reject play() until the user has interacted; in that
  // case we surface the "enable audio on this device" button via showEnableAudio().
  // ---------------------------------------------------------------------------------------
  let appliedStationId = null;
  let appliedPlaying = false;
  // Tracks whether <audio> has ever fired the `playing` event in this session. Once it
  // has, the page has user-gesture credit for autoplay, so any subsequent play() rejection
  // is some other class of failure (network/decode/abort) — clicking "enable audio" would
  // not help, so we suppress the affordance entirely after the first successful play.
  let audioHasEverPlayed = false;
  function applyAudioFromState(opts) {
    const audio = document.getElementById("sr-audio");
    if (!audio) return;
    const opts_ = opts || {};
    const targetStation = playstate.station_id ? stationById.get(playstate.station_id) : null;
    const targetUrl = targetStation ? targetStation.url : "";

    // Re-arm the source on (a) explicit reset, (b) station change, or (c) paused→playing
    // transition. The transition case keeps every listener pinned to the live edge of the
    // stream — without it, resuming after a long pause replays stale buffered audio.
    const stationChanged = appliedStationId !== playstate.station_id;
    const justStartedPlaying = playstate.playing && !appliedPlaying;
    if (opts_.resetSrc || stationChanged || justStartedPlaying) {
      appliedStationId = playstate.station_id;
      if (targetUrl) {
        audio.src = targetUrl;
      } else {
        audio.removeAttribute("src");
        audio.load();
      }
    }
    appliedPlaying = !!playstate.playing;

    applyVolumeToAudio();

    if (playstate.playing && targetUrl) {
      const p = audio.play();
      if (p && typeof p.catch === "function") {
        p.catch((err) => {
          // Only show the affordance for the specific case it can actually resolve:
          // a NotAllowedError on a page that hasn't yet had a successful user-gesture
          // play. Network/decode/abort errors aren't fixed by clicking, and after the
          // first successful play the gesture credit means autoplay isn't the cause.
          if (!audioHasEverPlayed && err && err.name === "NotAllowedError") {
            showEnableAudio();
          }
        });
      }
    } else {
      audio.pause();
      hideHint();
    }
  }

  function applyVolumeToAudio() {
    const audio = document.getElementById("sr-audio");
    if (!audio) return;
    audio.volume = Math.max(0, Math.min(1, volume / 100));
    audio.muted = muted;
  }

  // Transient error / info message in the hint slot. Auto-hides; not a button.
  function showHint(msg) {
    const el = document.getElementById("sr-hint");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("sr-hint-action");
    el.hidden = false;
    clearTimeout(showHint._t);
    showHint._t = setTimeout(() => { el.hidden = true; }, 4000);
  }
  function hideHint() {
    const el = document.getElementById("sr-hint");
    if (!el) return;
    el.hidden = true;
    el.classList.remove("sr-hint-action");
    clearTimeout(showHint._t);
  }
  // Autoplay was blocked. Render a one-click affordance that retries audio.play() with a
  // real user gesture — without touching the room's shared playstate. Pressing the main
  // play button instead would pause for everyone, which is exactly what we want to avoid.
  function showEnableAudio() {
    const el = document.getElementById("sr-hint");
    if (!el) return;
    el.innerHTML = `<button type="button" class="sr-hint-btn">click to enable audio on this device</button>`;
    el.classList.add("sr-hint-action");
    el.hidden = false;
    clearTimeout(showHint._t);
    const btn = el.querySelector(".sr-hint-btn");
    btn.addEventListener("click", async () => {
      const audio = document.getElementById("sr-audio");
      try {
        await audio.play();
        hideHint();
      } catch {
        // Still blocked (rare — usually a single gesture is enough). Leave hint visible.
      }
    });
  }

  // ---------------------------------------------------------------------------------------
  // REALTIME — pushed playstate from frame.ts. Same object shape we receive from /api/state.
  // ---------------------------------------------------------------------------------------
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.type !== "radio_state") return;
    if (!d.playstate) return;
    const stationChanged = d.playstate.station_id !== playstate.station_id;
    playstate = { ...playstate, ...d.playstate };
    syncDropdown();
    renderMeta();
    renderLive();
    applyAudioFromState({ resetSrc: stationChanged });
  });

  load().catch((err) => {
    app.className = "sr-loading";
    app.textContent = "failed to load: " + (err && err.message || err);
  });
})();
