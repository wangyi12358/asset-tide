"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import {
  ArrowUpRight,
  ArrowRight,
  Eye,
  EyeOff,
  ShieldCheck,
  ChartNoAxesCombined,
  Layers3,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { safeReturn } from "@/lib/format";
import { api } from "@/lib/api-client";
import { Action, Field, Notice } from "./ui";
import { Brand } from "./workspace";
type Mode = "login" | "register" | "forgot-password" | "reset-password";
export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState(params.get("email") || "");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: config } = useSWR<{ mailMode: string }>("/config", api);
  const titles = {
    login: ["欢迎回来", "登录你的资产空间，继续看见每一份积累。"],
    register: ["从清晰开始", "创建账户，为你的每一份资产找到坐标。"],
    "forgot-password": [
      "找回你的密码",
      "输入注册邮箱，我们会发送密码重置链接。",
    ],
    "reset-password": [
      "设置新的密码",
      "使用一个安全的新密码，重新进入你的空间。",
    ],
  };
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (["register", "reset-password"].includes(mode) && password !== confirm)
        throw new Error("两次输入的密码不一致");
      if (mode === "login") {
        const r = await authClient.signIn.email({
          email: email.trim().toLowerCase(),
          password,
        });
        if (r.error) throw new Error("邮箱或密码不正确，请重试。");
        router.push(safeReturn(params.get("returnTo")));
        router.refresh();
      } else if (mode === "register") {
        const r = await authClient.signUp.email({
          email: email.trim().toLowerCase(),
          password,
          name: name.trim(),
          callbackURL: "/dashboard",
        });
        if (r.error)
          throw new Error("注册未完成，请检查邮箱是否已注册，或稍后重试。");
        router.push(safeReturn(params.get("returnTo")));
        router.refresh();
      } else if (mode === "forgot-password") {
        await authClient.requestPasswordReset({
          email: email.trim().toLowerCase(),
          redirectTo: "/reset-password",
        });
        setNotice(
          "如果该邮箱已注册，你将收到一封重置邮件，请在 30 分钟内使用链接。",
        );
      } else if (mode === "reset-password") {
        const token = params.get("token");
        if (!token) throw new Error("重置链接无效，请重新申请。");
        const r = await authClient.resetPassword({
          newPassword: password,
          token,
        });
        if (r.error)
          throw new Error("链接已失效或已使用，请重新申请重置邮件。");
        setNotice("密码已重置，原登录会话已撤销。请使用新密码登录。");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const hasPassword = ["login", "register", "reset-password"].includes(mode);
  return (
    <div className="auth-page">
      <aside className="auth-story">
        <Link href="/demo">
          <Brand />
        </Link>
        <div className="auth-story-main">
          <span className="eyebrow">A CLEARER VIEW OF YOUR WEALTH</span>
          <h1>
            资产有坐标，
            <br />
            生活有底气。
          </h1>
          <p>
            从现金到股票，从黄金到数字资产。
            <br />
            汇聚每一份价值，让未来清晰可见。
          </p>
          <div className="auth-illustration" aria-hidden="true">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="orbit orbit-three" />
            <div className="orbit-center">
              <span className="brand-mark">
                <span />
                <span />
                <span />
              </span>
            </div>
            <span className="orbit-node node-a">
              <ChartNoAxesCombined />
            </span>
            <span className="orbit-node node-b">¥</span>
            <span className="orbit-node node-c">
              <Layers3 />
            </span>
            <span className="orbit-node node-d">₿</span>
          </div>
        </div>
        <div className="auth-story-footer">
          <ShieldCheck size={16} />
          <span>独立账户 · 私有记录 · 从容管理</span>
        </div>
      </aside>
      <main className="auth-main">
        <div className="auth-top">
          <span>{mode === "login" ? "还没有账户？" : "已经有账户？"}</span>
          <Link href={mode === "login" ? "/register" : "/login"}>
            {mode === "login" ? "创建账户" : "前往登录"}
            <ArrowUpRight size={15} />
          </Link>
        </div>
        <div className="auth-box">
          <div className="mobile-auth-brand">
            <Brand />
          </div>
          <span className="eyebrow">YOUR PERSONAL ASSET ATLAS</span>
          <h2>{titles[mode][0]}</h2>
          <p className="auth-description">{titles[mode][1]}</p>
          {params.get("error") && mode === "reset-password" && (
            <Notice tone="error">重置链接无效或已过期，请重新申请。</Notice>
          )}
          <form onSubmit={submit}>
            {mode === "register" && (
              <Field
                label="你的称呼"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={60}
                placeholder="如何称呼你"
              />
            )}
            {mode !== "reset-password" && (
              <Field
                label="邮箱地址"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="you@example.com"
              />
            )}
            {hasPassword && (
              <div className="password-field">
                <Field
                  label={mode === "reset-password" ? "新密码" : "密码"}
                  type={show ? "text" : "password"}
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={mode === "login" ? 1 : 8}
                  maxLength={128}
                  placeholder={
                    mode === "login" ? "输入你的密码" : "8–128 个字符"
                  }
                />
                <button
                  type="button"
                  className="icon-button password-toggle"
                  onClick={() => setShow(!show)}
                  aria-label={show ? "隐藏密码" : "显示密码"}
                >
                  {show ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            )}
            {["register", "reset-password"].includes(mode) && (
              <Field
                label="确认密码"
                type={show ? "text" : "password"}
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                placeholder="再次输入密码"
              />
            )}
            {mode === "login" && (
              <div className="auth-form-links">
                <span>安全会话，安心记录</span>
                <Link href="/forgot-password">忘记密码？</Link>
              </div>
            )}
            {error && <Notice tone="error">{error}</Notice>}
            {notice && <Notice tone="success">{notice}</Notice>}
            <Action
              type="submit"
              className="auth-submit"
              isDisabled={
                busy ||
                (config?.mailMode === "unavailable" &&
                  mode === "forgot-password")
              }
            >
              {busy
                ? "处理中…"
                : {
                    login: "进入我的资产空间",
                    register: "创建我的账户",
                    "forgot-password": "发送重置邮件",
                    "reset-password": "重置密码",
                  }[mode]}
              <ArrowRight size={17} />
            </Action>
          </form>
          {["reset-password", "forgot-password"].includes(mode) && (
            <Link href="/login" className="resend-link">
              返回登录
            </Link>
          )}
          {config?.mailMode === "local" && mode === "forgot-password" && (
            <Notice>
              本地开发模式：邮件保存在项目 data/mailbox
              目录。正式上线需配置发信服务。
            </Notice>
          )}
          {config?.mailMode === "unavailable" && mode === "forgot-password" && (
            <Notice tone="error">邮件服务尚未配置，请联系管理员。</Notice>
          )}
          <div className="auth-divider">
            <span>先认识一下 AssetAtlas</span>
          </div>
          <Link href="/demo" className="demo-link">
            探索演示空间 <ArrowUpRight size={16} />
          </Link>
        </div>
        <div className="auth-bottom">
          资产的全貌，属于你的视角。<span>© 2026 AssetAtlas</span>
        </div>
      </main>
    </div>
  );
}
