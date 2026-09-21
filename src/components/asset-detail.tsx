"use client";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { ArrowLeft, Plus, ArrowUpRight } from "lucide-react";
import {
  Line,
  LineChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "@/lib/api-client";
import { dateTime, quantity, money } from "@/lib/format";
import type { Holding, LedgerEvent } from "@/lib/types";
import { useWorkspace } from "./workspace";
import {
  Action,
  AssetIcon,
  Empty,
  Field,
  Notice,
  PageTitle,
  Skeleton,
} from "./ui";
import { QuoteStatus } from "./holdings";
import { TransactionList } from "./transactions";
import { HoldingActions } from "./holding-actions";
interface Detail {
  holding: Holding;
  prices: { value: string; asOf: string; source: string }[];
  history: { value: string | null; asOf: string }[];
  transactions: LedgerEvent[];
}
export function AssetDetail({ id }: { id: string }) {
  const {
    data: portfolio,
    demo,
    href,
    amount,
    hidden,
    reload,
  } = useWorkspace();
  const {
    data: result,
    error,
    mutate,
  } = useSWR<Detail>(demo ? null : `/assets/${encodeURIComponent(id)}`, api);
  const h = demo
    ? portfolio.holdings.find((h) => h.holdingId === id)
    : result?.holding;
  const [price, setPrice] = useState("");
  const [fx, setFx] = useState("");
  const [source, setSource] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("value");
  async function update(automatic = false) {
    if (!h) return;
    setBusy(true);
    try {
      await api("/quotes", {
        instrumentId: h.id,
        ...(price ? { value: price } : {}),
        ...(fx ? { fx } : {}),
        source: automatic ? "用户主动切回自动报价" : source,
        asOf: new Date().toISOString(),
        automatic,
      });
      await Promise.all([mutate(), reload()]);
      setMessage(
        automatic
          ? "已结束手动价格覆盖，将采用可用自动价；无自动报价时显示待补全。"
          : "参考报价已保存。",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (error) return <Notice tone="error">{error.message}</Notice>;
  if (!h)
    return demo ? (
      <Empty title="没有找到这项资产">
        <Link href="/demo/assets">返回资产列表</Link>
      </Empty>
    ) : (
      <Skeleton />
    );
  const points =
    (mode === "price" ? result?.prices : result?.history)?.map((p) => ({
      date: p.asOf,
      value: p.value === null ? null : Number(p.value),
    })) || [];
  return (
    <>
      <Link href={href("/assets")} className="back-link">
        <ArrowLeft size={15} />
        返回我的资产
      </Link>
      <PageTitle
        eyebrow={`${h.market} · ${h.symbol}`}
        title={h.name}
        description={`${h.accountName} · ${h.currency} 报价 · ${h.unit}为数量单位`}
        action={
          <Link
            href={
              demo
                ? "/register"
                : `/transactions/new?instrument=${h.id}&account=${h.accountId}`
            }
            className="action"
          >
            <Plus size={16} />
            记录变动
          </Link>
        }
      />
      <div className="detail-stats">
        <section className="panel">
          <div className="flex items-center gap-3">
            <AssetIcon
              type={h.type}
              symbol={h.symbol}
              id={h.id}
              iconUrl={h.iconUrl}
            />
            <span>人民币参考价值</span>
            <QuoteStatus item={h} />
          </div>
          <strong>¥ {amount(h.value)}</strong>
          <p>
            {h.type === "gold"
              ? "参考金属价值，不含回收折价或首饰工费"
              : "根据持有数量、价格及原币兑人民币汇率计算"}
          </p>
        </section>
        <section className="panel">
          <span>持有数量</span>
          <strong>
            {hidden ? "••••" : quantity(h.quantity)} <small>{h.unit}</small>
          </strong>
          <p>
            原币价值 {amount(h.originalValue)} {h.currency}
          </p>
        </section>
      </div>
      {!demo && <HoldingActions holding={h} onUpdated={() => mutate()} />}
      <div className="detail-grid">
        <section className="panel">
          <div className="panel-heading">
            <h2>估值依据</h2>
            <QuoteStatus item={h} />
          </div>
          <dl className="detail-list">
            <div>
              <dt>参考价格</dt>
              <dd>
                {amount(h.price)} {h.currency} /{" "}
                {h.quoteBasis === "oz" ? "金衡盎司" : h.unit}
              </dd>
            </div>
            <div>
              <dt>价格来源</dt>
              <dd>{h.source}</dd>
            </div>
            <div>
              <dt>报价时间</dt>
              <dd>{h.priceAsOf ? dateTime(h.priceAsOf) : "待补全"}</dd>
            </div>
            <div>
              <dt>人民币汇率</dt>
              <dd>
                1 {h.currency} = {h.fx || "—"} CNY
              </dd>
            </div>
            <div>
              <dt>汇率来源</dt>
              <dd>{h.fxSource}</dd>
            </div>
            <div>
              <dt>汇率时间</dt>
              <dd>{h.fxAsOf ? dateTime(h.fxAsOf) : "待补全"}</dd>
            </div>
            {h.type === "gold" && (
              <div>
                <dt>含金纯度</dt>
                <dd>{Number(h.purity) * 100}%</dd>
              </div>
            )}
          </dl>
          {h.automaticAvailable && h.status === "manual" && (
            <Notice>
              自动报价已可用，当前仍保留你的手动参考价。可主动切回自动模式。
            </Notice>
          )}
        </section>
        <section className="panel quote-form">
          <h2>调整报价方式</h2>
          <p>手动报价仅对你生效，不会覆盖其他用户。</p>
          {demo ? (
            <Empty title="演示报价">
              <Link className="text-link" href="/register">
                创建你的资产空间 <ArrowUpRight size={14} />
              </Link>
            </Empty>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void update();
              }}
            >
              {h.type !== "cash" && (
                <Field
                  label={`当前参考价格（${h.currency}）`}
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  inputMode="decimal"
                  placeholder={h.price || "0.00"}
                />
              )}
              {h.currency !== "CNY" && (
                <Field
                  label={`汇率（1 ${h.currency} = ? CNY）`}
                  value={fx}
                  onChange={(e) => setFx(e.target.value)}
                  inputMode="decimal"
                  placeholder={h.fx || ""}
                />
              )}
              <Field
                label="报价依据 / 来源"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                required
                placeholder="例如：银行回单、交易所报价"
              />
              {message && <Notice>{message}</Notice>}
              <div className="page-actions">
                <Action type="submit" isDisabled={busy}>
                  保存参考价
                </Action>
                {h.type !== "cash" && (
                  <Action
                    type="button"
                    secondary
                    onPress={() => update(true)}
                    isDisabled={busy}
                  >
                    切回自动报价
                  </Action>
                )}
              </div>
            </form>
          )}
        </section>
      </div>
      <section className="panel detail-history">
        <div className="panel-heading">
          <h2>
            {mode === "price"
              ? `标的价格走势（${h.currency}）`
              : "我的持仓价值（CNY）"}
          </h2>
          <div className="segmented">
            <button
              className={mode === "value" ? "selected" : ""}
              onClick={() => setMode("value")}
            >
              持仓价值
            </button>
            <button
              className={mode === "price" ? "selected" : ""}
              onClick={() => setMode("price")}
            >
              标的价格
            </button>
          </div>
        </div>
        {!hidden && points.length ? (
          <div className="chart-container">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points}>
                <CartesianGrid vertical={false} stroke="#e2e7f0" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v) => dateTime(v).split(" ")[0]}
                />
                <YAxis domain={["auto", "auto"]} width={70} />
                <Tooltip
                  labelFormatter={(v) => dateTime(String(v))}
                  formatter={(v) => money(Number(v))}
                />
                <Line
                  dataKey="value"
                  stroke="#5381d0"
                  connectNulls={false}
                  dot={points.length < 3}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <Empty title={hidden ? "金额已隐藏" : "历史数据积累中"}>
            持仓历史按当时实际数量记录，不用今天的数量倒推过去。
          </Empty>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>相关流水</h2>
        </div>
        <TransactionList
          items={
            demo
              ? portfolio.transactions.filter((e) =>
                  e.legs?.some((l) => l.instrumentId === h.id),
                )
              : result?.transactions || []
          }
        />
      </section>
    </>
  );
}
