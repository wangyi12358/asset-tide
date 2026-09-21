import { existsSync } from "node:fs";
import { backup } from "../src/server/backup";
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--env-file")) {
  console.error("用法：pnpm db:backup [--env-file .env.backup]");
  process.exit(1);
}
if (args[1]) {
  process.loadEnvFile(args[1]);
  if (!process.env.DIRECT_URL && !process.env.DATABASE_URL) {
    console.error("备份配置必须包含 DIRECT_URL 或 DATABASE_URL");
    process.exit(1);
  }
} else if (existsSync(".env.local")) process.loadEnvFile(".env.local");
backup()
  .then((path) => console.log(`备份已保存：${path}`))
  .catch(() => {
    console.error("备份失败");
    process.exitCode = 1;
  });
