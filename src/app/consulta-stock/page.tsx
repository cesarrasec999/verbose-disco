"use client";

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

import { useEffect, useMemo, useRef, useState } from "react";
import { Flashlight, Home, PackageSearch, QrCode, RefreshCw, Search } from "lucide-react";
import { supabase } from "@/lib/supabase/client";

type User = {
  id: string;
  full_name: string;
  role: string;
};

type Store = {
  id: string;
  name: string;
  erp_sede?: string | null;
  is_active: boolean;
};

type Product = {
  id: string;
  sku: string;
  barcode: string | null;
  description: string;
  unit: string | null;
  cost: number | null;
};

type StockRow = {
  sede: string | null;
  codsap: string | null;
  stock: number | string | null;
};

type StockResult = {
  product: Product;
  total: number;
  rows: Array<{
    store: Store;
    stock: number;
  }>;
};

const scannerContainerId = "stock-consulta-scanner";

function normalizeCode(value: unknown) {
  return String(value || "").trim().toUpperCase();
}

function visibleCode(value: unknown) {
  return normalizeCode(value).replace(/^0+/, "");
}

function normalizeText(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function mappedProductCodeCandidates(row: Record<string, unknown>) {
  const values = [row.codsap, row.CODSAP, row.codigo, row.CODIGO, row.cod_sap, row.COD_SAP];
  return values.map(normalizeCode).filter(Boolean);
}

function number2(value: number) {
  return new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 }).format(value);
}

function formatDateTime(value?: string | null) {
  if (!value) return "No disponible";
  return new Date(value).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });
}

export default function ConsultaStockPage() {
  const [user, setUser] = useState<User | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockResult[]>([]);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const scannerRef = useRef<any>(null);
  const torchTrackRef = useRef<MediaStreamTrack | null>(null);

  const currentName = user?.full_name || "Usuario";

  useEffect(() => {
    const rawUser = localStorage.getItem("cyclic_user");
    if (!rawUser) {
      window.location.replace("/");
      return;
    }
    if (rawUser) {
      try { setUser(JSON.parse(rawUser)); } catch { localStorage.removeItem("cyclic_user"); }
    }
    void loadBaseData();
  }, []);

  useEffect(() => {
    if (!scannerOpen) return;
    let cancelled = false;
    async function startScanner() {
      try {
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
        if (cancelled) return;
        const scanner = new Html5Qrcode(scannerContainerId, {
          verbose: false,
          formatsToSupport: [
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.CODE_93,
            Html5QrcodeSupportedFormats.CODABAR,
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.ITF,
            Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E,
            Html5QrcodeSupportedFormats.QR_CODE,
          ],
        });
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 260, height: 180 } },
          async decodedText => {
            const clean = decodedText.trim();
            if (!clean) return;
            setQuery(clean);
            await stopScanner();
            await searchStock(clean);
          },
          undefined
        );
        const video = document.querySelector(`#${scannerContainerId} video`) as HTMLVideoElement | null;
        const stream = video?.srcObject as MediaStream | null;
        torchTrackRef.current = stream?.getVideoTracks?.()[0] || null;
      } catch (error: any) {
        setMessage("No se pudo abrir el escaner: " + (error?.message || error));
        setScannerOpen(false);
      }
    }
    void startScanner();
    return () => {
      cancelled = true;
      void stopScanner();
    };
  }, [scannerOpen]);

  async function loadBaseData() {
    const [{ data: storeRows }, syncStatus, fallbackSync] = await Promise.all([
      supabase.from("stores").select("id,name,erp_sede,is_active").eq("is_active", true).order("name"),
      supabase.from("erp_sync_status").select("synced_at,updated_at").eq("id", "stock_general").maybeSingle(),
      supabase.from("stock_general").select("updated_at").order("updated_at", { ascending: false }).limit(1),
    ]);
    setStores((storeRows || []) as Store[]);
    setLastSync(syncStatus.data?.synced_at || syncStatus.data?.updated_at || fallbackSync.data?.[0]?.updated_at || null);
  }

  async function resolveProducts(text: string) {
    const raw = text.trim();
    const code = normalizeCode(raw);
    if (!raw) return [];

    const products = new Map<string, Product>();
    const { data: direct } = await supabase
      .from("cyclic_products")
      .select("id,sku,barcode,description,unit,cost")
      .eq("is_active", true)
      .or(`sku.eq.${code},barcode.eq.${raw}`)
      .limit(20);
    (direct || []).forEach(row => products.set(row.id, row as Product));

    const [{ data: upcRows }, { data: aluRows }] = await Promise.all([
      supabase.from("codigos_barra").select("codsap,upc,alu").eq("upc", raw).not("codsap", "is", null).limit(20),
      supabase.from("codigos_barra").select("codsap,upc,alu").eq("alu", raw).not("codsap", "is", null).limit(20),
    ]);
    const mappedCodes = [...new Set([...(upcRows || []), ...(aluRows || [])].flatMap(row => mappedProductCodeCandidates(row as Record<string, unknown>)))];
    if (mappedCodes.length > 0) {
      const { data: mapped } = await supabase
        .from("cyclic_products")
        .select("id,sku,barcode,description,unit,cost")
        .eq("is_active", true)
        .in("sku", mappedCodes)
        .limit(30);
      (mapped || []).forEach(row => products.set(row.id, row as Product));
    }

    if (products.size === 0) {
      const terms = normalizeText(raw).split(/\s+/).filter(Boolean).slice(0, 5);
      const { data: fuzzy } = await supabase
        .from("cyclic_products")
        .select("id,sku,barcode,description,unit,cost")
        .eq("is_active", true)
        .or(`sku.ilike.%${code}%,barcode.ilike.%${raw}%,description.ilike.%${raw}%`)
        .limit(50);
      (fuzzy || [])
        .filter(row => {
          if (terms.length === 0) return true;
          const haystack = normalizeText(`${row.sku} ${row.barcode || ""} ${row.description}`);
          return terms.every(term => haystack.includes(term));
        })
        .forEach(row => products.set(row.id, row as Product));
    }

    return [...products.values()].sort((a, b) => {
      const aCode = normalizeCode(a.sku);
      const bCode = normalizeCode(b.sku);
      if (aCode === code) return -1;
      if (bCode === code) return 1;
      if (visibleCode(a.sku) === visibleCode(code)) return -1;
      if (visibleCode(b.sku) === visibleCode(code)) return 1;
      return aCode.localeCompare(bCode);
    }).slice(0, 12);
  }

  async function searchStock(text = query) {
    const term = text.trim();
    if (!term) {
      setMessage("Ingresa codigo, descripcion o escanea una barra.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const foundProducts = await resolveProducts(term);
      if (foundProducts.length === 0) {
        setResults([]);
        setMessage("No se encontro el producto.");
        return;
      }
      const skus = foundProducts.map(product => normalizeCode(product.sku));
      const { data: stockRows, error } = await supabase
        .from("stock_general")
        .select("sede,codsap,stock")
        .in("codsap", skus);
      if (error) throw error;

      const stockBySkuSede = new Map<string, StockRow>();
      for (const row of (stockRows || []) as StockRow[]) {
        stockBySkuSede.set(`${normalizeCode(row.codsap)}__${String(row.sede || "").trim()}`, row);
      }
      const nextResults = foundProducts.map(product => {
        const sku = normalizeCode(product.sku);
        const rows = stores.filter(s => !!s.erp_sede).map(store => {
          const sede = String(store.erp_sede || store.name || "").trim();
          const stockRow = stockBySkuSede.get(`${sku}__${sede}`);
          return { store, stock: Number(stockRow?.stock || 0) };
        });
        return {
          product,
          rows,
          total: rows.reduce((sum, row) => sum + row.stock, 0),
        };
      });
      setResults(nextResults);
    } catch (error: any) {
      setMessage("Error consultando stock: " + (error?.message || error));
    } finally {
      setLoading(false);
    }
  }

  async function stopScanner() {
    try {
      if (torchTrackRef.current) {
        try { await torchTrackRef.current.applyConstraints({ advanced: [{ torch: false } as any] }); } catch {}
      }
      await scannerRef.current?.stop?.();
      await scannerRef.current?.clear?.();
    } catch {}
    scannerRef.current = null;
    torchTrackRef.current = null;
    setTorchOn(false);
    setScannerOpen(false);
  }

  async function toggleTorch() {
    const track = torchTrackRef.current;
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn } as any] });
      setTorchOn(prev => !prev);
    } catch {
      setMessage("La linterna no esta disponible en este dispositivo.");
    }
  }

  const hasResults = results.length > 0;
  const totalMatches = useMemo(() => results.reduce((sum, result) => sum + result.total, 0), [results]);

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-3 py-3 md:px-5">
          <button onClick={() => window.location.href = "/"} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border bg-white" title="Menu principal">
            <Home size={20} />
          </button>
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-slate-900 text-white">
            <PackageSearch size={25} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-black">Consulta de stock</h1>
            <p className="truncate text-sm text-slate-500">{currentName}</p>
          </div>
          <button onClick={() => void loadBaseData()} className="grid h-11 w-11 place-items-center rounded-xl border bg-white" title="Actualizar sincronizacion">
            <RefreshCw size={20} />
          </button>
        </div>
      </header>

      <section className="mx-auto max-w-7xl space-y-4 px-3 py-4 md:px-5">
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-black">Stock actualizado por tienda</h2>
              <p className="text-sm font-semibold text-slate-500">Ultima sincronizacion con RMS: {formatDateTime(lastSync)}</p>
            </div>
            {hasResults && (
              <div className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-black text-white">
                Total: {number2(totalMatches)}
              </div>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => { if (event.key === "Enter") void searchStock(); }}
              placeholder="Codigo, descripcion o codigo de barra"
              className="min-w-0 rounded-xl border px-4 py-3 text-base font-bold outline-none focus:border-blue-700"
            />
            <button onClick={() => setScannerOpen(true)} className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white">
              <QrCode size={18} /> Escanear
            </button>
            <button onClick={() => void searchStock()} disabled={loading} className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-700 px-5 py-3 text-sm font-black text-white disabled:opacity-50">
              <Search size={18} /> {loading ? "Consultando..." : "Consultar"}
            </button>
          </div>
          {message && <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">{message}</p>}
        </div>

        <div className="space-y-4">
          {results.map(result => (
            <article key={result.product.id} className="overflow-hidden rounded-2xl border bg-white shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b bg-slate-50 p-4">
                <div className="min-w-0">
                  <div className="text-lg font-black text-slate-950">{result.product.sku}</div>
                  <div className="max-w-4xl text-sm font-semibold text-slate-700">{result.product.description}</div>
                  <div className="mt-1 text-xs font-bold text-slate-500">UM: {result.product.unit || "N/D"} · Barra: {result.product.barcode || "-"}</div>
                </div>
                <div className="rounded-xl bg-blue-700 px-4 py-2 text-right text-white">
                  <div className="text-[11px] font-black uppercase">Total</div>
                  <div className="text-xl font-black">{number2(result.total)}</div>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-white">
                    <tr className="border-b text-left text-xs uppercase text-slate-500">
                      <th className="px-4 py-3">Tienda</th>
                      <th className="px-4 py-3 text-right">Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map(row => (
                      <tr key={row.store.id} className="border-b last:border-0">
                        <td className="px-4 py-3 font-bold">{row.store.name}</td>
                        <td className={`px-4 py-3 text-right text-base font-black ${row.stock > 0 ? "text-green-700" : "text-slate-400"}`}>{number2(row.stock)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
        </div>
      </section>

      {scannerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3">
          <div className="w-full max-w-lg rounded-2xl bg-white p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="font-black">Escanear producto</h3>
              <div className="flex gap-2">
                <button onClick={toggleTorch} className={`rounded-lg border px-3 py-2 text-sm font-black ${torchOn ? "bg-yellow-400 text-slate-900" : "bg-slate-900 text-white"}`}>
                  <Flashlight className="mr-1 inline" size={18} /> Linterna
                </button>
                <button onClick={() => void stopScanner()} className="rounded-lg border px-3 py-2 text-sm font-black">Cerrar</button>
              </div>
            </div>
            <div className="overflow-hidden rounded-xl bg-black">
              <div id={scannerContainerId} className="min-h-[280px] w-full" />
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
