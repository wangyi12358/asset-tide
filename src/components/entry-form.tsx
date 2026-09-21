"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { ArrowLeft, Check, Plus, ShieldCheck } from "lucide-react";
import {
  ASSET_LABELS,
  EVENT_LABELS,
  type AssetType,
  type EventType,
  type Instrument,
  type InstrumentSearch,
  type LedgerEvent,
} from "@/lib/types";
import type { EventInput } from "@/server/ledger";
import { api } from "@/lib/api-client";
import { useWorkspace } from "./workspace";
import { Action, Field, Notice, PageTitle, SelectField } from "./ui";
function localTime() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
}
export function EntryForm({ asset = false }: { asset?: boolean }) {
  const { data, demo, reload, notify } = useWorkspace();
  const router = useRouter();
  const params = useSearchParams();
  const edit = params.get("edit");
  const {
    data: instruments,
    mutate,
    error: instrumentsError,
    isLoading: instrumentsLoading,
  } = useSWR<Instrument[]>(demo ? null : "/instruments", api);
  const { data: old } = useSWR<LedgerEvent>(
    !demo && edit ? `/transactions/${edit}` : null,
    api,
  );
  const [type, setType] = useState<EventType>(
    data.initialized ? (asset ? "deposit" : "buy") : "opening",
  );
  const [accountId, setAccountId] = useState(
    params.get("account") || data.accounts.find((a) => !a.archived)?.id || "",
  );
  const [instrumentId, setInstrumentId] = useState(
    params.get("instrument") || "",
  );
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 500);
    return () => clearTimeout(timer);
  }, [search]);
  const canSearchOnline = !["cash", "gold"].includes(filter);
  const searchReady = search.trim() === debouncedSearch && !!debouncedSearch;
  const {
    data: matches,
    error: searchError,
    isLoading: searching,
    mutate: retrySearch,
  } = useSWR<InstrumentSearch>(
    !demo && canSearchOnline && searchReady
      ? `/instruments/search?q=${encodeURIComponent(debouncedSearch)}&type=${filter}`
      : null,
    api,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
      dedupingInterval: 300_000,
    },
  );
  const [targetAccountId, setTargetAccount] = useState("");
  const [targetInstrumentId, setTargetInstrument] = useState("cash-usd");
  const [purchaseCost, setPurchaseCost] = useState("");
  const [q, setQ] = useState("");
  const [price, setPrice] = useState("");
  const [fx, setFx] = useState("");
  const [fee, setFee] = useState("0");
  const [received, setReceived] = useState("");
  const [date, setDate] = useState(localTime);
  const [direction, setDirection] = useState<"increase" | "decrease">(
    "increase",
  );
  const [note, setNote] = useState("");
  const [dateChanged, setDateChanged] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState(false);
  const key = useRef<string | null>(null);
  const previousBody = useRef("");
  const item = instruments?.find((i) => i.id === instrumentId);
  function selectInstrument(id: string) {
    setInstrumentId(id);
    setQ("");
    setPrice("");
    setFx("");
    setPurchaseCost("");
    setFee("0");
  }
  async function chooseInstrument(value: string) {
    setError("");
    if (!value.startsWith("remote:")) {
      selectInstrument(value);
      return;
    }
    selectInstrument("");
    setImporting(true);
    try {
      const chosen = await api<Instrument>("/instruments/import", {
        q: debouncedSearch,
        type: filter,
        key: value.slice(7),
      });
      await mutate(
        (current) => [
          ...(current || []).filter((i) => i.id !== chosen.id),
          chosen,
        ],
        { revalidate: false },
      );
      selectInstrument(chosen.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  }
  useEffect(() => {
    if (!old) return;
    const input = JSON.parse(old.payload) as EventInput;
    setType(input.type);
    setAccountId(input.accountId);
    setInstrumentId(input.instrumentId);
    setQ(input.quantity);
    setPurchaseCost(input.purchaseCost || "");
    setPrice(input.price || "");
    setFx(input.fx || "");
    setFee(input.fee || "0");
    setTargetAccount(input.targetAccountId || "");
    setTargetInstrument(input.targetInstrumentId || "cash-usd");
    setReceived(input.receivedQuantity || "");
    setNote(input.note);
    setDirection(input.direction);
    const d = new Date(input.occurredAt);
    setDate(
      new Date(d.getTime() - d.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 19),
    );
  }, [old]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || demo || importing) return;
    setError("");
    if (!item || (filter !== "all" && item.type !== filter)) {
      setError("请选择当前类别下的具体资产标的");
      return;
    }
    setBusy(true);
    try {
      const body = {
        ...(purchaseCost ? { purchaseCost } : {}),
        type,
        accountId,
        instrumentId,
        quantity: q,
        occurredAt:
          !edit && !dateChanged
            ? new Date().toISOString()
            : new Date(date).toISOString(),
        note,
        fee,
        direction,
        ...(price ? { price } : {}),
        ...(fx ? { fx } : {}),
        ...(targetAccountId ? { targetAccountId } : {}),
        ...(type === "exchange"
          ? { targetInstrumentId, receivedQuantity: received }
          : {}),
      };
      const encoded = JSON.stringify(body);
      if (encoded !== previousBody.current) {
        key.current = crypto.randomUUID();
        previousBody.current = encoded;
      }
      const saved = await api<
        LedgerEvent & { market?: { warnings: string[] } }
      >(
        edit ? `/transactions/${edit}` : "/transactions",
        body,
        edit ? "PUT" : "POST",
        key.current!,
      );
      notify(
        saved.market?.warnings.length
          ? `记录已保存，无需重复添加。${saved.market.warnings.join("；")}`
          : "",
      );
      await reload();
      router.push(asset ? "/assets" : "/transactions");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (demo)
    return (
      <Notice>
        演示空间为只读。
        <Link href="/register" className="text-link">
          创建账户后录入你的真实资产 →
        </Link>
      </Notice>
    );
  const needsValue = ["deposit", "withdrawal", "adjustment"].includes(type);
  const automaticFundValue =
    item?.type === "fund" &&
    item.currency === "CNY" &&
    !!item.providerId &&
    !edit &&
    !dateChanged &&
    needsValue;
  const automaticGoldValue =
    item?.type === "gold" &&
    item.unit === "克" &&
    ["unit", "oz"].includes(item.quoteBasis) &&
    ["CNY", "USD", "HKD"].includes(item.currency) &&
    !edit &&
    !dateChanged &&
    needsValue;
  const automaticValue = automaticFundValue || automaticGoldValue;
  const needPrice =
    item?.type !== "cash" &&
    ((needsValue && !automaticValue) ||
      ["buy", "sell", "split"].includes(type));
  const needNote =
    (needsValue && (!automaticValue || !!price)) ||
    ["split", "adjustment"].includes(type);
  const filtered = instruments?.filter(
    (i) =>
      i.id === instrumentId ||
      ((i.ownerId !== null ||
        i.type === "cash" ||
        i.type === "gold" ||
        data.holdings.some((h) => h.id === i.id)) &&
        (filter === "all" || i.type === filter) &&
        `${i.name} ${i.symbol}`.toLowerCase().includes(search.toLowerCase())),
  );
  return (
    <>
      <Link href={asset ? "/assets" : "/transactions"} className="back-link">
        <ArrowLeft size={15} />
        返回{asset ? "我的资产" : "资金流水"}
      </Link>
      <PageTitle
        eyebrow={
          asset ? "MAKE ROOM FOR YOUR ASSETS" : "KEEP YOUR RECORDS IN SYNC"
        }
        title={edit ? "修正流水" : asset ? "添加资产" : "记录资产变动"}
        description={
          edit
            ? "保留原记录与修正痕迹，并重算受影响的历史快照。"
            : "每一次认真记录，都让资产全貌更清晰。"
        }
      />
      <div className="form-layout">
        <form className="panel entry-form" onSubmit={submit}>
          <div className="form-section-title">
            <span>01</span>
            <h2>选择资产与账户</h2>
          </div>
          <div className="form-grid">
            <SelectField
              label="记录类型"
              value={type}
              onChange={(e) => setType(e.target.value as EventType)}
            >
              {(Object.keys(EVENT_LABELS) as EventType[])
                .filter((t) =>
                  data.initialized ? t !== "opening" : t === "opening",
                )
                .map((t) => (
                  <option key={t} value={t}>
                    {EVENT_LABELS[t]}
                  </option>
                ))}
            </SelectField>
            <SelectField
              label="所属账户"
              required
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {data.accounts
                .filter((a) => !a.archived)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </SelectField>
          </div>
          <div className="form-grid">
            <SelectField
              label="资产类别"
              value={filter}
              disabled={importing}
              onChange={(e) => {
                const next = e.target.value;
                setFilter(next);
                setSearch("");
                setDebouncedSearch("");
                setError("");
                if (item && next !== "all" && item.type !== next)
                  selectInstrument("");
              }}
            >
              <option value="all">全部类别</option>
              {(Object.keys(ASSET_LABELS) as AssetType[]).map((t) => (
                <option key={t} value={t}>
                  {ASSET_LABELS[t]}
                </option>
              ))}
            </SelectField>
            <Field
              label="查找标的"
              placeholder="输入名称或代码，例如 BABA、600519、RAY"
              value={search}
              disabled={importing}
              maxLength={80}
              hint={
                canSearchOnline
                  ? "输入后自动查询；请在下方按市场和币种选择具体标的。"
                  : "现金可直接选择币种；实物黄金按国际现货金价自动估值，也可创建自定义品种。"
              }
              onChange={(e) => {
                const next = e.target.value;
                setSearch(next);
                selectInstrument("");
                setError("");
              }}
            />
          </div>
          <div
            className="instrument-search-status"
            role="status"
            aria-live="polite"
          >
            {importing
              ? "正在选择标的…"
              : canSearchOnline && search.trim() && (!searchReady || searching)
                ? "正在查询在线标的…"
                : canSearchOnline && searchReady && matches
                  ? matches.items.length
                    ? `找到 ${matches.items.length} 个在线结果，请核对市场和报价币种。`
                    : matches.warnings.length
                      ? "暂未取得在线结果，可重试或创建手动报价标的。"
                      : "未找到匹配标的，请尝试准确代码或英文名称，也可创建手动报价标的。"
                  : canSearchOnline
                    ? "输入名称或代码即可搜索，无需预先创建资产。"
                    : null}
          </div>
          {searchReady &&
            canSearchOnline &&
            (searchError || !!matches?.warnings.length) && (
              <Notice>
                {searchError
                  ? (searchError as Error).message
                  : matches?.warnings.join("；")}
                <button
                  type="button"
                  className="text-link"
                  onClick={() => void retrySearch()}
                >
                  {" "}
                  重新查询
                </button>
              </Notice>
            )}
          {instrumentsError && (
            <Notice tone="error">
              资产标的加载失败：{(instrumentsError as Error).message}
              <button
                type="button"
                className="text-link"
                onClick={() => void mutate()}
              >
                重新加载
              </button>
            </Notice>
          )}
          <SelectField
            label="资产标的"
            required
            value={instrumentId}
            disabled={importing || instrumentsLoading || !!instrumentsError}
            onChange={(e) => void chooseInstrument(e.target.value)}
          >
            <option value="" disabled>
              {instrumentsLoading ? "正在加载资产标的…" : "请选择资产"}
            </option>
            {!!filtered?.length && (
              <optgroup label="已选 / 已有资产与手动标的">
                {filtered.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} · {i.symbol} · {i.market} · {i.currency}
                  </option>
                ))}
              </optgroup>
            )}
            {searchReady && canSearchOnline && !!matches?.items.length && (
              <optgroup label="在线搜索结果">
                {matches.items.map((i) => (
                  <option key={i.key} value={`remote:${i.key}`}>
                    {i.name} · {i.symbol} · {i.market} · {i.currency} ·{" "}
                    {ASSET_LABELS[i.type]}
                  </option>
                ))}
              </optgroup>
            )}
          </SelectField>
          <button
            type="button"
            className="text-link custom-link"
            onClick={() => setCustom(!custom)}
          >
            <Plus size={14} />
            没有找到？创建手动报价标的
          </button>
          {custom && (
            <CustomInstrument
              onCreated={async (id) => {
                await mutate();
                selectInstrument(id);
                setFilter("all");
                setSearch("");
                setCustom(false);
              }}
            />
          )}
          <div className="form-section-title">
            <span>02</span>
            <h2>填写变动明细</h2>
          </div>
          <div className="form-grid">
            <Field
              label={
                type === "split"
                  ? "增加 / 减少的份额"
                  : `数量${item ? `（${item.unit}）` : ""}`
              }
              inputMode="decimal"
              required
              placeholder="0.00"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <Field
              label="发生时间（本机时区）"
              type="datetime-local"
              step="1"
              required
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setDateChanged(true);
              }}
            />
          </div>
          {["adjustment", "split"].includes(type) && (
            <SelectField
              label="变更方向"
              value={direction}
              onChange={(e) =>
                setDirection(e.target.value as "increase" | "decrease")
              }
            >
              <option value="increase">增加数量</option>
              <option value="decrease">减少数量</option>
            </SelectField>
          )}
          {item && item.type !== "cash" && (
            <Field
              label={`${["buy", "sell"].includes(type) ? "实际成交单价" : type === "split" ? "变更后参考单价" : "手动参考价"}（${item?.currency || "原币"}/${item?.quoteBasis === "oz" ? "金衡盎司" : item?.unit || "单位"}${needPrice ? "" : "，选填"}）`}
              required={needPrice}
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder={
                automaticFundValue
                  ? "留空，保存时自动获取已公布净值"
                  : automaticGoldValue
                    ? "留空，保存时自动获取参考金价"
                    : needPrice
                      ? "填写发生时价格"
                      : "可留空，保存后刷新报价"
              }
              hint={
                automaticFundValue
                  ? "默认使用天天基金已公布净值，并自动记录估值依据。填写此项会改用手动报价。"
                  : automaticGoldValue
                    ? "默认使用 Gold API 参考金价，并自动记录估值依据。填写此项会改用手动报价。"
                    : "填写后作为私有手动报价生效；可在资产详情主动切回自动行情。"
              }
            />
          )}
          {item && item.currency !== "CNY" && (
            <Field
              label={`发生时汇率（1 ${item?.currency || "原币"} = ? CNY）`}
              inputMode="decimal"
              required={needsValue}
              value={fx}
              onChange={(e) => setFx(e.target.value)}
              placeholder="例如 7.20"
              hint="使用有依据的实际参考汇率，不会把当前汇率倒填到历史。"
            />
          )}
          {["buy", "sell", "transfer", "exchange"].includes(type) && (
            <SelectField
              label={
                ["buy", "sell"].includes(type) ? "结算现金账户" : "转入账户"
              }
              value={targetAccountId}
              onChange={(e) => setTargetAccount(e.target.value)}
              required={type === "transfer"}
            >
              <option value="">
                {type === "transfer" ? "请选择另一个账户" : "使用同一账户"}
              </option>
              {data.accounts
                .filter(
                  (a) =>
                    !a.archived && (type !== "transfer" || a.id !== accountId),
                )
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </SelectField>
          )}
          {type === "exchange" && (
            <div className="form-grid">
              <SelectField
                label="收到的币种"
                value={targetInstrumentId}
                onChange={(e) => setTargetInstrument(e.target.value)}
              >
                {instruments
                  ?.filter((i) => i.type === "cash" && i.id !== instrumentId)
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
              </SelectField>
              <Field
                label="实际收到数量"
                inputMode="decimal"
                required
                value={received}
                onChange={(e) => setReceived(e.target.value)}
              />
            </div>
          )}
          {type === "opening" && (
            <Field
              label={`累计购买成本（${item?.currency || "原币"}，选填）`}
              inputMode="decimal"
              value={purchaseCost}
              onChange={(e) => setPurchaseCost(e.target.value)}
              hint="仅保存成本依据；首版不会据此推算缺少历史记录的收益率。"
            />
          )}
          <Field
            label={`手续费（${item?.currency || "原币"}，从所属账户同币种现金扣除）`}
            inputMode="decimal"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            required
          />
          <label className="field">
            <span>
              {needNote ? "估值依据 / 变更原因（必填）" : "备注 / 价格来源"}
            </span>
            <textarea
              className="field-input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              required={needNote}
              maxLength={1000}
              placeholder="例如：银行结汇回单、券商成交记录、持仓调整原因…"
              rows={3}
            />
          </label>
          {error && <Notice tone="error">{error}</Notice>}
          {item && (
            <Notice>
              本次记录：{ASSET_LABELS[item.type]} · {item.name}（{item.symbol}）
              · {q || "待填写数量"} {item.unit}。报价币种为 {item.currency}，
              资产总览统一折算为人民币展示。
            </Notice>
          )}
          <div className="form-actions">
            <Link href={asset ? "/assets" : "/transactions"}>取消</Link>
            <Action type="submit" isDisabled={busy || importing || !item}>
              {busy ? "正在保存…" : edit ? "确认修正并重算" : "保存记录"}
              <Check size={16} />
            </Action>
          </div>
        </form>
        <aside className="form-guide">
          <ShieldCheck size={28} strokeWidth={1.4} />
          <h3>让记录，忠于实际。</h3>
          <p>AssetAtlas 不会自动读取你的金融账户，持仓数量由你维护。</p>
          <div>
            <b>期初持仓</b>
            <p>先录入所有已持有资产，再到总览完成初始化，建立完整起始基线。</p>
          </div>
          <div>
            <b>投入与收益分开</b>
            <p>
              外部转入和转出计入净流入。买卖同时变更资产与结算现金，手续费计入损益。
            </p>
          </div>
          <div>
            <b>保留真实历史</b>
            <p>
              只能补记基线之后的流水。修正会保留原始记录，并重算受影响快照。
            </p>
          </div>
          {item?.type === "gold" && (
            <Notice>
              纯度 {Number(item.purity) * 100}%，按
              {item.currency}/{item.quoteBasis === "oz" ? "金衡盎司" : "克"}
              折算参考金属价值。自动价采用国际现货黄金，不含金店溢价、回收折价或工费。
            </Notice>
          )}
        </aside>
      </div>
    </>
  );
}
function CustomInstrument({
  onCreated,
}: {
  onCreated: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [type, setType] = useState<AssetType>("stock");
  const [currency, setCurrency] = useState("CNY");
  const [market, setMarket] = useState("");
  const [unit, setUnit] = useState("股");
  const [purity, setPurity] = useState("0.9999");
  const [basis, setBasis] = useState("unit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create() {
    setBusy(true);
    try {
      const r = await api<{ id: string }>("/instruments", {
        name,
        symbol,
        type,
        currency,
        market,
        unit,
        purity: type === "gold" ? purity : "1",
        quoteBasis: type === "gold" ? basis : "unit",
      });
      await onCreated(r.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="custom-instrument">
      <h3>创建私有标的</h3>
      <div className="form-grid">
        <Field
          label="名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          label="代码 / 唯一标识"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
        />
        <SelectField
          label="类别"
          value={type}
          onChange={(e) => {
            const t = e.target.value as AssetType;
            setType(t);
            setUnit(
              t === "gold"
                ? "克"
                : t === "crypto"
                  ? "枚"
                  : t === "fund"
                    ? "份"
                    : "股",
            );
          }}
        >
          {(Object.keys(ASSET_LABELS) as AssetType[])
            .filter((t) => t !== "cash")
            .map((t) => (
              <option value={t} key={t}>
                {ASSET_LABELS[t]}
              </option>
            ))}
        </SelectField>
        <SelectField
          label="报价币种"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
        >
          {["CNY", "USD", "HKD"].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </SelectField>
        <Field
          label="市场 / 品种"
          value={market}
          onChange={(e) => setMarket(e.target.value)}
        />
        <Field
          label="数量单位"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
        />
        {type === "gold" && (
          <>
            <Field
              label="含金纯度（0–1）"
              value={purity}
              onChange={(e) => setPurity(e.target.value)}
            />
            <SelectField
              label="报价基准"
              value={basis}
              onChange={(e) => setBasis(e.target.value)}
            >
              <option value="unit">原币 / 克</option>
              <option value="oz">原币 / 金衡盎司</option>
            </SelectField>
          </>
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <Action type="button" secondary onPress={create} isDisabled={busy}>
        {busy ? "创建中…" : "创建并选择"}
      </Action>
    </div>
  );
}
