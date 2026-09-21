import { coinIconUrl } from "@/lib/asset-icons";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getDb, transaction } from "./db";
import { DomainError } from "./ledger";
import { fundList } from "./funds";
import type {
  Instrument,
  InstrumentCandidate,
  InstrumentSearch,
} from "@/lib/types";

export const searchSchema = z.object({
  q: z.string().trim().min(1).max(80),
  type: z
    .enum(["all", "stock", "fund", "crypto", "cash", "gold"])
    .default("all"),
});
type SearchInput = z.infer<typeof searchSchema>;
const cache = new Map<
  string,
  { until: number; value: Promise<InstrumentCandidate[]> }
>();
function cached(
  key: string,
  fn: () => Promise<InstrumentCandidate[]>,
  ttl = 300_000,
) {
  const old = cache.get(key);
  if (old && old.until > Date.now()) return old.value;
  if (cache.size >= 200) cache.delete(cache.keys().next().value!);
  const value = fn().catch((error) => {
    if (cache.get(key)?.value === value) cache.delete(key);
    throw error;
  });
  cache.set(key, { until: Date.now() + ttl, value });
  return value;
}
async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("搜索服务暂不可用，请稍后重试");
  return response.json();
}
function candidate(
  data: Omit<InstrumentCandidate, "key">,
): InstrumentCandidate {
  const key = createHash("sha256")
    .update(
      JSON.stringify([data.source, data.type, data.providerId, data.currency]),
    )
    .digest("hex");
  return { ...data, name: data.name.slice(0, 100), key };
}
async function stocks(q: string) {
  if (!process.env.TWELVE_DATA_API_KEY)
    throw new Error("未配置 Twelve Data Key，股票在线搜索暂不可用");
  // HK brokers often show five digits; Twelve Data uses four (00700 -> 0700).
  const query = /^0\d{4}$/.test(q) ? String(Number(q)).padStart(4, "0") : q;
  return cached(`stock:${query.toLowerCase()}`, async () => {
    const url = new URL("https://api.twelvedata.com/symbol_search");
    url.searchParams.set("symbol", query);
    url.searchParams.set("outputsize", "100");
    url.searchParams.set("apikey", process.env.TWELVE_DATA_API_KEY!);
    const raw = await json(url.toString());
    if (raw.status === "error")
      throw new Error("Twelve Data 搜索不可用，请检查密钥、额度或稍后重试");
    const data = z
      .object({
        data: z.array(
          z.object({
            symbol: z.string().min(1),
            instrument_name: z.string().min(1),
            exchange: z.string().min(1),
            currency: z.string(),
            instrument_type: z.string(),
            country: z.string(),
          }),
        ),
      })
      .parse(raw);
    return data.data
      .filter(
        (i) =>
          ["CNY", "USD", "HKD"].includes(i.currency) &&
          ["United States", "China", "Hong Kong"].includes(i.country) &&
          /stock|depositary|etf|reit|trust/i.test(i.instrument_type),
      )
      .map((i) =>
        candidate({
          name: i.instrument_name,
          symbol: i.symbol,
          type: "stock",
          market: i.exchange,
          currency: i.currency as InstrumentCandidate["currency"],
          unit: "股",
          providerId: `${i.symbol}:${i.exchange}`,
          source: "Twelve Data",
        }),
      );
  });
}
async function coins(q: string) {
  return cached(`crypto:${q.toLowerCase()}`, async () => {
    const url = new URL("https://api.coingecko.com/api/v3/search");
    url.searchParams.set("query", q);
    const data = z
      .object({
        coins: z.array(
          z.object({
            id: z.string().min(1),
            large: z.string().optional(),
            thumb: z.string().optional(),
            name: z.string().min(1),
            symbol: z.string().min(1),
          }),
        ),
      })
      .parse(
        await json(url.toString(), {
          headers: process.env.COINGECKO_API_KEY
            ? { "x-cg-demo-api-key": process.env.COINGECKO_API_KEY }
            : {},
        }),
      );
    return data.coins.slice(0, 30).map((i) =>
      candidate({
        name: i.name,
        symbol: i.symbol.toUpperCase(),
        type: "crypto",
        market: "全球",
        currency: "USD",
        unit: "枚",
        providerId: i.id,
        source: "CoinGecko",
        iconUrl: coinIconUrl(i.large) || coinIconUrl(i.thumb),
      }),
    );
  });
}
async function funds(q: string) {
  const all = await cached(
    "fund:eastmoney:list",
    async () =>
      (await fundList()).map(({ code, name }) =>
        candidate({
          name,
          symbol: code,
          // Preserve the identity used by previously imported domestic funds.
          providerId: `${code}.OF`,
          type: "fund",
          market: "中国公募",
          currency: "CNY",
          unit: "份",
          source: "天天基金",
        }),
      ),
    24 * 3600_000,
  );
  const term = q.toLowerCase();
  return all
    .filter((i) =>
      `${i.symbol} ${i.name} ${i.providerId}`.toLowerCase().includes(term),
    )
    .slice(0, 30);
}
export async function searchInstruments(
  input: SearchInput,
): Promise<InstrumentSearch> {
  const { q, type } = searchSchema.parse(input);
  const jobs: Array<{
    name: string;
    run: () => Promise<InstrumentCandidate[]>;
  }> = [];
  if (type === "all" || type === "stock")
    jobs.push({ name: "股票", run: () => stocks(q) });
  if (type === "all" || type === "crypto")
    jobs.push({ name: "加密货币", run: () => coins(q) });
  if (type === "all" || type === "fund")
    jobs.push({ name: "基金", run: () => funds(q) });
  const results = await Promise.allSettled(jobs.map((j) => j.run()));
  const warnings: string[] = [];
  const items = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const error = result.reason;
    const message =
      error instanceof Error && /[\u4e00-\u9fff]/.test(error.message)
        ? error.message
        : "搜索服务暂不可用，请稍后重试";
    warnings.push(`${jobs[index].name}：${message}`);
    return [];
  });
  const exact = q.toUpperCase();
  return {
    items: [...new Map(items.map((i) => [i.key, i])).values()]
      .sort((a, b) => Number(b.symbol === exact) - Number(a.symbol === exact))
      .slice(0, 60),
    warnings,
  };
}
export async function importInstrument(
  input: SearchInput & { key: string },
): Promise<Instrument> {
  // Re-resolve on the server: clients cannot forge names, currencies or provider IDs.
  const result = await searchInstruments(input);
  const item = result.items.find((i) => i.key === input.key);
  if (!item) throw new DomainError("该搜索结果已不可用，请重新搜索后选择", 409);
  return await transaction(async () => {
    const existing = (await getDb().instrument.findFirst({
      where: {
        ownerId: null,
        type: item.type,
        currency: item.currency,
        OR: [
          { providerId: item.providerId },
          {
            type: "stock",
            symbol: item.symbol,
            market: item.market,
            providerId: item.symbol,
          },
        ],
      },
    })) as Instrument | undefined;
    if (existing) {
      if (item.iconUrl)
        await getDb().instrument.update({
          where: { id: existing.id },
          data: { iconUrl: item.iconUrl },
        });
      return { ...existing, iconUrl: item.iconUrl || existing.iconUrl };
    }
    const id = `online-${item.key}`;
    await getDb().instrument.createMany({
      data: [
        {
          id: id,
          ownerId: null,
          name: item.name,
          symbol: item.symbol,
          type: item.type,
          market: item.market,
          currency: item.currency,
          unit: item.unit,
          providerId: item.providerId,
          purity: "1",
          quoteBasis: "unit",
          iconUrl: item.iconUrl || null,
        },
      ],
      skipDuplicates: true,
    });
    return (await getDb().instrument.findFirst({
      where: { id: id },
    })) as Instrument;
  }, `instrument:${item.key}`);
}

// Backfill old crypto instruments from a provider-ID match, not a symbol match.
export async function resolveCoinIcon(instrument: Instrument) {
  if (instrument.type !== "crypto" || !instrument.providerId) return null;
  if (coinIconUrl(instrument.iconUrl)) return instrument.iconUrl!;
  const item = (await coins(instrument.symbol)).find(
    (i) => i.providerId === instrument.providerId,
  );
  const url = coinIconUrl(item?.iconUrl);
  if (url)
    await getDb().instrument.update({
      where: { id: instrument.id },
      data: { iconUrl: url },
    });
  return url;
}
