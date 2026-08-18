const test = require("node:test");
const assert = require("node:assert/strict");

process.env.CAPTURE_PAIRING_KEY = "pairing-key-long-enough-for-tests";
process.env.CAPTURE_SESSION_SECRET = "session-secret-long-enough-for-tests";
process.env.CAPTURE_SERVER_KEY = "server-key-long-enough-for-backend-tests-1234567890";

const pair = require("../netlify/functions/capture-pair");
const api = require("../netlify/functions/capture-api");

async function pairedCookie() {
  const result = await pair.handler({
    httpMethod: "POST", headers: {},
    body: JSON.stringify({ key: process.env.CAPTURE_PAIRING_KEY }),
  });
  assert.equal(result.statusCode, 200);
  return result.headers["Set-Cookie"].split(";")[0];
}

test("pairing rejects the wrong key and sets a private cookie for the right key", async () => {
  const wrong = await pair.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ key: "wrong" }) });
  assert.equal(wrong.statusCode, 401);
  const cookie = await pairedCookie();
  const full = (await pair.handler({
    httpMethod: "POST", headers: {}, body: JSON.stringify({ key: process.env.CAPTURE_PAIRING_KEY }),
  })).headers["Set-Cookie"];
  assert.match(cookie, /^acre_capture=/);
  assert.match(full, /HttpOnly/);
  assert.match(full, /Secure/);
  assert.match(full, /SameSite=Strict/);
  assert.match(full, /Path=\/api\/capture/);
});

test("the API rejects an unpaired browser before touching Supabase", async () => {
  const before = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; throw new Error("should not run"); };
  try {
    const result = await api.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "load" }) });
    assert.equal(result.statusCode, 401);
    assert.equal(called, false);
  } finally {
    global.fetch = before;
  }
});

test("a paired load uses the one protected database doorway", async () => {
  const before = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ items: [], run: null, changes: [] }), { status: 200 });
  };
  try {
    const result = await api.handler({
      httpMethod: "POST", headers: { cookie: await pairedCookie() }, body: JSON.stringify({ action: "load" }),
    });
    assert.equal(result.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rpc\/capture_server_request$/);
    assert.ok(calls[0].options.headers.apikey.startsWith("sb_publishable_"));
    assert.equal(calls[0].options.headers["x-capture-server-key"], process.env.CAPTURE_SERVER_KEY);
    assert.ok(!("Authorization" in calls[0].options.headers));
    assert.deepEqual(JSON.parse(calls[0].options.body), { p_action: "load", p_payload: {} });
  } finally {
    global.fetch = before;
  }
});

test("browser updates are field-limited and fail closed", () => {
  assert.throws(() => api._test.validateReminderChanges({ agent_reviewed_at: null }), /Unsupported/);
  assert.throws(() => api._test.validateReminderChanges({ priority: 500 }), /priority/);
  assert.throws(() => api._test.validateReminderChanges({ remind_at: "2026-02-30" }), /real date/);
  assert.deepEqual(api._test.validateReminderChanges({ done: true, done_at: null }), { done: true, done_at: null });
  assert.deepEqual(api._test.validateReminderChanges({ kind: null, surfaced_on: null }), { kind: null, surfaced_on: null });
  assert.throws(() => api._test.validateReminderChanges({ related: ["not-an-id"] }), /related/);
  assert.throws(() => api._test.validateChangeDecision({ reason: "changed" }), /Invalid decision/);
  assert.deepEqual(api._test.validateChangeDecision({ confirmed: true, reverted: false }), { confirmed: true, reverted: false });
});
