import "./database";
import test from "node:test";
import assert from "node:assert/strict";
import { getDb, uid } from "../src/server/db";
import {
  ensureProfile,
  instruments,
  wallets,
  holdings,
} from "../src/server/valuation";
import { eventSchema, recordEvent } from "../src/server/ledger";

test("an unseeded database repairs required currencies concurrently without overwriting private instruments or creating holdings", async () => {
  // The fixture normally seeds the catalog; reproduce a migrated-only Neon database.
  await getDb().instrument.deleteMany({});
  const userId = uid(),
    otherId = uid();
  for (const id of [userId, otherId]) {
    await getDb().user.create({
      data: { id, name: "Cash test", email: `${id}@example.test` },
    });
    await ensureProfile(id);
  }
  const privateAsset = await getDb().instrument.create({
    data: {
      id: uid(),
      ownerId: otherId,
      name: "Private gold",
      symbol: "PRIVATE",
      type: "gold",
      market: "manual",
      currency: "CNY",
      unit: "克",
    },
  });
  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, i) => instruments(i % 2 ? userId : otherId)),
  );
  for (const items of responses) {
    assert.deepEqual(
      items
        .filter((i) => i.type === "cash")
        .map((i) => i.currency)
        .sort(),
      ["CNY", "HKD", "USD"],
    );
  }
  assert.equal(
    await getDb().instrument.count({ where: { type: "cash", ownerId: null } }),
    3,
  );
  assert.equal(
    await getDb().instrument.count(),
    5,
    "include physical gold but do not seed optional stocks or crypto",
  );
  assert.equal(
    (await instruments(userId)).some((i) => i.id === privateAsset.id),
    false,
  );
  assert.deepEqual(
    await getDb().instrument.findUnique({ where: { id: privateAsset.id } }),
    privateAsset,
  );
  assert.equal(
    await getDb().ledgerEvent.count(),
    0,
    "currency catalog does not create balances",
  );

  await getDb().instrument.update({
    where: { id: "cash-usd" },
    data: { name: "美元（已有名称）" },
  });
  await getDb().instrument.delete({ where: { id: "cash-hkd" } });
  const repaired = await instruments(userId);
  assert.equal(
    repaired.find((i) => i.id === "cash-usd")!.name,
    "美元（已有名称）",
  );
  assert.equal(repaired.find((i) => i.id === "cash-hkd")!.currency, "HKD");

  await recordEvent(
    userId,
    eventSchema.parse({
      type: "opening",
      accountId: (await wallets(userId))[0].id,
      instrumentId: "cash-cny",
      quantity: "100",
      occurredAt: new Date().toISOString(),
    }),
    uid(),
  );
  assert.equal((await holdings(userId))[0].value, "100");
});
