import { getDb, now } from "./db";
import { runDailySnapshots } from "./daily-snapshots";
import { schedulerEnabled } from "./runtime";
import { refreshMarket } from "./market";
import { backup } from "./backup";
export { backup } from "./backup";
const globalJobs = globalThis as unknown as {
  atlasTimer?: ReturnType<typeof setInterval>;
  atlasRunning?: boolean;
  atlasMarketAt?: number;
};
export async function tick() {
  if (globalJobs.atlasRunning) return;
  globalJobs.atlasRunning = true;
  try {
    const profiles = (await getDb().profile.findMany({})) as {
      userId: string;
      baselineAt: string | null;
      initialized: number;
    }[];
    if (
      !globalJobs.atlasMarketAt ||
      Date.now() - globalJobs.atlasMarketAt >= 15 * 60_000
    ) {
      globalJobs.atlasMarketAt = Date.now();
      let failures = 0;
      for (const user of profiles)
        failures += (await refreshMarket(user.userId)).warnings.length;
      await getDb().job.upsert({
        where: { name: "market" },
        create: {
          name: "market",
          lastSuccess: now(),
          lastError: failures
            ? `${failures} 项行情未更新，请在资产总览刷新查看具体原因`
            : null,
        },
        update: {
          lastSuccess: now(),
          lastError: failures
            ? `${failures} 项行情未更新，请在资产总览刷新查看具体原因`
            : null,
        },
      });
    }
    await runDailySnapshots();
    if (profiles.length) {
      const lastBackup = (await getDb().job.findFirst({
        where: { name: "backup" },
      })) as { lastSuccess: string } | undefined;
      if (lastBackup?.lastSuccess.slice(0, 10) !== now().slice(0, 10)) {
        await backup();
        await getDb().job.upsert({
          where: { name: "backup" },
          create: { name: "backup", lastSuccess: now() },
          update: { lastSuccess: now(), lastError: null },
        });
      }
    }
    await getDb().job.upsert({
      where: { name: "scheduler" },
      create: { name: "scheduler", lastSuccess: now() },
      update: { lastSuccess: now(), lastError: null },
    });
  } catch {
    await getDb().job.upsert({
      where: { name: "scheduler" },
      create: {
        name: "scheduler",
        lastError: `任务失败 ${now()}，等待下一分钟重试`,
      },
      update: { lastError: `任务失败 ${now()}，等待下一分钟重试` },
    });
  } finally {
    globalJobs.atlasRunning = false;
  }
}
export function startScheduler() {
  if (!schedulerEnabled() || globalJobs.atlasTimer) return;
  globalJobs.atlasTimer = setInterval(() => void tick(), 60_000);
  globalJobs.atlasTimer.unref();
  void tick();
}
