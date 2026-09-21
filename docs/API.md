# Hono API

业务请求同源进入 Next.js 的 `src/app/api/[[...route]]/route.ts`，没有独立 Hono 端口。每日 Cron 使用独立的 `src/app/api/cron/daily/route.ts`。

私有接口使用 Better Auth Cookie。服务端从会话获取用户 ID，不接受调用者指定用户身份。写入请求须带 `Content-Type: application/json`、匹配 `BETTER_AUTH_URL` 的 `Origin`、长度 8–100 的 `Idempotency-Key`。同键同请求重放返回相同结果，不同请求返回 409。金额和数量传十进制字符串，时间用 UTC ISO 8601。

`POST /api/refresh` 是限频刷新例外，不存幂等响应。请求体 `{mode:"auto"}` 使用数据库共享的 15 分钟冷却窗口，跳过时返回 200 `{skipped:true,warnings:[]}`；`{}` 或 `{mode:"manual"}` 为手动刷新，60 秒内重复返回 429。两种模式共用最近尝试时间，失败也保留冷却。成功执行返回 `{skipped:false,warnings,updatedAt}`。仍须登录、同源 Origin 和 JSON。

`GET /api/cron/daily` 使用独立 `Authorization: Bearer <CRON_SECRET>`，不使用用户 Cookie、Origin 或幂等键。仅计算每日快照和清理过期限流/验证记录，不刷新行情、不写本地备份。未配置密钥或密钥错误返回 401，Vercel Preview 返回 403，HEAD 返回 405。完成返回 200 `{created,pending:false,boundary}`；有待补跑记录返回 503 `{created,pending:true,boundary}`，再次执行从已提交快照继续；失败返回 500。响应均不缓存。

持仓操作：`PATCH /api/assets/:accountId~instrumentId/quantity` 提交 `quantity`（新的非负总数量）、`expectedQuantity`（操作前数量）和 `reason`；`DELETE /api/assets/:accountId~instrumentId` 提交 `expectedQuantity` 和 `reason`，将当前持仓清零。两者保留历史、记录调整和审计；并发数量变化返回 409，不会覆盖。初始化后缺少参考价格或汇率时，需补充 `price` / `fx`；已有报价自动采用，不新增手动覆盖。数量为零的持仓可重新设置正数恢复。

| 方法     | 路径                                       | 用途                                                                              |
| -------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| GET/POST | `/api/auth/*`                              | Better Auth 注册自动登录/登录/密码/会话                                           |
| GET      | `/api/health`                              | 无私有信息的存活检查                                                              |
| GET      | `/api/config`                              | 邮件模式说明，不返回密钥                                                          |
| GET      | `/api/portfolio`                           | 当前估值、持仓、账户、最近事件与快照                                              |
| GET/POST | `/api/instruments`                         | 可见标的、创建私有手动标的                                                        |
| GET/POST | `/api/accounts`                            | 逻辑账户查询、创建                                                                |
| PATCH    | `/api/accounts/:id`                        | 名称/类型/归档状态                                                                |
| POST     | `/api/initialize`                          | 全部期初资产统一估值，建立正式基线                                                |
| GET      | `/api/assets/:accountId~instrumentId`      | 持仓详情、价格/价值历史、关联流水                                                 |
| GET      | `/api/transactions?page=1&type=buy`        | 25 条分页与类型筛选                                                               |
| GET      | `/api/transactions/:id`                    | 当前用户的单个事件与关联腿                                                        |
| POST     | `/api/transactions`                        | 创建完整事件                                                                      |
| PUT      | `/api/transactions/:id`                    | 保留旧事件、保存新事件并原子重算                                                  |
| POST     | `/api/transactions/:id/void`               | `reason` 必填；撤销与原子重算                                                     |
| POST     | `/api/quotes`                              | 手动报价/汇率或主动结束手动价格覆盖                                               |
| POST     | `/api/refresh`                             | 60 秒用户限频、共享行情缓存和请求合并                                             |
| GET      | `/api/export?kind=json`                    | 完整个人数据                                                                      |
| GET      | `/api/export?kind=holdings`                | 持仓 CSV；另支持 transactions、snapshots                                          |
| GET      | `/api/system`                              | 后台任务与行情配置状态                                                            |
| GET      | `/api/instruments/search?q=...&type=stock` | 登录后在线搜索；type 支持 all/stock/crypto/fund/cash/gold，返回 items 与 warnings |
| POST     | `/api/instruments/import`                  | 提交搜索的 q/type/key，服务端重新核对来源后登记标的；不会创建持仓                 |

流水字段由 `src/server/ledger.ts` 的 `eventSchema` 定义。买卖的 `targetAccountId` 表示结算现金账户，转账/换汇表示接收账户。`quantity` 是绝对变动数量；修正/份额变更用 `direction` 表明增减。换汇使用 `targetInstrumentId` 和 `receivedQuantity`。`price`、`fx` 是发生时参考依据；填写后作为私有报价记录，支持后续主动切回自动价格。`purchaseCost` 可选，仅作期初成本记录，不用于凭空生成历史收益。

错误为 `{ "error": "可读原因" }`，使用 400（校验/业务约束）、401（需登录）、403（来源）、404（不存在或不可见）、409（冲突）、429（频率）、500（内部故障）。错误日志不包含密码、令牌、报价密钥或用户持仓明细。

## 共同资产（需登录 Cookie）

- `GET /api/shares`：自己的邀请、有效期、状态和自己授权的账户。邀请有效期 7 天。
- `POST /api/shares`：`{email,walletIds}`，向已注册用户发起邀请，同时同意对方接受后查看所选账户。双方已有 pending/accepted 关系时拒绝重复邀请。
- `POST /api/shares/:id/accept`：受邀人提交 `{walletIds}`，同意并授权自己的账户。
- `POST /api/shares/:id/decline`：受邀人拒绝；`POST /api/shares/:id/revoke`：任一方撤回或解除；请求体 `{}`。
- `POST /api/shares/:id/wallets`：`{walletIds}`，只修改自己的授权账户范围。
- `GET /api/shares/:id/portfolio`：双方授权账户的当前持仓及合计，只有 accepted 关系的当事人可读。
- `GET /api/shares/portfolio`：汇总所有与自己互相授权的账户，按账户去重；不传递其他人的共享关系。不含个人流水、备注、整体基准和历史快照。

上述写接口沿用 Origin 校验与 Idempotency-Key。资产修改接口仍只允许资产所有者使用。

## 图标

`GET /api/instruments/:id/icon`：登录后解析加密货币的 CoinGecko 图标，按 providerId 精确匹配，缓存到 instrument.iconUrl；仅允许可信 CoinGecko HTTPS 图片域名。不存在或上游不可用时 404，UI 使用币种缩写回退。黄金静态图标为 `/icons/gold.svg`。

## MCP 与令牌

- `GET /api/mcp-tokens`：列出自己的令牌元数据，不包含令牌明文或哈希。
- `POST /api/mcp-tokens`：`{name,expiresInDays,transactions}`；登录 + Origin 校验。只在此响应返回一次性 token，**不缓存幂等响应**。有效期 1–365 天，默认 90 天，基础权限 portfolio:read，transactions=true 时增加 transactions:read。
- `DELETE /api/mcp-tokens/:id`：登录 + Origin + Idempotency-Key，请求体 `{}`，撤销自己的令牌。
- `POST /api/mcp`：独立 Bearer 令牌认证，无状态 MCP Streamable HTTP；要求 Accept 包含 application/json 与 text/event-stream。不使用 Cookie 和业务写接口幂等键；非 POST 返回 405，非法令牌 401，非法 Origin 403，限流 429。

协议方法和客户端配置见 [MCP.md](MCP.md)。只读方法不向其他服务实时查询或发送资产数据；使用账本中已有价格、汇率和快照。
