// Serves site/ and counts unique visitors (past hour, day, week).
// A visitor = sha256(salt + IP + user agent); the salt is made on first start and kept in DATA_DIR, never in git.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 80);
const SITE = path.resolve("site");
const DATA = process.env.DATA_DIR || "/data";
const LOG = path.join(DATA, "visits.jsonl");
const WEEK = 7 * 24 * 3600 * 1000;
const BOT = /bot|crawl|spider|slurp|curl|wget|python|httpclient|headless|preview|monitor|uptime/i;

fs.mkdirSync(DATA, { recursive: true });
const saltFile = path.join(DATA, "salt");
if (!fs.existsSync(saltFile)) fs.writeFileSync(saltFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
const salt = fs.readFileSync(saltFile, "utf8").trim();

// [ts, hash] for the past week, oldest first
let visits = [];
if (fs.existsSync(LOG)) {
  const cutoff = Date.now() - WEEK;
  for (const line of fs.readFileSync(LOG, "utf8").split("\n")) {
    try { const v = JSON.parse(line); if (v[0] >= cutoff) visits.push(v); } catch {}
  }
  fs.writeFileSync(LOG, visits.map((v) => JSON.stringify(v)).join("\n") + (visits.length ? "\n" : ""));
}

function prune() {
  const cutoff = Date.now() - WEEK;
  let i = 0;
  while (i < visits.length && visits[i][0] < cutoff) i++;
  if (i) visits = visits.slice(i);
}

function counts() {
  prune();
  const now = Date.now();
  const since = (ms) => new Set(visits.filter((v) => v[0] >= now - ms).map((v) => v[1])).size;
  return { hour: since(3600e3), day: since(24 * 3600e3), week: since(WEEK) };
}

function record(req) {
  const ua = req.headers["user-agent"] || "";
  if (!ua || BOT.test(ua)) return;
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const hash = crypto.createHash("sha256").update(salt + ip + ua).digest("hex").slice(0, 20);
  const v = [Date.now(), hash];
  visits.push(v);
  fs.appendFile(LOG, JSON.stringify(v) + "\n", () => {});
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".json": "application/json", ".map": "application/json", ".gif": "image/gif", ".eot": "application/vnd.ms-fontobject", ".txt": "text/plain" };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/visits") {
    if (req.method === "POST") record(req);
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
