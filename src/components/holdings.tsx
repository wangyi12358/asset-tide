"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  Plus,
  Search,
  ArrowUpDown,
  ArrowUpRight,
  Download,
} from "lucide-react";
import { ASSET_LABELS, type AssetType, type Holding } from "@/lib/types";
import { dateTime, quantity } from "@/lib/format";
import { useWorkspace } from "./workspace";
import { AssetIcon, Empty, PageTitle } from "./ui";
export function QuoteStatus({ item }: { item: Holding }) {
  return (
    <span className={`quote-status ${item.status}`}>
      <i />
      {
        {
          missing: "待补报价",
          manual: "手动估值",
          stale: "历史报价",
          current: "有效报价",
        }[item.status]
      }
    </span>
  );
}
export function HoldingList({
  items,
  compact = false,
}: {
  items: Holding[];
  compact?: boolean;
}) {
  const { data, href, amount, hidden } = useWorkspace();
  return (
    <div className={`holding-list ${compact ? "compact" : ""}`}>
      <div className="holding-head">
        <span>资产 / 账户</span>
        <span>持有数量</span>
        {!compact && <span>参考单价</span>}
        <span>人民币价值</span>
        {!compact && <span>报价状态</span>}
        <span />
      </div>
      {items.map((item) => (
        <Link
          key={item.holdingId}
          href={href(`/assets/${item.holdingId}`)}
          className="holding-row"
        >
          <span className="holding-identity">
            <AssetIcon
              type={item.type}
              symbol={item.symbol}
              id={item.id}
              iconUrl={item.iconUrl}
            />
            <span>
              <b>{item.name}</b>
              <small>
                {item.symbol} <i>·</i>{" "}
                {compact ? item.market : item.accountName}
              </small>
            </span>
          </span>
          <span className="holding-quantity">
            {hidden ? "••••" : quantity(item.quantity)}{" "}
            <small>{item.unit}</small>
          </span>
          {!compact && (
            <span className="holding-price">
              {amount(item.price)}
              <small>{item.currency}</small>
            </span>
          )}
          <span className="holding-value">
            <b>{amount(item.value)}</b>
            <small>
              {item.value && Number(data.total) > 0 && !hidden
                ? `${((Number(item.value) / Number(data.total)) * 100).toFixed(1)}%`
                : "—"}{" "}
              <span className="mini-bar">
                <i
                  style={{
                    width: `${Math.min(100, (Number(item.value || 0) / Number(data.total || 1)) * 100)}%`,
                  }}
                />
              </span>
            </small>
          </span>
          {!compact && (
            <span className="holding-status">
              <QuoteStatus item={item} />
              <small>
                {item.priceAsOf ? dateTime(item.priceAsOf) : "尚无数据"}
              </small>
            </span>
          )}
          <ArrowUpRight className="row-arrow" size={15} />
        </Link>
      ))}
    </div>
  );
}
export function AssetsPage() {
  const { data, demo } = useWorkspace();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [type, setType] = useState("all");
  const [account, setAccount] = useState("all");
  const [sort, setSort] = useState("value");
  const [closed, setClosed] = useState(false);
  const q = searchParams.get("q") || "";
  const [previousQ, setPreviousQ] = useState(q);
  if (q !== previousQ) {
    setPreviousQ(q);
    setQuery(q);
  }
  const filtered = data.holdings
    .filter(
      (h) =>
        (closed || Number(h.quantity) > 0) &&
        (type === "all" || h.type === type) &&
        (account === "all" || h.accountId === account) &&
        `${h.name} ${h.symbol} ${h.market}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, "zh-CN")
        : Number(b.value || 0) - Number(a.value || 0),
    );
  return (
    <>
      <PageTitle
        eyebrow="YOUR ASSET COLLECTION"
        title="我的资产"
        description="不同市场，不同账户，一处管理。"
        action={
          <Link className="action" href={demo ? "/register" : "/assets/new"}>
            <Plus size={17} />
            添加资产
          </Link>
        }
      />
      <div className="asset-category-tabs">
        <button
          onClick={() => setType("all")}
          className={type === "all" ? "active" : ""}
        >
          全部资产{" "}
          <span>
            {data.holdings.filter((h) => Number(h.quantity) > 0).length}
          </span>
        </button>
        {(Object.keys(ASSET_LABELS) as AssetType[]).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={type === t ? "active" : ""}
          >
            {ASSET_LABELS[t]}
          </button>
        ))}
      </div>
      <section className="panel">
        <div className="filter-bar">
          <label className="search-field">
            <Search size={17} />
            <input
              aria-label="搜索名称或代码"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索名称、代码或市场"
            />
          </label>
          <div className="filter-options">
            <select
              aria-label="筛选账户"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="all">全部账户</option>
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.archived ? "（已归档）" : ""}
                </option>
              ))}
            </select>
            <label className="sort-select">
              <ArrowUpDown size={14} />
              <select
                aria-label="资产排序"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="value">按价值排序</option>
                <option value="name">按名称排序</option>
              </select>
            </label>
          </div>
        </div>
        {filtered.length ? (
          <HoldingList items={filtered} />
        ) : (
          <Empty title={query ? "没有找到匹配的资产" : "这里还没有持仓"}>
            试试调整筛选条件，或录入一份新资产。
          </Empty>
        )}
        <div className="table-footer">
          <label>
            <input
              type="checkbox"
              checked={closed}
              onChange={(e) => setClosed(e.target.checked)}
            />{" "}
            显示已清仓资产
          </label>
          <span>共 {filtered.length} 项</span>
          {!demo && (
            <a href="/api/export?kind=holdings">
              <Download size={14} />
              导出持仓
            </a>
          )}
        </div>
      </section>
    </>
  );
}
