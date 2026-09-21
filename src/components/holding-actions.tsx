"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { quantity } from "@/lib/format";
import type { Holding } from "@/lib/types";
import { useWorkspace } from "./workspace";
import { Action, Field, Notice } from "./ui";

export function HoldingActions({
  holding: h,
  onUpdated,
}: {
  holding: Holding;
  onUpdated: () => Promise<unknown>;
}) {
  const { data, reload, notify } = useWorkspace();
  const router = useRouter();
  const [mode, setMode] = useState<"quantity" | "delete" | null>(null);
  const [target, setTarget] = useState("");
  const [expected, setExpected] = useState("");
  const [reason, setReason] = useState("");
  const [price, setPrice] = useState("");
  const [fx, setFx] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef({ body: "", key: "" });
  const needsPrice = data.initialized && h.type !== "cash" && h.price === null;
  const needsFx = data.initialized && h.currency !== "CNY" && h.fx === null;
  function open(next: "quantity" | "delete") {
    setMode(next);
    setTarget(h.quantity);
    setExpected(h.quantity);
    setReason(
      next === "delete" ? "从资产列表移除此持仓" : "按实际持仓修正数量",
    );
    setPrice("");
    setFx("");
    setError("");
    request.current = { body: "", key: "" };
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !mode) return;
    setBusy(true);
    setError("");
    const body = {
      ...(mode === "quantity" ? { quantity: target } : {}),
      expectedQuantity: expected,
      reason,
      ...(needsPrice && price ? { price } : {}),
      ...(needsFx && fx ? { fx } : {}),
    };
    const encoded = JSON.stringify({ mode, body });
    if (request.current.body !== encoded)
      request.current = { body: encoded, key: crypto.randomUUID() };
    try {
      await api(
        `/assets/${encodeURIComponent(h.holdingId)}${mode === "quantity" ? "/quantity" : ""}`,
        body,
        mode === "quantity" ? "PATCH" : "DELETE",
        request.current.key,
      );
      const removed = mode === "delete" || Number(target) === 0;
      setMode(null);
      notify(
        removed
          ? "资产已从当前列表移除，历史流水保留。勾选“显示已清仓资产”可查看或重新设置数量。"
          : "当前持仓数量已更新，已记录调整流水。",
      );
      // A refresh failure must not invite a second financial record after a successful mutation.
      await Promise.allSettled([onUpdated(), reload()]);
      if (removed) router.push("/assets");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel holding-management">
      <div className="page-actions">
        <h2>管理持仓</h2>
        <Action secondary onPress={() => open("quantity")} isDisabled={busy}>
          <Pencil size={15} />
          修改数量
        </Action>
        <Action
          secondary
          className="danger-action"
          onPress={() => open("delete")}
          isDisabled={busy || Number(h.quantity) === 0}
        >
          <Trash2 size={15} />
          删除资产
        </Action>
      </div>
      {mode && (
        <form onSubmit={submit} className="holding-change-form">
          <h3>{mode === "delete" ? "确认删除这项持仓" : "设置当前持仓数量"}</h3>
          <p>
            {h.name}（{h.symbol}） · {h.accountName} · 当前 {quantity(expected)}{" "}
            {h.unit}
          </p>
          <Notice>
            {mode === "delete"
              ? "确认后，当前持仓数量将设为 0，并从默认资产列表移除。历史流水与历史持仓仍保留。"
              : "填写修改后的总数量，系统自动计算增减差额并记录持仓修正。填 0 将从默认资产列表移除。"}
            {data.initialized
              ? "调整会按参考价格和汇率计入修正，不计作投资收益，也不产生现金收支。实际买卖请使用“记录变动”。"
              : "期初资产合计会随之更新，初始化完成前不计算投资收益。"}
          </Notice>
          {mode === "quantity" && (
            <Field
              label={`新的总数量（${h.unit}）`}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              inputMode="decimal"
              required
              disabled={busy}
              autoFocus
              hint="支持小数，不能为负数。"
            />
          )}
          {(needsPrice || needsFx) && (
            <Notice>
              当前缺少估值依据，请补充发生时参考价格或汇率，以便正确记录调整金额。
            </Notice>
          )}
          <div className="form-grid">
            {needsPrice && (
              <Field
                label={`参考单价（${h.currency}/${h.quoteBasis === "oz" ? "金衡盎司" : h.unit}）`}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
                required
                disabled={busy}
              />
            )}
            {needsFx && (
              <Field
                label={`汇率（1 ${h.currency} = ? CNY）`}
                value={fx}
                onChange={(e) => setFx(e.target.value)}
                inputMode="decimal"
                required
                disabled={busy}
              />
            )}
          </div>
          <Field
            label={mode === "delete" ? "删除原因" : "调整原因"}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={2}
            maxLength={500}
            disabled={busy}
          />
          {error && <Notice tone="error">{error}</Notice>}
          <div className="page-actions">
            <Action
              type="submit"
              isDisabled={busy}
              className={mode === "delete" ? "danger-action" : ""}
            >
              {busy
                ? "正在保存…"
                : mode === "delete"
                  ? "确认删除资产"
                  : "保存新数量"}
            </Action>
            <Action
              type="button"
              secondary
              onPress={() => setMode(null)}
              isDisabled={busy}
            >
              取消
            </Action>
          </div>
        </form>
      )}
    </section>
  );
}
