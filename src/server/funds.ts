import { z } from "zod";

async function fundText(path: string) {
  try {
    const response = await fetch(`https://fund.eastmoney.com/${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok)
      throw new Error(
        response.status === 429
          ? "天天基金请求过于频繁，请稍后重试"
          : "天天基金服务暂不可用，请稍后重试",
      );
    return await response.text();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("天天基金"))
      throw error;
    throw new Error("天天基金连接失败或超时，请稍后重试");
  }
}

// Extract JSON literals only. Never evaluate JavaScript from the provider.
function literal(text: string, name: string): unknown {
  const match = text.match(new RegExp(`\\bvar\\s+${name}\\s*=\\s*([^]*?);`));
  if (!match) throw new Error("天天基金返回数据格式异常");
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new Error("天天基金返回数据格式异常");
  }
}

export async function fundList() {
  const text = await fundText("js/fundcode_search.js");
  const parsed = z
    .array(
      z.tuple([
        z.string().regex(/^\d{6}$/),
        z.string(),
        z.string().min(1),
        z.string(),
        z.string(),
      ]),
    )
    .min(1)
    .safeParse(literal(text, "r"));
  if (!parsed.success) throw new Error("天天基金目录格式异常");
  return parsed.data.map(([code, , name]) => ({ code, name }));
}

export async function fundQuote(providerId: string) {
  // Keep compatibility with existing Tushare IDs (e.g. 000001.OF).
  const code = providerId.match(/^(\d{6})(?:\.(?:OF|SH|SZ))?$/)?.[1];
  if (!code) throw new Error("基金代码无效，自动净值仅支持六位国内基金代码");
  const text = await fundText(`pingzhongdata/${code}.js`);
  if (literal(text, "fS_code") !== code)
    throw new Error("天天基金返回的基金代码不匹配");
  if (literal(text, "ishb") !== false)
    throw new Error("货币基金暂不支持自动单位净值，请手动录入净值");
  const parsed = z
    .array(
      z.object({
        x: z.number().int().positive().max(Date.now()),
        y: z.number().positive(),
      }),
    )
    .min(1)
    .safeParse(literal(text, "Data_netWorthTrend"));
  if (!parsed.success) throw new Error("天天基金未返回有效的单位净值");
  const latest = parsed.data.reduce((a, b) => (a.x > b.x ? a : b));
  const date = new Date(latest.x + 8 * 3600_000).toISOString().slice(0, 10);
  return {
    value: String(latest.y),
    // NAV is known only after publication; don't backdate portfolio snapshots.
    asOf: new Date().toISOString(),
    source: `天天基金 已公布净值 ${date}（采集时生效）`,
  };
}
