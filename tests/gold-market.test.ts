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
