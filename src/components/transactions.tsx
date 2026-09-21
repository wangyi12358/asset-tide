"use client";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  Plus,
  Download,
  Undo2,
  Pencil,
} from "lucide-react";
import { EVENT_LABELS, type EventType, type LedgerEvent } from "@/lib/types";
import { api } from "@/lib/api-client";
import { dateTime, quantity } from "@/lib/format";
import { useWorkspace } from "./workspace";
import { Action, Empty, Field, Notice, PageTitle, Skeleton } from "./ui";
export function TransactionList({
  items,
  compact = false,
  onVoid,
}: {
  items: LedgerEvent[];
  compact?: boolean;
  onVoid?: (e: LedgerEvent) => void;
}) {
  const { data, amount, hidden, demo } = useWorkspace();
  if (!items.length)
    return (
      <Empty title="还没有流水记录">
        录入资产后，每一次变动都会记录在这里。
      </Empty>
    );
  return (
    <div className={`transaction-list ${compact ? "compact" : ""}`}>
      {items.map((e) => {
        const leg = e.legs?.[0];
        const item = data.holdings.find((h) => h.id === leg?.instrumentId);
        const increase = Number(leg?.quantity) > 0;
        return (
          <div
            key={e.id}
            className={`transaction-row ${e.status !== "active" ? "voided" : ""}`}
          >
            <span className={`transaction-icon ${increase ? "in" : "out"}`}>
              {["transfer", "exchange"].includes(e.type) ? (
                <ArrowLeftRight size={17} />
              ) : increase ? (
                <ArrowDownLeft size={17} />
              ) : (
                <ArrowUpRight size={17} />
              )}
            </span>
            <div className="transaction-info">
              <b>
                {EVENT_LABELS[e.type]}
                {!compact && item ? ` · ${item.name}` : ""}
                {e.status !== "active" && (
                  <span className="subtle-tag">
                    {e.status === "void" ? "已撤销" : "已修正"}
                  </span>
                )}
              </b>
              <small>
                {compact
                  ? e.note || item?.name || "资产变动"
                  : `${dateTime(e.occurredAt)} · ${e.note || "无备注"}`}
              </small>
              {!compact && (
                <small>
                  {e.legs
                    ?.map(
                      (l) =>
                        `${data.accounts.find((a) => a.id === l.accountId)?.name || "账户"} ${data.holdings.find((h) => h.id === l.instrumentId)?.symbol || l.instrumentId} ${hidden ? "••••" : `${Number(l.quantity) > 0 ? "+" : ""}${quantity(l.quantity)}`}`,
                    )
                    .join(" / ")}
                </small>
              )}
            </div>
            <div className="transaction-amount">
              <b>
                {e.externalCny !== "0"
                  ? amount(e.externalCny, true)
                  : hidden
                    ? "••••"
                    : leg
                      ? `${increase ? "+" : ""}${quantity(leg.quantity)}`
                      : "—"}
              </b>
              <small>
                {compact
                  ? dateTime(e.occurredAt).split(" ")[0]
                  : e.externalCny !== "0"
                    ? "CNY 外部净流入"
                    : item?.unit || "数量"}
              </small>
            </div>
            {!compact &&
              !demo &&
              e.status === "active" &&
              e.type !== "opening" && (
                <div className="row-actions">
                  {!!data.initialized && (
                    <Link
                      className="icon-button"
                      href={`/transactions/new?edit=${e.id}`}
                      aria-label="修正流水"
                    >
                      <Pencil size={15} />
                    </Link>
                  )}
                  {onVoid && (
                    <button
                      className="icon-button"
                      onClick={() => onVoid?.(e)}
                      aria-label="撤销流水"
                    >
                      <Undo2 size={15} />
                    </button>
                  )}
                </div>
              )}
          </div>
        );
      })}
    </div>
  );
}
export function TransactionsPage() {
  const { data, demo, reload } = useWorkspace();
  const [page, setPage] = useState(1);
  const [type, setType] = useState("");
  const [target, setTarget] = useState<LedgerEvent | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const {
    data: result,
    error: fetchError,
    mutate,
  } = useSWR<{ items: LedgerEvent[]; total: number }>(
    demo ? null : `/transactions?page=${page}&type=${type}`,
    api,
  );
  const items = demo
    ? data.transactions.filter((e) => !type || e.type === type)
    : result?.items;
  async function revoke() {
    if (!target) return;
    setBusy(true);
    try {
      await api(`/transactions/${target.id}/void`, { reason });
      setTarget(null);
      setReason("");
      await Promise.all([mutate(), reload()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="EVERY MOVE, A CLEAR RECORD"
        title="资金流水"
        description="记录资金的来去，分清投入与收益。"
        action={
          <Link
            className="action"
            href={demo ? "/register" : "/transactions/new"}
          >
            <Plus size={17} />
            记录变动
          </Link>
        }
      />
      {fetchError && <Notice tone="error">{fetchError.message}</Notice>}
      {target && (
        <section className="panel confirm-panel">
          <h2>撤销这笔{EVENT_LABELS[target.type]}？</h2>
          <p>
            将撤回资产与现金变动，并重算 {dateTime(target.occurredAt)}{" "}
            起的快照。原流水和撤销原因会保留供审计。
          </p>
          <Field
            label="撤销原因"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
          />
          {error && <Notice tone="error">{error}</Notice>}
          <div className="page-actions">
            <Action secondary onPress={() => setTarget(null)}>
              保留流水
            </Action>
            <Action
              onPress={revoke}
              isDisabled={busy || reason.trim().length < 3}
            >
              {busy ? "重算中…" : "确认撤销并重算"}
            </Action>
          </div>
        </section>
      )}
      <section className="panel">
        <div className="filter-bar">
          <h2>
            流水记录{" "}
            <span className="count-badge">
              {demo ? items?.length : result?.total || 0}
            </span>
          </h2>
          <div className="filter-options">
            <select
              aria-label="流水类型"
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部类型</option>
              {(Object.keys(EVENT_LABELS) as EventType[]).map((t) => (
                <option key={t} value={t}>
                  {EVENT_LABELS[t]}
                </option>
              ))}
            </select>
            {!demo && (
              <a
                href="/api/export?kind=transactions"
                className="icon-button"
                aria-label="导出流水"
              >
                <Download size={17} />
              </a>
            )}
          </div>
        </div>
        {items ? (
          <TransactionList
            items={items}
            onVoid={(e) => {
              setTarget(e);
              setError("");
            }}
          />
        ) : (
          <Skeleton />
        )}
        <div className="table-footer">
          <span>完整事件保存 · 关联现金同步变动</span>
          {!demo && (
            <div className="pagination">
              <button
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
              >
                上一页
              </button>
              <span>{page}</span>
              <button
                disabled={page * 25 >= (result?.total || 0)}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
