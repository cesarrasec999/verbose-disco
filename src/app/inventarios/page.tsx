"use client";

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardList, Download, FileLock2, Flashlight, FolderOpen, LockOpen, Plus, QrCode, Save, Search, ShieldCheck, Trash2, UserCheck, X } from "lucide-react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase/client";
import { createClientUuid, getOrCreateDeviceId } from "@/lib/offline/clientIdentity";
import { findCachedProductsByCode } from "@/lib/offline/catalogCache";
import { enqueueOfflineItem, getOfflineItem, listPendingOfflineItems, removeOfflineItem } from "@/lib/offline/pendingQueue";
import { useIsMobileAccess } from "@/lib/mobileAccess";
import { fetchDisabledModules, isModuleBlockedForUser } from "@/features/access/moduleFlags";
import ModuleDisabledScreen from "@/features/access/ModuleDisabledScreen";
import {
  fetchAllInventoryCounts,
  fetchInventoryNonInventoryRows,
  fetchNonInventorySkuSetForProducts,
  fetchOperatorCountsPage,
  fetchPagedSessionRows,
  fetchProductCategories,
  fetchProductRotationsForSession,
  fetchStockGeneralBySkuForSession,
  fetchSummaryRowsFromRpc,
} from "@/features/inventarios/api";
import { InventoryHeader } from "@/features/inventarios/components/InventoryHeader";
import { InventoryTabs } from "@/features/inventarios/components/InventoryTabs";
import { MiniMetric, SortHeader } from "@/features/inventarios/components/InventoryUi";
import { RegistrosModule } from "@/features/inventarios/modules/RegistrosModule";
import { ReconteoModule } from "@/features/inventarios/modules/ReconteoModule";
import { ResumenModule } from "@/features/inventarios/modules/ResumenModule";
import type {
  CountRow,
  CyclicUser,
  InventoryLocation,
  InventoryOperator,
  InventoryOperatorDraft,
  InventorySession,
  ManualLocationDraft,
  ManualRecountDraft,
  OperatorMode,
  OperatorRecountRecord,
  Product,
  ProductLookupMode,
  RecountAssignedSortKey,
  RecountAssignedStatusFilter,
  RecountCandidate,
  RecountDocumentRow,
  RecountDraft,
  RecountFilter,
  RecountItem,
  RecountLocationLine,
  RecountManagerTab,
  RecountType,
  ScannerTarget,
  SessionStatus,
  SortDirection,
  SortState,
  StockGeneralRow,
  Store,
  SummaryRow,
  SummarySortKey,
  ValidatorTab,
  RecordsSortKey,
} from "@/features/inventarios/types";
import {
  buildFullLocationFromParts,
  calculateActiveCounterMinutes,
  canOperatorEnter,
  codeMatchRank,
  compareLocationByZone,
  compareValues,
  COUNTER_ACTIVE_GAP_MINUTES,
  countRowKey,
  dateOnly,
  escapeHtml,
  findInventoryLocation,
  isIosDevice,
  locationZoneKey,
  money,
  normalizeCode,
  normalizeLocationCode,
  normalizePhone,
  number2,
  OPERATOR_RECORDS_PAGE_SIZE,
  operatorRecountItemMatchesQuery,
  readWorkbookMatrixFromBuffer,
  recordMatchesQuery,
  recountCandidateMatchesQuery,
  recountKey,
  scannerPermissionMessage,
  searchWords,
  sortOperatorRecountCards,
  sortRecountAssignmentLines,
  statusLabel,
  summaryStatus,
} from "@/features/inventarios/utils";

// Unico usuario autorizado para editar el stock de sistema de sesiones YA
// finalizadas (ver saveFinishedStockEdit). A proposito NO es "cualquier
// Administrador" -- hoy hay 2 cuentas con ese rol (Administrador Principal y
// Diana Apaico) y el usuario pidio explicitamente restringirlo a esta cuenta
// puntual, por id, no por rol.
const FINISHED_STOCK_EDITOR_USER_ID = "6640b556-8944-4921-8b13-c547c834fb05";
const OPERATOR_KEY = "general_inventory_operator";
const OPERATOR_MODE_KEY = "general_inventory_operator_mode";
const SESSION_KEY = "general_inventory_session_id";
const SUMMARY_PAGE_SIZE = 120;
const VALIDATOR_RECORDS_PAGE_SIZE = 120;
const RECOUNT_PAGE_SIZE = 80;
const FINISHED_REPORT_PAGE_SIZE = 50;

type SummaryCacheEntry = {
  rows: SummaryRow[];
  observationDrafts: Record<string, string>;
  cachedAt: number;
};

type ProductivityLayerRow = {
  layer: "recount" | "validation";
  operator_id: string;
  operator_name: string | null;
  product_id: string;
  sku: string;
};

type ProductivityAssignedRow = ProductivityLayerRow;

type FinishedGeneralInventoryReportRow = {
  session_id: string;
  inventory_name: string;
  store_id: string;
  store_name: string | null;
  scheduled_date: string | null;
  finished_at: string | null;
  finished_by_name: string | null;
  stock_frozen_at: string | null;
  duration_minutes: number;
  total_codes: number;
  counted_codes: number;
  ok_codes: number;
  no_counted_codes: number;
  surplus_codes: number;
  missing_codes: number;
  difference_codes: number;
  system_value: number;
  counted_value: number;
  surplus_value: number;
  missing_value: number;
  net_value_diff: number;
  abs_value_diff: number;
  eri_pct: number;
  sales_in_period: number | null;
  deviation_over_sales_pct: number | null;
};

function currentMonthStartISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function summaryRecountLabel(row: Pick<SummaryRow, "re_counted" | "recount_status">) {
  const status = row.recount_status || (row.re_counted ? "counted" : "no");
  if (status === "counted") return "Si";
  if (status === "assigned") return "Asignado";
  return "-";
}

function summaryQuantityStatusLabel(value: number | null, status: "no" | "assigned" | "counted" | undefined) {
  if (status === "assigned") return "Asignado";
  if (status === "counted") return value === null ? "-" : number2(value);
  return "-";
}

export default function InventariosPage() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [moduleDisabled, setModuleDisabled] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);
  const [sessionsStoreFilter, setSessionsStoreFilter] = useState("");
  const [sessions, setSessions] = useState<InventorySession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [operator, setOperator] = useState<InventoryOperator | null>(null);
  const [operatorMode, setOperatorMode] = useState<OperatorMode>("conteo");
  const [operatorName, setOperatorName] = useState("");
  const [operatorPhone, setOperatorPhone] = useState("");
  const [operatorPassword, setOperatorPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const isMobileAccess = useIsMobileAccess();

  const [newStoreId, setNewStoreId] = useState("");
  const [newName, setNewName] = useState("");
  const [newDate, setNewDate] = useState(new Date().toISOString().slice(0, 10));
  const [locationsFile, setLocationsFile] = useState<File | null>(null);
  const [locationsFileBuffer, setLocationsFileBuffer] = useState<ArrayBuffer | null>(null);
  const locationsFileRef = useRef<HTMLInputElement | null>(null);
  const [importingLocations, setImportingLocations] = useState(false);
  const [pendingLocationSortDirection, setPendingLocationSortDirection] = useState<SortDirection>("asc");
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
  const [productivityLayerRows, setProductivityLayerRows] = useState<ProductivityLayerRow[]>([]);
  const [productivityAssignedRows, setProductivityAssignedRows] = useState<ProductivityAssignedRow[]>([]);
  const [operatorRecordsPage, setOperatorRecordsPage] = useState(1);
  const [operatorRecordsTotal, setOperatorRecordsTotal] = useState(0);
  const [operatorRecordsLoading, setOperatorRecordsLoading] = useState(false);
  const [countedLocationCodes, setCountedLocationCodes] = useState<string[]>([]);
  const [recordsQuery, setRecordsQuery] = useState("");
  const [recordsOperatorFilter, setRecordsOperatorFilter] = useState("");
  const [recordsZoneFilter, setRecordsZoneFilter] = useState("");
  const [locationCode, setLocationCode] = useState("");
  const [productCode, setProductCode] = useState("");
  const [quantity, setQuantity] = useState("");
  const [editingCountId, setEditingCountId] = useState<string | null>(null);
  const [editingAdminCount, setEditingAdminCount] = useState<CountRow | null>(null);
  const [editingAdminLocation, setEditingAdminLocation] = useState("");
  const [editingAdminQuantity, setEditingAdminQuantity] = useState("");
  const [editingFinishedStock, setEditingFinishedStock] = useState<SummaryRow | null>(null);
  const [editingFinishedStockValue, setEditingFinishedStockValue] = useState("");
  const [editingFinishedStockNote, setEditingFinishedStockNote] = useState("");
  const [savingFinishedStockEdit, setSavingFinishedStockEdit] = useState(false);
  const [productCandidates, setProductCandidates] = useState<Product[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [productLookupMessage, setProductLookupMessage] = useState("");
  const [productLookupMode, setProductLookupMode] = useState<ProductLookupMode>("typed");
  const [operatorLookupCode, setOperatorLookupCode] = useState("");
  const [operatorLookupRows, setOperatorLookupRows] = useState<CountRow[]>([]);
  const [operatorLookupLoading, setOperatorLookupLoading] = useState(false);
  const [operatorLookupMessage, setOperatorLookupMessage] = useState("");
  const [savingCount, setSavingCount] = useState(false);
  const savingCountRef = useRef(false);
  const productLookupRequestRef = useRef(0);
  const productLookupModeRef = useRef<ProductLookupMode>("typed");
  const pendingStockRefreshRef = useRef(false);
  const summaryRef = useRef<SummaryRow[]>([]);
  const summaryCacheRef = useRef<Map<string, SummaryCacheEntry>>(new Map());
  const dirtyObservationKeysRef = useRef<Set<string>>(new Set());
  const productInputRef = useRef<HTMLInputElement | null>(null);
  const qtyInputRef = useRef<HTMLInputElement | null>(null);
  const loadedSessionTabsRef = useRef<Set<string>>(new Set());
  const staleSessionTabsRef = useRef<Set<string>>(new Set());
  const lastSummaryReloadRef = useRef<number>(0);
  const summaryThrottleTimerRef = useRef<number | null>(null);
  const sessionLoadGenRef = useRef(0);

  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [summaryLoadedSessionId, setSummaryLoadedSessionId] = useState("");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [refreshingNonOkStock, setRefreshingNonOkStock] = useState(false);
  const [summaryHasPendingChanges, setSummaryHasPendingChanges] = useState(false);
  const [summaryQuery, setSummaryQuery] = useState("");
  const [summaryPage, setSummaryPage] = useState(1);
  const [validatorRecordsPage, setValidatorRecordsPage] = useState(1);
  const [pendingRecountPage, setPendingRecountPage] = useState(1);
  const [assignedRecountPage, setAssignedRecountPage] = useState(1);
  const [manualRecountPage, setManualRecountPage] = useState(1);
  const [adminRecountRecordsPage, setAdminRecountRecordsPage] = useState(1);
  const [inventoryNotesDraft, setInventoryNotesDraft] = useState("");
  const [observationDrafts, setObservationDrafts] = useState<Record<string, string>>({});
  const [validatorTab, setValidatorTab] = useState<ValidatorTab>("preparacion");
  const [recordsSort, setRecordsSort] = useState<SortState<RecordsSortKey>>({ key: "counted_at", direction: "desc" });
  const [summarySort, setSummarySort] = useState<SortState<SummarySortKey>>({ key: "valueDiff", direction: "desc" });
  const [recountAssignedSort, setRecountAssignedSort] = useState<SortState<RecountAssignedSortKey>>({ key: "ticket", direction: "asc" });
  const [recountAssignedQuery, setRecountAssignedQuery] = useState("");
  const [recountAssignedStatusFilter, setRecountAssignedStatusFilter] = useState<RecountAssignedStatusFilter>("all");
  const [recountRecordsQuery, setRecountRecordsQuery] = useState("");
  const [adminRecordLayer, setAdminRecordLayer] = useState<"all" | "recount" | "validation">("all");
  const [recountManagerTab, setRecountManagerTab] = useState<RecountManagerTab>("pendientes");
  const [pendingRecountQuery, setPendingRecountQuery] = useState("");
  const [selectedPendingRecountKeys, setSelectedPendingRecountKeys] = useState<Set<string>>(new Set());
  const [sessionOperators, setSessionOperators] = useState<InventoryOperator[]>([]);
  const [inventoryOperators, setInventoryOperators] = useState<InventoryOperator[]>([]);
  const [inventoryOperatorDrafts, setInventoryOperatorDrafts] = useState<Record<string, InventoryOperatorDraft>>({});
  const [savingInventoryOperatorId, setSavingInventoryOperatorId] = useState<string | null>(null);
  const [recountItems, setRecountItems] = useState<RecountItem[]>([]);
  const [operatorRecountQuery, setOperatorRecountQuery] = useState("");
  const [operatorSavedRecordQuery, setOperatorSavedRecordQuery] = useState("");
  const [operatorRecordLayer, setOperatorRecordLayer] = useState<"recount" | "validation">("recount");
  const [reassignOperatorDrafts, setReassignOperatorDrafts] = useState<Record<string, string>>({});
  const [recountFilter, setRecountFilter] = useState<RecountFilter>("surplus");
  const recountType: RecountType = recountFilter === "missing" || recountFilter === "missing_not_counted" ? "missing" : "surplus";
  const [recountOperatorId, setRecountOperatorId] = useState("");
  const [recountPrintOperatorId, setRecountPrintOperatorId] = useState("");
  const [recountDrafts, setRecountDrafts] = useState<Record<string, RecountDraft>>({});
  const [manualRecountDrafts, setManualRecountDrafts] = useState<Record<string, ManualRecountDraft>>({});
  const [savingRecountId, setSavingRecountId] = useState<string | null>(null);
  const savingRecountIdsRef = useRef<Set<string>>(new Set());
  const [operatorRecountRecords, setOperatorRecountRecords] = useState<OperatorRecountRecord[]>([]);
  const [adminRecountRecords, setAdminRecountRecords] = useState<OperatorRecountRecord[]>([]);
  const [editingAdminRecountRecord, setEditingAdminRecountRecord] = useState<OperatorRecountRecord | null>(null);
  const [editingAdminRecountMode, setEditingAdminRecountMode] = useState<"edit" | "add">("edit");
  const [editingAdminRecountLocation, setEditingAdminRecountLocation] = useState("");
  const [editingAdminRecountQuantity, setEditingAdminRecountQuantity] = useState("");
  const [finishedReportFrom, setFinishedReportFrom] = useState(currentMonthStartISO());
  const [finishedReportTo, setFinishedReportTo] = useState(new Date().toISOString().slice(0, 10));
  const [finishedReportRows, setFinishedReportRows] = useState<FinishedGeneralInventoryReportRow[]>([]);
  const [finishedReportLoading, setFinishedReportLoading] = useState(false);
  const [finishedReportPage, setFinishedReportPage] = useState(1);
  const [editingRecountItemId, setEditingRecountItemId] = useState<string | null>(null);
  const editingRecountItemIdRef = useRef<string | null>(null);
  const [scannerTarget, setScannerTarget] = useState<ScannerTarget>(null);
  const [torchOn, setTorchOn] = useState(false);
  const scannerRef = useRef<any>(null);
  const scannerBusyRef = useRef(false);
  // Mantener separado el lector auxiliar de la bandera del callback de
  // html5-qrcode. Si el WASM tarda o falla en Safari, no debe bloquear la
  // lectura normal de la cámara.
  const iosFrameBusyRef = useRef(false);
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
  const isValidationManagerTab = validatorTab === "validacion";
  const isSelectedSessionFinished = selectedSession?.status === "finished";
  const canAdminReopenSelectedSession = user?.role === "Administrador" && isSelectedSessionFinished;

  useEffect(() => {
    setInventoryNotesDraft(selectedSession?.notes || "");
  }, [selectedSession?.id, selectedSession?.notes]);

  useEffect(() => {
    editingRecountItemIdRef.current = editingRecountItemId;
  }, [editingRecountItemId]);

  useEffect(() => {
    setRecordsQuery("");
    setOperatorRecountQuery("");
    setOperatorSavedRecordQuery("");
    setOperatorRecordLayer(selectedSession?.validation_enabled ? "validation" : "recount");
    setRecordsOperatorFilter("");
    setRecordsZoneFilter("");
    setOperatorRecordsPage(1);
    setOperatorRecordsTotal(0);
  }, [selectedSessionId, selectedSession?.validation_enabled]);

  useEffect(() => {
    setOperatorRecordsPage(1);
  }, [recordsQuery, operator?.id]);

  useEffect(() => {
    if (!selectedSessionId || !operator?.id || isValidator || operatorMode !== "conteo") return;
    const timer = window.setTimeout(() => {
      void loadRecordsData(selectedSessionId, operator.id);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [selectedSessionId, operator?.id, isValidator, operatorMode, operatorRecordsPage, recordsQuery]);

  const activeSessions = useMemo(
    () => sessions.filter(session => canOperatorEnter(session.status)),
    [sessions]
  );

  const isOperatorView = !!operator && !isValidator;
  const showSidePanel = false;

  function sessionTabKey(sessionId: string, tab: ValidatorTab) {
    return `${sessionId}__${tab}`;
  }

  function markSessionTabLoaded(sessionId: string, tab: ValidatorTab) {
    const key = sessionTabKey(sessionId, tab);
    loadedSessionTabsRef.current.add(key);
    staleSessionTabsRef.current.delete(key);
  }

  function markSessionTabStale(sessionId: string, tab: ValidatorTab) {
    staleSessionTabsRef.current.add(sessionTabKey(sessionId, tab));
  }

  function isSessionTabFresh(sessionId: string, tab: ValidatorTab) {
    const key = sessionTabKey(sessionId, tab);
    return loadedSessionTabsRef.current.has(key) && !staleSessionTabsRef.current.has(key);
  }

  function observationKey(sessionId: string, productId: string) {
    return `${sessionId}__${productId}`;
  }

  function observationDraftsFromRows(rows: SummaryRow[]) {
    return Object.fromEntries(rows.map(row => [row.product_id, row.observation || ""]));
  }

  function applyObservationDraftsFromServer(sessionId: string, nextDrafts: Record<string, string>) {
    setObservationDrafts(prev => {
      const merged = { ...nextDrafts };
      for (const productId of Object.keys(prev)) {
        if (dirtyObservationKeysRef.current.has(observationKey(sessionId, productId))) {
          merged[productId] = prev[productId];
        }
      }
      return merged;
    });
  }

  function updateObservationDraft(productId: string, value: string) {
    if (selectedSessionId) dirtyObservationKeysRef.current.add(observationKey(selectedSessionId, productId));
    setObservationDrafts(prev => ({ ...prev, [productId]: value }));
  }

  function cacheSummary(sessionId: string, rows: SummaryRow[]) {
    summaryCacheRef.current.set(sessionId, {
      rows,
      observationDrafts: observationDraftsFromRows(rows),
      cachedAt: Date.now(),
    });
  }

  function applyCachedSummary(sessionId: string) {
    const cached = summaryCacheRef.current.get(sessionId);
    if (!cached) return false;
    setSummary(cached.rows);
    applyObservationDraftsFromServer(sessionId, cached.observationDrafts);
    setSummaryLoadedSessionId(sessionId);
    setSummaryHasPendingChanges(false);
    return true;
  }

  const recordsOperatorOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const row of counts) {
      if (!row.operator_id) continue;
      options.set(row.operator_id, row.operator_name || "Sin usuario");
    }
    return [...options.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [counts]);

  const recordsZoneOptions = useMemo(() => {
    return [...new Set(counts.map(row => locationZoneKey(row.location_code)).filter(Boolean))]
      .sort((a, b) => compareLocationByZone(a, b, "asc"));
  }, [counts]);

  const filteredCounts = useMemo(() => {
    const q = recordsQuery.trim();
    const rows = counts.filter(row =>
      (!recordsOperatorFilter || row.operator_id === recordsOperatorFilter) &&
      (!recordsZoneFilter || locationZoneKey(row.location_code) === recordsZoneFilter) &&
      recordMatchesQuery(row, q)
    );
    return [...rows].sort((a, b) => {
      if (recordsSort.key === "location_code") {
        return compareLocationByZone(a.location_code, b.location_code, recordsSort.direction);
      }
      const left = recordsSort.key === "value" ? Number(a.quantity || 0) * Number(a.cost_snapshot || 0) :
        recordsSort.key === "counted_at" ? new Date(a.counted_at).getTime() :
        a[recordsSort.key];
      const right = recordsSort.key === "value" ? Number(b.quantity || 0) * Number(b.cost_snapshot || 0) :
        recordsSort.key === "counted_at" ? new Date(b.counted_at).getTime() :
        b[recordsSort.key];
      return compareValues(left ?? "", right ?? "", recordsSort.direction);
    });
  }, [counts, recordsOperatorFilter, recordsQuery, recordsSort, recordsZoneFilter]);

  const operatorRecordsTotalPages = Math.max(1, Math.ceil(operatorRecordsTotal / OPERATOR_RECORDS_PAGE_SIZE));
  const operatorRecordsFrom = operatorRecordsTotal === 0 ? 0 : ((operatorRecordsPage - 1) * OPERATOR_RECORDS_PAGE_SIZE) + 1;
  const operatorRecordsTo = Math.min(operatorRecordsPage * OPERATOR_RECORDS_PAGE_SIZE, operatorRecordsTotal);
  const validatorRecordsTotalPages = Math.max(1, Math.ceil(filteredCounts.length / VALIDATOR_RECORDS_PAGE_SIZE));
  const pagedValidatorCounts = useMemo(() => {
    const page = Math.min(validatorRecordsPage, validatorRecordsTotalPages);
    const start = (page - 1) * VALIDATOR_RECORDS_PAGE_SIZE;
    return filteredCounts.slice(start, start + VALIDATOR_RECORDS_PAGE_SIZE);
  }, [filteredCounts, validatorRecordsPage, validatorRecordsTotalPages]);

  const recordsRenderKey = useMemo(() => [
    selectedSessionId,
    recordsOperatorFilter,
    recordsZoneFilter,
    recordsQuery.trim(),
    recordsSort.key,
    recordsSort.direction,
    filteredCounts.length,
    validatorRecordsPage,
  ].join("__"), [filteredCounts.length, recordsOperatorFilter, recordsQuery, recordsSort, recordsZoneFilter, selectedSessionId, validatorRecordsPage]);

  const counterStats = useMemo(() => {
    const grouped = new Map<string, { id: string; name: string; count: number; first: number; last: number; times: number[] }>();
    for (const row of counts) {
      const time = new Date(row.counted_at).getTime();
      if (!Number.isFinite(time)) continue;
      const key = row.operator_id;
      const current = grouped.get(key);
      if (!current) {
        grouped.set(key, { id: key, name: row.operator_name || "Sin usuario", count: 1, first: time, last: time, times: [time] });
        continue;
      }
      current.count += 1;
      current.first = Math.min(current.first, time);
      current.last = Math.max(current.last, time);
      current.times.push(time);
    }
    const rows = [...grouped.values()].map(row => {
      const { activeMinutes, excludedPauseMinutes } = calculateActiveCounterMinutes(row.times);
      return { ...row, minutes: activeMinutes, excludedPauseMinutes, perMinute: row.count / activeMinutes };
    }).sort((a, b) => b.perMinute - a.perMinute);
    const maxPerMinute = Math.max(1, ...rows.map(row => row.perMinute));
    return { rows, maxPerMinute };
  }, [counts]);

  const productivityByUser = useMemo(() => {
    type Bucket = {
      id: string;
      name: string;
      counted: Set<string>;
      recounted: Set<string>;
      validated: Set<string>;
      assignedRecount: Set<string>;
      assignedValidation: Set<string>;
    };
    const grouped = new Map<string, Bucket>();
    const ensureBucket = (operatorId: string, operatorName: string | null | undefined) => {
      const key = operatorId || "sin_usuario";
      const current = grouped.get(key);
      if (current) {
        if ((!current.name || current.name === "Sin usuario") && operatorName) current.name = operatorName;
        return current;
      }
      const next = {
        id: key,
        name: operatorName || "Sin usuario",
        counted: new Set<string>(),
        recounted: new Set<string>(),
        validated: new Set<string>(),
        assignedRecount: new Set<string>(),
        assignedValidation: new Set<string>(),
      };
      grouped.set(key, next);
      return next;
    };
    const codeKey = (productId: string | null | undefined, sku: string | null | undefined) =>
      String(productId || "").trim() || normalizeCode(sku).toUpperCase();

    for (const row of counts) {
      const key = codeKey(row.product_id, row.sku);
      if (!key) continue;
      ensureBucket(row.operator_id, row.operator_name).counted.add(key);
    }
    for (const row of productivityLayerRows) {
      const key = codeKey(row.product_id, row.sku);
      if (!key) continue;
      const bucket = ensureBucket(row.operator_id, row.operator_name);
      if (row.layer === "validation") bucket.validated.add(key);
      else bucket.recounted.add(key);
    }
    for (const row of productivityAssignedRows) {
      const key = codeKey(row.product_id, row.sku);
      if (!key) continue;
      const bucket = ensureBucket(row.operator_id, row.operator_name);
      if (row.layer === "validation") bucket.assignedValidation.add(key);
      else bucket.assignedRecount.add(key);
    }

    const rows = [...grouped.values()].map(row => ({
      id: row.id,
      name: row.name,
      counted: row.counted.size,
      recounted: row.recounted.size,
      validated: row.validated.size,
      assignedRecount: row.assignedRecount.size,
      assignedValidation: row.assignedValidation.size,
      total: row.counted.size + row.recounted.size + row.validated.size,
    })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "es", { sensitivity: "base" }));

    const totals = rows.reduce((acc, row) => ({
      counted: acc.counted + row.counted,
      recounted: acc.recounted + row.recounted,
      validated: acc.validated + row.validated,
      assignedRecount: acc.assignedRecount + row.assignedRecount,
      assignedValidation: acc.assignedValidation + row.assignedValidation,
      total: acc.total + row.total,
    }), { counted: 0, recounted: 0, validated: 0, assignedRecount: 0, assignedValidation: 0, total: 0 });

    return {
      rows,
      totals,
      maxTotal: Math.max(1, ...rows.map(row => row.total)),
      maxCounted: Math.max(1, ...rows.map(row => row.counted)),
      maxRecounted: Math.max(1, ...rows.map(row => row.recounted)),
      maxValidated: Math.max(1, ...rows.map(row => row.validated)),
    };
  }, [counts, productivityAssignedRows, productivityLayerRows]);

  const filteredSummary = useMemo(() => {
    const q = summaryQuery.trim().toLowerCase();
    const rows = summary.filter(row =>
      !q ||
      row.sku.toLowerCase().includes(q) ||
      row.description.toLowerCase().includes(q) ||
      String(row.observation || "").toLowerCase().includes(q)
    );
    return [...rows].sort((a, b) => {
      const left = summarySort.key === "observation" ? String(a.observation || "") : a[summarySort.key] ?? "";
      const right = summarySort.key === "observation" ? String(b.observation || "") : b[summarySort.key] ?? "";
      return compareValues(left, right, summarySort.direction);
    });
  }, [summary, summaryQuery, summarySort]);
  const summaryTotalPages = Math.max(1, Math.ceil(filteredSummary.length / SUMMARY_PAGE_SIZE));
  const pagedSummary = useMemo(() => {
    const page = Math.min(summaryPage, summaryTotalPages);
    const start = (page - 1) * SUMMARY_PAGE_SIZE;
    return filteredSummary.slice(start, start + SUMMARY_PAGE_SIZE);
  }, [filteredSummary, summaryPage, summaryTotalPages]);
  const showValidationSummary = Boolean(selectedSession?.validation_enabled);

  const recountCandidates = useMemo(() => {
    const summaryByProduct = new Map(summary.map(row => [row.product_id, row]));
    const locationById = new Map(locations.map(row => [row.id, row]));
    const surplusGroups = new Map<string, RecountCandidate>();
    const validationMode = isValidationManagerTab;

    if (validationMode) {
      return sortRecountAssignmentLines(summary
        .filter(row => row.re_counted && row.diff !== 0)
        .map(row => ({
          product_id: row.product_id,
          sku: row.sku,
          description: row.description,
          unit: row.unit,
          location_id: null,
          location_code: null,
          full_location: "Validacion por codigo",
          zone: null,
          zone_ref: null,
          lineal: null,
          ticket: row.diff < 0 ? "VALIDACION FALTANTE" : "VALIDACION SOBRANTE",
          recount_type: row.diff < 0 ? "missing" as const : "surplus" as const,
          system_stock: row.system_stock,
          counted_qty: row.counted,
          diff_qty: row.diff,
          cost_snapshot: row.cost,
          value_diff: row.valueDiff,
          location_count: 0,
          original_locations: [],
        })));
    }

    for (const row of counts) {
      const summaryRow = summaryByProduct.get(row.product_id);
      if (!summaryRow || summaryRow.diff <= 0) continue;
      if (!validationMode && summaryRow.re_counted) continue;
      const location = locationById.get(row.location_id) || findInventoryLocation(locations, row.location_code) || null;
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
      .filter(row => row.diff < 0 && (validationMode ? row.re_counted : !row.re_counted))
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
  }, [counts, locations, isValidationManagerTab, summary]);

  const countLocationLinesByProduct = useMemo(() => {
    const locationById = new Map(locations.map(row => [row.id, row]));
    const grouped = new Map<string, RecountLocationLine[]>();
    for (const row of counts) {
      const location = locationById.get(row.location_id) || findInventoryLocation(locations, row.location_code) || null;
      const locationCode = normalizeLocationCode(row.location_code || location?.location_code || "");
      if (!row.product_id || !locationCode) continue;
      const lines = grouped.get(row.product_id) || [];
      const existing = lines.find(item => normalizeLocationCode(item.location_code) === locationCode);
      if (existing) {
        existing.counted_qty += Number(row.quantity || 0);
      } else {
        lines.push({
          id: `${row.product_id}__${locationCode}`,
          location_id: row.location_id || location?.id || null,
          location_code: row.location_code || location?.location_code || locationCode,
          full_location: location?.full_location || location?.description || null,
          zone: location?.zone || null,
          zone_ref: location?.zone_ref || null,
          lineal: location?.lineal || null,
          ticket: location?.ticket || row.location_code,
          counted_qty: Number(row.quantity || 0),
        });
      }
      grouped.set(row.product_id, lines);
    }
    for (const [productId, lines] of grouped) {
      grouped.set(productId, lines.sort((a, b) => String(a.full_location || a.location_code).localeCompare(String(b.full_location || b.location_code), "es", { numeric: true, sensitivity: "base" })));
    }
    return grouped;
  }, [counts, locations]);

  const selectedRecountCandidates = useMemo(() => {
    if (recountFilter === "missing") {
      return sortRecountAssignmentLines(recountCandidates.filter(row => row.recount_type === "missing"));
    }
    if (recountFilter === "missing_not_counted") {
      return sortRecountAssignmentLines(recountCandidates.filter(row =>
        row.recount_type === "missing" &&
        Number(row.system_stock || 0) > 0 &&
        Number(row.counted_qty || 0) <= 0
      ));
    }
    if (recountFilter === "surplus_zero_stock") {
      return sortRecountAssignmentLines(recountCandidates.filter(row =>
        row.recount_type === "surplus" &&
        Number(row.system_stock || 0) <= 0 &&
        Number(row.counted_qty || 0) > 0
      ));
    }
    return sortRecountAssignmentLines(recountCandidates.filter(row => row.recount_type === "surplus"));
  }, [recountCandidates, recountFilter]);

  const assignedRecountKeys = useMemo(
    () => new Set(recountItems
      .filter(row => row.status !== "cancelled")
      .map(row => recountKey(row))),
    [recountItems]
  );
  const assignedValidationProductIds = useMemo(
    () => new Set(recountItems
      .filter(row => row.layer === "validation" && row.status !== "cancelled")
      .map(row => row.product_id)),
    [recountItems]
  );

  const unassignedRecountCandidates = useMemo(
    () => selectedRecountCandidates.filter(row => isValidationManagerTab
      ? !assignedValidationProductIds.has(row.product_id)
      : !assignedValidationProductIds.has(row.product_id) && !assignedRecountKeys.has(recountKey(row))),
    [assignedRecountKeys, assignedValidationProductIds, isValidationManagerTab, selectedRecountCandidates]
  );

  const filteredUnassignedRecountCandidates = useMemo(
    () => unassignedRecountCandidates.filter(row => recountCandidateMatchesQuery(row, pendingRecountQuery)),
    [pendingRecountQuery, unassignedRecountCandidates]
  );
  const pendingRecountTotalPages = Math.max(1, Math.ceil(filteredUnassignedRecountCandidates.length / RECOUNT_PAGE_SIZE));
  const pagedUnassignedRecountCandidates = useMemo(() => {
    const page = Math.min(pendingRecountPage, pendingRecountTotalPages);
    const start = (page - 1) * RECOUNT_PAGE_SIZE;
    return filteredUnassignedRecountCandidates.slice(start, start + RECOUNT_PAGE_SIZE);
  }, [filteredUnassignedRecountCandidates, pendingRecountPage, pendingRecountTotalPages]);

  const selectedPendingRecountRows = useMemo(
    () => filteredUnassignedRecountCandidates.filter(row => selectedPendingRecountKeys.has(recountKey(row))),
    [filteredUnassignedRecountCandidates, selectedPendingRecountKeys]
  );

  const allPendingRecountRowsSelected = filteredUnassignedRecountCandidates.length > 0 &&
    filteredUnassignedRecountCandidates.every(row => selectedPendingRecountKeys.has(recountKey(row)));

  const assignedRecountRows = useMemo(() => {
    const q = recountAssignedQuery.trim().toLowerCase();
    const rows = recountItems.filter(row =>
      row.status !== "cancelled" &&
      row.recount_type === recountType &&
      (!recountPrintOperatorId || row.assigned_operator_id === recountPrintOperatorId) &&
      (recountAssignedStatusFilter === "all" ||
        (recountAssignedStatusFilter === "pending" && row.status !== "counted") ||
        (recountAssignedStatusFilter === "counted" && row.status === "counted")) &&
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
  }, [recountAssignedQuery, recountAssignedSort, recountAssignedStatusFilter, recountItems, recountPrintOperatorId, recountType]);
  const assignedRecountTotalPages = Math.max(1, Math.ceil(assignedRecountRows.length / RECOUNT_PAGE_SIZE));
  const pagedAssignedRecountRows = useMemo(() => {
    const page = Math.min(assignedRecountPage, assignedRecountTotalPages);
    const start = (page - 1) * RECOUNT_PAGE_SIZE;
    return assignedRecountRows.slice(start, start + RECOUNT_PAGE_SIZE);
  }, [assignedRecountRows, assignedRecountPage, assignedRecountTotalPages]);

  const assignedRecountStatusCounts = useMemo(() => {
    const baseRows = recountItems.filter(row =>
      row.status !== "cancelled" &&
      row.recount_type === recountType &&
      (!recountPrintOperatorId || row.assigned_operator_id === recountPrintOperatorId)
    );
    return {
      all: baseRows.length,
      pending: baseRows.filter(row => row.status !== "counted").length,
      counted: baseRows.filter(row => row.status === "counted").length,
    };
  }, [recountItems, recountPrintOperatorId, recountType]);

  const activeAssignedRecountCount = useMemo(
    () => recountItems.filter(row => row.status !== "cancelled" && row.recount_type === recountType).length,
    [recountItems, recountType]
  );

  const manualRecountRows = useMemo(() => {
    return assignedRecountRows;
  }, [assignedRecountRows]);
  const manualRecountTotalPages = Math.max(1, Math.ceil(manualRecountRows.length / RECOUNT_PAGE_SIZE));
  const pagedManualRecountRows = useMemo(() => {
    const page = Math.min(manualRecountPage, manualRecountTotalPages);
    const start = (page - 1) * RECOUNT_PAGE_SIZE;
    return manualRecountRows.slice(start, start + RECOUNT_PAGE_SIZE);
  }, [manualRecountRows, manualRecountPage, manualRecountTotalPages]);

  const filteredOperatorRecountItems = useMemo(() => {
    const q = operatorRecountQuery.trim();
    return recountItems.filter(row => operatorRecountItemMatchesQuery(row, q));
  }, [operatorRecountQuery, recountItems]);

  const operatorRecordLayerCounts = useMemo(() => ({
    recount: operatorRecountRecords.filter(record => record.item.layer !== "validation").length,
    validation: operatorRecountRecords.filter(record => record.item.layer === "validation").length,
  }), [operatorRecountRecords]);

  const filteredOperatorRecountRecords = useMemo(() => {
    const q = operatorSavedRecordQuery.trim().toLowerCase();
    return operatorRecountRecords.filter(record => {
      const layer = record.item.layer === "validation" ? "validation" : "recount";
      if (layer !== operatorRecordLayer) return false;
      return !q ||
        record.sku.toLowerCase().includes(q) ||
        record.description.toLowerCase().includes(q) ||
        record.location_code.toLowerCase().includes(q) ||
        String(record.item.ticket || "").toLowerCase().includes(q) ||
        String(record.item.full_location || "").toLowerCase().includes(q);
    });
  }, [operatorRecordLayer, operatorSavedRecordQuery, operatorRecountRecords]);

  const filteredAdminRecountRecords = useMemo(() => {
    const q = recountRecordsQuery.trim().toLowerCase();
    return adminRecountRecords.filter(record => {
      const layer = record.item.layer === "validation" ? "validation" : "recount";
      if (adminRecordLayer !== "all" && layer !== adminRecordLayer) return false;
      if (!q && record.item.recount_type !== recountType) return false;
      return !q ||
        record.sku.toLowerCase().includes(q) ||
        record.description.toLowerCase().includes(q) ||
        record.location_code.toLowerCase().includes(q) ||
        String(record.operator_name || "").toLowerCase().includes(q);
    });
  }, [adminRecountRecords, adminRecordLayer, recountRecordsQuery, recountType]);
  const adminRecountRecordsTotalPages = Math.max(1, Math.ceil(filteredAdminRecountRecords.length / RECOUNT_PAGE_SIZE));
  const pagedAdminRecountRecords = useMemo(() => {
    const page = Math.min(adminRecountRecordsPage, adminRecountRecordsTotalPages);
    const start = (page - 1) * RECOUNT_PAGE_SIZE;
    return filteredAdminRecountRecords.slice(start, start + RECOUNT_PAGE_SIZE);
  }, [filteredAdminRecountRecords, adminRecountRecordsPage, adminRecountRecordsTotalPages]);

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
        for (const row of filteredUnassignedRecountCandidates) next.delete(recountKey(row));
      } else {
        for (const row of filteredUnassignedRecountCandidates) next.add(recountKey(row));
      }
      return next;
    });
  }

  function changeRecountFilter(filter: RecountFilter) {
    setRecountFilter(filter);
    setSelectedPendingRecountKeys(new Set());
    setRecountManagerTab("pendientes");
  }

  function renderRecountPagination(total: number, page: number, totalPages: number, onPageChange: (page: number) => void, pageSize: number = RECOUNT_PAGE_SIZE) {
    const from = total === 0 ? 0 : ((page - 1) * pageSize) + 1;
    const to = Math.min(page * pageSize, total);
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-xl bg-slate-50 px-3 py-2 text-xs font-black text-slate-600">
          {total === 0 ? "Sin filas" : `Mostrando ${from}-${to} de ${total}`}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="rounded-xl border px-3 py-2 text-xs font-black text-slate-700 disabled:opacity-40"
        >
          Anterior
        </button>
        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="rounded-xl border px-3 py-2 text-xs font-black text-slate-700 disabled:opacity-40"
        >
          Siguiente
        </button>
      </div>
    );
  }

  function renderReportKpiCard(label: string, value: string, tone: "slate" | "green" | "amber" | "red" | "blue") {
    const toneClasses: Record<typeof tone, string> = {
      slate: "border-slate-300 bg-slate-50 text-slate-900",
      green: "border-green-300 bg-green-50 text-green-800",
      amber: "border-amber-300 bg-amber-50 text-amber-800",
      red: "border-red-300 bg-red-50 text-red-700",
      blue: "border-blue-300 bg-blue-50 text-blue-800",
    };
    return (
      <div className={`rounded-2xl border-2 p-4 text-center shadow-sm ${toneClasses[tone]}`}>
        <div className="text-2xl font-black">{value}</div>
        <div className="mt-1 text-[11px] font-bold uppercase tracking-wide">{label}</div>
      </div>
    );
  }

  function barcodeVariants(value: string) {
    const raw = normalizeCode(value).toUpperCase();
    const hyphenated = raw.replace(/['’‘´`]/g, "-");
    const variants = new Set<string>([raw, hyphenated]);
    if (/^\d+$/.test(raw)) {
      const noLeadingZeros = raw.replace(/^0+/, "");
      if (noLeadingZeros) variants.add(noLeadingZeros);
      if (raw.length === 12) variants.add(`0${raw}`);
      if (raw.length === 13 && raw.startsWith("0")) variants.add(raw.slice(1));
      if (raw.length > 8) variants.add(raw.slice(0, -1));
    }
    return [...variants].filter(Boolean);
  }

  function normalizeScannedBarcode(value: string) {
    return normalizeCode(value).replace(/['’‘´`]/g, "-").toUpperCase();
  }

  function normalizeProductKeyboardInput(value: string) {
    return value.replace(/['’‘´`]/g, "-").toUpperCase();
  }

  const pendingLocations = useMemo(() => {
    const counted = new Set(countedLocationCodes.map(normalizeLocationCode));
    return locations
      .filter(location => !location.is_empty && !counted.has(normalizeLocationCode(location.location_code)))
      .sort((a, b) => compareLocationByZone(a.location_code, b.location_code, pendingLocationSortDirection));
  }, [locations, countedLocationCodes, pendingLocationSortDirection]);

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
      okCodes,
      surplusCodes,
      missingCodes,
      notCountedCodes,
      countedCodes,
      totalCodes,
      skuProgress: totalCodes > 0 ? Math.round((countedCodes / totalCodes) * 100) : 0,
      valueProgress: systemValue > 0 ? Math.round((countedValue / systemValue) * 100) : 0,
    };
  }, [summary]);

  const finishedReportTotals = useMemo(() => {
    const sums = finishedReportRows.reduce((acc, row) => ({
      inventories: acc.inventories + 1,
      totalCodes: acc.totalCodes + Number(row.total_codes || 0),
      okCodes: acc.okCodes + Number(row.ok_codes || 0),
      differenceCodes: acc.differenceCodes + Number(row.difference_codes || 0),
      systemValue: acc.systemValue + Number(row.system_value || 0),
      surplusValue: acc.surplusValue + Number(row.surplus_value || 0),
      missingValue: acc.missingValue + Number(row.missing_value || 0),
      netValueDiff: acc.netValueDiff + Number(row.net_value_diff || 0),
      absValueDiff: acc.absValueDiff + Number(row.abs_value_diff || 0),
      salesInPeriod: acc.salesInPeriod + Number(row.sales_in_period || 0),
    }), {
      inventories: 0,
      totalCodes: 0,
      okCodes: 0,
      differenceCodes: 0,
      systemValue: 0,
      surplusValue: 0,
      missingValue: 0,
      netValueDiff: 0,
      absValueDiff: 0,
      salesInPeriod: 0,
    });
    // Signo invertido a proposito: diferencia positiva (sobrante) resta,
    // diferencia negativa (faltante) suma -- para que un sobrante en una
    // tienda compense un faltante en otra al ponderar contra la venta
    // total del periodo, en vez de que ambos sumen como si fueran perdida.
    const weightedDeviationPct = sums.salesInPeriod > 0
      ? Math.round((-sums.netValueDiff / sums.salesInPeriod) * 10000) / 100
      : null;
    const weightedEriPct = sums.totalCodes > 0
      ? Math.round((sums.okCodes / sums.totalCodes) * 10000) / 100
      : null;
    return { ...sums, weightedDeviationPct, weightedEriPct };
  }, [finishedReportRows]);

  const finishedReportTotalPages = Math.max(1, Math.ceil(finishedReportRows.length / FINISHED_REPORT_PAGE_SIZE));
  const pagedFinishedReportRows = useMemo(() => {
    const page = Math.min(finishedReportPage, finishedReportTotalPages);
    const start = (page - 1) * FINISHED_REPORT_PAGE_SIZE;
    return finishedReportRows.slice(start, start + FINISHED_REPORT_PAGE_SIZE);
  }, [finishedReportRows, finishedReportPage, finishedReportTotalPages]);

  useEffect(() => {
    const rawUser = localStorage.getItem("cyclic_user");
    if (rawUser) {
      try {
        const parsedUser = JSON.parse(rawUser) as CyclicUser;
        setUser(parsedUser);
        fetchDisabledModules().then(disabled => {
          if (isModuleBlockedForUser(disabled, "general_inventory", parsedUser)) setModuleDisabled(true);
        });
      } catch {
        setUser(null);
      }
    }

    const rawOperator = localStorage.getItem(OPERATOR_KEY);
    if (rawOperator) {
      try {
        setOperator(JSON.parse(rawOperator) as InventoryOperator);
        const savedMode = localStorage.getItem(OPERATOR_MODE_KEY);
        if (savedMode === "reconteo" || savedMode === "consulta") setOperatorMode(savedMode);
      } catch {
        localStorage.removeItem(OPERATOR_KEY);
      }
    }

    const savedSessionId = localStorage.getItem(SESSION_KEY) || "";
    if (savedSessionId) setSelectedSessionId(savedSessionId);

    void loadInitial(savedSessionId);
  }, []);

  useEffect(() => {
    summaryRef.current = summary;
  }, [summary]);

  useEffect(() => {
    setSummaryPage(1);
  }, [selectedSessionId, summaryQuery, summarySort.key, summarySort.direction]);

  useEffect(() => {
    if (summaryPage > summaryTotalPages) setSummaryPage(summaryTotalPages);
  }, [summaryPage, summaryTotalPages]);

  useEffect(() => {
    setValidatorRecordsPage(1);
  }, [selectedSessionId, recordsOperatorFilter, recordsZoneFilter, recordsQuery, recordsSort.key, recordsSort.direction]);

  useEffect(() => {
    if (validatorRecordsPage > validatorRecordsTotalPages) setValidatorRecordsPage(validatorRecordsTotalPages);
  }, [validatorRecordsPage, validatorRecordsTotalPages]);

  useEffect(() => {
    setPendingRecountPage(1);
  }, [selectedSessionId, pendingRecountQuery, recountFilter, recountType, isValidationManagerTab]);

  useEffect(() => {
    setAssignedRecountPage(1);
  }, [selectedSessionId, recountAssignedQuery, recountAssignedStatusFilter, recountAssignedSort.key, recountAssignedSort.direction, recountPrintOperatorId, recountType]);

  useEffect(() => {
    setManualRecountPage(1);
  }, [selectedSessionId, recountPrintOperatorId, recountType]);

  useEffect(() => {
    setAdminRecountRecordsPage(1);
  }, [selectedSessionId, adminRecordLayer, recountRecordsQuery, recountType]);

  useEffect(() => {
    if (pendingRecountPage > pendingRecountTotalPages) setPendingRecountPage(pendingRecountTotalPages);
  }, [pendingRecountPage, pendingRecountTotalPages]);

  useEffect(() => {
    if (assignedRecountPage > assignedRecountTotalPages) setAssignedRecountPage(assignedRecountTotalPages);
  }, [assignedRecountPage, assignedRecountTotalPages]);

  useEffect(() => {
    if (manualRecountPage > manualRecountTotalPages) setManualRecountPage(manualRecountTotalPages);
  }, [manualRecountPage, manualRecountTotalPages]);

  useEffect(() => {
    if (adminRecountRecordsPage > adminRecountRecordsTotalPages) setAdminRecountRecordsPage(adminRecountRecordsTotalPages);
  }, [adminRecountRecordsPage, adminRecountRecordsTotalPages]);

  useEffect(() => {
    if (!selectedSessionId || !isValidator) return;
    lastSummaryReloadRef.current = 0;
    localStorage.setItem(SESSION_KEY, selectedSessionId);
    if (validatorTab === "resumen") applyCachedSummary(selectedSessionId);
    if (isSessionTabFresh(selectedSessionId, validatorTab)) return;
    void loadSessionData(selectedSessionId, validatorTab);
  }, [selectedSessionId, validatorTab, isValidator, operator?.id]);

  useEffect(() => {
    if (validatorTab === "reconteo" || validatorTab === "validacion") {
      setAdminRecordLayer("all");
    }
  }, [validatorTab]);

  useEffect(() => {
    if (isReadOnlySupervisor && (validatorTab === "preparacion" || validatorTab === "reconteo" || validatorTab === "usuarios")) {
      setValidatorTab("registros");
    }
  }, [isReadOnlySupervisor, validatorTab]);

  useEffect(() => {
    if (!operator || isValidator || !selectedSession || canOperatorEnter(selectedSession.status)) return;
    setOperator(null);
    setOperatorMode("conteo");
    localStorage.removeItem(OPERATOR_KEY);
    localStorage.removeItem(OPERATOR_MODE_KEY);
    localStorage.removeItem(SESSION_KEY);
    setMessage("Esta sesion fue finalizada. Ya no acepta conteos ni reconteos de operarios.");
  }, [operator?.id, isValidator, selectedSession?.id, selectedSession?.status]);

  useEffect(() => {
    if (!selectedSessionId || !isValidator) return;

    let timer: number | null = null;
    const channel = supabase
      .channel(`gi-session-${selectedSessionId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "general_inventory_sessions", filter: `id=eq.${selectedSessionId}` },
        () => {
          if (timer) window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            void (async () => {
              await loadInitial(selectedSessionId);
              if (!isValidator && operator?.id) await loadOperatorRecountItems(selectedSessionId, operator.id);
            })();
          }, 1500);
        }
      )
      .subscribe();

    return () => {
      if (timer) window.clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [selectedSessionId, isValidator, operator?.id]);

  useEffect(() => {
    if (!selectedSessionId || !operator || isValidator) return;
    void loadOperatorRecountItems(selectedSessionId, operator.id);
  }, [selectedSessionId, operator?.id, isValidator, selectedSession?.validation_enabled]);

  useEffect(() => {
    if (!selectedSessionId) return;

    let timer: number | null = null;
    const reloadInventoryCounts = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (validatorTab === "registros") void loadRecordsData(selectedSessionId);
        else if (validatorTab === "productividad") void loadProductivityData(selectedSessionId);
        else {
          markSessionTabStale(selectedSessionId, "registros");
          markSessionTabStale(selectedSessionId, "productividad");
        }
        if (validatorTab === "resumen") {
          const THROTTLE_MS = 6_000;
          const now = Date.now();
          const elapsed = now - lastSummaryReloadRef.current;
          if (elapsed >= THROTTLE_MS) {
            lastSummaryReloadRef.current = now;
            if (summaryThrottleTimerRef.current !== null) {
              window.clearTimeout(summaryThrottleTimerRef.current);
              summaryThrottleTimerRef.current = null;
            }
            void loadSummary(selectedSessionId, true);
          } else if (summaryThrottleTimerRef.current === null) {
            summaryThrottleTimerRef.current = window.setTimeout(() => {
              summaryThrottleTimerRef.current = null;
              lastSummaryReloadRef.current = Date.now();
              void loadSummary(selectedSessionId, true);
            }, THROTTLE_MS - elapsed);
          }
        } else markSessionTabStale(selectedSessionId, "resumen");
        if (validatorTab === "reconteo") void loadRecountData(selectedSessionId, false);
        else markSessionTabStale(selectedSessionId, "reconteo");
        if (validatorTab === "validacion") void loadRecountData(selectedSessionId, true);
        else markSessionTabStale(selectedSessionId, "validacion");
      }, 800);
    };

    const validationRealtimeEnabled = Boolean(selectedSession?.validation_enabled);
    let channel = supabase
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
      );
    if (validationRealtimeEnabled) {
      channel = channel
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "general_inventory_validation_items", filter: `session_id=eq.${selectedSessionId}` },
          reloadInventoryCounts
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "general_inventory_validation_counts", filter: `session_id=eq.${selectedSessionId}` },
          reloadInventoryCounts
        );
    }
    channel.subscribe();

    return () => {
      if (timer) window.clearTimeout(timer);
      if (summaryThrottleTimerRef.current !== null) {
        window.clearTimeout(summaryThrottleTimerRef.current);
        summaryThrottleTimerRef.current = null;
      }
      supabase.removeChannel(channel);
    };
  }, [selectedSessionId, isValidator, validatorTab, selectedSession?.validation_enabled]);

  useEffect(() => {
    if (!selectedSessionId) return;

    const reloadAfterOfflineSync = () => {
      if (isValidator) {
        markSessionTabStale(selectedSessionId, "registros");
        markSessionTabStale(selectedSessionId, "resumen");
        markSessionTabStale(selectedSessionId, "reconteo");
        void loadSessionData(selectedSessionId, validatorTab);
        return;
      }
      void loadRecordsData(selectedSessionId, operator?.id || null);
    };

    window.addEventListener("rasecorp-offline-sync-complete", reloadAfterOfflineSync);
    return () => window.removeEventListener("rasecorp-offline-sync-complete", reloadAfterOfflineSync);
  }, [selectedSessionId, isValidator, validatorTab, operator?.id]);

  useEffect(() => {
    if (!selectedSessionId || !isValidator || validatorTab !== "resumen") return;
    if (selectedSession?.status === "finished" || selectedSession?.status === "cancelled") return;

    // El trigger de BD (gi_stock_snapshot_sync_from_erp, migracion
    // 20260718120000) ya escribe el stock en vivo directo en
    // general_inventory_stock_snapshot -- este canal solo necesita avisarle
    // al cliente que se refresque, no volver a calcular nada el mismo.
    // Antes escuchaba cambios en stock_general, pero esa tabla nunca estuvo
    // habilitada para Realtime en Supabase (canal muerto, jamas disparaba).
    let timer: number | null = null;
    const flushStockChanges = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!pendingStockRefreshRef.current) return;
        pendingStockRefreshRef.current = false;
        void loadSummary(selectedSessionId, true)
          .catch(error => setMessage("No se pudo actualizar stock en tiempo real: " + (error instanceof Error ? error.message : String(error))));
      }, 1000);
    };

    const channel = supabase
      .channel(`gi-live-stock-${selectedSessionId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "general_inventory_stock_snapshot", filter: `session_id=eq.${selectedSessionId}` },
        () => {
          pendingStockRefreshRef.current = true;
          flushStockChanges();
        }
      )
      .subscribe();

    return () => {
      if (timer) window.clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [selectedSessionId, isValidator, validatorTab, summaryLoadedSessionId, sessions, stores, selectedSession?.stock_frozen_at, selectedSession?.status]);

  useEffect(() => {
    if (!selectedSessionId || !operator || isValidator) return;

    let timer: number | null = null;
    const reloadAssignedRecounts = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void loadOperatorRecountItems(selectedSessionId, operator.id);
      }, 1000);
    };

    const validationRealtimeEnabled = Boolean(selectedSession?.validation_enabled);
    let channel = supabase
      .channel(`gi-operator-recounts-${selectedSessionId}-${operator.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "general_inventory_recount_items", filter: `assigned_operator_id=eq.${operator.id}` },
        reloadAssignedRecounts
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "general_inventory_recount_counts", filter: `operator_id=eq.${operator.id}` },
        reloadAssignedRecounts
      );
    if (validationRealtimeEnabled) {
      channel = channel
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "general_inventory_validation_items", filter: `assigned_operator_id=eq.${operator.id}` },
          reloadAssignedRecounts
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "general_inventory_validation_counts", filter: `operator_id=eq.${operator.id}` },
          reloadAssignedRecounts
        );
    }
    channel.subscribe();

    return () => {
      if (timer) window.clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [selectedSessionId, operator?.id, isValidator, selectedSession?.validation_enabled]);

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
    if (!operator || isValidator) return;
    setOperatorLookupRows([]);
    setOperatorLookupMessage("");
  }, [selectedSessionId, operator?.id, isValidator]);

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
        setMessage(scannerPermissionMessage(err));
        await stopScanner();
      }
    })();
    return () => { cancelled = true; void stopScanner(false); };
  }, [scannerTarget]);

  async function startHtml5Scanner(isCancelled: () => boolean) {
    const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
    if (isCancelled()) return;
    const isIos = isIosDevice();
    const scanner = isIos
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
          Html5QrcodeSupportedFormats.QR_CODE,
        ],
      })
      : new Html5Qrcode(scannerContainerId);
    scannerRef.current = scanner;
    scannerBusyRef.current = false;
    const scanConfig = isIos
      ? {
        // En iPhone el código puede quedar fuera del recuadro pequeño.
        fps: 12,
        qrbox: { width: 360, height: 260 },
        disableFlip: true,
        videoConstraints: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: 15, max: 24 },
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
    if (isIos) startIosFrameScanner();
  }

  function startIosFrameScanner() {
    if (iosFrameScanTimerRef.current) window.clearInterval(iosFrameScanTimerRef.current);
    iosFrameScanTimerRef.current = window.setInterval(() => {
      void scanCurrentIosFrame();
    }, 500);
  }

  async function scanCurrentIosFrame() {
    if (!scannerTargetRef.current || scannerBusyRef.current || iosFrameBusyRef.current) return;
    const video = document.querySelector<HTMLVideoElement>(`#${scannerContainerId} video`);
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth <= 0 || video.videoHeight <= 0) return;

    iosFrameBusyRef.current = true;
    try {
      const frameFiles = await buildIosFrameScanFiles(video);
      if (frameFiles.length === 0) return;

      const { readBarcodes } = await import("zxing-wasm/reader");
      for (const file of frameFiles) {
        const results = await readBarcodes(file, {
          formats: ["Code128", "Code39", "Code39Ext", "Code93", "Codabar", "ITF", "EAN13", "EAN8", "UPCA", "UPCE", "QRCode"],
          tryHarder: true,
          tryRotate: true,
          tryInvert: true,
          tryDownscale: true,
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
    } catch {
      // Safari puede rechazar una captura concreta; se reintenta en el siguiente ciclo.
    } finally {
      iosFrameBusyRef.current = false;
    }
  }

  async function buildIosFrameScanFiles(video: HTMLVideoElement) {
    const width = video.videoWidth;
    const height = video.videoHeight;
    // No limitar la captura a la franja central: en Safari el vídeo puede
    // mostrarse recortado y el código puede estar arriba o abajo del visor.
    const box = { sx: width * 0.02, sy: height * 0.04, sw: width * 0.96, sh: height * 0.92 };
    const crops = [
      { name: "frame-full", sx: box.sx, sy: box.sy, sw: box.sw, sh: box.sh, scale: 1.25, contrast: 1.15 },
      { name: "frame-center", sx: box.sx, sy: box.sy + box.sh * 0.18, sw: box.sw, sh: box.sh * 0.64, scale: 1.7, contrast: 1.45 },
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
    const scale = Math.min(crop.scale, 1600 / Math.max(1, crop.sw));
    canvas.width = Math.max(1, Math.round(crop.sw * scale));
    canvas.height = Math.max(1, Math.round(crop.sh * scale));
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
      setLocationCode(normalizeLocationCode(clean));
      setMessage("Ubicación escaneada.");
      setTimeout(() => productInputRef.current?.focus(), 50);
    }
    if (target === "product") {
      const scannedCode = normalizeScannedBarcode(clean);
      setProductLookupMode("scan");
      productLookupModeRef.current = "scan";
      setProductCode(scannedCode);
      await validateScannedProduct(scannedCode);
    }
    if (target === "operator_lookup_product") {
      const scannedCode = normalizeScannedBarcode(clean);
      setOperatorLookupCode(scannedCode);
      await searchOperatorCodeRecords(scannedCode);
    }
    if (target === "recount_location" && activeRecountScanId) {
      const [rowId, indexText] = activeRecountScanId.split(":");
      const item = recountItems.find(row => row.id === rowId);
      if (item) updateRecountDraftLine(item, Number(indexText || 0), "locationCode", normalizeLocationCode(clean));
      setMessage("Ubicacion de reconteo escaneada.");
    }
    if (target === "recount_product" && activeRecountScanId) {
      const [rowId] = activeRecountScanId.split(":");
      updateRecountDraft(rowId, "productCode", normalizeScannedBarcode(clean));
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

  // Si dos tiendas comparten nombre (mismo nombre, distinto id en stores),
  // expande la busqueda a ambos ids para no perder sesiones registradas
  // bajo el id "hermano" del par.
  function expandStoreIds(id: string, storeList: Store[]): string[] {
    const target = storeList.find(s => s.id === id);
    if (!target) return [id];
    const key = String(target.name || "").trim().toLowerCase();
    const siblings = storeList.filter(s => String(s.name || "").trim().toLowerCase() === key).map(s => s.id);
    return siblings.length > 0 ? siblings : [id];
  }

  async function loadInitial(preferredSessionId = "", storeFilterOverride?: string) {
    setLoading(true);
    const filterValue = storeFilterOverride !== undefined ? storeFilterOverride : sessionsStoreFilter;
    const storesRes = await supabase.from("stores").select("*").eq("is_active", true).order("name");
    const storeRows = (storesRes.data || []) as Store[];

    let sessionsQuery = supabase
      .from("general_inventory_sessions")
      .select("*, stores(name)")
      .in("status", ["planned", "open", "frozen", "finished"])
      .order("created_at", { ascending: false })
      .limit(80);
    if (filterValue) sessionsQuery = sessionsQuery.in("store_id", expandStoreIds(filterValue, storeRows));
    const sessionsRes = await sessionsQuery;

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
    if (validatorTab === "reportes" && user?.role === "Administrador") {
      await loadFinishedGeneralInventoryReport();
      return;
    }
    if (selectedSessionId) await loadSessionData(selectedSessionId, validatorTab);
  }

  function ensureSelectedSessionEditable() {
    if (selectedSession?.status === "finished") {
      setMessage("Esta sesion esta finalizada. Solo se pueden consultar datos; para modificarla el administrador debe desfinalizarla.");
      return false;
    }
    return true;
  }

  async function loadSessionData(sessionId: string, tab: ValidatorTab = validatorTab) {
    const gen = ++sessionLoadGenRef.current;
    if (isValidator) {
      if (tab === "preparacion" && canManageInventory) {
        await loadPreparationData(sessionId);
        markSessionTabLoaded(sessionId, "preparacion");
        return;
      }
      if (tab === "registros") {
        await loadRecordsData(sessionId, null, gen);
        markSessionTabLoaded(sessionId, tab);
        return;
      }
      if (tab === "productividad") {
        await loadProductivityData(sessionId);
        markSessionTabLoaded(sessionId, "productividad");
        return;
      }
      if ((tab === "reconteo" || tab === "validacion") && canManageInventory) {
        await loadRecountData(sessionId, tab === "validacion");
        markSessionTabLoaded(sessionId, tab);
        return;
      }
      if (tab === "usuarios" && user?.role === "Administrador") {
        await loadInventoryOperators();
        markSessionTabLoaded(sessionId, "usuarios");
        return;
      }
      if (tab === "reportes" && user?.role === "Administrador") {
        await loadFinishedGeneralInventoryReport();
        markSessionTabLoaded(sessionId, "reportes");
        return;
      }
      await loadSummary(sessionId, summaryHasPendingChanges, gen);
      markSessionTabLoaded(sessionId, "resumen");
      return;
    }

    if (!operator?.id) {
      await loadPreparationData(sessionId);
      setCounts([]);
      return;
    }

    await Promise.all([loadPreparationData(sessionId), loadRecordsData(sessionId, operator.id, gen)]);
  }

  async function loadFinishedGeneralInventoryReport() {
    if (user?.role !== "Administrador") {
      setMessage("Solo el administrador puede ver este reporte.");
      return;
    }
    if (!finishedReportFrom || !finishedReportTo) {
      setMessage("Selecciona el rango de fechas del reporte.");
      return;
    }
    if (finishedReportFrom > finishedReportTo) {
      setMessage("La fecha inicial no puede ser mayor que la fecha final.");
      return;
    }

    setFinishedReportLoading(true);
    setMessage("");
    const { data, error } = await supabase.rpc("get_finished_general_inventory_report", {
      p_date_from: finishedReportFrom,
      p_date_to: finishedReportTo,
    });
    setFinishedReportLoading(false);

    if (error) {
      setMessage("No se pudo cargar el reporte. Ejecuta el SQL get_finished_general_inventory_report en Supabase: " + error.message);
      return;
    }
    const reportRows = (data || []) as FinishedGeneralInventoryReportRow[];
    // El RPC histórico no siempre incluye el nombre del usuario que finalizó
    // la sesión. Lo completamos desde la tabla de sesiones para que el
    // registro quede visible también en reportes generados con datos nuevos.
    const sessionIds = [...new Set(reportRows.map(row => row.session_id).filter(Boolean))];
    const finishedByName = new Map<string, string | null>();
    for (let index = 0; index < sessionIds.length; index += 500) {
      const chunk = sessionIds.slice(index, index + 500);
      const { data: sessionRows } = await supabase
        .from("general_inventory_sessions")
        .select("id,finished_by_name")
        .in("id", chunk);
      (sessionRows || []).forEach(row => finishedByName.set(String(row.id), row.finished_by_name || null));
    }
    setFinishedReportRows(reportRows.map(row => ({
      ...row,
      finished_by_name: row.finished_by_name || finishedByName.get(row.session_id) || null,
    })));
    setFinishedReportPage(1);
    setMessage(`Reporte cargado: ${(data || []).length} inventario(s) finalizado(s).`);
  }

  function exportFinishedGeneralInventoryReport() {
    if (finishedReportRows.length === 0) {
      setMessage("Primero carga el reporte de inventarios finalizados.");
      return;
    }
    const rows = finishedReportRows.map(row => ({
      Inventario: row.inventory_name,
      Tienda: row.store_name || "",
      FechaProgramada: dateOnly(row.scheduled_date),
      Finalizado: row.finished_at ? new Date(row.finished_at).toLocaleString("es-PE") : "",
      FinalizadoPor: row.finished_by_name || "",
      StockCongelado: row.stock_frozen_at ? new Date(row.stock_frozen_at).toLocaleString("es-PE") : "",
      DuracionMin: Number(row.duration_minutes || 0),
      CodigosTotales: Number(row.total_codes || 0),
      CodigosContados: Number(row.counted_codes || 0),
      CodigosOK: Number(row.ok_codes || 0),
      NoContados: Number(row.no_counted_codes || 0),
      Sobrantes: Number(row.surplus_codes || 0),
      Faltantes: Number(row.missing_codes || 0),
      CodigosDiferencia: Number(row.difference_codes || 0),
      ValorSistema: Number(row.system_value || 0),
      ValorContado: Number(row.counted_value || 0),
      ValorSobrante: Number(row.surplus_value || 0),
      ValorFaltante: Number(row.missing_value || 0),
      DiferenciaNeta: Number(row.net_value_diff || 0),
      DiferenciaAbs: Number(row.abs_value_diff || 0),
      ERI: Number(row.eri_pct || 0),
      VentasPeriodo: Number(row.sales_in_period || 0),
      DesviacionSobreVentaPct: row.deviation_over_sales_pct === null || row.deviation_over_sales_pct === undefined ? "" : Number(row.deviation_over_sales_pct),
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Inventarios finalizados");
    XLSX.writeFile(wb, `inventarios-finalizados-${finishedReportFrom}-${finishedReportTo}.xlsx`);
  }

  async function loadPreparationData(sessionId: string) {
    const [locationRows, countRows] = await Promise.all([
      loadPagedSessionRows("general_inventory_locations", "*", sessionId, "location_code"),
      loadPagedSessionRows("general_inventory_counts", "location_code", sessionId, "location_code"),
    ]);

    setLocations((locationRows as InventoryLocation[]).filter(row => row.is_active !== false).map(row => ({
      ...row,
      location_code: normalizeLocationCode(row.location_code),
      ticket: row.ticket ? normalizeLocationCode(row.ticket) : row.ticket,
    })));
    setCountedLocationCodes([...new Set(countRows.map(row => normalizeLocationCode(row.location_code)).filter(Boolean))]);
  }

  async function loadRecordsData(sessionId: string, operatorId: string | null = isValidator ? null : operator?.id || null, gen?: number) {
    if (!isValidator && !operatorId) {
      setCounts([]);
      setOperatorRecordsTotal(0);
      return;
    }

    try {
      const countRows = !isValidator && operatorId
        ? await loadOperatorCountsPage(sessionId, operatorId, operatorRecordsPage, recordsQuery)
        : await loadAllCounts(sessionId, operatorId);
      if (gen !== undefined && gen !== sessionLoadGenRef.current) return;
      const pendingRows = await loadPendingOfflineCountRows(sessionId, operatorId);
      if (gen !== undefined && gen !== sessionLoadGenRef.current) return;
      const rows = mergePendingCounts(countRows, (!isValidator && operatorId && operatorRecordsPage > 1) ? [] : pendingRows);
      setCounts(rows);
      if (!operatorId) setCountedLocationCodes([...new Set(rows.map(row => normalizeLocationCode(row.location_code)).filter(Boolean))]);
      if (isValidator && !operatorId) markSessionTabLoaded(sessionId, "registros");
    } catch (error) {
      setMessage("Error leyendo registros: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  async function loadProductivityLayerRows(sessionId: string, layer: "recount" | "validation") {
    const table = layer === "validation" ? "general_inventory_validation_counts" : "general_inventory_recount_counts";
    const rows = await loadPagedSessionRows(
      table,
      "operator_id,product_id,sku,general_inventory_operators(full_name)",
      sessionId,
      "operator_id"
    );
    return rows.map((row: any) => ({
      layer,
      operator_id: String(row.operator_id || ""),
      operator_name: row.general_inventory_operators?.full_name || null,
      product_id: String(row.product_id || ""),
      sku: String(row.sku || ""),
    })).filter(row => row.operator_id && (row.product_id || row.sku)) as ProductivityLayerRow[];
  }

  async function loadProductivityAssignedRows(sessionId: string, layer: "recount" | "validation") {
    const table = layer === "validation" ? "general_inventory_validation_items" : "general_inventory_recount_items";
    const rows = await loadPagedSessionRows(
      table,
      "assigned_operator_id,product_id,sku,status",
      sessionId,
      "assigned_operator_id"
    );
    return rows.map((row: any) => ({
      layer,
      operator_id: String(row.assigned_operator_id || ""),
      operator_name: null,
      product_id: String(row.product_id || ""),
      sku: String(row.sku || ""),
      status: String(row.status || ""),
    }))
      .filter(row => row.operator_id && row.status !== "cancelled" && (row.product_id || row.sku))
      .map(({ status, ...row }) => row) as ProductivityAssignedRow[];
  }

  async function loadOperatorNameMap(operatorIds: string[]) {
    const ids = [...new Set(operatorIds.filter(Boolean))];
    const names = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 500) {
      const { data, error } = await supabase
        .from("general_inventory_operators")
        .select("id,full_name")
        .in("id", ids.slice(i, i + 500));
      if (error) throw error;
      for (const row of data || []) names.set(String(row.id), String(row.full_name || "Sin usuario"));
    }
    return names;
  }

  async function loadProductivityData(sessionId: string) {
    try {
      const validationEnabled = Boolean((sessions.find(session => session.id === sessionId) || selectedSession)?.validation_enabled);
      const [countRows, pendingRows, recountRows, validationRows, assignedRecountRows, assignedValidationRows] = await Promise.all([
        loadAllCounts(sessionId, null),
        loadPendingOfflineCountRows(sessionId, null),
        loadProductivityLayerRows(sessionId, "recount"),
        validationEnabled ? loadProductivityLayerRows(sessionId, "validation") : Promise.resolve([] as ProductivityLayerRow[]),
        loadProductivityAssignedRows(sessionId, "recount"),
        validationEnabled ? loadProductivityAssignedRows(sessionId, "validation") : Promise.resolve([] as ProductivityAssignedRow[]),
      ]);
      const rows = mergePendingCounts(countRows, pendingRows);
      const nextLayerRows = [...recountRows, ...validationRows];
      const nextAssignedRows = [...assignedRecountRows, ...assignedValidationRows];
      const operatorNames = await loadOperatorNameMap([
        ...rows.map(row => row.operator_id),
        ...nextLayerRows.map(row => row.operator_id),
        ...nextAssignedRows.map(row => row.operator_id),
      ]);
      setCounts(rows.map(row => ({ ...row, operator_name: row.operator_name || operatorNames.get(row.operator_id) || null })));
      setProductivityLayerRows(nextLayerRows.map(row => ({ ...row, operator_name: row.operator_name || operatorNames.get(row.operator_id) || null })));
      setProductivityAssignedRows(nextAssignedRows.map(row => ({ ...row, operator_name: row.operator_name || operatorNames.get(row.operator_id) || null })));
      setCountedLocationCodes([...new Set(rows.map(row => normalizeLocationCode(row.location_code)).filter(Boolean))]);
      markSessionTabLoaded(sessionId, "productividad");
    } catch (error) {
      setMessage("Error leyendo productividad: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  async function searchOperatorCodeRecords(rawCode = operatorLookupCode) {
    if (!operator || !selectedSessionId || isValidator) return;
    const query = normalizeCode(rawCode).toUpperCase();
    if (!query) {
      setOperatorLookupRows([]);
      setOperatorLookupMessage("Ingresa un codigo para consultar.");
      return;
    }
    setOperatorLookupLoading(true);
    setOperatorLookupMessage("");
    try {
      const productResult = await findProductCandidates(query, "scan");
      const skus = [...new Set([
        query,
        ...barcodeVariants(query),
        ...productResult.products.map(product => normalizeCode(product.sku).toUpperCase()),
      ].filter(Boolean))];

      const { data, error } = await supabase
        .from("general_inventory_counts")
        .select("*, general_inventory_operators(full_name)")
        .eq("session_id", selectedSessionId)
        .in("sku", skus)
        .order("counted_at", { ascending: false })
        .limit(80);

      if (error) throw error;
      const rows = ((data || []) as any[]).map(row => ({
        ...row,
        operator_name: row.general_inventory_operators?.full_name || null,
      })) as CountRow[];
      setOperatorLookupRows(rows);
      setOperatorLookupMessage(rows.length > 0 ? `${rows.length} registro(s) encontrados.` : "No hay registros guardados para ese codigo en esta sesion.");
    } catch (error) {
      setOperatorLookupRows([]);
      setOperatorLookupMessage("No se pudo consultar registros: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setOperatorLookupLoading(false);
    }
  }

  async function loadOperatorCountsPage(sessionId: string, operatorId: string, page: number, rawQuery: string): Promise<CountRow[]> {
    setOperatorRecordsLoading(true);
    try {
      const { rows, total } = await fetchOperatorCountsPage(supabase, { sessionId, operatorId, page, query: rawQuery });
      setOperatorRecordsTotal(total);
      return rows;
    } finally {
      setOperatorRecordsLoading(false);
    }
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
          location_code: normalizeLocationCode(payload.location_code),
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

  async function loadRecountData(sessionId: string, validationMode = isValidationManagerTab) {
    await Promise.all([
      loadPreparationData(sessionId),
      loadRecordsData(sessionId),
      loadSummary(sessionId),
      loadRecountAssignments(sessionId, validationMode),
      loadAdminRecountRecords(sessionId, validationMode),
    ]);
    markSessionTabLoaded(sessionId, validationMode ? "validacion" : "reconteo");
  }

  async function loadOriginalCountedByProductLocation(sessionId: string, productIds: string[]) {
    const originalByLocation = new Map<string, number>();
    const cleanProductIds = [...new Set(productIds.filter(Boolean))];
    for (let i = 0; i < cleanProductIds.length; i += 100) {
      const chunk = cleanProductIds.slice(i, i + 100);
      const { data, error } = await supabase
        .from("general_inventory_counts")
        .select("product_id,sku,location_id,location_code,quantity")
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
        const skuCodeKey = `sku__${normalizeCode(row.sku).toUpperCase()}__code__${normalizeLocationCode(row.location_code)}`;
        originalByLocation.set(skuCodeKey, (originalByLocation.get(skuCodeKey) || 0) + qty);
        if (row.location_id) {
          const idKey = `${row.product_id}__id__${row.location_id}`;
          originalByLocation.set(idKey, (originalByLocation.get(idKey) || 0) + qty);
          const skuIdKey = `sku__${normalizeCode(row.sku).toUpperCase()}__id__${row.location_id}`;
          originalByLocation.set(skuIdKey, (originalByLocation.get(skuIdKey) || 0) + qty);
        }
      }
    }
    return originalByLocation;
  }

  async function loadAdminRecountRecordsForLayer(sessionId: string, validationMode: boolean) {
    const countTable = validationMode ? "general_inventory_validation_counts" : "general_inventory_recount_counts";
    const itemTable = validationMode ? "general_inventory_validation_items" : "general_inventory_recount_items";
    const itemIdColumn = validationMode ? "validation_item_id" : "recount_item_id";

    let countRows: any[] = [];
    try {
      countRows = await loadPagedSessionRows(countTable, "*, general_inventory_operators(full_name)", sessionId, "updated_at");
    } catch (error) {
      setMessage(`No se pudieron leer registros de ${validationMode ? "validacion" : "reconteo"}: ` + (error instanceof Error ? error.message : String(error)));
      return [];
    }

    countRows.sort((a, b) => new Date(b.updated_at || b.counted_at || 0).getTime() - new Date(a.updated_at || a.counted_at || 0).getTime());
    const itemIds = [...new Set(countRows.map(row => String(row[itemIdColumn] || "")).filter(Boolean))];
    const itemRows: any[] = [];
    for (let i = 0; i < itemIds.length; i += 100) {
      const chunk = itemIds.slice(i, i + 100);
      const itemRowsRes = await supabase
        .from(itemTable)
        .select("*")
        .in("id", chunk);
      if (itemRowsRes.error) {
        setMessage(`No se pudieron leer detalles de ${validationMode ? "validacion" : "reconteo"}: ` + itemRowsRes.error.message);
        return [];
      }
      itemRows.push(...(itemRowsRes.data || []));
    }

    const productIds = [...new Set([
      ...countRows.map(row => String(row.product_id || "")).filter(Boolean),
      ...itemRows.map(row => String(row.product_id || "")).filter(Boolean),
    ])];
    const originalByLocation = await loadOriginalCountedByProductLocation(sessionId, productIds);

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
      layer: validationMode ? "validation" : "recount",
      source_recount_item_id: row.source_recount_item_id || null,
    } as RecountItem]));

    const rows = countRows
      .map(countRow => {
        const item = itemById.get(String(countRow[itemIdColumn] || "")) || {
          id: String(countRow[itemIdColumn] || ""),
          product_id: String(countRow.product_id || ""),
          sku: String(countRow.sku || ""),
          description: String(countRow.description || ""),
          unit: String(countRow.unit || ""),
          location_id: countRow.location_id ? String(countRow.location_id) : null,
          location_code: countRow.location_code || null,
          full_location: countRow.location_code || null,
          zone: null,
          zone_ref: null,
          lineal: null,
          ticket: countRow.location_code || null,
          recount_type: validationMode ? "missing" : "surplus",
          system_stock: 0,
          counted_qty: 0,
          diff_qty: 0,
          cost_snapshot: Number(countRow.cost_snapshot || 0),
          value_diff: 0,
          location_count: 0,
          original_locations: [],
          assigned_operator_id: String(countRow.operator_id || "") || null,
          assigned_operator_name: countRow.general_inventory_operators?.full_name || null,
          status: "counted",
          layer: validationMode ? "validation" : "recount",
          source_recount_item_id: null,
        } as RecountItem;
        const locationId = String(countRow.location_id || "");
        const locationCode = normalizeLocationCode(countRow.location_code);
        const productIdsToCheck = [...new Set([String(countRow.product_id || ""), item.product_id].filter(Boolean))];
        const skusToCheck = [...new Set([String(countRow.sku || ""), item.sku].map(sku => normalizeCode(sku).toUpperCase()).filter(Boolean))];
        let originalQuantity = 0;
        for (const productId of productIdsToCheck) {
          const byId = locationId ? originalByLocation.get(`${productId}__id__${locationId}`) : undefined;
          const byCode = locationCode ? originalByLocation.get(`${productId}__code__${locationCode}`) : undefined;
          if (byId !== undefined || byCode !== undefined) {
            originalQuantity = byId ?? byCode ?? 0;
            break;
          }
        }
        if (originalQuantity === 0) {
          for (const sku of skusToCheck) {
            const byId = locationId ? originalByLocation.get(`sku__${sku}__id__${locationId}`) : undefined;
            const byCode = locationCode ? originalByLocation.get(`sku__${sku}__code__${locationCode}`) : undefined;
            if (byId !== undefined || byCode !== undefined) {
              originalQuantity = byId ?? byCode ?? 0;
              break;
            }
          }
        }
        return {
          id: String(countRow.id || ""),
          recount_item_id: String(countRow[itemIdColumn] || ""),
          operator_id: String(countRow.operator_id || ""),
          operator_name: countRow.general_inventory_operators?.full_name || null,
          location_id: countRow.location_id ? String(countRow.location_id) : null,
          location_code: String(countRow.location_code || ""),
          product_id: String(countRow.product_id || item.product_id || ""),
          sku: String(countRow.sku || item.sku || ""),
          description: String(countRow.description || item.description || ""),
          unit: String(countRow.unit || item.unit || ""),
          quantity: Number(countRow.quantity || 0),
          original_quantity: originalQuantity,
          cost_snapshot: Number(countRow.cost_snapshot || item.cost_snapshot || 0),
          counted_at: String(countRow.counted_at || ""),
          updated_at: String(countRow.updated_at || countRow.counted_at || ""),
          item,
        } as OperatorRecountRecord;
      })
      .filter(Boolean) as OperatorRecountRecord[];
    return rows;
  }

  async function loadAdminRecountRecords(sessionId: string, validationMode = isValidationManagerTab) {
    const validationEnabled = Boolean((sessions.find(session => session.id === sessionId) || selectedSession)?.validation_enabled);
    if (validationEnabled) {
      const [recountRows, validationRows] = await Promise.all([
        loadAdminRecountRecordsForLayer(sessionId, false),
        loadAdminRecountRecordsForLayer(sessionId, true),
      ]);
      setAdminRecountRecords([...recountRows, ...validationRows].sort((a, b) => new Date(b.updated_at || b.counted_at || 0).getTime() - new Date(a.updated_at || a.counted_at || 0).getTime()));
      return;
    }
    setAdminRecountRecords(await loadAdminRecountRecordsForLayer(sessionId, validationMode));
  }

  async function switchAdminRecordLayer(layer: "all" | "recount" | "validation") {
    setAdminRecordLayer(layer);
    if (selectedSessionId) await loadAdminRecountRecords(selectedSessionId, layer === "validation");
  }

  async function loadRecountAssignments(sessionId: string, validationMode = isValidationManagerTab) {
    const itemTable = validationMode ? "general_inventory_validation_items" : "general_inventory_recount_items";
    const countTable = validationMode ? "general_inventory_validation_counts" : "general_inventory_recount_counts";
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
        .from(countTable)
        .select("operator_id")
        .eq("session_id", sessionId),
      supabase
        .from(itemTable)
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
      setMessage(`Error leyendo ${validationMode ? "validaciones" : "reconteos"} guardados: ` + recountCountOperatorsRes.error.message);
    }
    if (itemsRes.error) {
      setMessage(`Ejecuta primero el SQL de ${validationMode ? "validacion" : "reconteo"}. Error: ` + itemsRes.error.message);
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
      layer: validationMode ? "validation" : "recount",
      source_recount_item_id: row.source_recount_item_id || null,
    })) as RecountItem[]);
    setRecountItems(rows);
    setReassignOperatorDrafts(Object.fromEntries(rows.map(row => [row.id, row.assigned_operator_id || ""])));
  }

  async function toggleManualRecountMode() {
    if (!ensureSelectedSessionEditable()) return;
    if (!selectedSessionId || !canManageInventory) {
      setMessage("Solo el validador o administrador puede cambiar el modo de reconteo manual.");
      return;
    }
    const nextValue = !Boolean(selectedSession?.manual_recount_enabled);
    const { error } = await supabase
      .from("general_inventory_sessions")
      .update({ manual_recount_enabled: nextValue, updated_at: new Date().toISOString() })
      .eq("id", selectedSessionId);
    if (error) {
      setMessage("No se pudo cambiar el seguro de reconteo manual. Ejecuta el SQL actualizado: " + error.message);
      return;
    }
    setSessions(prev => prev.map(session => session.id === selectedSessionId ? { ...session, manual_recount_enabled: nextValue } : session));
    if (nextValue && operatorMode === "reconteo") {
      setOperatorMode("conteo");
      localStorage.setItem(OPERATOR_MODE_KEY, "conteo");
    }
    setMessage(nextValue
      ? "Reconteo manual activado. Los operarios ya no veran reconteos asignados en la app."
      : "Reconteo manual desactivado. Los operarios podran ver sus reconteos asignados en la app."
    );
  }

  async function toggleValidationPlan() {
    if (!ensureSelectedSessionEditable()) return;
    if (!selectedSessionId || user?.role !== "Administrador") {
      setMessage("Solo el administrador puede activar o desactivar el plan de validacion.");
      return;
    }
    const nextValue = !Boolean(selectedSession?.validation_enabled);
    const { error } = await supabase
      .from("general_inventory_sessions")
      .update({ validation_enabled: nextValue, updated_at: new Date().toISOString() })
      .eq("id", selectedSessionId);
    if (error) {
      setMessage("No se pudo cambiar el plan de validacion. Ejecuta el SQL actualizado: " + error.message);
      return;
    }
    setSessions(prev => prev.map(session => session.id === selectedSessionId ? { ...session, validation_enabled: nextValue } : session));
    setMessage(nextValue
      ? "Plan de validacion activado. Desde ahora el resumen priorizara validacion sobre reconteo cuando exista."
      : "Plan de validacion desactivado. El resumen volvera a priorizar reconteo sobre conteo."
    );
    if (selectedSessionId) await loadSummary(selectedSessionId, true);
  }

  async function loadValidationSummaryRows(sessionId: string, enabled: boolean) {
    if (!enabled) return { validationCountRows: [] as Array<Record<string, any>>, validationItemRows: [] as Array<Record<string, any>> };
    try {
      const [validationCountRows, validationItemRows] = await Promise.all([
        loadPagedSessionRows("general_inventory_validation_counts", "validation_item_id,product_id,sku,description,unit,quantity,cost_snapshot,counted_at,updated_at", sessionId, "sku"),
        loadPagedSessionRows("general_inventory_validation_items", "id,product_id,status,recount_type,created_at,updated_at", sessionId, "product_id"),
      ]);
      return { validationCountRows, validationItemRows };
    } catch (error: unknown) {
      setMessage("Plan de validacion activo, pero faltan las tablas de validacion. Ejecuta el SQL actualizado: " + (error instanceof Error ? error.message : String(error)));
      return { validationCountRows: [] as Array<Record<string, any>>, validationItemRows: [] as Array<Record<string, any>> };
    }
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
    const sessionState = await supabase
      .from("general_inventory_sessions")
      .select("validation_enabled,manual_recount_enabled")
      .eq("id", sessionId)
      .maybeSingle();
    const sessionStateData = sessionState.data;
    if (sessionStateData) {
      setSessions(prev => prev.map(session => session.id === sessionId
        ? {
          ...session,
          validation_enabled: Boolean(sessionStateData.validation_enabled),
          manual_recount_enabled: Boolean(sessionStateData.manual_recount_enabled),
        }
        : session
      ));
    }
    const operatorIds = new Set([operatorId]);
    if (operator?.phone) {
      const samePhone = await supabase
        .from("general_inventory_operators")
        .select("id")
        .eq("phone", operator.phone);
      for (const row of samePhone.data || []) operatorIds.add(row.id);
    }

    const loadAssignedLayer = async (layer: "recount" | "validation") => {
      const layerValidationMode = layer === "validation";
      const { data, error } = await supabase
        .from(layerValidationMode ? "general_inventory_validation_items" : "general_inventory_recount_items")
        .select("*")
        .eq("session_id", sessionId)
        .in("assigned_operator_id", [...operatorIds])
        .order("location_code", { ascending: true, nullsFirst: false })
        .order("value_diff", { ascending: false });
      if (error) {
        setMessage(`No se pudo leer ${layerValidationMode ? "validaciones" : "reconteos"} asignados: ${error.message}`);
        return [] as RecountItem[];
      }
      return (data || []).map((row: any) => ({
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
      layer,
      source_recount_item_id: row.source_recount_item_id || null,
      })) as RecountItem[];
    };

    const assignedRows = [
      ...(await loadAssignedLayer("recount")),
      ...(await loadAssignedLayer("validation")),
    ];
    const mappedRows = sortOperatorRecountCards(assignedRows);

    const productIds = [...new Set(mappedRows.map(row => row.product_id).filter(Boolean))];
    const skus = [...new Set(mappedRows.map(row => normalizeCode(row.sku).toUpperCase()).filter(Boolean))];
    const locationsRequest = supabase
      .from("general_inventory_locations")
      .select("*")
      .eq("session_id", sessionId)
      .eq("is_active", true);
    const [originalCountRowsRes, recountCountRowsRes, locationsRes] = productIds.length > 0 || skus.length > 0
      ? await Promise.all([
        supabase
          .from("general_inventory_counts")
          .select("product_id,sku,location_id,location_code,quantity")
          .eq("session_id", sessionId)
          .or([
            productIds.length > 0 ? `product_id.in.(${productIds.join(",")})` : "",
            skus.length > 0 ? `sku.in.(${skus.map(sku => `"${sku}"`).join(",")})` : "",
          ].filter(Boolean).join(",")),
        supabase
          .from("general_inventory_recount_counts")
          .select("recount_item_id,product_id,sku,location_id,location_code,quantity")
          .eq("session_id", sessionId)
          .or([
            productIds.length > 0 ? `product_id.in.(${productIds.join(",")})` : "",
            skus.length > 0 ? `sku.in.(${skus.map(sku => `"${sku}"`).join(",")})` : "",
          ].filter(Boolean).join(",")),
        locationsRequest,
      ])
      : [{ data: [] }, { data: [] }, await locationsRequest];
    const activeLocations = (locationsRes.data || []) as InventoryLocation[];
    setLocations(activeLocations);
    const locationById = new Map(activeLocations.map(row => [row.id, row]));
    const linesByLayerProduct = new Map<string, RecountLocationLine[]>();
    const addSourceLines = (sourceLayer: "recount" | "validation", countRows: any[]) => {
      for (const countRow of countRows || []) {
        const productId = String(countRow.product_id || "");
        const loc = locationById.get(String(countRow.location_id || "")) || findInventoryLocation(activeLocations, countRow.location_code || "");
        const code = normalizeLocationCode(countRow.location_code || loc?.location_code || "");
        if (!code) continue;
        const sku = normalizeCode(countRow.sku).toUpperCase();
        const keys = [
          productId ? `${sourceLayer}__product__${productId}` : "",
          sku ? `${sourceLayer}__sku__${sku}` : "",
        ].filter(Boolean);
        for (const key of keys) {
          if (!linesByLayerProduct.has(key)) linesByLayerProduct.set(key, []);
          const rows = linesByLayerProduct.get(key)!;
          const existing = rows.find(row => normalizeLocationCode(row.location_code) === code);
          if (existing) {
            existing.counted_qty += Number(countRow.quantity || 0);
          } else {
            rows.push({
              id: `${productId || sku}__${code}`,
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
      }
    };
    addSourceLines("recount", originalCountRowsRes.data || []);
    addSourceLines("validation", recountCountRowsRes.data || []);

    const rowsWithLocations = mappedRows.map(row => {
      const rowLayer = row.layer === "validation" ? "validation" : "recount";
      const productLocations = linesByLayerProduct.get(`${rowLayer}__product__${row.product_id}`) || [];
      const skuLocations = linesByLayerProduct.get(`${rowLayer}__sku__${normalizeCode(row.sku).toUpperCase()}`) || [];
      const sourceLocationsByCode = new Map<string, RecountLocationLine>();
      for (const location of [...productLocations, ...skuLocations]) {
        const code = normalizeLocationCode(location.location_code);
        if (!code || sourceLocationsByCode.has(code)) continue;
        sourceLocationsByCode.set(code, location);
      }
      const originalLocations = [...sourceLocationsByCode.values()]
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
    const editingItemId = editingRecountItemIdRef.current;
    setRecountItems(rowsWithLocations.filter(row => !["counted", "cancelled"].includes(row.status || "") || row.id === editingItemId));
    const itemById = new Map(rowsWithLocations.map(row => [row.id, row]));

    const loadSavedLayerRecords = async (layer: "recount" | "validation") => {
      const layerValidationMode = layer === "validation";
      const layerCountTable = layerValidationMode ? "general_inventory_validation_counts" : "general_inventory_recount_counts";
      const layerItemTable = layerValidationMode ? "general_inventory_validation_items" : "general_inventory_recount_items";
      const layerItemIdColumn = layerValidationMode ? "validation_item_id" : "recount_item_id";
      const savedRes = await supabase
        .from(layerCountTable)
        .select("*")
        .eq("session_id", sessionId)
        .in("operator_id", [...operatorIds])
        .order("counted_at", { ascending: false });
      if (savedRes.error) {
        setMessage(`No se pudo leer registros guardados de ${layerValidationMode ? "validacion" : "reconteo"}: ${savedRes.error.message}`);
        return [] as OperatorRecountRecord[];
      }
      const savedRows = (savedRes.data || []) as any[];
      const savedItemIds = [...new Set(savedRows.map(row => String(row[layerItemIdColumn] || "")).filter(Boolean))];
      const savedItems = new Map<string, RecountItem>();
      for (const [id, item] of itemById.entries()) {
        if ((item.layer === "validation" ? "validation" : "recount") === layer) savedItems.set(id, item);
      }
      for (let i = 0; i < savedItemIds.length; i += 100) {
        const chunk = savedItemIds.slice(i, i + 100).filter(id => !savedItems.has(id));
        if (chunk.length === 0) continue;
        const itemsRes = await supabase
          .from(layerItemTable)
          .select("*")
          .in("id", chunk);
        if (itemsRes.error) {
          setMessage(`No se pudo leer detalle de registros de ${layerValidationMode ? "validacion" : "reconteo"}: ${itemsRes.error.message}`);
          continue;
        }
        for (const row of itemsRes.data || []) {
          savedItems.set(String(row.id), {
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
            assigned_operator_name: operator?.full_name || null,
            status: row.status || "counted",
            layer,
            source_recount_item_id: row.source_recount_item_id || null,
          } as RecountItem);
        }
      }
      return savedRows.map(countRow => {
        const itemId = String(countRow[layerItemIdColumn] || "");
        const item = savedItems.get(itemId) || {
          id: itemId,
          product_id: String(countRow.product_id || ""),
          sku: String(countRow.sku || ""),
          description: String(countRow.description || ""),
          unit: String(countRow.unit || ""),
          location_id: countRow.location_id ? String(countRow.location_id) : null,
          location_code: countRow.location_code || null,
          full_location: countRow.location_code || null,
          zone: null,
          zone_ref: null,
          lineal: null,
          ticket: countRow.location_code || null,
          recount_type: "missing",
          system_stock: 0,
          counted_qty: 0,
          diff_qty: 0,
          cost_snapshot: Number(countRow.cost_snapshot || 0),
          value_diff: 0,
          location_count: 0,
          original_locations: [],
          assigned_operator_id: String(countRow.operator_id || "") || null,
          assigned_operator_name: operator?.full_name || null,
          status: "counted",
          layer,
          source_recount_item_id: null,
        } as RecountItem;
        return {
          id: String(countRow.id || ""),
          recount_item_id: itemId,
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
      });
    };

    const savedRecords = [
      ...(await loadSavedLayerRecords("recount")),
      ...(await loadSavedLayerRecords("validation")),
    ].sort((a, b) => new Date(b.updated_at || b.counted_at || 0).getTime() - new Date(a.updated_at || a.counted_at || 0).getTime());
    setOperatorRecountRecords(savedRecords);
  }

  async function loadAllCounts(sessionId: string, operatorId: string | null = null): Promise<CountRow[]> {
    return fetchAllInventoryCounts(supabase, { sessionId, operatorId });
  }

  async function loadPagedSessionRows(table: string, select: string, sessionId: string, orderColumn = "id"): Promise<any[]> {
    try {
      return await fetchPagedSessionRows(supabase, { table, select, sessionId, orderColumn });
    } catch (error) {
      setMessage(`Error leyendo ${table}: ` + (error instanceof Error ? error.message : String(error)));
      return [];
    }
  }

  async function loadInventoryNonInventoryRows(sessionId: string): Promise<Array<{ sku: string }>> {
    return fetchInventoryNonInventoryRows(supabase, sessionId);
  }

  async function loadNonInventorySkuSetForProducts(sessionId: string, skus: string[]): Promise<Set<string>> {
    return fetchNonInventorySkuSetForProducts(supabase, { sessionId, skus });
  }

  async function loadStockGeneralBySkuForSession(sessionId: string, skus: string[]): Promise<Map<string, StockGeneralRow>> {
    const session = sessions.find(row => row.id === sessionId) || selectedSession;
    try {
      return await fetchStockGeneralBySkuForSession(supabase, { session, stores, skus });
    } catch (error) {
      setMessage("No se pudo cruzar stock actual de la tienda: " + (error instanceof Error ? error.message : String(error)));
      return new Map<string, StockGeneralRow>();
    }
  }

  async function loadProductCategories(productIds: string[]) {
    try {
      return await fetchProductCategories(supabase, productIds);
    } catch (error) {
      console.warn("No se pudieron cargar categorias de productos:", error);
      return new Map<string, Pick<SummaryRow, "brand" | "department" | "class_name" | "subclass_name">>();
    }
  }

  async function loadProductRotationsForSession(session: InventorySession | null | undefined, skus: string[]) {
    try {
      return await fetchProductRotationsForSession(supabase, { session, stores, skus });
    } catch (error) {
      console.warn("No se pudieron cargar rotaciones mensuales:", error);
      return new Map<string, string>();
    }
  }

  async function loadSummaryFromRpc(sessionId: string): Promise<SummaryRow[] | null> {
    const session = sessions.find(row => row.id === sessionId) || selectedSession;
    return fetchSummaryRowsFromRpc(supabase, { sessionId, session, stores });
  }

  function sessionSede(sessionId: string) {
    const session = sessions.find(row => row.id === sessionId) || selectedSession;
    const store = stores.find(row => row.id === session?.store_id);
    return store?.erp_sede || store?.name || session?.store_name || "";
  }

  // Chequeo "OK" en vivo (no depende de `summary` en memoria, que puede estar
  // desactualizado) -- usa la misma funcion SQL (gi_snapshot_counted_qty) que
  // ya usa el trigger de sincronizacion en tiempo real, para que la nocion de
  // "esta OK" sea identica en cliente y servidor.
  async function checkProductCurrentlyOk(sessionId: string, productId: string): Promise<{ ok: boolean; systemStock: number; counted: number }> {
    const session = sessions.find(row => row.id === sessionId) || selectedSession;
    const [{ data: snapshotRow }, { data: countedValue, error: rpcError }] = await Promise.all([
      supabase.from("general_inventory_stock_snapshot").select("system_stock").eq("session_id", sessionId).eq("product_id", productId).maybeSingle(),
      supabase.rpc("gi_snapshot_counted_qty", {
        p_session_id: sessionId,
        p_product_id: productId,
        p_validation_enabled: Boolean(session?.validation_enabled),
      }),
    ]);
    if (rpcError) throw rpcError;
    const systemStock = Number(snapshotRow?.system_stock || 0);
    const counted = Number(countedValue || 0);
    return { ok: counted > 0 && counted === systemStock, systemStock, counted };
  }

  // Refresca el stock en vivo del ERP para UN solo producto de una sesion --
  // se llama cuando YA se confirmo que este producto dejo de estar OK por
  // una edicion, para que no se quede esperando al proximo cambio real de
  // stock_general (que puede tardar).
  async function refreshSingleProductStockFromErp(sessionId: string, productId: string, sku: string) {
    const sede = sessionSede(sessionId);
    if (!sede) return;
    const codsap = normalizeCode(sku).toUpperCase();
    if (!codsap) return;

    const [stockRes, productRes] = await Promise.all([
      supabase.from("stock_general").select("stock,costo").eq("sede", sede).eq("codsap", codsap).maybeSingle(),
      supabase.from("cyclic_products").select("id,sku,description,unit,cost").eq("id", productId).maybeSingle(),
    ]);
    if (!productRes.data) return;

    await supabase.from("general_inventory_stock_snapshot").upsert({
      session_id: sessionId,
      product_id: productId,
      sku: productRes.data.sku,
      description: productRes.data.description,
      unit: productRes.data.unit,
      system_stock: Number(stockRes.data?.stock || 0),
      cost: Number(stockRes.data?.costo ?? productRes.data.cost ?? 0),
      frozen_at: new Date().toISOString(),
    }, { onConflict: "session_id,product_id" });
  }

  // Barrido completo de stock_general (todo lo que tenga stock>0 en la sede,
  // no solo los SKUs ya conocidos por la sesion) para que un codigo que gana
  // stock mientras la sesion sigue abierta entre al resumen para su revision,
  // sin esperar a que alguien lo cuente o a que se finalice. A diferencia de
  // saveStockSnapshotInBatches, esta funcion NO cambia el estado de la sesion
  // (no congela/finaliza nada) - se usa para mantener la foto al dia mientras
  // la sesion sigue activa (refresco automatico cada 55s y el boton manual
  // "Actualizar stock ERP"). Los productos ya OK (contado = sistema) nunca se
  // tocan.
  async function refreshFullSessionSnapshotFromErp(sessionId: string): Promise<number | null> {
    const session = sessions.find(row => row.id === sessionId) || selectedSession;
    const store = stores.find(row => row.id === session?.store_id);
    const sede = store?.erp_sede || store?.name || session?.store_name || "";
    if (!sede) return null;

    const protectedProductIds = await loadProtectedOkProductIdsForStockUpdate(sessionId);
    const nonInventoryRows = await loadInventoryNonInventoryRows(sessionId);
    const nonInventorySkus = new Set(nonInventoryRows.map(row => normalizeCode(row.sku).toUpperCase()));
    const deleteError = await deleteUnprotectedSnapshotRows(sessionId, protectedProductIds);
    if (deleteError) return null;

    let inserted = protectedProductIds.size;
    let from = 0;
    const pageSize = 1000;
    const upsertedProductIds = new Set<string>();
    while (true) {
      const stockRes = await supabase
        .from("stock_general")
        .select("codsap,stock,costo")
        .eq("sede", sede)
        .gt("stock", 0)
        .order("codsap", { ascending: true })
        .range(from, from + pageSize - 1);
      if (stockRes.error) return null;

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
        if (productsRes.error) return null;
        const rows = ((productsRes.data || []) as Product[]).filter(product => !protectedProductIds.has(product.id)).map(product => {
          const stock = stockBySku.get(normalizeCode(product.sku).toUpperCase());
          const systemStock = Number(stock?.stock || 0);
          const cost = Number(stock?.costo ?? product.cost ?? 0);
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
          if (upsertRes.error) return null;
          for (const row of rows) upsertedProductIds.add(row.product_id);
          inserted += rows.length;
        }
      }

      if (stockRows.length < pageSize) break;
      from += pageSize;
    }

    // Limpieza de fantasmas: productos que quedaron en el snapshot pero ya
    // no tienen stock live (y no estan protegidos por estar OK).
    const postUpsertSnapshot = await loadPagedSessionRows("general_inventory_stock_snapshot", "id,product_id", sessionId, "product_id");
    const phantomIds = postUpsertSnapshot
      .filter(row => {
        const pid = String(row.product_id || "");
        return pid && !protectedProductIds.has(pid) && !upsertedProductIds.has(pid);
      })
      .map(row => String(row.id || ""))
      .filter(Boolean);
    for (let i = 0; i < phantomIds.length; i += 500) {
      await supabase.from("general_inventory_stock_snapshot").delete().in("id", phantomIds.slice(i, i + 500));
    }

    return inserted;
  }

  async function fetchAllSkusFromTable(sessionId: string, table: string): Promise<string[]> {
    const PAGE = 1000;
    const all: string[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from(table)
        .select("sku")
        .eq("session_id", sessionId)
        .range(from, from + PAGE - 1);
      if (error) throw error;
      const chunk = (data || []).map((r: any) => String(r.sku || "")).filter(Boolean);
      all.push(...chunk);
      if (chunk.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }

  async function fetchAllSnapshotSkus(sessionId: string): Promise<string[]> {
    return fetchAllSkusFromTable(sessionId, "general_inventory_stock_snapshot");
  }

  async function forceRefreshNonOkStock() {
    if (!selectedSessionId || user?.role !== "Administrador") return;
    setRefreshingNonOkStock(true);
    setMessage("Sincronizando stock del inventario con ERP...");
    try {
      // Barrido completo (no solo SKUs ya conocidos): tambien trae codigos
      // nuevos que ganaron stock en el ERP y todavia no estaban en la sesion.
      const updatedCount = await refreshFullSessionSnapshotFromErp(selectedSessionId);
      if (updatedCount === null) { setMessage("No se pudo sincronizar stock: no se encontro la sede ERP del inventario."); return; }
      await loadSummary(selectedSessionId, true);
      setMessage(`Stock sincronizado: ${updatedCount} codigos en la foto (los ya contados OK no se tocan).`);
    } catch (error) {
      setMessage("Error al sincronizar stock: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setRefreshingNonOkStock(false);
    }
  }

  async function protectOkProductSnapshot(sessionId: string, product: Product) {
    const sku = normalizeCode(product.sku).toUpperCase();
    const stockBySku = await loadStockGeneralBySkuForSession(sessionId, [sku]);
    const liveStock = stockBySku.get(sku);
    const systemStock = Number(liveStock?.stock || 0);
    if (systemStock <= 0) return;

    const { data, error } = await supabase
      .from("general_inventory_counts")
      .select("quantity")
      .eq("session_id", sessionId)
      .eq("product_id", product.id);
    if (error) throw error;

    const counted = (data || []).reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    if (counted <= 0 || counted !== systemStock) return;

    const { error: snapshotError } = await supabase
      .from("general_inventory_stock_snapshot")
      .upsert({
        session_id: sessionId,
        product_id: product.id,
        sku: product.sku,
        description: product.description,
        unit: product.unit,
        system_stock: systemStock,
        cost: Number(liveStock?.costo ?? product.cost ?? 0),
        frozen_at: new Date().toISOString(),
      }, { onConflict: "session_id,product_id" });
    if (snapshotError) throw snapshotError;
  }

  async function loadSummary(sessionId: string, force = false, gen?: number) {
    // Ambos checks de "ya cargado, no volver a pedir" deben respetar
    // isSessionTabFresh -- si no, un markSessionTabStale (ej. tras editar un
    // registro) no tiene efecto: este primer check devolvia temprano igual,
    // ignorando por completo que la sesion quedo marcada como desactualizada.
    if (!force && summaryLoadedSessionId === sessionId && isSessionTabFresh(sessionId, "resumen")) return;
    const hadCachedSummary = applyCachedSummary(sessionId);
    if (!force && hadCachedSummary && isSessionTabFresh(sessionId, "resumen")) return;
    setSummaryLoading(true);
    try {
      // NO se llama mas a refreshFullSessionSnapshotFromErp() aca de forma
      // automatica. Ese barrido BORRA todas las filas no-OK del snapshot y
      // las reinserta de a paginas (puede tardar varios segundos en una
      // sesion grande) -- mientras tanto, el canal Realtime nuevo
      // (gi-live-stock-*, ver useEffect ~1335) reacciona a CADA escritura
      // intermedia de ese barrido y recarga el resumen a medio terminar,
      // causando que los KPIs "parpadeen" con numeros incompletos (ej.
      // "720/720" mientras solo quedan los codigos OK protegidos, luego
      // "752/2874" a medida que se reinsertan) -- bug real visto en
      // produccion 2026-07-18 (sesion Callao y probablemente otras).
      // El trigger de BD (gi_stock_snapshot_sync_from_erp, migracion
      // 20260718120000) ya mantiene el snapshot al dia en tiempo real por
      // su cuenta, asi que este barrido completo ya no hace falta como
      // proceso automatico -- se dejo solo como accion manual explicita
      // (boton "Actualizar stock ERP", forceRefreshNonOkStock) y como
      // barrido puntual al desfinalizar una sesion (unfinishSession), para
      // el caso borde de cambios de ERP perdidos mientras estuvo finalizada.
      const rpcRows = await loadSummaryFromRpc(sessionId);
      if (gen !== undefined && gen !== sessionLoadGenRef.current) { setSummaryLoading(false); return; }
      if (rpcRows) {
        rpcRows.sort((a, b) => Math.abs(b.valueDiff) - Math.abs(a.valueDiff));
        cacheSummary(sessionId, rpcRows);
        setSummary(rpcRows);
        applyObservationDraftsFromServer(sessionId, summaryCacheRef.current.get(sessionId)?.observationDrafts || {});
        setSummaryLoadedSessionId(sessionId);
        setSummaryHasPendingChanges(false);
        markSessionTabLoaded(sessionId, "resumen");
        setSummaryLoading(false);
        return;
      }
    } catch (error) {
      console.warn("No se pudo usar resumen SQL optimizado; uso calculo local:", error);
    }
    const summarySession = sessions.find(session => session.id === sessionId) || selectedSession;
    const validationEnabled = Boolean(summarySession?.validation_enabled);
    const useFrozenSnapshot = Boolean(summarySession?.stock_frozen_at);
    const [snapshotRows, countRows, observationRows, nonInventoryRows, recountCountRows, recountItemRows, validationRows] = await Promise.all([
      loadPagedSessionRows("general_inventory_stock_snapshot", "*", sessionId, "sku"),
      loadPagedSessionRows("general_inventory_counts", "product_id,sku,description,unit,quantity,cost_snapshot", sessionId, "sku"),
      loadPagedSessionRows("general_inventory_item_observations", "*", sessionId, "product_id"),
      loadInventoryNonInventoryRows(sessionId),
      loadPagedSessionRows("general_inventory_recount_counts", "recount_item_id,product_id,sku,description,unit,quantity,cost_snapshot,counted_at,updated_at", sessionId, "sku"),
      loadPagedSessionRows("general_inventory_recount_items", "id,product_id,status,recount_type,created_at,updated_at", sessionId, "product_id"),
      loadValidationSummaryRows(sessionId, validationEnabled),
    ]);
    if (gen !== undefined && gen !== sessionLoadGenRef.current) { setSummaryLoading(false); return; }
    const { validationCountRows, validationItemRows } = validationRows;
    const liveStockBySku = useFrozenSnapshot ? new Map<string, StockGeneralRow>() : await loadStockGeneralBySkuForSession(sessionId, [
        ...snapshotRows.map(row => row.sku),
        ...countRows.map(row => row.sku),
        ...recountCountRows.map(row => row.sku),
        ...validationCountRows.map(row => row.sku),
      ]);

    const nonInventorySkus = new Set(nonInventoryRows.map(row => normalizeCode(row.sku).toUpperCase()));
    const originalCountedByProduct = new Map<string, number>();
    for (const row of countRows) {
      if (nonInventorySkus.has(normalizeCode(row.sku).toUpperCase())) continue;
      originalCountedByProduct.set(row.product_id, (originalCountedByProduct.get(row.product_id) || 0) + Number(row.quantity || 0));
    }
    const recountItemById = new Map(recountItemRows.map(row => [row.id, row]));
    const latestRecountItemByProduct = new Map<string, { id: string; timestamp: number }>();
    for (const row of recountCountRows) {
      if (nonInventorySkus.has(normalizeCode(row.sku).toUpperCase())) continue;
      const item = recountItemById.get(row.recount_item_id);
      if (!item?.id || !item.product_id || item.status !== "counted") continue;
      const timestamp = new Date(row.updated_at || row.counted_at || 0).getTime() || 0;
      const current = latestRecountItemByProduct.get(item.product_id);
      if (!current || timestamp >= current.timestamp) {
        latestRecountItemByProduct.set(item.product_id, { id: item.id, timestamp });
      }
    }
    const recountTotalByProduct = new Map<string, number>();
    for (const row of recountCountRows) {
      if (nonInventorySkus.has(normalizeCode(row.sku).toUpperCase())) continue;
      const item = recountItemById.get(row.recount_item_id);
      const latestItemId = item?.product_id ? latestRecountItemByProduct.get(item.product_id)?.id : null;
      if (item?.product_id && item.status === "counted" && item.id === latestItemId) {
        recountTotalByProduct.set(item.product_id, (recountTotalByProduct.get(item.product_id) || 0) + Number(row.quantity || 0));
      }
    }
    const assignedRecountByProduct = new Set<string>();
    for (const item of recountItemRows) {
      if (!item.product_id || item.status === "counted" || item.status === "cancelled") continue;
      assignedRecountByProduct.add(item.product_id);
    }

    const validationItemById = new Map(validationItemRows.map(row => [row.id, row]));
    const latestValidationCountItemByProduct = new Map<string, { id: string; timestamp: number }>();
    for (const row of validationCountRows) {
      if (nonInventorySkus.has(normalizeCode(row.sku).toUpperCase())) continue;
      const item = validationItemById.get(row.validation_item_id);
      if (!item?.id || !item.product_id || item.status !== "counted") continue;
      const timestamp = new Date(row.updated_at || row.counted_at || 0).getTime() || 0;
      const current = latestValidationCountItemByProduct.get(item.product_id);
      if (!current || timestamp >= current.timestamp) {
        latestValidationCountItemByProduct.set(item.product_id, { id: item.id, timestamp });
      }
    }
    const validationTotalByProduct = new Map<string, number>();
    for (const row of validationCountRows) {
      if (nonInventorySkus.has(normalizeCode(row.sku).toUpperCase())) continue;
      const item = validationItemById.get(row.validation_item_id);
      const latestItem = item?.product_id ? latestValidationCountItemByProduct.get(item.product_id) : null;
      if (item?.product_id && item.status === "counted" && item.id === latestItem?.id) {
        validationTotalByProduct.set(item.product_id, (validationTotalByProduct.get(item.product_id) || 0) + Number(row.quantity || 0));
      }
    }
    const latestValidationAssignmentByProduct = new Map<string, { id: string; status: string; timestamp: number }>();
    for (const item of validationItemRows) {
      if (!item?.id || !item.product_id || item.status === "cancelled") continue;
      if (latestValidationCountItemByProduct.has(item.product_id)) continue;
      const timestamp = new Date(item.updated_at || item.created_at || 0).getTime() || 0;
      const current = latestValidationAssignmentByProduct.get(item.product_id);
      if (!current || timestamp >= current.timestamp) {
        latestValidationAssignmentByProduct.set(item.product_id, { id: item.id, status: item.status || "assigned", timestamp });
      }
    }
    const assignedValidationByProduct = new Set<string>();
    const countedValidationByProduct = new Set<string>();
    for (const item of validationItemRows) {
      if (!item.product_id || item.status === "cancelled") continue;
      const latestCountItem = latestValidationCountItemByProduct.get(item.product_id);
      if (latestCountItem) {
        if (item.id === latestCountItem.id) countedValidationByProduct.add(item.product_id);
        continue;
      }
      const latestAssignedItem = latestValidationAssignmentByProduct.get(item.product_id);
      if (item.id === latestAssignedItem?.id) assignedValidationByProduct.add(item.product_id);
    }

    const observations = new Map<string, string>();
    for (const row of observationRows) observations.set(row.product_id, row.observation || "");
    const productIdsForSummary = [
      ...snapshotRows.map(row => row.product_id),
      ...countRows.map(row => row.product_id),
    ];
    const skusForSummary = [
      ...snapshotRows.map(row => row.sku),
      ...countRows.map(row => row.sku),
      ...recountCountRows.map(row => row.sku),
      ...validationCountRows.map(row => row.sku),
    ];
    const [productCategories, productRotations] = await Promise.all([
      loadProductCategories(productIdsForSummary),
      loadProductRotationsForSession(summarySession, skusForSummary),
    ]);

    const productIdsInSnapshot = new Set<string>();
    const rows: SummaryRow[] = [];
    for (const snap of snapshotRows) {
      if (nonInventorySkus.has(normalizeCode(snap.sku).toUpperCase())) continue;
      const countedOriginal = originalCountedByProduct.get(snap.product_id) || 0;
      const recountedQty = recountTotalByProduct.has(snap.product_id) ? recountTotalByProduct.get(snap.product_id)! : null;
      const validationQty = validationTotalByProduct.has(snap.product_id) ? validationTotalByProduct.get(snap.product_id)! : null;
      const validationStatus = validationTotalByProduct.has(snap.product_id)
        ? "counted" as const
        : (assignedValidationByProduct.has(snap.product_id) || countedValidationByProduct.has(snap.product_id)) ? "assigned" as const : "no" as const;
      const counted = validationQty ?? recountedQty ?? countedOriginal;
      const snapshotStock = Number(snap.system_stock || 0);
      const protectedOkStock = counted > 0 && counted === snapshotStock;
      const liveStock = liveStockBySku.get(normalizeCode(snap.sku).toUpperCase());
      const systemStock = useFrozenSnapshot || protectedOkStock ? snapshotStock : Number(liveStock?.stock || 0);
      if (systemStock <= 0 && counted <= 0) continue;
      productIdsInSnapshot.add(snap.product_id);
      const cost = useFrozenSnapshot || protectedOkStock ? Number(snap.cost || 0) : Number(liveStock?.costo ?? snap.cost ?? 0);
      const diff = counted - systemStock;
      rows.push({
        product_id: snap.product_id,
        sku: snap.sku,
        description: snap.description || "",
        unit: snap.unit || "",
        ...productCategories.get(snap.product_id),
        rotation_category: productRotations.get(normalizeCode(snap.sku).toUpperCase()) || null,
        system_stock: systemStock,
        counted,
        counted_original: countedOriginal,
        recounted_qty: recountedQty,
        validation_qty: validationQty,
        diff,
        cost,
        valueDiff: diff * cost,
        re_counted: recountTotalByProduct.has(snap.product_id),
        recount_status: recountTotalByProduct.has(snap.product_id) ? "counted" : assignedRecountByProduct.has(snap.product_id) ? "assigned" : "no",
        validation_status: validationStatus,
        validated: validationTotalByProduct.has(snap.product_id),
        observation: observations.get(snap.product_id) || "",
      });
    }

    for (const row of countRows) {
      if (nonInventorySkus.has(normalizeCode(row.sku).toUpperCase())) continue;
      if (productIdsInSnapshot.has(row.product_id)) continue;
      const countedOriginal = originalCountedByProduct.get(row.product_id) || 0;
      const recountedQty = recountTotalByProduct.has(row.product_id) ? recountTotalByProduct.get(row.product_id)! : null;
      const validationQty = validationTotalByProduct.has(row.product_id) ? validationTotalByProduct.get(row.product_id)! : null;
      const validationStatus = validationTotalByProduct.has(row.product_id)
        ? "counted" as const
        : (assignedValidationByProduct.has(row.product_id) || countedValidationByProduct.has(row.product_id)) ? "assigned" as const : "no" as const;
      const counted = validationQty ?? recountedQty ?? countedOriginal;
      const liveStock = liveStockBySku.get(normalizeCode(row.sku).toUpperCase());
      const systemStock = useFrozenSnapshot ? 0 : Number(liveStock?.stock || 0);
      const cost = useFrozenSnapshot ? Number(row.cost_snapshot || 0) : Number(liveStock?.costo ?? row.cost_snapshot ?? 0);
      const diff = counted - systemStock;
      rows.push({
        product_id: row.product_id,
        sku: row.sku,
        description: row.description || "",
        unit: row.unit || "",
        ...productCategories.get(row.product_id),
        rotation_category: productRotations.get(normalizeCode(row.sku).toUpperCase()) || null,
        system_stock: systemStock,
        counted,
        counted_original: countedOriginal,
        recounted_qty: recountedQty,
        validation_qty: validationQty,
        diff,
        cost,
        valueDiff: diff * cost,
        re_counted: recountTotalByProduct.has(row.product_id),
        recount_status: recountTotalByProduct.has(row.product_id) ? "counted" : assignedRecountByProduct.has(row.product_id) ? "assigned" : "no",
        validation_status: validationStatus,
        validated: validationTotalByProduct.has(row.product_id),
        observation: observations.get(row.product_id) || "",
      });
      productIdsInSnapshot.add(row.product_id);
    }

    rows.sort((a, b) => Math.abs(b.valueDiff) - Math.abs(a.valueDiff));
    if (gen !== undefined && gen !== sessionLoadGenRef.current) { setSummaryLoading(false); return; }
    cacheSummary(sessionId, rows);
    setSummary(rows);
    applyObservationDraftsFromServer(sessionId, summaryCacheRef.current.get(sessionId)?.observationDrafts || {});
    setSummaryLoadedSessionId(sessionId);
    setSummaryHasPendingChanges(false);
    markSessionTabLoaded(sessionId, "resumen");
    setSummaryLoading(false);
  }

  async function assignRecountBlock(limit?: number, explicitRows?: RecountCandidate[]) {
    if (!ensureSelectedSessionEditable()) return;
    if (!selectedSessionId || !user || !recountOperatorId) {
      setMessage("Selecciona operador activo para asignar reconteo.");
      return;
    }
    const validationMode = isValidationManagerTab;
    const baseRows = explicitRows || filteredUnassignedRecountCandidates;
    const sourceRows = typeof limit === "number" ? baseRows.slice(0, limit) : baseRows;
    const rows = sourceRows.map(row => ({
      session_id: selectedSessionId,
      ...(validationMode ? { source_recount_item_id: null } : {}),
      product_id: row.product_id,
      location_id: null,
      location_code: "CODIGO_COMPLETO",
      ticket: row.recount_type === "missing" ? "FALTANTE" : "CODIGO COMPLETO",
      zone: null,
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
      setMessage(`No hay diferencias pendientes para asignar ${validationMode ? "en validacion" : "con ese filtro"}.`);
      return;
    }

    const { error } = await supabase
      .from(validationMode ? "general_inventory_validation_items" : "general_inventory_recount_items")
      .upsert(rows, { onConflict: "session_id,product_id,location_code,recount_type" });
    if (error) {
      setMessage(`No se pudo asignar ${validationMode ? "validacion" : "reconteo"}. Ejecuta el SQL si aun no lo hiciste: ` + error.message);
      return;
    }

    setSelectedPendingRecountKeys(prev => {
      const next = new Set(prev);
      for (const row of sourceRows) next.delete(recountKey(row));
      return next;
    });
    setMessage(`${rows.length} items asignados para ${validationMode ? "validacion" : "reconteo"}.`);
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
    if (!ensureSelectedSessionEditable()) return;
    if (!selectedSessionId || !user || !isValidator) {
      setMessage("Solo el validador o administrador puede reasignar reconteos.");
      return;
    }
    const validationMode = item.layer === "validation";
    const itemTable = validationMode ? "general_inventory_validation_items" : "general_inventory_recount_items";
    if (item.status === "counted") {
      setMessage(`Esta ${validationMode ? "validacion" : "linea de reconteo"} ya fue contada y no se puede reasignar sin borrar el registro guardado.`);
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
      .from(itemTable)
      .update({
        assigned_operator_id: nextOperatorId,
        status: "assigned",
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id);
    if (error) {
      setMessage(`No se pudo reasignar ${validationMode ? "validacion" : "reconteo"}: ` + error.message);
      return;
    }
    setMessage(`${validationMode ? "Validacion" : "Reconteo"} reasignado.`);
    await loadRecountAssignments(selectedSessionId);
  }

  async function unassignRecountItem(item: RecountItem) {
    if (!ensureSelectedSessionEditable()) return;
    if (!selectedSessionId || !user || !isValidator) {
      setMessage("Solo el validador o administrador puede quitar asignaciones.");
      return;
    }
    const validationMode = item.layer === "validation";
    const itemTable = validationMode ? "general_inventory_validation_items" : "general_inventory_recount_items";
    if (item.status === "counted") {
      setMessage(`Esta ${validationMode ? "validacion" : "linea de reconteo"} ya fue contada y no se puede quitar sin borrar el registro guardado.`);
      return;
    }
    const { error } = await supabase
      .from(itemTable)
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
    setMessage("Asignacion quitada. Si la diferencia sigue vigente, la linea volvera a pendientes por asignar.");
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
    if (!ensureSelectedSessionEditable()) return;
    if (!selectedSessionId || !canManageInventory) {
      setMessage("Solo el validador o administrador puede borrar reconteos guardados.");
      return;
    }
    const validationMode = item.layer === "validation";
    const itemTable = validationMode ? "general_inventory_validation_items" : "general_inventory_recount_items";
    const countTable = validationMode ? "general_inventory_validation_counts" : "general_inventory_recount_counts";
    const itemIdColumn = validationMode ? "validation_item_id" : "recount_item_id";
    const confirmed = window.confirm(`Borrar ${validationMode ? "la validacion" : "el reconteo"} guardado de ${item.sku}? La asignacion quedara abierta y el resumen volvera a tomar ${validationMode ? "el reconteo" : "el conteo original"}.`);
    if (!confirmed) return;
    const { error } = await supabase
      .from(countTable)
      .delete()
      .eq(itemIdColumn, item.id)
      .eq("session_id", selectedSessionId);
    if (error) {
      setMessage(`No se pudo borrar ${validationMode ? "la validacion" : "el reconteo"} guardado: ` + error.message);
      return;
    }
    await supabase
      .from(itemTable)
      .update({ status: "assigned", updated_at: new Date().toISOString() })
      .eq("id", item.id);
    setMessage(`${validationMode ? "Validacion" : "Reconteo"} guardado borrado. La linea volvio a asignado.`);
    await refreshAfterRecountDelete(selectedSessionId);
  }

  function openAdminEditRecountRecord(record: OperatorRecountRecord) {
    if (!ensureSelectedSessionEditable()) return;
    setEditingAdminRecountMode("edit");
    setEditingAdminRecountRecord(record);
    setEditingAdminRecountLocation(record.location_code === "SIN_FISICO" ? "" : record.location_code || "");
    setEditingAdminRecountQuantity(String(record.quantity || ""));
  }

  function openAdminAddRecountRecord(record: OperatorRecountRecord) {
    if (!ensureSelectedSessionEditable()) return;
    setEditingAdminRecountMode("add");
    setEditingAdminRecountRecord(record);
    setEditingAdminRecountLocation("");
    setEditingAdminRecountQuantity("");
  }

  async function saveAdminEditRecountRecord() {
    if (!ensureSelectedSessionEditable()) return;
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
      loc = await resolveInventoryLocation(locationCode, { allowCreate: true, sourceLabel: locationCode });
      if (!loc) {
        setMessage(selectedSession?.location_lock_enabled ? "La ubicacion no esta cargada para esta sesion." : "No se pudo registrar la ubicacion.");
        return;
      }
      locationCode = loc.location_code;
    }
    const validationMode = editingAdminRecountRecord.item.layer === "validation";
    const countTable = validationMode ? "general_inventory_validation_counts" : "general_inventory_recount_counts";
    const itemTable = validationMode ? "general_inventory_validation_items" : "general_inventory_recount_items";
    const itemIdColumn = validationMode ? "validation_item_id" : "recount_item_id";
    const now = new Date().toISOString();
    const rowPayload = {
      [itemIdColumn]: editingAdminRecountRecord.recount_item_id,
      session_id: selectedSessionId,
      operator_id: editingAdminRecountRecord.operator_id,
      location_id: loc?.id || null,
      location_code: locationCode,
      product_id: editingAdminRecountRecord.product_id,
      sku: editingAdminRecountRecord.sku,
      description: editingAdminRecountRecord.description,
      unit: editingAdminRecountRecord.unit,
      quantity: qty,
      cost_snapshot: editingAdminRecountRecord.cost_snapshot,
      ...(validationMode ? {} : {
        client_uuid: createClientUuid("gi-recount"),
        client_device_id: getOrCreateDeviceId(),
        sync_origin: "web",
      }),
      updated_at: now,
    };

    const request = editingAdminRecountMode === "add"
      ? supabase.from(countTable).insert(rowPayload)
      : supabase
        .from(countTable)
        .update({
        location_id: loc?.id || null,
        location_code: locationCode,
        quantity: qty,
        updated_at: now,
      })
      .eq("id", editingAdminRecountRecord.id)
      .eq("session_id", selectedSessionId);
    const { error } = await request;
    if (error) {
      setMessage(`No se pudo ${editingAdminRecountMode === "add" ? "agregar" : "actualizar"} registro de ${validationMode ? "validacion" : "reconteo"}: ` + error.message);
      return;
    }

    if (editingAdminRecountMode === "add") {
      await supabase
        .from(itemTable)
        .update({ status: "counted", updated_at: now })
        .eq("id", editingAdminRecountRecord.recount_item_id);
    }

    setEditingAdminRecountRecord(null);
    setEditingAdminRecountMode("edit");
    setMessage(`Registro de ${validationMode ? "validacion" : "reconteo"} ${editingAdminRecountMode === "add" ? "agregado" : "actualizado"}.`);
    await Promise.all([
      loadAdminRecountRecords(selectedSessionId),
      loadSummary(selectedSessionId, true),
      loadRecountAssignments(selectedSessionId),
    ]);
  }

  async function deleteAdminRecountRecord(record: OperatorRecountRecord) {
    if (!ensureSelectedSessionEditable()) return;
    if (!selectedSessionId || !canManageInventory) {
      setMessage("Solo el validador o administrador puede borrar reconteos guardados.");
      return;
    }
    const validationMode = record.item.layer === "validation";
    const countTable = validationMode ? "general_inventory_validation_counts" : "general_inventory_recount_counts";
    const itemTable = validationMode ? "general_inventory_validation_items" : "general_inventory_recount_items";
    const itemIdColumn = validationMode ? "validation_item_id" : "recount_item_id";
    const confirmed = window.confirm(`Borrar el registro de ${validationMode ? "validacion" : "reconteo"} de ${record.sku} en ${record.location_code || "SIN UBICACION"}?`);
    if (!confirmed) return;
    const { error } = await supabase
      .from(countTable)
      .delete()
      .eq("id", record.id)
      .eq("session_id", selectedSessionId);
    if (error) {
      setMessage(`No se pudo borrar el registro de ${validationMode ? "validacion" : "reconteo"}: ` + error.message);
      return;
    }

    const remaining = await supabase
      .from(countTable)
      .select("id")
      .eq(itemIdColumn, record.recount_item_id)
      .limit(1);
    if (!remaining.error && (remaining.data || []).length === 0) {
      await supabase
        .from(itemTable)
        .update({ status: "assigned", updated_at: new Date().toISOString() })
        .eq("id", record.recount_item_id);
    }

    setMessage(`Registro de ${validationMode ? "validacion" : "reconteo"} borrado.`);
    await Promise.all([
      loadAdminRecountRecords(selectedSessionId),
      loadSummary(selectedSessionId, true),
      loadRecountAssignments(selectedSessionId),
    ]);
  }

  async function deleteAllAssignedRecountCounts() {
    if (!ensureSelectedSessionEditable()) return;
    if (!selectedSessionId || !canManageInventory) {
      setMessage("Solo el validador o administrador puede borrar reconteos guardados.");
      return;
    }
    const validationMode = isValidationManagerTab;
    const countTable = validationMode ? "general_inventory_validation_counts" : "general_inventory_recount_counts";
    const itemTable = validationMode ? "general_inventory_validation_items" : "general_inventory_recount_items";
    const confirmed = window.confirm(`Borrar TODAS las ${validationMode ? "validaciones" : "reconteos"} guardadas de esta sesion? Las asignaciones quedaran abiertas y el resumen volvera a tomar ${validationMode ? "los reconteos" : "los conteos originales"}.`);
    if (!confirmed) return;
    const { error } = await supabase
      .from(countTable)
      .delete()
      .eq("session_id", selectedSessionId);
    if (error) {
      setMessage(`No se pudieron borrar ${validationMode ? "las validaciones" : "los reconteos"} guardados: ` + error.message);
      return;
    }
    const statusUpdate = await supabase
      .from(itemTable)
      .update({ status: "assigned", updated_at: new Date().toISOString() })
      .eq("session_id", selectedSessionId)
      .eq("status", "counted");
    if (statusUpdate.error) {
      setMessage("Reconteos borrados, pero no se pudo reabrir asignaciones: " + statusUpdate.error.message);
      return;
    }
    setMessage(`Todas las ${validationMode ? "validaciones" : "reconteos"} guardadas fueron borradas.`);
    await refreshAfterRecountDelete(selectedSessionId);
  }

  async function markLocationEmpty(location: InventoryLocation) {
    if (!ensureSelectedSessionEditable()) return;
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
    setLoading(true);
    setMessage("Cargando stock inicial de la tienda...");
    await preloadStockForNewSession(row.id, row.store_id);
    setLoading(false);
  }

  async function preloadStockForNewSession(sessionId: string, storeId: string) {
    const store = stores.find(row => row.id === storeId);
    const sede = store?.erp_sede || store?.name || "";
    if (!sede) {
      setMessage("Inventario creado. No se pudo cargar stock inicial: no se encontro la sede ERP de la tienda.");
      return;
    }

    const nonInventoryRows = await loadInventoryNonInventoryRows(sessionId);
    const nonInventorySkus = new Set(nonInventoryRows.map(row => normalizeCode(row.sku).toUpperCase()));

    let inserted = 0;
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
        setMessage("Inventario creado, pero no se pudo cargar stock inicial: " + stockRes.error.message);
        return;
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
          setMessage("Inventario creado, pero no se pudo cruzar stock con maestro: " + productsRes.error.message);
          return;
        }
        const rows = ((productsRes.data || []) as Product[]).map(product => {
          const stock = stockBySku.get(normalizeCode(product.sku).toUpperCase());
          return {
            session_id: sessionId,
            product_id: product.id,
            sku: product.sku,
            description: product.description,
            unit: product.unit,
            system_stock: Number(stock?.stock || 0),
            cost: Number(stock?.costo ?? product.cost ?? 0),
            frozen_at: new Date().toISOString(),
          };
        });
        if (rows.length > 0) {
          const upsertRes = await supabase
            .from("general_inventory_stock_snapshot")
            .upsert(rows, { onConflict: "session_id,product_id" });
          if (upsertRes.error) {
            setMessage("Inventario creado, pero no se pudo guardar stock inicial: " + upsertRes.error.message);
            return;
          }
          inserted += rows.length;
          setMessage(`Cargando stock inicial... ${inserted} codigos.`);
        }
      }

      if (stockRows.length < pageSize) break;
      from += pageSize;
    }

    setMessage(`Inventario creado. ${inserted} codigos con stock cargados.`);
  }

  async function handleLocationsFileChange(file: File | null) {
    setLocationsFile(file);
    setLocationsFileBuffer(null);
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      setLocationsFileBuffer(buffer);
      setMessage(`Excel listo para subir: ${file.name}.`);
    } catch (error) {
      setLocationsFile(null);
      if (locationsFileRef.current) locationsFileRef.current.value = "";
      setMessage("No pude leer el archivo seleccionado. Cierra el Excel si esta abierto y vuelve a seleccionarlo: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  async function importLocations() {
    if (!canManageInventory) { setMessage("Tu usuario tiene acceso de solo lectura."); return; }
    if (!selectedSessionId || !locationsFile || !locationsFileBuffer) {
      setMessage("Selecciona el Excel de ubicaciones.");
      return;
    }
    setImportingLocations(true);
    setMessage("Cargando ubicaciones desde Excel...");
    try {
      const excelRows = await readWorkbookMatrixFromBuffer(locationsFileBuffer, locationsFile.name);
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
      for (const [index, row] of excelRows.entries()) {
        const ticket = String(row[0] ?? "").trim();
        const firstCell = normalizeCode(ticket).toUpperCase();
        const secondCell = normalizeCode(String(row[1] ?? "")).toUpperCase();
        if (index === 0 && (["TICKET", "UBICACION", "UBICACIÓN", "CODIGO", "CÓDIGO"].includes(firstCell) || secondCell === "ZONA")) continue;
        const locationCode = normalizeLocationCode(ticket);
        if (!locationCode) continue;
        const zona = String(row[1] ?? "").trim();
        const lineal = String(row[2] ?? "").trim();
        const metro = String(row[3] ?? "").trim();
        const nivel = String(row[4] ?? "").trim();
        const fullLocation = String(row[5] ?? "").trim();
        uniqueRows.set(locationCode, {
          session_id: selectedSessionId,
          location_code: locationCode,
          ticket: locationCode,
          zone: zona || null,
          zone_ref: metro || null,
          lineal: lineal || null,
          reference: nivel || null,
          full_location: fullLocation || null,
          description: fullLocation || [zona, lineal, metro, nivel].filter(Boolean).join(" - ") || null,
        });
      }
      const rows = [...uniqueRows.values()];
      if (rows.length === 0) {
        setMessage("No encontre ubicaciones en el Excel. Revisa que la primera columna tenga las ubicaciones.");
        return;
      }
      const { error } = await supabase.from("general_inventory_locations").upsert(rows, { onConflict: "session_id,location_code" });
      if (error) {
        setMessage("Error cargando ubicaciones: " + error.message);
        return;
      }
      setLocationsFile(null);
      setLocationsFileBuffer(null);
      if (locationsFileRef.current) locationsFileRef.current.value = "";
      setMessage(`${rows.length} ubicaciones cargadas desde Excel. El control de tickets no modifica stock ni conteos, incluso en sesiones finalizadas.`);
      await loadPreparationData(selectedSessionId);
    } catch (error) {
      setMessage("Error leyendo el Excel: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setImportingLocations(false);
    }
  }

  function updateManualLocationDraft(field: keyof ManualLocationDraft, value: string) {
    setManualLocationDraft(prev => ({ ...prev, [field]: value }));
  }

  async function saveManualLocation() {
    if (!ensureSelectedSessionEditable()) return;
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
    if (selectedSession?.stock_frozen_at) {
      setMessage("Este inventario ya tiene foto de stock. No se reemplaza automaticamente para proteger la fotografia original.");
      return;
    }
    await saveStockSnapshot("Congelando stock. Este proceso puede tardar varios minutos si es la primera vez.", "Stock congelado");
  }

  async function unfreezeSession() {
    if (!canManageInventory || !selectedSessionId || !selectedSession) return;
    if (selectedSession.status !== "frozen") {
      setMessage("La sesion no esta congelada.");
      return;
    }
    const confirmed = window.confirm(
      "Descongelar el stock de este inventario?\n\n" +
      "Esto borra la fotografia de stock. Usa esta opcion solo si necesitas tomar una nueva foto desde cero.\n" +
      "Nota: el stock de productos no-OK ya se actualiza automaticamente desde el ERP incluso con el stock congelado."
    );
    if (!confirmed) return;
    setLoading(true);
    setMessage("Descongelando stock...");
    const { error } = await supabase
      .from("general_inventory_sessions")
      .update({
        status: "open",
        stock_frozen_at: null,
        frozen_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", selectedSessionId);
    if (error) {
      setMessage("No se pudo descongelar: " + error.message);
      setLoading(false);
      return;
    }
    setSessions(prev =>
      prev.map(s =>
        s.id === selectedSessionId
          ? { ...s, status: "open" as SessionStatus, stock_frozen_at: null, frozen_by: null }
          : s
      )
    );
    setMessage("Stock descongelado. Se actualizara en tiempo real cuando el ERP sincronice.");
    setLoading(false);
  }

  async function saveStockSnapshot(progressMessage: string, successLabel: string) {
    if (!ensureSelectedSessionEditable()) return;
    if (!canManageInventory) { setMessage("Tu usuario tiene acceso de solo lectura."); return; }
    if (!user || !selectedSessionId) return;
    setLoading(true);
    setSummaryLoading(true);
    setMessage(progressMessage);
    try {
      if (selectedSession?.stock_frozen_at) {
        const fallbackInserted = await saveStockSnapshotInBatches(selectedSessionId, user.id, successLabel, true);
        if (fallbackInserted === null) return;
        await loadInitial(selectedSessionId);
        setValidatorTab("resumen");
        await loadSummary(selectedSessionId, true);
        return;
      }

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
        const fallbackInserted = await saveStockSnapshotInBatches(selectedSessionId, user.id, successLabel, false);
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

  async function loadProtectedOkProductIdsForStockUpdate(sessionId: string) {
    const session = sessions.find(row => row.id === sessionId) || selectedSession;
    const validationEnabled = Boolean(session?.validation_enabled);
    const [snapshotRows, countRows, recountCountRows, recountItemRows, validationRows, nonInventoryRows] = await Promise.all([
      loadPagedSessionRows("general_inventory_stock_snapshot", "product_id,system_stock", sessionId, "product_id"),
      loadPagedSessionRows("general_inventory_counts", "product_id,sku,quantity", sessionId, "product_id"),
      loadPagedSessionRows("general_inventory_recount_counts", "recount_item_id,product_id,sku,quantity,counted_at,updated_at", sessionId, "product_id"),
      loadPagedSessionRows("general_inventory_recount_items", "id,product_id,status,recount_type,created_at,updated_at", sessionId, "product_id"),
      loadValidationSummaryRows(sessionId, validationEnabled),
      loadInventoryNonInventoryRows(sessionId),
    ]);
    const { validationCountRows, validationItemRows } = validationRows;
    const nonInventorySkus = new Set(nonInventoryRows.map(row => normalizeCode(row.sku).toUpperCase()));
    const originalCountedByProduct = new Map<string, number>();
    for (const row of countRows) {
      if (nonInventorySkus.has(normalizeCode(row.sku).toUpperCase())) continue;
      const productId = String(row.product_id || "");
      if (!productId) continue;
      originalCountedByProduct.set(productId, (originalCountedByProduct.get(productId) || 0) + Number(row.quantity || 0));
    }

    const recountItemById = new Map(recountItemRows.map(row => [String(row.id || ""), row]));
    const latestRecountItemByProduct = new Map<string, { id: string; timestamp: number }>();
    for (const row of recountCountRows) {
      if (nonInventorySkus.has(normalizeCode(row.sku).toUpperCase())) continue;
      const item = recountItemById.get(String(row.recount_item_id || ""));
      if (!item?.id || !item.product_id || item.status !== "counted") continue;
      const timestamp = new Date(row.updated_at || row.counted_at || item.updated_at || item.created_at || 0).getTime() || 0;
      const productId = String(item.product_id || "");
      const current = latestRecountItemByProduct.get(productId);
      if (!current || timestamp >= current.timestamp) {
        latestRecountItemByProduct.set(productId, { id: String(item.id), timestamp });
      }
    }

    const recountTotalByProduct = new Map<string, number>();
    for (const row of recountCountRows) {
      if (nonInventorySkus.has(normalizeCode(row.sku).toUpperCase())) continue;
      const item = recountItemById.get(String(row.recount_item_id || ""));
      const productId = item?.product_id ? String(item.product_id) : "";
      const latestItemId = productId ? latestRecountItemByProduct.get(productId)?.id : null;
      if (productId && item?.status === "counted" && String(item.id) === latestItemId) {
        recountTotalByProduct.set(productId, (recountTotalByProduct.get(productId) || 0) + Number(row.quantity || 0));
      }
    }

    const validationItemById = new Map(validationItemRows.map(row => [String(row.id || ""), row]));
    const latestValidationItemByProduct = new Map<string, { id: string; timestamp: number }>();
    for (const row of validationCountRows) {
      if (nonInventorySkus.has(normalizeCode(row.sku).toUpperCase())) continue;
      const item = validationItemById.get(String(row.validation_item_id || ""));
      if (!item?.id || !item.product_id || item.status !== "counted") continue;
      const timestamp = new Date(row.updated_at || row.counted_at || item.updated_at || item.created_at || 0).getTime() || 0;
      const productId = String(item.product_id || "");
      const current = latestValidationItemByProduct.get(productId);
      if (!current || timestamp >= current.timestamp) {
        latestValidationItemByProduct.set(productId, { id: String(item.id), timestamp });
      }
    }

    const validationTotalByProduct = new Map<string, number>();
    for (const row of validationCountRows) {
      if (nonInventorySkus.has(normalizeCode(row.sku).toUpperCase())) continue;
      const item = validationItemById.get(String(row.validation_item_id || ""));
      const productId = item?.product_id ? String(item.product_id) : "";
      const latestItemId = productId ? latestValidationItemByProduct.get(productId)?.id : null;
      if (productId && item?.status === "counted" && String(item.id) === latestItemId) {
        validationTotalByProduct.set(productId, (validationTotalByProduct.get(productId) || 0) + Number(row.quantity || 0));
      }
    }

    const protectedIds = new Set<string>();
    for (const snap of snapshotRows) {
      const productId = String(snap.product_id || "");
      if (!productId) continue;
      const counted = validationTotalByProduct.has(productId)
        ? validationTotalByProduct.get(productId)!
        : recountTotalByProduct.has(productId)
          ? recountTotalByProduct.get(productId)!
          : originalCountedByProduct.get(productId) || 0;
      const systemStock = Number(snap.system_stock || 0);
      if (counted > 0 && counted === systemStock) protectedIds.add(productId);
    }
    return protectedIds;
  }

  async function deleteUnprotectedSnapshotRows(sessionId: string, protectedProductIds: Set<string>) {
    const snapshotRows = await loadPagedSessionRows("general_inventory_stock_snapshot", "id,product_id", sessionId, "product_id");
    const deleteIds = snapshotRows
      .filter(row => !protectedProductIds.has(String(row.product_id || "")))
      .map(row => String(row.id || ""))
      .filter(Boolean);
    for (let i = 0; i < deleteIds.length; i += 500) {
      const deleteRes = await supabase
        .from("general_inventory_stock_snapshot")
        .delete()
        .in("id", deleteIds.slice(i, i + 500));
      if (deleteRes.error) return deleteRes.error;
    }
    return null;
  }

  async function saveStockSnapshotInBatches(sessionId: string, userId: string, successLabel: string, preserveOkProducts: boolean) {
    const session = sessions.find(row => row.id === sessionId) || selectedSession;
    const store = stores.find(row => row.id === session?.store_id);
    const sede = store?.erp_sede || store?.name || session?.store_name || "";
    if (!sede) {
      setMessage("No se pudo actualizar stock por lotes: no encontre la sede ERP del inventario.");
      return null;
    }

    const protectedProductIds = preserveOkProducts ? await loadProtectedOkProductIdsForStockUpdate(sessionId) : new Set<string>();
    const nonInventoryRows = await loadInventoryNonInventoryRows(sessionId);
    const nonInventorySkus = new Set(nonInventoryRows.map(row => normalizeCode(row.sku).toUpperCase()));
    const deleteError = preserveOkProducts
      ? await deleteUnprotectedSnapshotRows(sessionId, protectedProductIds)
      : (await supabase.from("general_inventory_stock_snapshot").delete().eq("session_id", sessionId)).error;
    if (deleteError) {
      setMessage("No se pudo limpiar la foto anterior de stock: " + deleteError.message);
      return null;
    }

    let inserted = protectedProductIds.size;
    let totalValue = 0;
    let from = 0;
    const pageSize = 1000;
    const upsertedProductIds = new Set<string>();
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
        const rows = ((productsRes.data || []) as Product[]).filter(product => !protectedProductIds.has(product.id)).map(product => {
          const stock = stockBySku.get(normalizeCode(product.sku).toUpperCase());
          const systemStock = Number(stock?.stock || 0);
          const cost = Number(stock?.costo ?? product.cost ?? 0);
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
          for (const row of rows) upsertedProductIds.add(row.product_id);
          inserted += rows.length;
          setMessage(`Actualizando stock por lotes... ${inserted} codigos en foto${protectedProductIds.size > 0 ? ` (${protectedProductIds.size} OK protegidos)` : ""}.`);
        }
      }

      if (stockRows.length < pageSize) break;
      from += pageSize;
    }

    // Limpieza de fantasmas: eliminar filas del snapshot que no tienen stock live
    // y no son productos protegidos (OK). Cubre casos donde la eliminacion inicial
    // fue parcial por fallo de red u otro problema transitorio.
    if (preserveOkProducts) {
      const postUpsertSnapshot = await loadPagedSessionRows("general_inventory_stock_snapshot", "id,product_id", sessionId, "product_id");
      const phantomIds = postUpsertSnapshot
        .filter(row => {
          const pid = String(row.product_id || "");
          return pid && !protectedProductIds.has(pid) && !upsertedProductIds.has(pid);
        })
        .map(row => String(row.id || ""))
        .filter(Boolean);
      for (let i = 0; i < phantomIds.length; i += 500) {
        const cleanupRes = await supabase.from("general_inventory_stock_snapshot").delete().in("id", phantomIds.slice(i, i + 500));
        if (cleanupRes.error) {
          setMessage("Advertencia: no se pudieron eliminar " + phantomIds.length + " codigos sin stock del snapshot: " + cleanupRes.error.message);
        }
      }
    }

    const finalSnapshotRows = await loadPagedSessionRows("general_inventory_stock_snapshot", "system_stock,cost", sessionId, "product_id");
    totalValue = finalSnapshotRows.reduce((sum, row) => sum + Number(row.system_stock || 0) * Number(row.cost || 0), 0);
    inserted = finalSnapshotRows.length;

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

    setMessage(`${successLabel}. Codigos en foto: ${inserted}. Con stock: ${inserted}.${protectedProductIds.size > 0 ? ` OK protegidos: ${protectedProductIds.size}.` : ""}`);
    return inserted;
  }

  async function finishSession() {
    if (!canManageInventory) { setMessage("Tu usuario tiene acceso de solo lectura."); return; }
    if (!selectedSessionId) return;
    if (selectedSession?.status === "finished") {
      setMessage("Esta sesion ya esta finalizada.");
      return;
    }
    const confirmed = window.confirm("Finalizar esta sesion? Los operarios ya no podran entrar y no se podra modificar conteo, reconteo ni stock.");
    if (!confirmed) return;
    if (!selectedSession?.stock_frozen_at) {
      const inserted = await saveStockSnapshotInBatches(selectedSessionId, user?.id ?? "", "Stock congelado al finalizar", true);
      if (inserted === null) return;
    }
    const { error } = await supabase
      .from("general_inventory_sessions")
      .update({
        status: "finished",
        finished_at: new Date().toISOString(),
        finished_by: user?.id ?? null,
        finished_by_name: user?.full_name ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", selectedSessionId);
    if (error) {
      setMessage("No se pudo finalizar: " + error.message);
      return;
    }
    setMessage("Inventario finalizado. Los operadores ya no podran entrar.");
    await loadInitial(selectedSessionId);
    // Sin esto, la pantalla se quedaba mostrando el resumen de antes de
    // finalizar (loadInitial solo recarga la lista de sesiones, no el
    // resumen) — mismo fix que ya usa saveStockSnapshot() al congelar.
    await loadSummary(selectedSessionId, true);
  }

  async function unfinishSession() {
    if (user?.role !== "Administrador" || !selectedSessionId || !selectedSession) return;
    if (selectedSession.status !== "finished") {
      setMessage("La sesion no esta finalizada.");
      return;
    }
    const nextStatus: SessionStatus = selectedSession.stock_frozen_at ? "frozen" : "open";
    const confirmed = window.confirm(`Desfinalizar esta sesion? Volvera a estado ${statusLabel(nextStatus)} y se habilitaran cambios nuevamente.`);
    if (!confirmed) return;
    const { error } = await supabase
      .from("general_inventory_sessions")
      .update({ status: nextStatus, finished_at: null, finished_by: null, finished_by_name: null, updated_at: new Date().toISOString() })
      .eq("id", selectedSessionId);
    if (error) {
      setMessage("No se pudo desfinalizar: " + error.message);
      return;
    }
    setMessage(`Sesion desfinalizada. Estado actual: ${statusLabel(nextStatus)}.`);
    // Mientras estuvo "finished" el trigger de sincronizacion de stock la
    // ignoro a proposito (no toca sesiones finalizadas/canceladas) -- un
    // barrido puntual aca pone al dia cualquier cambio de ERP que haya
    // pasado en el medio, antes de que el trigger retome solo desde ahora.
    try {
      await refreshFullSessionSnapshotFromErp(selectedSessionId);
    } catch { /* si falla, el trigger igual la va a ir poniendo al dia con cada cambio nuevo del ERP */ }
    await loadInitial(selectedSessionId);
    if (selectedSessionId) await loadSessionData(selectedSessionId, validatorTab);
  }

  async function deleteSession() {
    if (!selectedSessionId || user?.role !== "Administrador" || !selectedSession) return;
    const confirmed = window.confirm(
      `Cancelar/archivar la sesion "${selectedSession.name}"? No se borraran ubicaciones, conteos, reconteos, validaciones ni stock congelado.`
    );
    if (!confirmed) return;
    const { error } = await supabase
      .from("general_inventory_sessions")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", selectedSessionId);
    if (error) {
      setMessage("No se pudo cancelar la sesion: " + error.message);
      return;
    }
    setSelectedSessionId("");
    localStorage.removeItem(SESSION_KEY);
    setLocations([]);
    setCounts([]);
    setCountedLocationCodes([]);
    setSummary([]);
    setMessage("Sesion cancelada/archivada. No se borraron registros.");
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
    const variants = barcodeVariants(raw);
    const isNumericSearch = /^\d+$/.test(raw);
    const shouldSearchDescription = mode === "typed" && !isNumericSearch;

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      const cachedProducts = (await Promise.all(variants.map(code => findCachedProductsByCode(code))))
        .flat()
        .filter((product, index, rows) => rows.findIndex(item => item.sku === product.sku) === index);
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
        supabase.from("codigos_barra").select("codsap,upc,alu").in("upc", variants).not("codsap", "is", null).limit(50),
        supabase.from("codigos_barra").select("codsap,upc,alu").in("alu", variants).not("codsap", "is", null).limit(50),
      ]).catch(async () => {
        const cachedProducts = (await Promise.all(variants.map(code => findCachedProductsByCode(code)))).flat();
        return [
          { data: cachedProducts.map(product => ({ codsap: product.sku, upc: null, alu: null })) },
          { data: [] },
        ];
      });
      const mapped = [...(byUpc.data || []), ...(byAlu.data || [])].map(row => row.codsap).filter(Boolean);
      const candidateSkus = [...new Set([...variants, ...mapped])];

      const [bySku, byBarcode, byErpSku] = await Promise.all([
        supabase.from("cyclic_products").select("*").in("sku", variants).eq("is_active", true).limit(50),
        supabase.from("cyclic_products").select("*").in("barcode", variants).eq("is_active", true).limit(50),
        supabase.from("cyclic_products").select("*").in("erp_sku", variants).eq("is_active", true).limit(50),
      ]);
      for (const product of ([...(bySku.data || []), ...(byBarcode.data || []), ...(byErpSku.data || [])] as Product[])) productMap.set(product.sku, product);

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
        supabase.from("codigos_barra").select("codsap,upc,alu").in("upc", variants).not("codsap", "is", null).limit(50),
        supabase.from("codigos_barra").select("codsap,upc,alu").in("alu", variants).not("codsap", "is", null).limit(50),
      ]).catch(async () => {
        const cachedProducts = (await Promise.all(variants.map(code => findCachedProductsByCode(code)))).flat();
        return [
          { data: cachedProducts.map(product => ({ codsap: product.sku, upc: null, alu: null })) },
          { data: [] },
        ];
      });
      const mapped = [...(byUpc.data || []), ...(byAlu.data || [])].map(row => row.codsap).filter(Boolean);
      const candidateSkus = [...new Set([...variants, ...mapped])];

      const [{ data }, { data: byErpSku }] = await Promise.all([
        supabase.from("cyclic_products").select("*").in("sku", candidateSkus).eq("is_active", true).limit(20),
        supabase.from("cyclic_products").select("*").in("erp_sku", variants).eq("is_active", true).limit(20),
      ]);
      for (const product of ([...(data || []), ...(byErpSku || [])]) as Product[]) productMap.set(product.sku, product);

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

  async function upsertKnownProductLocation(product: Pick<Product, "id" | "sku">, locationValue: string) {
    const cleanLocation = normalizeLocationCode(locationValue);
    if (!selectedSession?.store_id || !product.id || !product.sku || !cleanLocation || cleanLocation.startsWith("__")) return;
    const now = new Date().toISOString();
    const row = {
      store_id: selectedSession.store_id,
      product_id: product.id,
      sku: normalizeCode(product.sku).toUpperCase(),
      location: cleanLocation,
      is_active: true,
      updated_by: user?.id || null,
      updated_at: now,
      last_source: "inventario general",
      last_seen_at: now,
      general_inventory_registered: true,
    };
    let { error } = await supabase.from("product_locations").upsert(row, { onConflict: "store_id,product_id,location" });
    if (error && /last_source|last_seen_at|general_inventory_registered/i.test(error.message)) {
      const fallbackRow: Partial<typeof row> = { ...row };
      delete fallbackRow.last_source;
      delete fallbackRow.last_seen_at;
      delete fallbackRow.general_inventory_registered;
      ({ error } = await supabase.from("product_locations").upsert(fallbackRow, { onConflict: "store_id,product_id,location" }));
    }
    if (error) console.warn("No se pudo registrar ubicacion de inventario general:", error.message);
  }

  async function replaceKnownInventoryLocations(product: Pick<Product, "id" | "sku">, locationValues: string[]) {
    if (!selectedSession?.store_id || !product.id || !product.sku) return;
    const cleanLocations = [...new Set(locationValues
      .map(location => normalizeLocationCode(location))
      .filter(location => location && !location.startsWith("__") && location !== "SIN_FISICO"))];
    const now = new Date().toISOString();

    const deactivateBySource = await supabase
      .from("product_locations")
      .update({ is_active: false, updated_by: user?.id || null, updated_at: now })
      .eq("store_id", selectedSession.store_id)
      .eq("product_id", product.id)
      .eq("is_active", true)
      .eq("last_source", "inventario general");

    let error = deactivateBySource.error;
    if (!error || /last_source/i.test(error.message)) {
      const deactivateByFlag = await supabase
        .from("product_locations")
        .update({ is_active: false, updated_by: user?.id || null, updated_at: now })
        .eq("store_id", selectedSession.store_id)
        .eq("product_id", product.id)
        .eq("is_active", true)
        .eq("general_inventory_registered", true);
      error = deactivateByFlag.error && !/general_inventory_registered/i.test(deactivateByFlag.error.message)
        ? deactivateByFlag.error
        : null;
    }

    if (error) {
      console.warn("No se pudieron reemplazar ubicaciones de inventario general:", error.message);
    }

    await Promise.all(cleanLocations.map(location => upsertKnownProductLocation(product, location)));
  }

  async function resolveInventoryLocation(locationValue: string, options: { allowCreate: boolean; sourceLabel?: string }) {
    const cleanLocation = normalizeLocationCode(locationValue);
    if (!selectedSessionId || !cleanLocation) return null;

    let loc = findInventoryLocation(locations, cleanLocation);
    if (!loc && navigator.onLine) {
      const numericKey = cleanLocation.replace(/^0+(?=\d)/, "");
      const lookupValues = [...new Set([cleanLocation, numericKey].filter(Boolean))];
      const directLocationRes = await supabase
        .from("general_inventory_locations")
        .select("*")
        .eq("session_id", selectedSessionId)
        .eq("is_active", true)
        .or(`location_code.in.(${lookupValues.join(",")}),ticket.in.(${lookupValues.join(",")})`)
        .limit(5);
      if (!directLocationRes.error) {
        const directLocations = (directLocationRes.data || []) as InventoryLocation[];
        loc = findInventoryLocation(directLocations, cleanLocation);
        if (loc) {
          const foundLocation: InventoryLocation = {
            ...loc,
            location_code: normalizeLocationCode(loc.location_code),
            ticket: loc.ticket ? normalizeLocationCode(loc.ticket) : loc.ticket,
          };
          setLocations(prev => {
            const exists = prev.some(item => item.id === foundLocation.id);
            return exists
              ? prev.map(item => item.id === foundLocation.id ? foundLocation : item)
              : [...prev, foundLocation];
          });
        }
      }
    }

    if (loc || !options.allowCreate || selectedSession?.location_lock_enabled) return loc || null;

    const fullLocation = options.sourceLabel || cleanLocation;
    const row = {
      session_id: selectedSessionId,
      location_code: cleanLocation,
      ticket: cleanLocation,
      zone: null,
      zone_ref: null,
      lineal: null,
      reference: null,
      full_location: fullLocation,
      description: fullLocation,
      is_active: true,
    };
    const { data, error } = await supabase
      .from("general_inventory_locations")
      .upsert(row, { onConflict: "session_id,location_code" })
      .select("*")
      .single();
    if (error) {
      setMessage("No se pudo registrar la ubicacion nueva: " + error.message);
      return null;
    }
    const nextLocation = data as InventoryLocation;
    setLocations(prev => {
      const exists = prev.some(item => item.id === nextLocation.id || normalizeLocationCode(item.location_code) === cleanLocation);
      const rows = exists
        ? prev.map(item => item.id === nextLocation.id || normalizeLocationCode(item.location_code) === cleanLocation ? nextLocation : item)
        : [...prev, nextLocation];
      return rows.sort((a, b) => String(a.location_code).localeCompare(String(b.location_code), "es", { numeric: true, sensitivity: "base" }));
    });
    return nextLocation;
  }

  async function toggleLocationLock() {
    if (!ensureSelectedSessionEditable()) return;
    if (!selectedSessionId || !canManageInventory) {
      setMessage("Solo el validador o administrador puede cambiar el seguro de ubicaciones.");
      return;
    }
    const nextValue = !Boolean(selectedSession?.location_lock_enabled);
    const { error } = await supabase
      .from("general_inventory_sessions")
      .update({ location_lock_enabled: nextValue, updated_at: new Date().toISOString() })
      .eq("id", selectedSessionId);
    if (error) {
      setMessage("No se pudo cambiar el seguro de ubicaciones. Ejecuta el SQL actualizado: " + error.message);
      return;
    }
    setSessions(prev => prev.map(session => session.id === selectedSessionId ? { ...session, location_lock_enabled: nextValue } : session));
    setMessage(nextValue
      ? "Seguro de ubicaciones activado. Solo se aceptan ubicaciones cargadas por Excel o registradas en preparacion."
      : "Seguro de ubicaciones desactivado. Se permitira registrar ubicaciones nuevas al contar o recontar."
    );
  }

  async function saveCount() {
    if (savingCountRef.current) return;
    if (!operator || !selectedSession || !canOperatorEnter(selectedSession.status)) {
      setMessage("No hay inventario activo para registrar.");
      return;
    }

    const locCode = normalizeLocationCode(locationCode);
    const loc = await resolveInventoryLocation(locCode, { allowCreate: true, sourceLabel: locCode });
    if (!loc) {
      setMessage(selectedSession.location_lock_enabled
        ? "Ubicacion no autorizada para esta sesion. Desactiva el seguro o carga la ubicacion por Excel."
        : "Ingresa una ubicacion valida."
      );
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

      const persistCountPending = async () => {
        const pendingPayload = { ...insertRow, sync_origin: "pwa_offline" };
        await enqueueOfflineItem({
          localId: clientUuid,
          clientUuid,
          deviceId,
          module: "general_inventory",
          entity: "general_inventory_counts",
          operation: "insert",
          payload: pendingPayload,
          status: "pending",
          attempts: pendingEdit?.attempts || 0,
          createdAt: pendingEdit?.createdAt || now,
          updatedAt: now,
        });
      };

      const keepCountPending = async (messageText: string) => {
        await persistCountPending();

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
        setMessage(messageText);
      };

      if (pendingEdit) {
        await keepCountPending("Edicion guardada en pendiente. Se subira solo la ultima version.");
        return;
      }

      if (!navigator.onLine) {
        const isPwa = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
        if (!isPwa) {
          setMessage("Sin conexion. Los conteos desde el navegador web requieren internet. Usa la app instalada para trabajar sin conexion.");
          return;
        }
        await keepCountPending("Conteo guardado sin conexion. Se sincronizara cuando vuelva internet.");
        return;
      }

      if (!editingCountId) {
        await persistCountPending();
      }

      // editingCountId puede seguir siendo un id local ("gi-count-<uuid>",
      // ver createClientUuid) si el registro se sincronizo en segundo plano
      // (cola offline, PwaQueueSync cada 30s) mientras el formulario de
      // edicion seguia abierto con ese id viejo capturado al montar. pendingEdit
      // ya no lo encuentra (se borro de la cola al sincronizar), asi que sin
      // este chequeo el id local se mandaba tal cual a la columna uuid de
      // Supabase y fallaba con "invalid input syntax for type uuid". Se busca
      // el id real por clave natural (misma sesion/producto/ubicacion) antes
      // de intentar el update.
      let updateTargetId = editingCountId;
      if (editingCountId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(editingCountId)) {
        const { data: syncedRow } = await supabase
          .from("general_inventory_counts")
          .select("id")
          .eq("session_id", selectedSession.id)
          .eq("product_id", product.id)
          .eq("location_id", loc.id)
          .maybeSingle();
        if (!syncedRow) {
          setMessage("Este registro se sincronizo mientras lo editabas. Recarga la pantalla e intenta de nuevo.");
          return;
        }
        updateTargetId = syncedRow.id;
      }

      const request = updateTargetId
        ? supabase.from("general_inventory_counts").update(row).eq("id", updateTargetId)
        : supabase.from("general_inventory_counts").insert(insertRow);
      const { error } = await request;

      if (error) {
        if (!editingCountId) {
          await keepCountPending("No se pudo confirmar en Supabase, pero el conteo quedo guardado en este equipo y se reintentara automaticamente.");
          return;
        }
        setMessage("No se pudo guardar la edicion en Supabase. El registro original no fue modificado: " + error.message);
        return;
      }

      // Local update inmediato — el realtime sincroniza con el servidor a los 800ms
      const localRow: CountRow = {
        id: updateTargetId ?? clientUuid,
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
      setMessage("Conteo guardado.");

      // Fire-and-forget: no bloquean al operador
      void removeOfflineItem(clientUuid).catch(() => undefined);
      void protectOkProductSnapshot(selectedSession.id, product).catch(error => {
        console.warn("No se pudo proteger snapshot OK:", error);
      });
      void upsertKnownProductLocation(product, loc.location_code);
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
    if (!operator || !selectedSessionId || savingRecountIdsRef.current.has(row.id)) return;
    savingRecountIdsRef.current.add(row.id);
    const validationMode = row.layer === "validation";
    const itemTable = validationMode ? "general_inventory_validation_items" : "general_inventory_recount_items";
    const countTable = validationMode ? "general_inventory_validation_counts" : "general_inventory_recount_counts";
    const itemIdColumn = validationMode ? "validation_item_id" : "recount_item_id";
    const actionLabel = validationMode ? "validacion" : "reconteo";
    if (selectedSession?.status === "finished") {
      setMessage(`Esta sesion ya fue finalizada. No se puede guardar ${actionLabel}.`);
      savingRecountIdsRef.current.delete(row.id);
      return;
    }
    const draft = recountDraftFor(row);
    if (!draft.productCode.trim()) {
      setMessage(`Ingresa codigo valido para la ${actionLabel}.`);
      savingRecountIdsRef.current.delete(row.id);
      return;
    }

    const lines = draft.rows
      .map(line => ({
        locationCode: normalizeLocationCode(line.locationCode),
        quantity: String(line.quantity).trim() === "" ? NaN : Number(line.quantity),
        isExtra: Boolean(line.isExtra),
      }))
      .filter(line => line.locationCode || line.quantity > 0 || !line.isExtra);

    if (lines.length === 0) {
      setMessage(`Ingresa al menos una ubicacion y cantidad para la ${actionLabel}.`);
      savingRecountIdsRef.current.delete(row.id);
      return;
    }

    const locationRows: Array<{ loc: InventoryLocation | null; locationCode: string; quantity: number }> = [];
    for (const line of lines) {
      if (!line.locationCode) {
        if (row.recount_type === "missing" && line.quantity === 0) {
          locationRows.push({ loc: null, locationCode: "SIN_FISICO", quantity: 0 });
          continue;
        }
        setMessage(`Completa la ubicacion en todas las lineas de la ${actionLabel}.`);
        savingRecountIdsRef.current.delete(row.id);
        return;
      }
      const loc = await resolveInventoryLocation(line.locationCode, { allowCreate: true, sourceLabel: line.locationCode });
      if (!loc) {
        setMessage(selectedSession?.location_lock_enabled
          ? `Ubicacion ${line.locationCode} no autorizada para esta sesion.`
          : `Ubicacion ${line.locationCode} no valida.`
        );
        savingRecountIdsRef.current.delete(row.id);
        return;
      }
      if (!Number.isFinite(line.quantity) || line.quantity < 0) {
        setMessage(`Ingresa cantidades validas para todas las lineas de la ${actionLabel}.`);
        savingRecountIdsRef.current.delete(row.id);
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
        setMessage(candidates.length > 1 ? `El codigo de la ${actionLabel} coincide con varios productos. Ingresa el CodSap exacto.` : "Codigo no existe en el maestro ni en codigos de barra.");
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
        .from(countTable)
        .delete()
        .eq(itemIdColumn, row.id);
      if (deleteExisting.error) {
        setMessage(`No se pudo reemplazar la ${actionLabel} anterior: ` + deleteExisting.error.message);
        return;
      }

      const rows = locationRows.map(({ loc, locationCode, quantity }) => ({
          [itemIdColumn]: row.id,
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
          ...(validationMode ? {} : {
            client_uuid: createClientUuid("gi-recount"),
            client_device_id: getOrCreateDeviceId(),
            sync_origin: "web",
          }),
          updated_at: new Date().toISOString(),
      }));
      const { error } = await supabase
        .from(countTable)
        .insert(rows);
      if (error) {
        setMessage(`No se pudo guardar ${actionLabel}. Ejecuta el SQL actualizado: ` + error.message);
        return;
      }
      await replaceKnownInventoryLocations(product, locationRows.map(({ locationCode }) => locationCode));

      const statusUpdate = await supabase
        .from(itemTable)
        .update({ status: "counted", updated_at: new Date().toISOString() })
        .eq("id", row.id);
      if (statusUpdate.error) {
        setMessage(`${validationMode ? "Validacion" : "Reconteo"} guardado, pero no se pudo cerrar la linea: ` + statusUpdate.error.message);
        return;
      }

      setRecountDrafts(prev => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      setEditingRecountItemId(null);
      setMessage(`${validationMode ? "Validacion" : "Reconteo"} guardado.`);
      await loadOperatorRecountItems(selectedSessionId, operator.id);
    } finally {
      savingRecountIdsRef.current.delete(row.id);
      setSavingRecountId(null);
    }
  }

  function updateManualRecountDraft(rowId: string, field: keyof ManualRecountDraft, value: string) {
    setManualRecountDrafts(prev => ({
      ...prev,
      [rowId]: {
        locationCode: prev[rowId]?.locationCode || "",
        quantity: prev[rowId]?.quantity || "",
        [field]: value,
      },
    }));
  }

  function parseManualRecountLines(locationText: string, totalQuantity: number) {
    const rawParts = locationText
      .split(/\n|;/)
      .map(part => part.trim())
      .filter(Boolean);
    if (rawParts.length <= 1) {
      return [{ locationCode: normalizeLocationCode(locationText), quantity: totalQuantity }];
    }
    const rows = rawParts.map(part => {
      const match = part.match(/^(.+?)[=:,]\s*(-?\d+(?:[.,]\d+)?)$/);
      if (!match) return { locationCode: normalizeLocationCode(part), quantity: NaN };
      return {
        locationCode: normalizeLocationCode(match[1]),
        quantity: Number(match[2].replace(",", ".")),
      };
    });
    if (rows.some(line => !Number.isFinite(line.quantity))) {
      return rawParts.map(part => ({ locationCode: normalizeLocationCode(part), quantity: totalQuantity }));
    }
    return rows;
  }

  async function saveManualRecountValidation(row: RecountItem) {
    if (!ensureSelectedSessionEditable()) return;
    if (savingRecountIdsRef.current.has(row.id)) return;
    savingRecountIdsRef.current.add(row.id);
    if (!selectedSessionId || !canManageInventory) {
      setMessage("Solo el validador o administrador puede registrar reconteos manuales.");
      savingRecountIdsRef.current.delete(row.id);
      return;
    }
    if (!row.assigned_operator_id) {
      setMessage("Este reconteo no tiene recontador asignado.");
      savingRecountIdsRef.current.delete(row.id);
      return;
    }
    const draft = manualRecountDrafts[row.id] || { locationCode: "", quantity: "" };
    const totalQuantity = Number(String(draft.quantity).replace(",", "."));
    if (!Number.isFinite(totalQuantity) || totalQuantity < 0) {
      setMessage("Ingresa una cantidad de reconteo valida.");
      savingRecountIdsRef.current.delete(row.id);
      return;
    }

    const parsedLines = parseManualRecountLines(draft.locationCode, totalQuantity)
      .filter(line => line.locationCode || totalQuantity === 0);
    if (parsedLines.length === 0) {
      setMessage("Ingresa al menos una ubicacion para el reconteo manual.");
      savingRecountIdsRef.current.delete(row.id);
      return;
    }

    const locationRows: Array<{ loc: InventoryLocation | null; locationCode: string; quantity: number }> = [];
    for (const line of parsedLines) {
      if (!line.locationCode) {
        if (row.recount_type === "missing" && totalQuantity === 0) {
          locationRows.push({ loc: null, locationCode: "SIN_FISICO", quantity: 0 });
          continue;
        }
        setMessage("Completa la ubicacion del reconteo manual.");
        savingRecountIdsRef.current.delete(row.id);
        return;
      }
      if (!Number.isFinite(line.quantity) || line.quantity < 0) {
        setMessage("Si ingresas varias ubicaciones usa el formato UBICACION:CANTIDAD por linea.");
        savingRecountIdsRef.current.delete(row.id);
        return;
      }
      const loc = await resolveInventoryLocation(line.locationCode, { allowCreate: true, sourceLabel: line.locationCode });
      if (!loc) {
        setMessage(selectedSession?.location_lock_enabled
          ? `Ubicacion ${line.locationCode} no autorizada para esta sesion.`
          : `No se pudo registrar la ubicacion ${line.locationCode}.`
        );
        savingRecountIdsRef.current.delete(row.id);
        return;
      }
      locationRows.push({ loc, locationCode: loc.location_code, quantity: line.quantity });
    }

    setSavingRecountId(row.id);
    try {
      const cost = Number(row.cost_snapshot || 0);
      const deleteExisting = await supabase
        .from("general_inventory_recount_counts")
        .delete()
        .eq("recount_item_id", row.id);
      if (deleteExisting.error) {
        setMessage("No se pudo reemplazar el reconteo manual anterior: " + deleteExisting.error.message);
        return;
      }

      const now = new Date().toISOString();
      const rows = locationRows.map(({ loc, locationCode, quantity }) => ({
        recount_item_id: row.id,
        session_id: selectedSessionId,
        operator_id: row.assigned_operator_id,
        location_id: loc?.id || null,
        location_code: loc?.location_code || locationCode,
        product_id: row.product_id,
        sku: row.sku,
        description: row.description,
        unit: row.unit,
        quantity,
        cost_snapshot: cost,
        client_uuid: createClientUuid("gi-manual-recount"),
        client_device_id: getOrCreateDeviceId(),
        sync_origin: "manual_sheet",
        counted_at: now,
        updated_at: now,
      }));
      const { error } = await supabase.from("general_inventory_recount_counts").insert(rows);
      if (error) {
        setMessage("No se pudo guardar reconteo manual. Ejecuta el SQL actualizado: " + error.message);
        return;
      }
      await replaceKnownInventoryLocations({ id: row.product_id, sku: row.sku }, locationRows.map(({ locationCode }) => locationCode));

      const statusUpdate = await supabase
        .from("general_inventory_recount_items")
        .update({ status: "counted", updated_at: now })
        .eq("id", row.id);
      if (statusUpdate.error) {
        setMessage("Reconteo manual guardado, pero no se pudo cerrar la linea: " + statusUpdate.error.message);
        return;
      }
      setManualRecountDrafts(prev => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      setMessage("Reconteo manual guardado y aplicado al resumen.");
      await Promise.all([
        loadRecountAssignments(selectedSessionId),
        loadAdminRecountRecords(selectedSessionId),
        loadSummary(selectedSessionId, true),
      ]);
    } finally {
      savingRecountIdsRef.current.delete(row.id);
      setSavingRecountId(null);
    }
  }

  function generateManualRecountSheet() {
    if (!selectedSession) return;
    const rows = manualRecountRows;
    if (rows.length === 0) {
      setMessage("No hay reconteos manuales para imprimir con ese filtro.");
      return;
    }
    const operatorName = recountPrintOperatorId
      ? sessionOperators.find(item => item.id === recountPrintOperatorId)?.full_name || "Recontador"
      : "Todos los recontadores";
    const generatedAt = new Date().toLocaleString("es-PE");
    const recountDate = new Date().toLocaleDateString("es-PE");
    const recountTypeLabel = recountType === "missing" ? "Faltante" : "Sobrante";
    const title = `Reconteo manual de ${recountType === "missing" ? "faltantes" : "sobrantes"} - tienda ${selectedSession.store_name || selectedSession.name}`;
    const bodyRows = rows.map((row, index) => {
      const locationLines = (countLocationLinesByProduct.get(row.product_id) || row.original_locations || [])
        .slice(0, 4)
        .map(line => `${line.full_location || line.location_code} (${number2(line.counted_qty)} ${row.unit})`)
        .join("<br>");
      return `
        <tr>
          <td class="num">${index + 1}</td>
          <td class="code">${escapeHtml(row.sku)}</td>
          <td>${escapeHtml(row.description)}</td>
          <td class="center">${escapeHtml(row.unit)}</td>
          <td class="num">${number2(row.system_stock)}</td>
          <td class="num">${number2(row.counted_qty)}</td>
          <td class="num ${row.diff_qty < 0 ? "red" : "blue"}">${number2(row.diff_qty)}</td>
          <td class="num ${row.value_diff < 0 ? "red" : "blue"}">${money(row.value_diff)}</td>
          <td class="blank"></td>
          <td class="blank"></td>
          <td class="locations">${locationLines || "SIN UBICACION REGISTRADA"}</td>
        </tr>`;
    }).join("");
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4 landscape; margin: 8mm; }
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; color: #071126; margin: 0; font-size: 10px; }
    h1 { margin: 0 0 4px; font-size: 19px; }
    .header { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1.5px solid #071126; padding-bottom: 8px; margin-bottom: 8px; }
    .meta { font-size: 10px; line-height: 1.35; color: #334155; }
    .fields { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 8px; }
    .field { border: 1px solid #cbd5e1; border-radius: 4px; padding: 6px; min-height: 34px; }
    .field span { display: block; color: #64748b; font-size: 8px; font-weight: 700; text-transform: uppercase; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; page-break-inside: auto; }
    th, td { border: 1px solid #b9c6d6; padding: 3px 4px; vertical-align: top; }
    th { background: #eef3f8; text-align: left; font-size: 8px; }
    td { height: 48px; }
    .num { text-align: right; font-weight: 700; }
    .center { text-align: center; }
    .code { font-weight: 700; width: 72px; }
    .blank { background: #fff; }
    .locations { font-size: 8px; line-height: 1.25; }
    .red { color: #d00; }
    .blue { color: #0647e8; }
    .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 42px; margin-top: 18px; page-break-inside: avoid; }
    .signature { border-top: 1.5px solid #071126; padding-top: 6px; text-align: center; font-weight: 700; }
    @media print { .page-break { page-break-after: always; } }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">Inventario: ${escapeHtml(selectedSession.name)}<br>Tienda: ${escapeHtml(selectedSession.store_name || selectedSession.store_id)}<br>Recontador: ${escapeHtml(operatorName)}</div>
    </div>
    <div class="meta" style="text-align:right">Generado: ${escapeHtml(generatedAt)}<br>Registros: ${rows.length}<br>Tipo: ${recountType === "missing" ? "Faltantes" : "Sobrantes"}</div>
  </div>
  <div class="fields">
    <div class="field"><span>Nombre del recontador</span><strong>${escapeHtml(operatorName)}</strong></div>
    <div class="field"><span>Fecha de reconteo</span><strong>${escapeHtml(recountDate)}</strong></div>
    <div class="field"><span>Hoja / validacion</span><strong>${escapeHtml(recountTypeLabel)}</strong></div>
  </div>
  <table>
    <thead>
      <tr>
        <th style="width:30px">#</th>
        <th style="width:76px">Codigo</th>
        <th>Descripcion</th>
        <th style="width:42px">UM</th>
        <th style="width:58px">Stock</th>
        <th style="width:58px">Conteo</th>
        <th style="width:58px">Dif.</th>
        <th style="width:72px">Dif. val.</th>
        <th style="width:78px">Reconteo</th>
        <th style="width:78px">Validacion</th>
        <th style="width:210px">Ubicaciones y cantidades</th>
      </tr>
    </thead>
    <tbody>${bodyRows}</tbody>
  </table>
  <div class="signatures">
    <div class="signature">Firma jefe de almacen</div>
    <div class="signature">Firma asesor que recuenta</div>
  </div>
</body>
</html>`;
    const reportWindow = window.open("", "_blank");
    if (!reportWindow) {
      setMessage("El navegador bloqueo la hoja de reconteo manual. Permite ventanas emergentes.");
      return;
    }
    reportWindow.document.write(html);
    reportWindow.document.close();
    reportWindow.focus();
    setTimeout(() => reportWindow.print(), 500);
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
    if (!ensureSelectedSessionEditable()) return;
    setEditingAdminCount(row);
    setEditingAdminLocation(row.location_code || "");
    setEditingAdminQuantity(String(row.quantity || ""));
  }

  async function saveAdminEditCount() {
    if (!ensureSelectedSessionEditable()) return;
    if (!editingAdminCount) return;
    const qty = Number(editingAdminQuantity);
    const location = editingAdminLocation.trim().toUpperCase();
    if (!location || !Number.isFinite(qty) || qty < 0) {
      setMessage("Ingresa ubicacion y cantidad valida.");
      return;
    }

    // Si el codigo ya esta OK (contado = stock), avisar antes de editar: la
    // edicion casi seguro lo va a dejar con una diferencia real.
    let wasOk = false;
    try {
      const status = await checkProductCurrentlyOk(editingAdminCount.session_id, editingAdminCount.product_id);
      wasOk = status.ok;
      if (wasOk) {
        const confirmed = window.confirm(
          `${editingAdminCount.sku} ya esta OK (contado = stock sistema: ${status.systemStock}).\n` +
          `Si editas este registro es muy probable que quede con una diferencia (sobrante o faltante).\n\n` +
          `¿Confirmas que quieres editarlo de todas formas?`
        );
        if (!confirmed) return;
      }
    } catch (checkError) {
      console.warn("No se pudo verificar el estado OK antes de editar:", checkError);
    }

    const locationRow = await resolveInventoryLocation(location, { allowCreate: true, sourceLabel: location });
    if (!locationRow) {
      setMessage(selectedSession?.location_lock_enabled ? "La ubicacion no esta cargada para esta sesion." : "No se pudo registrar la ubicacion.");
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

    // El registro cambio: Resumen/Productividad quedaron desactualizados
    // hasta que alguien los vuelva a visitar (o se recarguen aca mismo).
    markSessionTabStale(editingAdminCount.session_id, "resumen");
    markSessionTabStale(editingAdminCount.session_id, "productividad");

    // Si el producto dejo de estar protegido por esta edicion, no esperar al
    // proximo cambio real de stock_general -- sincronizarlo con el ERP ya.
    if (wasOk) {
      try {
        await refreshSingleProductStockFromErp(editingAdminCount.session_id, editingAdminCount.product_id, editingAdminCount.sku);
      } catch (refreshError) {
        console.warn("No se pudo re-sincronizar stock en vivo tras la edicion:", refreshError);
      }
    }

    setEditingAdminCount(null);
    setMessage("Registro actualizado.");
    await loadSessionData(editingAdminCount.session_id, isValidator ? validatorTab : "registros");
  }

  // Edicion de system_stock en sesiones YA finalizadas -- unicamente para
  // corregir a mano un stock de sistema que quedo mal congelado (ver
  // investigacion de Huancayo en LOG_PROYECTO.md, 2026-07-19). Restringido
  // a un solo usuario (FINISHED_STOCK_EDITOR_USER_ID) y a sesiones
  // finalizadas. No toca stock_general ni dispara ningun refresco de ERP
  // -- es un UPDATE directo y puntual sobre general_inventory_stock_snapshot,
  // marcado con manually_adjusted para dejar rastro de que ya no es el
  // valor original congelado por el sistema.
  function openFinishedStockEdit(row: SummaryRow) {
    if (!isSelectedSessionFinished) return;
    if (user?.id !== FINISHED_STOCK_EDITOR_USER_ID) return;
    setEditingFinishedStock(row);
    setEditingFinishedStockValue(String(row.system_stock ?? ""));
    setEditingFinishedStockNote("");
  }

  async function saveFinishedStockEdit() {
    if (!editingFinishedStock || !selectedSessionId) return;
    if (user?.id !== FINISHED_STOCK_EDITOR_USER_ID) return;
    if (!isSelectedSessionFinished) {
      setMessage("Esta edicion solo aplica a sesiones ya finalizadas.");
      return;
    }

    const newValue = Number(editingFinishedStockValue);
    if (!Number.isFinite(newValue) || newValue < 0) {
      setMessage("Ingresa un stock de sistema valido (numero mayor o igual a 0).");
      return;
    }
    const oldValue = Number(editingFinishedStock.system_stock || 0);
    if (newValue === oldValue) {
      setMessage("El valor no cambio, no se guardo nada.");
      setEditingFinishedStock(null);
      return;
    }
    const note = editingFinishedStockNote.trim();
    if (!note) {
      setMessage("El motivo del ajuste es obligatorio.");
      return;
    }

    const confirmed = window.confirm(
      `Vas a cambiar el stock de sistema de ${editingFinishedStock.sku} (${editingFinishedStock.description}) ` +
      `de ${number2(oldValue)} a ${number2(newValue)} en un inventario YA FINALIZADO.\n\n` +
      `Esto mueve el resultado y los KPIs de este inventario (Valor sistema, Diferencia, ERI, etc.) ` +
      `de forma inmediata y visible para todos. El stock queda congelado con este valor -- no se vuelve a sincronizar con el ERP.\n\n` +
      `Motivo registrado: "${note}"\n\n` +
      `¿Confirmas el cambio?`
    );
    if (!confirmed) return;

    setSavingFinishedStockEdit(true);
    const { error } = await supabase
      .from("general_inventory_stock_snapshot")
      .update({
        system_stock: newValue,
        manually_adjusted: true,
        adjusted_by: user?.id || null,
        adjusted_at: new Date().toISOString(),
        adjustment_note: note,
      })
      .eq("session_id", selectedSessionId)
      .eq("product_id", editingFinishedStock.product_id);
    setSavingFinishedStockEdit(false);

    if (error) {
      setMessage("No se pudo guardar el ajuste de stock: " + error.message);
      return;
    }

    setEditingFinishedStock(null);
    setMessage(`Stock de sistema de ${editingFinishedStock.sku} actualizado a ${number2(newValue)}.`);
    // "En tiempo real": recarga forzada del resumen para que el KPI y la
    // tabla reflejen el ajuste de inmediato, sin esperar a que el usuario
    // navegue fuera y vuelva.
    await loadSummary(selectedSessionId, true);
  }

  async function deleteCount(row: CountRow) {
    if (!ensureSelectedSessionEditable()) return;
    if (!canManageInventory) { setMessage("Tu usuario tiene acceso de solo lectura."); return; }
    const confirmed = window.confirm(`Borrar el registro de ${row.sku} en ${row.location_code || "SIN UBICACION"} (${row.quantity} ${row.unit || "un"})?`);
    if (!confirmed) return;
    const { error } = await supabase.from("general_inventory_counts").delete().eq("id", row.id);
    if (error) {
      setMessage("No se pudo eliminar: " + error.message);
      return;
    }
    markSessionTabStale(row.session_id, "resumen");
    markSessionTabStale(row.session_id, "productividad");
    await loadSessionData(row.session_id, isValidator ? validatorTab : "registros");
  }

  async function saveObservation(row: SummaryRow) {
    if (!ensureSelectedSessionEditable()) return;
    if (!canManageInventory) { setMessage("Tu usuario tiene acceso de solo lectura."); return; }
    if (!user || !selectedSessionId) return;
    const observation = observationDrafts[row.product_id] || "";
    const { error } = await supabase
      .from("general_inventory_item_observations")
      .upsert({
        session_id: selectedSessionId,
        product_id: row.product_id,
        observation: observation || null,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: "session_id,product_id" });
    if (error) {
      setMessage("No se pudo guardar observacion: " + error.message);
      return;
    }
    dirtyObservationKeysRef.current.delete(observationKey(selectedSessionId, row.product_id));
    setSummary(prev => prev.map(item => item.product_id === row.product_id ? { ...item, observation } : item));
    const cached = summaryCacheRef.current.get(selectedSessionId);
    if (cached) {
      const rows = cached.rows.map(item => item.product_id === row.product_id ? { ...item, observation } : item);
      summaryCacheRef.current.set(selectedSessionId, {
        ...cached,
        rows,
        observationDrafts: { ...cached.observationDrafts, [row.product_id]: observation },
        cachedAt: Date.now(),
      });
    }
    setMessage("Observacion guardada.");
    await loadSummary(selectedSessionId, true);
  }

  async function markSummaryAsNonInventory(row: SummaryRow) {
    if (!ensureSelectedSessionEditable()) return;
    if (!selectedSessionId) return;
    const confirmed = window.confirm(
      `Vas a marcar ${row.sku} como "No inventariable".\n\n` +
      "El codigo se excluira de los KPIs y del resumen de esta sesion. " +
      "Esta accion no modifica el stock ERP, pero requiere reversarla manualmente si fue un error.\n\n" +
      "¿Deseas continuar?"
    );
    if (!confirmed) return;
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

  async function loadRecountRecordsForExport(sessionId: string) {
    const { data, error } = await supabase
      .from("general_inventory_recount_counts")
      .select("*, general_inventory_operators(full_name)")
      .eq("session_id", sessionId)
      .order("updated_at", { ascending: false, nullsFirst: false })
      .order("counted_at", { ascending: false });
    if (error) throw error;

    const countRows = (data || []) as Array<Record<string, unknown>>;
    const itemIds = [...new Set(countRows.map(row => String(row.recount_item_id || "")).filter(Boolean))];
    const itemRows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < itemIds.length; i += 100) {
      const { data: itemsData, error: itemsError } = await supabase
        .from("general_inventory_recount_items")
        .select("*")
        .in("id", itemIds.slice(i, i + 100));
      if (itemsError) throw itemsError;
      itemRows.push(...((itemsData || []) as Array<Record<string, unknown>>));
    }

    const productIds = [...new Set([
      ...countRows.map(row => String(row.product_id || "")).filter(Boolean),
      ...itemRows.map(row => String(row.product_id || "")).filter(Boolean),
    ])];
    const originalByLocation = await loadOriginalCountedByProductLocation(sessionId, productIds);
    const itemById = new Map(itemRows.map(row => [String(row.id || ""), row]));

    return countRows.map(countRow => {
      const item = itemById.get(String(countRow.recount_item_id || "")) || {};
      const locationId = String(countRow.location_id || "");
      const locationCode = normalizeLocationCode(String(countRow.location_code || ""));
      const productIdsToCheck = [...new Set([String(countRow.product_id || ""), String(item.product_id || "")].filter(Boolean))];
      const skusToCheck = [...new Set([String(countRow.sku || ""), String(item.sku || "")].map(sku => normalizeCode(sku).toUpperCase()).filter(Boolean))];
      let originalQuantity = 0;
      for (const productId of productIdsToCheck) {
        const byId = locationId ? originalByLocation.get(`${productId}__id__${locationId}`) : undefined;
        const byCode = locationCode ? originalByLocation.get(`${productId}__code__${locationCode}`) : undefined;
        if (byId !== undefined || byCode !== undefined) {
          originalQuantity = byId ?? byCode ?? 0;
          break;
        }
      }
      if (originalQuantity === 0) {
        for (const sku of skusToCheck) {
          const byId = locationId ? originalByLocation.get(`sku__${sku}__id__${locationId}`) : undefined;
          const byCode = locationCode ? originalByLocation.get(`sku__${sku}__code__${locationCode}`) : undefined;
          if (byId !== undefined || byCode !== undefined) {
            originalQuantity = byId ?? byCode ?? 0;
            break;
          }
        }
      }
      const operator = countRow.general_inventory_operators as { full_name?: string | null } | null | undefined;
      const recountType = String(item.recount_type || "");
      const quantity = Number(countRow.quantity || 0);
      const cost = Number(countRow.cost_snapshot || item.cost_snapshot || 0);
      return {
        FECHA: countRow.counted_at ? new Date(String(countRow.counted_at)).toLocaleString("es-PE") : "",
        ULTIMA_EDICION: (countRow.updated_at || countRow.counted_at) ? new Date(String(countRow.updated_at || countRow.counted_at)).toLocaleString("es-PE") : "",
        RECONTADOR: operator?.full_name || "",
        TIPO: recountType === "missing" ? "Faltante" : recountType === "surplus" ? "Sobrante" : "",
        UBICACION: String(countRow.location_code || ""),
        CODIGO: String(countRow.sku || item.sku || ""),
        DESCRIPCION: String(countRow.description || item.description || ""),
        UM: String(countRow.unit || item.unit || ""),
        SISTEMA: Number(item.system_stock || 0),
        CONTEO: originalQuantity,
        RECONTEO: quantity,
        DIF: quantity - originalQuantity,
        COSTO: cost,
        VALOR_RECONTEO: quantity * cost,
      };
    });
  }

  async function loadValidationRecordsForExport(sessionId: string) {
    const { data, error } = await supabase
      .from("general_inventory_validation_counts")
      .select("*, general_inventory_operators(full_name)")
      .eq("session_id", sessionId)
      .order("updated_at", { ascending: false, nullsFirst: false })
      .order("counted_at", { ascending: false });
    if (error) throw error;

    const countRows = (data || []) as Array<Record<string, unknown>>;
    const itemIds = [...new Set(countRows.map(row => String(row.validation_item_id || "")).filter(Boolean))];
    const itemRows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < itemIds.length; i += 100) {
      const { data: itemsData, error: itemsError } = await supabase
        .from("general_inventory_validation_items")
        .select("*")
        .in("id", itemIds.slice(i, i + 100));
      if (itemsError) throw itemsError;
      itemRows.push(...((itemsData || []) as Array<Record<string, unknown>>));
    }

    const itemById = new Map(itemRows.map(row => [String(row.id || ""), row]));
    return countRows.map(countRow => {
      const item = itemById.get(String(countRow.validation_item_id || "")) || {};
      const operator = countRow.general_inventory_operators as { full_name?: string | null } | null | undefined;
      const recountType = String(item.recount_type || "");
      const quantity = Number(countRow.quantity || 0);
      const cost = Number(countRow.cost_snapshot || item.cost_snapshot || 0);
      return {
        FECHA: countRow.counted_at ? new Date(String(countRow.counted_at)).toLocaleString("es-PE") : "",
        ULTIMA_EDICION: (countRow.updated_at || countRow.counted_at) ? new Date(String(countRow.updated_at || countRow.counted_at)).toLocaleString("es-PE") : "",
        VALIDADOR: operator?.full_name || "",
        TIPO: recountType === "missing" ? "Faltante" : recountType === "surplus" ? "Sobrante" : "",
        UBICACION: String(countRow.location_code || ""),
        CODIGO: String(countRow.sku || item.sku || ""),
        DESCRIPCION: String(countRow.description || item.description || ""),
        UM: String(countRow.unit || item.unit || ""),
        SISTEMA: Number(item.system_stock || 0),
        RECONTEO_BASE: Number(item.counted_qty || 0),
        VALIDACION: quantity,
        DIF_VALIDACION_RECONTEO: quantity - Number(item.counted_qty || 0),
        COSTO: cost,
        VALOR_VALIDACION: quantity * cost,
      };
    });
  }

  async function exportRecords() {
    if (!selectedSessionId) return;
    const orderedCounts = [...filteredCounts].sort((a, b) => compareLocationByZone(a.location_code, b.location_code, "asc"));
    const rows = orderedCounts.map(row => ({
      FECHA: new Date(row.counted_at).toLocaleString("es-PE"),
      CONTADOR: row.operator_name || "",
      ZONA: locationZoneKey(row.location_code),
      UBICACION: normalizeLocationCode(row.location_code),
      CODIGO: row.sku,
      DESCRIPCION: row.description,
      UM: row.unit,
      CANTIDAD: row.quantity,
      COSTO: row.cost_snapshot,
      VALOR: row.quantity * row.cost_snapshot,
    }));
    let recountRows: Awaited<ReturnType<typeof loadRecountRecordsForExport>> = [];
    let validationRows: Awaited<ReturnType<typeof loadValidationRecordsForExport>> = [];
    try {
      recountRows = await loadRecountRecordsForExport(selectedSessionId);
      if (selectedSession?.validation_enabled) validationRows = await loadValidationRecordsForExport(selectedSessionId);
    } catch (error: unknown) {
      setMessage("No se pudieron leer los registros de reconteo/validacion para el Excel: " + (error instanceof Error ? error.message : String(error)));
      return;
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Registros");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(recountRows), "Reconteo");
    if (selectedSession?.validation_enabled) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(validationRows), "Validacion");
    XLSX.writeFile(wb, `inventario_registros_${selectedSession?.name || "sesion"}.xlsx`);
  }

  function printRecordsByZone() {
    if (!selectedSession) return;
    const rows = [...filteredCounts].sort((a, b) => compareLocationByZone(a.location_code, b.location_code, "asc"));
    if (rows.length === 0) {
      setMessage("No hay registros para imprimir.");
      return;
    }
    const generatedAt = new Date().toLocaleString("es-PE");
    const title = `Registros de inventario - ${selectedSession.store_name || selectedSession.name}`;
    const bodyRows = rows.map((row, index) => `
      <tr>
        <td class="num">${index + 1}</td>
        <td>${escapeHtml(locationZoneKey(row.location_code))}</td>
        <td>${escapeHtml(normalizeLocationCode(row.location_code))}</td>
        <td class="code">${escapeHtml(row.sku)}</td>
        <td>${escapeHtml(row.description)}</td>
        <td>${escapeHtml(row.unit)}</td>
        <td class="num">${number2(row.quantity)}</td>
        <td>${escapeHtml(row.operator_name || "Sin usuario")}</td>
        <td>${escapeHtml(new Date(row.counted_at).toLocaleString("es-PE"))}</td>
      </tr>
    `).join("");
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4 landscape; margin: 8mm; }
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; color: #071126; margin: 0; font-size: 10px; }
    h1 { margin: 0 0 4px; font-size: 18px; }
    .header { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1.5px solid #071126; padding-bottom: 8px; margin-bottom: 8px; }
    .meta { color: #334155; line-height: 1.35; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #b9c6d6; padding: 3px 4px; vertical-align: top; }
    th { background: #eef3f8; text-align: left; font-size: 8px; }
    .num { text-align: right; font-weight: 700; }
    .code { font-weight: 700; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">Inventario: <strong>${escapeHtml(selectedSession.name)}</strong><br>Tienda: <strong>${escapeHtml(selectedSession.store_name || selectedSession.store_id)}</strong></div>
    </div>
    <div class="meta" style="text-align:right">Generado: <strong>${escapeHtml(generatedAt)}</strong><br>Registros: <strong>${number2(rows.length)}</strong><br>${recordsZoneFilter ? `Zona: <strong>${escapeHtml(recordsZoneFilter)}</strong><br>` : ""}Orden: <strong>Zona / ubicacion A-Z</strong></div>
  </div>
  <table>
    <thead>
      <tr>
        <th style="width:32px" class="num">#</th>
        <th style="width:52px">Zona</th>
        <th style="width:105px">Ubicacion</th>
        <th style="width:76px">Codigo</th>
        <th>Descripcion</th>
        <th style="width:38px">UM</th>
        <th style="width:58px" class="num">Cantidad</th>
        <th style="width:115px">Contador</th>
        <th style="width:95px">Fecha</th>
      </tr>
    </thead>
    <tbody>${bodyRows}</tbody>
  </table>
</body>
</html>`;
    const reportWindow = window.open("", "_blank");
    if (!reportWindow) {
      setMessage("El navegador bloqueo la impresion de registros. Permite ventanas emergentes.");
      return;
    }
    reportWindow.document.write(html);
    reportWindow.document.close();
    reportWindow.focus();
    setTimeout(() => reportWindow.print(), 500);
  }

  function exportSummary() {
    const rows = summary.map(row => {
      const base = {
        CODIGO: row.sku,
        DESCRIPCION: row.description,
        UM: row.unit,
        STOCK_SISTEMA: row.system_stock,
        CONTEO: row.counted_original,
        RECONTEO: summaryQuantityStatusLabel(row.recounted_qty, row.recount_status),
      };
      return {
        ...base,
        ...(showValidationSummary ? {
          VALIDACION: summaryQuantityStatusLabel(row.validation_qty, row.validation_status),
        } : {}),
        DIFERENCIA: row.diff,
        STATUS: summaryStatus(row),
        COSTO: row.cost,
        DIF_VALORIZADA: row.valueDiff,
        ...(showValidationSummary ? {
          VALIDADO: row.validated ? "SI" : "NO",
        } : {}),
        OBSERVACION: row.observation || "",
      };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Resumen");
    XLSX.writeFile(wb, `inventario_resumen_${selectedSession?.name || "sesion"}.xlsx`);
  }

  async function generateInventoryCategoryReport() {
    if (!selectedSession) {
      setMessage("Selecciona un inventario para generar el Reporte IG.");
      return;
    }
    if (summary.length === 0) {
      setMessage("Carga o actualiza el resumen antes de generar el Reporte IG.");
      return;
    }

    // Abrimos la ventana dentro del gesto del usuario para evitar que el
    // navegador bloquee el informe mientras cargamos el control de tickets.
    const reportWindow = window.open("", "_blank");
    if (!reportWindow) {
      setMessage("El navegador bloqueo el Reporte IG. Permite ventanas emergentes.");
      return;
    }
    reportWindow.document.write("<p style=\"font-family:Arial;padding:24px\">Preparando Reporte IG...</p>");
    reportWindow.document.close();
    setMessage("Preparando Reporte IG y analizando zonas del control de tickets...");

    type ZoneCountRow = { name: string; codes: number; percentage: number };
    const normalizeReportZone = (value: unknown) => {
      const normalized = String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
      return normalized || "SIN ZONA";
    };
    const exhibitedZones = new Set(["TIENDA", "PISO_VENTA", "PISO_VENTA (1)", "PISO_VENTA (2)", "PASILLO_VENTA"]);
    const isExhibitedZone = (zone: string) => exhibitedZones.has(zone);
    const isDiamanteSession = String(selectedSession.store_name || "").toUpperCase().includes("DIAMANTE");
    const diamanteExhibitedLocations = new Set(["09", "174", "200", "20O"]);
    const reportZoneForLocation = (rawZone: unknown, rawLocationCode: unknown) => {
      const zone = normalizeReportZone(rawZone);
      const locationKey = locationZoneKey(normalizeLocationCode(String(rawLocationCode || "")));
      if (isDiamanteSession && zone === "SIN ZONA" && diamanteExhibitedLocations.has(locationKey)) return "TIENDA";
      // A counted product without a zone in the ticket control is treated as warehouse.
      return zone === "SIN ZONA" ? "ALMACEN" : zone;
    };
    const [ticketLocationRows, countedLocationRows] = await Promise.all([
      loadPagedSessionRows("general_inventory_locations", "id,location_code,zone,is_active", selectedSession.id, "location_code"),
      loadPagedSessionRows("general_inventory_counts", "product_id,sku,location_id,location_code", selectedSession.id, "sku"),
    ]);
    const activeTicketLocations = ticketLocationRows.filter(row => row.is_active !== false);
    const zoneByLocationId = new Map<string, string>();
    const zoneByLocationCode = new Map<string, string>();
    for (const row of activeTicketLocations) {
      const zone = reportZoneForLocation(row.zone, row.location_code || row.ticket);
      const locationId = String(row.id || "").trim();
      const locationCode = normalizeLocationCode(String(row.location_code || row.ticket || ""));
      if (locationId) zoneByLocationId.set(locationId, zone);
      if (locationCode) zoneByLocationCode.set(locationCode, zone);
    }
    const zonesByProduct = new Map<string, Set<string>>();
    for (const row of countedLocationRows) {
      const productKey = String(row.product_id || normalizeCode(row.sku || "")).trim().toUpperCase();
      if (!productKey) continue;
      const locationId = String(row.location_id || "").trim();
      const locationCode = normalizeLocationCode(String(row.location_code || ""));
      const zone = (locationId && zoneByLocationId.get(locationId)) || (locationCode && zoneByLocationCode.get(locationCode)) || "ALMACEN";
      const zones = zonesByProduct.get(productKey) || new Set<string>();
      zones.add(zone);
      zonesByProduct.set(productKey, zones);
    }
    const zoneBySummaryProduct = new Map<string, string>();
    for (const row of summary) {
      const productKey = String(row.product_id || normalizeCode(row.sku || "")).trim().toUpperCase();
      const zones = zonesByProduct.get(productKey) || new Set<string>(["ALMACEN"]);
      zonesByProduct.set(productKey, zones);
      const zone = zones.size === 0
        ? "ALMACEN"
        : [...zones].some(isExhibitedZone)
          ? "TIENDA"
          : zones.size === 1
            ? [...zones][0]
            : "MULTIPLES ZONAS";
      zoneBySummaryProduct.set(productKey, zone);
    }
    const zoneCounts = new Map<string, number>();
    for (const zone of zoneBySummaryProduct.values()) zoneCounts.set(zone, (zoneCounts.get(zone) || 0) + 1);
    const zoneRows: ZoneCountRow[] = [...zoneCounts.entries()]
      .map(([name, codes]) => ({ name, codes, percentage: summary.length > 0 ? (codes / summary.length) * 100 : 0 }))
      .sort((a, b) => b.codes - a.codes || a.name.localeCompare(b.name));
    // Use the same summarized code population shown in the zone table. Count rows
    // that exist only in the location records but not in the inventory summary
    // separately, so the KPI and table never use different denominators.
    const summarizedZones = [...zoneBySummaryProduct.values()];
    const codesExhibited = summarizedZones.filter(isExhibitedZone).length;
    const codesNotExhibited = summarizedZones.filter(zone => !isExhibitedZone(zone)).length;
    const codesWithKnownZone = summarizedZones.length;
    const zoneTableRows = zoneRows.map(row => `
      <tr>
        <td>${escapeHtml(row.name)}</td>
        <td class="num">${number2(row.codes)}</td>
        <td class="num">${row.percentage.toFixed(2)}%</td>
      </tr>
    `).join("");
    const topOutsideStoreRows = summary
      .map(row => {
        const productKey = String(row.product_id || normalizeCode(row.sku || "")).trim().toUpperCase();
        return {
          row,
          zone: zoneBySummaryProduct.get(productKey) || "ALMACEN",
          hasKnownZone: zonesByProduct.has(productKey),
          isExhibited: [...(zonesByProduct.get(productKey) || new Set<string>())].some(isExhibitedZone),
          inventoryValue: Number(row.counted || 0) * Number(row.cost || 0),
        };
      })
      .filter(item => item.hasKnownZone && !item.isExhibited)
      .sort((a, b) => b.inventoryValue - a.inventoryValue || a.row.sku.localeCompare(b.row.sku))
      .slice(0, 20);
    const topOutsideStoreTableRows = topOutsideStoreRows.map(item => `
      <tr>
        <td>${escapeHtml(item.row.sku)}</td>
        <td class="oneLine">${escapeHtml(item.row.description)}</td>
        <td>${escapeHtml(item.zone)}</td>
        <td>${escapeHtml(item.row.unit || "-")}</td>
        <td class="num">${number2(item.row.counted)}</td>
        <td class="num">${money(item.row.cost)}</td>
        <td class="num warn">${money(item.inventoryValue)}</td>
      </tr>
    `).join("");

    type GroupRow = {
      name: string;
      total: number;
      counted: number;
      ok: number;
      surplus: number;
      missing: number;
      systemValue: number;
      countedValue: number;
      surplusValue: number;
      missingValue: number;
    };
    const emptyGroup = (name: string): GroupRow => ({
      name,
      total: 0,
      counted: 0,
      ok: 0,
      surplus: 0,
      missing: 0,
      systemValue: 0,
      countedValue: 0,
      surplusValue: 0,
      missingValue: 0,
    });
    const aggregateBy = (field: "department" | "brand" | "rotation_category") => {
      const groups = new Map<string, GroupRow>();
      for (const row of summary) {
        const fallback = field === "rotation_category" ? "SIN ROTACION" : "SIN CLASIFICAR";
        const name = String(row[field] || fallback).trim() || fallback;
        const group = groups.get(name) || emptyGroup(name);
        group.total += 1;
        if (row.counted > 0) group.counted += 1;
        if (row.counted > 0 && row.diff === 0) group.ok += 1;
        if (row.diff > 0) {
          group.surplus += 1;
          group.surplusValue += row.valueDiff;
        }
        if (row.diff < 0) {
          group.missing += 1;
          group.missingValue += row.valueDiff;
        }
        group.systemValue += row.system_stock * row.cost;
        group.countedValue += row.counted * row.cost;
        groups.set(name, group);
      }
      return [...groups.values()].sort((a, b) =>
        Math.abs(b.missingValue) + Math.abs(b.surplusValue) - (Math.abs(a.missingValue) + Math.abs(a.surplusValue)) ||
        a.name.localeCompare(b.name)
      );
    };
    const pct = (value: number, total: number) => total > 0 ? Math.round((value / total) * 100) : 0;
    const valueProgress = (row: GroupRow) => row.systemValue > 0 ? Math.round((row.countedValue / row.systemValue) * 100) : 0;
    const deptRows = aggregateBy("department");
    const rotationRows = aggregateBy("rotation_category");
    const totalCodes = summary.length;
    const nonExhibitedCategoryCounts = new Map<string, number>();
    for (const row of summary) {
      const productKey = String(row.product_id || normalizeCode(row.sku || "")).trim().toUpperCase();
      const zones = zonesByProduct.get(productKey) || new Set<string>(["ALMACEN"]);
      if ([...zones].some(isExhibitedZone)) continue;
      const category = String(row.department || "SIN CATEGORIA").trim() || "SIN CATEGORIA";
      nonExhibitedCategoryCounts.set(category, (nonExhibitedCategoryCounts.get(category) || 0) + 1);
    }
    const nonExhibitedCategoryRows = [...nonExhibitedCategoryCounts.entries()]
      .map(([category, codes]) => ({ category, codes, percentage: totalCodes > 0 ? (codes / totalCodes) * 100 : 0 }))
      .sort((a, b) => b.codes - a.codes || a.category.localeCompare(b.category));
    const nonExhibitedCategoryTableRows = nonExhibitedCategoryRows.map(row => `
      <tr>
        <td>${escapeHtml(row.category)}</td>
        <td class="num">${number2(row.codes)}</td>
        <td class="num">${row.percentage.toFixed(2)}%</td>
      </tr>
    `).join("");
    const totalDiffCodes = summary.filter(row => row.diff !== 0).length;
    const originallyCountedCodes = summary.filter(row => row.counted_original > 0).length;
    const recountedCodes = summary.filter(row => row.diff !== 0 && row.recount_status === "counted").length;
    const validatedCodes = summary.filter(row => row.diff !== 0 && row.validation_status === "counted").length;
    const generatedAt = new Date().toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });
    const reportStartDate = dateOnly(selectedSession.scheduled_date || selectedSession.created_at);
    const reportEndDate = selectedSession.finished_at ? dateOnly(selectedSession.finished_at) : "En curso";
    const logoUrl = `${window.location.origin}/icon.png`;
    const donut = (label: string, value: number, color: string, detail: string) => `
      <td style="padding:4px;width:33.33%;vertical-align:top;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;border-collapse:separate;">
          <tr>
            <td style="padding:10px 12px;">
              <div style="font-size:24px;line-height:1;font-weight:900;color:${color};">${Math.round(value)}%</div>
              <div style="font-size:11px;font-weight:900;color:#0f172a;margin-top:5px;">${escapeHtml(label)}</div>
              <div style="font-size:10px;color:#64748b;margin-top:3px;">${escapeHtml(detail)}</div>
              <div style="height:9px;background:#e2e8f0;border-radius:999px;overflow:hidden;margin-top:9px;">
                <div style="height:9px;width:${Math.max(2, Math.min(100, Math.round(value)))}%;background:${color};border-radius:999px;"></div>
              </div>
            </td>
          </tr>
        </table>
      </td>`;
    const tableRows = (rows: GroupRow[]) => rows.map(row => `
      <tr>
        <td>${escapeHtml(row.name)}</td>
        <td class="num">${number2(row.total)}</td>
        <td class="num">${number2(row.counted)}</td>
        <td class="num ok">${number2(row.ok)}</td>
        <td class="num bad">${number2(row.missing)}</td>
        <td class="num warn">${number2(row.surplus)}</td>
        <td class="num">${pct(row.ok, row.total)}%</td>
        <td class="num">${valueProgress(row)}%</td>
        <td class="num bad">${money(row.missingValue)}</td>
        <td class="num warn">${money(row.surplusValue)}</td>
      </tr>
    `).join("");
    const horizontalBar = (label: string, value: number, max: number, color: string, formatted: string) => {
      const width = max > 0 ? Math.max(4, Math.round((Math.abs(value) / max) * 100)) : 0;
      return `
        <tr>
          <td style="width:88px;padding:6px 0;font-weight:800;color:#334155;">${escapeHtml(label)}</td>
          <td style="padding:6px 8px;">
            <div style="height:12px;background:#e2e8f0;border-radius:999px;overflow:hidden;">
              <div style="height:12px;width:${width}%;background:${color};border-radius:999px;"></div>
            </div>
          </td>
          <td style="width:110px;padding:6px 0;text-align:right;font-weight:900;color:${color};white-space:nowrap;">${escapeHtml(formatted)}</td>
        </tr>
      `;
    };
    const maxCodeDiff = Math.max(kpis.missingCodes, kpis.surplusCodes, 1);
    const maxValueDiff = Math.max(Math.abs(kpis.missingValue), Math.abs(kpis.surplusValue), 1);
    const metricCard = (label: string, value: string | number, cls = "") => `
      <td style="padding:4px;vertical-align:top;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;border-collapse:separate;">
          <tr><td style="padding:9px 6px;text-align:center;">
            <div style="font-size:17px;font-weight:900;line-height:1.1;color:${cls === "bad" ? "#b91c1c" : cls === "warn" ? "#1d4ed8" : cls === "ok" ? "#15803d" : "#0f172a"};">${escapeHtml(String(value))}</div>
            <div style="color:#64748b;font-size:8.5px;font-weight:800;margin-top:3px;text-transform:uppercase;">${escapeHtml(label)}</div>
          </td></tr>
        </table>
      </td>
    `;
    const topMissingRows = summary
      .filter(row => row.diff < 0)
      .sort((a, b) => a.valueDiff - b.valueDiff)
      .slice(0, 20);
    const topSurplusRows = summary
      .filter(row => row.diff > 0)
      .sort((a, b) => b.valueDiff - a.valueDiff)
      .slice(0, 20);
    const topSkuRows = (rows: SummaryRow[]) => rows.map(row => `
      <tr>
        <td>${escapeHtml(row.sku)}</td>
        <td class="oneLine">${escapeHtml(row.description)}</td>
        <td>${escapeHtml(row.unit)}</td>
        <td>${escapeHtml(row.department || "SIN CLASIFICAR")}</td>
        <td>${escapeHtml(row.rotation_category || "SIN ROTACION")}</td>
        <td class="num">${number2(row.system_stock)}</td>
        <td class="num">${number2(row.counted)}</td>
        <td class="num ${row.diff < 0 ? "bad" : "warn"}">${number2(row.diff)}</td>
        <td class="num ${row.valueDiff < 0 ? "bad" : "warn"}">${money(row.valueDiff)}</td>
      </tr>
    `).join("");
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Reporte IG - ${escapeHtml(selectedSession.name)}</title>
  <style>
    @page { size: A4 landscape; margin: 8mm; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f1f5f9; color: #0f172a; font-family: Arial, sans-serif; font-size: 10px; }
    .shell { max-width: 1180px; margin: 0 auto; background: #ffffff; }
    h1 { margin: 0; font-size: 21px; color: #ffffff; }
    h2 { margin: 12px 0 7px; font-size: 12px; border-left: 3px solid #1d4ed8; padding-left: 9px; text-transform: uppercase; letter-spacing: .3px; }
    .muted { color: #64748b; }
    .header { display: flex; justify-content: space-between; gap: 14px; padding: 24px 28px 22px; background: linear-gradient(135deg,#0f172a 0%,#1e3a5f 60%,#1d4ed8 100%); }
    .header .muted { color: #bfdbfe; }
    .meta { text-align: right; line-height: 1.45; color: #dbeafe; }
    .content { padding: 18px 28px 24px; }
    .donuts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 8px 0; }
    .donutCard { display: flex; align-items: center; gap: 9px; border: 1px solid #cbd5e1; border-radius: 7px; padding: 7px; background: #f8fafc; }
    .donutCard strong { display: block; font-size: 11px; }
    .donutCard span { display: block; color: #64748b; margin-top: 2px; }
    .metricGrid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 7px; margin: 8px 0 12px; }
    .metricCard { border: 1px solid #cbd5e1; border-radius: 8px; background: #f8fafc; padding: 8px 6px; text-align: center; }
    .metricValue { font-size: 16px; font-weight: 900; color: #0f172a; line-height: 1.1; }
    .metricLabel { color: #64748b; font-size: 8.5px; font-weight: 800; margin-top: 3px; text-transform: uppercase; }
    .chartGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 9px 0 12px; }
    .chartBox { border: 1px solid #cbd5e1; border-radius: 8px; background: #f8fafc; padding: 10px; }
    .chartTitle { margin: 0 0 8px; color: #0f172a; font-weight: 900; font-size: 11px; text-transform: uppercase; }
    .barRow { display: grid; grid-template-columns: 88px 1fr 98px; gap: 8px; align-items: center; margin: 7px 0; }
    .barLabel { font-weight: 800; color: #334155; }
    .barTrack { height: 12px; background: #e2e8f0; border-radius: 999px; overflow: hidden; }
    .barTrack span { display: block; height: 100%; border-radius: 999px; }
    .barValue { text-align: right; font-weight: 900; white-space: nowrap; }
    .grid2 { display: grid; grid-template-columns: 1fr 0.75fr; gap: 10px; }
    .stack { display: grid; grid-template-columns: 1fr; gap: 10px; }
    .topTable th:nth-child(1), .topTable td:nth-child(1) { width: 78px; }
    .topTable th:nth-child(2), .topTable td:nth-child(2) { width: auto; max-width: 340px; }
    .topTable th:nth-child(3), .topTable td:nth-child(3) { width: 42px; }
    .topTable th:nth-child(4), .topTable td:nth-child(4) { width: 105px; }
    .topTable th:nth-child(5), .topTable td:nth-child(5) { width: 48px; }
    .topTable th:nth-child(6), .topTable td:nth-child(6),
    .topTable th:nth-child(7), .topTable td:nth-child(7),
    .topTable th:nth-child(8), .topTable td:nth-child(8),
    .topTable th:nth-child(9), .topTable td:nth-child(9) { width: 72px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #cbd5e1; padding: 3px 4px; vertical-align: middle; }
    th { background: #f1f5f9; font-size: 9px; text-align: left; }
    .oneLine { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .num { text-align: right; white-space: nowrap; }
    .ok { color: #15803d; font-weight: 800; }
    .bad { color: #b91c1c; font-weight: 800; }
    .warn { color: #1d4ed8; font-weight: 800; }
    .pageBreak { break-before: page; }
    .noteBox { margin: 12px 0; border: 1px solid #fde68a; background: #fffbeb; color: #92400e; border-radius: 9px; padding: 10px 12px; line-height: 1.55; }
    .footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 10px 28px; text-align: center; color: #94a3b8; }
    .analystSign { margin-top: 16px; border-top: 1px solid #e2e8f0; padding-top: 13px; color: #475569; font-size: 12px; line-height: 1.6; }
    @media print { .donuts, .grid2 { break-inside: avoid; } }
  </style>
</head>
<body>
<div class="shell">
  <div class="header">
    <div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        <img src="${escapeHtml(logoUrl)}" width="38" height="38" style="display:block;border-radius:10px;background:#ffffff;" alt="RASECORP"/>
        <div>
          <div style="font-size:12px;font-weight:900;color:#93c5fd;letter-spacing:1.4px;">RASECORP</div>
          <div style="font-size:10px;color:#64748b;letter-spacing:1px;">AUDITORIA Y CONTROL DE INVENTARIOS</div>
        </div>
      </div>
      <h1>Reporte IG</h1>
      <div class="muted">Inventario: <strong>${escapeHtml(selectedSession.name)}</strong></div>
      <div class="muted">Tienda: <strong>${escapeHtml(selectedSession.store_name || selectedSession.store_id)}</strong></div>
      <div class="muted">Fecha: <strong>${escapeHtml(reportStartDate || "-")} - ${escapeHtml(reportEndDate)}</strong></div>
    </div>
    <div class="meta">
      <div>Estado: <strong>${escapeHtml(statusLabel(selectedSession.status))}</strong></div>
      <div>Generado: <strong>${escapeHtml(generatedAt)}</strong></div>
    </div>
  </div>

  <div class="content">
  <p style="margin:0 0 12px;font-size:12px;color:#334155;line-height:1.55;">
    Estimado equipo,<br>
    A continuacion el resumen ejecutivo del inventario general. Revisar los resultados por rotacion y categorias para priorizar acciones correctivas.
  </p>

  <table width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;border-collapse:collapse;">
    <tr>
    ${donut("ERI", kpis.eri, "#16a34a", `${summary.filter(row => row.diff === 0 && row.counted > 0).length} OK / ${kpis.totalCodes} codigos`)}
    ${donut("AVANCE POR SKU", kpis.skuProgress, "#0f172a", `${kpis.countedCodes} / ${kpis.totalCodes} codigos`)}
    ${donut("AVANCE POR VALORIZADO", kpis.valueProgress, "#1d4ed8", `${money(kpis.countedValue)} de ${money(kpis.systemValue)}`)}
    </tr>
  </table>

  <h2>Control de avance operativo</h2>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;border-collapse:collapse;">
    <tr>
    ${donut("CODIGOS CONTADOS", pct(originallyCountedCodes, totalCodes), "#0f172a", `${number2(originallyCountedCodes)} / ${number2(totalCodes)} codigos`)}
    ${donut("CODIGOS RECONTADOS", pct(recountedCodes, totalDiffCodes), "#7c3aed", `${number2(recountedCodes)} / ${number2(totalDiffCodes)} codigos con diferencia`)}
    ${donut("CODIGOS VALIDADOS", pct(validatedCodes, totalDiffCodes), "#15803d", `${number2(validatedCodes)} / ${number2(totalDiffCodes)} codigos con diferencia`)}
    </tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 12px;border-collapse:collapse;">
    <tr>
      <td style="padding:4px;width:50%;vertical-align:top;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;border-collapse:separate;">
          <tr><td style="padding:10px;">
            <div style="margin:0 0 8px;color:#0f172a;font-weight:900;font-size:11px;text-transform:uppercase;">Faltantes y sobrantes por codigo</div>
            <table width="100%" cellpadding="0" cellspacing="0">${horizontalBar("Faltantes", kpis.missingCodes, maxCodeDiff, "#dc2626", number2(kpis.missingCodes))}${horizontalBar("Sobrantes", kpis.surplusCodes, maxCodeDiff, "#1d4ed8", number2(kpis.surplusCodes))}</table>
          </td></tr>
        </table>
      </td>
      <td style="padding:4px;width:50%;vertical-align:top;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;border-collapse:separate;">
          <tr><td style="padding:10px;">
            <div style="margin:0 0 8px;color:#0f172a;font-weight:900;font-size:11px;text-transform:uppercase;">Faltantes y sobrantes valorizados</div>
            <table width="100%" cellpadding="0" cellspacing="0">${horizontalBar("Faltantes", kpis.missingValue, maxValueDiff, "#dc2626", money(kpis.missingValue))}${horizontalBar("Sobrantes", kpis.surplusValue, maxValueDiff, "#1d4ed8", money(kpis.surplusValue))}</table>
          </td></tr>
        </table>
      </td>
    </tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 12px;border-collapse:collapse;">
    <tr>
    ${metricCard("Codigos totales", number2(kpis.totalCodes))}
    ${metricCard("Codigos contados", number2(kpis.countedCodes), "ok")}
    ${metricCard("Codigos OK", number2(kpis.okCodes), "ok")}
    ${metricCard("Codigos faltantes", number2(kpis.missingCodes), "bad")}
    ${metricCard("Codigos sobrantes", number2(kpis.surplusCodes), "warn")}
    ${metricCard("Codigos no contados", number2(kpis.notCountedCodes))}
    </tr>
    <tr>
      <td colspan="6" style="padding:4px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #cbd5e1;border-radius:8px;background:#fff7ed;border-collapse:separate;">
          <tr><td style="padding:10px 12px;text-align:center;">
            <div style="font-size:20px;font-weight:900;color:${kpis.diffValue < 0 ? "#b91c1c" : kpis.diffValue > 0 ? "#1d4ed8" : "#15803d"};">${money(kpis.diffValue)}</div>
            <div style="font-size:9px;color:#64748b;font-weight:900;text-transform:uppercase;">Diferencia total valorizada</div>
          </td></tr>
        </table>
      </td>
    </tr>
  </table>

  <div class="stack">
    <div>
      <h2>Top 20 faltantes</h2>
      <table class="topTable">
        <thead><tr><th>Codigo</th><th>Descripcion</th><th>UM</th><th>Cat.</th><th>Rot.</th><th class="num">Sistema</th><th class="num">Conteo</th><th class="num">Dif.</th><th class="num">Dif. val.</th></tr></thead>
        <tbody>${topSkuRows(topMissingRows)}</tbody>
      </table>
    </div>
    <div>
      <h2>Top 20 sobrantes</h2>
      <table class="topTable">
        <thead><tr><th>Codigo</th><th>Descripcion</th><th>UM</th><th>Cat.</th><th>Rot.</th><th class="num">Sistema</th><th class="num">Conteo</th><th class="num">Dif.</th><th class="num">Dif. val.</th></tr></thead>
        <tbody>${topSkuRows(topSurplusRows)}</tbody>
      </table>
    </div>
  </div>

  <div class="noteBox">
    <strong>Acciones sugeridas:</strong> priorizar revision de los top faltantes valorizados, validar sobrantes de mayor impacto y cruzar las diferencias por rotacion para enfocar la investigacion.
  </div>

  <h2 class="pageBreak">Detalle por rotacion</h2>
  <table>
    <thead><tr><th>Rotacion</th><th class="num">Codigos</th><th class="num">Contados</th><th class="num">OK</th><th class="num">Falt.</th><th class="num">Sobr.</th><th class="num">ERI</th><th class="num">Av. val.</th><th class="num">Faltante S/</th><th class="num">Sobrante S/</th></tr></thead>
    <tbody>${tableRows(rotationRows)}</tbody>
  </table>

  <h2>Detalle por categorias</h2>
  <table>
    <thead><tr><th>Categoria</th><th class="num">Codigos</th><th class="num">Contados</th><th class="num">OK</th><th class="num">Falt.</th><th class="num">Sobr.</th><th class="num">ERI</th><th class="num">Av. val.</th><th class="num">Faltante S/</th><th class="num">Sobrante S/</th></tr></thead>
    <tbody>${tableRows(deptRows)}</tbody>
  </table>

  <h2>Distribucion de codigos exhibidos y no exhibidos</h2>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;border-collapse:collapse;">
    <tr>
    ${metricCard("Codigos exhibidos", number2(codesExhibited), "ok")}
    ${metricCard("% codigos exhibidos", `${(codesWithKnownZone > 0 ? (codesExhibited / codesWithKnownZone) * 100 : 0).toFixed(2)}%`, "ok")}
    ${metricCard("Codigos no exhibidos", number2(codesNotExhibited), codesNotExhibited > 0 ? "bad" : "ok")}
    ${metricCard("% codigos no exhibidos", `${(codesWithKnownZone > 0 ? (codesNotExhibited / codesWithKnownZone) * 100 : 0).toFixed(2)}%`, codesNotExhibited > 0 ? "bad" : "ok")}
    </tr>
  </table>
  <table>
    <thead><tr><th>Zona</th><th class="num">Codigos</th><th class="num">% del total de codigos</th></tr></thead>
    <tbody>${zoneTableRows}</tbody>
  </table>

  <h2>Categorias no exhibidas</h2>
  <table>
    <thead><tr><th>Categoria</th><th class="num">Codigos no exhibidos</th><th class="num">% del total de codigos</th></tr></thead>
    <tbody>${nonExhibitedCategoryTableRows || `<tr><td colspan="3" class="muted">No hay categorias con codigos no exhibidos.</td></tr>`}</tbody>
  </table>

  <h2>Top 20 codigos no exhibidos por valorizado contado</h2>
  <p class="muted" style="margin:0 0 7px;line-height:1.45;">Ordenado de mayor a menor por valorizado contado: costo unitario multiplicado por la cantidad sumada del inventario.</p>
  <table>
    <thead><tr><th style="width:78px">Codigo</th><th>Descripcion</th><th style="width:90px">Zona</th><th style="width:62px">Unidad</th><th class="num" style="width:62px">Contado</th><th class="num" style="width:62px">Costo</th><th class="num" style="width:85px">Valorizado contado</th></tr></thead>
    <tbody>${topOutsideStoreTableRows || `<tr><td colspan="7" class="muted">No hay codigos fuera de TIENDA.</td></tr>`}</tbody>
  </table>
  <div class="analystSign">
    Atentamente,<br>
    <strong style="color:#0f172a;">Analista de Inventarios</strong><br>
    <span style="color:#94a3b8;">Area de Auditoria y Control de Inventarios</span>
  </div>
  </div>
  <div class="footer">Generado automaticamente por el Sistema de Inventarios Generales</div>
</div>
</body>
</html>`;

    reportWindow.document.open();
    reportWindow.document.write(html);
    reportWindow.document.close();
    reportWindow.focus();
  }

  async function saveInventoryNotes() {
    if (!ensureSelectedSessionEditable()) return;
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
        <td class="num">${summaryRecountLabel(row)}</td>
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
      .select("id,recount_item_id,operator_id,location_id,location_code,sku,description,unit,quantity,cost_snapshot,counted_at,updated_at,general_inventory_operators(id,full_name,phone)")
      .eq("session_id", selectedSessionId)
      .order("operator_id", { ascending: true })
      .order("updated_at", { ascending: false, nullsFirst: false })
      .order("counted_at", { ascending: false });
    if (recountPrintOperatorId) query = query.eq("operator_id", recountPrintOperatorId);
    const { data, error } = await query;

    if (error) {
      setMessage("No se pudieron leer los reconteos guardados: " + error.message);
      return;
    }

    const recountCountRows = (data || []) as any[];
    const itemById = new Map(recountItems.map(row => [row.id, row]));
    const recountProductIds = [...new Set([
      ...recountCountRows.map(row => String(row.product_id || "")).filter(Boolean),
      ...recountCountRows.map(row => itemById.get(String(row.recount_item_id))?.product_id || "").filter(Boolean),
    ])];
    const originalByLocation = await loadOriginalCountedByProductLocation(selectedSessionId, recountProductIds);
    const locationById = new Map(locations.map(row => [row.id, row]));
    const documentRows = recountCountRows
      .map((countRow: any) => {
        const item = itemById.get(String(countRow.recount_item_id));
        if (!item) return null;
        const locationId = String(countRow.location_id || "");
        const locationCode = normalizeLocationCode(countRow.location_code);
        const productIdsToCheck = [...new Set([String(countRow.product_id || ""), item.product_id].filter(Boolean))];
        const skusToCheck = [...new Set([String(countRow.sku || ""), item.sku].map(sku => normalizeCode(sku).toUpperCase()).filter(Boolean))];
        let originalQuantity = 0;
        for (const productId of productIdsToCheck) {
          const byId = locationId ? originalByLocation.get(`${productId}__id__${locationId}`) : undefined;
          const byCode = locationCode ? originalByLocation.get(`${productId}__code__${locationCode}`) : undefined;
          if (byId !== undefined || byCode !== undefined) {
            originalQuantity = byId ?? byCode ?? 0;
            break;
          }
        }
        if (originalQuantity === 0) {
          for (const sku of skusToCheck) {
            const byId = locationId ? originalByLocation.get(`sku__${sku}__id__${locationId}`) : undefined;
            const byCode = locationCode ? originalByLocation.get(`sku__${sku}__code__${locationCode}`) : undefined;
            if (byId !== undefined || byCode !== undefined) {
              originalQuantity = byId ?? byCode ?? 0;
              break;
            }
          }
        }
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
          recount_original_quantity: originalQuantity,
          recount_counted_at: String(countRow.counted_at || ""),
          recount_updated_at: String(countRow.updated_at || countRow.counted_at || ""),
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
        new Date(b.recount_updated_at || b.recount_counted_at || 0).getTime() - new Date(a.recount_updated_at || a.recount_counted_at || 0).getTime()
      );
      const recountDate = (orderedRows[0]?.recount_updated_at || orderedRows[0]?.recount_counted_at)
        ? new Date(orderedRows[0].recount_updated_at || orderedRows[0].recount_counted_at).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" })
        : generatedAt;
      const rowsHtml = orderedRows.map((row, rowIndex) => `
        <tr>
          <td class="num">${rowIndex + 1}</td>
          <td class="num">${(row.recount_updated_at || row.recount_counted_at) ? escapeHtml(new Date(row.recount_updated_at || row.recount_counted_at).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", hour12: false })) : "-"}</td>
          <td>${escapeHtml(row.full_location || row.location_code || "Por codigo")}</td>
          <td>${escapeHtml(row.sku)}</td>
          <td>${escapeHtml(row.description)}</td>
          <td>${escapeHtml(row.unit)}</td>
          <td class="num">${number2(row.system_stock)}</td>
          <td class="num">${number2(row.recount_original_quantity)}</td>
          <td class="num">${number2(row.recount_quantity)}</td>
          <td class="num ${row.diff_qty < 0 ? "bad" : row.diff_qty > 0 ? "warn" : ""}">${number2(row.diff_qty)}</td>
          <td class="num ${row.value_diff < 0 ? "bad" : row.value_diff > 0 ? "warn" : ""}">${money(row.value_diff)}</td>
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
                <th style="width:44px" class="num">Stock</th>
                <th style="width:50px" class="num">Conteo</th>
                <th style="width:56px" class="num">Reconteo</th>
                <th style="width:48px" class="num">Dif. und</th>
                <th style="width:64px" class="num">Dif. valorizada</th>
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
    .bad { color: #dc2626; font-weight: 800; }
    .warn { color: #2563eb; font-weight: 800; }
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
    if (selectedSession?.manual_recount_enabled) {
      setMessage("Esta sesion usa reconteo manual impreso. Los reconteos no se muestran en la app del operario.");
      return;
    }
    setOperatorMode("reconteo");
    localStorage.setItem(OPERATOR_MODE_KEY, "reconteo");
    if (selectedSessionId && operator) await loadOperatorRecountItems(selectedSessionId, operator.id);
  }

  function openOperatorCountMode() {
    setOperatorMode("conteo");
    localStorage.setItem(OPERATOR_MODE_KEY, "conteo");
  }

  function openOperatorLookupMode() {
    setOperatorMode("consulta");
    localStorage.setItem(OPERATOR_MODE_KEY, "consulta");
    setProductCandidates([]);
    setProductLookupMessage("");
    setSelectedProduct(null);
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
            disabled={savingManualLocation || !selectedSessionId || isSelectedSessionFinished}
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

  if (moduleDisabled) return <ModuleDisabledScreen moduleLabel="Inventarios" />;

  return (
    <main className="min-h-screen overflow-x-hidden bg-slate-100 text-slate-900">
      <InventoryHeader
        user={user}
        operator={operator}
        operatorMode={operatorMode}
        selectedSession={selectedSession}
        isMobileAccess={isMobileAccess}
        onBack={() => operator && !user ? (operatorMode === "reconteo" || operatorMode === "consulta" ? openOperatorCountMode() : logoutOperator()) : window.location.href = "/"}
        onRefresh={refreshCurrentView}
        onGoModule={goModule}
        onLogin={goLogin}
        onOpenOperatorCountMode={openOperatorCountMode}
        onOpenOperatorLookupMode={openOperatorLookupMode}
        onOpenOperatorRecountMode={openOperatorRecountMode}
      />

      <div className={`mx-auto grid w-full min-w-0 ${isOperatorView ? "max-w-2xl gap-2 px-2 py-2" : "max-w-[1800px] gap-4 px-3 py-4"} ${showSidePanel ? "lg:grid-cols-[360px_1fr]" : "lg:grid-cols-1"}`}>
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
                  {stores.filter(s => !!s.erp_sede).map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
                </select>
                <input value={newName} onChange={event => setNewName(event.target.value)} placeholder="Nombre de inventario" className="w-full rounded-xl border px-3 py-3 text-sm" />
                <input type="date" value={newDate} onChange={event => setNewDate(event.target.value)} className="w-full rounded-xl border px-3 py-3 text-sm" />
                <button onClick={createSession} disabled={loading} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                  <Plus size={16} /> {loading ? "Cargando stock..." : "Crear inventario"}
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
                {selectedSession.finished_at && <div>Finalizado: {new Date(selectedSession.finished_at).toLocaleString("es-PE")}{selectedSession.finished_by_name ? ` por ${selectedSession.finished_by_name}` : ""}</div>}
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
                <button onClick={registerOperator} disabled={!selectedSessionId || !selectedSession || !canOperatorEnter(selectedSession.status)} className="w-full rounded-xl bg-orange-600 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                  Entrar al inventario
                </button>
              </div>
            </section>
          )}

          {canManageInventory && selectedSessionId && (
            <section className="space-y-3 rounded-2xl border bg-white p-4 shadow-sm">
              <h2 className="font-black">Preparación</h2>
              <div>
                <label className="text-xs font-bold text-slate-500">Control de tickets / ubicaciones (también después de finalizar)</label>
                <input
                  ref={locationsFileRef}
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={event => void handleLocationsFileChange(event.target.files?.[0] || null)}
                />
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <button onClick={() => locationsFileRef.current?.click()} className="inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-black">
                    <FolderOpen size={16} /> {locationsFile ? locationsFile.name : "Seleccionar Excel"}
                  </button>
                  <button onClick={importLocations} disabled={!locationsFile || !locationsFileBuffer || importingLocations} className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                    {importingLocations ? "Subiendo..." : "Subir ubicaciones"}
                  </button>
                </div>
                <button
                  onClick={toggleLocationLock}
                  disabled={!selectedSessionId || isSelectedSessionFinished}
                  className={`mt-3 w-full rounded-xl border px-4 py-3 text-sm font-black disabled:opacity-40 ${selectedSession?.location_lock_enabled ? "border-green-200 bg-green-50 text-green-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}
                >
                  Seguro de ubicaciones: {selectedSession?.location_lock_enabled ? "Activo" : "Libre"}
                </button>
              </div>
              {renderManualLocationForm()}
              <div className="rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-800">
                Los no inventariables se toman automaticamente desde la base de datos global.
              </div>
              <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
                <div className="font-black text-slate-900">Ubicaciones</div>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                  <div>Total: {locations.length} | Pendientes: {pendingLocations.length}</div>
                  <select
                    value={pendingLocationSortDirection}
                    onChange={event => setPendingLocationSortDirection(event.target.value as SortDirection)}
                    className="rounded-lg border bg-white px-2 py-1 text-xs font-black text-slate-700"
                    aria-label="Ordenar ubicaciones pendientes"
                  >
                    <option value="asc">Menor a mayor</option>
                    <option value="desc">Mayor a menor</option>
                  </select>
                </div>
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
              {selectedSession?.status === "frozen" && !isSelectedSessionFinished && canManageInventory && (
                <button onClick={unfreezeSession} disabled={loading} className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-orange-300 bg-orange-50 px-4 py-3 text-sm font-black text-orange-700 disabled:opacity-40">
                  <LockOpen size={16} /> Descongelar stock
                </button>
              )}
              <button onClick={finishSession} disabled={isSelectedSessionFinished} className="w-full rounded-xl bg-green-700 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                Finalizar inventario
              </button>
              {canAdminReopenSelectedSession && (
                <button onClick={unfinishSession} className="w-full rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-black text-amber-800">
                  Desfinalizar sesion
                </button>
              )}
              {user?.role === "Administrador" && (
                <button onClick={deleteSession} className="w-full rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm font-black text-red-700">
                  Cancelar sesion
                </button>
              )}
            </section>
          )}
        </aside>
        )}

        <section className="min-w-0 space-y-4">
          {message && <div className="rounded-2xl border bg-white px-4 py-3 text-sm font-bold text-slate-700 shadow-sm">{message}</div>}
          {isValidator && isSelectedSessionFinished && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800 shadow-sm">
              Sesion finalizada: los datos estan congelados para consulta. Solo un administrador puede desfinalizarla para volver a modificar.
            </div>
          )}
          {operator && !user && selectedSession?.manual_recount_enabled && (
            <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-800 shadow-sm">
              Esta sesion usa reconteo manual impreso. Los reconteos asignados no se muestran en la app.
            </div>
          )}

          {isValidator && (selectedSessionId || user?.role === "Administrador") && (
            <InventoryTabs
              activeTab={validatorTab}
              canManageInventory={canManageInventory}
              isAdmin={user?.role === "Administrador"}
              validationEnabled={Boolean(selectedSession?.validation_enabled)}
              onTabChange={setValidatorTab}
            />
          )}

          {isValidator && user?.role === "Administrador" && validatorTab === "reportes" && (
            <section className="space-y-4 rounded-2xl border bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-black">Reporte de inventarios finalizados</h2>
                  <p className="text-xs text-slate-500">Incluye solo inventarios generales finalizados dentro del rango.</p>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="grid gap-1 text-xs font-black text-slate-500">
                    Desde
                    <input
                      type="date"
                      value={finishedReportFrom}
                      onChange={event => setFinishedReportFrom(event.target.value)}
                      className="rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-900"
                    />
                  </label>
                  <label className="grid gap-1 text-xs font-black text-slate-500">
                    Hasta
                    <input
                      type="date"
                      value={finishedReportTo}
                      onChange={event => setFinishedReportTo(event.target.value)}
                      className="rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-900"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void loadFinishedGeneralInventoryReport()}
                    disabled={finishedReportLoading}
                    className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-black text-white disabled:opacity-40"
                  >
                    {finishedReportLoading ? "Cargando..." : "Generar"}
                  </button>
                  <button
                    type="button"
                    onClick={exportFinishedGeneralInventoryReport}
                    disabled={finishedReportLoading || finishedReportRows.length === 0}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border bg-white px-4 py-2 text-sm font-black text-slate-700 disabled:opacity-40"
                  >
                    <Download size={16} /> Excel
                  </button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                {renderReportKpiCard("Inventarios (cantidad)", number2(finishedReportTotals.inventories), "slate")}
                {renderReportKpiCard(
                  "ERI ponderado",
                  finishedReportTotals.weightedEriPct === null ? "-" : `${number2(finishedReportTotals.weightedEriPct)}%`,
                  finishedReportTotals.weightedEriPct === null ? "slate" : finishedReportTotals.weightedEriPct >= 90 ? "green" : finishedReportTotals.weightedEriPct >= 70 ? "amber" : "red"
                )}
                {renderReportKpiCard(
                  "Sobrantes valorizados",
                  money(finishedReportTotals.surplusValue),
                  "blue"
                )}
                {renderReportKpiCard(
                  "Faltantes valorizados",
                  money(finishedReportTotals.missingValue),
                  "red"
                )}
                {renderReportKpiCard(
                  "Diferencia valorizada",
                  money(finishedReportTotals.netValueDiff),
                  finishedReportTotals.netValueDiff < 0 ? "red" : finishedReportTotals.netValueDiff > 0 ? "blue" : "slate"
                )}
                {renderReportKpiCard(
                  "Desviacion sobre la venta ponderada",
                  finishedReportTotals.weightedDeviationPct === null ? "-" : `${number2(finishedReportTotals.weightedDeviationPct)}%`,
                  finishedReportTotals.weightedDeviationPct === null || finishedReportTotals.weightedDeviationPct === 0
                    ? "slate"
                    : finishedReportTotals.weightedDeviationPct > 0 ? "red" : "blue"
                )}
              </div>

              <div className="overflow-x-auto rounded-2xl border">
                <table className="w-full min-w-[1180px] text-[11px]">
                  <thead className="bg-slate-100 text-slate-600">
                    <tr>
                      <th className="border p-2 text-left">Inventario</th>
                      <th className="border p-2 text-left">Tienda</th>
                      <th className="border p-2 text-left">Finalizado</th>
                      <th className="border p-2 text-left">Finalizado por</th>
                      <th className="border p-2 text-right">Codigos</th>
                      <th className="border p-2 text-right">Contados</th>
                      <th className="border p-2 text-right">OK</th>
                      <th className="border p-2 text-right">No contados</th>
                      <th className="border p-2 text-right">Sobrantes</th>
                      <th className="border p-2 text-right">Faltantes</th>
                      <th className="border p-2 text-right">ERI</th>
                      <th className="border p-2 text-right">Valor sistema</th>
                      <th className="border p-2 text-right">Dif. neta</th>
                      <th className="border p-2 text-right">Dif. abs.</th>
                      <th className="border p-2 text-right">Ventas del periodo</th>
                      <th className="border p-2 text-right">Desviacion sobre la venta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedFinishedReportRows.map(row => (
                      <tr key={row.session_id} className="hover:bg-slate-50">
                        <td className="border p-2 font-black text-slate-900">{row.inventory_name}</td>
                        <td className="border p-2 font-semibold">{row.store_name || "-"}</td>
                        <td className="border p-2">{row.finished_at ? new Date(row.finished_at).toLocaleString("es-PE") : "-"}</td>
                        <td className="border p-2">{row.finished_by_name || "-"}</td>
                        <td className="border p-2 text-right font-bold">{number2(Number(row.total_codes || 0))}</td>
                        <td className="border p-2 text-right font-bold">{number2(Number(row.counted_codes || 0))}</td>
                        <td className="border p-2 text-right font-bold text-green-700">{number2(Number(row.ok_codes || 0))}</td>
                        <td className="border p-2 text-right font-bold">{number2(Number(row.no_counted_codes || 0))}</td>
                        <td className="border p-2 text-right font-bold text-blue-700">{number2(Number(row.surplus_codes || 0))}</td>
                        <td className="border p-2 text-right font-bold text-red-700">{number2(Number(row.missing_codes || 0))}</td>
                        <td className="border p-2 text-right font-black">{number2(Number(row.eri_pct || 0))}%</td>
                        <td className="border p-2 text-right font-black">{money(Number(row.system_value || 0))}</td>
                        <td className={`border p-2 text-right font-black ${Number(row.net_value_diff || 0) < 0 ? "text-red-700" : "text-blue-700"}`}>{money(Number(row.net_value_diff || 0))}</td>
                        <td className="border p-2 text-right font-black">{money(Number(row.abs_value_diff || 0))}</td>
                        <td className="border p-2 text-right font-black">{money(Number(row.sales_in_period || 0))}</td>
                        <td className={`border p-2 text-right font-black ${row.deviation_over_sales_pct !== null && row.deviation_over_sales_pct !== undefined ? (Number(row.deviation_over_sales_pct) > 0 ? "text-red-700" : Number(row.deviation_over_sales_pct) < 0 ? "text-blue-700" : "") : ""}`}>
                          {row.deviation_over_sales_pct === null || row.deviation_over_sales_pct === undefined
                            ? "-"
                            : `${number2(Number(row.deviation_over_sales_pct))}%`}
                        </td>
                      </tr>
                    ))}
                    {finishedReportRows.length === 0 && (
                      <tr>
                        <td colSpan={16} className="p-8 text-center text-sm text-slate-400">
                          Genera el reporte para ver inventarios finalizados.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {finishedReportRows.length > 0 && renderRecountPagination(
                finishedReportRows.length,
                Math.min(finishedReportPage, finishedReportTotalPages),
                finishedReportTotalPages,
                setFinishedReportPage,
                FINISHED_REPORT_PAGE_SIZE
              )}
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
                      {stores.filter(s => !!s.erp_sede).map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
                    </select>
                    <input value={newName} onChange={event => setNewName(event.target.value)} placeholder="Nombre de inventario" className="w-full rounded-xl border px-3 py-3 text-sm" />
                    <input type="date" value={newDate} onChange={event => setNewDate(event.target.value)} className="w-full rounded-xl border px-3 py-3 text-sm" />
                    <button onClick={createSession} disabled={loading} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                      <Plus size={16} /> {loading ? "Cargando stock..." : "Crear inventario"}
                    </button>
                  </div>
                </section>

                <section className="rounded-2xl border bg-white p-4 shadow-sm">
                  <h2 className="mb-3 font-black">Inventario activo</h2>
                  <select
                    value={sessionsStoreFilter}
                    onChange={event => { const v = event.target.value; setSessionsStoreFilter(v); void loadInitial("", v); }}
                    className="mb-2 w-full rounded-xl border bg-white px-3 py-2.5 text-xs font-semibold"
                  >
                    <option value="">Buscar en: todas las tiendas</option>
                    {stores.filter(s => !!s.erp_sede).map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
                  </select>
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
                      {selectedSession.finished_at && <div>Finalizado: {new Date(selectedSession.finished_at).toLocaleString("es-PE")}{selectedSession.finished_by_name ? ` por ${selectedSession.finished_by_name}` : ""}</div>}
                    </div>
                  )}
                </section>

                <section className="space-y-2 rounded-2xl border bg-white p-4 shadow-sm">
                  <h2 className="font-black">Acciones de sesión</h2>
                  {selectedSession?.status === "frozen" && !isSelectedSessionFinished && canManageInventory && (
                    <button onClick={unfreezeSession} disabled={loading} className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-orange-300 bg-orange-50 px-4 py-3 text-sm font-black text-orange-700 disabled:opacity-40">
                      <LockOpen size={16} /> Descongelar stock
                    </button>
                  )}
                  <button onClick={finishSession} disabled={!selectedSessionId || isSelectedSessionFinished} className="w-full rounded-xl bg-green-700 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                    Finalizar inventario
                  </button>
                  {canAdminReopenSelectedSession && (
                    <button onClick={unfinishSession} className="w-full rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-black text-amber-800">
                      Desfinalizar sesion
                    </button>
                  )}
                  {user?.role === "Administrador" && (
                    <button onClick={deleteSession} disabled={!selectedSessionId} className="w-full rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm font-black text-red-700 disabled:opacity-40">
                      Cancelar sesion
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
                    <label className="text-xs font-bold text-slate-500">Control de tickets / ubicaciones (también después de finalizar)</label>
                    <input
                      ref={locationsFileRef}
                      type="file"
                      accept=".xlsx,.xls"
                      className="hidden"
                      onChange={event => void handleLocationsFileChange(event.target.files?.[0] || null)}
                    />
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <button onClick={() => locationsFileRef.current?.click()} className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl border bg-white px-4 py-3 text-sm font-black">
                        <FolderOpen size={16} /> {locationsFile ? locationsFile.name : "Seleccionar Excel"}
                      </button>
                      <button onClick={importLocations} disabled={!locationsFile || !locationsFileBuffer || importingLocations || !selectedSessionId} className="min-h-14 rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                        {importingLocations ? "Subiendo..." : "Subir ubicaciones"}
                      </button>
                    </div>
                    <button
                      onClick={toggleLocationLock}
                      disabled={!selectedSessionId || isSelectedSessionFinished}
                      className={`mt-3 w-full rounded-xl border px-4 py-3 text-sm font-black disabled:opacity-40 ${selectedSession?.location_lock_enabled ? "border-green-200 bg-green-50 text-green-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}
                    >
                      Seguro de ubicaciones: {selectedSession?.location_lock_enabled ? "Activo" : "Libre"}
                    </button>
                    <p className="mt-2 text-xs font-bold text-slate-500">
                      Activo: solo acepta ubicaciones cargadas/registradas. Libre: permite crear ubicaciones al contar o recontar.
                    </p>
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
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-xs font-black text-slate-600">{pendingLocations.length} pendientes | {emptyLocations.length} vacias</div>
                      <select
                        value={pendingLocationSortDirection}
                        onChange={event => setPendingLocationSortDirection(event.target.value as SortDirection)}
                        className="rounded-lg border bg-white px-2 py-1 text-xs font-black text-slate-700"
                        aria-label="Ordenar ubicaciones pendientes"
                      >
                        <option value="asc">Menor a mayor</option>
                        <option value="desc">Mayor a menor</option>
                      </select>
                    </div>
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
                            disabled={savingEmptyLocationId === location.id || isSelectedSessionFinished}
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
                  <input value={locationCode} onChange={event => setLocationCode(normalizeLocationCode(event.target.value))} placeholder="Ubicación / ticket" autoFocus className="min-w-0 flex-1 rounded-lg px-3 py-3 text-base font-black outline-none" />
                  <button onClick={() => openScanner("location")} className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-green-700 text-white transition active:scale-95 active:bg-green-800" title="Escanear ubicación">
                    <QrCode size={22} />
                  </button>
                </div>
                <div className="flex w-full min-w-0 rounded-xl border bg-white p-1 focus-within:ring-2 focus-within:ring-blue-200">
                  <input ref={productInputRef} value={productCode} onChange={event => { setProductLookupMode("typed"); productLookupModeRef.current = "typed"; setProductCode(normalizeProductKeyboardInput(event.target.value)); }} placeholder="Codigo, barra o descripcion" className="min-w-0 flex-1 rounded-lg px-3 py-3 text-base outline-none" />
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

          {operator && !isValidator && operatorMode === "consulta" && (
            <section className="min-w-0 overflow-hidden rounded-2xl border bg-white p-3 shadow-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <h2 className="font-black">Consultar codigo</h2>
                  <p className="text-xs text-slate-500">Busca registros de este inventario por codigo.</p>
                </div>
                <div className="text-xs font-black text-slate-500">{operatorLookupRows.length} resultado(s)</div>
              </div>
              <div className="flex w-full min-w-0 rounded-xl border bg-white p-1 focus-within:ring-2 focus-within:ring-blue-200">
                <input
                  value={operatorLookupCode}
                  onChange={event => setOperatorLookupCode(normalizeProductKeyboardInput(event.target.value))}
                  onKeyDown={event => { if (event.key === "Enter") void searchOperatorCodeRecords(); }}
                  placeholder="Codigo o barra"
                  className="min-w-0 flex-1 rounded-lg px-3 py-3 text-base font-bold outline-none"
                />
                <button onClick={() => openScanner("operator_lookup_product")} className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-slate-900 text-white transition active:scale-95 active:bg-slate-700" title="Escanear codigo">
                  <QrCode size={22} />
                </button>
              </div>
              <button
                onClick={() => void searchOperatorCodeRecords()}
                disabled={operatorLookupLoading || !operatorLookupCode.trim()}
                className="mt-2 w-full rounded-xl bg-blue-700 px-4 py-3 text-sm font-black text-white disabled:opacity-40"
              >
                {operatorLookupLoading ? "Buscando..." : "Buscar registros"}
              </button>
              {operatorLookupMessage && <div className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700">{operatorLookupMessage}</div>}
              {operatorLookupRows.length > 0 && (
                <div className="mt-3 divide-y overflow-hidden rounded-xl border">
                  {operatorLookupRows.map(row => (
                    <div key={row.id} className="p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-black text-blue-700">{row.sku}</span>
                            <span className="font-black text-slate-900">{row.location_code}</span>
                          </div>
                          <div className="whitespace-normal break-words text-sm font-semibold text-slate-700">{row.description}</div>
                          <div className="mt-1 text-xs text-slate-500">{row.operator_name || "Sin contador"} · {new Date(row.counted_at).toLocaleString("es-PE")} · {row.unit}</div>
                        </div>
                        <div className="shrink-0 text-right text-xl font-black text-slate-950">{number2(row.quantity)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {operator && !isValidator && operatorMode === "conteo" && (
            <section className="min-w-0 overflow-hidden rounded-2xl border bg-white shadow-sm">
              <div className="border-b p-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="inline-flex items-center gap-2 font-black"><ClipboardList size={18} /> Registros</h2>
                  <div className="text-right text-xs font-bold text-slate-500">
                    <div>{operatorRecordsLoading ? "Cargando..." : `${number2(operatorRecordsTotal)} registros`}</div>
                    <div>Pagina {operatorRecordsPage} de {operatorRecordsTotalPages}</div>
                  </div>
                </div>
                <div className="mt-2 flex items-center rounded-xl border px-3 py-2">
                  <Search size={16} className="shrink-0 text-slate-400" />
                  <input value={recordsQuery} onChange={event => setRecordsQuery(event.target.value)} placeholder="Buscar codigo, descripcion o ubicacion" className="min-w-0 flex-1 px-2 text-sm outline-none" />
                  {recordsQuery && (
                    <button type="button" onClick={() => setRecordsQuery("")} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Limpiar busqueda">
                      <X size={14} />
                    </button>
                  )}
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-xs font-black text-slate-500">
                  <span>{operatorRecordsTotal === 0 ? "Sin registros para mostrar" : `Mostrando ${number2(operatorRecordsFrom)}-${number2(operatorRecordsTo)}`}</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setOperatorRecordsPage(page => Math.max(1, page - 1))}
                      disabled={operatorRecordsPage <= 1 || operatorRecordsLoading}
                      className="rounded-lg border px-3 py-1.5 text-slate-700 disabled:opacity-40"
                    >
                      Anterior
                    </button>
                    <button
                      type="button"
                      onClick={() => setOperatorRecordsPage(page => Math.min(operatorRecordsTotalPages, page + 1))}
                      disabled={operatorRecordsPage >= operatorRecordsTotalPages || operatorRecordsLoading || operatorRecordsTotal === 0}
                      className="rounded-lg border px-3 py-1.5 text-slate-700 disabled:opacity-40"
                    >
                      Siguiente
                    </button>
                  </div>
                </div>
              </div>
              <div key={recordsRenderKey} className="divide-y">
                {filteredCounts.map(row => (
                  <div key={countRowKey(row)} className="p-3">
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

          {operator && !isValidator && operatorMode === "reconteo" && !selectedSession?.manual_recount_enabled && (
            <section className="min-w-0 overflow-hidden rounded-2xl border bg-white p-4 shadow-sm">
              <div className="mb-3 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="font-black">{selectedSession?.validation_enabled ? "Mis reconteos y validaciones asignadas" : "Mis reconteos asignados"}</h2>
                    <p className="text-xs text-slate-500">{operator.full_name}{selectedSession ? ` · ${selectedSession.name}` : ""}</p>
                  </div>
                  <div className="text-right text-xs font-bold text-slate-500">
                    <div>{recountItems.length} asignados</div>
                    {filteredOperatorRecountItems.length !== recountItems.length && <div>{filteredOperatorRecountItems.length} filtrados</div>}
                  </div>
                </div>
                <div className="flex items-center rounded-xl border px-3 py-2">
                  <Search size={16} className="shrink-0 text-slate-400" />
                  <input
                    value={operatorRecountQuery}
                    onChange={event => setOperatorRecountQuery(event.target.value)}
                    placeholder="Buscar codigo, descripcion o ubicacion"
                    className="min-w-0 flex-1 px-2 text-sm outline-none"
                  />
                  {operatorRecountQuery && (
                    <button type="button" onClick={() => setOperatorRecountQuery("")} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Limpiar busqueda de reconteos">
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {filteredOperatorRecountItems.map(row => {
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
                            <input value={draft.productCode} onChange={event => updateRecountDraft(row.id, "productCode", normalizeProductKeyboardInput(event.target.value))} placeholder="Codigo final" className="min-w-0 flex-1 rounded-lg px-3 py-2 text-sm font-bold outline-none" />
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
                                      <div className="text-[10px] font-black uppercase text-slate-500">{row.layer === "validation" ? "Reconteo base" : "Conteo original"}</div>
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
                            {savingRecountId === row.id ? "Guardando" : editingRecountItemId === row.id ? "Guardar edición" : row.layer === "validation" ? "Guardar validacion" : "Guardar reconteo"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>
                  );
                })}
                {recountItems.length === 0 && (
                  <div className="rounded-2xl border bg-slate-50 p-8 text-center text-sm font-bold text-slate-400 md:col-span-2">
                    No tienes códigos asignados para {selectedSession?.validation_enabled ? "reconteo o validacion" : "reconteo"} en este inventario.
                  </div>
                )}
                {recountItems.length > 0 && filteredOperatorRecountItems.length === 0 && (
                  <div className="rounded-2xl border bg-slate-50 p-8 text-center text-sm font-bold text-slate-400 md:col-span-2">
                    No hay {selectedSession?.validation_enabled ? "validaciones" : "reconteos"} que coincidan con la búsqueda.
                  </div>
                )}
              </div>
              <div className="mt-4 rounded-2xl border bg-white">
                <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                  <div>
                    <h3 className="font-black text-slate-900">{operatorRecordLayer === "validation" ? "Validaciones guardadas" : "Reconteos guardados"}</h3>
                    <p className="text-xs text-slate-500">Registro de lo que vas guardando en esta sesión.</p>
                  </div>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-600">{filteredOperatorRecountRecords.length}</span>
                </div>
                <div className="border-b px-4 py-3">
                  <div className="mb-2 grid grid-cols-2 gap-2 rounded-xl border bg-slate-50 p-1">
                    <button
                      type="button"
                      onClick={() => setOperatorRecordLayer("recount")}
                      className={`rounded-lg px-3 py-2 text-xs font-black ${operatorRecordLayer === "recount" ? "bg-slate-900 text-white" : "text-slate-600"}`}
                    >
                      Reconteo ({operatorRecordLayerCounts.recount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setOperatorRecordLayer("validation")}
                      className={`rounded-lg px-3 py-2 text-xs font-black ${operatorRecordLayer === "validation" ? "bg-slate-900 text-white" : "text-slate-600"}`}
                    >
                      Validacion ({operatorRecordLayerCounts.validation})
                    </button>
                  </div>
                  <div className="flex items-center rounded-xl border px-3 py-2">
                    <Search size={16} className="shrink-0 text-slate-400" />
                    <input
                      value={operatorSavedRecordQuery}
                      onChange={event => setOperatorSavedRecordQuery(event.target.value)}
                      placeholder="Buscar registro guardado"
                      className="min-w-0 flex-1 px-2 text-sm outline-none"
                    />
                    {operatorSavedRecordQuery && (
                      <button type="button" onClick={() => setOperatorSavedRecordQuery("")} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Limpiar busqueda de registros guardados">
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="divide-y">
                  {filteredOperatorRecountRecords.map(record => (
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
                  {filteredOperatorRecountRecords.length === 0 && (
                    <div className="p-8 text-center text-sm font-semibold text-slate-400">Aun no tienes {operatorRecordLayer === "validation" ? "validaciones" : "reconteos"} guardados.</div>
                  )}
                </div>
              </div>
            </section>
          )}

          {canManageInventory && selectedSessionId && (validatorTab === "reconteo" || validatorTab === "validacion") && (
            <ReconteoModule
              isValidationManagerTab={isValidationManagerTab}
              isAdmin={user?.role === "Administrador"}
              validationEnabled={Boolean(selectedSession?.validation_enabled)}
              isSelectedSessionFinished={isSelectedSessionFinished}
              recountFilter={recountFilter}
              recountOperatorId={recountOperatorId}
              sessionOperators={sessionOperators}
              filteredUnassignedCount={filteredUnassignedRecountCandidates.length}
              unassignedCount={unassignedRecountCandidates.length}
              activeAssignedRecountCount={activeAssignedRecountCount}
              recountManagerTab={recountManagerTab}
              assignedCount={assignedRecountRows.length}
              manualCount={manualRecountRows.length}
              recordsLabel={adminRecordLayer === "validation" ? "Validaciones guardadas" : adminRecordLayer === "recount" ? "Reconteos guardados" : "Registros guardados"}
              recordsCount={filteredAdminRecountRecords.length}
              selectedPendingCount={selectedPendingRecountRows.length}
              onToggleValidationPlan={toggleValidationPlan}
              onAssignRecountBlock={assignRecountBlock}
              onAssignSelectedRecountRows={assignSelectedRecountRows}
              onChangeRecountFilter={changeRecountFilter}
              onRecountOperatorChange={setRecountOperatorId}
              onRecountManagerTabChange={setRecountManagerTab}
            >

              {recountManagerTab === "pendientes" && (
              <section className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-black">Codigos pendientes por asignar {isValidationManagerTab ? "a validacion" : ""}</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex min-w-[240px] items-center rounded-xl border px-3 py-2 md:w-96">
                      <Search size={15} className="text-slate-400" />
                      <input
                        value={pendingRecountQuery}
                        onChange={event => setPendingRecountQuery(event.target.value)}
                        placeholder="Buscar codigo, descripcion, ubicacion o ticket"
                        className="min-w-0 flex-1 px-2 text-xs font-semibold outline-none"
                      />
                      {pendingRecountQuery && (
                        <button type="button" onClick={() => setPendingRecountQuery("")} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Limpiar busqueda pendientes">
                          <X size={14} />
                        </button>
                      )}
                    </div>
                    <div className="text-xs font-bold text-slate-500">{selectedPendingRecountRows.length} seleccionadas</div>
                    {renderRecountPagination(filteredUnassignedRecountCandidates.length, pendingRecountPage, pendingRecountTotalPages, setPendingRecountPage)}
                  </div>
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
                      {pagedUnassignedRecountCandidates.map(row => (
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
                      {filteredUnassignedRecountCandidates.length === 0 && (
                        <tr>
                          <td colSpan={14} className="p-8 text-center text-sm text-slate-400">
                            No hay codigos pendientes para asignar con el filtro actual.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex justify-end">
                  {renderRecountPagination(filteredUnassignedRecountCandidates.length, pendingRecountPage, pendingRecountTotalPages, setPendingRecountPage)}
                </div>
              </section>
              )}

              {recountManagerTab === "asignados" && (
              <section className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-black">{isValidationManagerTab ? "Codigos en validacion / reasignar" : "Codigos asignados / reasignar"}</h3>
                  <div className="flex flex-wrap gap-2">
                    {renderRecountPagination(assignedRecountRows.length, assignedRecountPage, assignedRecountTotalPages, setAssignedRecountPage)}
                    <select
                      value={recountPrintOperatorId}
                      onChange={event => setRecountPrintOperatorId(event.target.value)}
                      className="rounded-xl border bg-white px-3 py-2 text-xs font-black text-slate-700"
                      title="Filtrar reconteos por recontador"
                    >
                      <option value="">Todos los recontadores</option>
                      {sessionOperators.map(operatorRow => (
                        <option key={operatorRow.id} value={operatorRow.id}>{operatorRow.full_name}</option>
                      ))}
                    </select>
                    <select
                      value={recountAssignedStatusFilter}
                      onChange={event => setRecountAssignedStatusFilter(event.target.value as RecountAssignedStatusFilter)}
                      className="rounded-xl border bg-white px-3 py-2 text-xs font-black text-slate-700"
                      title="Filtrar por estado de guardado"
                    >
                      <option value="all">Todos ({assignedRecountStatusCounts.all})</option>
                      <option value="pending">Sin guardar ({assignedRecountStatusCounts.pending})</option>
                      <option value="counted">Guardados ({assignedRecountStatusCounts.counted})</option>
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
                      disabled={!assignedRecountRows.some(row => row.status === "counted") || isSelectedSessionFinished}
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
                      {pagedAssignedRecountRows.map(row => (
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
                              disabled={row.status === "counted" || isSelectedSessionFinished}
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
                                disabled={row.status === "counted" || isSelectedSessionFinished}
                                className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-black text-white disabled:opacity-40"
                              >
                                Reasignar
                              </button>
                              <button
                                onClick={() => unassignRecountItem(row)}
                                disabled={row.status === "counted" || isSelectedSessionFinished}
                                className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-black text-amber-700 disabled:opacity-40"
                              >
                                Quitar
                              </button>
                              {row.status === "counted" && (
                                <button
                                  onClick={() => deleteAssignedRecountCounts(row)}
                                  disabled={isSelectedSessionFinished}
                                  className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-black text-red-700 disabled:opacity-40"
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
                <div className="mt-3 flex justify-end">
                  {renderRecountPagination(assignedRecountRows.length, assignedRecountPage, assignedRecountTotalPages, setAssignedRecountPage)}
                </div>
              </section>
              )}

              {recountManagerTab === "manual" && (
              <section className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-black">Reconteo manual</h3>
                    <p className="text-xs text-slate-500">Imprime hojas A4 horizontal y registra aqui la validacion escrita por los recontadores.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {renderRecountPagination(manualRecountRows.length, manualRecountPage, manualRecountTotalPages, setManualRecountPage)}
                    <select
                      value={recountPrintOperatorId}
                      onChange={event => setRecountPrintOperatorId(event.target.value)}
                      className="rounded-xl border bg-white px-3 py-2 text-xs font-black text-slate-700"
                    >
                      <option value="">Todos los recontadores</option>
                      {sessionOperators.map(operatorRow => (
                        <option key={operatorRow.id} value={operatorRow.id}>{operatorRow.full_name}</option>
                      ))}
                    </select>
                    <button
                      onClick={generateManualRecountSheet}
                      disabled={manualRecountRows.length === 0}
                      className="inline-flex items-center gap-1 rounded-xl bg-slate-900 px-3 py-2 text-xs font-black text-white disabled:opacity-40"
                    >
                      <Download size={15} /> Imprimir hoja manual
                    </button>
                  </div>
                </div>

                <div className="mb-3 rounded-2xl border bg-slate-50 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="font-black text-slate-900">Seguro de reconteo manual</div>
                      <p className="text-xs font-bold text-slate-500">Cuando esta activo, los operarios no ven ni guardan reconteos desde la app.</p>
                    </div>
                    <button
                      onClick={toggleManualRecountMode}
                      disabled={!selectedSessionId || isSelectedSessionFinished}
                      className={`rounded-xl border px-4 py-2 text-xs font-black disabled:opacity-40 ${selectedSession?.manual_recount_enabled ? "border-green-200 bg-green-50 text-green-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}
                    >
                      {selectedSession?.manual_recount_enabled ? "Manual activo" : "App activa"}
                    </button>
                  </div>
                </div>

                <div className="overflow-auto rounded-xl border">
                  <table className="w-full min-w-[1520px] text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="p-2 text-center">#</th>
                        <th className="p-2 text-left">Recontador</th>
                        <th className="p-2 text-left">Codigo</th>
                        <th className="p-2 text-left">Descripcion</th>
                        <th className="p-2 text-center">UM</th>
                        <th className="p-2 text-center">Stock</th>
                        <th className="p-2 text-center">Conteo</th>
                        <th className="p-2 text-center">Dif.</th>
                        <th className="p-2 text-center">Dif. val.</th>
                        <th className="p-2 text-left">Ubicaciones conteo</th>
                        <th className="p-2 text-left">Ubicacion validada</th>
                        <th className="p-2 text-center">Reconteo</th>
                        <th className="p-2 text-center">Accion</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedManualRecountRows.map((row, index) => {
                        const draft = manualRecountDrafts[row.id] || { locationCode: "", quantity: "" };
                        const originalLines = countLocationLinesByProduct.get(row.product_id) || row.original_locations || [];
                        return (
                          <tr key={row.id} className="border-t align-top">
                            <td className="p-2 text-center font-black">{((manualRecountPage - 1) * RECOUNT_PAGE_SIZE) + index + 1}</td>
                            <td className="p-2 font-bold">{row.assigned_operator_name || "-"}</td>
                            <td className="p-2 font-black text-slate-950">{row.sku}</td>
                            <td className="max-w-sm whitespace-normal break-words p-2 text-slate-700">{row.description}</td>
                            <td className="p-2 text-center">{row.unit}</td>
                            <td className="p-2 text-center font-bold">{number2(row.system_stock)}</td>
                            <td className="p-2 text-center font-bold">{number2(row.counted_qty)}</td>
                            <td className={`p-2 text-center font-black ${row.diff_qty < 0 ? "text-red-600" : "text-blue-700"}`}>{number2(row.diff_qty)}</td>
                            <td className={`p-2 text-center font-black ${row.value_diff < 0 ? "text-red-600" : "text-blue-700"}`}>{money(row.value_diff)}</td>
                            <td className="p-2">
                              <div className="max-w-[260px] space-y-1">
                                {originalLines.length > 0 ? originalLines.slice(0, 4).map(line => (
                                  <div key={line.id} className="rounded-lg border bg-slate-50 px-2 py-1">
                                    <div className="font-black">{line.full_location || line.location_code}</div>
                                    <div className="text-[10px] font-bold text-slate-500">{number2(line.counted_qty)} {row.unit}</div>
                                  </div>
                                )) : <span className="text-slate-400">Sin ubicacion registrada</span>}
                              </div>
                            </td>
                            <td className="p-2">
                              <textarea
                                value={draft.locationCode}
                                onChange={event => updateManualRecountDraft(row.id, "locationCode", event.target.value.toUpperCase())}
                                disabled={isSelectedSessionFinished}
                                placeholder="Ubicacion o UBI:CANT por linea"
                                className="h-20 w-full min-w-[190px] rounded-xl border px-3 py-2 text-xs font-bold uppercase disabled:opacity-40"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                value={draft.quantity}
                                onChange={event => updateManualRecountDraft(row.id, "quantity", event.target.value)}
                                disabled={isSelectedSessionFinished}
                                placeholder="Cant."
                                className="w-24 rounded-xl border px-3 py-2 text-center text-xs font-black disabled:opacity-40"
                              />
                            </td>
                            <td className="p-2 text-center">
                              <button
                                onClick={() => saveManualRecountValidation(row)}
                                disabled={savingRecountId === row.id || isSelectedSessionFinished}
                                className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-black text-white disabled:opacity-40"
                              >
                                {savingRecountId === row.id ? "Guardando" : row.status === "counted" ? "Reemplazar" : "Guardar"}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                      {manualRecountRows.length === 0 && (
                        <tr>
                          <td colSpan={13} className="p-8 text-center text-sm text-slate-400">
                            No hay reconteos asignados para imprimir o validar con ese filtro.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex justify-end">
                  {renderRecountPagination(manualRecountRows.length, manualRecountPage, manualRecountTotalPages, setManualRecountPage)}
                </div>
              </section>
              )}

              {recountManagerTab === "registros" && (
              <section className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-black">{adminRecordLayer === "validation" ? "Registros guardados de validacion" : adminRecordLayer === "recount" ? "Registros guardados de reconteo" : "Registros guardados"}</h3>
                    <p className="text-xs text-slate-500">Edicion y borrado por linea de lo registrado por los operadores.</p>
                  </div>
                  <div className="flex rounded-xl border p-1 text-xs font-black">
                    <button
                      type="button"
                      onClick={() => { void switchAdminRecordLayer("all"); }}
                      className={`rounded-lg px-3 py-2 ${adminRecordLayer === "all" ? "bg-slate-900 text-white" : "text-slate-600"}`}
                    >
                      Todos
                    </button>
                    <button
                      type="button"
                      onClick={() => { void switchAdminRecordLayer("recount"); }}
                      className={`rounded-lg px-3 py-2 ${adminRecordLayer === "recount" ? "bg-slate-900 text-white" : "text-slate-600"}`}
                    >
                      Reconteo
                    </button>
                    <button
                      type="button"
                      onClick={() => { void switchAdminRecordLayer("validation"); }}
                      disabled={!selectedSession?.validation_enabled}
                      className={`rounded-lg px-3 py-2 disabled:opacity-40 ${adminRecordLayer === "validation" ? "bg-slate-900 text-white" : "text-slate-600"}`}
                    >
                      Validacion
                    </button>
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
                  {renderRecountPagination(filteredAdminRecountRecords.length, adminRecountRecordsPage, adminRecountRecordsTotalPages, setAdminRecountRecordsPage)}
                </div>
                <div className="overflow-auto rounded-xl border">
                  <table className="w-full min-w-[1460px] text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="p-2 text-left">Contador</th>
                        <th className="p-2 text-left">Registro</th>
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
                      {pagedAdminRecountRecords.map(record => (
                        <tr key={record.id} className="border-t">
                          <td className="p-2 font-black text-slate-800">{record.operator_name || "Sin recontador"}</td>
                          <td className="p-2 font-black text-slate-700">{record.item.layer === "validation" ? "Validacion" : "Reconteo"}</td>
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
                              <button onClick={() => openAdminEditRecountRecord(record)} disabled={isSelectedSessionFinished} className="rounded-lg border px-2 py-1 text-xs font-black disabled:opacity-40">Editar</button>
                              <button onClick={() => openAdminAddRecountRecord(record)} disabled={isSelectedSessionFinished} className="rounded-lg border border-blue-200 px-2 py-1 text-xs font-black text-blue-700 disabled:opacity-40">Agregar</button>
                              <button onClick={() => deleteAdminRecountRecord(record)} disabled={isSelectedSessionFinished} className="rounded-lg border border-red-200 px-2 py-1 text-xs font-black text-red-700 disabled:opacity-40">Borrar</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {filteredAdminRecountRecords.length === 0 && (
                        <tr>
                          <td colSpan={15} className="p-8 text-center text-sm text-slate-400">Aun no hay {adminRecordLayer === "validation" ? "validaciones" : adminRecordLayer === "recount" ? "reconteos" : "registros"} guardados que coincidan con la busqueda.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex justify-end">
                  {renderRecountPagination(filteredAdminRecountRecords.length, adminRecountRecordsPage, adminRecountRecordsTotalPages, setAdminRecountRecordsPage)}
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
            </ReconteoModule>
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

          {isValidator && selectedSessionId && validatorTab === "productividad" && (
            <section className="space-y-4">
              <div className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="font-black">Productividad por usuario</h2>
                    <p className="text-xs text-slate-500">Codigos unicos contados, recontados y validados por usuario.</p>
                  </div>
                  <div className="text-xs font-black text-slate-500">{productivityByUser.totals.total} codigos procesados</div>
                </div>

                <div className={`mb-4 grid gap-2 ${showValidationSummary ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
                  <div className="rounded-xl border bg-slate-50 p-3 text-center">
                    <div className="text-xl font-black text-slate-950">{productivityByUser.totals.total}</div>
                    <div className="text-xs font-black text-slate-500">Total</div>
                  </div>
                  <div className="rounded-xl border bg-blue-50 p-3 text-center">
                    <div className="text-xl font-black text-blue-700">{productivityByUser.totals.counted}</div>
                    <div className="text-xs font-black text-slate-500">Contados</div>
                  </div>
                  <div className="rounded-xl border bg-amber-50 p-3 text-center">
                    <div className="text-xl font-black text-amber-700">{productivityByUser.totals.recounted}/{productivityByUser.totals.assignedRecount}</div>
                    <div className="text-xs font-black text-slate-500">Reconteo</div>
                  </div>
                  {showValidationSummary && (
                    <div className="rounded-xl border bg-green-50 p-3 text-center">
                      <div className="text-xl font-black text-green-700">{productivityByUser.totals.validated}/{productivityByUser.totals.assignedValidation}</div>
                      <div className="text-xs font-black text-slate-500">Validacion</div>
                    </div>
                  )}
                </div>

                <div className={`grid gap-4 ${showValidationSummary ? "xl:grid-cols-3" : "xl:grid-cols-2"}`}>
                  <div className="rounded-2xl border bg-slate-50 p-3">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h3 className="font-black text-slate-900">Conteo</h3>
                      <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-black text-blue-700">{productivityByUser.totals.counted}</span>
                    </div>
                    <div className="space-y-3">
                      {productivityByUser.rows.filter(row => row.counted > 0).sort((a, b) => b.counted - a.counted || a.name.localeCompare(b.name, "es", { sensitivity: "base" })).map(row => (
                        <div key={`counted-${row.id}`} className="grid gap-1">
                          <div className="flex items-center justify-between gap-2 text-xs font-black">
                            <span className="truncate text-slate-800">{row.name}</span>
                            <span className="text-blue-700">{row.counted}</span>
                          </div>
                          <div className="h-4 overflow-hidden rounded-full bg-white">
                            <div className="h-full rounded-full bg-blue-700" style={{ width: `${Math.max(4, Math.round((row.counted / productivityByUser.maxCounted) * 100))}%` }} />
                          </div>
                        </div>
                      ))}
                      {productivityByUser.rows.every(row => row.counted === 0) && <div className="rounded-xl bg-white p-5 text-center text-sm text-slate-400">Sin conteos.</div>}
                    </div>
                  </div>

                  <div className="rounded-2xl border bg-slate-50 p-3">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h3 className="font-black text-slate-900">Reconteo</h3>
                      <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-black text-amber-700">{productivityByUser.totals.recounted}/{productivityByUser.totals.assignedRecount}</span>
                    </div>
                    <div className="space-y-3">
                      {productivityByUser.rows.filter(row => row.recounted > 0 || row.assignedRecount > 0).sort((a, b) => b.assignedRecount - a.assignedRecount || b.recounted - a.recounted || a.name.localeCompare(b.name, "es", { sensitivity: "base" })).map(row => {
                        const assigned = Math.max(row.assignedRecount, row.recounted);
                        const percent = assigned > 0 ? Math.min(100, Math.round((row.recounted / assigned) * 100)) : 0;
                        return (
                        <div key={`recounted-${row.id}`} className="grid gap-1">
                          <div className="flex items-center justify-between gap-2 text-xs font-black">
                            <span className="truncate text-slate-800">{row.name}</span>
                            <span className="text-amber-700">{row.recounted}/{row.assignedRecount} · {percent}%</span>
                          </div>
                          <div className="h-4 overflow-hidden rounded-full bg-white">
                            <div className="h-full rounded-full bg-amber-500" style={{ width: `${Math.max(row.recounted > 0 ? 4 : 0, percent)}%` }} />
                          </div>
                          {row.recounted > row.assignedRecount && <div className="text-[10px] font-black text-amber-700">Extra: {row.recounted - row.assignedRecount}</div>}
                        </div>
                        );
                      })}
                      {productivityByUser.rows.every(row => row.recounted === 0 && row.assignedRecount === 0) && <div className="rounded-xl bg-white p-5 text-center text-sm text-slate-400">Sin reconteos.</div>}
                    </div>
                  </div>

                  {showValidationSummary && (
                    <div className="rounded-2xl border bg-slate-50 p-3">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <h3 className="font-black text-slate-900">Validacion</h3>
                        <span className="rounded-full bg-green-50 px-3 py-1 text-xs font-black text-green-700">{productivityByUser.totals.validated}/{productivityByUser.totals.assignedValidation}</span>
                      </div>
                      <div className="space-y-3">
                        {productivityByUser.rows.filter(row => row.validated > 0 || row.assignedValidation > 0).sort((a, b) => b.assignedValidation - a.assignedValidation || b.validated - a.validated || a.name.localeCompare(b.name, "es", { sensitivity: "base" })).map(row => {
                          const assigned = Math.max(row.assignedValidation, row.validated);
                          const percent = assigned > 0 ? Math.min(100, Math.round((row.validated / assigned) * 100)) : 0;
                          return (
                            <div key={`validated-${row.id}`} className="grid gap-1">
                              <div className="flex items-center justify-between gap-2 text-xs font-black">
                                <span className="truncate text-slate-800">{row.name}</span>
                                <span className="text-green-700">{row.validated}/{row.assignedValidation} · {percent}%</span>
                              </div>
                              <div className="h-4 overflow-hidden rounded-full bg-white">
                                <div className="h-full rounded-full bg-green-600" style={{ width: `${Math.max(row.validated > 0 ? 4 : 0, percent)}%` }} />
                              </div>
                              {row.validated > row.assignedValidation && <div className="text-[10px] font-black text-green-700">Extra: {row.validated - row.assignedValidation}</div>}
                            </div>
                          );
                        })}
                        {productivityByUser.rows.every(row => row.validated === 0 && row.assignedValidation === 0) && <div className="rounded-xl bg-white p-5 text-center text-sm text-slate-400">Sin validaciones.</div>}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="font-black">Velocidad de conteo</h2>
                    <p className="text-xs text-slate-500">Registros por minuto efectivo. Pausas mayores a {COUNTER_ACTIVE_GAP_MINUTES} min no se consideran.</p>
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
                      <div className="text-sm font-black text-slate-900">
                        {row.perMinute.toFixed(2)} reg/min
                        <div className="text-[11px] font-bold text-slate-500">{row.minutes.toFixed(1)} min activos</div>
                      </div>
                    </div>
                  ))}
                  {counterStats.rows.length === 0 && <div className="rounded-xl bg-slate-50 p-6 text-center text-sm text-slate-400">Sin registros para graficar.</div>}
                </div>
              </div>
            </section>
          )}

          {((!isValidator && !operator) || !selectedSessionId || (isValidator && validatorTab === "registros")) && (
            <RegistrosModule
              isValidator={isValidator}
              canManageInventory={canManageInventory}
              isSelectedSessionFinished={isSelectedSessionFinished}
              operatorId={operator?.id}
              recordsOperatorFilter={recordsOperatorFilter}
              recordsOperatorOptions={recordsOperatorOptions}
              recordsZoneFilter={recordsZoneFilter}
              recordsZoneOptions={recordsZoneOptions}
              recordsQuery={recordsQuery}
              recordsSort={recordsSort}
              recordsRenderKey={recordsRenderKey}
              filteredCounts={pagedValidatorCounts}
              totalFilteredCounts={filteredCounts.length}
              recordsPage={validatorRecordsPage}
              recordsTotalPages={validatorRecordsTotalPages}
              countsTotal={counts.length}
              onRecordsOperatorFilterChange={setRecordsOperatorFilter}
              onRecordsZoneFilterChange={setRecordsZoneFilter}
              onRecordsQueryChange={setRecordsQuery}
              onRecordsPageChange={setValidatorRecordsPage}
              onExportRecords={exportRecords}
              onPrintRecordsByZone={printRecordsByZone}
              onToggleRecordsSort={toggleRecordsSort}
              onEditCount={editCount}
              onAdminEditCount={openAdminEditCount}
              onDeleteCount={deleteCount}
            />
          )}

          {isValidator && selectedSessionId && validatorTab === "resumen" && (
            <ResumenModule
              title={`Resumen Inventario General - ${selectedSession?.store_name || selectedSession?.name || "Tienda"}`}
              summaryLoading={summaryLoading}
              kpis={kpis}
              summary={summary}
              summaryQuery={summaryQuery}
              inventoryNotesDraft={inventoryNotesDraft}
              showValidationSummary={showValidationSummary}
              summarySort={summarySort}
              filteredSummary={pagedSummary}
              totalSummaryRows={filteredSummary.length}
              summaryPage={summaryPage}
              summaryTotalPages={summaryTotalPages}
              observationDrafts={observationDrafts}
              isSelectedSessionFinished={isSelectedSessionFinished}
              onGenerateGeneralInventoryReport={generateGeneralInventoryReport}
              onGenerateInventoryCategoryReport={generateInventoryCategoryReport}
              onExportSummary={exportSummary}
              onSummaryQueryChange={setSummaryQuery}
              onSummaryPageChange={setSummaryPage}
              onInventoryNotesDraftChange={setInventoryNotesDraft}
              onSaveInventoryNotes={saveInventoryNotes}
              onToggleSummarySort={toggleSummarySort}
              onObservationDraftChange={updateObservationDraft}
              onSaveObservation={saveObservation}
              onMarkSummaryAsNonInventory={markSummaryAsNonInventory}
              summaryQuantityStatusLabel={summaryQuantityStatusLabel}
              canForceRefreshStock={user?.role === "Administrador" && !isSelectedSessionFinished}
              refreshingNonOkStock={refreshingNonOkStock}
              onForceRefreshNonOkStock={forceRefreshNonOkStock}
              canEditFinishedStock={user?.id === FINISHED_STOCK_EDITOR_USER_ID && isSelectedSessionFinished}
              onEditSystemStock={openFinishedStockEdit}
            />
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
              <button onClick={saveAdminEditCount} disabled={isSelectedSessionFinished} className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                Guardar
              </button>
              <button onClick={() => setEditingAdminCount(null)} className="rounded-xl border px-4 py-3 text-sm font-black">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {editingFinishedStock && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-3 sm:p-4">
          <div className="app-modal-panel w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
            <h3 className="font-black text-red-700">Editar stock de sistema (inventario finalizado)</h3>
            <p className="mt-1 whitespace-normal break-words text-sm text-slate-500">{editingFinishedStock.sku} - {editingFinishedStock.description}</p>
            <p className="mt-2 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-800">
              Esto cambia el stock de sistema congelado de este código en un inventario ya finalizado.
              Mueve el Valor sistema, la Diferencia y el ERI de esta sesión de inmediato. No se vuelve a
              sincronizar con el ERP.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="text-xs font-black uppercase text-slate-500">Stock de sistema actual</label>
                <p className="text-sm font-bold text-slate-700">{number2(editingFinishedStock.system_stock)}</p>
              </div>
              <div>
                <label className="text-xs font-black uppercase text-slate-500">Nuevo stock de sistema</label>
                <input
                  value={editingFinishedStockValue}
                  onChange={event => setEditingFinishedStockValue(event.target.value)}
                  placeholder="Nuevo stock"
                  inputMode="decimal"
                  className="mt-1 w-full rounded-xl border px-3 py-3 text-sm font-bold"
                />
              </div>
              <div>
                <label className="text-xs font-black uppercase text-slate-500">Motivo del ajuste (obligatorio)</label>
                <textarea
                  value={editingFinishedStockNote}
                  onChange={event => setEditingFinishedStockNote(event.target.value)}
                  placeholder="Por que se corrige este stock..."
                  className="mt-1 min-h-16 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
              <button onClick={saveFinishedStockEdit} disabled={savingFinishedStockEdit} className="rounded-xl bg-red-700 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                {savingFinishedStockEdit ? "Guardando..." : "Guardar ajuste"}
              </button>
              <button onClick={() => setEditingFinishedStock(null)} disabled={savingFinishedStockEdit} className="rounded-xl border px-4 py-3 text-sm font-black disabled:opacity-40">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {editingAdminRecountRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-3 sm:p-4">
          <div className="app-modal-panel w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
            <h3 className="font-black">{editingAdminRecountMode === "add" ? "Agregar ubicacion al reconteo" : "Editar registro de reconteo"}</h3>
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
              <button onClick={saveAdminEditRecountRecord} disabled={isSelectedSessionFinished} className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                {editingAdminRecountMode === "add" ? "Agregar linea" : "Guardar"}
              </button>
              <button onClick={() => { setEditingAdminRecountRecord(null); setEditingAdminRecountMode("edit"); }} className="rounded-xl border px-4 py-3 text-sm font-black">
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
