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

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".json": "application/json", ".map": "application/json", ".gif": "image/gif", ".eot": "application/vnd.ms-fontobject", ".txt": "text/plain" };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/visits") {
    if (req.method === "POST") record(req, url.searchParams.has("beat"));
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(counts()));
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
