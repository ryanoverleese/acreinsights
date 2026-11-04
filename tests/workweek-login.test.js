const test = require("node:test");
const assert = require("node:assert/strict");
process.env.CAPTURE_SESSION_SECRET = "session-secret-long-enough-for-tests";
process.env.CAPTURE_PAIRING_KEY = "pairing-key-long-enough-for-tests";
process.env.CAPTURE_SERVER_KEY = "server-key-long-enough-for-backend-tests-1234567890";
const login = require("../netlify/functions/workweek-login");
const api = require("../netlify/functions/workweek-api");
login.FAIL_DELAY_MS = 1;
const post = (password, ip = "1.1.1.1") => login.handler({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": ip }, body: JSON.stringify({ password }) });

test("unset WORKWEEK_PASSWORD refuses everything", async () => {
  delete process.env.WORKWEEK_PASSWORD; login._reset();
  for (const p of ["", "anything", undefined]) { const r = await post(p); assert.equal(r.statusCode, 401); assert.equal(r.headers["Set-Cookie"], undefined); }
  process.env.WORKWEEK_PASSWORD = "   "; assert.equal((await post("   ")).statusCode, 401);
});

test("wrong password is 401 with no cookie; right one sets the Capture cookie that the API accepts", async () => {
  process.env.WORKWEEK_PASSWORD = "correct horse"; login._reset();
  const bad = await post("wrong");
  assert.equal(bad.statusCode, 401); assert.equal(bad.headers["Set-Cookie"], undefined);
  assert.ok(!JSON.stringify(bad).includes("correct horse"));
  const ok = await post("correct horse");
  assert.equal(ok.statusCode, 200);
  const c = ok.headers["Set-Cookie"];
  for (const part of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api/capture", "Max-Age=31536000"]) assert.ok(c.includes(part), part);
  assert.ok(!c.includes("correct horse"));
  const before = global.fetch; global.fetch = async () => new Response("{}", { status: 200 });
  try {
    const r = await api.handler({ httpMethod: "POST", headers: { cookie: c.split(";")[0] }, body: JSON.stringify({ action: "load", week: "2026-11-02" }) });
    assert.equal(r.statusCode, 200);
  } finally { global.fetch = before; }
});

test("repeated failures are rate limited per IP", async () => {
  process.env.WORKWEEK_PASSWORD = "correct horse"; login._reset();
  for (let i = 0; i < 5; i++) assert.equal((await post("nope", "2.2.2.2")).statusCode, 401);
  assert.equal((await post("correct horse", "2.2.2.2")).statusCode, 429);
  assert.equal((await post("correct horse", "3.3.3.3")).statusCode, 200);
});

test("only POST", async () => {
  assert.equal((await login.handler({ httpMethod: "GET", headers: {} })).statusCode, 405);
});
