"use client";

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ClipboardCheck, ClipboardList, Flashlight, LogOut, PackageCheck, PackageSearch, QrCode, RefreshCw, Search, Truck, XCircle } from "lucide-react";
import { supabase } from "@/lib/supabase/client";

type Role = "Operario" | "Validador" | "Supervisor" | "Administrador";
type TabKey = "deliveries" | "receptions";
type ScannerTarget = "search" | "receipt" | null;
const PAGE_SIZE = 25;

type CyclicUser = {
  id: string;
  username: string;
  full_name: string;
  role: Role;
  store_id: string | null;
  can_access_all_stores: boolean;
  is_active: boolean;
};

type Store = {
  id: string;
  code: string;
  name: string;
  erp_sede?: string | null;
  erp_store_no?: string | null;
  is_active: boolean;
};

type SupplyLine = {
  line_key: string;
  document_no: string;
  inv_request_id?: string | null;
  inv_request_no?: string | null;
  status_code?: string | null;
  status_name?: string | null;
  destination_store_code: string;
  destination_store_name?: string | null;
  source_store_code?: string | null;
  source_store_name?: string | null;
  reason?: string | null;
  notes?: string | null;
  product_code: string;
  barcode?: string | null;
  description?: string | null;
  unit?: string | null;
  qty_requested?: number | string | null;
  qty_pending?: number | string | null;
  expected_qty?: number | string | null;
  cost?: number | string | null;
  request_date?: string | null;
  creation_date?: string | null;
  request_created_at?: string | null;
  delivered_at?: string | null;
  updated_at?: string | null;
};

type ReceiptCount = {
  id: string;
  line_key: string;
  document_no: string;
  destination_store_code: string;
  source_store_code?: string | null;
  product_code: string;
  description?: string | null;
  expected_qty: number;
  counted_qty: number;
  counted_by?: string | null;
  counted_by_name?: string | null;
  counted_at: string;
};

type SupplyGroup = {
  document_no: string;
  destination_store_code: string;
  destination_store_name: string;
  source_store_code: string;
  source_store_name: string;
  reason: string;
  notes: string;
  request_date: string | null;
  delivered_at: string | null;
  lines: SupplyLine[];
};

const USER_KEY = "cyclic_user";
const TAB_KEY = "supply_tab";

function normalize(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeCode(value: unknown) {
  return normalize(value).replace(/\.0+$/, "").toUpperCase();
}

function normalizeText(value: unknown) {
  return normalize(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function numberValue(value: unknown) {
  const parsed = Number(String(value ?? 0).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function number2(value: unknown) {
  return numberValue(value).toLocaleString("es-PE", { maximumFractionDigits: 2 });
}

function dateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });
}

function storeCodeFromStore(store: Store | null) {
  if (!store) return "";
  const name = `${store.name || ""} ${store.erp_sede || ""}`.trim();
  if (/CD-GPC/i.test(name)) return "1000";
  const gpc = name.match(/GPC0*([0-9]+)/i);
  if (gpc) return String(1000 + Number(gpc[1]));
  if (store.erp_store_no && /^\d+$/.test(store.erp_store_no)) return String(1000 + Number(store.erp_store_no));
  if (store.code && /^\d+$/.test(store.code)) return store.code.length <= 2 ? String(1000 + Number(store.code)) : store.code;
  return store.code || store.erp_sede || store.name || "";
}

function storeCodeCandidates(store: Store | null) {
  const codes = new Set<string>();
  const add = (value: unknown) => {
    const code = normalize(value);
    if (!code) return;
    codes.add(code);
    if (!/^\d+$/.test(code)) return;
    const num = Number(code);
    codes.add(String(num));
    if (num >= 1000) codes.add(String(num - 1000));
    if (num < 1000) codes.add(String(num + 1000));
  };

  add(storeCodeFromStore(store));
  add(store?.code);
  add(store?.erp_store_no);

  const label = `${store?.name || ""} ${store?.erp_sede || ""}`;
  if (/CD-GPC/i.test(label)) {
    add("0");
    add("1000");
  }
  const gpc = label.match(/GPC0*([0-9]+)/i);
  if (gpc) {
    const num = Number(gpc[1]);
    add(num);
    add(num + 1000);
  }
  return [...codes];
}

function supplyGroupKey(group: SupplyGroup) {
  return `${group.document_no}|${group.destination_store_code}|${group.source_store_code}`;
}

function storeLabel(code: string, name: string | null | undefined, storeNameByCode: Map<string, string>) {
  const clean = normalize(code);
  return normalize(name) || storeNameByCode.get(clean) || clean || "Tienda pendiente";
}

function lineExpectedQty(line: SupplyLine) {
  return numberValue(line.expected_qty ?? line.qty_pending ?? line.qty_requested);
}

function lineMatches(line: SupplyLine, query: string) {
  const q = normalizeText(query);
  if (!q) return true;
  const code = normalizeCode(query);
  const product = normalizeCode(line.product_code);
  const barcode = normalizeCode(line.barcode);
  if (code && (product === code || barcode === code || product.endsWith(code) || barcode.endsWith(code))) return true;
  return [
    line.document_no,
    line.reason,
    line.notes,
    line.description,
    line.destination_store_name,
    line.source_store_name,
  ].some(value => normalizeText(value).includes(q));
}

function findLineInGroup(group: SupplyGroup, code: string) {
  const clean = normalizeCode(code);
  if (!clean) return null;
  return group.lines.find(line => {
    const product = normalizeCode(line.product_code);
    const barcode = normalizeCode(line.barcode);
    return product === clean || barcode === clean || product.endsWith(clean) || barcode.endsWith(clean);
  }) || null;
}

function groupLines(lines: SupplyLine[]) {
  const map = new Map<string, SupplyGroup>();
  for (const line of lines) {
    const key = `${line.document_no}|${line.destination_store_code}|${line.source_store_code || ""}`;
    if (!map.has(key)) {
      map.set(key, {
        document_no: line.document_no || "Sin documento",
        destination_store_code: line.destination_store_code || "",
        destination_store_name: line.destination_store_name || "",
        source_store_code: line.source_store_code || "",
        source_store_name: line.source_store_name || "",
        reason: cleanReason(line.reason),
        notes: line.notes || "",
        request_date: line.request_date || line.creation_date || line.request_created_at || null,
        delivered_at: line.delivered_at || null,
        lines: [],
      });
    }
    const group = map.get(key)!;
    if (!group.destination_store_name && line.destination_store_name) group.destination_store_name = line.destination_store_name;
    if (!group.source_store_name && line.source_store_name) group.source_store_name = line.source_store_name;
    group.lines.push(line);
  }
  return [...map.values()].sort((a, b) => String(b.request_date || "").localeCompare(String(a.request_date || "")));
}

function cleanReason(value: unknown) {
  const text = normalize(value);
  if (!text) return "-";
  return text.replace(/\s*From Inventory Request.*$/i, "").trim() || text;
}

export default function AbastecimientoPage() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [deliveries, setDeliveries] = useState<SupplyLine[]>([]);
  const [receptions, setReceptions] = useState<SupplyLine[]>([]);
  const [counts, setCounts] = useState<ReceiptCount[]>([]);
  const [tab, setTab] = useState<TabKey>(() => {
    if (typeof window === "undefined") return "receptions";
    return (sessionStorage.getItem(TAB_KEY) as TabKey) || "receptions";
  });
  const [query, setQuery] = useState("");
  const [activeGroupKey, setActiveGroupKey] = useState("");
  const [selectedLineKey, setSelectedLineKey] = useState("");
  const [listPage, setListPage] = useState(1);
  const [scanCode, setScanCode] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [scannerTarget, setScannerTarget] = useState<ScannerTarget>(null);
  const [torchOn, setTorchOn] = useState(false);
  const scannerRef = useRef<any>(null);
  const scannerTargetRef = useRef<ScannerTarget>(null);
  const scannerHistoryRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const scannerContainerId = "supply-scanner";

  const selectedStore = useMemo(() => stores.find(store => store.id === selectedStoreId) || null, [stores, selectedStoreId]);
  const selectedStoreCodes = useMemo(() => storeCodeCandidates(selectedStore), [selectedStore]);
  const storeNameByCode = useMemo(() => {
    const map = new Map<string, string>();
    for (const store of stores) {
      for (const code of storeCodeCandidates(store)) {
        if (code) map.set(code, store.name);
      }
    }
    return map;
  }, [stores]);
  const canSeeAllStores = user?.role === "Administrador" || user?.role === "Supervisor" || user?.can_access_all_stores;

  const countByLine = useMemo(() => {
    const map = new Map<string, number>();
    for (const count of counts) map.set(count.line_key, (map.get(count.line_key) || 0) + numberValue(count.counted_qty));
    return map;
  }, [counts]);

  const filteredDeliveries = useMemo(() => deliveries.filter(line => lineMatches(line, query)), [deliveries, query]);
  const filteredReceptions = useMemo(() => receptions.filter(line => lineMatches(line, query)), [receptions, query]);
  const deliveryGroups = useMemo(() => groupLines(filteredDeliveries), [filteredDeliveries]);
  const receptionGroups = useMemo(() => groupLines(filteredReceptions), [filteredReceptions]);
  const visibleGroups = tab === "deliveries" ? deliveryGroups : receptionGroups;
  const activeGroup = useMemo(() => visibleGroups.find(group => supplyGroupKey(group) === activeGroupKey) || null, [visibleGroups, activeGroupKey]);
  const totalPages = Math.max(1, Math.ceil(visibleGroups.length / PAGE_SIZE));
  const pagedGroups = useMemo(() => visibleGroups.slice((listPage - 1) * PAGE_SIZE, listPage * PAGE_SIZE), [visibleGroups, listPage]);
  const activeGroupCounts = useMemo(() => {
    if (!activeGroup) return [];
    const keys = new Set(activeGroup.lines.map(line => line.line_key));
    return counts.filter(count => keys.has(count.line_key));
  }, [activeGroup, counts]);
  const selectedReceiptLine = useMemo(() => {
    if (!activeGroup) return null;
    return activeGroup.lines.find(line => line.line_key === selectedLineKey) || findLineInGroup(activeGroup, scanCode) || null;
  }, [activeGroup, selectedLineKey, scanCode]);

  const stats = useMemo(() => {
    const expected = receptions.reduce((sum, line) => sum + lineExpectedQty(line), 0);
    const counted = receptions.reduce((sum, line) => sum + (countByLine.get(line.line_key) || 0), 0);
    const pendingCodes = receptions.filter(line => (countByLine.get(line.line_key) || 0) < lineExpectedQty(line)).length;
    return {
      deliveries: deliveryGroups.length,
      receptions: receptionGroups.length,
      expected,
      counted,
      pendingCodes,
    };
  }, [receptions, countByLine, deliveryGroups, receptionGroups]);

  useEffect(() => {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) {
      window.location.href = "/";
      return;
    }
    const parsed = JSON.parse(raw) as CyclicUser;
    setUser(parsed);
    void loadInitial(parsed);
  }, []);

  useEffect(() => {
    sessionStorage.setItem(TAB_KEY, tab);
    setActiveGroupKey("");
    setListPage(1);
  }, [tab]);

  useEffect(() => {
    if (!user || !selectedStoreId) return;
    void loadSupplyData();
    const timer = window.setInterval(() => void loadSupplyData(false), 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [user, selectedStoreId]);

  useEffect(() => {
    scannerTargetRef.current = scannerTarget;
  }, [scannerTarget]);

  useEffect(() => {
    if (activeGroupKey && !visibleGroups.some(group => supplyGroupKey(group) === activeGroupKey)) {
      setActiveGroupKey("");
    }
  }, [activeGroupKey, visibleGroups]);

  useEffect(() => {
    setListPage(1);
  }, [query, selectedStoreId]);

  useEffect(() => {
    if (!activeGroup || tab !== "receptions") {
      setCounts([]);
      setSelectedLineKey("");
      return;
    }
    setSelectedLineKey("");
    void loadCounts(activeGroup.lines);
  }, [activeGroupKey, tab]);

  useEffect(() => {
    const onPopState = () => {
      if (!scannerTargetRef.current) return;
      scannerHistoryRef.current = false;
      void stopScanner(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!scannerTarget) return;
    let cancelled = false;
    (async () => {
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
          ],
        });
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: "environment" },
          { fps: 18, qrbox: { width: 320, height: 180 }, aspectRatio: 1.6, disableFlip: true },
          async decoded => {
            const target = scannerTargetRef.current;
            await stopScanner();
            applyScannedCode(decoded, target);
          },
          () => {}
        );
      } catch (err: any) {
        setMessage("No se pudo iniciar la camara: " + (err?.message || err));
        await stopScanner();
      }
    })();
    return () => { cancelled = true; void stopScanner(false); };
  }, [scannerTarget]);

  async function loadInitial(activeUser: CyclicUser) {
    setLoading(true);
    const { data, error } = await supabase
      .from("stores")
      .select("id,code,name,erp_sede,erp_store_no,is_active")
      .eq("is_active", true)
      .order("name", { ascending: true });
    if (error) {
      setMessage("No se pudieron cargar tiendas: " + error.message);
      setLoading(false);
      return;
    }
    const rows = (data || []) as Store[];
    setStores(rows);
    const preferred = activeUser.store_id && rows.find(store => store.id === activeUser.store_id);
    setSelectedStoreId((preferred || rows[0])?.id || "");
    setLoading(false);
  }

  async function loadSupplyData(showSpinner = true) {
    if (selectedStoreCodes.length === 0) return;
    if (showSpinner) setLoading(true);
    setMessage("");
    const deliveryQuery = supabase.from("abastecimiento_delivery_pending").select("*").order("creation_date", { ascending: false }).limit(1000);
    const receptionQuery = supabase.from("abastecimiento_reception_pending").select("*").order("request_created_at", { ascending: false }).limit(1000);
    if (!canSeeAllStores) {
      deliveryQuery.in("source_store_code", selectedStoreCodes);
      receptionQuery.in("destination_store_code", selectedStoreCodes);
    } else if (selectedStoreCodes.length > 0) {
      deliveryQuery.in("source_store_code", selectedStoreCodes);
      receptionQuery.in("destination_store_code", selectedStoreCodes);
    }
    const [deliveryRes, receptionRes] = await Promise.all([deliveryQuery, receptionQuery]);
    if (deliveryRes.error || receptionRes.error) {
      setMessage("Ejecuta la version actualizada de supabase_abastecimiento.sql y verifica que la tarea cargue abastecimiento_request_lines. " + (deliveryRes.error?.message || receptionRes.error?.message || ""));
      setLoading(false);
      return;
    }
    const receptionRows = (receptionRes.data || []) as SupplyLine[];
    setDeliveries((deliveryRes.data || []) as SupplyLine[]);
    setReceptions(receptionRows);
    if (!activeGroupKey) setCounts([]);
    setLastSync(new Date());
    setLoading(false);
  }

  async function loadCounts(lines: SupplyLine[]) {
    if (lines.length === 0) {
      setCounts([]);
      return;
    }
    const keys = [...new Set(lines.map(line => line.line_key).filter(Boolean))];
    const rows: ReceiptCount[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const { data, error } = await supabase
        .from("abastecimiento_receipt_counts")
        .select("*")
        .in("line_key", chunk)
        .order("counted_at", { ascending: false });
      if (error) {
        setMessage("No se pudieron leer conteos de recepcion: " + error.message);
        return;
      }
      rows.push(...((data || []) as ReceiptCount[]));
    }
    rows.sort((a, b) => String(b.counted_at || "").localeCompare(String(a.counted_at || "")));
    setCounts(rows);
  }

  function applyScannedCode(value: string, target = scannerTargetRef.current) {
    const clean = normalizeCode(value);
    if (!clean) return;
    if (target === "receipt") {
      setScanCode(clean);
      selectReceiptCode(clean);
      return;
    }
    setQuery(clean);
    searchInputRef.current?.focus();
  }

  function openScanner(target: Exclude<ScannerTarget, null>) {
    if (!scannerHistoryRef.current) {
      window.history.pushState({ supplyScanner: true }, "", window.location.href);
      scannerHistoryRef.current = true;
    }
    setTorchOn(false);
    setScannerTarget(target);
  }

  async function stopScanner(removeHistory = true) {
    setTorchOn(false);
    setScannerTarget(null);
    scannerTargetRef.current = null;
    try {
      if (scannerRef.current) {
        const state = scannerRef.current.getState?.();
        if (state !== 1) await scannerRef.current.stop();
        await scannerRef.current.clear();
      }
    } catch {}
    scannerRef.current = null;
    if (removeHistory && scannerHistoryRef.current) {
      scannerHistoryRef.current = false;
      window.history.back();
    }
  }

  async function toggleTorch() {
    try {
      const scanner = scannerRef.current;
      if (!scanner?.applyVideoConstraints) {
        setMessage("La linterna no esta disponible en este dispositivo.");
        return;
      }
      await scanner.applyVideoConstraints({ advanced: [{ torch: !torchOn }] });
      setTorchOn(prev => !prev);
    } catch {
      setMessage("La linterna no esta disponible en este dispositivo.");
    }
  }

  function findReceiptLine(code: string) {
    return activeGroup ? findLineInGroup(activeGroup, code) : null;
  }

  function selectReceiptCode(code: string) {
    const line = findReceiptLine(code);
    setSelectedLineKey(line?.line_key || "");
    setMessage(line ? "Codigo encontrado en este requerimiento." : "El codigo no esta en el requerimiento seleccionado.");
  }

  async function saveReceiptCount(forcedCode?: string) {
    if (!user || !activeGroup || tab !== "receptions") return;
    const code = normalizeCode(forcedCode || scanCode);
    const qty = numberValue(quantity || 1);
    if (!code || qty <= 0) {
      setMessage("Escanea o digita codigo y cantidad mayor a 0.");
      return;
    }
    const line = findReceiptLine(code);
    if (!line) {
      setMessage("El codigo no esta en el requerimiento seleccionado.");
      return;
    }
    setSaving(true);
    const payload = {
      line_key: line.line_key,
      document_no: line.document_no,
      destination_store_code: line.destination_store_code,
      source_store_code: line.source_store_code || null,
      product_code: line.product_code,
      description: line.description || null,
      expected_qty: lineExpectedQty(line),
      counted_qty: qty,
      counted_by: user.id,
      counted_by_name: user.full_name,
    };
    const { error } = await supabase.from("abastecimiento_receipt_counts").insert(payload);
    setSaving(false);
    if (error) {
      setMessage("No se pudo guardar conteo: " + error.message);
      return;
    }
    setMessage("Conteo registrado.");
    setScanCode("");
    setSelectedLineKey("");
    setQuantity("1");
    await loadCounts(activeGroup.lines);
  }

  function logout() {
    localStorage.removeItem(USER_KEY);
    window.location.href = "/";
  }

  if (!user) {
    return <main className="grid min-h-screen place-items-center bg-slate-100 text-slate-500">Cargando abastecimiento...</main>;
  }

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <header className="sticky top-0 z-20 border-b bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <button onClick={() => { window.location.href = "/dashboard"; }} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border bg-white">
              <ArrowLeft size={20} />
            </button>
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-emerald-700 text-white">
              <Truck size={25} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-black">Abastecimiento</h1>
              <p className="truncate text-sm text-slate-500">{user.full_name} - {selectedStore?.name || "tienda"}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void loadSupplyData()} className="grid h-11 w-11 place-items-center rounded-xl border bg-white" title="Actualizar">
              <RefreshCw size={20} />
            </button>
            <button onClick={() => { window.location.href = "/consulta-stock"; }} className="grid h-11 w-11 place-items-center rounded-xl border bg-white" title="Consulta de stock">
              <PackageSearch size={20} />
            </button>
            <button onClick={logout} className="grid h-11 w-11 place-items-center rounded-xl border bg-white" title="Salir">
              <LogOut size={20} />
            </button>
          </div>
        </div>
      </header>

      <section className="mx-auto grid max-w-7xl gap-4 p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <div className="grid gap-3 rounded-2xl border bg-white p-4 shadow-sm md:grid-cols-4">
            <Kpi label="Entregas pendientes" value={stats.deliveries} />
            <Kpi label="Recepciones pendientes" value={stats.receptions} />
            <Kpi label="Unidades esperadas" value={number2(stats.expected)} />
            <Kpi label="Unidades contadas" value={number2(stats.counted)} tone={stats.pendingCodes ? "amber" : "green"} />
          </div>
          <div className="rounded-2xl border bg-white p-4 text-sm text-slate-500 shadow-sm">
            <div className="font-black text-slate-900">Actualizacion</div>
            <div>{lastSync ? lastSync.toLocaleTimeString("es-PE") : "-"}</div>
            <div>Auto cada 5 min</div>
          </div>
        </div>

        <div className="grid gap-3 rounded-2xl border bg-white p-4 shadow-sm md:grid-cols-[auto_1fr_auto]">
          <div className="flex rounded-xl border bg-slate-50 p-1">
            <button onClick={() => setTab("deliveries")} className={`rounded-lg px-3 py-2 text-sm font-black ${tab === "deliveries" ? "bg-slate-900 text-white" : "text-slate-600"}`}>
              Entregas
            </button>
            <button onClick={() => setTab("receptions")} className={`rounded-lg px-3 py-2 text-sm font-black ${tab === "receptions" ? "bg-slate-900 text-white" : "text-slate-600"}`}>
              Recepciones
            </button>
          </div>
          <div className="flex min-w-0 rounded-xl border bg-white p-1">
            <Search className="ml-2 mt-3 shrink-0 text-slate-400" size={20} />
            <input ref={searchInputRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar codigo, barra, descripcion o documento" className="min-w-0 flex-1 px-3 py-2 text-sm outline-none" />
            <button onClick={() => openScanner("search")} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-slate-900 text-white" title="Escanear">
              <QrCode size={20} />
            </button>
          </div>
          {canSeeAllStores && (
            <select value={selectedStoreId} onChange={event => setSelectedStoreId(event.target.value)} className="rounded-xl border bg-white px-3 py-2 text-sm font-bold">
              {stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
            </select>
          )}
        </div>

        {message && <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">{message}</div>}
        {loading && <div className="rounded-2xl border bg-white p-6 text-center text-sm font-bold text-slate-500">Cargando datos...</div>}

        {!loading && activeGroup && (
          <section className="grid gap-4">
            <button onClick={() => setActiveGroupKey("")} className="flex w-fit items-center gap-2 rounded-xl border bg-white px-4 py-2 text-sm font-black">
              <ArrowLeft size={18} /> Volver a pendientes
            </button>
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-black uppercase text-slate-400">Documento / guia de remision</div>
                  <h2 className="text-2xl font-black">{activeGroup.document_no}</h2>
                  <div className="mt-2 grid gap-1 text-sm text-slate-600">
                    <span><b>Desde:</b> {storeLabel(activeGroup.source_store_code, activeGroup.source_store_name, storeNameByCode)}</span>
                    <span><b>Para:</b> {storeLabel(activeGroup.destination_store_code, activeGroup.destination_store_name, storeNameByCode)}</span>
                    <span><b>Creado:</b> {dateTime(activeGroup.request_date)}</span>
                    <span><b>Motivo:</b> {activeGroup.reason}</span>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <MiniMetric label="Codigos" value={activeGroup.lines.length} />
                  <MiniMetric label="Esperado" value={number2(activeGroup.lines.reduce((sum, line) => sum + lineExpectedQty(line), 0))} />
                  <MiniMetric label="Contado" value={number2(activeGroup.lines.reduce((sum, line) => sum + (countByLine.get(line.line_key) || 0), 0))} />
                </div>
              </div>
            </div>

            {tab === "receptions" && (
              <div className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div>
                    <h3 className="font-black">Verificar codigo y cantidad</h3>
                    <p className="text-xs text-slate-500">Escanea o digita el codigo del producto recibido.</p>
                  </div>
                  <ClipboardCheck className="text-emerald-700" size={24} />
                </div>
                <div className="grid gap-2 md:grid-cols-[1fr_180px_auto]">
                  <div className="flex rounded-xl border p-1">
                    <input
                      value={scanCode}
                      onChange={event => {
                        const value = event.target.value;
                        setScanCode(value);
                        if (normalizeCode(value)) selectReceiptCode(value);
                        else setSelectedLineKey("");
                      }}
                      placeholder="Codigo de producto"
                      className="min-w-0 flex-1 rounded-lg px-3 py-2 text-sm outline-none"
                    />
                    <button onClick={() => openScanner("receipt")} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-emerald-700 text-white">
                      <QrCode size={20} />
                    </button>
                  </div>
                  <input value={quantity} onChange={event => setQuantity(event.target.value)} inputMode="decimal" placeholder="Cantidad" className="rounded-xl border px-3 py-2 text-sm font-bold outline-none" />
                  <button onClick={() => void saveReceiptCount()} disabled={saving} className="rounded-xl bg-slate-900 px-5 py-2 text-sm font-black text-white disabled:opacity-50">
                    Guardar
                  </button>
                </div>
                {selectedReceiptLine && (
                  <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs font-black uppercase text-emerald-700">Codigo seleccionado</div>
                        <div className="font-black text-blue-700">{selectedReceiptLine.product_code}</div>
                        <div className="line-clamp-2 text-sm font-bold text-slate-700">{selectedReceiptLine.description}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-black">{number2(countByLine.get(selectedReceiptLine.line_key) || 0)} / {number2(lineExpectedQty(selectedReceiptLine))}</div>
                        <div className="text-xs font-bold text-slate-500">contado / esperado</div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="grid gap-3">
              <h3 className="text-lg font-black">Avance por codigo</h3>
              {activeGroup.lines.map(line => {
                const expected = lineExpectedQty(line);
                const counted = countByLine.get(line.line_key) || 0;
                const diff = counted - expected;
                const progress = expected > 0 ? Math.min(100, Math.max(0, (counted / expected) * 100)) : 0;
                return (
                  <div key={line.line_key} className="rounded-2xl border bg-white p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-black text-blue-700">{line.product_code}</div>
                        <div className="line-clamp-2 text-sm font-bold text-slate-700">{line.description}</div>
                      </div>
                      <div className={`rounded-lg px-2 py-1 text-xs font-black ${diff === 0 ? "bg-green-100 text-green-700" : diff > 0 ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"}`}>
                        {diff === 0 ? "OK" : diff > 0 ? "Sobrante" : "Faltante"}
                      </div>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-emerald-600" style={{ width: `${progress}%` }} />
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                      <MiniMetric label="Esperado" value={number2(expected)} />
                      <MiniMetric label="Contado" value={number2(counted)} />
                      <MiniMetric label="Dif." value={number2(diff)} />
                    </div>
                  </div>
                );
              })}
            </div>

            {tab === "receptions" && (
              <div className="rounded-2xl border bg-white p-4 shadow-sm">
                <h3 className="mb-3 text-lg font-black">Historial de registros</h3>
                <div className="grid gap-2">
                  {activeGroupCounts.map(count => (
                    <div key={count.id} className="grid gap-1 rounded-xl bg-slate-50 px-3 py-2 text-sm md:grid-cols-[1fr_auto_auto] md:items-center">
                      <div className="min-w-0">
                        <div className="font-black text-blue-700">{count.product_code}</div>
                        <div className="truncate text-slate-500">{count.description}</div>
                      </div>
                      <div className="font-black">{number2(count.counted_qty)}</div>
                      <div className="text-xs font-bold text-slate-400">{dateTime(count.counted_at)}</div>
                    </div>
                  ))}
                  {activeGroupCounts.length === 0 && <EmptyState text="Aun no hay registros para este requerimiento." />}
                </div>
              </div>
            )}
          </section>
        )}

        {!loading && !activeGroup && (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border bg-white px-4 py-3 text-sm font-bold text-slate-600">
              <span>{tab === "deliveries" ? "Entregas pendientes" : "Recepciones pendientes"}: {visibleGroups.length}</span>
              <div className="flex items-center gap-2">
                <button disabled={listPage <= 1} onClick={() => setListPage(page => Math.max(1, page - 1))} className="rounded-lg border px-3 py-2 disabled:opacity-40">Anterior</button>
                <span>Pagina {listPage} de {totalPages}</span>
                <button disabled={listPage >= totalPages} onClick={() => setListPage(page => Math.min(totalPages, page + 1))} className="rounded-lg border px-3 py-2 disabled:opacity-40">Siguiente</button>
              </div>
            </div>
            {pagedGroups.map(group => (
              <button
                key={supplyGroupKey(group)}
                onClick={() => setActiveGroupKey(supplyGroupKey(group))}
                className="text-left"
              >
                <TransferCard group={group} mode={tab === "deliveries" ? "delivery" : "reception"} countByLine={countByLine} storeNameByCode={storeNameByCode} />
              </button>
            ))}
            {visibleGroups.length === 0 && <EmptyState text={tab === "deliveries" ? "No hay entregas pendientes para esta tienda." : "No hay recepciones en transito para esta tienda."} />}
          </div>
        )}
      </section>

      {scannerTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="font-black">Escanear codigo</h3>
                <p className="text-xs text-slate-500">Apunta al codigo de barras.</p>
              </div>
              <button onClick={toggleTorch} className={`rounded-xl border px-3 py-2 text-sm font-black ${torchOn ? "bg-yellow-400" : "bg-slate-900 text-white"}`}>
                <Flashlight className="mr-2 inline" size={18} /> Linterna
              </button>
            </div>
            <div className="relative overflow-hidden rounded-xl border bg-black">
              <div id={scannerContainerId} className="min-h-[320px] w-full" />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-8">
                <div className="relative h-36 w-full max-w-sm border-2 border-white/90 bg-black/10">
                  <div className="absolute left-0 right-0 top-1/2 h-0.5 -translate-y-1/2 bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.9)]" />
                </div>
              </div>
            </div>
            <button onClick={() => void stopScanner()} className="mt-3 w-full rounded-xl border px-4 py-3 text-sm font-black text-slate-700">
              Cerrar camara
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function TransferCard({ group, mode, countByLine, storeNameByCode }: { group: SupplyGroup; mode: "delivery" | "reception"; countByLine: Map<string, number>; storeNameByCode: Map<string, string> }) {
  const expected = group.lines.reduce((sum, line) => sum + lineExpectedQty(line), 0);
  const counted = group.lines.reduce((sum, line) => sum + (countByLine.get(line.line_key) || 0), 0);
  const codes = group.lines.length;
  const from = storeLabel(group.source_store_code, group.source_store_name, storeNameByCode);
  const to = storeLabel(group.destination_store_code, group.destination_store_name, storeNameByCode);
  return (
    <article className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-black uppercase text-slate-400">Documento / guia de remision</div>
          <div className="flex items-center gap-2">
            {mode === "delivery" ? <ClipboardList size={20} /> : <PackageCheck size={20} />}
            <h3 className="font-black">{group.document_no}</h3>
          </div>
          <div className="mt-2 grid gap-1 text-sm text-slate-500">
            <span><b>Desde:</b> {from}</span>
            <span><b>{mode === "delivery" ? "Entregar a:" : "Para:"}</b> {to}</span>
            <span><b>Motivo:</b> {group.reason}</span>
          </div>
          {group.notes && <p className="mt-1 line-clamp-2 text-xs font-bold text-slate-500">{group.notes}</p>}
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <MiniMetric label="Codigos" value={codes} />
          <MiniMetric label={mode === "delivery" ? "Pend." : "Esperado"} value={number2(expected)} />
          <MiniMetric label="Contado" value={number2(counted)} />
        </div>
      </div>
      <div className="mt-3 grid gap-2">
        {group.lines.slice(0, 5).map(line => (
          <div key={line.line_key} className="grid grid-cols-[1fr_auto] gap-3 rounded-xl bg-slate-50 px-3 py-2">
            <div className="min-w-0">
              <div className="font-black text-blue-700">{line.product_code}</div>
              <div className="truncate text-sm text-slate-600">{line.description}</div>
            </div>
            <div className="text-right text-sm font-black">{number2(lineExpectedQty(line))}</div>
          </div>
        ))}
        {group.lines.length > 5 && <div className="text-center text-xs font-bold text-slate-400">+ {group.lines.length - 5} codigos mas</div>}
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
        <span>Creado: {dateTime(group.request_date)}</span>
        {mode === "reception" && <span>Entregado: {dateTime(group.delivered_at)}</span>}
      </div>
    </article>
  );
}

function Kpi({ label, value, tone = "slate" }: { label: string; value: string | number; tone?: "slate" | "amber" | "green" }) {
  const color = tone === "green" ? "text-green-700" : tone === "amber" ? "text-amber-600" : "text-slate-900";
  return (
    <div className="rounded-xl bg-slate-50 p-3 text-center">
      <div className={`text-xl font-black ${color}`}>{value}</div>
      <div className="mt-1 text-xs font-bold text-slate-500">{label}</div>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-white px-2 py-1">
      <div className="font-black text-slate-900">{value}</div>
      <div className="text-[10px] font-bold text-slate-400">{label}</div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border bg-white p-8 text-center text-sm font-bold text-slate-400">
      <XCircle className="mx-auto mb-2" size={28} />
      {text}
    </div>
  );
}
