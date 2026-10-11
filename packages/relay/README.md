# @aihub/relay

AiHub 的内置模型通道模块。把三个 DSH 订阅接入插件——`dsh-connect-trae`、
`dsh-workbuddy-connect`、`dsh-qoder-connect`——**已经写好的协议层原样提取出来**，
装配成六个模型通道挂到 AiHub 的 `/v1` 上。

它不是独立服务：没有自己的端口和地址，一切走 AiHub 的
`http://127.0.0.1:8787`。模块内部的逻辑（模型路由、出站兼容、SSE 规范化、
非流式聚合）与上游 local-relay 项目逐字一致。

## 六个通道

| 前缀 | 通道 | 键 |
| --- | --- | --- |
| `trae/` | Trae 国内版 | `trae` |
| `traeg/` | Trae 国际版 | `trae` |
| `wb/` | WorkBuddy 国内版 | `workbuddy` |
| `wbai/` | WorkBuddy 国际版 | `workbuddy` |
| `qoder/` | Qoder 国内版 | `qoder` |
| `qoderg/` | Qoder 国际版 | `qoder` |

**模型名格式：`前缀/模型ID`**（斜杠不能漏，大小写敏感）。ID 以
`GET /v1/models` 的实际返回为准——那里同时给 `id` 与 `name`，`name` 是给人看的
显示名，**不能当 ID 用**。

```
✅ qoder/qmodel_latest      → 显示为 Qwen3.7-Max
✅ wb/deepseek-v4.1-flash
❌ qoder/Qwen3.7-Max        ← 显示名当 ID，上游拒绝
❌ qmodel_latest            ← 漏前缀，AiHub 按普通未配置模型处理
```

## 在 AiHub 里启用

模块由 AiHub 的 SQLite settings 控制，分为总开关与三个通道开关。两种方式：

- 管理端「订阅中转」页：总开关、trae / workbuddy / qoder 三个通道开关
- `PUT /api/admin/relay`，请求体 `{ "enabled": true, "channels": { "trae": true, "workbuddy": false, "qoder": true } }`

**总开关关闭**时模块完全不装配：不读凭据、不起 shim、不拉目录，`/v1/models`
不含任何前缀模型，`/panel/api/*` 返回 503。**单个通道关闭**时该通道的两个变体
一起下线。

## 控制面板

控制面板已整合进 AiHub 管理端「订阅中转」页（`http://127.0.0.1:8787/admin/relay`），
菜单在页面顶部，含总览、Trae、WorkBuddy、Qoder、设置五个标签页；总开关与
三个通道开关在「设置」里，额度/签到/模型启停/推理探针/账号切换在各通道页里。
面板 API 挂在 `/api/admin/relay/panel/*`，与 AiHub 管理端一致，免登录（都只监听本机）。
请求日志统一写入 AiHub「日志」页（渠道筛选为 `relay:{prefix}`）。

**三个会真的做事的按钮**：Trae「领取签到」、WorkBuddy / Qoder「探针」（**会真发
上游请求并消耗额度**）、WorkBuddy「模型启停」（全局持久化，停用的模型不出现在 `/v1/models`）。

## 依赖桩

`shims/node_modules/` 是**入库的核心资产**：提取来的协议层连同版权声明，可 diff
审查。`src/providers/*.mjs` 里的 `import 'dsh-connect-trae'` 是裸包名解析，所以
运行时需要 `packages/relay/node_modules/`——它由脚本从 `shims/` 复制而来：

```powershell
npm run sync:relay-deps          # 在仓库根执行；改了桩之后必须重跑
```

## 状态目录

`~/.dsh/local-relay/`，与 DSH 插件刻意分开放（两边都是整文件覆盖写，同目录会互相
抹掉）。`RELAY_STATE_DIR` 可覆盖。Trae 的凭据副本
（`~/.dsh/.trae-auth.<region>.json`）是有意共享的。

请求日志是内存环形缓冲（`RELAY_LOG_CAP`，默认 500），重启即清，只记元数据、
不记请求与响应正文。它**不写** AiHub 的 `request_logs` 表。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `RELAY_STATE_DIR` | `~/.dsh/local-relay` | 状态目录 |
| `RELAY_LOG_CAP` | `500` | 请求日志环形缓冲容量 |
| `RELAY_PANEL_LIVE_TIMEOUT_MS` | `3000` | 面板里额度/用量这类真上游读取的等待预算 |
| `RELAY_WB_POLL_MS` | `30000` | WorkBuddy 凭据轮询间隔 |
| `RELAY_QODER_POLL_MS` | `300000` | Qoder 凭据轮询间隔（下限 60s） |
| `RELAY_TRAE_AUTH_FILE` | 自动发现 | 手动指定 Trae 凭据文件 |
| `RELAY_TRAE_EDITION` | 自动发现 | 手动指定 Trae 版本（CN / 国际） |

`RELAY_PORT` / `RELAY_KEY` 是独立运行时代的配置，移植后已废弃：端口跟随 AiHub，
鉴权走 AiHub 的 gateway token。

## 测试

```powershell
npm run sync:relay-deps          # 测试里有裸包名 import，必须先同步
npm test -w @aihub/relay
```

## 已知限制

- **主要验证平台是 Windows**；凭据发现逻辑来自插件（Windows 注册表 / 常见安装
  路径），macOS / Linux 未实测。
- **必须本机登录过对应客户端**。模块只读取登录态，不代登录、不刷新密码。
- WorkBuddy 5.6 起凭据文件是加密的，解密需要临时调用 WorkBuddy 自己的二进制——
  **app 得在**，且首次读取会慢一点。
- 只实现 **Chat Completions + Models**：没有 embeddings、responses、audio、
  images 端点。
- 上游额度耗尽 / 排队 / 风控都会如实以 4xx/5xx 透出，模块不重试、不轮换账号。

## 来源与致谢

本模块移植自独立项目 **local-relay**（MIT © 2026 lunesnow），
`src/`、`shims/`、`panel/`、`test/` 均原样保留，只改了进程入口那一层
（`src/server.mjs` → `src/gateway.mjs`，去掉自己监听端口与 `RELAY_KEY` 校验）。

三个插件的协议层来自这些 MIT 许可的包，连同各自的版权声明一并保留在
`shims/` 下（未做改动，仅做装配）：

| 包 | 角色 |
| --- | --- |
| `dsh-connect-trae` | Trae 的凭据发现/刷新、请求编码、SSE 解码与工具调用桥接、模型目录路由 |
| `dsh-workbuddy-connect` | WorkBuddy 的凭据存储与 at-rest 解密、目录与可见性、推理探针 |
| `dsh-qoder-connect` | Qoder 的 PAT 校验与传输、账号/额度读取、签到 |

`shims/node_modules/@deepseek-ai/*` 与 `@earendil-works/pi-ai` 是该项目手写的
DSH 运行时桩，只为让上述包能在 DSH 进程外被解析，不属于第三方代码。

请**仅用于本机自用**。你调用的仍是你自己的订阅账号，必须遵守 Trae / WorkBuddy /
Qoder 各自的服务条款；不要用它分享账号、转售额度或绕过计费。使用风险自负。
