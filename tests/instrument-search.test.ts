import "./database";
import test from "node:test";
import assert from "node:assert/strict";
process.env.ENABLE_SCHEDULER = "false";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET =
  "search-integration-test-only-secret-12345678901234567890";
process.env.TWELVE_DATA_API_KEY = "test-twelve-key";
process.env.COINGECKO_API_KEY = "test-coin-key";
delete process.env.TUSHARE_TOKEN;

test("online search: authenticated lookup, exchange identity, validated import, cache and partial failure", async () => {
  const { app } = await import("../src/server/api");
  const { getDb } = await import("../src/server/db");
  const { searchInstruments } = await import("../src/server/instrument-search");
  const signup = await app.request(
    "http://localhost:3000/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        name: "Search test",
        email: "search-test@example.test",
        password: "Testing123",
      }),
    },
  );
  assert.equal(signup.status, 200);
  const cookie = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const call = (path: string, body?: unknown) =>
    app.request(`http://localhost:3000/api${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Cookie: cookie,
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  assert.equal(
    (await app.request("http://localhost:3000/api/instruments/search?q=BABA"))
      .status,
    401,
  );
  assert.equal((await call("/instruments/search?q=")).status, 400);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let fundFailing = true;
  let fundRequests = 0;
  const rows = [
    {
      symbol: "UNSEEDED",
      instrument_name: "Previously unknown company",
      exchange: "NYSE",
      currency: "USD",
      instrument_type: "Common Stock",
      country: "United States",
    },
    {
      symbol: "UNSEEDED",
      instrument_name: "Other listing",
      exchange: "HKEX",
      currency: "HKD",
      instrument_type: "Common Stock",
      country: "Hong Kong",
    },
    {
      symbol: "UNSEEDED",
      instrument_name: "Unsupported currency",
      exchange: "LSE",
      currency: "GBP",
      instrument_type: "Common Stock",
      country: "United Kingdom",
    },
  ];
  globalThis.fetch = async (url, init) => {
    requests++;
    const parsed = new URL(String(url));
    if (parsed.hostname === "api.twelvedata.com") {
      assert.equal(parsed.searchParams.get("apikey"), "test-twelve-key");
      if (parsed.searchParams.get("symbol") === "failure")
        throw new Error("network unavailable");
      if (parsed.searchParams.get("symbol") === "0700")
        return Response.json({
          data: [{ ...rows[1], symbol: "0700", instrument_name: "Tencent" }],
        });
      return Response.json({ data: rows });
    }
    if (parsed.hostname === "api.coingecko.com") {
      assert.equal(
        new Headers(init?.headers).get("x-cg-demo-api-key"),
        "test-coin-key",
      );
      return Response.json({
        coins: [
          {
            id: "unique-one",
            symbol: "SAME",
            name: "First coin",
            large: "https://evil.test/tracker",
          },
          {
            id: "unique-two",
            symbol: "SAME",
            name: "Second coin",
            large:
              "https://coin-images.coingecko.com/coins/images/1/large/test.png",
          },
        ],
      });
    }
    assert.equal(
      parsed.href,
      "https://fund.eastmoney.com/js/fundcode_search.js",
    );
    fundRequests++;
    if (fundFailing) return new Response("", { status: 503 });
    return new Response(
      'var r = [["123456","CSJJ","测试基金","混合型","CESHIJIJIN"]];',
    );
  };
  try {
    const db = getDb();
    const count = async () =>
      (
        ({ n: await getDb().instrument.count({}) }) as {
          n: number;
        }
      ).n;
    const before = await count();
    const response = await call("/instruments/search?q=UNSEEDED&type=stock");
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.items.length, 2);
    assert.equal(await count(), before, "search does not persist candidates");
    assert.equal(JSON.stringify(data).includes("test-twelve-key"), false);
    await call("/instruments/search?q=UNSEEDED&type=stock");
    assert.equal(requests, 1, "repeated search shares cache");
    const body = {
      q: "UNSEEDED",
      type: "stock",
      key: data.items[0].key,
      currency: "CNY",
      providerId: "FORGED",
    };
    const imported = await (await call("/instruments/import", body)).json();
    assert.equal(imported.currency, "USD");
    assert.equal(imported.providerId, "UNSEEDED:NYSE");
    const again = await (await call("/instruments/import", body)).json();
    assert.equal(
      again.id,
      imported.id,
      "repeated imports share one instrument",
    );
    const other = await (
      await call("/instruments/import", { ...body, key: data.items[1].key })
    ).json();
    assert.notEqual(
      other.id,
      imported.id,
      "same ticker in different markets stays distinct",
    );
    assert.equal(other.currency, "HKD");
    assert.equal(
      (await call("/instruments/import", { ...body, key: "0".repeat(64) }))
        .status,
      409,
    );
    const hk = await searchInstruments({ q: "00700", type: "stock" });
    assert.equal(hk.items[0].providerId, "0700:HKEX");
    const coins = await (
      await call("/instruments/search?q=SAME&type=crypto")
    ).json();
    assert.notEqual(coins.items[0].key, coins.items[1].key);
    const chosen = await (
      await call("/instruments/import", {
        q: "SAME",
        type: "crypto",
        key: coins.items[1].key,
      })
    ).json();
    assert.equal(chosen.providerId, "unique-two");
    assert.equal(coins.items[0].iconUrl, null);
    assert.equal(
      chosen.iconUrl,
      "https://coin-images.coingecko.com/coins/images/1/large/test.png",
    );
    const { resolveCoinIcon } = await import("../src/server/instrument-search");
    await getDb().instrument.update({
      where: { id: chosen.id },
      data: { iconUrl: null },
    });
    assert.equal(
      await resolveCoinIcon({ ...chosen, iconUrl: null }),
      chosen.iconUrl,
    );
    assert.equal(
      (await call(`/instruments/${chosen.id}/icon`)).headers.get("location"),
      chosen.iconUrl,
    );

    const failedFund = await searchInstruments({ q: "测试", type: "fund" });
    assert.match(failedFund.warnings[0], /天天基金服务暂不可用/);
    fundFailing = false;
    const funds = await searchInstruments({ q: "测试", type: "fund" });
    assert.equal(funds.items[0].providerId, "123456.OF");
    assert.equal(funds.items[0].source, "天天基金");
    await searchInstruments({ q: "123456", type: "fund" });
    assert.equal(
      fundRequests,
      2,
      "failed directory is retried; successful directory is cached",
    );
    await db.instrument.create({
      data: {
        id: "legacy-tushare-fund",
        name: "测试基金",
        symbol: "123456",
        providerId: "123456.OF",
        type: "fund",
        market: "中国公募",
        currency: "CNY",
        unit: "份",
        purity: "1",
        quoteBasis: "unit",
      },
    });
    const importedFund = await (
      await call("/instruments/import", {
        q: "测试",
        type: "fund",
        key: funds.items[0].key,
      })
    ).json();
    assert.equal(
      importedFund.id,
      "legacy-tushare-fund",
      "reuse existing Tushare instrument",
    );
    const system = await (await call("/system")).json();
    assert.match(system.providers.funds, /天天基金/);
    const partial = await searchInstruments({ q: "failure", type: "all" });
    assert.equal(partial.warnings.length, 1);
    assert.ok(partial.items.some((i) => i.type === "crypto"));
    delete process.env.TWELVE_DATA_API_KEY;
    const missing = await searchInstruments({ q: "new", type: "stock" });
    assert.match(missing.warnings[0], /未配置/);
    assert.equal(missing.items.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
