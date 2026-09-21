import Decimal from "decimal.js";
import { getDb, now, uid, transaction } from "./db";
import type {
  Holding,
  Instrument,
  Leg,
  Price,
  Snapshot,
  Wallet,
} from "@/lib/types";
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export const D = (value: Decimal.Value) => new Decimal(value);
export function toCny(
  quantity: string,
  price: string,
  fx: string,
  purity = "1",
  basis = "unit",
) {
  return D(quantity)
    .mul(price)
    .mul(fx)
    .mul(purity)
    .div(basis === "oz" ? "31.1034768" : 1)
    .toFixed();
}
export function investmentPnl(
  total: string,
  baseline: string,
  netFlow: string,
  adjustments = "0",
) {
  return D(total).minus(baseline).minus(netFlow).minus(adjustments).toFixed();
}
export async function ensureProfile(userId: string) {
  await transaction(async () => {
    if (!(await getDb().profile.findFirst({ where: { userId: userId } }))) {
      await getDb().profile.create({ data: { userId: userId } });
      await getDb().wallet.create({
        data: { id: uid(), userId: userId, name: "默认账户", type: "综合账户" },
      });
    }
  }, userId);
}
export interface Profile {
  userId: string;
  baseline: string | null;
  baselineAt: string | null;
  initialized: number;
  lastRefresh: string | null;
}
export async function profile(userId: string) {
  await ensureProfile(userId);
  return (await getDb().profile.findFirst({
    where: { userId: userId },
  })) as Profile;
}
export async function instruments(userId: string) {
  return (await getDb().instrument.findMany({
    where: { OR: [{ ownerId: null }, { ownerId: userId }] },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  })) as Instrument[];
}
export async function wallets(userId: string) {
  await ensureProfile(userId);
  return (await getDb().wallet.findMany({
    where: { userId: userId },
    orderBy: [{ archived: "asc" }, { name: "asc" }],
  })) as Wallet[];
}
export async function rawHoldings(userId: string, at = now()) {
  const rows = (await getDb().leg.findMany({
    where: {
      event: { userId: userId, status: "active", occurredAt: { lte: at } },
    },
    orderBy: [
      { event: { occurredAt: "asc" } },
      { event: { createdAt: "asc" } },
      { event: { id: "asc" } },
      { position: "asc" },
    ],
  })) as Leg[];
  const map = new Map<string, Leg>();
  for (const r of rows) {
    const key = `${r.accountId}~${r.instrumentId}`;
    const prev = map.get(key);
    map.set(key, {
      ...r,
      quantity: D(prev?.quantity || 0)
        .plus(r.quantity)
        .toFixed(),
    });
  }
  return [...map.values()];
}
export async function quote(
  userId: string,
  instrument: Instrument,
  at: string,
): Promise<{
  price: string | null;
  source: string;
  asOf: string | null;
  manual: boolean;
  automaticAvailable: boolean;
}> {
  if (instrument.type === "cash")
    return {
      price: "1",
      source: "货币面值",
      asOf: at,
      manual: false,
      automaticAvailable: false,
    };
  const manual = (await getDb().price.findFirst({
    where: {
      instrumentId: instrument.id,
      userId: userId,
      manual: 1,
      asOf: { lte: at },
      AND: [
        { OR: [{ endedAt: null }, { endedAt: { gt: at } }] },
        { OR: [{ eventId: null }, { event: { status: "active" } }] },
      ],
    },
    orderBy: [{ asOf: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  })) as Price | undefined;
  const automatic = (await getDb().price.findFirst({
    where: {
      instrumentId: instrument.id,
      userId: null,
      manual: 0,
      asOf: { lte: at },
    },
    orderBy: [{ asOf: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  })) as Price | undefined;
  const p = manual || automatic;
  return {
    price: p?.value ?? null,
    source: p?.source ?? "暂无报价",
    asOf: p?.asOf ?? null,
    manual: !!manual,
    automaticAvailable: !!automatic,
  };
}
export async function fxRate(userId: string, currency: string, at: string) {
  if (currency === "CNY") return { value: "1", asOf: at, source: "人民币基准" };
  return (await getDb().fxRate.findFirst({
    where: {
      currency: currency,
      asOf: { lte: at },
      AND: [
        { OR: [{ userId: null }, { userId: userId }] },
        { OR: [{ eventId: null }, { event: { status: "active" } }] },
      ],
    },
    orderBy: [{ asOf: "desc" }, { sequence: "desc" }],
    select: { value: true, asOf: true, source: true },
  })) as { value: string; asOf: string; source: string } | undefined;
}
export async function holdings(userId: string, at = now()): Promise<Holding[]> {
  const [available, walletList, raw] = await Promise.all([
    instruments(userId),
    wallets(userId),
    rawHoldings(userId, at),
  ]);
  const catalog = new Map(available.map((i) => [i.id, i]));
  const accounts = new Map(walletList.map((i) => [i.id, i]));
  const ids = [
    ...new Set(
      raw
        .map((h) => h.instrumentId)
        .filter((id) => catalog.get(id)?.type !== "cash"),
    ),
  ];
  const currencies = [
    ...new Set(raw.map((h) => catalog.get(h.instrumentId)!.currency)),
  ];
  // Fetch latest prices through bounded relations, avoiding one database round trip per holding.
  const [manualRows, automaticRows, rates] = await Promise.all([
    getDb().instrument.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        prices: {
          where: {
            userId,
            manual: 1,
            asOf: { lte: at },
            AND: [
              { OR: [{ endedAt: null }, { endedAt: { gt: at } }] },
              { OR: [{ eventId: null }, { event: { status: "active" } }] },
            ],
          },
          orderBy: [{ asOf: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          take: 1,
        },
      },
    }),
    getDb().instrument.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        prices: {
          where: { userId: null, manual: 0, asOf: { lte: at } },
          orderBy: [{ asOf: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          take: 1,
        },
      },
    }),
    Promise.all(
      currencies.map(
        async (currency) =>
          [currency, await fxRate(userId, currency, at)] as const,
      ),
    ),
  ]);
  const manual = new Map(manualRows.map((i) => [i.id, i.prices[0]]));
  const automatic = new Map(automaticRows.map((i) => [i.id, i.prices[0]]));
  const rateMap = new Map(rates);
  return raw.map((h) => {
    const i = catalog.get(h.instrumentId)!;
    const price = manual.get(i.id) || automatic.get(i.id);
    const p =
      i.type === "cash"
        ? {
            price: "1",
            source: "货币面值",
            asOf: at,
            manual: false,
            automaticAvailable: false,
          }
        : {
            price: price?.value ?? null,
            source: price?.source ?? "暂无报价",
            asOf: price?.asOf ?? null,
            manual: !!manual.get(i.id),
            automaticAvailable: !!automatic.get(i.id),
          };
    const fx = rateMap.get(i.currency);
    const age = p.asOf
      ? new Date(at).getTime() - new Date(p.asOf).getTime()
      : Infinity;
    const stale =
      (i.type !== "cash" &&
        age > (i.type === "crypto" ? 3600_000 : 4 * 86400_000)) ||
      (fx &&
        i.currency !== "CNY" &&
        new Date(at).getTime() - new Date(fx.asOf).getTime() > 5 * 86400_000);
    return {
      ...i,
      holdingId: `${h.accountId}~${i.id}`,
      accountId: h.accountId,
      accountName: accounts.get(h.accountId)?.name || "未知账户",
      quantity: h.quantity,
      originalValue:
        p.price !== null
          ? toCny(h.quantity, p.price, "1", i.purity, i.quoteBasis)
          : null,
      price: p.price,
      fx: fx?.value ?? null,
      value:
        p.price !== null && fx
          ? toCny(h.quantity, p.price, fx.value, i.purity, i.quoteBasis)
          : null,
      priceAsOf: p.asOf,
      fxAsOf: fx?.asOf ?? null,
      source: p.source,
      fxSource: fx?.source || "暂无汇率",
      status:
        !p.price || !fx
          ? "missing"
          : p.manual
            ? "manual"
            : stale
              ? "stale"
              : "current",
      automaticAvailable: p.automaticAvailable,
    };
  });
}
export async function valuation(userId: string, at = now()) {
  const p = await profile(userId);
  const items = (await holdings(userId, at)).filter(
    (h) => !D(h.quantity).isZero(),
  );
  const complete = items.every((h) => h.value !== null);
  const total = items.reduce((a, h) => a.plus(h.value || 0), D(0)).toFixed();
  const flows = (await getDb().ledgerEvent.findMany({
    where: { userId: userId, status: "active", occurredAt: { lte: at } },
    select: { externalCny: true, baselineAdjustment: true },
  })) as { externalCny: string; baselineAdjustment: string }[];
  const netFlow = flows.reduce((a, e) => a.plus(e.externalCny), D(0)).toFixed();
  const adjustment = flows
    .reduce((a, e) => a.plus(e.baselineAdjustment), D(0))
    .toFixed();
  const pnl =
    complete && p.baseline !== null && p.baselineAt && at >= p.baselineAt
      ? investmentPnl(total, p.baseline, netFlow, adjustment)
      : null;
  return { items, total, complete, netFlow, pnl };
}
export async function saveSnapshot(userId: string, at: string) {
  return transaction(async () => {
    const v = await valuation(userId, at);
    const old = (await getDb().snapshot.findFirst({
      where: { userId: userId, asOf: at },
    })) as
      | {
          id: string;
          total: string;
          netFlow: string;
          pnl: string | null;
          complete: number;
          items: string;
        }
      | undefined;
    const encoded = JSON.stringify(v.items);
    if (
      old &&
      old.total === v.total &&
      old.netFlow === v.netFlow &&
      old.pnl === v.pnl &&
      !!old.complete === v.complete &&
      old.items === encoded
    )
      return;
    if (old)
      await getDb().audit.create({
        data: {
          id: uid(),
          userId: userId,
          action: "snapshot.revision",
          targetId: old.id,
          detail: JSON.stringify(old),
          createdAt: now(),
        },
      });
    await getDb().snapshot.upsert({
      where: { userId_asOf: { userId: userId, asOf: at } },
      create: {
        id: uid(),
        userId: userId,
        asOf: at,
        total: v.total,
        netFlow: v.netFlow,
        pnl: v.pnl,
        complete: Number(v.complete),
        items: encoded,
      },
      update: {
        total: v.total,
        netFlow: v.netFlow,
        pnl: v.pnl,
        complete: Number(v.complete),
        items: encoded,
        version: { increment: 1 },
      },
    });
  }, userId);
}
export async function rebuildSnapshots(userId: string, from: string) {
  const p = await profile(userId);
  if (p.baselineAt && from <= p.baselineAt) {
    const initial = await valuation(userId, p.baselineAt);
    await getDb().profile.update({
      where: { userId: userId },
      data: { baseline: initial.complete ? initial.total : null },
    });
  }
  const dates = (await getDb().snapshot.findMany({
    where: { userId: userId, asOf: { gte: from } },
    select: { asOf: true },
    orderBy: { asOf: "asc" },
  })) as { asOf: string }[];
  for (const { asOf } of dates) await saveSnapshot(userId, asOf);
}
export async function history(userId: string): Promise<Snapshot[]> {
  const rows = (await getDb().snapshot.findMany({
    where: { userId: userId },
    orderBy: { asOf: "asc" },
  })) as (Omit<Snapshot, "items" | "complete"> & {
    items: string;
    complete: number;
  })[];
  return rows.map((s) => ({
    ...s,
    complete: !!s.complete,
    items: JSON.parse(s.items),
  }));
}
