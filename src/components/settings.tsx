"use client";
import { McpSettings } from "./mcp-settings";
import { useState } from "react";
import useSWR from "swr";
import {
  Download,
  Plus,
  Landmark,
  Archive,
  Pencil,
  ShieldCheck,
  CheckCircle2,
  Database,
  Activity,
} from "lucide-react";
import { useWorkspace } from "./workspace";
import { Action, Field, Notice, PageTitle, SelectField } from "./ui";
import { api } from "@/lib/api-client";
import { authClient } from "@/lib/auth-client";
import type { Wallet } from "@/lib/types";
export function SettingsPage() {
  const { data, demo, reload } = useWorkspace();
  const [name, setName] = useState("");
  const [type, setType] = useState("综合账户");
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const { data: system } = useSWR<{
    scheduleMode: "continuous" | "on-demand";
    backupMode: "server" | "local";
    providers: Record<string, string>;
    jobs: {
      name: string;
      lastSuccess: string | null;
      lastError: string | null;
    }[];
  }>(demo ? null : "/system", api);
  async function account(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await api(
        editing ? `/accounts/${editing}` : "/accounts",
        { name, type },
        editing ? "PATCH" : "POST",
      );
      await reload();
      setName("");
      setEditing(null);
      setMessage("账户已保存");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function archive(a: Wallet) {
    setBusy(true);
    try {
      await api(`/accounts/${a.id}`, { archived: !a.archived }, "PATCH");
      await reload();
      setMessage(
        a.archived
          ? "账户已恢复"
          : "账户已归档，持仓与历史数据继续保留在统计中。",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await authClient.changePassword({
        currentPassword: current,
        newPassword: password,
        revokeOtherSessions: true,
      });
      if (r.error) throw new Error(r.error.message || "密码修改失败");
      setMessage("密码已更新，其他设备会话已撤销。");
      setCurrent("");
      setPassword("");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="A SPACE THAT’S TRULY YOURS"
        title="账户与设置"
        description="管理资产的归属，也守护记录的安全。"
      />
      {message && <Notice>{message}</Notice>}
      {demo && (
        <Notice>
          演示空间仅供浏览。注册后即可管理自己的账户、密码和数据。
        </Notice>
      )}
      <div className="settings-grid">
        <section className="panel settings-panel">
          <div className="panel-heading">
            <div>
              <h2>资产账户</h2>
              <p>按银行、券商和钱包区分资产存放位置</p>
            </div>
            <Landmark size={20} />
          </div>
          <div className="account-list">
            {data.accounts.map((a) => (
              <div className="account-row" key={a.id}>
                <span className="account-icon">
                  <Landmark size={19} />
                </span>
                <div>
                  <b>{a.name}</b>
                  <small>
                    {a.type}
                    {a.archived ? " · 已归档" : ""}
                  </small>
                </div>
                {!demo && (
                  <div className="row-actions">
                    <button
                      className="icon-button"
                      aria-label={`修改${a.name}`}
                      onClick={() => {
                        setEditing(a.id);
                        setName(a.name);
                        setType(a.type);
                      }}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="icon-button"
                      disabled={busy}
                      aria-label={`${a.archived ? "恢复" : "归档"}${a.name}`}
                      onClick={() => archive(a)}
                    >
                      <Archive size={15} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {!demo && (
            <form className="account-form" onSubmit={account}>
              <h3>{editing ? "编辑账户" : "添加账户"}</h3>
              <div className="form-grid">
                <Field
                  label="账户名称"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={60}
                  placeholder="例如：银行美元账户"
                />
                <SelectField
                  label="账户类型"
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                >
                  {[
                    "综合账户",
                    "银行账户",
                    "证券账户",
                    "基金账户",
                    "数字钱包",
                    "实物保管",
                  ].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </SelectField>
              </div>
              <div className="page-actions">
                <Action type="submit" isDisabled={busy}>
                  <Plus size={15} />
                  {editing ? "保存修改" : "创建账户"}
                </Action>
                {editing && (
                  <Action
                    secondary
                    onPress={() => {
                      setEditing(null);
                      setName("");
                    }}
                  >
                    取消编辑
                  </Action>
                )}
              </div>
            </form>
          )}
        </section>
        <div className="settings-column">
          <section className="panel settings-panel">
            <div className="panel-heading">
              <h2>账户安全</h2>
              <ShieldCheck size={20} />
            </div>
            <div className="email-status">
              <span>
                <b>{data.email}</b>
                <small>
                  <CheckCircle2 size={13} />
                  邮箱密码登录 · 无需验证
                </small>
              </span>
            </div>
            {!demo && (
              <form onSubmit={changePassword}>
                <Field
                  label="当前密码"
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  required
                />
                <Field
                  label="新密码"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  hint="8–128 个字符；修改后其他会话会退出。"
                />
                <Action type="submit" secondary isDisabled={busy}>
                  更新密码
                </Action>
              </form>
            )}
          </section>
          <section className="panel settings-panel">
            <div className="panel-heading">
              <h2>数据导出</h2>
              <Database size={20} />
            </div>
            <p>你的记录始终属于你。可导出持仓、流水和历史快照。</p>
            <div className="export-grid">
              {[
                ["holdings", "持仓 CSV"],
                ["transactions", "流水 CSV"],
                ["snapshots", "快照 CSV"],
                ["json", "完整数据 JSON"],
              ].map(([kind, label]) => (
                <a
                  key={kind}
                  className="export-button"
                  href={demo ? "/register" : `/api/export?kind=${kind}`}
                >
                  <Download size={16} />
                  {label}
                </a>
              ))}
            </div>
          </section>
        </div>
      </div>
      {!demo && <McpSettings />}
      <section className="panel settings-panel mt-6">
        <div className="panel-heading">
          <div>
            <h2>估值与系统状态</h2>
            <p>
              统计币种 CNY · 默认时区 Asia/Shanghai · 每日快照以 08:00
              为估值时点
            </p>
          </div>
          <Activity size={20} />
        </div>
        <div className="provider-grid">
          {Object.entries(
            system?.providers || {
              fx: "Frankfurter",
              crypto: "CoinGecko",
              stocks: "按供应商覆盖获取",
              gold: "手动参考金属价值",
            },
          ).map(([key, value]) => (
            <div key={key}>
              <span>
                {
                  {
                    fx: "外币汇率",
                    crypto: "加密货币",
                    stocks: "股票",
                    funds: "公募基金",
                    gold: "黄金",
                  }[key]
                }
              </span>
              <b>{value}</b>
            </div>
          ))}
        </div>
        {system?.scheduleMode === "on-demand" && (
          <p className="system-job">
            打开页面或返回标签页时按需更新行情，自动更新间隔至少 15
            分钟；无人访问时不持续采集。每日快照可能延迟生成，缺少历史报价时保留缺口。
          </p>
        )}
        {system?.backupMode === "local" && (
          <p className="system-job">
            完整数据库备份由部署者在本机保存。下方任务状态不代表已有独立备份；个人账本可使用本页导出功能。
          </p>
        )}
        {system?.scheduleMode === "on-demand" &&
          !system.jobs.some((j) => j.name === "daily-snapshots") && (
            <p className="system-job">每日快照：等待首次执行</p>
          )}
        {system?.jobs
          .filter(
            (j) =>
              system.scheduleMode === "continuous" ||
              j.name === "daily-snapshots",
          )
          .map((j) => (
            <p className="system-job" key={j.name}>
              {(
                {
                  backup: "数据库备份",
                  market: "行情采集",
                  scheduler: "后台调度",
                  "daily-snapshots": "每日快照",
                } as Record<string, string>
              )[j.name] || j.name}
              ：
              {j.lastError ||
                (j.lastSuccess
                  ? `最近完成 ${new Date(j.lastSuccess).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`
                  : "等待首次执行")}
            </p>
          ))}
      </section>
    </>
  );
}
