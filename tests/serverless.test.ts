import "./database";
import test from "node:test";
import assert from "node:assert/strict";
import { getDb, uid } from "../src/server/db";
import { ensureProfile, wallets } from "../src/server/valuation";
import { eventSchema, recordEvent } from "../src/server/ledger";
import { runDailySnapshots } from "../src/server/daily-snapshots";
import { refreshOnDemand } from "../src/server/refresh";
import { consumeMcpLimit } from "../src/server/rate-limit";
import { schedulerEnabled } from "../src/server/runtime";
import { GET, HEAD } from "../src/app/api/cron/daily/route";

process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET = "serverless-tests-secret-12345678901234567890";

async function makeUser() {
  const id = uid();
  await getDb().user.create({
    data: { id, name: "Serverless", email: `${id}@example.test` },
  });
  await ensureProfile(id);
  return id;
}

test("Vercel never starts an interval, and cron rejects missing secrets, previews and HEAD", async () => {
  const prior = {
    vercel: process.env.VERCEL,
    env: process.env.VERCEL_ENV,
    scheduler: process.env.ENABLE_SCHEDULER,
    secret: process.env.CRON_SECRET,
  };
  try {
    process.env.VERCEL = "1";
    process.env.ENABLE_SCHEDULER = "true";
    assert.equal(schedulerEnabled(), false);
    const { startScheduler } = await import("../src/server/jobs");
    startScheduler();
    assert.equal(
      (globalThis as unknown as { atlasTimer?: unknown }).atlasTimer,
      undefined,
    );
    delete process.env.CRON_SECRET;
    const req = (token = "undefined") =>
      new Request("http://localhost/api/cron/daily", {
        headers: { Authorization: `Bearer ${token}` },
      });
    assert.equal((await GET(req())).status, 401);
    process.env.CRON_SECRET = "cron-tests-secret";
    assert.equal((await GET(req("wrong"))).status, 401);
    process.env.VERCEL_ENV = "preview";
    assert.equal((await GET(req("cron-tests-secret"))).status, 403);
    assert.equal(HEAD().status, 405);
    process.env.VERCEL_ENV = "production";
    const result = await GET(req("cron-tests-secret"));
    assert.equal(result.status, 200);
    assert.match(result.headers.get("Cache-Control")!, /no-store/);
    assert.equal(await getDb().job.count({ where: { name: "backup" } }), 0);
  } finally {
    for (const [key, value] of Object.entries({
      VERCEL: prior.vercel,
      VERCEL_ENV: prior.env,
      ENABLE_SCHEDULER: prior.scheduler,
      CRON_SECRET: prior.secret,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("concurrent daily jobs catch up once, exclude future FX and preserve missing historical prices", async () => {
  const userId = await makeUser();
  const boundary = new Date();
  boundary.setUTCHours(0, 0, 0, 0);
  const baseline = new Date(boundary.getTime() - 2 * 86400_000).toISOString();
  const accountId = (await wallets(userId))[0].id;
  await recordEvent(
    userId,
    eventSchema.parse({
      type: "opening",
      accountId,
      instrumentId: "cash-usd",
      quantity: "100",
      occurredAt: baseline,
    }),
    uid(),
  );
  await getDb().profile.update({
    where: { userId },
    data: { initialized: 1, baselineAt: baseline, baseline: "700" },
  });
  // Only a quote after today's boundary exists: it must not fill historical gaps.
  await getDb().fxRate.create({
    data: {
      id: uid(),
      userId,
      currency: "USD",
      value: "7",
      asOf: new Date(boundary.getTime() + 60_000).toISOString(),
      source: "test future quote",
    },
  });
  const results = await Promise.all([runDailySnapshots(), runDailySnapshots()]);
  assert.ok(results.every((r) => !r.pending));
  const snapshots = await getDb().snapshot.findMany({
    where: { userId },
    orderBy: { asOf: "asc" },
  });
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots.at(-1)!.asOf, boundary.toISOString());
  assert.ok(snapshots.every((s) => s.complete === 0 && s.version === 1));
  assert.equal((await runDailySnapshots()).created, 0);
  assert.equal(
    await getDb().audit.count({
      where: { userId, action: "snapshot.revision" },
    }),
    0,
  );
  assert.equal(await getDb().job.count({ where: { name: "backup" } }), 0);
});

test("daily catch-up reports partial progress and can resume from committed checkpoints", async () => {
  const userId = await makeUser();
  const boundary = new Date();
  boundary.setUTCHours(0, 0, 0, 0);
  await getDb().profile.update({
    where: { userId },
    data: {
      initialized: 1,
      baselineAt: new Date(boundary.getTime() - 86400_000).toISOString(),
      baseline: "0",
    },
  });
  const partial = await runDailySnapshots(Date.now() - 1);
  assert.equal(partial.pending, true);
  assert.match(
    (
      await getDb().job.findUniqueOrThrow({
        where: { name: "daily-snapshots" },
      })
    ).lastError!,
    /尚未补齐/,
  );
  assert.equal((await runDailySnapshots()).pending, false);
  assert.equal(await getDb().snapshot.count({ where: { userId } }), 1);
  assert.equal(
    (
      await getDb().job.findUniqueOrThrow({
        where: { name: "daily-snapshots" },
      })
    ).lastError,
    null,
  );
});

test("automatic refresh has a shared 15-minute cooldown while manual refresh permits 60 seconds", async () => {
  const userId = await makeUser();
  const results = await Promise.all(
    Array.from({ length: 6 }, () => refreshOnDemand(userId, "auto")),
  );
  assert.equal(results.filter((r) => !r.skipped).length, 1);
  await getDb().profile.update({
    where: { userId },
    data: { lastRefresh: new Date(Date.now() - 120_000).toISOString() },
  });
  assert.equal((await refreshOnDemand(userId, "auto")).skipped, true);
  assert.equal((await refreshOnDemand(userId, "manual")).skipped, false);
  assert.equal((await refreshOnDemand(userId, "manual")).skipped, true);
  await getDb().profile.update({
    where: { userId },
    data: { lastRefresh: new Date(Date.now() - 16 * 60_000).toISOString() },
  });
  assert.equal((await refreshOnDemand(userId, "auto")).skipped, false);
});

test("MCP rate limiting is atomic in the database and resets after expiry", async () => {
  const tokenId = uid(),
    key = `mcp:${tokenId}`;
  await getDb().rateLimit.create({
    data: { id: uid(), key, count: 119, lastRequest: BigInt(Date.now()) },
  });
  const allowed = await Promise.all(
    Array.from({ length: 5 }, () => consumeMcpLimit(tokenId)),
  );
  assert.equal(allowed.filter(Boolean).length, 1);
  await getDb().rateLimit.update({
    where: { key },
    data: { lastRequest: BigInt(Date.now() - 61_000) },
  });
  assert.equal(await consumeMcpLimit(tokenId), true);
});

test("login rate limits persist across independently created auth instances", async () => {
  const { auth } = await import("../src/server/auth");
  const { betterAuth } = await import("better-auth");
  const other = betterAuth(auth.options);
  const request = () =>
    new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
        "x-forwarded-for": "192.0.2.42",
      },
      body: JSON.stringify({
        email: "missing@example.test",
        password: "Testing123",
      }),
    });
  for (let i = 0; i < 5; i++)
    assert.equal((await auth.handler(request())).status, 401);
  assert.equal((await other.handler(request())).status, 429);
  assert.ok(
    await getDb().rateLimit.count({
      where: { key: { contains: "192.0.2.42" } },
    }),
  );
});
