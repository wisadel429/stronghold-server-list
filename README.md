# 卫戍协议 · 服务器列表（总览站）

把各服的 `/healthz` 汇总成一张总览页：在线状态、人数、房间、版本、延迟、24 小时走势与可用率、玩家评分、感谢名单。
前台/后台的视觉与交互**照抄参考站 `wei.jiangjiangze.icu`**（源码副本不随仓库发布）。

- **零依赖**：只用 Node 内置模块，Node ≥ 18
- 单进程，1C1G 够用
- 数据落 `data/`（运行时，已 gitignore），配置是 `servers.json`

线上：**https://mon3tr.fun** ｜ 管理页 `/admin` ｜ 自检 `/healthz`

---

## 1. 架构

```
国内游戏服（进程内 server/listReporter.mjs）
   │ 每 30s：拉 /api/servers → 逐个探 /healthz → POST /api/report（带 REPORT_TOKEN）
   ▼
列表站（香港 ECS，只存不算）
   │ systemd: stronghold-list，监听 :80
   ▼
Cloudflare 隧道 stronghold-list（源站 http://localhost:80）
   ▼
https://mon3tr.fun
```

**为什么探测不在服务器上做**：香港机房直连国内"裸 IP:端口"经常不通（实测只有 4/14，
国内节点 10/14）。所以列表站**不探测**，只接收国内节点上报。

## 2. 文件

| 路径 | 说明 |
|---|---|
| `server.mjs` | HTTP 服务 + 管理 API + 上报/评分 + 自更新（`/admin/api/deploy`） |
| `servers.json` | 收录的服务器（14 个，管理页可直接改） |
| `public/index.html` | 总览页（hero + 列表 + 感谢名单，明暗主题） |
| `public/admin.html` | 管理页（左清单 / 右固定表单） |
| `public/thanks.json` | 感谢名单本地副本（首屏零请求，随后与上游比 `v` 对齐） |
| `public/favicon.ico` `icon-32.png` `icon-180.png` | 站点图标（取自启动器的 `launcher/game.ico`） |
| `public/agent.mjs` | 备用上报器（可独立跑，现在的线上是游戏服内置那份） |
| `deploy/stronghold-list.service` | systemd 单元 |
| `data/state.json` | 运行时：每站 24h 走势 + 7 天可用率（**要备份**） |
| `data/votes.json` | 运行时：超大杯 / 中杯票数（**要备份**） |

## 3. 接口

| 路径 | 方法 | 说明 |
|---|---|---|
| `/` `/admin` | GET | 总览页 / 管理页 |
| `/api/servers` | GET | 全量状态（含 `rating`、`history24h`、`probeSource`、`lastReportAt`） |
| `/api/report` | POST | 国内节点上报，需要 `REPORT_TOKEN` |
| `/api/vote` | POST | `{id, kind:"large"\|"medium"}`，每 IP 每服每天一票 |
| `/admin/login` | POST | `{password}` → `sl_admin` cookie（12h） |
| `/admin/logout` | POST | 销毁会话 + cookie 立即过期 |
| `/admin/api/list` | GET | 全部服（含已下架） |
| `/admin/api/save` | POST | 新增 / 修改（带 `id` 即修改） |
| `/admin/api/toggle` | POST | 上下架 `{id, enabled}` |
| `/admin/api/delete` | POST | 删除 `{id}` |
| `/admin/api/deploy` | POST | 自更新：`git pull --ff-only origin main`；`server.mjs` 变了自动重启 |
| `/healthz` | GET | `{ok, service, servers, at}` |

> ⚠️ 新增管理路由必须加进 `server.mjs` 末尾的路由白名单
> （`/admin/login`、`/admin/logout`、`/admin/api/*`），否则会掉到静态分支变 404。

## 4. 本地开发

```bash
# 依赖：只要 Node ≥ 18
PORT=3100 ADMIN_PASSWORD=test123 REPORT_TOKEN=dev LOCAL_PROBE=0 node server.mjs
# 打开 http://127.0.0.1:3100
```

- `LOCAL_PROBE=0` 关掉本机探测（只想看界面时用，数据来自 `data/state.json`）
- 想本机探测就设 `LOCAL_PROBE=1`（会真的去连各服）
- 没配 `ADMIN_PASSWORD` 会随机生成并打印在启动日志里

## 5. 部署与更新

**首次部署**：`git clone` 到 `/opt/stronghold-list` → 装 `deploy/stronghold-list.service`
→ 按需改 `ADMIN_PASSWORD` / `REPORT_TOKEN` / `ExecStart`（用 `command -v node` 的绝对路径）
→ `systemctl daemon-reload && systemctl enable --now stronghold-list`。

**日常更新（不用登服务器）**：

```bash
git add -A && git commit -m "..." && git push
curl -X POST https://mon3tr.fun/admin/api/deploy -b cookie.txt   # 或点后台「更新到最新版」
```

纯静态改动不重启；`server.mjs` 有变化会在响应后 2 秒退出，由 `Restart=always` 拉起（约 3 秒）。

**备份**（走势和票数丢了不可恢复）：

```bash
tar czf /root/list-backup-$(date +%F).tgz /opt/stronghold-list/data /opt/stronghold-list/servers.json
```

## 6. 前端要点

| 模块 | 说明 |
|---|---|
| 字体 | `Bahnschrift,"DIN Alternate","Roboto Condensed","Arial Narrow","Segoe UI"`；正文 `Segoe UI/微软雅黑/PingFang`；无外链字体 |
| 色板 | 纸底 `#ecebe7` / 墨色 `#141414` / lime `#9ee03a` / orange `#f07d1a` |
| 行 | 白卡 + 1px 边，悬停位移 4px + 硬阴影 + 橙色角标 |
| 编号块 | 88px、数字 38px、右侧 6px 状态条；悬停时块内白光自上而下 1.2s 无限循环 |
| 24h 分段条 | 48 列 grid、1px 间隙、22px 高；绿=在线、红=失败、灰=无采集 |
| 评分 | 超大杯 / 中杯，点过变黑底；localStorage 记已投，服务端按 IP+天去重 |
| hero | 12 个固定槽位散落节点（点击跳行并闪框）、中央 `SRV LIST` 黑块、`NODES FOUND` 打乱字符、标题黑条擦除 |
| 进场动画 | 5 段共 3.9s，点击/按键跳过，每会话一次，`prefers-reduced-motion` 时跳过 |
| 主题 | `html[data-theme]` + `localStorage.rl.theme`，默认跟随系统 |
| 感谢名单 | 本地 `thanks.json` 优先，再与上游 `v` 比对决定是否重画；两份轨道无缝滚动，悬停暂停 |

## 7. 已知坑

1. 香港探测不准，**必须由国内节点上报**（`REPORT_TOKEN` 两边一致）。
2. `mon3tr.fun` 指向本列表站，**不是游戏**；游戏入口 `http://8.134.50.56:3000`。
3. CN → `47.243.152.136` 的 22/80/443 都不通，只能走 Cloudflare 隧道。
4. 重启会清空内存里的登录会话和评分去重表。
5. `data/` 被 gitignore，**静态资源别放 `public/data/`**（会 404）。
6. 全局 pre-commit 会拦形似 `PASSWORD=...` 的写法。
7. 收录的是别人的服，30 秒一次、UA `StrongholdList/1.0`；要求下架就把 `enabled` 设为 `false`。
