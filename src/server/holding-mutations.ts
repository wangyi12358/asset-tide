import { z } from "zod";
import { getDb, now, uid, transaction } from "./db";
import { decimal, positive, DomainError, assertTimeline } from "./ledger";
import {
  D,
  holdings,
  profile,
  rebuildSnapshots,
  toCny,
  wallets,
} from "./valuation";
import type { LedgerEvent } from "@/lib/types";

export const holdingChangeSchema = z.object({
  quantity: decimal,
  expectedQuantity: decimal,
  reason: z.string().trim().min(2, "请填写调整原因").max(500),
  price: decimal.optional(),
  fx: positive.optional(),
});
export async function changeHolding(
  userId: string,
  holdingId: string,
  raw: z.infer<typeof holdingChangeSchema>,
  key: string,
  action: "quantity" | "delete" = "quantity",
) {
  const input = holdingChangeSchema.parse(raw);
  if (action === "delete" && !D(input.quantity).isZero())
    throw new DomainError("删除持仓的目标数量必须为 0");
  const fingerprint = JSON.stringify({ holdingId, action, ...input });
  return await transaction(async () => {
    const existing = (await getDb().ledgerEvent.findFirst({
      where: { userId: userId, idempotencyKey: key },
    })) as LedgerEvent | undefined;
    if (existing) {
      if (
        JSON.parse(existing.payload).holdingChange?.fingerprint !== fingerprint
      )
        throw new DomainError("同一幂等键不能用于不同请求", 409);
      return {
        changed: true,
        eventId: existing.id,
        quantity: D(input.quantity).toFixed(),
      };
    }
    const at = now();
    const h = (await holdings(userId, at)).find(
      (h) => h.holdingId === holdingId,
    );
    if (!h) throw new DomainError("持仓不存在", 404);
    if ((await wallets(userId)).find((w) => w.id === h.accountId)?.archived)
      throw new DomainError("请先取消账户归档再修改持仓");
    if (!D(h.quantity).eq(input.expectedQuantity))
      throw new DomainError("持仓数量已发生变化，请刷新页面后重新操作", 409);
    const target = D(input.quantity);
    const delta = target.minus(h.quantity);
    if (delta.isZero()) return { changed: false, quantity: target.toFixed() };
    const p = await profile(userId);
    const price = h.type === "cash" ? "1" : (input.price ?? h.price);
    const fx = h.currency === "CNY" ? "1" : (input.fx ?? h.fx);
    if (p.initialized && (price === null || fx === null))
      throw new DomainError(
        "缺少估值依据，请填写参考价格和汇率后再调整，避免将数量变化误算为收益",
      );
    const adjustment = p.initialized
      ? toCny(delta.toFixed(), price!, fx!, h.purity, h.quoteBasis)
      : "0";
    const id = uid();
    const note = `${action === "delete" ? "删除持仓" : "修改当前数量"}：${h.quantity} → ${target.toFixed()} ${h.unit}；${input.reason}`;
    const payload = JSON.stringify({
      type: "adjustment",
      accountId: h.accountId,
      instrumentId: h.id,
      quantity: delta.abs().toFixed(),
      direction: delta.isNegative() ? "decrease" : "increase",
      fee: "0",
      occurredAt: at,
      note,
      ...(price !== null ? { price } : {}),
      ...(fx !== null ? { fx } : {}),
      holdingChange: {
        action,
        before: h.quantity,
        after: target.toFixed(),
        fingerprint,
        priceSource: h.source,
        fxSource: h.fxSource,
      },
    });
    await getDb().ledgerEvent.create({
      data: {
        id: id,
        userId: userId,
        type: "adjustment",
        occurredAt: at,
        createdAt: at,
        note: note,
        externalCny: "0",
        baselineAdjustment: adjustment,
        idempotencyKey: key,
        payload: payload,
      },
    });
    await getDb().leg.create({
      data: {
        id: uid(),
        eventId: id,
        accountId: h.accountId,
        instrumentId: h.id,
        quantity: delta.toFixed(),
      },
    });
    if (input.price !== undefined && h.type !== "cash")
      await getDb().price.create({
        data: {
          id: uid(),
          instrumentId: h.id,
          userId: userId,
          value: input.price,
          asOf: at,
          source: `持仓调整参考价 · ${input.reason}`,
          manual: 1,
          createdAt: at,
          eventId: id,
        },
      });
    if (input.fx && h.currency !== "CNY")
      await getDb().fxRate.create({
        data: {
          id: uid(),
          currency: h.currency,
          userId: userId,
          value: input.fx,
          asOf: at,
          source: `持仓调整汇率 · ${input.reason}`,
          eventId: id,
        },
      });
    await assertTimeline(userId);
    await getDb().audit.create({
      data: {
        id: uid(),
        userId: userId,
        action: `holding.${action}`,
        targetId: holdingId,
        detail: JSON.stringify({
          before: h.quantity,
          after: target.toFixed(),
          reason: input.reason,
          eventId: id,
        }),
        createdAt: at,
      },
    });
    await rebuildSnapshots(userId, at);
    return { changed: true, eventId: id, quantity: target.toFixed() };
  }, userId);
}
