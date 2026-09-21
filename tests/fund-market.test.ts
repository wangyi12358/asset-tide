import "./database";
import test from "node:test";
import assert from "node:assert/strict";
import { getDb, uid } from "../src/server/db";
import { ensureProfile, holdings, wallets } from "../src/server/valuation";
import { eventSchema, recordEvent } from "../src/server/ledger";
import { refreshMarket } from "../src/server/market";

test("legacy fund refresh switches provider without token and preserves price on failure", async (t) => {
  delete process.env.TUSHARE_TOKEN;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const userId = uid();
  const instrumentId = uid();
  await getDb().user.create({
    data: { id: userId, name: "Fund", email: `${userId}@example.test` },
  });
  await ensureProfile(userId);
  await getDb().instrument.create({
    data: {
      id: instrumentId,
      name: "测试基金",
      symbol: "000001",
      providerId: "000001.OF",
      type: "fund",
      market: "中国公募",
      currency: "CNY",
      unit: "份",
      purity: "1",
      quoteBasis: "unit",
    },
  });
  await recordEvent(
    userId,
    eventSchema.parse({
      type: "opening",
      instrumentId,
      accountId: (await wallets(userId))[0].id,
      quantity: "100",
      occurredAt: new Date(Date.now() - 120000).toISOString(),
    }),
    uid(),
  );
  await getDb().price.create({
    data: {
      id: uid(),
      instrumentId,
      value: "1",
      asOf: new Date(Date.now() - 1000).toISOString(),
      createdAt: new Date(Date.now() - 1000).toISOString(),
      source: "Tushare 已公布净值",
    },
  });
  let calls = 0;
  let failing = false;
  const navDate = Date.parse("2025-01-02T00:00:00+08:00");
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, "https://fund.eastmoney.com/pingzhongdata/000001.js");
    calls++;
    return failing
      ? new Response("", { status: 503 })
      : new Response(
          `var ishb=false;var fS_code="000001";var Data_netWorthTrend=[{"x":${navDate},"y":1.25}];`,
        );
  });
  assert.deepEqual((await refreshMarket(userId)).warnings, []);
  const h = (await holdings(userId))[0];
  assert.equal(h.price, "1.25");
  assert.equal(h.value, "125");
  assert.match(h.source, /天天基金 已公布净值 2025-01-02/);
  await refreshMarket(userId);
  assert.equal(calls, 1, "new provider respects refresh interval");
  t.mock.timers.tick(15 * 60_000 + 1);
  failing = true;
  assert.match(
    (await refreshMarket(userId)).warnings[0],
    /天天基金服务暂不可用/,
  );
  const after = (await holdings(userId))[0];
  assert.equal(after.price, h.price);
  assert.equal(after.priceAsOf, h.priceAsOf);
});

test("current fund deposits auto-value without manual price or note and retries stay idempotent", async (t) => {
  const userId = uid();
  const instrumentId = uid();
  await getDb().user.create({
    data: {
      id: userId,
      name: "Automatic fund",
      email: `${userId}@example.test`,
    },
  });
  await ensureProfile(userId);
  await getDb().profile.update({
    where: { userId },
    data: {
      initialized: 1,
      baseline: "0",
      baselineAt: new Date(Date.now() - 86400_000).toISOString(),
    },
  });
  await getDb().instrument.create({
    data: {
      id: instrumentId,
      name: "测试基金",
      symbol: "000001",
      providerId: "000001.OF",
      type: "fund",
      market: "中国公募",
      currency: "CNY",
      unit: "份",
      purity: "1",
      quoteBasis: "unit",
    },
  });
  let calls = 0;
  let failing = false;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return failing
      ? new Response("", { status: 503 })
      : new Response(
          `var ishb=false;var fS_code="000001";var Data_netWorthTrend=[{"x":${Date.now() - 86400_000},"y":1.25}];`,
        );
  });
  const input = eventSchema.parse({
    type: "deposit",
    accountId: (await wallets(userId))[0].id,
    instrumentId,
    quantity: "100",
    occurredAt: new Date().toISOString(),
  });
  const key = uid();
  const saved = await recordEvent(userId, input, key);
  assert.equal(saved.externalCny, "125");
  assert.match(saved.note, /估值依据：天天基金/);
  assert.equal((await holdings(userId))[0].price, "1.25");
  const prices = await getDb().price.findMany({ where: { instrumentId } });
  assert.equal(prices.length, 1);
  assert.equal(prices[0].manual, 0);
  assert.equal(prices[0].userId, null);
  assert.equal(
    JSON.parse(saved.payload).price,
    undefined,
    "retain original input for idempotency",
  );
  failing = true;
  assert.equal((await recordEvent(userId, input, key)).id, saved.id);
  assert.equal(
    calls,
    1,
    "retry does not depend on provider availability or changing NAV",
  );
  await assert.rejects(
    recordEvent(
      userId,
      { ...input, occurredAt: new Date(Date.now() - 3600_000).toISOString() },
      uid(),
    ),
    /历史基金流水/,
  );
  assert.equal(calls, 1, "historical entry never fetches today's NAV");
  await assert.rejects(
    recordEvent(userId, { ...input, type: "buy" }, uid()),
    /实际成交单价/,
  );
  const retryKey = uid();
  await assert.rejects(
    recordEvent(userId, input, retryKey),
    /未能自动获取基金净值/,
  );
  assert.equal(
    await getDb().ledgerEvent.count({ where: { userId } }),
    1,
    "quote failure saves no unvalued flow",
  );
  failing = false;
  assert.equal((await recordEvent(userId, input, retryKey)).externalCny, "125");
  const beforeManual = calls;
  const manual = await recordEvent(
    userId,
    { ...input, price: "1.3", note: "对账单净值" },
    uid(),
  );
  assert.equal(manual.externalCny, "130");
  assert.equal(calls, beforeManual, "explicit price bypasses automatic NAV");
  assert.equal(
    await getDb().price.count({ where: { instrumentId, userId, manual: 1 } }),
    1,
  );
});
