"use client";
import { Button, Input, Label, TextField } from "@heroui/react";
import {
  AlertCircle,
  ArrowUpRight,
  ChartNoAxesCombined,
  Coins,
} from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";
import { coinIconUrl } from "@/lib/asset-icons";
import type { AssetType } from "@/lib/types";
export function Action({
  children,
  className = "",
  secondary = false,
  ...props
}: ComponentProps<typeof Button> & { secondary?: boolean }) {
  return (
    <Button
      {...props}
      className={`action ${secondary ? "secondary" : ""} ${className}`}
    >
      {children}
    </Button>
  );
}
export function Field({
  label,
  hint,
  ...props
}: ComponentProps<typeof Input> & { label: string; hint?: string }) {
  return (
    <TextField className="field" isRequired={props.required}>
      <Label>{label}</Label>
      <Input {...props} className="field-input" />
      {hint && <span className="field-hint">{hint}</span>}
    </TextField>
  );
}
export function SelectField({
  label,
  children,
  ...props
}: ComponentProps<"select"> & { label: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select {...props} className="field-input">
        {children}
      </select>
    </label>
  );
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "error" | "success";
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`notice ${tone}`}
    >
      <AlertCircle size={17} />
      <div>{children}</div>
    </div>
  );
}
export function PageTitle({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function AssetIcon({
  type,
  symbol,
  id,
  iconUrl,
}: {
  type: AssetType;
  symbol?: string;
  id?: string;
  iconUrl?: string | null;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (type !== "crypto" && type !== "gold") return null;
  const src =
    type === "gold"
      ? "/icons/gold.svg"
      : coinIconUrl(iconUrl) ||
        (id ? `/api/instruments/${encodeURIComponent(id)}/icon` : null);
  return (
    <span className={`asset-icon ${type}`} aria-hidden="true">
      {src && failed !== src ? (
        <img
          src={src}
          alt=""
          width={32}
          height={32}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(src)}
        />
      ) : type === "gold" ? (
        <Coins size={22} />
      ) : (
        <span className="coin-fallback">{symbol?.slice(0, 3) || "◈"}</span>
      )}
    </span>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <ChartNoAxesCombined size={28} strokeWidth={1.4} />
      </span>
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}
export function Skeleton() {
  return (
    <div className="skeleton-layout" aria-label="正在加载资产数据">
      <div className="skeleton h-24" />
      <div className="grid gap-5 md:grid-cols-3">
        <div className="skeleton h-40" />
        <div className="skeleton h-40" />
        <div className="skeleton h-40" />
      </div>
      <div className="skeleton h-96" />
    </div>
  );
}
export function SmallArrow() {
  return <ArrowUpRight size={15} />;
}
