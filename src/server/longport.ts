import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { QuoteContext } from "longport";
import type { Instrument } from "@/lib/types";
import { longportSdk } from "./longport-sdk";

const credentialNames = [
  "LONGPORT_APP_KEY",
  "LONGPORT_APP_SECRET",
  "LONGPORT_ACCESS_TOKEN",
] as const;

export function longportStatus() {
  const count = credentialNames.filter((key) =>
    process.env[key]?.trim(),
  ).length;
  return count === 3 ? "ready" : count === 0 ? "disabled" : "incomplete";
}

export function isHongKongStock(i: Instrument) {
  return i.type === "stock" && /^(HKEX|SEHK|XHKG|HK)$/i.test(i.market);
}

export function longportSymbol(symbol: string) {
  const match = /^(\d{1,5})(?:\.HK)?$/i.exec(symbol.trim());
  if (!match || Number(match[1]) === 0)
    throw new Error("长桥港股代码无效，请检查资产代码");
  return `${Number(match[1])}.HK`;
}

let cached: { key: string; context: Promise<QuoteContext> } | undefined;
async function context() {
  if (longportStatus() !== "ready")
    throw new Error(
      "长桥配置不完整，请填写 App Key、App Secret 和 Access Token",
    );
  const values = credentialNames.map((key) => process.env[key]!.trim());
  const key = createHash("sha256").update(JSON.stringify(values)).digest("hex");
  if (cached?.key === key) return cached.context;
  const pending = longportSdk.create(values[0], values[1], values[2]);
  cached = { key, context: pending };
  try {
    return await pending;
  } catch (error) {
    if (cached?.context === pending) cached = undefined;
    throw error;
  }
}

function providerError(error: unknown) {
  // Never expose raw SDK errors: they can include request credentials.
  const message = error instanceof Error ? error.message : String(error);
  if (/401003|token.*expired/i.test(message))
    return new Error("长桥 Access Token 已过期，请在开放平台更新凭证");
  if (/403205|ip.*not allowed/i.test(message))
    return new Error("长桥 IP 白名单未允许当前服务器");
  if (
    /401|403201|403203|signature|apikey|unauthenticated|unauthorized|invalid.*token/i.test(
      message,
    )
  )
    return new Error(
      "长桥认证失败，请检查 App Key、App Secret 和 Access Token",
    );
  if (/301606|429|rate.?limit/i.test(message))
    return new Error("长桥行情请求过于频繁，请稍后重试");
  if (/permission|quote.*right|no.*access|403|301604/i.test(message))
    return new Error(
      "长桥未开通此标的的 OpenAPI 行情权限，请检查开放平台行情权限",
    );
  return new Error("长桥行情请求失败，请检查网络、应用凭证及 OpenAPI 行情权限");
}

export async function longportQuote(i: Instrument) {
  const symbol = longportSymbol(i.symbol);
  if (longportStatus() !== "ready")
    throw new Error(
      "长桥配置不完整，请填写 App Key、App Secret 和 Access Token",
    );
  const request = (async () => {
    try {
      const ctx = await context();
      return await Promise.all([ctx.quote([symbol]), ctx.staticInfo([symbol])]);
    } catch (error) {
      throw providerError(error);
    }
  })();
  // The native SDK owns its transport. Bound the API wait without retrying a
  // potentially still-running request, and clear the timer on every outcome.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const [quotes, info] = await Promise.race([
    request,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("长桥行情请求超时，请稍后重试")),
        10_000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  const quote = quotes.find((row) => row.symbol === symbol);
  const security = info.find((row) => row.symbol === symbol);
  if (!quote || !security) throw new Error("长桥未返回此标的报价或基础信息");
  if (security.currency !== i.currency) throw new Error("长桥报价币种不匹配");
  const value = quote.lastDone.toString();
  const time = quote.timestamp.getTime();
  if (
    !new Decimal(value).isFinite() ||
    new Decimal(value).lte(0) ||
    !Number.isFinite(time) ||
    time <= 0 ||
    time > Date.now()
  )
    throw new Error("长桥返回的价格或报价时间无效");
  return {
    value,
    asOf: quote.timestamp.toISOString(),
    source: "长桥 LongPort（行情可能延迟，以报价时间为准）",
  };
}
