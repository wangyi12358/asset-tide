import { betterAuth } from "better-auth";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma, uid } from "./db";

function secret() {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
  if (
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  )
    throw new Error("生产环境必须设置 BETTER_AUTH_SECRET");
  const path = resolve("data/.dev-secret");
  mkdirSync(resolve("data"), { recursive: true });
  if (!existsSync(path))
    writeFileSync(path, randomBytes(48).toString("base64"), { mode: 0o600 });
  return readFileSync(path, "utf8");
}
async function sendMail(to: string, url: string) {
  const title = "重置 AssetAtlas 密码";
  if (process.env.RESEND_API_KEY) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: [to],
        subject: title,
        text: `${title}\n\n请打开以下链接：\n${url}\n\n如果不是你发起的操作，请忽略此邮件。`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("邮件发送失败，请稍后重试");
  } else {
    if (process.env.NODE_ENV === "production")
      throw new Error("邮件服务尚未配置");
    mkdirSync(resolve("data/mailbox"), { recursive: true, mode: 0o700 });
    writeFileSync(
      resolve(`data/mailbox/${Date.now()}-${uid()}.json`),
      JSON.stringify({ to, title, url, kind: "reset" }, null, 2),
      { mode: 0o600 },
    );
  }
}
export const auth = betterAuth({
  appName: "AssetAtlas",
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  secret: secret(),
  database: prismaAdapter(prisma(), { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    requireEmailVerification: false,
    autoSignIn: true,
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 1800,
    sendResetPassword: async ({ user, url }) => sendMail(user.email, url),
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 12,
    freshAge: 60 * 10,
  },
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 30,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 3 },
      "/request-password-reset": { window: 60, max: 3 },
    },
  },
  advanced: {
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  },
});
