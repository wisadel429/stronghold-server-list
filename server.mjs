// list-site/server.mjs — 卫戍协议 · 服务器列表（总览站）
//
// 纯 Node（>=18），零依赖：轮询各服 /healthz → 存状态与走势 → 输出一个页面 + 一个 JSON API。
// 数据契约沿用 2026-11-20 的 servers.json 备份（字段见 README）。
//
// 环境变量：
//   PORT        监听端口（默认 3100）
//   HOST        监听地址（默认 0.0.0.0）
//   POLL_MS     轮询间隔（默认 30000）
//   TIMEOUT_MS  单站超时（默认 8000；国内机房拉到海外服建议 10000）
//   DATA_DIR    数据目录（默认 ./data，必须持久化）

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '0.0.0.0';
const POLL_MS = Number(process.env.POLL_MS || 30000);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 8000);
const DATA_DIR = path.resolve(HERE, process.env.DATA_DIR || 'data');
const SERVERS_FILE = path.join(HERE, 'servers.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const VOTES_FILE = path.join(DATA_DIR, 'votes.json');
const PUBLIC_DIR = path.join(HERE, 'public');
const UA = 'StrongholdList/1.0 (+server list overview)';

/** 管理页口令：环境变量优先；没设就每次启动随机生成（会打到日志里提醒） */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || randomToken(6);
const ADMIN_RANDOM = !process.env.ADMIN_PASSWORD;

/**
 * 上报令牌（业主 2026-11-22 方案 A）：探测由**国内节点**做，列表站只负责展示。
 * 配了 REPORT_TOKEN 就默认关闭本机探测（可用 LOCAL_PROBE=1 强制同时开）。
 */
const REPORT_TOKEN = process.env.REPORT_TOKEN || '';
const LOCAL_PROBE = process.env.LOCAL_PROBE ? process.env.LOCAL_PROBE === '1' : !REPORT_TOKEN;
const reportState = { lastAt: 0, count: 0, source: '' };

/** 玩家评分（超大杯 / 中杯）：{ [serverId]: { large, medium } } */
let votes = {};
const voteLog = new Map();   // ip|id|day → kind（每人每天每服一票）
/** 登录后发的会话令牌（内存表，12 小时过期；重启失效 → 重新登录即可） */
const sessions = new Map();
const SESSION_TTL = 12 * 3600_000;

/** 24 小时走势：48 个点，每 30 分钟一个 */
const HISTORY_POINTS = 48;
const POINT_MS = 30 * 60_000;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- 数据

/** @type {{servers: any[], pollSeconds: number}} */
let config = { servers: [], pollSeconds: Math.round(POLL_MS / 1000) };
/** @type {Map<string, any>} */
const state = new Map();

function loadConfig() {
  const raw = fs.readFileSync(SERVERS_FILE, 'utf8').replace(/^\uFEFF/, '');
  const doc = JSON.parse(raw);
  const rows = Array.isArray(doc) ? doc : doc.servers || [];
  config.servers = rows
    .filter((r) => r && r.url)
    .map((r, i) => ({
      id: String(r.id || `s${i}`),
      title: String(r.title || r.url),
      region: String(r.region || ''),
      maintainer: String(r.maintainer || ''),
      version: String(r.version || ''),
      notes: String(r.notes || ''),
      notice: String(r.notice || ''),
      url: String(r.url).replace(/\/+$/, ''),
      tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
      statusPath: String(r.statusPath || '/healthz'),
      order: Number.isFinite(r.order) ? r.order : i,
      // 下架的仍然留在配置里（管理页要能再上架），只是不探测、不上公开页
      enabled: r.enabled !== false,
    }))
    .sort((a, b) => a.order - b.order);
  log(`配置载入：${config.servers.length} 个服（其中 ${config.servers.filter((s) => s.enabled).length} 个启用）`);
}

function loadState() {
  try {
    const doc = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const row of doc.servers || []) if (row && row.id) state.set(row.id, row);
    log(`状态载入：${state.size} 条`);
  } catch { /* 首次运行 */ }
}

let saving = false;
function saveState() {
  if (saving) return;
  saving = true;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), servers: [...state.values()] }), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { log('状态写盘失败', e.message); }
  finally { saving = false; }
}

/** 评分：读盘 / 写盘 / 查一个服的票数 */
function loadVotes() {
  try {
    const doc = JSON.parse(fs.readFileSync(VOTES_FILE, 'utf8'));
    votes = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  } catch { votes = {}; }
}
function saveVotes() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${VOTES_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(votes), 'utf8');
    fs.renameSync(tmp, VOTES_FILE);
  } catch (e) { log('评分写盘失败', e.message); }
}
function ratingOf(id) {
  const v = votes[id] || {};
  return { large: Number(v.large) || 0, medium: Number(v.medium) || 0 };
}

function ensureState(id) {
  let s = state.get(id);
  if (!s) {
    s = { id, status: null, uptime24h: null, uptime7d: null, history24h: [], days: {}, checkedAt: 0 };
    state.set(id, s);
  }
  return s;
}

// ---------------------------------------------------------------- 探测

/** 拉一个站的 /healthz，返回 { ok, status, latencyMs, error } */
function probe(srv) {
  return new Promise((resolve) => {
    const url = srv.url + srv.statusPath;
    const started = Date.now();
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, {
      timeout: TIMEOUT_MS,
      headers: { 'user-agent': UA, accept: 'application/json' },
      rejectUnauthorized: false, // 自签证书的服也要能收录（另记 certificateWarning）
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 256 * 1024) { req.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const latencyMs = Date.now() - started;
        const body = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(body); } catch { /* 不是 JSON */ }
        if (res.statusCode !== 200 || !json) {
          resolve({ ok: false, latencyMs, error: `HTTP ${res.statusCode}` });
          return;
        }
        resolve({ ok: true, latencyMs, json });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, latencyMs: Date.now() - started, error: e.code || e.message }));
  });
}

/** healthz 的字段在不同版本上不完全一致，逐项兜底 */
function normalizeHealth(json) {
  const online = Number(json.online ?? json.players ?? json.humans);
  // 注意：很多服的 healthz 里 `version` 是**协议号**（数字 1），游戏版本在 `app` 字段
  const appVer = (typeof json.app === 'string' && json.app)
    ? json.app
    : ((typeof json.version === 'string' && /\d+\.\d+/.test(json.version)) ? json.version : '');
  return {
    state: json.ok === false ? 'offline' : 'online',
    online: Number.isFinite(online) ? online : null,
    rooms: Number.isFinite(Number(json.rooms)) ? Number(json.rooms) : null,
    matches: Number.isFinite(Number(json.matches)) ? Number(json.matches) : null,
    version: String(appVer || ''),
    build: String(json.build || ''),
    sockets: Number.isFinite(Number(json.sockets)) ? Number(json.sockets) : null,
  };
}

function pushPoint(s, ts, online) {
  s.history24h.push([ts, online]);
  const cut = ts - 24 * 3600_000;
  while (s.history24h.length && s.history24h[0][0] < cut) s.history24h.shift();
  if (s.history24h.length > HISTORY_POINTS) s.history24h = s.history24h.slice(-HISTORY_POINTS);
}

/** 按天累计可用率（保留最近 7 天） */
function bumpDay(s, ok, ts) {
  const d = new Date(ts);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const day = s.days[key] || { ok: 0, total: 0 };
  day.total++;
  if (ok) day.ok++;
  s.days[key] = day;
  const keys = Object.keys(s.days).sort();
  while (keys.length > 7) delete s.days[keys.shift()];
  let ok7 = 0, t7 = 0;
  for (const k of Object.keys(s.days)) { ok7 += s.days[k].ok; t7 += s.days[k].total; }
  s.uptime7d = t7 ? Math.round((ok7 / t7) * 1000) / 10 : null;
}

/** 把一次探测结果落到状态里（本机探测与国内上报共用同一条路径） */
function applyOutcome(srv, outcome, now) {
  const s = ensureState(srv.id);
  s.checkedAt = now;
  s.source = outcome.source || 'local';
  s.latencyMs = outcome.ok ? outcome.latencyMs : null;
  s.error = outcome.ok ? null : (outcome.error || 'unreachable');
  if (outcome.ok) {
    s.status = normalizeHealth(outcome.health || {});
    s.status.latencyMs = outcome.latencyMs;
    s.status.certificateWarning = false;
  } else {
    s.status = { state: 'unreachable', online: null, latencyMs: null };
  }
  // 只按"在线/离线"记点，人数单独存，避免走势被空值打断
  const online = outcome.ok ? (s.status.online == null ? 0 : s.status.online) : null;
  pushPoint(s, now, online);
  bumpDay(s, outcome.ok, now);
  const okPoints = s.history24h.filter((p) => p[1] != null).length;
  s.uptime24h = s.history24h.length ? Math.round((okPoints / s.history24h.length) * 1000) / 10 : null;
  return s;
}

async function pollOne(srv) {
  const r = await probe(srv);
  applyOutcome(srv, { ok: r.ok, latencyMs: r.latencyMs, health: r.json, error: r.error, source: 'local' }, Date.now());
}

let polling = false;
async function pollAll() {
  if (!LOCAL_PROBE) return;          // 方案 A：由国内节点上报时，本机不再探测
  if (polling) return;
  polling = true;
  const started = Date.now();
  try {
    const active = config.servers.filter((srv) => srv.enabled !== false);
    await Promise.all(active.map((srv) => pollOne(srv).catch((e) => log('探测异常', srv.id, e.message))));
  } finally {
    polling = false;
    saveState();
    log(`轮询完成：${config.servers.length} 个服，用时 ${Date.now() - started}ms`);
  }
}

// ---------------------------------------------------------------- 管理（/admin）

function randomToken(n = 24) {
  return crypto.randomBytes(n).toString('hex').slice(0, n * 2);
}

function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cookieOf(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function authed(req) {
  const t = cookieOf(req, 'sl_admin');
  const exp = sessions.get(t);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(t); return false; }
  return true;
}

/** 读原始 servers.json（保住别人的手写字段，不整份重写） */
function readServersRaw() {
  const doc = JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8').replace(/^\uFEFF/, ''));
  const rows = Array.isArray(doc) ? doc : (doc.servers || []);
  return { base: Array.isArray(doc) ? { servers: rows } : doc, rows };
}

function writeServersFile(rows) {
  const doc = { pollSeconds: Math.round(POLL_MS / 1000), servers: rows };
  const tmp = `${SERVERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  fs.renameSync(tmp, SERVERS_FILE);
  loadConfig();
}

/** 管理页提交的一行 → 规范化（缺 id 视为新增） */
function rowFromInput(b) {
  const url = String(b.url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) throw new Error('入口地址必须以 http:// 或 https:// 开头');
  const tags = Array.isArray(b.tags)
    ? b.tags.map((t) => String(t).trim()).filter(Boolean)
    : String(b.tags || '').split(/[,，、]/).map((t) => t.trim()).filter(Boolean);
  return {
    id: String(b.id || '').trim() || `s${Date.now().toString(36)}`,
    title: String(b.title || '').trim() || url,
    region: String(b.region || '').trim(),
    maintainer: String(b.maintainer || '').trim(),
    url,
    statusPath: String(b.statusPath || '/healthz').trim() || '/healthz',
    tags,
    notes: String(b.notes || '').trim().replace(/\s*\n\s*/g, '\n'),
    order: Number.isFinite(Number(b.order)) ? Number(b.order) : 99,
    enabled: b.enabled !== false,
  };
}

/** 跑一条命令，返回 { code, out } */
function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, out: `${stdout || ''}${stderr || ''}`.trim().slice(-2000) });
    });
  });
}

/**
 * 自更新：git pull --ff-only；如果 server.mjs / package.json 变了就退出让 systemd 重启。
 * 只执行固定命令，不接受任何外部传入的参数 —— 不是通用远程执行。
 */
async function deploySelf() {
  if (!fs.existsSync(path.join(HERE, '.git'))) {
    return { ok: false, error: '这个目录不是 git 仓库，无法自更新' };
  }
  const before = (await run('git', ['rev-parse', 'HEAD'], HERE)).out;
  // 显式指定 origin + 当前分支：不依赖本地的 upstream 跟踪配置
  const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], HERE)).out.trim() || 'main';
  const pull = await run('git', ['pull', '--ff-only', 'origin', branch], HERE);
  const after = (await run('git', ['rev-parse', 'HEAD'], HERE)).out;
  const changed = before && after && before !== after
    ? (await run('git', ['diff', '--name-only', before, after], HERE)).out.split('\n').filter(Boolean)
    : [];
  const needRestart = changed.some((f) => f === 'server.mjs' || f === 'package.json');
  return {
    ok: pull.code === 0,
    before: before.slice(0, 8),
    after: after.slice(0, 8),
    changed,
    restarted: needRestart,
    out: pull.out,
  };
}

async function handleAdmin(req, res, url) {
  // 登录
  if (url.pathname === '/admin/login' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (String(body.password || '') !== ADMIN_PASSWORD) return json(res, 401, { error: '口令不对' });
    const token = randomToken(24);
    sessions.set(token, Date.now() + SESSION_TTL);
    res.setHeader('set-cookie', `sl_admin=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL / 1000}; SameSite=Lax`);
    return json(res, 200, { ok: true, ttlHours: SESSION_TTL / 3600_000 });
  }

  // 登出：清掉服务端会话 + 立刻让 cookie 失效（业主 2026-11-22）
  if (url.pathname === '/admin/logout' && req.method === 'POST') {
    const t = cookieOf(req, 'sl_admin');
    if (t) sessions.delete(t);
    res.setHeader('set-cookie', 'sl_admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
    return json(res, 200, { ok: true });
  }

  if (!authed(req)) return json(res, 401, { error: '未登录' });

  if (url.pathname === '/admin/api/list') return json(res, 200, serversPayload(true));

  // 自更新（业主 2026-11-22：以后改代码不用再手工 git pull）
  if (url.pathname === '/admin/api/deploy' && req.method === 'POST') {
    const r = await deploySelf();
    json(res, r.ok ? 200 : 500, r);
    if (r.restarted) {
      log('自更新：server.mjs 有变化，2 秒后重启进程');
      setTimeout(() => process.exit(0), 2000);   // systemd Restart=always 会拉起来
    }
    return;
  }

  if (url.pathname === '/admin/api/save' && req.method === 'POST') {
    const row = rowFromInput(JSON.parse((await readBody(req)) || '{}'));
    const { base, rows } = readServersRaw();
    const i = rows.findIndex((r) => r && r.id === row.id);
    if (i >= 0) rows[i] = { ...rows[i], ...row };
    else rows.push(row);
    writeServersFile(rows);
    pollAll();
    log(`管理：${i >= 0 ? '修改' : '新增'} ${row.id} ${row.title}`);
    return json(res, 200, { ok: true, id: row.id, created: i < 0, count: rows.length });
  }

  if (url.pathname === '/admin/api/delete' && req.method === 'POST') {
    const { id } = JSON.parse((await readBody(req)) || '{}');
    const { rows } = readServersRaw();
    const next = rows.filter((r) => r && r.id !== id);
    if (next.length === rows.length) return json(res, 404, { error: '没找到这条' });
    writeServersFile(next);
    state.delete(id);
    log(`管理：删除 ${id}`);
    return json(res, 200, { ok: true, count: next.length });
  }

  if (url.pathname === '/admin/api/toggle' && req.method === 'POST') {
    const { id, enabled } = JSON.parse((await readBody(req)) || '{}');
    const { rows } = readServersRaw();
    const row = rows.find((r) => r && r.id === id);
    if (!row) return json(res, 404, { error: '没找到这条' });
    row.enabled = !!enabled;
    writeServersFile(rows);
    log(`管理：${enabled ? '上架' : '下架'} ${id}`);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------- 上报（国内探测节点 → 列表站）

/**
 * POST /api/report
 * { token, source?, results:[{ id, ok, latencyMs, health?, error? }] }
 * 由国内节点（游戏服）定时上报；列表站只负责落库与展示。
 */
async function handleReport(req, res) {
  if (!REPORT_TOKEN) return json(res, 503, { error: '未配置 REPORT_TOKEN，拒绝接收上报' });
  const body = JSON.parse((await readBody(req)) || '{}');
  const token = String(body.token || req.headers['x-report-token'] || '');
  if (token !== REPORT_TOKEN) return json(res, 401, { error: 'token 不对' });
  const results = Array.isArray(body.results) ? body.results : [];
  const now = Date.now();
  const source = String(body.source || 'cn').slice(0, 16);
  let applied = 0;
  const unknown = [];
  for (const r of results) {
    if (!r || typeof r.id !== 'string') continue;
    const srv = config.servers.find((s) => s.id === r.id);
    if (!srv) { unknown.push(r.id); continue; }
    if (srv.enabled === false) continue;
    applyOutcome(srv, {
      ok: !!r.ok,
      latencyMs: Number(r.latencyMs) || null,
      health: r.health || {},
      error: r.error,
      source,
    }, now);
    applied++;
  }
  reportState.lastAt = now;
  reportState.count += applied;
  reportState.source = source;
  saveState();
  return json(res, 200, { ok: true, applied, unknown: unknown.slice(0, 10), servers: config.servers.length });
}

// ---------------------------------------------------------------- 评分（超大杯 / 中杯）

/** POST /api/vote { id, kind: 'large'|'medium' } → 每人每天每服一票（按 IP 去重） */
async function handleVote(req, res) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const id = String(body.id || '');
  const kind = body.kind === 'large' || body.kind === 'medium' ? body.kind : '';
  if (!kind) return json(res, 400, { error: 'kind 必须是 large 或 medium' });
  const srv = config.servers.find((s) => s.id === id);
  if (!srv) return json(res, 404, { error: '没有这个服务器' });

  const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0].trim();
  const day = new Date().toISOString().slice(0, 10);
  const key = `${ip}|${id}|${day}`;
  if (voteLog.has(key)) return json(res, 429, { error: '今天已经给这个服投过票了', ...ratingOf(id) });
  voteLog.set(key, kind);
  votes[id] = votes[id] || { large: 0, medium: 0 };
  votes[id][kind] = (Number(votes[id][kind]) || 0) + 1;
  saveVotes();
  log(`评分：${srv.title} ← ${kind}（${votes[id].large}/${votes[id].medium}）`);
  return json(res, 200, { ok: true, ...ratingOf(id) });
}

// ---------------------------------------------------------------- HTTP

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function serveStatic(res, rel) {
  const file = path.join(PUBLIC_DIR, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

function serversPayload(all = false) {
  const list = all ? config.servers : config.servers.filter((s) => s.enabled !== false);
  return {
    pollSeconds: Math.round(POLL_MS / 1000),
    serverTime: Date.now(),
    probeSource: reportState.lastAt ? (reportState.source || 'cn') : (LOCAL_PROBE ? 'local' : ''),
    lastReportAt: reportState.lastAt || 0,
    servers: list.map((srv) => {
      const s = ensureState(srv.id);
      return {
        ...srv,
        status: s.status,
        error: s.error || null,
        source: s.source || null,
        checkedAt: s.checkedAt,
        uptime24h: s.uptime24h,
        uptime7d: s.uptime7d,
        history24h: s.history24h,
        rating: ratingOf(srv.id),
      };
    }),
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  if (url.pathname === '/api/servers') return json(res, 200, serversPayload());
  if (url.pathname === '/healthz') {
    return json(res, 200, { ok: true, service: 'stronghold-server-list', servers: config.servers.length, at: Date.now() });
  }
  if (url.pathname === '/admin') return serveStatic(res, '/admin.html');
  if (url.pathname === '/api/report' && req.method === 'POST') {
    return handleReport(req, res).catch((e) => json(res, 400, { error: e.message }));
  }
  if (url.pathname === '/api/vote' && req.method === 'POST') {
    return handleVote(req, res).catch((e) => json(res, 400, { error: e.message }));
  }
  if (url.pathname === '/admin/login' || url.pathname === '/admin/logout' || url.pathname.startsWith('/admin/api/')) {
    return handleAdmin(req, res, url).catch((e) => json(res, 400, { error: e.message }));
  }
  return serveStatic(res, decodeURIComponent(url.pathname));
});

// ---------------------------------------------------------------- 启动

loadConfig();
loadState();
loadVotes();
server.listen(PORT, HOST, () => {
  log(`列表站已启动 http://${HOST}:${PORT}（轮询 ${config.servers.length} 个服 / ${POLL_MS}ms）`);
  log(`管理页 /admin${ADMIN_RANDOM ? ' · 本次随机口令：' + ADMIN_PASSWORD + '（建议设置 ADMIN_PASSWORD 固定下来）' : ' · 口令来自 ADMIN_PASSWORD'}`);
  log(LOCAL_PROBE
    ? `探测：本机（每 ${POLL_MS}ms）`
    : `探测：**外部上报**（REPORT_TOKEN 已配置，本机不探测；上报地址 POST /api/report）`);
  pollAll();
  setInterval(pollAll, POLL_MS).unref?.();
});
process.on('SIGTERM', () => { saveState(); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { saveState(); server.close(() => process.exit(0)); });
