# AssetAtlas

响应式个人资产账本，将现金、股票、公募基金、黄金、加密货币统一按人民币估值。按 `PRD.md` 开发，真实账户初始为空，演示数据仅在 `/demo` 展示。

免费部署推荐 **Vercel Hobby + Neon**，操作步骤见 [免费部署指南](docs/VERCEL.md)。已有 Docker 部署仍然支持。

## 快速启动

Node.js 22.x（至少 22.13），pnpm 11.11.0，PostgreSQL 14+。

```bash
pnpm install
cp .env.example .env.local
# 设置 DATABASE_URL、BETTER_AUTH_SECRET，先创建 asset_atlas 数据库
pnpm db:setup
pnpm dev
```

访问 <http://localhost:3000>；只启动 **一个 Next.js 服务**，Hono API、Better Auth 和后台任务均在同一应用内运行，通过 Prisma 连接 PostgreSQL。

本次本地预览使用 **3003** 端口（3000 已有其他服务），`.env.local` 已对应设置：

```bash
pnpm dev --port 3003
```

- 演示：<http://localhost:3003/demo>
- 注册：<http://localhost:3003/register>
- 登录：<http://localhost:3003/login>

切换端口时同步修改 `BETTER_AUTH_URL`，使邮件回跳、Cookie 和写入 Origin 校验保持同源。

## 已实现

- Next.js App Router + React + TypeScript；Tailwind v4 + HeroUI v3。
- 360px 手机底部导航、768px 紧凑侧栏、1200px+ 完整侧栏；表格在手机转为卡片。
- 注册即自动登录、退出、找回/重置密码、修改密码；重置密码撤销旧会话。
- 总览、持仓筛选与排序、资产详情、期初录入、流水录入/修正/撤销、账户管理。
- 资产详情可直接修改当前总数量，或确认删除持仓（清零并保留历史）；支持小数、并发数量校验、调整审计及已清仓持仓恢复，不修改其他账户同名资产。
- 所有 PRD 事件类型；买卖现金腿和资产腿原子保存、历史非负余额校验。
- 资金相关计算使用 Decimal.js；数据库存十进制字符串，保持精度，不使用浮点数累计金额。
- 持仓重建、外部现金流、调整基线、每日 08:00 快照、历史重算和审计版本。
- 价格/汇率缺失时保留空值、部分估值和不确定盈亏；真实历史不回造。
- 私有手动报价、有效时间和来源、主动切回自动价；公开行情不会静默替换手动价。
- Cookie 认证、用户隔离、Origin 校验、Zod 校验、写入幂等、刷新限频。
- 持仓/流水/快照 CSV 和完整 JSON 导出；CSV 公式注入防护。
- Vercel 按需行情刷新、每日 Cron 快照与断点补跑；Docker 常驻定时采集；本机 PostgreSQL pg_dump 备份保留最近 30 个日备份。
- 单实例 Docker 部署文件、自动化测试和浏览器验收脚本。

## 邮件与认证

注册无需验证邮箱，也不发送注册邮件。已有未验证账户可以直接登录。开发环境无 `RESEND_API_KEY` 时，密码重置邮件保存到 **`data/mailbox/*.json`**，其中 `url` 可在浏览器打开。该目录包含临时令牌，不应提交或公开。界面会明确提示此开发模式。开发密钥自动生成到 `data/.dev-secret`。

生产环境需配置应用地址和密钥；`RESEND_API_KEY` 与 `MAIL_FROM` 仅找回密码功能需要：

```dotenv
BETTER_AUTH_URL=https://your-domain.example
BETTER_AUTH_SECRET=<至少32字节的随机秘密>
RESEND_API_KEY=<邮件服务密钥>
MAIL_FROM=AssetAtlas <hello@your-verified-domain.example>
DATABASE_URL=postgresql://postgres:password@localhost:5432/asset_atlas
ENABLE_SCHEDULER=true
```

可用 `openssl rand -base64 48` 生成密钥。生产环境不提供本地邮件或弱密钥回退。密码由 Better Auth 的默认 scrypt 方案处理，Cookie 为 HttpOnly/SameSite=Lax，生产开启 Secure。会话闲置有效期 7 天，应用 API 强制最长 30 天。

认证的限流在本机没有可信代理 IP 时采用共享路径桶。正式代理须移除来客伪造的 IP 头，再按 Better Auth 的可信代理配置接入；不要直接信任任意 `X-Forwarded-For`。登录和 MCP 的限流计数存入数据库，供多个 Vercel 实例共享。

## 行情状态与边界

保存资产流水后会立即刷新对应持仓的行情和汇率，期初录入阶段也支持按需刷新；Docker 常驻模式还会定时刷新。行情失败不会回滚已保存的流水，页面会提示具体原因；完成初始化之前只更新估值，不生成基线快照。

添加资产时，输入名称或代码会在 500ms 停顿后自动在线搜索，不再依赖预设股票或币种列表。股票由 Twelve Data 查询（美股、A 股、港股，保留交易所及 USD/CNY/HKD 币种），加密货币由 CoinGecko 查询，国内场外公募基金由 Tushare `fund_basic` 查询。基金搜索需要对应接口权限；股票能被搜到不代表账户拥有该市场的报价权限。名称匹配取决于供应商，查不到时可尝试准确代码或英文名称；港股五位代码如 `00700` 会转换为供应商使用的 `0700`。

搜索只返回候选结果，选择后才由服务端核对并登记标的，填写数量并保存后才生成持仓。已有持仓和私有手动标的继续可选，实物黄金保留手动创建。服务端缓存搜索结果 5 分钟，基金目录缓存 24 小时，并对每位用户每分钟最多允许 30 次搜索/选择请求；接口失败与无匹配结果分别提示，支持重试。不同交易所的同名代码、不同 CoinGecko ID 的同名代币不会合并。

| 类型         | 实现                               | 本次验证                              |
| ------------ | ---------------------------------- | ------------------------------------- |
| CNY          | 固定汇率 1                         | 计算测试通过                          |
| USD/HKD 汇率 | Frankfurter，日频                  | USD 基础的 CNY/HKD 响应实测 HTTP 200  |
| 加密货币     | CoinGecko 唯一供应商 ID、独立报价  | Bitcoin/USD 含更新时间，实测 HTTP 200 |
| 股票         | Twelve Data，校验币种和有效时间    | 未提供密钥，覆盖与额度待验证          |
| 国内基金     | Tushare 已公布净值                 | 未提供 Token，权限待验证              |
| 黄金         | 私有手动报价，纯度/克/金衡盎司转换 | 单位与精度测试通过                    |
| 自定义标的   | 用户私有标的与手动估值             | 不冒充自动行情覆盖                    |

可选环境变量：`COINGECKO_API_KEY`、`TWELVE_DATA_API_KEY`、`TUSHARE_TOKEN`。密钥仅供服务端使用。

**不能视为已完成的生产验收：**邮件实际送达、多市场商业行情授权与全面覆盖、法定休市日历、供应商历史行情回补、HTTPS/远程监控、连续 7 天运行与真实移动网络性能。本版不会把“接口已接好”等同于“全部数据可用”。

未提供可靠行情有效时间的日频数据保守地以采集时生效，公布日期保留在来源中；不会倒填到此前的快照。历史价格图展示本应用已经采集的报价，不预置供应商历史。价格不足的补跑日会保留缺口。股票陈旧状态目前用保守时间阈值，没有完整交易日历，因此不宣称准确识别所有休市/停牌。

## 账本使用流程

1. 注册后自动登录，进入空资产空间。
2. 创建需要的逻辑账户，录入所有期初资产。
3. 自动刷新或手动补充价格与汇率，到总览点击“完成期初录入”。
4. 此后用外部转入、买卖、换汇等记录变动。外部转入/转出和修正须保存发生时价格、汇率和依据。
5. 需要买入时先确认结算账户有足够的同币种现金。手续费从现金扣除。
6. 历史快照从正式基线开始积累；修改、撤销会保留审计并重算。已建立基线的期初记录通过“持仓修正”调整。

收益：当前完整总资产 − 起始基线 − 外部净流入 − 持仓修正影响。缺价时显示“已估值合计”，完整组合盈亏显示横线。持仓收益率、TWR/MWR、回撤等属于 PRD 的后续范围。

## 开发与验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:browser
pnpm test:benchmark
pnpm db:backup
pnpm exec prettier --check src tests scripts
```

`pnpm test` 使用 `TEST_DATABASE_URL`（默认本机 `asset_atlas_test` 数据库），每个测试文件独立 schema 并自动清理，拒绝使用名称不以 `_test` 结尾的数据库。先创建测试数据库；备份恢复测试要求测试数据库角色具有 CREATEDB 权限。

`test:browser` 需要先启动本地服务，默认 `http://localhost:3003`，可用 `TEST_BASE_URL` 覆盖。macOS 使用已安装的 Chrome；其他系统先 `pnpm exec playwright install chromium`，或指定 `PLAYWRIGHT_EXECUTABLE_PATH`。脚本创建 `qa-*@example.test` 测试账户，无需验证邮件；**只在开发数据库运行**。

`pnpm build` 使用 Next.js Webpack 生产构建。当前宿主环境的 Turbopack 生产构建受临时端口限制，因此选择该稳定构建路径；开发仍用 Turbopack。

测试覆盖与剩余验收见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md)。实施规划见 [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md)。

## 部署与备份

```bash
# 先按上文配置生产 .env.local
pnpm db:setup
pnpm build
pnpm start
# 或：生成独立 Docker 配置，按需填行情 Key
node scripts/docker-init.mjs
docker compose --env-file .env.docker up --build -d
```

部署使用 PostgreSQL + Prisma。Docker Compose 自动启动数据库、执行一次 Prisma 迁移和种子初始化，再启动应用。Docker 常驻定时任务只启用一个 app 实例；完整流程与 HTTPS 配置见 [Docker 部署指南](docs/DEPLOYMENT.md)。Vercel 部署使用 [免费部署指南](docs/VERCEL.md)，自动关闭进程内定时器。

**Docker 常驻模式**后台每分钟唤醒，15 分钟采集一次活跃持仓。每天北京时间 08:00（UTC 00:00）保存快照；停机后每轮最多补跑 90 天。数据不足时保留不完整标记。任务状态在设置页查看。应在服务器持续运行，关闭个人电脑不会影响服务器任务。

**Vercel 免费模式**在打开工作台或返回标签页时尝试更新行情，数据库控制自动刷新至少间隔 15 分钟；无人访问时不持续采集。每天 Cron 按北京时间 08:00 的历史数据计算快照，实际触发可延迟，缺少历史价格不会回填未来报价。完整数据库备份由部署者在本机执行 `pnpm db:backup --env-file .env.backup`，不在 Vercel 写入备份。

`pnpm db:backup` 使用 `pg_dump` custom 格式写入 `backups/asset-atlas-YYYY-MM-DD.dump`，保留最近 30 份；需要匹配数据库版本的 PostgreSQL 客户端，可通过 `PG_DUMP_PATH` 指定。本机原生客户端不可用时，可以设置 `PG_DUMP_PATH=./scripts/pg-dump`、`PG_RESTORE_PATH=./scripts/pg-restore` 使用官方 Docker 客户端（需启动 Docker Desktop，仅运行临时客户端）。恢复到新数据库后核对数据，再切换 `DATABASE_URL`，详见部署指南。

Prisma 模型见 `prisma/schema.prisma`，迁移文件提交在 `prisma/migrations/`。日常修改模型后使用 `pnpm exec prisma migrate dev --name <change>`，部署使用 `pnpm db:migrate`；`pnpm db:generate` 生成客户端，`pnpm db:studio` 可查看数据。

已有 SQLite 用户：停止旧服务，在空 PostgreSQL 数据库运行 `pnpm db:migrate`，然后 `pnpm db:import-sqlite -- data/asset-atlas.db`。导入器先做 SQLite 一致性备份，按事务迁入所有业务表并核对数量；目标存在用户或流水时拒绝导入。原文件保留。运行时只连接 PostgreSQL，SQLite 依赖仅供旧数据导入。

## 目录

```text
src/app/                  Next.js 页面与唯一 API catch-all
src/components/           响应式业务页面、HeroUI 表单、图表
src/lib/                  类型、客户端、展示格式、隔离演示数据
src/server/api.ts         Hono 路由、认证/隔离/CSRF/幂等中间件
src/server/auth.ts        Better Auth 与邮件适配
src/server/db.ts          Prisma 连接池、事务与用户级并发锁
prisma/                  PostgreSQL 模型与版本化迁移
src/server/ledger.ts      业务事件、原子现金腿、约束、撤销修正
src/server/valuation.ts   Decimal 估值、历史重建、基线/快照
src/server/market.ts      HTTP 行情适配、超时重试与请求合并
src/server/jobs.ts        定时采集、快照补跑、备份
src/instrumentation.ts    在 Next.js 进程启动后台任务
src/proxy.ts              安全传递原页面地址用于登录回跳
```

数据库已改为 PostgreSQL + Prisma，认证使用 Better Auth Prisma Adapter。快照事务、登录/MCP 限流和按需刷新冷却已支持跨实例。Docker 常驻采集/备份仍按单实例运行；供应商搜索限流与缓存仍在进程内，较大规模部署需另行共享和监控。

## 官方接入依据

- [Prisma 7 升级与 PostgreSQL Adapter](https://docs.prisma.io/docs/guides/upgrade-prisma-orm/v7)
- [Hono 在 Next.js 中运行](https://hono.dev/docs/getting-started/nextjs)
- [HeroUI v3 快速开始](https://heroui.com/en/docs/react/getting-started/quick-start)
- [Better Auth 邮箱与密码](https://better-auth.com/docs/authentication/email-password)
- [Frankfurter 汇率接口](https://frankfurter.dev/)
- [CoinGecko Simple Price](https://docs.coingecko.com/reference/simple-price)
- [Tushare 公募基金净值](https://tushare.pro/document/2?doc_id=119)

## 共同资产与 AI 分析

- 「共同资产」页面通过注册邮箱发起站内邀请。双方分别选择愿意共享的账户，接受后可合并查看。新增账户默认不共享；任一方可解除。可以关联多位家人，各段关系独立、不会传递授权；资产修改仍由所有者操作。
- 加密货币使用 CoinGecko 图标，旧资产首次展示时补齐并缓存；黄金使用内置图标，其他资产不显示图标。图标服务失败时显示币种缩写，不影响估值。
- 「账户与设置 → 连接 AI 助手 · MCP」可以生成只读令牌，供其他 Agent 分析个人持仓。支持 HTTP 直接连接与可下载的 stdio 脚本，详见 [MCP 使用说明](docs/MCP.md)。家人的共享资产不在该授权内。
