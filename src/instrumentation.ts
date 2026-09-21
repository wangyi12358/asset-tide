export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build" &&
    process.env.VERCEL !== "1" &&
    process.env.ENABLE_SCHEDULER !== "false"
  ) {
    const { startScheduler } = await import("./server/jobs");
    startScheduler();
  }
}
