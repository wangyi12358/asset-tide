import { timingSafeEqual } from "node:crypto";
import { runDailySnapshots } from "@/server/daily-snapshots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  const secret = process.env.CRON_SECRET;
  const supplied = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret || ""}`);
  if (
    !secret ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  if (process.env.VERCEL === "1" && process.env.VERCEL_ENV !== "production") {
    return Response.json(
      { error: "每日任务仅在生产部署执行" },
      { status: 403, headers },
    );
  }
  try {
    const result = await runDailySnapshots();
    return Response.json(result, {
      status: result.pending ? 503 : 200,
      headers,
    });
  } catch {
    return Response.json(
      { error: "每日快照失败，请查看任务状态并重试" },
      { status: 500, headers },
    );
  }
}

// Next otherwise maps HEAD to GET; probes must never execute a job.
export function HEAD() {
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET", "Cache-Control": "no-store" },
  });
}
