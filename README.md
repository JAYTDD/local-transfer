# AiHub 本地 AI 中转网关

AiHub 把多个 OpenAI 兼容 chat、OpenAI Responses API 和 Anthropic Messages API 上游聚合成一个本地 OpenAI 兼容入口。每个渠道都有独立的 `baseUrl`，客户端按渠道配置后只会看到该渠道的模型；也可以使用全局入口，模型名在多个渠道重复时会被拒绝。

## 技术栈

- Node.js 24+
- TypeScript、Fastify
- 内置 `node:sqlite`
- React、Vite、Ant Design 5
- Vitest

## 快速开始

```powershell
npm install
npm run dev
```

开发模式会同时启动：

- Fastify：`http://127.0.0.1:8787`
- Vite 管理端：`http://127.0.0.1:5174/admin/`

管理端仅监听本机且免登录，可直接查看 gateway token、创建渠道并配置模型。渠道页支持拉取模型多选、拖拽排序、启停、复制、删除和真实最小请求测试。

生产构建与启动：

```powershell
npm run build
npm start
```

此时管理端由 Fastify 托管在 `http://127.0.0.1:8787/admin/`。

## 对外接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 健康检查，无需鉴权 |
| `GET` | `/v1/models` | 返回全部渠道模型的并集（全局入口） |
| `POST` | `/v1/chat/completions` | 全局入口，模型只在一个渠道配置时可用 |
| `GET` | `/v1/channels/{channelId}/models` | 只返回该渠道配置的模型 |
| `POST` | `/v1/channels/{channelId}/chat/completions` | 只请求该渠道，支持流式 |

`/v1/*` 使用 `Authorization: Bearer <gatewayToken>`。管理端只监听 `127.0.0.1`，不额外要求登录令牌。

示例：

```powershell
$env:AIHUB_GATEWAY_TOKEN = "在设置页获取"

curl.exe http://127.0.0.1:8787/v1/models `
  -H "Authorization: Bearer $env:AIHUB_GATEWAY_TOKEN"

curl.exe http://127.0.0.1:8787/v1/chat/completions `
  -H "Authorization: Bearer $env:AIHUB_GATEWAY_TOKEN" `
  -H "Content-Type: application/json" `
  --data-binary '{"model":"gpt-5","messages":[{"role":"user","content":"你好"}]}'

curl.exe http://127.0.0.1:8787/v1/channels/<channelId>/chat/completions `
  -H "Authorization: Bearer $env:AIHUB_GATEWAY_TOKEN" `
  -H "Content-Type: application/json" `
  --data-binary '{"model":"gpt-5","messages":[{"role":"user","content":"你好"}]}'
```

## 请求范围

当前版本支持：

- `messages`：`system`、`developer`、`user`、`assistant`、`tool`，支持多轮与工具调用消息
- `tools`、`tool_choice`、`parallel_tool_calls`（function calling，三种上游协议互转）
- `temperature`、`top_p`、`max_tokens`、`max_completion_tokens`
- `stop`、`stream`、`stream_options.include_usage`
- `store`、`frequency_penalty`、`presence_penalty`、`seed`、`user`、`metadata`
- `response_format`、`logprobs`、`top_logprobs`、`service_tier`、`reasoning_effort`、`verbosity`、`logit_bias`
- `n: 1`

对外请求按 OpenAI chat 规范接收。未显式识别的顶层字段会原样转发给 OpenAI/Responses 渠道；消息内的附加字段（如 `reasoning_content`）会转发给 OpenAI 渠道，其他协议忽略。图片、音频、文件等多模态输入仍返回统一的 `400 unsupported_parameter`。

## 渠道与转换

- 模型直接挂在渠道下，模型 ID 就是上游真实模型名，网关转发时原样传递。
- OpenAI 渠道请求发送到 `{baseUrl}/chat/completions`。
- Responses 渠道请求发送到 `{baseUrl}/responses`，`instructions`、`input`、流式事件和 usage 会转回 chat completions 格式。
- Responses API 没有等价的 `stop` 字段；请求带 `stop` 且路由到 Responses 渠道时返回 `400`。
- Anthropic 渠道请求发送到 `{baseUrl}/messages`，使用 `x-api-key` 和 `anthropic-version: 2023-06-01`。
- Anthropic 不支持 messages 内的 system 角色，因此所有 system 消息会按原顺序合并到顶层 `system` 文本块数组。
- Function calling 会在三种协议间转换：OpenAI/Responses 的 `tools`、`tool_calls`、`function_call` 与 Anthropic 的 `tool_use`、`tool_result` 互相映射，流式工具调用增量同样支持。
- 每个渠道提供独立的 `/v1/channels/{channelId}` 接入地址，渠道页可以复制完整地址。
- 请求只命中目标渠道，不再跨渠道故障转移；上游连接失败、429、5xx 或超时都会直接返回统一错误，错误里包含渠道和原因。
- 全局 `/v1` 入口保留兼容：模型只在一个渠道配置时正常路由，同名模型配置在多个渠道时返回 `400 model_ambiguous`。
- 停用渠道的模型仍会出现在模型列表中，渠道专属请求返回 `503 channel_unavailable`，全局请求返回 `503 model_unavailable`。
- 渠道排序只用于管理界面展示，不影响请求路由。

## 数据

默认数据库为项目内 `data/aihub.sqlite`，可用 `AIHUB_DATA_DIR` 覆盖。所有渠道、渠道模型、设置和请求日志都持久化在 SQLite 中。

服务默认监听 `127.0.0.1:8787`，可用以下环境变量覆盖：

| 变量 | 默认值 |
| --- | --- |
| `AIHUB_HOST` | `127.0.0.1` |
| `AIHUB_PORT` | `8787` |
| `AIHUB_DATA_DIR` | `data` |

## 测试

```powershell
npm test
```

测试覆盖请求与响应转换、OpenAI/Anthropic 流式转换、渠道路由、客户端断连、管理 API、鉴权与持久化。

## 非目标

当前版本不包含多模态、计费、多租户、配额、密钥池、自动熔断、统计 Dashboard 和 Docker 部署。
