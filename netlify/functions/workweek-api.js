const { captureCookie, hasCaptureSession } = require("../lib/capture-auth");

// Same Supabase project and same server-only key as capture-api.js. The browser
// never sees a database key; it only holds the paired Capture cookie.
const SUPABASE = "https://vqqmyjapnvmpktxikrrz.supabase.co/rest/v1";
const SUPABASE_PUBLISHABLE = "sb_publishable_j2eKDEtVo-2CgTR4aKN6bQ_NqJvlyVB";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const responseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function reply(statusCode, value, extraHeaders = {}) {
  return { statusCode, headers: { ...responseHeaders, ...extraHeaders }, body: JSON.stringify(value) };
}

function serverKey() {
  const key = (process.env.CAPTURE_SERVER_KEY || "").trim();
  if (key.length < 48) throw new Error("CAPTURE_SERVER_KEY is not configured");
  return key;
}

async function rpc(fn, action, payload = {}) {
  const result = await fetch(`${SUPABASE}/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SUPABASE_PUBLISHABLE, "x-capture-server-key": serverKey(), "Content-Type": "application/json" },
    body: JSON.stringify({ p_action: action, p_payload: payload }),
  });
  const raw = await result.text();
  if (!result.ok) throw new Error(`Supabase ${result.status}: ${raw.slice(0, 300)}`);
  return raw ? JSON.parse(raw) : null;
}

function assertId(value) {
  if (!UUID.test(value || "")) throw new Error("Invalid id");
}

function assertDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid date");
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new Error("Invalid date");
}

function assertStart(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 24) throw new Error("Invalid start");
}

function slot(message) {
  assertDate(message.date);
  assertStart(message.start);
  assertId(message.reminder_id);
  return { date: message.date, start: Math.round(message.start * 100) / 100, reminder_id: message.reminder_id };
}

async function dispatch(message) {
  switch (message.action) {
    case "load":
      assertDate(message.week);
      return rpc("workweek_server_request", "load", { week: message.week });
    case "createReminder": {
      const body = typeof message.body === "string" ? message.body.trim() : "";
      if (!body || body.length > 2000) throw new Error("Invalid reminder");
      return rpc("capture_server_request", "createReminder", { body });
    }
    case "complete":
      assertId(message.id);
      await rpc("capture_server_request", "updateReminder", {
        id: message.id, changes: { done: true, done_at: new Date().toISOString() },
      });
      return { saved: true };
    case "place":
      return rpc("workweek_server_request", "place", slot(message));
    case "unplace":
      return rpc("workweek_server_request", "unplace", slot(message));
    default:
      throw new Error("Unsupported action");
  }
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
  try {
    if (!hasCaptureSession(event)) return reply(401, { error: "This device is not paired" });
    const message = JSON.parse(event.body || "{}");
    return reply(200, await dispatch(message), { "Set-Cookie": captureCookie() });
  } catch (error) {
    console.error("Work Week API failed:", error.message);
    const badInput = /Invalid|Unsupported/.test(error.message);
    return reply(badInput ? 400 : 503, { error: badInput ? error.message : "Work Week is temporarily unavailable" });
  }
};
