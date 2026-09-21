import { getDb, now, transaction } from "./db";
import { saveSnapshot } from "./valuation";

export async function runDailySnapshots(deadline = Date.now() + 210_000) {
  // A delayed invocation must still value the portfolio at 08:00 Asia/Shanghai.
  const boundary = new Date();
  boundary.setUTCHours(0, 0, 0, 0);
  let created = 0;
  let pending = false;
  try {
    await getDb().rateLimit.deleteMany({
      where: { lastRequest: { lt: BigInt(Date.now() - 86400_000) } },
    });
    await getDb().usedVerificationToken.deleteMany({
      where: {
        consumedAt: { lt: new Date(Date.now() - 30 * 86400_000).toISOString() },
      },
    });
    const profiles = await getDb().profile.findMany({
      where: { initialized: 1, baselineAt: { not: null } },
      orderBy: { userId: "asc" },
    });
    for (const user of profiles) {
      if (Date.now() >= deadline) {
        pending = true;
        break;
      }
      let caughtUp = false;
      for (let n = 0; n < 90; n++) {
        if (Date.now() >= deadline) break;
        // Read the checkpoint under the same lock as the write. Concurrent cron
        // requests and financial mutations cannot race the snapshot calculation.
        const saved = await transaction(async () => {
          const last = await getDb().snapshot.aggregate({
            where: { userId: user.userId },
            _max: { asOf: true },
          });
          const start = new Date(last._max.asOf || user.baselineAt!);
          start.setUTCHours(0, 0, 0, 0);
          start.setUTCDate(start.getUTCDate() + 1);
          if (start > boundary) return false;
          await saveSnapshot(user.userId, start.toISOString());
          return true;
        }, user.userId);
        if (!saved) {
          caughtUp = true;
          break;
        }
        created++;
      }
      if (!caughtUp) {
        const latest = await getDb().snapshot.aggregate({
          where: { userId: user.userId },
          _max: { asOf: true },
        });
        pending ||=
          !latest._max.asOf || latest._max.asOf < boundary.toISOString();
      }
    }
    const lastError = pending ? "历史快照尚未补齐，请再次执行每日任务" : null;
    const status = pending ? { lastError } : { lastSuccess: now(), lastError };
    await getDb().job.upsert({
      where: { name: "daily-snapshots" },
      create: { name: "daily-snapshots", ...status },
      update: status,
    });
    return { created, pending, boundary: boundary.toISOString() };
  } catch (error) {
    await getDb().job.upsert({
      where: { name: "daily-snapshots" },
      create: {
        name: "daily-snapshots",
        lastError: `每日快照失败 ${now()}，请重试`,
      },
      update: { lastError: `每日快照失败 ${now()}，请重试` },
    });
    throw error;
  }
}
