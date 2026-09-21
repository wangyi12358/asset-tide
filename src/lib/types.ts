export type AssetType = "cash" | "stock" | "fund" | "gold" | "crypto";
export type Currency = "CNY" | "USD" | "HKD";
export type EventType =
  | "opening"
  | "deposit"
  | "withdrawal"
  | "buy"
  | "sell"
  | "transfer"
  | "exchange"
  | "dividend"
  | "adjustment"
  | "split";
export interface Instrument {
  id: string;
  ownerId: string | null;
  name: string;
  symbol: string;
  type: AssetType;
  market: string;
  currency: Currency;
  unit: string;
  providerId: string | null;
  iconUrl?: string | null;
  purity: string;
  quoteBasis: string;
}
export interface InstrumentCandidate {
  key: string;
  name: string;
  symbol: string;
  type: "stock" | "fund" | "crypto";
  market: string;
  currency: Currency;
  unit: string;
  providerId: string;
  source: string;
  iconUrl?: string | null;
}
export interface InstrumentSearch {
  items: InstrumentCandidate[];
  warnings: string[];
}
export interface Wallet {
  id: string;
  userId: string;
  name: string;
  type: string;
  archived: number;
}
export interface Price {
  id: string;
  instrumentId: string;
  userId: string | null;
  value: string;
  asOf: string;
  source: string;
  manual: number;
  active: number;
  createdAt: string;
}
export interface Holding extends Instrument {
  holdingId: string;
  accountId: string;
  accountName: string;
  quantity: string;
  originalValue: string | null;
  price: string | null;
  fx: string | null;
  value: string | null;
  priceAsOf: string | null;
  fxAsOf: string | null;
  source: string;
  fxSource: string;
  status: "missing" | "manual" | "stale" | "current";
  automaticAvailable?: boolean;
}
export interface LedgerEvent {
  id: string;
  userId: string;
  type: EventType;
  occurredAt: string;
  createdAt: string;
  note: string;
  externalCny: string;
  baselineAdjustment: string;
  status: string;
  idempotencyKey: string;
  payload: string;
  legs?: Leg[];
}
export interface Leg {
  id?: string;
  eventId?: string;
  accountId: string;
  instrumentId: string;
  quantity: string;
}
export interface Snapshot {
  id: string;
  asOf: string;
  total: string;
  netFlow: string;
  pnl: string | null;
  complete: boolean;
  version: number;
  items: Holding[];
}
export interface Portfolio {
  holdings: Holding[];
  accounts: Wallet[];
  transactions: LedgerEvent[];
  total: string;
  complete: boolean;
  missingCount: number;
  staleCount: number;
  netFlow: string;
  pnl: string | null;
  baseline: string | null;
  baselineAt: string | null;
  change: string | null;
  periodFlow: string | null;
  periodPnl: string | null;
  history: Snapshot[];
  asOf: string;
  initialized: boolean;
  name: string;
  email: string;
  emailVerified: boolean;
  demo?: boolean;
}
export const ASSET_LABELS: Record<AssetType, string> = {
  cash: "现金",
  stock: "股票",
  fund: "基金",
  gold: "黄金",
  crypto: "加密货币",
};
export const ASSET_COLORS: Record<AssetType, string> = {
  cash: "#527fcb",
  stock: "#a9c2ec",
  fund: "#97a7c1",
  gold: "#ddbd7d",
  crypto: "#b39ac4",
};
export const EVENT_LABELS: Record<EventType, string> = {
  opening: "期初持仓",
  deposit: "外部转入",
  withdrawal: "外部转出",
  buy: "买入",
  sell: "卖出",
  transfer: "内部转账",
  exchange: "换汇",
  dividend: "分红 / 利息",
  adjustment: "持仓修正",
  split: "拆股 / 份额变更",
};
