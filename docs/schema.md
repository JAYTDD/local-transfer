# SQLite Schema

数据库文件默认位于 `data/aihub.sqlite`，启动时自动创建和迁移。

## settings

键值设置表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `key` | TEXT | 设置键，主键 |
| `value` | TEXT | 设置值 |

内置键：

- `gatewayToken`
- `connectTimeoutMs`
- `streamIdleTimeoutMs`

## channels

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT | UUID，主键 |
| `name` | TEXT | 渠道名，唯一 |
| `protocol` | TEXT | `openai`、`responses` 或 `anthropic` |
| `base_url` | TEXT | 包含版本路径的 API 根地址 |
| `api_key` | TEXT | 上游密钥，本地明文存储 |
| `default_max_tokens` | INTEGER | 默认最大输出 token |
| `enabled` | INTEGER | 渠道是否可用；停用时专属请求返回 503 |
| `position` | INTEGER | 管理界面展示顺序，不影响请求路由 |
| `created_at` | INTEGER | Unix 秒 |
| `updated_at` | INTEGER | Unix 秒 |

## channel_models

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `channel_id` | TEXT | 引用 `channels.id` |
| `model_id` | TEXT | 上游真实模型名，同时作为对外模型 ID |
| `created_at` | INTEGER | 首次添加到该渠道的 Unix 秒 |

主键为 `(channel_id, model_id)`。删除渠道时，该渠道的模型记录会级联删除。`/v1/models` 返回所有渠道模型的去重并集，`created` 取最早添加时间；`/v1/channels/{channelId}/models` 只返回该渠道的模型。

## request_logs

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER | 自增主键 |
| `created_at` | INTEGER | Unix 秒 |
| `virtual_model` | TEXT | 客户端请求的模型名 |
| `channel_id` | TEXT | 最终命中的渠道 ID |
| `channel_name` | TEXT | 最终命中的渠道名 |
| `protocol` | TEXT | 最终协议 |
| `upstream_model` | TEXT | 最终上游模型名，当前与请求模型名一致 |
| `stream` | INTEGER | 是否流式 |
| `status` | TEXT | `ok`、`error`、`aborted` 或 `upstream_error` |
| `http_status` | INTEGER | 上游 HTTP 状态 |
| `duration_ms` | INTEGER | 总耗时 |
| `error_summary` | TEXT | 错误摘要 |

日志正文不包含请求消息或上游密钥。
