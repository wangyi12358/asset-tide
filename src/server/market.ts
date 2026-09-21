import { z } from "zod";
import { getDb, now, uid, transaction } from "./db";
import { D, holdings, rebuildSnapshots, profile } from "./valuation";
import type { Instrument } from "@/lib/types";
import { isHongKongStock, longportQuote, longportStatus } from "./longport";
import { goldQuote } from "./gold";
const inflight = new Map<string, Promise<void>>();
async function json(
  url: string,
  init?: RequestInit,
  acceptProviderError = false,
): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) {
        // Twelve Data uses HTTP 404 for plan restrictions as well as missing symbols.
        // Preserve the structured error so the caller can distinguish those cases.
        if (acceptProviderError && r.status >= 400 && r.status < 500) {
          const body: unknown = await r.json().catch(() => null);
          if (z.object({ status: z.literal("error") }).safeParse(body).success)
            return body;
        }
        if (r.status !== 429 && r.status < 500)
          throw new Error("行情请求不可用");
        throw new Error("行情服务暂不可用");
      }
      return await r.json();
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
    }
  }
}
async function shared(key: string, fn: () => Promise<void>) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
async function storePrice(
  i: Instrument,
  value: string,
  asOf: string,
  source: string,
) {
  if (!D(value).isFinite() || D(value).lt(0) || asOf > now())
    throw new Error("报价不合法");
  if (
    !(await getDb().price.findFirst({
      where: {
        instrumentId: i.id,
        asOf: asOf,
        userId: null,
        value: value,
        source,
      },
    }))
  )
    await getDb().price.create({
      data: {
        id: uid(),
        instrumentId: i.id,
        value: value,
        asOf: asOf,
        source: source,
        createdAt: now(),
      },
    });
}
async function refreshInstrument(i: Instrument) {
  await shared(i.id, async () => {
    const useLongport = isHongKongStock(i) && longportStatus() !== "disabled";
    const last = (await getDb().price.findFirst({
      where: { instrumentId: i.id, userId: null },
      orderBy: { createdAt: "desc" },
    })) as { createdAt: string; source: string } | undefined;
    const sameProvider =
      !!last &&
      (i.type === "gold"
        ? last.source.startsWith("Gold API")
        : useLongport === last.source.startsWith("长桥 LongPort"));
    if (
      last &&
      sameProvider &&
      Date.now() - Date.parse(last.createdAt) <
        (i.type === "gold" ? 60_000 : 15 * 60_000)
    )
      return;
    if (i.type === "gold") {
      const quote = await goldQuote(i);
      await storePrice(i, quote.value, quote.asOf, quote.source);
    } else if (useLongport) {
      const quote = await longportQuote(i);
      await storePrice(i, quote.value, quote.asOf, quote.source);
    } else if (i.type === "crypto" && i.providerId) {
      const data = z
        .record(
          z.string(),
          z.object({
            usd: z.number().nonnegative(),
            last_updated_at: z.number().positive(),
          }),
        )
        .parse(
          await json(
            `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(i.providerId)}&vs_currencies=usd&include_last_updated_at=true`,
            {
              headers: process.env.COINGECKO_API_KEY
                ? { "x-cg-demo-api-key": process.env.COINGECKO_API_KEY }
                : {},
            },
          ),
        );
      const row = data[i.providerId];
      if (!row) throw new Error("供应商未覆盖此币种");
      await storePrice(
        i,
        String(row.usd),
        new Date(row.last_updated_at * 1000).toISOString(),
        "CoinGecko",
      );
    } else if (
      i.type === "stock" &&
      i.providerId &&
      process.env.TWELVE_DATA_API_KEY
    ) {
      const raw = await json(
        `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(i.providerId)}&apikey=${encodeURIComponent(process.env.TWELVE_DATA_API_KEY)}`,
        undefined,
        true,
      );
      const failure = z
        .object({
          status: z.literal("error"),
          code: z.number().optional(),
          message: z.string().optional(),
        })
        .safeParse(raw);
      if (failure.success) {
        const requiredPlan = failure.data.message?.match(
          /starting with the (Grow|Pro|Ultra)(?: or (Venture|Enterprise))? plan/i,
        );
        if (requiredPlan)
          throw new Error(
            `Twelve Data 此标的需 ${requiredPlan[1]}${requiredPlan[2] ? ` 或 ${requiredPlan[2]}` : ""} 套餐，当前 Key 无报价权限`,
          );
        const messages: Record<number, string> = {
          401: "Twelve Data 密钥无效，请检查配置",
          403: "Twelve Data 账户未开通此市场的报价权限",
          404: "Twelve Data 未找到此标的报价",
          429: "Twelve Data 调用额度已用尽，请稍后重试",
        };
        throw new Error(
          messages[failure.data.code || 0] || "Twelve Data 暂未提供此标的报价",
        );
      }
      const data = z
        .object({
          close: z.string(),
          timestamp: z.number(),
          currency: z.string(),
        })
        .parse(raw);
      if (data.currency !== i.currency) throw new Error("报价币种不匹配");
      await storePrice(
        i,
        data.close,
        new Date(data.timestamp * 1000).toISOString(),
        "Twelve Data",
      );
    } else if (i.type === "fund" && i.providerId && process.env.TUSHARE_TOKEN) {
      const data = z
        .object({
          code: z.number(),
          data: z
            .object({
              fields: z.array(z.string()),
              items: z.array(
                z.array(z.union([z.string(), z.number(), z.null()])),
              ),
            })
            .nullable(),
        })
        .parse(
          await json("https://api.tushare.pro", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_name: "fund_nav",
              token: process.env.TUSHARE_TOKEN,
              params: { ts_code: i.providerId },
              fields: "nav_date,unit_nav",
            }),
          }),
        );
      const rows = data.data;
      if (data.code !== 0 || !rows?.items.length)
        throw new Error("基金净值未返回");
      const sorted = rows.items.sort((a, b) =>
        String(b[rows.fields.indexOf("nav_date")]).localeCompare(
          String(a[rows.fields.indexOf("nav_date")]),
        ),
      );
      const row = sorted[0];
      const date = String(row[rows.fields.indexOf("nav_date")]);
      await storePrice(
        i,
        String(row[rows.fields.indexOf("unit_nav")]),
        now(),
        `Tushare 已公布净值 ${date}（采集时生效）`,
      );
    } else throw new Error("此标的的自动行情未配置");
  });
}
export async function refreshMarket(userId: string, instrumentId?: string) {
  const current = (await holdings(userId)).filter(
    (h) => D(h.quantity).gt(0) && (!instrumentId || h.id === instrumentId),
  );
  const warnings: string[] = [];
  const currencies = [...new Set(current.map((h) => h.currency))].filter(
    (c) => c !== "CNY",
  );
  const assets = [
    ...new Map(
      current.filter((h) => h.type !== "cash").map((h) => [h.id, h]),
    ).values(),
  ];
  const results = await Promise.allSettled([
    ...currencies.map((currency) =>
      shared(`fx-${currency}`, async () => {
        const last = (await getDb().fxRate.findFirst({
          where: { currency: currency, userId: null },
          orderBy: { asOf: "desc" },
        })) as { asOf: string } | undefined;
        if (last && Date.now() - Date.parse(last.asOf) < 12 * 3600_000) return;
        const data = z
          .object({
            date: z.string(),
            rates: z.object({ CNY: z.number().positive() }),
          })
          .parse(
            await json(
              `https://api.frankfurter.dev/v1/latest?base=${currency}&symbols=CNY`,
            ),
          );
        await getDb().fxRate.create({
          data: {
            id: uid(),
            currency: currency,
            userId: null,
            value: String(data.rates.CNY),
            asOf: now(),
            source: `Frankfurter ${data.date}（采集时生效）`,
          },
        });
      }),
    ),
    ...assets.map((i) => refreshInstrument(i)),
  ]);
  results.forEach((r, index) => {
    if (r.status === "rejected")
      warnings.push(
        `${index < currencies.length ? currencies[index] : assets[index - currencies.length].name}：${r.reason instanceof Error ? r.reason.message : "更新失败"}`,
      );
  });
  const p = await profile(userId);
  if (p.baselineAt)
    await transaction(
      async () => rebuildSnapshots(userId, p.baselineAt!),
      userId,
    );
  return { warnings, updatedAt: now() };
}
