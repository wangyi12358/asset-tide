"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  LayoutDashboard,
  Wallet,
  ArrowLeftRight,
  Settings2,
  Users,
  Search,
  Eye,
  EyeOff,
  ArrowUpRight,
  LogOut,
  Leaf,
  ChevronDown,
  ShieldCheck,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { authClient } from "@/lib/auth-client";
import { demoPortfolio } from "@/lib/demo";
import { money } from "@/lib/format";
import type { Portfolio } from "@/lib/types";
import { Notice, Skeleton } from "./ui";
interface WorkspaceContext {
  data: Portfolio;
  demo: boolean;
  hidden: boolean;
  amount: (v: string | number | null | undefined, signed?: boolean) => string;
  href: (path: string) => string;
  reload: () => Promise<unknown>;
  notify: (message: string) => void;
}
const Context = createContext<WorkspaceContext | null>(null);
export function useWorkspace() {
  const c = useContext(Context);
  if (!c) throw new Error("Workspace context missing");
  return c;
}
export function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <span />
        <span />
        <span />
      </span>
      <span>
        Asset<span className="brand-light">Atlas</span>
        <small>你的资产，全局在握</small>
      </span>
    </span>
  );
}
const nav = [
  { href: "/dashboard", label: "资产总览", icon: LayoutDashboard },
  { href: "/assets", label: "我的资产", icon: Wallet },
  { href: "/shared", label: "共同资产", icon: Users },
  { href: "/transactions", label: "资金流水", icon: ArrowLeftRight },
  { href: "/settings", label: "账户与设置", icon: Settings2 },
];
export function Workspace({
  children,
  demo = false,
}: {
  children: ReactNode;
  demo?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [hidden, setHidden] = useState(false);
  const [search, setSearch] = useState("");
  const [logoutError, setLogoutError] = useState("");
  const [message, setMessage] = useState("");
  const { data, error, mutate } = useSWR<Portfolio>(
    demo ? null : "/portfolio",
    api,
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const portfolio = demo ? demoPortfolio : data;
  const { mutate: mutateCache } = useSWRConfig();
  const hasGold = !!portfolio?.holdings.some(
    (h) => h.type === "gold" && h.unit === "克" && Number(h.quantity) > 0,
  );
  // Gold refreshes every minute while visible; other portfolios refresh on focus.
  // The server shares the cooldown across tabs and instances.
  useEffect(() => {
    if (demo) return;
    let active = true;
    let refreshing = false;
    async function refreshIfNeeded() {
      if (document.visibilityState !== "visible" || refreshing) return;
      refreshing = true;
      try {
        const result = await api<{ skipped: boolean; warnings: string[] }>(
          "/refresh",
          { mode: "auto" },
        );
        if (active) {
          await mutate();
          if (!result.skipped)
            await mutateCache(
              (key) => typeof key === "string" && key.startsWith("/assets/"),
            );
          if (active && result.warnings.length)
            setMessage(result.warnings.join("；"));
        }
      } catch (error) {
        if (active)
          setMessage(
            `自动更新未完成：${(error as Error).message}。可在总览重试。`,
          );
      } finally {
        refreshing = false;
      }
    }
    void refreshIfNeeded();
    document.addEventListener("visibilitychange", refreshIfNeeded);
    const timer = hasGold
      ? window.setInterval(() => void refreshIfNeeded(), 60_000)
      : undefined;
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      active = false;
      document.removeEventListener("visibilitychange", refreshIfNeeded);
    };
  }, [demo, hasGold, mutate, mutateCache]);
  useEffect(() => {
    setHidden(localStorage.getItem("atlas-hide-amounts") === "true");
  }, []);
  const href = (p: string) =>
    demo ? `/demo${p === "/dashboard" ? "" : p}` : p;
  const isActive = (p: string) =>
    p === "/dashboard" ? pathname === href(p) : pathname.startsWith(href(p));
  function toggle() {
    const next = !hidden;
    setHidden(next);
    localStorage.setItem("atlas-hide-amounts", String(next));
  }
  async function logout() {
    const result = await authClient.signOut();
    if (result.error) setLogoutError("退出失败，请重试");
    else {
      await mutate(undefined, false);
      router.push("/login");
      router.refresh();
    }
  }
  return (
    <div className="workspace">
      <a href="#main-content" className="skip-link">
        跳转到主要内容
      </a>
      <aside className="sidebar">
        <Link href={href("/dashboard")} aria-label="AssetAtlas 首页">
          <Brand />
        </Link>
        <div className="sidebar-caption">个人资产空间</div>
        <nav>
          {nav.map((n) => (
            <Link
              key={n.href}
              href={href(n.href)}
              className={`nav-link ${isActive(n.href) ? "active" : ""}`}
              aria-current={isActive(n.href) ? "page" : undefined}
            >
              <n.icon size={19} strokeWidth={1.7} />
              <span>{n.label}</span>
              {isActive(n.href) && <span className="nav-dot" />}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="slow-note">
            <Leaf size={23} strokeWidth={1.5} />
            <p>
              看清当下，
              <br />
              让财富从容生长。
            </p>
            <span>记录每一步，积累每一天。</span>
          </div>
          <div className="privacy-note">
            <ShieldCheck size={14} /> 私有账本 · 安心记录
          </div>
          <Link className="profile" href={href("/settings")}>
            <span className="avatar">
              {(portfolio?.name || "A").slice(0, 1).toUpperCase()}
            </span>
            <span className="profile-text">
              <b>{portfolio?.name || "我的账户"}</b>
              <small>{demo ? "演示空间" : "个人资产账户"}</small>
            </span>
            <ChevronDown size={15} />
          </Link>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <div className="breadcrumb">
            我的工作台 <span>/</span>{" "}
            <b>{nav.find((n) => isActive(n.href))?.label || "资产详情"}</b>
          </div>
          <Link href={href("/dashboard")} className="mobile-brand">
            <Brand />
          </Link>
          <div className="topbar-actions">
            <form
              className="global-search"
              onSubmit={(e) => {
                e.preventDefault();
                router.push(
                  `${href("/assets")}?q=${encodeURIComponent(search)}`,
                );
              }}
            >
              <Search size={16} />
              <input
                aria-label="搜索资产"
                placeholder="搜索资产、代码…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <kbd>↵</kbd>
            </form>
            <button
              onClick={toggle}
              className="icon-button"
              aria-label={hidden ? "显示金额" : "隐藏金额"}
              title={hidden ? "显示金额" : "隐藏金额"}
            >
              {hidden ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
            {demo ? (
              <Link href="/register" className="topbar-signup">
                创建账户 <ArrowUpRight size={14} />
              </Link>
            ) : (
              <button
                className="icon-button"
                onClick={logout}
                aria-label="退出登录"
              >
                <LogOut size={18} />
              </button>
            )}
          </div>
        </header>
        <main id="main-content" className="main-content">
          {demo && (
            <div className="demo-banner">
              <span>
                <span className="status-dot" /> 演示空间{" "}
                <span className="demo-description">
                  · 所有金额与走势均为示例数据
                </span>
              </span>
              <Link href="/register">
                开始记录我的资产 <ArrowUpRight size={14} />
              </Link>
            </div>
          )}
          {logoutError && <Notice tone="error">{logoutError}</Notice>}
          {error && (
            <Notice tone="error">
              {error.message} <button onClick={() => mutate()}>重新加载</button>
            </Notice>
          )}
          {portfolio ? (
            <Context.Provider
              value={{
                data: portfolio,
                demo,
                hidden,
                amount: (v, signed) => (hidden ? "••••••" : money(v, signed)),
                href,
                reload: () => mutate(),
                notify: setMessage,
              }}
            >
              {message && (
                <Notice>
                  {message}{" "}
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => setMessage("")}
                  >
                    关闭提示
                  </button>
                </Notice>
              )}
              {children}
            </Context.Provider>
          ) : !error ? (
            <Skeleton />
          ) : null}
          <footer className="footer">
            <span>
              <span className="footer-brand">AssetAtlas</span>{" "}
              让每一份资产，都有清晰的坐标。
            </span>
            <span>
              以人民币计价 <span>·</span> Asia/Shanghai
            </span>
          </footer>
        </main>
      </div>
      <nav className="mobile-nav" aria-label="移动导航">
        {nav.map((n) => (
          <Link
            key={n.href}
            href={href(n.href)}
            className={isActive(n.href) ? "active" : ""}
          >
            <n.icon size={21} strokeWidth={1.6} />
            <span>{n.label.replace("账户与设置", "设置")}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
