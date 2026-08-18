const crypto = require("node:crypto");

const COOKIE_NAME = "acre_capture";
const COOKIE_PATH = "/api/capture";
const ONE_YEAR = 60 * 60 * 24 * 365;

function required(name) {
  const value = (process.env[name] || "").trim();
  if (value.length < 24) throw new Error(`${name} is missing or too short`);
  return value;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sessionValue() {
  return crypto
    .createHmac("sha256", required("CAPTURE_SESSION_SECRET"))
    .update("acre-capture-device-v1")
    .digest("base64url");
}

function cookies(event) {
  const raw = event.headers?.cookie || event.headers?.Cookie || "";
  return Object.fromEntries(raw.split(";").map(part => {
    const at = part.indexOf("=");
    if (at < 0) return [part.trim(), ""];
    return [part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim())];
  }).filter(([key]) => key));
}

function hasCaptureSession(event) {
  return safeEqual(cookies(event)[COOKIE_NAME], sessionValue());
}

function pairingKeyMatches(value) {
  return safeEqual(value, required("CAPTURE_PAIRING_KEY"));
}

function captureCookie() {
  return `${COOKIE_NAME}=${encodeURIComponent(sessionValue())}; Path=${COOKIE_PATH}; Max-Age=${ONE_YEAR}; HttpOnly; Secure; SameSite=Strict`;
}

module.exports = { captureCookie, hasCaptureSession, pairingKeyMatches };
