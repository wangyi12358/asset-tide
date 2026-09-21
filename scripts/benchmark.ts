// Isolated benchmark uses the same disposable PostgreSQL schema as integration tests.
import "../tests/database";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { getDb, transaction, uid } from "../src/server/db";
import { ensureProfile, valuation, wallets } from "../src/server/valuation";
test("valuation benchmark", async () => {
  const id = uid(),
    timestamp = "2026-01-01T00:00:00.000Z";
  await getDb().user.create({
    data: { id, name: "Benchmark", email: `${id}@example.test` },
  });
  await ensureProfile(id);
  const accountId = (await wallets(id))[0].id;
  await transaction(async () => {
    for (let i = 0; i < 200; i++) {
      const instrumentId = `benchmark-${i}`;
      await getDb().instrument.create({
        data: {
          id: instrumentId,
          ownerId: id,
          name: `Benchmark ${i}`,
          symbol: `B${i}`,
          type: "stock",
          market: "TEST",
          currency: "CNY",
          unit: "股",
        },
      });
      await getDb().price.create({
        data: {
          id: uid(),
          instrumentId,
          userId: id,
          value: "10",
          asOf: timestamp,
          source: "fixture",
          manual: 1,
          createdAt: timestamp,
        },
      });
      const events = Array.from({ length: 50 }, () => ({
        id: uid(),
        userId: id,
        type: "opening",
        occurredAt: timestamp,
        createdAt: timestamp,
        note: "benchmark",
        idempotencyKey: uid(),
        payload: "{}",
      }));
      await getDb().ledgerEvent.createMany({ data: events });
      await getDb().leg.createMany({
        data: events.map((e) => ({
          id: uid(),
          eventId: e.id,
          accountId,
          instrumentId,
          quantity: "1",
        })),
      });
    }
  }, id);
  const times: number[] = [];
  for (let n = 0; n < 30; n++) {
    const start = performance.now();
    if ((await valuation(id)).total !== "100000") throw Error("Wrong total");
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      scope: "valuation + local PostgreSQL",
      holdings: 200,
      events: 10000,
      runs: 30,
      p50Ms: times[14],
      p95Ms: times[28],
    }),
  );
});
