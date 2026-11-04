// Work Week password door. A correct WORKWEEK_PASSWORD sets the same
// acre_capture cookie that Capture pairing sets. Nothing secret reaches the page.
const crypto = require("node:crypto");
const { captureCookie } = require("../lib/capture-auth");

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const failures = new Map(); // per warm function instance: ip -> [timestamps]

function digest(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest();
}
function passwordMatches(value) {
  const real = (process.env.WORKWEEK_PASSWORD || "").trim();
  if (!real) return false;
  return crypto.timingSafeEqual(digest(value), digest(real));
}
function clientIp(event) {
  const h = event.headers || {};
  return h["x-nf-client-connection-ip"] || (h["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
}
function recentFails(ip, now) {
  const list = (failures.get(ip) || []).filter(t => now - t < WINDOW_MS);
  failures.set(ip, list);
  return list;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

exports.FAIL_DELAY_MS = 1000;
exports._reset = () => failures.clear();
exports.handler = async event => {
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  const ip = clientIp(event), now = Date.now();
  if (recentFails(ip, now).length >= MAX_FAILS) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: "Too many tries. Wait 15 minutes." }) };
  }
  let password = "";
  try { password = String(JSON.parse(event.body || "{}").password || "").slice(0, 200); } catch (e) {}
  if (!process.env.WORKWEEK_PASSWORD || !(process.env.WORKWEEK_PASSWORD || "").trim()) {
    await wait(exports.FAIL_DELAY_MS);
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Password login is not set up" }) };
  }
  if (!passwordMatches(password)) {
    recentFails(ip, now).push(now);
    await wait(exports.FAIL_DELAY_MS);
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Wrong password" }) };
  }
  failures.delete(ip);
  return { statusCode: 200, headers: { ...headers, "Set-Cookie": captureCookie() }, body: JSON.stringify({ paired: true }) };
};
