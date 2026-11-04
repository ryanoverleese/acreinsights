const test = require("node:test");
const assert = require("node:assert/strict");

process.env.CAPTURE_PAIRING_KEY = "pairing-key-long-enough-for-tests";
process.env.CAPTURE_SESSION_SECRET = "session-secret-long-enough-for-tests";
process.env.CAPTURE_SERVER_KEY = "server-key-long-enough-for-backend-tests-1234567890";

const pair = require("../netlify/functions/capture-pair");
const api = require("../netlify/functions/workweek-api");
const ID = "f37d9569-cc05-4b0d-a0cb-15251ed52cb0";

async function cookie() {
  const r = await pair.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ key: process.env.CAPTURE_PAIRING_KEY }) });
  return r.headers["Set-Cookie"].split(";")[0];
}

async function withFetch(fn) {
  const before = global.fetch, calls = [];
  global.fetch = async (url, options) => { calls.push({ url: String(url), body: JSON.parse(options.body), headers: options.headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
  try { await fn(calls); } finally { global.fetch = before; }
}

test("unpaired browsers are refused before Supabase", async () => {
  await withFetch(async calls => {
    const r = await api.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "load", week: "2026-11-02" }) });
    assert.equal(r.statusCode, 401);
    assert.equal(calls.length, 0);
  });
});

test("place, unplace and load go through the work week doorway with the server key", async () => {
  await withFetch(async calls => {
    const c = await cookie();
    for (const body of [{ action: "load", week: "2026-11-02" }, { action: "place", date: "2026-11-04", start: 13.5, reminder_id: ID },
                        { action: "unplace", date: "2026-11-04", start: 13.5, reminder_id: ID }]) {
      const r = await api.handler({ httpMethod: "POST", headers: { cookie: c }, body: JSON.stringify(body) });
      assert.equal(r.statusCode, 200);
    }
    assert.deepEqual(calls.map(x => x.url.split("/rpc/")[1]), ["workweek_server_request", "workweek_server_request", "workweek_server_request"]);
    assert.deepEqual(calls.map(x => x.body.p_action), ["load", "place", "unplace"]);
    assert.equal(calls[0].headers["x-capture-server-key"], process.env.CAPTURE_SERVER_KEY);
  });
});

test("add and check-off reuse the Capture doorway", async () => {
  await withFetch(async calls => {
    const c = await cookie();
    await api.handler({ httpMethod: "POST", headers: { cookie: c }, body: JSON.stringify({ action: "createReminder", body: "Fix gate" }) });
    await api.handler({ httpMethod: "POST", headers: { cookie: c }, body: JSON.stringify({ action: "complete", id: ID }) });
    assert.deepEqual(calls.map(x => [x.url.split("/rpc/")[1], x.body.p_action]),
      [["capture_server_request", "createReminder"], ["capture_server_request", "updateReminder"]]);
    assert.equal(calls[1].body.p_payload.changes.done, true);
  });
});

test("bad input is rejected", async () => {
  await withFetch(async calls => {
    const c = await cookie();
    for (const body of [{ action: "place", date: "2026-13-04", start: 9, reminder_id: ID }, { action: "place", date: "2026-11-04", start: 30, reminder_id: ID },
                        { action: "complete", id: "nope" }, { action: "drop" }]) {
      const r = await api.handler({ httpMethod: "POST", headers: { cookie: c }, body: JSON.stringify(body) });
      assert.equal(r.statusCode, 400);
    }
    assert.equal(calls.length, 0);
  });
});
