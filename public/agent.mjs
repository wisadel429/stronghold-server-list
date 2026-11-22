// agent.mjs — 国内探测节点（业主 2026-11-22 方案 A）
//
// 跑在**国内**的机器上（例如游戏服），每 30 秒拉一次列表、逐个探测，把结果 POST 给列表站。
// 列表站只展示，不做探测 —— 因为香港机房直连国内"裸 IP:端口"经常不通，会把在线的服误判成离线。
//
// 零依赖，Node >= 18。用法：
//   LIST_URL=https://mon3tr.fun REPORT_TOKEN=xxx node agent.mjs
//
// Windows（管理员 PowerShell）：
//   $env:LIST_URL='https://mon3tr.fun'; $env:REPORT_TOKEN='xxx'; node agent.mjs

import http from 'node:http';
import https from 'node:https';

const LIST_URL = (process.env.LIST_URL || 'https://mon3tr.fun').replace(/\/+$/, '');
const REPORT_TOKEN = process.env.REPORT_TOKEN || '';
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 30000);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 8000);
const SOURCE = process.env.SOURCE || 'cn';

if (!REPORT_TOKEN) {
  console.error('缺少 REPORT_TOKEN。示例：REPORT_TOKEN=xxx node agent.mjs');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** 简单 GET/POST，返回 { status, body } */
function request(url, { method = 'GET', body = null, timeout = TIMEOUT_MS * 2, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const data = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const req = mod.request(url, {
      method,
      timeout,
      rejectUnauthorized: false,
      headers: {
        'user-agent': 'StrongholdListAgent/1.0',
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 4 * 1024 * 1024) { req.destroy(); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** 探一个站的 statusPath，返回 { ok, latencyMs, health?, error? } */
async function probe(srv) {
  const url = srv.url.replace(/\/+$/, '') + (srv.statusPath || '/healthz');
  const started = Date.now();
  try {
    const r = await request(url, { timeout: TIMEOUT_MS, headers: { accept: 'application/json' } });
    const latencyMs = Date.now() - started;
    if (r.status !== 200) return { ok: false, latencyMs, error: `HTTP ${r.status}` };
    let health;
    try { health = JSON.parse(r.body); } catch { return { ok: false, latencyMs, error: '不是 JSON' }; }
    return { ok: true, latencyMs, health };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: e.code || e.message || 'error' };
  }
}

async function cycle() {
  // 1) 拉列表（只拿 id / url / statusPath）
  const listRes = await request(`${LIST_URL}/api/servers`, { timeout: TIMEOUT_MS * 2 });
  if (listRes.status !== 200) { log(`拉列表失败 HTTP ${listRes.status}`); return; }
  const doc = JSON.parse(listRes.body);
  const servers = (doc.servers || []).filter((s) => s && s.url);
  if (!servers.length) { log('列表为空，跳过'); return; }

  // 2) 并发探测
  const results = await Promise.all(servers.map(async (srv) => {
    const r = await probe(srv);
    return { id: srv.id, ...r };
  }));

  // 3) 上报
  const up = await request(`${LIST_URL}/api/report`, {
    method: 'POST',
    body: { token: REPORT_TOKEN, source: SOURCE, at: Date.now(), results },
    timeout: TIMEOUT_MS * 2,
  });
  const okCount = results.filter((r) => r.ok).length;
  let note = up.body;
  try { note = JSON.stringify(JSON.parse(up.body)); } catch { /* 保持原文 */ }
  log(`探测 ${results.length} 个：在线 ${okCount} / 离线 ${results.length - okCount} → 上报 HTTP ${up.status} ${note}`);
}

async function main() {
  log(`agent 启动：列表站 ${LIST_URL}，间隔 ${INTERVAL_MS}ms，超时 ${TIMEOUT_MS}ms，来源标记 ${SOURCE}`);
  for (;;) {
    try { await cycle(); } catch (e) { log('本轮失败：' + (e.message || e)); }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main();
