const { captureCookie, pairingKeyMatches } = require("../lib/capture-auth");

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

exports.handler = async event => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const body = JSON.parse(event.body || "{}");
    if (!pairingKeyMatches(body.key)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "Pairing key not accepted" }) };
    }
    return {
      statusCode: 200,
      headers: { ...headers, "Set-Cookie": captureCookie() },
      body: JSON.stringify({ paired: true }),
    };
  } catch (error) {
    console.error("Capture pairing failed:", error.message);
    return { statusCode: 503, headers, body: JSON.stringify({ error: "Pairing is temporarily unavailable" }) };
  }
};
