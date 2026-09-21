import { z } from "zod";
import {
  D,
  ensureProfile,
  instruments,
  profile,
  rawHoldings,
  rebuildSnapshots,
  saveSnapshot,
  toCny,
  valuation,
} from "./valuation";
import { getDb, now, uid, transaction } from "./db";
import { fundQuote } from "./funds";
import type { LedgerEvent, Leg, Wallet } from "@/lib/types";
export class DomainError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const decimal = z
  .string()
  .max(40)
  .regex(/^\d{1,18}(\.\d{1,18})?$/, "请输入有效十进制数");
export const positive = decimal.refine((v) => D(v).gt(0), "必须大于 0");
export const eventSchema = z.object({
  type: z.enum([
    "opening",
    "deposit",
    "withdrawal",
    "buy",
    "sell",
    "transfer",
    "exchange",
    "dividend",
    "adjustment",
    "split",
  ]),
  accountId: z.string().min(1),
  instrumentId: z.string().min(1),
  quantity: positive,
  targetAccountId: z.string().optional(),
  targetInstrumentId: z.string().optional(),
  receivedQuantity: positive.optional(),
  purchaseCost: decimal.optional(),
  price: decimal.optional(),
  fx: positive.optional(),
  fee: decimal.default("0"),
  occurredAt: z.iso.datetime(),
  note: z.string().max(1000).default(""),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});
export type EventInput = z.infer<typeof eventSchema>;
export async function assertTimeline(userId: string) {
  const rows = (await getDb().leg.findMany({
    where: { event: { userId: userId, status: "active" } },
    orderBy: [
      { event: { occurredAt: "asc" } },
      { event: { createdAt: "asc" } },
      { event: { id: "asc" } },
      { position: "asc" },
    ],
  })) as Leg[];
  const balances = new Map<string, string>();
  for (const r of rows) {
    const key = `${r.accountId}~${r.instrumentId}`;
    const value = D(balances.get(key) || 0).plus(r.quantity);
    if (value.lt(0))
      throw new DomainError(
        "余额或持仓不足：此操作会使当前或后续历史余额为负，请先补记入金或修正关联流水。",
      );
    balances.set(key, value.toFixed());
  }
}
export async function recordEvent(
  userId: string,
  input: EventInput,
  key: string,
  replacing?: string,
) {
  await ensureProfile(userId);
  return await transaction(async () => {
    const encoded = JSON.stringify({ ...input, replacing });
    const existing = (await getDb().ledgerEvent.findFirst({
      where: { userId: userId, idempotencyKey: key },
    })) as LedgerEvent | undefined;
    if (existing) {
      if (existing.payload !== encoded)
        throw new DomainError("同一幂等键不能用于不同请求", 409);
      return existing;
    }
    const p = await profile(userId);
    const at = input.occurredAt;
    if (at > now()) throw new DomainError("流水时间不能晚于当前时间");
    if (p.baselineAt && at < p.baselineAt)
      throw new DomainError("不能补记早于起始基线的流水");
    if (p.initialized && input.type === "opening")
      throw new DomainError("初始化已完成，请使用外部转入或持仓修正");
    if (!p.initialized && input.type !== "opening")
      throw new DomainError("请先完成期初资产录入并建立基线");
    const asset = (await instruments(userId)).find(
      (i) => i.id === input.instrumentId,
    );
    if (!asset) throw new DomainError("标的不存在", 404);
    const getWallet = async (id?: string) => {
      const w = (await getDb().wallet.findFirst({
        where: { id: id || "", userId: userId, archived: 0 },
      })) as Wallet | undefined;
      if (!w) throw new DomainError("账户不存在或已归档", 404);
      return w;
    };
    await getWallet(input.accountId);
    let automaticFundQuote: Awaited<ReturnType<typeof fundQuote>> | undefined;
    if (
      input.price === undefined &&
      asset.type === "fund" &&
      asset.currency === "CNY" &&
      asset.providerId &&
      ["deposit", "withdrawal", "adjustment"].includes(input.type)
    ) {
      // A newly fetched NAV can value a current movement, never a historical one.
      if (replacing || Date.now() - Date.parse(at) > 5 * 60_000)
        throw new DomainError(
          "历史基金流水请填写发生时净值，不能使用当前净值回填",
        );
      try {
        automaticFundQuote = await fundQuote(asset.providerId);
      } catch (error) {
        throw new DomainError(
          `未能自动获取基金净值：${error instanceof Error ? error.message : "服务暂不可用"}。请重试或填写手动参考价`,
        );
      }
    }
    if (replacing) {
      const old = (await getDb().ledgerEvent.findFirst({
        where: { id: replacing, userId: userId, status: "active" },
      })) as LedgerEvent | undefined;
      if (!old) throw new DomainError("流水不存在", 404);
      if (old.type === "opening")
        throw new DomainError("期初流水不能直接修正，请新增持仓修正");
      await getDb().ledgerEvent.update({
        where: { id: replacing },
        data: { status: "replaced" },
      });
      await getDb().audit.create({
        data: {
          id: uid(),
          userId: userId,
          action: "event.replace",
          targetId: replacing,
          detail: JSON.stringify(old),
          createdAt: now(),
        },
      });
    }
    const legList: Leg[] = [];
    let external = "0";
    let adjustment = "0";
    const add = (accountId: string, instrumentId: string, q: string) =>
      legList.push({ accountId, instrumentId, quantity: q });
    const q = input.quantity;
    const fee = D(input.fee);
    const cashId = `cash-${asset.currency.toLowerCase()}`;
    const requiredValue = () => {
      const price =
        asset.type === "cash"
          ? "1"
          : (input.price ?? automaticFundQuote?.value);
      const fx = asset.currency === "CNY" ? "1" : input.fx;
      const needsNote = !automaticFundQuote || input.type === "adjustment";
      if (price === undefined || !fx || (needsNote && !input.note.trim()))
        throw new DomainError(
          "外部流入/修正需要发生时价格、汇率和估值依据备注",
        );
      return toCny(q, price, fx, asset.purity, asset.quoteBasis);
    };
    switch (input.type) {
      case "opening":
        add(input.accountId, asset.id, q);
        break;
      case "deposit":
        external = requiredValue();
        add(input.accountId, asset.id, q);
        break;
      case "withdrawal":
        external = D(requiredValue()).negated().toFixed();
        add(input.accountId, asset.id, D(q).negated().toFixed());
        break;
      case "buy":
      case "sell": {
        if (asset.type === "cash") throw new DomainError("现金兑换请使用换汇");
        if (!input.price || D(input.price).lte(0))
          throw new DomainError("请填写实际成交单价");
        const cashAccount = input.targetAccountId || input.accountId;
        await getWallet(cashAccount);
        const amount = D(
          toCny(q, input.price, "1", asset.purity, asset.quoteBasis),
        );
        add(
          input.accountId,
          asset.id,
          input.type === "buy" ? q : D(q).negated().toFixed(),
        );
        add(
          cashAccount,
          cashId,
          input.type === "buy"
            ? amount.plus(fee).negated().toFixed()
            : amount.minus(fee).toFixed(),
        );
        break;
      }
      case "transfer": {
        const target = await getWallet(input.targetAccountId);
        if (target.id === input.accountId)
          throw new DomainError("转出和转入账户必须不同");
        add(input.accountId, asset.id, D(q).negated().toFixed());
        add(target.id, asset.id, q);
        break;
      }
      case "exchange": {
        const target = (await instruments(userId)).find(
          (i) => i.id === input.targetInstrumentId,
        );
        if (
          asset.type !== "cash" ||
          target?.type !== "cash" ||
          target.id === asset.id ||
          !input.receivedQuantity
        )
          throw new DomainError("请选择两种不同现金币种并填写实际收到数量");
        const targetAccount = await getWallet(
          input.targetAccountId || input.accountId,
        );
        add(input.accountId, asset.id, D(q).negated().toFixed());
        add(targetAccount.id, target.id, input.receivedQuantity);
        break;
      }
      case "dividend":
        if (asset.type !== "cash")
          throw new DomainError("分红/利息必须记入现金标的");
        add(input.accountId, asset.id, q);
        break;
      case "adjustment":
        adjustment = D(requiredValue())
          .mul(input.direction === "decrease" ? -1 : 1)
          .toFixed();
        add(
          input.accountId,
          asset.id,
          D(q)
            .mul(input.direction === "decrease" ? -1 : 1)
            .toFixed(),
        );
        break;
      case "split": {
        if (
          !["stock", "fund"].includes(asset.type) ||
          !input.note.trim() ||
          input.price === undefined
        )
          throw new DomainError(
            "份额变更仅适用于股票/基金，须填写原因与变更后报价",
          );
        if (
          !(await rawHoldings(userId, at)).some(
            (h) =>
              h.accountId === input.accountId &&
              h.instrumentId === asset.id &&
              D(h.quantity).gt(0),
          )
        )
          throw new DomainError("没有可变更的原持仓");
        add(
          input.accountId,
          asset.id,
          D(q)
            .mul(input.direction === "decrease" ? -1 : 1)
            .toFixed(),
        );
        break;
      }
    }
    if (!fee.isZero() && !["buy", "sell"].includes(input.type))
      add(input.accountId, cashId, fee.negated().toFixed());
    const id = uid();
    await getDb().ledgerEvent.create({
      data: {
        id: id,
        userId: userId,
        type: input.type,
        occurredAt: at,
        createdAt: now(),
        note: automaticFundQuote
          ? [
              input.note,
              `估值依据：${automaticFundQuote.source}，${automaticFundQuote.value} CNY/份`,
            ]
              .filter(Boolean)
              .join("；")
          : input.note,
        externalCny: external,
        baselineAdjustment: adjustment,
        idempotencyKey: key,
        payload: encoded,
      },
    });
    for (const [position, leg] of legList.entries())
      await getDb().leg.create({
        data: {
          id: uid(),
          eventId: id,
          accountId: leg.accountId,
          instrumentId: leg.instrumentId,
          quantity: leg.quantity,
          position,
        },
      });
    await assertTimeline(userId);
    if (automaticFundQuote)
      await getDb().price.create({
        data: {
          id: uid(),
          instrumentId: asset.id,
          userId: asset.ownerId,
          value: automaticFundQuote.value,
          asOf: automaticFundQuote.asOf,
          source: automaticFundQuote.source,
          manual: 0,
          createdAt: now(),
        },
      });
    if (input.price !== undefined && asset.type !== "cash")
      await getDb().price.create({
        data: {
          id: uid(),
          instrumentId: asset.id,
          userId: userId,
          value: input.price,
          asOf: at,
          source: `手动参考 · ${input.note || "录入时提供"}`,
          manual: 1,
          createdAt: now(),
          eventId: id,
        },
      });
    if (input.fx && asset.currency !== "CNY")
      await getDb().fxRate.create({
        data: {
          id: uid(),
          currency: asset.currency,
          userId: userId,
          value: input.fx,
          asOf: at,
          source: `手动汇率 · ${input.note || "录入时提供"}`,
          eventId: id,
        },
      });
    await rebuildSnapshots(userId, replacing ? p.baselineAt || at : at);
    return (await getDb().ledgerEvent.findFirst({
      where: { id: id },
    })) as LedgerEvent;
  }, userId);
}
export async function finalize(userId: string) {
  return await transaction(async () => {
    const p = await profile(userId);
    if (p.initialized) return p;
    const v = await valuation(userId);
    if (!v.items.length || !v.complete)
      throw new DomainError(
        "请至少录入一项资产，并补齐全部价格和汇率后再建立基线",
      );
    const at = now();
    await getDb().profile.update({
      where: { userId: userId },
      data: { initialized: 1, baseline: v.total, baselineAt: at },
    });
    await saveSnapshot(userId, at);
    return await profile(userId);
  }, userId);
}
export async function voidEvent(userId: string, id: string, reason: string) {
  return await transaction(async () => {
    const event = (await getDb().ledgerEvent.findFirst({
      where: { id: id, userId: userId },
    })) as LedgerEvent | undefined;
    if (!event) throw new DomainError("流水不存在", 404);
    if (event.status !== "active") return;
    if (event.type === "opening" && (await profile(userId)).initialized)
      throw new DomainError("期初基线已建立，请通过持仓修正调整");
    await getDb().ledgerEvent.update({
      where: { id: id },
      data: { status: "void" },
    });
    await assertTimeline(userId);
    await getDb().audit.create({
      data: {
        id: uid(),
        userId: userId,
        action: "event.void",
        targetId: id,
        detail: JSON.stringify({ reason, event }),
        createdAt: now(),
      },
    });
    await rebuildSnapshots(userId, event.occurredAt);
  }, userId);
}
