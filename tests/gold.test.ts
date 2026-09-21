import test from "node:test";
import assert from "node:assert/strict";
import { goldQuote } from "../src/server/gold";
import { catalog } from "../src/server/catalog";

test("Gold API converts troy ounces, shares cached requests, and rejects invalid quotes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const gold = catalog.find((i) => i.id === "gold-au9999")!;
  let calls = 0;
  let body: Record<string, unknown> = {
    symbol: "XAU",
    currency: "CNY",
    price: 31103.4768,
    updatedAt: new Date(Date.now() - 1000).toISOString(),
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, `https://api.gold-api.com/price/XAU/${body.currency}`);
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal);
    return Response.json(body);
  });
  const [gram, ounce] = await Promise.all([
    goldQuote(gold),
    goldQuote({ ...gold, quoteBasis: "oz" }),
  ]);
  assert.equal(calls, 1, "different instruments share the same upstream quote");
  assert.equal(gram.value, "1000", "price is per fine gram, without purity");
  assert.equal(ounce.value, "31103.4768");
  assert.equal(gram.asOf, body.updatedAt);
  await goldQuote(gold);
  assert.equal(calls, 1);
  t.mock.timers.tick(60_001);
  await goldQuote(gold);
  assert.equal(calls, 2, "unchanged market timestamp can still be rechecked");

  for (const currency of ["USD", "HKD"] as const) {
    body = { ...body, currency };
    assert.equal((await goldQuote({ ...gold, currency })).value, "1000");
  }
  await assert.rejects(goldQuote({ ...gold, unit: "千克" }), /仅支持以克/);
  body = { ...body, currency: "CNY" };
  for (const invalid of [
    { price: 0 },
    { price: -1 },
    { price: "1000" },
    { symbol: "XAG" },
    { updatedAt: "bad date" },
    { updatedAt: new Date(Date.now() + 86400_000).toISOString() },
  ]) {
    t.mock.timers.tick(60_001);
    const original = body;
    body = { ...body, ...invalid };
    await assert.rejects(goldQuote(gold), /报价时间无效/);
    body = original;
  }
  // A response in a different currency must not be treated as CNY.
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ ...body, currency: "USD" }),
  );
  await assert.rejects(goldQuote(gold), /币种/);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({}, { status: 429 }),
  );
  await assert.rejects(goldQuote(gold), /请求过于频繁/);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network failure");
  });
  await assert.rejects(goldQuote(gold), /连接失败/);
});
