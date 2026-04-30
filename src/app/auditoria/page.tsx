"use client";

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BarChart3, CheckCircle2, ClipboardCheck, ClipboardList, Download, Edit3, FileText, Flashlight, LogOut, Mail, PackageSearch, Plus, QrCode, RefreshCw, Save, Search, Settings2, Trash2, XCircle } from "lucide-react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase/client";

type Role = "Operario" | "Validador" | "Administrador";
type ScannerTarget = "product" | "location" | null;
type MainTab = "sessions" | "register";
type RegisterTab = "count" | "records" | "summary";
type SummarySortKey = "sku" | "description" | "unit" | "stock" | "counted" | "diff" | "value" | "status" | "observation";
type SortDirection = "asc" | "desc";

const AUDIT_MAIN_TAB_KEY = "audit_main_tab";
const AUDIT_REGISTER_TAB_KEY = "audit_register_tab";
const AUDIT_SESSION_ID_KEY = "audit_session_id";

type CyclicUser = {
  id: string;
  username: string;
  full_name: string;
  role: Role;
  store_id: string | null;
  can_access_all_stores: boolean;
  can_access_audit?: boolean;
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
  observation?: string | null;
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
  observation?: string | null;
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

function codeCandidates(value: string | number | null | undefined): string[] {
  const raw = String(value ?? "").trim();
  const clean = cleanCode(raw);
  const withoutPrefix = raw.replace(/^[A-Za-z]+/, "");
  const withoutPrefixClean = cleanCode(withoutPrefix);
  const withAuPrefix = withoutPrefixClean ? `AU${withoutPrefixClean.padStart(7, "0")}` : "";
  const padded = withoutPrefixClean ? withoutPrefixClean.padStart(7, "0") : "";
  return Array.from(new Set([raw, clean, withoutPrefix, withoutPrefixClean, padded, withAuPrefix].filter(Boolean)));
}

function mappedProductCodeCandidates(row: Record<string, unknown> | null | undefined): string[] {
  if (!row) return [];
  const values = Object.entries(row)
    .filter(([key]) => ["codsap", "codigosap", "productreference", "sku"].includes(key.toLowerCase().replace(/[^a-z0-9]/g, "")))
    .flatMap(([, value]) => codeCandidates(String(value ?? "")));
  return Array.from(new Set(values));
}

function normalizeText(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
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
  const [torchOn, setTorchOn] = useState(false);
  const [mainTab, setMainTab] = useState<MainTab>(() => {
    if (typeof window === "undefined") return "register";
    const saved = sessionStorage.getItem(AUDIT_MAIN_TAB_KEY);
    if (saved === "sessions" || saved === "register") return saved;
    return window.matchMedia("(max-width: 767px)").matches ? "register" : "sessions";
  });
  const [registerTab, setRegisterTab] = useState<RegisterTab>(() => {
    if (typeof window === "undefined") return "count";
    const saved = sessionStorage.getItem(AUDIT_REGISTER_TAB_KEY);
    if (saved === "count" || saved === "records" || saved === "summary") return saved;
    return window.matchMedia("(max-width: 767px)").matches ? "records" : "count";
  });
  const [recordsQuery, setRecordsQuery] = useState("");
  const [summaryQuery, setSummaryQuery] = useState("");
  const [summarySort, setSummarySort] = useState<{ key: SummarySortKey; direction: SortDirection }>({ key: "value", direction: "desc" });
  const [itemObservationDrafts, setItemObservationDrafts] = useState<Record<string, string>>({});
  const [savingItemObservationId, setSavingItemObservationId] = useState<string | null>(null);
  const [itemStockDrafts, setItemStockDrafts] = useState<Record<string, string>>({});
  const [savingItemStockId, setSavingItemStockId] = useState<string | null>(null);
  const [leadAuditor, setLeadAuditor] = useState("");
  const [storeLeader, setStoreLeader] = useState("");
  const [warehouseAdvisor, setWarehouseAdvisor] = useState("");
  const [emailHTML, setEmailHTML] = useState("");
  const [showEmailModal, setShowEmailModal] = useState(false);
  const scannerRef = useRef<any>(null);
  const scannerBusyRef = useRef(false);
  const scannerTargetRef = useRef<ScannerTarget>(null);
  const scannerHistoryRef = useRef(false);
  const scannerContainerId = "audit-scanner";
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const selectedStore = useMemo(() => stores.find(s => s.id === storeId), [stores, storeId]);

  useEffect(() => {
    const raw = localStorage.getItem("cyclic_user");
    if (!raw) { window.location.replace("/"); return; }
    const parsed = JSON.parse(raw) as CyclicUser;
    if (parsed.role === "Operario") { window.location.replace("/dashboard"); return; }
    supabase.from("cyclic_users").select("*").eq("id", parsed.id).maybeSingle().then(({ data }) => {
      const currentUser = (data || parsed) as CyclicUser;
      if (currentUser.role !== "Administrador" && !currentUser.can_access_audit) {
        window.location.replace("/dashboard");
        return;
      }
      setUser(currentUser);
      localStorage.setItem("cyclic_user", JSON.stringify(currentUser));
    });

    supabase.from("stores").select("*").eq("is_active", true).order("name").then(({ data }) => {
      const list = (data || []) as Store[];
      setStores(list);
      setStoreId(parsed.store_id || list[0]?.id || "");
    });
    loadSessions();
    const savedSessionId = sessionStorage.getItem(AUDIT_SESSION_ID_KEY);
    if (savedSessionId) void loadSavedSession(savedSessionId);
  }, []);

  useEffect(() => {
    sessionStorage.setItem(AUDIT_MAIN_TAB_KEY, mainTab);
  }, [mainTab]);

  useEffect(() => {
    sessionStorage.setItem(AUDIT_REGISTER_TAB_KEY, registerTab);
  }, [registerTab]);

  useEffect(() => {
    if (session?.id) sessionStorage.setItem(AUDIT_SESSION_ID_KEY, session.id);
    else sessionStorage.removeItem(AUDIT_SESSION_ID_KEY);
  }, [session?.id]);

  useEffect(() => {
    if (!user) return;
    const refresh = () => {
      if (session?.id) void loadSavedSession(session.id);
      void loadSessions();
    };
    const channel = supabase.channel(`audit-live-${user.id}-${session?.id || "none"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "audit_counts" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "audit_session_items" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "audit_sessions" }, refresh)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, session?.id]);


  useEffect(() => {
    scannerTargetRef.current = scannerTarget;
  }, [scannerTarget]);

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
        const { Html5Qrcode } = await import("html5-qrcode");
        if (cancelled) return;
        const scanner = new Html5Qrcode(scannerContainerId);
        scannerRef.current = scanner;
        scannerBusyRef.current = false;
        await scanner.start(
          { facingMode: "environment" },
          { fps: 15, qrbox: { width: 280, height: 190 }, aspectRatio: 1.6 },
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
        await stopScanner();
      }
    })();
    return () => { cancelled = true; void stopScanner(false); };
  }, [scannerTarget]);

  function openScanner(target: Exclude<ScannerTarget, null>) {
    if (!scannerHistoryRef.current) {
      window.history.pushState({ auditScanner: true }, "", window.location.href);
      scannerHistoryRef.current = true;
    }
    setTorchOn(false);
    setScannerTarget(target);
  }

  async function stopScanner(removeHistory = true) {
    scannerTargetRef.current = null;
    setTorchOn(false);
    setScannerTarget(null);
    try {
      if (scannerRef.current) {
        const state = scannerRef.current.getState?.();
        if (state !== 1) await scannerRef.current.stop();
        await scannerRef.current.clear();
      }
    } catch {}
    scannerRef.current = null;
    scannerBusyRef.current = false;
    if (removeHistory && scannerHistoryRef.current) {
      scannerHistoryRef.current = false;
      window.history.back();
    }
  }

  async function toggleTorch() {
    try {
      const next = !torchOn;
      const scanner = scannerRef.current;
      if (!scanner?.applyVideoConstraints) {
        setMessage("La linterna no está disponible en este dispositivo.");
        return;
      }
      await scanner.applyVideoConstraints({ advanced: [{ torch: next }] });
      setTorchOn(next);
    } catch {
      setMessage("La linterna no está disponible en este dispositivo.");
    }
  }

  async function loadSessions() {
    const { data } = await supabase
      .from("audit_sessions")
      .select("*, stores(name), cyclic_users(full_name)")
      .order("started_at", { ascending: false })
      .limit(50);
    setSessions((data || []).map((r: any) => ({ ...r, store_name: r.stores?.name, auditor_name: r.cyclic_users?.full_name })) as AuditSession[]);
  }

  async function loadSavedSession(sessionId: string) {
    const { data } = await supabase
      .from("audit_sessions")
      .select("*, stores(name), cyclic_users(full_name)")
      .eq("id", sessionId)
      .maybeSingle();
    if (!data) {
      sessionStorage.removeItem(AUDIT_SESSION_ID_KEY);
      return;
    }
    const row = { ...data, store_name: data.stores?.name, auditor_name: data.cyclic_users?.full_name } as AuditSession;
    setSession(row);
    setStoreId(row.store_id);
    await loadSessionData(row.id);
  }

  async function refreshAuditData() {
    setLoading(true);
    await loadSessions();
    if (session?.id) await loadSavedSession(session.id);
    setLoading(false);
    setMessage("Datos actualizados.");
  }

  async function openSession(row: AuditSession) {
    setSession(row);
    setStoreId(row.store_id);
    setMainTab("register");
    setRegisterTab(user?.role === "Administrador" ? "records" : "count");
    await loadSessionData(row.id);
  }

  async function getStockMap(products: Product[]) {
    const store = selectedStore || stores.find(s => s.id === session?.store_id);
    if (!store || products.length === 0) return new Map<string, number>();
    const sede = String(store.erp_sede || store.name || "").trim();
    const candidateToSku = new Map<string, string>();
    for (const product of products) {
      const skuKey = cleanCode(product.sku);
      if (!skuKey) continue;
      for (const candidate of codeCandidates(product.sku)) {
        candidateToSku.set(candidate, skuKey);
        candidateToSku.set(cleanCode(candidate), skuKey);
      }
      for (const candidate of codeCandidates(product.barcode)) {
        candidateToSku.set(candidate, skuKey);
        candidateToSku.set(cleanCode(candidate), skuKey);
      }
    }
    const lookupCodes = [...new Set(candidateToSku.keys())].filter(Boolean);
    for (let i = 0; i < lookupCodes.length; i += 500) {
      const chunk = lookupCodes.slice(i, i + 500);
      const [{ data: byUpc }, { data: byAlu }, { data: byCodsap }] = await Promise.all([
        supabase.from("codigos_barra").select("codsap, upc, alu").in("upc", chunk),
        supabase.from("codigos_barra").select("codsap, upc, alu").in("alu", chunk),
        supabase.from("codigos_barra").select("codsap, upc, alu").in("codsap", chunk),
      ]);
      for (const row of [...(byUpc || []), ...(byAlu || []), ...(byCodsap || [])]) {
        const skuKey =
          candidateToSku.get(String(row.upc || "")) ||
          candidateToSku.get(cleanCode(row.upc)) ||
          candidateToSku.get(String(row.alu || "")) ||
          candidateToSku.get(cleanCode(row.alu)) ||
          candidateToSku.get(String(row.codsap || "")) ||
          candidateToSku.get(cleanCode(row.codsap));
        if (!skuKey) continue;
        for (const candidate of codeCandidates(row.codsap)) {
          candidateToSku.set(candidate, skuKey);
          candidateToSku.set(cleanCode(candidate), skuKey);
        }
      }
    }
    const skus = [...new Set(candidateToSku.keys())].filter(Boolean);
    const map = new Map<string, number>();
    for (let i = 0; i < skus.length; i += 500) {
      const chunk = skus.slice(i, i + 500);
      const { data } = await supabase.from("stock_general").select("codsap, stock").eq("sede", sede).in("codsap", chunk);
      for (const row of data || []) {
        const skuKey = candidateToSku.get(String(row.codsap || "")) || candidateToSku.get(cleanCode(row.codsap));
        if (skuKey) map.set(skuKey, Number(row.stock || 0));
      }
    }
    return map;
  }

  async function refreshAuditItemStock(item: AuditItem) {
    return item;
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
    sessionStorage.setItem(AUDIT_SESSION_ID_KEY, data.id);
    await loadSessions();
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
    const existingProductIds = new Set(items.map(item => item.product_id));
    const selectedProducts = results.filter(p => selected.has(p.id));
    const chosen = selectedProducts.filter(p => !existingProductIds.has(p.id));
    if (selectedProducts.length === 0) { setMessage("Selecciona al menos un producto."); return; }
    if (chosen.length === 0) { setMessage("Los productos seleccionados ya están en la fotografía de esta auditoría."); return; }
    const rows = chosen.map(p => ({
      session_id: session.id,
      product_id: p.id,
      source: "selected",
      system_stock: Number(p.system_stock || 0),
      cost_snapshot: Number(p.cost || 0),
    }));
    const { error } = await supabase.from("audit_session_items").insert(rows);
    if (error) { setMessage("Error agregando productos: " + error.message); return; }
    await loadSessionData(session.id);
    const omitted = selectedProducts.length - rows.length;
    setMessage(`${rows.length} productos agregados a la sesión.${omitted > 0 ? ` ${omitted} ya estaban en la fotografía y no se modificaron.` : ""}`);
  }

  async function loadSessionData(sessionId: string) {
    const { data: itemRows } = await supabase
      .from("audit_session_items")
      .select("*, cyclic_products(sku, barcode, description, unit)")
      .eq("session_id", sessionId)
      .order("created_at");
    const mappedItems = (itemRows || []).map((r: any) => ({
      ...r,
      sku: r.cyclic_products?.sku,
      barcode: r.cyclic_products?.barcode,
      description: r.cyclic_products?.description,
      unit: r.cyclic_products?.unit,
    })) as AuditItem[];
    setItems(mappedItems);
    setItemObservationDrafts(Object.fromEntries(mappedItems.map(item => [item.id, item.observation || ""])));
    setItemStockDrafts(Object.fromEntries(mappedItems.map(item => [item.id, String(Number(item.system_stock || 0))])));

    const { data: countRows } = await supabase.from("audit_counts").select("*").eq("session_id", sessionId).order("counted_at", { ascending: false });
    setCounts((countRows || []) as AuditCount[]);
  }

  async function findProductByCode(code: string): Promise<Product | null> {
    const candidates = codeCandidates(code);
    if (candidates.length === 0) return null;

    for (const candidate of candidates) {
      const { data: bySku } = await supabase.from("cyclic_products").select("*").eq("sku", candidate).eq("is_active", true).maybeSingle();
      if (bySku) return bySku as Product;
    }

    for (const candidate of candidates) {
      const { data: byBarcode } = await supabase.from("cyclic_products").select("*").eq("barcode", candidate).eq("is_active", true).maybeSingle();
      if (byBarcode) return byBarcode as Product;
    }

    for (const candidate of candidates) {
      const { data: mapped } = await supabase
        .from("codigos_barra")
        .select("*")
        .or(`upc.eq.${candidate},alu.eq.${candidate}`)
        .not("codsap", "is", null)
        .limit(1)
        .maybeSingle();

      for (const mappedCandidate of mappedProductCodeCandidates(mapped as Record<string, unknown> | null)) {
        const { data: byMappedSku } = await supabase.from("cyclic_products").select("*").eq("sku", mappedCandidate).eq("is_active", true).maybeSingle();
        if (byMappedSku) return byMappedSku as Product;
      }
    }

    return null;
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

    item = await refreshAuditItemStock(item);
    setActiveItem(item);
    setScanCode("");
    setQty("");
    setLocation("");
    setMessage(`Producto detectado: ${product.sku} - ${product.description} - UM: ${product.unit || item?.unit || "N/D"}`);
  }

  async function saveCount() {
    if (!session || !activeItem) return;
    const quantity = Number(qty);
    if (!location.trim()) { setMessage("Ingresa ubicación."); return; }
    if (!Number.isFinite(quantity) || quantity < 0) { setMessage("Ingresa cantidad válida."); return; }
    const currentItem = await refreshAuditItemStock(activeItem);
    const { error } = await supabase.from("audit_counts").insert({
      session_id: session.id,
      item_id: currentItem.id,
      product_id: currentItem.product_id,
      location: location.trim().toUpperCase(),
      quantity,
      counted_by: user?.id,
    });
    if (error) { setMessage("Error guardando conteo: " + error.message); return; }
    await loadSessionData(session.id);
    setActiveItem(null);
    setMessage(`Conteo registrado: ${quantity} ${currentItem.unit || "UM"}. Stock sistema usado para el resumen: ${currentItem.system_stock}.`);
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

  async function deleteSession(row: AuditSession) {
    if (user?.role !== "Administrador") {
      setMessage("Solo el administrador puede eliminar sesiones.");
      return;
    }
    if (!confirm(`¿Eliminar la sesión de auditoría de ${row.store_name || row.store_id}? Esta acción borrará sus productos y conteos.`)) return;
    const { error } = await supabase.from("audit_sessions").delete().eq("id", row.id);
    if (error) { setMessage("Error eliminando sesión: " + error.message); return; }
    if (session?.id === row.id) {
      setSession(null);
      setItems([]);
      setCounts([]);
      setActiveItem(null);
    }
    await loadSessions();
    setMessage("Sesión eliminada.");
  }

  async function saveItemObservation(itemId: string) {
    if (!session) return;
    const text = (itemObservationDrafts[itemId] || "").trim();
    setSavingItemObservationId(itemId);
    const { error } = await supabase
      .from("audit_session_items")
      .update({ observation: text || null })
      .eq("id", itemId);
    setSavingItemObservationId(null);
    if (error) {
      setMessage("Error guardando observación por código: " + error.message + ". Ejecuta supabase_auditoria.sql para crear la columna y recargar el schema cache.");
      return;
    }
    setItems(prev => prev.map(item => item.id === itemId ? { ...item, observation: text || null } : item));
    setMessage("Observación del código guardada.");
  }

  async function saveItemStockSnapshot(itemId: string) {
    if (!session || user?.role !== "Administrador") return;
    const stock = Number(itemStockDrafts[itemId]);
    if (!Number.isFinite(stock) || stock < 0) {
      setMessage("Ingresa un stock sistema válido.");
      return;
    }
    setSavingItemStockId(itemId);
    const { error } = await supabase
      .from("audit_session_items")
      .update({ system_stock: stock })
      .eq("id", itemId);
    setSavingItemStockId(null);
    if (error) {
      setMessage("Error actualizando stock de la fotografía: " + error.message);
      return;
    }
    setItems(prev => prev.map(item => item.id === itemId ? { ...item, system_stock: stock } : item));
    setItemStockDrafts(prev => ({ ...prev, [itemId]: String(stock) }));
    setMessage("Stock de la fotografía actualizado solo para esta auditoría.");
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
      ok,
      missing: summaryRows.filter(r => r.diff < 0).length,
      surplus: summaryRows.filter(r => r.diff > 0).length,
      withStock: summaryRows.filter(r => Number(r.item.system_stock || 0) > 0).length,
      value: summaryRows.reduce((acc, r) => acc + r.value, 0),
    };
  }, [summaryRows]);

  const filteredSummaryRows = useMemo(() => {
    const term = normalizeText(summaryQuery.trim());
    const valueForSort = (row: typeof summaryRows[number]) => {
      switch (summarySort.key) {
        case "sku": return row.item.sku || "";
        case "description": return row.item.description || "";
        case "unit": return row.item.unit || "";
        case "stock": return Number(row.item.system_stock || 0);
        case "counted": return row.total;
        case "diff": return row.diff;
        case "value": return row.value;
        case "status": return row.status;
        case "observation": return itemObservationDrafts[row.item.id] ?? row.item.observation ?? "";
        default: return "";
      }
    };
    return [...summaryRows]
      .filter(row => {
        if (!term) return true;
        const haystack = normalizeText([
          row.item.sku,
          row.item.barcode,
          row.item.description,
          row.item.unit,
          row.item.system_stock,
          row.total,
          row.diff,
          row.value,
          row.status,
          itemObservationDrafts[row.item.id] ?? row.item.observation ?? "",
        ].join(" "));
        return haystack.includes(term);
      })
      .sort((a, b) => {
        const aValue = valueForSort(a);
        const bValue = valueForSort(b);
        const multiplier = summarySort.direction === "asc" ? 1 : -1;
        if (typeof aValue === "number" && typeof bValue === "number") {
          return (aValue - bValue) * multiplier;
        }
        return String(aValue).localeCompare(String(bValue), "es", { numeric: true, sensitivity: "base" }) * multiplier;
      });
  }, [summaryRows, summaryQuery, summarySort, itemObservationDrafts]);

  const filteredCounts = useMemo(() => {
    const term = normalizeText(recordsQuery.trim());
    return [...counts]
      .sort((a, b) => new Date(b.counted_at).getTime() - new Date(a.counted_at).getTime())
      .filter(count => {
        if (!term) return true;
        const item = items.find(row => row.id === count.item_id);
        const haystack = normalizeText([
          item?.sku || count.sku,
          item?.description || count.description,
          item?.unit || count.unit,
          count.location,
          count.quantity,
          new Date(count.counted_at).toLocaleString("es-PE"),
        ].join(" "));
        return haystack.includes(term);
      });
  }, [counts, items, recordsQuery]);

  function changeSummarySort(key: SummarySortKey) {
    setSummarySort(prev => ({
      key,
      direction: prev.key === key && prev.direction === "desc" ? "asc" : "desc",
    }));
  }

  function summarySortMark(key: SummarySortKey) {
    if (summarySort.key !== key) return "";
    return summarySort.direction === "desc" ? " v" : " ^";
  }

  function downloadSummaryExcel() {
    if (filteredSummaryRows.length === 0) {
      setMessage("No hay filas en el resumen para descargar.");
      return;
    }
    const rows = filteredSummaryRows.map(r => ({
      Codigo: r.item.sku,
      Descripcion: r.item.description || "",
      UM: r.item.unit || "N/D",
      "Stock foto": Number(r.item.system_stock || 0),
      Contado: r.total,
      "Dif.": r.diff,
      Valor: Number(r.value || 0),
      Estado: `${r.item.source === "extra" ? "Extra - " : ""}${r.status}`,
      Observacion: itemObservationDrafts[r.item.id] ?? r.item.observation ?? "",
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet["!cols"] = [
      { wch: 14 },
      { wch: 48 },
      { wch: 10 },
      { wch: 12 },
      { wch: 12 },
      { wch: 10 },
      { wch: 14 },
      { wch: 18 },
      { wch: 42 },
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Resumen por codigo");
    const storeName = (selectedStore?.name || session?.store_name || "tienda").replace(/[\\/:*?"<>|]+/g, "_");
    XLSX.writeFile(workbook, `resumen_por_codigo_${storeName}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function escapeHTML(value: string | number | null | undefined) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function svgDataUrl(svg: string) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function auditBarChart(title: string, data: { label: string; value: number; color: string }[]) {
    const width = 640;
    const height = 260;
    const max = Math.max(1, ...data.map(d => Math.abs(d.value)));
    const bars = data.map((d, index) => {
      const x = 70 + index * 135;
      const barHeight = Math.max(6, Math.round((Math.abs(d.value) / max) * 140));
      const y = 190 - barHeight;
      return `<g><rect x="${x}" y="${y}" width="72" height="${barHeight}" rx="8" fill="${d.color}"/><text x="${x + 36}" y="${y - 10}" text-anchor="middle" font-size="18" font-weight="800" fill="#0f172a">${escapeHTML(d.value)}</text><text x="${x + 36}" y="222" text-anchor="middle" font-size="12" font-weight="700" fill="#475569">${escapeHTML(d.label)}</text></g>`;
    }).join("");
    return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="640" height="260" rx="18" fill="#f8fafc"/><text x="28" y="34" font-size="17" font-weight="900" fill="#0f172a">${escapeHTML(title)}</text><line x1="48" y1="194" x2="594" y2="194" stroke="#cbd5e1" stroke-width="1"/>${bars}</svg>`);
  }

  function buildAuditReportHTML() {
    if (!session) return "";
    const storeName = selectedStore?.name || session.store_name || "Tienda";
    const topMissing = [...summaryRows]
      .filter(r => r.diff < 0)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, 10);
    const topSurplus = [...summaryRows]
      .filter(r => r.diff > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
    const chart = auditBarChart("Indicadores de auditoría", [
      { label: "Sobrantes", value: totals.surplus, color: "#2563eb" },
      { label: "Faltantes", value: totals.missing, color: "#dc2626" },
      { label: "OK", value: totals.ok, color: "#16a34a" },
    ]);
    const diffRow = (r: typeof summaryRows[number]) => `
          <tr>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-weight:800;color:#0f172a;">${escapeHTML(r.item.sku)}</td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;color:#475569;">${escapeHTML(r.item.description)}</td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center;font-weight:800;color:#334155;">${escapeHTML(r.item.unit || "N/D")}</td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center;">${escapeHTML(r.item.system_stock)}</td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center;font-weight:800;">${escapeHTML(r.total)}</td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center;font-weight:900;color:${r.diff < 0 ? "#dc2626" : "#2563eb"};">${r.diff > 0 ? "+" : ""}${escapeHTML(r.diff)}</td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center;font-weight:800;">${escapeHTML(money(r.value))}</td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;color:#334155;">${escapeHTML(r.item.observation || "")}</td>
          </tr>`;
    const missingRows = topMissing.length === 0
      ? `<tr><td colspan="8" style="padding:12px;text-align:center;color:#64748b;">Sin faltantes registrados.</td></tr>`
      : topMissing.map(diffRow).join("");
    const surplusRows = topSurplus.length === 0
      ? `<tr><td colspan="8" style="padding:12px;text-align:center;color:#64748b;">Sin sobrantes registrados.</td></tr>`
      : topSurplus.map(diffRow).join("");
    const today = new Date().toLocaleString("es-PE");
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Informe auditoría ${escapeHTML(storeName)}</title></head>
<body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
  <div style="max-width:760px;margin:24px auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;">
    <div style="background:#0f172a;padding:28px 32px;color:#ffffff;">
      <div style="font-size:12px;font-weight:900;letter-spacing:1.8px;color:#93c5fd;">WMS AUDITORIA DE EXISTENCIAS</div>
      <h1 style="margin:8px 0 4px;font-size:25px;line-height:1.2;">Informe de auditoría</h1>
      <p style="margin:0;color:#cbd5e1;font-size:14px;">${escapeHTML(storeName)} - ${escapeHTML(user?.full_name || "")} - ${escapeHTML(today)}</p>
    </div>
    <div style="padding:28px 32px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px;"><tr>
        <td style="padding:6px;"><div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px;text-align:center;"><div style="font-size:28px;font-weight:900;color:#16a34a;">${totals.eri}%</div><div style="font-size:11px;font-weight:800;color:#64748b;">ERI</div></div></td>
        <td style="padding:6px;"><div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px;text-align:center;"><div style="font-size:28px;font-weight:900;color:#2563eb;">${totals.surplus}</div><div style="font-size:11px;font-weight:800;color:#64748b;">SOBRANTE</div></div></td>
        <td style="padding:6px;"><div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px;text-align:center;"><div style="font-size:28px;font-weight:900;color:#dc2626;">${totals.missing}</div><div style="font-size:11px;font-weight:800;color:#64748b;">FALTANTE</div></div></td>
        <td style="padding:6px;"><div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px;text-align:center;"><div style="font-size:28px;font-weight:900;color:#16a34a;">${totals.ok}</div><div style="font-size:11px;font-weight:800;color:#64748b;">OK</div></div></td>
        <td style="padding:6px;"><div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px;text-align:center;"><div style="font-size:22px;font-weight:900;color:${totals.value < 0 ? "#dc2626" : "#2563eb"};">${escapeHTML(money(totals.value))}</div><div style="font-size:11px;font-weight:800;color:#64748b;">DIF. VALORIZADA</div></div></td>
      </tr></table>
      <h2 style="font-size:16px;margin:0 0 10px;border-left:4px solid #2563eb;padding-left:10px;">Dashboard compatible</h2>
      <div style="border:1px solid #e2e8f0;border-radius:12px;padding:12px;margin-bottom:22px;background:#f8fafc;"><img src="${chart}" width="640" style="max-width:100%;display:block;" alt="Gráfico auditoría"/></div>
      <h2 style="font-size:16px;margin:0 0 10px;border-left:4px solid #dc2626;padding-left:10px;">Top faltantes</h2>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;font-size:13px;">
        <thead><tr style="background:#f1f5f9;color:#475569;"><th style="padding:9px;text-align:left;">CÓDIGO</th><th style="padding:9px;text-align:left;">DESCRIPCIÓN</th><th style="padding:9px;text-align:center;">UM</th><th style="padding:9px;text-align:center;">STOCK</th><th style="padding:9px;text-align:center;">CONTADO</th><th style="padding:9px;text-align:center;">DIF.</th><th style="padding:9px;text-align:center;">VALOR</th><th style="padding:9px;text-align:left;">OBSERVACIÓN</th></tr></thead>
        <tbody>${missingRows}</tbody>
      </table>
      <h2 style="font-size:16px;margin:24px 0 10px;border-left:4px solid #2563eb;padding-left:10px;">Top sobrantes</h2>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;font-size:13px;">
        <thead><tr style="background:#f1f5f9;color:#475569;"><th style="padding:9px;text-align:left;">CÓDIGO</th><th style="padding:9px;text-align:left;">DESCRIPCIÓN</th><th style="padding:9px;text-align:center;">UM</th><th style="padding:9px;text-align:center;">STOCK</th><th style="padding:9px;text-align:center;">CONTADO</th><th style="padding:9px;text-align:center;">DIF.</th><th style="padding:9px;text-align:center;">VALOR</th><th style="padding:9px;text-align:left;">OBSERVACIÓN</th></tr></thead>
        <tbody>${surplusRows}</tbody>
      </table>
      <h2 style="font-size:16px;margin:24px 0 10px;border-left:4px solid #16a34a;padding-left:10px;">Firmas de conformidad</h2>
      <table width="100%" cellpadding="0" cellspacing="8" style="margin-top:6px;">
        <tr>
          <td style="width:33.33%;padding:16px;border:1px solid #e2e8f0;border-radius:12px;text-align:center;vertical-align:bottom;height:104px;">
            <div style="height:42px;border-bottom:1.5px solid #0f172a;margin-bottom:8px;"></div>
            <div style="font-weight:900;font-size:12px;color:#0f172a;">${escapeHTML(leadAuditor)}</div>
            <div style="font-size:11px;color:#64748b;">Auditor líder</div>
          </td>
          <td style="width:33.33%;padding:16px;border:1px solid #e2e8f0;border-radius:12px;text-align:center;vertical-align:bottom;height:104px;">
            <div style="height:42px;border-bottom:1.5px solid #0f172a;margin-bottom:8px;"></div>
            <div style="font-weight:900;font-size:12px;color:#0f172a;">${escapeHTML(storeLeader)}</div>
            <div style="font-size:11px;color:#64748b;">Líder de tienda</div>
          </td>
          <td style="width:33.33%;padding:16px;border:1px solid #e2e8f0;border-radius:12px;text-align:center;vertical-align:bottom;height:104px;">
            <div style="height:42px;border-bottom:1.5px solid #0f172a;margin-bottom:8px;"></div>
            <div style="font-weight:900;font-size:12px;color:#0f172a;">${escapeHTML(warehouseAdvisor)}</div>
            <div style="font-size:11px;color:#64748b;">Asesor de almacén</div>
          </td>
        </tr>
      </table>
      <div style="margin:24px 0 0;text-align:right;">
        <span style="display:inline-flex;align-items:center;gap:8px;color:#0f172a;font-weight:900;font-size:13px;">
          <span style="display:inline-block;width:24px;height:24px;border-radius:7px;background:#0f172a;color:#ffffff;text-align:center;line-height:24px;font-size:15px;font-weight:900;">R</span>
          Rasecorp
        </span>
      </div>
    </div>
  </div>
</body></html>`;
  }

  function generateAuditReport() {
    if (!session) { setMessage("Selecciona una sesión para generar el informe."); return; }
    if (!leadAuditor.trim() || !storeLeader.trim() || !warehouseAdvisor.trim()) {
      setMessage("Completa auditor líder, líder de tienda y asesor de almacén antes de generar el informe.");
      return;
    }
    const html = buildAuditReportHTML();
    setEmailHTML(html);
    setShowEmailModal(true);
  }

  function downloadAuditReport() {
    const html = emailHTML || buildAuditReportHTML();
    if (!html) return;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `informe_auditoria_${selectedStore?.name || "tienda"}_${new Date().toISOString().slice(0, 10)}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function openEmailDraft() {
    if (!session) return;
    const subject = `Informe auditoría ${selectedStore?.name || session.store_name || ""}`;
    window.open(`https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(subject)}`, "_blank");
    setMessage("Se abrió Gmail. Descarga o copia el informe HTML y pégalo en el cuerpo del correo.");
  }

  function logout() {
    localStorage.removeItem("cyclic_user");
    window.location.href = "/";
  }

  if (!user) return <main className="min-h-screen grid place-items-center text-slate-500">Cargando...</main>;

  const tabClass = (active: boolean) => `flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-bold transition ${active ? "bg-slate-900 text-white shadow-sm" : "bg-white text-slate-600 hover:bg-slate-50"}`;
  const subTabClass = (active: boolean) => `flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold transition ${active ? "border-blue-700 bg-blue-700 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-3 py-3 md:px-5">
          <button onClick={() => window.location.href = "/dashboard"} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Volver al dashboard"><ArrowLeft size={18} /></button>
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 font-black text-white">W</div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-black leading-tight">Auditoria WMS</h1>
            <p className="truncate text-xs text-slate-500">{user.full_name} - {selectedStore?.name || "Selecciona tienda"}</p>
          </div>
          <select value={storeId} onChange={e => setStoreId(e.target.value)} disabled={!!session && session.status === "in_progress"} className="hidden max-w-xs rounded-xl border bg-white px-3 py-2 text-sm md:block">
            {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button onClick={refreshAuditData} disabled={loading} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50 disabled:opacity-40" title="Actualizar datos"><RefreshCw size={18} className={loading ? "animate-spin" : ""} /></button>
          <button onClick={logout} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Cerrar sesión"><LogOut size={18} /></button>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-3 py-4 md:px-5">
        <div className="mb-4 grid grid-cols-2 gap-2 rounded-2xl border bg-white p-1.5 shadow-sm">
          <button onClick={() => setMainTab("sessions")} className={tabClass(mainTab === "sessions")}><Settings2 size={16} /> Sesiones</button>
          <button onClick={() => setMainTab("register")} className={tabClass(mainTab === "register")}><ClipboardList size={16} /> Registro</button>
        </div>

        {message && <div className="mb-4 rounded-2xl border border-blue-200 bg-blue-50 p-3 text-sm font-semibold text-blue-800">{message}</div>}

        {mainTab === "sessions" && (
          <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
            <section className="space-y-4">
              <div className="rounded-2xl border bg-white p-4 shadow-sm">
                <h2 className="font-black">Crear sesión de auditoría</h2>
                <p className="mt-1 text-sm text-slate-500">Selecciona tienda, inicia la auditoría y carga la familia de productos a contar.</p>
                <select value={storeId} onChange={e => setStoreId(e.target.value)} disabled={!!session && session.status === "in_progress"} className="mt-4 w-full rounded-xl border bg-white px-3 py-3 text-sm md:hidden">
                  {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                {!session ? (
                  <button onClick={createSession} disabled={!storeId || loading} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white disabled:opacity-50"><ClipboardCheck size={18} /> Crear sesión</button>
                ) : (
                  <div className="mt-4 space-y-2 text-sm">
                    <div className="rounded-xl bg-green-50 p-3 font-bold text-green-800">{session.status === "finished" ? "Finalizada" : "En progreso"}</div>
                    <button onClick={finishSession} disabled={session.status !== "in_progress"} className="w-full rounded-xl bg-green-700 px-4 py-3 font-bold text-white disabled:opacity-40"><CheckCircle2 className="mr-2 inline" size={18} /> Finalizar auditoría</button>
                  </div>
                )}
              </div>

              <div className="rounded-2xl border bg-white p-4 shadow-sm">
                <h2 className="font-black">Buscar familia</h2>
                <div className="mt-3 flex gap-2">
                  <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter") searchFamily(); }} placeholder="far lat innov ambar" className="min-w-0 flex-1 rounded-xl border px-3 py-3 text-sm" />
                  <button onClick={searchFamily} disabled={!session || loading} className="rounded-xl bg-blue-700 px-4 text-white disabled:opacity-40" title="Buscar"><Search size={18} /></button>
                </div>
                <div className="mt-3 flex gap-2">
                  <button onClick={() => setSelected(new Set(results.map(p => p.id)))} className="rounded-lg border px-3 py-1.5 text-xs font-semibold">Seleccionar todo</button>
                  <button onClick={() => setSelected(new Set())} className="rounded-lg border px-3 py-1.5 text-xs font-semibold">Quitar todo</button>
                </div>
                <button onClick={addSelectedItems} disabled={!session || selected.size === 0} className="mt-3 w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white disabled:opacity-40"><Plus className="mr-2 inline" size={16} /> Agregar seleccionados</button>
              </div>
            </section>

            <section className="space-y-4">
              <div className="rounded-2xl border bg-white p-4 shadow-sm">
                <h2 className="font-black">Sesiones recientes</h2>
                <div className="mt-3 grid max-h-80 gap-2 overflow-auto md:grid-cols-2">
                  {sessions.map(s => (
                    <div key={s.id} className={`rounded-xl border p-3 text-xs hover:bg-slate-50 ${session?.id === s.id ? "border-blue-600 bg-blue-50" : ""}`}>
                      <button onClick={() => openSession(s)} className="w-full text-left">
                        <div className="font-black text-slate-900">{s.store_name || s.store_id}</div>
                        <div className="text-slate-500">{new Date(s.started_at).toLocaleString("es-PE")} - {s.status === "finished" ? "Finalizada" : "En progreso"}</div>
                      </button>
                      {user.role === "Administrador" && (
                        <button onClick={() => deleteSession(s)} className="mt-2 rounded-lg border border-red-200 px-2 py-1 text-xs font-black text-red-600 hover:bg-red-50">
                          <Trash2 className="mr-1 inline" size={13} /> Eliminar
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {results.length > 0 && (
                <div className="rounded-2xl border bg-white shadow-sm">
                  <div className="border-b px-4 py-3 font-black">Resultados ({results.length})</div>
                  <div className="max-h-96 overflow-auto">
                    {results.map(p => (
                      <label key={p.id} className="flex cursor-pointer items-center gap-3 border-b px-4 py-3 text-sm hover:bg-slate-50">
                        <input type="checkbox" checked={selected.has(p.id)} onChange={() => setSelected(prev => { const next = new Set(prev); if (next.has(p.id)) next.delete(p.id); else next.add(p.id); return next; })} />
                        <div className="min-w-0 flex-1">
                          <div className="font-black">{p.sku}</div>
                          <div className="truncate text-slate-600">{p.description}</div>
                          <div className="text-xs text-slate-400">UM: {p.unit} - Stock: {p.system_stock || 0} - Costo: {money(p.cost)}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {mainTab === "register" && (
          <section className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <button onClick={() => setRegisterTab("count")} className={subTabClass(registerTab === "count")}><PackageSearch size={15} /> Contar</button>
              <button onClick={() => setRegisterTab("records")} className={subTabClass(registerTab === "records")}><ClipboardList size={15} /> Registros</button>
              <button onClick={() => setRegisterTab("summary")} className={subTabClass(registerTab === "summary")}><BarChart3 size={15} /> Resumen</button>
            </div>

            {registerTab === "count" && (
              <div className="mx-auto max-w-2xl rounded-2xl border bg-white p-4 shadow-sm md:p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-black">Conteo fisico</h2>
                    <p className="text-xs text-slate-500">Pantalla compacta para celular.</p>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs font-black ${session?.status === "in_progress" ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-500"}`}>{session?.status === "in_progress" ? "Activa" : "Sin sesión"}</span>
                </div>

                <div className="mt-4 space-y-3">
                  <label className="block text-xs font-black uppercase tracking-wide text-slate-500">Producto</label>
                  <div className="flex rounded-2xl border bg-white p-1 focus-within:ring-2 focus-within:ring-blue-200">
                    <input value={scanCode} onChange={e => setScanCode(e.target.value)} onKeyDown={e => { if (e.key === "Enter") scanProduct(); }} placeholder="Escanea o digita código/barra" className="min-w-0 flex-1 rounded-xl px-3 py-3 text-base outline-none" />
                    <button onClick={() => openScanner("product")} disabled={!session || session.status !== "in_progress"} className="grid h-12 w-12 place-items-center rounded-xl bg-slate-900 text-white disabled:opacity-40" title="Escanear QR producto"><QrCode size={22} /></button>
                  </div>
                  <button onClick={() => scanProduct()} disabled={!session || session.status !== "in_progress"} className="w-full rounded-xl bg-blue-700 px-4 py-3 text-sm font-black text-white disabled:opacity-40"><PackageSearch className="mr-2 inline" size={16} /> Buscar producto</button>
                </div>

                {activeItem && (
                  <div className="mt-4 rounded-2xl border bg-slate-50 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-lg font-black">{activeItem.sku}</div>
                        <div className="line-clamp-2 text-sm text-slate-600">{activeItem.description}</div>
                        <div className="mt-1 text-xs font-semibold text-slate-400">UM: {activeItem.unit || "N/D"} - Stock sistema: {activeItem.system_stock} - {activeItem.source === "extra" ? "Extra encontrado" : "Lista inicial"}</div>
                      </div>
                      <button onClick={() => setActiveItem(null)} className="text-slate-400"><XCircle size={20} /></button>
                    </div>
                    <div className="mt-4 space-y-3">
                      <label className="block text-xs font-black uppercase tracking-wide text-slate-500">Ubicacion</label>
                      <div className="flex rounded-2xl border bg-white p-1 focus-within:ring-2 focus-within:ring-green-200">
                        <input value={location} onChange={e => setLocation(e.target.value)} placeholder="Escanea ubicación" className="min-w-0 flex-1 rounded-xl px-3 py-3 text-base font-semibold uppercase outline-none" />
                        <button onClick={() => openScanner("location")} disabled={!session || session.status !== "in_progress"} className="grid h-12 w-12 place-items-center rounded-xl bg-green-700 text-white disabled:opacity-40" title="Escanear QR ubicación"><QrCode size={22} /></button>
                      </div>
                      <label className="block text-xs font-black uppercase tracking-wide text-slate-500">Cantidad</label>
                      <input value={qty} onChange={e => setQty(e.target.value)} placeholder="0" inputMode="decimal" type="number" className="w-full rounded-2xl border px-4 py-4 text-center text-2xl font-black outline-none focus:ring-2 focus:ring-blue-200" />
                      <button onClick={saveCount} className="w-full rounded-2xl bg-green-700 px-4 py-4 text-base font-black text-white">Guardar conteo</button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {registerTab === "records" && (
              <div className="rounded-2xl border bg-white shadow-sm">
                <div className="border-b px-4 py-3">
                  <div className="font-black">Registros realizados ({filteredCounts.length}/{counts.length})</div>
                  <div className="mt-3 flex rounded-2xl border bg-white p-1 focus-within:ring-2 focus-within:ring-blue-200">
                    <input
                      value={recordsQuery}
                      onChange={e => setRecordsQuery(e.target.value)}
                      placeholder="Buscar código, descripción, UM o ubicación"
                      className="min-w-0 flex-1 rounded-xl px-3 py-2 text-sm outline-none"
                    />
                    <Search className="mx-3 self-center text-slate-400" size={18} />
                  </div>
                </div>
                <div className="max-h-[70vh] overflow-auto">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead className="sticky top-0 bg-slate-100 text-xs text-slate-600"><tr><th className="p-2 text-left">Código</th><th className="p-2 text-left">Descripción</th><th className="p-2">UM</th><th className="p-2">Ubicación</th><th className="p-2">Cant.</th><th className="p-2">Fecha/hora</th><th className="p-2">Acción</th></tr></thead>
                    <tbody>{filteredCounts.map(c => {
                      const item = items.find(i => i.id === c.item_id);
                      return <tr key={c.id} className="border-b hover:bg-slate-50"><td className="p-2 font-black">{item?.sku || c.sku}</td><td className="max-w-xs truncate p-2">{item?.description || c.description}</td><td className="p-2 text-center">{item?.unit || c.unit}</td><td className="p-2 text-center font-semibold">{c.location}</td><td className="p-2 text-center font-black">{c.quantity}</td><td className="p-2 text-center text-xs">{new Date(c.counted_at).toLocaleString("es-PE")}</td><td className="p-2 text-center"><button onClick={() => startEdit(c)} className="rounded-lg border px-2 py-1 text-blue-700"><Edit3 size={14} /></button><button onClick={() => deleteCount(c)} className="ml-1 rounded-lg border px-2 py-1 text-red-600"><Trash2 size={14} /></button></td></tr>;
                    })}</tbody>
                  </table>
                </div>
              </div>
            )}

            {registerTab === "summary" && (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <div className="rounded-2xl bg-white p-4 shadow-sm"><div className="text-xs text-slate-500">ERI</div><div className="text-2xl font-black">{totals.eri}%</div></div>
                  <div className="rounded-2xl bg-white p-4 shadow-sm"><div className="text-xs text-slate-500">Sobrante</div><div className="text-2xl font-black text-blue-700">{totals.surplus}</div></div>
                  <div className="rounded-2xl bg-white p-4 shadow-sm"><div className="text-xs text-slate-500">Faltante</div><div className="text-2xl font-black text-red-600">{totals.missing}</div></div>
                  <div className="rounded-2xl bg-white p-4 shadow-sm"><div className="text-xs text-slate-500">OK</div><div className="text-2xl font-black text-green-700">{totals.ok}</div></div>
                  <div className="rounded-2xl bg-white p-4 shadow-sm"><div className="text-xs text-slate-500">Dif. valorizada</div><div className="text-lg font-black">{money(totals.value)}</div></div>
                </div>

                <div className="rounded-2xl border bg-white p-4 shadow-sm">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h2 className="font-black">Informe de auditoría</h2>
                      <p className="text-xs text-slate-500">Completa los responsables antes de generar el informe.</p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={generateAuditReport} disabled={!session} className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-black text-white disabled:opacity-40"><FileText className="mr-1 inline" size={15} /> Generar informe</button>
                      <button onClick={openEmailDraft} disabled={!session} className="rounded-xl border px-3 py-2 text-xs font-black text-slate-700 disabled:opacity-40"><Mail className="mr-1 inline" size={15} /> Correo</button>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <input value={leadAuditor} onChange={e => setLeadAuditor(e.target.value)} placeholder="Auditor líder" className="rounded-xl border px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-200" />
                    <input value={storeLeader} onChange={e => setStoreLeader(e.target.value)} placeholder="Líder de tienda" className="rounded-xl border px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-200" />
                    <input value={warehouseAdvisor} onChange={e => setWarehouseAdvisor(e.target.value)} placeholder="Asesor de almacén" className="rounded-xl border px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-200" />
                  </div>
                </div>

                <div className="rounded-2xl border bg-white shadow-sm">
                  <div className="border-b px-4 py-3">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <div className="font-black">Resumen por código ({filteredSummaryRows.length}/{summaryRows.length})</div>
                      <button onClick={downloadSummaryExcel} disabled={filteredSummaryRows.length === 0} className="inline-flex items-center justify-center rounded-xl bg-green-700 px-3 py-2 text-xs font-black text-white disabled:opacity-40">
                        <Download className="mr-1" size={15} /> Descargar Excel
                      </button>
                    </div>
                    <div className="mt-3 flex rounded-2xl border bg-white p-1 focus-within:ring-2 focus-within:ring-blue-200">
                      <input
                        value={summaryQuery}
                        onChange={e => setSummaryQuery(e.target.value)}
                        placeholder="Buscar código, descripción, UM, estado u observación"
                        className="min-w-0 flex-1 rounded-xl px-3 py-2 text-sm outline-none"
                      />
                      <Search className="mx-3 self-center text-slate-400" size={18} />
                    </div>
                  </div>
                  <div className="max-h-[520px] overflow-auto">
                    <table className="w-full min-w-[1160px] text-sm">
                      <thead className="sticky top-0 bg-slate-100 text-xs text-slate-600">
                        <tr>
                          <th className="p-2 text-left"><button onClick={() => changeSummarySort("sku")} className="font-black">Código{summarySortMark("sku")}</button></th>
                          <th className="p-2 text-left"><button onClick={() => changeSummarySort("description")} className="font-black">Descripción{summarySortMark("description")}</button></th>
                          <th className="p-2"><button onClick={() => changeSummarySort("unit")} className="font-black">UM{summarySortMark("unit")}</button></th>
                          <th className="p-2"><button onClick={() => changeSummarySort("stock")} className="font-black">Stock foto{summarySortMark("stock")}</button></th>
                          <th className="p-2"><button onClick={() => changeSummarySort("counted")} className="font-black">Contado{summarySortMark("counted")}</button></th>
                          <th className="p-2"><button onClick={() => changeSummarySort("diff")} className="font-black">Dif.{summarySortMark("diff")}</button></th>
                          <th className="p-2"><button onClick={() => changeSummarySort("value")} className="font-black">Valor{summarySortMark("value")}</button></th>
                          <th className="p-2"><button onClick={() => changeSummarySort("status")} className="font-black">Estado{summarySortMark("status")}</button></th>
                          <th className="p-2 text-left"><button onClick={() => changeSummarySort("observation")} className="font-black">Observación{summarySortMark("observation")}</button></th>
                          <th className="p-2">Guardar</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredSummaryRows.map(r => (
                          <tr key={r.item.id} className="border-b hover:bg-slate-50">
                            <td className="p-2 font-black">{r.item.sku}</td>
                            <td className="max-w-sm truncate p-2">{r.item.description}</td>
                            <td className="p-2 text-center text-xs font-black">{r.item.unit || "N/D"}</td>
                            <td className="p-2 text-center">
                              {user?.role === "Administrador" ? (
                                <div className="flex min-w-28 items-center justify-center gap-1">
                                  <input
                                    value={itemStockDrafts[r.item.id] ?? String(r.item.system_stock || 0)}
                                    onChange={e => setItemStockDrafts(prev => ({ ...prev, [r.item.id]: e.target.value }))}
                                    type="number"
                                    min="0"
                                    step="any"
                                    className="w-20 rounded-lg border px-2 py-1 text-center text-xs font-black outline-none focus:ring-2 focus:ring-amber-200"
                                  />
                                  <button
                                    onClick={() => saveItemStockSnapshot(r.item.id)}
                                    disabled={savingItemStockId === r.item.id}
                                    className="rounded-lg border border-amber-200 px-2 py-1 text-amber-700 disabled:opacity-40"
                                    title="Guardar stock de fotografía"
                                  >
                                    <Save size={13} />
                                  </button>
                                </div>
                              ) : r.item.system_stock}
                            </td>
                            <td className="p-2 text-center font-semibold">{r.total}</td>
                            <td className={`p-2 text-center font-black ${r.diff < 0 ? "text-red-600" : r.diff > 0 ? "text-blue-700" : "text-green-700"}`}>{r.diff > 0 ? "+" : ""}{r.diff}</td>
                            <td className="p-2 text-center text-xs">{money(r.value)}</td>
                            <td className="p-2 text-center text-xs font-black">{r.item.source === "extra" ? "Extra - " : ""}{r.status}</td>
                            <td className="p-2">
                              <textarea
                                value={itemObservationDrafts[r.item.id] ?? ""}
                                onChange={e => setItemObservationDrafts(prev => ({ ...prev, [r.item.id]: e.target.value }))}
                                placeholder="Observación por código"
                                className="min-h-16 w-full min-w-56 rounded-xl border px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-200"
                              />
                            </td>
                            <td className="p-2 text-center">
                              <button
                                onClick={() => saveItemObservation(r.item.id)}
                                disabled={!session || savingItemObservationId === r.item.id}
                                className="rounded-xl bg-green-700 px-3 py-2 text-xs font-black text-white disabled:opacity-40"
                              >
                                <Save className="mr-1 inline" size={14} /> Guardar
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}
      </div>

      {scannerTarget && (<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><div className="w-full max-w-lg rounded-2xl bg-white p-4 shadow-2xl"><div className="mb-3 flex items-center justify-between"><h3 className="font-black">{scannerTarget === "product" ? "Escanear producto" : "Escanear ubicación"}</h3><button onClick={toggleTorch} className={`rounded-lg border px-3 py-2 text-sm font-black ${torchOn ? "bg-yellow-400 text-slate-900" : "bg-slate-900 text-white"}`} title="Prender linterna"><Flashlight className="mr-2 inline" size={18} /> Linterna</button></div><div className="overflow-hidden rounded-xl bg-black"><div id={scannerContainerId} className="min-h-[280px] w-full" /></div></div></div>)}
      {editingCount && (<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"><div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"><h3 className="font-black">Editar registro</h3><input value={editLocation} onChange={e => setEditLocation(e.target.value)} className="mt-4 w-full rounded-xl border px-3 py-3 text-sm" placeholder="Ubicación" /><input value={editQty} onChange={e => setEditQty(e.target.value)} className="mt-2 w-full rounded-xl border px-3 py-3 text-sm" type="number" placeholder="Cantidad" /><div className="mt-4 flex gap-2"><button onClick={saveEdit} className="flex-1 rounded-xl bg-green-700 px-4 py-3 text-sm font-bold text-white"><Save className="mr-2 inline" size={16} />Guardar</button><button onClick={() => setEditingCount(null)} className="rounded-xl border px-4 py-3 text-sm font-bold">Cancelar</button></div></div></div>)}
      {showEmailModal && (<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"><div className="flex max-h-[86vh] w-full max-w-5xl flex-col rounded-2xl bg-white shadow-2xl"><div className="flex items-center justify-between border-b px-4 py-3"><h3 className="font-black">Informe de auditoría</h3><button onClick={() => setShowEmailModal(false)} className="rounded-lg border p-2"><XCircle size={18} /></button></div><div className="grid min-h-0 flex-1 gap-0 md:grid-cols-[320px_1fr]"><div className="space-y-2 border-b p-4 md:border-b-0 md:border-r"><button onClick={downloadAuditReport} className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white"><Download className="mr-2 inline" size={16} /> Descargar HTML</button><button onClick={openEmailDraft} className="w-full rounded-xl border px-4 py-3 text-sm font-black text-slate-700"><Mail className="mr-2 inline" size={16} /> Abrir correo</button><p className="text-xs text-slate-500">El informe usa tablas e imagen SVG embebida para que gráficos y dashboard sean compatibles al enviarlo.</p></div><iframe title="Informe auditoría" srcDoc={emailHTML} className="h-[60vh] w-full bg-slate-50 md:h-[72vh]" /></div></div></div>)}
    </main>
  );
}
