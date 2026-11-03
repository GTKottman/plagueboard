// Also holds a moderated comments section: visitors post (1 per 50 min per IP), the owner approves at /admin#<token>.
// Serves site/ and counts visitors: who is on the page right now (heartbeats) and unique visitors all time.
// A visitor = sha256(salt + IP + user agent); the salt is made on first start and kept in DATA_DIR, never in git.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 80);
const SITE = path.resolve("site");
const DATA = process.env.DATA_DIR || "/data";
const LOG = path.join(DATA, "visits.jsonl");
const LIVE_LOG = path.join(DATA, "live.jsonl");
const DAY = 24 * 3600 * 1000;
const LIVE_MS = 75 * 1000; // a page beats every 30 s; gone after 75 s of silence
const BOT = /bot|crawl|spider|slurp|curl|wget|python|httpclient|headless|preview|monitor|uptime/i;

fs.mkdirSync(DATA, { recursive: true });
const saltFile = path.join(DATA, "salt");
if (!fs.existsSync(saltFile)) fs.writeFileSync(saltFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
const salt = fs.readFileSync(saltFile, "utf8").trim();

// [ts, hash] for every visit ever logged, oldest first. (Builds before Nov 2 kept only the past week.)
const visits = [];
if (fs.existsSync(LOG)) {
  for (const line of fs.readFileSync(LOG, "utf8").split("\n")) {
    try { const v = JSON.parse(line); if (Array.isArray(v)) visits.push(v); } catch {}
  }
}
const everyone = new Set(visits.map((v) => v[1]));

// hash -> last heartbeat; liveSamples = [ts, people on the page] once a minute for the past day
const lastSeen = new Map();
let liveSamples = [];
if (fs.existsSync(LIVE_LOG)) {
  const cutoff = Date.now() - DAY;
  for (const line of fs.readFileSync(LIVE_LOG, "utf8").split("\n")) {
    try { const v = JSON.parse(line); if (v[0] >= cutoff) liveSamples.push(v); } catch {}
  }
  fs.writeFileSync(LIVE_LOG, liveSamples.map((v) => JSON.stringify(v)).join("\n") + (liveSamples.length ? "\n" : ""));
}

function liveNow() {
  const cutoff = Date.now() - LIVE_MS;
  for (const [h, t] of lastSeen) if (t < cutoff) lastSeen.delete(h);
  return lastSeen.size;
}

setInterval(() => {
  const v = [Date.now(), liveNow()];
  liveSamples.push(v);
  const cutoff = Date.now() - DAY;
  while (liveSamples.length && liveSamples[0][0] < cutoff) liveSamples.shift();
  fs.appendFile(LIVE_LOG, JSON.stringify(v) + "\n", () => {});
}, 60 * 1000);

// cumulative unique visitors at the end of each UTC day
function allTimeSeries() {
  const seen = new Set();
  const out = [];
  for (const [ts, h] of visits) {
    seen.add(h);
    const day = Math.floor(ts / DAY) * DAY;
    if (out.length && out[out.length - 1][0] === day) out[out.length - 1][1] = seen.size;
    else out.push([day, seen.size]);
  }
  return out;
}

function counts() {
  return { now: liveNow(), all: everyone.size, since: visits.length ? visits[0][0] : Date.now(),
    live: liveSamples, allTime: allTimeSeries() };
}

function visitor(req) {
  const ua = req.headers["user-agent"] || "";
  if (!ua || BOT.test(ua)) return null;
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  return crypto.createHash("sha256").update(salt + ip + ua).digest("hex").slice(0, 20);
}

function record(req, beat) {
  const hash = visitor(req);
  if (!hash) return;
  lastSeen.set(hash, Date.now());
  if (beat) return;
  const v = [Date.now(), hash];
  visits.push(v);
  everyone.add(hash);
  fs.appendFile(LOG, JSON.stringify(v) + "\n", () => {});
}

// ---- comments ----
// comments.jsonl is an append-only event log: a full comment line when posted, then {id, status} lines when approved or deleted.
const COMMENTS_LOG = path.join(DATA, "comments.jsonl");
const COMMENT_GAP = 50 * 60 * 1000;
const MAX_BODY = 8 * 1024;
const comments = new Map(); // id -> {id, ts, name, text, ipHash, status}
const lastPost = new Map(); // ipHash -> ts of last accepted comment (kept even after delete)
if (fs.existsSync(COMMENTS_LOG)) {
  for (const line of fs.readFileSync(COMMENTS_LOG, "utf8").split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.text !== undefined) { comments.set(e.id, e); lastPost.set(e.ipHash, Math.max(lastPost.get(e.ipHash) || 0, e.ts)); }
      else if (comments.has(e.id)) comments.get(e.id).status = e.status;
    } catch {}
  }
}
// The owner's admin token is checked by its sha256 (safe to publish; the token itself is never in the repo).
// ADMIN_TOKEN in the environment, if set, replaces it.
const ADMIN_TOKEN_SHA256 = "4a992632bd51f75003e8485ac3966f6ef354f672c6dea941f9bad724aeeec7a4";
const adminToken = process.env.ADMIN_TOKEN || "";

function clientHash(req) {
  // last x-forwarded-for entry = the address the proxy saw; earlier entries can be faked by the sender
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",").pop().trim();
  return crypto.createHash("sha256").update(salt + ip).digest("hex");
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readJson(req, res, cb) {
  let size = 0; const chunks = []; let dead = false;
  req.on("data", (c) => {
    if (dead) return;
    size += c.length;
    if (size > MAX_BODY) { dead = true; json(res, 413, { error: "Too big." }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    if (dead) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return json(res, 400, { error: "Bad JSON." }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "Bad JSON." });
    cb(body);
  });
}

const pub = (c) => ({ id: c.id, ts: c.ts, name: c.name, text: c.text });
const byNewest = (a, b) => b.ts - a.ts;

function postComment(req, res) {
  readJson(req, res, (b) => {
    if (typeof b.website === "string" && b.website !== "") return json(res, 200, { ok: true }); // honeypot: pretend it worked
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (name.length < 1 || name.length > 40) return json(res, 400, { error: "Name must be 1 to 40 characters." });
    if (text.length < 1 || text.length > 2000) return json(res, 400, { error: "Comment must be 1 to 2000 characters." });
    const ipHash = clientHash(req);
    const now = Date.now();
    const wait = (lastPost.get(ipHash) || 0) + COMMENT_GAP - now;
    if (wait > 0) return json(res, 429, { error: "Too soon.", minutes: Math.ceil(wait / 60000) });
    const c = { id: crypto.randomBytes(8).toString("hex"), ts: now, name, text, ipHash, status: "pending" };
    comments.set(c.id, c);
    lastPost.set(ipHash, now);
    fs.appendFile(COMMENTS_LOG, JSON.stringify(c) + "\n", () => {});
    json(res, 200, { ok: true });
  });
}

function adminAllowed(req, res) {
  const a = crypto.createHash("sha256").update(String(req.headers["x-admin-token"] || "")).digest();
  const b = adminToken ? crypto.createHash("sha256").update(adminToken).digest() : Buffer.from(ADMIN_TOKEN_SHA256, "hex");
  if (!crypto.timingSafeEqual(a, b)) { json(res, 401, { error: "Wrong token." }); return false; }
  return true;
}

function adminApi(req, res, url) {
  if (!adminAllowed(req, res)) return;
  if (req.method === "GET" && url.pathname === "/api/admin/comments") {
    const all = [...comments.values()].filter((c) => c.status !== "deleted").sort(byNewest);
    const strip = ({ ipHash, ...c }) => c;
    return json(res, 200, { pending: all.filter((c) => c.status === "pending").map(strip), approved: all.filter((c) => c.status === "approved").map(strip) });
  }
  const m = url.pathname.match(/^\/api\/admin\/comments\/([0-9a-f]+)\/(approve|delete)$/);
  if (req.method === "POST" && m) {
    const c = comments.get(m[1]);
    if (!c || c.status === "deleted") return json(res, 404, { error: "No such comment." });
    c.status = m[2] === "approve" ? "approved" : "deleted";
    fs.appendFile(COMMENTS_LOG, JSON.stringify({ id: c.id, status: c.status }) + "\n", () => {});
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: "Not found." });
}

// Admin page: text goes in with textContent only, never as HTML. The token is read from the URL hash so it never reaches a server log.
const ADMIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Comments admin</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#fff;color:#111}
main{max-width:760px;margin:0 auto;padding:32px 16px 80px}
h1{font-size:26px;margin:0 0 4px} h2{font-size:15px;letter-spacing:.08em;text-transform:uppercase;color:#6b6b6b;margin:36px 0 12px}
.c{border:1px solid #e5e5e5;border-radius:12px;padding:16px 18px;margin-bottom:12px;background:#fafafa}
.meta{font-size:13px;color:#6b6b6b;margin-bottom:6px} .meta b{color:#111;font-size:15px}
.t{white-space:pre-wrap;overflow-wrap:anywhere}
.row{display:flex;gap:8px;margin-top:12px}
button{font:inherit;font-weight:600;padding:8px 18px;border-radius:99px;border:1px solid #d4d4d4;background:#fff;color:#111;cursor:pointer}
button.ok{background:#FD3A25;border-color:#FD3A25;color:#fff} button:hover{opacity:.85}
#msg{color:#FD3A25;margin:12px 0}.none{color:#6b6b6b}
</style></head><body><main><h1>Comments</h1><div id="msg"></div>
<h2>Waiting for verify</h2><div id="pending"></div><h2>On the site</h2><div id="approved"></div></main>
<script>
const token = decodeURIComponent(location.hash.slice(1));
const msg = document.getElementById("msg");
async function call(method, url) {
  const r = await fetch(url, { method, headers: { "x-admin-token": token } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("Error " + r.status));
  return j;
}
function card(c, withVerify) {
  const d = document.createElement("div"); d.className = "c";
  const m = document.createElement("div"); m.className = "meta";
  const b = document.createElement("b"); b.textContent = c.name;
  m.append(b, " · " + new Date(c.ts).toLocaleString());
  const t = document.createElement("div"); t.className = "t"; t.textContent = c.text;
  const row = document.createElement("div"); row.className = "row";
  if (withVerify) { const v = document.createElement("button"); v.className = "ok"; v.textContent = "Verify"; v.onclick = () => act(c.id, "approve"); row.append(v); }
  const x = document.createElement("button"); x.textContent = "Delete"; x.onclick = () => act(c.id, "delete"); row.append(x);
  d.append(m, t, row); return d;
}
function fill(id, list, withVerify) {
  const el = document.getElementById(id); el.replaceChildren();
  if (!list.length) { const n = document.createElement("div"); n.className = "none"; n.textContent = "Nothing here."; el.append(n); }
  for (const c of list) el.append(card(c, withVerify));
}
async function act(id, what) { try { await call("POST", "/api/admin/comments/" + id + "/" + what); load(); } catch (e) { msg.textContent = e.message; } }
async function load() {
  try { const j = await call("GET", "/api/admin/comments"); msg.textContent = ""; fill("pending", j.pending, true); fill("approved", j.approved, false); }
  catch (e) { msg.textContent = e.message; }
}
load();
</script></body></html>`;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".json": "application/json", ".map": "application/json", ".gif": "image/gif", ".eot": "application/vnd.ms-fontobject", ".txt": "text/plain", ".ico": "image/x-icon" };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/visits") {
    if (req.method === "POST") record(req, url.searchParams.has("beat"));
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(counts()));
  }
  if (url.pathname === "/api/comments") {
    if (req.method === "POST") return postComment(req, res);
    return json(res, 200, [...comments.values()].filter((c) => c.status === "approved").sort(byNewest).map(pub));
  }
  if (url.pathname.startsWith("/api/admin/")) return adminApi(req, res, url);
  if (url.pathname === "/admin") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" });
    return res.end(ADMIN_HTML);
  }
  let file = path.join(SITE, decodeURIComponent(url.pathname));
  if (!file.startsWith(SITE)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  });
}).listen(PORT, () => console.log(`plagueboard on :${PORT}`));
