import { existsSync } from "node:fs";
import { prisma } from "../src/server/db";
import { catalog } from "../src/server/catalog";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
async function main() {
  await prisma().instrument.createMany({ data: catalog, skipDuplicates: true });
  console.log("Default instruments ready");
}
main().finally(() => prisma().$disconnect());
