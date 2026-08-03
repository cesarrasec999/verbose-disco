"use client";

import { useState } from "react";
import { Search, XCircle } from "lucide-react";
import type { Product, Store } from "@/features/ciclicos/types";
import { fetchStockForStore, resolveProductCandidates } from "./api";

export type SelectedRequestProduct = {
  product: Product;
  systemStock: number;
};

export function ProductSelector({
  label,
  store,
  value,
  onChange,
}: {
  label: string;
  store: Store | null;
  value: SelectedRequestProduct | null;
  onChange: (value: SelectedRequestProduct | null) => void;
}) {
  const [code, setCode] = useState("");
  const [candidates, setCandidates] = useState<Product[]>([]);
  const [searching, setSearching] = useState(false);

  async function search() {
    const term = code.trim();
    if (!term || !store) return;
    setSearching(true);
    try {
      const matches = await resolveProductCandidates(term);
      if (matches.length === 0) { setCandidates([]); return; }
      if (matches.length === 1) await select(matches[0]);
      else setCandidates(matches);
    } finally {
      setSearching(false);
    }
  }

  async function select(product: Product) {
    if (!store) return;
    setSearching(true);
    try {
      const systemStock = await fetchStockForStore(store, product);
      onChange({ product, systemStock });
      setCandidates([]);
      setCode("");
    } finally {
      setSearching(false);
    }
  }

  if (value) {
    return (
      <div className="rounded-xl border bg-slate-50 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-black uppercase text-slate-500">{label}</p>
            <p className="font-black text-slate-900">{value.product.sku}</p>
            <p className="text-sm text-slate-600">{value.product.description || "Sin descripción"}</p>
            <p className="mt-1 text-xs font-bold text-slate-500">UM: {value.product.unit || "N/D"} · Stock actual: <span className="text-slate-900">{value.systemStock}</span></p>
          </div>
          <button type="button" onClick={() => onChange(null)} className="rounded-lg border p-2 text-slate-500" title="Cambiar código"><XCircle size={17} /></button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label className="text-xs font-black uppercase text-slate-500">{label}</label>
      <div className="flex gap-2">
        <input
          value={code}
          onChange={event => setCode(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") void search(); }}
          placeholder="Escanea o digita el código"
          disabled={!store || searching}
          className="min-w-0 flex-1 rounded-xl border px-3 py-3 text-sm font-bold disabled:bg-slate-100"
        />
        <button type="button" onClick={() => void search()} disabled={!store || searching || !code.trim()} className="rounded-xl bg-blue-700 px-3 py-3 text-white disabled:opacity-40" title="Buscar"><Search size={18} /></button>
      </div>
      {candidates.length > 0 && (
        <div className="max-h-48 space-y-1 overflow-auto rounded-xl border bg-white p-2">
          {candidates.map(product => <button key={product.id} type="button" onClick={() => void select(product)} className="w-full rounded-lg px-3 py-2 text-left hover:bg-blue-50"><b>{product.sku}</b><span className="ml-2 text-sm text-slate-600">{product.description}</span></button>)}
        </div>
      )}
    </div>
  );
}
