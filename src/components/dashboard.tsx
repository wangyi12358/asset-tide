"use client";
import Link from "next/link";
import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  CirclePlus,
  RefreshCw,
  ArrowRight,
  TrendingUp,
  Wallet,
  ArrowLeftRight,
  Info,
} from "lucide-react";
import { useWorkspace } from "./workspace";
import { Action, Empty, Notice, PageTitle } from "./ui";
import { Allocation, HistoryChart } from "./charts";
import { HoldingList } from "./holdings";
import { TransactionList } from "./transactions";
import { api } from "@/lib/api-client";
import { dateTime } from "@/lib/format";
export function Dashboard() {
  const { data, demo, amount, href, reload } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function refresh() {
    setBusy(true);
    setMessage("");
    try {
      const result = await api<{ warnings: string[] }>("/refresh", {});
      await reload();
      setMessage(
        result.warnings.length
          ? result.warnings.join("；")
          : "估值已更新，报价来源可在资产详情查看。",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function initialize() {
    setBusy(true);
    try {
      await api("/initialize", {});
      await reload();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const active = data.holdings.filter((h) => Number(h.quantity) > 0);
  return (
    <>
      <PageTitle
        eyebrow="YOUR WEALTH, IN PERSPECTIVE"
        title="资产总览"
        description="把分散的资产，汇成清晰的全貌。"
        action={
          <div className="page-actions">
            {!demo && (
              <Action secondary onPress={refresh} isDisabled={busy}>
                <RefreshCw size={16} className={busy ? "spin" : ""} />
                {busy ? "更新中" : "刷新估值"}
              </Action>
            )}
            <Link href={demo ? "/register" : "/assets/new"} className="action">
              <CirclePlus size={17} />
              添加资产
            </Link>
          </div>
        }
      />
      {message && <Notice>{message}</Notice>}
      {!data.initialized && active.length > 0 && (
        <Notice>
          期初资产录入中。请录入全部已有持仓，补齐报价，再建立起始基线。
          <Action secondary onPress={initialize} isDisabled={busy}>
            完成期初录入
          </Action>
        </Notice>
      )}
      {data.missingCount > 0 && (
        <Notice tone="error">
          {data.missingCount}{" "}
          项持仓缺少价格或汇率，当前仅显示已估值合计，组合盈亏待确认。
        </Notice>
      )}
      <div className="stat-grid">
        <section className="total-card">
          <div className="total-card-top">
            <span>{data.complete ? "总资产估值" : "已估值资产合计"}</span>
            <span className="currency-tag">CNY 人民币</span>
          </div>
          <div className="total-value">
            <span>¥</span>
            {amount(data.total)}
          </div>
          <div className="total-card-bottom">
            <span>
              <span className="status-dot" />
              {data.complete
                ? data.staleCount
                  ? "含历史报价"
                  : "估值完整"
                : "部分估值"}
            </span>
            <span>{dateTime(data.asOf)} 更新</span>
          </div>
          <div className="total-decoration" aria-hidden="true" />
        </section>
        <section className="stat-card">
          <div className="stat-label">
            累计投资盈亏 <TrendingUp size={18} />
          </div>
          <div
            className={`stat-value ${Number(data.pnl) >= 0 ? "positive" : "negative"}`}
          >
            {amount(data.pnl, true)}
            <span>CNY</span>
          </div>
          <div className="stat-note">
            <span className="soft-pill">
              <ArrowUpRight size={13} />
              {data.pnl === null ? "待建立完整基线" : "已剔除外部净流入"}
            </span>
            <span>从开始记录至今</span>
          </div>
        </section>
        <section className="stat-card">
          <div className="stat-label">
            累计外部净流入 <ArrowDownToLine size={18} />
          </div>
          <div className="stat-value">
            {amount(data.netFlow, true)}
            <span>CNY</span>
          </div>
          <div className="stat-note">
            <span className="soft-pill neutral">
              {data.accounts.length} 个资产账户
            </span>
            <span>投入与收益，分开看</span>
          </div>
        </section>
      </div>
      <div className="daily-summary">
        <span>
          <span className="summary-icon">
            <ArrowLeftRight size={15} />
          </span>
          较上一有效日快照
        </span>
        <div>
          <span>
            资产变化 <b>{amount(data.change, true)}</b>
          </span>
          <span>
            期间净流入 <b>{amount(data.periodFlow, true)}</b>
          </span>
          <span>
            投资盈亏{" "}
            <b
              className={Number(data.periodPnl) >= 0 ? "positive" : "negative"}
            >
              {amount(data.periodPnl, true)}
            </b>
          </span>
        </div>
        <span
          className="summary-help"
          title="投资盈亏 = 资产变化 − 外部净流入 − 持仓修正影响；没有完整上日快照时显示横线。"
        >
          <Info size={15} />
        </span>
      </div>
      <div className="chart-grid">
        <HistoryChart />
        <Allocation />
      </div>
      <div className="bottom-grid">
        <section className="panel holdings-panel">
          <div className="panel-heading">
            <div>
              <h2>
                主要持仓 <span className="count-badge">{active.length}</span>
              </h2>
              <p>一览你持有的每一份价值</p>
            </div>
            <Link className="text-link" href={href("/assets")}>
              全部资产 <ArrowRight size={15} />
            </Link>
          </div>
          {active.length ? (
            <HoldingList
              items={[...active]
                .sort((a, b) => Number(b.value) - Number(a.value))
                .slice(0, 5)}
              compact
            />
          ) : (
            <Empty title="第一份记录，是清晰的开始">
              <p>手动录入现金、股票、基金、黄金或加密货币。</p>
              <Link className="action mt-5" href="/assets/new">
                <Wallet size={16} />
                录入第一笔资产
              </Link>
            </Empty>
          )}
        </section>
        <section className="panel recent-panel">
          <div className="panel-heading">
            <div>
              <h2>最近流水</h2>
              <p>让每次变动都有迹可循</p>
            </div>
            <Link
              className="icon-button"
              href={href("/transactions")}
              aria-label="查看全部流水"
            >
              <ArrowUpRight size={18} />
            </Link>
          </div>
          <TransactionList items={data.transactions.slice(0, 4)} compact />
          <Link
            href={demo ? "/register" : "/transactions/new"}
            className="record-link"
          >
            <CirclePlus size={16} /> 记录一笔变动
          </Link>
        </section>
      </div>
      <div className="valuation-note">
        <Info size={15} />
        <span>
          所有估值以人民币展示，仅作资产记录参考。黄金按金属价值估算，不含回收折价与工费。
        </span>
      </div>
    </>
  );
}
