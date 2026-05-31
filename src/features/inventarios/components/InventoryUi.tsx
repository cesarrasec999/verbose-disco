"use client";

import type { SortDirection } from "@/features/inventarios/types";
import { money, number2 } from "@/features/inventarios/utils";

export function SortHeader({ label, active, direction, onClick, align = "center" }: { label: string; active: boolean; direction: SortDirection; onClick: () => void; align?: "left" | "center" }) {
  return (
    <th className={`p-0 ${align === "left" ? "text-left" : "text-center"}`}>
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center gap-1 px-2 py-2 text-xs font-black ${align === "left" ? "justify-start" : "justify-center"} ${active ? "text-slate-950" : "text-slate-600 hover:text-slate-950"}`}
      >
        <span>{label}</span>
        <span className="text-[10px]">{active ? (direction === "desc" ? "↓" : "↑") : "↕"}</span>
      </button>
    </th>
  );
}

export function MiniMetric({ label, value, compact = false }: { label: string; value: string | number; compact?: boolean }) {
  const displayValue = typeof value === "number" ? number2(value) : value;
  return (
    <div className={`rounded-xl bg-white text-center ${compact ? "p-1" : "p-2"}`}>
      <div className={`${compact ? "text-xs" : "text-sm"} font-black text-slate-950`}>{displayValue}</div>
      <div className="text-[10px] font-bold text-slate-500">{label}</div>
    </div>
  );
}

export function DonutKpi({ label, value, detail, tone = "slate" }: { label: string; value: number; detail: string; tone?: "slate" | "blue" | "green" }) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(value || 0))));
  const color = tone === "blue" ? "#1d4ed8" : tone === "green" ? "#16a34a" : "#0f172a";
  return (
    <div className="rounded-xl border bg-slate-50 p-4">
      <div className="flex items-center gap-4">
        <div
          className="grid h-28 w-28 shrink-0 place-items-center rounded-full"
          style={{ background: `conic-gradient(${color} ${pct * 3.6}deg, #e2e8f0 0deg)` }}
        >
          <div className="grid h-20 w-20 place-items-center rounded-full bg-white text-2xl font-black text-slate-950">
            {pct}%
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-black uppercase text-slate-500">{label}</div>
          <div className="mt-2 text-base font-black text-slate-900">{detail}</div>
        </div>
      </div>
    </div>
  );
}

export function ValueBarKpi({ label, value, maxValue, tone }: { label: string; value: number; maxValue: number; tone: "blue" | "red" }) {
  const absValue = Math.abs(Number(value || 0));
  const pct = Math.max(2, Math.min(100, (absValue / Math.max(1, maxValue)) * 100));
  const barColor = tone === "blue" ? "bg-blue-700" : "bg-red-600";
  const softColor = tone === "blue" ? "bg-blue-50 border-blue-100" : "bg-red-50 border-red-100";
  const textColor = tone === "blue" ? "text-blue-700" : "text-red-600";
  return (
    <div className={`rounded-xl border p-4 ${softColor}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-black uppercase text-slate-500">{label}</div>
          <div className={`mt-1 text-2xl font-black ${textColor}`}>{money(value)}</div>
        </div>
        <div className="flex h-16 items-end gap-1">
          {[0.35, 0.55, 0.75, 1].map((step, index) => (
            <div key={index} className="w-3 rounded-t bg-white/80">
              <div className={`${barColor} rounded-t`} style={{ height: `${Math.max(8, pct * step * 0.6)}px` }} />
            </div>
          ))}
        </div>
      </div>
      <div className="mt-4 h-3 overflow-hidden rounded-full bg-white">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Kpi({ label, value, tone = "slate" }: { label: string; value: string | number; tone?: "slate" | "blue" | "red" | "amber" | "green" }) {
  const color = tone === "blue" ? "text-blue-700" : tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : tone === "green" ? "text-green-700" : "text-slate-900";
  const displayValue = typeof value === "number" ? number2(value) : value;
  return (
    <div className="rounded-xl border bg-slate-50 p-3 text-center">
      <div className={`text-xl font-black ${color}`}>{displayValue}</div>
      <div className="mt-1 text-xs font-bold text-slate-500">{label}</div>
    </div>
  );
}
