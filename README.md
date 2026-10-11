# AiHub

> 本地优先的个人 AI 网关。对外只暴露一个 OpenAI 兼容的 chat completions 接口，把 OpenAI 兼容、OpenAI Responses、Anthropic Messages 上游，以及本机 Trae / WorkBuddy / Qoder 订阅通道聚合成统一的 `/v1` 服务。

AiHub 面向个人本地使用，不依赖容器、云数据库或外部控制面。配置和日志落在本地 SQLite，管理端由同一个 Node 进程托管，改完配置即时生效，不需要重启服务。

## 功能特性

- 统一入口：对外提供 OpenAI 兼容的 `/v1/chat/completions` 和 `/v1/models`，支持流式与非流式。
- 多种上游：支持 OpenAI 兼容 chat completions、OpenAI Responses API、Anthropic Messages API 三种协议。
- 按渠道隔离：每个渠道有独立接入地址，模型 ID 为 `渠道名/上游模型名`，同名模型不会跨渠道串线。
- 协议转换：请求体、响应体、SSE 流式事件、错误结构和 usage 字段在三种协议之间转换。
- 渠道管理：新建、编辑、复制、删除、启停、拖拽排序、拉取模型多选、真实最小请求测试。
- 请求日志：记录模型、渠道、协议、耗时、状态、错误摘要和是否流式，支持筛选，重启不丢失。
- 订阅中转：把本机已登录的 Trae / WorkBuddy / Qoder 订阅额度接成六个模型通道，复用本机凭据，不另填 API Key。
- 本地安全边界：服务默认只监听 `127.0.0.1`，管理端没有公网暴露。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 运行时 | Node.js 24+ |
| 后端 | TypeScript、Fastify |
| 数据库 | Node.js 内置 `node:sqlite` |
| 前端 | React 19、Vite、Ant Design 5 |
| 测试 | Vitest、`node:test` |

## 快速开始

### 环境要求

- Node.js `>= 24`
- npm（随 Node.js 安装）
- Windows、macOS、Linux 均可

### 安装与开发启动

```powershell
npm install
npm run sync:relay-deps
npm run dev
```

`sync:relay-deps` 把订阅中转模块的协议层依赖桩同步到 `packages/relay/shims/node_modules`。首次使用订阅中转时必跑；不启用订阅中转时可以跳过，渠道功能不受影响。

开发模式会同时启动两个进程：

| 服务 | 地址 |
| --- | --- |
| Fastify API | `http://127.0.0.1:8787` |
| Vite 管理端 | `http://127.0.0.1:5174/admin/` |

Vite 会把 `/api` 和 `/v1` 请求代理到 Fastify。开发时修改前端会热更新，修改后端会由 `tsx watch` 自动重启。

### 生产构建与启动

```powershell
npm run build
npm start
```

构建完成后，Fastify 会静态托管 `apps/web/dist`，统一从以下地址访问：

- 管理端：`http://127.0.0.1:8787/admin/`
- API：`http://127.0.0.1:8787/v1`

## 管理端

管理端包含四个页面：

| 页面 | 用途 |
| --- | --- |
| 渠道 | 管理上游渠道和渠道模型，查看接入地址，执行测试 |
| 日志 | 查询请求记录，按模型、渠道、状态、流式和时间筛选 |
| 订阅中转 | 管理 Trae / WorkBuddy / Qoder 通道，查看额度和账号，配置模型启停 |
| 设置 | 查看和修改 gateway token、连接超时、流式空闲超时 |

管理端只监听本机，不额外要求登录令牌。第一次启动时，gateway token 会自动生成，在「设置」页可以查看和修改。

### 配置一个渠道

1. 打开「渠道」页，新建渠道。
2. 选择协议类型，填写渠道名、`baseUrl`、上游密钥和默认 `max_tokens`。
3. 点击「拉取模型」，从上游返回的模型列表中多选，也可以手动输入模型名。
4. 保存后，渠道卡片会显示接入地址，例如 `http://127.0.0.1:8787/v1/channels/<channelId>`。
5. 点击「测试」发送一次真实最小请求，确认上游可达并查看耗时。

渠道停用后仍会保留配置和模型，但渠道专属请求会返回 `503 channel_unavailable`。渠道排序只影响管理端展示，不影响请求路由。

## 客户端接入

任意兼容 OpenAI Chat Completions 的客户端都可以接入 AiHub：

| 配置项 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:8787/v1` |
| API Key | 管理端「设置」页里的 gateway token |
| Model | `渠道名/上游模型名`，例如 `openai/gpt-5` |

### curl 示例

先设置 gateway token：

```powershell
$env:AIHUB_GATEWAY_TOKEN = "在设置页获取"
```

查询模型列表：

```powershell
curl.exe http://127.0.0.1:8787/v1/models `
  -H "Authorization: Bearer $env:AIHUB_GATEWAY_TOKEN"
```

发起非流式请求：

```powershell
curl.exe http://127.0.0.1:8787/v1/chat/completions `
  -H "Authorization: Bearer $env:AIHUB_GATEWAY_TOKEN" `
  -H "Content-Type: application/json" `
  --data-binary '{"model":"openai/gpt-5","messages":[{"role":"user","content":"你好"}]}'
```

发起流式请求：

```powershell
curl.exe http://127.0.0.1:8787/v1/chat/completions `
  -H "Authorization: Bearer $env:AIHUB_GATEWAY_TOKEN" `
  -H "Content-Type: application/json" `
  --data-binary '{"model":"openai/gpt-5","messages":[{"role":"user","content":"你好"}],"stream":true,"stream_options":{"include_usage":true}}'
```

### 渠道独立入口

如果客户端需要严格绑定某个渠道，可以使用渠道专属地址：

```text
GET  /v1/channels/{channelId}/models
POST /v1/channels/{channelId}/chat/completions
```

渠道专属入口只请求指定渠道，不会切换到其他渠道。渠道页可以直接复制完整地址。

## API 参考

### 对外接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 健康检查，无需鉴权 |
| `GET` | `/v1/models` | 返回全部渠道模型和订阅中转模型的并集 |
| `POST` | `/v1/chat/completions` | 全局 chat 入口，支持流式与非流式 |
| `GET` | `/v1/channels/{channelId}/models` | 只返回该渠道的模型 |
| `POST` | `/v1/channels/{channelId}/chat/completions` | 只请求该渠道 |
| `GET` | `/admin/` | 管理端静态页面 |

所有 `/v1/*` 接口都要求：

```http
Authorization: Bearer <gatewayToken>
```

### 模型命名与路由

- 渠道模型对外 ID 是 `渠道名/上游真实模型名`。
- 请求带渠道名前缀时，AiHub 解析前缀并路由到对应渠道，转发上游时剥离前缀。
- 不带前缀的旧模型名仍兼容：只配置在一个渠道时正常路由，配置在多个渠道时返回 `400 model_ambiguous`。
- 渠道不存在返回 `404 channel_not_found`。
- 模型未挂在目标渠道返回 `404 model_not_found`。
- 渠道存在但已停用返回 `503 channel_unavailable`。
- 订阅中转的 `trae/`、`traeg/`、`wb/`、`wbai/`、`qoder/`、`qoderg/` 前缀优先接管，不进入渠道路由。

当前版本不做跨渠道故障转移。每个请求只命中一个渠道，上游连接失败、`429`、`5xx` 或超时都会直接返回统一错误，错误里会带上具体渠道和原因。

### 支持的请求字段

核心字段：

- `model`
- `messages`：支持 `system`、`developer`、`user`、`assistant`、`tool` 角色和多轮消息
- `temperature`
- `top_p`
- `max_tokens`
- `max_completion_tokens`
- `stop`
- `stream`
- `stream_options.include_usage`

工具调用：

- `tools`
- `tool_choice`
- `parallel_tool_calls`

其他常用字段：

- `store`
- `frequency_penalty`
- `presence_penalty`
- `seed`
- `user`
- `metadata`
- `response_format`
- `logprobs`
- `top_logprobs`
- `service_tier`
- `reasoning_effort`
- `verbosity`
- `logit_bias`
- `n: 1`

未显式识别的顶层字段会尽量原样转发给 OpenAI / Responses 渠道；消息内的附加字段会按协议能力处理。图片、音频、文件和音视频等多模态输入不支持，返回统一的 `400 unsupported_parameter`。

### 错误结构

对外错误统一为 OpenAI error 结构：

```json
{
  "error": {
    "message": "Upstream channel \"OpenAI 官方\" failed: ...",
    "type": "upstream_error",
    "code": "upstream_error",
    "upstream": {
      "attempts": [
        {
          "channelId": "9f3c...",
          "channelName": "OpenAI 官方",
          "protocol": "openai",
          "status": 429,
          "reason": "rate limited",
          "durationMs": 321
        }
      ]
    }
  }
}
```

错误信息不会返回上游密钥，只返回渠道 ID、渠道名、协议、HTTP 状态或失败原因。

## 上游协议

| 协议 | 上游端点 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `openai` | `POST {baseUrl}/chat/completions` | `Authorization: Bearer <apiKey>` | OpenAI 兼容 chat completions |
| `responses` | `POST {baseUrl}/responses` | `Authorization: Bearer <apiKey>` | OpenAI Responses API，会转回 chat completions |
| `anthropic` | `POST {baseUrl}/messages` | `x-api-key` + `anthropic-version: 2023-06-01` | Claude 原生 Messages API |

`baseUrl` 需要包含版本路径，例如 `https://api.openai.com/v1`。AiHub 只追加协议端点，不会自动猜测或补全版本路径。

### 协议转换要点

- OpenAI 请求按公共字段规范化后转发，只替换 `model`；缺失 `max_tokens` 时注入渠道默认值。
- Anthropic 请求会把所有 `system` 消息按原顺序合并为顶层 `system` 文本块数组。
- Anthropic 的 `stop` 转为 `stop_sequences`；`max_tokens` 缺失时使用渠道默认值。
- Anthropic 非流式响应映射为 `chat.completion`，流式事件映射为 `chat.completion.chunk`。
- 流式响应在 `stream_options.include_usage` 为真时合成最终 usage chunk，再发送 `[DONE]`。
- 响应中的 `model` 字段会回显客户端请求的模型 ID，包含渠道名前缀。
- Function calling 在 OpenAI、Responses、Anthropic 之间互相转换，流式工具调用增量同样支持。

## 订阅中转

订阅中转把本机已登录的三个 DSH 订阅接入插件的协议层装配成六个模型通道。它和普通渠道共用同一个 `/v1` 入口、同一个进程和同一个管理端。

| 前缀 | 通道 | 开关 |
| --- | --- | --- |
| `trae/` | Trae 国内版 | `trae` |
| `traeg/` | Trae 国际版 | `trae` |
| `wb/` | WorkBuddy 国内版 | `workbuddy` |
| `wbai/` | WorkBuddy 国际版 | `workbuddy` |
| `qoder/` | Qoder 国内版 | `qoder` |
| `qoderg/` | Qoder 国际版 | `qoder` |

模型名格式是 `前缀/模型ID`。实际可用 ID 以 `/v1/models` 返回为准，`name` 是显示名，不能当 ID 使用。

### 启用与配置

订阅中转的开关在管理端「订阅中转」页的「设置」标签中，也可以用管理 API 修改：

```powershell
curl.exe http://127.0.0.1:8787/api/admin/relay `
  -H "Content-Type: application/json" `
  -X PUT `
  --data-binary '{"enabled":true,"channels":{"trae":true,"workbuddy":false,"qoder":true}}'
```

总开关关闭时，模块完全不装配：不读凭据、不启动通道、不拉目录，`/v1/models` 不包含任何前缀模型。单个通道关闭时，它的国内版和国际版一起下线。配置修改后即时生效。

### 凭据与状态

- 凭据直接复用本机已登录的 Trae / WorkBuddy / Qoder 客户端，不需要在 AiHub 里填写订阅账号。
- 模块状态落在 `~/.dsh/local-relay/`，可用 `RELAY_STATE_DIR` 覆盖。
- Trae 登录态复用 `~/.dsh/.trae-auth.<region>.json`。
- 请求日志统一写入 AiHub 的 `request_logs` 表，渠道筛选值为 `relay:{prefix}`。
- 「领取签到」和「推理探针」会真实请求上游并消耗订阅额度，操作前请确认。

订阅中转模块的更多细节见 [packages/relay/README.md](packages/relay/README.md)。

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AIHUB_HOST` | `127.0.0.1` | 服务监听地址 |
| `AIHUB_PORT` | `8787` | 服务监听端口 |
| `AIHUB_DATA_DIR` | `data` | 数据目录，相对路径以仓库根为基准，也可使用绝对路径 |

### 数据库设置

数据库文件默认是 `data/aihub.sqlite`，启动时自动建表和迁移。常用设置项：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `gatewayToken` | 首次启动随机生成 | `/v1/*` 的 Bearer token |
| `connectTimeoutMs` | `10000` | 连接和响应头超时 |
| `streamIdleTimeoutMs` | `60000` | 流式空闲超时 |
| `relayEnabled` | `true` | 订阅中转总开关 |
| `relayChannels` | 全部启用 | 三个订阅通道的 JSON 开关 |

渠道默认 `max_tokens` 是 `4096`。所有管理端修改即时生效，不需要重启服务。

完整表结构见 [docs/schema.md](docs/schema.md)。

## 数据与安全

- 上游渠道密钥和 gateway token 目前以明文存储在本地 SQLite 中。
- `data/` 已在 `.gitignore` 中忽略，正常情况下不会进入 git。
- 管理端和 API 默认只监听 `127.0.0.1`，不会暴露到局域网或公网。
- 请求日志只记录元数据，不记录请求消息、响应正文或上游密钥。
- 如果需要对外提供访问，请自行增加反向代理、鉴权和 HTTPS，并重新评估密钥存储方式。

## 项目结构

```text
.
├─ apps/
│  ├─ server/          Fastify 后端、SQLite、路由和协议转换
│  └─ web/             React 管理端
├─ packages/
│  ├─ shared/          前后端共享类型
│  └─ relay/           订阅中转模块和协议层依赖桩
├─ docs/
│  └─ schema.md        SQLite 表结构
├─ data/               本地数据库目录，git 忽略
└─ package.json        工作区脚本
```

## 开发与测试

常用命令：

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 同时启动后端和前端开发服务 |
| `npm run build` | 构建 shared、server 和 web |
| `npm start` | 启动生产构建 |
| `npm test` | 运行全部工作区测试 |
| `npm run sync:relay-deps` | 同步订阅中转依赖桩 |

测试覆盖：

- 请求和响应转换
- OpenAI、Responses、Anthropic 流式转换
- 模型命名、渠道路由、客户端断连
- 渠道 CRUD、模型管理、日志、设置和持久化
- gateway 鉴权和统一错误结构
- 订阅中转的模型路由、面板数据层和出站兼容处理
- 前端主要页面

## 已知限制与非目标

当前版本明确不做：

- 图片、音频、文件等多模态输入
- 计费、多租户、配额
- 上游密钥池和自动轮换
- 自动熔断、健康探测和跨渠道故障转移
- 统计 Dashboard
- Docker 或容器化部署

其他限制：

- 管理端没有独立登录令牌，依赖仅监听本机来隔离访问。
- 全局入口遇到同名多渠道模型时会返回 `model_ambiguous`，需要改用渠道专属入口。
- 订阅中转依赖本机已登录的 DSH 客户端，登录态失效时需要先在原客户端重新登录。
- AiHub 不提供 models.dev 元数据补全，部分客户端可能需要手动选择模型。

## 相关文档

- [SQLite Schema](docs/schema.md)
- [订阅中转模块说明](packages/relay/README.md)
