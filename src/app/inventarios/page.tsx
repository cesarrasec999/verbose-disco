"use client";

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ClipboardList, Download, FileLock2, Flashlight, FolderOpen, LogIn, LogOut, PackageSearch, Plus, QrCode, RefreshCw, Save, Search, ShieldCheck, Trash2, UserCheck } from "lucide-react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase/client";

type Role = "Operario" | "Validador" | "Administrador";
type SessionStatus = "planned" | "open" | "frozen" | "finished" | "cancelled";
type ValidatorTab = "preparacion" | "registros" | "reconteo" | "resumen" | "usuarios";
type OperatorMode = "conteo" | "reconteo";
type SortDirection = "asc" | "desc";
type RecordsSortKey = "counted_at" | "operator_name" | "location_code" | "sku" | "description" | "unit" | "quantity" | "cost_snapshot" | "value";
type SummarySortKey = "sku" | "description" | "unit" | "system_stock" | "counted" | "diff" | "cost" | "valueDiff" | "observation";
type RecountAssignedSortKey = "status" | "recount_type" | "ticket" | "location_code" | "sku" | "description" | "system_stock" | "counted_qty" | "diff_qty" | "value_diff" | "assigned_operator_name";
type SortState<T extends string> = { key: T; direction: SortDirection };

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
  password?: string;
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
  operator_name?: string | null;
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

type RecountType = "surplus" | "missing";
type RecountColumn = "zone";
type ScannerTarget = "location" | "product" | "recount_location" | "recount_product" | null;

type RecountCandidate = {
  product_id: string;
  sku: string;
  description: string;
  unit: string;
  location_id: string | null;
  location_code: string | null;
  full_location: string | null;
  zone: string | null;
  zone_ref: string | null;
  lineal: string | null;
  ticket: string | null;
  recount_type: RecountType;
  system_stock: number;
  counted_qty: number;
  diff_qty: number;
  cost_snapshot: number;
  value_diff: number;
};

type RecountItem = RecountCandidate & {
  id: string;
  status: string;
  assigned_operator_id: string | null;
  assigned_operator_name?: string | null;
};

type RecountDraft = {
  locationCode: string;
  productCode: string;
  quantity: string;
};

type InventoryOperatorDraft = {
  full_name: string;
  phone: string;
  password: string;
};

const OPERATOR_KEY = "general_inventory_operator";
const OPERATOR_MODE_KEY = "general_inventory_operator_mode";
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

function number2(value: number | string | null | undefined) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("es-PE", { maximumFractionDigits: 2 });
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

function compareValues(a: string | number, b: string | number, direction: SortDirection) {
  const multiplier = direction === "asc" ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * multiplier;
  return String(a).localeCompare(String(b), "es", { numeric: true, sensitivity: "base" }) * multiplier;
}

function recountKey(row: Pick<RecountCandidate, "product_id" | "location_code" | "recount_type">) {
  return `${row.product_id}__${row.location_code || "FALTANTE"}__${row.recount_type}`;
}

function sortRecountAssignmentLines<T extends Pick<RecountCandidate, "value_diff" | "ticket" | "location_code" | "sku">>(rows: T[]) {
  return [...rows].sort((a, b) => {
    const ticketCompare = String(a.ticket || "").localeCompare(String(b.ticket || ""), "es", { numeric: true, sensitivity: "base" });
    if (ticketCompare !== 0) return ticketCompare;
    const valueCompare = Math.abs(Number(b.value_diff || 0)) - Math.abs(Number(a.value_diff || 0));
    if (valueCompare !== 0) return valueCompare;
    const locationCompare = String(a.location_code || "").localeCompare(String(b.location_code || ""), "es", { numeric: true, sensitivity: "base" });
    if (locationCompare !== 0) return locationCompare;
    return String(a.sku || "").localeCompare(String(b.sku || ""), "es", { numeric: true, sensitivity: "base" });
  });
}

function sortOperatorRecountCards<T extends Pick<RecountCandidate, "location_code" | "ticket" | "sku" | "value_diff">>(rows: T[]) {
  return [...rows].sort((a, b) => {
    const ticketCompare = String(a.ticket || "").localeCompare(String(b.ticket || ""), "es", { numeric: true, sensitivity: "base" });
    if (ticketCompare !== 0) return ticketCompare;
    const valueCompare = Math.abs(Number(b.value_diff || 0)) - Math.abs(Number(a.value_diff || 0));
    if (valueCompare !== 0) return valueCompare;
    const locationCompare = String(a.location_code || "").localeCompare(String(b.location_code || ""), "es", { numeric: true, sensitivity: "base" });
    if (locationCompare !== 0) return locationCompare;
    const skuCompare = String(a.sku || "").localeCompare(String(b.sku || ""), "es", { numeric: true, sensitivity: "base" });
    if (skuCompare !== 0) return skuCompare;
    return 0;
  });
}

export default function InventariosPage() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [sessions, setSessions] = useState<InventorySession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [operator, setOperator] = useState<InventoryOperator | null>(null);
  const [operatorMode, setOperatorMode] = useState<OperatorMode>("conteo");
  const [operatorName, setOperatorName] = useState("");
  const [operatorPhone, setOperatorPhone] = useState("");
  const [operatorPassword, setOperatorPassword] = useState("");
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
  const [countedLocationCodes, setCountedLocationCodes] = useState<string[]>([]);
  const [recordsQuery, setRecordsQuery] = useState("");
  const [locationCode, setLocationCode] = useState("");
  const [productCode, setProductCode] = useState("");
  const [quantity, setQuantity] = useState("");
  const [editingCountId, setEditingCountId] = useState<string | null>(null);
  const [productCandidates, setProductCandidates] = useState<Product[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [productLookupMessage, setProductLookupMessage] = useState("");
  const [savingCount, setSavingCount] = useState(false);
  const savingCountRef = useRef(false);
  const productInputRef = useRef<HTMLInputElement | null>(null);
  const qtyInputRef = useRef<HTMLInputElement | null>(null);

  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [summaryQuery, setSummaryQuery] = useState("");
  const [observationDrafts, setObservationDrafts] = useState<Record<string, string>>({});
  const [validatorTab, setValidatorTab] = useState<ValidatorTab>("preparacion");
  const [recordsSort, setRecordsSort] = useState<SortState<RecordsSortKey>>({ key: "counted_at", direction: "desc" });
  const [summarySort, setSummarySort] = useState<SortState<SummarySortKey>>({ key: "valueDiff", direction: "desc" });
  const [recountAssignedSort, setRecountAssignedSort] = useState<SortState<RecountAssignedSortKey>>({ key: "ticket", direction: "asc" });
  const [recountAssignedQuery, setRecountAssignedQuery] = useState("");
  const [sessionOperators, setSessionOperators] = useState<InventoryOperator[]>([]);
  const [inventoryOperators, setInventoryOperators] = useState<InventoryOperator[]>([]);
  const [inventoryOperatorDrafts, setInventoryOperatorDrafts] = useState<Record<string, InventoryOperatorDraft>>({});
  const [savingInventoryOperatorId, setSavingInventoryOperatorId] = useState<string | null>(null);
  const [recountItems, setRecountItems] = useState<RecountItem[]>([]);
  const [reassignOperatorDrafts, setReassignOperatorDrafts] = useState<Record<string, string>>({});
  const [operatorRecountContextItems, setOperatorRecountContextItems] = useState<RecountItem[]>([]);
  const [recountType, setRecountType] = useState<RecountType>("surplus");
  const recountColumn: RecountColumn = "zone";
  const [recountValue, setRecountValue] = useState("");
  const [recountOperatorId, setRecountOperatorId] = useState("");
  const [recountDrafts, setRecountDrafts] = useState<Record<string, RecountDraft>>({});
  const [savingRecountId, setSavingRecountId] = useState<string | null>(null);
  const [scannerTarget, setScannerTarget] = useState<ScannerTarget>(null);
  const [torchOn, setTorchOn] = useState(false);
  const scannerRef = useRef<any>(null);
  const scannerBusyRef = useRef(false);
  const scannerTargetRef = useRef<ScannerTarget>(null);
  const activeRecountScanIdRef = useRef<string | null>(null);
  const scannerHistoryRef = useRef(false);
  const scannerContainerId = "inventory-scanner";

  const isValidator = user?.role === "Administrador" || user?.role === "Validador";
  const selectedSession = useMemo(
    () => sessions.find(session => session.id === selectedSessionId) || null,
    [sessions, selectedSessionId]
  );

  const activeSessions = useMemo(
    () => sessions.filter(session => canOperatorEnter(session.status)),
    [sessions]
  );

  const isOperatorView = !!operator && !isValidator;
  const showSidePanel = false;

  const filteredCounts = useMemo(() => {
    const q = recordsQuery.trim().toLowerCase();
    const rows = counts.filter(row =>
      !q ||
      row.sku.toLowerCase().includes(q) ||
      row.description.toLowerCase().includes(q) ||
      row.location_code.toLowerCase().includes(q) ||
      String(row.operator_name || "").toLowerCase().includes(q)
    );
    return rows.sort((a, b) => {
      const left = recordsSort.key === "value" ? Number(a.quantity || 0) * Number(a.cost_snapshot || 0) :
        recordsSort.key === "counted_at" ? new Date(a.counted_at).getTime() :
        a[recordsSort.key];
      const right = recordsSort.key === "value" ? Number(b.quantity || 0) * Number(b.cost_snapshot || 0) :
        recordsSort.key === "counted_at" ? new Date(b.counted_at).getTime() :
        b[recordsSort.key];
      return compareValues(left ?? "", right ?? "", recordsSort.direction);
    });
  }, [counts, recordsQuery, recordsSort]);

  const counterStats = useMemo(() => {
    const grouped = new Map<string, { id: string; name: string; count: number; first: number; last: number }>();
    for (const row of counts) {
      const time = new Date(row.counted_at).getTime();
      const key = row.operator_id;
      const current = grouped.get(key);
      if (!current) {
        grouped.set(key, { id: key, name: row.operator_name || "Sin usuario", count: 1, first: time, last: time });
        continue;
      }
      current.count += 1;
      current.first = Math.min(current.first, time);
      current.last = Math.max(current.last, time);
    }
    const rows = [...grouped.values()].map(row => {
      const minutes = Math.max(1, (row.last - row.first) / 60000);
      return { ...row, minutes, perMinute: row.count / minutes };
    }).sort((a, b) => b.perMinute - a.perMinute);
    const maxPerMinute = Math.max(1, ...rows.map(row => row.perMinute));
    return { rows, maxPerMinute };
  }, [counts]);

  const filteredSummary = useMemo(() => {
    const q = summaryQuery.trim().toLowerCase();
    const rows = summary.filter(row =>
      !q ||
      row.sku.toLowerCase().includes(q) ||
      row.description.toLowerCase().includes(q) ||
      String(row.observation || "").toLowerCase().includes(q)
    );
    return rows.sort((a, b) => {
      const left = summarySort.key === "observation" ? String(a.observation || "") : a[summarySort.key];
      const right = summarySort.key === "observation" ? String(b.observation || "") : b[summarySort.key];
      return compareValues(left, right, summarySort.direction);
    });
  }, [summary, summaryQuery, summarySort]);

  const recountCandidates = useMemo(() => {
    const summaryByProduct = new Map(summary.map(row => [row.product_id, row]));
    const locationById = new Map(locations.map(row => [row.id, row]));
    const surplusGroups = new Map<string, RecountCandidate>();

    for (const row of counts) {
      const summaryRow = summaryByProduct.get(row.product_id);
      if (!summaryRow || summaryRow.diff <= 0) continue;
      const location = locationById.get(row.location_id) || null;
      const key = `${row.product_id}__${row.location_id || row.location_code}`;
      const current = surplusGroups.get(key);
      if (current) {
        current.counted_qty += Number(row.quantity || 0);
        current.value_diff = summaryRow.valueDiff;
        continue;
      }
      surplusGroups.set(key, {
        product_id: row.product_id,
        sku: row.sku,
        description: row.description,
        unit: row.unit,
        location_id: row.location_id,
        location_code: row.location_code,
        full_location: location?.full_location || location?.description || null,
        zone: location?.zone || null,
        zone_ref: location?.zone_ref || null,
        lineal: location?.lineal || null,
        ticket: location?.ticket || row.location_code,
        recount_type: "surplus",
        system_stock: summaryRow.system_stock,
        counted_qty: Number(row.quantity || 0),
        diff_qty: summaryRow.diff,
        cost_snapshot: Number(row.cost_snapshot || summaryRow.cost || 0),
        value_diff: summaryRow.valueDiff,
      });
    }

    const missingRows = summary
      .filter(row => row.diff < 0)
      .map(row => ({
        product_id: row.product_id,
        sku: row.sku,
        description: row.description,
        unit: row.unit,
        location_id: null,
        location_code: null,
        full_location: null,
        zone: null,
        zone_ref: null,
        lineal: null,
        ticket: null,
        recount_type: "missing" as const,
        system_stock: row.system_stock,
        counted_qty: row.counted,
        diff_qty: row.diff,
        cost_snapshot: row.cost,
        value_diff: row.valueDiff,
      }));

    return sortRecountAssignmentLines([...surplusGroups.values(), ...missingRows]);
  }, [counts, locations, summary]);

  const recountValues = useMemo(() => {
    const values = locations
      .map(location => String(location[recountColumn] || "").trim())
      .filter(Boolean);
    return [...new Set(values)].sort((a, b) => a.localeCompare(b, "es", { numeric: true }));
  }, [locations, recountColumn]);

  const selectedRecountCandidates = useMemo(() => {
    if (recountType === "missing") {
      return sortRecountAssignmentLines(recountCandidates.filter(row => row.recount_type === "missing"));
    }
    return sortRecountAssignmentLines(recountCandidates.filter(row => row.recount_type === "surplus" && String(row[recountColumn] || "") === recountValue));
  }, [recountCandidates, recountColumn, recountType, recountValue]);

  const assignedRecountKeys = useMemo(
    () => new Set(recountItems.filter(row => row.status !== "cancelled").map(row => recountKey(row))),
    [recountItems]
  );

  const unassignedRecountCandidates = useMemo(
    () => selectedRecountCandidates.filter(row => !assignedRecountKeys.has(recountKey(row))),
    [assignedRecountKeys, selectedRecountCandidates]
  );

  const assignedRecountRows = useMemo(() => {
    const q = recountAssignedQuery.trim().toLowerCase();
    const rows = recountItems.filter(row =>
      row.status !== "cancelled" &&
      (!q ||
        row.sku.toLowerCase().includes(q) ||
        row.description.toLowerCase().includes(q) ||
        String(row.location_code || "").toLowerCase().includes(q) ||
        String(row.full_location || "").toLowerCase().includes(q) ||
        String(row.ticket || "").toLowerCase().includes(q))
    );
    return [...rows].sort((a, b) => {
      if (recountAssignedSort.key === "ticket") {
        const ticketCompare = compareValues(String(a.ticket || ""), String(b.ticket || ""), recountAssignedSort.direction);
        if (ticketCompare !== 0) return ticketCompare;
        const valueCompare = Math.abs(Number(b.value_diff || 0)) - Math.abs(Number(a.value_diff || 0));
        if (valueCompare !== 0) return valueCompare;
      }
      if (recountAssignedSort.key === "value_diff") {
        const multiplier = recountAssignedSort.direction === "asc" ? 1 : -1;
        const valueCompare = (Math.abs(Number(a.value_diff || 0)) - Math.abs(Number(b.value_diff || 0))) * multiplier;
        if (valueCompare !== 0) return valueCompare;
        return String(a.ticket || "").localeCompare(String(b.ticket || ""), "es", { numeric: true, sensitivity: "base" });
      }
      const left = recountAssignedSort.key === "assigned_operator_name" ? String(a.assigned_operator_name || "") : a[recountAssignedSort.key];
      const right = recountAssignedSort.key === "assigned_operator_name" ? String(b.assigned_operator_name || "") : b[recountAssignedSort.key];
      return compareValues(left as string | number, right as string | number, recountAssignedSort.direction);
    });
  }, [recountAssignedQuery, recountAssignedSort, recountItems]);

  function toggleRecordsSort(key: RecordsSortKey) {
    setRecordsSort(prev => ({ key, direction: prev.key === key && prev.direction === "desc" ? "asc" : "desc" }));
  }

  function toggleSummarySort(key: SummarySortKey) {
    setSummarySort(prev => ({ key, direction: prev.key === key && prev.direction === "desc" ? "asc" : "desc" }));
  }

  function toggleRecountAssignedSort(key: RecountAssignedSortKey) {
    setRecountAssignedSort(prev => ({ key, direction: prev.key === key && prev.direction === "desc" ? "asc" : "desc" }));
  }

  const pendingLocations = useMemo(() => {
    const counted = new Set(countedLocationCodes);
    return locations.filter(location => !counted.has(location.location_code));
  }, [locations, countedLocationCodes]);

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
    const totalSystemUnits = rows.reduce((sum, row) => sum + row.system_stock, 0);
    const productsWithStock = rows.filter(row => row.system_stock > 0).length;
    const countedValue = rows.filter(row => row.counted > 0).reduce((sum, row) => sum + row.system_stock * row.cost, 0);
    return {
      eri: totalCodes > 0 ? Math.round((okCodes / totalCodes) * 100) : 0,
      systemValue,
      totalSystemUnits,
      productsWithStock,
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
        const savedMode = localStorage.getItem(OPERATOR_MODE_KEY);
        if (savedMode === "reconteo") setOperatorMode("reconteo");
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
    void loadSessionData(selectedSessionId, validatorTab);
  }, [selectedSessionId, validatorTab]);

  useEffect(() => {
    if (!selectedSessionId || !operator || isValidator) return;
    void loadOperatorRecountItems(selectedSessionId, operator.id);
  }, [selectedSessionId, operator?.id, isValidator]);

  useEffect(() => {
    if (!operator || isValidator) return;
    const raw = productCode.trim();
    if (selectedProduct && raw.toUpperCase() === selectedProduct.sku) return;
    setSelectedProduct(null);
    setProductLookupMessage("");
    if (raw.length < 3 || !selectedSessionId) {
      setProductCandidates([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const result = await findProductCandidates(raw);
        setProductCandidates(result.products);
        setProductLookupMessage(result.message);
        if (result.products.length === 1) setSelectedProduct(result.products[0]);
      } catch {
        setProductCandidates([]);
        setProductLookupMessage("No se pudo consultar el producto. Intenta nuevamente.");
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [productCode, selectedSessionId, operator?.id, isValidator, selectedProduct]);

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
            const target = scannerTargetRef.current;
            const activeRecountScanId = activeRecountScanIdRef.current;
            await stopScanner();
            const clean = decodedText.trim();
            if (target === "location") {
              setLocationCode(clean.toUpperCase());
              setMessage("Ubicación escaneada.");
              setTimeout(() => productInputRef.current?.focus(), 50);
            }
            if (target === "product") {
              setProductCode(clean);
              setMessage("Código de producto escaneado.");
              setTimeout(() => qtyInputRef.current?.focus(), 50);
            }
            if (target === "recount_location" && activeRecountScanId) {
              updateRecountDraft(activeRecountScanId, "locationCode", clean.toUpperCase());
              setMessage("Ubicacion de reconteo escaneada.");
            }
            if (target === "recount_product" && activeRecountScanId) {
              updateRecountDraft(activeRecountScanId, "productCode", clean);
              setMessage("Codigo de reconteo escaneado.");
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
      window.history.pushState({ inventoryScanner: true }, "", window.location.href);
      scannerHistoryRef.current = true;
    }
    setTorchOn(false);
    setScannerTarget(target);
  }

  function openRecountScanner(rowId: string, target: "recount_location" | "recount_product") {
    activeRecountScanIdRef.current = rowId;
    openScanner(target);
  }

  async function stopScanner(removeHistory = true) {
    scannerTargetRef.current = null;
    activeRecountScanIdRef.current = null;
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

  async function refreshCurrentView() {
    await loadInitial(selectedSessionId);
    if (selectedSessionId) await loadSessionData(selectedSessionId, validatorTab);
  }

  async function loadSessionData(sessionId: string, tab: ValidatorTab = validatorTab) {
    if (isValidator) {
      if (tab === "preparacion") {
        await loadPreparationData(sessionId);
        return;
      }
      if (tab === "registros") {
        await loadRecordsData(sessionId);
        return;
      }
      if (tab === "reconteo") {
        await loadRecountData(sessionId);
        return;
      }
      if (tab === "usuarios") {
        await loadInventoryOperators();
        return;
      }
      await loadSummary(sessionId);
      return;
    }

    await Promise.all([loadPreparationData(sessionId), loadRecordsData(sessionId)]);
  }

  async function loadPreparationData(sessionId: string) {
    const [locRes, countRows] = await Promise.all([
      supabase.from("general_inventory_locations").select("*").eq("session_id", sessionId).eq("is_active", true).order("location_code"),
      loadPagedSessionRows("general_inventory_counts", "location_code", sessionId, "location_code"),
    ]);

    setLocations((locRes.data || []) as InventoryLocation[]);
    setCountedLocationCodes([...new Set(countRows.map(row => row.location_code).filter(Boolean))]);
  }

  async function loadRecordsData(sessionId: string) {
    const countRows = await loadAllCounts(sessionId);
    setCounts(countRows);
    setCountedLocationCodes([...new Set(countRows.map(row => row.location_code).filter(Boolean))]);
  }

  async function loadRecountData(sessionId: string) {
    await Promise.all([
      loadPreparationData(sessionId),
      loadRecordsData(sessionId),
      loadSummary(sessionId),
      loadRecountAssignments(sessionId),
    ]);
  }

  async function loadRecountAssignments(sessionId: string) {
    const [operatorsRes, countOperatorsRes, recountCountOperatorsRes, itemsRes] = await Promise.all([
      supabase
        .from("general_inventory_session_operators")
        .select("operator_id,status,general_inventory_operators(id,full_name,phone)")
        .eq("session_id", sessionId)
        .eq("status", "active"),
      supabase
        .from("general_inventory_counts")
        .select("operator_id")
        .eq("session_id", sessionId),
      supabase
        .from("general_inventory_recount_counts")
        .select("operator_id")
        .eq("session_id", sessionId),
      supabase
        .from("general_inventory_recount_items")
        .select("*")
        .eq("session_id", sessionId)
        .order("location_code", { ascending: true, nullsFirst: false })
        .order("value_diff", { ascending: false }),
    ]);

    if (operatorsRes.error) {
      setMessage("Error leyendo operadores activos: " + operatorsRes.error.message);
    }
    if (countOperatorsRes.error) {
      setMessage("Error leyendo contadores de la sesion: " + countOperatorsRes.error.message);
    }
    if (recountCountOperatorsRes.error) {
      setMessage("Error leyendo reconteos guardados: " + recountCountOperatorsRes.error.message);
    }
    if (itemsRes.error) {
      setMessage("Ejecuta primero el SQL de reconteo. Error: " + itemsRes.error.message);
    }

    const activeOperators = (operatorsRes.data || [])
      .map((row: any) => row.general_inventory_operators)
      .filter(Boolean) as InventoryOperator[];
    const operatorById = new Map<string, InventoryOperator>();
    for (const row of activeOperators) operatorById.set(row.id, row);

    const sessionOperatorIds = new Set<string>(activeOperators.map(row => row.id));
    for (const row of countOperatorsRes.data || []) if (row.operator_id) sessionOperatorIds.add(row.operator_id);
    for (const row of recountCountOperatorsRes.data || []) if (row.operator_id) sessionOperatorIds.add(row.operator_id);
    for (const row of itemsRes.data || []) if (row.assigned_operator_id) sessionOperatorIds.add(row.assigned_operator_id);

    const missingSessionOperatorIds = [...sessionOperatorIds].filter(id => !operatorById.has(id));
    if (missingSessionOperatorIds.length > 0) {
      const missingOperatorsRes = await supabase
        .from("general_inventory_operators")
        .select("id,full_name,phone")
        .in("id", missingSessionOperatorIds);
      for (const row of (missingOperatorsRes.data || []) as InventoryOperator[]) operatorById.set(row.id, row);
    }

    const sessionOperatorsSorted = [...operatorById.values()].sort((a, b) =>
      `${a.full_name} ${a.phone}`.localeCompare(`${b.full_name} ${b.phone}`, "es", { numeric: true, sensitivity: "base" })
    );
    setSessionOperators(sessionOperatorsSorted);
    if (!recountOperatorId && sessionOperatorsSorted[0]?.id) setRecountOperatorId(sessionOperatorsSorted[0].id);

    const operatorLabelById = new Map(sessionOperatorsSorted.map(row => [row.id, row.full_name]));
    const assignedOperatorIds = [...new Set((itemsRes.data || []).map((row: any) => row.assigned_operator_id).filter(Boolean))];
    const missingAssignedIds = assignedOperatorIds.filter((id: string) => !operatorLabelById.has(id));
    if (missingAssignedIds.length > 0) {
      const assignedOperatorsRes = await supabase
        .from("general_inventory_operators")
        .select("id,full_name,phone")
        .in("id", missingAssignedIds);
      for (const row of (assignedOperatorsRes.data || []) as InventoryOperator[]) {
        operatorLabelById.set(row.id, row.full_name);
      }
    }
    const rows = sortRecountAssignmentLines((itemsRes.data || []).map((row: any) => ({
      id: row.id,
      product_id: row.product_id,
      sku: row.sku,
      description: row.description || "",
      unit: row.unit || "",
      location_id: row.location_id,
      location_code: row.location_code,
      full_location: row.full_location || null,
      zone: row.zone || null,
      zone_ref: row.zone_ref || null,
      lineal: row.lineal || null,
      ticket: row.ticket || row.location_code || null,
      recount_type: row.recount_type,
      system_stock: Number(row.system_stock || 0),
      counted_qty: Number(row.counted_qty || 0),
      diff_qty: Number(row.diff_qty || 0),
      cost_snapshot: Number(row.cost_snapshot || 0),
      value_diff: Number(row.value_diff || 0),
      assigned_operator_id: row.assigned_operator_id,
      assigned_operator_name: operatorLabelById.get(row.assigned_operator_id) || null,
      status: row.status || "assigned",
    })) as RecountItem[]);
    setRecountItems(rows);
    setReassignOperatorDrafts(Object.fromEntries(rows.map(row => [row.id, row.assigned_operator_id || ""])));
  }

  async function loadInventoryOperators(sessionId = selectedSessionId) {
    let rows: InventoryOperator[] = [];
    if (sessionId) {
      const [sessionOpsRes, countOpsRes, recountItemsRes, recountCountsRes] = await Promise.all([
        supabase.from("general_inventory_session_operators").select("operator_id").eq("session_id", sessionId).eq("status", "active"),
        supabase.from("general_inventory_counts").select("operator_id").eq("session_id", sessionId),
        supabase.from("general_inventory_recount_items").select("assigned_operator_id").eq("session_id", sessionId),
        supabase.from("general_inventory_recount_counts").select("operator_id").eq("session_id", sessionId),
      ]);
      const ids = new Set<string>();
      for (const row of sessionOpsRes.data || []) if (row.operator_id) ids.add(row.operator_id);
      for (const row of countOpsRes.data || []) if (row.operator_id) ids.add(row.operator_id);
      for (const row of recountItemsRes.data || []) if (row.assigned_operator_id) ids.add(row.assigned_operator_id);
      for (const row of recountCountsRes.data || []) if (row.operator_id) ids.add(row.operator_id);
      if (ids.size > 0) {
        const { data, error } = await supabase
          .from("general_inventory_operators")
          .select("id,full_name,phone,password")
          .in("id", [...ids]);
        if (error) {
          setMessage("No se pudo leer usuarios de inventario: " + error.message);
          return;
        }
        rows = (data || []) as InventoryOperator[];
      }
    } else {
      const { data, error } = await supabase
        .from("general_inventory_operators")
        .select("id,full_name,phone,password")
        .order("full_name", { ascending: true })
        .order("phone", { ascending: true });
      if (error) {
        setMessage("No se pudo leer usuarios de inventario: " + error.message);
        return;
      }
      rows = (data || []) as InventoryOperator[];
    }

    rows.sort((a, b) => `${a.full_name} ${a.phone}`.localeCompare(`${b.full_name} ${b.phone}`, "es", { numeric: true, sensitivity: "base" }));
    setInventoryOperators(rows);
    setInventoryOperatorDrafts(Object.fromEntries(rows.map(row => [row.id, {
      full_name: row.full_name || "",
      phone: row.phone || "",
      password: row.password || "",
    }])));
  }

  function updateInventoryOperatorDraft(id: string, field: keyof InventoryOperatorDraft, value: string) {
    setInventoryOperatorDrafts(prev => ({
      ...prev,
      [id]: {
        full_name: prev[id]?.full_name || "",
        phone: prev[id]?.phone || "",
        password: prev[id]?.password || "",
        [field]: value,
      },
    }));
  }

  async function saveInventoryOperator(id: string) {
    if (user?.role !== "Administrador") {
      setMessage("Solo el administrador puede editar usuarios de inventario.");
      return;
    }
    const draft = inventoryOperatorDrafts[id];
    if (!draft) return;
    const fullName = draft.full_name.trim();
    const phone = normalizePhone(draft.phone);
    const password = draft.password.trim();
    if (!fullName || phone.length < 8 || !password) {
      setMessage("Completa nombre, celular valido y clave.");
      return;
    }

    setSavingInventoryOperatorId(id);
    const { error } = await supabase
      .from("general_inventory_operators")
      .update({ full_name: fullName, phone, password })
      .eq("id", id);
    setSavingInventoryOperatorId(null);

    if (error) {
      setMessage("No se pudo actualizar usuario. Revisa si el celular ya existe: " + error.message);
      return;
    }

    setMessage("Usuario de inventario actualizado.");
    await loadInventoryOperators();
    if (selectedSessionId) await loadRecountAssignments(selectedSessionId);
  }

  async function deleteInventoryOperator(id: string) {
    if (user?.role !== "Administrador") {
      setMessage("Solo el administrador puede eliminar usuarios de inventario.");
      return;
    }
    const row = inventoryOperators.find(item => item.id === id);
    if (!row || !confirm(`Eliminar usuario de inventario ${row.full_name}?`)) return;

    const [countsRes, recountCountsRes, recountItemsRes] = await Promise.all([
      supabase.from("general_inventory_counts").select("id").eq("operator_id", id).limit(1),
      supabase.from("general_inventory_recount_counts").select("id").eq("operator_id", id).limit(1),
      supabase.from("general_inventory_recount_items").select("id").eq("assigned_operator_id", id).limit(1),
    ]);

    if ((countsRes.data || []).length > 0 || (recountCountsRes.data || []).length > 0 || (recountItemsRes.data || []).length > 0) {
      setMessage("No se puede eliminar: este usuario tiene registros o reconteos asignados. Edita sus datos o reasigna primero.");
      return;
    }

    const sessionCleanup = await supabase.from("general_inventory_session_operators").delete().eq("operator_id", id);
    if (sessionCleanup.error) {
      setMessage("No se pudo limpiar sesiones del usuario: " + sessionCleanup.error.message);
      return;
    }

    const { error } = await supabase.from("general_inventory_operators").delete().eq("id", id);
    if (error) {
      setMessage("No se pudo eliminar usuario: " + error.message);
      return;
    }

    setMessage("Usuario de inventario eliminado.");
    await loadInventoryOperators();
    if (selectedSessionId) await loadRecountAssignments(selectedSessionId);
  }

  async function loadOperatorRecountItems(sessionId: string, operatorId: string) {
    const operatorIds = new Set([operatorId]);
    if (operator?.phone) {
      const samePhone = await supabase
        .from("general_inventory_operators")
        .select("id")
        .eq("phone", operator.phone);
      for (const row of samePhone.data || []) operatorIds.add(row.id);
    }

    const { data, error } = await supabase
      .from("general_inventory_recount_items")
      .select("*")
      .eq("session_id", sessionId)
      .in("assigned_operator_id", [...operatorIds])
      .order("location_code", { ascending: true, nullsFirst: false })
      .order("value_diff", { ascending: false });
    if (error) {
      setMessage("No se pudo leer reconteos asignados: " + error.message);
      return;
    }
    const openRows = (data || []).filter((row: any) => !["counted", "cancelled"].includes(row.status || ""));
    const mappedRows = sortOperatorRecountCards(openRows.map((row: any) => ({
      id: row.id,
      product_id: row.product_id,
      sku: row.sku,
      description: row.description || "",
      unit: row.unit || "",
      location_id: row.location_id,
      location_code: row.location_code,
      full_location: row.full_location || null,
      zone: row.zone || null,
      zone_ref: row.zone_ref || null,
      lineal: row.lineal || null,
      ticket: row.ticket || row.location_code || null,
      recount_type: row.recount_type,
      system_stock: Number(row.system_stock || 0),
      counted_qty: Number(row.counted_qty || 0),
      diff_qty: Number(row.diff_qty || 0),
      cost_snapshot: Number(row.cost_snapshot || 0),
      value_diff: Number(row.value_diff || 0),
      assigned_operator_id: row.assigned_operator_id,
      assigned_operator_name: operator?.full_name || null,
      status: row.status || "assigned",
    })) as RecountItem[]);
    setRecountItems(mappedRows);

    const surplusProductIds = [...new Set(mappedRows.filter(row => row.recount_type === "surplus").map(row => row.product_id))];
    if (surplusProductIds.length === 0) {
      setOperatorRecountContextItems([]);
      return;
    }

    const contextRes = await supabase
      .from("general_inventory_recount_items")
      .select("*")
      .eq("session_id", sessionId)
      .eq("recount_type", "surplus")
      .in("product_id", surplusProductIds);
    setOperatorRecountContextItems(sortOperatorRecountCards((contextRes.data || []).map((row: any) => ({
      id: row.id,
      product_id: row.product_id,
      sku: row.sku,
      description: row.description || "",
      unit: row.unit || "",
      location_id: row.location_id,
      location_code: row.location_code,
      full_location: row.full_location || null,
      zone: row.zone || null,
      zone_ref: row.zone_ref || null,
      lineal: row.lineal || null,
      ticket: row.ticket || row.location_code || null,
      recount_type: row.recount_type,
      system_stock: Number(row.system_stock || 0),
      counted_qty: Number(row.counted_qty || 0),
      diff_qty: Number(row.diff_qty || 0),
      cost_snapshot: Number(row.cost_snapshot || 0),
      value_diff: Number(row.value_diff || 0),
      assigned_operator_id: row.assigned_operator_id,
      assigned_operator_name: null,
      status: row.status || "assigned",
    })) as RecountItem[]));
  }

  async function loadAllCounts(sessionId: string): Promise<CountRow[]> {
    const rows: CountRow[] = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("general_inventory_counts")
        .select("*, general_inventory_operators(full_name)")
        .eq("session_id", sessionId)
        .order("counted_at", { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) {
        setMessage("Error leyendo registros: " + error.message);
        break;
      }
      rows.push(...((data || []).map((row: any) => ({
        ...row,
        operator_name: row.general_inventory_operators?.full_name || null,
      })) as CountRow[]));
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
    const [snapshotRows, countRows, observationRows, nonInventoryRows, recountCountRows, recountItemRows] = await Promise.all([
      loadPagedSessionRows("general_inventory_stock_snapshot", "*", sessionId, "sku"),
      loadPagedSessionRows("general_inventory_counts", "product_id,sku,description,unit,quantity,cost_snapshot", sessionId, "sku"),
      loadPagedSessionRows("general_inventory_item_observations", "*", sessionId, "product_id"),
      loadPagedSessionRows("general_inventory_non_inventory_products", "sku", sessionId, "sku"),
      loadPagedSessionRows("general_inventory_recount_counts", "recount_item_id,product_id,sku,description,unit,quantity,cost_snapshot", sessionId, "sku"),
      loadPagedSessionRows("general_inventory_recount_items", "id,product_id,counted_qty", sessionId, "product_id"),
    ]);

    const nonInventorySkus = new Set(nonInventoryRows.map(row => row.sku));
    const countedByProduct = new Map<string, number>();
    for (const row of countRows) {
      if (nonInventorySkus.has(row.sku)) continue;
      countedByProduct.set(row.product_id, (countedByProduct.get(row.product_id) || 0) + Number(row.quantity || 0));
    }
    const recountItemById = new Map(recountItemRows.map(row => [row.id, row]));
    for (const row of recountCountRows) {
      if (nonInventorySkus.has(row.sku)) continue;
      const original = recountItemById.get(row.recount_item_id);
      if (original?.product_id) {
        countedByProduct.set(original.product_id, (countedByProduct.get(original.product_id) || 0) - Number(original.counted_qty || 0));
      }
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

  async function assignRecountBlock(limit?: number) {
    if (!selectedSessionId || !user || !recountOperatorId) {
      setMessage("Selecciona operador activo para asignar reconteo.");
      return;
    }
    if (recountType === "surplus" && !recountValue) {
      setMessage("Selecciona el bloque de ubicaciones para sobrantes.");
      return;
    }

    const sourceRows = typeof limit === "number" ? unassignedRecountCandidates.slice(0, limit) : unassignedRecountCandidates;
    const rows = sourceRows.map(row => ({
      session_id: selectedSessionId,
      product_id: row.product_id,
      location_id: row.location_id,
      location_code: row.location_code || "FALTANTE",
      ticket: row.ticket,
      zone: row.zone,
      zone_ref: row.zone_ref,
      lineal: row.lineal,
      full_location: row.full_location,
      recount_type: row.recount_type,
      sku: row.sku,
      description: row.description,
      unit: row.unit,
      system_stock: row.system_stock,
      counted_qty: row.counted_qty,
      diff_qty: row.diff_qty,
      cost_snapshot: row.cost_snapshot,
      value_diff: row.value_diff,
      assigned_operator_id: recountOperatorId,
      assigned_by: user.id,
      status: "assigned",
      updated_at: new Date().toISOString(),
    }));

    if (rows.length === 0) {
      setMessage("No hay diferencias pendientes para asignar con ese filtro.");
      return;
    }

    const { error } = await supabase
      .from("general_inventory_recount_items")
      .upsert(rows, { onConflict: "session_id,product_id,location_code,recount_type" });
    if (error) {
      setMessage("No se pudo asignar reconteo. Ejecuta el SQL si aun no lo hiciste: " + error.message);
      return;
    }

    setMessage(`${rows.length} items asignados para reconteo.`);
    await loadRecountAssignments(selectedSessionId);
  }

  async function reassignRecountItem(item: RecountItem) {
    if (!selectedSessionId || !user || !isValidator) {
      setMessage("Solo el validador o administrador puede reasignar reconteos.");
      return;
    }
    if (item.status === "counted") {
      setMessage("Este reconteo ya fue contado y no se puede reasignar sin anular la validacion.");
      return;
    }
    const nextOperatorId = reassignOperatorDrafts[item.id];
    if (!nextOperatorId) {
      setMessage("Selecciona el nuevo operador.");
      return;
    }
    if (!sessionOperators.some(row => row.id === nextOperatorId)) {
      setMessage("El operador debe estar asociado a esta sesion para recibir reconteos.");
      return;
    }
    const { error } = await supabase
      .from("general_inventory_recount_items")
      .update({
        assigned_operator_id: nextOperatorId,
        status: "assigned",
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id);
    if (error) {
      setMessage("No se pudo reasignar reconteo: " + error.message);
      return;
    }
    setMessage("Reconteo reasignado.");
    await loadRecountAssignments(selectedSessionId);
  }

  async function unassignRecountItem(item: RecountItem) {
    if (!selectedSessionId || !user || !isValidator) {
      setMessage("Solo el validador o administrador puede quitar asignaciones.");
      return;
    }
    if (item.status === "counted") {
      setMessage("Este reconteo ya fue contado y no se puede quitar sin anular la validacion.");
      return;
    }
    const { error } = await supabase
      .from("general_inventory_recount_items")
      .update({
        assigned_operator_id: null,
        status: "cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id);
    if (error) {
      setMessage("No se pudo quitar la asignacion: " + error.message);
      return;
    }
    setMessage("Asignacion quitada. La linea volvio a pendientes de reconteo.");
    await loadRecountAssignments(selectedSessionId);
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
    await loadPreparationData(selectedSessionId);
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
    if (validatorTab === "resumen") await loadSummary(selectedSessionId);
  }

  async function freezeStock() {
    if (!user || !selectedSessionId) return;
    setLoading(true);
    setMessage("Congelando stock. Este proceso puede tardar varios minutos si es la primera vez.");
    const { data, error } = await supabase.rpc("freeze_general_inventory_stock", {
      p_session_id: selectedSessionId,
      p_user_id: user.id,
    });
    setLoading(false);
    if (error) {
      setMessage("No se pudo congelar stock: " + error.message);
      return;
    }
    const { count: productsWithStockCount } = await supabase
      .from("general_inventory_stock_snapshot")
      .select("id", { count: "exact", head: true })
      .eq("session_id", selectedSessionId)
      .gt("system_stock", 0);
    setMessage(`Stock congelado. Productos en foto: ${data || 0}. Con stock: ${productsWithStockCount || 0}.`);
    await loadInitial(selectedSessionId);
    setValidatorTab("resumen");
    await loadSummary(selectedSessionId);
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
    setCountedLocationCodes([]);
    setSummary([]);
    setMessage("Sesion eliminada.");
    await loadInitial("");
  }

  async function registerOperator() {
    const phone = normalizePhone(operatorPhone);
    if (!operatorName.trim() || phone.length < 8 || !operatorPassword.trim() || !selectedSession) {
      setMessage("Completa nombre, celular, clave y selecciona un inventario activo.");
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
      if (operatorRow.password && operatorRow.password !== operatorPassword.trim()) {
        setMessage("Celular ya registrado. Ingresa desde el login principal con tu clave.");
        return;
      }
      if (operatorRow.full_name !== operatorName.trim()) {
        await supabase.from("general_inventory_operators").update({ full_name: operatorName.trim(), password: operatorPassword.trim() }).eq("id", operatorRow.id);
        operatorRow = { ...operatorRow, full_name: operatorName.trim(), password: operatorPassword.trim() };
      }
    } else {
      const created = await supabase
        .from("general_inventory_operators")
        .insert({ full_name: operatorName.trim(), phone, password: operatorPassword.trim() })
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

  async function findProductCandidates(code: string): Promise<{ products: Product[]; message: string }> {
    const raw = normalizeCode(code).toUpperCase();
    if (!raw || !selectedSessionId) return { products: [], message: "" };

    const [byUpc, byAlu] = await Promise.all([
      supabase.from("codigos_barra").select("codsap,upc,alu").eq("upc", raw).not("codsap", "is", null).limit(20),
      supabase.from("codigos_barra").select("codsap,upc,alu").eq("alu", raw).not("codsap", "is", null).limit(20),
    ]);
    const mapped = [...(byUpc.data || []), ...(byAlu.data || [])].map(row => row.codsap).filter(Boolean);
    const candidateSkus = [...new Set([raw, ...mapped])];
    const productMap = new Map<string, Product>();

    if (candidateSkus.length > 0) {
      const { data } = await supabase
        .from("cyclic_products")
        .select("*")
        .in("sku", candidateSkus)
        .eq("is_active", true)
        .limit(20);
      for (const product of (data || []) as Product[]) productMap.set(product.sku, product);
    }

    if (raw.length >= 4) {
      const { data } = await supabase
        .from("cyclic_products")
        .select("*")
        .eq("is_active", true)
        .ilike("sku", `%${raw}%`)
        .limit(12);
      for (const product of (data || []) as Product[]) productMap.set(product.sku, product);
    }

    const products = [...productMap.values()];
    if (products.length === 0) return { products: [], message: "Codigo no existe en el maestro ni en codigos de barra." };

    const { data: nonInvRows } = await supabase
      .from("general_inventory_non_inventory_products")
      .select("sku")
      .eq("session_id", selectedSessionId)
      .in("sku", products.map(product => product.sku));
    const nonInvSkus = new Set((nonInvRows || []).map(row => row.sku));
    const allowed = products.filter(product => !nonInvSkus.has(product.sku));

    if (allowed.length === 0) {
      return { products: [], message: "Este codigo esta en la lista de no inventariables y no puede registrarse." };
    }

    return {
      products: allowed.sort((a, b) => a.sku.localeCompare(b.sku, "es", { numeric: true })),
      message: allowed.length > 1 ? "El codigo coincide con varios productos. Elige una tarjeta antes de guardar." : "",
    };
  }

  async function saveCount() {
    if (savingCountRef.current) return;
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

    savingCountRef.current = true;
    setSavingCount(true);

    try {
      const latestCandidates = selectedProduct ? productCandidates : (await findProductCandidates(productCode)).products;
      const product = selectedProduct || (latestCandidates.length === 1 ? latestCandidates[0] : null);
      if (!product) {
        setProductCandidates(latestCandidates);
        setMessage(latestCandidates.length > 1 ? "Elige el producto correcto antes de guardar." : "Codigo no existe en el maestro ni en codigos de barra.");
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
      setProductCandidates([]);
      setSelectedProduct(null);
      setProductLookupMessage("");
      setQuantity("");
      setEditingCountId(null);
      setMessage("Conteo guardado.");
      await loadSessionData(selectedSession.id, isValidator ? validatorTab : "registros");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo guardar conteo.");
    } finally {
      savingCountRef.current = false;
      setSavingCount(false);
    }
  }

  function recountDraftFor(row: RecountItem) {
    return recountDrafts[row.id] || {
      locationCode: row.location_code || "",
      productCode: row.sku,
      quantity: "",
    };
  }

  function updateRecountDraft(rowId: string, field: keyof RecountDraft, value: string) {
    setRecountDrafts(prev => ({
      ...prev,
      [rowId]: {
        locationCode: prev[rowId]?.locationCode || "",
        productCode: prev[rowId]?.productCode || "",
        quantity: prev[rowId]?.quantity || "",
        [field]: value,
      },
    }));
  }

  async function saveRecountValidation(row: RecountItem) {
    if (!operator || !selectedSessionId || savingRecountId) return;
    const draft = recountDraftFor(row);
    const locCode = draft.locationCode.trim().toUpperCase();
    const loc = locations.find(location => location.location_code === locCode);
    if (!loc) {
      setMessage("Ubicacion no autorizada para esta sesion.");
      return;
    }

    const qty = Number(draft.quantity);
    if (!draft.productCode.trim() || !Number.isFinite(qty) || qty < 0) {
      setMessage("Ingresa codigo y cantidad valida para el reconteo.");
      return;
    }

    setSavingRecountId(row.id);
    try {
      const candidates = (await findProductCandidates(draft.productCode)).products;
      const product = candidates.find(item => item.sku === draft.productCode.trim().toUpperCase()) || (candidates.length === 1 ? candidates[0] : null);
      if (!product) {
        setMessage(candidates.length > 1 ? "El codigo del reconteo coincide con varios productos. Ingresa el CodSap exacto." : "Codigo no existe en el maestro ni en codigos de barra.");
        return;
      }

      const snapshot = await supabase
        .from("general_inventory_stock_snapshot")
        .select("cost")
        .eq("session_id", selectedSessionId)
        .eq("product_id", product.id)
        .maybeSingle();

      const cost = Number(snapshot.data?.cost ?? product.cost ?? row.cost_snapshot ?? 0);
      const { error } = await supabase
        .from("general_inventory_recount_counts")
        .upsert({
          recount_item_id: row.id,
          session_id: selectedSessionId,
          operator_id: operator.id,
          location_id: loc.id,
          location_code: loc.location_code,
          product_id: product.id,
          sku: product.sku,
          description: product.description,
          unit: product.unit,
          quantity: qty,
          cost_snapshot: cost,
          updated_at: new Date().toISOString(),
        }, { onConflict: "recount_item_id" });
      if (error) {
        setMessage("No se pudo guardar reconteo. Ejecuta el SQL actualizado: " + error.message);
        return;
      }

      const statusUpdate = await supabase
        .from("general_inventory_recount_items")
        .update({ status: "counted", updated_at: new Date().toISOString() })
        .eq("id", row.id);
      if (statusUpdate.error) {
        setMessage("Reconteo guardado, pero no se pudo cerrar la linea: " + statusUpdate.error.message);
        return;
      }

      setRecountDrafts(prev => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      setMessage("Reconteo guardado.");
      await loadOperatorRecountItems(selectedSessionId, operator.id);
    } finally {
      setSavingRecountId(null);
    }
  }

  async function editCount(row: CountRow) {
    setEditingCountId(row.id);
    setLocationCode(row.location_code);
    setProductCode(row.sku);
    setSelectedProduct({
      id: row.product_id,
      sku: row.sku,
      barcode: null,
      description: row.description,
      unit: row.unit,
      cost: row.cost_snapshot,
      is_active: true,
    });
    setProductCandidates([]);
    setQuantity(String(row.quantity));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function deleteCount(row: CountRow) {
    const { error } = await supabase.from("general_inventory_counts").delete().eq("id", row.id);
    if (error) {
      setMessage("No se pudo eliminar: " + error.message);
      return;
    }
    await loadSessionData(row.session_id, isValidator ? validatorTab : "registros");
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
      CONTADOR: row.operator_name || "",
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
    setOperatorMode("conteo");
    localStorage.removeItem(OPERATOR_KEY);
    localStorage.removeItem(OPERATOR_MODE_KEY);
    localStorage.removeItem(SESSION_KEY);
  }

  async function openOperatorRecountMode() {
    setOperatorMode("reconteo");
    localStorage.setItem(OPERATOR_MODE_KEY, "reconteo");
    if (selectedSessionId && operator) await loadOperatorRecountItems(selectedSessionId, operator.id);
  }

  function openOperatorCountMode() {
    setOperatorMode("conteo");
    localStorage.setItem(OPERATOR_MODE_KEY, "conteo");
  }

  function logoutUser() {
    setUser(null);
    setValidatorTab("preparacion");
    localStorage.removeItem("cyclic_user");
    window.location.href = "/";
  }

  function goLogin() {
    window.location.href = "/";
  }

  function goModule(path: string) {
    window.location.href = path;
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-slate-100 text-slate-900">
      <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-2 py-3 sm:gap-3 sm:px-3">
          <button
            onClick={() => operator && !user ? (operatorMode === "reconteo" ? openOperatorCountMode() : logoutOperator()) : window.location.href = "/"}
            className="shrink-0 rounded-xl border p-2 text-slate-600 hover:bg-slate-50"
            title={operator && !user ? (operatorMode === "reconteo" ? "Volver a conteo" : "Cerrar sesión") : "Volver"}
          >
            {operator && !user ? (operatorMode === "reconteo" ? <ClipboardList size={18} /> : <LogOut size={18} />) : <ArrowLeft size={18} />}
          </button>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-600 font-black text-white">R</div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-black leading-tight">Inventarios generales</h1>
            <p className="truncate text-xs text-slate-500">RASECORP - conteo por ubicaciones</p>
          </div>
          <button onClick={refreshCurrentView} className="shrink-0 rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Actualizar">
            <RefreshCw size={18} />
          </button>
          {user?.role === "Administrador" && (
            <select
              value="/inventarios"
              onChange={event => goModule(event.target.value)}
              className="hidden shrink-0 rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-700 md:block"
              title="Cambiar modulo"
            >
              <option value="/dashboard">Ciclicos</option>
              <option value="/auditoria">Auditorias</option>
              <option value="/inventarios">Inventarios</option>
            </select>
          )}
          {user && (
            <button onClick={logoutUser} className="inline-flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-sm font-black text-slate-700 hover:bg-slate-50" title="Cerrar sesión">
              <LogOut size={18} />
              <span className="hidden sm:inline">Cerrar sesión</span>
            </button>
          )}
          {operator && !user && (
            <button onClick={operatorMode === "reconteo" ? openOperatorCountMode : openOperatorRecountMode} className={`inline-flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-sm font-black hover:bg-slate-50 ${operatorMode === "reconteo" ? "bg-slate-900 text-white hover:bg-slate-800" : "text-slate-700"}`} title={operatorMode === "reconteo" ? "Volver a conteo" : "Modo reconteo"}>
              {operatorMode === "reconteo" ? <ClipboardList size={18} /> : <PackageSearch size={18} />}
              <span className="hidden sm:inline">{operatorMode === "reconteo" ? "Conteo" : "Reconteo"}</span>
            </button>
          )}
          {!user && !operator && (
            <button onClick={goLogin} className="inline-flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-sm font-black text-slate-700 hover:bg-slate-50" title="Iniciar sesión">
              <LogIn size={18} />
              <span className="hidden sm:inline">Iniciar sesión</span>
            </button>
          )}
        </div>
      </header>

      <div className={`mx-auto grid w-full min-w-0 ${isOperatorView ? "max-w-2xl gap-2 px-2 py-2" : "max-w-7xl gap-4 px-3 py-4"} ${showSidePanel ? "lg:grid-cols-[360px_1fr]" : "lg:grid-cols-1"}`}>
        {showSidePanel && (
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
                <input value={operatorPassword} onChange={event => setOperatorPassword(event.target.value)} placeholder="Clave" type="password" className="w-full rounded-xl border px-3 py-3 text-sm" />
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
        )}

        <section className="min-w-0 space-y-4">
          {message && <div className="rounded-2xl border bg-white px-4 py-3 text-sm font-bold text-slate-700 shadow-sm">{message}</div>}

          {isValidator && selectedSessionId && (
            <section className="rounded-2xl border bg-white p-2 shadow-sm">
              <div className={`grid gap-2 ${user?.role === "Administrador" ? "grid-cols-2 md:grid-cols-5" : "grid-cols-2 md:grid-cols-4"}`}>
                <button onClick={() => setValidatorTab("preparacion")} className={`rounded-xl px-3 py-2 text-xs font-black ${validatorTab === "preparacion" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                  Preparacion
                </button>
                <button onClick={() => setValidatorTab("registros")} className={`rounded-xl px-3 py-2 text-xs font-black ${validatorTab === "registros" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                  Registros
                </button>
                <button onClick={() => setValidatorTab("reconteo")} className={`rounded-xl px-3 py-2 text-xs font-black ${validatorTab === "reconteo" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                  Reconteo
                </button>
                <button onClick={() => setValidatorTab("resumen")} className={`rounded-xl px-3 py-2 text-xs font-black ${validatorTab === "resumen" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                  Resumen
                </button>
                {user?.role === "Administrador" && (
                  <button onClick={() => setValidatorTab("usuarios")} className={`rounded-xl px-3 py-2 text-xs font-black ${validatorTab === "usuarios" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                    Usuarios
                  </button>
                )}
              </div>
            </section>
          )}

          {isValidator && validatorTab === "preparacion" && (
            <section className="grid gap-4 xl:grid-cols-[360px_1fr]">
              <div className="space-y-4">
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

                <section className="rounded-2xl border bg-white p-4 shadow-sm">
                  <h2 className="mb-3 font-black">Inventario activo</h2>
                  <select value={selectedSessionId} onChange={event => setSelectedSessionId(event.target.value)} className="w-full rounded-xl border bg-white px-3 py-3 text-sm">
                    <option value="">Selecciona inventario</option>
                    {sessions.map(session => (
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

                <section className="space-y-2 rounded-2xl border bg-white p-4 shadow-sm">
                  <h2 className="font-black">Acciones de sesión</h2>
                  <button onClick={freezeStock} disabled={loading || !selectedSessionId} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-700 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                    <FileLock2 size={16} /> Congelar stock
                  </button>
                  <button onClick={finishSession} disabled={!selectedSessionId} className="w-full rounded-xl bg-green-700 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                    Finalizar inventario
                  </button>
                  {user?.role === "Administrador" && (
                    <button onClick={deleteSession} disabled={!selectedSessionId} className="w-full rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm font-black text-red-700 disabled:opacity-40">
                      Eliminar sesion
                    </button>
                  )}
                </section>
              </div>

              <section className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-black">Preparación</h2>
                    <p className="text-xs text-slate-500">Carga ubicaciones autorizadas y productos no inventariables para esta sesión.</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 px-4 py-2 text-xs font-bold text-slate-600">
                    Ubicaciones: {locations.length} | Pendientes: {pendingLocations.length}
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-2xl border bg-slate-50 p-4">
                    <label className="text-xs font-bold text-slate-500">Control de tickets / ubicaciones</label>
                    <input
                      ref={locationsFileRef}
                      type="file"
                      accept=".xlsx,.xls"
                      className="hidden"
                      onChange={event => setLocationsFile(event.target.files?.[0] || null)}
                    />
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <button onClick={() => locationsFileRef.current?.click()} className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl border bg-white px-4 py-3 text-sm font-black">
                        <FolderOpen size={16} /> {locationsFile ? locationsFile.name : "Seleccionar Excel"}
                      </button>
                      <button onClick={importLocations} disabled={!locationsFile || !selectedSessionId} className="min-h-14 rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                        Subir ubicaciones
                      </button>
                    </div>
                  </div>

                  <div className="rounded-2xl border bg-slate-50 p-4">
                    <label className="text-xs font-bold text-slate-500">No inventariables / no considerar</label>
                    <input
                      ref={nonInventoryFileRef}
                      type="file"
                      accept=".xlsx,.xls"
                      className="hidden"
                      onChange={event => setNonInventoryFile(event.target.files?.[0] || null)}
                    />
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <button onClick={() => nonInventoryFileRef.current?.click()} className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl border bg-white px-4 py-3 text-sm font-black">
                        <FolderOpen size={16} /> {nonInventoryFile ? nonInventoryFile.name : "Seleccionar Excel"}
                      </button>
                      <button onClick={importNonInventory} disabled={!nonInventoryFile || !selectedSessionId} className="min-h-14 rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                        Subir no inventariables
                      </button>
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border bg-slate-50 p-4 text-sm">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-black text-slate-900">Ubicaciones pendientes</div>
                      <div className="text-xs text-slate-500">Ubicaciones cargadas que todavía no tienen registros.</div>
                    </div>
                    <div className="text-xs font-black text-slate-600">{pendingLocations.length} pendientes</div>
                  </div>
                  <div className="max-h-[420px] overflow-auto rounded-xl border bg-white">
                    {pendingLocations.length > 0 ? pendingLocations.map(location => (
                      <div key={location.id} className="grid gap-2 border-b p-3 last:border-b-0 md:grid-cols-[140px_1fr]">
                        <div className="font-black text-slate-900">{location.location_code}</div>
                        <div className="min-w-0 text-slate-600">
                          <div className="truncate">{location.full_location || location.description || "Sin descripción"}</div>
                          {(location.zone || location.lineal || location.zone_ref) && (
                            <div className="mt-1 text-xs text-slate-400">
                              {[location.zone, location.lineal, location.zone_ref].filter(Boolean).join(" | ")}
                            </div>
                          )}
                        </div>
                      </div>
                    )) : (
                      <div className="p-8 text-center text-sm text-slate-400">Sin ubicaciones pendientes.</div>
                    )}
                  </div>
                </div>
              </section>
            </section>
          )}

          {operator && !isValidator && operatorMode === "conteo" && (
            <section className="min-w-0 overflow-hidden rounded-2xl border bg-white p-3 shadow-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <h2 className="font-black">Conteo por ubicación</h2>
                  <p className="text-xs text-slate-500">{operator.full_name}{selectedSession ? ` · ${selectedSession.name}` : ""}</p>
                </div>
                {editingCountId && <button onClick={() => { setEditingCountId(null); setProductCode(""); setQuantity(""); }} className="rounded-xl border px-3 py-2 text-xs font-black">Cancelar edición</button>}
              </div>
              <div className="space-y-2">
                {selectedSession ? (
                  <div className="rounded-xl border bg-slate-50 px-3 py-3 text-sm font-black text-slate-800">
                    {selectedSession.name} - {selectedSession.store_name || selectedSession.store_id}
                  </div>
                ) : (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm font-bold text-amber-700">
                    No tienes inventario activo seleccionado. Cierra sesion e ingresa nuevamente.
                  </div>
                )}
                <div className="flex w-full min-w-0 rounded-xl border bg-white p-1 focus-within:ring-2 focus-within:ring-green-200">
                  <input value={locationCode} onChange={event => setLocationCode(event.target.value.toUpperCase())} placeholder="Ubicación / ticket" autoFocus className="min-w-0 flex-1 rounded-lg px-3 py-3 text-base font-black outline-none" />
                  <button onClick={() => openScanner("location")} className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-green-700 text-white transition active:scale-95 active:bg-green-800" title="Escanear ubicación">
                    <QrCode size={22} />
                  </button>
                </div>
                <div className="flex w-full min-w-0 rounded-xl border bg-white p-1 focus-within:ring-2 focus-within:ring-blue-200">
                  <input ref={productInputRef} value={productCode} onChange={event => setProductCode(event.target.value)} placeholder="Código o barra del producto" className="min-w-0 flex-1 rounded-lg px-3 py-3 text-base outline-none" />
                  <button onClick={() => openScanner("product")} className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-slate-900 text-white transition active:scale-95 active:bg-slate-700" title="Escanear producto">
                    <QrCode size={22} />
                  </button>
                </div>
                {(productLookupMessage || productCandidates.length > 0) && (
                  <div className="space-y-2">
                    {productLookupMessage && <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">{productLookupMessage}</div>}
                    {productCandidates.map(product => (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => { setSelectedProduct(product); setProductCode(product.sku); setProductLookupMessage(""); setTimeout(() => qtyInputRef.current?.focus(), 50); }}
                        className={`w-full rounded-xl border p-3 text-left transition active:scale-[0.99] ${selectedProduct?.id === product.id ? "border-green-600 bg-green-50" : "bg-white hover:border-slate-400"}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-black text-slate-950">{product.sku}</div>
                            <div className="line-clamp-2 text-sm font-semibold text-slate-700">{product.description}</div>
                            <div className="mt-1 text-xs text-slate-500">UM: {product.unit || "N/D"} · Costo: {money(Number(product.cost || 0))}</div>
                          </div>
                          <span className={`shrink-0 rounded-lg px-2 py-1 text-[11px] font-black ${selectedProduct?.id === product.id ? "bg-green-700 text-white" : "bg-slate-100 text-slate-600"}`}>
                            {selectedProduct?.id === product.id ? "Elegido" : "Elegir"}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_3.25rem] gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <input ref={qtyInputRef} value={quantity} onChange={event => setQuantity(event.target.value)} placeholder="Cantidad" inputMode="decimal" className="min-w-0 rounded-xl border px-3 py-3 text-base font-bold" />
                  <button onClick={saveCount} disabled={savingCount || !selectedSession || !canOperatorEnter(selectedSession.status)} className="inline-flex min-w-0 items-center justify-center gap-2 rounded-xl bg-slate-900 px-0 py-3 text-sm font-black text-white transition active:scale-95 active:bg-slate-700 disabled:opacity-40 disabled:active:scale-100 sm:min-w-28 sm:px-4">
                  <Save size={16} /> <span className="hidden sm:inline">{savingCount ? "Guardando..." : "Guardar"}</span>
                  </button>
                </div>
              </div>
            </section>
          )}

          {operator && !isValidator && operatorMode === "conteo" && (
            <section className="min-w-0 overflow-hidden rounded-2xl border bg-white shadow-sm">
              <div className="border-b p-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="inline-flex items-center gap-2 font-black"><ClipboardList size={18} /> Registros</h2>
                  <div className="text-xs font-bold text-slate-500">{filteredCounts.length}</div>
                </div>
                <div className="mt-2 flex items-center rounded-xl border px-3 py-2">
                  <Search size={16} className="shrink-0 text-slate-400" />
                  <input value={recordsQuery} onChange={event => setRecordsQuery(event.target.value)} placeholder="Buscar código o ubicación" className="min-w-0 flex-1 px-2 text-sm outline-none" />
                </div>
              </div>
              <div className="divide-y">
                {filteredCounts.slice(0, 40).map(row => (
                  <div key={row.id} className="p-3">
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-black text-slate-900">{row.location_code}</span>
                          <span className="font-black text-blue-700">{row.sku}</span>
                        </div>
                        <div className="max-w-full truncate text-sm text-slate-600">{row.description}</div>
                        <div className="mt-1 text-xs text-slate-400">{new Date(row.counted_at).toLocaleString("es-PE")} · {row.unit}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-xl font-black text-slate-950">{number2(row.quantity)}</div>
                        {operator.id === row.operator_id && (
                          <button onClick={() => editCount(row)} className="mt-1 rounded-lg border px-2 py-1 text-xs font-black">Editar</button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {filteredCounts.length === 0 && <div className="p-8 text-center text-sm text-slate-400">Sin registros.</div>}
              </div>
            </section>
          )}

          {operator && !isValidator && operatorMode === "reconteo" && (
            <section className="min-w-0 overflow-hidden rounded-2xl border bg-white p-4 shadow-sm">
              <div className="mb-3">
                <h2 className="font-black">Mis reconteos asignados</h2>
                <p className="text-xs text-slate-500">{operator.full_name}{selectedSession ? ` · ${selectedSession.name}` : ""}</p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {recountItems.map(row => {
                  const draft = recountDraftFor(row);
                  const relatedSurplusRows = row.recount_type === "surplus"
                    ? operatorRecountContextItems.filter(item => item.product_id === row.product_id)
                    : [];
                  return (
                  <article key={row.id} className="rounded-2xl border bg-slate-50 p-4">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-black text-slate-950">{row.sku}</div>
                        <div className="line-clamp-2 text-sm font-semibold text-slate-700">{row.description}</div>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-black ${row.recount_type === "missing" ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-700"}`}>
                        {row.recount_type === "missing" ? "Faltante" : "Sobrante"}
                      </span>
                    </div>
                    <div className="space-y-2 text-xs text-slate-600">
                      <div className="rounded-xl border bg-white p-3">
                        <div className="font-black text-slate-900">{row.location_code || "Sin ubicación"}</div>
                        <div className="truncate">{row.full_location || "Reconteo por código"}</div>
                        {(row.zone || row.lineal || row.zone_ref) && <div className="mt-1 text-slate-400">{[row.zone, row.lineal, row.zone_ref].filter(Boolean).join(" | ")}</div>}
                      </div>
                      {row.recount_type === "surplus" && relatedSurplusRows.length > 1 && (
                        <div className="rounded-xl border bg-white p-3">
                          <div className="mb-2 font-black text-slate-900">Registros del mismo codigo</div>
                          <div className="space-y-2">
                            {relatedSurplusRows.map(item => (
                              <div key={item.id} className={`rounded-lg border px-3 py-2 ${item.id === row.id ? "border-blue-600 bg-blue-50" : "bg-slate-50 opacity-75"}`}>
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-black">{item.location_code || "Sin ubicacion"}</span>
                                  <span className={item.id === row.id ? "font-black text-blue-700" : "font-bold text-slate-400"}>
                                    {item.id === row.id ? "Asignado" : "Referencia"}
                                  </span>
                                </div>
                                <div className="truncate text-slate-500">{item.full_location || "Reconteo por codigo"}</div>
                                <div className="mt-1 grid grid-cols-3 gap-1 text-center">
                                  <MiniMetric label="Sistema" value={item.system_stock} />
                                  <MiniMetric label="Contado" value={item.counted_qty} />
                                  <MiniMetric label="Dif." value={item.diff_qty} />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="grid grid-cols-3 gap-2">
                        <MiniMetric label="Sistema" value={row.system_stock} />
                        <MiniMetric label="Contado" value={row.counted_qty} />
                        <MiniMetric label="Dif." value={row.diff_qty} />
                      </div>
                      <div className="grid gap-2">
                        <div>
                          <label className="mb-1 block text-[11px] font-black text-slate-500">{row.recount_type === "missing" && !row.location_code ? "Ubicacion final del faltante" : "Ubicacion asignada"}</label>
                          <div className="flex rounded-xl border bg-white p-1">
                            <input value={draft.locationCode} onChange={event => updateRecountDraft(row.id, "locationCode", event.target.value.toUpperCase())} placeholder="Ubicacion / ticket final" className="min-w-0 flex-1 rounded-lg px-3 py-2 text-sm font-bold outline-none" />
                            <button onClick={() => openRecountScanner(row.id, "recount_location")} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-slate-900 text-white transition active:scale-95" title="Escanear ubicacion">
                              <QrCode size={18} />
                            </button>
                          </div>
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] font-black text-slate-500">Codigo final</label>
                          <div className="flex rounded-xl border bg-white p-1">
                            <input value={draft.productCode} onChange={event => updateRecountDraft(row.id, "productCode", event.target.value)} placeholder="Codigo final" className="min-w-0 flex-1 rounded-lg px-3 py-2 text-sm font-bold outline-none" />
                            <button onClick={() => openRecountScanner(row.id, "recount_product")} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-slate-900 text-white transition active:scale-95" title="Escanear producto">
                              <QrCode size={18} />
                            </button>
                          </div>
                        </div>
                        <div className="grid grid-cols-[1fr_auto] gap-2">
                          <input value={draft.quantity} onChange={event => updateRecountDraft(row.id, "quantity", event.target.value)} placeholder="Cantidad final" inputMode="decimal" className="min-w-0 rounded-xl border bg-white px-3 py-3 text-sm font-bold outline-none" />
                          <button onClick={() => saveRecountValidation(row)} disabled={savingRecountId === row.id} className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                            {savingRecountId === row.id ? "Guardando" : "Guardar"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>
                  );
                })}
                {recountItems.length === 0 && (
                  <div className="rounded-2xl border bg-slate-50 p-8 text-center text-sm font-bold text-slate-400 md:col-span-2">
                    No tienes códigos asignados para reconteo en este inventario.
                  </div>
                )}
              </div>
            </section>
          )}

          {isValidator && selectedSessionId && validatorTab === "reconteo" && (
            <section className="space-y-4">
              <section className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="inline-flex items-center gap-2 font-black"><UserCheck size={18} /> Reconteo</h2>
                    <p className="text-xs text-slate-500">Asigna diferencias por bloques a operadores activos.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => assignRecountBlock(20)} className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white">
                      Asignar 20 primeros
                    </button>
                    <button onClick={() => assignRecountBlock()} className="rounded-xl border px-4 py-3 text-sm font-black text-slate-800">
                      Asignar todos
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 lg:grid-cols-[180px_1fr_1fr_220px]">
                  <div className="grid grid-cols-2 overflow-hidden rounded-xl border p-1">
                    <button onClick={() => setRecountType("surplus")} className={`rounded-lg px-3 py-2 text-xs font-black ${recountType === "surplus" ? "bg-blue-700 text-white" : "text-slate-600"}`}>Sobrantes</button>
                    <button onClick={() => setRecountType("missing")} className={`rounded-lg px-3 py-2 text-xs font-black ${recountType === "missing" ? "bg-red-600 text-white" : "text-slate-600"}`}>Faltantes</button>
                  </div>

                  <div className="grid gap-2">
                    <select value={recountValue} onChange={event => setRecountValue(event.target.value)} disabled={recountType === "missing"} className="rounded-xl border bg-white px-3 py-3 text-sm disabled:opacity-40">
                      <option value="">Selecciona zona</option>
                      {recountValues.map(value => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </div>

                  <select value={recountOperatorId} onChange={event => setRecountOperatorId(event.target.value)} className="rounded-xl border bg-white px-3 py-3 text-sm">
                    <option value="">Operador</option>
                    {sessionOperators.map(row => <option key={row.id} value={row.id}>{row.full_name}</option>)}
                  </select>

                  <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm font-black text-slate-700">
                    {unassignedRecountCandidates.length} pendientes | {recountItems.length} asignados
                  </div>
                </div>
                <p className="mt-3 text-xs font-bold text-slate-500">Orden operativo: ticket primero, luego mayor diferencia valorizada.</p>
              </section>

              <section className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-black">Lineas pendientes por asignar</h3>
                  <div className="text-xs font-bold text-slate-500">Ordenado por ticket y luego Dif. val.</div>
                </div>
                <div className="overflow-auto rounded-xl border">
                  <table className="w-full min-w-[1100px] text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="p-2 text-left">Tipo</th>
                        <th className="p-2 text-left">Ticket</th>
                        <th className="p-2 text-left">Ubicacion</th>
                        <th className="p-2 text-left">Zona</th>
                        <th className="p-2 text-left">Codigo</th>
                        <th className="p-2 text-left">Descripcion</th>
                        <th className="p-2 text-center">UM</th>
                        <th className="p-2 text-center">Sistema</th>
                        <th className="p-2 text-center">Contado</th>
                        <th className="p-2 text-center">Dif.</th>
                        <th className="p-2 text-center">Costo</th>
                        <th className="p-2 text-center">Dif. val.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unassignedRecountCandidates.map(row => (
                        <tr key={recountKey(row)} className="border-t">
                          <td className="p-2 font-black">
                            <span className={row.recount_type === "missing" ? "text-red-600" : "text-blue-700"}>
                              {row.recount_type === "missing" ? "Faltante" : "Sobrante"}
                            </span>
                          </td>
                          <td className="p-2 font-black">{row.ticket || "-"}</td>
                          <td className="p-2">{row.location_code || "Por codigo"}</td>
                          <td className="p-2">{row.zone || "-"}</td>
                          <td className="p-2 font-black text-slate-950">{row.sku}</td>
                          <td className="max-w-sm truncate p-2 text-slate-700">{row.description}</td>
                          <td className="p-2 text-center">{row.unit}</td>
                          <td className="p-2 text-center font-bold">{number2(row.system_stock)}</td>
                          <td className="p-2 text-center font-bold">{number2(row.counted_qty)}</td>
                          <td className="p-2 text-center font-black">{number2(row.diff_qty)}</td>
                          <td className="p-2 text-center">{money(row.cost_snapshot)}</td>
                          <td className="p-2 text-center font-black">{money(row.value_diff)}</td>
                        </tr>
                      ))}
                      {unassignedRecountCandidates.length === 0 && (
                        <tr>
                          <td colSpan={12} className="p-8 text-center text-sm text-slate-400">
                            No hay lineas pendientes para asignar con el filtro actual.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-black">Lineas asignadas / reasignar</h3>
                  <div className="flex min-w-[240px] flex-1 items-center rounded-xl border px-3 py-2 md:max-w-md">
                    <Search size={16} className="shrink-0 text-slate-400" />
                    <input
                      value={recountAssignedQuery}
                      onChange={event => setRecountAssignedQuery(event.target.value)}
                      placeholder="Buscar codigo, descripcion o ubicacion"
                      className="min-w-0 flex-1 px-2 text-sm outline-none"
                    />
                  </div>
                </div>
                <div className="overflow-auto rounded-xl border">
                  <table className="w-full min-w-[1320px] text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <SortHeader label="Estado" active={recountAssignedSort.key === "status"} direction={recountAssignedSort.direction} onClick={() => toggleRecountAssignedSort("status")} align="left" />
                        <SortHeader label="Tipo" active={recountAssignedSort.key === "recount_type"} direction={recountAssignedSort.direction} onClick={() => toggleRecountAssignedSort("recount_type")} align="left" />
                        <SortHeader label="Ticket" active={recountAssignedSort.key === "ticket"} direction={recountAssignedSort.direction} onClick={() => toggleRecountAssignedSort("ticket")} align="left" />
                        <SortHeader label="Ubicacion" active={recountAssignedSort.key === "location_code"} direction={recountAssignedSort.direction} onClick={() => toggleRecountAssignedSort("location_code")} align="left" />
                        <SortHeader label="Codigo" active={recountAssignedSort.key === "sku"} direction={recountAssignedSort.direction} onClick={() => toggleRecountAssignedSort("sku")} align="left" />
                        <SortHeader label="Descripcion" active={recountAssignedSort.key === "description"} direction={recountAssignedSort.direction} onClick={() => toggleRecountAssignedSort("description")} align="left" />
                        <SortHeader label="Sistema" active={recountAssignedSort.key === "system_stock"} direction={recountAssignedSort.direction} onClick={() => toggleRecountAssignedSort("system_stock")} />
                        <SortHeader label="Contado" active={recountAssignedSort.key === "counted_qty"} direction={recountAssignedSort.direction} onClick={() => toggleRecountAssignedSort("counted_qty")} />
                        <SortHeader label="Dif." active={recountAssignedSort.key === "diff_qty"} direction={recountAssignedSort.direction} onClick={() => toggleRecountAssignedSort("diff_qty")} />
                        <SortHeader label="Dif. val." active={recountAssignedSort.key === "value_diff"} direction={recountAssignedSort.direction} onClick={() => toggleRecountAssignedSort("value_diff")} />
                        <SortHeader label="Asignado actual" active={recountAssignedSort.key === "assigned_operator_name"} direction={recountAssignedSort.direction} onClick={() => toggleRecountAssignedSort("assigned_operator_name")} align="left" />
                        <th className="p-2 text-left">Nuevo operador</th>
                        <th className="p-2 text-center">Accion</th>
                      </tr>
                    </thead>
                    <tbody>
                      {assignedRecountRows.map(row => (
                        <tr key={row.id} className="border-t">
                          <td className="p-2 font-black">{row.status === "counted" ? "Contado" : "Asignado"}</td>
                          <td className="p-2 font-black">
                            <span className={row.recount_type === "missing" ? "text-red-600" : "text-blue-700"}>
                              {row.recount_type === "missing" ? "Faltante" : "Sobrante"}
                            </span>
                          </td>
                          <td className="p-2 font-black">{row.ticket || "-"}</td>
                          <td className="p-2">{row.location_code || "Por codigo"}</td>
                          <td className="p-2 font-black text-slate-950">{row.sku}</td>
                          <td className="max-w-sm truncate p-2 text-slate-700">{row.description}</td>
                          <td className="p-2 text-center font-bold">{number2(row.system_stock)}</td>
                          <td className="p-2 text-center font-bold">{number2(row.counted_qty)}</td>
                          <td className="p-2 text-center font-black">{number2(row.diff_qty)}</td>
                          <td className="p-2 text-center font-black">{money(row.value_diff)}</td>
                          <td className="p-2">{row.assigned_operator_name || "-"}</td>
                          <td className="p-2">
                            <select
                              value={reassignOperatorDrafts[row.id] || row.assigned_operator_id || ""}
                              onChange={event => setReassignOperatorDrafts(prev => ({ ...prev, [row.id]: event.target.value }))}
                              disabled={row.status === "counted"}
                              className="w-full min-w-[220px] rounded-xl border bg-white px-3 py-2 text-xs disabled:opacity-40"
                            >
                              <option value="">Selecciona operador</option>
                              {sessionOperators.map(operatorRow => (
                                <option key={operatorRow.id} value={operatorRow.id}>
                                  {operatorRow.full_name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="p-2 text-center">
                            <div className="flex justify-center gap-2">
                              <button
                                onClick={() => reassignRecountItem(row)}
                                disabled={row.status === "counted"}
                                className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-black text-white disabled:opacity-40"
                              >
                                Reasignar
                              </button>
                              <button
                                onClick={() => unassignRecountItem(row)}
                                disabled={row.status === "counted"}
                                className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-black text-amber-700 disabled:opacity-40"
                              >
                                Quitar
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {assignedRecountRows.length === 0 && (
                        <tr>
                          <td colSpan={13} className="p-8 text-center text-sm text-slate-400">
                            No hay reconteos asignados con ese filtro.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="hidden rounded-2xl border bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-black">Cards de reconteo</h3>
                  <div className="text-xs font-bold text-slate-500">{recountItems.length} asignados</div>
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {(recountItems.length > 0 ? recountItems : selectedRecountCandidates).map((row: any) => (
                    <article key={`${row.product_id}-${row.location_code || row.recount_type}`} className="rounded-2xl border bg-slate-50 p-4">
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-black text-slate-950">{row.sku}</div>
                          <div className="line-clamp-2 text-sm font-semibold text-slate-700">{row.description}</div>
                        </div>
                        <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-black ${row.recount_type === "missing" ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-700"}`}>
                          {row.recount_type === "missing" ? "Faltante" : "Sobrante"}
                        </span>
                      </div>

                      <div className="space-y-2 text-xs text-slate-600">
                        <div className="rounded-xl border bg-white p-3">
                          <div className="font-black text-slate-900">{row.location_code || "Sin ubicación"}</div>
                          <div className="truncate">{row.full_location || "Reconteo por código"}</div>
                          {(row.zone || row.lineal || row.zone_ref) && <div className="mt-1 text-slate-400">{[row.zone, row.lineal, row.zone_ref].filter(Boolean).join(" | ")}</div>}
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <MiniMetric label="Sistema" value={row.system_stock} />
                          <MiniMetric label="Contado" value={row.counted_qty} />
                          <MiniMetric label="Dif." value={row.diff_qty} />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <MiniMetric label="Costo" value={money(row.cost_snapshot)} />
                          <MiniMetric label="Dif. val." value={money(row.value_diff)} />
                        </div>
                        <div className="rounded-xl bg-white p-3 font-bold">
                          Asignado: {row.assigned_operator_name || sessionOperators.find(op => op.id === row.assigned_operator_id)?.full_name || "Sin asignar"}
                        </div>
                      </div>
                    </article>
                  ))}
                  {(recountItems.length === 0 && selectedRecountCandidates.length === 0) && (
                    <div className="rounded-2xl border bg-slate-50 p-8 text-center text-sm text-slate-400 md:col-span-2 xl:col-span-3">
                      No hay diferencias para reconteo con el filtro actual.
                    </div>
                  )}
                </div>
              </section>
            </section>
          )}

          {isValidator && user?.role === "Administrador" && validatorTab === "usuarios" && (
            <section className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="inline-flex items-center gap-2 font-black"><UserCheck size={18} /> Usuarios de inventario</h2>
                  <p className="text-xs text-slate-500">Edita nombre, celular y clave usados solo en inventarios generales.</p>
                </div>
                <button onClick={() => loadInventoryOperators()} className="rounded-xl border px-4 py-2 text-sm font-black text-slate-700 hover:bg-slate-50">
                  Actualizar
                </button>
              </div>
              <div className="overflow-auto rounded-xl border">
                <table className="w-full min-w-[980px] text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-600">
                    <tr>
                      <th className="p-2 text-left">Nombre</th>
                      <th className="p-2 text-left">Celular</th>
                      <th className="p-2 text-left">Clave</th>
                      <th className="p-2 text-center">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inventoryOperators.map(row => {
                      const draft = inventoryOperatorDrafts[row.id] || { full_name: row.full_name || "", phone: row.phone || "", password: row.password || "" };
                      return (
                        <tr key={row.id} className="border-t">
                          <td className="p-2">
                            <input
                              value={draft.full_name}
                              onChange={event => updateInventoryOperatorDraft(row.id, "full_name", event.target.value)}
                              className="w-full rounded-xl border px-3 py-2 text-sm"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              value={draft.phone}
                              onChange={event => updateInventoryOperatorDraft(row.id, "phone", event.target.value)}
                              inputMode="numeric"
                              className="w-full rounded-xl border px-3 py-2 text-sm"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              value={draft.password}
                              onChange={event => updateInventoryOperatorDraft(row.id, "password", event.target.value)}
                              className="w-full rounded-xl border px-3 py-2 text-sm"
                            />
                          </td>
                          <td className="p-2 text-center">
                            <div className="flex justify-center gap-2">
                              <button
                                onClick={() => saveInventoryOperator(row.id)}
                                disabled={savingInventoryOperatorId === row.id}
                                className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-black text-white disabled:opacity-40"
                              >
                                {savingInventoryOperatorId === row.id ? "Guardando" : "Guardar"}
                              </button>
                              <button
                                onClick={() => deleteInventoryOperator(row.id)}
                                className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs font-black text-red-700"
                              >
                                Eliminar
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {inventoryOperators.length === 0 && (
                      <tr>
                        <td colSpan={4} className="p-8 text-center text-sm text-slate-400">
                          No hay usuarios registrados en inventarios generales.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
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
                <Kpi label="Valor sistema" value={money(kpis.systemValue)} />
                <Kpi label="Stock sistema" value={kpis.totalSystemUnits} />
                <Kpi label="Productos con stock" value={kpis.productsWithStock} />
                <Kpi label="Códigos sobrantes" value={kpis.surplusCodes} tone="blue" />
                <Kpi label="Códigos faltantes" value={kpis.missingCodes} tone="red" />
                <Kpi label="No contados" value={kpis.notCountedCodes} tone="amber" />
                <Kpi label="Contados / total" value={`${kpis.countedCodes} / ${kpis.totalCodes}`} />
                <Kpi label="Avance valorizado" value={`${kpis.valueProgress}%`} />
              </div>
            </section>
          )}

          {((!isValidator && !operator) || !selectedSessionId || (isValidator && validatorTab === "registros")) && (
          <div className="space-y-4">
          {isValidator && selectedSessionId && validatorTab === "registros" && (
            <section className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-black">Productividad de contadores</h2>
                  <p className="text-xs text-slate-500">Registros por minuto calculado desde el primer al ultimo registro de cada contador.</p>
                </div>
                <div className="text-xs font-black text-slate-500">{counts.length} registros</div>
              </div>
              <div className="space-y-3">
                {counterStats.rows.map(row => (
                  <div key={row.id} className="grid gap-2 md:grid-cols-[220px_1fr_160px] md:items-center">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-black text-slate-900">{row.name}</div>
                      <div className="text-xs text-slate-500">{row.count} registros</div>
                    </div>
                    <div className="h-4 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-blue-700"
                        style={{ width: `${Math.max(4, Math.round((row.perMinute / counterStats.maxPerMinute) * 100))}%` }}
                      />
                    </div>
                    <div className="text-sm font-black text-slate-900">{row.perMinute.toFixed(2)} reg/min</div>
                  </div>
                ))}
                {counterStats.rows.length === 0 && <div className="rounded-xl bg-slate-50 p-6 text-center text-sm text-slate-400">Sin registros para graficar.</div>}
              </div>
            </section>
          )}
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
            <div className="overflow-auto">
              <table className="w-full min-w-[1100px] text-sm">
                <thead className="bg-slate-100 text-xs text-slate-600">
                  <tr>
                    <SortHeader label="Fecha" active={recordsSort.key === "counted_at"} direction={recordsSort.direction} onClick={() => toggleRecordsSort("counted_at")} />
                    <SortHeader label="Contador" active={recordsSort.key === "operator_name"} direction={recordsSort.direction} onClick={() => toggleRecordsSort("operator_name")} align="left" />
                    <SortHeader label="Ubicacion" active={recordsSort.key === "location_code"} direction={recordsSort.direction} onClick={() => toggleRecordsSort("location_code")} />
                    <SortHeader label="Codigo" active={recordsSort.key === "sku"} direction={recordsSort.direction} onClick={() => toggleRecordsSort("sku")} />
                    <SortHeader label="Descripcion" active={recordsSort.key === "description"} direction={recordsSort.direction} onClick={() => toggleRecordsSort("description")} align="left" />
                    <SortHeader label="UM" active={recordsSort.key === "unit"} direction={recordsSort.direction} onClick={() => toggleRecordsSort("unit")} />
                    <SortHeader label="Cantidad" active={recordsSort.key === "quantity"} direction={recordsSort.direction} onClick={() => toggleRecordsSort("quantity")} />
                    <SortHeader label="Costo" active={recordsSort.key === "cost_snapshot"} direction={recordsSort.direction} onClick={() => toggleRecordsSort("cost_snapshot")} />
                    <SortHeader label="Valor" active={recordsSort.key === "value"} direction={recordsSort.direction} onClick={() => toggleRecordsSort("value")} />
                    <th className="p-2 text-center">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCounts.map(row => (
                    <tr key={row.id} className="border-b">
                      <td className="p-2 text-center text-xs text-slate-500">{new Date(row.counted_at).toLocaleString("es-PE")}</td>
                      <td className="max-w-[180px] truncate p-2 font-bold text-slate-700">{row.operator_name || "Sin usuario"}</td>
                      <td className="p-2 text-center font-black text-slate-800">{row.location_code}</td>
                      <td className="p-2 text-center font-black text-blue-700">{row.sku}</td>
                      <td className="max-w-md truncate p-2 text-slate-700">{row.description}</td>
                      <td className="p-2 text-center">{row.unit}</td>
                      <td className="p-2 text-center font-black">{number2(row.quantity)}</td>
                      <td className="p-2 text-center">{money(row.cost_snapshot)}</td>
                      <td className="p-2 text-center font-black">{money(Number(row.quantity || 0) * Number(row.cost_snapshot || 0))}</td>
                      <td className="p-2 text-center">
                        {(operator?.id === row.operator_id || isValidator) && (
                          <div className="flex justify-center gap-1">
                            {operator?.id === row.operator_id && (
                              <button onClick={() => editCount(row)} className="rounded-lg border px-2 py-1 text-xs font-black">Editar</button>
                            )}
                            {isValidator && (
                              <button onClick={() => deleteCount(row)} className="rounded-lg border px-2 py-1 text-red-600"><Trash2 size={14} /></button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                  {filteredCounts.length === 0 && (
                    <tr><td colSpan={10} className="p-8 text-center text-sm text-slate-400">Sin registros.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
          </div>
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
                <table className="w-full min-w-[1120px] text-sm">
                  <thead className="bg-slate-100 text-xs text-slate-600">
                    <tr>
                      <SortHeader label="Código" active={summarySort.key === "sku"} direction={summarySort.direction} onClick={() => toggleSummarySort("sku")} align="left" />
                      <SortHeader label="Descripción" active={summarySort.key === "description"} direction={summarySort.direction} onClick={() => toggleSummarySort("description")} align="left" />
                      <SortHeader label="UM" active={summarySort.key === "unit"} direction={summarySort.direction} onClick={() => toggleSummarySort("unit")} />
                      <SortHeader label="Sistema" active={summarySort.key === "system_stock"} direction={summarySort.direction} onClick={() => toggleSummarySort("system_stock")} />
                      <SortHeader label="Contado" active={summarySort.key === "counted"} direction={summarySort.direction} onClick={() => toggleSummarySort("counted")} />
                      <SortHeader label="Dif." active={summarySort.key === "diff"} direction={summarySort.direction} onClick={() => toggleSummarySort("diff")} />
                      <SortHeader label="Costo" active={summarySort.key === "cost"} direction={summarySort.direction} onClick={() => toggleSummarySort("cost")} />
                      <SortHeader label="Dif. Val." active={summarySort.key === "valueDiff"} direction={summarySort.direction} onClick={() => toggleSummarySort("valueDiff")} />
                      <SortHeader label="Observación" active={summarySort.key === "observation"} direction={summarySort.direction} onClick={() => toggleSummarySort("observation")} align="left" />
                      <th className="p-2">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSummary.map(row => (
                      <tr key={row.product_id} className="border-b">
                        <td className="p-2 font-black">{row.sku}</td>
                        <td className="max-w-sm truncate p-2">{row.description}</td>
                        <td className="p-2 text-center">{row.unit}</td>
                        <td className="p-2 text-center">{number2(row.system_stock)}</td>
                        <td className="p-2 text-center font-black">{number2(row.counted)}</td>
                        <td className={`p-2 text-center font-black ${row.diff < 0 ? "text-red-600" : row.diff > 0 ? "text-blue-700" : "text-green-700"}`}>{number2(row.diff)}</td>
                        <td className="p-2 text-center">{money(row.cost)}</td>
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

      {scannerTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h3 className="font-black">{scannerTarget === "product" ? "Escanear producto" : "Escanear ubicación"}</h3>
                <p className="text-xs text-slate-500">Apunta al código con la cámara.</p>
              </div>
              <button onClick={toggleTorch} className={`rounded-lg border px-3 py-2 text-sm font-black ${torchOn ? "bg-yellow-400 text-slate-900" : "bg-slate-900 text-white"}`} title="Linterna">
                <Flashlight className="mr-2 inline" size={18} /> Linterna
              </button>
            </div>
            <div className="overflow-hidden rounded-xl bg-black">
              <div id={scannerContainerId} className="min-h-[280px] w-full" />
            </div>
            <button onClick={() => stopScanner()} className="mt-3 w-full rounded-xl border px-4 py-3 text-sm font-black text-slate-700">
              Cerrar cámara
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function SortHeader({ label, active, direction, onClick, align = "center" }: { label: string; active: boolean; direction: SortDirection; onClick: () => void; align?: "left" | "center" }) {
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

function MiniMetric({ label, value }: { label: string; value: string | number }) {
  const displayValue = typeof value === "number" ? number2(value) : value;
  return (
    <div className="rounded-xl bg-white p-2 text-center">
      <div className="text-sm font-black text-slate-950">{displayValue}</div>
      <div className="text-[11px] font-bold text-slate-500">{label}</div>
    </div>
  );
}

function Kpi({ label, value, tone = "slate" }: { label: string; value: string | number; tone?: "slate" | "blue" | "red" | "amber" }) {
  const color = tone === "blue" ? "text-blue-700" : tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : "text-slate-900";
  const displayValue = typeof value === "number" ? number2(value) : value;
  return (
    <div className="rounded-xl border bg-slate-50 p-3 text-center">
      <div className={`text-xl font-black ${color}`}>{displayValue}</div>
      <div className="mt-1 text-xs font-bold text-slate-500">{label}</div>
    </div>
  );
}
