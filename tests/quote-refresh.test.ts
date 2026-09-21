import "./database";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const backupDir = mkdtempSync(join(tmpdir(), "atlas-scheduler-test-"));
process.env.BACKUP_PATH = backupDir;
process.env.ENABLE_SCHEDULER = "false";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET =
  "quote-refresh-tests-only-secret-12345678901234567890";
process.env.TWELVE_DATA_API_KEY = "test-key";
delete process.env.LONGPORT_APP_KEY;
delete process.env.LONGPORT_APP_SECRET;
delete process.env.LONGPORT_ACCESS_TOKEN;

test("opening assets get quotes immediately; failed quotes keep a single saved record and scheduler retries before initialization", async (t) => {
  const { app } = await import("../src/server/api");
  const { getDb } = await import("../src/server/db");
  const { tick } = await import("../src/server/jobs");
  const { holdings } = await import("../src/server/valuation");
  const origin = "http://localhost:3000";
  const signup = await app.request(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Quote regression",
      email: "quote-regression@example.test",
      password: "Testing123",
    }),
  });
  assert.equal(signup.status, 200);
  const cookie = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const user = (await signup.json()).user.id;
  const db = getDb();
  const wallet = (await getDb().wallet.findFirst({
    where: { userId: user },
  })) as { id: string } | undefined;
  // Session middleware creates the default wallet/profile on the first private request.
  await app.request(`${origin}/api/portfolio`, { headers: { Cookie: cookie } });
  const accountId =
    wallet?.id ||
    (
      (await getDb().wallet.findFirst({ where: { userId: user } })) as {
        id: string;
      }
    ).id;
  const originalFetch = globalThis.fetch;
  let fail = true;
  const requested: string[] = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "api.frankfurter.dev")
      return Response.json({ date: "2026-09-18", rates: { CNY: 7 } });
    assert.equal(parsed.hostname, "api.twelvedata.com");
    const symbol = parsed.searchParams.get("symbol")!;
    requested.push(symbol);
    if (symbol === "9988:HKEX")
      return Response.json(
        {
          status: "error",
          code: 404,
          message:
            "This symbol is available starting with the Pro or Venture plan. Consider upgrading now at https://twelvedata.com/pricing",
        },
        { status: 404 },
      );
    if (symbol === "MSFT" && fail)
      return Response.json({ status: "error", code: 429, message: "quota" });
    return Response.json({
      close: "100",
      timestamp: Math.floor(Date.now() / 1000) - 60,
      currency: "USD",
    });
  };
  const post = (body: unknown, key: string) =>
    app.request(`${origin}/api/transactions`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });
  try {
    const input = {
      type: "opening",
      accountId,
      instrumentId: "stock-baba",
      quantity: "2",
      occurredAt: new Date().toISOString(),
    };
    const response = await post(input, crypto.randomUUID());
    assert.equal(response.status, 201);
    assert.deepEqual((await response.json()).market.warnings, []);
    const baba = (await holdings(user)).find((h) => h.symbol === "BABA")!;
    assert.equal(baba.price, "100");
    assert.equal(baba.fx, "7");
    assert.equal(baba.value, "1400");
    assert.equal(baba.status, "current");
    const key = crypto.randomUUID();
    const failed = { ...input, instrumentId: "stock-msft" };
    const saved = await post(failed, key);
    assert.equal(
      saved.status,
      201,
      "market failure must not fail the saved ledger mutation",
    );
    const result = await saved.json();
    assert.match(result.market.warnings[0], /调用额度/);
    const repeat = await post(failed, key);
    assert.equal((await repeat.json()).id, result.id);
    assert.deepEqual(
      requested,
      ["BABA", "MSFT"],
      "only fetch the changed instrument; idempotent retries do not refetch",
    );
    assert.equal(
      (
        { n: await getDb().ledgerEvent.count({ where: { userId: user } }) } as {
          n: number;
        }
      ).n,
      2,
    );
    assert.equal(
      (
        (await getDb().profile.findUnique({ where: { userId: user } })) as {
          initialized: number;
        }
      ).initialized,
      0,
    );
    fail = false;
    await tick();
    assert.equal(
      (await holdings(user)).find((h) => h.symbol === "MSFT")?.price,
      "100",
      "scheduler includes uninitialized users",
    );
    assert.equal(
      (
        { n: await getDb().snapshot.count({ where: { userId: user } }) } as {
          n: number;
        }
      ).n,
      0,
      "quotes do not finalize the baseline or create pre-baseline snapshots",
    );
    await getDb().instrument.create({
      data: {
        id: "test-hk-alibaba",
        name: "Alibaba Hong Kong",
        symbol: "9988",
        type: "stock",
        market: "HKEX",
        currency: "HKD",
        unit: "股",
        providerId: "9988:HKEX",
      },
    });
    const hk = await post(
      { ...input, instrumentId: "test-hk-alibaba" },
      crypto.randomUUID(),
    );
    assert.equal(hk.status, 201, "quote permissions must not lose the holding");
    const hkResult = await hk.json();
    assert.match(
      hkResult.market.warnings[0],
      /Pro 或 Venture 套餐.*无报价权限/,
    );
    assert.doesNotMatch(hkResult.market.warnings[0], /未找到|test-key/);
    assert.equal(
      requested.filter((s) => s === "9988:HKEX").length,
      1,
      "do not retry permanent plan restrictions",
    );
    assert.equal(
      await getDb().price.count({ where: { instrumentId: "test-hk-alibaba" } }),
      0,
    );
    assert.equal(
      (await holdings(user)).find((h) => h.id === "test-hk-alibaba")?.price,
      null,
    );
    const { longportSdk } = await import("../src/server/longport-sdk");
    const { refreshMarket } = await import("../src/server/market");
    const quoteTime = new Date(Date.now() - 15 * 60_000);
    let longportRequests = 0;
    t.mock.method(
      longportSdk,
      "create",
      async () =>
        ({
          quote: async (symbols: string[]) => {
            assert.deepEqual(symbols, ["9988.HK"]);
            longportRequests++;
            return [
              {
                symbol: "9988.HK",
                lastDone: { toString: () => "125" },
                timestamp: quoteTime,
              },
            ];
          },
          staticInfo: async () => [{ symbol: "9988.HK", currency: "HKD" }],
        }) as unknown as import("longport").QuoteContext,
    );
    process.env.LONGPORT_APP_KEY = "hk-test-app";
    process.env.LONGPORT_APP_SECRET = "hk-test-secret";
    process.env.LONGPORT_ACCESS_TOKEN = "hk-test-token";
    assert.deepEqual(
      (await refreshMarket(user, "test-hk-alibaba")).warnings,
      [],
    );
    const pricedHk = (await holdings(user)).find(
      (h) => h.id === "test-hk-alibaba",
    )!;
    assert.equal(pricedHk.price, "125");
    assert.equal(pricedHk.originalValue, "250");
    assert.equal(pricedHk.value, "1750");
    assert.equal(pricedHk.currency, "HKD");
    assert.equal(pricedHk.priceAsOf, quoteTime.toISOString());
    assert.match(pricedHk.source, /长桥 LongPort/);
    await refreshMarket(user, "test-hk-alibaba");
    assert.equal(longportRequests, 1, "reuse cached quote within 15 minutes");
    assert.equal(
      requested.filter((s) => s === "9988:HKEX").length,
      1,
      "configured HK quotes must bypass Twelve Data",
    );
  } finally {
    delete process.env.LONGPORT_APP_KEY;
    delete process.env.LONGPORT_APP_SECRET;
    delete process.env.LONGPORT_ACCESS_TOKEN;
    globalThis.fetch = originalFetch;
    rmSync(backupDir, { recursive: true, force: true });
  }
});
