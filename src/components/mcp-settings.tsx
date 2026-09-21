"use client";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { Cable, Copy, Download } from "lucide-react";
import { api } from "@/lib/api-client";
import { Action, Field, Notice, SelectField } from "./ui";
type Token = {
  id: string;
  name: string;
  prefix: string;
  scopes: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};
export function McpSettings() {
  const { data, error, mutate } = useSWR<{ items: Token[] }>(
    "/mcp-tokens",
    api,
    { shouldRetryOnError: false },
  );
  const [name, setName] = useState("我的 AI 助手"),
    [days, setDays] = useState("90"),
    [transactions, setTransactions] = useState(false),
    [secret, setSecret] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [confirm, setConfirm] = useState<string | null>(null),
    [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const config = JSON.stringify(
    {
      mcpServers: {
        "asset-atlas": {
          command: "node",
          args: ["/绝对路径/asset-atlas-bridge.mjs"],
          env: {
            ASSET_ATLAS_URL: origin,
            ASSET_ATLAS_TOKEN: secret || "在此填入令牌",
          },
        },
      },
    },
    null,
    2,
  );
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const r = await api<{ token: string }>("/mcp-tokens", {
        name,
        expiresInDays: Number(days),
        transactions,
      });
      setSecret(r.token);
      await mutate();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    try {
      await api(`/mcp-tokens/${id}`, {}, "DELETE");
      setConfirm(null);
      setSecret("");
      await mutate();
      setMessage("令牌已撤销，相关 AI 工具无法再读取资产。");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage("已复制");
    } catch {
      setMessage("复制失败，请手动选择文本复制。");
    }
  }
  return (
    <section className="panel settings-panel mt-6" id="mcp">
      <div className="panel-heading">
        <div>
          <h2>连接 AI 助手 · MCP</h2>
          <p>让你选择的 AI 工具分析持仓、配置与历史变化</p>
        </div>
        <Cable size={22} />
      </div>
      <Notice>
        令牌仅可读取本人资产，不包含家人的共享资产，不能新增、修改或删除记录。连接的
        AI 服务会收到你授权的数据。
      </Notice>
      {message && <Notice>{message}</Notice>}
      {error && (
        <Notice tone="error">
          {error.message} <button onClick={() => mutate()}>重试</button>
        </Notice>
      )}
      <div className="mcp-grid">
        <form onSubmit={create}>
          <h3>创建访问令牌</h3>
          <Field
            label="令牌名称"
            required
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <SelectField
            label="有效期"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          >
            <option value="7">7 天</option>
            <option value="30">30 天</option>
            <option value="90">90 天</option>
            <option value="365">365 天</option>
          </SelectField>
          <label className="check-line">
            <input
              type="checkbox"
              checked={transactions}
              onChange={(e) => setTransactions(e.target.checked)}
            />
            同时允许读取流水及备注
          </label>
          <p className="field-hint">
            默认允许读取资产总览、账户、持仓详情、配置比例和历史快照。
          </p>
          <Action type="submit" isDisabled={busy || !!secret}>
            创建只读令牌
          </Action>
        </form>
        <div>
          <h3>安装到其他 Agent</h3>
          <ol className="setup-steps">
            <li>本机安装 Node.js 22 或更高版本。</li>
            <li>
              <a
                href="/mcp/asset-atlas-bridge.mjs"
                download
                className="text-link"
              >
                <Download size={14} className="inline" /> 下载 MCP 连接脚本
              </a>
              ，保存到固定位置。
            </li>
            <li>
              复制下方配置到工具的 MCP
              配置文件，把脚本路径改为实际绝对路径；远程部署时使用 HTTPS 地址。
            </li>
            <li>
              重启该工具，启用
              asset-atlas。可尝试：“分析我的持仓集中度，并标明缺失或过期报价。”
            </li>
          </ol>
          <details>
            <summary>支持远程 HTTP 的客户端</summary>
            <p>
              类型选择 Streamable HTTP，地址为 <code>{origin}/api/mcp</code>
              ，请求头填写 <code>Authorization: Bearer 你的令牌</code>
              。当前采用访问令牌认证；仅支持 OAuth 的客户端请使用下方 stdio
              连接脚本。
            </p>
          </details>
        </div>
      </div>
      {secret && (
        <div className="mcp-secret">
          <Notice>
            令牌只显示这一次。妥善保存配置，不要发送给他人或提交到代码仓库。
          </Notice>
          <Field
            label="一次性显示的令牌"
            value={secret}
            readOnly
            autoComplete="off"
          />
          <div className="page-actions">
            <Action secondary onPress={() => copy(secret)}>
              <Copy size={14} />
              复制令牌
            </Action>
            <Action secondary onPress={() => copy(config)}>
              <Copy size={14} />
              复制 MCP 配置
            </Action>
            <Action secondary onPress={() => setSecret("")}>
              已保存，隐藏令牌
            </Action>
          </div>
        </div>
      )}
      <details className="mcp-config" open={!!secret}>
        <summary>stdio MCP 配置示例{secret ? "（包含本次令牌）" : ""}</summary>
        <pre>{config}</pre>
      </details>
      <div className="token-list">
        {data?.items.map((t) => (
          <div className="token-row" key={t.id}>
            <div>
              <b>{t.name}</b>
              <small>
                {t.prefix}… ·{" "}
                {t.revokedAt
                  ? "已撤销"
                  : Date.parse(t.expiresAt) <= Date.now()
                    ? "已过期"
                    : `有效至 ${new Date(t.expiresAt).toLocaleDateString("zh-CN")}`}
              </small>
              <small>
                {t.scopes.includes("transactions:read")
                  ? "资产与流水只读"
                  : "资产只读"}{" "}
                ·{" "}
                {t.lastUsedAt
                  ? `最近使用 ${new Date(t.lastUsedAt).toLocaleString("zh-CN")}`
                  : "尚未使用"}
              </small>
            </div>
            {!t.revokedAt &&
              (confirm === t.id ? (
                <div className="page-actions">
                  <Action isDisabled={busy} onPress={() => revoke(t.id)}>
                    确认撤销
                  </Action>
                  <Action secondary onPress={() => setConfirm(null)}>
                    取消
                  </Action>
                </div>
              ) : (
                <Action
                  secondary
                  isDisabled={busy}
                  onPress={() => setConfirm(t.id)}
                >
                  撤销
                </Action>
              ))}
          </div>
        ))}
      </div>
    </section>
  );
}
