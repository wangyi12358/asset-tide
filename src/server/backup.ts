import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
const execute = promisify(execFile);
export function pgBinary(name: "pg_dump" | "pg_restore") {
  const override =
    process.env[name === "pg_dump" ? "PG_DUMP_PATH" : "PG_RESTORE_PATH"];
  return (
    override ||
    [
      `/opt/homebrew/opt/libpq/bin/${name}`,
      `/Library/PostgreSQL/14/bin/${name}`,
    ].find(existsSync) ||
    name
  );
}
export async function backup() {
  const url = new URL(
    process.env.DIRECT_URL ||
      process.env.DATABASE_URL ||
      "postgresql://postgres:postgres@127.0.0.1:5432/asset_atlas",
  );
  const dir = resolve(process.env.BACKUP_PATH || "backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = resolve(
    dir,
    `asset-atlas-${new Date().toISOString().slice(0, 10)}.dump`,
  );
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const schema = url.searchParams.get("schema");
  url.searchParams.delete("schema");
  const password = decodeURIComponent(url.password);
  url.password = "";
  try {
    await execute(
      pgBinary("pg_dump"),
      [
        "--dbname",
        url.toString(),
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--file",
        temporary,
        ...(schema ? ["--schema", schema] : []),
      ],
      { env: { ...process.env, PGPASSWORD: password }, timeout: 300000 },
    );
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    const files = readdirSync(dir)
      .filter((f) => /^asset-atlas-\d{4}-\d{2}-\d{2}\.dump$/.test(f))
      .sort()
      .reverse();
    files.slice(30).forEach((f) => rmSync(resolve(dir, f)));
    return path;
  } catch {
    rmSync(temporary, { force: true });
    throw new Error(
      "PostgreSQL 备份失败，请检查 pg_dump 版本、数据库连接和备份目录权限",
    );
  }
}
