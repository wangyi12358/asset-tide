import "./database";
import test from "node:test";
import assert from "node:assert/strict";
import { getDb, uid } from "../src/server/db";
import {
  D,
  ensureProfile,
  history,
  holdings,
  investmentPnl,
  profile,
  saveSnapshot,
  toCny,
  valuation,
  wallets,
} from "../src/server/valuation";
import {
  eventSchema,
  finalize,
  recordEvent,
  voidEvent,
} from "../src/server/ledger";
process.env.ENABLE_SCHEDULER = "false";
const start = "2026-01-01T00:00:00.000Z";
const next = "2026-01-02T00:00:00.000Z";
async function user() {
  const id = uid();
  await getDb().user.create({
    data: {
      id: id,
      name: "Test",
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  await ensureProfile(id);
  return { id, account: (await wallets(id))[0].id };
}
async function event(
  u: Awaited<ReturnType<typeof user>>,
  input: Record<string, unknown>,
  key = uid(),
) {
  return await recordEvent(
    u.id,
    eventSchema.parse({
      type: "opening",
      accountId: u.account,
      instrumentId: "cash-cny",
      quantity: "100000",
      occurredAt: start,
      ...input,
    }),
    key,
  );
}
async function baseline(u: Awaited<ReturnType<typeof user>>) {
  await finalize(u.id);
  await getDb().snapshot.deleteMany({ where: { userId: u.id } });
  await getDb().profile.update({
    where: { userId: u.id },
    data: { baselineAt: start },
  });
  await saveSnapshot(u.id, start);
}
test("A04/A05: USD cash and shares use exact CNY conversion", () => {
  assert.equal(toCny("1000", "1", "7.2"), "7200");
  assert.equal(toCny("10", "200", "7.2"), "14400");
  assert.equal(toCny("0.1", "0.2", "0.3"), "0.006");
});
test("gold purity and troy ounces have explicit units", () => {
  assert.equal(toCny("31.1034768", "2000", "7.2", "1", "oz"), "14400");
  assert.equal(toCny("100", "500", "1", "0.9999"), "49995");
});
test("A06: deposits are not investment gains", async () => {
  assert.equal(investmentPnl("112000", "100000", "10000"), "2000");
  const u = await user();
  await event(u, {});
  await baseline(u);
  await event(u, {
    type: "deposit",
    quantity: "10000",
    occurredAt: next,
    note: "银行转账回单",
  });
  assert.equal((await valuation(u.id)).total, "110000");
  assert.equal((await valuation(u.id)).pnl, "0");
});
test("A07: internal transfer leaves total and external flow unchanged", async () => {
  const u = await user();
  await event(u, {});
  await baseline(u);
  const target = uid();
  await getDb().wallet.create({
    data: { id: target, userId: u.id, name: "另一账户", type: "银行" },
  });
  await event(u, {
    type: "transfer",
    targetAccountId: target,
    quantity: "30000",
    occurredAt: next,
  });
  assert.equal((await valuation(u.id)).total, "100000");
  assert.equal((await valuation(u.id)).netFlow, "0");
  assert.equal(
    (await holdings(u.id)).find((h) => h.accountId === target)?.quantity,
    "30000",
  );
});
test("A08/A14/A15: buys atomically deduct cash and fees; idempotency and overdraft protection", async () => {
  const u = await user();
  await event(u, { instrumentId: "cash-usd", quantity: "1000", fx: "7.2" });
  await baseline(u);
  const key = uid();
  const input = {
    type: "buy",
    instrumentId: "stock-aapl",
    quantity: "2",
    price: "200",
    fee: "10",
    fx: "7.2",
    occurredAt: next,
  };
  const e = await event(u, input, key);
  assert.equal((await event(u, input, key)).id, e.id);
  assert.equal((await valuation(u.id)).total, "7128");
  assert.equal((await valuation(u.id)).pnl, "-72");
  assert.equal(
    (await holdings(u.id)).find((h) => h.id === "cash-usd")?.quantity,
    "590",
  );
  await assert.rejects(
    async () => await event(u, { ...input, quantity: "999" }),
    /不足/,
  );
  await assert.rejects(
    async () => await event(u, { ...input, type: "sell", quantity: "3" }),
    /不足/,
  );
  assert.equal(
    (await holdings(u.id)).find((h) => h.id === "stock-aapl")?.quantity,
    "2",
  );
  await assert.rejects(
    async () => await event(u, { ...input, quantity: "1" }, key),
    /幂等/,
  );
});
test("A09/A11: missing quotes never become zero or fake historical points", async () => {
  const u = await user();
  await event(u, { instrumentId: "stock-aapl", quantity: "10" });
  const v = await valuation(u.id);
  assert.equal(v.complete, false);
  assert.equal(v.items[0].value, null);
  assert.equal(v.pnl, null);
  assert.equal((await history(u.id)).length, 0);
  await assert.rejects(async () => await finalize(u.id), /补齐/);
});
test("A12: correction keeps audit and revises historical snapshots", async () => {
  const u = await user();
  await event(u, {});
  await baseline(u);
  const e = await event(u, {
    type: "deposit",
    quantity: "1000",
    occurredAt: next,
    note: "外部转入依据",
  });
  await saveSnapshot(u.id, next);
  const body = eventSchema.parse({
    type: "deposit",
    accountId: u.account,
    instrumentId: "cash-cny",
    quantity: "2000",
    occurredAt: next,
    note: "修正外部转入金额",
  });
  await recordEvent(u.id, body, uid(), e.id);
  const snapshot = (await history(u.id)).at(-1)!;
  assert.equal(snapshot.total, "102000");
  assert.equal(snapshot.pnl, "0");
  assert.equal(snapshot.version, 2);
  assert.ok(
    await getDb().audit.findFirst({
      where: { userId: u.id, action: "event.replace" },
    }),
  );
});
test("A16: stock split changes quantity and price without manufacturing profit", async () => {
  const u = await user();
  await event(u, {
    instrumentId: "stock-aapl",
    quantity: "10",
    price: "200",
    fx: "7.2",
  });
  await baseline(u);
  await event(u, {
    type: "split",
    instrumentId: "stock-aapl",
    quantity: "10",
    price: "100",
    occurredAt: next,
    note: "2:1 拆股公告",
  });
  assert.equal((await valuation(u.id)).total, "14400");
  assert.equal((await valuation(u.id)).pnl, "0");
});
test("A17: historical snapshots never use future FX quotes", async () => {
  const u = await user();
  await event(u, { instrumentId: "cash-usd", quantity: "1000", fx: "7.2" });
  await baseline(u);
  await getDb().fxRate.create({
    data: {
      id: uid(),
      currency: "USD",
      userId: u.id,
      value: "7.5",
      asOf: next,
      source: "测试",
    },
  });
  assert.equal((await valuation(u.id, start)).total, "7200");
  assert.equal((await valuation(u.id, next)).total, "7500");
  assert.equal((await valuation(u.id, next)).pnl, "300");
});
test("A03: accounts and manual quotes cannot cross users", async () => {
  const a = await user();
  const b = await user();
  await event(a, {
    instrumentId: "stock-aapl",
    quantity: "1",
    price: "200",
    fx: "7.2",
  });
  await event(b, { instrumentId: "stock-aapl", quantity: "1" });
  assert.equal((await valuation(b.id)).complete, false);
  await assert.rejects(
    async () => await event(b, { accountId: a.account }),
    /账户不存在/,
  );
  assert.equal((await holdings(a.id)).length, 1);
});
test("revoke is atomic and rejected if subsequent balances would go negative", async () => {
  const u = await user();
  await event(u, { quantity: "1000" });
  await baseline(u);
  const deposit = await event(u, {
    type: "deposit",
    quantity: "500",
    occurredAt: next,
    note: "银行回单",
  });
  await event(u, {
    type: "withdrawal",
    quantity: "1400",
    occurredAt: "2026-01-03T00:00:00.000Z",
    note: "银行回单",
  });
  await assert.rejects(
    async () => await voidEvent(u.id, deposit.id, "录入错误"),
    /不足/,
  );
  assert.equal((await valuation(u.id)).total, "100");
});
test("adjustment changes baseline attribution, not profit", async () => {
  const u = await user();
  await event(u, {});
  await baseline(u);
  await event(u, {
    type: "adjustment",
    quantity: "1000",
    occurredAt: next,
    note: "遗漏现金修正",
  });
  assert.equal((await valuation(u.id)).total, "101000");
  assert.equal((await valuation(u.id)).pnl, "0");
  assert.equal((await valuation(u.id)).netFlow, "0");
});
test("FX conversion conserves accounting and fees reduce profit", async () => {
  const u = await user();
  await event(u, { quantity: "7200" });
  await baseline(u);
  await event(u, {
    type: "exchange",
    quantity: "7200",
    targetInstrumentId: "cash-usd",
    receivedQuantity: "1000",
    occurredAt: next,
  });
  assert.equal((await valuation(u.id)).complete, false);
  await getDb().fxRate.create({
    data: {
      id: uid(),
      currency: "USD",
      userId: u.id,
      value: "7.2",
      asOf: next,
      source: "测试",
    },
  });
  assert.equal((await valuation(u.id)).pnl, "0");
});
test("daily snapshot is idempotent", async () => {
  const u = await user();
  await event(u, {});
  await baseline(u);
  await saveSnapshot(u.id, next);
  await saveSnapshot(u.id, next);
  assert.equal((await history(u.id)).length, 2);
  assert.equal((await history(u.id)).at(-1)?.version, 1);
});
test("voiding a split also removes its linked price from valuation", async () => {
  const u = await user();
  await event(u, {
    instrumentId: "stock-aapl",
    quantity: "10",
    price: "200",
    fx: "7.2",
  });
  await baseline(u);
  const e = await event(u, {
    type: "split",
    instrumentId: "stock-aapl",
    quantity: "10",
    price: "100",
    occurredAt: next,
    note: "拆股记录",
  });
  await voidEvent(u.id, e.id, "撤销误记拆股");
  assert.equal((await valuation(u.id)).total, "14400");
  assert.equal((await valuation(u.id)).pnl, "0");
});

test("original-currency value remains available when FX is missing", async () => {
  const u = await user();
  await event(u, { instrumentId: "stock-aapl", quantity: "10", price: "200" });
  const h = (await holdings(u.id))[0];
  assert.equal(h.originalValue, "2000");
  assert.equal(h.value, null);
  assert.equal(h.fx, null);
  assert.equal((await valuation(u.id)).pnl, null);
});
