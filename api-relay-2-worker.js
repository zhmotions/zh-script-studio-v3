/**
 * ZH API relay v2 — Cloudflare Worker (hardened)
 * ----------------------------------------------
 * Same job as the original api-relay: forwards app requests to zhmotions.com
 * from a clean Cloudflare IP with a browser User-Agent so Hostinger's lsrecaptcha
 * firewall lets flagged clients through (license activation + Auto Subtitle + reviews).
 *
 * DIFFERENCE vs the original: a PATH ALLOWLIST so the Worker can only relay the
 * app's real endpoints — not act as an open proxy for the whole site.
 *
 * Deploy: Cloudflare → Workers & Pages → Create Worker → name it "api-relay-2"
 *         → paste this → Deploy.  URL: https://api-relay-2.zhmotionspanel.workers.dev
 *         (The ORIGINAL api-relay stays as-is so already-installed clients keep working.)
 */

const ORIGIN = "https://zhmotions.com";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/16.5 Safari/605.1.15";

function corsHeaders(extra) {
  const h = new Headers(extra || {});
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CSRF-Token");
  h.set("Access-Control-Max-Age", "86400");
  return h;
}

export default {
  async fetch(request) {
    // CORS preflight from the CEP panel / browser clients.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // Path allowlist — relay ONLY the app's real endpoints (not an open proxy).
    const okPath =
      url.pathname === "/api.php" ||
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/templates/");
    if (!okPath) {
      return new Response(JSON.stringify({ status: "error", message: "Not relayable." }), {
        status: 403,
        headers: corsHeaders({ "Content-Type": "application/json" }),
      });
    }

    const target = ORIGIN + url.pathname + url.search;

    // Rebuild headers: keep Content-Type, force a browser UA + Referer so lsrecaptcha passes.
    const headers = new Headers();
    const ct = request.headers.get("content-type");
    if (ct) headers.set("Content-Type", ct);
    const csrf = request.headers.get("x-csrf-token");
    if (csrf) headers.set("X-CSRF-Token", csrf);
    headers.set("User-Agent", BROWSER_UA);
    headers.set("Referer", ORIGIN + "/");
    headers.set("Accept", "application/json, text/plain, */*");

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const init = { method: request.method, headers, redirect: "follow" };
    if (hasBody) {
      // STREAM the body (don't buffer with arrayBuffer) — a long-audio WAV can be 100s of MB and
      // buffering it would blow the Worker's memory. Streaming passes it through with low memory.
      init.body = request.body;
      init.duplex = "half";   // required when body is a stream
    }

    let resp;
    try {
      resp = await fetch(target, init);
    } catch (e) {
      return new Response(JSON.stringify({ status: "error", message: "relay failed: " + e }), {
        status: 502, headers: corsHeaders({ "Content-Type": "application/json" }),
      });
    }

    // Pass the origin response back with permissive CORS.
    const out = corsHeaders();
    const rct = resp.headers.get("content-type");
    if (rct) out.set("Content-Type", rct);
    return new Response(resp.body, { status: resp.status, headers: out });
  },
};
