# 免费部署：Vercel Hobby + Neon

面向个人或家庭的非商业账本，在平台免费额度内运行。网页、Hono API、Better Auth 和 MCP 部署在 Vercel；PostgreSQL 使用 Neon Free。使用 Vercel 提供的域名即可，无需购买域名。额度与条款以平台当前说明为准。

## 运行方式

- 打开工作台或返回浏览器标签页时自动尝试更新行情，同一用户至少间隔 15 分钟；持有实物黄金时缩短为 1 分钟，页面可见期间每分钟尝试更新，隐藏时停止请求。服务端使用数据库原子更新限频，多个标签页和函数实例共享冷却时间。
- “刷新估值”按钮继续保留，手动刷新至少间隔 60 秒。失败的请求也占用冷却窗口，供应商故障不会造成持续重试。添加资产后仍立即尝试获取对应报价。
- 无人访问时不持续采集行情。MCP 读取已保存的报价，不触发更新。
- `vercel.json` 每天以 UTC `0 0 * * *` 调用 `/api/cron/daily`。Hobby 可能在北京时间 08:00–08:59 之间触发，快照的估值边界始终是 08:00；当天 08:00 之后采集的价格不会倒填快照。
- 缺少历史价格或汇率时，历史快照保留不完整标记；每日 Cron 不额外抓取行情。不访问网站也会生成快照，但估值可能使用较早报价或缺价。
- Vercel 自动关闭进程内定时器，不调用 `pg_dump`，不写本地备份。Docker 的常驻任务仍可使用。
- 登录、MCP 限流存储在 PostgreSQL；快照计算使用事务级锁，重复调用不会重复插入。

## 1. 创建 Neon 数据库

1. 创建 Neon Free 项目，优先选择新加坡区域，与本项目配置的 Vercel `sin1` 区域接近；若选择其他区域，同步调整 `vercel.json`。
2. 在 Connect 中复制同一分支、同一数据库的两条连接串：
   - **Pooled**：主机名含 `-pooler`，用于应用的 `DATABASE_URL`。
   - **Direct**：未启用连接池，用于迁移、备份的 `DIRECT_URL`。
3. 保留平台连接串中的 TLS 参数，不关闭证书校验。Vercel 每个实例的连接池上限为 3，空闲连接会释放。

Neon 免费数据库会休眠，首次连接可能稍慢。频繁访问、历史重算和数据增长都会消耗额度；不保证永远免费或无限存储。

## 2. 初始化数据库

先使用空 Neon 数据库验证。已有账本迁移需先做独立备份，再恢复到新数据库并核对用户、账户、流水与快照；保留原库和原 `BETTER_AUTH_SECRET`。

在本机准备专用环境文件 `.env.neon`（已被 `.gitignore` 排除）：

```dotenv
DATABASE_URL=postgresql://USER:PASSWORD@YOUR-HOST-pooler.neon.tech/DB?sslmode=require
DIRECT_URL=postgresql://USER:PASSWORD@YOUR-HOST.neon.tech/DB?sslmode=require
```

安装依赖后执行：

```bash
chmod 600 .env.neon
node --env-file=.env.neon node_modules/prisma/build/index.js migrate deploy
node --env-file=.env.neon --import tsx scripts/seed.ts
```

显式传入的环境值优先于开发用 `.env.local`。迁移会创建业务表和共享限流表；seed 仅补充默认资产目录，不写演示用户或持仓。每次代码新增迁移后，在发布前再次执行迁移命令。

构建命令只执行 `pnpm build`，不会自动修改数据库。这样 Preview 构建不会意外迁移生产库。

## 3. 创建 Vercel 项目

将项目上传到自己的私有 Git 仓库，在 Vercel 导入并选择 Next.js。仓库固定 Node.js 22.x 和 pnpm 11.11.0（本机 Node.js 至少 22.13）。pnpm 11.12.0 的发布包损坏，不要切回该版本。安装命令保持平台默认，构建命令为 `pnpm build`。保留框架默认输出目录，不要把输出目录设为 `.next/standalone`。

在 **Production** 环境中设置：

| 环境变量                                                      | 值                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`                                                | Neon 的 pooled 连接串                                            |
| `BETTER_AUTH_URL`                                             | 稳定的生产域名，例如 `https://your-project.vercel.app`，不带路径 |
| `BETTER_AUTH_SECRET`                                          | 至少 32 字符随机密钥；升级或迁移时保留                           |
| `CRON_SECRET`                                                 | 独立的至少 32 字符随机密钥                                       |
| `ENABLE_SCHEDULER`                                            | `false`                                                          |
| `COINGECKO_API_KEY` / `TWELVE_DATA_API_KEY` / `TUSHARE_TOKEN` | 按需配置；行情供应商另有额度与权限                               |
| `RESEND_API_KEY` / `MAIL_FROM`                                | 可选，找回密码使用；未配置时仍可注册和登录                       |

可分别运行两次 `openssl rand -hex 32` 生成不同的认证密钥和 Cron 密钥。不要使用 `NEXT_PUBLIC_` 前缀存放任何密钥。`DIRECT_URL` 仅在本机迁移和备份时使用，无需放入 Vercel；Vercel 自动提供 `VERCEL` 与 `VERCEL_ENV`。

首次部署前确认最终项目域名，并使其与 `BETTER_AUTH_URL` 完全一致。变更环境变量后重新部署。不要给 Preview 环境继承生产数据库：使用单独 Neon 分支并初始化、设置该 Preview 对应的认证地址与独立密钥，或仅使用 Production。应用会拒绝 Preview 执行每日 Cron。

## 4. 验证上线

1. `/api/health` 返回 `status: ok`；注册测试账户、添加一笔资产，确认登录和保存正常。
2. 打开总览，检查自动刷新及手动刷新；报价失败时应保留账本并显示原因。
3. 在 Vercel 的 Cron Jobs 页面确认每日任务存在，手动执行一次，预期 HTTP 200。直接在浏览器访问 `/api/cron/daily` 应返回 401。
4. 设置页应显示按需行情更新、每日快照状态和本机备份说明。未完成期初录入的用户不会产生每日快照。
5. MCP 地址为 `https://your-project.vercel.app/api/mcp`，继续使用设置页生成的访问令牌。

Vercel 自动把 `CRON_SECRET` 作为 Bearer 头发送给 Cron 接口。接口关闭缓存；HEAD 请求不会执行任务。每次最多补跑每用户 90 天，并在约 210 秒后停止启动新的快照计算，为正在进行的事务留出时间；函数上限 300 秒。HTTP 503 表示尚有历史需要补跑，已提交快照保留，请手动再次执行；500 表示任务失败。Vercel 不保证自动重试，下一次每日任务也会从已保存的检查点继续。大量用户或长历史可能需要多次执行。

## 5. 在本机保存独立备份

安装与 Neon PostgreSQL 版本匹配的 `pg_dump` / `pg_restore`。仓库 Docker 镜像自带的 PG 15 客户端不能备份更高版本服务器。

创建 `.env.backup`，与开发环境配置分开：

```dotenv
DIRECT_URL=postgresql://USER:PASSWORD@YOUR-HOST.neon.tech/DB?sslmode=require
BACKUP_PATH=./backups/neon
# 若 pg_dump 不在 PATH，设置完整路径：
# PG_DUMP_PATH=/absolute/path/to/pg_dump
```

```bash
chmod 600 .env.backup
pnpm db:backup --env-file .env.backup
```

备份包含所有用户的账本与认证数据，保存时权限为 0600，按日期保留最近 30 份。命令需在本机实际执行；没有自动创建电脑定时任务。请定期执行并将副本另存到可信位置。

恢复时，对一个**新的空数据库**运行匹配版本的 `pg_restore --no-owner --no-acl --exit-on-error`，通过受保护的本地环境传入连接信息。核对数据后再切换连接串；不要对原库直接覆盖恢复。设置页 JSON/CSV 导出是个人数据副本，不能替代可完整恢复认证与账本的 PostgreSQL 备份。

## 官方参考

- [Vercel Hobby 用途与额度](https://vercel.com/docs/plans/hobby)
- [Cron 频率与时间精度](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- [Cron 认证、并发与重试](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
- [Neon Free 额度](https://neon.com/blog/how-to-make-the-most-of-neons-free-plan)
