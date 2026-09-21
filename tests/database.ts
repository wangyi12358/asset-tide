import { before, after } from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { Client } from "pg";
import { parseEnv } from "node:util";
import { prisma } from "../src/server/db";
import { catalog } from "../src/server/catalog";
// Load only local client paths; tests never inherit production database/provider secrets.
if (existsSync(".env.local")) {
  const local = parseEnv(readFileSync(".env.local", "utf8"));
  for (const key of ["PG_DUMP_PATH", "PG_RESTORE_PATH"])
    if (!process.env[key] && local[key]) process.env[key] = local[key];
}
const url = new URL(
  process.env.TEST_DATABASE_URL ||
    "postgresql://postgres:postgres@127.0.0.1:5432/asset_atlas_test",
);
if (!url.pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must use a database ending in _test");
export const testSchema = `test_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
url.searchParams.delete("schema");
export const testConnection = url.toString();
url.searchParams.set("schema", testSchema);
process.env.DATABASE_URL = url.toString();
delete process.env.DIRECT_URL;
process.env.ENABLE_SCHEDULER = "false";
before(async () => {
  const client = new Client({ connectionString: testConnection });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${testSchema}"`);
    await client.query(`SET search_path TO "${testSchema}"`);
    for (const entry of readdirSync("prisma/migrations", {
      withFileTypes: true,
    })
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      await client.query(
        readFileSync(
          `prisma/migrations/${entry.name}/migration.sql`,
          "utf8",
        ).replace('CREATE SCHEMA IF NOT EXISTS "public";', ""),
      );
    }
  } finally {
    await client.end();
  }
  await prisma().instrument.createMany({ data: catalog, skipDuplicates: true });
});
after(async () => {
  await prisma().$disconnect();
  const client = new Client({ connectionString: testConnection });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
  } finally {
    await client.end();
  }
});
