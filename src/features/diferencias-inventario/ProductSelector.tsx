"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { QrCode, Search, X, XCircle } from "lucide-react";
import type { Product, Store } from "@/features/ciclicos/types";
import { fetchStockForStore, resolveProductCandidates } from "./api";

type Html5QrLike = {
  start: (camera: { facingMode: string }, config: { fps: number; qrbox: { width: number; height: number } }, onSuccess: (text: string) => void, onError?: () => void) => Promise<unknown>;
  stop: () => Promise<unknown>;
  clear: () => void | Promise<unknown>;
};

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
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerRunning, setScannerRunning] = useState(false);
  const [scannerError, setScannerError] = useState("");
  const scannerRef = useRef<Html5QrLike | null>(null);
  const scanHandledRef = useRef(false);
  const scannerId = `inventory-difference-scanner-${useId().replace(/:/g, "")}`;

  const closeScanner = useCallback(async () => {
    try {
      await scannerRef.current?.stop();
      await scannerRef.current?.clear();
    } catch {}
    scannerRef.current = null;
    scanHandledRef.current = false;
    setScannerRunning(false);
    setScannerOpen(false);
  }, []);

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

  const search = useCallback(async (scannedCode?: string) => {
    const term = (scannedCode ?? code).trim();
    if (!term || !store) return;
    setSearching(true);
    try {
      const matches = await resolveProductCandidates(term);
      if (matches.length === 0) {
        setCandidates([]);
        setScannerError(scannedCode ? "No se encontró un producto activo para el código escaneado." : "");
        return;
      }
      setScannerError("");
      if (matches.length === 1) await select(matches[0]);
      else setCandidates(matches);
    } finally {
      setSearching(false);
    }
  // select changes only with the store; keeping this callback stable prevents camera restarts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, store]);

  useEffect(() => {
    if (!scannerOpen) return;
    let cancelled = false;
    async function startScanner() {
      try {
        setScannerError("");
        scanHandledRef.current = false;
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
        if (cancelled) return;
        const scanner = new Html5Qrcode(scannerId, {
          verbose: false,
          formatsToSupport: [
            Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.CODE_93, Html5QrcodeSupportedFormats.CODABAR,
            Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.ITF, Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E, Html5QrcodeSupportedFormats.QR_CODE,
          ],
        }) as Html5QrLike;
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 260, height: 180 } },
          decoded => {
            if (scanHandledRef.current) return;
            scanHandledRef.current = true;
            const scanned = decoded.trim();
            setCode(scanned);
            void closeScanner();
            void search(scanned);
          },
          undefined,
        );
        if (!cancelled) setScannerRunning(true);
      } catch (error) {
        setScannerError(`No se pudo abrir la cámara: ${error instanceof Error ? error.message : String(error)}`);
        void closeScanner();
      }
    }
    void startScanner();
    return () => { cancelled = true; void closeScanner(); };
  }, [closeScanner, scannerId, scannerOpen, search]);

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
          onChange={event => { setCode(event.target.value); setScannerError(""); }}
          onKeyDown={event => { if (event.key === "Enter") void search(); }}
          placeholder="UPC, ALU, SKU o código"
          disabled={!store || searching}
          className="min-w-0 flex-1 rounded-xl border px-3 py-3 text-sm font-bold disabled:bg-slate-100"
        />
        <button type="button" onClick={() => void search()} disabled={!store || searching || !code.trim()} className="rounded-xl bg-blue-700 px-3 py-3 text-white disabled:opacity-40" title="Buscar"><Search size={18} /></button>
        <button type="button" onClick={() => setScannerOpen(true)} disabled={!store || searching} className="rounded-xl bg-slate-950 px-3 py-3 text-white disabled:opacity-40" title="Escanear UPC, ALU, SKU o código"><QrCode size={18} /></button>
      </div>
      {scannerError && <p className="text-xs font-semibold text-red-600">{scannerError}</p>}
      {candidates.length > 0 && (
        <div className="max-h-48 space-y-1 overflow-auto rounded-xl border bg-white p-2">
          {candidates.map(product => <button key={product.id} type="button" onClick={() => void select(product)} className="w-full rounded-lg px-3 py-2 text-left hover:bg-blue-50"><b>{product.sku}</b><span className="ml-2 text-sm text-slate-600">{product.description}</span></button>)}
        </div>
      )}
      {scannerOpen && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/80 p-4">
          <p className="text-center font-black text-white">Escanea UPC, ALU, SKU o código del producto</p>
          {!scannerRunning && <p className="text-sm text-white/60">Iniciando cámara...</p>}
          <div id={scannerId} className="w-full max-w-xs overflow-hidden rounded-2xl" />
          <button type="button" onClick={() => void closeScanner()} className="flex items-center gap-2 rounded-2xl bg-white px-6 py-3 font-black text-slate-900"><X size={16} /> Cancelar</button>
        </div>
      )}
    </div>
  );
}
