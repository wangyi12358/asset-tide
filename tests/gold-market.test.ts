import "./database";
import test from "node:test";
import assert from "node:assert/strict";
import { getDb, uid } from "../src/server/db";
import {
  D,
  ensureProfile,
  holdings,
  quote,
  wallets,
} from "../src/server/valuation";
import { eventSchema, recordEvent } from "../src/server/ledger";
import { refreshMarket } from "../src/server/market";
import { refreshOnDemand } from "../src/server/refresh";
import { catalog } from "../src/server/catalog";

test("physical gold refresh values pure weight, preserves manual prices, and retains old quotes on failure", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const userId = uid();
  await getDb().user.create({
    data: { id: userId, name: "Gold", email: `${userId}@example.test` },
  });
  await ensureProfile(userId);
  const accountId = (await wallets(userId))[0].id;
  const instrumentId = "gold-au9999";
  const gold = catalog.find((i) => i.id === instrumentId)!;
  await recordEvent(
    userId,
    eventSchema.parse({
      type: "opening",
      instrumentId,
      accountId,
      quantity: "100",
      occurredAt: new Date(Date.now() - 120_000).toISOString(),
    }),
    uid(),
  );
  let calls = 0;
  let failing = false;
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, "https://api.gold-api.com/price/XAU/CNY");
    calls++;
    return failing
      ? Response.json({}, { status: 503 })
      : Response.json({
          symbol: "XAU",
          currency: "CNY",
          price: 31103.4768,
          updatedAt,
        });
  });
  assert.deepEqual((await refreshMarket(userId)).warnings, []);
  let h = (await holdings(userId))[0];
  assert.equal(h.price, "1000");
  assert.equal(h.value, "99990", "100 grams * 0.9999 purity * 1000 CNY");
  assert.equal(h.status, "current");
  assert.equal(h.priceAsOf, updatedAt);
  assert.match(h.source, /Gold API/);
  assert.equal(
    (
      await quote(
        userId,
        gold,
        new Date(Date.parse(updatedAt) - 1).toISOString(),
      )
    ).price,
    null,
  );
  await refreshMarket(userId);
  assert.equal(calls, 1);

  const manualId = uid();
  await getDb().price.create({
    data: {
      id: manualId,
      instrumentId,
      userId,
      value: "900",
      manual: 1,
      asOf: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      source: "手动 · 回收参考价",
    },
  });
  h = (await holdings(userId))[0];
  assert.equal(h.price, "900");
  assert.equal(h.status, "manual");
  assert.equal(h.automaticAvailable, true);
  assert.equal(
    (await quote(uid(), gold, new Date().toISOString())).price,
    "1000",
  );
  await getDb().price.update({
    where: { id: manualId },
    data: { active: 0, endedAt: new Date().toISOString() },
  });
  assert.equal((await holdings(userId))[0].price, "1000");

  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () => refreshOnDemand(userId, "auto")),
  );
  assert.equal(concurrent.filter((r) => !r.skipped).length, 1);
  assert.equal((await refreshOnDemand(userId, "auto")).skipped, true);
  t.mock.timers.tick(60_001);
  assert.equal((await refreshOnDemand(userId, "auto")).skipped, false);
  assert.equal(calls, 2, "gold automatic refresh is allowed after one minute");
  assert.equal(
    await getDb().price.count({ where: { instrumentId, userId: null } }),
    1,
    "an unchanged upstream timestamp does not create fake price history",
  );

  t.mock.timers.tick(60_001);
  failing = true;
  const failed = await refreshMarket(userId);
  assert.match(failed.warnings[0], /Gold API 暂不可用/);
  h = (await holdings(userId))[0];
  assert.equal(h.price, "1000");
  assert.equal(h.priceAsOf, updatedAt, "failure must not advance quote time");
  assert.equal(D(h.value!).toFixed(), "99990");
  t.mock.timers.tick(3600_001);
  assert.equal((await holdings(userId))[0].status, "stale");
});

test("current gold movements use API prices when the manual reference is omitted", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 86400_000 });
  const userId = uid();
  const instrumentId = uid();
  await getDb().user.create({
    data: {
      id: userId,
      name: "Automatic gold",
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
      ...catalog.find((i) => i.id === "gold-au9999")!,
      id: instrumentId,
      ownerId: userId,
    },
  });
  let calls = 0;
  let failing = false;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, "https://api.gold-api.com/price/XAU/CNY");
    calls++;
    return failing
      ? Response.json({}, { status: 503 })
      : Response.json({
          symbol: "XAU",
          currency: "CNY",
          price: 31103.4768,
          updatedAt: new Date(Date.now() - 1000).toISOString(),
        });
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
  assert.equal(saved.externalCny, "99990", "purity is applied exactly once");
  assert.match(saved.note, /估值依据：Gold API.*1000 CNY\/克/);
  assert.equal(JSON.parse(saved.payload).price, undefined);
  const prices = await getDb().price.findMany({ where: { instrumentId } });
  assert.equal(prices.length, 1);
  assert.equal(prices[0].manual, 0);
  assert.equal(prices[0].userId, userId, "custom gold quotes remain private");
  assert.equal((await recordEvent(userId, input, key)).id, saved.id);
  assert.equal(calls, 1);
  const withdrawal = await recordEvent(
    userId,
    { ...input, type: "withdrawal", quantity: "10" },
    uid(),
  );
  assert.equal(withdrawal.externalCny, "-9999");
  await assert.rejects(
    recordEvent(userId, { ...input, type: "adjustment" }, uid()),
    /估值依据备注/,
  );
  const adjustment = await recordEvent(
    userId,
    { ...input, type: "adjustment", quantity: "10", note: "重量修正" },
    uid(),
  );
  assert.equal(adjustment.baselineAdjustment, "9999");
  assert.equal((await holdings(userId))[0].value, "99990");
  for (const type of ["buy", "sell"] as const)
    await assert.rejects(
      recordEvent(userId, { ...input, type }, uid()),
      /实际成交单价/,
    );
  await assert.rejects(
    recordEvent(
      userId,
      { ...input, occurredAt: new Date(Date.now() - 3600_000).toISOString() },
      uid(),
    ),
    /历史黄金流水/,
  );
  await assert.rejects(
    recordEvent(userId, input, uid(), saved.id),
    /历史黄金流水/,
  );
  assert.equal(calls, 1, "historical entries never fetch current prices");
  t.mock.timers.tick(60_001);
  failing = true;
  const retryKey = uid();
  await assert.rejects(
    recordEvent(userId, input, retryKey),
    /未能自动获取黄金价格/,
  );
  assert.equal(await getDb().ledgerEvent.count({ where: { userId } }), 3);
  failing = false;
  assert.equal(
    (await recordEvent(userId, input, retryKey)).externalCny,
    "99990",
  );
  const beforeManual = calls;
  const manual = await recordEvent(
    userId,
    { ...input, price: "900", note: "回收报价" },
    uid(),
  );
  assert.equal(manual.externalCny, "89991");
  assert.equal(calls, beforeManual);
  assert.equal(
    await getDb().price.count({ where: { instrumentId, userId, manual: 1 } }),
    1,
  );
});
