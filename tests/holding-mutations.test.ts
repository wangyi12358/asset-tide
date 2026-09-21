import "./database";
import test from "node:test";
import assert from "node:assert/strict";
import { getDb, uid } from "../src/server/db";
import { changeHolding } from "../src/server/holding-mutations";
import { eventSchema, recordEvent, voidEvent } from "../src/server/ledger";
import {
  ensureProfile,
  holdings,
  valuation,
  wallets,
  saveSnapshot,
} from "../src/server/valuation";
process.env.ENABLE_SCHEDULER = "false";
async function setup(instrument = "cash-cny", quantity = "100") {
  const user = uid(),
    db = getDb();
  await getDb().user.create({
    data: {
      id: user,
      name: "Holding test",
      email: `${user}@example.test`,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  await ensureProfile(user);
  const accountId = (await wallets(user))[0].id;
  await recordEvent(
    user,
    eventSchema.parse({
      type: "opening",
      accountId,
      instrumentId: instrument,
      quantity,
      occurredAt: "2026-01-01T00:00:00Z",
    }),
    uid(),
  );
  return { user, accountId, id: `${accountId}~${instrument}` };
}
test("set exact decimal quantity before initialization, reject stale writes, delete and restore while retaining history", async () => {
  const u = await setup("crypto-bitcoin", "1.1");
  const input = {
    quantity: "0.100000000000000001",
    expectedQuantity: "1.1",
    reason: "核对实际持仓",
  };
  const key = uid();
  const result = await changeHolding(u.user, u.id, input, key);
  assert.equal((await holdings(u.user))[0].quantity, input.quantity);
  assert.equal(
    (await changeHolding(u.user, u.id, input, key)).eventId,
    result.eventId,
  );
  await assert.rejects(
    async () =>
      await changeHolding(u.user, u.id, { ...input, quantity: "2" }, key),
    /幂等键/,
  );
  await assert.rejects(
    async () => await changeHolding(u.user, u.id, input, uid()),
    /数量已发生变化/,
  );
  await assert.rejects(
    async () =>
      await changeHolding(u.user, u.id, { ...input, quantity: "-1" }, uid()),
  );
  const removed = await changeHolding(
    u.user,
    u.id,
    { quantity: "0", expectedQuantity: input.quantity, reason: "删除误录持仓" },
    uid(),
    "delete",
  );
  assert.equal((await holdings(u.user))[0].quantity, "0");
  assert.equal((await valuation(u.user)).items.length, 0);
  assert.equal(
    (
      { n: await getDb().ledgerEvent.count({ where: { userId: u.user } }) } as {
        n: number;
      }
    ).n,
    3,
  );
  await voidEvent(u.user, removed.eventId!, "恢复误删持仓");
  assert.equal((await holdings(u.user))[0].quantity, input.quantity);
  const other = await setup();
  await assert.rejects(
    async () => await changeHolding(other.user, u.id, input, uid()),
    /持仓不存在/,
  );
});
test("quantity corrections and deletion adjust attribution without cash flow, fake returns, or rewriting past snapshots", async () => {
  const u = await setup();
  const db = getDb();
  const baseline = "2026-01-02T00:00:00Z";
  await getDb().profile.update({
    where: { userId: u.user },
    data: { initialized: 1, baseline: "100", baselineAt: baseline },
  });
  await saveSnapshot(u.user, baseline);
  const snapshot = await getDb().snapshot.findFirst({
    where: { userId: u.user },
  });
  await changeHolding(
    u.user,
    u.id,
    { quantity: "150", expectedQuantity: "100", reason: "修正漏记数量" },
    uid(),
  );
  assert.equal((await valuation(u.user)).total, "150");
  assert.equal((await valuation(u.user)).pnl, "0");
  assert.equal((await valuation(u.user)).netFlow, "0");
  await changeHolding(
    u.user,
    u.id,
    { quantity: "0", expectedQuantity: "150", reason: "删除此持仓" },
    uid(),
    "delete",
  );
  assert.equal((await valuation(u.user)).total, "0");
  assert.equal((await valuation(u.user)).pnl, "0");
  assert.deepEqual(
    await getDb().snapshot.findFirst({ where: { userId: u.user } }),
    snapshot,
  );
  assert.equal(
    (
      { n: await getDb().audit.count({ where: { userId: u.user } }) } as {
        n: number;
      }
    ).n,
    2,
  );
  await changeHolding(
    u.user,
    u.id,
    { quantity: "20", expectedQuantity: "0", reason: "恢复持仓数量" },
    uid(),
  );
  assert.equal((await holdings(u.user))[0].quantity, "20");
  assert.equal((await valuation(u.user)).pnl, "0");
});
test("missing valuation requires explicit basis after initialization; automatic prices remain untouched", async () => {
  const u = await setup("stock-baba", "10"),
    db = getDb();
  await getDb().profile.update({
    where: { userId: u.user },
    data: {
      initialized: 1,
      baseline: "7000",
      baselineAt: "2026-01-02T00:00:00Z",
    },
  });
  const input = {
    quantity: "0",
    expectedQuantity: "10",
    reason: "删除过期持仓",
  };
  await assert.rejects(
    async () => await changeHolding(u.user, u.id, input, uid(), "delete"),
    /缺少估值依据/,
  );
  assert.equal((await holdings(u.user))[0].quantity, "10");
  await getDb().price.create({
    data: {
      id: uid(),
      instrumentId: "stock-baba",
      value: "100",
      asOf: "2026-01-01T00:00:00Z",
      source: "Test provider",
      createdAt: "2026-01-01T00:00:00Z",
    },
  });
  await getDb().fxRate.create({
    data: {
      id: uid(),
      currency: "USD",
      value: "7",
      asOf: "2026-01-01T00:00:00Z",
      source: "Test provider",
    },
  });
  await changeHolding(u.user, u.id, input, uid(), "delete");
  assert.equal((await valuation(u.user)).pnl, "0");
  assert.equal(
    (
      { n: await getDb().price.count({ where: { userId: u.user } }) } as {
        n: number;
      }
    ).n,
    0,
  );
});

test("holding endpoints enforce authentication, ownership, quantity conflicts and idempotent deletion", async () => {
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET =
    "holding-api-test-secret-only-1234567890123456789012345";
  const { app } = await import("../src/server/api");
  const origin = "http://localhost:3000";
  const signup = await app.request(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "API holding",
      email: "holding-api@example.test",
      password: "Testing123",
    }),
  });
  assert.equal(signup.status, 200);
  const user = (await signup.json()).user.id;
  const cookie = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  await ensureProfile(user);
  const accountId = (await wallets(user))[0].id;
  await recordEvent(
    user,
    eventSchema.parse({
      type: "opening",
      accountId,
      instrumentId: "cash-cny",
      quantity: "100",
      occurredAt: "2026-01-01T00:00:00Z",
    }),
    uid(),
  );
  const path = `/assets/${accountId}~cash-cny`;
  const call = (
    suffix: string,
    method: string,
    body: unknown,
    key = uid(),
    auth = cookie,
  ) =>
    app.request(`${origin}/api${suffix}`, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: auth,
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });
  const body = { quantity: "120", expectedQuantity: "100", reason: "更新数量" };
  assert.equal(
    (await call(path + "/quantity", "PATCH", body, uid(), "")).status,
    401,
  );
  const other = await setup();
  assert.equal(
    (await call(`/assets/${other.id}/quantity`, "PATCH", body)).status,
    404,
  );
  assert.equal((await call(path + "/quantity", "PATCH", body)).status, 200);
  assert.equal((await call(path + "/quantity", "PATCH", body)).status, 409);
  const key = uid(),
    removal = { expectedQuantity: "120", reason: "删除当前持仓" };
  assert.equal((await call(path, "DELETE", removal, key)).status, 200);
  assert.equal((await call(path, "DELETE", removal, key)).status, 200);
  assert.equal((await holdings(user))[0].quantity, "0");
  assert.equal(
    (
      { n: await getDb().ledgerEvent.count({ where: { userId: user } }) } as {
        n: number;
      }
    ).n,
    3,
  );
});
