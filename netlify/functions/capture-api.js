const { hasCaptureSession } = require("../lib/capture-auth");

const SUPABASE = "https://vqqmyjapnvmpktxikrrz.supabase.co/rest/v1";
const SUPABASE_PUBLISHABLE = "sb_publishable_j2eKDEtVo-2CgTR4aKN6bQ_NqJvlyVB";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS = new Set(["actionable", "future", "memory", "uncertain"]);
const REMINDER_UPDATE_FIELDS = new Set([
  "body", "done", "done_at", "category", "kind", "priority", "pinned",
  "remind_at", "locked_fields", "deleted_at", "title", "summary", "tags",
  "entities", "related", "surfaced_reason", "surfaced_on",
]);
const CHANGE_UPDATE_FIELDS = new Set(["confirmed", "reverted"]);

const responseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function reply(statusCode, value) {
  return { statusCode, headers: responseHeaders, body: JSON.stringify(value) };
}

function serverKey() {
  const key = (process.env.CAPTURE_SERVER_KEY || "").trim();
  if (key.length < 48) {
    throw new Error("CAPTURE_SERVER_KEY is not configured");
  }
  return key;
}

async function serverRequest(action, payload = {}) {
  const headers = {
    apikey: SUPABASE_PUBLISHABLE,
    "x-capture-server-key": serverKey(),
    "Content-Type": "application/json",
  };
  const result = await fetch(SUPABASE + "/rpc/capture_server_request", {
    method: "POST",
    headers,
    body: JSON.stringify({ p_action: action, p_payload: payload }),
  });
  const raw = await result.text();
  if (!result.ok) throw new Error(`Supabase ${result.status}: ${raw.slice(0, 300)}`);
  return raw ? JSON.parse(raw) : null;
}

function assertId(value) {
  if (!UUID.test(value || "")) throw new Error("Invalid id");
}

function assertDate(value, field) {
  if (value === null) return;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must be a date or empty`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} is not a real date`);
  }
}

function assertTimestamp(value, field) {
  if (value === null) return;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be a timestamp or empty`);
  }
}

function validateReminderChanges(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Changes are required");
  const entries = Object.entries(input);
  if (!entries.length || entries.some(([key]) => !REMINDER_UPDATE_FIELDS.has(key))) {
    throw new Error("Unsupported reminder change");
  }
  const out = {};
  for (const [field, value] of entries) {
    if (field === "body") {
      if (typeof value !== "string" || !value.trim() || value.length > 50000) throw new Error("Invalid body");
    } else if (["done", "pinned"].includes(field)) {
      if (typeof value !== "boolean") throw new Error(`Invalid ${field}`);
    } else if (["done_at", "deleted_at"].includes(field)) {
      assertTimestamp(value, field);
    } else if (["category", "summary", "surfaced_reason"].includes(field)) {
      if (value !== null && (typeof value !== "string" || value.length > 2000)) throw new Error(`Invalid ${field}`);
    } else if (field === "title") {
      if (value !== null && (typeof value !== "string" || value.length > 300)) throw new Error("Invalid title");
    } else if (field === "kind") {
      if (value !== null && !KINDS.has(value)) throw new Error("Invalid kind");
    } else if (field === "priority") {
      if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("Invalid priority");
    } else if (["remind_at", "surfaced_on"].includes(field)) {
      assertDate(value, field);
    } else if (["locked_fields", "tags"].includes(field)) {
      if (!Array.isArray(value) || value.length > 40 || value.some(v => typeof v !== "string" || v.length > 60)) {
        throw new Error(`Invalid ${field}`);
      }
    } else if (field === "related") {
      if (!Array.isArray(value) || value.length > 40 || value.some(v => !UUID.test(v))) throw new Error("Invalid related");
    } else if (field === "entities") {
      if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 20000) {
        throw new Error("Invalid entities");
      }
    }
    out[field] = value;
  }
  return out;
}

function validateChangeDecision(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Decision is required");
  const entries = Object.entries(input);
  if (!entries.length || entries.some(([key]) => !CHANGE_UPDATE_FIELDS.has(key)) ||
      entries.some(([, value]) => typeof value !== "boolean")) {
    throw new Error("Invalid decision");
  }
  return input;
}

async function loadCapture() {
  return serverRequest("load");
}

async function dispatch(message) {
  switch (message.action) {
    case "load":
      return loadCapture();
    case "createReminder": {
      const body = typeof message.body === "string" ? message.body.replace(/\s+$/, "") : "";
      if (!body.trim() || body.length > 50000) throw new Error("Invalid reminder");
      return serverRequest("createReminder", { body });
    }
    case "updateReminder": {
      assertId(message.id);
      const changes = validateReminderChanges(message.changes);
      await serverRequest("updateReminder", { id: message.id, changes });
      return { saved: true };
    }
    case "updateChange": {
      assertId(message.id);
      const changes = validateChangeDecision(message.changes);
      await serverRequest("updateChange", { id: message.id, changes });
      return { saved: true };
    }
    default:
      throw new Error("Unsupported action");
  }
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
  try {
    if (!hasCaptureSession(event)) return reply(401, { error: "This device is not paired" });
    const message = JSON.parse(event.body || "{}");
    return reply(200, await dispatch(message));
  } catch (error) {
    console.error("Capture API failed:", error.message);
    const badInput = /Invalid|Unsupported|Changes are required|Decision is required/.test(error.message);
    return reply(badInput ? 400 : 503, { error: badInput ? error.message : "Capture is temporarily unavailable" });
  }
};

exports._test = { validateReminderChanges, validateChangeDecision };
