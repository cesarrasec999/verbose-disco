"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Camera, CheckCircle2, ClipboardCheck, Edit3, LogOut, PackageSearch, Plus, Save, Search, Trash2, XCircle } from "lucide-react";
import { supabase } from "@/lib/supabase/client";

type Role = "Operario" | "Validador" | "Administrador";
type ScannerTarget = "product" | "location" | null;

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
  is_active: boolean;
};

type Product = {
  id: string;
  sku: string;
  barcode: string | null;
  description: string;
  unit: string;
  cost: number;
  is_active: boolean;
  system_stock?: number;
};

type AuditSession = {
  id: string;
  store_id: string;
  auditor_id: string;
  status: "in_progress" | "finished" | "cancelled";
  started_at: string;
  finished_at: string | null;
  store_name?: string;
  auditor_name?: string;
};

type AuditItem = {
  id: string;
  session_id: string;
  product_id: string;
  source: "selected" | "extra";
  system_stock: number;
  cost_snapshot: number;
  sku?: string;
  barcode?: string | null;
  description?: string;
  unit?: string;
};

type AuditCount = {
  id: string;
  session_id: string;
  item_id: string;
  product_id: string;
  location: string;
  quantity: number;
  counted_at: string;
  counted_by: string;
  sku?: string;
  description?: string;
  unit?: string;
};

function cleanCode(value: string | number | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const numeric = raw.replace(/\.0+$/, "").replace(/^0+/, "");
  return numeric || raw;
}

function normalizeText(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function smartMatch(description: string, query: string) {
  const words = normalizeText(description).split(/[^a-z0-9]+/).filter(Boolean);
  const terms = normalizeText(query).split(/\s+/).filter(Boolean);
  return terms.every(term => words.some(word => word.includes(term) || word.startsWith(term)));
}

function money(value: number) {
  return `S/ ${Number(value || 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function AuditoriaPage() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [sessions, setSessions] = useState<AuditSession[]>([]);
  const [storeId, setStoreId] = useState("");
  const [session, setSession] = useState<AuditSession | null>(null);
  const [items, setItems] = useState<AuditItem[]>([]);
  const [counts, setCounts] = useState<AuditCount[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanCode, setScanCode] = useState("");
  const [activeItem, setActiveItem] = useState<AuditItem | null>(null);
  const [location, setLocation] = useState("");
  const [qty, setQty] = useState("");
  const [editingCount, setEditingCount] = useState<AuditCount | null>(null);
  const [editLocation, setEditLocation] = useState("");
  const [editQty, setEditQty] = useState("");
  const [scannerTarget, setScannerTarget] = useState<ScannerTarget>(null);
  const scannerRef = useRef<any>(null);
  const scannerBusyRef = useRef(false);
  const scannerContainerId = "audit-scanner";
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const selectedStore = useMemo(() => stores.find(s => s.id === storeId), [stores, storeId]);

  useEffect(() => {
    const raw = localStorage.getItem("cyclic_user");
    if (!raw) { window.location.replace("/"); return; }
    const parsed = JSON.parse(raw) as CyclicUser;
    if (parsed.role === "Operario") { window.location.replace("/dashboard"); return; }
    setUser(parsed);

    supabase.from("stores").select("*").eq("is_active", true).order("name").then(({ data }) => {
      const list = (data || []) as Store[];
      setStores(list);
      setStoreId(parsed.store_id || list[0]?.id || "");
    });
    loadSessions();
  }, []);



  useEffect(() => {
    if (!scannerTarget) return;
    let cancelled = false;
    (async () => {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        if (cancelled) return;
        const scanner = new Html5Qrcode(scannerContainerId);
        scannerRef.current = scanner;
        scannerBusyRef.current = false;
        await scanner.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 260, height: 180 } },
          async (decodedText: string) => {
            if (scannerBusyRef.current) return;
            scannerBusyRef.current = true;
            const target = scannerTarget;
            await stopScanner();
            if (target === "product") {
              setScanCode(decodedText);
              await scanProduct(decodedText);
            } else if (target === "location") {
              setLocation(decodedText.trim().toUpperCase());
              setMessage("Ubicación escaneada: " + decodedText.trim().toUpperCase());
            }
          },
          () => {}
        );
      } catch (err: any) {
        setMessage("No se pudo iniciar la cámara: " + (err?.message || err));
        setScannerTarget(null);
      }
    })();
    return () => { cancelled = true; stopScanner(); };
  }, [scannerTarget]);

  async function stopScanner() {
    try {
      if (scannerRef.current) {
        const state = scannerRef.current.getState?.();
        if (state !== 1) await scannerRef.current.stop();
        await scannerRef.current.clear();
      }
    } catch {}
    scannerRef.current = null;
    scannerBusyRef.current = false;
    setScannerTarget(null);
  }

  async function loadSessions() {
    const { data } = await supabase
      .from("audit_sessions")
      .select("*, stores(name), cyclic_users(full_name)")
      .order("started_at", { ascending: false })
      .limit(50);
    setSessions((data || []).map((r: any) => ({ ...r, store_name: r.stores?.name, auditor_name: r.cyclic_users?.full_name })) as AuditSession[]);
  }

  async function openSession(row: AuditSession) {
    setSession(row);
    setStoreId(row.store_id);
    await loadSessionData(row.id);
  }

  async function getStockMap(products: Product[]) {
    if (!selectedStore || products.length === 0) return new Map<string, number>();
    const sede = selectedStore.erp_sede || selectedStore.name;
    const skus = [...new Set(products.map(p => cleanCode(p.sku)).filter(Boolean))];
    const map = new Map<string, number>();
    for (let i = 0; i < skus.length; i += 500) {
      const chunk = skus.slice(i, i + 500);
      const { data } = await supabase.from("stock_general").select("codsap, stock").eq("sede", sede).in("codsap", chunk);
      for (const row of data || []) map.set(cleanCode(row.codsap), Number(row.stock || 0));
    }
    return map;
  }

  async function createSession() {
    if (!user || !storeId) return;
    setLoading(true);
    const { data, error } = await supabase.from("audit_sessions").insert({
      store_id: storeId,
      auditor_id: user.id,
      status: "in_progress",
    }).select("*").single();
    setLoading(false);
    if (error) { setMessage("Error creando sesión: " + error.message); return; }
    setSession(data as AuditSession);
    setItems([]);
    setCounts([]);
    setMessage("Sesión de auditoría iniciada.");
  }

  async function searchFamily() {
    const terms = normalizeText(query).split(/\s+/).filter(Boolean);
    if (terms.length === 0) return;

    setLoading(true);
    setMessage("Buscando productos en la base de datos...");

    const pageSize = 1000;
    let from = 0;
    let allProducts: Product[] = [];

    while (true) {
      let request = supabase
        .from("cyclic_products")
        .select("*")
        .eq("is_active", true)
        .range(from, from + pageSize - 1);

      for (const term of terms) {
        request = request.ilike("description", `%${term}%`);
      }

      const { data, error } = await request;
      if (error) { setLoading(false); setMessage("Error buscando productos: " + error.message); return; }

      const page = (data || []) as Product[];
      allProducts = allProducts.concat(page);
      if (page.length < pageSize) break;
      from += pageSize;
    }

    const stockMap = await getStockMap(allProducts);
    const enriched = allProducts.map(p => ({ ...p, system_stock: stockMap.get(cleanCode(p.sku)) || 0 }));
    setResults(enriched);
    setSelected(new Set(enriched.map(p => p.id)));
    setLoading(false);
    setMessage(`${enriched.length} productos encontrados en la BD. Se seleccionaron todos.`);
  }

  async function addSelectedItems() {
    if (!session) return;
    const chosen = results.filter(p => selected.has(p.id));
    if (chosen.length === 0) { setMessage("Selecciona al menos un producto."); return; }
    const rows = chosen.map(p => ({
      session_id: session.id,
      product_id: p.id,
      source: "selected",
      system_stock: Number(p.system_stock || 0),
      cost_snapshot: Number(p.cost || 0),
    }));
    const { error } = await supabase.from("audit_session_items").upsert(rows, { onConflict: "session_id,product_id" });
    if (error) { setMessage("Error agregando productos: " + error.message); return; }
    await loadSessionData(session.id);
    setMessage(`${rows.length} productos agregados a la sesión.`);
  }

  async function loadSessionData(sessionId: string) {
    const { data: itemRows } = await supabase
      .from("audit_session_items")
      .select("*, cyclic_products(sku, barcode, description, unit)")
      .eq("session_id", sessionId)
      .order("created_at");
    setItems((itemRows || []).map((r: any) => ({
      ...r,
      sku: r.cyclic_products?.sku,
      barcode: r.cyclic_products?.barcode,
      description: r.cyclic_products?.description,
      unit: r.cyclic_products?.unit,
    })) as AuditItem[]);

    const { data: countRows } = await supabase.from("audit_counts").select("*").eq("session_id", sessionId).order("counted_at");
    setCounts((countRows || []) as AuditCount[]);
  }

  async function findProductByCode(code: string): Promise<Product | null> {
    const clean = cleanCode(code);
    if (!clean) return null;

    const { data: bySku } = await supabase.from("cyclic_products").select("*").eq("sku", clean).eq("is_active", true).maybeSingle();
    if (bySku) return bySku as Product;

    const { data: byBarcode } = await supabase.from("cyclic_products").select("*").eq("barcode", clean).eq("is_active", true).maybeSingle();
    if (byBarcode) return byBarcode as Product;

    const { data: mapped } = await supabase.from("codigos_barra").select("codsap").or(`upc.eq.${clean},alu.eq.${clean}`).limit(1).maybeSingle();
    if (!mapped?.codsap) return null;

    const { data: byMappedSku } = await supabase.from("cyclic_products").select("*").eq("sku", cleanCode(mapped.codsap)).eq("is_active", true).maybeSingle();
    return (byMappedSku as Product | null) || null;
  }

  async function scanProduct(codeOverride?: string) {
    const code = codeOverride ?? scanCode;
    if (!session || !code.trim()) return;
    const product = await findProductByCode(code);
    if (!product) { setMessage("Código no encontrado en maestro."); return; }

    let item = items.find(i => i.product_id === product.id) || null;
    if (!item) {
      const stockMap = await getStockMap([product]);
      const { data, error } = await supabase.from("audit_session_items").insert({
        session_id: session.id,
        product_id: product.id,
        source: "extra",
        system_stock: stockMap.get(cleanCode(product.sku)) || 0,
        cost_snapshot: Number(product.cost || 0),
      }).select("*, cyclic_products(sku, barcode, description, unit)").single();
      if (error) { setMessage("Error agregando extra: " + error.message); return; }
      item = {
        ...data,
        sku: data.cyclic_products?.sku,
        barcode: data.cyclic_products?.barcode,
        description: data.cyclic_products?.description,
        unit: data.cyclic_products?.unit,
      } as AuditItem;
      setItems(prev => [...prev, item!]);
      setMessage("Producto extra agregado a la auditoría.");
    }

    setActiveItem(item);
    setScanCode("");
    setQty("");
    setLocation("");
    setMessage(`Producto detectado: ${product.sku} - ${product.description}`);
  }

  async function saveCount() {
    if (!session || !activeItem) return;
    const quantity = Number(qty);
    if (!location.trim()) { setMessage("Ingresa ubicación."); return; }
    if (!Number.isFinite(quantity) || quantity < 0) { setMessage("Ingresa cantidad válida."); return; }
    const { error } = await supabase.from("audit_counts").insert({
      session_id: session.id,
      item_id: activeItem.id,
      product_id: activeItem.product_id,
      location: location.trim().toUpperCase(),
      quantity,
      counted_by: user?.id,
    });
    if (error) { setMessage("Error guardando conteo: " + error.message); return; }
    await loadSessionData(session.id);
    setActiveItem(null);
    setMessage("Conteo registrado.");
  }



  function startEdit(row: AuditCount) {
    setEditingCount(row);
    setEditLocation(row.location);
    setEditQty(String(row.quantity));
  }

  async function saveEdit() {
    if (!editingCount || !session) return;
    const quantity = Number(editQty);
    if (!editLocation.trim() || !Number.isFinite(quantity) || quantity < 0) { setMessage("Datos de edición inválidos."); return; }
    const { error } = await supabase.from("audit_counts").update({ location: editLocation.trim().toUpperCase(), quantity }).eq("id", editingCount.id);
    if (error) { setMessage("Error actualizando registro: " + error.message); return; }
    setEditingCount(null);
    await loadSessionData(session.id);
    setMessage("Registro actualizado.");
  }

  async function deleteCount(row: AuditCount) {
    if (!session || !confirm("¿Eliminar este registro de auditoría?")) return;
    const { error } = await supabase.from("audit_counts").delete().eq("id", row.id);
    if (error) { setMessage("Error eliminando registro: " + error.message); return; }
    await loadSessionData(session.id);
    setMessage("Registro eliminado.");
  }

  async function finishSession() {
    if (!session) return;
    const { error } = await supabase.from("audit_sessions").update({ status: "finished", finished_at: new Date().toISOString() }).eq("id", session.id);
    if (error) { setMessage("Error finalizando: " + error.message); return; }
    setSession({ ...session, status: "finished", finished_at: new Date().toISOString() });
    setMessage("Auditoría finalizada.");
  }

  const summaryRows = useMemo(() => items.map(item => {
    const total = counts.filter(c => c.item_id === item.id).reduce((acc, c) => acc + Number(c.quantity || 0), 0);
    const diff = total - Number(item.system_stock || 0);
    const value = diff * Number(item.cost_snapshot || 0);
    const status = counts.some(c => c.item_id === item.id)
      ? diff === 0 ? "OK" : diff > 0 ? "Sobrante" : "Faltante"
      : item.source === "extra" ? "Extra sin conteo" : "No contado";
    return { item, total, diff, value, status };
  }), [items, counts]);

  const totals = useMemo(() => {
    const audited = summaryRows.filter(r => r.status !== "No contado").length;
    const ok = summaryRows.filter(r => r.status === "OK").length;
    const eri = audited === 0 ? 0 : Math.round((ok / audited) * 100);
    return {
      audited,
      eri,
      missing: summaryRows.filter(r => r.status === "Faltante" || r.status === "No contado").length,
      surplus: summaryRows.filter(r => r.status === "Sobrante" || r.item.source === "extra").length,
      withStock: summaryRows.filter(r => Number(r.item.system_stock || 0) > 0).length,
      value: summaryRows.reduce((acc, r) => acc + r.value, 0),
    };
  }, [summaryRows]);

  function logout() {
    localStorage.removeItem("cyclic_user");
    window.location.href = "/";
  }

  if (!user) return <main className="min-h-screen grid place-items-center text-slate-500">Cargando...</main>;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <header className="sticky top-0 z-20 border-b bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
          <button onClick={() => window.location.href = "/dashboard"} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Volver al dashboard"><ArrowLeft size={18} /></button>
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-600 font-black text-white">R</div>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-bold leading-tight">Auditoría de existencias</h1>
            <p className="text-xs text-slate-500">{user.full_name} · {selectedStore?.name || "Selecciona tienda"}</p>
          </div>
          <select value={storeId} onChange={e => setStoreId(e.target.value)} disabled={!!session && session.status === "in_progress"} className="max-w-xs rounded-xl border bg-white px-3 py-2 text-sm">
            {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button onClick={logout} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Cerrar sesión"><LogOut size={18} /></button>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-4 px-4 py-5 lg:grid-cols-[380px_1fr]">
        <section className="space-y-4">
          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <h2 className="font-bold">Sesión</h2>
            <p className="mt-1 text-sm text-slate-500">Crea una sesión por tienda para registrar conteos físicos con ubicación y hora.</p>
            {!session ? (
              <button onClick={createSession} disabled={!storeId || loading} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white disabled:opacity-50"><ClipboardCheck size={18} /> Crear sesión</button>
            ) : (
              <div className="mt-4 space-y-2 text-sm">
                <div className="rounded-xl bg-green-50 p-3 font-semibold text-green-800">{session.status === "finished" ? "Finalizada" : "En progreso"}</div>
                <button onClick={finishSession} disabled={session.status !== "in_progress"} className="w-full rounded-xl bg-green-700 px-4 py-3 font-bold text-white disabled:opacity-40"><CheckCircle2 className="mr-2 inline" size={18} /> Finalizar auditoría</button>
              </div>
            )}
          </div>

          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <h2 className="font-bold">Sesiones recientes</h2>
            <div className="mt-3 max-h-56 overflow-auto space-y-2">
              {sessions.map(s => (
                <button key={s.id} onClick={() => openSession(s)} className="w-full rounded-xl border p-3 text-left text-xs hover:bg-slate-50">
                  <div className="font-bold text-slate-900">{s.store_name || s.store_id}</div>
                  <div className="text-slate-500">{new Date(s.started_at).toLocaleString("es-PE")} · {s.status === "finished" ? "Finalizada" : "En progreso"}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <h2 className="font-bold">Buscar familia</h2>
            <div className="mt-3 flex gap-2">
              <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter") searchFamily(); }} placeholder="far lat innov ambar" className="min-w-0 flex-1 rounded-xl border px-3 py-2 text-sm" />
              <button onClick={searchFamily} disabled={!session || loading} className="rounded-xl bg-blue-700 px-3 text-white disabled:opacity-40"><Search size={18} /></button>
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={() => setSelected(new Set(results.map(p => p.id)))} className="rounded-lg border px-3 py-1.5 text-xs font-semibold">Seleccionar todo</button>
              <button onClick={() => setSelected(new Set())} className="rounded-lg border px-3 py-1.5 text-xs font-semibold">Quitar todo</button>
            </div>
            <button onClick={addSelectedItems} disabled={!session || selected.size === 0} className="mt-3 w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"><Plus className="mr-2 inline" size={16} /> Agregar seleccionados</button>
          </div>

          {message && <div className="rounded-2xl border border-blue-200 bg-blue-50 p-3 text-sm font-semibold text-blue-800">{message}</div>}
        </section>

        <section className="space-y-4">
          {results.length > 0 && (
            <div className="rounded-2xl border bg-white shadow-sm">
              <div className="border-b px-4 py-3 font-bold">Resultados ({results.length})</div>
              <div className="max-h-72 overflow-auto">
                {results.map(p => (
                  <label key={p.id} className="flex cursor-pointer items-center gap-3 border-b px-4 py-3 text-sm hover:bg-slate-50">
                    <input type="checkbox" checked={selected.has(p.id)} onChange={() => setSelected(prev => { const next = new Set(prev); next.has(p.id) ? next.delete(p.id) : next.add(p.id); return next; })} />
                    <div className="min-w-0 flex-1">
                      <div className="font-bold">{p.sku}</div>
                      <div className="truncate text-slate-600">{p.description}</div>
                      <div className="text-xs text-slate-400">UM: {p.unit} · Stock: {p.system_stock || 0} · Costo: {money(p.cost)}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <h2 className="font-bold">Conteo físico</h2>
            <div className="mt-3 flex gap-2">
              <input value={scanCode} onChange={e => setScanCode(e.target.value)} onKeyDown={e => { if (e.key === "Enter") scanProduct(); }} placeholder="Escanea o digita código/barra" className="min-w-0 flex-1 rounded-xl border px-3 py-2 text-sm" />
              <button onClick={() => scanProduct()} disabled={!session || session.status !== "in_progress"} className="rounded-xl bg-slate-900 px-4 text-white disabled:opacity-40"><PackageSearch size={18} /></button>
            </div>
            <button onClick={() => setScannerTarget("product")} disabled={!session || session.status !== "in_progress"} className="mt-2 w-full rounded-xl bg-blue-700 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"><Camera className="mr-2 inline" size={16} />Escanear producto</button>
            {activeItem && (
              <div className="mt-4 rounded-xl border bg-slate-50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-bold">{activeItem.sku}</div>
                    <div className="text-sm text-slate-600">{activeItem.description}</div>
                    <div className="text-xs text-slate-400">Stock sistema: {activeItem.system_stock} · {activeItem.source === "extra" ? "Extra encontrado" : "Lista inicial"}</div>
                  </div>
                  <button onClick={() => setActiveItem(null)} className="text-slate-400"><XCircle size={18} /></button>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <input value={location} onChange={e => setLocation(e.target.value)} placeholder="Ubicación" className="rounded-xl border px-3 py-2 text-sm" />
                  <input value={qty} onChange={e => setQty(e.target.value)} placeholder="Cantidad" type="number" className="rounded-xl border px-3 py-2 text-sm" />
                </div>
                <button onClick={saveCount} className="mt-3 w-full rounded-xl bg-green-700 px-4 py-2.5 text-sm font-bold text-white">Guardar conteo</button>
              </div>
            )}
          </div>


          <div className="rounded-2xl border bg-white shadow-sm">
            <div className="border-b px-4 py-3 font-bold">Registros realizados ({counts.length})</div>
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-100 text-xs text-slate-600"><tr><th className="p-2 text-left">Código</th><th className="p-2 text-left">Descripción</th><th className="p-2">UM</th><th className="p-2">Ubicación</th><th className="p-2">Cant.</th><th className="p-2">Fecha/hora</th><th className="p-2">Acción</th></tr></thead>
                <tbody>{counts.map(c => {
                  const item = items.find(i => i.id === c.item_id);
                  return <tr key={c.id} className="border-b hover:bg-slate-50"><td className="p-2 font-bold">{item?.sku || c.sku}</td><td className="max-w-xs truncate p-2">{item?.description || c.description}</td><td className="p-2 text-center">{item?.unit || c.unit}</td><td className="p-2 text-center font-semibold">{c.location}</td><td className="p-2 text-center font-bold">{c.quantity}</td><td className="p-2 text-center text-xs">{new Date(c.counted_at).toLocaleString("es-PE")}</td><td className="p-2 text-center"><button onClick={() => startEdit(c)} className="rounded-lg border px-2 py-1 text-blue-700"><Edit3 size={14} /></button><button onClick={() => deleteCount(c)} className="ml-1 rounded-lg border px-2 py-1 text-red-600"><Trash2 size={14} /></button></td></tr>;
                })}</tbody>
              </table>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-5">
            <div className="rounded-2xl bg-white p-4 shadow-sm"><div className="text-xs text-slate-500">ERI</div><div className="text-2xl font-black">{totals.eri}%</div></div>
            <div className="rounded-2xl bg-white p-4 shadow-sm"><div className="text-xs text-slate-500">Códigos con stock</div><div className="text-2xl font-black">{totals.withStock}</div></div>
            <div className="rounded-2xl bg-white p-4 shadow-sm"><div className="text-xs text-slate-500">Faltantes / no contados</div><div className="text-2xl font-black text-red-600">{totals.missing}</div></div>
            <div className="rounded-2xl bg-white p-4 shadow-sm"><div className="text-xs text-slate-500">Sobrantes / extras</div><div className="text-2xl font-black text-blue-700">{totals.surplus}</div></div>
            <div className="rounded-2xl bg-white p-4 shadow-sm"><div className="text-xs text-slate-500">Dif. valorizada</div><div className="text-lg font-black">{money(totals.value)}</div></div>
          </div>

          <div className="rounded-2xl border bg-white shadow-sm">
            <div className="border-b px-4 py-3 font-bold">Resumen de sesión ({summaryRows.length})</div>
            <div className="max-h-[420px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-100 text-xs text-slate-600">
                  <tr><th className="p-2 text-left">Código</th><th className="p-2 text-left">Descripción</th><th className="p-2">Stock</th><th className="p-2">Contado</th><th className="p-2">Dif.</th><th className="p-2">Valor</th><th className="p-2">Estado</th></tr>
                </thead>
                <tbody>
                  {summaryRows.map(r => (
                    <tr key={r.item.id} className="border-b hover:bg-slate-50">
                      <td className="p-2 font-bold">{r.item.sku}</td>
                      <td className="max-w-sm truncate p-2">{r.item.description}</td>
                      <td className="p-2 text-center">{r.item.system_stock}</td>
                      <td className="p-2 text-center font-semibold">{r.total}</td>
                      <td className={`p-2 text-center font-bold ${r.diff < 0 ? "text-red-600" : r.diff > 0 ? "text-blue-700" : "text-green-700"}`}>{r.diff > 0 ? "+" : ""}{r.diff}</td>
                      <td className="p-2 text-center text-xs">{money(r.value)}</td>
                      <td className="p-2 text-center text-xs font-bold">{r.item.source === "extra" ? "Extra · " : ""}{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
      {scannerTarget && (<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><div className="w-full max-w-lg rounded-2xl bg-white p-4 shadow-2xl"><div className="mb-3 flex items-center justify-between"><h3 className="font-bold">{scannerTarget === "product" ? "Escanear producto" : "Escanear ubicación"}</h3><button onClick={stopScanner} className="rounded-lg border p-2"><XCircle size={18} /></button></div><div className="overflow-hidden rounded-xl bg-black"><div id={scannerContainerId} className="min-h-[280px] w-full" /></div></div></div>)}
      {editingCount && (<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"><div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"><h3 className="font-bold">Editar registro</h3><input value={editLocation} onChange={e => setEditLocation(e.target.value)} className="mt-4 w-full rounded-xl border px-3 py-3 text-sm" placeholder="Ubicación" /><input value={editQty} onChange={e => setEditQty(e.target.value)} className="mt-2 w-full rounded-xl border px-3 py-3 text-sm" type="number" placeholder="Cantidad" /><div className="mt-4 flex gap-2"><button onClick={saveEdit} className="flex-1 rounded-xl bg-green-700 px-4 py-3 text-sm font-bold text-white"><Save className="mr-2 inline" size={16} />Guardar</button><button onClick={() => setEditingCount(null)} className="rounded-xl border px-4 py-3 text-sm font-bold">Cancelar</button></div></div></div>)}
    </main>
  );
}
