"use client";

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ClipboardList, Download, FileLock2, Flashlight, FolderOpen, LogIn, LogOut, PackageSearch, Plus, QrCode, RefreshCw, Save, Search, ShieldCheck, Trash2, UserCheck } from "lucide-react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase/client";
import { createClientUuid, getOrCreateDeviceId } from "@/lib/offline/clientIdentity";
import { findCachedProductsByCode } from "@/lib/offline/catalogCache";
import { enqueueOfflineItem, getOfflineItem, listPendingOfflineItems } from "@/lib/offline/pendingQueue";

type Role = "Operario" | "Validador" | "Supervisor" | "Administrador";
type SessionStatus = "planned" | "open" | "frozen" | "finished" | "cancelled";
type ValidatorTab = "preparacion" | "registros" | "reconteo" | "resumen" | "usuarios";
type OperatorMode = "conteo" | "reconteo";
type RecountManagerTab = "pendientes" | "asignados" | "registros";
type SortDirection = "asc" | "desc";
type RecordsSortKey = "counted_at" | "operator_name" | "location_code" | "sku" | "description" | "unit" | "quantity" | "cost_snapshot" | "value";
type SummarySortKey = "sku" | "description" | "unit" | "system_stock" | "counted" | "counted_original" | "recounted_qty" | "diff" | "cost" | "valueDiff" | "observation";
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
  finished_at?: string | null;
  created_at?: string | null;
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
  is_empty?: boolean | null;
  empty_marked_by?: string | null;
  empty_marked_at?: string | null;
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

type StockGeneralRow = {
  codsap: string;
  stock: number | string | null;
  costo: number | string | null;
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
  counted_original: number;
  recounted_qty: number | null;
  diff: number;
  cost: number;
  valueDiff: number;
  re_counted: boolean;
  observation?: string | null;
};

type RecountType = "surplus" | "missing";
type RecountColumn = "zone";
type ScannerTarget = "location" | "product" | "recount_location" | "recount_product" | null;
type ProductLookupMode = "typed" | "scan";

type RecountLocationLine = {
  id: string;
  location_id: string | null;
  location_code: string;
  full_location: string | null;
  zone: string | null;
  zone_ref: string | null;
  lineal: string | null;
  ticket: string | null;
  counted_qty: number;
};

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
  location_count: number;
  original_locations: RecountLocationLine[];
};

type RecountItem = RecountCandidate & {
  id: string;
  status: string;
  assigned_operator_id: string | null;
  assigned_operator_name?: string | null;
};

type RecountDocumentRow = RecountItem & {
  recount_count_id: string;
  recount_operator_id: string;
  recount_operator_name: string;
  recount_quantity: number;
  recount_original_quantity: number;
  recount_counted_at: string;
};

type OperatorRecountRecord = {
  id: string;
  recount_item_id: string;
  operator_id: string;
  operator_name?: string | null;
  location_id: string | null;
  location_code: string;
  product_id: string;
  sku: string;
  description: string;
  unit: string;
  quantity: number;
  original_quantity?: number;
  cost_snapshot: number;
  counted_at: string;
  updated_at?: string | null;
  item: RecountItem;
};

type RecountDraft = {
  productCode: string;
  extraProductCode: string;
  rows: Array<{
    locationCode: string;
    quantity: string;
    isExtra?: boolean;
  }>;
};

type InventoryOperatorDraft = {
  full_name: string;
  phone: string;
  password: string;
};

type ManualLocationDraft = {
  location_code: string;
  zone: string;
  zone_ref: string;
  lineal: string;
  reference: string;
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

function normalizeLocationCode(value: string | number | null | undefined) {
  return normalizeCode(value)
    .replace(/\u00a0/g, " ")
    .trim()
    .toUpperCase();
}

function buildFullLocationFromParts(parts: Pick<ManualLocationDraft, "zone" | "zone_ref" | "lineal" | "reference">) {
  return [parts.zone, parts.zone_ref, parts.lineal, parts.reference]
    .map(value => value.trim())
    .filter(Boolean)
    .join(" - ");
}

function numericLocationKey(value: string | number | null | undefined) {
  const clean = normalizeLocationCode(value);
  return /^\d+$/.test(clean) ? clean.replace(/^0+(?=\d)/, "") : "";
}

function findInventoryLocation(locations: InventoryLocation[], value: string | number | null | undefined) {
  const target = normalizeLocationCode(value);
  if (!target) return null;

  const exact = locations.find(row =>
    normalizeLocationCode(row.location_code) === target ||
    normalizeLocationCode(row.ticket) === target
  );
  if (exact) return exact;

  const numericTarget = numericLocationKey(target);
  if (!numericTarget) return null;
  const numericMatches = locations.filter(row =>
    numericLocationKey(row.location_code) === numericTarget ||
    numericLocationKey(row.ticket) === numericTarget
  );
  return numericMatches.length === 1 ? numericMatches[0] : null;
}

function isIosDevice() {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function searchWords(value: string) {
  return value.trim().toLowerCase().split(/\s+/).filter(word => word.length >= 2);
}

function codeMatchRank(product: Product, query: string) {
  const sku = normalizeCode(product.sku).toUpperCase();
  const barcode = normalizeCode(product.barcode).toUpperCase();
  const suffix = query.slice(-5);
  if (sku === query || barcode === query) return 0;
  if (query.length >= 4 && (sku.endsWith(query) || barcode.endsWith(query))) return 1;
  if (suffix.length >= 4 && (sku.endsWith(suffix) || barcode.endsWith(suffix))) return 2;
  if (query.length >= 4 && (sku.includes(query) || barcode.includes(query))) return 3;
  if (suffix.length >= 4 && (sku.includes(suffix) || barcode.includes(suffix))) return 4;
  return 5;
}

function money(value: number) {
  return `S/ ${Number(value || 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function number2(value: number | string | null | undefined) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("es-PE", { maximumFractionDigits: 2 });
}

function dateOnly(value: string | null | undefined) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("es-PE");
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] || char));
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

function normalizeHeader(value: string) {
  return value.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/_\d+$/, "");
}

function pickFirstMatchingColumn(row: Record<string, string>, names: string[]) {
  const normalizedNames = new Set(names.map(normalizeHeader));
  const found = Object.entries(row).find(([key]) => normalizedNames.has(normalizeHeader(key)));
  return String(found?.[1] ?? "").trim();
}

function pickLastMatchingColumn(row: Record<string, string>, names: string[]) {
  const normalizedNames = new Set(names.map(normalizeHeader));
  const found = [...Object.entries(row)].reverse().find(([key]) => normalizedNames.has(normalizeHeader(key)));
  return String(found?.[1] ?? "").trim();
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

function recountKey(row: Pick<RecountCandidate, "product_id" | "recount_type">) {
  return `${row.product_id}__${row.recount_type}`;
}

function sortRecountAssignmentLines<T extends Pick<RecountCandidate, "value_diff" | "recount_type" | "sku">>(rows: T[]) {
  return [...rows].sort((a, b) => {
    const aValue = Number(a.value_diff || 0);
    const bValue = Number(b.value_diff || 0);
    const valueCompare = a.recount_type === "missing"
      ? aValue - bValue
      : bValue - aValue;
    if (valueCompare !== 0) return valueCompare;
    return String(a.sku || "").localeCompare(String(b.sku || ""), "es", { numeric: true, sensitivity: "base" });
  });
}

function sortOperatorRecountCards<T extends Pick<RecountCandidate, "sku" | "value_diff" | "recount_type">>(rows: T[]) {
  return [...rows].sort((a, b) => {
    const aValue = Number(a.value_diff || 0);
    const bValue = Number(b.value_diff || 0);
    const valueCompare = a.recount_type === "missing"
      ? aValue - bValue
      : bValue - aValue;
    if (valueCompare !== 0) return valueCompare;
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
  const locationsFileRef = useRef<HTMLInputElement | null>(null);
  const [manualLocationDraft, setManualLocationDraft] = useState<ManualLocationDraft>({
    location_code: "",
    zone: "",
    zone_ref: "",
    lineal: "",
    reference: "",
  });
  const [savingManualLocation, setSavingManualLocation] = useState(false);

  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [savingEmptyLocationId, setSavingEmptyLocationId] = useState<string | null>(null);
  const [counts, setCounts] = useState<CountRow[]>([]);
  const [countedLocationCodes, setCountedLocationCodes] = useState<string[]>([]);
  const [recordsQuery, setRecordsQuery] = useState("");
  const [locationCode, setLocationCode] = useState("");
  const [productCode, setProductCode] = useState("");
  const [quantity, setQuantity] = useState("");
  const [editingCountId, setEditingCountId] = useState<string | null>(null);
  const [editingAdminCount, setEditingAdminCount] = useState<CountRow | null>(null);
  const [editingAdminLocation, setEditingAdminLocation] = useState("");
  const [editingAdminQuantity, setEditingAdminQuantity] = useState("");
  const [productCandidates, setProductCandidates] = useState<Product[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [productLookupMessage, setProductLookupMessage] = useState("");
  const [productLookupMode, setProductLookupMode] = useState<ProductLookupMode>("typed");
  const [savingCount, setSavingCount] = useState(false);
  const savingCountRef = useRef(false);
  const productLookupRequestRef = useRef(0);
  const productLookupModeRef = useRef<ProductLookupMode>("typed");
  const productInputRef = useRef<HTMLInputElement | null>(null);
  const qtyInputRef = useRef<HTMLInputElement | null>(null);

  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [summaryLoadedSessionId, setSummaryLoadedSessionId] = useState("");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryHasPendingChanges, setSummaryHasPendingChanges] = useState(false);
  const [summaryQuery, setSummaryQuery] = useState("");
  const [inventoryNotesDraft, setInventoryNotesDraft] = useState("");
  const [observationDrafts, setObservationDrafts] = useState<Record<string, string>>({});
  const [validatorTab, setValidatorTab] = useState<ValidatorTab>("preparacion");
  const [recordsSort, setRecordsSort] = useState<SortState<RecordsSortKey>>({ key: "counted_at", direction: "desc" });
  const [summarySort, setSummarySort] = useState<SortState<SummarySortKey>>({ key: "valueDiff", direction: "desc" });
  const [recountAssignedSort, setRecountAssignedSort] = useState<SortState<RecountAssignedSortKey>>({ key: "ticket", direction: "asc" });
  const [recountAssignedQuery, setRecountAssignedQuery] = useState("");
  const [recountRecordsQuery, setRecountRecordsQuery] = useState("");
  const [recountManagerTab, setRecountManagerTab] = useState<RecountManagerTab>("pendientes");
  const [selectedPendingRecountKeys, setSelectedPendingRecountKeys] = useState<Set<string>>(new Set());
  const [sessionOperators, setSessionOperators] = useState<InventoryOperator[]>([]);
  const [inventoryOperators, setInventoryOperators] = useState<InventoryOperator[]>([]);
  const [inventoryOperatorDrafts, setInventoryOperatorDrafts] = useState<Record<string, InventoryOperatorDraft>>({});
  const [savingInventoryOperatorId, setSavingInventoryOperatorId] = useState<string | null>(null);
  const [recountItems, setRecountItems] = useState<RecountItem[]>([]);
  const [reassignOperatorDrafts, setReassignOperatorDrafts] = useState<Record<string, string>>({});
  const [recountType, setRecountType] = useState<RecountType>("surplus");
  const recountColumn: RecountColumn = "zone";
  const [recountValue, setRecountValue] = useState("");
  const [recountOperatorId, setRecountOperatorId] = useState("");
  const [recountPrintOperatorId, setRecountPrintOperatorId] = useState("");
  const [recountDrafts, setRecountDrafts] = useState<Record<string, RecountDraft>>({});
  const [savingRecountId, setSavingRecountId] = useState<string | null>(null);
  const [operatorRecountRecords, setOperatorRecountRecords] = useState<OperatorRecountRecord[]>([]);
  const [adminRecountRecords, setAdminRecountRecords] = useState<OperatorRecountRecord[]>([]);
  const [editingAdminRecountRecord, setEditingAdminRecountRecord] = useState<OperatorRecountRecord | null>(null);
  const [editingAdminRecountLocation, setEditingAdminRecountLocation] = useState("");
  const [editingAdminRecountQuantity, setEditingAdminRecountQuantity] = useState("");
  const [editingRecountItemId, setEditingRecountItemId] = useState<string | null>(null);
  const [scannerTarget, setScannerTarget] = useState<ScannerTarget>(null);
  const [torchOn, setTorchOn] = useState(false);
  const scannerRef = useRef<any>(null);
  const scannerBusyRef = useRef(false);
  const scannerTargetRef = useRef<ScannerTarget>(null);
  const torchOnRef = useRef(false);
  const activeRecountScanIdRef = useRef<string | null>(null);
  const scannerHistoryRef = useRef(false);
  const iosFrameScanTimerRef = useRef<number | null>(null);
  const scannerContainerId = "inventory-scanner";

  const canManageInventory = user?.role === "Administrador" || user?.role === "Validador";
  const isReadOnlySupervisor = user?.role === "Supervisor";
  const isValidator = canManageInventory || isReadOnlySupervisor;
  const selectedSession = useMemo(
    () => sessions.find(session => session.id === selectedSessionId) || null,
    [sessions, selectedSessionId]
  );

  useEffect(() => {
    setInventoryNotesDraft(selectedSession?.notes || "");
  }, [selectedSession?.id, selectedSession?.notes]);

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
      const left = summarySort.key === "observation" ? String(a.observation || "") : a[summarySort.key] ?? "";
      const right = summarySort.key === "observation" ? String(b.observation || "") : b[summarySort.key] ?? "";
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
      const key = row.product_id;
      const qty = Number(row.quantity || 0);
      const current = surplusGroups.get(key);
      if (current) {
        current.counted_qty += qty;
        current.value_diff = summaryRow.valueDiff;
        current.diff_qty = summaryRow.diff;
        const lineKey = normalizeLocationCode(row.location_code || location?.location_code || "");
        const existingLine = current.original_locations.find(item => normalizeLocationCode(item.location_code) === lineKey);
        if (existingLine) {
          existingLine.counted_qty += qty;
        } else {
          current.original_locations.push({
            id: `${row.product_id}__${lineKey || current.original_locations.length}`,
            location_id: row.location_id || location?.id || null,
            location_code: row.location_code || location?.location_code || "",
            full_location: location?.full_location || location?.description || null,
            zone: location?.zone || null,
            zone_ref: location?.zone_ref || null,
            lineal: location?.lineal || null,
            ticket: location?.ticket || row.location_code,
            counted_qty: qty,
          });
          current.location_count = current.original_locations.length;
        }
        continue;
      }
      surplusGroups.set(key, {
        product_id: row.product_id,
        sku: row.sku,
        description: row.description,
        unit: row.unit,
        location_id: row.location_id,
        location_code: null,
        full_location: location?.full_location || location?.description || null,
        zone: location?.zone || null,
        zone_ref: location?.zone_ref || null,
        lineal: location?.lineal || null,
        ticket: "CODIGO COMPLETO",
        recount_type: "surplus",
        system_stock: summaryRow.system_stock,
        counted_qty: qty,
        diff_qty: summaryRow.diff,
        cost_snapshot: Number(row.cost_snapshot || summaryRow.cost || 0),
        value_diff: summaryRow.valueDiff,
        location_count: 1,
        original_locations: [{
          id: `${row.product_id}__${normalizeLocationCode(row.location_code || location?.location_code || "") || "SIN_UBICACION"}`,
          location_id: row.location_id || location?.id || null,
          location_code: row.location_code || location?.location_code || "",
          full_location: location?.full_location || location?.description || null,
          zone: location?.zone || null,
          zone_ref: location?.zone_ref || null,
          lineal: location?.lineal || null,
          ticket: location?.ticket || row.location_code,
          counted_qty: qty,
        }],
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
        location_count: 0,
        original_locations: [],
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
    return sortRecountAssignmentLines(recountCandidates.filter(row =>
      row.recount_type === "surplus" &&
      (!recountValue || row.original_locations.some(location => String(location[recountColumn] || "") === recountValue))
    ));
  }, [recountCandidates, recountColumn, recountType, recountValue]);

  const assignedRecountKeys = useMemo(
    () => new Set(recountItems.map(row => row.product_id)),
    [recountItems]
  );

  const unassignedRecountCandidates = useMemo(
    () => selectedRecountCandidates.filter(row => !assignedRecountKeys.has(row.product_id)),
    [assignedRecountKeys, selectedRecountCandidates]
  );

  const selectedPendingRecountRows = useMemo(
    () => unassignedRecountCandidates.filter(row => selectedPendingRecountKeys.has(recountKey(row))),
    [selectedPendingRecountKeys, unassignedRecountCandidates]
  );

  const allPendingRecountRowsSelected = unassignedRecountCandidates.length > 0 &&
    unassignedRecountCandidates.every(row => selectedPendingRecountKeys.has(recountKey(row)));

  const assignedRecountRows = useMemo(() => {
    const q = recountAssignedQuery.trim().toLowerCase();
    const rows = recountItems.filter(row =>
      row.status !== "cancelled" &&
      row.recount_type === recountType &&
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
  }, [recountAssignedQuery, recountAssignedSort, recountItems, recountType]);

  const activeAssignedRecountCount = useMemo(
    () => recountItems.filter(row => row.status !== "cancelled" && row.recount_type === recountType).length,
    [recountItems, recountType]
  );

  const filteredAdminRecountRecords = useMemo(() => {
    const q = recountRecordsQuery.trim().toLowerCase();
    return adminRecountRecords.filter(record => {
      if (record.item.recount_type !== recountType) return false;
      return !q ||
        record.sku.toLowerCase().includes(q) ||
        record.description.toLowerCase().includes(q) ||
        record.location_code.toLowerCase().includes(q) ||
        String(record.operator_name || "").toLowerCase().includes(q);
    });
  }, [adminRecountRecords, recountRecordsQuery, recountType]);

  function toggleRecordsSort(key: RecordsSortKey) {
    setRecordsSort(prev => ({ key, direction: prev.key === key && prev.direction === "desc" ? "asc" : "desc" }));
  }

  function toggleSummarySort(key: SummarySortKey) {
    setSummarySort(prev => ({ key, direction: prev.key === key && prev.direction === "desc" ? "asc" : "desc" }));
  }

  function toggleRecountAssignedSort(key: RecountAssignedSortKey) {
    setRecountAssignedSort(prev => ({ key, direction: prev.key === key && prev.direction === "desc" ? "asc" : "desc" }));
  }

  function togglePendingRecountSelection(key: string) {
    setSelectedPendingRecountKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAllPendingRecountSelection() {
    setSelectedPendingRecountKeys(prev => {
      const next = new Set(prev);
      if (allPendingRecountRowsSelected) {
        for (const row of unassignedRecountCandidates) next.delete(recountKey(row));
      } else {
        for (const row of unassignedRecountCandidates) next.add(recountKey(row));
      }
      return next;
    });
  }

  function changeRecountType(type: RecountType) {
    setRecountType(type);
    setSelectedPendingRecountKeys(new Set());
    setRecountManagerTab("pendientes");
    if (type === "missing") setRecountValue("");
  }

  const pendingLocations = useMemo(() => {
    const counted = new Set(countedLocationCodes.map(normalizeLocationCode));
    return locations.filter(location => !location.is_empty && !counted.has(normalizeLocationCode(location.location_code)));
  }, [locations, countedLocationCodes]);

  const emptyLocations = useMemo(
    () => locations.filter(location => location.is_empty),
    [locations]
  );

  const manualFullLocation = useMemo(
    () => buildFullLocationFromParts(manualLocationDraft),
    [manualLocationDraft]
  );

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
    const codesWithDifference = surplusCodes + missingCodes;
    const countedValue = rows.reduce((sum, row) => sum + row.counted * row.cost, 0);
    const pendingValue = Math.max(0, systemValue - countedValue);
    return {
      eri: totalCodes > 0 ? Math.round((okCodes / totalCodes) * 100) : 0,
      systemValue,
      countedValue,
      pendingValue,
      codesWithDifference,
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
    if (!selectedSessionId || !isValidator) return;
    localStorage.setItem(SESSION_KEY, selectedSessionId);
    void loadSessionData(selectedSessionId, validatorTab);
  }, [selectedSessionId, validatorTab, isValidator, operator?.id]);

  useEffect(() => {
    if (isReadOnlySupervisor && (validatorTab === "preparacion" || validatorTab === "reconteo" || validatorTab === "usuarios")) {
      setValidatorTab("registros");
    }
  }, [isReadOnlySupervisor, validatorTab]);

  useEffect(() => {
    if (!selectedSessionId || !operator || isValidator) return;
    void loadOperatorRecountItems(selectedSessionId, operator.id);
  }, [selectedSessionId, operator?.id, isValidator]);

  useEffect(() => {
    if (!selectedSessionId) return;

    let timer: number | null = null;
    const reloadInventoryCounts = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (validatorTab === "registros") void loadRecordsData(selectedSessionId);
        if (validatorTab === "resumen") setSummaryHasPendingChanges(true);
        if (validatorTab === "reconteo") void loadRecountData(selectedSessionId);
      }, 1500);
    };

    const channel = supabase
      .channel(`gi-counts-${selectedSessionId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "general_inventory_counts", filter: `session_id=eq.${selectedSessionId}` },
        reloadInventoryCounts
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "general_inventory_recount_counts", filter: `session_id=eq.${selectedSessionId}` },
        reloadInventoryCounts
      )
      .subscribe();

    return () => {
      if (timer) window.clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [selectedSessionId, isValidator, validatorTab]);

  useEffect(() => {
    if (!selectedSessionId) return;

    const reloadAfterOfflineSync = () => {
      if (isValidator) {
        void loadSessionData(selectedSessionId, validatorTab);
        return;
      }
      void loadRecordsData(selectedSessionId, operator?.id || null);
    };

    window.addEventListener("rasecorp-offline-sync-complete", reloadAfterOfflineSync);
    return () => window.removeEventListener("rasecorp-offline-sync-complete", reloadAfterOfflineSync);
  }, [selectedSessionId, isValidator, validatorTab, operator?.id]);

  useEffect(() => {
    if (!selectedSessionId || !operator || isValidator) return;

    let timer: number | null = null;
    const reloadAssignedRecounts = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void loadOperatorRecountItems(selectedSessionId, operator.id);
      }, 250);
    };

    const channel = supabase
      .channel(`gi-operator-recounts-${selectedSessionId}-${operator.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "general_inventory_recount_items", filter: `session_id=eq.${selectedSessionId}` },
        reloadAssignedRecounts
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "general_inventory_recount_counts", filter: `session_id=eq.${selectedSessionId}` },
        reloadAssignedRecounts
      )
      .subscribe();

    return () => {
      if (timer) window.clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [selectedSessionId, operator?.id, isValidator]);

  useEffect(() => {
    const validKeys = new Set(unassignedRecountCandidates.map(row => recountKey(row)));
    setSelectedPendingRecountKeys(prev => {
      const next = new Set([...prev].filter(key => validKeys.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [unassignedRecountCandidates]);

  useEffect(() => {
    if (!operator || isValidator) return;
    const raw = productCode.trim();
    if (selectedProduct && raw.toUpperCase() === selectedProduct.sku) return;
    if (productLookupModeRef.current === "scan") return;
    setSelectedProduct(null);
    setProductLookupMessage("");
    if (raw.length < 3 || !selectedSessionId) {
      productLookupRequestRef.current += 1;
      setProductCandidates([]);
      return;
    }
    const requestId = ++productLookupRequestRef.current;
    const timer = window.setTimeout(async () => {
      try {
        const result = await findProductCandidates(raw, productLookupModeRef.current);
        if (requestId !== productLookupRequestRef.current) return;
        setProductCandidates(result.products);
        setProductLookupMessage(result.message);
        if (result.products.length === 1) setSelectedProduct(result.products[0]);
      } catch {
        if (requestId !== productLookupRequestRef.current) return;
        setProductCandidates([]);
        setProductLookupMessage("No se pudo consultar el producto. Intenta nuevamente.");
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [productCode, selectedSessionId, operator?.id, isValidator, selectedProduct, productLookupMode]);

  useEffect(() => {
    scannerTargetRef.current = scannerTarget;
  }, [scannerTarget]);

  useEffect(() => {
    productLookupModeRef.current = productLookupMode;
  }, [productLookupMode]);

  useEffect(() => {
    torchOnRef.current = torchOn;
  }, [torchOn]);

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
        await startHtml5Scanner(() => cancelled);
      } catch (err: any) {
        setMessage("No se pudo iniciar la cámara: " + (err?.message || err));
        await stopScanner();
      }
    })();
    return () => { cancelled = true; void stopScanner(false); };
  }, [scannerTarget]);

  async function startHtml5Scanner(isCancelled: () => boolean) {
    const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
    if (isCancelled()) return;
    const scanner = isIosDevice()
      ? new Html5Qrcode(scannerContainerId, {
        verbose: false,
        useBarCodeDetectorIfSupported: false,
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
      })
      : new Html5Qrcode(scannerContainerId);
    scannerRef.current = scanner;
    scannerBusyRef.current = false;
    const isIos = isIosDevice();
    const scanConfig = isIos
      ? {
        fps: 15,
        qrbox: { width: 380, height: 190 },
        aspectRatio: 1.6,
        disableFlip: true,
        videoConstraints: {
          facingMode: { ideal: "environment" },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          frameRate: { ideal: 30 },
          resizeMode: "none",
        },
      }
      : { fps: 24, qrbox: { width: 300, height: 170 }, aspectRatio: 1.6, disableFlip: true };
    await scanner.start(
      { facingMode: "environment" },
      scanConfig,
      async (decodedText: string) => {
        if (scannerBusyRef.current) return;
        scannerBusyRef.current = true;
        const target = scannerTargetRef.current;
        const activeRecountScanId = activeRecountScanIdRef.current;
        await stopScanner();
        await applyScannedValue(decodedText, target, activeRecountScanId);
      },
      () => {}
    );
    if (isIos) {
      try {
        await scanner.applyVideoConstraints?.({
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          frameRate: { ideal: 30 },
          resizeMode: "none",
        } as MediaTrackConstraints);
      } catch {
        // Safari puede rechazar 4K en algunos iPhone; en ese caso mantiene la mejor resolución disponible.
      }
      startIosFrameScanner();
    }
  }

  function startIosFrameScanner() {
    if (iosFrameScanTimerRef.current) window.clearInterval(iosFrameScanTimerRef.current);
    iosFrameScanTimerRef.current = window.setInterval(() => {
      void scanCurrentIosFrame();
    }, 200);
  }

  async function scanCurrentIosFrame() {
    if (!scannerTargetRef.current || scannerBusyRef.current) return;
    const video = document.querySelector<HTMLVideoElement>(`#${scannerContainerId} video`);
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth <= 0 || video.videoHeight <= 0) return;

    try {
      const frameFiles = await buildIosFrameScanFiles(video);
      if (frameFiles.length === 0) return;

      scannerBusyRef.current = true;
      const { readBarcodes } = await import("zxing-wasm/reader");
      for (const file of frameFiles) {
        const results = await readBarcodes(file, {
          formats: ["Code128", "Code39", "Code39Ext", "Code93", "Codabar", "ITF", "EAN13", "EAN8", "UPCA", "UPCE"],
          tryHarder: true,
          tryRotate: true,
          tryInvert: true,
          tryDownscale: false,
          minLineCount: 1,
          maxNumberOfSymbols: 3,
          textMode: "Plain",
        });
        const decodedText = results.find(result => result.isValid && result.text.trim())?.text.trim();
        if (decodedText) {
          const target = scannerTargetRef.current;
          const activeRecountScanId = activeRecountScanIdRef.current;
          await stopScanner();
          await applyScannedValue(decodedText, target, activeRecountScanId);
          return;
        }
      }
      scannerBusyRef.current = false;
    } catch {
      scannerBusyRef.current = false;
    }
  }

  async function buildIosFrameScanFiles(video: HTMLVideoElement) {
    const width = video.videoWidth;
    const height = video.videoHeight;
    const box = { sx: width * 0.04, sy: height * 0.28, sw: width * 0.92, sh: height * 0.44 };
    const crops = [
      { name: "box-full", sx: box.sx, sy: box.sy, sw: box.sw, sh: box.sh, scale: 2.4, contrast: 1.8 },
      { name: "box-top", sx: box.sx, sy: box.sy, sw: box.sw, sh: box.sh * 0.32, scale: 4.2, contrast: 2.15 },
      { name: "box-upper-middle", sx: box.sx, sy: box.sy + box.sh * 0.18, sw: box.sw, sh: box.sh * 0.32, scale: 4.2, contrast: 2.15 },
      { name: "box-center", sx: box.sx, sy: box.sy + box.sh * 0.34, sw: box.sw, sh: box.sh * 0.32, scale: 4.5, contrast: 2.25 },
      { name: "box-lower-middle", sx: box.sx, sy: box.sy + box.sh * 0.50, sw: box.sw, sh: box.sh * 0.32, scale: 4.2, contrast: 2.15 },
      { name: "box-bottom", sx: box.sx, sy: box.sy + box.sh * 0.68, sw: box.sw, sh: box.sh * 0.32, scale: 4.2, contrast: 2.15 },
    ];
    const files: File[] = [];
    for (const crop of crops) {
      const file = await buildEnhancedFrameFile(video, crop);
      if (file) files.push(file);
    }
    return files;
  }

  async function buildEnhancedFrameFile(
    video: HTMLVideoElement,
    crop: { name: string; sx: number; sy: number; sw: number; sh: number; scale: number; contrast: number }
  ) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(crop.sw * crop.scale));
    canvas.height = Math.max(1, Math.round(crop.sh * crop.scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.imageSmoothingEnabled = false;
    context.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);

    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = image.data;
    for (let index = 0; index < data.length; index += 4) {
      const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
      const boosted = Math.max(0, Math.min(255, (gray - 128) * crop.contrast + 128));
      data[index] = boosted;
      data[index + 1] = boosted;
      data[index + 2] = boosted;
    }
    context.putImageData(image, 0, 0);

    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    return blob ? new File([blob], `${crop.name}.png`, { type: "image/png" }) : null;
  }

  async function applyScannedValue(decodedText: string, target = scannerTargetRef.current, activeRecountScanId = activeRecountScanIdRef.current) {
    const clean = decodedText.trim();
    if (target === "location") {
      setLocationCode(clean.toUpperCase());
      setMessage("Ubicación escaneada.");
      setTimeout(() => productInputRef.current?.focus(), 50);
    }
    if (target === "product") {
      setProductLookupMode("scan");
      productLookupModeRef.current = "scan";
      setProductCode(clean);
      await validateScannedProduct(clean);
    }
    if (target === "recount_location" && activeRecountScanId) {
      const [rowId, indexText] = activeRecountScanId.split(":");
      const item = recountItems.find(row => row.id === rowId);
      if (item) updateRecountDraftLine(item, Number(indexText || 0), "locationCode", clean.toUpperCase());
      setMessage("Ubicacion de reconteo escaneada.");
    }
    if (target === "recount_product" && activeRecountScanId) {
      const [rowId] = activeRecountScanId.split(":");
      updateRecountDraft(rowId, "productCode", clean);
      setMessage("Codigo de reconteo escaneado.");
    }
  }

  async function validateScannedProduct(code: string) {
    const requestId = ++productLookupRequestRef.current;
    setSelectedProduct(null);
    setProductCandidates([]);
    setProductLookupMessage("");
    setMessage("Código escaneado. Buscando en maestro...");
    try {
      const result = await findProductCandidates(code, "scan");
      if (requestId !== productLookupRequestRef.current) return;
      setProductCandidates(result.products);
      setProductLookupMessage(result.message);
      if (result.products.length === 1) {
        setSelectedProduct(result.products[0]);
        setMessage("Producto encontrado.");
        setTimeout(() => qtyInputRef.current?.focus(), 50);
        return;
      }
      setMessage(result.products.length > 1 ? "El código escaneado coincide con varios productos. Elige el correcto." : "El código escaneado no está en el maestro de productos.");
    } catch {
      if (requestId !== productLookupRequestRef.current) return;
      setProductCandidates([]);
      setProductLookupMessage("");
      setMessage("No se pudo validar el código escaneado. Intenta nuevamente.");
    }
  }

  function openScanner(target: Exclude<ScannerTarget, null>) {
    if (!scannerHistoryRef.current) {
      window.history.pushState({ inventoryScanner: true }, "", window.location.href);
      scannerHistoryRef.current = true;
    }
    setTorchOn(false);
    torchOnRef.current = false;
    setScannerTarget(target);
  }

  function openRecountScanner(rowId: string, target: "recount_location" | "recount_product", lineIndex = 0) {
    activeRecountScanIdRef.current = `${rowId}:${lineIndex}`;
    openScanner(target);
  }

  async function stopScanner(removeHistory = true) {
    scannerTargetRef.current = null;
    activeRecountScanIdRef.current = null;
    setTorchOn(false);
    torchOnRef.current = false;
    setScannerTarget(null);
    if (iosFrameScanTimerRef.current) {
      window.clearInterval(iosFrameScanTimerRef.current);
      iosFrameScanTimerRef.current = null;
    }
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
      torchOnRef.current = next;
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
      if (tab === "preparacion" && canManageInventory) {
        await loadPreparationData(sessionId);
        return;
      }
      if (tab === "registros") {
        await loadRecordsData(sessionId);
        return;
      }
      if (tab === "reconteo" && canManageInventory) {
        await loadRecountData(sessionId);
        return;
      }
      if (tab === "usuarios" && user?.role === "Administrador") {
        await loadInventoryOperators();
        return;
      }
      await loadSummary(sessionId);
      return;
    }

    if (!operator?.id) {
      await loadPreparationData(sessionId);
      setCounts([]);
      return;
    }

    await Promise.all([loadPreparationData(sessionId), loadRecordsData(sessionId, operator.id)]);
  }

  async function loadPreparationData(sessionId: string) {
    const [locRes, countRows] = await Promise.all([
      supabase.from("general_inventory_locations").select("*").eq("session_id", sessionId).eq("is_active", true).order("location_code"),
      loadPagedSessionRows("general_inventory_counts", "location_code", sessionId, "location_code"),
    ]);

    setLocations((locRes.data || []) as InventoryLocation[]);
    setCountedLocationCodes([...new Set(countRows.map(row => row.location_code).filter(Boolean))]);
  }

  async function loadRecordsData(sessionId: string, operatorId: string | null = isValidator ? null : operator?.id || null) {
    if (!isValidator && !operatorId) {
      setCounts([]);
      return;
    }

    const countRows = await loadAllCounts(sessionId, operatorId);
    const pendingRows = await loadPendingOfflineCountRows(sessionId, operatorId);
    const rows = mergePendingCounts(countRows, pendingRows);
    setCounts(rows);
    if (!operatorId) setCountedLocationCodes([...new Set(rows.map(row => row.location_code).filter(Boolean))]);
  }

  async function loadPendingOfflineCountRows(sessionId: string, operatorId: string | null = null): Promise<CountRow[]> {
    const pending = await listPendingOfflineItems().catch(() => []);
    return pending
      .filter(item => item.entity === "general_inventory_counts" && item.operation === "insert")
      .map(item => {
        const payload = item.payload as Partial<CountRow> & { counted_at?: string };
        return {
          id: item.localId,
          session_id: String(payload.session_id || sessionId),
          operator_id: String(payload.operator_id || ""),
          location_id: String(payload.location_id || ""),
          location_code: String(payload.location_code || ""),
          product_id: String(payload.product_id || ""),
          sku: String(payload.sku || ""),
          description: String(payload.description || ""),
          unit: String(payload.unit || ""),
          quantity: Number(payload.quantity || 0),
          cost_snapshot: Number(payload.cost_snapshot || 0),
          counted_at: String(payload.counted_at || item.createdAt),
          operator_name: operator?.full_name || "Pendiente offline",
        };
      })
      .filter(row => row.session_id === sessionId && (!operatorId || row.operator_id === operatorId));
  }

  function mergePendingCounts(serverRows: CountRow[], pendingRows: CountRow[]) {
    if (pendingRows.length === 0) return serverRows;
    const pendingIds = new Set(pendingRows.map(row => row.id));
    return [...pendingRows, ...serverRows.filter(row => !pendingIds.has(row.id))];
  }

  async function loadRecountData(sessionId: string) {
    await Promise.all([
      loadPreparationData(sessionId),
      loadRecordsData(sessionId),
      loadSummary(sessionId),
      loadRecountAssignments(sessionId),
      loadAdminRecountRecords(sessionId),
    ]);
  }

  async function loadOriginalCountedByProductLocation(sessionId: string, productIds: string[]) {
    const originalByLocation = new Map<string, number>();
    const cleanProductIds = [...new Set(productIds.filter(Boolean))];
    for (let i = 0; i < cleanProductIds.length; i += 100) {
      const chunk = cleanProductIds.slice(i, i + 100);
      const { data, error } = await supabase
        .from("general_inventory_counts")
        .select("product_id,location_id,location_code,quantity")
        .eq("session_id", sessionId)
        .in("product_id", chunk);
      if (error) {
        setMessage("No se pudo leer conteo original por ubicacion: " + error.message);
        return originalByLocation;
      }
      for (const row of data || []) {
        const qty = Number(row.quantity || 0);
        const codeKey = `${row.product_id}__code__${normalizeLocationCode(row.location_code)}`;
        originalByLocation.set(codeKey, (originalByLocation.get(codeKey) || 0) + qty);
        if (row.location_id) {
          const idKey = `${row.product_id}__id__${row.location_id}`;
          originalByLocation.set(idKey, (originalByLocation.get(idKey) || 0) + qty);
        }
      }
    }
    return originalByLocation;
  }

  async function loadAdminRecountRecords(sessionId: string) {
    const { data, error } = await supabase
      .from("general_inventory_recount_counts")
      .select("*, general_inventory_operators(full_name)")
      .eq("session_id", sessionId)
      .order("updated_at", { ascending: false, nullsFirst: false })
      .order("counted_at", { ascending: false });
    if (error) {
      setMessage("No se pudieron leer registros de reconteo: " + error.message);
      return;
    }

    const countRows = (data || []) as any[];
    const productIds = [...new Set(countRows.map(row => String(row.product_id || "")).filter(Boolean))];
    const originalByLocation = await loadOriginalCountedByProductLocation(sessionId, productIds);
    const itemIds = [...new Set(countRows.map(row => String(row.recount_item_id || "")).filter(Boolean))];
    const itemRows: any[] = [];
    for (let i = 0; i < itemIds.length; i += 100) {
      const chunk = itemIds.slice(i, i + 100);
      const itemRowsRes = await supabase
        .from("general_inventory_recount_items")
        .select("*")
        .in("id", chunk);
      if (itemRowsRes.error) {
        setMessage("No se pudieron leer detalles de reconteo: " + itemRowsRes.error.message);
        return;
      }
      itemRows.push(...(itemRowsRes.data || []));
    }

    const itemById = new Map(itemRows.map(row => [String(row.id), {
      id: String(row.id),
      product_id: String(row.product_id || ""),
      sku: String(row.sku || ""),
      description: String(row.description || ""),
      unit: String(row.unit || ""),
      location_id: row.location_id ? String(row.location_id) : null,
      location_code: row.location_code || null,
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
      location_count: Number(row.location_count || 0),
      original_locations: [],
      assigned_operator_id: row.assigned_operator_id || null,
      assigned_operator_name: null,
      status: row.status || "assigned",
    } as RecountItem]));

    const rows = countRows
      .map(countRow => {
        const item = itemById.get(String(countRow.recount_item_id || ""));
        if (!item) return null;
        return {
          id: String(countRow.id || ""),
          recount_item_id: String(countRow.recount_item_id || ""),
          operator_id: String(countRow.operator_id || ""),
          operator_name: countRow.general_inventory_operators?.full_name || null,
          location_id: countRow.location_id ? String(countRow.location_id) : null,
          location_code: String(countRow.location_code || ""),
          product_id: String(countRow.product_id || item.product_id || ""),
          sku: String(countRow.sku || item.sku || ""),
          description: String(countRow.description || item.description || ""),
          unit: String(countRow.unit || item.unit || ""),
          quantity: Number(countRow.quantity || 0),
          original_quantity: originalByLocation.get(`${String(countRow.product_id || item.product_id || "")}__id__${String(countRow.location_id || "")}`) ??
            originalByLocation.get(`${String(countRow.product_id || item.product_id || "")}__code__${normalizeLocationCode(countRow.location_code)}`) ??
            0,
          cost_snapshot: Number(countRow.cost_snapshot || item.cost_snapshot || 0),
          counted_at: String(countRow.counted_at || ""),
          updated_at: String(countRow.updated_at || countRow.counted_at || ""),
          item,
        } as OperatorRecountRecord;
      })
      .filter(Boolean) as OperatorRecountRecord[];
    setAdminRecountRecords(rows);
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
      location_count: Number(row.location_count || 0),
      original_locations: [],
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
    if (!row || !confirm(`Eliminar usuario de inventario ${row.full_name} de esta sesion?`)) return;

    if (selectedSessionId) {
      const [sessionCountsRes, sessionRecountCountsRes, sessionRecountItemsRes] = await Promise.all([
        supabase.from("general_inventory_counts").select("id").eq("session_id", selectedSessionId).eq("operator_id", id).limit(1),
        supabase.from("general_inventory_recount_counts").select("id").eq("session_id", selectedSessionId).eq("operator_id", id).limit(1),
        supabase.from("general_inventory_recount_items").select("id").eq("session_id", selectedSessionId).eq("assigned_operator_id", id).neq("status", "cancelled").limit(1),
      ]);

      if ((sessionCountsRes.data || []).length > 0 || (sessionRecountCountsRes.data || []).length > 0 || (sessionRecountItemsRes.data || []).length > 0) {
        setMessage("No se puede retirar de esta sesion: tiene registros o reconteos asignados. Reasigna o quita sus reconteos primero.");
        return;
      }

      const currentSessionCleanup = await supabase
        .from("general_inventory_session_operators")
        .delete()
        .eq("session_id", selectedSessionId)
        .eq("operator_id", id);
      if (currentSessionCleanup.error) {
        setMessage("No se pudo retirar al usuario de esta sesion: " + currentSessionCleanup.error.message);
        return;
      }
    }

    const [countsRes, recountCountsRes, recountItemsRes] = await Promise.all([
      supabase.from("general_inventory_counts").select("id").eq("operator_id", id).limit(1),
      supabase.from("general_inventory_recount_counts").select("id").eq("operator_id", id).limit(1),
      supabase.from("general_inventory_recount_items").select("id").eq("assigned_operator_id", id).limit(1),
    ]);

    const hasHistoricalLinks = (countsRes.data || []).length > 0 || (recountCountsRes.data || []).length > 0 || (recountItemsRes.data || []).length > 0;
    let deletedGlobalOperator = false;
    if (!hasHistoricalLinks) {
      const remainingSessions = await supabase
        .from("general_inventory_session_operators")
        .select("id")
        .eq("operator_id", id)
        .limit(1);

      if ((remainingSessions.data || []).length === 0) {
        const { error } = await supabase.from("general_inventory_operators").delete().eq("id", id);
        if (error) {
          setMessage("Usuario retirado de esta sesion. No se pudo eliminar de la tabla global: " + error.message);
          await loadInventoryOperators();
          if (selectedSessionId) await loadRecountAssignments(selectedSessionId);
          return;
        }
        deletedGlobalOperator = true;
      }
    }

    setMessage(deletedGlobalOperator ? "Usuario de inventario eliminado." : "Usuario retirado de esta sesion. Se conserva su historico si existe.");
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
    const assignedRows = (data || []) as any[];
    const mappedRows = sortOperatorRecountCards(assignedRows.map((row: any) => ({
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
      location_count: Number(row.location_count || 0),
      original_locations: [],
      assigned_operator_id: row.assigned_operator_id,
      assigned_operator_name: operator?.full_name || null,
      status: row.status || "assigned",
    })) as RecountItem[]);

    const productIds = [...new Set(mappedRows.map(row => row.product_id).filter(Boolean))];
    const locationsRequest = supabase
      .from("general_inventory_locations")
      .select("*")
      .eq("session_id", sessionId)
      .eq("is_active", true);
    const savedRecountsRequest = supabase
      .from("general_inventory_recount_counts")
      .select("*")
      .eq("session_id", sessionId)
      .in("operator_id", [...operatorIds])
      .order("counted_at", { ascending: false });
    const [countRowsRes, locationsRes, savedRecountsRes] = productIds.length > 0
      ? await Promise.all([
        supabase
          .from("general_inventory_counts")
          .select("product_id,location_id,location_code,quantity")
          .eq("session_id", sessionId)
          .in("product_id", productIds),
        locationsRequest,
        savedRecountsRequest,
      ])
      : [{ data: [] }, await locationsRequest, await savedRecountsRequest];
    const activeLocations = (locationsRes.data || []) as InventoryLocation[];
    setLocations(activeLocations);
    const locationById = new Map(activeLocations.map(row => [row.id, row]));
    const linesByProduct = new Map<string, RecountLocationLine[]>();
    for (const countRow of countRowsRes.data || []) {
      const productId = String(countRow.product_id || "");
      const loc = locationById.get(String(countRow.location_id || ""));
      const code = normalizeLocationCode(countRow.location_code || loc?.location_code || "");
      if (!productId || !code) continue;
      if (!linesByProduct.has(productId)) linesByProduct.set(productId, []);
      const rows = linesByProduct.get(productId)!;
      const existing = rows.find(row => normalizeLocationCode(row.location_code) === code);
      if (existing) {
        existing.counted_qty += Number(countRow.quantity || 0);
      } else {
        rows.push({
          id: `${productId}__${code}`,
          location_id: String(countRow.location_id || loc?.id || "") || null,
          location_code: code,
          full_location: loc?.full_location || loc?.description || null,
          zone: loc?.zone || null,
          zone_ref: loc?.zone_ref || null,
          lineal: loc?.lineal || null,
          ticket: loc?.ticket || code,
          counted_qty: Number(countRow.quantity || 0),
        });
      }
    }

    const rowsWithLocations = mappedRows.map(row => {
      const originalLocations = (linesByProduct.get(row.product_id) || [])
        .sort((a, b) => a.location_code.localeCompare(b.location_code, "es", { numeric: true, sensitivity: "base" }));
      const originalTotal = originalLocations.reduce((sum, location) => sum + Number(location.counted_qty || 0), 0);
      const shouldUseCountedLocations = row.recount_type === "surplus" || originalLocations.length > 0;
      const countedQty = row.recount_type === "missing" && originalLocations.length > 0 ? originalTotal : row.counted_qty;
      const diffQty = row.recount_type === "missing" && originalLocations.length > 0 ? countedQty - row.system_stock : row.diff_qty;
      return {
        ...row,
        counted_qty: countedQty,
        diff_qty: diffQty,
        value_diff: row.recount_type === "missing" && originalLocations.length > 0 ? diffQty * row.cost_snapshot : row.value_diff,
        original_locations: shouldUseCountedLocations ? originalLocations : [],
        location_count: shouldUseCountedLocations ? originalLocations.length : 0,
      };
    });
    setRecountItems(rowsWithLocations.filter(row => !["counted", "cancelled"].includes(row.status || "")));
    const itemById = new Map(rowsWithLocations.map(row => [row.id, row]));
    const savedRecords = ((savedRecountsRes.data || []) as any[])
      .map(countRow => {
        const item = itemById.get(String(countRow.recount_item_id || ""));
        if (!item) return null;
        return {
          id: String(countRow.id || ""),
          recount_item_id: String(countRow.recount_item_id || ""),
          operator_id: String(countRow.operator_id || ""),
          location_id: countRow.location_id ? String(countRow.location_id) : null,
          location_code: String(countRow.location_code || ""),
          product_id: String(countRow.product_id || item.product_id || ""),
          sku: String(countRow.sku || item.sku || ""),
          description: String(countRow.description || item.description || ""),
          unit: String(countRow.unit || item.unit || ""),
          quantity: Number(countRow.quantity || 0),
          cost_snapshot: Number(countRow.cost_snapshot || item.cost_snapshot || 0),
          counted_at: String(countRow.counted_at || ""),
          updated_at: String(countRow.updated_at || countRow.counted_at || ""),
          item,
        } as OperatorRecountRecord;
      })
      .filter(Boolean) as OperatorRecountRecord[];
    setOperatorRecountRecords(savedRecords);
  }

  async function loadAllCounts(sessionId: string, operatorId: string | null = null): Promise<CountRow[]> {
    const rows: CountRow[] = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      let query = supabase
        .from("general_inventory_counts")
        .select("*, general_inventory_operators(full_name)")
        .eq("session_id", sessionId)
        .order("counted_at", { ascending: false });
      if (operatorId) query = query.eq("operator_id", operatorId);
      const { data, error } = await query.range(from, from + pageSize - 1);
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

  async function loadInventoryNonInventoryRows(sessionId: string): Promise<Array<{ sku: string }>> {
    const [sessionRows, globalRows] = await Promise.all([
      loadPagedSessionRows("general_inventory_non_inventory_products", "sku", sessionId, "sku"),
      supabase.from("cyclic_non_inventory_products").select("sku").eq("is_active", true).order("sku"),
    ]);
    const skus = new Set<string>();
    for (const row of sessionRows) {
      const sku = normalizeCode(row.sku).toUpperCase();
      if (sku) skus.add(sku);
    }
    for (const row of globalRows.data || []) {
      const sku = normalizeCode(row.sku).toUpperCase();
      if (sku) skus.add(sku);
    }
    return [...skus].map(sku => ({ sku }));
  }

  async function loadNonInventorySkuSetForProducts(sessionId: string, skus: string[]): Promise<Set<string>> {
    const cleanSkus = [...new Set(skus.map(sku => normalizeCode(sku).toUpperCase()).filter(Boolean))];
    if (cleanSkus.length === 0) return new Set();
    const rows: Array<{ sku: string }> = [];
    for (let i = 0; i < cleanSkus.length; i += 500) {
      const chunk = cleanSkus.slice(i, i + 500);
      const [sessionRows, globalRows] = await Promise.all([
        supabase.from("general_inventory_non_inventory_products").select("sku").eq("session_id", sessionId).in("sku", chunk),
        supabase.from("cyclic_non_inventory_products").select("sku").eq("is_active", true).in("sku", chunk),
      ]);
      rows.push(...(sessionRows.data || []), ...(globalRows.data || []));
    }
    return new Set(rows.map(row => normalizeCode(row.sku).toUpperCase()).filter(Boolean));
  }

  async function loadStockGeneralBySkuForSession(sessionId: string, skus: string[]): Promise<Map<string, StockGeneralRow>> {
    const session = sessions.find(row => row.id === sessionId) || selectedSession;
    const store = stores.find(row => row.id === session?.store_id);
    const sede = store?.erp_sede || store?.name || session?.store_name || "";
    const cleanSkus = [...new Set(skus.map(sku => normalizeCode(sku).toUpperCase()).filter(Boolean))];
    const stockBySku = new Map<string, StockGeneralRow>();
    if (!sede || cleanSkus.length === 0) return stockBySku;

    for (let i = 0; i < cleanSkus.length; i += 100) {
      const chunk = cleanSkus.slice(i, i + 100);
      const { data, error } = await supabase
        .from("stock_general")
        .select("codsap,stock,costo")
        .eq("sede", sede)
        .in("codsap", chunk);
      if (error) {
        setMessage("No se pudo cruzar stock actual de la tienda: " + error.message);
        return stockBySku;
      }
      for (const row of (data || []) as StockGeneralRow[]) {
        const sku = normalizeCode(row.codsap).toUpperCase();
        if (sku) stockBySku.set(sku, row);
      }
    }

    return stockBySku;
  }

  async function loadSummary(sessionId: string, force = false) {
    if (!force && summaryLoadedSessionId === sessionId) return;
    setSummaryLoading(true);
    const [snapshotRows, countRows, observationRows, nonInventoryRows, recountCountRows, recountItemRows] = await Promise.all([
      loadPagedSessionRows("general_inventory_stock_snapshot", "*", sessionId, "sku"),
      loadPagedSessionRows("general_inventory_counts", "product_id,sku,description,unit,quantity,cost_snapshot", sessionId, "sku"),
      loadPagedSessionRows("general_inventory_item_observations", "*", sessionId, "product_id"),
      loadInventoryNonInventoryRows(sessionId),
      loadPagedSessionRows("general_inventory_recount_counts", "recount_item_id,product_id,sku,description,unit,quantity,cost_snapshot", sessionId, "sku"),
      loadPagedSessionRows("general_inventory_recount_items", "id,product_id,status", sessionId, "product_id"),
    ]);
    const liveStockBySku = await loadStockGeneralBySkuForSession(sessionId, [
      ...countRows.map(row => row.sku),
      ...recountCountRows.map(row => row.sku),
    ]);

    const nonInventorySkus = new Set(nonInventoryRows.map(row => normalizeCode(row.sku).toUpperCase()));
    const originalCountedByProduct = new Map<string, number>();
    for (const row of countRows) {
      if (nonInventorySkus.has(normalizeCode(row.sku).toUpperCase())) continue;
      originalCountedByProduct.set(row.product_id, (originalCountedByProduct.get(row.product_id) || 0) + Number(row.quantity || 0));
    }
    const recountItemById = new Map(recountItemRows.map(row => [row.id, row]));
    const recountTotalByProduct = new Map<string, number>();
    for (const row of recountCountRows) {
      if (nonInventorySkus.has(normalizeCode(row.sku).toUpperCase())) continue;
      const item = recountItemById.get(row.recount_item_id);
      if (item?.product_id && item.status === "counted") {
        recountTotalByProduct.set(item.product_id, (recountTotalByProduct.get(item.product_id) || 0) + Number(row.quantity || 0));
      }
    }

    const observations = new Map<string, string>();
    for (const row of observationRows) observations.set(row.product_id, row.observation || "");

    const productIdsInSnapshot = new Set<string>();
    const rows: SummaryRow[] = [];
    for (const snap of snapshotRows) {
      if (nonInventorySkus.has(normalizeCode(snap.sku).toUpperCase())) continue;
      const countedOriginal = originalCountedByProduct.get(snap.product_id) || 0;
      const recountedQty = recountTotalByProduct.has(snap.product_id) ? recountTotalByProduct.get(snap.product_id)! : null;
      const counted = recountedQty ?? countedOriginal;
      const systemStock = Number(snap.system_stock || 0);
      if (systemStock <= 0 && counted <= 0) continue;
      productIdsInSnapshot.add(snap.product_id);
      const cost = Number(snap.cost || 0);
      const diff = counted - systemStock;
      rows.push({
        product_id: snap.product_id,
        sku: snap.sku,
        description: snap.description || "",
        unit: snap.unit || "",
        system_stock: systemStock,
        counted,
        counted_original: countedOriginal,
        recounted_qty: recountedQty,
        diff,
        cost,
        valueDiff: diff * cost,
        re_counted: recountTotalByProduct.has(snap.product_id),
        observation: observations.get(snap.product_id) || "",
      });
    }

    for (const row of countRows) {
      if (nonInventorySkus.has(normalizeCode(row.sku).toUpperCase())) continue;
      if (productIdsInSnapshot.has(row.product_id)) continue;
      const countedOriginal = originalCountedByProduct.get(row.product_id) || 0;
      const recountedQty = recountTotalByProduct.has(row.product_id) ? recountTotalByProduct.get(row.product_id)! : null;
      const counted = recountedQty ?? countedOriginal;
      const liveStock = liveStockBySku.get(normalizeCode(row.sku).toUpperCase());
      const systemStock = Number(liveStock?.stock || 0);
      const cost = Number(liveStock?.costo ?? row.cost_snapshot ?? 0);
      const diff = counted - systemStock;
      rows.push({
        product_id: row.product_id,
        sku: row.sku,
        description: row.description || "",
        unit: row.unit || "",
        system_stock: systemStock,
        counted,
        counted_original: countedOriginal,
        recounted_qty: recountedQty,
        diff,
        cost,
        valueDiff: diff * cost,
        re_counted: recountTotalByProduct.has(row.product_id),
        observation: observations.get(row.product_id) || "",
      });
      productIdsInSnapshot.add(row.product_id);
    }

    rows.sort((a, b) => Math.abs(b.valueDiff) - Math.abs(a.valueDiff));
    setSummary(rows);
    setObservationDrafts(Object.fromEntries(rows.map(row => [row.product_id, row.observation || ""])));
    setSummaryLoadedSessionId(sessionId);
    setSummaryHasPendingChanges(false);
    setSummaryLoading(false);
  }

  async function assignRecountBlock(limit?: number, explicitRows?: RecountCandidate[]) {
    if (!selectedSessionId || !user || !recountOperatorId) {
      setMessage("Selecciona operador activo para asignar reconteo.");
      return;
    }
    const baseRows = explicitRows || unassignedRecountCandidates;
    const sourceRows = typeof limit === "number" ? baseRows.slice(0, limit) : baseRows;
    const rows = sourceRows.map(row => ({
      session_id: selectedSessionId,
      product_id: row.product_id,
      location_id: null,
      location_code: "CODIGO_COMPLETO",
      ticket: row.recount_type === "missing" ? "FALTANTE" : "CODIGO COMPLETO",
      zone: row.recount_type === "surplus" ? recountValue || null : null,
      zone_ref: null,
      lineal: null,
      full_location: row.recount_type === "missing" ? "Reconteo por codigo faltante" : `${row.location_count} ubicacion(es) contadas`,
      recount_type: row.recount_type,
      sku: row.sku,
      description: row.description,
      unit: row.unit,
      system_stock: row.system_stock,
      counted_qty: row.counted_qty,
      diff_qty: row.diff_qty,
      cost_snapshot: row.cost_snapshot,
      value_diff: row.value_diff,
      location_count: row.location_count,
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

    setSelectedPendingRecountKeys(prev => {
      const next = new Set(prev);
      for (const row of sourceRows) next.delete(recountKey(row));
      return next;
    });
    setMessage(`${rows.length} items asignados para reconteo.`);
    await loadRecountAssignments(selectedSessionId);
  }

  async function assignSelectedRecountRows() {
    if (selectedPendingRecountRows.length === 0) {
      setMessage("Marca al menos una linea pendiente para asignar.");
      return;
    }
    await assignRecountBlock(undefined, selectedPendingRecountRows);
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
    setMessage("Asignacion quitada. La linea queda fuera de pendientes porque ya fue enviada a reconteo.");
    await loadRecountAssignments(selectedSessionId);
  }

  async function refreshAfterRecountDelete(sessionId: string, operatorId?: string) {
    if (operatorId) await loadOperatorRecountItems(sessionId, operatorId);
    if (isValidator) {
      await loadRecountData(sessionId);
      await loadSummary(sessionId, true);
    } else {
      setSummaryHasPendingChanges(true);
    }
  }

  async function deleteAssignedRecountCounts(item: RecountItem) {
    if (!selectedSessionId || !canManageInventory) {
      setMessage("Solo el validador o administrador puede borrar reconteos guardados.");
      return;
    }
    const confirmed = window.confirm(`Borrar el reconteo guardado de ${item.sku}? La asignacion quedara abierta y el resumen volvera a tomar el conteo original.`);
    if (!confirmed) return;
    const { error } = await supabase
      .from("general_inventory_recount_counts")
      .delete()
      .eq("recount_item_id", item.id)
      .eq("session_id", selectedSessionId);
    if (error) {
      setMessage("No se pudo borrar el reconteo guardado: " + error.message);
      return;
    }
    await supabase
      .from("general_inventory_recount_items")
      .update({ status: "assigned", updated_at: new Date().toISOString() })
      .eq("id", item.id);
    setMessage("Reconteo guardado borrado. La linea volvio a asignado.");
    await refreshAfterRecountDelete(selectedSessionId);
  }

  function openAdminEditRecountRecord(record: OperatorRecountRecord) {
    setEditingAdminRecountRecord(record);
    setEditingAdminRecountLocation(record.location_code === "SIN_FISICO" ? "" : record.location_code || "");
    setEditingAdminRecountQuantity(String(record.quantity || ""));
  }

  async function saveAdminEditRecountRecord() {
    if (!editingAdminRecountRecord || !selectedSessionId) return;
    const qty = Number(editingAdminRecountQuantity);
    const location = normalizeLocationCode(editingAdminRecountLocation);
    if (!Number.isFinite(qty) || qty < 0) {
      setMessage("Ingresa cantidad valida.");
      return;
    }

    let loc: InventoryLocation | null = null;
    let locationCode = location;
    if (!locationCode) {
      if (editingAdminRecountRecord.item.recount_type === "missing" && qty === 0) {
        locationCode = "SIN_FISICO";
      } else {
        setMessage("Ingresa ubicacion valida.");
        return;
      }
    } else {
      loc = findInventoryLocation(locations, locationCode);
      if (!loc) {
        setMessage("La ubicacion no esta cargada para esta sesion.");
        return;
      }
      locationCode = loc.location_code;
    }

    const { error } = await supabase
      .from("general_inventory_recount_counts")
      .update({
        location_id: loc?.id || null,
        location_code: locationCode,
        quantity: qty,
        updated_at: new Date().toISOString(),
      })
      .eq("id", editingAdminRecountRecord.id)
      .eq("session_id", selectedSessionId);
    if (error) {
      setMessage("No se pudo actualizar registro de reconteo: " + error.message);
      return;
    }

    setEditingAdminRecountRecord(null);
    setMessage("Registro de reconteo actualizado.");
    await Promise.all([
      loadAdminRecountRecords(selectedSessionId),
      loadSummary(selectedSessionId, true),
      loadRecountAssignments(selectedSessionId),
    ]);
  }

  async function deleteAdminRecountRecord(record: OperatorRecountRecord) {
    if (!selectedSessionId || !canManageInventory) {
      setMessage("Solo el validador o administrador puede borrar reconteos guardados.");
      return;
    }
    const confirmed = window.confirm(`Borrar el registro de reconteo de ${record.sku} en ${record.location_code || "SIN UBICACION"}?`);
    if (!confirmed) return;
    const { error } = await supabase
      .from("general_inventory_recount_counts")
      .delete()
      .eq("id", record.id)
      .eq("session_id", selectedSessionId);
    if (error) {
      setMessage("No se pudo borrar el registro de reconteo: " + error.message);
      return;
    }

    const remaining = await supabase
      .from("general_inventory_recount_counts")
      .select("id")
      .eq("recount_item_id", record.recount_item_id)
      .limit(1);
    if (!remaining.error && (remaining.data || []).length === 0) {
      await supabase
        .from("general_inventory_recount_items")
        .update({ status: "assigned", updated_at: new Date().toISOString() })
        .eq("id", record.recount_item_id);
    }

    setMessage("Registro de reconteo borrado.");
    await Promise.all([
      loadAdminRecountRecords(selectedSessionId),
      loadSummary(selectedSessionId, true),
      loadRecountAssignments(selectedSessionId),
    ]);
  }

  async function deleteAllAssignedRecountCounts() {
    if (!selectedSessionId || !canManageInventory) {
      setMessage("Solo el validador o administrador puede borrar reconteos guardados.");
      return;
    }
    const confirmed = window.confirm("Borrar TODOS los reconteos guardados de esta sesion? Las asignaciones quedaran abiertas y el resumen volvera a tomar los conteos originales.");
    if (!confirmed) return;
    const { error } = await supabase
      .from("general_inventory_recount_counts")
      .delete()
      .eq("session_id", selectedSessionId);
    if (error) {
      setMessage("No se pudieron borrar los reconteos guardados: " + error.message);
      return;
    }
    const statusUpdate = await supabase
      .from("general_inventory_recount_items")
      .update({ status: "assigned", updated_at: new Date().toISOString() })
      .eq("session_id", selectedSessionId)
      .eq("status", "counted");
    if (statusUpdate.error) {
      setMessage("Reconteos borrados, pero no se pudo reabrir asignaciones: " + statusUpdate.error.message);
      return;
    }
    setMessage("Todos los reconteos guardados fueron borrados. El resumen vuelve al conteo original.");
    await refreshAfterRecountDelete(selectedSessionId);
  }

  async function markLocationEmpty(location: InventoryLocation) {
    if (!selectedSessionId || !user || !canManageInventory) {
      setMessage("Solo el validador o administrador puede marcar ubicaciones vacias.");
      return;
    }
    const counted = new Set(countedLocationCodes.map(normalizeLocationCode));
    if (counted.has(normalizeLocationCode(location.location_code))) {
      setMessage("Esta ubicacion ya tiene registros y no puede marcarse como vacia.");
      return;
    }
    const confirmed = window.confirm(`Marcar la ubicacion ${location.location_code} como vacia? Desaparecera de pendientes reales y quedara guardada para reportes.`);
    if (!confirmed) return;

    setSavingEmptyLocationId(location.id);
    try {
      const { error } = await supabase
        .from("general_inventory_locations")
        .update({
          is_empty: true,
          empty_marked_by: user.id,
          empty_marked_at: new Date().toISOString(),
        })
        .eq("id", location.id)
        .eq("session_id", selectedSessionId);
      if (error) {
        setMessage("No se pudo marcar como vacia. Ejecuta supabase_inventarios_generales.sql actualizado: " + error.message);
        return;
      }
      setLocations(prev => prev.map(row => row.id === location.id ? {
        ...row,
        is_empty: true,
        empty_marked_by: user.id,
        empty_marked_at: new Date().toISOString(),
      } : row));
      setMessage(`Ubicacion ${location.location_code} marcada como vacia.`);
    } finally {
      setSavingEmptyLocationId(null);
    }
  }

  async function createSession() {
    if (!canManageInventory) { setMessage("Tu usuario tiene acceso de solo lectura."); return; }
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
    if (!canManageInventory) { setMessage("Tu usuario tiene acceso de solo lectura."); return; }
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
      const locationCode = normalizeLocationCode(ticket);
      if (!locationCode) continue;
      const bloqueUbicacion = pickFirstMatchingColumn(row, ["UBICACIÓN", "UBICACION"]);
      const zona = pickColumn(row, ["ZONA"]);
      const zonaRef = pickColumn(row, ["ZONA REF"]) || zona;
      const lineal = pickColumn(row, ["LINEAL"]);
      const referencia = pickColumn(row, ["REFERENCIA"]);
      const fullLocation = pickColumn(row, ["UBICACIÓN CONCATENADA", "UBICACION CONCATENADA"]) || pickLastMatchingColumn(row, ["UBICACIÓN", "UBICACION"]);
      uniqueRows.set(locationCode, {
        session_id: selectedSessionId,
        location_code: locationCode,
        ticket: locationCode,
        zone: bloqueUbicacion || null,
        zone_ref: zonaRef || null,
        lineal: lineal || null,
        reference: referencia || null,
        full_location: fullLocation || null,
        description: fullLocation || [bloqueUbicacion, zona, lineal, referencia].filter(Boolean).join(" - ") || null,
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

  function updateManualLocationDraft(field: keyof ManualLocationDraft, value: string) {
    setManualLocationDraft(prev => ({ ...prev, [field]: value }));
  }

  async function saveManualLocation() {
    if (!canManageInventory) { setMessage("Tu usuario tiene acceso de solo lectura."); return; }
    if (!selectedSessionId) {
      setMessage("Selecciona un inventario.");
      return;
    }

    const locationCode = normalizeLocationCode(manualLocationDraft.location_code);
    if (!locationCode) {
      setMessage("Ingresa el ticket o codigo de ubicacion.");
      return;
    }

    const fullLocation = manualFullLocation;
    const row = {
      session_id: selectedSessionId,
      location_code: locationCode,
      ticket: locationCode,
      zone: manualLocationDraft.zone.trim() || null,
      zone_ref: manualLocationDraft.zone_ref.trim() || null,
      lineal: manualLocationDraft.lineal.trim() || null,
      reference: manualLocationDraft.reference.trim() || null,
      full_location: fullLocation || null,
      description: fullLocation || null,
      is_active: true,
    };

    setSavingManualLocation(true);
    const { data, error } = await supabase
      .from("general_inventory_locations")
      .upsert(row, { onConflict: "session_id,location_code" })
      .select("*")
      .single();
    setSavingManualLocation(false);

    if (error) {
      setMessage("No se pudo guardar la ubicacion: " + error.message);
      return;
    }

    if (data) {
      setLocations(prev => {
        const nextRow = data as InventoryLocation;
        const exists = prev.some(location => location.id === nextRow.id || normalizeLocationCode(location.location_code) === locationCode);
        if (exists) {
          return prev
            .map(location => location.id === nextRow.id || normalizeLocationCode(location.location_code) === locationCode ? nextRow : location)
            .sort((a, b) => String(a.location_code).localeCompare(String(b.location_code), "es", { numeric: true, sensitivity: "base" }));
        }
        return [...prev, nextRow].sort((a, b) => String(a.location_code).localeCompare(String(b.location_code), "es", { numeric: true, sensitivity: "base" }));
      });
    } else {
      await loadPreparationData(selectedSessionId);
    }

    setManualLocationDraft({
      location_code: "",
      zone: "",
      zone_ref: "",
      lineal: "",
      reference: "",
    });
    setMessage(`Ubicacion ${locationCode} guardada.`);
  }

  async function freezeStock() {
    await saveStockSnapshot("Congelando stock. Este proceso puede tardar varios minutos si es la primera vez.", "Stock congelado");
  }

  async function updateStockSnapshot() {
    if (selectedSession?.status === "frozen") {
      const ok = confirm("Este inventario ya tiene una foto de stock congelada. Si aceptas, se reemplazara por el stock actual y esa nueva foto quedara congelada para los reportes posteriores.");
      if (!ok) return;
    }
    await saveStockSnapshot("Actualizando stock actual y congelando nueva foto.", "Stock actualizado y congelado");
  }

  async function saveStockSnapshot(progressMessage: string, successLabel: string) {
    if (!canManageInventory) { setMessage("Tu usuario tiene acceso de solo lectura."); return; }
    if (!user || !selectedSessionId) return;
    setLoading(true);
    setSummaryLoading(true);
    setMessage(progressMessage);
    try {
      const { data, error } = await supabase.rpc("freeze_general_inventory_stock", {
        p_session_id: selectedSessionId,
        p_user_id: user.id,
      });
      if (error) {
        const shouldFallback = error.message.toLowerCase().includes("statement timeout") || error.message.toLowerCase().includes("canceling statement");
        if (!shouldFallback) {
          setMessage("No se pudo actualizar stock: " + error.message);
          return;
        }
        setMessage("La actualizacion directa demoro demasiado. Continuo por lotes para evitar timeout...");
        const fallbackInserted = await saveStockSnapshotInBatches(selectedSessionId, user.id, successLabel);
        if (fallbackInserted === null) return;
      } else {
        const { count: productsWithStockCount } = await supabase
          .from("general_inventory_stock_snapshot")
          .select("id", { count: "exact", head: true })
          .eq("session_id", selectedSessionId)
          .gt("system_stock", 0);
        setMessage(`${successLabel}. Codigos en foto: ${data || 0}. Con stock: ${productsWithStockCount || 0}.`);
      }
      await loadInitial(selectedSessionId);
      setValidatorTab("resumen");
      await loadSummary(selectedSessionId, true);
    } finally {
      setLoading(false);
      setSummaryLoading(false);
    }
  }

  async function saveStockSnapshotInBatches(sessionId: string, userId: string, successLabel: string) {
    const session = sessions.find(row => row.id === sessionId) || selectedSession;
    const store = stores.find(row => row.id === session?.store_id);
    const sede = store?.erp_sede || store?.name || session?.store_name || "";
    if (!sede) {
      setMessage("No se pudo actualizar stock por lotes: no encontre la sede ERP del inventario.");
      return null;
    }

    const nonInventoryRows = await loadInventoryNonInventoryRows(sessionId);
    const nonInventorySkus = new Set(nonInventoryRows.map(row => normalizeCode(row.sku).toUpperCase()));
    const deleteRes = await supabase
      .from("general_inventory_stock_snapshot")
      .delete()
      .eq("session_id", sessionId);
    if (deleteRes.error) {
      setMessage("No se pudo limpiar la foto anterior de stock: " + deleteRes.error.message);
      return null;
    }

    let inserted = 0;
    let totalValue = 0;
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const stockRes = await supabase
        .from("stock_general")
        .select("codsap,stock,costo")
        .eq("sede", sede)
        .gt("stock", 0)
        .order("codsap", { ascending: true })
        .range(from, from + pageSize - 1);
      if (stockRes.error) {
        setMessage("No se pudo leer stock por lotes: " + stockRes.error.message);
        return null;
      }

      const stockRows = (stockRes.data || []) as StockGeneralRow[];
      if (stockRows.length === 0) break;
      const stockBySku = new Map<string, StockGeneralRow>();
      for (const row of stockRows) {
        const sku = normalizeCode(row.codsap).toUpperCase();
        if (sku && !nonInventorySkus.has(sku)) stockBySku.set(sku, row);
      }

      const skus = [...stockBySku.keys()];
      for (let i = 0; i < skus.length; i += 500) {
        const chunk = skus.slice(i, i + 500);
        const productsRes = await supabase
          .from("cyclic_products")
          .select("id,sku,description,unit,cost,is_active")
          .eq("is_active", true)
          .in("sku", chunk);
        if (productsRes.error) {
          setMessage("No se pudo cruzar stock con maestro de productos: " + productsRes.error.message);
          return null;
        }
        const rows = ((productsRes.data || []) as Product[]).map(product => {
          const stock = stockBySku.get(normalizeCode(product.sku).toUpperCase());
          const systemStock = Number(stock?.stock || 0);
          const cost = Number(stock?.costo ?? product.cost ?? 0);
          totalValue += systemStock * cost;
          return {
            session_id: sessionId,
            product_id: product.id,
            sku: product.sku,
            description: product.description,
            unit: product.unit,
            system_stock: systemStock,
            cost,
            frozen_at: new Date().toISOString(),
          };
        });
        if (rows.length > 0) {
          const upsertRes = await supabase
            .from("general_inventory_stock_snapshot")
            .upsert(rows, { onConflict: "session_id,product_id" });
          if (upsertRes.error) {
            setMessage("No se pudo guardar stock por lotes: " + upsertRes.error.message);
            return null;
          }
          inserted += rows.length;
          setMessage(`Actualizando stock por lotes... ${inserted} codigos cargados.`);
        }
      }

      if (stockRows.length < pageSize) break;
      from += pageSize;
    }

    const sessionUpdate = await supabase
      .from("general_inventory_sessions")
      .update({
        status: "frozen",
        frozen_by: userId,
        stock_frozen_at: new Date().toISOString(),
        frozen_total_value: Math.round(totalValue * 100) / 100,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sessionId);
    if (sessionUpdate.error) {
      setMessage("Stock cargado, pero no se pudo congelar la sesion: " + sessionUpdate.error.message);
      return null;
    }

    setMessage(`${successLabel}. Codigos en foto: ${inserted}. Con stock: ${inserted}.`);
    return inserted;
  }

  async function finishSession() {
    if (!canManageInventory) { setMessage("Tu usuario tiene acceso de solo lectura."); return; }
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
      const currentSessionOperator = await supabase
        .from("general_inventory_session_operators")
        .select("id,status")
        .eq("session_id", selectedSession.id)
        .eq("operator_id", operatorRow.id)
        .maybeSingle();

      if (currentSessionOperator.data?.status === "active") {
        if (operatorRow.password && operatorRow.password !== operatorPassword.trim()) {
          setMessage("Este celular ya esta registrado en esta sesion. Ingresa con su clave correcta desde el login principal.");
          return;
        }
        setOperator(operatorRow);
        localStorage.setItem(OPERATOR_KEY, JSON.stringify(operatorRow));
        localStorage.setItem(SESSION_KEY, selectedSession.id);
        setMessage(`Bienvenido, ${operatorRow.full_name}.`);
        await Promise.all([loadPreparationData(selectedSession.id), loadRecordsData(selectedSession.id, operatorRow.id)]);
        return;
      }

      if (operatorRow.full_name !== operatorName.trim() || operatorRow.password !== operatorPassword.trim()) {
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
    await Promise.all([loadPreparationData(selectedSession.id), loadRecordsData(selectedSession.id, operatorRow.id)]);
  }

  async function findProductCandidates(query: string, mode: ProductLookupMode = "typed"): Promise<{ products: Product[]; message: string }> {
    const text = query.trim();
    const raw = normalizeCode(text).toUpperCase();
    if (!raw || !selectedSessionId) return { products: [], message: "" };
    const isNumericSearch = /^\d+$/.test(raw);
    const shouldSearchDescription = mode === "typed" && !isNumericSearch;

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      const cachedProducts = await findCachedProductsByCode(raw);
      if (cachedProducts.length === 0) return { products: [], message: "Codigo no encontrado en el catalogo offline descargado." };
      return {
        products: (cachedProducts as Product[]).sort((a, b) => codeMatchRank(a, raw) - codeMatchRank(b, raw) || a.sku.localeCompare(b.sku, "es", { numeric: true })),
        message: cachedProducts.length > 1 ? "El codigo coincide con varios productos offline. Elige una tarjeta antes de guardar." : "",
      };
    }

    const productMap = new Map<string, Product>();

    if (shouldSearchDescription) {
      const words = searchWords(text);
      if (words.length > 0) {
        let descriptionQuery = supabase
          .from("cyclic_products")
          .select("*")
          .eq("is_active", true);
        for (const word of words) descriptionQuery = descriptionQuery.ilike("description", `%${word}%`);
        const { data } = await descriptionQuery.limit(500);
        for (const product of (data || []) as Product[]) productMap.set(product.sku, product);
      }
    } else if (mode === "scan") {
      const [byUpc, byAlu] = await Promise.all([
        supabase.from("codigos_barra").select("codsap,upc,alu").eq("upc", raw).not("codsap", "is", null).limit(20),
        supabase.from("codigos_barra").select("codsap,upc,alu").eq("alu", raw).not("codsap", "is", null).limit(20),
      ]).catch(async () => {
        const cachedProducts = await findCachedProductsByCode(raw);
        return [
          { data: cachedProducts.map(product => ({ codsap: product.sku, upc: null, alu: null })) },
          { data: [] },
        ];
      });
      const mapped = [...(byUpc.data || []), ...(byAlu.data || [])].map(row => row.codsap).filter(Boolean);
      const candidateSkus = [...new Set([raw, ...mapped])];

      const { data } = await supabase
        .from("cyclic_products")
        .select("*")
        .eq("is_active", true)
        .or(`sku.eq.${raw},barcode.eq.${raw}`);
      for (const product of (data || []) as Product[]) productMap.set(product.sku, product);

      if (candidateSkus.length > 0) {
        const { data: mappedProducts } = await supabase
          .from("cyclic_products")
          .select("*")
          .in("sku", candidateSkus)
          .eq("is_active", true)
          .limit(20);
        for (const product of (mappedProducts || []) as Product[]) productMap.set(product.sku, product);
      }
    } else {
      const [byUpc, byAlu] = await Promise.all([
        supabase.from("codigos_barra").select("codsap,upc,alu").eq("upc", raw).not("codsap", "is", null).limit(20),
        supabase.from("codigos_barra").select("codsap,upc,alu").eq("alu", raw).not("codsap", "is", null).limit(20),
      ]).catch(async () => {
        const cachedProducts = await findCachedProductsByCode(raw);
        return [
          { data: cachedProducts.map(product => ({ codsap: product.sku, upc: null, alu: null })) },
          { data: [] },
        ];
      });
      const mapped = [...(byUpc.data || []), ...(byAlu.data || [])].map(row => row.codsap).filter(Boolean);
      const candidateSkus = [...new Set([raw, ...mapped])];

      const { data } = await supabase
        .from("cyclic_products")
        .select("*")
        .in("sku", candidateSkus)
        .eq("is_active", true)
        .limit(20);
      for (const product of (data || []) as Product[]) productMap.set(product.sku, product);

      if (raw.length >= 4) {
        const suffix = raw.slice(-5);
        const { data } = await supabase
          .from("cyclic_products")
          .select("*")
          .eq("is_active", true)
          .or(`sku.ilike.%${suffix},barcode.ilike.%${suffix},sku.ilike.%${raw}%,barcode.ilike.%${raw}%`)
          .limit(80);
        for (const product of (data || []) as Product[]) productMap.set(product.sku, product);
      }
    }

    let usedDescriptionFallback = false;
    if (mode === "typed" && isNumericSearch && productMap.size === 0) {
      const { data } = await supabase
        .from("cyclic_products")
        .select("*")
        .eq("is_active", true)
        .ilike("description", `%${raw}%`)
        .limit(80);
      for (const product of (data || []) as Product[]) productMap.set(product.sku, product);
      usedDescriptionFallback = productMap.size > 0;
    }

    const products = [...productMap.values()];
    if (products.length === 0) {
      return {
        products: [],
        message: shouldSearchDescription
          ? "No encontre productos por esa descripcion."
          : "Codigo no existe en el maestro ni en codigos de barra.",
      };
    }

    const nonInvSkus = await loadNonInventorySkuSetForProducts(selectedSessionId, products.map(product => product.sku));
    const allowed = products.filter(product => !nonInvSkus.has(normalizeCode(product.sku).toUpperCase()));

    if (allowed.length === 0) {
      return { products: [], message: "Este codigo esta en la lista de no inventariables y no puede registrarse." };
    }

    return {
      products: allowed.sort((a, b) => (shouldSearchDescription || usedDescriptionFallback)
        ? a.description.localeCompare(b.description, "es", { numeric: true, sensitivity: "base" }) || a.sku.localeCompare(b.sku, "es", { numeric: true })
        : codeMatchRank(a, raw) - codeMatchRank(b, raw) || a.sku.localeCompare(b.sku, "es", { numeric: true })),
      message: allowed.length > 1 ? "La busqueda coincide con varios productos. Elige una tarjeta antes de guardar." : "",
    };
  }

  async function saveCount() {
    if (savingCountRef.current) return;
    if (!operator || !selectedSession || !canOperatorEnter(selectedSession.status)) {
      setMessage("No hay inventario activo para registrar.");
      return;
    }

    const locCode = normalizeLocationCode(locationCode);
    let loc = findInventoryLocation(locations, locCode);
    if (!loc && navigator.onLine) {
      const freshLocationsRes = await supabase
        .from("general_inventory_locations")
        .select("*")
        .eq("session_id", selectedSession.id)
        .eq("is_active", true)
        .order("location_code");
      if (!freshLocationsRes.error) {
        const freshLocations = (freshLocationsRes.data || []) as InventoryLocation[];
        setLocations(freshLocations);
        loc = findInventoryLocation(freshLocations, locCode);
      }
    }
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
      const latestCandidates = selectedProduct ? productCandidates : (await findProductCandidates(productCode, productLookupModeRef.current)).products;
      const product = selectedProduct || (latestCandidates.length === 1 ? latestCandidates[0] : null);
      if (!product) {
        setProductCandidates(latestCandidates);
        setMessage(latestCandidates.length > 1 ? "Elige el producto correcto antes de guardar." : "Codigo no existe en el maestro ni en codigos de barra.");
        return;
      }

      const snapshot = navigator.onLine
        ? await supabase
          .from("general_inventory_stock_snapshot")
          .select("cost")
          .eq("session_id", selectedSession.id)
          .eq("product_id", product.id)
          .maybeSingle()
        : { data: null };

      const pendingEdit = editingCountId ? await getOfflineItem(editingCountId) : undefined;
      if (!navigator.onLine && editingCountId && !pendingEdit) {
        setMessage("Este registro ya esta sincronizado. Necesitas internet para editarlo.");
        return;
      }

      const clientUuid = pendingEdit?.clientUuid || createClientUuid("gi-count");
      const deviceId = pendingEdit?.deviceId || getOrCreateDeviceId();
      const now = new Date().toISOString();
      const countedAt = ((pendingEdit?.payload as { counted_at?: string } | undefined)?.counted_at) || now;
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
        updated_at: now,
      };
      const insertRow = {
        ...row,
        counted_at: countedAt,
        client_uuid: clientUuid,
        client_device_id: deviceId,
        sync_origin: navigator.onLine ? "web" : "pwa_offline",
      };

      if (!navigator.onLine) {
        await enqueueOfflineItem({
          localId: clientUuid,
          clientUuid,
          deviceId,
          module: "general_inventory",
          entity: "general_inventory_counts",
          operation: "insert",
          payload: insertRow,
          status: "pending",
          attempts: pendingEdit?.attempts || 0,
          createdAt: pendingEdit?.createdAt || now,
          updatedAt: now,
        });

        const localRow: CountRow = {
          id: clientUuid,
          ...row,
          counted_at: countedAt,
          operator_name: operator.full_name,
        };
        setCounts(prev => editingCountId
          ? prev.map(item => item.id === editingCountId ? localRow : item)
          : [localRow, ...prev]
        );
        setCountedLocationCodes(prev => prev.includes(loc.location_code) ? prev : [...prev, loc.location_code]);
        setProductCode("");
        setProductCandidates([]);
        setSelectedProduct(null);
        setProductLookupMessage("");
        setQuantity("");
        setEditingCountId(null);
        setMessage(editingCountId
          ? "Edicion guardada sin conexion. Se subira solo la ultima version."
          : "Conteo guardado sin conexion. Se sincronizara cuando vuelva internet."
        );
        return;
      }

      const request = editingCountId
        ? supabase.from("general_inventory_counts").update(row).eq("id", editingCountId)
        : supabase.from("general_inventory_counts").insert(insertRow);
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
      setCountedLocationCodes(prev => prev.includes(loc.location_code) ? prev : [...prev, loc.location_code]);
      if (isValidator) await loadSessionData(selectedSession.id, validatorTab);
      else await loadRecordsData(selectedSession.id, operator.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo guardar conteo.");
    } finally {
      savingCountRef.current = false;
      setSavingCount(false);
    }
  }

  function recountDraftFor(row: RecountItem) {
    return recountDrafts[row.id] || {
      productCode: row.sku,
      extraProductCode: "",
      rows: row.original_locations.length > 0
        ? row.original_locations.map(location => ({
          locationCode: location.location_code,
          quantity: "",
        }))
        : [{
          locationCode: "",
          quantity: "",
        }],
    };
  }

  function updateRecountDraft(rowId: string, field: "productCode" | "extraProductCode", value: string) {
    setRecountDrafts(prev => ({
      ...prev,
      [rowId]: {
        productCode: field === "productCode" ? value : prev[rowId]?.productCode || "",
        extraProductCode: field === "extraProductCode" ? value : prev[rowId]?.extraProductCode || "",
        rows: prev[rowId]?.rows || [],
      },
    }));
  }

  function updateRecountDraftLine(row: RecountItem, index: number, field: "locationCode" | "quantity", value: string) {
    setRecountDrafts(prev => {
      const current = prev[row.id] || recountDraftFor(row);
      const rows = current.rows.length > 0 ? [...current.rows] : [{ locationCode: "", quantity: "" }];
      rows[index] = {
        locationCode: rows[index]?.locationCode || "",
        quantity: rows[index]?.quantity || "",
        isExtra: rows[index]?.isExtra,
        [field]: value,
      };
      return { ...prev, [row.id]: { ...current, rows } };
    });
  }

  function addRecountDraftLine(row: RecountItem) {
    setRecountDrafts(prev => {
      const current = prev[row.id] || recountDraftFor(row);
      return {
        ...prev,
        [row.id]: {
          ...current,
          rows: [...current.rows, { locationCode: "", quantity: "", isExtra: true }],
        },
      };
    });
  }

  function clearRecountDraftLineQuantity(row: RecountItem, index: number) {
    updateRecountDraftLine(row, index, "quantity", "0");
  }

  function removeRecountDraftLine(row: RecountItem, index: number) {
    setRecountDrafts(prev => {
      const current = prev[row.id] || recountDraftFor(row);
      const rows = current.rows.filter((_, rowIndex) => rowIndex !== index);
      return { ...prev, [row.id]: { ...current, rows: rows.length > 0 ? rows : [{ locationCode: "", quantity: "" }] } };
    });
  }

  function editRecountRecord(record: OperatorRecountRecord) {
    const item = record.item;
    const relatedRecords = operatorRecountRecords
      .filter(row => row.recount_item_id === record.recount_item_id)
      .sort((a, b) => a.location_code.localeCompare(b.location_code, "es", { numeric: true, sensitivity: "base" }));
    const originalCodes = new Set(item.original_locations.map(location => normalizeLocationCode(location.location_code)));

    setRecountItems(prev => [item, ...prev.filter(row => row.id !== item.id)]);
    setRecountDrafts(prev => ({
      ...prev,
      [item.id]: {
        productCode: record.sku || item.sku,
        extraProductCode: "",
        rows: relatedRecords.map(row => ({
          locationCode: row.location_code,
          quantity: String(row.quantity),
          isExtra: !originalCodes.has(normalizeLocationCode(row.location_code)),
        })),
      },
    }));
    setEditingRecountItemId(item.id);
    setMessage("Reconteo cargado para editar.");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelRecountEdit(row: RecountItem) {
    setEditingRecountItemId(null);
    setRecountDrafts(prev => {
      const next = { ...prev };
      delete next[row.id];
      return next;
    });
    if (row.status === "counted") {
      setRecountItems(prev => prev.filter(item => item.id !== row.id));
    }
  }

  async function saveRecountValidation(row: RecountItem) {
    if (!operator || !selectedSessionId || savingRecountId) return;
    const draft = recountDraftFor(row);
    if (!draft.productCode.trim()) {
      setMessage("Ingresa codigo valido para el reconteo.");
      return;
    }

    const lines = draft.rows
      .map(line => ({
        locationCode: normalizeLocationCode(line.locationCode),
        quantity: Number(line.quantity),
        isExtra: Boolean(line.isExtra),
      }))
      .filter(line => line.locationCode || line.quantity > 0 || !line.isExtra);

    if (lines.length === 0) {
      setMessage("Ingresa al menos una ubicacion y cantidad para el reconteo.");
      return;
    }

    let availableLocations = locations;
    const locationRows: Array<{ loc: InventoryLocation | null; locationCode: string; quantity: number }> = [];
    for (const line of lines) {
      if (!line.locationCode) {
        if (row.recount_type === "missing" && line.quantity === 0) {
          locationRows.push({ loc: null, locationCode: "SIN_FISICO", quantity: 0 });
          continue;
        }
        setMessage("Completa la ubicacion en todas las lineas del reconteo.");
        return;
      }
      let loc = findInventoryLocation(availableLocations, line.locationCode);
      if (!loc && navigator.onLine) {
        const freshLocationsRes = await supabase
          .from("general_inventory_locations")
          .select("*")
          .eq("session_id", selectedSessionId)
          .eq("is_active", true)
          .order("location_code");
        if (!freshLocationsRes.error) {
          availableLocations = (freshLocationsRes.data || []) as InventoryLocation[];
          setLocations(availableLocations);
          loc = findInventoryLocation(availableLocations, line.locationCode);
        }
      }
      if (!loc) {
        setMessage(`Ubicacion ${line.locationCode} no autorizada para esta sesion.`);
        return;
      }
      if (!Number.isFinite(line.quantity) || line.quantity < 0) {
        setMessage("Ingresa cantidades validas para todas las lineas del reconteo.");
        return;
      }
      const existing = locationRows.find(item => normalizeLocationCode(item.locationCode) === normalizeLocationCode(loc.location_code));
      if (existing) existing.quantity += line.quantity;
      else locationRows.push({ loc, locationCode: loc.location_code, quantity: line.quantity });
    }

    setSavingRecountId(row.id);
    try {
      const normalizedDraftProductCode = normalizeCode(draft.productCode).toUpperCase();
      const normalizedAssignedSku = normalizeCode(row.sku).toUpperCase();
      const candidates = (await findProductCandidates(draft.productCode)).products;
      const assignedProductFallback: Product | null = normalizedDraftProductCode === normalizedAssignedSku
        ? {
          id: row.product_id,
          sku: row.sku,
          barcode: null,
          description: row.description,
          unit: row.unit,
          cost: row.cost_snapshot,
          is_active: true,
        }
        : null;
      const product = candidates.find(item => normalizeCode(item.sku).toUpperCase() === normalizedDraftProductCode) ||
        (candidates.length === 1 ? candidates[0] : null) ||
        assignedProductFallback;
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
      const deleteExisting = await supabase
        .from("general_inventory_recount_counts")
        .delete()
        .eq("recount_item_id", row.id);
      if (deleteExisting.error) {
        setMessage("No se pudo reemplazar el reconteo anterior: " + deleteExisting.error.message);
        return;
      }

      const rows = locationRows.map(({ loc, locationCode, quantity }) => ({
          recount_item_id: row.id,
          session_id: selectedSessionId,
          operator_id: operator.id,
          location_id: loc?.id || null,
          location_code: loc?.location_code || locationCode,
          product_id: product.id,
          sku: product.sku,
          description: product.description,
          unit: product.unit,
          quantity,
          cost_snapshot: cost,
          client_uuid: createClientUuid("gi-recount"),
          client_device_id: getOrCreateDeviceId(),
          sync_origin: "web",
          updated_at: new Date().toISOString(),
      }));
      const { error } = await supabase
        .from("general_inventory_recount_counts")
        .insert(rows);
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
      setEditingRecountItemId(null);
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

  function openAdminEditCount(row: CountRow) {
    setEditingAdminCount(row);
    setEditingAdminLocation(row.location_code || "");
    setEditingAdminQuantity(String(row.quantity || ""));
  }

  async function saveAdminEditCount() {
    if (!editingAdminCount) return;
    const qty = Number(editingAdminQuantity);
    const location = editingAdminLocation.trim().toUpperCase();
    if (!location || !Number.isFinite(qty) || qty < 0) {
      setMessage("Ingresa ubicacion y cantidad valida.");
      return;
    }

    const locationRow = locations.find(row => row.location_code.toUpperCase() === location);
    if (!locationRow) {
      setMessage("La ubicacion no esta cargada para esta sesion.");
      return;
    }

    const { error } = await supabase
      .from("general_inventory_counts")
      .update({
        location_id: locationRow.id,
        location_code: locationRow.location_code,
        quantity: qty,
        updated_at: new Date().toISOString(),
      })
      .eq("id", editingAdminCount.id);

    if (error) {
      setMessage("No se pudo actualizar registro: " + error.message);
      return;
    }

    setEditingAdminCount(null);
    setMessage("Registro actualizado.");
    await loadSessionData(editingAdminCount.session_id, "registros");
  }

  async function deleteCount(row: CountRow) {
    if (!canManageInventory) { setMessage("Tu usuario tiene acceso de solo lectura."); return; }
    const { error } = await supabase.from("general_inventory_counts").delete().eq("id", row.id);
    if (error) {
      setMessage("No se pudo eliminar: " + error.message);
      return;
    }
    await loadSessionData(row.session_id, isValidator ? validatorTab : "registros");
  }

  async function saveObservation(row: SummaryRow) {
    if (!canManageInventory) { setMessage("Tu usuario tiene acceso de solo lectura."); return; }
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
    await loadSummary(selectedSessionId, true);
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
    await loadSummary(selectedSessionId, true);
  }

  function exportRecords() {
    const rows = filteredCounts.map(row => ({
      FECHA: new Date(row.counted_at).toLocaleString("es-PE"),
      CONTADOR: row.operator_name || "",
      UBICACION: row.location_code,
      CODIGO: row.sku,
      DESCRIPCION: row.description,
      UM: row.unit,
      CANTIDAD: row.quantity,
      COSTO: row.cost_snapshot,
      VALOR: row.quantity * row.cost_snapshot,
    }));
    const counterRows = counterStats.rows.map(row => ({
      CONTADOR: row.name,
      REGISTROS: row.count,
      PRIMER_REGISTRO: Number.isFinite(row.first) ? new Date(row.first).toLocaleString("es-PE") : "",
      ULTIMO_REGISTRO: Number.isFinite(row.last) ? new Date(row.last).toLocaleString("es-PE") : "",
      MINUTOS: Number(row.minutes.toFixed(2)),
      REGISTROS_POR_MINUTO: Number(row.perMinute.toFixed(2)),
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Registros");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(counterRows), "Resumen contadores");
    XLSX.writeFile(wb, `inventario_registros_${selectedSession?.name || "sesion"}.xlsx`);
  }

  function exportSummary() {
    const rows = summary.map(row => ({
      CODIGO: row.sku,
      DESCRIPCION: row.description,
      UM: row.unit,
      STOCK_SISTEMA: row.system_stock,
      CONTEO: row.counted_original,
      RECONTEO: row.recounted_qty ?? "",
      DIFERENCIA: row.diff,
      COSTO: row.cost,
      DIF_VALORIZADA: row.valueDiff,
      RECONTADO: row.re_counted ? "SI" : "NO",
      OBSERVACION: row.observation || "",
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Resumen");
    XLSX.writeFile(wb, `inventario_resumen_${selectedSession?.name || "sesion"}.xlsx`);
  }

  async function saveInventoryNotes() {
    if (!canManageInventory) { setMessage("Tu usuario tiene acceso de solo lectura."); return; }
    if (!selectedSessionId) return;
    const notes = inventoryNotesDraft.trim();
    const { error } = await supabase
      .from("general_inventory_sessions")
      .update({ notes: notes || null, updated_at: new Date().toISOString() })
      .eq("id", selectedSessionId);
    if (error) {
      setMessage("No se pudieron guardar las notas: " + error.message);
      return;
    }
    setSessions(prev => prev.map(session => session.id === selectedSessionId ? { ...session, notes: notes || null } : session));
    setMessage("Notas del inventario guardadas.");
  }

  function generateGeneralInventoryReport() {
    if (!selectedSession) {
      setMessage("Selecciona un inventario para generar el informe.");
      return;
    }
    if (summary.length === 0) {
      setMessage("Carga o actualiza el resumen antes de generar el informe.");
      return;
    }

    const sortedByValue = [...summary].sort((a, b) => a.valueDiff - b.valueDiff);
    const diffRows = sortedByValue.filter(row => row.diff !== 0);
    const okRows = summary.filter(row => row.diff === 0 && row.counted > 0);
    const surplusRows = summary.filter(row => row.diff > 0);
    const missingRows = summary.filter(row => row.diff < 0);
    const notCountedRows = summary.filter(row => row.counted <= 0);
    const generatedAt = new Date().toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });
    const frozenAt = selectedSession.stock_frozen_at ? new Date(selectedSession.stock_frozen_at).toLocaleString("es-PE") : "-";
    const reportStartDate = dateOnly(selectedSession.scheduled_date || selectedSession.created_at);
    const reportEndDate = selectedSession.finished_at ? dateOnly(selectedSession.finished_at) : "En curso";
    const reportNotes = inventoryNotesDraft.trim() || selectedSession.notes || "";

    const diffTable = diffRows.map(row => `
      <tr>
        <td>${escapeHtml(row.sku)}</td>
        <td class="oneLine">${escapeHtml(row.description)}</td>
        <td>${escapeHtml(row.unit)}</td>
        <td class="num">${money(row.cost)}</td>
        <td class="num">${number2(row.system_stock)}</td>
        <td class="num">${number2(row.counted_original)}</td>
        <td class="num">${row.recounted_qty === null ? "-" : number2(row.recounted_qty)}</td>
        <td class="num ${row.diff < 0 ? "bad" : "warn"}">${number2(row.diff)}</td>
        <td class="num ${row.valueDiff < 0 ? "bad" : "warn"}">${money(row.valueDiff)}</td>
        <td class="num">${row.re_counted ? "Si" : "No"}</td>
        <td class="oneLine">${escapeHtml(row.observation || "")}</td>
      </tr>
    `).join("");

    const donut = (label: string, value: number, color: string, detail: string) => `
      <div class="donutCard">
        <svg class="donutSvg" viewBox="0 0 64 64" width="48" height="48" xmlns="http://www.w3.org/2000/svg" aria-label="${Math.round(value)}%">
          <circle cx="32" cy="32" r="24" fill="#ffffff" stroke="#cbd5e1" stroke-width="8"/>
          <circle cx="32" cy="32" r="24" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"
            stroke-dasharray="${Math.max(0, Math.min(100, value)) * 1.508} 150.8" transform="rotate(-90 32 32)"/>
          <circle cx="32" cy="32" r="17" fill="#ffffff" stroke="#ffffff" stroke-width="1"/>
          <text x="32" y="36" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="900" fill="#0f172a">${Math.round(value)}%</text>
        </svg>
        <div>
          <strong>${escapeHtml(label)}</strong>
          <span>${escapeHtml(detail)}</span>
        </div>
      </div>
    `;

    const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Informe inventario general - ${escapeHtml(selectedSession.name)}</title>
  <style>
    @page { size: A4 portrait; margin: 9mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #0f172a; font-family: Arial, sans-serif; font-size: 9px; }
    h1 { margin: 0; font-size: 17px; }
    h2 { margin: 8px 0 4px; font-size: 11px; }
    .muted { color: #64748b; }
    .header { display: flex; justify-content: space-between; gap: 14px; border-bottom: 1px solid #0f172a; padding-bottom: 8px; }
    .meta { text-align: right; line-height: 1.4; }
    .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin: 7px 0; }
    .card { border: 1px solid #cbd5e1; border-radius: 6px; padding: 6px; background: #f8fafc; }
    .label { color: #64748b; font-size: 9px; font-weight: 700; }
    .value { margin-top: 1px; font-size: 13px; font-weight: 800; }
    .donuts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 7px 0; }
    .donutCard { display: flex; align-items: center; gap: 7px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 5px; }
    .donutSvg { display: block; flex: 0 0 auto; }
    .donutCard strong { display: block; font-size: 10px; }
    .donutCard span { display: block; color: #64748b; margin-top: 2px; }
    .summaryGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .notesBox { min-height: 62px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 6px; white-space: pre-wrap; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #cbd5e1; padding: 2px 3px; line-height: 1.12; vertical-align: top; }
    th { background: #f1f5f9; font-size: 9px; text-align: left; }
    .diffTable th, .diffTable td { padding: 1px 2px; line-height: 1.05; }
    .oneLine { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .num { text-align: right; white-space: nowrap; }
    .ok { color: #15803d; font-weight: 800; }
    .bad { color: #b91c1c; font-weight: 800; }
    .warn { color: #1d4ed8; font-weight: 800; }
    .signatures { display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px; margin-top: 24px; break-inside: avoid; }
    .signature { border-top: 1px solid #0f172a; padding-top: 20px; text-align: center; font-weight: 800; }
    button { margin-top: 8px; padding: 7px 10px; border: 1px solid #0f172a; border-radius: 8px; background: #0f172a; color: white; font-weight: 800; }
    @media print {
      button { display: none; }
      .cards, .donuts, .summaryGrid { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Informe de inventario general</h1>
      <div class="muted">Inventario: <strong>${escapeHtml(selectedSession.name)}</strong></div>
      <div class="muted">Tienda: <strong>${escapeHtml(selectedSession.store_name || selectedSession.store_id)}</strong></div>
      <div class="muted">Fecha: <strong>${escapeHtml(reportStartDate || "-")} - ${escapeHtml(reportEndDate)}</strong></div>
    </div>
    <div class="meta">
      <div>Estado: <strong>${escapeHtml(statusLabel(selectedSession.status))}</strong></div>
      <div>Stock congelado: <strong>${escapeHtml(frozenAt)}</strong></div>
      <div>Generado: <strong>${escapeHtml(generatedAt)}</strong></div>
      <button onclick="window.print()">Imprimir / guardar PDF</button>
    </div>
  </div>

  <div class="donuts">
    ${donut("AVANCE POR SKU", kpis.skuProgress, "#0f172a", `${kpis.countedCodes} / ${kpis.totalCodes} codigos`)}
    ${donut("AVANCE POR VALORIZADO", kpis.valueProgress, "#1d4ed8", `${money(kpis.systemValue)} base`)}
    ${donut("ERI", kpis.eri, "#16a34a", `${okRows.length} codigos OK`)}
  </div>

  <div class="cards">
    <div class="card"><div class="label">Codigos totales</div><div class="value">${number2(kpis.totalCodes)}</div></div>
    <div class="card"><div class="label">Codigos OK</div><div class="value ok">${number2(okRows.length)}</div></div>
    <div class="card"><div class="label">No contados</div><div class="value">${number2(notCountedRows.length)}</div></div>
    <div class="card"><div class="label">Faltantes valorizados</div><div class="value bad">${money(kpis.missingValue)}</div></div>
    <div class="card"><div class="label">Sobrantes valorizados</div><div class="value warn">${money(kpis.surplusValue)}</div></div>
    <div class="card"><div class="label">Diferencia valorizada</div><div class="value ${kpis.diffValue < 0 ? "bad" : "warn"}">${money(kpis.diffValue)}</div></div>
  </div>

  <div class="summaryGrid">
    <div>
      <h2>Resumen por resultado</h2>
      <table>
        <thead><tr><th>Resultado</th><th class="num">Codigos</th><th class="num">Valor</th></tr></thead>
        <tbody>
          <tr><td class="ok">OK</td><td class="num">${number2(okRows.length)}</td><td class="num">-</td></tr>
          <tr><td class="bad">Faltantes</td><td class="num">${number2(missingRows.length)}</td><td class="num bad">${money(kpis.missingValue)}</td></tr>
          <tr><td class="warn">Sobrantes</td><td class="num">${number2(surplusRows.length)}</td><td class="num warn">${money(kpis.surplusValue)}</td></tr>
          <tr><td>No contados</td><td class="num">${number2(notCountedRows.length)}</td><td class="num">-</td></tr>
        </tbody>
      </table>
    </div>
    <div>
      <h2>Notas del validador</h2>
      <div class="notesBox">${reportNotes ? escapeHtml(reportNotes) : "Sin notas registradas."}</div>
    </div>
  </div>

  <h2>Todas las diferencias sobrantes y faltantes (${number2(diffRows.length)})</h2>
  <table class="diffTable">
    <thead>
      <tr>
        <th style="width:62px">Codigo</th>
        <th>Descripcion</th>
        <th style="width:25px">UM</th>
        <th style="width:52px" class="num">Costo</th>
        <th style="width:44px" class="num">Sistema</th>
        <th style="width:42px" class="num">Conteo</th>
        <th style="width:46px" class="num">Reconteo</th>
        <th style="width:40px" class="num">Dif.</th>
        <th style="width:60px" class="num">Valorizado</th>
        <th style="width:46px" class="num">Recontado</th>
        <th style="width:70px">Obs.</th>
      </tr>
    </thead>
    <tbody>
      ${diffTable || `<tr><td colspan="11" style="text-align:center;color:#64748b">Sin diferencias para mostrar.</td></tr>`}
    </tbody>
  </table>

  <div class="signatures">
    <div class="signature">Firma asesor de almacen</div>
    <div class="signature">Firma lider de tienda</div>
    <div class="signature">Firma validador de inventario</div>
  </div>
</body>
</html>`;

    const reportWindow = window.open("", "_blank");
    if (!reportWindow) {
      setMessage("El navegador bloqueo la ventana del informe. Permite ventanas emergentes e intenta otra vez.");
      return;
    }
    reportWindow.document.open();
    reportWindow.document.write(html);
    reportWindow.document.close();
    reportWindow.focus();
    setTimeout(() => reportWindow.print(), 500);
  }

  async function generateRecountCommitmentDocuments() {
    if (!selectedSession) {
      setMessage("Selecciona un inventario para generar las actas de reconteo.");
      return;
    }
    if (!selectedSessionId) return;

    let query = supabase
      .from("general_inventory_recount_counts")
      .select("id,recount_item_id,operator_id,location_id,location_code,sku,description,unit,quantity,cost_snapshot,counted_at,general_inventory_operators(id,full_name,phone)")
      .eq("session_id", selectedSessionId)
      .order("operator_id", { ascending: true })
      .order("counted_at", { ascending: false });
    if (recountPrintOperatorId) query = query.eq("operator_id", recountPrintOperatorId);
    const { data, error } = await query;

    if (error) {
      setMessage("No se pudieron leer los reconteos guardados: " + error.message);
      return;
    }

    const recountCountRows = (data || []) as any[];
    const recountProductIds = [...new Set(recountCountRows.map(row => String(row.product_id || "")).filter(Boolean))];
    const originalByLocation = await loadOriginalCountedByProductLocation(selectedSessionId, recountProductIds);
    const itemById = new Map(recountItems.map(row => [row.id, row]));
    const locationById = new Map(locations.map(row => [row.id, row]));
    const documentRows = recountCountRows
      .map((countRow: any) => {
        const item = itemById.get(String(countRow.recount_item_id));
        if (!item) return null;
        const operatorName = countRow.general_inventory_operators?.full_name || item.assigned_operator_name || "Sin asesor";
        const location = locationById.get(String(countRow.location_id || "")) ||
          findInventoryLocation(locations, countRow.location_code || "");
        const fullLocation = location?.full_location || location?.description || countRow.location_code || item.full_location || item.location_code || "Por codigo";
        return {
          ...item,
          location_code: countRow.location_code || item.location_code,
          full_location: fullLocation,
          sku: countRow.sku || item.sku,
          description: countRow.description || item.description,
          unit: countRow.unit || item.unit,
          recount_count_id: String(countRow.id),
          recount_operator_id: String(countRow.operator_id),
          recount_operator_name: operatorName,
          recount_quantity: Number(countRow.quantity || 0),
          recount_original_quantity: originalByLocation.get(`${String(countRow.product_id || item.product_id || "")}__id__${String(countRow.location_id || "")}`) ??
            originalByLocation.get(`${String(countRow.product_id || item.product_id || "")}__code__${normalizeLocationCode(countRow.location_code)}`) ??
            0,
          recount_counted_at: String(countRow.counted_at || ""),
        } as RecountDocumentRow;
      })
      .filter(Boolean) as RecountDocumentRow[];

    if (documentRows.length === 0) {
      setMessage(recountPrintOperatorId ? "Ese recontador aun no tiene reconteos guardados para generar el documento." : "Aun no hay reconteos guardados por asesores para generar el documento.");
      return;
    }

    const grouped = new Map<string, { operatorName: string; recountType: RecountType; rows: RecountDocumentRow[] }>();
    for (const row of documentRows) {
      const key = `${row.recount_operator_id}__${row.recount_type}`;
      if (!grouped.has(key)) grouped.set(key, { operatorName: row.recount_operator_name, recountType: row.recount_type, rows: [] });
      grouped.get(key)?.rows.push(row);
    }

    const generatedAt = new Date().toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });
    const pages = [...grouped.values()].map((group, index) => {
      const orderedRows = [...group.rows].sort((a, b) =>
        new Date(b.recount_counted_at || 0).getTime() - new Date(a.recount_counted_at || 0).getTime()
      );
      const recountDate = orderedRows[0]?.recount_counted_at
        ? new Date(orderedRows[0].recount_counted_at).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" })
        : generatedAt;
      const rowsHtml = orderedRows.map((row, rowIndex) => `
        <tr>
          <td class="num">${rowIndex + 1}</td>
          <td class="num">${row.recount_counted_at ? escapeHtml(new Date(row.recount_counted_at).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", hour12: false })) : "-"}</td>
          <td>${escapeHtml(row.full_location || row.location_code || "Por codigo")}</td>
          <td>${escapeHtml(row.sku)}</td>
          <td>${escapeHtml(row.description)}</td>
          <td>${escapeHtml(row.unit)}</td>
          <td class="num">${number2(row.recount_original_quantity)}</td>
          <td class="num">${number2(row.recount_quantity)}</td>
          <td>${escapeHtml(row.recount_type === "missing" ? "Faltante" : "Sobrante")}</td>
        </tr>
      `).join("");

      return `
        <section class="page ${index > 0 ? "pageBreak" : ""}">
          <div class="header">
            <div>
              <h1>Reconteo de ${group.recountType === "missing" ? "faltantes" : "sobrantes"} - tienda ${escapeHtml(selectedSession.store_name || selectedSession.store_id)}</h1>
              <div class="muted">Inventario: <strong>${escapeHtml(selectedSession.name)}</strong></div>
              <div class="muted">Tienda: <strong>${escapeHtml(selectedSession.store_name || selectedSession.store_id)}</strong></div>
            </div>
            <div class="meta">
              <div>Fecha de reconteo: <strong>${escapeHtml(recountDate)}</strong></div>
              <div>Generado: <strong>${escapeHtml(generatedAt)}</strong></div>
              <div>Registros: <strong>${number2(orderedRows.length)}</strong></div>
            </div>
          </div>

          <div class="operatorBox">
            <div class="field"><span>Nombre del recontador</span><strong>${escapeHtml(group.operatorName)}</strong></div>
            <div class="field"><span>Fecha de reconteo</span><strong>${escapeHtml(recountDate)}</strong></div>
            <div class="field"><span>Tipo / registros</span><strong>${escapeHtml(group.recountType === "missing" ? "Faltantes" : "Sobrantes")} - ${number2(orderedRows.length)}</strong></div>
          </div>

          <h2>Registros guardados</h2>
          <table>
            <thead>
              <tr>
                <th style="width:26px" class="num">#</th>
                <th style="width:40px" class="num">Hora</th>
                <th style="width:145px">Ubicacion</th>
                <th style="width:70px">Codigo</th>
                <th>Descripcion</th>
                <th style="width:34px">UM</th>
                <th style="width:50px" class="num">Conteo</th>
                <th style="width:56px" class="num">Reconteo</th>
                <th style="width:58px">Tipo</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>

          <div class="signatureGrid">
            <div class="signature">Firma recontador</div>
            <div class="signature">Firma lider de tienda</div>
          </div>
        </section>
      `;
    }).join("");

    const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Actas de reconteo - ${escapeHtml(selectedSession.name)}</title>
  <style>
    @page { size: A4 landscape; margin: 10mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #0f172a; font-family: Arial, sans-serif; font-size: 10px; }
    h1 { margin: 0; font-size: 18px; }
    h2 { margin: 10px 0 5px; font-size: 12px; }
    .page { min-height: 190mm; display: flex; flex-direction: column; }
    .pageBreak { break-before: page; }
    .header { display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid #0f172a; padding-bottom: 8px; }
    .muted { color: #64748b; line-height: 1.45; }
    .meta { text-align: right; line-height: 1.5; }
    .operatorBox { display: grid; grid-template-columns: 1.4fr .9fr .7fr; gap: 6px; margin: 10px 0; }
    .field { border: 1px solid #cbd5e1; border-radius: 6px; padding: 6px; min-height: 42px; }
    .field span { display: block; color: #64748b; font-size: 9px; font-weight: 800; text-transform: uppercase; }
    .field strong { display: block; margin-top: 4px; font-size: 11px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #cbd5e1; padding: 3px; line-height: 1.15; vertical-align: top; word-wrap: break-word; }
    th { background: #f1f5f9; text-align: left; font-size: 9px; }
    .num { text-align: right; white-space: nowrap; }
    .signatureGrid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 34px; margin-top: auto; padding-top: 18mm; break-inside: avoid; page-break-inside: avoid; }
    .signature { border-top: 1px solid #0f172a; padding-top: 22px; text-align: center; font-weight: 800; }
    .toolbar { position: sticky; top: 0; margin-bottom: 8px; padding: 8px; background: white; border-bottom: 1px solid #cbd5e1; }
    button { padding: 7px 10px; border: 1px solid #0f172a; border-radius: 8px; background: #0f172a; color: white; font-weight: 800; }
    @media print {
      .toolbar { display: none; }
      .page { break-inside: auto; }
    }
  </style>
</head>
<body>
  <div class="toolbar"><button onclick="window.print()">Imprimir / guardar PDF</button></div>
  ${pages}
</body>
</html>`;

    const reportWindow = window.open("", "_blank");
    if (!reportWindow) {
      setMessage("El navegador bloqueo las actas de reconteo. Permite ventanas emergentes e intenta otra vez.");
      return;
    }
    reportWindow.document.open();
    reportWindow.document.write(html);
    reportWindow.document.close();
    reportWindow.focus();
    setTimeout(() => reportWindow.print(), 500);
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

  function renderManualLocationForm() {
    return (
      <div className="rounded-2xl border bg-white p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-black text-slate-900">Agregar ubicacion</h3>
            <p className="text-xs text-slate-500">Mismas columnas del Excel; la ubicacion concatenada se calcula sola.</p>
          </div>
          <button
            onClick={saveManualLocation}
            disabled={savingManualLocation || !selectedSessionId}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:opacity-40"
          >
            <Save size={16} /> {savingManualLocation ? "Guardando" : "Guardar"}
          </button>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-black text-slate-500">Ticket / codigo</span>
            <input
              value={manualLocationDraft.location_code}
              onChange={event => updateManualLocationDraft("location_code", event.target.value.toUpperCase())}
              placeholder="Ej. A-01-03"
              className="w-full rounded-xl border px-3 py-3 text-sm font-bold uppercase"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-black text-slate-500">Ubicacion</span>
            <input
              value={manualLocationDraft.zone}
              onChange={event => updateManualLocationDraft("zone", event.target.value.toUpperCase())}
              placeholder="Bloque / area"
              className="w-full rounded-xl border px-3 py-3 text-sm font-bold uppercase"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-black text-slate-500">Zona ref</span>
            <input
              value={manualLocationDraft.zone_ref}
              onChange={event => updateManualLocationDraft("zone_ref", event.target.value.toUpperCase())}
              placeholder="Zona"
              className="w-full rounded-xl border px-3 py-3 text-sm font-bold uppercase"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-black text-slate-500">Lineal</span>
            <input
              value={manualLocationDraft.lineal}
              onChange={event => updateManualLocationDraft("lineal", event.target.value.toUpperCase())}
              placeholder="Lineal"
              className="w-full rounded-xl border px-3 py-3 text-sm font-bold uppercase"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-black text-slate-500">Referencia</span>
            <input
              value={manualLocationDraft.reference}
              onChange={event => updateManualLocationDraft("reference", event.target.value.toUpperCase())}
              placeholder="Referencia"
              className="w-full rounded-xl border px-3 py-3 text-sm font-bold uppercase"
            />
          </label>
          <label className="block md:col-span-2 xl:col-span-1">
            <span className="mb-1 block text-xs font-black text-slate-500">Ubicacion concatenada</span>
            <input
              value={manualFullLocation}
              readOnly
              placeholder="Se genera automaticamente"
              className="w-full rounded-xl border bg-slate-50 px-3 py-3 text-sm font-bold uppercase text-slate-600"
            />
          </label>
        </div>
      </div>
    );
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
          {(user?.role === "Administrador" || user?.role === "Supervisor") && (
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
          {canManageInventory && (
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

          {canManageInventory && selectedSessionId && (
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
              {renderManualLocationForm()}
              <div className="rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-800">
                Los no inventariables se toman automaticamente desde la base de datos global.
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
                {canManageInventory && <button onClick={() => setValidatorTab("preparacion")} className={`rounded-xl px-3 py-2 text-xs font-black ${validatorTab === "preparacion" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                  Preparacion
                </button>}
                <button onClick={() => setValidatorTab("registros")} className={`rounded-xl px-3 py-2 text-xs font-black ${validatorTab === "registros" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                  Registros
                </button>
                {canManageInventory && <button onClick={() => setValidatorTab("reconteo")} className={`rounded-xl px-3 py-2 text-xs font-black ${validatorTab === "reconteo" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                  Reconteo
                </button>}
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

          {canManageInventory && validatorTab === "preparacion" && (
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
                    Ubicaciones: {locations.length} | Pendientes: {pendingLocations.length} | Vacias: {emptyLocations.length}
                  </div>
                </div>

                <div className="grid gap-4">
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

                  {renderManualLocationForm()}

                  <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-800">
                    No inventariables: se excluyen automaticamente usando la base global de codigos no inventariables.
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border bg-slate-50 p-4 text-sm">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-black text-slate-900">Ubicaciones pendientes</div>
                      <div className="text-xs text-slate-500">Ubicaciones cargadas que todavía no tienen registros.</div>
                    </div>
                    <div className="text-xs font-black text-slate-600">{pendingLocations.length} pendientes | {emptyLocations.length} vacias</div>
                  </div>
                  <div className="max-h-[420px] overflow-auto rounded-xl border bg-white">
                    {pendingLocations.length > 0 ? pendingLocations.map(location => (
                      <div key={location.id} className="grid gap-2 border-b p-3 last:border-b-0 md:grid-cols-[140px_1fr_auto]">
                        <div className="font-black text-slate-900">{location.location_code}</div>
                        <div className="min-w-0 text-slate-600">
                          <div className="truncate">{location.full_location || location.description || "Sin descripción"}</div>
                          {(location.zone || location.lineal || location.zone_ref) && (
                            <div className="mt-1 text-xs text-slate-400">
                              {[location.zone, location.lineal, location.zone_ref].filter(Boolean).join(" | ")}
                            </div>
                          )}
                        </div>
                        <div className="flex items-start justify-end">
                          <button
                            onClick={() => markLocationEmpty(location)}
                            disabled={savingEmptyLocationId === location.id}
                            className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-[11px] font-black text-amber-700 hover:bg-amber-100 disabled:opacity-40"
                          >
                            {savingEmptyLocationId === location.id ? "Guardando" : "Vacia"}
                          </button>
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
                  <input ref={productInputRef} value={productCode} onChange={event => { setProductLookupMode("typed"); productLookupModeRef.current = "typed"; setProductCode(event.target.value); }} placeholder="Codigo, barra o descripcion" className="min-w-0 flex-1 rounded-lg px-3 py-3 text-base outline-none" />
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
                            <div className="whitespace-normal break-words text-sm font-semibold text-slate-700">{product.description}</div>
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
                        <div className="max-w-full whitespace-normal break-words text-sm text-slate-600">{row.description}</div>
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
                  return (
                  <article key={row.id} className="rounded-2xl border bg-slate-50 p-4">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-black text-slate-950">{row.sku}</div>
                        <div className="whitespace-normal break-words text-sm font-semibold text-slate-700">{row.description}</div>
                        {row.unit && <div className="mt-1 text-xs font-black text-slate-900">UM: {row.unit}</div>}
                        {editingRecountItemId === row.id && <div className="mt-1 text-xs font-black text-amber-700">Editando reconteo guardado</div>}
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-black ${row.recount_type === "missing" ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-700"}`}>
                        {row.recount_type === "missing" ? "Faltante" : "Sobrante"}
                      </span>
                    </div>
                    <div className="space-y-2 text-xs text-slate-600">
                      <div className="rounded-xl border bg-white p-3 text-sm font-black text-slate-800">
                        Ubicaciones contadas: {row.location_count || row.original_locations.length || (row.recount_type === "missing" ? 1 : 0)}
                      </div>
                      <div className="hidden">
                        <div className="font-black text-slate-900">{row.location_code || "Sin ubicación"}</div>
                        <div className="truncate">{row.full_location || "Reconteo por código"}</div>
                        {(row.zone || row.lineal || row.zone_ref) && <div className="mt-1 text-slate-400">{[row.zone, row.lineal, row.zone_ref].filter(Boolean).join(" | ")}</div>}
                      </div>
                      <div className="grid grid-cols-5 gap-1 rounded-xl border bg-white p-2 text-center">
                        <MiniMetric label="Sistema" value={row.system_stock} compact />
                        <MiniMetric label="Contado" value={row.counted_qty} compact />
                        <MiniMetric label="Dif." value={row.diff_qty} compact />
                        <MiniMetric label="Ubics." value={row.location_count || row.original_locations.length || (row.recount_type === "missing" ? 1 : 0)} compact />
                        <MiniMetric label="Dif. val." value={money(row.value_diff)} compact />
                      </div>
                      <div className="grid gap-2">
                        <div>
                          <label className="mb-1 block text-[11px] font-black text-slate-500">Codigo validado</label>
                          <div className="flex rounded-xl border bg-white p-1">
                            <input value={draft.productCode} onChange={event => updateRecountDraft(row.id, "productCode", event.target.value)} placeholder="Codigo final" className="min-w-0 flex-1 rounded-lg px-3 py-2 text-sm font-bold outline-none" />
                            <button onClick={() => openRecountScanner(row.id, "recount_product")} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-slate-900 text-white transition active:scale-95" title="Escanear producto">
                              <QrCode size={18} />
                            </button>
                          </div>
                        </div>
                        <div className="rounded-xl border bg-white p-3">
                          <div className="mb-2 font-black text-slate-900">Ubicaciones a validar</div>
                          <div className="space-y-2">
                            {draft.rows.map((line, index) => {
                              const original = row.original_locations.find(item => normalizeLocationCode(item.location_code) === normalizeLocationCode(line.locationCode));
                              return (
                                <div key={`${row.id}-${index}`} className="rounded-lg border bg-slate-50 p-2">
                                  <div className="mb-1 flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                      <div className="whitespace-normal break-words text-base font-black text-slate-950">
                                        {line.isExtra ? "Ubicacion extra" : original?.full_location || line.locationCode || "Ubicacion"}
                                      </div>
                                      {!line.isExtra && (
                                        <div className="mt-0.5 text-[11px] font-bold text-slate-500">
                                          Ticket: {original?.location_code || line.locationCode || "-"}
                                        </div>
                                      )}
                                    </div>
                                    {line.isExtra && (
                                      <button onClick={() => removeRecountDraftLine(row, index)} className="rounded-md border px-2 py-1 text-[11px] font-black text-red-600">
                                        Quitar
                                      </button>
                                    )}
                                  </div>
                                  {original && (
                                    <div className="mb-2 rounded-xl border bg-white px-3 py-2">
                                      <div className="text-[10px] font-black uppercase text-slate-500">Conteo original</div>
                                      <div className="text-2xl font-black leading-tight text-slate-950">{number2(original.counted_qty)} <span className="text-sm font-black text-slate-900">{row.unit}</span></div>
                                    </div>
                                  )}
                                  <div className="grid grid-cols-[1fr_110px_42px] gap-2">
                                    <input value={line.locationCode} onChange={event => updateRecountDraftLine(row, index, "locationCode", event.target.value.toUpperCase())} placeholder="Ubicacion" className="min-w-0 rounded-xl border bg-white px-3 py-2 text-sm font-bold outline-none" />
                                    <input value={line.quantity} onChange={event => updateRecountDraftLine(row, index, "quantity", event.target.value)} placeholder="Cant." inputMode="decimal" className="min-w-0 rounded-xl border bg-white px-3 py-2 text-sm font-bold outline-none" />
                                    <button onClick={() => openRecountScanner(row.id, "recount_location", index)} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-slate-900 text-white transition active:scale-95" title="Escanear ubicacion">
                                      <QrCode size={18} />
                                    </button>
                                  </div>
                                  {!line.isExtra && (
                                    <button onClick={() => clearRecountDraftLineQuantity(row, index)} className="mt-2 w-full rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-black text-red-700">
                                      No se encontro en esta ubicacion
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          <button onClick={() => addRecountDraftLine(row)} className="mt-2 w-full rounded-xl border px-3 py-2 text-xs font-black text-slate-700">
                            + Agregar ubicacion
                          </button>
                        </div>
                        <div className="flex justify-end gap-2">
                          {editingRecountItemId === row.id && (
                            <button onClick={() => cancelRecountEdit(row)} className="rounded-xl border px-4 py-3 text-sm font-black text-slate-700">
                              Cancelar
                            </button>
                          )}
                          <button onClick={() => saveRecountValidation(row)} disabled={savingRecountId === row.id} className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                            {savingRecountId === row.id ? "Guardando" : editingRecountItemId === row.id ? "Guardar edición" : "Guardar reconteo"}
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
              <div className="mt-4 rounded-2xl border bg-white">
                <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                  <div>
                    <h3 className="font-black text-slate-900">Reconteos guardados</h3>
                    <p className="text-xs text-slate-500">Registro de lo que vas guardando en esta sesión.</p>
                  </div>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-600">{operatorRecountRecords.length}</span>
                </div>
                <div className="divide-y">
                  {operatorRecountRecords.map(record => (
                    <div key={record.id} className="p-3">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-black text-slate-900">{record.location_code || "Sin ubicación"}</span>
                            <span className="font-black text-blue-700">{record.sku}</span>
                          </div>
                          <div className="max-w-full whitespace-normal break-words text-sm text-slate-600">{record.description}</div>
                          <div className="mt-1 text-xs text-slate-400">{record.counted_at ? new Date(record.counted_at).toLocaleString("es-PE") : "-"} · {record.unit}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-xl font-black text-slate-950">{number2(record.quantity)}</div>
                          <button onClick={() => editRecountRecord(record)} className="mt-1 rounded-lg border px-2 py-1 text-xs font-black">Editar</button>
                        </div>
                      </div>
                    </div>
                  ))}
                  {operatorRecountRecords.length === 0 && (
                    <div className="p-8 text-center text-sm font-semibold text-slate-400">Aún no tienes reconteos guardados.</div>
                  )}
                </div>
              </div>
            </section>
          )}

          {canManageInventory && selectedSessionId && validatorTab === "reconteo" && (
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
                    <button onClick={assignSelectedRecountRows} disabled={selectedPendingRecountRows.length === 0} className="rounded-xl border px-4 py-3 text-sm font-black text-slate-800 disabled:opacity-40">
                      Asignar seleccionados
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 lg:grid-cols-[180px_1fr_1fr_220px]">
                  <div className="grid grid-cols-2 overflow-hidden rounded-xl border p-1">
                    <button onClick={() => changeRecountType("surplus")} className={`rounded-lg px-3 py-2 text-xs font-black ${recountType === "surplus" ? "bg-blue-700 text-white" : "text-slate-600"}`}>Sobrantes</button>
                    <button onClick={() => changeRecountType("missing")} className={`rounded-lg px-3 py-2 text-xs font-black ${recountType === "missing" ? "bg-red-600 text-white" : "text-slate-600"}`}>Faltantes</button>
                  </div>

                  <div className="grid gap-2">
                    <select value={recountValue} onChange={event => setRecountValue(event.target.value)} disabled={recountType === "missing"} className="rounded-xl border bg-white px-3 py-3 text-sm disabled:opacity-40">
                      <option value="">Selecciona ubicacion</option>
                      {recountValues.map(value => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </div>

                  <select value={recountOperatorId} onChange={event => setRecountOperatorId(event.target.value)} className="rounded-xl border bg-white px-3 py-3 text-sm">
                    <option value="">Operador</option>
                    {sessionOperators.map(row => <option key={row.id} value={row.id}>{row.full_name}</option>)}
                  </select>

                  <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm font-black text-slate-700">
                    {unassignedRecountCandidates.length} pendientes | {activeAssignedRecountCount} asignados
                  </div>
                </div>
                <p className="mt-3 text-xs font-bold text-slate-500">Orden operativo: sobrantes por mayor diferencia valorizada y faltantes por menor diferencia valorizada.</p>
              </section>

              <div className="grid overflow-hidden rounded-2xl border bg-white p-1 shadow-sm md:grid-cols-3">
                <button
                  onClick={() => setRecountManagerTab("pendientes")}
                  className={`rounded-xl px-4 py-3 text-sm font-black ${recountManagerTab === "pendientes" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
                >
                  Pendientes por asignar ({unassignedRecountCandidates.length})
                </button>
                <button
                  onClick={() => setRecountManagerTab("asignados")}
                  className={`rounded-xl px-4 py-3 text-sm font-black ${recountManagerTab === "asignados" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
                >
                  Reconteos asignados ({assignedRecountRows.length})
                </button>
                <button
                  onClick={() => setRecountManagerTab("registros")}
                  className={`rounded-xl px-4 py-3 text-sm font-black ${recountManagerTab === "registros" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
                >
                  Registros guardados ({filteredAdminRecountRecords.length})
                </button>
              </div>

              {recountManagerTab === "pendientes" && (
              <section className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-black">Codigos pendientes por asignar</h3>
                  <div className="text-xs font-bold text-slate-500">{selectedPendingRecountRows.length} seleccionadas</div>
                </div>
                <div className="overflow-auto rounded-xl border">
                  <table className="w-full min-w-[1160px] text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="p-2 text-center">
                          <input
                            type="checkbox"
                            checked={allPendingRecountRowsSelected}
                            onChange={toggleAllPendingRecountSelection}
                            aria-label="Seleccionar todos los pendientes visibles"
                          />
                        </th>
                        <th className="p-2 text-left">Tipo</th>
                        <th className="p-2 text-left">Ticket</th>
                        <th className="p-2 text-left">Ubicacion</th>
                        <th className="p-2 text-center">Ubics.</th>
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
                          <td className="p-2 text-center">
                            <input
                              type="checkbox"
                              checked={selectedPendingRecountKeys.has(recountKey(row))}
                              onChange={() => togglePendingRecountSelection(recountKey(row))}
                              aria-label={`Seleccionar ${row.sku}`}
                            />
                          </td>
                          <td className="p-2 font-black">
                            <span className={row.recount_type === "missing" ? "text-red-600" : "text-blue-700"}>
                              {row.recount_type === "missing" ? "Faltante" : "Sobrante"}
                            </span>
                          </td>
                          <td className="p-2 font-black">{row.ticket || "-"}</td>
                          <td className="p-2">{row.location_code || "Por codigo"}</td>
                          <td className="p-2 text-center font-black">{row.location_count || row.original_locations.length || (row.recount_type === "missing" ? 1 : 0)}</td>
                          <td className="p-2">{row.zone || "-"}</td>
                          <td className="p-2 font-black text-slate-950">{row.sku}</td>
                          <td className="max-w-sm whitespace-normal break-words p-2 text-slate-700">{row.description}</td>
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
                          <td colSpan={14} className="p-8 text-center text-sm text-slate-400">
                            No hay codigos pendientes para asignar con el filtro actual.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
              )}

              {recountManagerTab === "asignados" && (
              <section className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-black">Codigos asignados / reasignar</h3>
                  <div className="flex flex-wrap gap-2">
                    <select
                      value={recountPrintOperatorId}
                      onChange={event => setRecountPrintOperatorId(event.target.value)}
                      className="rounded-xl border bg-white px-3 py-2 text-xs font-black text-slate-700"
                      title="Filtrar actas por recontador"
                    >
                      <option value="">Todos los recontadores</option>
                      {sessionOperators.map(operatorRow => (
                        <option key={operatorRow.id} value={operatorRow.id}>{operatorRow.full_name}</option>
                      ))}
                    </select>
                    <button
                      onClick={generateRecountCommitmentDocuments}
                      disabled={assignedRecountRows.length === 0}
                      className="inline-flex items-center gap-1 rounded-xl bg-slate-900 px-3 py-2 text-xs font-black text-white disabled:opacity-40"
                    >
                      <Download size={15} /> Actas por asesor
                    </button>
                    <button
                      onClick={deleteAllAssignedRecountCounts}
                      disabled={!assignedRecountRows.some(row => row.status === "counted")}
                      className="inline-flex items-center gap-1 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-black text-red-700 disabled:opacity-40"
                    >
                      <Trash2 size={14} /> Borrar guardados
                    </button>
                  </div>
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
                          <td className="p-2">
                            <div className="max-w-[260px] space-y-1">
                              {row.original_locations.length > 0 ? row.original_locations.map(location => (
                                <div key={location.id} className="rounded-lg border bg-slate-50 px-2 py-1">
                                  <div className="font-black text-slate-900">{location.full_location || location.location_code}</div>
                                  <div className="text-[10px] font-bold text-slate-500">
                                    {location.ticket || location.location_code} · {number2(location.counted_qty)} {row.unit}
                                  </div>
                                </div>
                              )) : (
                                <span>{row.full_location || row.location_code || "Por codigo"}</span>
                              )}
                            </div>
                          </td>
                          <td className="p-2 font-black text-slate-950">{row.sku}</td>
                          <td className="max-w-sm whitespace-normal break-words p-2 text-slate-700">{row.description}</td>
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
                              {row.status === "counted" && (
                                <button
                                  onClick={() => deleteAssignedRecountCounts(row)}
                                  className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-black text-red-700"
                                >
                                  Borrar
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                      {assignedRecountRows.length === 0 && (
                        <tr>
                          <td colSpan={12} className="p-8 text-center text-sm text-slate-400">
                            No hay reconteos asignados con ese filtro.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
              )}

              {recountManagerTab === "registros" && (
              <section className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-black">Registros guardados de reconteo</h3>
                    <p className="text-xs text-slate-500">Edicion y borrado por linea de lo registrado por los recontadores.</p>
                  </div>
                  <div className="flex min-w-[260px] flex-1 items-center rounded-xl border px-3 py-2 md:max-w-md">
                    <Search size={16} className="shrink-0 text-slate-400" />
                    <input
                      value={recountRecordsQuery}
                      onChange={event => setRecountRecordsQuery(event.target.value)}
                      placeholder="Buscar codigo, descripcion, ubicacion o recontador"
                      className="min-w-0 flex-1 px-2 text-sm outline-none"
                    />
                  </div>
                  <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-600">{filteredAdminRecountRecords.length}</div>
                </div>
                <div className="overflow-auto rounded-xl border">
                  <table className="w-full min-w-[1460px] text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="p-2 text-left">Contador</th>
                        <th className="p-2 text-center">Ult. edicion</th>
                        <th className="p-2 text-left">Tipo</th>
                        <th className="p-2 text-left">Ubicacion</th>
                        <th className="p-2 text-left">Codigo</th>
                        <th className="p-2 text-left">Descripcion</th>
                        <th className="p-2 text-center">UM</th>
                        <th className="p-2 text-center">Cantidad</th>
                        <th className="p-2 text-center">Sistema</th>
                        <th className="p-2 text-center">Conteo</th>
                        <th className="p-2 text-center">Dif.</th>
                        <th className="p-2 text-center">Costo</th>
                        <th className="p-2 text-center">Dif. val.</th>
                        <th className="p-2 text-center">Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAdminRecountRecords.map(record => (
                        <tr key={record.id} className="border-t">
                          <td className="p-2 font-black text-slate-800">{record.operator_name || "Sin recontador"}</td>
                          <td className="p-2 text-center text-slate-500">{record.updated_at ? new Date(record.updated_at).toLocaleString("es-PE") : "-"}</td>
                          <td className={`p-2 font-black ${record.item.recount_type === "missing" ? "text-red-600" : "text-blue-700"}`}>
                            {record.item.recount_type === "missing" ? "Faltante" : "Sobrante"}
                          </td>
                          <td className="p-2 font-black text-slate-800">{record.location_code || "Sin ubicacion"}</td>
                          <td className="p-2 font-black text-slate-950">{record.sku}</td>
                          <td className="max-w-sm whitespace-normal break-words p-2 text-slate-700">{record.description}</td>
                          <td className="p-2 text-center">{record.unit}</td>
                          <td className="p-2 text-center font-black">{number2(record.quantity)}</td>
                          <td className="p-2 text-center">{number2(record.item.system_stock)}</td>
                          <td className="p-2 text-center">{number2(record.original_quantity || 0)}</td>
                          <td className="p-2 text-center font-black">{number2(record.item.diff_qty)}</td>
                          <td className="p-2 text-center">{money(record.cost_snapshot)}</td>
                          <td className="p-2 text-center font-black">{money(record.item.value_diff)}</td>
                          <td className="p-2">
                            <div className="flex justify-center gap-1">
                              <button onClick={() => openAdminEditRecountRecord(record)} className="rounded-lg border px-2 py-1 text-xs font-black">Editar</button>
                              <button onClick={() => deleteAdminRecountRecord(record)} className="rounded-lg border border-red-200 px-2 py-1 text-xs font-black text-red-700">Borrar</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {filteredAdminRecountRecords.length === 0 && (
                        <tr>
                          <td colSpan={14} className="p-8 text-center text-sm text-slate-400">Aun no hay registros guardados de reconteo.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
              )}

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
                          <div className="whitespace-normal break-words text-sm font-semibold text-slate-700">{row.description}</div>
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
                <div>
                  <h2 className="font-black">Dashboard de inventario</h2>
                  {summaryHasPendingChanges && (
                    <div className="mt-1 text-xs font-black text-amber-600">Hay nuevos registros. Actualiza KPIs cuando necesites refrescar el resumen.</div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => loadSummary(selectedSessionId, true)} disabled={summaryLoading} className={`inline-flex items-center gap-1 rounded-xl px-3 py-2 text-xs font-black disabled:opacity-40 ${summaryHasPendingChanges ? "bg-amber-500 text-white" : "border"}`}>
                    {summaryLoading ? "Actualizando..." : summaryHasPendingChanges ? "Actualizar cambios" : "Actualizar KPIs"}
                  </button>
                  {canManageInventory && (
                    <button onClick={updateStockSnapshot} disabled={loading || summaryLoading} className="inline-flex items-center gap-1 rounded-xl bg-blue-700 px-3 py-2 text-xs font-black text-white disabled:opacity-40">
                      <RefreshCw size={14} /> Actualizar stock
                    </button>
                  )}
                  <button onClick={generateGeneralInventoryReport} className="inline-flex items-center gap-1 rounded-xl bg-slate-900 px-3 py-2 text-xs font-black text-white"><Download size={15} /> Informe PDF</button>
                  <button onClick={exportSummary} className="inline-flex items-center gap-1 rounded-xl bg-green-700 px-3 py-2 text-xs font-black text-white"><Download size={15} /> Resumen</button>
                </div>
              </div>
              <div className="grid gap-4">
                <div className="grid gap-4 lg:grid-cols-3">
                  <DonutKpi label="AVANCE POR SKU" value={kpis.skuProgress} detail={`${kpis.countedCodes} / ${kpis.totalCodes} codigos`} />
                  <DonutKpi label="AVANCE POR VALORIZADO" value={kpis.valueProgress} detail={`${money(kpis.countedValue)} de ${money(kpis.systemValue)} total`} tone="blue" />
                  <DonutKpi label="ERI" value={kpis.eri} detail={`${summary.filter(row => row.diff === 0 && row.counted > 0).length} OK / ${kpis.totalCodes} total`} tone="green" />
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                  <Kpi label="Codigos totales" value={kpis.totalCodes} />
                  <Kpi label="Codigos contados" value={kpis.countedCodes} tone="green" />
                  <Kpi label="Codigos OK" value={summary.filter(row => row.diff === 0 && row.counted > 0).length} />
                  <Kpi label="No contados" value={kpis.notCountedCodes} tone="amber" />
                  <Kpi label="Codigos con diferencia" value={kpis.codesWithDifference} tone={kpis.codesWithDifference > 0 ? "amber" : "slate"} />
                </div>
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                <ValueBarKpi label="Sobrantes valorizados" value={kpis.surplusValue} maxValue={Math.max(Math.abs(kpis.surplusValue), Math.abs(kpis.missingValue), 1)} tone="blue" />
                <ValueBarKpi label="Faltantes valorizados" value={kpis.missingValue} maxValue={Math.max(Math.abs(kpis.surplusValue), Math.abs(kpis.missingValue), 1)} tone="red" />
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Kpi label="Valor sistema" value={money(kpis.systemValue)} />
                <Kpi label="Códigos sobrantes" value={kpis.surplusCodes} tone="blue" />
                <Kpi label="Códigos faltantes" value={kpis.missingCodes} tone="red" />
                <Kpi label="Diferencia valorizada" value={money(kpis.diffValue)} tone={kpis.diffValue < 0 ? "red" : "blue"} />
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
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex min-w-[220px] flex-1 items-center rounded-xl border px-3 py-2 md:w-96">
                    <Search size={16} className="text-slate-400" />
                    <input value={recordsQuery} onChange={event => setRecordsQuery(event.target.value)} placeholder="Buscar código, descripción o ubicación" className="min-w-0 flex-1 px-2 text-sm outline-none" />
                  </div>
                  <button onClick={exportRecords} disabled={filteredCounts.length === 0} className="inline-flex items-center gap-1 rounded-xl bg-green-700 px-3 py-2 text-xs font-black text-white disabled:opacity-40">
                    <Download size={15} /> Descargar Excel
                  </button>
                </div>
              </div>
            </div>
            <div className="overflow-auto">
              <table className="w-full min-w-[920px] text-sm">
                <thead className="bg-slate-100 text-xs text-slate-600">
                  <tr>
                    <SortHeader label="Fecha" active={recordsSort.key === "counted_at"} direction={recordsSort.direction} onClick={() => toggleRecordsSort("counted_at")} />
                    <SortHeader label="Contador" active={recordsSort.key === "operator_name"} direction={recordsSort.direction} onClick={() => toggleRecordsSort("operator_name")} align="left" />
                    <SortHeader label="Ubicacion" active={recordsSort.key === "location_code"} direction={recordsSort.direction} onClick={() => toggleRecordsSort("location_code")} />
                    <SortHeader label="Codigo" active={recordsSort.key === "sku"} direction={recordsSort.direction} onClick={() => toggleRecordsSort("sku")} />
                    <SortHeader label="Descripcion" active={recordsSort.key === "description"} direction={recordsSort.direction} onClick={() => toggleRecordsSort("description")} align="left" />
                    <SortHeader label="UM" active={recordsSort.key === "unit"} direction={recordsSort.direction} onClick={() => toggleRecordsSort("unit")} />
                    <SortHeader label="Cantidad" active={recordsSort.key === "quantity"} direction={recordsSort.direction} onClick={() => toggleRecordsSort("quantity")} />
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
                      <td className="max-w-md whitespace-normal break-words p-2 text-slate-700">{row.description}</td>
                      <td className="p-2 text-center">{row.unit}</td>
                      <td className="p-2 text-center font-black">{number2(row.quantity)}</td>
                      <td className="p-2 text-center">
                        {(operator?.id === row.operator_id || isValidator) && (
                          <div className="flex justify-center gap-1">
                            {operator?.id === row.operator_id && !isValidator && (
                              <button onClick={() => editCount(row)} className="rounded-lg border px-2 py-1 text-xs font-black">Editar</button>
                            )}
                            {isValidator && (
                              <button onClick={() => openAdminEditCount(row)} className="rounded-lg border px-2 py-1 text-xs font-black">Editar</button>
                            )}
                            {canManageInventory && (
                              <button onClick={() => deleteCount(row)} className="rounded-lg border px-2 py-1 text-red-600"><Trash2 size={14} /></button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                  {filteredCounts.length === 0 && (
                    <tr><td colSpan={8} className="p-8 text-center text-sm text-slate-400">Sin registros.</td></tr>
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
              <div className="border-b px-4 pb-4">
                <div className="rounded-2xl border bg-slate-50 p-3">
                  <label className="text-xs font-black text-slate-500">Notas del validador para el informe</label>
                  <textarea
                    value={inventoryNotesDraft}
                    onChange={event => setInventoryNotesDraft(event.target.value)}
                    className="mt-2 min-h-20 w-full rounded-xl border bg-white px-3 py-2 text-sm outline-none focus:border-slate-500"
                    placeholder="Escribe observaciones generales del inventario, incidencias, criterios aplicados o acuerdos con tienda."
                  />
                  <div className="mt-2 flex justify-end">
                    <button onClick={saveInventoryNotes} className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-black text-white">
                      Guardar notas
                    </button>
                  </div>
                </div>
              </div>
              <div className="overflow-auto">
                <table className="w-full min-w-[1320px] text-sm">
                  <thead className="bg-slate-100 text-xs text-slate-600">
                    <tr>
                      <SortHeader label="Código" active={summarySort.key === "sku"} direction={summarySort.direction} onClick={() => toggleSummarySort("sku")} align="left" />
                      <SortHeader label="Descripción" active={summarySort.key === "description"} direction={summarySort.direction} onClick={() => toggleSummarySort("description")} align="left" />
                      <SortHeader label="UM" active={summarySort.key === "unit"} direction={summarySort.direction} onClick={() => toggleSummarySort("unit")} />
                      <SortHeader label="Sistema" active={summarySort.key === "system_stock"} direction={summarySort.direction} onClick={() => toggleSummarySort("system_stock")} />
                      <SortHeader label="Conteo" active={summarySort.key === "counted_original"} direction={summarySort.direction} onClick={() => toggleSummarySort("counted_original")} />
                      <SortHeader label="Reconteo" active={summarySort.key === "recounted_qty"} direction={summarySort.direction} onClick={() => toggleSummarySort("recounted_qty")} />
                      <SortHeader label="Dif." active={summarySort.key === "diff"} direction={summarySort.direction} onClick={() => toggleSummarySort("diff")} />
                      <SortHeader label="Costo" active={summarySort.key === "cost"} direction={summarySort.direction} onClick={() => toggleSummarySort("cost")} />
                      <SortHeader label="Dif. Val." active={summarySort.key === "valueDiff"} direction={summarySort.direction} onClick={() => toggleSummarySort("valueDiff")} />
                      <th className="p-2 text-center">Recontado</th>
                      <SortHeader label="Observación" active={summarySort.key === "observation"} direction={summarySort.direction} onClick={() => toggleSummarySort("observation")} align="left" />
                      <th className="p-2">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSummary.map(row => (
                      <tr key={row.product_id} className="border-b">
                        <td className="p-2 font-black">{row.sku}</td>
                        <td className="max-w-sm whitespace-normal break-words p-2">{row.description}</td>
                        <td className="p-2 text-center">{row.unit}</td>
                        <td className="p-2 text-center">{number2(row.system_stock)}</td>
                        <td className="p-2 text-center font-bold">{number2(row.counted_original)}</td>
                        <td className="p-2 text-center font-bold">{row.recounted_qty === null ? "-" : number2(row.recounted_qty)}</td>
                        <td className={`p-2 text-center font-black ${row.diff < 0 ? "text-red-600" : row.diff > 0 ? "text-blue-700" : "text-green-700"}`}>{number2(row.diff)}</td>
                        <td className="p-2 text-center">{money(row.cost)}</td>
                        <td className={`p-2 text-center font-black ${row.valueDiff < 0 ? "text-red-600" : row.valueDiff > 0 ? "text-blue-700" : "text-green-700"}`}>{money(row.valueDiff)}</td>
                        <td className="p-2 text-center">
                          <span className={`rounded-full px-2 py-1 text-[11px] font-black ${row.re_counted ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"}`}>
                            {row.re_counted ? "Si" : "No"}
                          </span>
                        </td>
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

      {editingAdminCount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-3 sm:p-4">
          <div className="app-modal-panel w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
            <h3 className="font-black">Editar registro</h3>
            <p className="mt-1 whitespace-normal break-words text-sm text-slate-500">{editingAdminCount.sku} - {editingAdminCount.description}</p>
            <div className="mt-4 space-y-3">
              <input
                value={editingAdminLocation}
                onChange={event => setEditingAdminLocation(event.target.value.toUpperCase())}
                placeholder="Ubicacion / ticket"
                className="w-full rounded-xl border px-3 py-3 text-sm font-bold"
              />
              <input
                value={editingAdminQuantity}
                onChange={event => setEditingAdminQuantity(event.target.value)}
                placeholder="Cantidad"
                inputMode="decimal"
                className="w-full rounded-xl border px-3 py-3 text-sm font-bold"
              />
            </div>
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
              <button onClick={saveAdminEditCount} className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white">
                Guardar
              </button>
              <button onClick={() => setEditingAdminCount(null)} className="rounded-xl border px-4 py-3 text-sm font-black">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {editingAdminRecountRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-3 sm:p-4">
          <div className="app-modal-panel w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
            <h3 className="font-black">Editar registro de reconteo</h3>
            <p className="mt-1 whitespace-normal break-words text-sm text-slate-500">
              {editingAdminRecountRecord.sku} - {editingAdminRecountRecord.description}
            </p>
            <div className="mt-3 rounded-xl border bg-slate-50 p-3 text-xs text-slate-600">
              <div><strong>Recontador:</strong> {editingAdminRecountRecord.operator_name || "Sin recontador"}</div>
              <div><strong>Tipo:</strong> {editingAdminRecountRecord.item.recount_type === "missing" ? "Faltante" : "Sobrante"}</div>
              <div><strong>UM:</strong> {editingAdminRecountRecord.unit}</div>
            </div>
            <div className="mt-4 space-y-3">
              <input
                value={editingAdminRecountLocation}
                onChange={event => setEditingAdminRecountLocation(event.target.value.toUpperCase())}
                placeholder={editingAdminRecountRecord.item.recount_type === "missing" ? "Ubicacion / vacio si no hay fisico" : "Ubicacion / ticket"}
                className="w-full rounded-xl border px-3 py-3 text-sm font-bold"
              />
              <input
                value={editingAdminRecountQuantity}
                onChange={event => setEditingAdminRecountQuantity(event.target.value)}
                placeholder="Cantidad"
                inputMode="decimal"
                className="w-full rounded-xl border px-3 py-3 text-sm font-bold"
              />
            </div>
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
              <button onClick={saveAdminEditRecountRecord} className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white">
                Guardar
              </button>
              <button onClick={() => setEditingAdminRecountRecord(null)} className="rounded-xl border px-4 py-3 text-sm font-black">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {scannerTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-3 sm:p-4">
          <div className="app-modal-panel w-full max-w-lg rounded-2xl bg-white p-4 shadow-2xl">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-black">{scannerTarget === "product" ? "Escanear producto" : "Escanear ubicación"}</h3>
                <p className="text-xs text-slate-500">Apunta al código con la cámara.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={toggleTorch} className={`rounded-lg border px-3 py-2 text-sm font-black ${torchOn ? "bg-yellow-400 text-slate-900" : "bg-slate-900 text-white"}`} title="Linterna">
                  <Flashlight className="mr-2 inline" size={18} /> Linterna
                </button>
              </div>
            </div>
            <div className="relative overflow-hidden rounded-xl border bg-black">
              <div id={scannerContainerId} className={isIosDevice() ? "h-[340px] max-h-[48vh] min-h-[300px] w-full" : "min-h-[320px] w-full"} />
              {isIosDevice() && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
                  <div className="relative h-44 w-full max-w-sm border-2 border-white/90 bg-black/10 shadow-[0_0_0_999px_rgba(0,0,0,0.18)]">
                    <div className="absolute left-0 right-0 top-1/2 h-0.5 -translate-y-1/2 bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.9)]" />
                    <div className="absolute -left-1 -top-1 h-6 w-6 border-l-4 border-t-4 border-emerald-400" />
                    <div className="absolute -right-1 -top-1 h-6 w-6 border-r-4 border-t-4 border-emerald-400" />
                    <div className="absolute -bottom-1 -left-1 h-6 w-6 border-b-4 border-l-4 border-emerald-400" />
                    <div className="absolute -bottom-1 -right-1 h-6 w-6 border-b-4 border-r-4 border-emerald-400" />
                  </div>
                </div>
              )}
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

function MiniMetric({ label, value, compact = false }: { label: string; value: string | number; compact?: boolean }) {
  const displayValue = typeof value === "number" ? number2(value) : value;
  return (
    <div className={`rounded-xl bg-white text-center ${compact ? "p-1" : "p-2"}`}>
      <div className={`${compact ? "text-xs" : "text-sm"} font-black text-slate-950`}>{displayValue}</div>
      <div className="text-[10px] font-bold text-slate-500">{label}</div>
    </div>
  );
}

function DonutKpi({ label, value, detail, tone = "slate" }: { label: string; value: number; detail: string; tone?: "slate" | "blue" | "green" }) {
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

function ValueBarKpi({ label, value, maxValue, tone }: { label: string; value: number; maxValue: number; tone: "blue" | "red" }) {
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

function Kpi({ label, value, tone = "slate" }: { label: string; value: string | number; tone?: "slate" | "blue" | "red" | "amber" | "green" }) {
  const color = tone === "blue" ? "text-blue-700" : tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : tone === "green" ? "text-green-700" : "text-slate-900";
  const displayValue = typeof value === "number" ? number2(value) : value;
  return (
    <div className="rounded-xl border bg-slate-50 p-3 text-center">
      <div className={`text-xl font-black ${color}`}>{displayValue}</div>
      <div className="mt-1 text-xs font-bold text-slate-500">{label}</div>
    </div>
  );
}
