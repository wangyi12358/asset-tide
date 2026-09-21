"use client";
import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ASSET_COLORS, ASSET_LABELS, type AssetType } from "@/lib/types";
import { useWorkspace } from "./workspace";
import { Empty } from "./ui";
import { money, dateTime } from "@/lib/format";
export function HistoryChart() {
  const { data, hidden } = useWorkspace();
  const [range, setRange] = useState(30);
  const [mode, setMode] = useState<"total" | "pnl">("total");
  const cutoff = Date.parse(data.asOf) - range * 86400_000;
  const points = data.history
    .filter((s) => range === 0 || Date.parse(s.asOf) >= cutoff)
    .map((s) => ({
      date: s.asOf,
      value: s.complete && s[mode] !== null ? Number(s[mode]) : null,
    }));
  return (
    <section className="panel trend-panel">
      <div className="panel-heading">
        <div>
          <h2>
            资产走势 <span className="subtle-tag">CNY</span>
          </h2>
          <p>长期视角，看到每一份积累</p>
        </div>
        <div className="segmented range-switch">
          {[
            [7, "7 天"],
            [30, "30 天"],
            [90, "90 天"],
            [0, "全部"],
          ].map(([v, label]) => (
            <button
              key={v}
              onClick={() => setRange(Number(v))}
              className={range === v ? "selected" : ""}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-tabs">
        <button
          className={mode === "total" ? "active" : ""}
          onClick={() => setMode("total")}
        >
          总资产
        </button>
        <button
          className={mode === "pnl" ? "active" : ""}
          onClick={() => setMode("pnl")}
        >
          累计投资盈亏
        </button>
      </div>
      {hidden ? (
        <Empty title="金额已隐藏">点击右上角眼睛图标查看资产走势</Empty>
      ) : points.length ? (
        <>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={points}
                margin={{ top: 20, right: 14, left: -12, bottom: 0 }}
              >
                <defs>
                  <linearGradient
                    id="atlas-gradient"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor="#5381d0" stopOpacity={0.22} />
                    <stop
                      offset="100%"
                      stopColor="#5381d0"
                      stopOpacity={0.01}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 5"
                  vertical={false}
                  stroke="#e4e9f1"
                />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v) =>
                    `${new Date(v).getUTCMonth() + 1}/${new Date(v).getUTCDate()}`
                  }
                  axisLine={false}
                  tickLine={false}
                  minTickGap={32}
                  tick={{ fill: "#8491a9", fontSize: 11 }}
                  dy={10}
                />
                <YAxis
                  domain={["auto", "auto"]}
                  tickFormatter={(v) =>
                    Math.abs(v) >= 10000
                      ? `${(v / 10000).toFixed(0)}万`
                      : `${v}`
                  }
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "#8491a9", fontSize: 11 }}
                  width={65}
                />
                <Tooltip
                  labelFormatter={(v) => dateTime(String(v))}
                  formatter={(v) => [
                    `¥ ${money(Number(v))}`,
                    mode === "total" ? "总资产" : "累计投资盈亏",
                  ]}
                  contentStyle={{
                    borderRadius: 12,
                    border: "1px solid #dde3ee",
                    fontSize: 12,
                  }}
                />
                <Area
                  type="linear"
                  dataKey="value"
                  stroke="#4374ca"
                  strokeWidth={2.5}
                  fill="url(#atlas-gradient)"
                  connectNulls={false}
                  dot={points.length < 3 ? { r: 5, fill: "#4374ca" } : false}
                  activeDot={{ r: 5, stroke: "white", strokeWidth: 3 }}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <p className="chart-footnote">
            <span className="legend-dot" />{" "}
            {points.length === 1
              ? "历史数据积累中 · 目前仅有一个真实记录点"
              : `共 ${points.length} 个记录点 · 每日北京时间 08:00 快照`}
            {data.demo && " · 示例走势"}
          </p>
        </>
      ) : (
        <Empty title="从今天开始，积累你的资产轨迹">
          完成期初录入后建立第一个记录点；缺失数据不会被虚构填补。
        </Empty>
      )}
    </section>
  );
}
export function Allocation() {
  const { data, amount, hidden } = useWorkspace();
  const rows = (Object.keys(ASSET_LABELS) as AssetType[])
    .map((type) => ({
      type,
      value: data.holdings
        .filter((h) => h.type === type)
        .reduce((a, h) => a + Number(h.value || 0), 0),
    }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = rows.reduce((a, r) => a + r.value, 0);
  let position = 0;
  const stops = rows
    .map((r) => {
      const start = position;
      position += (r.value / total) * 100;
      return `${ASSET_COLORS[r.type]} ${start}% ${position}%`;
    })
    .join(",");
  return (
    <section className="panel allocation-panel">
      <div className="panel-heading">
        <div>
          <h2>资产分布</h2>
          <p>每一份资产，各有其位</p>
        </div>
        <span className="subtle-tag">{rows.length} 类资产</span>
      </div>
      {rows.length ? (
        <>
          <div className="donut-wrap">
            <div
              className="donut"
              role="img"
              aria-label={
                hidden
                  ? "资产占比已隐藏"
                  : rows
                      .map(
                        (r) =>
                          `${ASSET_LABELS[r.type]} ${((r.value / total) * 100).toFixed(1)}%`,
                      )
                      .join("，")
              }
              style={{
                background: hidden ? "#dfe4ee" : `conic-gradient(${stops})`,
              }}
            >
              <div>
                <span>资产类别</span>
                <strong>
                  {hidden ? "—" : rows.length.toString().padStart(2, "0")}
                </strong>
              </div>
            </div>
          </div>
          <div className="allocation-list">
            {rows.map((r) => (
              <div key={r.type}>
                <span>
                  <i style={{ background: ASSET_COLORS[r.type] }} />
                  {ASSET_LABELS[r.type]}
                </span>
                <b>{amount(r.value)}</b>
                <small>
                  {hidden ? "—" : `${((r.value / total) * 100).toFixed(1)}%`}
                </small>
              </div>
            ))}
          </div>
          {!data.complete && (
            <p className="chart-footnote">占比仅基于已有估值的资产</p>
          )}
        </>
      ) : (
        <Empty title="你的资产地图，待点亮">录入资产后查看配置占比</Empty>
      )}
    </section>
  );
}
