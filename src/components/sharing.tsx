"use client";
import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Users, UserPlus, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api-client";
import type { Holding, Wallet } from "@/lib/types";
import { quantity } from "@/lib/format";
import { useWorkspace } from "./workspace";
import {
  Action,
  AssetIcon,
  Empty,
  Field,
  Notice,
  PageTitle,
  Skeleton,
} from "./ui";

type Share = {
  id: string;
  peer: { name: string; email: string };
  direction: string;
  status: string;
  expiresAt: string;
  ownWalletIds: string[];
};
type SharedPortfolio = {
  total: string;
  complete: boolean;
  missingCount: number;
  staleCount: number;
  asOf: string;
  members: {
    name: string;
    isSelf: boolean;
    accountCount: number;
    total: string;
    holdings: Holding[];
  }[];
};
function WalletSelection({
  accounts,
  selected,
  onChange,
  disabled = false,
}: {
  accounts: Wallet[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="wallet-picker" disabled={disabled}>
      <legend>允许对方查看的账户</legend>
      {accounts.map((w) => (
        <label key={w.id}>
          <input
            type="checkbox"
            checked={selected.includes(w.id)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...selected, w.id]
                  : selected.filter((id) => id !== w.id),
              )
            }
          />
          <span>
            {w.name}
            {w.archived ? "（已归档）" : ""}
          </span>
        </label>
      ))}
      <p className="field-hint">
        仅共享这些账户的名称、持仓数量及估值。未勾选的账户、流水和备注保持私有；新增账户不会自动共享。
      </p>
    </fieldset>
  );
}
function SharedView({ id }: { id?: string }) {
  const { amount, hidden } = useWorkspace();
  const { data, error, mutate } = useSWR<SharedPortfolio>(
    id ? `/shares/${id}/portfolio` : "/shares/portfolio",
    api,
    {
      refreshInterval: 30000,
      revalidateOnFocus: true,
      shouldRetryOnError: false,
    },
  );
  // Never render stale cached assets when a refreshed authorization check fails.
  if (error)
    return (
      <Notice tone="error">
        {error.message} <button onClick={() => mutate()}>重新检查</button>
      </Notice>
    );
  if (!data) return <Skeleton />;
  return (
    <section className="panel settings-panel shared-summary">
      <div className="panel-heading">
        <div>
          <h2>我们的共同资产</h2>
          <p>所有互相授权账户的当前持仓 · 人民币计价 · 只读</p>
        </div>
        <Users size={22} />
      </div>
      <div className="shared-total">{amount(data.total)}</div>
      <p>
        {data.complete ? "估值完整" : "仅包含已有报价的资产"} ·{" "}
        {new Date(data.asOf).toLocaleString("zh-CN")}
      </p>
      {data.missingCount > 0 && (
        <Notice>{data.missingCount} 项资产缺少报价，合计尚不完整。</Notice>
      )}
      {data.staleCount > 0 && (
        <Notice>
          {data.staleCount} 项资产报价较旧，分析时请留意更新时间。
        </Notice>
      )}
      <div className="shared-members">
        {data.members.map((member, index) => (
          <div key={index}>
            <div className="shared-member-title">
              <h3>
                {member.name}
                {member.isSelf ? "（我）" : ""}
              </h3>
              <span>
                {member.accountCount} 个共享账户 · {amount(member.total)}
              </span>
            </div>
            {member.holdings.length === 0 ? (
              <p className="muted">暂无共享持仓</p>
            ) : (
              member.holdings.map((h) => (
                <div className="shared-holding" key={h.holdingId}>
                  <div className="holding-identity">
                    <AssetIcon
                      type={h.type}
                      symbol={h.symbol}
                      id={h.id}
                      iconUrl={h.iconUrl}
                    />
                    <div>
                      <b>{h.name}</b>
                      <small>
                        {h.symbol} · {h.accountName}
                      </small>
                    </div>
                  </div>
                  <div>
                    <b>{amount(h.value)}</b>
                    <small>
                      {hidden ? "••••" : quantity(h.quantity)} {h.unit}
                    </small>
                  </div>
                </div>
              ))
            )}
          </div>
        ))}
      </div>
      <p className="field-hint">
        同一笔资产请由一方记录，双方分别记账会重复计入。共享视图不合并个人收益基准。
      </p>
    </section>
  );
}
function ShareCard({
  share,
  onUpdated,
}: {
  share: Share;
  onUpdated: () => Promise<unknown>;
}) {
  const { data } = useWorkspace();
  const { mutate: mutateCache } = useSWRConfig();
  const [ids, setIds] = useState(share.ownWalletIds),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false),
    [view, setView] = useState(false);
  const incoming = share.status === "pending" && share.direction === "incoming";
  async function act(action: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/shares/${share.id}/${action}`, { walletIds: ids });
      setEditing(false);
      setConfirm(false);
      await onUpdated();
      await mutateCache("/shares/portfolio");
      if (action === "wallets")
        await mutateCache(`/shares/${share.id}/portfolio`);
      if (action === "revoke") {
        setView(false);
        await mutateCache(`/shares/${share.id}/portfolio`, undefined, {
          revalidate: false,
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="panel settings-panel">
      <div className="panel-heading">
        <div>
          <h2>{share.peer.name}</h2>
          <p>{share.peer.email}</p>
        </div>
        <span className="share-status">
          {
            (
              {
                pending: incoming ? "邀请你共享" : "等待对方同意",
                accepted: "已互相授权",
                declined: "已拒绝",
                revoked: "已解除",
                expired: "邀请已过期",
              } as Record<string, string>
            )[share.status]
          }
        </span>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {incoming && (
        <p>
          对方希望与你共同查看资产。选择你愿意共享的账户，接受后双方才能查看共同视图。
        </p>
      )}
      {share.status === "pending" && (
        <p className="field-hint">
          邀请有效至 {new Date(share.expiresAt).toLocaleDateString("zh-CN")}
          ，同意前双方都不能查看对方资产。
        </p>
      )}
      {(incoming || editing) && (
        <WalletSelection
          accounts={data.accounts}
          selected={ids}
          onChange={setIds}
          disabled={busy}
        />
      )}
      <div className="page-actions">
        {incoming && (
          <>
            <Action isDisabled={busy} onPress={() => act("accept")}>
              同意并共享所选账户
            </Action>
            <Action secondary isDisabled={busy} onPress={() => act("decline")}>
              拒绝邀请
            </Action>
          </>
        )}
        {share.status === "accepted" && (
          <>
            <Action onPress={() => setView(!view)}>
              {view ? "收起共同资产" : "查看共同资产"}
            </Action>
            {editing ? (
              <>
                <Action
                  secondary
                  isDisabled={busy}
                  onPress={() => act("wallets")}
                >
                  保存共享范围
                </Action>
                <Action secondary onPress={() => setEditing(false)}>
                  取消编辑
                </Action>
              </>
            ) : (
              <Action
                secondary
                onPress={() => {
                  setIds(share.ownWalletIds);
                  setEditing(true);
                }}
              >
                修改我的共享范围
              </Action>
            )}
          </>
        )}
        {(share.status === "accepted" ||
          (share.status === "pending" && !incoming)) && (
          <Action secondary isDisabled={busy} onPress={() => setConfirm(true)}>
            {share.status === "accepted" ? "解除共享" : "撤回邀请"}
          </Action>
        )}
      </div>
      {confirm && (
        <div className="confirm-box">
          <p>
            确认
            {share.status === "accepted"
              ? "解除共享？双方将立即失去对方资产的访问权限，各自账本保留。"
              : "撤回邀请？"}
          </p>
          <div className="page-actions">
            <Action isDisabled={busy} onPress={() => act("revoke")}>
              确认{share.status === "accepted" ? "解除" : "撤回"}
            </Action>
            <Action secondary onPress={() => setConfirm(false)}>
              取消
            </Action>
          </div>
        </div>
      )}
      {view && share.status === "accepted" && <SharedView id={share.id} />}
    </article>
  );
}
export function SharingPage() {
  const { data, demo } = useWorkspace();
  const {
    data: shares,
    error,
    mutate,
  } = useSWR<{ items: Share[] }>(demo ? null : "/shares", api, {
    refreshInterval: 30000,
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  });
  const [email, setEmail] = useState(""),
    [ids, setIds] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [showInvite, setShowInvite] = useState(false);
  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await api("/shares", { email, walletIds: ids });
      setEmail("");
      setIds([]);
      setShowInvite(false);
      await mutate();
      setMessage(
        "邀请已送达对方的「共同资产」页面。对方登录后可选择账户并接受邀请。",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="A SHARED PICTURE"
        title="共同资产"
        description="各自记录，一起看清。只有双方同意，共同视图才会开启。"
        action={
          !demo && (
            <Action onPress={() => setShowInvite(!showInvite)}>
              <UserPlus size={17} />
              {showInvite ? "收起邀请" : "邀请家人"}
            </Action>
          )
        }
      />
      <Notice>
        <ShieldCheck size={15} className="inline" />{" "}
        每个人保留独立账本与修改权限。共享按关系分别授权，不会向对方的其他联系人开放。
      </Notice>
      {demo ? (
        <Empty title="和家人共同查看资产">
          注册后即可邀请家人，选择愿意共享的账户。
        </Empty>
      ) : (
        <>
          {message && <Notice>{message}</Notice>}
          {error && (
            <Notice tone="error">
              {error.message} <button onClick={() => mutate()}>重试</button>
            </Notice>
          )}
          {showInvite && (
            <form className="panel settings-panel mt-6" onSubmit={invite}>
              <h2>发起资产共享邀请</h2>
              <Field
                label="对方注册邮箱"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="请输入对方已注册的邮箱"
              />
              <WalletSelection
                accounts={data.accounts}
                selected={ids}
                onChange={setIds}
                disabled={busy}
              />
              <Action type="submit" isDisabled={busy}>
                同意共享所选账户并发送邀请
              </Action>
            </form>
          )}
          {shares?.items.some((s) => s.status === "accepted") && (
            <SharedView
              key={JSON.stringify(
                shares.items.map((s) => [s.id, s.status, s.ownWalletIds]),
              )}
            />
          )}
          <div className="sharing-list">
            {shares?.items.map((share) => (
              <ShareCard key={share.id} share={share} onUpdated={mutate} />
            ))}
            {shares?.items.length === 0 && (
              <Empty title="邀请一位家人，一起看资产">
                对方需要先注册独立账号。你们可以随时调整共享范围或解除共享。
              </Empty>
            )}
          </div>
        </>
      )}
    </>
  );
}
