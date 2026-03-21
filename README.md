# gpt-load-nodejs

## Latest parity updates

- Added compatibility route: `/proxy/:group_name/api/integration/info`
- Added auth extraction compatibility: query `key`, `Authorization: Bearer`, `X-Api-Key`, `X-Goog-Api-Key`
- Proxy forwarding now strips inbound auth query key (`key`) from upstream requests and request logs
- Added model list transformation compatibility for `/v1/models`, `/v1beta/models`, `/v1beta/openai/v1/models`
- Added static asset long-cache headers and SPA fallback no-cache headers
- Expanded group config options/default settings with Go-compatible request/connection fields

这是基于 Node.js + TypeScript 重构的 `gpt-load` 项目版本，目录独立于原 Go 版本：

- 原始 `gpt-load` 项目地址：[https://github.com/tbphp/gpt-load](https://github.com/tbphp/gpt-load)
- 本地原项目目录：`gpt-load-main`
- 重构版本：`gpt-load-nodejs`

## 当前重构范围

- 后端框架：`Fastify`
- 数据存储：`SQLite (better-sqlite3)`
- 前端静态托管：后端可直接托管 `web/dist`（构建后可访问 `/`）
- 可选 Redis：跨实例任务状态与分布式锁（`REDIS_URL`）
- 已实现核心接口：
  - `/health`
  - `/api/auth/login`
  - `/api/integration/info`
  - `/api/channel-types`
  - `/api/settings` (GET/PUT)
  - `/api/groups` 及其子接口（列表/创建/更新/删除/复制/子分组）
  - `/api/keys` 及其子接口（导入/删除/恢复/导出/异步任务）
  - `/api/tasks/status`
  - `/api/dashboard/*`
  - `/api/logs` 与 `/api/logs/export`
  - `/proxy/:group_name/*`（多密钥重试 + 基础日志）
  - 请求超时控制（按配置 `request_timeout`）
  - 日志自动清理（按 `request_log_retention_days`）
  - API Key 入库加密（通过 `ENCRYPTION_KEY` 启用）
  - `migrate-keys` 迁移命令（启用/禁用/轮换加密密钥）
  - 分组密钥验证任务改为真实上游校验（不再是随机模拟）
  - 后台定时无效密钥重校验（按 `key_validation_interval_minutes`）
  - 基础安全中间件（`helmet`）与全局限流（`RATE_LIMIT_MAX`）
  - Redis pub/sub 配置广播（settings/groups/keys 变更事件）
  - 基础双语错误消息（根据 `Accept-Language` 返回中文/英文）

- 前端：已复用原项目 `web` 目录

## 运行

1. 复制环境变量

```bash
cp .env.example .env
```

2. 安装依赖

```bash
npm install
```

3. 开发运行（单端口，推荐）

```bash
npm run dev
```

说明：该命令会先构建前端 `web/dist`，再启动后端（仅 `3001` 一个端口）。

如需前端热更新双端口联调（可选）：

```bash
npm run dev:all
```

4. 构建

```bash
npm run build
```

如需后端直接托管前端页面，请先构建前端：

```bash
npm run build:web
```

也可以一次性构建：

```bash
npm run build:all
```

5. 生产运行

```bash
npm start
```

## 数据加密迁移

```bash
# 启用加密：明文 -> 加密
npm run migrate-keys -- --to "new-encryption-key"

# 关闭加密：加密 -> 明文
npm run migrate-keys -- --from "old-encryption-key"

# 轮换密钥：旧密钥 -> 新密钥
npm run migrate-keys -- --from "old-encryption-key" --to "new-encryption-key"
```

默认地址：`http://localhost:3001`

当存在 `web/dist` 时，访问 `http://localhost:3001/` 会返回前端页面。

## Redis（可选）

在 `.env` 设置：

```env
REDIS_URL=redis://127.0.0.1:6379
```

启用后将用于：

- 全局任务状态共享（`/api/tasks/status` 跨实例一致）
- 任务启动锁（防止多实例重复执行）
- 日志清理锁与定时校验锁
- 配置广播通道（`gpt-load:config:events`）

## 说明

- 本版本优先保证 API 兼容与可运行性。
- Go 版本中的部分高级行为（如完整加密迁移命令、全部中间件细节）仍可继续逐步对齐。
