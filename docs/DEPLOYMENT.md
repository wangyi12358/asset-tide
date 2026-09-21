# Docker 快速部署

免费部署请先看 [Vercel + Neon 部署指南](VERCEL.md)。本文适用于自有服务器的 Docker 常驻部署。

应用、Hono API、Better Auth、MCP 和定时任务运行在同一个 Node.js 服务里。数据库采用 PostgreSQL 15，Prisma 管理模型与迁移。常驻定时采集和备份只启用一个 app 实例；登录、MCP 和按需刷新限流使用数据库。Compose 包含 app、db，以及执行完退出的 migrate 容器。

## 本机启动

需要 Docker Engine / Docker Desktop 与 Docker Compose v2，以及生成配置时使用的 Node.js 22+。

```bash
node scripts/docker-init.mjs
# 按需编辑 .env.docker，填入行情 API Key；已有文件不会被生成脚本覆盖。
docker compose --env-file .env.docker up --build -d
docker compose --env-file .env.docker ps
```

访问 `http://localhost:3000`。生成脚本写入随机认证密钥与数据库密码、设置文件权限为 0600；`.env.docker` 不进入 Git 或镜像。如果改端口，`APP_PORT` 与 `BETTER_AUTH_URL` 必须一致。`APP_BIND` 默认 `127.0.0.1`，只供本机或同服务器上的代理访问。

已有旧版 `.env.docker` 时，补充 `POSTGRES_PASSWORD` 与 `POSTGRES_DB` 后再启动；不要覆盖已有认证密钥。

Docker 默认创建全新账本，不会自动读取开发环境 `data/` 或 `.env.local`。API Key 按需复制到 `.env.docker`。迁移现有账本请按下文备份与恢复步骤进行。

## 公网 HTTPS（可选 Caddy）

1. 准备一个域名，A/AAAA 记录指向服务器，开放 80/443；不要保留指向其他机器的 AAAA 记录。
2. 编辑 `.env.docker`：`DOMAIN=assets.example.com`、`BETTER_AUTH_URL=https://assets.example.com`，保留 `APP_BIND=127.0.0.1`。
3. 启动：

```bash
docker compose --env-file .env.docker -f compose.yaml -f compose.https.yaml up --build -d
```

Caddy 自动申请并续期证书，证书保存在持久卷。应用仍是一个 Node 服务；Caddy 只是可选 HTTPS 入口。若已有 Nginx、Traefik 等代理，可只运行基本 compose 并转发到本机 3000 端口。生产认证 Cookie 要求 HTTPS；容器启动校验会拒绝远程 HTTP 配置。客户端 MCP 地址为 `https://assets.example.com/api/mcp`，不要让代理缓冲或改写 JSON 请求头。

## 配置

| 变量                            | 要求                                                                    |
| ------------------------------- | ----------------------------------------------------------------------- |
| BETTER_AUTH_URL                 | 用户实际访问的完整站点 Origin，含端口；不要带路径                       |
| BETTER_AUTH_SECRET              | 至少 32 字符，生成脚本默认随机生成；升级时保留，否则已有登录会话失效    |
| COINGECKO_API_KEY               | 可选，CoinGecko Demo Key，用于加密货币行情和图标；免费方案可用但有额度  |
| TWELVE_DATA_API_KEY             | 可选，股票检索和报价；覆盖范围取决于供应商权限                          |
| RESEND_API_KEY / MAIL_FROM      | 可选，密码重置邮件；注册无需邮箱验证                                    |
| ENABLE_SCHEDULER                | 默认 true，负责行情刷新、快照及每日备份                                 |
| POSTGRES_PASSWORD / POSTGRES_DB | 数据库密码与库名，默认库名 asset_atlas；生成脚本创建 URL 安全的随机密码 |
| DATABASE_URL / BACKUP_PATH      | Compose 自动连接 db，备份目录为 /app/backups                            |

没有外部行情 Key 时可以使用手动报价。无需为 MCP 申请第三方 Key，用户在设置里创建自己的 MCP 访问令牌。

## 运维

```bash
# 查看最近日志（不会输出密钥）
docker compose --env-file .env.docker logs --tail=100 app
# 修改运行时环境变量后重建容器
docker compose --env-file .env.docker up -d --force-recreate app
# 代码升级，保留已有卷与配置
docker compose --env-file .env.docker up --build -d
# 停止服务，保留数据
docker compose --env-file .env.docker down
```

不要执行 `down -v`，它会删除数据卷。容器以非 root 的 node 用户运行。数据卷首次挂载自动获得正确权限；如果改为宿主机目录挂载，需要使目录可由 UID 1000 写入。

## 备份和恢复

后台每日通过 PostgreSQL `pg_dump` 生成 custom 格式备份，最多保留最近 30 份，目录 `/app/backups`。运行镜像包含 PostgreSQL 15 客户端（可备份 PG 14/15；外部数据库版本更高时也要升级客户端）。

即时备份并导出（文件内含私人账本与认证数据）：

```bash
docker compose --env-file .env.docker exec -T db sh -c 'pg_dump -U postgres -d "$POSTGRES_DB" -Fc --no-owner --no-acl' > asset-atlas.dump
chmod 600 asset-atlas.dump
```

自动备份可通过 `docker compose --env-file .env.docker cp app:/app/backups/asset-atlas-YYYY-MM-DD.dump ./` 导出。不要只把本机/同机备份当成异地备份。

恢复或迁移已有本机 PostgreSQL 账本：

1. 停止写入：`docker compose --env-file .env.docker stop app`。本地迁移可先 `pnpm db:backup`。
2. 恢复到一个**新库**（保留原库）：

```bash
docker compose --env-file .env.docker exec db createdb -U postgres asset_atlas_restored
docker compose --env-file .env.docker exec -T db pg_restore -U postgres -d asset_atlas_restored --no-owner --no-acl --exit-on-error < asset-atlas.dump
```

3. 核对新库用户、流水、持仓与快照，将 `.env.docker` 的 `POSTGRES_DB` 改为 `asset_atlas_restored`，保留原 `BETTER_AUTH_SECRET`。
4. `docker compose --env-file .env.docker up -d --force-recreate`；Prisma 仅应用尚未执行的迁移，不清空已有数据。确认正常后保留原库一段时间以便回滚。

本地开发直接使用已有 PG：`.env.local` 设置 `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/asset_atlas`，运行 `pnpm db:setup` 后 `pnpm dev --port 3003`。本机无需再启动 Docker 数据库。SQLite 旧库导入流程见 README。

生产运行镜像包含 standalone 文件、静态资源和 PostgreSQL 备份客户端；迁移镜像包含 Prisma CLI 与迁移文件。两者都不包含 `.env`、开发数据库或本地备份。使用 Docker 直接运行 app（不经过 Compose）时，应先通过 migrate 镜像对目标库执行 `pnpm db:setup`。
