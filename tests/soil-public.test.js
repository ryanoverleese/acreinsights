const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const fn = require("../netlify/functions/soil-public");
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const UPSTREAM = {
  generated_at: "2026-11-23T20:51:41+00:00",
  sites: [{
    id: 1, name: "Grass corner", location: "3 mi NW of Axtell", latitude: 40.5, longitude: -99.1, logger_name: "ai_shop_test",
    last_read_at: "2026-11-23T20:00:00+00:00",
    latest: [{ depth_in: 2, temp_f: 51, water_pct: 18.4, raw_moisture: 0.4 }],
    surface_day: { date: "2026-11-22", avg_f: 51.2, high_f: 54.9, low_f: 49, readings: 48, avg_7day_f: 54.5 },
    water_series: { depths_in: [2], points: [{ t: "2026-11-23T19:30:00+00:00", w: [18.3] }, { t: "2026-11-23T20:00:00+00:00", w: [18.4] }] },
  }, { id: 2, name: "No readings yet", last_read_at: null }],
};

async function withFetch(response, fn2) {
  const before = global.fetch, calls = [];
  global.fetch = async (url, options) => { calls.push({ url: String(url), options }); return response(); };
  try { await fn2(calls); } finally { global.fetch = before; }
}

test("only GET and HEAD are allowed", async () => {
  const r = await fn.handler({ httpMethod: "POST" });
  assert.equal(r.statusCode, 405);
});

test("without the key it refuses before calling Supabase and is not cached", async () => {
  delete process.env.SOIL_SUPABASE_KEY;
  await withFetch(() => new Response("{}"), async (calls) => {
    const r = await fn.handler({ httpMethod: "GET" });
    assert.equal(r.statusCode, 503);
    assert.equal(r.headers["Cache-Control"], "no-store");
    assert.equal(calls.length, 0);
  });
});

test("reads the public-only RPC with the env key and returns display fields only, cached 10 minutes", async () => {
  process.env.SOIL_SUPABASE_KEY = "publishable-key-for-tests";
  await withFetch(() => new Response(JSON.stringify(UPSTREAM), { status: 200 }), async (calls) => {
    const r = await fn.handler({ httpMethod: "GET" });
    assert.equal(r.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rest\/v1\/rpc\/soil_public_sites$/);
    assert.equal(calls[0].options.headers.apikey, "publishable-key-for-tests");
    assert.match(r.headers["Cache-Control"], /public, max-age=600/);
    const body = JSON.parse(r.body);
    assert.equal(body.sites.length, 1, "sites without readings are dropped");
    const site = body.sites[0];
    assert.deepEqual(Object.keys(site).sort(), ["last_read_at", "latest", "location", "name", "surface_day", "water_series"]);
    assert.deepEqual(site.latest, [{ depth_in: 2, temp_f: 51, water_pct: 18.4 }]);
    assert.deepEqual(Object.keys(site.surface_day).sort(), ["avg_7day_f", "avg_f", "date", "high_f", "low_f"]);
    assert.doesNotMatch(r.body, /latitude|longitude|logger_name|raw_moisture|publishable-key/);
  });
});

test("an upstream failure is a 502 that is not cached", async () => {
  process.env.SOIL_SUPABASE_KEY = "publishable-key-for-tests";
  await withFetch(() => new Response("nope", { status: 500 }), async () => {
    const r = await fn.handler({ httpMethod: "GET" });
    assert.equal(r.statusCode, 502);
    assert.equal(r.headers["Cache-Control"], "no-store");
  });
});

test("/soiltemps reads /api/soil, not soil_temp.json, and carries no database key", () => {
  const html = read("soiltemps.html");
  assert.match(html, /fetch\('\/api\/soil'\)/);
  assert.doesNotMatch(html, /soil_temp\.json/);
  assert.doesNotMatch(html, /supabase|sb_publishable|apikey/i);
  assert.doesNotMatch(html, /uncalibrated|Learn more|Last updated|Readings come from/);
  assert.match(html, /2&Prime;&ndash;6&Prime; avg/);
  assert.match(read("_redirects"), /^\/api\/soil\s+\/\.netlify\/functions\/soil-public\s+200$/m);
});

test("/soiltemps and /updates use the home page stylesheet, nav and footer", () => {
  const navLabels = (html) => [...html.match(/<ul class="n-links"[\s\S]*?<\/ul>/)[0].matchAll(/>([^<>]+)<\/a>/g)].map((m) => m[1].replace("&amp;", "&"));
  const footLabels = (html) => [...html.match(/<ul class="f-nav">[\s\S]*?<\/ul>/)[0].matchAll(/>([^<>]+)<\/a>/g)].map((m) => m[1].replace("&amp;", "&"));
  const home = read("index.html");
  assert.match(home, /<link rel="stylesheet" href="\/assets\/site\.css">/);
  assert.doesNotMatch(home, /<style>/);
  for (const file of ["soiltemps.html", "updates.html"]) {
    const html = read(file);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/site\.css">/, file);
    assert.deepEqual(navLabels(html), navLabels(home), `${file} nav`);
    assert.deepEqual(footLabels(html), footLabels(home), `${file} footer`);
    assert.match(html, /<script src="\/assets\/nav\.js" defer><\/script>/, file);
    assert.doesNotMatch(html, /fonts\.googleapis|gradient/i, file);
  }
});
