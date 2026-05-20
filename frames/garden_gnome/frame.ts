// ----------------------------------------------------------------------------------------
// Garden Gnome — at-a-glance home garden helper. Per-placement prefs (location, soil,
// chosen plants) live in a single JSON file keyed by sfi_id. Open-Meteo is hit at most
// once every 15 minutes per location and the result is shared across all placements
// pointing at the same place. Each ticked plant gets three color-coded dots on a +/-
// spectrum (water, temperature, sunlight) so the gardener can see at a glance whether
// nature is doing the work or whether the plant needs a hand.
//
// Time-weighting model:
//   - Water  → soil-moisture bucket simulation. Walks past 5 days + forecast 24h day by
//              day: each step adds rain and subtracts evapotranspiration (driven by that
//              day's temperature + UV). Recent rain matters more *as a consequence* of
//              the physics — old rain has had more days to dry off. Soil type tunes both
//              total capacity and the ET rate (sandy dries fast, clay holds tight).
//   - Temp   → exponential-decay weighted mean of daily means, ~2-day half-life, with
//              the next-24h forecast riding alongside the most-recent past day.
//   - Sun    → same decay applied to daily peak UV plus the forecast 24h UV peak.
//
// Risk badges flag catastrophic conditions that the dot alone can't communicate (a
// FREEZE risk dragging into a 60°F rolling average still leaves the temp dot looking
// fine, even though tomatoes are about to die). Each plant carries its own
// freeze_risk_f and heat_risk_f; DROUGHT / WATERLOGGED are derived from soil moisture
// vs. the plant's weekly water band.
// ----------------------------------------------------------------------------------------
import {
  log, parsePeerInfo, serveFileAtPath, serveHtmlShell,
  jsonReply, parseJsonBody, sanitizeText, pushToInstance,
  loadJsonFile, saveJsonFile,
} from "@frame-core";

// ----- Plant catalog --------------------------------------------------------------------
type PlantKey =
  | "tomatoes"               | "potatoes"               | "herbs"        | "onions"
  | "peppers"                | "carrots"                | "greens"       | "beans"
  | "squash"                 | "strawberries"           | "corn"         | "lavender"
  | "flowers"                | "fruit_trees"            | "bush_berries" | "cucumber_melon"
  | "seedlings_cold_hardy"   | "seedlings_temperate";

const PLANT_TYPES: { key: PlantKey; label: string; icon: string }[] = [
  { key: "seedlings_cold_hardy", label: "Seedlings (cool)",       icon: "ph-potted-plant" },
  { key: "seedlings_temperate",  label: "Seedlings (temperate)",  icon: "ph-flower-lotus" },
  { key: "tomatoes",             label: "Tomatoes",               icon: "ph-circle" },
  { key: "potatoes",             label: "Potatoes",               icon: "ph-egg" },
  { key: "herbs",                label: "Herbs",                  icon: "ph-leaf" },
  { key: "onions",               label: "Onions",                 icon: "ph-circle-half" },
  { key: "peppers",              label: "Peppers",                icon: "ph-pepper" },
  { key: "carrots",              label: "Carrots",                icon: "ph-carrot" },
  { key: "greens",               label: "Salad greens",           icon: "ph-plant" },
  { key: "beans",                label: "Beans",                  icon: "ph-coffee-bean" },
  { key: "squash",               label: "Squash",                 icon: "ph-orange" },
  { key: "cucumber_melon",       label: "Cucumber & melons",      icon: "ph-orange-slice" },
  { key: "strawberries",         label: "Strawberries",           icon: "ph-cherries" },
  { key: "bush_berries",         label: "Bush berries",           icon: "ph-circles-three" },
  { key: "corn",                 label: "Corn",                   icon: "ph-grains" },
  { key: "lavender",             label: "Lavender",               icon: "ph-flower-tulip" },
  { key: "flowers",              label: "Flowers",                icon: "ph-flower" },
  { key: "fruit_trees",          label: "Fruit trees",            icon: "ph-tree" },
];

// Per-plant ideal bands plus catastrophic thresholds.
//   water_per_week_in : weekly water need; the simulation's soil-moisture ideal band is
//                       derived from this (~half-week reserve at the low end, ~1.5-week
//                       reserve at the high end).
//   avg_temp_f        : rolling daily-mean comfort band.
//   max_uv            : daily peak UV comfort band.
//   freeze_risk_f     : at or below this temperature → FREEZE callout. Tomatoes / peppers
//                       are damaged well above 32°F; cool-season crops shrug off light
//                       frosts; lavender is wood-hardy down into the teens.
//   heat_risk_f       : at or above this temperature → HEAT STRESS callout. Cool-season
//                       crops bolt early in the 80s; heat-lovers tolerate triple digits.
type PlantProfile = {
  water_per_week_in: [number, number];
  avg_temp_f:        [number, number];
  max_uv:            [number, number];
  freeze_risk_f:     number;
  heat_risk_f:       number;
};

const PLANT_PROFILES: Record<PlantKey, PlantProfile> = {
  // Seedlings have shallow roots and unhardened tissue — tighter bands across all three
  // axes and stricter freeze/heat callout thresholds than the mature equivalents.
  seedlings_cold_hardy: { water_per_week_in: [0.8, 1.4], avg_temp_f: [50, 65], max_uv: [2, 6],  freeze_risk_f: 30, heat_risk_f: 80  },
  seedlings_temperate:  { water_per_week_in: [1.0, 1.6], avg_temp_f: [65, 78], max_uv: [3, 7],  freeze_risk_f: 48, heat_risk_f: 88  },
  tomatoes:             { water_per_week_in: [1.0, 2.0], avg_temp_f: [60, 85], max_uv: [4, 9],  freeze_risk_f: 40, heat_risk_f: 95  },
  potatoes:             { water_per_week_in: [1.0, 2.0], avg_temp_f: [55, 75], max_uv: [3, 8],  freeze_risk_f: 32, heat_risk_f: 90  },
  herbs:                { water_per_week_in: [0.5, 1.5], avg_temp_f: [60, 80], max_uv: [4, 9],  freeze_risk_f: 32, heat_risk_f: 95  },
  onions:               { water_per_week_in: [1.0, 1.5], avg_temp_f: [55, 75], max_uv: [4, 9],  freeze_risk_f: 28, heat_risk_f: 90  },
  peppers:              { water_per_week_in: [1.0, 1.5], avg_temp_f: [65, 88], max_uv: [5, 10], freeze_risk_f: 45, heat_risk_f: 100 },
  carrots:              { water_per_week_in: [1.0, 1.5], avg_temp_f: [55, 75], max_uv: [3, 8],  freeze_risk_f: 28, heat_risk_f: 90  },
  greens:               { water_per_week_in: [1.0, 2.0], avg_temp_f: [50, 70], max_uv: [3, 7],  freeze_risk_f: 28, heat_risk_f: 85  },
  beans:                { water_per_week_in: [1.0, 1.5], avg_temp_f: [60, 80], max_uv: [4, 9],  freeze_risk_f: 40, heat_risk_f: 95  },
  squash:               { water_per_week_in: [1.5, 2.5], avg_temp_f: [65, 85], max_uv: [4, 9],  freeze_risk_f: 40, heat_risk_f: 100 },
  cucumber_melon:       { water_per_week_in: [1.5, 2.5], avg_temp_f: [65, 88], max_uv: [5, 10], freeze_risk_f: 50, heat_risk_f: 100 },
  strawberries:         { water_per_week_in: [1.0, 1.5], avg_temp_f: [55, 75], max_uv: [3, 8],  freeze_risk_f: 30, heat_risk_f: 90  },
  bush_berries:         { water_per_week_in: [1.0, 2.0], avg_temp_f: [55, 80], max_uv: [4, 9],  freeze_risk_f: 25, heat_risk_f: 95  },
  corn:                 { water_per_week_in: [1.0, 2.0], avg_temp_f: [65, 85], max_uv: [5, 10], freeze_risk_f: 40, heat_risk_f: 100 },
  lavender:             { water_per_week_in: [0.2, 0.8], avg_temp_f: [60, 85], max_uv: [5, 11], freeze_risk_f: 15, heat_risk_f: 105 },
  flowers:              { water_per_week_in: [0.5, 1.5], avg_temp_f: [55, 80], max_uv: [4, 9],  freeze_risk_f: 32, heat_risk_f: 95  },
  fruit_trees:          { water_per_week_in: [1.0, 2.0], avg_temp_f: [50, 85], max_uv: [4, 10], freeze_risk_f: 20, heat_risk_f: 100 },
};

// ----- Soil types -----------------------------------------------------------------------
// retention_factor scales recent rainfall to "how much of it is still available to roots".
// Sandy drains away; clay holds tight. Loamy is the gardener's baseline (=1.0).
type SoilKey = "sandy" | "loamy" | "clay" | "silty" | "chalky";

const SOIL_TYPES: { key: SoilKey; label: string; description: string; retention_factor: number }[] = [
  { key: "sandy",  label: "Sandy",  description: "Gritty, drains fast — water passes through quickly", retention_factor: 0.6 },
  { key: "loamy",  label: "Loamy",  description: "Balanced — the gardener's baseline",                  retention_factor: 1.0 },
  { key: "silty",  label: "Silty",  description: "Smooth, holds moisture well",                         retention_factor: 1.2 },
  { key: "clay",   label: "Clay",   description: "Heavy, holds onto water — slow to drain",             retention_factor: 1.4 },
  { key: "chalky", label: "Chalky", description: "Stony, alkaline, drains quickly",                     retention_factor: 0.7 },
];

// ----- Per-placement preferences (single JSON file) -------------------------------------
type Prefs = {
  location: string;
  soil: SoilKey;
  plants: PlantKey[];
};

const DEFAULT_PREFS: Prefs = { location: "", soil: "loamy", plants: [] };

const allPrefs: Record<string, Prefs> = loadJsonFile(
  import.meta.url, "prefs.json", {} as Record<string, Prefs>,
);

const PLANT_KEY_SET = new Set<string>(PLANT_TYPES.map((p) => p.key));
const SOIL_KEY_SET  = new Set<string>(SOIL_TYPES.map((s) => s.key));

function getPrefs(sfi_id: string): Prefs {
  const stored = allPrefs[sfi_id] ?? {} as Partial<Prefs>;
  const soilRaw = typeof stored.soil === "string" ? stored.soil : DEFAULT_PREFS.soil;
  const soil: SoilKey = SOIL_KEY_SET.has(soilRaw) ? (soilRaw as SoilKey) : DEFAULT_PREFS.soil;
  const plants: PlantKey[] = Array.isArray(stored.plants)
    ? (stored.plants.filter((p): p is PlantKey => typeof p === "string" && PLANT_KEY_SET.has(p)))
    : [];
  return {
    location: typeof stored.location === "string" ? stored.location : "",
    soil,
    plants,
  };
}

function setPrefs(sfi_id: string, next: Prefs): void {
  allPrefs[sfi_id] = next;
  saveJsonFile(import.meta.url, "prefs.json", allPrefs);
}

// ----- Weather: shared 15-minute cache keyed by location string -------------------------
type DailyEntry  = { date: string; t_max: number; t_min: number; t_mean: number; rain_in: number; uv_max: number };
type HourlyEntry = { hour: string; t: number; precip: number; uv: number };

type WeatherSummary = {
  avg_temp_f: number;            // mean of past 5 days' daily means
  max_temp_f: number;            // hottest daily-max from past 5 days
  min_temp_f: number;            // coldest daily-min from past 5 days
  rain_past_5d_in: number;       // total rainfall, past 5 days
  current_temp_f: number;        // Open-Meteo "current" reading at fetch time
  current_precip_in: number;     // precipitation rate in the current observation
  forecast_24h_mean_temp: number; // mean of next 24 hourly temps
  forecast_24h_max_temp: number;  // peak of next 24 hourly temps (heat-spike awareness)
  forecast_24h_min_temp: number;  // dip of next 24 hourly temps (freeze-spike awareness)
  forecast_24h_rain: number;     // sum of next 24 hourly precip
  avg_uv_max: number;            // mean of past 5 days' daily peak UV
  peak_uv: number;               // hottest daily peak UV from past 5 days
};

type WeatherData = {
  resolved_name: string;
  past_days: DailyEntry[];
  forecast_24h: HourlyEntry[];
  summary: WeatherSummary;
  fetched_at: number;
};

const weatherCache = new Map<string, WeatherData>();
const weatherInflight = new Map<string, Promise<WeatherData | null>>();
const WEATHER_TTL_MS = 15 * 60 * 1000;

function avg(a: number[]): number { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function sumNums(a: number[]): number { return a.reduce((x, y) => x + y, 0); }
function numArr(v: unknown): number[] {
  return Array.isArray(v) ? v.map(Number).map((n) => Number.isFinite(n) ? n : 0) : [];
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
      current: "temperature_2m,precipitation",
      daily: "temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,uv_index_max",
      hourly: "temperature_2m,precipitation,uv_index",
      temperature_unit: "fahrenheit",
      precipitation_unit: "inch",
      timezone: "auto",
      past_days: "5",
      forecast_days: "2",
    });
    const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!wRes.ok) throw new Error(`weather failed: ${wRes.status}`);
    const wJson = await wRes.json();

    const daily = wJson.daily ?? {};
    const dDates: string[] = Array.isArray(daily.time) ? daily.time : [];
    const dTmax  = numArr(daily.temperature_2m_max);
    const dTmin  = numArr(daily.temperature_2m_min);
    const dTmean = numArr(daily.temperature_2m_mean);
    const dRain  = numArr(daily.precipitation_sum);
    const dUv    = numArr(daily.uv_index_max);

    const past_days: DailyEntry[] = [];
    for (let i = 0; i < Math.min(5, dDates.length); i++) {
      past_days.push({
        date: dDates[i],
        t_max:   dTmax[i]  ?? 0,
        t_min:   dTmin[i]  ?? 0,
        t_mean:  dTmean[i] ?? 0,
        rain_in: dRain[i]  ?? 0,
        uv_max:  dUv[i]    ?? 0,
      });
    }

    const hourly = wJson.hourly ?? {};
    const hTimes: string[] = Array.isArray(hourly.time) ? hourly.time : [];
    const hT  = numArr(hourly.temperature_2m);
    const hP  = numArr(hourly.precipitation);
    const hUv = numArr(hourly.uv_index);

    const nowMs = Date.now();
    const forecast_24h: HourlyEntry[] = [];
    for (let i = 0; i < hTimes.length; i++) {
      const t = new Date(hTimes[i]).getTime();
      if (Number.isNaN(t)) continue;
      if (t < nowMs - 60 * 60 * 1000) continue;
      if (t > nowMs + 24 * 60 * 60 * 1000) continue;
      forecast_24h.push({ hour: hTimes[i], t: hT[i] ?? 0, precip: hP[i] ?? 0, uv: hUv[i] ?? 0 });
    }

    const past5_means = past_days.map((d) => d.t_mean);
    const past5_max   = past_days.map((d) => d.t_max);
    const past5_min   = past_days.map((d) => d.t_min);
    const past5_rain  = past_days.map((d) => d.rain_in);
    const past5_uv    = past_days.map((d) => d.uv_max);
    const f24_t       = forecast_24h.map((h) => h.t);
    const f24_p       = forecast_24h.map((h) => h.precip);

    const current = (wJson.current ?? {}) as Record<string, unknown>;
    const currentTempRaw   = Number(current.temperature_2m);
    const currentPrecipRaw = Number(current.precipitation);
    const currentTemp = Number.isFinite(currentTempRaw)
      ? currentTempRaw
      : (f24_t.length ? f24_t[0] : avg(past5_means));
    const currentPrecip = Number.isFinite(currentPrecipRaw) ? currentPrecipRaw : 0;

    const summary: WeatherSummary = {
      avg_temp_f:             avg(past5_means),
      max_temp_f:             past5_max.length ? Math.max(...past5_max) : 0,
      min_temp_f:             past5_min.length ? Math.min(...past5_min) : 0,
      rain_past_5d_in:        sumNums(past5_rain),
      current_temp_f:         currentTemp,
      current_precip_in:      currentPrecip,
      forecast_24h_mean_temp: avg(f24_t),
      forecast_24h_max_temp:  f24_t.length ? Math.max(...f24_t) : 0,
      forecast_24h_min_temp:  f24_t.length ? Math.min(...f24_t) : 0,
      forecast_24h_rain:      sumNums(f24_p),
      avg_uv_max:             avg(past5_uv),
      peak_uv:                past5_uv.length ? Math.max(...past5_uv) : 0,
    };
    const resolved_name = admin1 ? `${name}, ${admin1}` : `${name}, ${country}`;
    const data: WeatherData = { resolved_name, past_days, forecast_24h, summary, fetched_at: Date.now() };
    log(`weather fetched | ${resolved_name}`);
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
  // Coalesce concurrent fetches so a burst of viewers doesn't hammer Open-Meteo.
  const inflight = weatherInflight.get(key);
  if (inflight) return inflight;
  const p = fetchWeatherImpl(location).finally(() => weatherInflight.delete(key));
  weatherInflight.set(key, p);
  const data = await p;
  if (data) weatherCache.set(key, data);
  return data;
}

// ----- Indicator scoring ---------------------------------------------------------------
// Continuous score, anchored to the plant's ideal band:
//   value at ideal_lo → -1   (lower edge of band)
//   value at ideal_hi → +1   (upper edge of band)
//   linear in between, so two plants in their ideal range still differ if their
//   ideal bands differ — even small numeric differences move the marker.
//   Outside the band the line continues at the same slope (one band-width below
//   ideal_lo → -2, one band-width above ideal_hi → +2) and clamps at ±2 so a 0"
//   total or a 100°F heat wave doesn't run the marker off the bar.

function scoreContinuous(value: number, ideal_lo: number, ideal_hi: number): number {
  const band = Math.max(0.001, ideal_hi - ideal_lo);
  if (value <= ideal_lo) {
    return Math.max(-2, -1 - (ideal_lo - value) / band);
  }
  if (value >= ideal_hi) {
    return Math.min(2, 1 + (value - ideal_hi) / band);
  }
  return ((value - ideal_lo) / band) * 2 - 1;
}

// ----- Soil moisture simulation --------------------------------------------------------
// Each day deposits rain and drains by an evapotranspiration (ET) estimate driven by
// that day's temperature + UV. The result is *inches of plant-available moisture in
// the soil right now*. This naturally weights recent rain higher than old rain — a
// 1" deluge 5 days ago is mostly gone in 95°F sunshine but still half-present under
// cool overcast. Soil capacity caps the bucket so a clay-heavy garden can hoard more
// reserve than a sandy bed.

const SOIL_CAPACITY_BASE_IN     = 3.0;  // loamy baseline; scaled by retention_factor
const ET_BASE_PER_DAY_IN        = 0.08; // cool/cloudy day — always some loss
const ET_PEAK_BONUS_PER_DAY_IN  = 0.22; // additional ET on a hot/bright day

function dailyET(t_mean_f: number, uv_peak: number, retention_factor: number): number {
  // tempFactor ramps 0→1 across ~5°C..35°C (41°F..95°F). uvFactor ramps 0→1 across
  // UV 0..9. Mild overcast: ~0.08"/day. Hot bright day: ~0.25"/day. Sandy soils dry
  // faster (low retention_factor inflates the loss); clay holds tighter.
  const tempC = (t_mean_f - 32) * 5 / 9;
  const tempFactor = Math.max(0, Math.min(1, (tempC - 5) / 30));
  const uvFactor   = Math.max(0, Math.min(1, uv_peak / 9));
  const driver = tempFactor * 0.6 + uvFactor * 0.4;
  const raw = ET_BASE_PER_DAY_IN + ET_PEAK_BONUS_PER_DAY_IN * driver;
  return raw / Math.max(0.4, retention_factor);
}

function simulateMoisture(w: WeatherData, retention_factor: number): number {
  const capacity = SOIL_CAPACITY_BASE_IN * retention_factor;
  let moisture = 0;
  for (const d of w.past_days) {
    moisture += d.rain_in;
    moisture -= dailyET(d.t_mean, d.uv_max, retention_factor);
    moisture = Math.max(0, Math.min(capacity, moisture));
  }
  if (w.forecast_24h.length) {
    const fc_uv_peak = Math.max(...w.forecast_24h.map((h) => h.uv));
    moisture += w.summary.forecast_24h_rain;
    moisture -= dailyET(w.summary.forecast_24h_mean_temp, fc_uv_peak, retention_factor);
    moisture = Math.max(0, Math.min(capacity, moisture));
  }
  return moisture;
}

// ----- Time-weighted aggregation -------------------------------------------------------
// Exponential decay so older readings still contribute (regime change ≠ one-day blip)
// but recent days dominate. 2-day half-life: yesterday is ~71%, day -2 is 50%, day -5
// is ~18%. The forecast tick rides at age -1 (slightly *higher* weight than today)
// because it's where the plant is headed.

const TIME_DECAY_HALF_LIFE_DAYS = 2;

function timeWeightedMean(past_values: number[], forecast_value: number | null): number {
  const k = Math.log(2) / TIME_DECAY_HALF_LIFE_DAYS;
  let num = 0, den = 0;
  for (let i = 0; i < past_values.length; i++) {
    const age = past_values.length - 1 - i;  // newest past entry has age 0
    const wt = Math.exp(-k * age);
    num += past_values[i] * wt;
    den += wt;
  }
  if (forecast_value !== null) {
    const wt = Math.exp(-k * -1);
    num += forecast_value * wt;
    den += wt;
  }
  return den > 0 ? num / den : 0;
}

// ----- Risk detection ------------------------------------------------------------------
// Catastrophic events that the rolling dot can't communicate on its own. A FREEZE
// dragging through tonight still leaves a 60°F rolling average looking fine, but the
// tomatoes are about to die — so we surface a separate badge.

type RiskKey = "FREEZE RISK" | "HEAT STRESS" | "DROUGHT RISK" | "WATERLOGGED";
type Risk = { key: RiskKey; advice: string };

function detectRisks(w: WeatherData, moisture: number, profile: PlantProfile): Risk[] {
  const risks: Risk[] = [];

  // Freeze risk is forward-looking: a freeze last Tuesday is in the past and the
  // gardener can't act on it. Only the current observation + next-24h forecast count.
  const fc_min   = w.forecast_24h.length ? Math.min(...w.forecast_24h.map((h) => h.t)) : Infinity;
  const cold_low = Math.min(w.summary.current_temp_f, fc_min);
  if (Number.isFinite(cold_low) && cold_low <= profile.freeze_risk_f) {
    risks.push({
      key: "FREEZE RISK",
      advice: `Lows near ${Math.round(cold_low)}°F — cover overnight or move pots inside.`,
    });
  }

  // Heat stress is forward-looking too: a heatwave last week is in the past. Only
  // the current observation + next-24h forecast count.
  const fc_max    = w.forecast_24h.length ? Math.max(...w.forecast_24h.map((h) => h.t)) : -Infinity;
  const hot_high  = Math.max(w.summary.current_temp_f, fc_max);
  if (Number.isFinite(hot_high) && hot_high >= profile.heat_risk_f) {
    risks.push({
      key: "HEAT STRESS",
      advice: `Highs near ${Math.round(hot_high)}°F — shade cloth + mulch, water early morning.`,
    });
  }

  // Drought / waterlogged are derived from soil moisture vs. the weekly water band.
  // A plant that wants 1.0–2.0 in/wk is in real drought trouble if there's less than
  // ~0.15 of a week's water sitting in the soil (≈ 1 days' worth).
  const drought_floor = profile.water_per_week_in[0] * 0.15;
  if (moisture < drought_floor) {
    risks.push({
      key: "DROUGHT RISK",
      advice: `Only ${moisture.toFixed(2)}" in soil — water deeply soon.`,
    });
  }

  // Waterlogged: 2× the upper band, AND a meaningful absolute amount so a 0.5 in/wk
  // lavender doesn't flag every time a 1" rain falls on loamy soil.
  const soak_ceiling = Math.max(2.0, profile.water_per_week_in[1] * 2.0);
  if (moisture > soak_ceiling) {
    risks.push({
      key: "WATERLOGGED",
      advice: `${moisture.toFixed(2)}" in soil — hold off watering, check drainage.`,
    });
  }

  return risks;
}

type PlantStatus = {
  plant: PlantKey;
  label: string;
  icon: string;
  water: number;
  temp: number;
  sun: number;
  // Raw values surface to the UI for tooltips so the gardener can see the actual
  // number behind the dot ("1.4 in available moisture", "72.5 °F composite").
  water_value: number;
  temp_value: number;
  sun_value: number;
  risks: Risk[];
};

function statusFor(plant: PlantKey, w: WeatherData, soilFactor: number): PlantStatus {
  const profile = PLANT_PROFILES[plant];
  const meta = PLANT_TYPES.find((p) => p.key === plant)!;

  // Water: bucket simulation gives inches of moisture currently in the soil. The
  // plant's "comfort" reserve is about half- to one-and-a-half-weeks of its weekly
  // water need — that's the band the dot is anchored to.
  const moisture = simulateMoisture(w, soilFactor);
  const water_ideal_lo = profile.water_per_week_in[0] * 0.5;
  const water_ideal_hi = profile.water_per_week_in[1] * 1.5;
  const water = scoreContinuous(moisture, water_ideal_lo, water_ideal_hi);

  // Temp: exponentially-weighted mean of daily means + forecast 24h mean.
  const past_means = w.past_days.map((d) => d.t_mean);
  const fc_mean = w.forecast_24h.length ? w.summary.forecast_24h_mean_temp : null;
  const composite_temp = timeWeightedMean(past_means, fc_mean);
  const temp = scoreContinuous(composite_temp, profile.avg_temp_f[0], profile.avg_temp_f[1]);

  // Sun: same decay applied to daily peak UV + projected next-24h peak.
  const past_uv = w.past_days.map((d) => d.uv_max);
  const fc_uv_peak = w.forecast_24h.length ? Math.max(...w.forecast_24h.map((h) => h.uv)) : null;
  const composite_uv = timeWeightedMean(past_uv, fc_uv_peak);
  const sun = scoreContinuous(composite_uv, profile.max_uv[0], profile.max_uv[1]);

  const risks = detectRisks(w, moisture, profile);

  return {
    plant, label: meta.label, icon: meta.icon,
    water, temp, sun,
    water_value: moisture,
    temp_value: composite_temp,
    sun_value: composite_uv,
    risks,
  };
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

  // Garden Gnome is a personal/household tool — anonymous FAT visitors are not the
  // audience. Fail closed on every API call from anon viewers.
  if (isAnon && reqPath.startsWith("/api/")) {
    return jsonReply(replyPort, 403, { error: "private frame" });
  }

  if (reqPath === "/api/state" && method === "GET") {
    const prefs = getPrefs(peer.sfi_id);
    const soilDef = SOIL_TYPES.find((s) => s.key === prefs.soil) ?? SOIL_TYPES[1];
    const weather = prefs.location ? await fetchWeather(prefs.location) : null;
    const statuses: PlantStatus[] = weather
      ? prefs.plants.map((p) => statusFor(p, weather, soilDef.retention_factor))
      : [];
    return jsonReply(replyPort, 200, {
      prefs,
      soil_types: SOIL_TYPES,
      plant_types: PLANT_TYPES,
      weather,
      statuses,
      is_owner: isOwner,
      now: Date.now(),
    });
  }

  if (reqPath === "/api/save" && method === "POST") {
    const v = parseJsonBody<{ location?: unknown; soil?: unknown; plants?: unknown }>(body);
    if (!v) return jsonReply(replyPort, 400, { error: "invalid JSON" });
    const location = sanitizeText(v.location, 120);
    const soilRaw  = sanitizeText(v.soil, 20);
    const soil: SoilKey = SOIL_KEY_SET.has(soilRaw) ? (soilRaw as SoilKey) : "loamy";
    const plants: PlantKey[] = [];
    if (Array.isArray(v.plants)) {
      const seen = new Set<string>();
      for (const item of v.plants) {
        const key = sanitizeText(item, 30);
        if (PLANT_KEY_SET.has(key) && !seen.has(key)) {
          seen.add(key);
          plants.push(key as PlantKey);
        }
      }
    }
    const next: Prefs = { location, soil, plants };
    setPrefs(peer.sfi_id, next);
    pushToInstance(peer.sfi_id, { type: "settings_changed" });
    return jsonReply(replyPort, 200, { prefs: next });
  }

  if (method === "GET") {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }
  replyPort.postMessage({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }) });
};

log("Garden Gnome frame is up.");
