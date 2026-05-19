// ----------------------------------------------------------------------------------------
// Space Radio — synced, shared web radio player for SFI members.
//
// Auth model: only `is_sfi_member` peers can read state or push changes. Non-members and
// anonymous visitors get a uniform private-frame notice — there is no public toggle,
// because the experience only makes sense for the group of people sitting in the space.
//
// Shared state per placement: { station_id, playing, updated_by_name, updated_at }, stored
// as JSON keyed by sfi_id. Any member can flip it; every change is broadcast to all viewers
// of the placement via pushToInstance() so audio elements stay in lockstep.
//
// Per-user state (volume / mute / last-volume) is kept entirely in the browser's
// localStorage — it never travels through the backend and is not synced across viewers.
// ----------------------------------------------------------------------------------------
import {
  log, parsePeerInfo, serveFileAtPath, serveHtmlShell, pushToInstance,
  jsonReply, parseJsonBody, sanitizeText,
  loadJsonFile, saveJsonFile,
} from "@frame-core";

// ----------------------------------------------------------------------------------------
// STATION CATALOG — embedded directly so a frame update can extend the list without any
// per-placement state migration. `genre` and `country` are display hints only; the `id`
// is the wire identifier so renaming a station's display name is non-breaking.
// ----------------------------------------------------------------------------------------
type Station = {
  id: string;
  name: string;
  genre: string;
  country: string;
  url: string;
};

const STATIONS: Station[] = [
  // ----- Ambient / Background -----
  { id: "somafm-groovesalad",    name: "SomaFM — Groove Salad",          genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/groovesalad-128-mp3" },
  { id: "somafm-dronezone",      name: "SomaFM — Drone Zone",            genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/dronezone-128-mp3" },
  { id: "somafm-deepspaceone",   name: "SomaFM — Deep Space One",        genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/deepspaceone-128-mp3" },
  { id: "somafm-spacestation",   name: "SomaFM — Space Station Soma",    genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/spacestation-128-mp3" },
  { id: "somafm-missioncontrol", name: "SomaFM — Mission Control",       genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/missioncontrol-128-mp3" },
  { id: "somafm-synphaera",      name: "SomaFM — Synphaera Radio",       genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/synphaera-128-mp3" },
  { id: "somafm-beatblender",    name: "SomaFM — Beat Blender",          genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/beatblender-128-mp3" },
  { id: "somafm-cliqhop",        name: "SomaFM — cliqhop idm",           genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/cliqhop-128-mp3" },
  { id: "somafm-suburbsofgoa",   name: "SomaFM — Suburbs of Goa",        genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/suburbsofgoa-128-mp3" },
  { id: "somafm-lush",           name: "SomaFM — Lush",                  genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/lush-128-mp3" },
  { id: "somafm-thetrip",        name: "SomaFM — The Trip",              genre: "Ambient & Background", country: "US", url: "https://ice1.somafm.com/thetrip-128-mp3" },
  { id: "kcrw-eclectic24",       name: "KCRW Eclectic 24",               genre: "Ambient & Background", country: "US", url: "https://kcrw.streamguys1.com/kcrw_192k_mp3_e24" },
  { id: "rp-mellow",             name: "Radio Paradise — Mellow Mix",    genre: "Ambient & Background", country: "US", url: "https://stream.radioparadise.com/mellow-128" },

  // ----- Indie / Pop -----
  { id: "somafm-indiepop",       name: "SomaFM — Indie Pop Rocks!",      genre: "Indie & Pop",          country: "US", url: "https://ice1.somafm.com/indiepop-128-mp3" },
  { id: "somafm-poptron",        name: "SomaFM — PopTron (electropop)",  genre: "Indie & Pop",          country: "US", url: "https://ice1.somafm.com/poptron-128-mp3" },
  { id: "somafm-bagel",          name: "SomaFM — Bagel Radio",           genre: "Indie & Pop",          country: "US", url: "https://ice1.somafm.com/bagel-128-mp3" },
  { id: "kexp",                  name: "KEXP Seattle",                   genre: "Indie & Pop",          country: "US", url: "https://kexp-mp3-128.streamguys1.com/kexp128.mp3" },
  { id: "wfmu-freeform",         name: "WFMU Freeform",                  genre: "Indie & Pop",          country: "US", url: "https://stream0.wfmu.org/freeform-128k.mp3" },
  { id: "wfmu-ichiban",          name: "WFMU Rock 'n' Soul Ichiban",     genre: "Indie & Pop",          country: "US", url: "https://stream0.wfmu.org/ichiban-128k.mp3" },
  { id: "thecurrent",            name: "The Current (MPR)",              genre: "Indie & Pop",          country: "US", url: "https://current.stream.publicradio.org/current.mp3" },

  // ----- Rock / Classic / Americana -----
  { id: "rp-main",               name: "Radio Paradise — Main Mix",      genre: "Rock & Classic",       country: "US", url: "https://stream.radioparadise.com/aac-128" },
  { id: "rp-rock",               name: "Radio Paradise — Rock Mix",      genre: "Rock & Classic",       country: "US", url: "https://stream.radioparadise.com/rock-128" },
  { id: "somafm-u80s",           name: "SomaFM — Underground 80s",       genre: "Rock & Classic",       country: "US", url: "https://ice1.somafm.com/u80s-128-mp3" },
  { id: "somafm-seventies",      name: "SomaFM — Left Coast 70s",        genre: "Rock & Classic",       country: "US", url: "https://ice1.somafm.com/seventies-128-mp3" },
  { id: "somafm-bootliquor",     name: "SomaFM — Boot Liquor (Americana)", genre: "Rock & Classic",     country: "US", url: "https://ice1.somafm.com/bootliquor-128-mp3" },
  { id: "somafm-folkfwd",        name: "SomaFM — Folk Forward",          genre: "Rock & Classic",       country: "US", url: "https://ice1.somafm.com/folkfwd-128-mp3" },
  { id: "somafm-reggae",         name: "SomaFM — Heavyweight Reggae",    genre: "Rock & Classic",       country: "US", url: "https://ice1.somafm.com/reggae-128-mp3" },
  { id: "somafm-metaldetektor",  name: "SomaFM — Metal Detektor",        genre: "Rock & Classic",       country: "US", url: "https://ice1.somafm.com/metal-128-mp3" },

  // ----- Jazz -----
  { id: "wbgo",                  name: "WBGO Jazz 88.3 (Newark)",        genre: "Jazz",                 country: "US", url: "https://wbgo.streamguys1.com/wbgo128" },
  { id: "kcsm",                  name: "KCSM Jazz 91",                   genre: "Jazz",                 country: "US", url: "https://ice5.securenetsystems.net/KCSM" },
  { id: "somafm-sonicuniverse",  name: "SomaFM — Sonic Universe (jazz)", genre: "Jazz",                 country: "US", url: "https://ice1.somafm.com/sonicuniverse-128-mp3" },
  { id: "somafm-7soul",          name: "SomaFM — 7soul (rare grooves)",  genre: "Jazz",                 country: "US", url: "https://ice1.somafm.com/7soul-128-mp3" },
  { id: "swiss-jazz",            name: "Radio Swiss Jazz",               genre: "Jazz",                 country: "CH", url: "https://stream.srg-ssr.ch/m/rsj/mp3_128" },
  { id: "abc-jazz",              name: "ABC Jazz",                       genre: "Jazz",                 country: "AU", url: "https://live-radio01.mediahubaustralia.com/PJZW/mp3/" },

  // ----- Chiptune / Synthwave / Retro -----
  { id: "nightride",             name: "Nightride FM (synthwave)",       genre: "Chiptune & Synthwave", country: "EU", url: "https://stream.nightride.fm/nightride.mp3" },
  { id: "datawave",              name: "Datawave (cyberpunk)",           genre: "Chiptune & Synthwave", country: "EU", url: "https://stream.nightride.fm/datawave.mp3" },
  { id: "spacesynth",            name: "Spacesynth",                     genre: "Chiptune & Synthwave", country: "EU", url: "https://stream.nightride.fm/spacesynth.mp3" },
  { id: "darksynth",             name: "Darksynth",                      genre: "Chiptune & Synthwave", country: "EU", url: "https://stream.nightride.fm/darksynth.mp3" },
  { id: "horrorsynth",           name: "Horrorsynth",                    genre: "Chiptune & Synthwave", country: "EU", url: "https://stream.nightride.fm/horrorsynth.mp3" },
  { id: "rainwave-chiptune",     name: "Rainwave — Chiptune",            genre: "Chiptune & Synthwave", country: "US", url: "https://relay0.us.rainwave.cc/chiptune.mp3" },
  { id: "rainwave-ocremix",      name: "Rainwave — OCRemix",             genre: "Chiptune & Synthwave", country: "US", url: "https://relay0.us.rainwave.cc/ocremix.mp3" },
  { id: "somafm-defcon",         name: "SomaFM — DEF CON Radio",         genre: "Chiptune & Synthwave", country: "US", url: "https://ice1.somafm.com/defcon-128-mp3" },
  { id: "somafm-vaporwaves",     name: "SomaFM — Vaporwaves",            genre: "Chiptune & Synthwave", country: "US", url: "https://ice1.somafm.com/vaporwaves-128-mp3" },

  // ----- French -----
  { id: "fip",                   name: "FIP",                            genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fip-midfi.mp3" },
  { id: "fip-rock",              name: "FIP Rock",                       genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fiprock-midfi.mp3" },
  { id: "fip-jazz",              name: "FIP Jazz",                       genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fipjazz-midfi.mp3" },
  { id: "fip-groove",            name: "FIP Groove",                     genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fipgroove-midfi.mp3" },
  { id: "fip-electro",           name: "FIP Electro",                    genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fipelectro-midfi.mp3" },
  { id: "fip-pop",               name: "FIP Pop",                        genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fippop-midfi.mp3" },
  { id: "fip-reggae",            name: "FIP Reggae",                     genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fipreggae-midfi.mp3" },
  { id: "fip-world",             name: "FIP Monde",                      genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fipworld-midfi.mp3" },
  { id: "fip-nouveautes",        name: "FIP Nouveautés",                 genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/fipnouveautes-midfi.mp3" },
  { id: "france-inter",          name: "France Inter",                   genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/franceinter-midfi.mp3" },
  { id: "france-musique",        name: "France Musique",                 genre: "French",               country: "FR", url: "https://icecast.radiofrance.fr/francemusique-midfi.mp3" },

  // ----- Italian -----
  { id: "rai-radio1",            name: "RAI Radio 1",                    genre: "Italian",              country: "IT", url: "https://icestreaming.rai.it/1.mp3" },
  { id: "rai-radio2",            name: "RAI Radio 2",                    genre: "Italian",              country: "IT", url: "https://icestreaming.rai.it/2.mp3" },
  { id: "rai-radio3",            name: "RAI Radio 3",                    genre: "Italian",              country: "IT", url: "https://icestreaming.rai.it/3.mp3" },
  { id: "rai-tuttaitaliana",     name: "RAI Radio Tutta Italiana",       genre: "Italian",              country: "IT", url: "https://icestreaming.rai.it/12.mp3" },
  { id: "rai-classica",          name: "RAI Radio Classica",             genre: "Italian",              country: "IT", url: "https://icestreaming.rai.it/5.mp3" },

  // ----- Spanish / Latin -----
  { id: "rne-radio3",            name: "Radio 3 (RNE, España)",          genre: "Spanish & Latin",      country: "ES", url: "https://crtvecanalplus.rtve.es/canalplus/r3.mp3" },
  { id: "los40",                 name: "LOS40 (España)",                 genre: "Spanish & Latin",      country: "ES", url: "https://19493.live.streamtheworld.com/LOS40.mp3" },
  { id: "cadena100",             name: "Cadena 100 (España)",            genre: "Spanish & Latin",      country: "ES", url: "https://playerservices.streamtheworld.com/api/livestream-redirect/CADENA100.mp3" },
  { id: "kane-fm",               name: "Cadena Dial (España)",           genre: "Spanish & Latin",      country: "ES", url: "https://playerservices.streamtheworld.com/api/livestream-redirect/CADENADIAL.mp3" },

  // ----- Mexican -----
  { id: "reactor-105",           name: "Reactor 105 (CDMX)",             genre: "Mexican",              country: "MX", url: "https://playerservices.streamtheworld.com/api/livestream-redirect/XHRED_FM.mp3" },
  { id: "alfa-919",              name: "Alfa 91.3 (CDMX)",               genre: "Mexican",              country: "MX", url: "https://playerservices.streamtheworld.com/api/livestream-redirect/XHFAJ_FM.mp3" },
  { id: "los40-mexico",          name: "LOS40 México",                   genre: "Mexican",              country: "MX", url: "https://playerservices.streamtheworld.com/api/livestream-redirect/XHMM_FM.mp3" },

  // ----- Australian -----
  { id: "abc-triplej",           name: "Triple J",                       genre: "Australian",           country: "AU", url: "https://live-radio01.mediahubaustralia.com/2TJW/mp3/" },
  { id: "abc-doublej",           name: "Double J",                       genre: "Australian",           country: "AU", url: "https://live-radio01.mediahubaustralia.com/DJDW/mp3/" },
  { id: "abc-unearthed",         name: "triple j Unearthed",             genre: "Australian",           country: "AU", url: "https://live-radio01.mediahubaustralia.com/UNEW/mp3/" },
  { id: "abc-classic",           name: "ABC Classic",                    genre: "Australian",           country: "AU", url: "https://live-radio01.mediahubaustralia.com/2FMW/mp3/" },
  { id: "abc-country",           name: "ABC Country",                    genre: "Australian",           country: "AU", url: "https://live-radio01.mediahubaustralia.com/CRWW/mp3/" },

  // ----- New Zealand -----
  { id: "rnz-national",          name: "RNZ National",                   genre: "New Zealand",          country: "NZ", url: "https://radio-streams.rnz.co.nz/national.mp3" },
  { id: "rnz-concert",           name: "RNZ Concert",                    genre: "New Zealand",          country: "NZ", url: "https://radio-streams.rnz.co.nz/concert.mp3" },

  // ----- NPR & Public Radio -----
  { id: "npr",                   name: "NPR Program Stream",             genre: "NPR & Public",         country: "US", url: "https://npr-ice.streamguys1.com/live.mp3" },
  { id: "wnyc-fm",               name: "WNYC FM 93.9",                   genre: "NPR & Public",         country: "US", url: "https://fm939.wnyc.org/wnycfm.mp3" },
  { id: "wnyc-am",               name: "WNYC AM 820",                    genre: "NPR & Public",         country: "US", url: "https://am820.wnyc.org/wnycam.mp3" },
  { id: "kqed",                  name: "KQED 88.5 (San Francisco)",      genre: "NPR & Public",         country: "US", url: "https://streams2.kqed.org/kqedradio" },
  { id: "wbur",                  name: "WBUR (Boston)",                  genre: "NPR & Public",         country: "US", url: "https://audio.wbur.org/stream/live_mp3" },

  // ----- World / Eclectic -----
  { id: "rp-world",              name: "Radio Paradise — World/Etc",     genre: "World & Eclectic",     country: "US", url: "https://stream.radioparadise.com/world-etc-128" },
  { id: "swiss-classic",         name: "Radio Swiss Classic",            genre: "World & Eclectic",     country: "CH", url: "https://stream.srg-ssr.ch/m/rsc_de/mp3_128" },
  { id: "swiss-pop",             name: "Radio Swiss Pop",                genre: "World & Eclectic",     country: "CH", url: "https://stream.srg-ssr.ch/m/rsp/mp3_128" },
  { id: "somafm-secretagent",    name: "SomaFM — Secret Agent",          genre: "World & Eclectic",     country: "US", url: "https://ice1.somafm.com/secretagent-128-mp3" },
  { id: "somafm-illstreet",      name: "SomaFM — Illinois Street Lounge", genre: "World & Eclectic",    country: "US", url: "https://ice1.somafm.com/illstreet-128-mp3" },
  { id: "somafm-fluid",          name: "SomaFM — Fluid",                 genre: "World & Eclectic",     country: "US", url: "https://ice1.somafm.com/fluid-128-mp3" },
];

const STATION_INDEX = new Set(STATIONS.map((s) => s.id));

// ----------------------------------------------------------------------------------------
// PER-PLACEMENT STATE — single JSON file keyed by sfi_id. Each entry holds:
//   • The shared playstate (station + playing + who last changed it), broadcast to all
//     viewers of the placement.
//   • A per-device map of local volume/mute settings (`local_by_device`). The Tauri
//     webview's localStorage doesn't survive app restarts reliably, so we round-trip
//     local state through the frame backend instead. Each device_id gets its own slot,
//     so siblings on the same account keep independent volumes.
// ----------------------------------------------------------------------------------------
type Playstate = {
  station_id: string | null;
  playing: boolean;
  updated_at: number;
  updated_by_name: string;
};
const DEFAULT_PLAYSTATE: Playstate = {
  station_id: null,
  playing: false,
  updated_at: 0,
  updated_by_name: "",
};

type LocalState = { volume: number; muted: boolean };
const DEFAULT_LOCAL: LocalState = { volume: 15, muted: false };

type SfiRecord = Playstate & {
  local_by_device: Record<string, LocalState>;
};

// On-disk records may pre-date `local_by_device`; getRecord normalizes.
const allRecords: Record<string, Partial<SfiRecord>> = loadJsonFile(import.meta.url, "playstate.json", {});

function getRecord(sfiId: string): SfiRecord {
  const r = allRecords[sfiId] ?? {};
  return {
    ...DEFAULT_PLAYSTATE,
    ...r,
    local_by_device: r.local_by_device ?? {},
  };
}
function getPlaystate(sfiId: string): Playstate {
  const r = getRecord(sfiId);
  return {
    station_id: r.station_id,
    playing: r.playing,
    updated_at: r.updated_at,
    updated_by_name: r.updated_by_name,
  };
}
function getLocalState(sfiId: string, deviceId: string): LocalState {
  if (!deviceId) return { ...DEFAULT_LOCAL };
  const r = allRecords[sfiId];
  const entry = r?.local_by_device?.[deviceId];
  return { ...DEFAULT_LOCAL, ...(entry ?? {}) };
}

// Update the shared playstate while preserving the per-device local map.
function setPlaystate(sfiId: string, next: Playstate): void {
  const cur = getRecord(sfiId);
  allRecords[sfiId] = { ...next, local_by_device: cur.local_by_device };
  saveJsonFile(import.meta.url, "playstate.json", allRecords);
}
// Update one device's local volume/mute. Other clients never see this — it's purely a
// persistence layer for the client's own state, scoped to (sfi_id, device_id).
function setLocalState(sfiId: string, deviceId: string, next: LocalState): void {
  if (!sfiId || !deviceId) return;
  const cur = getRecord(sfiId);
  cur.local_by_device = { ...cur.local_by_device, [deviceId]: next };
  allRecords[sfiId] = cur;
  saveJsonFile(import.meta.url, "playstate.json", allRecords);
}

// ----------------------------------------------------------------------------------------
// HANDLER
// ----------------------------------------------------------------------------------------
self.onNetworkRequest = async (replyPort, reqPath, method, _headers, query, body, cookies) => {
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;
  const isSfiMember = peer.is_sfi_member === "1";

  // UI shell — served to everyone. Non-members render a private-frame notice client-side
  // after /api/state returns 403, matching the pattern other private frames use.
  if (reqPath === "/index.html" && method === "GET") {
    return serveHtmlShell(replyPort, new URL("./public/index.html", import.meta.url), {
      peer,
      inlineCss: ["index.css"],
      inlineJs: ["index.js"],
    });
  }

  // Member-only API. There's no public-toggle for this frame: a shared audio experience
  // only meaningfully applies to the people already in the space.
  if (!isSfiMember && reqPath.startsWith("/api/")) {
    return jsonReply(replyPort, 403, { error: "private frame" });
  }

  if (reqPath === "/api/state" && method === "GET") {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
    return jsonReply(replyPort, 200, {
      stations: STATIONS,
      playstate: getPlaystate(sfiId),
      // Per-device local volume/mute for the requesting device. Falls back to
      // DEFAULT_LOCAL (volume 15, not muted) when no row exists yet.
      local: getLocalState(sfiId, peer.device_id),
      me: { user_id: peer.user_id, user_name: peer.user_name, device_id: peer.device_id },
    });
  }

  // Save this device's local volume/mute. Body fields are optional: omitted = preserve.
  // Never broadcast — local state is private to one (sfi_id, device_id) slot.
  if (reqPath === "/api/local-set" && method === "POST") {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
    if (!peer.device_id) return jsonReply(replyPort, 400, { error: "device_id missing" });
    const v = parseJsonBody<{ volume?: unknown; muted?: unknown }>(body);
    const cur = getLocalState(sfiId, peer.device_id);
    let volume = cur.volume;
    if (Object.prototype.hasOwnProperty.call(v ?? {}, "volume")) {
      const n = Number(v?.volume);
      if (Number.isFinite(n)) volume = Math.max(0, Math.min(100, Math.trunc(n)));
    }
    let muted = cur.muted;
    if (Object.prototype.hasOwnProperty.call(v ?? {}, "muted")) {
      muted = v?.muted === true;
    }
    const next: LocalState = { volume, muted };
    setLocalState(sfiId, peer.device_id, next);
    return jsonReply(replyPort, 200, { ok: true, local: next });
  }

  // Set station and/or playing. Both fields are optional in the body — omitted fields
  // preserve the current value, so the UI can toggle just play/pause without re-sending
  // the station id. An empty / null station_id explicitly clears the station and forces
  // playing=false (you can't be "playing nothing").
  if (reqPath === "/api/set" && method === "POST") {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
    const v = parseJsonBody<{ station_id?: unknown; playing?: unknown }>(body);
    const cur = getPlaystate(sfiId);

    let stationId: string | null = cur.station_id;
    if (Object.prototype.hasOwnProperty.call(v ?? {}, "station_id")) {
      const raw = v?.station_id;
      if (raw === null || raw === "") {
        stationId = null;
      } else {
        const sid = sanitizeText(raw, 80);
        if (!STATION_INDEX.has(sid)) return jsonReply(replyPort, 400, { error: "unknown station" });
        stationId = sid;
      }
    }

    let playing = cur.playing;
    if (Object.prototype.hasOwnProperty.call(v ?? {}, "playing")) {
      playing = v?.playing === true;
    }
    if (!stationId) playing = false;

    const userName = sanitizeText(peer.user_name, 80) || "user";
    const next: Playstate = {
      station_id: stationId,
      playing,
      updated_at: Date.now(),
      updated_by_name: userName,
    };
    setPlaystate(sfiId, next);
    pushToInstance(sfiId, { type: "radio_state", sfi_id: sfiId, playstate: next });
    return jsonReply(replyPort, 200, { ok: true, playstate: next });
  }

  if (method === "GET") {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }
  replyPort.postMessage({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }) });
};

log("Space Radio frame is up.");
