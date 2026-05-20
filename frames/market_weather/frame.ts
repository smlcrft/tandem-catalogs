// ----------------------------------------------------------------------------------------
// Market Weather — a turnout forecaster for outdoor commerce. Per-placement location lives
// in a single JSON file keyed by sfi_id. Open-Meteo is hit at most once every 15 minutes
// per location and the result is shared across all placements pointing at the same place.
//
// For each of the next 72 hours we compute a composite "expected turnout" score in
// [0..100] from independent factors that each return a score in [-1..+1]:
//
//   temp_comfort  — bell curve centered at 68°F, sigma ~10°F, with hard penalties below
//                   35°F and above 95°F (cold-discouragement + heat-danger zones).
//   precip        — 0 at no rain, drops to -1 at ~0.1 in/hr. Rain is the single biggest
//                   killer of farmers-market foot traffic, so this carries a heavy weight.
//   uv            — sunny-but-not-burning is a positive; >=10 is a negative.
//   daylight      — Open-Meteo's is_day flag. After dark, attendance at outdoor day-events
//                   collapses; vendors should stop counting on foot traffic.
//   wind          — small penalty above 10 mph, large above 20.
//   weekend       — Sat/Sun get a strong bonus; Friday a mild one; weekday daytimes a
//                   small penalty (most people are working).
//   hour_of_day   — bell curve favoring 10am–3pm, the typical farmers-market window.
//   seasonal      — compares the forecast against a 30-day rolling local mean. When the
//                   forecast is in the comfort band AND notably better than what the
//                   area has had ("first warm Saturday after a cold week", "cool break
//                   in a heatwave"), turnout gets a measurable bump because people are
//                   primed to come out.
//
// Weighted-mean composite, then mapped 50 + composite * 50 → percent. The frontend draws
// the bold composite line on top of faint per-factor strips so a vendor can read at a
// glance both "what should I expect" and "why is the curve dipping there".
// ----------------------------------------------------------------------------------------
import {
  log, parsePeerInfo, serveFileAtPath, serveHtmlShell,
  jsonReply, parseJsonBody, sanitizeText, pushToInstance,
  loadJsonFile, saveJsonFile,
} from "@frame-core";

// ----- Per-placement preferences (single JSON file) -------------------------------------
// A WeeklyEvent is a recurring window (one day-of-week + a start→end time) for which
// View A computes turnout stats whenever the next occurrence falls inside the 72-hour
// forecast horizon. Names are user-given (e.g., "Baking Day").
type WeeklyEvent = {
  id: string;
  name: string;
  day_of_week: number;  // 0=Sun … 6=Sat
  start_hh: number;     // 0..23
  start_mm: number;     // 0..59
  end_hh: number;       // 0..23
  end_mm: number;       // 0..59
};
type Prefs = { location: string; events: WeeklyEvent[] };
const DEFAULT_PREFS: Prefs = { location: "", events: [] };

const allPrefs: Record<string, Prefs> = loadJsonFile(
  import.meta.url, "prefs.json", {} as Record<string, Prefs>,
);

function sanitizeEvent(v: unknown): WeeklyEvent | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const clamp = (n: unknown, lo: number, hi: number): number => {
    const x = Math.floor(Number(n));
    if (!Number.isFinite(x)) return lo;
    return Math.max(lo, Math.min(hi, x));
  };
  const name = sanitizeText(r.name, 100);
  const day_of_week = clamp(r.day_of_week, 0, 6);
  const start_hh = clamp(r.start_hh, 0, 23);
  const start_mm = clamp(r.start_mm, 0, 59);
  const end_hh = clamp(r.end_hh, 0, 23);
  const end_mm = clamp(r.end_mm, 0, 59);
  // Stable id; if missing or malformed, generate one. We avoid relying on the client
  // to provide a globally-unique id — frame.ts is the source of truth here.
  const id = typeof r.id === "string" && r.id.length > 0 && r.id.length < 64
    ? sanitizeText(r.id, 64) : `ev_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  return { id, name, day_of_week, start_hh, start_mm, end_hh, end_mm };
}

function getPrefs(sfi_id: string): Prefs {
  const stored = allPrefs[sfi_id] ?? {} as Partial<Prefs>;
  const events = Array.isArray(stored.events)
    ? (stored.events.map(sanitizeEvent).filter((e): e is WeeklyEvent => e !== null))
    : [];
  return {
    location: typeof stored.location === "string" ? stored.location : DEFAULT_PREFS.location,
    events,
  };
}

function setPrefs(sfi_id: string, next: Prefs): void {
  allPrefs[sfi_id] = next;
  saveJsonFile(import.meta.url, "prefs.json", allPrefs);
}

// ----- Weather: shared 15-minute cache keyed by location string -------------------------
// Hourly entries cover [now - 30 days .. now + 72 hours]. The past 30 days build the
// "local norm" baseline used by the seasonal-pleasantness factor; the next 72 hours
// are what the turnout curve is computed over.
type HourEntry = {
  iso: string;        // ISO 8601 in the location's local timezone
  ms: number;         // unix ms of that local-clock instant (used only for chart x positions)
  t_f: number;        // temperature, °F
  precip_in: number;  // precipitation, inches per hour
  uv: number;         // UV index (0..11+)
  wind_mph: number;   // 10m wind, mph
  cloud_pct: number;  // cloud cover %
  is_day: number;     // 1/0 from Open-Meteo
};

type WeatherData = {
  resolved_name: string;
  timezone: string;
  utc_offset_seconds: number;
  past_hours: HourEntry[];
  forecast_hours: HourEntry[];        // strictly future, capped at ~72h
  past_30d_mean_temp_f: number;       // simple mean of past_hours temps
  daily_summary: { date: string; t_max: number; t_min: number; sunrise: string; sunset: string }[];
  fetched_at: number;
};

const weatherCache = new Map<string, WeatherData>();
const weatherInflight = new Map<string, Promise<WeatherData | null>>();
const WEATHER_TTL_MS = 15 * 60 * 1000;

function numArr(v: unknown): number[] {
  return Array.isArray(v) ? v.map(Number).map((n) => Number.isFinite(n) ? n : 0) : [];
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

async function fetchWeatherImpl(location: string): Promise<WeatherData | null> {
  try {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
    const geoRes = await fetch(geoUrl);
    if (!geoRes.ok) throw new Error(`geocoding failed: ${geoRes.status}`);
    const geoJson = await geoRes.json();
    const loc = geoJson.results?.[0];
    if (!loc) throw new Error(`location not found: "${location}"`);
    const { latitude, longitude, name, country, admin1 } = loc;

    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      hourly: "temperature_2m,precipitation,uv_index,wind_speed_10m,cloud_cover,is_day",
      daily: "temperature_2m_max,temperature_2m_min,sunrise,sunset",
      temperature_unit: "fahrenheit",
      wind_speed_unit: "mph",
      precipitation_unit: "inch",
      timezone: "auto",
      past_days: "30",
      // 4 calendar days of forecast (today + 3 more) covers a full 72-hour window even
      // when "now" is late in the local day — 3 days would only reach ~49h on those calls.
      forecast_days: "4",
    });
    const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!wRes.ok) throw new Error(`weather failed: ${wRes.status}`);
    const wJson = await wRes.json();

    const tz: string = typeof wJson.timezone === "string" ? wJson.timezone : "UTC";
    const utc_offset_seconds: number = Number(wJson.utc_offset_seconds) || 0;

    const hourly = wJson.hourly ?? {};
    const hTimes = strArr(hourly.time);
    const hT     = numArr(hourly.temperature_2m);
    const hP     = numArr(hourly.precipitation);
    const hUv    = numArr(hourly.uv_index);
    const hWind  = numArr(hourly.wind_speed_10m);
    const hCloud = numArr(hourly.cloud_cover);
    const hIsDay = numArr(hourly.is_day);

    // Open-Meteo returns timestamps as naive local-time strings ("2026-05-20T14:00") when
    // timezone=auto. We pin each hour to its absolute UTC instant by adding the location's
    // utc_offset_seconds — that way the chart can place hours correctly on a real timeline
    // regardless of where the viewer is.
    const nowMs = Date.now();
    const past_hours: HourEntry[] = [];
    const forecast_hours: HourEntry[] = [];
    const FORECAST_HORIZON_MS = 72 * 60 * 60 * 1000;
    for (let i = 0; i < hTimes.length; i++) {
      const iso = hTimes[i];
      // "2026-05-20T14:00" is parsed by Date.UTC-style construction as UTC; subtract the
      // offset to recover the absolute instant of that local clock time.
      const localUtcMs = Date.parse(iso + "Z");
      if (Number.isNaN(localUtcMs)) continue;
      const ms = localUtcMs - utc_offset_seconds * 1000;
      const entry: HourEntry = {
        iso,
        ms,
        t_f: hT[i] ?? 0,
        precip_in: hP[i] ?? 0,
        uv: hUv[i] ?? 0,
        wind_mph: hWind[i] ?? 0,
        cloud_pct: hCloud[i] ?? 0,
        is_day: hIsDay[i] ?? 0,
      };
      if (ms < nowMs - 30 * 60 * 1000) past_hours.push(entry);
      else if (ms <= nowMs + FORECAST_HORIZON_MS) forecast_hours.push(entry);
    }

    const past_30d_mean_temp_f = past_hours.length
      ? past_hours.reduce((sum, h) => sum + h.t_f, 0) / past_hours.length
      : 0;

    const daily = wJson.daily ?? {};
    const dDates  = strArr(daily.time);
    const dTmax   = numArr(daily.temperature_2m_max);
    const dTmin   = numArr(daily.temperature_2m_min);
    const dSunR   = strArr(daily.sunrise);
    const dSunS   = strArr(daily.sunset);
    const daily_summary = dDates.map((date, i) => ({
      date,
      t_max:   dTmax[i] ?? 0,
      t_min:   dTmin[i] ?? 0,
      sunrise: dSunR[i] ?? "",
      sunset:  dSunS[i] ?? "",
    }));

    const resolved_name = admin1 ? `${name}, ${admin1}` : `${name}, ${country}`;
    const data: WeatherData = {
      resolved_name,
      timezone: tz,
      utc_offset_seconds,
      past_hours,
      forecast_hours,
      past_30d_mean_temp_f,
      daily_summary,
      fetched_at: Date.now(),
    };
    log(`weather fetched | ${resolved_name} | past=${past_hours.length}h forecast=${forecast_hours.length}h mean30d=${past_30d_mean_temp_f.toFixed(1)}F`);
    return data;
  } catch (e) {
    log(`weather fetch error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function fetchWeather(location: string): Promise<WeatherData | null> {
  const key = location.trim().toLowerCase();
  if (!key) return null;
  const cached = weatherCache.get(key);
  if (cached && Date.now() - cached.fetched_at < WEATHER_TTL_MS) return cached;
  const inflight = weatherInflight.get(key);
  if (inflight) return inflight;
  const p = fetchWeatherImpl(location).finally(() => weatherInflight.delete(key));
  weatherInflight.set(key, p);
  const data = await p;
  if (data) weatherCache.set(key, data);
  return data;
}

// ----- Turnout factors ------------------------------------------------------------------
// Each factor returns a score in [-1..+1] for one hour. The weighted mean of these is
// the composite turnout signal. Weights are tuned for outdoor-commerce realism — a
// thunderstorm beats a sunny Tuesday at the same temperature; midnight beats noon with
// the same forecast, etc. — but they're plain numbers and easy to tweak.

const W = {
  temp:     1.5,
  precip:   2.2,    // bumped — rain is the single biggest practical turnout killer
  uv:      0.4,
  daylight: 1.2,
  wind:    0.5,
  weekend: 0.7,
  hour:    0.6,
  seasonal: 0.9,    // bumped — "unusually pleasant" days really do pull people out
};
const W_TOTAL = Object.values(W).reduce((a, b) => a + b, 0);

function tempComfortScore(t_f: number): number {
  // Smooth bell centered on 68°F with sigma 11°F → peak +1 at 68, ~0 at 49 or 87,
  // ~-1 at 35 or 100. Two hard floors enforce "people just don't come" in genuine
  // cold or dangerous heat regardless of what the bell says.
  const center = 68;
  const sigma  = 11;
  const x = (t_f - center) / sigma;
  let s = Math.exp(-x * x / 2) * 2 - 1;
  if (t_f <= 32) s = Math.min(s, -1);
  else if (t_f <= 40) s = Math.min(s, -0.7);
  if (t_f >= 100) s = Math.min(s, -1);
  else if (t_f >= 92) s = Math.min(s, -0.6);
  return Math.max(-1, Math.min(1, s));
}

function precipScore(precip_in_hr: number): number {
  // Any precip is a turnout headwind, and a meaningful one. Even a trace forecast
  // (<0.005"/hr — basically "expect drizzle") shaves -0.2 off because shoppers see
  // "rain in the forecast" and skip the trip. 0.05"/hr (steady drizzle) → ~-0.83,
  // 0.06"/hr+ saturates to -1. We treat snow the same way — Open-Meteo's precip
  // field is water-equivalent and the human reaction to "stuff falling out of the
  // sky" is similar at the threshold farmers markets care about.
  if (precip_in_hr <= 0.001) return 0;
  if (precip_in_hr < 0.005) return -0.2;
  return Math.max(-1, -precip_in_hr / 0.06);
}

function uvScore(uv: number): number {
  // Comfortable sunlight (3..6) is a small positive — people picture sunny markets.
  // Very high UV (>=10) is a small negative for prolonged outdoor browsing.
  if (uv >= 11) return -0.6;
  if (uv >= 9)  return -0.3;
  if (uv >= 7)  return 0;
  if (uv >= 3)  return 0.3;
  return 0;
}

function daylightScore(is_day: number): number {
  // is_day is 1 during civil daylight, 0 otherwise. Outdoor day-events lose almost
  // all walk-up traffic after dark; the dip should be sharp.
  return is_day === 1 ? 0.4 : -1;
}

function windScore(wind_mph: number): number {
  if (wind_mph >= 25) return -1;
  if (wind_mph >= 18) return -0.6;
  if (wind_mph >= 12) return -0.25;
  return 0;
}

function weekendScore(d: Date): number {
  const dow = d.getUTCDay(); // we constructed d from local-clock components below
  if (dow === 6) return 0.9;       // Saturday — peak market day
  if (dow === 0) return 0.7;       // Sunday
  if (dow === 5) return 0.25;      // Friday — small bump (people knock off early)
  return -0.2;                     // Mon–Thu — people are at work
}

function hourOfDayScore(hour: number): number {
  // Bell centered around 12:30pm, sigma 3.5h → peak +1 at midday, ~0 at 8am and 5pm,
  // strongly negative at the extremes. Captures the classic 10am-3pm market window.
  const center = 12.5;
  const sigma  = 3.5;
  const x = (hour - center) / sigma;
  return Math.max(-1, Math.min(1, Math.exp(-x * x / 2) * 2 - 1));
}

function seasonalScore(t_f: number, precip_in_hr: number, mean_past_30d_f: number): number {
  // Reward the kind of weather people *talk about*. A pleasant-band temperature
  // (60..80°F) is always a positive. If it follows a cold stretch (recent mean
  // <55°F) or breaks a hot stretch (>82°F) by a meaningful margin, the bonus jumps —
  // "first nice weekend of the year" or "cool break in the heat" pulls extra people
  // out of their houses.
  const inComfort = t_f >= 60 && t_f <= 80;
  const delta = t_f - mean_past_30d_f;
  let base = 0;
  if      (inComfort && mean_past_30d_f < 55 && delta > 8)   base = 1.0;
  else if (inComfort && mean_past_30d_f > 82 && delta < -8)  base = 1.0;
  else if (inComfort)                                        base = 0.6;
  else if (t_f < 50 && mean_past_30d_f > 70)                 base = -0.7;
  else if (t_f > 90 && mean_past_30d_f < 70)                 base = -0.7;

  // Rain undermines seasonal pleasantness regardless of temperature. Even a 72°F
  // afternoon stops reading as "let's go to the market" when it's raining on it.
  // Light drizzle (~0.01"/hr) chips into a positive base; steady rain (~0.04"/hr)
  // drives the seasonal contribution firmly negative.
  if (precip_in_hr > 0.005) {
    base += Math.max(-1.0, -precip_in_hr / 0.04);
  }
  return Math.max(-1, Math.min(1, base));
}

type FactorScores = {
  temp: number; precip: number; uv: number; daylight: number;
  wind: number; weekend: number; hour: number; seasonal: number;
};

// Build a Date object whose .getUTCHours()/.getUTCDay() correspond to the LOCAL clock
// at the forecast location. We use this rather than the viewer-local Date constructor
// because the chart and the day-of-week logic must agree on "what day is it where the
// market is", not "what day is it where the viewer is sitting".
function localClockDate(iso: string): Date {
  // ISO like "2026-05-23T14:00" — append "Z" so Date.parse treats it as UTC.
  return new Date(iso + "Z");
}

function scoreHour(h: HourEntry, mean_past_30d_f: number): { factors: FactorScores; composite: number; turnout_pct: number } {
  const d = localClockDate(h.iso);
  const hourOfDay = d.getUTCHours() + d.getUTCMinutes() / 60;

  const factors: FactorScores = {
    temp:     tempComfortScore(h.t_f),
    precip:   precipScore(h.precip_in),
    uv:       uvScore(h.uv),
    daylight: daylightScore(h.is_day),
    wind:     windScore(h.wind_mph),
    weekend:  weekendScore(d),
    hour:     hourOfDayScore(hourOfDay),
    seasonal: seasonalScore(h.t_f, h.precip_in, mean_past_30d_f),
  };

  const weighted =
      factors.temp     * W.temp     +
      factors.precip   * W.precip   +
      factors.uv       * W.uv       +
      factors.daylight * W.daylight +
      factors.wind     * W.wind     +
      factors.weekend  * W.weekend  +
      factors.hour     * W.hour     +
      factors.seasonal * W.seasonal;
  const composite = Math.max(-1, Math.min(1, weighted / W_TOTAL));
  const turnout_pct = Math.max(0, Math.min(100, 50 + composite * 50));
  return { factors, composite, turnout_pct };
}

type HourReading = HourEntry & {
  factors: FactorScores;
  composite: number;
  turnout_pct: number;
};

function scoreForecast(w: WeatherData): HourReading[] {
  return w.forecast_hours.map((h) => ({ ...h, ...scoreHour(h, w.past_30d_mean_temp_f) }));
}

// ----- HTTP handler ---------------------------------------------------------------------
self.onNetworkRequest = async (replyPort, reqPath, method, _h, query, body, cookies) => {
  const peer = parsePeerInfo(query, cookies);
  const isAnon  = peer.is_anon  === "1" || !peer.user_id;
  const isOwner = peer.is_owner === "1";

  if (reqPath === "/index.html" && method === "GET") {
    // The script is a separate ES module file so it can import /lib/js/framelib.js —
    // inlineJs would flatten the <script type="module"> to a non-module <script>,
    // which can't use ES module imports, so it's intentionally omitted here.
    return serveHtmlShell(replyPort, new URL("./public/index.html", import.meta.url), {
      peer,
      inlineCss: ["index.css"],
    });
  }

  // Market Weather is a vendor-planning tool — anonymous FAT visitors aren't the
  // audience and the location string could be sensitive. Fail closed on every API call.
  if (isAnon && reqPath.startsWith("/api/")) {
    return jsonReply(replyPort, 403, { error: "private frame" });
  }

  if (reqPath === "/api/state" && method === "GET") {
    const prefs = getPrefs(peer.sfi_id);
    const weather = prefs.location ? await fetchWeather(prefs.location) : null;
    const readings = weather ? scoreForecast(weather) : [];
    return jsonReply(replyPort, 200, {
      prefs,
      weather,
      readings,
      weights: W,
      is_owner: isOwner,
      now: Date.now(),
    });
  }

  if (reqPath === "/api/save" && method === "POST") {
    const v = parseJsonBody<{ location?: unknown; events?: unknown }>(body);
    if (!v) return jsonReply(replyPort, 400, { error: "invalid JSON" });
    // Events: drop anything that doesn't sanitize cleanly, cap the list at 32 so a
    // misbehaving / pasted-in payload can't blow up the prefs JSON.
    const events: WeeklyEvent[] = Array.isArray(v.events)
      ? (v.events.map(sanitizeEvent).filter((e): e is WeeklyEvent => e !== null).slice(0, 32))
      : [];
    const next: Prefs = {
      location: sanitizeText(v.location, 120),
      events,
    };
    setPrefs(peer.sfi_id, next);
    pushToInstance(peer.sfi_id, { type: "settings_changed" });
    return jsonReply(replyPort, 200, { prefs: next });
  }

  if (method === "GET") {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }
  replyPort.postMessage({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }) });
};

log("Market Weather frame is up.");
