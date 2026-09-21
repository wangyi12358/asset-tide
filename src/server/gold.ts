import Decimal from "decimal.js";
import { z } from "zod";
import type { Instrument } from "@/lib/types";

const GoldDecimal = Decimal.clone({ precision: 40 });
const quoteSchema = z.object({
  symbol: z.literal("XAU"),
  currency: z.enum(["CNY", "USD", "HKD"]),
  price: z.number().positive(),
  updatedAt: z.iso.datetime({ offset: true }),
});
type GoldQuote = z.infer<typeof quoteSchema>;
const cache = new Map<string, { quote: GoldQuote; fetchedAt: number }>();
const inflight = new Map<string, Promise<GoldQuote>>();

export function supportsGoldQuote(i: Instrument) {
  return (
    i.type === "gold" &&
    i.unit === "克" &&
    ["unit", "oz"].includes(i.quoteBasis) &&
    ["CNY", "USD", "HKD"].includes(i.currency)
  );
}

async function fetchGold(currency: string): Promise<GoldQuote> {
  const cached = cache.get(currency);
  // The provider requests at least 30 seconds of caching, including weekends
  // when multiple fetches can legitimately return the same quote timestamp.
  if (cached && Date.now() - cached.fetchedAt < 60_000) return cached.quote;
  const pending = inflight.get(currency);
  if (pending) return pending;
  const request = (async () => {
    try {
      const response = await fetch(
        `https://api.gold-api.com/price/XAU/${currency}`,
        { cache: "no-store", signal: AbortSignal.timeout(8000) },
      );
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? "Gold API 请求过于频繁，请稍后重试"
            : "Gold API 暂不可用，请稍后重试",
        );
      const parsed = quoteSchema.safeParse(await response.json());
      if (
        !parsed.success ||
        parsed.data.currency !== currency ||
        Date.parse(parsed.data.updatedAt) > Date.now()
      )
        throw new Error("Gold API 返回的金价、币种或报价时间无效");
      const quote = parsed.data;
      cache.set(currency, { quote, fetchedAt: Date.now() });
      return quote;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Gold API"))
        throw error;
      throw new Error("Gold API 连接失败或响应无效，请稍后重试");
    }
  })().finally(() => inflight.delete(currency));
  inflight.set(currency, request);
  return request;
}

export async function goldQuote(i: Instrument) {
  if (!supportsGoldQuote(i))
    throw new Error("自动金价仅支持以克记录重量、按克或金衡盎司报价的实物黄金");
  const data = await fetchGold(i.currency);
  // XAU is priced per troy ounce of fine gold. Purity is applied once by
  // the existing valuation layer, never to the stored reference price.
  const value = new GoldDecimal(data.price)
    .div(i.quoteBasis === "oz" ? 1 : "31.1034768")
    .toFixed();
  return {
    value,
    asOf: new Date(data.updatedAt).toISOString(),
    source: "Gold API · 国际现货黄金（含供应商币种折算）",
  };
}
