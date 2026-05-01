"use client";

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ClipboardList, Download, FileLock2, FolderOpen, LogOut, PackageSearch, Plus, RefreshCw, Save, Search, ShieldCheck, Trash2 } from "lucide-react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase/client";

type Role = "Operario" | "Validador" | "Administrador";
type SessionStatus = "planned" | "open" | "frozen" | "finished" | "cancelled";
type ValidatorTab = "preparacion" | "registros" | "resumen";

type CyclicUser = {
  id: string;
  full_name: string;
  role: Role;
  store_id: string | null;
  can_access_all_stores: boolean;
  is_active: boolean;
};

type Store = {
  id: string;
  name: string;
  erp_sede?: string | null;
  is_active: boolean;
};

type InventorySession = {
  id: string;
  store_id: string;
  name: string;
  status: SessionStatus;
  scheduled_date: string | null;
  stock_frozen_at: string | null;
  frozen_total_value: number;
  notes?: string | null;
  store_name?: string;
};

type InventoryOperator = {
  id: string;
  full_name: string;
  phone: string;
};

type InventoryLocation = {
  id: string;
  session_id: string;
  location_code: string;
  ticket?: string | null;
  zone?: string | null;
  zone_ref?: string | null;
  lineal?: string | null;
  reference?: string | null;
  full_location?: string | null;
  description?: string | null;
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
};

type CountRow = {
  id: string;
  session_id: string;
  operator_id: string;
  location_id: string;
  location_code: string;
  product_id: string;
  sku: string;
  description: string;
  unit: string;
  quantity: number;
  cost_snapshot: number;
  counted_at: string;
};

type SummaryRow = {
  product_id: string;
  sku: string;
  description: string;
  unit: string;
  system_stock: number;
  counted: number;
  diff: number;
  cost: number;
  valueDiff: number;
  observation?: string | null;
};

const OPERATOR_KEY = "general_inventory_operator";
const SESSION_KEY = "general_inventory_session_id";

function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}

function normalizeCode(value: string | number | null | undefined) {
  return String(value ?? "").trim().replace(/\.0+$/, "");
}

function money(value: number) {
  return `S/ ${Number(value || 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function statusLabel(status: SessionStatus) {
  if (status === "planned") return "Planificado";
  if (status === "open") return "Abierto";
  if (status === "frozen") return "Stock congelado";
  if (status === "finished") return "Finalizado";
  return "Cancelado";
}

function canOperatorEnter(status: SessionStatus) {
  return status === "open" || status === "frozen";
}

async function readWorkbookRows(file: File): Promise<Record<string, string>[]> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: "", raw: false });
}

function pickColumn(row: Record<string, string>, names: string[]) {
  const entries = Object.entries(row);
  for (const name of names) {
    const normalized = name.trim().toLowerCase();
    const found = entries.find(([key]) => key.trim().toLowerCase() === normalized);
    if (found) return String(found[1] ?? "").trim();
  }
  return "";
}

function firstColumnValue(row: Record<string, string>) {
  const first = Object.values(row)[0];
  return String(first ?? "").trim();
}

export default function InventariosPage() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [sessions, setSessions] = useState<InventorySession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [operator, setOperator] = useState<InventoryOperator | null>(null);
  const [operatorName, setOperatorName] = useState("");
  const [operatorPhone, setOperatorPhone] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const [newStoreId, setNewStoreId] = useState("");
  const [newName, setNewName] = useState("");
  const [newDate, setNewDate] = useState(new Date().toISOString().slice(0, 10));
  const [locationsFile, setLocationsFile] = useState<File | null>(null);
  const [nonInventoryFile, setNonInventoryFile] = useState<File | null>(null);
  const locationsFileRef = useRef<HTMLInputElement | null>(null);
  const nonInventoryFileRef = useRef<HTMLInputElement | null>(null);

  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [counts, setCounts] = useState<CountRow[]>([]);
  const [recordsQuery, setRecordsQuery] = useState("");
  const [locationCode, setLocationCode] = useState("");
  const [productCode, setProductCode] = useState("");
  const [quantity, setQuantity] = useState("");
  const [editingCountId, setEditingCountId] = useState<string | null>(null);

  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [summaryQuery, setSummaryQuery] = useState("");
  const [observationDrafts, setObservationDrafts] = useState<Record<string, string>>({});
  const [validatorTab, setValidatorTab] = useState<ValidatorTab>("preparacion");

  const isValidator = user?.role === "Administrador" || user?.role === "Validador";
  const selectedSession = useMemo(
    () => sessions.find(session => session.id === selectedSessionId) || null,
    [sessions, selectedSessionId]
  );

  const activeSessions = useMemo(
    () => sessions.filter(session => canOperatorEnter(session.status)),
    [sessions]
  );

  const filteredCounts = useMemo(() => {
    const q = recordsQuery.trim().toLowerCase();
    const rows = [...counts].sort((a, b) => new Date(b.counted_at).getTime() - new Date(a.counted_at).getTime());
    if (!q) return rows;
    return rows.filter(row =>
      row.sku.toLowerCase().includes(q) ||
      row.description.toLowerCase().includes(q) ||
      row.location_code.toLowerCase().includes(q)
    );
  }, [counts, recordsQuery]);

  const filteredSummary = useMemo(() => {
    const q = summaryQuery.trim().toLowerCase();
    if (!q) return summary;
    return summary.filter(row =>
      row.sku.toLowerCase().includes(q) ||
      row.description.toLowerCase().includes(q) ||
      String(row.observation || "").toLowerCase().includes(q)
    );
  }, [summary, summaryQuery]);

  const pendingLocations = useMemo(() => {
    const counted = new Set(counts.map(row => row.location_code));
    return locations.filter(location => !counted.has(location.location_code));
  }, [locations, counts]);

  const kpis = useMemo(() => {
    const rows = summary;
    const totalCodes = rows.length;
    const countedCodes = rows.filter(row => row.counted > 0).length;
    const notCountedCodes = rows.filter(row => row.counted <= 0).length;
    const okCodes = rows.filter(row => row.counted > 0 && row.diff === 0).length;
    const surplusCodes = rows.filter(row => row.diff > 0).length;
    const missingCodes = rows.filter(row => row.diff < 0).length;
    const surplusValue = rows.filter(row => row.diff > 0).reduce((sum, row) => sum + row.valueDiff, 0);
    const missingValue = rows.filter(row => row.diff < 0).reduce((sum, row) => sum + row.valueDiff, 0);
    const systemValue = rows.reduce((sum, row) => sum + row.system_stock * row.cost, 0);
    const countedValue = rows.filter(row => row.counted > 0).reduce((sum, row) => sum + row.system_stock * row.cost, 0);
    return {
      eri: totalCodes > 0 ? Math.round((okCodes / totalCodes) * 100) : 0,
      surplusValue,
      missingValue,
      diffValue: surplusValue + missingValue,
      surplusCodes,
      missingCodes,
      notCountedCodes,
      countedCodes,
      totalCodes,
      skuProgress: totalCodes > 0 ? Math.round((countedCodes / totalCodes) * 100) : 0,
      valueProgress: systemValue > 0 ? Math.round((countedValue / systemValue) * 100) : 0,
    };
  }, [summary]);

  useEffect(() => {
    const rawUser = localStorage.getItem("cyclic_user");
    if (rawUser) {
      try {
        setUser(JSON.parse(rawUser) as CyclicUser);
      } catch {
        setUser(null);
      }
    }

    const rawOperator = localStorage.getItem(OPERATOR_KEY);
    if (rawOperator) {
      try {
        setOperator(JSON.parse(rawOperator) as InventoryOperator);
      } catch {
        localStorage.removeItem(OPERATOR_KEY);
      }
    }

    const savedSessionId = localStorage.getItem(SESSION_KEY) || "";
    if (savedSessionId) setSelectedSessionId(savedSessionId);

    void loadInitial(savedSessionId);
  }, []);

  useEffect(() => {
    if (!selectedSessionId) return;
    localStorage.setItem(SESSION_KEY, selectedSessionId);
    void loadSessionData(selectedSessionId);
  }, [selectedSessionId]);

  async function loadInitial(preferredSessionId = "") {
    setLoading(true);
    const [storesRes, sessionsRes] = await Promise.all([
      supabase.from("stores").select("*").eq("is_active", true).order("name"),
      supabase
        .from("general_inventory_sessions")
        .select("*, stores(name)")
        .in("status", ["planned", "open", "frozen", "finished"])
        .order("created_at", { ascending: false })
        .limit(80),
    ]);

    const storeRows = (storesRes.data || []) as Store[];
    const sessionRows = (sessionsRes.data || []).map((row: any) => ({
      ...row,
      store_name: row.stores?.name,
    })) as InventorySession[];

    setStores(storeRows);
    setSessions(sessionRows);
    setNewStoreId(storeRows[0]?.id || "");

    const nextSessionId = preferredSessionId || sessionRows.find(session => canOperatorEnter(session.status))?.id || "";
    if (nextSessionId) setSelectedSessionId(nextSessionId);
    setLoading(false);
  }

  async function loadSessionData(sessionId: string) {
    const [locRes, countRows] = await Promise.all([
      supabase.from("general_inventory_locations").select("*").eq("session_id", sessionId).eq("is_active", true).order("location_code"),
      loadAllCounts(sessionId),
    ]);

    setLocations((locRes.data || []) as InventoryLocation[]);
    setCounts(countRows);
    await loadSummary(sessionId);
  }

  async function loadAllCounts(sessionId: string): Promise<CountRow[]> {
    const rows: CountRow[] = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("general_inventory_counts")
        .select("*")
        .eq("session_id", sessionId)
        .order("counted_at", { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) {
        setMessage("Error leyendo registros: " + error.message);
        break;
      }
      rows.push(...((data || []) as CountRow[]));
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
    return rows;
  }

  async function loadPagedSessionRows(table: string, select: string, sessionId: string, orderColumn = "id"): Promise<any[]> {
    const rows: any[] = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from(table)
        .select(select)
        .eq("session_id", sessionId)
        .order(orderColumn, { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) {
        setMessage(`Error leyendo ${table}: ${error.message}`);
        break;
      }
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
    return rows;
  }

  async function loadSummary(sessionId: string) {
    const [snapshotRows, countRows, observationRows, nonInventoryRows] = await Promise.all([
      loadPagedSessionRows("general_inventory_stock_snapshot", "*", sessionId, "sku"),
      loadPagedSessionRows("general_inventory_counts", "product_id,sku,description,unit,quantity,cost_snapshot", sessionId, "sku"),
      loadPagedSessionRows("general_inventory_item_observations", "*", sessionId, "product_id"),
      loadPagedSessionRows("general_inventory_non_inventory_products", "sku", sessionId, "sku"),
    ]);

    const nonInventorySkus = new Set(nonInventoryRows.map(row => row.sku));
    const countedByProduct = new Map<string, number>();
    for (const row of countRows) {
      if (nonInventorySkus.has(row.sku)) continue;
      countedByProduct.set(row.product_id, (countedByProduct.get(row.product_id) || 0) + Number(row.quantity || 0));
    }

    const observations = new Map<string, string>();
    for (const row of observationRows) observations.set(row.product_id, row.observation || "");

    const productIdsInSnapshot = new Set<string>();
    const rows: SummaryRow[] = [];
    for (const snap of snapshotRows) {
      if (nonInventorySkus.has(snap.sku)) continue;
      productIdsInSnapshot.add(snap.product_id);
      const counted = countedByProduct.get(snap.product_id) || 0;
      const systemStock = Number(snap.system_stock || 0);
      const cost = Number(snap.cost || 0);
      const diff = counted - systemStock;
      rows.push({
        product_id: snap.product_id,
        sku: snap.sku,
        description: snap.description || "",
        unit: snap.unit || "",
        system_stock: systemStock,
        counted,
        diff,
        cost,
        valueDiff: diff * cost,
        observation: observations.get(snap.product_id) || "",
      });
    }

    for (const row of countRows) {
      if (nonInventorySkus.has(row.sku)) continue;
      if (productIdsInSnapshot.has(row.product_id)) continue;
      const counted = countedByProduct.get(row.product_id) || 0;
      const cost = Number(row.cost_snapshot || 0);
      rows.push({
        product_id: row.product_id,
        sku: row.sku,
        description: row.description || "",
        unit: row.unit || "",
        system_stock: 0,
        counted,
        diff: counted,
        cost,
        valueDiff: counted * cost,
        observation: observations.get(row.product_id) || "",
      });
      productIdsInSnapshot.add(row.product_id);
    }

    rows.sort((a, b) => Math.abs(b.valueDiff) - Math.abs(a.valueDiff));
    setSummary(rows);
    setObservationDrafts(Object.fromEntries(rows.map(row => [row.product_id, row.observation || ""])));
  }

  async function createSession() {
    if (!user || !newStoreId || !newName.trim()) {
      setMessage("Completa tienda y nombre de inventario.");
      return;
    }

    const { data, error } = await supabase
      .from("general_inventory_sessions")
      .insert({
        store_id: newStoreId,
        name: newName.trim(),
        scheduled_date: newDate || null,
        status: "open",
        created_by: user.id,
      })
      .select("*, stores(name)")
      .single();

    if (error) {
      setMessage("No se pudo crear la sesion: " + error.message);
      return;
    }

    const row = { ...data, store_name: data.stores?.name } as InventorySession;
    setSessions(prev => [row, ...prev]);
    setSelectedSessionId(row.id);
    setNewName("");
    setMessage("Inventario general creado y abierto.");
  }

  async function importLocations() {
    if (!selectedSessionId || !locationsFile) {
      setMessage("Selecciona el Excel de ubicaciones.");
      return;
    }
    const excelRows = await readWorkbookRows(locationsFile);
    const uniqueRows = new Map<string, {
      session_id: string;
      location_code: string;
      ticket: string;
      zone: string | null;
      zone_ref: string | null;
      lineal: string | null;
      reference: string | null;
      full_location: string | null;
      description: string | null;
    }>();
    for (const row of excelRows) {
      const ticket = firstColumnValue(row);
      const locationCode = normalizeCode(ticket).toUpperCase();
      if (!locationCode) continue;
      const zona = pickColumn(row, ["ZONA"]);
      const zonaRef = pickColumn(row, ["ZONA REF"]);
      const lineal = pickColumn(row, ["LINEAL"]);
      const referencia = pickColumn(row, ["REFERENCIA"]);
      const fullLocation = pickColumn(row, ["UBICACIÓN CONCATENADA", "UBICACION CONCATENADA"]);
      uniqueRows.set(locationCode, {
        session_id: selectedSessionId,
        location_code: locationCode,
        ticket: locationCode,
        zone: zona || null,
        zone_ref: zonaRef || null,
        lineal: lineal || null,
        reference: referencia || null,
        full_location: fullLocation || null,
        description: fullLocation || [zona, zonaRef, lineal, referencia].filter(Boolean).join(" - ") || null,
      });
    }
    const rows = [...uniqueRows.values()];
    if (rows.length === 0) {
      setMessage("No encontre ubicaciones en el Excel.");
      return;
    }
    const { error } = await supabase.from("general_inventory_locations").upsert(rows, { onConflict: "session_id,location_code" });
    if (error) {
      setMessage("Error cargando ubicaciones: " + error.message);
      return;
    }
    setLocationsFile(null);
    if (locationsFileRef.current) locationsFileRef.current.value = "";
    setMessage(`${rows.length} ubicaciones cargadas desde Excel.`);
    await loadSessionData(selectedSessionId);
  }

  async function importNonInventory() {
    if (!selectedSessionId || !nonInventoryFile) {
      setMessage("Selecciona el Excel de no inventariables.");
      return;
    }
    const excelRows = await readWorkbookRows(nonInventoryFile);
    const skus = [...new Set(excelRows
      .map(row => normalizeCode(pickColumn(row, ["ID", "CODSAP", "CODIGO", "CÓDIGO", "SKU"])).toUpperCase())
      .filter(Boolean))];
    if (skus.length === 0) {
      setMessage("No encontre codigos en el Excel.");
      return;
    }
    const productRows: any[] = [];
    for (let i = 0; i < skus.length; i += 500) {
      const chunk = skus.slice(i, i + 500);
      const { data } = await supabase.from("cyclic_products").select("id,sku,description").in("sku", chunk);
      productRows.push(...(data || []));
    }
    const productBySku = new Map(productRows.map(row => [row.sku, row]));
    const rows = skus.filter(sku => productBySku.has(sku)).map(sku => {
      const product = productBySku.get(sku);
      return {
        session_id: selectedSessionId,
        product_id: product.id,
        sku,
        description: product.description || null,
        reason: "No inventariable",
      };
    });
    if (rows.length === 0) {
      setMessage("Ningun codigo del Excel coincide exactamente con el maestro.");
      return;
    }
    const { error } = await supabase.from("general_inventory_non_inventory_products").upsert(rows, { onConflict: "session_id,sku" });
    if (error) {
      setMessage("Error cargando no inventariables: " + error.message);
      return;
    }
    setNonInventoryFile(null);
    if (nonInventoryFileRef.current) nonInventoryFileRef.current.value = "";
    setMessage(`${rows.length} codigos no inventariables cargados. Omitidos por no coincidir: ${skus.length - rows.length}.`);
    await loadSummary(selectedSessionId);
  }

  async function freezeStock() {
    if (!user || !selectedSessionId) return;
    setLoading(true);
    const { data, error } = await supabase.rpc("freeze_general_inventory_stock", {
      p_session_id: selectedSessionId,
      p_user_id: user.id,
    });
    setLoading(false);
    if (error) {
      setMessage("No se pudo congelar stock: " + error.message);
      return;
    }
    setMessage(`Stock congelado. Productos en foto: ${data || 0}.`);
    await loadInitial(selectedSessionId);
  }

  async function finishSession() {
    if (!selectedSessionId) return;
    const { error } = await supabase
      .from("general_inventory_sessions")
      .update({ status: "finished", finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", selectedSessionId);
    if (error) {
      setMessage("No se pudo finalizar: " + error.message);
      return;
    }
    setMessage("Inventario finalizado. Los operadores ya no podran entrar.");
    await loadInitial(selectedSessionId);
  }

  async function deleteSession() {
    if (!selectedSessionId || user?.role !== "Administrador") return;
    const { error } = await supabase
      .from("general_inventory_sessions")
      .delete()
      .eq("id", selectedSessionId);
    if (error) {
      setMessage("No se pudo eliminar la sesion: " + error.message);
      return;
    }
    setSelectedSessionId("");
    localStorage.removeItem(SESSION_KEY);
    setLocations([]);
    setCounts([]);
    setSummary([]);
    setMessage("Sesion eliminada.");
    await loadInitial("");
  }

  async function registerOperator() {
    const phone = normalizePhone(operatorPhone);
    if (!operatorName.trim() || phone.length < 8 || !selectedSession) {
      setMessage("Completa nombre, celular y selecciona un inventario activo.");
      return;
    }
    if (!canOperatorEnter(selectedSession.status)) {
      setMessage("Este inventario ya no acepta registros.");
      return;
    }

    let operatorRow: InventoryOperator | null = null;
    const existing = await supabase.from("general_inventory_operators").select("*").eq("phone", phone).maybeSingle();
    if (existing.data) {
      operatorRow = existing.data as InventoryOperator;
      if (operatorRow.full_name !== operatorName.trim()) {
        await supabase.from("general_inventory_operators").update({ full_name: operatorName.trim() }).eq("id", operatorRow.id);
        operatorRow = { ...operatorRow, full_name: operatorName.trim() };
      }
    } else {
      const created = await supabase
        .from("general_inventory_operators")
        .insert({ full_name: operatorName.trim(), phone })
        .select("*")
        .single();
      if (created.error) {
        setMessage("No se pudo registrar operador: " + created.error.message);
        return;
      }
      operatorRow = created.data as InventoryOperator;
    }

    const { error: joinError } = await supabase
      .from("general_inventory_session_operators")
      .upsert({ session_id: selectedSession.id, operator_id: operatorRow.id, status: "active" }, { onConflict: "session_id,operator_id" });
    if (joinError) {
      setMessage("No se pudo asociar a la sesion: " + joinError.message);
      return;
    }

    setOperator(operatorRow);
    localStorage.setItem(OPERATOR_KEY, JSON.stringify(operatorRow));
    localStorage.setItem(SESSION_KEY, selectedSession.id);
    setMessage(`Bienvenido, ${operatorRow.full_name}.`);
  }

  async function resolveProduct(code: string): Promise<Product | null | "NON_INVENTORY"> {
    const raw = normalizeCode(code).toUpperCase();
    if (!raw || !selectedSessionId) return null;

    const [byUpc, byAlu] = await Promise.all([
      supabase.from("codigos_barra").select("codsap,upc,alu").eq("upc", raw).not("codsap", "is", null).limit(20),
      supabase.from("codigos_barra").select("codsap,upc,alu").eq("alu", raw).not("codsap", "is", null).limit(20),
    ]);
    const mapped = [...(byUpc.data || []), ...(byAlu.data || [])].map(row => row.codsap).filter(Boolean);
    const candidates = [...new Set([raw, ...mapped])];

    for (const sku of candidates) {
      const nonInv = await supabase
        .from("general_inventory_non_inventory_products")
        .select("id")
        .eq("session_id", selectedSessionId)
        .eq("sku", sku)
        .maybeSingle();
      if (nonInv.data) return "NON_INVENTORY";

      const { data } = await supabase
        .from("cyclic_products")
        .select("*")
        .eq("sku", sku)
        .eq("is_active", true)
        .maybeSingle();
      if (data) return data as Product;
    }

    return null;
  }

  async function saveCount() {
    if (!operator || !selectedSession || !canOperatorEnter(selectedSession.status)) {
      setMessage("No hay inventario activo para registrar.");
      return;
    }

    const locCode = locationCode.trim().toUpperCase();
    const loc = locations.find(row => row.location_code === locCode);
    if (!loc) {
      setMessage("Ubicacion no autorizada para esta sesion.");
      return;
    }

    const qty = Number(quantity);
    if (!productCode.trim() || !Number.isFinite(qty) || qty <= 0) {
      setMessage("Ingresa codigo y cantidad mayor a cero.");
      return;
    }

    const product = await resolveProduct(productCode);
    if (product === "NON_INVENTORY") {
      setMessage("Este codigo esta en la lista de no inventariables y no puede registrarse.");
      return;
    }
    if (!product) {
      setMessage("Codigo no existe en el maestro ni en codigos de barra.");
      return;
    }

    const snapshot = await supabase
      .from("general_inventory_stock_snapshot")
      .select("cost")
      .eq("session_id", selectedSession.id)
      .eq("product_id", product.id)
      .maybeSingle();

    const row = {
      session_id: selectedSession.id,
      operator_id: operator.id,
      location_id: loc.id,
      location_code: loc.location_code,
      product_id: product.id,
      sku: product.sku,
      description: product.description,
      unit: product.unit,
      quantity: qty,
      cost_snapshot: Number(snapshot.data?.cost ?? product.cost ?? 0),
      updated_at: new Date().toISOString(),
    };

    const request = editingCountId
      ? supabase.from("general_inventory_counts").update(row).eq("id", editingCountId)
      : supabase.from("general_inventory_counts").insert(row);
    const { error } = await request;

    if (error) {
      setMessage("No se pudo guardar conteo: " + error.message);
      return;
    }

    setProductCode("");
    setQuantity("");
    setEditingCountId(null);
    setMessage("Conteo guardado.");
    await loadSessionData(selectedSession.id);
  }

  async function editCount(row: CountRow) {
    setEditingCountId(row.id);
    setLocationCode(row.location_code);
    setProductCode(row.sku);
    setQuantity(String(row.quantity));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function deleteCount(row: CountRow) {
    const { error } = await supabase.from("general_inventory_counts").delete().eq("id", row.id);
    if (error) {
      setMessage("No se pudo eliminar: " + error.message);
      return;
    }
    await loadSessionData(row.session_id);
  }

  async function saveObservation(row: SummaryRow) {
    if (!user || !selectedSessionId) return;
    const { error } = await supabase
      .from("general_inventory_item_observations")
      .upsert({
        session_id: selectedSessionId,
        product_id: row.product_id,
        observation: observationDrafts[row.product_id] || null,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: "session_id,product_id" });
    if (error) {
      setMessage("No se pudo guardar observacion: " + error.message);
      return;
    }
    setMessage("Observacion guardada.");
    await loadSummary(selectedSessionId);
  }

  async function markSummaryAsNonInventory(row: SummaryRow) {
    if (!selectedSessionId) return;
    const { error } = await supabase
      .from("general_inventory_non_inventory_products")
      .upsert({
        session_id: selectedSessionId,
        product_id: row.product_id,
        sku: row.sku,
        description: row.description,
        reason: observationDrafts[row.product_id] || "Marcado desde resumen por codigo",
      }, { onConflict: "session_id,sku" });
    if (error) {
      setMessage("No se pudo marcar como no inventariable: " + error.message);
      return;
    }
    setMessage(`${row.sku} marcado como no inventariable. Ya no se considerara en KPIs ni resumen.`);
    await loadSummary(selectedSessionId);
  }

  function exportRecords() {
    const rows = counts.map(row => ({
      FECHA: new Date(row.counted_at).toLocaleString("es-PE"),
      UBICACION: row.location_code,
      CODIGO: row.sku,
      DESCRIPCION: row.description,
      UM: row.unit,
      CANTIDAD: row.quantity,
      VALOR: row.quantity * row.cost_snapshot,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Registros");
    XLSX.writeFile(wb, `inventario_registros_${selectedSession?.name || "sesion"}.xlsx`);
  }

  function exportSummary() {
    const rows = summary.map(row => ({
      CODIGO: row.sku,
      DESCRIPCION: row.description,
      UM: row.unit,
      STOCK_SISTEMA: row.system_stock,
      CONTADO: row.counted,
      DIFERENCIA: row.diff,
      COSTO: row.cost,
      DIF_VALORIZADA: row.valueDiff,
      OBSERVACION: row.observation || "",
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Resumen");
    XLSX.writeFile(wb, `inventario_resumen_${selectedSession?.name || "sesion"}.xlsx`);
  }

  function logoutOperator() {
    setOperator(null);
    localStorage.removeItem(OPERATOR_KEY);
  }

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-3 py-3">
          <button onClick={() => window.location.href = "/"} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Volver">
            <ArrowLeft size={18} />
          </button>
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-600 font-black text-white">R</div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-black leading-tight">Inventarios generales</h1>
            <p className="truncate text-xs text-slate-500">RASECORP - conteo por ubicaciones</p>
          </div>
          <button onClick={() => loadInitial(selectedSessionId)} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Actualizar">
            <RefreshCw size={18} />
          </button>
          {operator && (
            <button onClick={logoutOperator} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Salir operador">
              <LogOut size={18} />
            </button>
          )}
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-4 px-3 py-4 lg:grid-cols-[360px_1fr]">
        <aside className="space-y-4">
          {isValidator && (
            <section className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2">
                <ShieldCheck size={18} className="text-orange-600" />
                <h2 className="font-black">Panel validador</h2>
              </div>
              <div className="space-y-2">
                <select value={newStoreId} onChange={event => setNewStoreId(event.target.value)} className="w-full rounded-xl border bg-white px-3 py-3 text-sm">
                  {stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
                </select>
                <input value={newName} onChange={event => setNewName(event.target.value)} placeholder="Nombre de inventario" className="w-full rounded-xl border px-3 py-3 text-sm" />
                <input type="date" value={newDate} onChange={event => setNewDate(event.target.value)} className="w-full rounded-xl border px-3 py-3 text-sm" />
                <button onClick={createSession} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white">
                  <Plus size={16} /> Crear inventario
                </button>
              </div>
            </section>
          )}

          <section className="rounded-2xl border bg-white p-4 shadow-sm">
            <h2 className="mb-3 font-black">Inventario activo</h2>
            <select value={selectedSessionId} onChange={event => setSelectedSessionId(event.target.value)} className="w-full rounded-xl border bg-white px-3 py-3 text-sm">
              <option value="">Selecciona inventario</option>
              {(isValidator ? sessions : activeSessions).map(session => (
                <option key={session.id} value={session.id}>
                  {session.name} - {session.store_name || session.store_id} - {statusLabel(session.status)}
                </option>
              ))}
            </select>
            {selectedSession && (
              <div className="mt-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
                <div className="font-black text-slate-900">{selectedSession.name}</div>
                <div>{selectedSession.store_name}</div>
                <div>Estado: {statusLabel(selectedSession.status)}</div>
                {selectedSession.stock_frozen_at && <div>Stock congelado: {new Date(selectedSession.stock_frozen_at).toLocaleString("es-PE")}</div>}
              </div>
            )}
          </section>

          {!operator && !isValidator && (
            <section className="rounded-2xl border bg-white p-4 shadow-sm">
              <h2 className="font-black">Registro operador</h2>
              <p className="mt-1 text-xs text-slate-500">Un celular solo puede tener un registro en inventario general.</p>
              <div className="mt-3 space-y-2">
                <input value={operatorName} onChange={event => setOperatorName(event.target.value)} placeholder="Nombres completos" className="w-full rounded-xl border px-3 py-3 text-sm" />
                <input value={operatorPhone} onChange={event => setOperatorPhone(event.target.value)} placeholder="Celular" inputMode="numeric" className="w-full rounded-xl border px-3 py-3 text-sm" />
                <button onClick={registerOperator} disabled={!selectedSessionId} className="w-full rounded-xl bg-orange-600 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                  Entrar al inventario
                </button>
              </div>
            </section>
          )}

          {isValidator && selectedSessionId && (
            <section className="space-y-3 rounded-2xl border bg-white p-4 shadow-sm">
              <h2 className="font-black">Preparación</h2>
              <div>
                <label className="text-xs font-bold text-slate-500">Control de tickets / ubicaciones</label>
                <input
                  ref={locationsFileRef}
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={event => setLocationsFile(event.target.files?.[0] || null)}
                />
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <button onClick={() => locationsFileRef.current?.click()} className="inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-black">
                    <FolderOpen size={16} /> {locationsFile ? locationsFile.name : "Seleccionar Excel"}
                  </button>
                  <button onClick={importLocations} disabled={!locationsFile} className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                    Subir ubicaciones
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs font-bold text-slate-500">No inventariables / no considerar</label>
                <input
                  ref={nonInventoryFileRef}
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={event => setNonInventoryFile(event.target.files?.[0] || null)}
                />
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <button onClick={() => nonInventoryFileRef.current?.click()} className="inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-black">
                    <FolderOpen size={16} /> {nonInventoryFile ? nonInventoryFile.name : "Seleccionar Excel"}
                  </button>
                  <button onClick={importNonInventory} disabled={!nonInventoryFile} className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                    Subir no inventariables
                  </button>
                </div>
              </div>
              <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
                <div className="font-black text-slate-900">Ubicaciones</div>
                <div>Total: {locations.length} | Pendientes: {pendingLocations.length}</div>
                {pendingLocations.length > 0 && (
                  <div className="mt-2 max-h-32 overflow-auto rounded-lg border bg-white p-2">
                    {pendingLocations.slice(0, 80).map(location => (
                      <div key={location.id} className="border-b py-1 last:border-b-0">
                        <span className="font-black">{location.location_code}</span>
                        {location.full_location || location.description ? <span className="text-slate-500"> - {location.full_location || location.description}</span> : null}
                      </div>
                    ))}
                    {pendingLocations.length > 80 && <div className="py-1 text-slate-400">+{pendingLocations.length - 80} pendientes mas</div>}
                  </div>
                )}
              </div>
              <button onClick={freezeStock} disabled={loading} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-700 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                <FileLock2 size={16} /> Congelar stock
              </button>
              <button onClick={finishSession} className="w-full rounded-xl bg-green-700 px-4 py-3 text-sm font-black text-white">
                Finalizar inventario
              </button>
              {user?.role === "Administrador" && (
                <button onClick={deleteSession} className="w-full rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm font-black text-red-700">
                  Eliminar sesion
                </button>
              )}
            </section>
          )}
        </aside>

        <section className="space-y-4">
          {message && <div className="rounded-2xl border bg-white px-4 py-3 text-sm font-bold text-slate-700 shadow-sm">{message}</div>}

          {isValidator && selectedSessionId && (
            <section className="rounded-2xl border bg-white p-2 shadow-sm">
              <div className="grid grid-cols-3 gap-2">
                <button onClick={() => setValidatorTab("preparacion")} className={`rounded-xl px-3 py-2 text-xs font-black ${validatorTab === "preparacion" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                  Preparacion
                </button>
                <button onClick={() => setValidatorTab("registros")} className={`rounded-xl px-3 py-2 text-xs font-black ${validatorTab === "registros" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                  Registros
                </button>
                <button onClick={() => setValidatorTab("resumen")} className={`rounded-xl px-3 py-2 text-xs font-black ${validatorTab === "resumen" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                  Resumen
                </button>
              </div>
            </section>
          )}

          {operator && selectedSession && canOperatorEnter(selectedSession.status) && !isValidator && (
            <section className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <h2 className="font-black">Conteo por ubicación</h2>
                  <p className="text-xs text-slate-500">{operator.full_name}</p>
                </div>
                {editingCountId && <button onClick={() => { setEditingCountId(null); setProductCode(""); setQuantity(""); }} className="rounded-xl border px-3 py-2 text-xs font-black">Cancelar edición</button>}
              </div>
              <div className="grid gap-2 md:grid-cols-[1fr_1fr_120px_auto]">
                <input value={locationCode} onChange={event => setLocationCode(event.target.value.toUpperCase())} placeholder="Ubicación" className="min-w-0 rounded-xl border px-3 py-3 text-sm font-bold" />
                <input value={productCode} onChange={event => setProductCode(event.target.value)} placeholder="Código o barra" className="min-w-0 rounded-xl border px-3 py-3 text-sm" />
                <input value={quantity} onChange={event => setQuantity(event.target.value)} placeholder="Cantidad" inputMode="decimal" className="min-w-0 rounded-xl border px-3 py-3 text-sm" />
                <button onClick={saveCount} className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white">
                  <Save size={16} /> Guardar
                </button>
              </div>
            </section>
          )}

          {isValidator && selectedSessionId && validatorTab === "resumen" && (
            <section className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-black">Dashboard de inventario</h2>
                <div className="flex gap-2">
                  <button onClick={exportRecords} className="inline-flex items-center gap-1 rounded-xl border px-3 py-2 text-xs font-black"><Download size={15} /> Registros</button>
                  <button onClick={exportSummary} className="inline-flex items-center gap-1 rounded-xl bg-green-700 px-3 py-2 text-xs font-black text-white"><Download size={15} /> Resumen</button>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <Kpi label="ERI" value={`${kpis.eri}%`} />
                <Kpi label="Sobrantes valorizados" value={money(kpis.surplusValue)} tone="blue" />
                <Kpi label="Faltantes valorizados" value={money(kpis.missingValue)} tone="red" />
                <Kpi label="Dif. valorizada" value={money(kpis.diffValue)} tone={kpis.diffValue < 0 ? "red" : "blue"} />
                <Kpi label="Avance SKU" value={`${kpis.skuProgress}%`} />
                <Kpi label="Códigos sobrantes" value={kpis.surplusCodes} tone="blue" />
                <Kpi label="Códigos faltantes" value={kpis.missingCodes} tone="red" />
                <Kpi label="No contados" value={kpis.notCountedCodes} tone="amber" />
                <Kpi label="Contados / total" value={`${kpis.countedCodes} / ${kpis.totalCodes}`} />
                <Kpi label="Avance valorizado" value={`${kpis.valueProgress}%`} />
              </div>
            </section>
          )}

          {(!isValidator || !selectedSessionId || validatorTab === "registros") && (
          <section className="rounded-2xl border bg-white shadow-sm">
            <div className="border-b p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="inline-flex items-center gap-2 font-black"><ClipboardList size={18} /> Registros</h2>
                <div className="flex min-w-[220px] flex-1 items-center rounded-xl border px-3 py-2 md:max-w-md">
                  <Search size={16} className="text-slate-400" />
                  <input value={recordsQuery} onChange={event => setRecordsQuery(event.target.value)} placeholder="Buscar código, descripción o ubicación" className="min-w-0 flex-1 px-2 text-sm outline-none" />
                </div>
              </div>
            </div>
            <div className="divide-y">
              {filteredCounts.map(row => (
                <div key={row.id} className="grid gap-2 p-3 text-sm md:grid-cols-[120px_130px_1fr_90px_90px] md:items-center">
                  <div className="font-black text-slate-800">{row.location_code}</div>
                  <div className="font-black text-blue-700">{row.sku}</div>
                  <div className="min-w-0">
                    <div className="truncate text-slate-700">{row.description}</div>
                    <div className="text-xs text-slate-400">{new Date(row.counted_at).toLocaleString("es-PE")} - {row.unit}</div>
                  </div>
                  <div className="font-black">{row.quantity}</div>
                  {(operator?.id === row.operator_id || isValidator) && (
                    <div className="flex gap-1">
                      {operator?.id === row.operator_id && (
                        <button onClick={() => editCount(row)} className="rounded-lg border px-2 py-1 text-xs font-black">Editar</button>
                      )}
                      {isValidator && (
                        <button onClick={() => deleteCount(row)} className="rounded-lg border px-2 py-1 text-red-600"><Trash2 size={14} /></button>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {filteredCounts.length === 0 && <div className="p-8 text-center text-sm text-slate-400">Sin registros.</div>}
            </div>
          </section>
          )}

          {isValidator && selectedSessionId && validatorTab === "resumen" && (
            <section className="rounded-2xl border bg-white shadow-sm">
              <div className="border-b p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="inline-flex items-center gap-2 font-black"><PackageSearch size={18} /> Resumen por código</h2>
                  <input value={summaryQuery} onChange={event => setSummaryQuery(event.target.value)} placeholder="Buscar código, descripción u observación" className="w-full rounded-xl border px-3 py-2 text-sm md:w-96" />
                </div>
              </div>
              <div className="overflow-auto">
                <table className="w-full min-w-[980px] text-sm">
                  <thead className="bg-slate-100 text-xs text-slate-600">
                    <tr>
                      <th className="p-2 text-left">Código</th>
                      <th className="p-2 text-left">Descripción</th>
                      <th className="p-2">UM</th>
                      <th className="p-2">Sistema</th>
                      <th className="p-2">Contado</th>
                      <th className="p-2">Dif.</th>
                      <th className="p-2">Dif. Val.</th>
                      <th className="p-2 text-left">Observación</th>
                      <th className="p-2">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSummary.map(row => (
                      <tr key={row.product_id} className="border-b">
                        <td className="p-2 font-black">{row.sku}</td>
                        <td className="max-w-sm truncate p-2">{row.description}</td>
                        <td className="p-2 text-center">{row.unit}</td>
                        <td className="p-2 text-center">{row.system_stock}</td>
                        <td className="p-2 text-center font-black">{row.counted}</td>
                        <td className={`p-2 text-center font-black ${row.diff < 0 ? "text-red-600" : row.diff > 0 ? "text-blue-700" : "text-green-700"}`}>{row.diff}</td>
                        <td className={`p-2 text-center font-black ${row.valueDiff < 0 ? "text-red-600" : row.valueDiff > 0 ? "text-blue-700" : "text-green-700"}`}>{money(row.valueDiff)}</td>
                        <td className="p-2">
                          <input value={observationDrafts[row.product_id] || ""} onChange={event => setObservationDrafts(prev => ({ ...prev, [row.product_id]: event.target.value }))} className="w-full rounded-lg border px-2 py-1 text-xs" />
                        </td>
                        <td className="p-2 text-center">
                          <div className="flex justify-center gap-1">
                            <button onClick={() => saveObservation(row)} className="rounded-lg border px-2 py-1 text-xs font-black">Guardar</button>
                            <button onClick={() => markSummaryAsNonInventory(row)} className="rounded-lg border border-amber-300 px-2 py-1 text-xs font-black text-amber-700">No inv.</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </section>
      </div>
    </main>
  );
}

function Kpi({ label, value, tone = "slate" }: { label: string; value: string | number; tone?: "slate" | "blue" | "red" | "amber" }) {
  const color = tone === "blue" ? "text-blue-700" : tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : "text-slate-900";
  return (
    <div className="rounded-xl border bg-slate-50 p-3 text-center">
      <div className={`text-xl font-black ${color}`}>{value}</div>
      <div className="mt-1 text-xs font-bold text-slate-500">{label}</div>
    </div>
  );
}
