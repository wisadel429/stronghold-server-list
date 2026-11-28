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
// 感谢名单（业主 2026-11-22）：前台首屏读这份静态副本，后台可在线编辑（写回同一个文件）
const THANKS_FILE = path.join(PUBLIC_DIR, 'thanks.json');
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

/**
 * 玩家点「刷新」时置位（业主 2026-11-28：「让玩家刷新时是真刷新」）。
 * 列表站自己不探测（方案 A），所以这里只记一个时间戳：
 * 国内上报器每 4 秒轮询一次 /api/servers，看到 refreshAt 比上一轮新就**立刻**探一轮并上报。
 */
let refreshAt = 0;
const refreshLog = new Map();   // ip -> 上次请求时间（节流）

/** 玩家评分（超大杯 / 中杯）：{ [serverId]: { large, medium } } */
let votes = {};
const voteLog = new Map();   // ip|id|day → kind（每人每天每服一票）
/** 登录后发的会话令牌（内存表，12 小时过期；重启失效 → 重新登录即可） */
const sessions = new Map();
const SESSION_TTL = 12 * 3600_000;

/** 24 小时走势：48 个点，每 30 分钟一个 */
const HISTORY_POINTS = 1440;   // 分钟桶上限（24h），见 pushPoint
/** 下发给国内上报器的探测间隔：8 秒一轮（业主 2026-11-28「频繁探测」），可用环境变量调 */
const AGENT_INTERVAL_MS = Math.max(3000, Number(process.env.AGENT_INTERVAL_MS) || 8000);
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

// ---------------------------------------------------------------- 感谢名单（业主 2026-11-22：后台可在线编辑）

/** 单行清洗：折叠空白、去首尾、截断（名字和职责都是单行展示，换行没意义） */
const thanksText = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/** 读当前名单；文件缺失或 JSON 损坏时返回空名单，不抛错（管理页照样能编辑） */
function readThanks() {
  try {
    const doc = JSON.parse(fs.readFileSync(THANKS_FILE, 'utf8'));
    if (doc && Array.isArray(doc.names)) {
      return {
        v: Number(doc.v) || 0,
        updated: String(doc.updated || ''),
        title: String(doc.title || '感谢名单'),
        micro: String(doc.micro || 'THANKS LIST'),
        prefix: String(doc.prefix || ''),
        names: doc.names.map((n) => ({ name: String(n && n.name || ''), role: String(n && n.role || '') })),
        dedication: { name: String(doc.dedication && doc.dedication.name || ''), role: String(doc.dedication && doc.dedication.role || '') },
      };
    }
  } catch { /* 缺文件或坏 JSON：落到下面的空名单 */ }
  return { v: 0, updated: '', title: '感谢名单', micro: 'THANKS LIST', prefix: '', names: [], dedication: { name: '', role: '' } };
}

/**
 * 写入名单：清洗 → 原子写（tmp + rename）→ `v` 自增。
 * `v` 是前台判断「要不要重画轨道」的依据，必须每次保存都变。
 */
function writeThanks(input) {
  const src = input && typeof input === 'object' ? input : {};
  const names = (Array.isArray(src.names) ? src.names : [])
    .map((n) => ({ name: thanksText(n && n.name, 40), role: thanksText(n && n.role, 60) }))
    .filter((n) => n.name)
    .slice(0, 300);
  const ded = src.dedication && typeof src.dedication === 'object' ? src.dedication : {};
  const doc = {
    v: Math.max(1, Number(readThanks().v) || 0) + 1,
    updated: new Date().toISOString().slice(0, 10),
    title: thanksText(src.title, 40) || '感谢名单',
    micro: thanksText(src.micro, 40) || 'THANKS LIST',
    prefix: thanksText(src.prefix, 20),
    names,
    dedication: { name: thanksText(ded.name, 40), role: thanksText(ded.role, 60) },
  };
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  const tmp = `${THANKS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc), 'utf8');
  fs.renameSync(tmp, THANKS_FILE);
  return doc;
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
  // 关服（后台「关闭服务器」）时进程仍在跑，/healthz 只回 { version, status:'closing' }，
  // 没有 ok / online 字段 —— 必须单独识别，否则会被当成"在线 0 人"（业主 2026-11-28）
  const rawState = String(json.status ?? json.state ?? '').trim().toLowerCase();
  const closed = rawState === 'closing' || rawState === 'closed' || rawState === 'close'
    || json.closed === true
    || (json.ok === false && /clos/i.test(String(json.reason || '')));
  const online = Number(json.online ?? json.players ?? json.humans);
  // 注意：很多服的 healthz 里 `version` 是**协议号**（数字 1），游戏版本在 `app` 字段
  const appVer = (typeof json.app === 'string' && json.app)
    ? json.app
    : ((typeof json.version === 'string' && /\d+\.\d+/.test(json.version)) ? json.version : '');
  return {
    state: closed ? 'closed' : (json.ok === false ? 'offline' : 'online'),
    closed,
    online: closed ? null : (Number.isFinite(online) ? online : null),
    rooms: closed ? null : (Number.isFinite(Number(json.rooms)) ? Number(json.rooms) : null),
    matches: closed ? null : (Number.isFinite(Number(json.matches)) ? Number(json.matches) : null),
    version: String(appVer || ''),
    build: String(json.build || ''),
    sockets: closed ? null : (Number.isFinite(Number(json.sockets)) ? Number(json.sockets) : null),
  };
}

/**
 * 历史点：**按分钟聚合**（业主 2026-11-28：国内节点要 8 秒探一次，原始点会涨到 24h≈10800 个/服）。
 * 每个点是 [分钟起点时间戳, 该分钟峰值人数, 成功次数, 总次数]，每服最多 1440 个（正好 24h）。
 * 老 state.json 里的 [ts, online] / [ts, online, ok] 由 normalizePoint 兼容。
 */
const HISTORY_MAX = 1440;

function normalizePoint(p) {
  if (!Array.isArray(p) || !p.length) return null;
  const ts = Number(p[0]) || 0;
  if (p.length >= 4) return [ts, p[1] == null ? null : Number(p[1]), Number(p[2]) || 0, Number(p[3]) || 0];
  // 老格式：[ts, online] 或 [ts, online, ok]
  const okFlag = p.length >= 3 ? (Number(p[2]) === 1 ? 1 : 0) : (p[1] == null ? 0 : 1);
  return [ts, p[1] == null ? null : Number(p[1]), okFlag, 1];
}

function pushPoint(s, ts, online, ok) {
  if (!Array.isArray(s.history24h)) s.history24h = [];
  else if (s.history24h.length && s.history24h[s.history24h.length - 1].length < 4) {
    s.history24h = s.history24h.map(normalizePoint).filter(Boolean);
  }
  const bucket = Math.floor(ts / 60000) * 60000;
  const last = s.history24h[s.history24h.length - 1];
  const okNum = ok ? 1 : 0;
  if (last && last[0] === bucket) {
    last[1] = (online == null) ? last[1] : Math.max(Number(last[1]) || 0, Number(online) || 0);
    last[2] += okNum;
    last[3] += 1;
  } else {
    s.history24h.push([bucket, online == null ? null : Number(online) || 0, okNum, 1]);
  }
  const cut = ts - 24 * 3600_000;
  while (s.history24h.length && s.history24h[0][0] < cut) s.history24h.shift();
  if (s.history24h.length > HISTORY_MAX) s.history24h = s.history24h.slice(-HISTORY_MAX);
}

/** 把分钟桶合并成 48 段（每段 30 分钟）→ [[ts, 峰值, 可用率 0..1 或 null]] */
function historyBuckets(s, count = 48, spanMs = 15 * 60000) {   // 48 格 × 15 分钟 = 12 小时（业主 2026-11-28）
  const pts = Array.isArray(s.history24h) ? s.history24h : [];
  const now = Date.now();
  const start = Math.floor(now / spanMs) * spanMs - (count - 1) * spanMs;
  const out = [];
  for (let i = 0; i < count; i++) {
    const bStart = start + i * spanMs;
    const bEnd = bStart + spanMs;
    let peak = null, ok = 0, total = 0;
    for (const p of pts) {
      if (p[0] < bStart || p[0] >= bEnd) continue;
      total += p[3] || 0;
      ok += p[2] || 0;
      if (p[1] != null) peak = peak == null ? p[1] : Math.max(peak, p[1]);
    }
    out.push([bStart, peak, total ? ok / total : null]);
  }
  return out;
}

/** 24h 可用率（按分钟桶的 ok/total 算，比按点算准） */
function uptime12h(s) {
  const pts = Array.isArray(s.history24h) ? s.history24h : [];
  const cut = Date.now() - 12 * 3600_000;
  let ok = 0, total = 0;
  for (const p of pts) { if (p[0] < cut) continue; total += p[3] || 0; ok += p[2] || 0; }
  return total ? Math.round((ok / total) * 1000) / 10 : null;
}

function uptimeFromHistory(s) {
  const pts = Array.isArray(s.history24h) ? s.history24h : [];
  const now = Date.now();
  const cut = now - 24 * 3600_000;
  let ok = 0, total = 0;
  for (const p of pts) {
    if (p[0] < cut) continue;
    total += p[3] || 0;
    ok += p[2] || 0;
  }
  return total ? Math.round((ok / total) * 1000) / 10 : null;
}

/** 按天累计可用率（保留最近 7 天） */
function bumpDay(s, ok, ts) {
  if (!s.days || typeof s.days !== 'object') s.days = {};
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
  // 只有"在线且在开服"才算可用；关服（closed）按不可用记，走势与可用率都算失败
  const usable = outcome.ok && s.status.state === 'online';
  const online = usable ? (s.status.online == null ? 0 : s.status.online) : null;
  pushPoint(s, now, online, usable);
  bumpDay(s, usable, now);
  s.uptime24h = uptimeFromHistory(s);
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

  if (url.pathname === '/admin/api/list') return json(res, 200, Object.assign(serversPayload(true), { stats: statsPayload() }));

  if (url.pathname === '/admin/api/stats') return json(res, 200, statsPayload());

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

  // 感谢名单：GET 读、POST 写（业主 2026-11-22 提的需求：后台直接编辑，不用改文件再部署）
  if (url.pathname === '/admin/api/thanks') {
    if (req.method === 'GET') return json(res, 200, readThanks());
    if (req.method === 'POST') {
      const doc = writeThanks(JSON.parse((await readBody(req)) || '{}'));
      log(`管理：感谢名单已更新（${doc.names.length} 位，v${doc.v}）`);
      return json(res, 200, { ok: true, count: doc.names.length, doc });
    }
    return json(res, 405, { error: '只支持 GET / POST' });
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

/**
 * POST /api/vote { id, kind: 'large'|'medium' } → 每人每天每服**一票，但可以改投**
 * （业主 2026-11-22：点错了不该被锁死到第二天）
 * 改投 = 把旧那一票扣掉（最小 0）再记新票，同一 IP 同一天同一服始终只算一票。
 */
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
  const prev = voteLog.get(key) || '';
  if (prev === kind) return json(res, 200, { ok: true, unchanged: true, myKind: kind, ...ratingOf(id) });
  votes[id] = votes[id] || { large: 0, medium: 0 };
  if (prev) votes[id][prev] = Math.max(0, (Number(votes[id][prev]) || 0) - 1);   // 改投：先退旧票
  votes[id][kind] = (Number(votes[id][kind]) || 0) + 1;
  voteLog.set(key, kind);
  saveVotes();
  log(`评分：${srv.title} ← ${kind}${prev ? `（由 ${prev} 改投）` : ''}（${votes[id].large}/${votes[id].medium}）`);
  return json(res, 200, { ok: true, changed: !!prev, myKind: kind, ...ratingOf(id) });
}

// ---------------------------------------------------------------- 访问量 / 抓取量（业主 2026-11-28）

const STATS_FILE = path.join(DATA_DIR, 'stats.json');
/** { days: { '2026-11-28': { page, uv, api, report } }, total: { page, uv, api, report } } */
let stats = { days: {}, total: { page: 0, uv: 0, api: 0, report: 0 } };
const uvSeen = new Map();        // day -> Set(ip)，只存内存（重启丢，够用）
let statsTimer = null;

function dayKeyOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function loadStats() {
  try {
    const doc = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    if (doc && typeof doc === 'object') {
      stats = { days: doc.days || {}, total: Object.assign({ page: 0, uv: 0, api: 0, report: 0 }, doc.total || {}) };
    }
  } catch { /* 首次运行没有文件 */ }
}

function saveStats() {
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${STATS_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(stats), 'utf8');
      fs.renameSync(tmp, STATS_FILE);
    } catch (e) { log('统计写盘失败', e.message); }
  }, 5000);
}

/** kind: page（页面访问）/ api（抓取 /api/servers）/ report（国内上报） */
function bumpStat(kind, ip) {
  const day = dayKeyOf(Date.now());
  const d = stats.days[day] || (stats.days[day] = { page: 0, uv: 0, api: 0, report: 0 });
  d[kind] = (Number(d[kind]) || 0) + 1;
  stats.total[kind] = (Number(stats.total[kind]) || 0) + 1;
  if (kind === 'page' && ip) {
    let set = uvSeen.get(day);
    if (!set) uvSeen.set(day, (set = new Set()));
    if (!set.has(ip)) {
      set.add(ip);
      d.uv = set.size;
      if (day === dayKeyOf(Date.now())) stats.total.uv = (Number(stats.total.uv) || 0) + 1;
    }
  }
  const keys = Object.keys(stats.days).sort();
  while (keys.length > 60) delete stats.days[keys.shift()];
  saveStats();
}

function sumDays(keys) {
  const out = { page: 0, uv: 0, api: 0, report: 0 };
  for (const k of keys) {
    const d = stats.days[k];
    if (!d) continue;
    out.page += Number(d.page) || 0;
    out.uv += Number(d.uv) || 0;
    out.api += Number(d.api) || 0;
    out.report += Number(d.report) || 0;
  }
  return out;
}

function statsPayload() {
  const today = dayKeyOf(Date.now());
  const yest = dayKeyOf(Date.now() - 86400_000);
  const last7 = [];
  for (let i = 0; i < 7; i++) last7.push(dayKeyOf(Date.now() - i * 86400_000));
  return {
    today: Object.assign({ page: 0, uv: 0, api: 0, report: 0 }, stats.days[today] || {}),
    yesterday: Object.assign({ page: 0, uv: 0, api: 0, report: 0 }, stats.days[yest] || {}),
    week: sumDays(last7),
    total: stats.total,
    days: Object.keys(stats.days).sort().slice(-14).map((k) => Object.assign({ day: k }, stats.days[k])),
  };
}

// ---------------------------------------------------------------- HTTP

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' };

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
    refreshAt: refreshAt || 0,
    agentIntervalMs: AGENT_INTERVAL_MS,
    servers: list.map((srv) => {
      const s = ensureState(srv.id);
      return {
        ...srv,
        status: s.status,
        error: s.error || null,
        source: s.source || null,
        checkedAt: s.checkedAt,
        uptime24h: s.uptime24h,
    uptime12h: uptime12h(s),
        uptime7d: s.uptime7d,
        history24h: historyBuckets(s),
        rating: ratingOf(srv.id),
      };
    }),
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0].trim();
  if (url.pathname === '/api/servers') {
    bumpStat('api', ip);
    res.setHeader('access-control-allow-origin', '*');
    return json(res, 200, serversPayload());
  }
  if (url.pathname === '/healthz') {
    return json(res, 200, { ok: true, service: 'stronghold-server-list', servers: config.servers.length, at: Date.now() });
  }
  if (url.pathname === '/' || url.pathname === '/index.html') bumpStat('page', ip);
  // 玩家点「刷新」→ 记一个时间戳，让国内上报器立刻探一轮（真刷新）
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    const now = Date.now();
    const last = refreshLog.get(ip) || 0;
    if (now - last < 2000) return json(res, 200, { ok: true, throttled: true, at: refreshAt, lastReportAt: reportState.lastAt });
    refreshLog.set(ip, now);
    if (refreshLog.size > 5000) refreshLog.clear();
    refreshAt = now;
    return json(res, 200, { ok: true, at: now, lastReportAt: reportState.lastAt });
  }
  if (url.pathname === '/admin') return serveStatic(res, '/admin.html');
  if (url.pathname === '/api/report' && req.method === 'POST') {
    bumpStat('report', ip);
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
loadStats();
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
