// Public, read-only soil probe data for /soiltemps.
//
// Returns only what the page displays: site name, general location label, last
// reading time, temperature (°F) and water (%vol) by depth (inches), a 7-day
// water series, and daily season averages with high/low (when
// public.soil_public_season is available). The database only returns loggers
// marked active AND public; this function whitelists the fields again so
// nothing else can leak. The key comes from Netlify env and never reaches the
// browser. Responses are cached for 10 minutes.

const DEFAULT_SUPABASE_URL = "https://junawlttpyztjlnbmvcb.supabase.co";
const DAYS = 7;
const SEASON_DAYS = 400;

const baseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
const CACHED = {
  "Cache-Control": "public, max-age=600",
  "Netlify-CDN-Cache-Control": "public, max-age=600, stale-while-revalidate=300",
};
const UNCACHED = { "Cache-Control": "no-store" };

function reply(statusCode, value, cacheHeaders) {
  return { statusCode, headers: { ...baseHeaders, ...cacheHeaders }, body: JSON.stringify(value) };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const text = (v, max = 80) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const time = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const date = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const list = (v) => (Array.isArray(v) ? v : []);

function nums(v, len) {
  const out = list(v).map(num);
  if (Number.isInteger(len) && len >= 0) {
    while (out.length < len) out.push(null);
    if (out.length > len) out.length = len;
  }
  return out;
}

function cleanSeason(season) {
  const depths = list(season && season.depths_in).map(num).filter((d) => d != null);
  const days = list(season && season.days).map((day) => {
    const dayDate = date(day && day.date);
    if (!dayDate) return null;
    const n = depths.length;
    return {
      date: dayDate,
      w_avg: nums(day.w_avg, n),
      w_high: nums(day.w_high, n),
      w_low: nums(day.w_low, n),
      t_avg: nums(day.t_avg, n),
      t_high: nums(day.t_high, n),
      t_low: nums(day.t_low, n),
    };
  }).filter(Boolean);
  if (!depths.length || !days.length) return null;
  return { depths_in: depths, days };
}

function seasonByName(payload) {
  const map = new Map();
  for (const site of list(payload && payload.sites)) {
    const name = text(site && site.name);
    const cleaned = cleanSeason(site);
    if (name && cleaned) map.set(name, cleaned);
  }
  return map;
}

function cleanSite(site, season) {
  const day = site && site.surface_day;
  const series = (site && site.water_series) || {};
  const out = {
    name: text(site.name) || "Unnamed site",
    location: text(site.location),
    last_read_at: time(site.last_read_at),
    latest: list(site.latest).map((r) => ({ depth_in: num(r.depth_in), temp_f: num(r.temp_f), water_pct: num(r.water_pct) })),
    surface_day: day && date(day.date) ? {
      date: date(day.date), avg_f: num(day.avg_f), high_f: num(day.high_f), low_f: num(day.low_f), avg_7day_f: num(day.avg_7day_f),
    } : null,
    water_series: {
      depths_in: list(series.depths_in).map(num),
      points: list(series.points).map((p) => ({ t: time(p.t), w: list(p.w).map(num) })).filter((p) => p.t),
    },
  };
  if (season) out.season = season;
  return out;
}

function cleanPayload(payload, seasonPayload) {
  const seasons = seasonByName(seasonPayload);
  return {
    generated_at: time(payload && payload.generated_at) || new Date().toISOString(),
    sites: list(payload && payload.sites).map((site) => {
      const name = text(site && site.name) || "Unnamed site";
      return cleanSite(site, seasons.get(name) || cleanSeason(site && site.season));
    }).filter((s) => s.last_read_at),
  };
}

exports.cleanPayload = cleanPayload;

async function rpc(base, key, name, body) {
  const res = await fetch(`${base}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${name} ${res.status}`);
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET" && event.httpMethod !== "HEAD") {
    return { ...reply(405, { error: "Method not allowed" }, UNCACHED), headers: { ...baseHeaders, ...UNCACHED, Allow: "GET, HEAD" } };
  }
  const key = (process.env.SOIL_SUPABASE_KEY || "").trim();
  if (!key) return reply(503, { error: "Soil data is not configured" }, UNCACHED);
  const base = (process.env.SOIL_SUPABASE_URL || DEFAULT_SUPABASE_URL).trim().replace(/\/+$/, "");

  try {
    const payload = await rpc(base, key, "soil_public_sites", { p_days: DAYS });
    let seasonPayload = null;
    try {
      seasonPayload = await rpc(base, key, "soil_public_season", { p_days: SEASON_DAYS });
    } catch (err) {
      console.error("soil-public season:", err.message);
    }
    return reply(200, cleanPayload(payload, seasonPayload), CACHED);
  } catch (err) {
    console.error("soil-public:", err.message);
    return reply(502, { error: "Soil data is unavailable right now" }, UNCACHED);
  }
};
