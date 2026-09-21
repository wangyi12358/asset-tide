# MCP：让其他 AI 工具分析资产

入口：**账户与设置 → 连接 AI 助手 · MCP**。服务与 Next.js/Hono 共用一个进程、一个端口，地址为 `https://你的域名/api/mcp`，使用官方 TypeScript MCP SDK 的无状态 Streamable HTTP 传输。所有方法均只读。

## 连接步骤

1. 创建访问令牌，选择有效期（7/30/90/365 天），按需勾选“同时允许读取流水及备注”。令牌只显示一次。
2. 支持 Streamable HTTP 和自定义请求头的客户端：配置上述 URL，增加 `Authorization: Bearer 令牌`。
3. 仅支持 stdio 的客户端：安装 Node.js 22+，从设置页面下载 `asset-atlas-bridge.mjs`（也位于仓库 `public/mcp/`），保存到固定路径。把设置页面生成的 JSON 合并进客户端的 `mcpServers` 配置，替换脚本的绝对路径，然后重启客户端。

```json
{
  "mcpServers": {
    "asset-atlas": {
      "command": "node",
      "args": ["/absolute/path/asset-atlas-bridge.mjs"],
      "env": {
        "ASSET_ATLAS_URL": "https://assets.example.com",
        "ASSET_ATLAS_TOKEN": "aat_替换成你的令牌"
      }
    }
  }
}
```

Windows 使用 `C:\\Users\\你\\asset-atlas-bridge.mjs` 等绝对路径。HTTP 仅允许 localhost / 127.0.0.1 / ::1 本地调试；远程地址必须使用 HTTPS。脚本不依赖 npm 安装，stdout 仅输出 MCP 消息，协议由服务器 SDK 处理。当前没有 OAuth 登录流程；要求 OAuth 的纯远程客户端需改用支持本地 stdio 的客户端。

## 方法

| 方法 | 作用 | 参数 |
|---|---|---|
| `get_portfolio_summary` | 总额、收益、基准、缺失和过期报价数量 | 无 |
| `list_accounts` | 本人账户列表 | 无 |
| `list_holdings` | 持仓、数量、原币价格、CNY 估值和来源 | 可选 type、accountId、includeClosed；offset、limit ≤ 100 |
| `get_asset_detail` | 单项持仓与估值依据 | holdingId |
| `get_allocation` | 资产类型、币种或账户占比 | groupBy：type / currency / account |
| `get_portfolio_history` | 历史快照、净流入、收益与完整度 | from / to（ISO 时间）、offset、limit ≤ 366 |
| `list_transactions` | 流水和分录，包括备注 | 需额外流水权限；from / to、offset、limit ≤ 100 |

流水权限未授权时，不会在 tools/list 中出现，也不能通过 tools/call 绕过。持仓列表支持 nextOffset；历史与流水按时间倒序，返回数量少于 limit 时到达末尾。

## 授权与数据口径

- 每个令牌绑定创建者，不能指定任意用户 ID。**MCP 不包括家人共享的资产**，避免将家人的数据自动授权给外部 AI。
- 密钥只在创建响应里出现一次，数据库仅保存 SHA-256 哈希和显示前缀。创建响应不进入 API 幂等结果缓存。密钥遗失时撤销并新建；网络异常时在列表里检查并撤销未保存的令牌。
- 在设置页面撤销立即阻止后续请求；有效期最长 365 天、每用户最多 20 个有效令牌、每令牌每分钟最多 120 请求。
- 令牌可以读取本人全部账户；当前不支持为 MCP 再细分单个资产账户。基础权限包含账户名称、持仓和历史汇总；流水及备注独立授权。
- 所有金额以十进制字符串返回，组合计价币种 CNY。`complete=false` 表示 total 仅为已有估值部分，不能理解为完整净资产；保留价格、汇率日期与来源。
- 别把令牌或包含它的配置提交到 Git。AI 服务获得你主动授权的资产数据；应自行选择可信的客户端和模型服务。

示例提问：“根据当前持仓分析币种暴露与集中度，先列出缺失或过期报价，不要假设缺失价格为零。”
