export function money(
  value: string | number | null | undefined,
  signed = false,
) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: signed ? "exceptZero" : "auto",
  }).format(Number(value));
}
export function quantity(value: string | number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 8 }).format(
    Number(value),
  );
}
export function dateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
export function safeReturn(value: string | null) {
  return value && /^\/(?!\/)/.test(value) && !value.includes("\\")
    ? value
    : "/dashboard";
}
