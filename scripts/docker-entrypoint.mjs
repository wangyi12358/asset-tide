// Fail early with actionable errors, never print secret values.
import { accessSync, constants } from "node:fs";
try {
  if ((process.env.BETTER_AUTH_SECRET || "").length < 32)
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
  const url = new URL(process.env.BETTER_AUTH_URL || "");
  if (url.pathname !== "/" || url.search || url.hash)
    throw new Error(
      "BETTER_AUTH_URL must be a site origin without a path, query or fragment.",
    );
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error(
      "Use an HTTPS BETTER_AUTH_URL for remote access; HTTP is supported only for local testing.",
    );
  const database = new URL(process.env.DATABASE_URL || "");
  if (!["postgresql:", "postgres:"].includes(database.protocol))
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL.");
  accessSync(process.env.BACKUP_PATH, constants.W_OK);
} catch (error) {
  console.error("AssetAtlas startup configuration error:", error.message);
  process.exit(1);
}
await import("./server.js");
