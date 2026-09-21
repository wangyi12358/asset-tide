export function schedulerEnabled() {
  // Vercel instances are request-bound, even if ENABLE_SCHEDULER was copied from Docker.
  return process.env.VERCEL !== "1" && process.env.ENABLE_SCHEDULER !== "false";
}
