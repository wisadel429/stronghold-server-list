# 卫戍协议 · 服务器列表（总览站）

把各服的 `/healthz` 轮询成一张总览页：在线状态、人数、房间、版本、延迟、24 小时可用率与走势。

- **零依赖**（只用 Node 内置模块），Node ≥ 18
- 单进程，1C1G 就够
- 数据只落 `data/state.json`（历史 + 可用率），配置是 `servers.json`

## 文件

| 路径 | 说明 |
|---|---|
| `server.mjs` | 轮询 + HTTP 服务（页面 / `/api/servers` / `/healthz`） |
| `servers.json` | 收录的服务器（初始数据来自 2026-11-20 的备份，14 个） |
| `public/index.html` | 总览页（暗绿风格，15 秒自动刷新） |
| `deploy/stronghold-list.service` | systemd 单元（裸机 / 1Panel 都用得上） |
| `data/state.json` | 运行时生成：每站最近 24h 走势 + 7 天可用率 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3100` | 监听端口（对外建议用反代，不直接暴露） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `POLL_MS` | `30000` | 轮询间隔；**别低于 30 秒**，别给别人的服添负担 |
| `TIMEOUT_MS` | `8000` | 单站超时；机房在国内拉海外服建议 `10000` |
| `DATA_DIR` | `./data` | 数据目录，**必须持久化** |
| `ADMIN_PASSWORD` | 随机 | 管理页口令；不设置则每次启动随机生成并打印到日志 |

## 管理页 `/admin`

打开 `http://<你的地址>/admin`，输入口令后可以：

- 改任意一行的 名称 / 地区 / 维护者 / 入口地址 / 状态路径 / 标签 / 备注 / 排序
- **新增服务器**（右上角，填名称 + 地址即可，状态路径默认 `/healthz`）
- **下架 / 上架**：下架只是把 `enabled` 设成 `false`，配置保留、不再探测、公开页不显示
- **删除**：真删（不可恢复）

改动直接写回 `servers.json` 并立刻重新探测；会话 12 小时，重启服务后需重新登录。

## 本地跑

```bash
node server.mjs
# → http://127.0.0.1:3100
```

## 部署（systemd）

```bash
sudo mkdir -p /opt/stronghold-list && sudo cp -r ./* /opt/stronghold-list/
sudo cp /opt/stronghold-list/deploy/stronghold-list.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now stronghold-list
systemctl status stronghold-list --no-pager
curl -s localhost:3100/healthz
```

## 部署（1Panel）

1. 应用商店 → 运行环境 → **Node.js**（或直接用上面的 systemd）
2. 网站 → 创建站点，反向代理到 `http://127.0.0.1:3100`
3. 反代配置里把超时放大：`proxy_read_timeout 30s;`、`proxy_connect_timeout 10s;`
4. 开 HTTPS（1Panel 里一键 Let's Encrypt）
5. **不需要 WebSocket**（这一点和游戏服不同）

## servers.json 字段

```json
{
  "id": "server-1",
  "title": "一服",
  "region": "广州",
  "maintainer": "Wisadel",
  "url": "http://8.134.50.56:3000",
  "statusPath": "/healthz",
  "tags": ["超限", "炸惊", "堙灭"],
  "notes": "一句话介绍",
  "order": 5,
  "enabled": true
}
```

- `url + statusPath` 就是探测地址；返回 JSON 且 `HTTP 200` 记为在线
- 游戏版本取 `healthz.app`（很多服的 `version` 是**协议号**，不是游戏版本）
- `enabled: false` 可以临时下架但保留配置

## 判定口径

- 超时 / 非 200 / 非 JSON → `unreachable`（页面显示 OFFLINE，**不等于对方真的挂了**）
- 24h 可用率 = 成功点 / 总点数（30 分钟一个点，48 点）
- 7 天可用率 = 按自然日累计（保留最近 7 天）

## 收录礼仪

- 每站 30 秒一次，带固定 UA `StrongholdList/1.0`，对方看日志能认出是谁
- 只拉 `/healthz` 这种公开状态接口，不碰玩家数据
- 收录别人的服前最好先打个招呼；别人要求下架就把 `enabled` 改 `false`
