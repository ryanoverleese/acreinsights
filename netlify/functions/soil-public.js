// Public, read-only soil probe data for /soiltemps.
//
// Returns only what the page displays: site name, general location label, last
// reading time, temperature (°F) and water (%vol) by depth (inches), and a 7-day
// water series. The database only returns loggers marked active AND public
// (public.soil_public_sites in the Acre Ops project); this function whitelists
// the fields again so nothing else can leak. The key comes from Netlify env and
// never reaches the browser. Responses are cached for 10 minutes.

const DEFAULT_SUPABASE_URL = "https://junawlttpyztjlnbmvcb.supabase.co";
const DAYS = 7;

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

function cleanSite(site) {
  const day = site && site.surface_day;
  const series = (site && site.water_series) || {};
  return {
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
}

function cleanPayload(payload) {
  return {
    generated_at: time(payload && payload.generated_at) || new Date().toISOString(),
    sites: list(payload && payload.sites).map(cleanSite).filter((s) => s.last_read_at),
  };
}

exports.cleanPayload = cleanPayload;

exports.handler = async (event) => {
  if (event.httpMethod !== "GET" && event.httpMethod !== "HEAD") {
    return { ...reply(405, { error: "Method not allowed" }, UNCACHED), headers: { ...baseHeaders, ...UNCACHED, Allow: "GET, HEAD" } };
  }
  const key = (process.env.SOIL_SUPABASE_KEY || "").trim();
  if (!key) return reply(503, { error: "Soil data is not configured" }, UNCACHED);
  const base = (process.env.SOIL_SUPABASE_URL || DEFAULT_SUPABASE_URL).trim().replace(/\/+$/, "");

  try {
    const res = await fetch(`${base}/rest/v1/rpc/soil_public_sites`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify({ p_days: DAYS }),
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return reply(200, cleanPayload(await res.json()), CACHED);
  } catch (err) {
    console.error("soil-public:", err.message);
    return reply(502, { error: "Soil data is unavailable right now" }, UNCACHED);
  }
};
