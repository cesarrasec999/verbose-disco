"use client";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, @typescript-eslint/no-unused-expressions, react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { createClientUuid, getOrCreateDeviceId } from "@/lib/offline/clientIdentity";
import * as XLSX from "xlsx";
import { BarChart3, ClipboardList, Database, FileText, LineChart, LogOut, Package, QrCode, RefreshCw, Store as StoreIcon, Users } from "lucide-react";

// ══════════════════════════════════════════════════════════
//  TIPOS
// ══════════════════════════════════════════════════════════
type Role = "Operario" | "Validador" | "Administrador";
type TabKey = "operario" | "validador" | "admin";

type CyclicUser = {
    id: string;
    username: string;
    password?: string;
    full_name: string;
    role: Role;
    store_id: string | null;
    can_access_all_stores: boolean;
    can_access_audit?: boolean;
    is_active: boolean;
    whatsapp?: string | null;
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

type NonInventoryProduct = {
    id: string;
    product_id: string | null;
    sku: string;
    description: string | null;
    is_active: boolean;
};

type Assignment = {
    id: string;
    store_id: string;
    product_id: string;
    system_stock: number;
    assigned_date: string;
    assigned_by: string | null;
    sku?: string;
    barcode?: string | null;
    description?: string;
    unit?: string;
    cost?: number;
    store_name?: string;
    counted?: boolean;
    count_id?: string;
};

type CountRecord = {
    id: string;
    assignment_id: string;
    store_id: string;
    product_id: string;
    counted_quantity: number;
    location: string;
    user_id: string | null;
    user_name: string | null;
    validator_id: string | null;
    validator_name: string | null;
    status: "Pendiente" | "Diferencia" | "Validado" | "Corregido";
    note: string | null;
    stock_snapshot?: number | null;
    counted_at: string;
    updated_at: string;
    sku?: string;
    barcode?: string | null;
    description?: string;
    unit?: string;
    cost?: number;
    system_stock?: number;
    difference?: number;
    store_name?: string;
};

// Resumen agrupado por product_id
type ResumenRow = {
    product_id: string;
    sku: string;
    description: string;
    unit: string;
    cost: number;
    system_stock: number;
    total_counted: number;
    difference: number;
    dif_valorizada: number;
};

// Dashboard: datos por tienda para el período
type DashboardRow = {
    store_id: string;
    store_name: string;
    date: string;
    total_asignados: number;
    total_asignados_periodo?: number;
    total_ok: number;
    total_sobrantes: number;
    total_faltantes: number;
    total_no_contados: number;
    dif_valorizada: number;
    eri: number;
    cumplio: boolean;
    cumplimiento_pct: number; // % días cumplidos sobre total días con asignación (para vista mes)
    dias_cumplidos: number;
    dias_totales: number;
    hora_inicio: string | null;
    hora_fin: string | null;
    duracion_min: number | null;
};

type StoreProgress = {
    store_id: string;
    store_name: string;
    total_asignados: number;
    total_contados: number;
    pct: number;
};

type AllStoreAssignmentSummary = {
    product_id: string;
    sku: string;
    description: string;
    unit: string;
    store_count: number;
    assignment_count: number;
    all_store_assignment_ids: string[];
};

// Fila de ubicación + cantidad en el modal del operario
type LocationRow = { location: string; qty: string };

// ══════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════
function todayISO(): string {
    return new Date().toISOString().split("T")[0];
}

function cleanCode(value: string | null | undefined): string {
    if (!value) return "";
    let s = String(value).trim();
    s = s.replace(/^['"''""\u2018\u2019\u201C\u201D]+/, "").replace(/['"''""\u2018\u2019\u201C\u201D]+$/, "").trim();
    if (/[Ee][+-]/.test(s) && !isNaN(Number(s))) {
        const n = Number(s);
        if (isFinite(n)) s = Math.round(n).toString();
    }
    s = s.replace(/\.0+$/, "");
    if (/^\d+$/.test(s)) {
        s = s.replace(/^0+/, "");
        if (s === "") s = "0";
    }
    return s;
}

function fullProductCode(value: string | number | null | undefined): string {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    let s = raw.replace(/^['"''""\u2018\u2019\u201C\u201D]+/, "").replace(/['"''""\u2018\u2019\u201C\u201D]+$/, "").trim();
    if (/[Ee][+-]/.test(s) && !isNaN(Number(s))) {
        const n = Number(s);
        if (isFinite(n)) s = Math.round(n).toString();
    }
    return s.replace(/\.0+$/, "");
}

function visibleProductCode(value: string | number | null | undefined): string {
    const full = fullProductCode(value);
    const digits = full.replace(/\D/g, "");
    const suffix = (digits || full).slice(-5);
    return cleanCode(suffix);
}

function isShortVisibleOnlyCode(value: string | number | null | undefined): boolean {
    return /^\d{1,5}$/.test(fullProductCode(value));
}

function preferFullCodsapProducts<T extends Product>(rows: T[]): T[] {
    const groups = new Map<string, T[]>();
    for (const row of rows) {
        const key = visibleProductCode(row.sku) || fullProductCode(row.sku);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(row);
    }

    const result: T[] = [];
    for (const group of groups.values()) {
        const hasFullCode = group.some(row => !isShortVisibleOnlyCode(row.sku));
        result.push(...(hasFullCode ? group.filter(row => !isShortVisibleOnlyCode(row.sku)) : group));
    }
    return result;
}

function codeCandidates(value: string | null | undefined): string[] {
    const raw = String(value || "").trim();
    const clean = cleanCode(raw);
    const withoutPrefix = raw.replace(/^[A-Za-z]+/, "");
    const withoutPrefixClean = cleanCode(withoutPrefix);
    const withAuPrefix = withoutPrefixClean ? `AU${withoutPrefixClean.padStart(7, "0")}` : "";
    const padded = withoutPrefixClean ? withoutPrefixClean.padStart(7, "0") : "";
    return Array.from(new Set([raw, clean, withoutPrefix, withoutPrefixClean, padded, withAuPrefix].filter(Boolean)));
}

function mappedProductCodeCandidates(row: Record<string, unknown> | null | undefined): string[] {
    if (!row) return [];
    const value = row.codsap ?? row.codigosap ?? row.ProductReference ?? row.productreference ?? row.sku;
    const full = fullProductCode(String(value ?? ""));
    return full ? [full] : [];
}

function normalizeText(v: string | null | undefined) {
    return String(v || "").trim().toLowerCase();
}

/** Parsea costos con miles: "1,140.95" → 1140.95; "1140.95" → 1140.95 */
function parseCost(raw: any): number {
    if (raw === null || raw === undefined || raw === "") return 0;
    if (typeof raw === "number") return isNaN(raw) ? 0 : raw;
    // Convertir a string y quitar separador de miles (coma o punto según locale)
    let s = String(raw).trim().replace(/\s/g, "");
    // Si tiene tanto coma como punto, la coma es separador de miles
    if (s.includes(",") && s.includes(".")) {
        // e.g. "1,140.95" → "1140.95"
        s = s.replace(/,/g, "");
    } else if (s.includes(",")) {
        // Podría ser separador decimal (europeo) o de miles
        const parts = s.split(",");
        if (parts.length === 2 && parts[1].length <= 2) {
            // "1140,95" → decimal europeo → "1140.95"
            s = s.replace(",", ".");
        } else {
            // "1,140" → miles → "1140"
            s = s.replace(/,/g, "");
        }
    }
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
}

function formatMoney(v: number) {
    return `S/ ${Number(v || 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatNumber(v: number | string | null | undefined) {
    const n = Number(v || 0);
    if (!Number.isFinite(n)) return "0";
    return n.toLocaleString("es-PE", { maximumFractionDigits: 2 });
}

/** Redondea a 2 decimales eliminando errores de punto flotante */
function r2(v: number): number {
    return Math.round((v + Number.EPSILON) * 100) / 100;
}

function formatDateTime(v: string) {
    if (!v) return "-";
    const d = new Date(v);
    if (isNaN(d.getTime())) return v;
    return d.toLocaleString("es-PE");
}

const ALL_STORES_VALUE = "__all_stores__";
const SESSION_FLAG_LOCATIONS = new Set([
    "__session_counting__",
    "__session_finished__",
    "__recount_started__",
    "__recount_done__",
]);

function isSessionFlagLocation(location: string | null | undefined): boolean {
    return SESSION_FLAG_LOCATIONS.has(String(location || ""));
}

function formatDuration(minutes: number | null): string {
    if (minutes === null || minutes < 0) return "—";
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) return `${m} min`;
    return `${h}h ${m}m`;
}

function statusBadge(status: CountRecord["status"]) {
    const base = "inline-block px-2 py-0.5 rounded-full text-xs font-semibold";
    switch (status) {
        case "Pendiente":  return `${base} bg-slate-100 text-slate-700`;
        case "Diferencia": return `${base} bg-red-100 text-red-700`;
        case "Validado":   return `${base} bg-green-100 text-green-700`;
        case "Corregido":  return `${base} bg-blue-100 text-blue-700`;
        default:           return `${base} bg-slate-100 text-slate-700`;
    }
}

function diffBadge(diff: number) {
    if (diff === 0) return <span className="text-green-700 font-semibold">0</span>;
    if (diff > 0)   return <span className="text-blue-700 font-semibold">+{formatNumber(diff)}</span>;
    return <span className="text-red-600 font-semibold">{formatNumber(diff)}</span>;
}

// ══════════════════════════════════════════════════════════
//  COMPONENTE PRINCIPAL
// ══════════════════════════════════════════════════════════
export default function DashboardPage() {
    // ─── Auth ───────────────────────────────────────────────
    const [user, setUser]         = useState<CyclicUser | null>(null);
    const [activeTab, setActiveTab] = useState<TabKey>("operario");

    // ─── Datos globales ─────────────────────────────────────
    const [stores, setStores]         = useState<Store[]>([]);
    const [allStores, setAllStores]   = useState<Store[]>([]);
    const [products, setProducts]     = useState<Product[]>([]);
    const [allUsers, setAllUsers]     = useState<CyclicUser[]>([]);

    // ─── Selector de tienda / fecha ─────────────────────────
    const [selectedStoreId, setSelectedStoreId] = useState("");
    const [selectedDate, setSelectedDate]       = useState(todayISO());

    // ─── Asignaciones y conteos ─────────────────────────────
    const [assignments, setAssignments] = useState<Assignment[]>([]);
    const [counts, setCounts]           = useState<CountRecord[]>([]);

    // ─── UI / mensajes ──────────────────────────────────────
    const [message, setMessage]         = useState("");
    const [messageType, setMessageType] = useState<"info"|"success"|"error">("info");
    const [loading, setLoading]         = useState(true);
    const messageTimerRef               = useRef<ReturnType<typeof setTimeout>|null>(null);

    // ─── Operario: conteo activo — múltiples filas ─
    const [activeAssignment, setActiveAssignment] = useState<Assignment | null>(null);
    const [refreshingStockId, setRefreshingStockId] = useState<string | null>(null);
    const [bulkRefreshingStocks, setBulkRefreshingStocks] = useState(false);
    const [locationRows, setLocationRows]         = useState<LocationRow[]>([{ location: "", qty: "" }]);
    const [sinStock, setSinStock]                 = useState(false); // marcar "sin stock físico"

    // ─── Operario: reconteo ──────────────────────────────────
    const [showRecount, setShowRecount]           = useState(false);
    const [recountAssignment, setRecountAssignment] = useState<Assignment | null>(null);
    const [recountRows, setRecountRows]           = useState<LocationRow[]>([{ location: "", qty: "" }]);
    const [sinStockRecount, setSinStockRecount]   = useState(false);
    const startingRecountRef = useRef(false);

    // ─── Escáner ─────────────────────────────────────────────
    const [scannerTarget, setScannerTarget]   = useState<"product"|"location"|"recount_location"|null>(null);
    const [scannerRunning, setScannerRunning] = useState(false);
    const [torchAvailable, setTorchAvailable] = useState(false);
    const [torchOn, setTorchOn]               = useState(false);
    const [scanningRowIndex, setScanningRowIndex] = useState<number>(0);
    const scannerRef         = useRef<any>(null);
    const scanHandledRef     = useRef(false);
    const overlayOpenedRef   = useRef(false);
    const scannerContainerId = "cyclic-scanner";

    // ─── Validador: filtros ──────────────────────────────────
    const [valTab, setValTab]               = useState<"asignar"|"registros"|"resumen"|"progreso"|"dashboard">("asignar");
    const [valStoreId, setValStoreId]       = useState("");
    const [valDate, setValDate]             = useState(todayISO());
    const [valSearchText, setValSearchText] = useState("");
    const [valStatusFilter, setValStatusFilter] = useState("todos");
    const [resumenSearch, setResumenSearch] = useState("");

    // ─── Validador: asignación ───────────────────────────────
    const [assignSearch, setAssignSearch]     = useState("");
    const [assignResults, setAssignResults]   = useState<Product[]>([]);
    const [assignSelectedIds, setAssignSelectedIds] = useState<Set<string>>(new Set());
    const [assignBusy, setAssignBusy] = useState(false);
    const [allStoreAssignmentSummary, setAllStoreAssignmentSummary] = useState<AllStoreAssignmentSummary[]>([]);
    const [allStoreSummaryLoading, setAllStoreSummaryLoading] = useState(false);
    const [bulkAssignFile, setBulkAssignFile] = useState<File|null>(null);
    const [bulkAssignFileName, setBulkAssignFileName] = useState("");
    const [bulkAssignProgress, setBulkAssignProgress] = useState<{step:string;pct:number}|null>(null);
    const bulkAssignRef = useRef<HTMLInputElement|null>(null);
    const [nonInventoryProducts, setNonInventoryProducts] = useState<NonInventoryProduct[]>([]);
    const [nonInventoryInput, setNonInventoryInput] = useState("");
    const nonInventoryExcelRef = useRef<HTMLInputElement|null>(null);
    const [nonInventoryExcelBusy, setNonInventoryExcelBusy] = useState(false);
    const [nonInventoryExcelFileName, setNonInventoryExcelFileName] = useState("");

    // ─── Validador: editar conteo ────────────────────────────
    const [editingCount, setEditingCount]   = useState<CountRecord|null>(null);
    const [editQty, setEditQty]             = useState("");
    const [editLocation, setEditLocation]   = useState("");
    const [editStatus, setEditStatus]       = useState<CountRecord["status"]>("Pendiente");
    const [editNote, setEditNote]           = useState("");

    // ─── Admin: maestro productos ────────────────────────────
    const [adminTab, setAdminTab]             = useState<"productos"|"tiendas"|"usuarios">("productos");
    const [prodSearch, setProdSearch]         = useState("");
    const [masterFile, setMasterFile]         = useState<File|null>(null);
    const [masterFileName, setMasterFileName] = useState("");
    const [uploadProgress, setUploadProgress] = useState<{step:string;pct:number}|null>(null);
    const masterInputRef = useRef<HTMLInputElement|null>(null);

    // ─── Admin: códigos de barra ─────────────────────────────
    const [barcodesFile, setBarcodesFile]         = useState<File|null>(null);
    const [barcodesFileName, setBarcodesFileName] = useState("");
    const [barcodesProgress, setBarcodesProgress] = useState<{step:string;pct:number}|null>(null);
    const barcodesInputRef = useRef<HTMLInputElement|null>(null);

    // ─── Admin: editar producto ──────────────────────────────
    const [editingProduct, setEditingProduct] = useState<Product|null>(null);
    const [editProdSku, setEditProdSku]       = useState("");
    const [editProdBarcode, setEditProdBarcode] = useState("");
    const [editProdDesc, setEditProdDesc]     = useState("");
    const [editProdUnit, setEditProdUnit]     = useState("");
    const [editProdCost, setEditProdCost]     = useState("");

    // ─── Admin: tiendas ──────────────────────────────────────
    const [newStoreName, setNewStoreName] = useState("");
    const [newStoreCode, setNewStoreCode] = useState("");

    // ─── Admin: usuarios ─────────────────────────────────────
    const [newUsername, setNewUsername]       = useState("");
    const [newPassword, setNewPassword]       = useState("");
    const [newFullName, setNewFullName]       = useState("");
    const [newRole, setNewRole]               = useState<Role>("Operario");
    const [newUserStoreId, setNewUserStoreId] = useState("");
    const [newUserAllStores, setNewUserAllStores] = useState(false);
    const [newUserWhatsapp, setNewUserWhatsapp] = useState("");
    const [newUserAuditAccess, setNewUserAuditAccess] = useState(false);
    const [editingUser, setEditingUser]       = useState<CyclicUser|null>(null);
    const [editUserRole, setEditUserRole]     = useState<Role>("Operario");
    const [editUserWhatsapp, setEditUserWhatsapp] = useState("");

    // ─── WhatsApp masivo post-carga ──────────────────────────
    const [showBulkWspModal, setShowBulkWspModal] = useState(false);
    const [bulkWspStores, setBulkWspStores] = useState<{ id: string; name: string; count: number; operario: { full_name: string; whatsapp: string; username: string; password: string } | null }[]>([]);
    const [bulkWspSelected, setBulkWspSelected] = useState<Set<string>>(new Set());
    const [bulkWspDate, setBulkWspDate] = useState("");
    const [bulkWspSendingIdx, setBulkWspSendingIdx] = useState(-1); // -1 = no enviando, 0+ = índice actual

    // ─── Protección anti-doble clic en guardados ─────────────
    const [savingCount, setSavingCount]         = useState(false);
    const [savingRecount, setSavingRecount]     = useState(false);
    const savingCountRef = useRef(false);
    const savingRecountRef = useRef(false);
    const [savingAnalysis, setSavingAnalysis]   = useState(false);

    // ─── Terminar sesión de conteo ───────────────────────────
    const [showFinishModal, setShowFinishModal] = useState(false);
    const [showRecountConfirmModal, setShowRecountConfirmModal] = useState(false);
    const [sessionFinished, setSessionFinished] = useState(false);
    const [recountFinished, setRecountFinished] = useState(false);
    const [countingStatus, setCountingStatus] = useState<"idle"|"counting"|"finished"|"recounting"|"recount_done">("idle");
    const [editUserStoreId, setEditUserStoreId] = useState("");
    const [editUserAllStores, setEditUserAllStores] = useState(false);
    const [editUserActive, setEditUserActive] = useState(true);
    const [editUserPassword, setEditUserPassword] = useState("");
    const [editUserAuditAccess, setEditUserAuditAccess] = useState(false);

    const [showEmailModal, setShowEmailModal] = useState(false);
    const [emailHTML, setEmailHTML]           = useState("");
    const [emailRecipients, setEmailRecipients] = useState("");
    const [manualProductCode, setManualProductCode] = useState("");
    const [manualProductCandidates, setManualProductCandidates] = useState<Product[]>([]);
    const [manualProductCodePending, setManualProductCodePending] = useState("");

    // ─── Dashboard ───────────────────────────────────────────
    const [dashPeriod, setDashPeriod] = useState<"dia"|"mes"|"rango">("dia");
    const [dashDate, setDashDate]     = useState(todayISO());
    const [dashMonth, setDashMonth]   = useState(todayISO().slice(0, 7));
    const [dashRangeFrom, setDashRangeFrom] = useState(todayISO().slice(0,7) + "-01");
    const [dashRangeTo, setDashRangeTo]     = useState(todayISO());
    const [dashData, setDashData]     = useState<DashboardRow[]>([]);
    const [dashLoading, setDashLoading] = useState(false);
    const [dashStoreFilter, setDashStoreFilter] = useState("");
    const [globalExportLoading, setGlobalExportLoading] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(false);

    // ─── Dashboard en validador: progreso por tienda ─────────
    const [storeProgressData, setStoreProgressData] = useState<StoreProgress[]>([]);
    const [storeProgressLoading, setStoreProgressLoading] = useState(false);

    // ─── Dashboard drill-down: tienda clickeada en vista día ─
    const [dashDrillSource, setDashDrillSource] = useState(false); // true = venimos del dashboard

    // ─── Resumen análisis: overrides de stock y cantidad contada
    // key = product_id, value = { system_stock?: number, total_counted?: number }
    const [resumenOverrides, setResumenOverrides] = useState<Record<string, { system_stock?: number; total_counted?: number }>>({});
    const [resumenDraft,     setResumenDraft]     = useState<Record<string, { system_stock?: number; total_counted?: number }>>({});
    const [resumenEditMode, setResumenEditMode] = useState(false);
    const [resumenSort, setResumenSort] = useState<{ col: string; dir: "asc" | "desc" } | null>(null);
    const nonInventorySkuSet = useMemo(() => new Set(
        nonInventoryProducts
            .filter(row => row.is_active !== false)
            .map(row => fullProductCode(row.sku).toUpperCase())
            .filter(Boolean)
    ), [nonInventoryProducts]);

    // ════════════════════════════════════════════════════════
    //  INIT
    // ════════════════════════════════════════════════════════
    useEffect(() => {
        const raw = localStorage.getItem("cyclic_user");
        if (!raw) { window.location.replace("/"); return; }
        let parsed: CyclicUser;
        try { parsed = JSON.parse(raw) as CyclicUser; } catch { window.location.replace("/"); return; }

        (async () => {
            try {
                const { data } = await supabase.from("cyclic_users").select("*").eq("id", parsed.id).maybeSingle();
                const u = (data || parsed) as CyclicUser;
                if (!u.is_active) { localStorage.removeItem("cyclic_user"); window.location.replace("/"); return; }
                localStorage.setItem("cyclic_user", JSON.stringify(u));
                setUser(u);

                const savedTab = sessionStorage.getItem("cyclic_active_tab") as TabKey | null;
                if (savedTab) {
                    const isValid =
                        (savedTab === "operario" && u.role === "Operario") ||
                        (savedTab === "validador" && (u.role === "Validador" || u.role === "Administrador")) ||
                        (savedTab === "admin" && u.role === "Administrador");
                    if (isValid) { setActiveTab(savedTab); }
                    else {
                        if (u.role === "Administrador") setActiveTab("admin");
                        else if (u.role === "Validador") setActiveTab("validador");
                        else setActiveTab("operario");
                    }
                } else {
                    if (u.role === "Administrador") setActiveTab("admin");
                    else if (u.role === "Validador") setActiveTab("validador");
                    else setActiveTab("operario");
                }

                const savedValTab = sessionStorage.getItem("cyclic_val_tab") as "asignar"|"registros"|"resumen"|"progreso"|"dashboard" | null;
                if (savedValTab) setValTab(savedValTab);

                const savedAdminTab = sessionStorage.getItem("cyclic_admin_tab") as "productos"|"tiendas"|"usuarios" | null;
                if (savedAdminTab) setAdminTab(savedAdminTab);

                const savedValStoreId = sessionStorage.getItem("cyclic_val_store");
                const savedValDate    = sessionStorage.getItem("cyclic_val_date");
                if (savedValStoreId && (savedValStoreId !== ALL_STORES_VALUE || savedValTab === "asignar")) setValStoreId(savedValStoreId);
                if (savedValDate)    setValDate(savedValDate);

                // Restaurar tienda y fecha seleccionadas (para admin que ve tab operario)
                const savedStoreId = sessionStorage.getItem("cyclic_selected_store");
                const savedDate    = sessionStorage.getItem("cyclic_selected_date");
                if (savedStoreId) setSelectedStoreId(savedStoreId);
                if (savedDate)    setSelectedDate(savedDate);

            } catch {
                setUser(parsed);
                if (parsed.role === "Administrador") setActiveTab("admin");
                else if (parsed.role === "Validador") setActiveTab("validador");
                else setActiveTab("operario");
            }
        })();
    }, []);

    useEffect(() => {
        if (user) { loadStores(); loadProducts(); loadNonInventoryProducts(); if (user.role !== "Operario") loadAllUsers(); }
    }, [user]);

    useEffect(() => {
        if (!user) return;
        if (user.role === "Operario") {
            const sid = user.store_id || "";
            setSelectedStoreId(sid);
            if (sid) loadOperarioData(sid, selectedDate);
        } else if (user.role === "Administrador" || user.role === "Validador") {
            // Restaurar datos del validador si estaba en ese tab
            const savedTab      = sessionStorage.getItem("cyclic_active_tab");
            const savedValStore = sessionStorage.getItem("cyclic_val_store");
            const savedValDate  = sessionStorage.getItem("cyclic_val_date");
            if ((savedTab === "validador") && savedValStore && savedValDate) {
                loadValidadorData(savedValStore, savedValDate);
            }
            // Restaurar vista operario para admin
            if (user.role === "Administrador") {
                const savedStoreId = sessionStorage.getItem("cyclic_selected_store");
                const savedDate    = sessionStorage.getItem("cyclic_selected_date");
                if (savedStoreId) {
                    setSelectedStoreId(savedStoreId);
                    loadOperarioData(savedStoreId, savedDate || selectedDate);
                }
            }
        }
    }, [user]);

    useEffect(() => {
        if (activeTab) sessionStorage.setItem("cyclic_active_tab", activeTab);
    }, [activeTab]);

    useEffect(() => {
        if (selectedStoreId) sessionStorage.setItem("cyclic_selected_store", selectedStoreId);
    }, [selectedStoreId]);

    useEffect(() => {
        if (selectedDate) sessionStorage.setItem("cyclic_selected_date", selectedDate);
    }, [selectedDate]);

    useEffect(() => {
        if (valTab) sessionStorage.setItem("cyclic_val_tab", valTab);
        if (valTab !== "asignar" && valStoreId === ALL_STORES_VALUE) {
            const firstStoreId = stores[0]?.id || "";
            setValStoreId(firstStoreId);
            if (firstStoreId && (valTab === "registros" || valTab === "resumen")) loadValidadorData(firstStoreId, valDate);
        }
    }, [valTab]);

    useEffect(() => {
        if (adminTab) sessionStorage.setItem("cyclic_admin_tab", adminTab);
    }, [adminTab]);

    useEffect(() => {
        if (valStoreId) sessionStorage.setItem("cyclic_val_store", valStoreId);
    }, [valStoreId]);

    useEffect(() => {
        if (valDate) sessionStorage.setItem("cyclic_val_date", valDate);
    }, [valDate]);

    useEffect(() => {
        if (activeTab !== "validador" || valTab !== "asignar" || valStoreId !== ALL_STORES_VALUE) return;
        loadAllStoreAssignmentSummary(valDate);
    }, [activeTab, valTab, valStoreId, valDate, stores]);

    // realtime para operario
    useEffect(() => {
        if (!selectedStoreId || user?.role !== "Operario") return;
        const ch = supabase.channel(`cyclic-store-${selectedStoreId}`)
            .on("postgres_changes", { event: "*", schema: "public", table: "cyclic_assignments", filter: `store_id=eq.${selectedStoreId}` }, () => loadOperarioData(selectedStoreId, selectedDate))
            .on("postgres_changes", { event: "*", schema: "public", table: "cyclic_counts",      filter: `store_id=eq.${selectedStoreId}` }, () => loadOperarioData(selectedStoreId, selectedDate))
            .subscribe();
        return () => { supabase.removeChannel(ch); };
    }, [selectedStoreId, selectedDate, user]);

    // realtime para admin viendo tab operario
    useEffect(() => {
        if (!selectedStoreId || user?.role !== "Administrador" || activeTab !== "operario") return;
        const ch = supabase.channel(`cyclic-admin-operario-${selectedStoreId}`)
            .on("postgres_changes", { event: "*", schema: "public", table: "cyclic_counts", filter: `store_id=eq.${selectedStoreId}` }, () => loadOperarioData(selectedStoreId, selectedDate))
            .subscribe();
        return () => { supabase.removeChannel(ch); };
    }, [selectedStoreId, selectedDate, user, activeTab]);

    // realtime para validador: recarga cuando operario registra conteos
    useEffect(() => {
        if (!valStoreId || activeTab !== "validador") return;
        if (valStoreId === ALL_STORES_VALUE) {
            const ch = supabase.channel(`cyclic-validador-all-${valDate}`)
                .on("postgres_changes", { event: "*", schema: "public", table: "cyclic_assignments" }, () => loadAllStoreAssignmentSummary(valDate))
                .subscribe();
            return () => { supabase.removeChannel(ch); };
        }
        const ch = supabase.channel(`cyclic-validador-${valStoreId}-${valDate}`)
            .on("postgres_changes", { event: "*", schema: "public", table: "cyclic_counts", filter: `store_id=eq.${valStoreId}` }, () => loadValidadorData(valStoreId, valDate))
            .on("postgres_changes", { event: "*", schema: "public", table: "cyclic_assignments", filter: `store_id=eq.${valStoreId}` }, () => loadValidadorData(valStoreId, valDate))
            .subscribe();
        return () => { supabase.removeChannel(ch); };
    }, [valStoreId, valDate, activeTab]);

    // scanner overlay
    useEffect(() => {
        if (!scannerTarget) return;
        let cancelled = false;
        async function startScanner() {
            try {
                const mod = await import("html5-qrcode");
                const Html5Qrcode = mod.Html5Qrcode;
                if (cancelled) return;
                const qr = new Html5Qrcode(scannerContainerId);
                scannerRef.current = qr;
                setScannerRunning(true);
                await qr.start(
                    { facingMode: "environment" },
                    { fps: 15, qrbox: { width: 260, height: 160 }, aspectRatio: 1.6 },
                    (decoded: string) => { applyScannedValue(decoded); },
                    () => {}
                );
                try {
                    const caps: any = (qr as any).getRunningTrackCapabilities?.();
                    setTorchAvailable(!!caps?.torch);
                } catch { setTorchAvailable(false); }
            } catch (err: any) {
                showMessage("No se pudo iniciar la cámara: " + (err?.message || ""), "error");
                setScannerRunning(false);
                setScannerTarget(null);
            }
        }
        void startScanner();
        return () => { cancelled = true; stopScanner(); };
    }, [scannerTarget]);

    // Botón atrás del celular cierra overlays
    useEffect(() => {
        const anyOpen = !!scannerTarget || !!editingCount || !!editingProduct || !!activeAssignment || !!editingUser || showRecount;
        if (anyOpen && !overlayOpenedRef.current) {
            window.history.pushState({ overlay: true }, "");
            overlayOpenedRef.current = true;
        }
        if (!anyOpen) overlayOpenedRef.current = false;

        const handler = (e: PopStateEvent) => {
            if (scannerTarget)    { closeScanner(); return; }
            if (editingCount)     { setEditingCount(null); return; }
            if (editingProduct)   { setEditingProduct(null); return; }
            if (activeAssignment) { setActiveAssignment(null); return; }
            if (editingUser)      { setEditingUser(null); return; }
            if (showRecount)      { setShowRecount(false); setRecountAssignment(null); return; }
        };
        window.addEventListener("popstate", handler);
        return () => window.removeEventListener("popstate", handler);
    }, [scannerTarget, editingCount, editingProduct, activeAssignment, editingUser, showRecount]);

    // ════════════════════════════════════════════════════════
    //  HELPERS UI
    // ════════════════════════════════════════════════════════
    function showMessage(msg: string, type: "info"|"success"|"error" = "info") {
        if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
        setMessage(msg);
        setMessageType(type);
        if (type === "success") messageTimerRef.current = setTimeout(() => setMessage(""), 4000);
    }
    function clearMessage() { setMessage(""); }
    function requireOnlineForStockPhoto() {
        if (typeof navigator !== "undefined" && !navigator.onLine) {
            showMessage("Verifica tu conexión a internet. No se puede contar sin actualizar la fotografía de stock.", "error");
            return false;
        }
        return true;
    }

    function handleLogout() {
        localStorage.removeItem("cyclic_user");
        sessionStorage.removeItem("cyclic_active_tab");
        sessionStorage.removeItem("cyclic_val_tab");
        sessionStorage.removeItem("cyclic_admin_tab");
        sessionStorage.removeItem("cyclic_val_store");
        sessionStorage.removeItem("cyclic_val_date");
        sessionStorage.removeItem("cyclic_selected_store");
        sessionStorage.removeItem("cyclic_selected_date");
        window.location.replace("/");
    }

    function handleFinishSessionClick() {
        if (pendingAssignments.length > 0) {
            setShowFinishModal(true);
        } else {
            confirmFinishSession();
        }
    }

    // ── Helper: escribir/borrar flags de sesión en BD ────────
    // Siempre usamos el assignment con ID mínimo (orden estable) como anchor.
    async function getSessionAnchor(storeId: string, date: string): Promise<string | null> {
        const { data: asgns } = await supabase
            .from("cyclic_assignments").select("id")
            .eq("store_id", storeId).eq("assigned_date", date)
            .order("id").limit(1);
        return asgns && asgns.length > 0 ? asgns[0].id : null;
    }

    async function setSessionFlag(storeId: string, date: string, flag: "__session_counting__" | "__session_finished__" | "__recount_started__" | "__recount_done__", active: boolean) {
        const { data: asgns } = await supabase
            .from("cyclic_assignments").select("id, product_id")
            .eq("store_id", storeId).eq("assigned_date", date)
            .order("id").limit(1);
        if (!asgns || asgns.length === 0) return;
        const anchorId = asgns[0].id;
        const anchorProductId = asgns[0].product_id; // product_id real del assignment anchor
        if (active) {
            await supabase.from("cyclic_counts").delete().eq("assignment_id", anchorId).eq("location", flag);
            await supabase.from("cyclic_counts").insert({
                assignment_id: anchorId,
                store_id: storeId,
                product_id: anchorProductId, // usar product_id real para respetar FK
                counted_quantity: 0,
                location: flag,
                status: "Pendiente",
                counted_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            });
        } else {
            await supabase.from("cyclic_counts").delete().eq("assignment_id", anchorId).eq("location", flag);
        }
    }

    async function clearSessionFlags(storeId: string, date: string) {
        // Limpia flags de TODOS los assignments de la tienda+fecha (no solo el anchor)
        // para asegurarse que no queden huérfanos de sesiones previas
        const { data: asgns } = await supabase
            .from("cyclic_assignments").select("id")
            .eq("store_id", storeId).eq("assigned_date", date);
        if (!asgns || asgns.length === 0) return;
        const ids = asgns.map((a: any) => a.id);
        await supabase.from("cyclic_counts")
            .delete()
            .in("assignment_id", ids)
            .in("location", Array.from(SESSION_FLAG_LOCATIONS));
    }

    async function confirmFinishSession() {
        setShowFinishModal(false);
        setSessionFinished(true);
        setRecountFinished(false);
        // Limpiar flags anteriores y escribir __session_finished__ en BD
        await clearSessionFlags(selectedStoreId, selectedDate);
        await setSessionFlag(selectedStoreId, selectedDate, "__session_finished__", true);

        if (difAssignments.length > 0) {
            await openRecountPanel();
            showMessage(`Conteo terminado. Pasamos a reconteo con ${difAssignments.length} codigo${difAssignments.length !== 1 ? "s" : ""} con diferencia.`, "info");
            return;
        }

        setShowRecount(false);
        setRecountAssignment(null);
        showMessage("GENIAL, CULMINASTE CON TUS ASIGNACIONES ✅", "success");
    }

    // ════════════════════════════════════════════════════════
    //  CARGA DE DATOS
    // ════════════════════════════════════════════════════════
    async function loadStores() {
        if (!user) return;
        const { data: all } = await supabase.from("stores").select("*").order("name");
        setAllStores((all || []) as Store[]);
        const active = (all || []).filter((s: any) => s.is_active) as Store[];
        if (user.role === "Administrador" || user.can_access_all_stores) {
            setStores(active);
            const savedValStore = sessionStorage.getItem("cyclic_val_store");
            if (savedValStore === ALL_STORES_VALUE) {
                setValStoreId(ALL_STORES_VALUE);
            } else if (savedValStore && active.some(s => s.id === savedValStore)) {
                setValStoreId(savedValStore);
            } else if (active.length > 0) {
                setValStoreId(active[0].id);
            }
        } else {
            const mine = user.store_id ? active.filter(s => s.id === user.store_id) : [];
            setStores(mine);
        }
        setLoading(false);
    }

    async function loadProducts() {
        const PAGE = 1000;
        const all: Product[] = [];
        let page = 0;
        let hasMore = true;
        while (hasMore) {
            const { data } = await supabase.from("cyclic_products").select("*").eq("is_active", true).order("sku").range(page * PAGE, (page + 1) * PAGE - 1);
            if (data && data.length > 0) { all.push(...(data as Product[])); page++; }
            if (!data || data.length < PAGE) hasMore = false;
        }
        setProducts(all);
    }

    async function loadNonInventoryProducts() {
        const { data, error } = await supabase
            .from("cyclic_non_inventory_products")
            .select("id, product_id, sku, description, is_active")
            .eq("is_active", true)
            .order("sku");
        if (error) {
            console.warn("No se pudo cargar no inventariables ciclicos:", error.message);
            return;
        }
        setNonInventoryProducts((data || []) as NonInventoryProduct[]);
    }

    async function loadAllUsers() {
        const { data } = await supabase.from("cyclic_users").select("*").order("full_name");
        setAllUsers((data || []) as CyclicUser[]);
    }

    async function loadOperarioData(storeId: string, date: string) {
        if (!storeId) return;
        const { data: asgn } = await supabase
            .from("cyclic_assignments")
            .select("*, cyclic_products(sku, barcode, description, unit, cost)")
            .eq("store_id", storeId)
            .eq("assigned_date", date)
            .order("created_at");
        const rows: Assignment[] = (asgn || []).map((a: any) => ({
            id: a.id, store_id: a.store_id, product_id: a.product_id,
            system_stock: a.system_stock, assigned_date: a.assigned_date, assigned_by: a.assigned_by,
            sku: a.cyclic_products?.sku, barcode: a.cyclic_products?.barcode,
            description: a.cyclic_products?.description, unit: a.cyclic_products?.unit,
            cost: Number(a.cyclic_products?.cost) || 0,
        }));
        setAssignments(rows);

        if (rows.length === 0) { setCounts([]); setSessionFinished(false); setRecountFinished(false); setShowRecount(false); return; }
        const assignIds = rows.map(r => r.id);
        const { data: cnts } = await supabase.from("cyclic_counts").select("*").in("assignment_id", assignIds);
        const cRows = (cnts || []) as CountRecord[];

        // Leer flags de sesión guardados como registros especiales en cyclic_counts
        // location = '__session_finished__'  → conteo terminado
        // location = '__recount_started__'   → reconteo iniciado
        // location = '__recount_done__'      → reconteo finalizado
        const sessionFlags = cRows.filter(c => isSessionFlagLocation(c.location));
        const keepRecountOpen = startingRecountRef.current && storeId === selectedStoreId && date === selectedDate;
        const isCounting    = sessionFlags.some(c => c.location === "__session_counting__");
        const isFinished    = sessionFlags.some(c => c.location === "__session_finished__");
        const isRecounting  = keepRecountOpen || sessionFlags.some(c => c.location === "__recount_started__");
        const isRecountDone = sessionFlags.some(c => c.location === "__recount_done__");

        // Conteos reales (excluir filas de flags)
        const realCounts = cRows.filter(c => !isSessionFlagLocation(c.location));
        const enriched = realCounts.map(c => {
            const asg = rows.find(a => a.id === c.assignment_id);
            const diff = r2(Number(c.counted_quantity) - Number(asg?.system_stock || 0));
            return { ...c, sku: asg?.sku, description: asg?.description, unit: asg?.unit, cost: asg?.cost, system_stock: asg?.system_stock, difference: diff };
        });
        setCounts(enriched);

        // Restaurar estado UI desde flags de BD
        // countingStatus: "idle" | "counting" | "finished" | "recounting" | "recount_done"
        const countingStatusVal = isRecountDone ? "recount_done"
            : isRecounting ? "recounting"
            : isFinished ? "finished"
            : isCounting ? "counting"
            : "idle";
        setCountingStatus(countingStatusVal);

        if (isFinished) {
            setSessionFinished(true);
            if (isRecountDone) {
                setRecountFinished(true);
                setShowRecount(false);
            } else if (isRecounting) {
                setRecountFinished(false);
                setShowRecount(true);
            } else {
                setRecountFinished(false);
                setShowRecount(false);
            }
        } else {
            setSessionFinished(false);
            setRecountFinished(false);
            setShowRecount(false);
        }
    }

    async function loadValidadorData(storeId: string, date: string) {
        if (!storeId) return;
        if (storeId === ALL_STORES_VALUE) {
            setAssignments([]);
            setCounts([]);
            await loadAllStoreAssignmentSummary(date);
            return;
        }
        const { data: asgn } = await supabase
            .from("cyclic_assignments")
            .select("*, cyclic_products(sku, barcode, description, unit, cost), stores(name)")
            .eq("store_id", storeId)
            .eq("assigned_date", date)
            .order("created_at");
        const rows: Assignment[] = (asgn || []).map((a: any) => ({
            id: a.id, store_id: a.store_id, product_id: a.product_id,
            system_stock: a.system_stock, assigned_date: a.assigned_date, assigned_by: a.assigned_by,
            sku: a.cyclic_products?.sku, barcode: a.cyclic_products?.barcode,
            description: a.cyclic_products?.description, unit: a.cyclic_products?.unit,
            // Prioridad: cost del assignment > cost del producto maestro
            cost: Number(a.cyclic_products?.cost) || 0,
            store_name: a.stores?.name,
        }));
        setAssignments(rows);

        if (rows.length === 0) { setCounts([]); return; }
        const assignIds = rows.map(r => r.id);
        const { data: cnts } = await supabase.from("cyclic_counts").select("*").in("assignment_id", assignIds);
        const cRows = (cnts || []) as CountRecord[];
        const realCounts = cRows.filter(c => !isSessionFlagLocation(c.location));
        const enriched = realCounts.map(c => {
            const asg = rows.find(a => a.id === c.assignment_id);
            const diff = r2(Number(c.counted_quantity) - Number(asg?.system_stock || 0));
            return { ...c, sku: asg?.sku, description: asg?.description, unit: asg?.unit, cost: asg?.cost, system_stock: asg?.system_stock, difference: diff, store_name: asg?.store_name };
        });
        setCounts(enriched);
    }

    async function loadAllStoreAssignmentSummary(date: string) {
        if (!date) return;
        const targetStores = stores.filter(store => store.is_active);
        const targetStoreIds = new Set(targetStores.map(store => store.id));
        if (targetStoreIds.size === 0) { setAllStoreAssignmentSummary([]); return; }

        setAllStoreSummaryLoading(true);
        try {
            const PAGE = 1000;
            let rows: { id: string; store_id: string; product_id: string }[] = [];
            let page = 0;
            while (true) {
                const { data, error } = await supabase
                    .from("cyclic_assignments")
                    .select("id,store_id,product_id")
                    .eq("assigned_date", date)
                    .in("store_id", [...targetStoreIds])
                    .range(page * PAGE, (page + 1) * PAGE - 1);
                if (error) throw error;
                if (!data || data.length === 0) break;
                rows = rows.concat(data as { id: string; store_id: string; product_id: string }[]);
                if (data.length < PAGE) break;
                page++;
            }

            if (rows.length === 0) { setAllStoreAssignmentSummary([]); return; }

            const grouped = new Map<string, { storeIds: Set<string>; ids: string[] }>();
            for (const row of rows) {
                if (!grouped.has(row.product_id)) grouped.set(row.product_id, { storeIds: new Set(), ids: [] });
                const entry = grouped.get(row.product_id)!;
                entry.storeIds.add(row.store_id);
                entry.ids.push(row.id);
            }

            const productIdsAssignedToAll = [...grouped.entries()]
                .filter(([, entry]) => entry.storeIds.size === targetStoreIds.size)
                .map(([productId]) => productId);

            if (productIdsAssignedToAll.length === 0) { setAllStoreAssignmentSummary([]); return; }

            let productRows: Product[] = [];
            for (let i = 0; i < productIdsAssignedToAll.length; i += 500) {
                const { data, error } = await supabase
                    .from("cyclic_products")
                    .select("id, sku, barcode, description, unit, cost, is_active")
                    .in("id", productIdsAssignedToAll.slice(i, i + 500));
                if (error) throw error;
                productRows = productRows.concat((data || []) as Product[]);
            }
            const productMap = new Map(productRows.map(product => [product.id, product]));

            const summary = productIdsAssignedToAll.map(productId => {
                const product = productMap.get(productId);
                const entry = grouped.get(productId)!;
                return {
                    product_id: productId,
                    sku: product?.sku || productId,
                    description: product?.description || "",
                    unit: product?.unit || "",
                    store_count: entry.storeIds.size,
                    assignment_count: entry.ids.length,
                    all_store_assignment_ids: entry.ids,
                };
            }).sort((a, b) => a.sku.localeCompare(b.sku));

            setAllStoreAssignmentSummary(summary);
        } catch (error: any) {
            showMessage("Error cargando resumen de todas las tiendas: " + (error?.message || error), "error");
        } finally {
            setAllStoreSummaryLoading(false);
        }
    }

    // ════════════════════════════════════════════════════════
    //  VALIDADOR — PROGRESO POR TIENDA
    // ════════════════════════════════════════════════════════
    async function loadStoreProgress(date: string) {
        setStoreProgressLoading(true);
        try {
            // 1. Traer TODAS las asignaciones del día paginado (Supabase limita 1000 por request)
            const PAGE = 1000;
            let asgnData: any[] = [];
            let page = 0;
            while (true) {
                const { data: chunk, error } = await supabase
                    .from("cyclic_assignments")
                    .select("id, store_id")
                    .eq("assigned_date", date)
                    .range(page * PAGE, (page + 1) * PAGE - 1);
                if (error) break;
                if (chunk && chunk.length > 0) asgnData = asgnData.concat(chunk);
                if (!chunk || chunk.length < PAGE) break;
                page++;
            }

            if (asgnData.length === 0) { setStoreProgressData([]); return; }

            // 2. Obtener IDs únicos de tiendas que tienen asignación ese día
            const storeIdsWithAsgn: string[] = Array.from(new Set<string>(asgnData.map((a: any) => a.store_id as string)));

            // 3. Traer nombres de esas tiendas directamente desde BD
            let storesWithNames: any[] = [];
            const STORE_CHUNK = 200;
            for (let i = 0; i < storeIdsWithAsgn.length; i += STORE_CHUNK) {
                const { data: sd } = await supabase
                    .from("stores")
                    .select("id, name")
                    .in("id", storeIdsWithAsgn.slice(i, i + STORE_CHUNK));
                if (sd) storesWithNames = storesWithNames.concat(sd);
            }
            const storeNameMap = new Map(storesWithNames.map((s: any) => [s.id, s.name]));

            // 4. Agrupar asignaciones por tienda
            const asgnByStore = new Map<string, string[]>();
            for (const a of asgnData) {
                if (!asgnByStore.has(a.store_id)) asgnByStore.set(a.store_id, []);
                asgnByStore.get(a.store_id)!.push(a.id);
            }

            // 5. Traer conteos del día (filtrando flags de sesión)
            const asgnIds = asgnData.map((a: any) => a.id);
            const FLAGS = ["__session_counting__","__session_finished__","__recount_started__","__recount_done__"];
            let allCountsRaw: any[] = [];
            const CHUNK = 500;
            for (let i = 0; i < asgnIds.length; i += CHUNK) {
                const { data: cd } = await supabase
                    .from("cyclic_counts")
                    .select("assignment_id, store_id, location")
                    .in("assignment_id", asgnIds.slice(i, i + CHUNK));
                if (cd) allCountsRaw = allCountsRaw.concat(cd);
            }

            // Filtrar flags internos
            const realCounts = allCountsRaw.filter((c: any) => !FLAGS.includes(c.location));

            // 6. Conteos reales por assignment_id
            const countedAsgns = new Set(realCounts.map((c: any) => c.assignment_id));

            // 7. Construir progreso para TODAS las tiendas con asignación ese día
            const result: StoreProgress[] = [];
            for (const storeId of storeIdsWithAsgn) {
                const storeAsgns = asgnByStore.get(storeId) || [];
                const totalAsignados = storeAsgns.length;
                const totalContados = storeAsgns.filter(id => countedAsgns.has(id)).length;
                const pct = totalAsignados > 0 ? Math.round((totalContados / totalAsignados) * 100) : 0;
                result.push({
                    store_id: storeId,
                    store_name: storeNameMap.get(storeId) || storeId,
                    total_asignados: totalAsignados,
                    total_contados: totalContados,
                    pct,
                });
            }

            // Ordenar: primero los incompletos, luego por nombre
            result.sort((a, b) => {
                if (a.pct === 100 && b.pct < 100) return 1;
                if (b.pct === 100 && a.pct < 100) return -1;
                return a.store_name.localeCompare(b.store_name);
            });
            setStoreProgressData(result);
        } catch (e: any) {
            showMessage("Error cargando progreso: " + e.message, "error");
        } finally {
            setStoreProgressLoading(false);
        }
    }

    // ════════════════════════════════════════════════════════
    //  DASHBOARD — CARGA
    // ════════════════════════════════════════════════════════
    async function loadDashboard() {
        setDashLoading(true);
        try {
            let dateFilter: { from: string; to: string };
            if (dashPeriod === "dia") {
                dateFilter = { from: dashDate, to: dashDate };
            } else if (dashPeriod === "rango") {
                dateFilter = { from: dashRangeFrom, to: dashRangeTo };
            } else {
                const [yr, mo] = dashMonth.split("-").map(Number);
                const from = `${dashMonth}-01`;
                const lastDay = new Date(yr, mo, 0).getDate();
                const to = `${dashMonth}-${String(lastDay).padStart(2, "0")}`;
                dateFilter = { from, to };
            }

            // ── Paso 1: traer assignments paginado (sin join) ──────────
            const DASH_PAGE = 1000;
            let asgnRaw: any[] = [];
            let dashP = 0;
            while (true) {
                const { data: chunk, error: eA } = await supabase
                    .from("cyclic_assignments")
                    .select("id, store_id, product_id, system_stock, assigned_date")
                    .gte("assigned_date", dateFilter.from)
                    .lte("assigned_date", dateFilter.to)
                    .order("assigned_date")
                    .order("id")
                    .range(dashP * DASH_PAGE, (dashP + 1) * DASH_PAGE - 1);
                if (eA) { console.error("loadDashboard asgn error", eA); showMessage("Error BD assignments: " + JSON.stringify(eA), "error"); break; }
                if (!chunk || chunk.length === 0) break;
                asgnRaw = asgnRaw.concat(chunk);
                if (chunk.length < DASH_PAGE) break;
                dashP++;
            }

            if (asgnRaw.length === 0) { setDashData([]); setDashLoading(false); showMessage(`Sin asignaciones en ${dateFilter.from} → ${dateFilter.to}`, "error"); return; }

            // ── Paso 2: traer stores y products por IDs únicos ────────
            const uniqueStoreIds = [...new Set(asgnRaw.map((a: any) => a.store_id))];
            const uniqueProdIds  = [...new Set(asgnRaw.map((a: any) => a.product_id))];

            let storesList: any[] = [];
            for (let i = 0; i < uniqueStoreIds.length; i += 500) {
                const { data: sc } = await supabase.from("stores").select("id, name").in("id", uniqueStoreIds.slice(i, i+500));
                storesList = storesList.concat(sc || []);
            }
            const storeMap = new Map(storesList.map((s: any) => [s.id, s.name]));

            let prodsList: any[] = [];
            for (let i = 0; i < uniqueProdIds.length; i += 500) {
                const { data: pc } = await supabase.from("cyclic_products").select("id, cost").in("id", uniqueProdIds.slice(i, i+500));
                prodsList = prodsList.concat(pc || []);
            }
            const prodCostMap = new Map(prodsList.map((p: any) => [p.id, parseCost(p.cost)]));

            // Enriquecer assignments (costo viene solo de cyclic_products)
            const asgnData = asgnRaw.map((a: any) => ({
                ...a,
                cost: 0, // columna no existe en cyclic_assignments, usar cyclic_products
                stores: { name: storeMap.get(a.store_id) || a.store_id },
                cyclic_products: { cost: prodCostMap.get(a.product_id) || 0 },
            }));

            // ── Paso 3: traer counts por assignment_id del período ─────────
            const asgnIds = asgnData.map((a: any) => a.id);
            const asgnIdSet = new Set<string>(asgnIds);
            let cntAll: CountRecord[] = [];
            for (let i = 0; i < asgnIds.length; i += 500) {
                const { data: cChunk } = await supabase
                    .from("cyclic_counts")
                    .select("*")
                    .in("assignment_id", asgnIds.slice(i, i + 500));
                if (cChunk) cntAll = cntAll.concat(cChunk as CountRecord[]);
            }

            // ── Paso 3b: separar flags de conteos reales y construir storeDateFlags ──
            const SESSION_FLAG_VALUES = new Set(["__session_counting__", "__session_finished__", "__recount_started__", "__recount_done__"]);

            // Resolver anchorId → { store_id, date } usando asgnData del período
            const anchorToMeta = new Map<string, { store_id: string; date: string }>();
            for (const a of asgnData as any[]) {
                anchorToMeta.set(a.id, { store_id: a.store_id, date: a.assigned_date });
            }
            // Flags que sí están en cntAll (cuando el bug esté corregido, estarán aquí)
            const storeDateFlags = new Map<string, Set<string>>();
            for (const c of cntAll as any[]) {
                if (!SESSION_FLAG_VALUES.has(c.location)) continue;
                const meta = anchorToMeta.get(c.assignment_id);
                if (!meta) continue;
                const k = `${meta.store_id}__${meta.date}`;
                if (!storeDateFlags.has(k)) storeDateFlags.set(k, new Set());
                storeDateFlags.get(k)!.add(c.location);
            }

            const counts = cntAll.filter(
                (c: any) => !SESSION_FLAG_VALUES.has(c.location) && asgnIdSet.has(c.assignment_id)
            );

            // Agrupar SIEMPRE por tienda+día para calcular cumplimiento por día
            const dayKeyFn = (a: any): string => `${a.store_id}__${a.assigned_date}`;
            const monthKeyFn = (a: any): string => `${a.store_id}__${(a.assigned_date as string).slice(0,7)}`;

            // Construir grupos por día
            const dayGroups = new Map<string, { store_id: string; store_name: string; date: string; asgns: any[]; cnts: CountRecord[] }>();

            for (const a of asgnData as any[]) {
                const k = dayKeyFn(a);
                if (!dayGroups.has(k)) {
                    dayGroups.set(k, {
                        store_id: a.store_id,
                        store_name: a.stores?.name || a.store_id,
                        date: a.assigned_date,
                        asgns: [],
                        cnts: [],
                    });
                }
                dayGroups.get(k)!.asgns.push(a);
            }

            // Construir mapa de assignment_id → asignación para lookups O(1)
            const asgnById = new Map<string, any>();
            for (const a of asgnData as any[]) asgnById.set(a.id, a);

            // Asignar conteos a sus grupos por día
            for (const c of counts) {
                const asgn = asgnById.get(c.assignment_id);
                if (!asgn) continue;
                const k = dayKeyFn(asgn);
                dayGroups.get(k)?.cnts.push(c);
            }

            // Calcular métricas por día
            type DayMetrics = { store_id: string; store_name: string; date: string; ok: number; sobrantes: number; faltantes: number; noContados: number; total: number; eri: number; cumplio: boolean; horaInicio: string|null; horaFin: string|null; duracion: number|null; difVal: number; };
            const dayMetrics: DayMetrics[] = [];

            for (const [, g] of dayGroups) {
                const groupKey = `${g.store_id}__${g.date}`;
                const flagsForGroup = storeDateFlags.get(groupKey) || new Set<string>();

                // Para cada assignment del día, ¿tiene al menos un conteo real?
                const countedAsgIds = new Set(g.cnts.map((c: any) => c.assignment_id));

                // Agrupar por product_id para calcular totales (puede haber >1 assignment por producto)
                const prodMap = new Map<string, { system_stock: number; total_counted: number; contado: boolean }>();
                for (const a of g.asgns) {
                    if (!prodMap.has(a.product_id)) {
                        prodMap.set(a.product_id, { system_stock: a.system_stock, total_counted: 0, contado: false });
                    }
                    // Si cualquier assignment de este producto fue contado, el producto cumplió
                    if (countedAsgIds.has(a.id)) {
                        prodMap.get(a.product_id)!.contado = true;
                    }
                }
                for (const c of g.cnts) {
                    const asgn = asgnById.get(c.assignment_id);
                    if (!asgn) continue;
                    const entry = prodMap.get(asgn.product_id);
                    if (entry) entry.total_counted += Number(c.counted_quantity);
                }

                let ok = 0, sobrantes = 0, faltantes = 0, noContados = 0;
                for (const [, entry] of prodMap) {
                    if (!entry.contado) { noContados++; continue; }
                    const diff = entry.total_counted - entry.system_stock;
                    if (diff === 0) ok++;
                    else if (diff > 0) sobrantes++;
                    else faltantes++;
                }
                const total = prodMap.size;
                // ERI se calcula solo sobre los contados (ok + sobrantes + faltantes)
                const totalContados = ok + sobrantes + faltantes;
                const eri = totalContados > 0 ? Math.round((ok / totalContados) * 100) : 0;

                let difValDay = 0;
                for (const [pid, entry] of prodMap) {
                    if (entry.contado) {
                        const asgForPid = g.asgns.find((a: any) => a.product_id === pid);
                        const costo = parseCost(asgForPid?.cyclic_products?.cost);
                        const diff = r2(entry.total_counted - entry.system_stock);
                        difValDay = r2(difValDay + r2(diff * costo));
                    }
                }

                const timestamps = g.cnts.map((c: any) => new Date(c.counted_at).getTime()).filter((t: number) => !isNaN(t));
                const horaInicio = timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : null;
                const horaFin = timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null;
                const duracion = horaInicio && horaFin ? Math.round((new Date(horaFin).getTime() - new Date(horaInicio).getTime()) / 60000) : null;

                // REGLA DE CUMPLIMIENTO:
                // 1. Principal: presionó "Finalizar Reconteo" (__recount_done__ flag en BD)
                // 2. Fallback para datos históricos antes del fix del bug: contó todos los productos
                const cumplioPorReconteo = flagsForGroup.has("__recount_done__");
                const cumplio = cumplioPorReconteo || (noContados === 0 && total > 0);
                dayMetrics.push({ store_id: g.store_id, store_name: g.store_name, date: g.date, ok, sobrantes, faltantes, noContados, total, eri, cumplio, horaInicio, horaFin, duracion, difVal: difValDay });
            }

            const rows: DashboardRow[] = [];

            if (dashPeriod === "dia") {
                // Vista día: una fila por tienda, con hora inicio/fin/duración
                for (const d of dayMetrics) {
                    const eriExacto = (d.ok + d.sobrantes + d.faltantes) > 0 ? Math.round((d.ok / (d.ok + d.sobrantes + d.faltantes)) * 100) : 0;
                    rows.push({
                        store_id: d.store_id,
                        store_name: d.store_name,
                        date: d.date,
                        total_asignados: d.total,
                        total_asignados_periodo: d.total,
                        total_ok: d.ok,
                        total_sobrantes: d.sobrantes,
                        total_faltantes: d.faltantes,
                        total_no_contados: d.noContados,
                        dif_valorizada: d.difVal,
                        eri: eriExacto,
                        cumplio: d.cumplio,
                        cumplimiento_pct: d.cumplio ? 100 : 0,
                        dias_cumplidos: d.cumplio ? 1 : 0,
                        dias_totales: 1,
                        hora_inicio: d.horaInicio,
                        hora_fin: d.horaFin,
                        duracion_min: d.duracion,
                    });
                }
            } else {
                // Vista mes o rango: una fila por tienda.
                // Totales, ERI y dif. valorizada usan todo el periodo.
                // Cumplimiento % = diasCumplidos / diasTotales con asignación.
                const storeGroups = new Map<string, DayMetrics[]>();
                for (const d of dayMetrics) {
                    if (!storeGroups.has(d.store_id)) storeGroups.set(d.store_id, []);
                    storeGroups.get(d.store_id)!.push(d);
                }
                for (const [, days] of storeGroups) {
                    const first = days[0];
                    const diasTotales = days.length;
                    const diasCumplidos = days.filter(d => d.cumplio).length;
                    const cumplimientoPct = diasTotales > 0 ? Math.round((diasCumplidos / diasTotales) * 100) : 0;
                    const totalAsignadosPeriodo = days.reduce((s, d) => s + d.total, 0);
                    const totalAsignados  = totalAsignadosPeriodo;
                    const daysCumplidos   = days.filter(d => d.cumplio);
                    // OK, sobrantes, faltantes, dif_valorizada: solo días que cumplieron
                    const totalOk         = daysCumplidos.reduce((s, d) => s + d.ok, 0);
                    const totalSobrantes  = daysCumplidos.reduce((s, d) => s + d.sobrantes, 0);
                    const totalFaltantes  = daysCumplidos.reduce((s, d) => s + d.faltantes, 0);
                    const totalNoContados = days.reduce((s, d) => s + d.noContados, 0);
                    const difVal          = daysCumplidos.reduce((s, d) => s + d.difVal, 0);
                    // ERI = OK / contados (ok+sobrantes+faltantes). Cumplimiento se calcula aparte.
                    const totalContadosPeriodo = totalOk + totalSobrantes + totalFaltantes;
                    const eriAgrupado = totalContadosPeriodo > 0 ? Math.round((totalOk / totalContadosPeriodo) * 100) : 0;
                    rows.push({
                        store_id: first.store_id,
                        store_name: first.store_name,
                        date: "",
                        total_asignados: totalAsignados,
                        total_asignados_periodo: totalAsignadosPeriodo,
                        total_ok: totalOk,
                        total_sobrantes: totalSobrantes,
                        total_faltantes: totalFaltantes,
                        total_no_contados: totalNoContados,
                        dif_valorizada: difVal,
                        eri: eriAgrupado,
                        cumplio: diasCumplidos === diasTotales,
                        cumplimiento_pct: cumplimientoPct,
                        dias_cumplidos: diasCumplidos,
                        dias_totales: diasTotales,
                        hora_inicio: null,
                        hora_fin: null,
                        duracion_min: null,
                    });
                }
            }

            rows.sort((a, b) => a.store_name.localeCompare(b.store_name) || a.date.localeCompare(b.date));
            setDashData(rows);
        } finally {
            setDashLoading(false);
        }
    }

    // ════════════════════════════════════════════════════════
    //  OPERARIO — CONTEO (múltiples ubicaciones)
    // ════════════════════════════════════════════════════════
    async function openCount(asgn: Assignment) {
        if (!requireOnlineForStockPhoto()) return;
        const existing = counts.filter(c => c.assignment_id === asgn.id);
        if (existing.length > 0) {
            setLocationRows(existing.map(c => ({ location: c.location, qty: String(c.counted_quantity) })));
        } else {
            setLocationRows([{ location: "", qty: "" }]);
        }
        setSinStock(false);
        setActiveAssignment(asgn);
        const updated = await refreshAssignmentStock(asgn, false, true);
        setActiveAssignment(updated);
        clearMessage();
    }

    function isPendingAssignment(asgn: Assignment | null | undefined): boolean {
        return !!asgn?.id?.startsWith("__pending_assignment__");
    }

    async function ensureAssignmentPersisted(asgn: Assignment): Promise<Assignment> {
        if (!isPendingAssignment(asgn)) return asgn;

        const latestStock = await getSystemStockForStore(asgn.sku || "", asgn.store_id);
        const { data: existing, error: existingError } = await supabase
            .from("cyclic_assignments")
            .select("id, store_id, product_id, system_stock, assigned_date, assigned_by")
            .eq("store_id", asgn.store_id)
            .eq("product_id", asgn.product_id)
            .eq("assigned_date", asgn.assigned_date)
            .maybeSingle();

        if (existingError) throw existingError;

        let persisted: Assignment;
        if (existing?.id) {
            persisted = {
                ...asgn,
                id: existing.id,
                system_stock: Number(existing.system_stock ?? latestStock),
                assigned_by: existing.assigned_by ?? asgn.assigned_by,
            };
        } else {
            const { data: inserted, error } = await supabase
                .from("cyclic_assignments")
                .insert({
                    store_id: asgn.store_id,
                    product_id: asgn.product_id,
                    system_stock: latestStock,
                    assigned_date: asgn.assigned_date,
                    assigned_by: user?.id || asgn.assigned_by,
                })
                .select("id")
                .single();

            if (error) throw error;
            persisted = { ...asgn, id: inserted.id, system_stock: latestStock, assigned_by: user?.id || asgn.assigned_by };
        }

        setAssignments(prev => {
            const withoutTemp = prev.filter(item => item.id !== asgn.id && item.id !== persisted.id);
            return [...withoutTemp, persisted];
        });
        setActiveAssignment(prev => prev?.id === asgn.id ? persisted : prev);
        return persisted;
    }

    function addLocationRow() {
        setLocationRows(prev => [...prev, { location: "", qty: "" }]);
    }

    function removeLocationRow(i: number) {
        setLocationRows(prev => prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i));
    }

    function updateLocationRow(i: number, field: keyof LocationRow, value: string) {
        setLocationRows(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: value } : r));
    }

    async function saveCount() {
        if (!activeAssignment || !user || savingCountRef.current) return;
        if (!requireOnlineForStockPhoto()) return;
        savingCountRef.current = true;
        setSavingCount(true);

        if (!sinStock) {
            for (let i = 0; i < locationRows.length; i++) {
                const row = locationRows[i];
                if (!row.location.trim()) { showMessage(`Fila ${i + 1}: ingresa la ubicacion.`, "error"); savingCountRef.current = false; setSavingCount(false); return; }
                if (row.qty === "") { showMessage(`Fila ${i + 1}: ingresa la cantidad.`, "error"); savingCountRef.current = false; setSavingCount(false); return; }
                const qty = Number(row.qty);
                if (isNaN(qty) || qty < 0) { showMessage(`Fila ${i + 1}: cantidad invalida.`, "error"); savingCountRef.current = false; setSavingCount(false); return; }
                if (qty === 0) {
                    showMessage(`Fila ${i + 1}: cantidad 0 no permitida. Si no hay stock fisico, usa el boton "Sin stock".`, "error");
                    savingCountRef.current = false;
                    setSavingCount(false); return;
                }
            }
        }

        let currentAssignment: Assignment;
        try {
            const persistedAssignment = await ensureAssignmentPersisted(activeAssignment);
            currentAssignment = await refreshAssignmentStock(persistedAssignment, false, true);
        } catch (error: any) {
            showMessage("Error al crear asignacion: " + (error?.message || error), "error");
            savingCountRef.current = false;
            setSavingCount(false);
            return;
        }

        // ── Modo "Sin stock físico" ──────────────────────────
        if (sinStock) {
            // Registrar un único conteo con qty=0 y ubicación especial "__sin_stock__"
            await supabase.from("cyclic_counts").delete().eq("assignment_id", currentAssignment.id);
            const { error } = await supabase.from("cyclic_counts").insert({
                assignment_id: currentAssignment.id,
                store_id: currentAssignment.store_id,
                product_id: currentAssignment.product_id,
                counted_quantity: 0,
                location: "__sin_stock__",
                user_id: user.id,
                user_name: user.full_name,
                status: "Diferencia" as CountRecord["status"],
                note: "Sin stock físico en tienda",
                stock_snapshot: Number(currentAssignment.system_stock || 0),
                client_uuid: createClientUuid("cyclic-count"),
                client_device_id: getOrCreateDeviceId(),
                sync_origin: "web",
                counted_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            });
            if (error) { showMessage("Error al guardar: " + error.message, "error"); savingCountRef.current = false; setSavingCount(false); return; }
            await setSessionFlag(currentAssignment.store_id, selectedDate, "__session_counting__", true);
            showMessage(`✅ "${activeAssignment.sku}" marcado como sin stock.`, "success");
            setSinStock(false);
            setActiveAssignment(null);
            loadOperarioData(selectedStoreId, selectedDate);
            savingCountRef.current = false;
            setSavingCount(false);
            return;
        }

        // ── Validación normal ────────────────────────────────
        for (let i = 0; i < locationRows.length; i++) {
            const row = locationRows[i];
            if (!row.location.trim()) { showMessage(`Fila ${i + 1}: ingresa la ubicación.`, "error"); savingCountRef.current = false; setSavingCount(false); return; }
            if (row.qty === "") { showMessage(`Fila ${i + 1}: ingresa la cantidad.`, "error"); savingCountRef.current = false; setSavingCount(false); return; }
            const qty = Number(row.qty);
            if (isNaN(qty) || qty < 0) { showMessage(`Fila ${i + 1}: cantidad inválida.`, "error"); savingCountRef.current = false; setSavingCount(false); return; }
            // ⛔ No se permite cantidad 0 con ubicación — usar "Sin stock" para eso
            if (qty === 0) {
                showMessage(`Fila ${i + 1}: cantidad 0 no permitida. Si no hay stock físico, usa el botón "Sin stock".`, "error");
                savingCountRef.current = false;
                setSavingCount(false); return;
            }
        }

        await supabase.from("cyclic_counts").delete().eq("assignment_id", currentAssignment.id);

        const totalQty = r2(locationRows.reduce((acc, row) => acc + Number(row.qty || 0), 0));
        const totalDiff = r2(totalQty - Number(currentAssignment.system_stock || 0));
        const status: CountRecord["status"] = totalDiff === 0 ? "Pendiente" : "Diferencia";

        for (const row of locationRows) {
            const qty = Number(row.qty);
            const { error } = await supabase.from("cyclic_counts").insert({
                assignment_id: currentAssignment.id,
                store_id: currentAssignment.store_id,
                product_id: currentAssignment.product_id,
                counted_quantity: qty,
                location: row.location.trim(),
                user_id: user.id,
                user_name: user.full_name,
                status,
                stock_snapshot: Number(currentAssignment.system_stock || 0),
                client_uuid: createClientUuid("cyclic-count"),
                client_device_id: getOrCreateDeviceId(),
                sync_origin: "web",
                counted_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            });
            if (error) { showMessage("Error al guardar: " + error.message, "error"); savingCountRef.current = false; setSavingCount(false); return; }
        }

        // Marcar que hay conteo activo en BD (para que admin/validador lo vean)
        await setSessionFlag(currentAssignment.store_id, selectedDate, "__session_counting__", true);

        showMessage(`✅ ${locationRows.length === 1 ? "Conteo guardado" : `${locationRows.length} ubicaciones guardadas`}.`, "success");
        setSinStock(false);
        setActiveAssignment(null);
        loadOperarioData(selectedStoreId, selectedDate);
        savingCountRef.current = false;
        setSavingCount(false);
    }

    // ════════════════════════════════════════════════════════
    //  OPERARIO — RECONTEO
    // ════════════════════════════════════════════════════════
    async function openRecountPanel() {
        startingRecountRef.current = true;
        setShowRecount(true);
        setRecountFinished(false);
        setRecountAssignment(null);
        setRecountRows([{ location: "", qty: "" }]);
        // Escribir flag __recount_started__ en BD
        await setSessionFlag(selectedStoreId, selectedDate, "__recount_done__", false);
        await setSessionFlag(selectedStoreId, selectedDate, "__recount_started__", true);
        await loadOperarioData(selectedStoreId, selectedDate);
        startingRecountRef.current = false;
        setShowRecount(true);
        clearMessage();
    }

    async function openRecountItem(asgn: Assignment) {
        if (!requireOnlineForStockPhoto()) return;
        const existing = counts.filter(c => c.assignment_id === asgn.id);
        if (existing.length > 0) {
            setRecountRows(existing.map(c => ({ location: c.location, qty: String(c.counted_quantity) })));
        } else {
            setRecountRows([{ location: "", qty: "" }]);
        }
        setSinStockRecount(false);
        setRecountAssignment(asgn);
        const totalContado = existing.reduce((sum, c) => sum + Number(c.counted_quantity || 0), 0);
        const tieneDiferencia = existing.length === 0 || r2(totalContado - Number(asgn.system_stock || 0)) !== 0;
        if (tieneDiferencia) {
            const updated = await refreshAssignmentStock(asgn, false, true);
            setRecountAssignment(updated);
        }
    }

    async function getSystemStockForStore(productSku: string, storeId: string): Promise<number> {
        const store = allStores.find(s => s.id === storeId) || stores.find(s => s.id === storeId);
        const sede = store?.erp_sede || store?.name || "";
        if (!sede) return 0;
        const codsap = fullProductCode(productSku);
        if (!codsap) return 0;

        const { data } = await supabase
            .from("stock_general")
            .select("stock")
            .eq("codsap", codsap)
            .eq("sede", sede)
            .maybeSingle();

        return Number(data?.stock || 0);
    }

    async function filterProductsInStoreStock(productsToFilter: Product[], storeId: string): Promise<Product[]> {
        const store = allStores.find(s => s.id === storeId) || stores.find(s => s.id === storeId);
        const sede = String(store?.erp_sede || store?.name || "").trim();
        if (!sede || productsToFilter.length === 0) return productsToFilter;

        const skus = [...new Set(productsToFilter.map(product => fullProductCode(product.sku)).filter(Boolean))];
        const available = new Set<string>();
        for (let i = 0; i < skus.length; i += 500) {
            const chunk = skus.slice(i, i + 500);
            const { data } = await supabase
                .from("stock_general")
                .select("codsap")
                .eq("sede", sede)
                .in("codsap", chunk);
            for (const row of data || []) available.add(fullProductCode(row.codsap));
        }

        return productsToFilter.filter(product => available.has(fullProductCode(product.sku)));
    }

    async function refreshAssignmentStock(asgn: Assignment, notify = true, forcePersist = false): Promise<Assignment> {
        if (!asgn.sku) return asgn;
        setRefreshingStockId(asgn.id);
        const latestStock = await getSystemStockForStore(asgn.sku, asgn.store_id);
        const updated = { ...asgn, system_stock: latestStock };

        // Si el código ya tiene conteo guardado, el snapshot queda intacto en la BD
        // (foto del momento en que el operario contó). Solo se actualiza en memoria
        // para no alterar el histórico.
        // Si aún no tiene conteo, sí se actualiza en BD para que el snapshot que
        // se grabe al guardar refleje el stock real de ese momento.
        const yaContado = counts.some(c => c.assignment_id === asgn.id);
        if ((forcePersist || !yaContado) && Number(asgn.system_stock || 0) !== latestStock) {
            await supabase
                .from("cyclic_assignments")
                .update({ system_stock: latestStock })
                .eq("id", asgn.id);
        }

        setAssignments(prev => prev.map(item => item.id === asgn.id ? { ...item, system_stock: latestStock } : item));
        setCounts(prev => prev.map(c => c.assignment_id === asgn.id ? {
            ...c,
            system_stock: latestStock,
            difference: r2(Number(c.counted_quantity || 0) - latestStock),
        } : c));
        setActiveAssignment(prev => prev?.id === asgn.id ? { ...prev, system_stock: latestStock } : prev);
        setRecountAssignment(prev => prev?.id === asgn.id ? { ...prev, system_stock: latestStock } : prev);
        setRefreshingStockId(null);

        if (notify) {
            const changed = Number(asgn.system_stock || 0) !== latestStock;
            showMessage(changed ? `Stock actualizado de ${formatNumber(asgn.system_stock)} a ${formatNumber(latestStock)}.` : "Stock sistema ya está actualizado.", "success");
        }
        return updated;
    }

    async function refreshAssignedStocks() {
        if (!selectedStoreId || assignments.length === 0 || bulkRefreshingStocks) return;
        const store = allStores.find(s => s.id === selectedStoreId) || stores.find(s => s.id === selectedStoreId);
        const sede = String(store?.erp_sede || store?.name || "").trim();
        if (!sede) {
            showMessage("No se encontró sede ERP para actualizar stock.", "error");
            return;
        }

        setBulkRefreshingStocks(true);
        const skus = [...new Set(assignments.map(a => fullProductCode(a.sku || "")).filter(Boolean))];
        const stockMap = new Map<string, number>();
        const chunkSize = 500;
        for (let i = 0; i < skus.length; i += chunkSize) {
            const chunk = skus.slice(i, i + chunkSize);
            const { data, error } = await supabase
                .from("stock_general")
                .select("codsap, stock")
                .eq("sede", sede)
                .in("codsap", chunk);
            if (error) {
                setBulkRefreshingStocks(false);
                showMessage("Error actualizando stocks: " + error.message, "error");
                return;
            }
            for (const row of data || []) stockMap.set(fullProductCode(row.codsap), Number(row.stock || 0));
        }

        const countedIds = new Set(counts.map(c => c.assignment_id));

        const updates = assignments
            .map(a => ({ assignment: a, stock: stockMap.get(fullProductCode(a.sku || "")) ?? Number(a.system_stock || 0) }))
            .filter(row => Number(row.assignment.system_stock || 0) !== row.stock);

        if (updates.length > 0) {
            // Solo escribe en BD los que aún no tienen conteo guardado (snapshot no sellado).
            // Los ya contados se actualizan solo en memoria para no alterar su histórico.
            const toWriteDB = updates.filter(row => !countedIds.has(row.assignment.id));
            for (let i = 0; i < toWriteDB.length; i += 100) {
                const batch = toWriteDB.slice(i, i + 100);
                await Promise.all(batch.map(row =>
                    supabase
                        .from("cyclic_assignments")
                        .update({ system_stock: row.stock })
                        .eq("id", row.assignment.id)
                ));
            }

            const updateMap = new Map(updates.map(row => [row.assignment.id, row.stock]));
            setAssignments(prev => prev.map(a => updateMap.has(a.id) ? { ...a, system_stock: updateMap.get(a.id)! } : a));
            setCounts(prev => prev.map(c => updateMap.has(c.assignment_id) ? {
                ...c,
                system_stock: updateMap.get(c.assignment_id)!,
                difference: r2(Number(c.counted_quantity || 0) - updateMap.get(c.assignment_id)!),
            } : c));
        }

        setBulkRefreshingStocks(false);
        showMessage(updates.length > 0 ? `${updates.length} stock${updates.length !== 1 ? "s" : ""} actualizado${updates.length !== 1 ? "s" : ""}.` : "Todos los stocks asignados ya están actualizados.", "success");
    }

    async function refreshValidatorAssignedStocksForDate() {
        if (!valDate || bulkRefreshingStocks) return;
        setBulkRefreshingStocks(true);
        try {
            const PAGE = 1000;
            let rowsRaw: any[] = [];
            let page = 0;
            while (true) {
                const { data, error } = await supabase
                    .from("cyclic_assignments")
                    .select("id, store_id, product_id, system_stock, assigned_date, cyclic_products(sku), stores(name, erp_sede)")
                    .eq("assigned_date", valDate)
                    .order("id")
                    .range(page * PAGE, (page + 1) * PAGE - 1);
                if (error) throw error;
                if (!data || data.length === 0) break;
                rowsRaw = rowsRaw.concat(data);
                if (data.length < PAGE) break;
                page++;
            }

            if (rowsRaw.length === 0) {
                showMessage("No hay asignaciones para actualizar en esta fecha.", "info");
                return;
            }

            const assignmentIds = rowsRaw.map(row => row.id as string);
            const countedIds = new Set<string>();
            for (let i = 0; i < assignmentIds.length; i += 500) {
                const { data, error } = await supabase
                    .from("cyclic_counts")
                    .select("assignment_id, location")
                    .in("assignment_id", assignmentIds.slice(i, i + 500));
                if (error) throw error;
                for (const row of data || []) {
                    if (!isSessionFlagLocation(row.location)) countedIds.add(row.assignment_id);
                }
            }

            const pendingRows = rowsRaw.filter(row => !countedIds.has(row.id));
            const codesBySede = new Map<string, Set<string>>();
            for (const row of pendingRows) {
                const store = Array.isArray(row.stores) ? row.stores[0] : row.stores;
                const product = Array.isArray(row.cyclic_products) ? row.cyclic_products[0] : row.cyclic_products;
                const sede = String(store?.erp_sede || store?.name || "").trim();
                const codsap = fullProductCode(product?.sku || "");
                if (!sede || !codsap) continue;
                if (!codesBySede.has(sede)) codesBySede.set(sede, new Set());
                codesBySede.get(sede)!.add(codsap);
            }

            const stockMap = new Map<string, number>();
            for (const [sede, codes] of codesBySede) {
                const list = [...codes];
                for (let i = 0; i < list.length; i += 500) {
                    const { data, error } = await supabase
                        .from("stock_general")
                        .select("codsap, stock")
                        .eq("sede", sede)
                        .in("codsap", list.slice(i, i + 500));
                    if (error) throw error;
                    for (const row of data || []) stockMap.set(`${sede}::${fullProductCode(row.codsap)}`, Number(row.stock || 0));
                }
            }

            const updates: { id: string; system_stock: number }[] = [];
            for (const row of pendingRows) {
                const store = Array.isArray(row.stores) ? row.stores[0] : row.stores;
                const product = Array.isArray(row.cyclic_products) ? row.cyclic_products[0] : row.cyclic_products;
                const sede = String(store?.erp_sede || store?.name || "").trim();
                const codsap = fullProductCode(product?.sku || "");
                if (!sede || !codsap) continue;
                const latestStock = stockMap.get(`${sede}::${codsap}`) ?? 0;
                if (Number(row.system_stock || 0) !== latestStock) updates.push({ id: row.id, system_stock: latestStock });
            }

            for (let i = 0; i < updates.length; i += 100) {
                const batch = updates.slice(i, i + 100);
                await Promise.all(batch.map(row =>
                    supabase.from("cyclic_assignments").update({ system_stock: row.system_stock }).eq("id", row.id)
                ));
            }

            const updateMap = new Map(updates.map(row => [row.id, row.system_stock]));
            if (updateMap.size > 0) {
                setAssignments(prev => prev.map(row => updateMap.has(row.id) ? { ...row, system_stock: updateMap.get(row.id)! } : row));
            }
            if (valStoreId && valStoreId !== ALL_STORES_VALUE) await loadValidadorData(valStoreId, valDate);

            const skipped = rowsRaw.length - pendingRows.length;
            showMessage(
                updates.length > 0
                    ? `Stock actualizado en ${updates.length} asignacion${updates.length !== 1 ? "es" : ""} de ${valDate}.${skipped > 0 ? ` ${skipped} ya tenian conteo y se conservaron.` : ""}`
                    : `Los stocks asignados de ${valDate} ya estan actualizados.${skipped > 0 ? ` ${skipped} ya tenian conteo y se conservaron.` : ""}`,
                "success"
            );
        } catch (error: any) {
            showMessage("Error actualizando stock asignado: " + (error?.message || error), "error");
        } finally {
            setBulkRefreshingStocks(false);
        }
    }

    async function findManualProductCandidates(codeValue: string): Promise<Product[]> {
        const code = fullProductCode(codeValue);
        if (!code) return [];

        const { data, error } = await supabase
            .from("cyclic_products")
            .select("*")
            .eq("is_active", true)
            .ilike("sku", `%${code}%`);

        if (error) {
            showMessage("Error buscando codigo manual: " + error.message, "error");
            return [];
        }

        const candidates = await filterProductsInStoreStock(preferFullCodsapProducts((data || []) as Product[]), selectedStoreId);
        if (!selectedStoreId || candidates.length === 0) return candidates;

        const enriched = await Promise.all(candidates.map(async product => ({
            ...product,
            system_stock: await getSystemStockForStore(product.sku, selectedStoreId),
        })));
        return enriched;
    }

    async function findProductBySystemBarcode(scanned: string): Promise<Product | "AMBIGUOUS" | null> {
        const raw = String(scanned || "").trim();
        if (!raw) return null;

        const [{ data: byUpc }, { data: byAlu }] = await Promise.all([
            supabase.from("codigos_barra").select("codsap,upc,alu").eq("upc", raw).not("codsap", "is", null).limit(20),
            supabase.from("codigos_barra").select("codsap,upc,alu").eq("alu", raw).not("codsap", "is", null).limit(20),
        ]);
        const barcodeRows = [...(byUpc || []), ...(byAlu || [])];
        const mappedCodes = [...new Set(barcodeRows.flatMap(row => mappedProductCodeCandidates(row as Record<string, unknown>)))];
        const mappedProducts: Product[] = [];

        for (const mappedCode of mappedCodes) {
            const { data: product } = await supabase
                .from("cyclic_products")
                .select("*")
                .eq("sku", mappedCode)
                .eq("is_active", true)
                .maybeSingle();

            if (product) mappedProducts.push(product as Product);
        }

        const stockMappedProducts = selectedStoreId
            ? await filterProductsInStoreStock(mappedProducts, selectedStoreId)
            : mappedProducts;

        if (stockMappedProducts.length === 1) return stockMappedProducts[0];
        if (stockMappedProducts.length > 1) {
            const enriched = selectedStoreId
                ? await Promise.all(stockMappedProducts.map(async product => ({
                    ...product,
                    system_stock: await getSystemStockForStore(product.sku, selectedStoreId),
                })))
                : stockMappedProducts;
            setManualProductCodePending(raw);
            setManualProductCandidates(enriched);
            showMessage(`El codigo de barra ${raw} existe en ${stockMappedProducts.length} codigos. Elige el correcto.`, "info");
            return "AMBIGUOUS";
        }

        const { data: bySku } = await supabase
            .from("cyclic_products")
            .select("*")
            .eq("sku", fullProductCode(raw))
            .eq("is_active", true)
            .maybeSingle();
        if (bySku) {
            const productsInStore = selectedStoreId ? await filterProductsInStoreStock([bySku as Product], selectedStoreId) : [bySku as Product];
            if (productsInStore.length === 1) return productsInStore[0];
        }

        const { data: byProductBarcode } = await supabase
            .from("cyclic_products")
            .select("*")
            .eq("barcode", raw)
            .eq("is_active", true)
            .maybeSingle();
        if (byProductBarcode) {
            const productsInStore = selectedStoreId ? await filterProductsInStoreStock([byProductBarcode as Product], selectedStoreId) : [byProductBarcode as Product];
            if (productsInStore.length === 1) return productsInStore[0];
        }

        return null;
    }

    async function openScannedProduct(product: Product) {
        if (!selectedStoreId || !selectedDate || !user) {
            showMessage("Selecciona tienda y fecha antes de escanear.", "error");
            return;
        }

        const alreadyAssigned = assignments.find(a => a.product_id === product.id);
        if (alreadyAssigned) {
            if (showRecount) await openRecountItem(alreadyAssigned);
            else await openCount(alreadyAssigned);
            return;
        }

        const stock = await getSystemStockForStore(product.sku, selectedStoreId);
        const { data: existing } = await supabase
            .from("cyclic_assignments")
            .select("id, store_id, product_id, system_stock, assigned_date, assigned_by")
            .eq("store_id", selectedStoreId)
            .eq("product_id", product.id)
            .eq("assigned_date", selectedDate)
            .maybeSingle();

        const asgn: Assignment = {
            id: existing?.id || `__pending_assignment__${product.id}`,
            store_id: selectedStoreId,
            product_id: product.id,
            system_stock: Number(existing?.system_stock ?? stock),
            assigned_date: selectedDate,
            assigned_by: existing?.assigned_by ?? user.id,
            sku: product.sku,
            barcode: product.barcode,
            description: product.description,
            unit: product.unit,
            cost: Number(product.cost) || 0,
        };

        if (existing?.id) {
            setAssignments(prev => prev.some(a => a.id === asgn.id) ? prev : [...prev, asgn]);
            if (showRecount) await openRecountItem(asgn);
            else await openCount(asgn);
            return;
        }

        if (showRecount) {
            showMessage("Este codigo no esta asignado para reconteo.", "error");
            return;
        }

        setLocationRows([{ location: "", qty: "" }]);
        setSinStock(false);
        setActiveAssignment(asgn);
        clearMessage();
    }

    async function addProductByCode(codeValue: string, clearTypedInput = false) {
        const code = codeValue.trim();
        if (!code) {
            showMessage("Digita un codigo para agregar.", "error");
            return;
        }

        if (clearTypedInput) {
            const candidates = await findManualProductCandidates(code);
            if (candidates.length > 1) {
                setManualProductCodePending(code);
                setManualProductCandidates(candidates);
                showMessage(`El codigo ${visibleProductCode(code)} existe en ${candidates.length} codigos. Elige el correcto.`, "info");
                return;
            }
            if (candidates.length === 1) {
                await openScannedProduct(candidates[0]);
                setManualProductCode("");
                return;
            }
        }

        const found = await findProductBySystemBarcode(code);
        if (found === "AMBIGUOUS") return;
        if (!found) {
            showMessage(`Codigo "${visibleProductCode(code) || fullProductCode(code)}" no encontrado en el maestro ni en UPC/ALU.`, "error");
            return;
        }

        await openScannedProduct(found);
        if (clearTypedInput) setManualProductCode("");
    }

    async function addProductByTypedCode() {
        await addProductByCode(manualProductCode, true);
    }

    function addRecountRow() { setRecountRows(prev => [...prev, { location: "", qty: "" }]); }
    function removeRecountRow(i: number) { setRecountRows(prev => prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)); }
    function updateRecountRow(i: number, field: keyof LocationRow, value: string) {
        setRecountRows(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: value } : r));
    }

    async function saveRecount() {
        if (!recountAssignment || !user || savingRecountRef.current) return;
        if (!requireOnlineForStockPhoto()) return;
        savingRecountRef.current = true;
        setSavingRecount(true);
        const currentRecountAssignment = await refreshAssignmentStock(recountAssignment, false, true);

        // ── Modo "Sin stock físico" en reconteo ──────────────
        if (sinStockRecount) {
            await supabase.from("cyclic_counts").delete().eq("assignment_id", currentRecountAssignment.id);
            const { error } = await supabase.from("cyclic_counts").insert({
                assignment_id: currentRecountAssignment.id,
                store_id: currentRecountAssignment.store_id,
                product_id: currentRecountAssignment.product_id,
                counted_quantity: 0,
                location: "__sin_stock__",
                user_id: user.id,
                user_name: user.full_name,
                status: "Diferencia" as CountRecord["status"],
                note: "Sin stock físico en tienda",
                stock_snapshot: Number(currentRecountAssignment.system_stock || 0),
                client_uuid: createClientUuid("cyclic-recount"),
                client_device_id: getOrCreateDeviceId(),
                sync_origin: "web",
                counted_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            });
            if (error) { showMessage("Error al guardar reconteo: " + error.message, "error"); savingRecountRef.current = false; setSavingRecount(false); return; }
            showMessage(`✅ "${recountAssignment.sku}" marcado como sin stock.`, "success");
            setSinStockRecount(false);
            setRecountAssignment(null);
            setRecountRows([{ location: "", qty: "" }]);
            savingRecountRef.current = false;
            setSavingRecount(false);
            loadOperarioData(selectedStoreId, selectedDate);
            return;
        }

        // ── Validación normal ────────────────────────────────
        for (let i = 0; i < recountRows.length; i++) {
            const row = recountRows[i];
            if (!row.location.trim()) { showMessage(`Fila ${i + 1}: ingresa la ubicación.`, "error"); savingRecountRef.current = false; setSavingRecount(false); return; }
            if (row.qty === "") { showMessage(`Fila ${i + 1}: ingresa la cantidad.`, "error"); savingRecountRef.current = false; setSavingRecount(false); return; }
            const qty = Number(row.qty);
            if (isNaN(qty) || qty < 0) { showMessage(`Fila ${i + 1}: cantidad inválida.`, "error"); savingRecountRef.current = false; setSavingRecount(false); return; }
            if (qty === 0) {
                showMessage(`Fila ${i + 1}: cantidad 0 no permitida. Usa el botón "Sin stock" si no hay producto físico.`, "error");
                savingRecountRef.current = false;
                setSavingRecount(false); return;
            }
        }

        await supabase.from("cyclic_counts").delete().eq("assignment_id", currentRecountAssignment.id);

        const totalQty = r2(recountRows.reduce((acc, row) => acc + Number(row.qty || 0), 0));
        const totalDiff = r2(totalQty - Number(currentRecountAssignment.system_stock || 0));
        const status: CountRecord["status"] = totalDiff === 0 ? "Corregido" : "Diferencia";

        for (const row of recountRows) {
            const qty = Number(row.qty);
            const { error } = await supabase.from("cyclic_counts").insert({
                assignment_id: currentRecountAssignment.id,
                store_id: currentRecountAssignment.store_id,
                product_id: currentRecountAssignment.product_id,
                counted_quantity: qty,
                location: row.location.trim(),
                user_id: user.id,
                user_name: user.full_name,
                status,
                stock_snapshot: Number(currentRecountAssignment.system_stock || 0),
                client_uuid: createClientUuid("cyclic-recount"),
                client_device_id: getOrCreateDeviceId(),
                sync_origin: "web",
                counted_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            });
            if (error) { showMessage("Error al guardar reconteo: " + error.message, "error"); savingRecountRef.current = false; setSavingRecount(false); return; }
        }

        showMessage(`✅ Reconteo guardado para ${recountAssignment.sku}.`, "success");
        setSinStockRecount(false);
        setRecountAssignment(null);
        setRecountRows([{ location: "", qty: "" }]);
        savingRecountRef.current = false;
        setSavingRecount(false);
        loadOperarioData(selectedStoreId, selectedDate);
    }

    async function finalizeRecount() {
        const currentDiffs = difAssignments.length;
        if (currentDiffs > 2 && !confirm(`¿Estás segura de culminar reconteo? Tenemos ${currentDiffs} códigos con diferencia.`)) {
            return;
        }

        // Marcar todos los conteos reales con diferencia como "Corregido"
        const difCounts = counts.filter(c => c.difference !== 0);
        if (difCounts.length > 0) {
            await supabase.from("cyclic_counts")
                .update({ status: "Corregido", updated_at: new Date().toISOString() })
                .in("id", difCounts.map(c => c.id));
        }
        // Actualizar flags en BD: reconteo terminado
        startingRecountRef.current = false;
        await setSessionFlag(selectedStoreId, selectedDate, "__recount_started__", false);
        await setSessionFlag(selectedStoreId, selectedDate, "__recount_done__", true);
        setShowRecount(false);
        setRecountFinished(true);
        setRecountAssignment(null);
        showMessage("GENIAL, CULMINASTE CON TUS ASIGNACIONES ✅", "success");
        loadOperarioData(selectedStoreId, selectedDate);
    }

    // ════════════════════════════════════════════════════════
    //  WHATSAPP — ALERTA AL OPERARIO
    // ════════════════════════════════════════════════════════
    async function sendWhatsappAlert(storeId: string, date: string, codigosCount: number) {
        // Buscar el operario activo asignado a esa tienda
        const { data: operario } = await supabase
            .from("cyclic_users")
            .select("full_name, whatsapp")
            .eq("store_id", storeId)
            .eq("role", "Operario")
            .eq("is_active", true)
            .maybeSingle();
        if (!operario || !operario.whatsapp) return; // sin número, no hacer nada
        const storeName = allStores.find(s => s.id === storeId)?.name || "tu tienda";
        const mensaje = `Hola ${operario.full_name} 👋, se te han asignado *${codigosCount} código${codigosCount !== 1 ? "s" : ""}* para contar en *${storeName}* el día *${date}*. Por favor ingresa a la app para realizar el conteo cíclico. ¡Gracias!`;
        const url = `https://wa.me/${operario.whatsapp}?text=${encodeURIComponent(mensaje)}`;
        window.open(url, "_blank");
    }

    // ════════════════════════════════════════════════════════
    //  VALIDADOR — ASIGNAR PRODUCTOS
    // ════════════════════════════════════════════════════════
    function isNonInventoryProduct(product: Product | null | undefined): boolean {
        if (!product) return false;
        return nonInventorySkuSet.has(fullProductCode(product.sku).toUpperCase());
    }

    function filterAssignableProducts(rows: Product[]): Product[] {
        return rows.filter(product => !isNonInventoryProduct(product));
    }

    function activeAssignStores(): Store[] {
        if (valStoreId === ALL_STORES_VALUE) return stores.filter(store => store.is_active);
        const selected = stores.find(store => store.id === valStoreId);
        return selected ? [selected] : [];
    }

    function toggleAssignSelection(productId: string) {
        setAssignSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(productId)) next.delete(productId);
            else next.add(productId);
            return next;
        });
    }

    function toggleAllAssignResults() {
        setAssignSelectedIds(prev => {
            const visibleIds = assignResults.map(product => product.id);
            const allSelected = visibleIds.length > 0 && visibleIds.every(id => prev.has(id));
            if (allSelected) return new Set([...prev].filter(id => !visibleIds.includes(id)));
            return new Set([...prev, ...visibleIds]);
        });
    }

    async function searchProductsByTypedCode(text: string, limit = 120): Promise<Product[]> {
        const code = fullProductCode(text);
        if (code.length < 3) return [];

        const { data } = await supabase
            .from("cyclic_products")
            .select("*")
            .eq("is_active", true)
            .ilike("sku", `%${code}%`)
            .limit(limit);

        const preferred = filterAssignableProducts(preferFullCodsapProducts((data || []) as Product[]));
        return valStoreId && valStoreId !== ALL_STORES_VALUE
            ? await filterProductsInStoreStock(preferred, valStoreId)
            : preferred;
    }

    async function searchProductsForAssign(text: string) {
        setAssignSearch(text);
        if (!text.trim()) { setAssignResults([]); return; }
        const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const byCode = await searchProductsByTypedCode(text);
        let q = supabase.from("cyclic_products").select("*").eq("is_active", true);
        for (const w of words) q = q.ilike("description", `%${w}%`);
        const { data: byDesc } = await q.limit(200);
        const descRows = filterAssignableProducts((byDesc || []) as Product[]);
        const stockFilteredDesc = valStoreId && valStoreId !== ALL_STORES_VALUE
            ? await filterProductsInStoreStock(descRows, valStoreId)
            : descRows;
        const combined = [...byCode, ...stockFilteredDesc];
        const seen = new Set<string>();
        const deduped = combined.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
        const nextResults = filterAssignableProducts(preferFullCodsapProducts(deduped as Product[])).slice(0, 120);
        setAssignResults(nextResults);
        setAssignSelectedIds(new Set(nextResults.slice(0, 30).map(product => product.id)));
    }

    async function assignProductsToStores(productsToAssign: Product[], modeLabel = "seleccionados") {
        const cleanProducts = filterAssignableProducts(productsToAssign);
        if (cleanProducts.length === 0) { showMessage("No hay productos asignables seleccionados.", "error"); return; }
        if (!valDate) { showMessage("Selecciona fecha.", "error"); return; }
        const targetStores = activeAssignStores();
        if (targetStores.length === 0) { showMessage("Selecciona tienda o Todas las tiendas.", "error"); return; }
        if (assignBusy) return;

        setAssignBusy(true);
        try {
            const productCodes = [...new Set(cleanProducts.map(product => fullProductCode(product.sku)).filter(Boolean))];
            const sedes = [...new Set(targetStores.map(store => String(store.erp_sede || store.name || "").trim()).filter(Boolean))];
            const stockByStoreSku = new Map<string, number>();
            for (let i = 0; i < productCodes.length; i += 500) {
                const chunk = productCodes.slice(i, i + 500);
                let query = supabase.from("stock_general").select("sede,codsap,stock").in("codsap", chunk);
                if (sedes.length > 0) query = query.in("sede", sedes);
                const { data, error } = await query;
                if (error) throw error;
                for (const row of data || []) stockByStoreSku.set(`${String(row.sede || "").trim()}__${fullProductCode(row.codsap)}`, Number(row.stock || 0));
            }

            const storeIds = targetStores.map(store => store.id);
            const productIds = cleanProducts.map(product => product.id);
            const existingRows: { id: string; store_id: string; product_id: string }[] = [];
            for (let i = 0; i < storeIds.length; i += 100) {
                const storeChunk = storeIds.slice(i, i + 100);
                for (let j = 0; j < productIds.length; j += 500) {
                    const productChunk = productIds.slice(j, j + 500);
                    const { data, error } = await supabase
                        .from("cyclic_assignments")
                        .select("id,store_id,product_id")
                        .in("store_id", storeChunk)
                        .in("product_id", productChunk)
                        .eq("assigned_date", valDate);
                    if (error) throw error;
                    existingRows.push(...((data || []) as { id: string; store_id: string; product_id: string }[]));
                }
            }

            const existingKeys = new Set(existingRows.map(row => `${row.store_id}__${row.product_id}`));
            const toInsert: any[] = [];
            for (const store of targetStores) {
                const sede = String(store.erp_sede || store.name || "").trim();
                for (const product of cleanProducts) {
                    const key = `${store.id}__${product.id}`;
                    if (existingKeys.has(key)) continue;
                    toInsert.push({
                        store_id: store.id,
                        product_id: product.id,
                        system_stock: stockByStoreSku.get(`${sede}__${fullProductCode(product.sku)}`) ?? 0,
                        assigned_date: valDate,
                        assigned_by: user?.id,
                    });
                }
            }

            let inserted = 0;
            for (let i = 0; i < toInsert.length; i += 500) {
                const batch = toInsert.slice(i, i + 500);
                const { error } = await supabase.from("cyclic_assignments").insert(batch);
                if (error) throw error;
                inserted += batch.length;
            }

            const skipped = (targetStores.length * cleanProducts.length) - inserted;
            showMessage(`✅ ${inserted} asignaciones creadas (${modeLabel}). ${skipped > 0 ? `${skipped} ya existian o fueron omitidas.` : ""}`, inserted > 0 ? "success" : "info");
            if (valStoreId && valStoreId !== ALL_STORES_VALUE) loadValidadorData(valStoreId, valDate);
            else { setAssignments([]); setCounts([]); loadAllStoreAssignmentSummary(valDate); }
        } catch (error: any) {
            showMessage("Error al asignar: " + (error?.message || error), "error");
        } finally {
            setAssignBusy(false);
        }
    }

    async function assignProduct(product: Product) {
        await assignProductsToStores([product], product.sku);
    }

    async function assignFirst30Results() {
        await assignProductsToStores(assignResults.slice(0, 30), "30 primeros");
    }

    async function assignSelectedResults() {
        const selected = assignResults.filter(product => assignSelectedIds.has(product.id));
        await assignProductsToStores(selected, "seleccionados");
    }

    async function saveNonInventoryCodes(codesRaw: Array<string | number | null | undefined>, sourceLabel = "manual"): Promise<number | null> {
        const codes = codesRaw
            .map(code => fullProductCode(code).toUpperCase())
            .filter(Boolean);
        const uniqueCodes = [...new Set(codes)];
        if (uniqueCodes.length === 0) { showMessage("Ingresa al menos un codigo.", "error"); return null; }

        const productsBySku = new Map<string, Product>();
        for (let i = 0; i < uniqueCodes.length; i += 500) {
            const chunk = uniqueCodes.slice(i, i + 500);
            const { data, error } = await supabase.from("cyclic_products").select("*").in("sku", chunk).eq("is_active", true);
            if (error) { showMessage("Error buscando codigos: " + error.message, "error"); return null; }
            for (const product of data || []) productsBySku.set(fullProductCode(product.sku), product as Product);
        }

        const rows = uniqueCodes.map(code => {
            const product = productsBySku.get(code);
            return {
                product_id: product?.id || null,
                sku: product?.sku || code,
                description: product?.description || null,
                is_active: true,
                updated_at: new Date().toISOString(),
                updated_by: user?.id || null,
            };
        });

        for (let i = 0; i < rows.length; i += 500) {
            const { error } = await supabase
                .from("cyclic_non_inventory_products")
                .upsert(rows.slice(i, i + 500), { onConflict: "sku" });
            if (error) { showMessage("Error guardando no inventariables: " + error.message, "error"); return null; }
        }

        await loadNonInventoryProducts();
        setAssignResults(prev => prev.filter(product => !uniqueCodes.includes(fullProductCode(product.sku))));
        setAssignSelectedIds(prev => new Set([...prev].filter(id => !assignResults.some(product => product.id === id && uniqueCodes.includes(fullProductCode(product.sku))))));
        showMessage(`✅ ${rows.length} codigo${rows.length !== 1 ? "s" : ""} marcado${rows.length !== 1 ? "s" : ""} como no inventariable${sourceLabel === "excel" ? " desde Excel" : ""}.`, "success");
        return rows.length;
    }

    async function addNonInventoryCodes() {
        const saved = await saveNonInventoryCodes(nonInventoryInput.split(/[\n,;]+/), "manual");
        if (saved !== null) setNonInventoryInput("");
    }

    async function uploadNonInventoryExcel(file: File | null) {
        if (!file || nonInventoryExcelBusy) return;
        setNonInventoryExcelBusy(true);
        setNonInventoryExcelFileName(file.name);
        try {
            const data = await file.arrayBuffer();
            const wb = XLSX.read(data, { type: "array" });
            const sheet = wb.Sheets[wb.SheetNames[0]];
            const allRows: any[][] = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false, header: 1 });
            const firstCol = allRows
                .map(row => String(row?.[0] ?? "").trim())
                .filter(Boolean);
            const header = firstCol[0]?.toLowerCase() || "";
            const hasHeader = ["codigo", "código", "codsap", "cod.sap", "sku", "producto"].some(label => header.includes(label));
            const codes = hasHeader ? firstCol.slice(1) : firstCol;
            await saveNonInventoryCodes(codes, "excel");
        } catch (error: any) {
            showMessage("Error leyendo Excel de no inventariables: " + (error?.message || error), "error");
        } finally {
            setNonInventoryExcelBusy(false);
            if (nonInventoryExcelRef.current) nonInventoryExcelRef.current.value = "";
        }
    }

    async function removeNonInventoryCode(row: NonInventoryProduct) {
        const { error } = await supabase
            .from("cyclic_non_inventory_products")
            .update({ is_active: false, updated_at: new Date().toISOString(), updated_by: user?.id || null })
            .eq("id", row.id);
        if (error) { showMessage("Error quitando no inventariable: " + error.message, "error"); return; }
        await loadNonInventoryProducts();
        showMessage("Codigo habilitado para asignacion.", "success");
    }

    async function assignProductLegacy(product: Product) {
        if (!valStoreId || !valDate) { showMessage("Selecciona tienda y fecha.", "error"); return; }
        const { data: existing } = await supabase.from("cyclic_assignments")
            .select("id").eq("store_id", valStoreId).eq("product_id", product.id).eq("assigned_date", valDate).maybeSingle();
        if (existing) { showMessage("Este producto ya está asignado para esa tienda y fecha.", "error"); return; }
        const stock = await getSystemStockForStore(product.sku, valStoreId);
        const { error } = await supabase.from("cyclic_assignments").insert({
            store_id: valStoreId, product_id: product.id, system_stock: stock,
            assigned_date: valDate, assigned_by: user?.id,
        });
        if (error) { showMessage("Error al asignar: " + error.message, "error"); return; }
        showMessage("✅ \"" + product.sku + "\" asignado con stock sistema " + stock + ".", "success");
        loadValidadorData(valStoreId, valDate);
    }

    async function removeAssignment(asgn: Assignment) {
        if (!confirm(`¿Eliminar asignación de "${asgn.sku}"? Si ya fue contado, el conteo también se eliminará.`)) return;
        await supabase.from("cyclic_counts").delete().eq("assignment_id", asgn.id);
        const { error } = await supabase.from("cyclic_assignments").delete().eq("id", asgn.id);
        if (error) { showMessage("Error al eliminar: " + error.message, "error"); return; }
        showMessage("✅ Asignación eliminada.", "success");
        loadValidadorData(valStoreId, valDate);
    }

    async function removeAllAssignments() {
        if (assignments.length === 0) return;
        if (!confirm(`¿Eliminar TODAS las ${assignments.length} asignaciones de este día? También se eliminarán todos los conteos asociados.`)) return;
        const ids = assignments.map(a => a.id);
        const CHUNK = 400;
        for (let i = 0; i < ids.length; i += CHUNK) {
            await supabase.from("cyclic_counts").delete().in("assignment_id", ids.slice(i, i + CHUNK));
            await supabase.from("cyclic_assignments").delete().in("id", ids.slice(i, i + CHUNK));
        }
        showMessage(`✅ ${ids.length} asignaciones eliminadas.`, "success");
        loadValidadorData(valStoreId, valDate);
    }

    async function removeAllStoresProductAssignments(row: AllStoreAssignmentSummary) {
        const ids = row.all_store_assignment_ids;
        if (ids.length === 0) return;
        if (!confirm(`Eliminar "${row.sku}" de todas las tiendas para ${valDate}? Tambien se eliminaran los conteos asociados.`)) return;

        const CHUNK = 400;
        for (let i = 0; i < ids.length; i += CHUNK) {
            const chunk = ids.slice(i, i + CHUNK);
            await supabase.from("cyclic_counts").delete().in("assignment_id", chunk);
            const { error } = await supabase.from("cyclic_assignments").delete().in("id", chunk);
            if (error) { showMessage("Error eliminando asignaciones: " + error.message, "error"); return; }
        }
        showMessage(`El codigo ${row.sku} fue quitado de ${row.store_count} tiendas.`, "success");
        loadAllStoreAssignmentSummary(valDate);
    }

    async function uploadBulkAssign() {
        if (!bulkAssignFile) { showMessage("Selecciona un archivo Excel.", "error"); return; }
        if (!valDate) { showMessage("Selecciona una fecha antes.", "error"); return; }
        try {
            const data = await bulkAssignFile.arrayBuffer();
            const wb = XLSX.read(data, { type: "array" });
            const sheet = wb.Sheets[wb.SheetNames[0]];
            const allRows: any[][] = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: true, header: 1 });
            const headerRow = allRows[0] || [];

            const findCol = (names: string[]): number => {
                const idx = headerRow.findIndex((h: any) => names.some(n => String(h || "").toLowerCase().includes(n.toLowerCase())));
                return idx >= 0 ? idx : -1;
            };

            const hasStoreCol = headerRow.some((h: any) => ["tienda", "store", "almacen", "almacén", "local", "tda", "sede"].some(n => String(h || "").toLowerCase().includes(n)));
            let colTienda = -1;
            let colCodigo: number;
            let colCosto = -1;
            let colStock = -1;

            if (hasStoreCol) {
                colTienda = findCol(["tienda", "store", "almacen", "almacén", "local", "tda", "sede"]);
                const detectedCodigo = findCol(["codigo", "código", "code", "sku", "cod", "codsap", "barra", "barcode"]);
                colCodigo = detectedCodigo >= 0 ? detectedCodigo : (colTienda >= 0 ? colTienda + 1 : 1);
                colCosto = findCol(["cost", "costo", "precio", "price", "ult.cost", "ult cost"]);
                colStock = findCol(["stock", "cantidad", "qty", "saldo", "existencia"]);
            } else {
                const detectedCodigo = findCol(["codigo", "código", "code", "sku", "cod", "codsap", "barra", "barcode"]);
                colCodigo = detectedCodigo >= 0 ? detectedCodigo : 0;
                colCosto = findCol(["cost", "costo", "precio", "price", "ult.cost", "ult cost"]);
                colStock = findCol(["stock", "cantidad", "qty", "saldo", "existencia"]);
            }

            const dataRows = allRows.slice(1).filter(r => r.some((v: any) => String(v || "").trim()));

            // ── PASO 1: Construir mapa de tiendas ────────────────────────
            const normalizeStoreKey = (value: string | null | undefined) => String(value || "").trim().toLowerCase();
            const storeNameMap = new Map<string, string>();
            const storeById = new Map<string, Store>();
            for (const st of allStores) {
                storeById.set(st.id, st);
                for (const key of [st.name, st.code, st.erp_sede]) {
                    const normalized = normalizeStoreKey(key || "");
                    if (normalized) storeNameMap.set(normalized, st.id);
                }
            }

            // ── PASO 2: Extraer códigos únicos del archivo ────────────────
            setBulkAssignProgress({ step: "Leyendo archivo y buscando productos...", pct: 5 });
            const codigosEnArchivo = new Set<string>();
            for (const row of dataRows) {
                const rawCode = fullProductCode(String(row[colCodigo] || ""));
                if (rawCode) codigosEnArchivo.add(rawCode);
            }

            // ── PASO 3: Traer productos relevantes de una vez ────────────
            setBulkAssignProgress({ step: "Cargando productos del maestro...", pct: 15 });
            const codeArr = [...codigosEnArchivo];
            const prodBySkuMap = new Map<string, Product>();
            const prodByBarcodeMap = new Map<string, Product>();
            const codSapByAltCode = new Map<string, string>();
            const CHUNK = 500;

            for (let i = 0; i < codeArr.length; i += CHUNK) {
                const chunk = codeArr.slice(i, i + CHUNK);
                const { data: prods } = await supabase.from("cyclic_products").select("*").in("sku", chunk).eq("is_active", true);
                for (const p of prods || []) {
                    prodBySkuMap.set(fullProductCode(p.sku), p as Product);
                    if (p.barcode) prodByBarcodeMap.set(fullProductCode(String(p.barcode)), p as Product);
                }
            }

            const notFoundBySku = codeArr.filter(code => !prodBySkuMap.has(code));
            for (let i = 0; i < notFoundBySku.length; i += CHUNK) {
                const chunk = notFoundBySku.slice(i, i + CHUNK);
                const { data: prods } = await supabase.from("cyclic_products").select("*").in("barcode", chunk).eq("is_active", true);
                for (const p of prods || []) {
                    if (p.barcode) prodByBarcodeMap.set(fullProductCode(String(p.barcode)), p as Product);
                    prodBySkuMap.set(fullProductCode(p.sku), p as Product);
                }
            }

            for (let i = 0; i < codeArr.length; i += CHUNK) {
                const chunk = codeArr.slice(i, i + CHUNK);
                const { data: byUpc } = await supabase.from("codigos_barra").select("codsap, upc, alu").in("upc", chunk);
                const { data: byAlu } = await supabase.from("codigos_barra").select("codsap, upc, alu").in("alu", chunk);
                for (const row of [...(byUpc || []), ...(byAlu || [])]) {
                    const codsap = fullProductCode(row.codsap);
                    if (!codsap) continue;
                    if (row.upc) codSapByAltCode.set(fullProductCode(String(row.upc)), codsap);
                    if (row.alu) codSapByAltCode.set(fullProductCode(String(row.alu)), codsap);
                }
            }

            const mappedSkus = [...new Set([...codSapByAltCode.values()].filter(sku => !prodBySkuMap.has(sku)))];
            for (let i = 0; i < mappedSkus.length; i += CHUNK) {
                const chunk = mappedSkus.slice(i, i + CHUNK);
                const { data: prods } = await supabase.from("cyclic_products").select("*").in("sku", chunk).eq("is_active", true);
                for (const p of prods || []) {
                    prodBySkuMap.set(fullProductCode(p.sku), p as Product);
                    if (p.barcode) prodByBarcodeMap.set(fullProductCode(String(p.barcode)), p as Product);
                }
            }

            const resolveProduct = (code: string): Product | null => {
                const clean = fullProductCode(code);
                const mappedSku = codSapByAltCode.get(clean);
                return (mappedSku ? prodBySkuMap.get(mappedSku) : null) || prodByBarcodeMap.get(clean) || prodBySkuMap.get(clean) || null;
            };

            // ── PASO 4: Tiendas y stock sincronizado por tienda/código ───
            setBulkAssignProgress({ step: "Cargando stock sincronizado por tienda...", pct: 30 });
            const storeIdsDelArchivo = new Set<string>();
            if (hasStoreCol && colTienda >= 0) {
                for (const row of dataRows) {
                    const rawStore = normalizeStoreKey(String(row[colTienda] || ""));
                    const sid = storeNameMap.get(rawStore);
                    if (sid) storeIdsDelArchivo.add(sid);
                }
            } else if (valStoreId === ALL_STORES_VALUE) {
                for (const store of stores.filter(s => s.is_active)) storeIdsDelArchivo.add(store.id);
            } else if (valStoreId) {
                storeIdsDelArchivo.add(valStoreId);
            }

            const storeIdsArr = [...storeIdsDelArchivo];
            const sedesArr = [...new Set(storeIdsArr.map(id => {
                const st = storeById.get(id);
                return String(st?.erp_sede || st?.name || "").trim();
            }).filter(Boolean))];

            const productSkus = [...new Set([...prodBySkuMap.values()].map(p => fullProductCode(p.sku)).filter(Boolean))];
            const stockBySedeSku = new Map<string, number>();
            for (let i = 0; i < productSkus.length; i += CHUNK) {
                const chunk = productSkus.slice(i, i + CHUNK);
                let q = supabase.from("stock_general").select("codsap, sede, stock").in("codsap", chunk);
                if (sedesArr.length > 0) q = q.in("sede", sedesArr);
                const { data: stockRows } = await q;
                for (const row of stockRows || []) {
                    stockBySedeSku.set(String(row.sede || "").trim() + "__" + fullProductCode(row.codsap), Number(row.stock || 0));
                }
            }

            // ── PASO 5: Traer asignaciones existentes para la fecha ──────
            setBulkAssignProgress({ step: "Revisando asignaciones existentes...", pct: 45 });
            type ExistingAssignment = { id: string; store_id: string; product_id: string; system_stock: number };
            let existingAsgns: ExistingAssignment[] = [];
            for (let i = 0; i < storeIdsArr.length; i += 100) {
                const chunk = storeIdsArr.slice(i, i + 100);
                const { data: ea } = await supabase.from("cyclic_assignments")
                    .select("id, store_id, product_id, system_stock")
                    .in("store_id", chunk)
                    .eq("assigned_date", valDate);
                existingAsgns = existingAsgns.concat((ea || []) as ExistingAssignment[]);
            }
            const existingMap = new Map<string, ExistingAssignment>();
            for (const ea of existingAsgns) existingMap.set(ea.store_id + "__" + ea.product_id, ea);

            // ── PASO 6: Procesar filas y construir lotes ────────────────
            setBulkAssignProgress({ step: "Preparando datos para inserción...", pct: 60 });
            let skip = 0, notFound = 0, storeNotFound = 0, stockNotFound = 0;
            const assignmentDrafts = new Map<string, { store_id: string; product_id: string; system_stock: number }>();
            const costUpdates: { id: string; cost: number }[] = [];

            for (const row of dataRows) {
                const rawCode = fullProductCode(String(row[colCodigo] || ""));
                if (!rawCode) { skip++; continue; }

                const targetStoreIds = valStoreId === ALL_STORES_VALUE && !hasStoreCol
                    ? stores.filter(s => s.is_active).map(s => s.id)
                    : [valStoreId || ""];
                if (hasStoreCol && colTienda >= 0) {
                    const rawStore = normalizeStoreKey(String(row[colTienda] || ""));
                    if (!rawStore) { skip++; continue; }
                    const sid = storeNameMap.get(rawStore);
                    if (!sid) { storeNotFound++; continue; }
                    targetStoreIds.splice(0, targetStoreIds.length, sid);
                }
                if (targetStoreIds.length === 0 || targetStoreIds.every(id => !id)) { skip++; continue; }

                const prod = resolveProduct(rawCode);
                if (!prod) { notFound++; continue; }
                if (isNonInventoryProduct(prod)) { skip++; continue; }

                for (const targetStoreId of targetStoreIds) {
                    const store = storeById.get(targetStoreId);
                    const sede = String(store?.erp_sede || store?.name || "").trim();
                    const syncedStock = stockBySedeSku.get(sede + "__" + fullProductCode(prod.sku));
                    const hasManualStock = colStock >= 0 && String(row[colStock] ?? "").trim() !== "";
                    const stock = hasManualStock ? Number(row[colStock] || 0) : Number(syncedStock || 0);
                    if (!hasManualStock && syncedStock === undefined) stockNotFound++;

                    if (colCosto >= 0 && String(row[colCosto] ?? "").trim() !== "") {
                        const cost = parseCost(row[colCosto]);
                        if (cost > 0 && cost !== prod.cost) costUpdates.push({ id: prod.id, cost });
                    }

                    assignmentDrafts.set(targetStoreId + "__" + prod.id, {
                        store_id: targetStoreId,
                        product_id: prod.id,
                        system_stock: stock,
                    });
                }
            }

            const toInsert: any[] = [];
            const toUpdate: { id: string; system_stock: number }[] = [];
            for (const [key, draft] of assignmentDrafts) {
                const existing = existingMap.get(key);
                if (existing) {
                    if (existing.system_stock !== draft.system_stock) toUpdate.push({ id: existing.id, system_stock: draft.system_stock });
                } else {
                    toInsert.push({ ...draft, assigned_date: valDate, assigned_by: user?.id });
                }
            }

            // ── PASO 7: Actualizar costos opcionales ────────────────────
            setBulkAssignProgress({ step: "Actualizando costos opcionales...", pct: 70 });
            const now = new Date().toISOString();
            for (let i = 0; i < costUpdates.length; i += 200) {
                const chunk = costUpdates.slice(i, i + 200);
                await Promise.all(chunk.map(c =>
                    supabase.from("cyclic_products").update({ cost: c.cost, updated_at: now }).eq("id", c.id)
                ));
            }

            // ── PASO 8: Actualizaciones de stock en lote ────────────────
            setBulkAssignProgress({ step: "Actualizando " + toUpdate.length + " asignaciones...", pct: 78 });
            for (let i = 0; i < toUpdate.length; i += 200) {
                const chunk = toUpdate.slice(i, i + 200);
                await Promise.all(chunk.map(u =>
                    supabase.from("cyclic_assignments").update({ system_stock: u.system_stock }).eq("id", u.id)
                ));
            }

            // ── PASO 9: Insertar nuevas asignaciones en lote ────────────
            setBulkAssignProgress({ step: "Insertando " + toInsert.length + " nuevas asignaciones...", pct: 88 });
            const INSERT_BATCH = 200;
            let insertOk = 0;
            for (let i = 0; i < toInsert.length; i += INSERT_BATCH) {
                const batch = toInsert.slice(i, i + INSERT_BATCH);
                const { error } = await supabase.from("cyclic_assignments").insert(batch);
                if (!error) insertOk += batch.length;
                const pct = toInsert.length > 0 ? 88 + Math.round((i / toInsert.length) * 10) : 98;
                setBulkAssignProgress({ step: "Insertando... " + Math.min(i + INSERT_BATCH, toInsert.length) + " / " + toInsert.length, pct });
            }

            setBulkAssignProgress(null);
            const storeMsg = storeNotFound > 0 ? " " + storeNotFound + " tiendas no encontradas." : "";
            const stockMsg = stockNotFound > 0 ? " " + stockNotFound + " sin stock sincronizado; se asignaron con 0." : "";
            showMessage("✅ " + insertOk + " nuevos asignados, " + toUpdate.length + " actualizados. " + skip + " vacíos. " + notFound + " no encontrados en maestro." + storeMsg + stockMsg, insertOk > 0 || toUpdate.length > 0 ? "success" : "error");
            setBulkAssignFile(null); setBulkAssignFileName("");
            if (valStoreId && valStoreId !== ALL_STORES_VALUE) loadValidadorData(valStoreId, valDate);
            if (valStoreId === ALL_STORES_VALUE) loadAllStoreAssignmentSummary(valDate);

            // ── PASO 10: Modal WhatsApp masivo ──────────────────────────
            if (insertOk > 0 || toUpdate.length > 0) {
                const wspStoreIds = [...storeIdsDelArchivo];
                const allOps: any[] = [];
                for (let i = 0; i < wspStoreIds.length; i += 200) {
                    const chunk = wspStoreIds.slice(i, i + 200);
                    const { data: ops } = await supabase.from("cyclic_users")
                        .select("full_name, whatsapp, store_id, username, password")
                        .in("store_id", chunk)
                        .eq("role", "Operario")
                        .eq("is_active", true)
                        .not("whatsapp", "is", null);
                    allOps.push(...(ops || []));
                }
                const operarioByStore = new Map<string, { full_name: string; whatsapp: string; username: string; password: string }>();
                for (const op of allOps) {
                    const wsp = String(op.whatsapp || "").trim();
                    if (!wsp) continue;
                    if (!operarioByStore.has(op.store_id)) {
                        operarioByStore.set(op.store_id, { full_name: op.full_name, whatsapp: wsp, username: op.username || "", password: op.password || "" });
                    }
                }

                const cntByStore = new Map<string, number>();
                for (const ea of existingAsgns) cntByStore.set(ea.store_id, (cntByStore.get(ea.store_id) || 0) + 1);
                for (const ins of toInsert) cntByStore.set(ins.store_id, (cntByStore.get(ins.store_id) || 0) + 1);

                const wspStoresData: typeof bulkWspStores = wspStoreIds.map(sid => ({
                    id: sid,
                    name: allStores.find(s => s.id === sid)?.name || sid,
                    count: cntByStore.get(sid) || 0,
                    operario: operarioByStore.get(sid) || null,
                }));
                wspStoresData.sort((a, b) => a.name.localeCompare(b.name));
                const withOperario = wspStoresData.filter(s => s.operario?.whatsapp);
                setBulkWspStores(wspStoresData);
                setBulkWspSelected(new Set(withOperario.map(s => s.id)));
                setBulkWspDate(valDate);
                setShowBulkWspModal(true);
            }
        } catch (e: any) {
            setBulkAssignProgress(null);
            showMessage("Error leyendo el archivo: " + e.message, "error");
        }
    }

    // Construye la lista ordenada de tiendas seleccionadas para el envío
    const bulkWspQueue = bulkWspStores.filter(s => bulkWspSelected.has(s.id) && s.operario?.whatsapp);

    function buildWspMessage(store: typeof bulkWspStores[0]) {
        const op = store.operario!;
        const appUrl = typeof window !== "undefined" ? window.location.origin : "";
        return `Hola ${op.full_name} 👋\n\nSe te han asignado *${store.count} código${store.count !== 1 ? "s" : ""}* para contar en *${store.name}* el día *${bulkWspDate}*.\n\nPor favor ingresa a la app para realizar el conteo cíclico:\n🔗 ${appUrl}\n👤 Usuario: *${op.username}*\n🔑 Contraseña: *${op.password}*\n\n¡Gracias!`;
    }

    function startBulkSend() {
        if (bulkWspQueue.length === 0) return;
        setBulkWspSendingIdx(0);
        const store = bulkWspQueue[0];
        const url = `https://wa.me/${store.operario!.whatsapp}?text=${encodeURIComponent(buildWspMessage(store))}`;
        window.open(url, "_blank");
    }

    function nextBulkSend() {
        const next = bulkWspSendingIdx + 1;
        if (next >= bulkWspQueue.length) {
            setBulkWspSendingIdx(-1);
            setShowBulkWspModal(false);
            showMessage(`✅ WhatsApp enviado a ${bulkWspQueue.length} tienda${bulkWspQueue.length !== 1 ? "s" : ""}.`, "success");
            return;
        }
        setBulkWspSendingIdx(next);
        const store = bulkWspQueue[next];
        const url = `https://wa.me/${store.operario!.whatsapp}?text=${encodeURIComponent(buildWspMessage(store))}`;
        window.open(url, "_blank");
    }

    function sendBulkWhatsapp() { startBulkSend(); }

    async function openBulkWspModal(date: string) {
        showMessage("Cargando tiendas...", "info");
        // Traer todas las asignaciones de la fecha paginando
        const PAGE = 1000;
        let allAsgns: any[] = [];
        let page = 0;
        while (true) {
            const { data: chunk } = await supabase
                .from("cyclic_assignments")
                .select("store_id, id")
                .eq("assigned_date", date)
                .range(page * PAGE, (page + 1) * PAGE - 1);
            if (!chunk || chunk.length === 0) break;
            allAsgns = allAsgns.concat(chunk);
            if (chunk.length < PAGE) break;
            page++;
        }

        if (allAsgns.length === 0) { showMessage("No hay tiendas con asignaciones en esta fecha.", "error"); return; }

        // Contar por tienda en memoria
        const countByStore = new Map<string, number>();
        for (const a of allAsgns) {
            countByStore.set(a.store_id, (countByStore.get(a.store_id) || 0) + 1);
        }
        const storeIds = [...countByStore.keys()];

        // Traer TODOS los operarios activos de esas tiendas de una sola vez
        const allOperarios: any[] = [];
        for (let i = 0; i < storeIds.length; i += 200) {
            const chunk = storeIds.slice(i, i + 200);
            const { data: ops } = await supabase.from("cyclic_users")
                .select("full_name, whatsapp, store_id, username, password")
                .in("store_id", chunk)
                .eq("role", "Operario")
                .eq("is_active", true)
                .not("whatsapp", "is", null);
            allOperarios.push(...(ops || []));
        }

        // Agrupar operarios por store_id — preferir el que tiene WhatsApp
        const operarioByStore = new Map<string, { full_name: string; whatsapp: string; username: string; password: string }>();
        for (const op of allOperarios) {
            const wsp = String(op.whatsapp || "").trim();
            if (!wsp) continue;
            // Si ya hay uno para esta tienda, quedarse con el primero que tenga número (lider*)
            if (!operarioByStore.has(op.store_id)) {
                operarioByStore.set(op.store_id, { full_name: op.full_name, whatsapp: wsp, username: op.username || "", password: op.password || "" });
            }
        }

        const wspStoresData: typeof bulkWspStores = storeIds.map(sid => ({
            id: sid,
            name: allStores.find(s => s.id === sid)?.name || sid,
            count: countByStore.get(sid) || 0,
            operario: operarioByStore.get(sid) || null,
        }));
        wspStoresData.sort((a, b) => a.name.localeCompare(b.name));

        clearMessage();
        const withOperario = wspStoresData.filter(s => s.operario?.whatsapp);
        setBulkWspStores(wspStoresData);
        setBulkWspSelected(new Set(withOperario.map(s => s.id)));
        setBulkWspDate(date);
        setShowBulkWspModal(true);
    }

    // ════════════════════════════════════════════════════════
    //  VALIDADOR — EDITAR CONTEO
    // ════════════════════════════════════════════════════════
    function openEditCount(c: CountRecord) {
        setEditingCount(c);
        setEditQty(String(c.counted_quantity));
        setEditLocation(c.location);
        setEditStatus(c.status);
        setEditNote(c.note || "");
    }

    async function saveEditCount() {
        if (!editingCount || !user) return;
        const qty = Number(editQty);
        if (isNaN(qty) || qty < 0) { showMessage("Cantidad inválida.", "error"); return; }
        const asg = assignments.find(a => a.id === editingCount.assignment_id);
        const diff = qty - Number(asg?.system_stock || 0);
        const { error } = await supabase.from("cyclic_counts").update({
            counted_quantity: qty, location: editLocation.trim(), status: editStatus,
            note: editNote.trim(), validator_id: user.id, validator_name: user.full_name,
            stock_snapshot: Number(asg?.system_stock ?? editingCount.stock_snapshot ?? 0),
            updated_at: new Date().toISOString(),
        }).eq("id", editingCount.id);
        if (error) { showMessage("Error: " + error.message, "error"); return; }
        showMessage("✅ Registro actualizado.", "success");
        setEditingCount(null);
        loadValidadorData(valStoreId, valDate);
    }

    // ════════════════════════════════════════════════════════
    //  RESUMEN ANÁLISIS — GUARDAR EN BD
    // ════════════════════════════════════════════════════════
    async function saveResumenAnalysis(overridesToSave?: Record<string, { system_stock?: number; total_counted?: number }>) {
        const effectiveOverrides = overridesToSave ?? resumenOverrides;
        const entries = Object.entries(effectiveOverrides);
        if (entries.length === 0) { showMessage("No hay cambios para guardar.", "info"); return; }
        if (!confirm(`¿Guardar ${entries.length} cambio${entries.length !== 1 ? "s" : ""} en la base de datos? Esta acción modifica el stock sistema y/o los conteos reales.`)) return;

        setSavingAnalysis(true);
        let errores = 0;
        const now = new Date().toISOString();

        for (const [product_id, ov] of entries) {
            // ── 1. Actualizar system_stock en todas las asignaciones de este producto/tienda/fecha ──
            if (ov.system_stock !== undefined) {
                const asgnsDelProducto = assignments.filter(a => a.product_id === product_id);
                for (const asg of asgnsDelProducto) {
                    const { error } = await supabase
                        .from("cyclic_assignments")
                        .update({ system_stock: ov.system_stock })
                        .eq("id", asg.id);
                    if (error) { errores++; console.error("Error actualizando stock:", error); }
                }
            }

            // ── 2. Actualizar counted_quantity en cyclic_counts ──────────────────────────────────
            // Estrategia: obtener todos los conteos reales del producto, sumar, y distribuir el nuevo total
            // en el primer conteo (el más reciente). Los demás se ponen en 0 para que la suma sea correcta.
            if (ov.total_counted !== undefined) {
                const cntsDeProd = counts.filter(c => c.product_id === product_id);
                if (cntsDeProd.length === 0) continue;

                // Ordenar por fecha más reciente primero
                const sorted = [...cntsDeProd].sort((a, b) => new Date(b.counted_at).getTime() - new Date(a.counted_at).getTime());
                const nuevoTotal = ov.total_counted;
                const stockSnapshot = Number(ov.system_stock ?? assignments.find(a => a.product_id === product_id)?.system_stock ?? 0);

                // El primer conteo (más reciente) toma el total completo
                const { error: e1 } = await supabase
                    .from("cyclic_counts")
                    .update({
                        counted_quantity: nuevoTotal,
                        status: nuevoTotal === stockSnapshot
                            ? "Validado"
                            : nuevoTotal > stockSnapshot
                            ? "Corregido"
                            : "Corregido",
                        stock_snapshot: stockSnapshot,
                        validator_id: user?.id ?? null,
                        validator_name: user?.full_name ?? null,
                        updated_at: now,
                    })
                    .eq("id", sorted[0].id);
                if (e1) { errores++; console.error("Error actualizando conteo principal:", e1); }

                // Los demás conteos se ponen en 0 para no duplicar la suma
                for (let i = 1; i < sorted.length; i++) {
                    const { error: ei } = await supabase
                        .from("cyclic_counts")
                        .update({ counted_quantity: 0, updated_at: now })
                        .eq("id", sorted[i].id);
                    if (ei) { errores++; console.error("Error zeroing conteo secundario:", ei); }
                }
            }
        }

        setSavingAnalysis(false);

        if (errores === 0) {
            showMessage(`✅ ${entries.length} cambio${entries.length !== 1 ? "s" : ""} guardado${entries.length !== 1 ? "s" : ""} correctamente.`, "success");
            setResumenOverrides({}); setResumenDraft({});
            setResumenDraft({});
            // Recargar datos para reflejar lo guardado
            loadValidadorData(valStoreId, valDate);
        } else {
            showMessage(`⚠️ Se guardaron con ${errores} error${errores !== 1 ? "es" : ""}. Revisa la consola.`, "error");
            loadValidadorData(valStoreId, valDate);
        }
    }

    async function deleteCount(c: CountRecord) {
        if (!confirm(`¿Eliminar conteo de "${c.sku}"?`)) return;
        const { error } = await supabase.from("cyclic_counts").delete().eq("id", c.id);
        if (error) { showMessage("Error: " + error.message, "error"); return; }
        showMessage("✅ Conteo eliminado.", "success");
        if (user?.role === "Operario") loadOperarioData(selectedStoreId, selectedDate);
        else loadValidadorData(valStoreId, valDate);
    }

    // ════════════════════════════════════════════════════════
    //  VALIDADOR / ADMIN — REVERSAR CUMPLIMIENTO
    //  Elimina TODOS los conteos reales de la tienda+fecha para
    //  que el operario vuelva a tener acceso a contar.
    // ════════════════════════════════════════════════════════
    async function reversarCumplimiento() {
        if (!valStoreId || !valDate) { showMessage("Selecciona tienda y fecha.", "error"); return; }
        const storeName = allStores.find(s => s.id === valStoreId)?.name || valStoreId;
        if (!confirm(`¿Reversar el cumplimiento de ${storeName} en ${valDate}?\n\nEsto eliminará TODOS los conteos del día para que el operario pueda volver a registrarlos. Esta acción no se puede deshacer.`)) return;

        // 1. Obtener todas las asignaciones de la tienda+fecha
        const asgIds = assignments.map(a => a.id);
        if (asgIds.length === 0) { showMessage("No hay asignaciones para reversar.", "error"); return; }

        // 2. Eliminar todos los conteos reales (incluyendo flags de sesión)
        const CHUNK = 400;
        let errores = 0;
        for (let i = 0; i < asgIds.length; i += CHUNK) {
            const { error } = await supabase
                .from("cyclic_counts")
                .delete()
                .in("assignment_id", asgIds.slice(i, i + CHUNK));
            if (error) { errores++; console.error("Error reversando:", error); }
        }

        if (errores > 0) {
            showMessage(`⚠️ Reversado con ${errores} error(es). Algunos conteos podrían no haberse eliminado.`, "error");
        } else {
            showMessage(`✅ Cumplimiento reversado para ${storeName} — ${valDate}. El operario puede volver a contar.`, "success");
        }
        loadValidadorData(valStoreId, valDate);
    }

    // ════════════════════════════════════════════════════════
    //  ADMIN — MAESTRO PRODUCTOS
    // ════════════════════════════════════════════════════════
    async function uploadMaster() {
        if (!masterFile) { showMessage("Selecciona un archivo.", "error"); return; }
        if (!confirm("¿Seguro? Esto actualizará o insertará productos en el maestro global.")) return;
        try {
            const data = await masterFile.arrayBuffer();
            const wb = XLSX.read(data, { type: "array" });
            const sheet = wb.Sheets[wb.SheetNames[0]];
            // Leer como array de arrays para ignorar la fila 1 y leer por posición de columna
            // Col A=0: codigo, Col B=1: descripcion, Col C=2: unidad, Col D=3: costo, Col E=4: stock
            const allRows: any[][] = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false, header: 1 });
            const dataRows = allRows.slice(1); // ignorar fila 1 (encabezado)

            const inputCodes = [...new Set(dataRows.map(row => fullProductCode(String(row[0] || ""))).filter(Boolean))];
            const codSapByInputCode = new Map<string, string>();
            const CHUNK = 500;
            for (let i = 0; i < inputCodes.length; i += CHUNK) {
                const chunk = inputCodes.slice(i, i + CHUNK);
                const { data: byUpc } = await supabase.from("codigos_barra").select("codsap, upc, alu").in("upc", chunk);
                const { data: byAlu } = await supabase.from("codigos_barra").select("codsap, upc, alu").in("alu", chunk);
                for (const row of [...(byUpc || []), ...(byAlu || [])]) {
                    const codsap = fullProductCode(row.codsap);
                    if (!codsap) continue;
                    if (row.upc) codSapByInputCode.set(fullProductCode(String(row.upc)), codsap);
                    if (row.alu) codSapByInputCode.set(fullProductCode(String(row.alu)), codsap);
                }
            }

            const map = new Map<string, any>();
            for (const row of dataRows) {
                const inputSku = fullProductCode(String(row[0] || ""));
                const rawSku = codSapByInputCode.get(inputSku) || inputSku;
                if (!rawSku) continue;
                const desc = String(row[1] || "").trim();
                if (!desc) continue;
                const unit = String(row[2] || "NIU").trim() || "NIU";
                const cost = parseCost(row[3]);
                // Col E (índice 4) es stock - lo guardamos en system_stock si existe, pero en maestro no se usa stock
                const barcode: string | null = null; // barcode viene del archivo separado
                map.set(normalizeText(rawSku), {
                    sku: rawSku, barcode, description: desc, unit, cost, is_active: true,
                    updated_at: new Date().toISOString(),
                });
            }
            if (map.size === 0) { showMessage("Archivo sin filas válidas. Verifica que tenga datos desde la fila 2.", "error"); return; }
            const items = Array.from(map.values());
            let ok = 0;
            const BATCH = 500;
            for (let i = 0; i < items.length; i += BATCH) {
                const batch = items.slice(i, i + BATCH);
                setUploadProgress({ step: `Procesando ${Math.min(i + BATCH, items.length)} / ${items.length}...`, pct: Math.round((Math.min(i + BATCH, items.length) / items.length) * 100) });
                const { error } = await supabase.from("cyclic_products").upsert(batch, { onConflict: "sku" });
                if (!error) ok += batch.length;
            }
            setUploadProgress(null);
            showMessage(`✅ ${ok} productos procesados en el maestro global.`, "success");
            setMasterFile(null); setMasterFileName("");
            loadProducts();
        } catch (e: any) {
            setUploadProgress(null);
            showMessage("Error: " + e.message, "error");
        }
    }

    async function uploadBarcodes() {
        if (!barcodesFile) { showMessage("Selecciona un archivo de códigos de barra.", "error"); return; }
        if (!confirm("¿Seguro? Esto actualizará los códigos de barra del maestro global.")) return;
        try {
            const data = await barcodesFile.arrayBuffer();
            const wb = XLSX.read(data, { type: "array" });
            const sheet = wb.Sheets[wb.SheetNames[0]];
            const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
            let ok = 0, notFound = 0;
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                setBarcodesProgress({ step: `Procesando ${i + 1} / ${rows.length}...`, pct: Math.round(((i + 1) / rows.length) * 100) });
                const rawSku = fullProductCode(String(row["CODIGO"] || ""));
                if (!rawSku) continue;
                const b1 = fullProductCode(String(row["CODIGO DE BARRA 1"] || ""));
                const b2 = fullProductCode(String(row["CODIGO DE BARRA 2"] || ""));
                const barcode = b1 || b2 || null;
                if (!barcode) continue;
                const { data: prod } = await supabase.from("cyclic_products").select("id").eq("sku", rawSku).maybeSingle();
                if (!prod) { notFound++; continue; }
                const { error } = await supabase.from("cyclic_products")
                    .update({ barcode, updated_at: new Date().toISOString() })
                    .eq("id", prod.id);
                if (!error) ok++;
                else notFound++;
            }
            setBarcodesProgress(null);
            showMessage(`✅ ${ok} códigos de barra actualizados. ${notFound} SKUs no encontrados.`, ok > 0 ? "success" : "error");
            setBarcodesFile(null); setBarcodesFileName("");
            loadProducts();
        } catch (e: any) {
            setBarcodesProgress(null);
            showMessage("Error: " + e.message, "error");
        }
    }

    async function saveEditProduct() {
        if (!editingProduct || !user) return;
        const sku = editProdSku.trim();
        const desc = editProdDesc.trim();
        if (!sku || !desc) { showMessage("SKU y descripción son obligatorios.", "error"); return; }
        const cost = Number(editProdCost);
        if (isNaN(cost) || cost < 0) { showMessage("Costo inválido.", "error"); return; }
        const { error } = await supabase.from("cyclic_products").update({
            sku, barcode: editProdBarcode.trim() || null, description: desc,
            unit: editProdUnit.trim() || "NIU", cost,
            updated_at: new Date().toISOString(),
        }).eq("id", editingProduct.id);
        if (error) { showMessage("Error: " + error.message, "error"); return; }
        showMessage("✅ Producto actualizado.", "success");
        setEditingProduct(null);
        loadProducts();
    }

    // ════════════════════════════════════════════════════════
    //  ADMIN — TIENDAS
    // ════════════════════════════════════════════════════════
    async function createStore() {
        if (!newStoreName.trim()) { showMessage("Nombre de tienda requerido.", "error"); return; }
        const { error } = await supabase.from("stores").insert({
            name: newStoreName.trim(), code: newStoreCode.trim() || newStoreName.trim().toUpperCase().slice(0,8),
            is_active: true,
        });
        if (error) { showMessage("Error: " + error.message, "error"); return; }
        showMessage("✅ Tienda creada.", "success");
        setNewStoreName(""); setNewStoreCode("");
        loadStores();
    }

    async function toggleStoreActive(store: Store) {
        const { error } = await supabase.from("stores").update({ is_active: !store.is_active }).eq("id", store.id);
        if (error) { showMessage("Error: " + error.message, "error"); return; }
        loadStores();
    }

    // ════════════════════════════════════════════════════════
    //  ADMIN — USUARIOS
    // ════════════════════════════════════════════════════════
    async function createUser() {
        if (!newUsername.trim() || !newPassword.trim() || !newFullName.trim()) { showMessage("Usuario, contraseña y nombre son obligatorios.", "error"); return; }
        const { data: existing } = await supabase.from("cyclic_users").select("id").eq("username", newUsername.trim().toLowerCase()).maybeSingle();
        if (existing) { showMessage("Nombre de usuario ya existe.", "error"); return; }
        const wsp = newUserWhatsapp.trim().replace(/\D/g, "");
        const { error } = await supabase.from("cyclic_users").insert({
            username: newUsername.trim().toLowerCase(), password: newPassword.trim(),
            full_name: newFullName.trim(), role: newRole,
            store_id: newRole === "Operario" ? (newUserStoreId || null) : null,
            can_access_all_stores: newRole !== "Operario",
            can_access_audit: newRole === "Administrador" ? true : newUserAuditAccess,
            is_active: true,
            whatsapp: wsp || null,
        });
        if (error) { showMessage("Error: " + error.message, "error"); return; }
        showMessage("✅ Usuario creado.", "success");
        setNewUsername(""); setNewPassword(""); setNewFullName(""); setNewRole("Operario"); setNewUserStoreId(""); setNewUserWhatsapp(""); setNewUserAuditAccess(false);
        loadAllUsers();
    }

    function openEditUser(u: CyclicUser) {
        setEditingUser(u);
        setEditUserRole(u.role);
        setEditUserStoreId(u.store_id || "");
        setEditUserAllStores(u.can_access_all_stores);
        setEditUserActive(u.is_active);
        setEditUserPassword("");
        setEditUserWhatsapp(u.whatsapp || "");
        setEditUserAuditAccess(u.role === "Administrador" ? true : !!u.can_access_audit);
    }

    async function saveEditUser() {
        if (!editingUser) return;
        const wsp = editUserWhatsapp.trim().replace(/\D/g, "");
        const updates: any = {
            role: editUserRole,
            store_id: editUserRole === "Operario" ? (editUserStoreId || null) : null,
            can_access_all_stores: editUserRole !== "Operario",
            can_access_audit: editUserRole === "Administrador" ? true : editUserAuditAccess,
            is_active: editUserActive,
            whatsapp: wsp || null,
        };
        if (editUserPassword.trim()) updates.password = editUserPassword.trim();
        const { error } = await supabase.from("cyclic_users").update(updates).eq("id", editingUser.id);
        if (error) { showMessage("Error: " + error.message, "error"); return; }
        showMessage("✅ Usuario actualizado.", "success");
        setEditingUser(null);
        loadAllUsers();
    }

    async function deleteUser(u: CyclicUser) {
        if (!confirm(`¿Eliminar usuario "${u.username}"? Esta acción no se puede deshacer.`)) return;
        const { error } = await supabase.from("cyclic_users").delete().eq("id", u.id);
        if (error) { showMessage("Error: " + error.message, "error"); return; }
        showMessage("✅ Usuario eliminado.", "success");
        loadAllUsers();
    }

    // ════════════════════════════════════════════════════════
    //  ESCÁNER
    // ════════════════════════════════════════════════════════
    async function stopScanner() {
        try {
            if (scannerRef.current) { await scannerRef.current.stop(); await scannerRef.current.clear(); scannerRef.current = null; }
        } catch { scannerRef.current = null; }
        finally { setScannerRunning(false); }
    }

    function closeScanner() {
        scanHandledRef.current = false; setTorchOn(false); setTorchAvailable(false);
        stopScanner(); setScannerTarget(null);
    }

    async function toggleTorch() {
        try {
            const next = !torchOn;
            await (scannerRef.current as any)?.applyVideoConstraints?.({ advanced: [{ torch: next }] });
            setTorchOn(next);
        } catch { showMessage("Linterna no disponible.", "error"); }
    }

    async function applyScannedValue(decoded: string) {
        const v = String(decoded || "").trim();
        if (!v || scanHandledRef.current) return;
        scanHandledRef.current = true;

        if (scannerTarget === "product") {
            closeScanner();
            await addProductByCode(v);
            return;
        }

        if (scannerTarget === "location") {
            setLocationRows(prev => prev.map((r, idx) => idx === scanningRowIndex ? { ...r, location: v } : r));
            showMessage("Ubicación escaneada.", "success");
            closeScanner();
        }

        if (scannerTarget === "recount_location") {
            setRecountRows(prev => prev.map((r, idx) => idx === scanningRowIndex ? { ...r, location: v } : r));
            showMessage("Ubicación escaneada.", "success");
            closeScanner();
        }
    }

    function openScanner(target: "product"|"location"|"recount_location", rowIndex: number = 0) {
        clearMessage();
        scanHandledRef.current = false;
        setScanningRowIndex(rowIndex);
        setScannerTarget(target);
    }

    // ════════════════════════════════════════════════════════
    //  EXPORT
    // ════════════════════════════════════════════════════════
    function exportCounts() {
        const storeName = allStores.find(s => s.id === valStoreId)?.name || "tienda";
        const rows = filteredCounts.map(c => ({
            TIENDA: c.store_name || storeName,
            SKU: c.sku, DESCRIPCION: c.description, UNIDAD: c.unit,
            STOCK_USADO: c.stock_snapshot ?? c.system_stock ?? "",
            CONTADO: c.counted_quantity,
            UBICACION: c.location,
            USUARIO: c.user_name,
            ESTADO: c.status, NOTA: c.note || "",
            FECHA_HORA: formatDateTime(c.counted_at),
        }));
        const ws = XLSX.utils.json_to_sheet(rows);
        const wbk = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wbk, ws, "Registros");
        XLSX.writeFile(wbk, `registros_${storeName}_${valDate}.xlsx`);
    }

    function exportResumen() {
        const storeName = allStores.find(s => s.id === valStoreId)?.name || "tienda";
        const rows = resumenPorCodigo.map(r => ({
            SKU: r.sku, DESCRIPCION: r.description, UNIDAD: r.unit,
            STOCK_SISTEMA: r.system_stock, CONTADO: r.total_counted,
            DIFERENCIA: r.difference,
            COSTO: r.cost, DIF_VALORIZADA: r.dif_valorizada,
            ESTADO: r.total_counted === 0 && r.system_stock > 0 ? "NO CONTADO" : r.difference > 0 ? "SOBRANTE" : r.difference < 0 ? "FALTANTE" : "OK",
        }));
        const ws = XLSX.utils.json_to_sheet(rows);
        const wbk = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wbk, ws, "Resumen");
        XLSX.writeFile(wbk, `resumen_ciclico_${storeName}_${valDate}.xlsx`);
    }

    // ════════════════════════════════════════════════════════
    //  GENERAR CORREO HTML — INFORME GERENCIAL CONTEO CÍCLICO
    // ════════════════════════════════════════════════════════
    async function generateEmailHTML() {
        if (filteredDashData.length === 0) { showMessage("Primero consulta el dashboard.", "error"); return; }

        const periodoLabel = dashPeriod === "dia"
            ? dashDate
            : dashPeriod === "mes"
            ? dashMonth
            : `${dashRangeFrom} al ${dashRangeTo}`;

        // ── Métricas globales ──────────────────────────────
        const emailKpiRows = filteredDashData;
        // Cumplimiento: usa TODAS las tiendas
        const cumplidos     = dashPeriod === "dia"
            ? filteredDashData.filter(r => r.cumplio).length
            : filteredDashData.reduce((s, r) => s + r.dias_cumplidos, 0);
        const totalCumplimiento = dashPeriod === "dia"
            ? filteredDashData.length
            : filteredDashData.reduce((s, r) => s + r.dias_totales, 0);
        const cumplimientoUnidad = dashPeriod === "dia" ? "tiendas" : "tienda-dia";
        const pctCumplimiento = totalCumplimiento > 0 ? Math.round((cumplidos / totalCumplimiento) * 100) : 0;
        // ERI, DifVal, Sobrantes, Faltantes: SOLO tiendas que cumplieron
        const emailFilasQueComplieron = dashPeriod === "dia"
            ? emailKpiRows.filter(r => r.cumplio && r.total_asignados > 0)
            : emailKpiRows.filter(r => r.dias_cumplidos > 0 && r.total_asignados > 0);
        const okTotal        = emailFilasQueComplieron.reduce((s, r) => s + r.total_ok, 0);
        const sobTotal       = emailFilasQueComplieron.reduce((s, r) => s + r.total_sobrantes, 0);
        const faltTotal      = emailFilasQueComplieron.reduce((s, r) => s + r.total_faltantes, 0);
        const contadosTotal  = okTotal + sobTotal + faltTotal;
        const eriGlobal      = contadosTotal > 0 ? Math.round((okTotal / contadosTotal) * 100) : 0;
        const totalDifVal    = emailFilasQueComplieron.reduce((s, r) => s + (r.dif_valorizada || 0), 0);
        const totalFaltantes = faltTotal;
        const totalSobrantes = sobTotal;

        // ── Top 10 por código: consultar BD con el rango del período ──
        showMessage("⏳ Calculando top por código...", "info");
        let dateFrom = dashDate, dateTo = dashDate;
        if (dashPeriod === "mes") {
            const [yr, mo] = dashMonth.split("-").map(Number);
            dateFrom = `${dashMonth}-01`;
            const lastDay = new Date(yr, mo, 0).getDate();
            dateTo = `${dashMonth}-${String(lastDay).padStart(2, "0")}`;
        } else if (dashPeriod === "rango") {
            dateFrom = dashRangeFrom; dateTo = dashRangeTo;
        }

        type SkuAgg = { store_name: string; sku: string; description: string; totalDif: number; totalDifVal: number };
        const skuFaltMap = new Map<string, SkuAgg>();
        const skuSobMap  = new Map<string, SkuAgg>();
        const storeNameById = new Map(filteredDashData.map(row => [row.store_id, row.store_name]));

        try {
            // 1. Traer assignments del período
            const PAGE = 1000;
            let asgnRows: any[] = [];
            let pg = 0;
            while (true) {
                const { data: chunk } = await supabase
                    .from("cyclic_assignments")
                    .select("id, store_id, product_id, system_stock, assigned_date")
                    .gte("assigned_date", dateFrom)
                    .lte("assigned_date", dateTo)
                    .range(pg * PAGE, (pg + 1) * PAGE - 1);
                if (!chunk || chunk.length === 0) break;
                asgnRows = asgnRows.concat(chunk);
                if (chunk.length < PAGE) break;
                pg++;
            }

            if (asgnRows.length > 0) {
                // 2. Traer products para obtener sku, description, cost
                const prodIds = [...new Set(asgnRows.map((a: any) => a.product_id))];
                let prodRows: any[] = [];
                for (let i = 0; i < prodIds.length; i += 500) {
                    const { data: pc } = await supabase
                        .from("cyclic_products")
                        .select("id, sku, description, cost")
                        .in("id", prodIds.slice(i, i + 500));
                    if (pc) prodRows = prodRows.concat(pc);
                }
                const prodMap = new Map(prodRows.map((p: any) => [p.id, p]));
                const asgnById = new Map(asgnRows.map((a: any) => [a.id, a]));

                // 3. Traer counts del período
                const asgnIds = asgnRows.map((a: any) => a.id);
                let cntRows: any[] = [];
                const CHUNK = 500;
                for (let i = 0; i < asgnIds.length; i += CHUNK) {
                    const { data: cc } = await supabase
                        .from("cyclic_counts")
                        .select("assignment_id, counted_quantity, location, status")
                        .in("assignment_id", asgnIds.slice(i, i + CHUNK));
                    if (cc) cntRows = cntRows.concat(cc);
                }
                // Filtrar flags internos
                cntRows = cntRows.filter((c: any) => !isSessionFlagLocation(c.location));

                // 4. Agrupar contado por assignment
                const cntByAsgn = new Map<string, number>();
                for (const c of cntRows) {
                    cntByAsgn.set(c.assignment_id, r2((cntByAsgn.get(c.assignment_id) || 0) + Number(c.counted_quantity)));
                }

                // 5. Agrupar por product_id → diferencia valorizada
                const asgnsByDay = new Map<string, any[]>();
                for (const asgn of asgnRows) {
                    const key = `${asgn.store_id}__${asgn.assigned_date}`;
                    if (!asgnsByDay.has(key)) asgnsByDay.set(key, []);
                    asgnsByDay.get(key)!.push(asgn);
                }

                const fulfilledDayKeys = new Set<string>();
                for (const [key, dayAsgns] of asgnsByDay) {
                    const countedProductIds = new Set<string>();
                    for (const asgn of dayAsgns) {
                        if (cntByAsgn.has(asgn.id)) countedProductIds.add(asgn.product_id);
                    }
                    const assignedProductIds = new Set(dayAsgns.map((asgn: any) => asgn.product_id));
                    const hasCorrected = cntRows.some((c: any) => {
                        const asgn = asgnById.get(c.assignment_id);
                        return asgn && `${asgn.store_id}__${asgn.assigned_date}` === key && c.status === "Corregido";
                    });
                    const completed = hasCorrected || [...assignedProductIds].every(productId => countedProductIds.has(productId));
                    if (completed) fulfilledDayKeys.add(key);
                }

                const prodAgg = new Map<string, { store_id: string; store_name: string; sku: string; description: string; cost: number; systemStock: number; counted: number }>();
                for (const asgn of asgnRows) {
                    const prod = prodMap.get(asgn.product_id);
                    if (!prod) continue;
                    // Solo considerar assignments de días que cumplieron
                    const dayKey = `${asgn.store_id}__${asgn.assigned_date}`;
                    if (!fulfilledDayKeys.has(dayKey)) continue;
                    const aggKey = `${asgn.store_id}__${asgn.product_id}`;
                    const prev = prodAgg.get(aggKey) ?? {
                        store_id: asgn.store_id,
                        store_name: storeNameById.get(asgn.store_id) || asgn.store_id,
                        sku: prod.sku || "",
                        description: prod.description || "",
                        cost: parseCost(prod.cost),
                        systemStock: 0,
                        counted: 0,
                    };
                    prev.systemStock = r2(prev.systemStock + Number(asgn.system_stock || 0));
                    prev.counted = r2(prev.counted + (cntByAsgn.get(asgn.id) || 0));
                    prodAgg.set(aggKey, prev);
                }

                for (const [, entry] of prodAgg) {
                    const diff = r2(entry.counted - entry.systemStock);
                    const difVal = r2(diff * entry.cost);
                    if (diff < 0) {
                        const key = `${entry.store_id}__${entry.sku}`;
                        const prev = skuFaltMap.get(key) ?? { store_name: entry.store_name, sku: entry.sku, description: entry.description, totalDif: 0, totalDifVal: 0 };
                        skuFaltMap.set(key, { ...prev, totalDif: r2(prev.totalDif + diff), totalDifVal: r2(prev.totalDifVal + difVal) });
                    } else if (diff > 0) {
                        const key = `${entry.store_id}__${entry.sku}`;
                        const prev = skuSobMap.get(key) ?? { store_name: entry.store_name, sku: entry.sku, description: entry.description, totalDif: 0, totalDifVal: 0 };
                        skuSobMap.set(key, { ...prev, totalDif: r2(prev.totalDif + diff), totalDifVal: r2(prev.totalDifVal + difVal) });
                    }
                }
            }
        } catch (e: any) {
            console.error("Error calculando top por código:", e);
        }

        const topFaltantes = [...skuFaltMap.values()].sort((a, b) => a.totalDifVal - b.totalDifVal).slice(0, 10);
        const topSobrantes = [...skuSobMap.values()].sort((a, b) => b.totalDifVal - a.totalDifVal).slice(0, 10);

        // ── Colores helper ──
        const eriColor = (v: number) => v >= 90 ? "#16a34a" : v >= 70 ? "#d97706" : "#dc2626";
        const pctColor = (v: number) => v >= 90 ? "#16a34a" : v >= 70 ? "#d97706" : "#dc2626";
        const difColor = (v: number) => v < 0 ? "#dc2626" : v > 0 ? "#2563eb" : "#16a34a";

        // ── Helper: convierte SVG string a PNG base64 via Canvas ──
        async function svgToPng(svgStr: string, width: number, height: number): Promise<string> {
            return new Promise((resolve) => {
                try {
                    const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
                    const url  = URL.createObjectURL(blob);
                    const img  = new Image();
                    img.onload = () => {
                        const canvas = document.createElement("canvas");
                        canvas.width  = width * 2;   // retina
                        canvas.height = height * 2;
                        const ctx = canvas.getContext("2d")!;
                        ctx.scale(2, 2);
                        ctx.fillStyle = "#f8fafc";
                        ctx.fillRect(0, 0, width, height);
                        ctx.drawImage(img, 0, 0, width, height);
                        URL.revokeObjectURL(url);
                        resolve(canvas.toDataURL("image/png"));
                    };
                    img.onerror = () => { URL.revokeObjectURL(url); resolve(""); };
                    img.src = url;
                } catch { resolve(""); }
            });
        }

        // ── Dimensiones base ──
        const barH     = 26;
        const gap      = 8;
        const svgFullW = 560;
        const eriLabelW = 180; // igual que dif, para consistencia

        // ── SVG helper: barra simple (ERI / Cumplimiento / Diferencia) ──
        const makeSingleBarSVG = (
            rows: { name: string; pct: number; color: string }[],
            svgWidth: number,
            lw: number
        ) => {
            const barArea = svgWidth - lw - 55; // deja espacio para el valor al final
            const h = rows.length * (barH + gap) + 34;
            const bars = rows.map((r, i) => {
                const y   = i * (barH + gap) + 24;
                const w   = Math.max(4, Math.round((r.pct / 100) * barArea));
                const name = r.name.length > 24 ? r.name.slice(0, 22) + "…" : r.name;
                return `<text x="0" y="${y + barH / 2 + 5}" font-size="11" fill="#1e293b" font-weight="600" font-family="Arial,sans-serif">${name}</text>
              <rect x="${lw}" y="${y}" width="${barArea}" height="${barH}" rx="4" fill="#e2e8f0"/>
              <rect x="${lw}" y="${y}" width="${w}" height="${barH}" rx="4" fill="${r.color}" opacity="0.90"/>
              <text x="${lw + w + 6}" y="${y + barH / 2 + 5}" font-size="11" fill="${r.color}" font-weight="800" font-family="Arial,sans-serif">${r.pct}%</text>`;
            }).join("\n");
            return { svg: `<svg width="${svgWidth}" height="${h}" xmlns="http://www.w3.org/2000/svg">
          <rect width="${svgWidth}" height="${h}" fill="#f8fafc"/>
          <text x="0" y="14" font-size="9" fill="#94a3b8" font-weight="700" font-family="Arial,sans-serif" letter-spacing="1">TIENDA</text>
          <text x="${lw}" y="14" font-size="9" fill="#94a3b8" font-family="Arial,sans-serif">0%</text>
          <text x="${lw + Math.round(barArea / 2) - 8}" y="14" font-size="9" fill="#94a3b8" font-family="Arial,sans-serif">50%</text>
          <text x="${lw + barArea - 16}" y="14" font-size="9" fill="#94a3b8" font-family="Arial,sans-serif">100%</text>
          <line x1="${lw + Math.round(barArea / 2)}" y1="17" x2="${lw + Math.round(barArea / 2)}" y2="${h}" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="3"/>
          ${bars}
        </svg>`, h };
        };

        // ── Gráfico ERI por tienda (ancho completo) ──
        const storesERI = [...emailFilasQueComplieron].sort((a, b) => a.eri - b.eri);
        const eriRows   = storesERI.map(r => ({ name: r.store_name, pct: r.eri, color: eriColor(r.eri) }));
        const { svg: svgERI, h: svgEriH } = makeSingleBarSVG(eriRows, svgFullW, eriLabelW);

        // ── Gráfico Cumplimiento por tienda (ancho completo) ──
        const complianceStores = [...filteredDashData].sort((a, b) => {
            const ap = dashPeriod === "dia" ? (a.cumplio ? 100 : 0) : a.cumplimiento_pct;
            const bp = dashPeriod === "dia" ? (b.cumplio ? 100 : 0) : b.cumplimiento_pct;
            return ap - bp;
        });
        const cumplRows = complianceStores.map(r => {
            const pct = dashPeriod === "dia" ? (r.cumplio ? 100 : 0) : r.cumplimiento_pct;
            return { name: r.store_name, pct, color: pctColor(pct) };
        });
        const { svg: svgCumpl, h: svgCumplH } = makeSingleBarSVG(cumplRows, svgFullW, eriLabelW);

        // ── Gráfico Diferencia Valorizada (ancho completo, solo con diferencias) ──
        const storesDif = [...emailFilasQueComplieron]
            .filter(r => (r.dif_valorizada || 0) !== 0)
            .sort((a, b) => (a.dif_valorizada || 0) - (b.dif_valorizada || 0));
        const maxAbsDif = Math.max(...storesDif.map(r => Math.abs(r.dif_valorizada || 0)), 1);
        const difBarArea = svgFullW - eriLabelW - 20;
        const svgDifH   = storesDif.length > 0 ? storesDif.length * (barH + gap) + 30 : 0;
        const difBarsInner = storesDif.map((r, i) => {
            const y    = i * (barH + gap) + 20;
            const val  = r.dif_valorizada || 0;
            const w    = Math.max(3, Math.round((Math.abs(val) / maxAbsDif) * (difBarArea / 2)));
            const col  = difColor(val);
            const cx   = eriLabelW + Math.round(difBarArea / 2);
            const x    = val < 0 ? cx - w : cx;
            const name = r.store_name.length > 26 ? r.store_name.slice(0, 24) + "…" : r.store_name;
            const label = `S/${val >= 0 ? "+" : ""}${Number(val).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            return `<text x="0" y="${y + barH / 2 + 4}" font-size="11" fill="#1e293b" font-weight="600" font-family="Arial,sans-serif">${name}</text>
              <rect x="${cx}" y="${y}" width="1" height="${barH}" fill="#cbd5e1"/>
              <rect x="${x}" y="${y}" width="${w}" height="${barH}" rx="3" fill="${col}" opacity="0.82"/>
              <text x="${val < 0 ? cx - w - 3 : cx + w + 3}" y="${y + barH / 2 + 5}" font-size="11" fill="${col}" font-weight="800" font-family="Arial,sans-serif" text-anchor="${val < 0 ? "end" : "start"}">${label}</text>`;
        }).join("\n");
        const svgDif = storesDif.length > 0
            ? `<svg width="${svgFullW}" height="${svgDifH}" xmlns="http://www.w3.org/2000/svg">
          <rect width="${svgFullW}" height="${svgDifH}" fill="#f8fafc"/>
          <text x="${eriLabelW + Math.round(difBarArea / 4)}" y="14" font-size="9" fill="#dc2626" font-weight="700" font-family="Arial,sans-serif" text-anchor="middle">← Faltante</text>
          <text x="${eriLabelW + Math.round(difBarArea * 3 / 4)}" y="14" font-size="9" fill="#2563eb" font-weight="700" font-family="Arial,sans-serif" text-anchor="middle">Sobrante →</text>
          ${difBarsInner}
        </svg>`
            : "";

        // Convertir los SVGs a PNG base64
        const [pngERI, pngCumpl, pngDif] = await Promise.all([
            svgToPng(svgERI,   svgFullW, svgEriH),
            svgToPng(svgCumpl, svgFullW, svgCumplH),
            svgDif ? svgToPng(svgDif, svgFullW, svgDifH) : Promise.resolve(""),
        ]);

        // ── Tabla detalle por tienda ──
        const storeRows = [...emailFilasQueComplieron]
            .sort((a, b) => a.eri - b.eri)
            .map(r => {
                const cumpl = dashPeriod === "dia"
                    ? (r.cumplio ? "✓ Sí" : "✗ No")
                    : `${r.dias_cumplidos}/${r.dias_totales} días`;
                const cumplColor = r.cumplio || r.dias_cumplidos > 0 ? "#16a34a" : "#dc2626";
                return `
                <tr style="border-bottom:1px solid #f1f5f9;">
                  <td style="padding:6px 10px;font-size:11px;font-weight:600;color:#1e293b;">${r.store_name}</td>
                  <td style="padding:6px;text-align:center;font-size:11px;color:#475569;">${r.total_asignados}</td>
                  <td style="padding:6px;text-align:center;font-size:11px;color:#16a34a;font-weight:700;">${r.total_ok}</td>
                  <td style="padding:6px;text-align:center;font-size:11px;color:#2563eb;font-weight:600;">${r.total_sobrantes}</td>
                  <td style="padding:6px;text-align:center;font-size:11px;color:#dc2626;font-weight:600;">${r.total_faltantes}</td>
                  <td style="padding:6px;text-align:center;font-size:11px;color:${difColor(r.dif_valorizada)};font-weight:700;">${formatMoney(r.dif_valorizada)}</td>
                  <td style="padding:6px;text-align:center;"><span style="background:${eriColor(r.eri)}22;color:${eriColor(r.eri)};font-weight:800;font-size:11px;padding:2px 7px;border-radius:20px;">${r.eri}%</span></td>
                  <td style="padding:6px;text-align:center;font-size:11px;font-weight:700;color:${cumplColor};">${cumpl}</td>
                </tr>`;
            }).join("");

        // ── Tabla top faltantes por código ──
        const faltantesRows = topFaltantes.length === 0
            ? `<tr><td colspan="5" style="padding:12px;text-align:center;color:#94a3b8;font-size:13px;">Sin diferencias negativas en el período</td></tr>`
            : topFaltantes.map(r => `
                <tr style="border-bottom:1px solid #fef2f2;">
                  <td style="padding:5px 8px;font-size:10px;font-weight:700;color:#1e293b;">${r.store_name}</td>
                  <td style="padding:5px;font-size:10px;font-weight:700;color:#1e293b;">${r.sku}</td>
                  <td style="padding:5px;font-size:10px;color:#475569;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.description}</td>
                  <td style="padding:5px;text-align:center;font-size:10px;color:#dc2626;font-weight:700;">${Number(r.totalDif).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td style="padding:5px;text-align:center;font-size:10px;color:#dc2626;font-weight:800;">${formatMoney(r.totalDifVal)}</td>
                </tr>`).join("");

        // ── Tabla top sobrantes por código ──
        const sobrantesRows = topSobrantes.length === 0
            ? `<tr><td colspan="5" style="padding:12px;text-align:center;color:#94a3b8;font-size:13px;">Sin diferencias positivas en el período</td></tr>`
            : topSobrantes.map(r => `
                <tr style="border-bottom:1px solid #eff6ff;">
                  <td style="padding:5px 8px;font-size:10px;font-weight:700;color:#1e293b;">${r.store_name}</td>
                  <td style="padding:5px;font-size:10px;font-weight:700;color:#1e293b;">${r.sku}</td>
                  <td style="padding:5px;font-size:10px;color:#475569;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.description}</td>
                  <td style="padding:5px;text-align:center;font-size:10px;color:#2563eb;font-weight:700;">+${Number(r.totalDif).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td style="padding:5px;text-align:center;font-size:10px;color:#2563eb;font-weight:800;">${formatMoney(r.totalDifVal)}</td>
                </tr>`).join("");

        const today = new Date().toLocaleDateString("es-PE", { day: "2-digit", month: "long", year: "numeric" });

        const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Informe Conteo Cíclico — ${periodoLabel}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:660px;margin:24px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.10);">

  <!-- HEADER -->
  <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 60%,#1d4ed8 100%);padding:28px 32px 22px;">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
      <div style="background:rgba(255,255,255,0.12);border-radius:10px;width:38px;height:38px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <span style="color:white;font-size:20px;line-height:1;">📦</span>
      </div>
      <div>
        <p style="margin:0;color:#93c5fd;font-weight:900;font-size:13px;letter-spacing:1.5px;">AUDITORÍA Y CONTROL DE INVENTARIOS</p>
        <p style="margin:2px 0 0;color:#64748b;font-size:10px;letter-spacing:1px;">SISTEMA DE CONTEO CÍCLICO</p>
      </div>
    </div>
    <h1 style="margin:0 0 4px;color:#ffffff;font-size:20px;font-weight:800;line-height:1.2;">Informe de Conteo Cíclico</h1>
    <p style="margin:0;color:#93c5fd;font-size:13px;">Período: <strong style="color:#ffffff;">${periodoLabel}</strong></p>
    <p style="margin:5px 0 0;color:#475569;font-size:11px;">Generado el ${today} · Área de Auditoría y Control de Inventarios</p>
  </div>

  <!-- BODY -->
  <div style="padding:24px 32px;">

    <!-- Saludo -->
    <p style="margin:0 0 20px;font-size:13px;color:#334155;line-height:1.6;">
      Estimado equipo,<br>
      A continuación el <strong>resumen ejecutivo del conteo cíclico</strong> del período <strong>${periodoLabel}</strong>.
      Revisar los resultados con los equipos de tienda y tomar acciones correctivas ante las diferencias identificadas.
    </p>

    <!-- KPIs globales -->
    <h2 style="margin:0 0 10px;font-size:12px;color:#0f172a;font-weight:800;border-left:3px solid #1d4ed8;padding-left:10px;text-transform:uppercase;letter-spacing:.5px;">Resumen General</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      <tr>
        <td style="padding:3px;width:33%;">
          <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:26px;font-weight:900;color:${eriColor(eriGlobal)};line-height:1;">${eriGlobal}%</div>
            <div style="font-size:10px;color:#64748b;font-weight:700;margin-top:3px;">ERI GLOBAL</div>
            <div style="font-size:9px;color:#94a3b8;">Exactitud inventario</div>
          </div>
        </td>
        <td style="padding:3px;width:33%;">
          <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:26px;font-weight:900;color:${pctColor(pctCumplimiento)};line-height:1;">${pctCumplimiento}%</div>
            <div style="font-size:10px;color:#64748b;font-weight:700;margin-top:3px;">CUMPLIMIENTO</div>
            <div style="font-size:9px;color:#94a3b8;">${cumplidos} de ${totalCumplimiento} ${cumplimientoUnidad}</div>
          </div>
        </td>
        <td style="padding:3px;width:34%;">
          <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:17px;font-weight:900;color:${difColor(totalDifVal)};line-height:1;">${formatMoney(totalDifVal)}</div>
            <div style="font-size:10px;color:#64748b;font-weight:700;margin-top:3px;">DIF. VALORIZADA</div>
            <div style="font-size:9px;color:#94a3b8;">${totalFaltantes} falt. · ${totalSobrantes} sob.</div>
          </div>
        </td>
      </tr>
    </table>

    <!-- Gráfico ERI por tienda -->
    <h2 style="margin:0 0 8px;font-size:12px;color:#0f172a;font-weight:800;border-left:3px solid #16a34a;padding-left:10px;text-transform:uppercase;letter-spacing:.5px;">ERI por Tienda (%)</h2>
    <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:20px;overflow:hidden;">
      ${pngERI ? `<img src="${pngERI}" width="100%" style="display:block;max-width:100%;" alt="ERI"/>` : "<p style='color:#94a3b8;font-size:12px;margin:0;'>Sin datos</p>"}
    </div>

    <!-- Gráfico Cumplimiento por tienda -->
    <h2 style="margin:0 0 8px;font-size:12px;color:#0f172a;font-weight:800;border-left:3px solid #7c3aed;padding-left:10px;text-transform:uppercase;letter-spacing:.5px;">Cumplimiento por Tienda (%)</h2>
    <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:20px;overflow:hidden;">
      ${pngCumpl ? `<img src="${pngCumpl}" width="100%" style="display:block;max-width:100%;" alt="Cumplimiento"/>` : "<p style='color:#94a3b8;font-size:12px;margin:0;'>Sin datos</p>"}
    </div>

    <!-- Gráfico Dif Valorizada (solo si hay diferencias) -->
    ${pngDif ? `
    <h2 style="margin:0 0 8px;font-size:12px;color:#0f172a;font-weight:800;border-left:3px solid #dc2626;padding-left:10px;text-transform:uppercase;letter-spacing:.5px;">Diferencia Valorizada por Tienda (S/)</h2>
    <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:10px;margin-bottom:20px;overflow:hidden;">
      <img src="${pngDif}" width="100%" style="display:block;max-width:100%;" alt="Dif. Valorizada"/>
    </div>` : ""}

    <!-- Tabla resumen por tienda -->
    <h2 style="margin:0 0 8px;font-size:12px;color:#0f172a;font-weight:800;border-left:3px solid #0f172a;padding-left:10px;text-transform:uppercase;letter-spacing:.5px;">Detalle por Tienda</h2>
    <div style="border:1.5px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:20px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:11px;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:8px 10px;text-align:left;color:#475569;font-size:10px;font-weight:700;letter-spacing:.5px;">TIENDA</th>
            <th style="padding:8px 6px;text-align:center;color:#475569;font-size:10px;font-weight:700;">ASIG.</th>
            <th style="padding:8px 6px;text-align:center;color:#16a34a;font-size:10px;font-weight:700;">OK</th>
            <th style="padding:8px 6px;text-align:center;color:#2563eb;font-size:10px;font-weight:700;">SOB.</th>
            <th style="padding:8px 6px;text-align:center;color:#dc2626;font-size:10px;font-weight:700;">FALT.</th>
            <th style="padding:8px 6px;text-align:center;color:#7c3aed;font-size:10px;font-weight:700;">DIF. VAL.</th>
            <th style="padding:8px 6px;text-align:center;color:#475569;font-size:10px;font-weight:700;">ERI%</th>
            <th style="padding:8px 6px;text-align:center;color:#475569;font-size:10px;font-weight:700;">CUMPL.</th>
          </tr>
        </thead>
        <tbody>${storeRows}</tbody>
      </table>
    </div>

    <!-- Top faltantes y sobrantes -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      <tr>
        <td style="padding-right:6px;vertical-align:top;width:50%;">
          <h2 style="margin:0 0 8px;font-size:12px;color:#dc2626;font-weight:800;border-left:3px solid #dc2626;padding-left:10px;text-transform:uppercase;letter-spacing:.5px;">🔴 Top 10 Faltantes</h2>
          <div style="border:1.5px solid #fee2e2;border-radius:10px;overflow:hidden;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:10px;">
              <thead><tr style="background:#fef2f2;">
                <th style="padding:6px 8px;text-align:left;color:#dc2626;font-size:9px;font-weight:700;">TIENDA</th>
                <th style="padding:6px;text-align:left;color:#dc2626;font-size:9px;font-weight:700;">SKU</th>
                <th style="padding:6px;text-align:left;color:#dc2626;font-size:9px;font-weight:700;">DESCRIPCIÓN</th>
                <th style="padding:6px;text-align:center;color:#dc2626;font-size:9px;font-weight:700;">DIF.</th>
                <th style="padding:6px;text-align:center;color:#dc2626;font-size:9px;font-weight:700;">S/</th>
              </tr></thead>
              <tbody>${faltantesRows}</tbody>
            </table>
          </div>
        </td>
        <td style="padding-left:6px;vertical-align:top;width:50%;">
          <h2 style="margin:0 0 8px;font-size:12px;color:#2563eb;font-weight:800;border-left:3px solid #2563eb;padding-left:10px;text-transform:uppercase;letter-spacing:.5px;">🔵 Top 10 Sobrantes</h2>
          <div style="border:1.5px solid #dbeafe;border-radius:10px;overflow:hidden;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:10px;">
              <thead><tr style="background:#eff6ff;">
                <th style="padding:6px 8px;text-align:left;color:#2563eb;font-size:9px;font-weight:700;">TIENDA</th>
                <th style="padding:6px;text-align:left;color:#2563eb;font-size:9px;font-weight:700;">SKU</th>
                <th style="padding:6px;text-align:left;color:#2563eb;font-size:9px;font-weight:700;">DESCRIPCIÓN</th>
                <th style="padding:6px;text-align:center;color:#2563eb;font-size:9px;font-weight:700;">DIF.</th>
                <th style="padding:6px;text-align:center;color:#2563eb;font-size:9px;font-weight:700;">S/</th>
              </tr></thead>
              <tbody>${sobrantesRows}</tbody>
            </table>
          </div>
        </td>
      </tr>
    </table>

    <!-- Mensaje de acción -->
    <div style="background:#fffbeb;border:1.5px solid #fcd34d;border-radius:10px;padding:12px 16px;margin-bottom:20px;">
      <p style="margin:0;font-size:11px;color:#92400e;line-height:1.7;">
        <strong>📋 Acciones requeridas:</strong><br>
        • Revisar con los jefes de tienda las diferencias de faltantes más significativas.<br>
        • Verificar ubicaciones en tiendas con ERI menor al 80%.<br>
        • Tiendas que no cumplieron deben reprogramar el conteo a la brevedad.
      </p>
    </div>

    <!-- Firma -->
    <div style="border-top:1.5px solid #e2e8f0;padding-top:16px;">
      <p style="margin:0;font-size:12px;color:#475569;line-height:1.7;">
        Atentamente,<br>
        <strong style="color:#0f172a;">Analista de Inventarios</strong><br>
        <span style="color:#94a3b8;font-size:11px;">Área de Auditoría y Control de Inventarios · ${today}</span>
      </p>
    </div>

  </div>

  <!-- FOOTER -->
  <div style="background:#f8fafc;border-top:1.5px solid #e2e8f0;padding:12px 32px;text-align:center;">
    <p style="margin:0;font-size:10px;color:#94a3b8;">
      Generado automáticamente por el Sistema de Conteo Cíclico · Área de Auditoría y Control de Inventarios
    </p>
  </div>

</div>
</body></html>`;

        setEmailHTML(html);
        setShowEmailModal(true);
        showMessage("", "info");
    }

    function exportDashboard() {
        const rows = filteredDashData.map(r => {
            const base: any = { TIENDA: r.store_name };
            if (dashPeriod === "dia") {
                // Vista día: incluye hora inicio/fin/duración, sin días_cumplidos
                base.ASIGNADOS      = r.total_asignados;
                base.OK             = r.total_ok;
                base.SOBRANTES      = r.total_sobrantes;
                base.FALTANTES      = r.total_faltantes;
                base.DIF_VALORIZADA = r.dif_valorizada || 0;
                base.ERI_PCT        = r.eri;
                base.CUMPLIMIENTO   = r.cumplio ? "Sí" : "No";
                base.HORA_INICIO    = r.hora_inicio ? formatDateTime(r.hora_inicio) : "—";
                base.HORA_FIN       = r.hora_fin ? formatDateTime(r.hora_fin) : "—";
                base.DURACION       = r.duracion_min !== null ? formatDuration(r.duracion_min) : "—";
            } else {
                // Vista mes/rango: todo el periodo, sin hora/duración
                base.ASIGNADOS_PERIODO = r.total_asignados_periodo ?? r.total_asignados;
                base.ASIGNADOS         = r.total_asignados;
                base.OK                = r.total_ok;
                base.SOBRANTES         = r.total_sobrantes;
                base.FALTANTES         = r.total_faltantes;
                base.DIF_VALORIZADA    = r.dif_valorizada || 0;
                base.ERI_PCT           = r.eri;
                base.CUMPLIMIENTO_PCT  = r.cumplimiento_pct;
                base.DIAS_CUMPLIDOS    = r.dias_cumplidos;
                base.DIAS_TOTALES      = r.dias_totales;
            }
            return base;
        });
        const ws = XLSX.utils.json_to_sheet(rows);
        const wbk = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wbk, ws, "Dashboard");
        XLSX.writeFile(wbk, `dashboard_ciclicos_${dashPeriod === "dia" ? dashDate : dashPeriod === "mes" ? dashMonth : `${dashRangeFrom}_${dashRangeTo}`}.xlsx`);
    }

    // ════════════════════════════════════════════════════════
    //  EXPORT GLOBAL — todas las tiendas con rango
    // ════════════════════════════════════════════════════════
    async function exportGlobal() {
        setGlobalExportLoading(true);
        try {
            let from = dashDate, to = dashDate;
            if (dashPeriod === "mes") {
                const [yr, mo] = dashMonth.split("-").map(Number);
                from = `${dashMonth}-01`;
                const lastDay = new Date(yr, mo, 0).getDate();
                to = `${dashMonth}-${String(lastDay).padStart(2, "0")}`;
            } else if (dashPeriod === "rango") {
                from = dashRangeFrom; to = dashRangeTo;
            }

            // ── Paso 1: assignments paginado sin joins ────────────────
            const EXP_PAGE = 1000;
            let asgnRaw2: any[] = [];
            let expPage = 0;
            while (true) {
                const { data: expChunk, error: eExp } = await supabase
                    .from("cyclic_assignments")
                    .select("id, store_id, product_id, system_stock, assigned_date")
                    .gte("assigned_date", from)
                    .lte("assigned_date", to)
                    .order("assigned_date")
                    .order("id")
                    .range(expPage * EXP_PAGE, (expPage + 1) * EXP_PAGE - 1);
                if (eExp) { console.error("exportGlobal asgn error", eExp); showMessage("Error BD export: " + JSON.stringify(eExp), "error"); break; }
                if (!expChunk || expChunk.length === 0) break;
                asgnRaw2 = asgnRaw2.concat(expChunk);
                if (expChunk.length < EXP_PAGE) break;
                expPage++;
            }

            if (asgnRaw2.length === 0) {
                showMessage(`No hay asignaciones: ${from} → ${to}. Ver consola F12.`, "error");
                setGlobalExportLoading(false); return;
            }

            // ── Paso 2: stores y products por IDs únicos ─────────────
            const expStoreIds = [...new Set(asgnRaw2.map((a: any) => a.store_id))];
            const expProdIds  = [...new Set(asgnRaw2.map((a: any) => a.product_id))];

            let expStores: any[] = [];
            for (let i = 0; i < expStoreIds.length; i += 500) {
                const { data: sc } = await supabase.from("stores").select("id, name").in("id", expStoreIds.slice(i, i+500));
                expStores = expStores.concat(sc || []);
            }
            const expStoreMap = new Map(expStores.map((s: any) => [s.id, s.name]));

            let expProds: any[] = [];
            for (let i = 0; i < expProdIds.length; i += 500) {
                const { data: pc } = await supabase.from("cyclic_products").select("id, sku, description, unit, cost").in("id", expProdIds.slice(i, i+500));
                expProds = expProds.concat(pc || []);
            }
            const expProdMap = new Map(expProds.map((p: any) => [p.id, p]));

            // Enriquecer assignments (costo viene solo de cyclic_products)
            const asgnData = asgnRaw2.map((a: any) => {
                const prod = expProdMap.get(a.product_id) || {};
                return {
                    ...a,
                    cost: 0, // columna no existe en cyclic_assignments, usar cyclic_products
                    stores: { name: expStoreMap.get(a.store_id) || a.store_id },
                    cyclic_products: prod,
                };
            });

            // Traer counts por store_id + rango de fechas (evita límite de .in() con miles de IDs)
            const asgnIds = asgnData.map((a: any) => a.id);
            const asgnIdSetExp = new Set<string>(asgnIds);
            let allCounts: CountRecord[] = [];
            for (let i = 0; i < asgnIds.length; i += 500) {
                const { data: cData } = await supabase
                    .from("cyclic_counts")
                    .select("*")
                    .in("assignment_id", asgnIds.slice(i, i + 500));
                if (cData) allCounts = allCounts.concat(cData as CountRecord[]);
            }

            const SESSION_FLAGS_EXP = new Set(["__session_counting__", "__session_finished__", "__recount_started__", "__recount_done__"]);
            const countMap = new Map<string, CountRecord[]>();
            for (const c of allCounts.filter((c: any) => !SESSION_FLAGS_EXP.has(c.location) && asgnIdSetExp.has(c.assignment_id))) {
                if (!countMap.has(c.assignment_id)) countMap.set(c.assignment_id, []);
                countMap.get(c.assignment_id)!.push(c);
            }

            // ── Paso 3b: determinar qué tienda-días cumplieron (flags de sesión) ──
            // Necesario para marcar CUMPLIO a nivel tienda-día, no producto individual
            const expAsgnById2 = new Map<string, any>();
            for (const a of asgnData as any[]) expAsgnById2.set(a.id, a);
            const recountDoneKeys2 = new Set<string>();
            const sessionFinishedKeys2 = new Set<string>();
            for (let i = 0; i < asgnIds.length; i += 500) {
                const { data: flagChunk2 } = await supabase
                    .from("cyclic_counts")
                    .select("assignment_id, location")
                    .in("assignment_id", asgnIds.slice(i, i + 500))
                    .in("location", ["__recount_done__", "__session_finished__"]);
                for (const flag of flagChunk2 || []) {
                    const asg2 = expAsgnById2.get(flag.assignment_id);
                    if (!asg2) continue;
                    const dk = `${asg2.store_id}__${asg2.assigned_date}`;
                    if (flag.location === "__recount_done__") recountDoneKeys2.add(dk);
                    if (flag.location === "__session_finished__") sessionFinishedKeys2.add(dk);
                }
            }
            // Determinar si cada tienda-día cumplió: contó todos sus productos O tiene flag recount_done
            // Agrupar products por tienda-día para verificar cobertura
            const dayProdCounted2 = new Map<string, { total: number; counted: number }>();
            for (const asg of asgnData as any[]) {
                const dk = `${asg.store_id}__${asg.assigned_date}`;
                const pk = `${dk}__${asg.product_id}`;
                if (!dayProdCounted2.has(dk)) dayProdCounted2.set(dk, { total: 0, counted: 0 });
                // count unique products per day
            }
            // Build unique product sets per day-store
            const dayProdsSet = new Map<string, Set<string>>();
            const dayProdsCountedSet = new Map<string, Set<string>>();
            for (const asg of asgnData as any[]) {
                const dk = `${asg.store_id}__${asg.assigned_date}`;
                if (!dayProdsSet.has(dk)) { dayProdsSet.set(dk, new Set()); dayProdsCountedSet.set(dk, new Set()); }
                dayProdsSet.get(dk)!.add(asg.product_id);
                const cnts2 = countMap.get(asg.id) || [];
                if (cnts2.length > 0) dayProdsCountedSet.get(dk)!.add(asg.product_id);
            }
            const cumplioByDayKey = new Set<string>();
            for (const [dk, prods] of dayProdsSet) {
                const counted = dayProdsCountedSet.get(dk)!;
                const allCounted = prods.size > 0 && counted.size === prods.size;
                if (recountDoneKeys2.has(dk) || (sessionFinishedKeys2.has(dk) && allCounted) || allCounted) {
                    cumplioByDayKey.add(dk);
                }
            }

            // Agrupar por tienda + fecha + producto (suma múltiples ubicaciones)
            type ExportKey = string;
            const resMap = new Map<ExportKey, {
                tienda: string; fecha: string; sku: string; descripcion: string; unidad: string;
                costo: number; stock_sistema: number; total_contado: number;
                diferencia: number; dif_valorizada: number; estado: string;
                cumplio: string; fecha_asignacion: string;
            }>();

            for (const asg of asgnData as any[]) {
                const key = `${asg.store_id}__${asg.assigned_date}__${asg.product_id}`;
                const dayKey2 = `${asg.store_id}__${asg.assigned_date}`;
                const prod = asg.cyclic_products || {};
                const tienda = asg.stores?.name || asg.store_id;
                const costo = parseCost(prod.cost);
                const stock = Number(asg.system_stock || 0);
                const cnts = countMap.get(asg.id) || [];
                const totalContado = cnts.reduce((s: number, c: any) => s + Number(c.counted_quantity), 0);
                // CUMPLIO refleja si la TIENDA-DÍA completa cumplió, no el producto individual
                const cumplioStr = cumplioByDayKey.has(dayKey2) ? "SI" : "NO";

                if (!resMap.has(key)) {
                    resMap.set(key, {
                        tienda, fecha: asg.assigned_date,
                        sku: prod.sku || asg.product_id,
                        descripcion: prod.description || "",
                        unidad: prod.unit || "",
                        costo, stock_sistema: stock,
                        total_contado: 0, diferencia: 0, dif_valorizada: 0,
                        estado: "", cumplio: cumplioStr,
                        fecha_asignacion: asg.assigned_date,
                    });
                }
                const row = resMap.get(key)!;
                row.total_contado += totalContado;
                if (costo > 0 && row.costo === 0) row.costo = costo;
            }

            // Calcular diferencias finales
            const exportRows: any[] = [];
            for (const r of resMap.values()) {
                r.diferencia = r2(r.total_contado - r.stock_sistema);
                r.dif_valorizada = r2(r.diferencia * r.costo);
                r.estado = r.cumplio === "NO" ? "NO CONTADO" : r.diferencia === 0 ? "OK" : r.diferencia > 0 ? "SOBRANTE" : "FALTANTE";
                exportRows.push({
                    TIENDA: r.tienda,
                    FECHA_ASIGNACION: r.fecha_asignacion,
                    SKU: r.sku,
                    DESCRIPCION: r.descripcion,
                    UNIDAD: r.unidad,
                    COSTO: r.costo,
                    STOCK: r.stock_sistema,
                    CONTEO: r.total_contado,
                    DIFERENCIA: r.diferencia,
                    ESTADO: r.estado,
                    DIF_VALORIZADA: r.dif_valorizada,
                    CUMPLIO: r.cumplio,
                });
            }

            exportRows.sort((a, b) => (a.TIENDA + a.FECHA_ASIGNACION + a.SKU).localeCompare(b.TIENDA + b.FECHA_ASIGNACION + b.SKU));

            // Hoja 2: Resumen por tienda+día (igual que el dashboard)
            // Primero agrupar por tienda+día+producto para sumar todas las ubicaciones antes de comparar con stock
            type DaySum = { tienda: string; fecha: string; asignados: number; ok: number; sobrantes: number; faltantes: number; difVal: number; cumplio: boolean; duracion: number | null; horaInicio: string | null; horaFin: string | null; };
            const daySumMap = new Map<string, DaySum>();

            // Agrupar assignments por tienda+día+producto
            type DayProdEntry = { stock: number; costo: number; totalContado: number; tienConteo: boolean; };
            const dayProdMap = new Map<string, DayProdEntry>();

            // Construir mapa de assignment_id → asignación para exportGlobal
            const expAsgnById = new Map<string, any>();
            for (const a of asgnData as any[]) expAsgnById.set(a.id, a);
            const recountDoneDayKeys = new Set<string>();
            const sessionFinishedDayKeys = new Set<string>();
            for (let i = 0; i < asgnIds.length; i += 500) {
                const { data: flagChunk } = await supabase
                    .from("cyclic_counts")
                    .select("assignment_id, location")
                    .in("assignment_id", asgnIds.slice(i, i + 500))
                    .in("location", ["__recount_done__", "__session_finished__"]);
                for (const flag of flagChunk || []) {
                    const asg = expAsgnById.get(flag.assignment_id);
                    if (!asg) continue;
                    const dayKey = `${asg.store_id}__${asg.assigned_date}`;
                    if (flag.location === "__recount_done__") recountDoneDayKeys.add(dayKey);
                    if (flag.location === "__session_finished__") sessionFinishedDayKeys.add(dayKey);
                }
            }

            for (const asg of asgnData as any[]) {
                const dayKey = `${asg.store_id}__${asg.assigned_date}`;
                const prodKey = `${asg.store_id}__${asg.assigned_date}__${asg.product_id}`;
                const tienda = asg.stores?.name || asg.store_id;

                if (!daySumMap.has(dayKey)) {
                    daySumMap.set(dayKey, { tienda, fecha: asg.assigned_date, asignados: 0, ok: 0, sobrantes: 0, faltantes: 0, difVal: 0, cumplio: false, duracion: null, horaInicio: null, horaFin: null });
                }

                const prod = asg.cyclic_products || {};
                const costo = parseCost(prod.cost);
                const stock = Number(asg.system_stock || 0);
                const cnts = (countMap.get(asg.id) || []);
                const totalContado = cnts.reduce((s: number, c: any) => s + Number(c.counted_quantity), 0);
                const tienConteo = cnts.length > 0;

                if (!dayProdMap.has(prodKey)) {
                    dayProdMap.set(prodKey, { stock, costo: costo > 0 ? costo : 0, totalContado: 0, tienConteo: false });
                }
                const dp = dayProdMap.get(prodKey)!;
                dp.totalContado += totalContado;
                if (tienConteo) dp.tienConteo = true;
                if (costo > 0 && dp.costo === 0) dp.costo = costo;

                // Horas: recopilar sobre el daySumMap
                const ds = daySumMap.get(dayKey)!;
                for (const c of cnts) {
                    const t = new Date(c.counted_at).getTime();
                    if (!isNaN(t)) {
                        if (ds.horaInicio === null || t < new Date(ds.horaInicio).getTime()) ds.horaInicio = c.counted_at;
                        if (ds.horaFin === null || t > new Date(ds.horaFin).getTime()) ds.horaFin = c.counted_at;
                    }
                }
            }

            // Ahora calcular métricas por día usando los totales agrupados por producto
            // Primero identificar qué productos pertenecen a cada día
            const dayKeySet = new Map<string, Set<string>>(); // dayKey → set of prodKeys
            for (const prodKey of dayProdMap.keys()) {
                // prodKey = "storeId__date__productId"
                const parts = prodKey.split("__");
                const dayKey = `${parts[0]}__${parts[1]}`;
                if (!dayKeySet.has(dayKey)) dayKeySet.set(dayKey, new Set());
                dayKeySet.get(dayKey)!.add(prodKey);
            }

            for (const [dayKey, prodKeys] of dayKeySet) {
                const ds = daySumMap.get(dayKey);
                if (!ds) continue;
                for (const prodKey of prodKeys) {
                    const dp = dayProdMap.get(prodKey)!;
                    const diff = dp.tienConteo ? dp.totalContado - dp.stock : -dp.stock;
                    ds.asignados++;
                    if (!dp.tienConteo) { ds.faltantes++; }
                    else if (diff === 0) { ds.ok++; }
                    else if (diff > 0) { ds.sobrantes++; }
                    else { ds.faltantes++; }
                    if (dp.tienConteo) { ds.difVal += diff * dp.costo; }
                }
            }

            for (const [dayKey, ds] of daySumMap.entries()) {
                // Cumplió = reconteo completo, O terminó sesión sin productos sin contar.
                const noContadosDia = ds.asignados - ds.ok - ds.sobrantes - ds.faltantes;
                const noContadosRealDia = Array.from(dayKeySet.get(dayKey) || []).filter(pk => !dayProdMap.get(pk)?.tienConteo).length;
                ds.cumplio = recountDoneDayKeys.has(dayKey) || (sessionFinishedDayKeys.has(dayKey) && noContadosRealDia === 0);
                if (ds.horaInicio && ds.horaFin) {
                    ds.duracion = Math.round((new Date(ds.horaFin).getTime() - new Date(ds.horaInicio).getTime()) / 60000);
                }
            }

            const summaryRows = Array.from(daySumMap.values()).sort((a, b) => (a.tienda + a.fecha).localeCompare(b.tienda + b.fecha)).map(ds => ({
                TIENDA: ds.tienda,
                FECHA: ds.fecha,
                ASIGNADOS: ds.asignados,
                OK: ds.ok,
                SOBRANTES: ds.sobrantes,
                FALTANTES: ds.faltantes,
                DIF_VALORIZADA: ds.difVal,
                ERI_PCT: (ds.ok + ds.sobrantes + ds.faltantes) > 0 ? Math.round((ds.ok / (ds.ok + ds.sobrantes + ds.faltantes)) * 100) : 0,
                CUMPLIMIENTO: ds.cumplio ? "SI" : "NO",
                HORA_INICIO: ds.horaInicio ? formatDateTime(ds.horaInicio) : "—",
                HORA_FIN: ds.horaFin ? formatDateTime(ds.horaFin) : "—",
                DURACION: ds.duracion !== null ? formatDuration(ds.duracion) : "—",
            }));

            const ws = XLSX.utils.json_to_sheet(exportRows);
            const wbk = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wbk, ws, "Detalle Códigos");
            const fname = `ciclicos_global_${from}_${to}.xlsx`;
            XLSX.writeFile(wbk, fname);
            showMessage(`✅ Excel global descargado: ${exportRows.length} filas.`, "success");
        } catch (e: any) {
            showMessage("Error exportando: " + e.message, "error");
        } finally {
            setGlobalExportLoading(false);
        }
    }

    // ════════════════════════════════════════════════════════
    //  COMPUTED
    // ════════════════════════════════════════════════════════
    const myAssignments = useMemo(() => {
        const myCountIds = new Set(counts.map(c => c.assignment_id));
        return assignments.map(a => ({ ...a, counted: myCountIds.has(a.id), count_id: counts.find(c => c.assignment_id === a.id)?.id }));
    }, [assignments, counts]);

    const pendingAssignments = useMemo(() => myAssignments.filter(a => !a.counted), [myAssignments]);
    const doneAssignments    = useMemo(() => myAssignments.filter(a =>  a.counted), [myAssignments]);

    // Asignaciones con diferencia para el reconteo (contados con dif + no contados)
    const difAssignments = useMemo(() => {
        // Contados con diferencia: comparar la SUMA total de todas las ubicaciones vs system_stock
        const withDiff = doneAssignments.filter(a => {
            const aCounts = counts.filter(c => c.assignment_id === a.id);
            const totalContado = aCounts.reduce((s, c) => s + Number(c.counted_quantity), 0);
            return totalContado !== Number(a.system_stock);
        });
        // No contados (tienen diferencia implícita ya que el contado = 0 vs stock)
        const uncounted = pendingAssignments.filter(a => a.system_stock > 0);
        // Combinar, evitando duplicados
        const seen = new Set(withDiff.map(a => a.id));
        return [...withDiff, ...uncounted.filter(a => !seen.has(a.id))];
    }, [doneAssignments, pendingAssignments, counts]);

    const filteredCounts = useMemo(() => {
        return counts.filter(c => {
            const text = [c.sku, c.description, c.location, c.user_name, c.validator_name].join(" ").toLowerCase();
            const textOk = valSearchText ? text.includes(valSearchText.toLowerCase()) : true;
            const statusOk = valStatusFilter === "todos" ? true : c.status.toLowerCase() === valStatusFilter;
            return textOk && statusOk;
        });
    }, [counts, valSearchText, valStatusFilter]);

    const resumenPorCodigo = useMemo((): ResumenRow[] => {
        const map = new Map<string, ResumenRow>();
        for (const asg of assignments) {
            if (!map.has(asg.product_id)) {
                map.set(asg.product_id, {
                    product_id: asg.product_id,
                    sku: asg.sku || "",
                    description: asg.description || "",
                    unit: asg.unit || "",
                    cost: asg.cost || 0,
                    system_stock: asg.system_stock,
                    total_counted: 0,
                    difference: 0,
                    dif_valorizada: 0,
                });
            } else {
                // Si hay múltiples asignaciones del mismo producto, usar el costo más reciente (no 0)
                const existing = map.get(asg.product_id)!;
                if ((asg.cost || 0) > 0 && existing.cost === 0) existing.cost = asg.cost || 0;
            }
        }
        for (const c of counts) {
            const asg = assignments.find(a => a.id === c.assignment_id);
            const entry = map.get(c.product_id);
            if (entry) {
                entry.total_counted += Number(c.counted_quantity);
                // Usar el costo del conteo si está disponible y es mayor a 0
                if ((c.cost || 0) > 0) entry.cost = c.cost || 0;
                else if ((asg?.cost || 0) > 0) entry.cost = asg!.cost || 0;
            }
        }
        for (const entry of map.values()) {
            entry.difference = r2(entry.total_counted - entry.system_stock);
            entry.dif_valorizada = r2(entry.difference * entry.cost);
        }
        return Array.from(map.values()).sort((a, b) => a.sku.localeCompare(b.sku));
    }, [assignments, counts]);

    // Resumen con overrides aplicados para el modo análisis
    const resumenConOverrides = useMemo((): ResumenRow[] => {
        if (Object.keys(resumenOverrides).length === 0) return resumenPorCodigo;
        return resumenPorCodigo.map(r => {
            const ov = resumenOverrides[r.product_id];
            if (!ov) return r;
            const system_stock  = ov.system_stock  !== undefined ? ov.system_stock  : r.system_stock;
            const total_counted = ov.total_counted !== undefined ? ov.total_counted : r.total_counted;
            const difference    = r2(total_counted - system_stock);
            const dif_valorizada = r2(difference * r.cost);
            return { ...r, system_stock, total_counted, difference, dif_valorizada };
        });
    }, [resumenPorCodigo, resumenOverrides]);

    const filteredResumen = useMemo(() => {
        const base = resumenEditMode ? resumenConOverrides : resumenPorCodigo;
        let rows = !resumenSearch.trim() ? base : base.filter(r => {
            const q = resumenSearch.trim().toLowerCase();
            return r.sku.toLowerCase().includes(q) || r.description.toLowerCase().includes(q);
        });
        if (resumenSort) {
            const { col, dir } = resumenSort;
            const mul = dir === "asc" ? 1 : -1;
            rows = [...rows].sort((a, b) => {
                if (col === "sku")      return mul * a.sku.localeCompare(b.sku);
                if (col === "desc")     return mul * a.description.localeCompare(b.description);
                if (col === "um")       return mul * a.unit.localeCompare(b.unit);
                if (col === "stock")    return mul * (a.system_stock   - b.system_stock);
                if (col === "contado")  return mul * (a.total_counted  - b.total_counted);
                if (col === "dif")      return mul * (a.difference     - b.difference);
                if (col === "costo")    return mul * (a.cost           - b.cost);
                if (col === "val")      return mul * (a.dif_valorizada - b.dif_valorizada);
                return 0;
            });
        }
        return rows;
    }, [resumenPorCodigo, resumenConOverrides, resumenEditMode, resumenSearch, resumenSort]);

    const notCountedAssignments = useMemo(() => {
        const countedPids = new Set<string>();
        for (const c of counts) countedPids.add(c.product_id);
        const seen = new Set<string>();
        return assignments.filter(a => {
            if (seen.has(a.product_id)) return false;
            seen.add(a.product_id);
            return !countedPids.has(a.product_id);
        });
    }, [assignments, counts]);

    const resumenStats = useMemo(() => {
        const base = resumenEditMode ? resumenConOverrides : resumenPorCodigo;
        const total = base.length;
        const contados = base.filter(r => r.total_counted > 0 || counts.some(c => c.product_id === r.product_id)).length;
        const pendientes = total - contados;
        const conDif = base.filter(r => {
            const wasCounted = counts.some(c => c.product_id === r.product_id);
            return wasCounted && r.difference !== 0;
        }).length;
        const valorizadaDif = base.reduce((s, r) => s + r.dif_valorizada, 0);
        return { total, contados, pendientes, conDif, valorizadaDif };
    }, [resumenPorCodigo, resumenConOverrides, resumenEditMode, counts]);

    const filteredProducts = useMemo(() => {
        const text = prodSearch.trim().toLowerCase();
        if (!text) return products.slice(0, 100);
        return products.filter(p => [p.sku, p.description, p.barcode].join(" ").toLowerCase().includes(text)).slice(0, 100);
    }, [products, prodSearch]);

    const filteredDashData = useMemo(() => {
        if (!dashStoreFilter) return dashData;
        return dashData.filter(r => r.store_id === dashStoreFilter);
    }, [dashData, dashStoreFilter]);

    const kpiDashData = useMemo(() => {
        return filteredDashData;
    }, [filteredDashData]);

    const dashSummary = useMemo(() => {
        if (filteredDashData.length === 0) return null;

        // Para CUMPLIMIENTO: usar TODAS las tiendas (no filtrar por cumplio)
        const cumplidos = dashPeriod === "dia"
            ? filteredDashData.filter(r => r.cumplio).length
            : filteredDashData.reduce((s, r) => s + r.dias_cumplidos, 0);
        const total = dashPeriod === "dia"
            ? filteredDashData.length
            : filteredDashData.reduce((s, r) => s + r.dias_totales, 0);

        // Para ERI, Sobrantes, Faltantes, DifVal: SOLO tiendas que cumplieron
        const filasQueComplieron = dashPeriod === "dia"
            ? kpiDashData.filter(r => r.cumplio && r.total_asignados > 0)
            : kpiDashData.filter(r => r.dias_cumplidos > 0 && r.total_asignados > 0);

        const okTotal = filasQueComplieron.reduce((s, r) => s + r.total_ok, 0);
        const sobrantesTotal = filasQueComplieron.reduce((s, r) => s + r.total_sobrantes, 0);
        const faltantesTotal2 = filasQueComplieron.reduce((s, r) => s + r.total_faltantes, 0);
        const totalContadosKpi = okTotal + sobrantesTotal + faltantesTotal2;
        const avgEri = totalContadosKpi > 0 ? Math.round((okTotal / totalContadosKpi) * 100) : 0;

        // Duración promedio: solo aplica en vista día (de las que cumplieron con duración)
        const filasConDuracion = dashPeriod === "dia"
            ? filasQueComplieron.filter(r => r.duracion_min !== null)
            : [];
        const avgDurMin = dashPeriod === "dia" && filasConDuracion.length > 0
            ? Math.round(filasConDuracion.reduce((s, r) => s + (r.duracion_min || 0), 0) / filasConDuracion.length)
            : null;

        const totalDifVal = filasQueComplieron.reduce((s, r) => s + (r.dif_valorizada || 0), 0);
        const totalSobrantes = filasQueComplieron.reduce((s, r) => s + r.total_sobrantes, 0);
        const totalFaltantes = filasQueComplieron.reduce((s, r) => s + r.total_faltantes, 0);
        const totalAsignacionesPeriodo = filteredDashData.reduce(
            (s, r) => s + (r.total_asignados_periodo ?? r.total_asignados),
            0
        );
        return { avgEri, cumplidos, total, avgDurMin, totalDifVal, totalSobrantes, totalFaltantes, totalAsignacionesPeriodo };
    }, [filteredDashData, kpiDashData, dashPeriod]);

    // ════════════════════════════════════════════════════════
    //  RENDER
    // ════════════════════════════════════════════════════════
    if (loading) {
        return (
            <main className="min-h-screen bg-slate-100 flex items-center justify-center">
                <div className="text-slate-500 text-lg">Cargando...</div>
            </main>
        );
    }

    const isAdmin    = user?.role === "Administrador";
    const isValOrAdm = user?.role === "Validador" || isAdmin;

    return (
        <main className="h-screen bg-slate-100 text-slate-900 flex overflow-hidden">

            {/* ══════════════════════════════════════════════════════
                SIDEBAR — NAVEGACIÓN PRINCIPAL (tipo WMS)
            ══════════════════════════════════════════════════════ */}
            {/* Overlay oscuro en mobile cuando sidebar abierto */}
            {sidebarOpen && (
                <div
                    className="fixed inset-0 bg-black/50 z-30 md:hidden"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            <aside
                className={`fixed top-0 left-0 h-screen w-56 bg-slate-900 text-white flex flex-col z-40 shadow-2xl transition-transform duration-300
                    md:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}
                style={{ minWidth: "14rem" }}>

                {/* Logo / Brand */}
                <div className="px-5 py-5 border-b border-slate-700/60">
                    <div className="flex items-center gap-2.5">
                        <div style={{
                            background: "linear-gradient(135deg, #f97316 0%, #c2410c 100%)",
                            borderRadius: "10px", padding: "6px 8px",
                        }}>
                            <svg viewBox="0 0 60 60" width="24" height="24">
                                <polygon points="30,3 54,17 54,43 30,57 6,43 6,17" fill="rgba(255,255,255,0.15)" />
                                <text x="30" y="42" textAnchor="middle" fill="white"
                                    fontSize="32" fontWeight="900" fontFamily="Arial Black, sans-serif">R</text>
                            </svg>
                        </div>
                        <div>
                            <p className="font-black text-sm leading-none tracking-wider">
                                RASE<span style={{ color: "#f97316" }}>CORP</span>
                            </p>
                            <p className="text-slate-400 text-[10px] leading-none mt-1 tracking-widest">CÍCLICOS</p>
                        </div>
                    </div>
                </div>

                {/* Usuario */}
                <div className="px-5 py-3 border-b border-slate-700/60">
                    <p className="text-xs font-semibold text-white truncate">{user?.full_name}</p>
                    <span className={`inline-block mt-0.5 text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        user?.role === "Administrador" ? "bg-purple-500/20 text-purple-300" :
                        user?.role === "Validador"     ? "bg-blue-500/20 text-blue-300" :
                                                         "bg-amber-500/20 text-amber-300"
                    }`}>{user?.role}</span>
                </div>

                {/* Menú de navegación */}
                <nav className="flex-1 py-3 overflow-y-auto">

                    {/* MÓDULO OPERARIO */}
                    {(user?.role === "Operario" || isAdmin) && (
                        <div className="px-3 mb-1">
                            <button
                                onClick={() => {
                                    setActiveTab("operario");
                                    setSidebarOpen(false);
                                    if (isAdmin && !selectedStoreId && allStores.filter(s=>s.is_active).length > 0) {
                                        const first = allStores.filter(s => s.is_active)[0];
                                        setSelectedStoreId(first.id);
                                        loadOperarioData(first.id, selectedDate);
                                    }
                                }}
                                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                                    activeTab === "operario"
                                        ? "bg-amber-500 text-white shadow-lg"
                                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                                }`}
                            >
                                <ClipboardList size={16} />
                                <span>Operario</span>
                            </button>
                        </div>
                    )}

                    {/* MÓDULO VALIDADOR */}
                    {isValOrAdm && (
                        <>
                            {/* Header de sección */}
                            <div className="px-5 pt-3 pb-1">
                                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Validador</p>
                            </div>
                            <div className="px-3 space-y-0.5">
                                {([
                                    { key: "asignar",   icon: Package,       label: "Asignar productos" },
                                    { key: "registros", icon: ClipboardList, label: "Registros"          },
                                    { key: "resumen",   icon: BarChart3,     label: "Resumen por codigo" },
                                    { key: "progreso",  icon: StoreIcon,     label: "Progreso tiendas"   },
                                    { key: "dashboard", icon: LineChart,     label: "Dashboard"           },
                                ] as const).map(item => (
                                    (() => {
                                        const Icon = item.icon;
                                        return (
                                    <button
                                        key={item.key}
                                        onClick={() => {
                                            setActiveTab("validador");
                                            setValTab(item.key);
                                            setSidebarOpen(false);
                                            // Reset drill-down state when navigating via sidebar
                                            if (item.key !== "resumen") { setDashDrillSource(false); setResumenOverrides({}); setResumenDraft({}); setResumenEditMode(false); }
                                            if (item.key === "registros" && valStoreId && valStoreId !== ALL_STORES_VALUE) loadValidadorData(valStoreId, valDate);
                                            if (item.key === "resumen"   && valStoreId && valStoreId !== ALL_STORES_VALUE) { setDashDrillSource(false); setResumenOverrides({}); setResumenDraft({}); setResumenEditMode(false); loadValidadorData(valStoreId, valDate); }
                                            if (item.key === "progreso")  loadStoreProgress(dashDate);
                                        }}
                                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                                            activeTab === "validador" && valTab === item.key
                                                ? "bg-blue-600 text-white shadow-lg"
                                                : "text-slate-400 hover:bg-slate-800 hover:text-white"
                                        }`}
                                    >
                                        <Icon size={16} />
                                        <span className="truncate">{item.label}</span>
                                    </button>
                                        );
                                    })()
                                ))}
                            </div>
                        </>
                    )}

                    {isAdmin && (
                        <>
                            <div className="px-5 pt-4 pb-1">
                                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Modulos</p>
                            </div>
                            <div className="px-3 space-y-0.5">
                                <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold bg-slate-800 text-white">
                                    <ClipboardList size={16} />
                                    <span className="truncate">Ciclicos</span>
                                </button>
                                <button
                                    onClick={() => { window.location.href = "/auditoria"; }}
                                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold text-slate-400 hover:bg-slate-800 hover:text-white transition-all"
                                >
                                    <FileText size={16} />
                                    <span className="truncate">Auditorias</span>
                                </button>
                                <button
                                    onClick={() => { window.location.href = "/inventarios"; }}
                                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold text-slate-400 hover:bg-slate-800 hover:text-white transition-all"
                                >
                                    <Package size={16} />
                                    <span className="truncate">Inventarios</span>
                                </button>
                            </div>
                        </>
                    )}

                    {/* MÓDULO ADMIN */}
                    {isAdmin && (
                        <>
                            <div className="px-5 pt-4 pb-1">
                                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Administración</p>
                            </div>
                            <div className="px-3 space-y-0.5">
                                {([
                                    { key: "productos", icon: Database,  label: "Maestro productos" },
                                    { key: "tiendas",   icon: StoreIcon, label: "Tiendas"           },
                                    { key: "usuarios",  icon: Users,     label: "Usuarios"           },
                                ] as const).map(item => (
                                    (() => {
                                        const Icon = item.icon;
                                        return (
                                    <button
                                        key={item.key}
                                        onClick={() => { setActiveTab("admin"); setAdminTab(item.key); setSidebarOpen(false); }}
                                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                                            activeTab === "admin" && adminTab === item.key
                                                ? "bg-purple-600 text-white shadow-lg"
                                                : "text-slate-400 hover:bg-slate-800 hover:text-white"
                                        }`}
                                    >
                                        <Icon size={16} />
                                        <span className="truncate">{item.label}</span>
                                    </button>
                                        );
                                    })()
                                ))}
                            </div>
                        </>
                    )}
                </nav>

                {/* Logout */}
                <div className="px-3 py-4 border-t border-slate-700/60">
                    <button
                        onClick={() => { handleLogout(); setSidebarOpen(false); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold text-slate-400 hover:bg-red-600/20 hover:text-red-300 transition-all"
                    >
                        <LogOut size={16} />
                        <span>Cerrar sesión</span>
                    </button>
                </div>
            </aside>

            {/* ══════════════════════════════════════════════════════
                CONTENIDO PRINCIPAL (desplazado por sidebar)
            ══════════════════════════════════════════════════════ */}
            <div className="flex-1 flex flex-col h-screen overflow-hidden md:ml-56">

                {/* ── HEADER DE CONTEXTO ──────────────────────────── */}
                <header className="bg-white border-b sticky top-0 z-30 px-3 md:px-6 py-3 flex items-center justify-between gap-3">
                    {/* Botón hamburguesa — solo mobile */}
                    <button
                        className="md:hidden flex-shrink-0 p-2 rounded-xl text-slate-600 hover:bg-slate-100 transition"
                        onClick={() => setSidebarOpen(prev => !prev)}
                        aria-label="Abrir menú"
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <line x1="3" y1="6" x2="21" y2="6"/>
                            <line x1="3" y1="12" x2="21" y2="12"/>
                            <line x1="3" y1="18" x2="21" y2="18"/>
                        </svg>
                    </button>
                    <div className="flex-1 min-w-0">
                        <h1 className="font-bold text-slate-900 text-base leading-tight">
                            {activeTab === "operario"  ? "Conteos del dia" :
                             activeTab === "validador" && valTab === "asignar"   ? "Asignar productos" :
                             activeTab === "validador" && valTab === "registros" ? "Registros de conteo" :
                             activeTab === "validador" && valTab === "resumen"   ? "Resumen por codigo" :
                             activeTab === "validador" && valTab === "progreso"  ? "Progreso tiendas" :
                             activeTab === "validador" && valTab === "dashboard" ? "Dashboard" :
                             activeTab === "admin"     && adminTab === "productos" ? "Maestro de productos" :
                             activeTab === "admin"     && adminTab === "tiendas"   ? "Tiendas" :
                             activeTab === "admin"     && adminTab === "usuarios"  ? "Usuarios" : "Ciclicos"}
                        </h1>
                        <p className="text-xs text-slate-400 leading-none mt-0.5">
                            {activeTab === "validador" && valTab !== "dashboard" && valStoreId
                                ? `${valStoreId === ALL_STORES_VALUE ? "Todas las tiendas" : stores.find(s => s.id === valStoreId)?.name || ""} · ${valDate}`
                                : activeTab === "operario"
                                ? `${allStores.find(s => s.id === selectedStoreId)?.name || "—"} · ${selectedDate}`
                                : ""}
                        </p>
                    </div>

                    {/* Controles contextuales de tienda/fecha para Validador (excepto Dashboard) */}
                    {activeTab === "validador" && valTab !== "dashboard" && valTab !== "progreso" && (
                        <div className="flex items-center gap-2 flex-wrap">
                            <select
                                className="border rounded-xl px-3 py-2 text-sm text-slate-900 bg-white"
                                value={valStoreId}
                                onChange={e => {
                                    const nextStoreId = e.target.value;
                                    setValStoreId(nextStoreId);
                                    if (nextStoreId && nextStoreId !== ALL_STORES_VALUE) loadValidadorData(nextStoreId, valDate);
                                    else { setAssignments([]); setCounts([]); }
                                }}
                            >
                                <option value="">— Tienda —</option>
                                {valTab === "asignar" && <option value={ALL_STORES_VALUE}>Todas las tiendas</option>}
                                {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                            <input
                                type="date"
                                className="border rounded-xl px-3 py-2 text-sm text-slate-900 bg-white"
                                value={valDate}
                                onChange={e => { setValDate(e.target.value); if (valStoreId && valStoreId !== ALL_STORES_VALUE) loadValidadorData(valStoreId, e.target.value); }}
                            />
                            {valStoreId && valStoreId !== ALL_STORES_VALUE && (
                                <button
                                    className="px-3 py-2 rounded-xl border text-sm font-semibold text-slate-700 bg-white hover:bg-slate-50 transition disabled:opacity-40"
                                    onClick={refreshValidatorAssignedStocksForDate}
                                >🔄</button>
                            )}
                            <button
                                className="px-3 py-2 rounded-xl bg-green-600 text-white font-semibold text-sm hover:bg-green-700 transition"
                                onClick={() => openBulkWspModal(valDate)}
                                title="WhatsApp masivo"
                            >📲</button>
                        </div>
                    )}

                    {/* Stats de tienda seleccionada en validador */}
                    {activeTab === "validador" && valTab !== "dashboard" && valTab !== "progreso" && valStoreId && resumenStats.total > 0 && (
                        <div className="hidden md:flex items-center gap-3">
                            <div className="flex gap-2 text-xs font-semibold text-slate-600 bg-slate-50 border rounded-xl px-3 py-2">
                                <span className="text-slate-500">Asig: <b className="text-slate-800">{resumenStats.total}</b></span>
                                <span className="text-slate-300">|</span>
                                <span className="text-green-700">OK: <b>{resumenStats.contados}</b></span>
                                <span className="text-slate-300">|</span>
                                <span className="text-amber-600">Pend: <b>{resumenStats.pendientes}</b></span>
                                <span className="text-slate-300">|</span>
                                <span className="text-red-600">Dif: <b>{resumenStats.conDif}</b></span>
                            </div>
                            <div className="w-24 space-y-0.5">
                                <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                                    <div className="h-full rounded-full transition-all"
                                        style={{
                                            width: `${(resumenStats.contados / resumenStats.total) * 100}%`,
                                            background: resumenStats.contados === resumenStats.total ? "#16a34a" : "#f59e0b"
                                        }}
                                    />
                                </div>
                                <p className="text-[10px] text-slate-400 text-right">
                                    {Math.round((resumenStats.contados / resumenStats.total) * 100)}%
                                </p>
                            </div>
                        </div>
                    )}
                </header>

                {/* ── MENSAJE GLOBAL ────────────────────────────────── */}
                {message && (
                    <div className={`mx-6 mt-4 rounded-2xl px-4 py-3 text-sm font-medium flex items-center justify-between gap-3 ${messageType === "success" ? "bg-green-50 text-green-800 border border-green-200" : messageType === "error" ? "bg-red-50 text-red-800 border border-red-200" : "bg-blue-50 text-blue-800 border border-blue-200"}`}>
                        <span>{message}</span>
                        <button className="text-lg leading-none opacity-60 hover:opacity-100" onClick={clearMessage}>×</button>
                    </div>
                )}

                {/* ── ÁREA DE CONTENIDO ─────────────────────────────── */}
                <div className="flex-1 w-full max-w-5xl mx-auto space-y-4 px-3 py-4 md:p-6 overflow-y-auto">

            {/* ════════════════════════════════════════════════════════
                TAB OPERARIO
            ════════════════════════════════════════════════════════ */}
            {activeTab === "operario" && (user?.role === "Operario" || isAdmin) && !showRecount && (
                <>
                    <section className="bg-white rounded-2xl p-4 shadow space-y-3 md:rounded-3xl md:p-5">
                        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:flex-wrap">
                            <div className="min-w-0">
                                <h2 className="text-xl font-bold text-slate-900">Conteos del día</h2>
                                <p className="text-slate-500 text-sm">{allStores.find(s => s.id === selectedStoreId)?.name || "—"} · {selectedDate}</p>
                                {countingStatus !== "idle" && isAdmin && (
                                    <span className={`inline-block mt-1 text-xs font-bold px-2 py-0.5 rounded-full ${
                                        countingStatus === "recount_done" ? "bg-green-100 text-green-700" :
                                        countingStatus === "recounting"   ? "bg-orange-100 text-orange-700" :
                                        countingStatus === "finished"     ? "bg-blue-100 text-blue-700" :
                                        "bg-indigo-100 text-indigo-700"
                                    }`}>
                                        {countingStatus === "recount_done" ? "✅ Reconteo completado" :
                                         countingStatus === "recounting"   ? "🔄 En reconteo" :
                                         countingStatus === "finished"     ? "🏁 Conteo finalizado" :
                                         "📝 Contando..."}
                                    </span>
                                )}
                            </div>
                            <div className="grid w-full gap-2 md:flex md:w-auto md:items-center md:flex-wrap md:gap-3">
                                {isAdmin && (
                                    <select
                                        className="w-full border rounded-2xl px-3 py-2 text-sm text-slate-900 bg-white md:w-auto"
                                        value={selectedStoreId}
                                        onChange={e => { setSelectedStoreId(e.target.value); if (e.target.value) loadOperarioData(e.target.value, selectedDate); }}
                                    >
                                        <option value="">— Selecciona tienda —</option>
                                        {allStores.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                    </select>
                                )}
                                <input type="date" className="w-full border rounded-2xl px-3 py-2 text-sm text-slate-900 bg-white md:w-auto" value={selectedDate} onChange={e => { setSelectedDate(e.target.value); if (selectedStoreId) loadOperarioData(selectedStoreId, e.target.value); }} />
                                <button
                                    className="flex w-full items-center justify-center gap-2 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 disabled:opacity-40 md:w-auto"
                                    onClick={refreshAssignedStocks}
                                    disabled={!selectedStoreId || assignments.length === 0 || bulkRefreshingStocks}
                                    title="Actualizar stocks asignados"
                                >
                                    <RefreshCw size={16} className={bulkRefreshingStocks ? "animate-spin" : ""} />
                                    {bulkRefreshingStocks ? "Actualizando" : "Actualizar stocks"}
                                </button>
                                <div className="grid w-full grid-cols-2 gap-2 md:flex md:w-auto md:items-center">
                                    <input
                                        className="col-span-2 w-full border rounded-2xl px-3 py-2 text-sm text-slate-900 bg-white md:col-span-1 md:w-40"
                                        placeholder="Codigo"
                                        value={manualProductCode}
                                        onChange={e => setManualProductCode(e.target.value)}
                                        onKeyDown={e => { if (e.key === "Enter") addProductByTypedCode(); }}
                                    />
                                    <button className="rounded-2xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white" onClick={addProductByTypedCode}>
                                        Agregar
                                    </button>
                                    <button className="flex items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white" onClick={() => openScanner("product")}>
                                        <QrCode size={16} /> Escanear
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Progreso */}
                        <div className="rounded-2xl bg-slate-50 border p-4 space-y-2">
                            <div className="flex justify-between text-sm font-medium text-slate-700">
                                <span>Progreso del día</span>
                                <span>{doneAssignments.length} / {myAssignments.length}</span>
                            </div>
                            <div className="h-3 bg-slate-200 rounded-full overflow-hidden">
                                <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: myAssignments.length > 0 ? `${(doneAssignments.length / myAssignments.length) * 100}%` : "0%" }} />
                            </div>
                            <div className="flex gap-4 text-xs text-slate-500 pt-1">
                                <span className="text-amber-600 font-semibold">⏳ {pendingAssignments.length} pendientes</span>
                                <span className="text-green-600 font-semibold">✅ {doneAssignments.length} contados</span>
                            </div>

                            {/* Botones de estado: Terminar conteo / Reconteo / Sesión finalizada */}
                            {!sessionFinished ? (
                                <div className="flex gap-2 mt-2">
                                    <button
                                        onClick={handleFinishSessionClick}
                                        className="flex-1 py-3 rounded-2xl font-bold text-sm border-2 border-slate-700 text-slate-800 bg-slate-100 hover:bg-slate-200 transition-colors flex items-center justify-center gap-2"
                                    >
                                        <span>🏁</span> Terminar conteo
                                    </button>
                                </div>
                            ) : recountFinished ? (
                                /* Estado: reconteo ya finalizado */
                                <div className="space-y-2 mt-2">
                                    <div className="w-full py-3 rounded-2xl font-bold text-sm bg-green-100 text-green-800 text-center flex items-center justify-center gap-2 border border-green-300">
                                        <span>✅</span> Sesión finalizada — reconteo completado
                                    </div>
                                    <button
                                        onClick={async () => {
                                            if (confirm("¿Deseas volver a modificar el reconteo?")) {
                                                await setSessionFlag(selectedStoreId, selectedDate, "__recount_done__", false);
                                                await setSessionFlag(selectedStoreId, selectedDate, "__recount_started__", true);
                                                setRecountFinished(false);
                                                setShowRecount(true);
                                                setRecountAssignment(null);
                                                setRecountRows([{ location: "", qty: "" }]);
                                            }
                                        }}
                                        className="w-full py-2.5 rounded-2xl font-semibold text-sm border border-slate-400 text-slate-700 bg-white hover:bg-slate-50 transition-colors flex items-center justify-center gap-2"
                                    >
                                        ✏️ ¿Deseas modificar?
                                    </button>
                                </div>
                            ) : (
                                /* Estado: conteo finalizado, puede iniciar reconteo */
                                <div className="space-y-2 mt-2">
                                    <div className="w-full py-3 rounded-2xl font-bold text-sm bg-green-100 text-green-800 text-center flex items-center justify-center gap-2 border border-green-300">
                                        <span>✅</span> Conteo finalizado — {doneAssignments.length} producto{doneAssignments.length !== 1 ? "s" : ""} contado{doneAssignments.length !== 1 ? "s" : ""}
                                    </div>
                                    {difAssignments.length > 0 ? (
                                        <button
                                            onClick={() => setShowRecountConfirmModal(true)}
                                            className="w-full py-3 rounded-2xl font-bold text-sm border-2 border-orange-500 text-orange-700 bg-orange-50 hover:bg-orange-100 transition-colors flex items-center justify-center gap-2"
                                        >
                                            <span>🔄</span> Iniciar reconteo ({difAssignments.length} con diferencia)
                                        </button>
                                    ) : (
                                        <button
                                            onClick={async () => {
                                                if (confirm("¿Estás seguro de que deseas modificar el conteo finalizado?")) {
                                                    await clearSessionFlags(selectedStoreId, selectedDate);
                                                    setSessionFinished(false);
                                                    setRecountFinished(false);
                                                    showMessage("Conteo reabierto para modificación.", "info");
                                                    loadOperarioData(selectedStoreId, selectedDate);
                                                }
                                            }}
                                            className="w-full py-2.5 rounded-2xl font-semibold text-sm border border-slate-400 text-slate-700 bg-white hover:bg-slate-50 transition-colors flex items-center justify-center gap-2"
                                        >
                                            ✏️ ¿Deseas modificar algo?
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    </section>

                    {/* Lista pendientes */}
                    {pendingAssignments.length > 0 && (
                        <section className="bg-white rounded-3xl p-5 shadow space-y-3">
                            <h3 className="font-bold text-slate-900 text-base flex items-center gap-2">
                                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-500 text-white text-xs font-bold">{pendingAssignments.length}</span>
                                Pendientes por contar
                            </h3>
                            <div className="space-y-2">
                                {pendingAssignments.map(a => (
                                    <div key={a.id} className="flex items-center justify-between gap-3 border-2 border-amber-300 rounded-2xl p-4 bg-amber-50 active:scale-[0.98] transition-transform">
                                        <div className="flex-1 min-w-0">
                                            <div className="font-bold text-slate-900 text-base truncate">{a.sku}</div>
                                            <div className="text-sm text-slate-600 truncate">{a.description}</div>
                                            <div className="text-xs text-slate-400 mt-0.5">UM: {a.unit} · Stock: <b>{formatNumber(a.system_stock)}</b></div>
                                        </div>
                                        <button
                                            className="px-5 py-3 rounded-2xl bg-amber-500 text-white text-sm font-bold whitespace-nowrap shadow active:bg-amber-600 active:scale-95 transition-all"
                                                                                    onClick={() => { void openCount(a); }}
                                        >
                                            ➕ Contar
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    {/* Lista contados */}
                    {doneAssignments.length > 0 && (
                        <section className="bg-white rounded-3xl p-5 shadow space-y-3">
                            <h3 className="font-bold text-slate-900 text-base flex items-center gap-2">
                                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-500 text-white text-xs font-bold">{doneAssignments.length}</span>
                                Ya contados
                            </h3>
                            <div className="space-y-2">
                                {doneAssignments.map(a => {
                                    const asgCounts = counts.filter(c => c.assignment_id === a.id);
                                    const totalContado = asgCounts.reduce((s, c) => s + Number(c.counted_quantity), 0);
                                    const hasDiff = totalContado !== Number(a.system_stock);
                                    return (
                                        <div key={a.id} className={`border-2 rounded-2xl p-4 active:scale-[0.98] transition-transform ${hasDiff ? "bg-red-50 border-red-300" : "bg-green-50 border-green-300"}`}>
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="flex-1 min-w-0">
                                                    <div className="font-bold text-slate-900 text-base truncate">{a.sku}</div>
                                                    <div className="text-sm text-slate-600 truncate">{a.description}</div>
                                                    <div className="text-xs text-slate-500 mt-1 flex items-center gap-2 flex-wrap">
                                                        <span>Stock: <b>{formatNumber(a.system_stock)}</b></span>
                                                        <span>·</span>
                                                        <span>Contado: <b>{formatNumber(totalContado)}</b></span>
                                                        {hasDiff
                                                            ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-bold text-xs border border-red-200">
                                                                ⚠️ Dif: {totalContado - Number(a.system_stock) > 0 ? "+" : ""}{formatNumber(totalContado - Number(a.system_stock))}
                                                              </span>
                                                            : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-bold text-xs border border-green-200">
                                                                ✓ OK
                                                              </span>
                                                        }
                                                    </div>
                                                </div>
                                                <button
                                                    className="px-4 py-2.5 rounded-2xl border-2 border-slate-300 text-sm font-semibold bg-white active:bg-slate-100 active:scale-95 transition-all"
                                                                                onClick={() => { void openCount(a); }}
                                                >
                                                    ✏️ Editar
                                                </button>
                                            </div>
                                            {asgCounts.length > 0 && (
                                                <div className="mt-3 space-y-1.5">
                                                    {asgCounts.map((c, i) => (
                                                        <div key={c.id} className="text-xs text-slate-600 flex gap-2 items-center bg-white rounded-xl px-3 py-2 border border-slate-200">
                                                            <span className="font-bold text-slate-400 w-14 flex-shrink-0">Ubic {i + 1}</span>
                                                            <span className="font-mono text-slate-700 truncate flex-1">{c.location || <em className="text-slate-400">—</em>}</span>
                                                            <span className="font-bold text-slate-800 flex-shrink-0">{formatNumber(c.counted_quantity)} {a.unit}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </section>
                    )}

                    {myAssignments.length === 0 && (
                        <div className="bg-white rounded-3xl p-8 shadow text-center text-slate-400">
                            No hay productos asignados para hoy en tu tienda.
                            <br />Puedes digitar o escanear un codigo para agregarlo voluntariamente al conteo.
                        </div>
                    )}
                </>
            )}

            {/* ════════════════════════════════════════════════════════
                PANEL RECONTEO (Operario)
            ════════════════════════════════════════════════════════ */}
            {activeTab === "operario" && (user?.role === "Operario" || isAdmin) && showRecount && (
                <>
                    <section className="bg-white rounded-3xl p-5 shadow space-y-3">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <h2 className="text-xl font-bold text-slate-900">🔄 Reconteo</h2>
                                <p className="text-slate-500 text-sm">{difAssignments.length} producto{difAssignments.length !== 1 ? "s" : ""} con diferencia para recontar</p>
                            </div>
                            <div className="flex items-center gap-2">
                                <input
                                    className="border rounded-2xl px-3 py-2 text-sm text-slate-900 bg-white w-40"
                                    placeholder="Codigo"
                                    value={manualProductCode}
                                    onChange={e => setManualProductCode(e.target.value)}
                                    onKeyDown={e => { if (e.key === "Enter") addProductByTypedCode(); }}
                                />
                                <button
                                    className="px-4 py-2 rounded-2xl bg-blue-600 text-white text-sm font-semibold"
                                    onClick={addProductByTypedCode}
                                >
                                    Agregar
                                </button>
                                <button
                                    className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-slate-900 text-white text-sm font-semibold"
                                    onClick={() => openScanner("product")}
                                >
                                    <QrCode size={16} /> Escanear
                                </button>
                                <button
                                    onClick={async () => {
                                        await setSessionFlag(selectedStoreId, selectedDate, "__recount_started__", false);
                                        setShowRecount(false);
                                        setRecountAssignment(null);
                                    }}
                                    className="px-4 py-2 rounded-2xl border text-sm font-semibold"
                                >
                                    ← Volver
                                </button>
                            </div>
                        </div>

                        {/* Panel de edición de producto seleccionado */}
                        {recountAssignment ? (
                            <div className="rounded-2xl border bg-orange-50 border-orange-200 p-4 space-y-3">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <p className="font-bold text-slate-900">{recountAssignment.sku}</p>
                                        <p className="text-xs text-slate-600">{recountAssignment.description}</p>
                                        <p className="text-xs text-slate-400">UM: {recountAssignment.unit} · Stock sistema: <b>{formatNumber(recountAssignment.system_stock)}</b></p>
                                    </div>
                                    <button onClick={() => { setRecountAssignment(null); setRecountRows([{ location: "", qty: "" }]); }} className="text-slate-400 text-xl">×</button>
                                </div>

                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <label className="block font-semibold text-sm text-slate-700">Ubicaciones y cantidades</label>
                                        <button className="text-xs px-3 py-1.5 rounded-xl bg-slate-100 text-slate-700 font-semibold border" onClick={addRecountRow} disabled={sinStockRecount}>+ Agregar ubicación</button>
                                    </div>

                                    {/* Botón Sin stock en reconteo */}
                                    <button
                                        className={`w-full py-2.5 rounded-2xl font-bold text-sm border-2 transition-all ${sinStockRecount ? "bg-red-600 text-white border-red-600" : "bg-white text-red-600 border-red-300 hover:bg-red-50"}`}
                                        onClick={() => setSinStockRecount(prev => !prev)}
                                    >
                                        {sinStockRecount ? "🚫 Sin stock — toca para cancelar" : "🚫 Sin stock físico"}
                                    </button>
                                    {sinStockRecount && (
                                        <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 font-medium">
                                            Se registrará cantidad 0 para <b>{recountAssignment.sku}</b>. Quedará contado con diferencia.
                                        </div>
                                    )}

                                    {!sinStockRecount && recountRows.map((row, i) => (
                                        <div key={i} className="rounded-2xl border bg-white p-3 space-y-2">
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="text-xs font-semibold text-slate-500">Ubicación {recountRows.length > 1 ? i + 1 : ""}</span>
                                                {recountRows.length > 1 && (
                                                    <button className="text-xs text-red-500 font-semibold" onClick={() => removeRecountRow(i)}>Quitar</button>
                                                )}
                                            </div>
                                            <div>
                                                <label className="text-xs text-slate-500 block mb-1">Ubicación</label>
                                                <div className="flex gap-1">
                                                    <input
                                                        className="flex-1 border rounded-xl p-2.5 text-sm text-slate-900 bg-white"
                                                        placeholder="Ej: A-01-03"
                                                        value={row.location}
                                                        onChange={e => updateRecountRow(i, "location", e.target.value)}
                                                    />
                                                    <button className="px-3 py-2 rounded-xl bg-slate-200 text-slate-700 text-xs" onClick={() => openScanner("recount_location", i)} title="Escanear ubicación">
                                                        <QrCode size={14} />
                                                    </button>
                                                </div>
                                            </div>
                                            <div>
                                                <label className="text-xs text-slate-500 block mb-1">Cantidad</label>
                                                <input
                                                    className="w-full border rounded-xl p-3 text-lg text-center font-bold text-slate-900 bg-white"
                                                    type="number" min="0" placeholder="0"
                                                    value={row.qty}
                                                    onChange={e => updateRecountRow(i, "qty", e.target.value)}
                                                />
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                <div className="flex gap-3">
                                    <button
                                        className={`flex-1 py-4 rounded-2xl font-bold text-base transition-all active:scale-95 ${savingRecount ? "bg-orange-300 text-white cursor-not-allowed" : "bg-orange-600 text-white active:bg-orange-700"}`}
                                        onClick={saveRecount}
                                        disabled={savingRecount}
                                    >
                                        {savingRecount ? "Guardando..." : "💾 Guardar reconteo"}
                                    </button>
                                    <button
                                        className="px-5 py-4 rounded-2xl border-2 font-semibold text-sm active:bg-slate-100 active:scale-95 transition-all"
                                        onClick={() => { setRecountAssignment(null); setRecountRows([{ location: "", qty: "" }]); setSinStockRecount(false); }}
                                        disabled={savingRecount}
                                    >
                                        Cancelar
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <p className="text-sm text-slate-500 text-center py-2">Selecciona un producto de abajo para recontar.</p>
                        )}
                    </section>

                    {/* Lista de productos con diferencia */}
                    <section className="bg-white rounded-3xl p-5 shadow space-y-3">
                        <h3 className="font-bold text-slate-900">Productos con diferencia ({difAssignments.length})</h3>
                        <div className="space-y-2">
                            {difAssignments.map(a => {
                                const aCounts = counts.filter(c => c.assignment_id === a.id);
                                const totalContado = aCounts.reduce((s, c) => s + Number(c.counted_quantity), 0);
                                const diff = totalContado - a.system_stock;
                                const isSelected = recountAssignment?.id === a.id;
                                const isUncounted = !a.counted;
                                return (
                                    <div
                                        key={a.id}
                                        className={`border rounded-2xl p-3 cursor-pointer transition-all ${isSelected ? "bg-orange-100 border-orange-400" : isUncounted ? "bg-amber-50 border-amber-300 hover:bg-amber-100" : "bg-red-50 border-red-200 hover:bg-red-100"}`}
                                        onClick={() => { void openRecountItem(a); }}
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="flex-1 min-w-0">
                                                <div className="font-semibold text-slate-900 truncate">{a.sku}</div>
                                                <div className="text-xs text-slate-600 truncate">{a.description}</div>
                                                <div className="text-xs text-slate-400 mt-0.5">
                                                    {isUncounted
                                                        ? <span className="text-amber-700 font-semibold">⏳ No contado · Stock: <b>{formatNumber(a.system_stock)}</b></span>
                                                        : <>Stock: <b>{formatNumber(a.system_stock)}</b> · Contado: <b>{formatNumber(totalContado)}</b> · Dif: {diffBadge(diff)}</>
                                                    }
                                                </div>
                                            </div>
                                            <span className={`text-xs font-semibold px-3 py-1.5 rounded-xl border ${isSelected ? "text-orange-700 bg-orange-100 border-orange-200" : isUncounted ? "text-amber-700 bg-amber-100 border-amber-200" : "text-orange-700 bg-orange-100 border-orange-200"}`}>
                                                {isSelected ? "Editando" : "Recontar"}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </section>

                    {/* Botón finalizar reconteo */}
                    <button
                        onClick={() => {
                            const noContados = difAssignments.filter(a => !a.counted).length;
                            if (noContados > 0) {
                                if (!confirm(`Tienes ${noContados} código${noContados !== 1 ? "s" : ""} aún sin contar. ¿Deseas finalizar el reconteo de todas formas?`)) return;
                            }
                            finalizeRecount();
                        }}
                        className="w-full py-4 rounded-2xl font-bold text-base bg-green-600 text-white shadow hover:bg-green-700 transition-colors flex items-center justify-center gap-2"
                    >
                        ✅ Finalizar reconteo
                    </button>
                </>
            )}

            {/* ════════════════════════════════════════════════════════
                TAB VALIDADOR
            ════════════════════════════════════════════════════════ */}
            {activeTab === "validador" && isValOrAdm && (
                <>

                    {/* ── SUB-TAB: PROGRESO POR TIENDA ─────────────────── */}
                    {valTab === "progreso" && (
                        <>
                            {/* ── Progreso por tienda hoy ───────────────────── */}
                            <section className="bg-white rounded-3xl p-5 shadow space-y-4">
                                <div className="flex items-center justify-between flex-wrap gap-3">
                                    <div>
                                        <h2 className="text-xl font-bold text-slate-900">🏪 Progreso de conteo por tienda</h2>
                                        <p className="text-slate-500 text-sm mt-0.5">Avance en tiempo real de cada tienda para la fecha seleccionada.</p>
                                    </div>
                                    <div className="flex items-center gap-3 flex-wrap">
                                        <div>
                                            <label className="block text-xs font-semibold text-slate-600 mb-1">Fecha</label>
                                            <input type="date" className="border rounded-2xl p-2.5 text-sm text-slate-900 bg-white" value={dashDate} onChange={e => setDashDate(e.target.value)} />
                                        </div>
                                        <button
                                            onClick={() => loadStoreProgress(dashDate)}
                                            disabled={storeProgressLoading}
                                            className="px-5 py-2.5 rounded-2xl bg-slate-900 text-white font-semibold text-sm disabled:opacity-50"
                                        >
                                            {storeProgressLoading ? "Cargando..." : "🔄 Actualizar"}
                                        </button>
                                    </div>
                                </div>

                                {storeProgressLoading ? (
                                    <div className="text-center text-slate-400 py-8">Cargando progreso...</div>
                                ) : storeProgressData.length === 0 ? (
                                    <div className="text-center text-slate-400 py-8">
                                        No hay asignaciones para esta fecha. Presiona <b>Actualizar</b> para consultar.
                                    </div>
                                ) : (
                                    <>
                                        {/* Resumen global rápido */}
                                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                            <div className="rounded-2xl bg-slate-50 border p-4 text-center">
                                                <div className="text-2xl font-bold text-slate-900">{storeProgressData.length}</div>
                                                <div className="text-xs text-slate-500 mt-1">Tiendas con asignación</div>
                                            </div>
                                            <div className="rounded-2xl bg-green-50 border border-green-200 p-4 text-center">
                                                <div className="text-2xl font-bold text-green-700">{storeProgressData.filter(s => s.pct === 100).length}</div>
                                                <div className="text-xs text-slate-500 mt-1">Completadas (100%)</div>
                                            </div>
                                            <div className="rounded-2xl bg-amber-50 border border-amber-200 p-4 text-center">
                                                <div className="text-2xl font-bold text-amber-600">{storeProgressData.filter(s => s.pct > 0 && s.pct < 100).length}</div>
                                                <div className="text-xs text-slate-500 mt-1">En progreso</div>
                                            </div>
                                            <div className="rounded-2xl bg-red-50 border border-red-200 p-4 text-center">
                                                <div className="text-2xl font-bold text-red-600">{storeProgressData.filter(s => s.pct === 0).length}</div>
                                                <div className="text-xs text-slate-500 mt-1">Sin iniciar</div>
                                            </div>
                                        </div>

                                        {/* Lista de tiendas con barra de progreso */}
                                        <div className="space-y-3">
                                            {storeProgressData.map(sp => {
                                                const isComplete = sp.pct === 100;
                                                const isStarted  = sp.pct > 0 && sp.pct < 100;
                                                const barColor   = isComplete ? "#16a34a" : isStarted ? "#f59e0b" : "#e2e8f0";
                                                const borderCls  = isComplete ? "border-green-200 bg-green-50" : isStarted ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white";
                                                return (
                                                    <div key={sp.store_id} className={`rounded-2xl border p-4 space-y-2 ${borderCls}`}>
                                                        <div className="flex items-center justify-between gap-3">
                                                            <div className="flex-1 min-w-0">
                                                                <span className="font-semibold text-slate-900 text-sm">{sp.store_name}</span>
                                                            </div>
                                                            <div className="flex items-center gap-3 flex-shrink-0">
                                                                <span className="text-xs text-slate-500">{sp.total_contados} / {sp.total_asignados} códigos</span>
                                                                <span className={`text-sm font-bold w-12 text-right ${isComplete ? "text-green-700" : isStarted ? "text-amber-600" : "text-slate-400"}`}>
                                                                    {sp.pct}%
                                                                </span>
                                                                {isComplete && <span className="text-green-600 text-base">✅</span>}
                                                                {!isComplete && sp.pct === 0 && <span className="text-slate-300 text-base">⏳</span>}
                                                                {isStarted && <span className="text-amber-500 text-base">🔄</span>}
                                                            </div>
                                                        </div>
                                                        <div className="h-2.5 bg-slate-200 rounded-full overflow-hidden">
                                                            <div
                                                                className="h-full rounded-full transition-all duration-500"
                                                                style={{ width: `${sp.pct}%`, background: barColor }}
                                                            />
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </>
                                )}
                            </section>
                        </>
                    )}

                    {/* ── SUB-TAB: DASHBOARD ───────────────────────────── */}
                    {valTab === "dashboard" && (
                        <>
                            <section className="bg-white rounded-3xl p-5 shadow space-y-4">
                                <div>
                                    <h2 className="text-xl font-bold text-slate-900">📊 Dashboard histórico por tienda</h2>
                                    <p className="text-slate-500 text-sm mt-0.5">Resumen de inventario cíclico por período.</p>
                                </div>

                                {/* Controles */}
                                <div className="flex gap-3 flex-wrap items-end">
                                    <div>
                                        <label className="block text-xs font-semibold text-slate-600 mb-1">Período</label>
                                        <div className="flex gap-1 flex-wrap">
                                            <button onClick={() => setDashPeriod("dia")} className={`px-4 py-2 rounded-2xl text-sm font-semibold border transition ${dashPeriod === "dia" ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-300"}`}>Por día</button>
                                            <button onClick={() => setDashPeriod("mes")} className={`px-4 py-2 rounded-2xl text-sm font-semibold border transition ${dashPeriod === "mes" ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-300"}`}>Por mes</button>
                                            <button onClick={() => setDashPeriod("rango")} className={`px-4 py-2 rounded-2xl text-sm font-semibold border transition ${dashPeriod === "rango" ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-300"}`}>Rango</button>
                                        </div>
                                    </div>
                                    {dashPeriod === "dia" ? (
                                        <div>
                                            <label className="block text-xs font-semibold text-slate-600 mb-1">Fecha</label>
                                            <input type="date" className="border rounded-2xl p-3 text-sm text-slate-900 bg-white" value={dashDate} onChange={e => setDashDate(e.target.value)} />
                                        </div>
                                    ) : dashPeriod === "rango" ? (
                                        <>
                                            <div>
                                                <label className="block text-xs font-semibold text-slate-600 mb-1">Desde</label>
                                                <input type="date" className="border rounded-2xl p-3 text-sm text-slate-900 bg-white" value={dashRangeFrom} onChange={e => setDashRangeFrom(e.target.value)} />
                                            </div>
                                            <div>
                                                <label className="block text-xs font-semibold text-slate-600 mb-1">Hasta</label>
                                                <input type="date" className="border rounded-2xl p-3 text-sm text-slate-900 bg-white" value={dashRangeTo} onChange={e => setDashRangeTo(e.target.value)} />
                                            </div>
                                        </>
                                    ) : (
                                        <div>
                                            <label className="block text-xs font-semibold text-slate-600 mb-1">Mes</label>
                                            <input type="month" className="border rounded-2xl p-3 text-sm text-slate-900 bg-white" value={dashMonth} onChange={e => setDashMonth(e.target.value)} />
                                        </div>
                                    )}
                                    <div className="flex-1 min-w-[160px]">
                                        <label className="block text-xs font-semibold text-slate-600 mb-1">Filtrar tienda</label>
                                        <select className="w-full border rounded-2xl p-3 text-sm text-slate-900 bg-white" value={dashStoreFilter} onChange={e => setDashStoreFilter(e.target.value)}>
                                            <option value="">Todas las tiendas</option>
                                            {allStores.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                        </select>
                                    </div>
                                    <button onClick={loadDashboard} className="px-6 py-3 rounded-2xl bg-slate-900 text-white font-semibold text-sm" disabled={dashLoading}>
                                        {dashLoading ? "Cargando..." : "🔍 Consultar"}
                                    </button>
                                    {dashData.length > 0 && (
                                        <button onClick={loadDashboard} disabled={dashLoading} className="px-4 py-3 rounded-2xl border text-sm font-semibold text-slate-700 flex items-center gap-2 disabled:opacity-50">
                                            🔄 Actualizar
                                        </button>
                                    )}
                                    {dashData.length > 0 && (
                                        <button onClick={exportDashboard} className="px-4 py-3 rounded-2xl border text-sm font-semibold text-slate-700">↓ Excel resumen</button>
                                    )}
                                    {dashData.length > 0 && (
                                        <button
                                            onClick={generateEmailHTML}
                                            className="px-4 py-3 rounded-2xl bg-indigo-700 text-white text-sm font-semibold hover:bg-indigo-800 transition-colors flex items-center gap-2"
                                            title="Genera un correo HTML profesional con gráficos para enviar a gerencia"
                                        >
                                            ✉️ Generar correo
                                        </button>
                                    )}
                                    <button
                                        onClick={exportGlobal}
                                        disabled={globalExportLoading}
                                        className="px-4 py-3 rounded-2xl bg-green-700 text-white text-sm font-semibold disabled:opacity-50"
                                        title="Descarga todos los códigos asignados con su estado, de todas las tiendas, en el período seleccionado"
                                    >
                                        {globalExportLoading ? "Generando..." : "↓ Excel global (todos los códigos)"}
                                    </button>
                                </div>
                            </section>

                            {/* Tarjetas resumen */}
                            {dashSummary && (
                                <div className={`grid gap-3 ${dashPeriod === "dia" ? "grid-cols-2 md:grid-cols-5" : "grid-cols-2 md:grid-cols-5"}`}>
                                    <div className="bg-white rounded-2xl p-4 shadow text-center">
                                        <div className="text-3xl font-bold text-slate-900">{dashSummary.avgEri}%</div>
                                        <div className="text-xs text-slate-500 mt-1">ERI</div>
                                    </div>
                                    <div className="bg-white rounded-2xl p-4 shadow text-center">
                                        <div className="text-3xl font-bold text-green-700">
                                            {dashSummary.total > 0 ? Math.round((dashSummary.cumplidos / dashSummary.total) * 100) : 0}%
                                        </div>
                                        <div className="text-xs text-slate-500 mt-1">{dashPeriod === "mes" ? "Cumplimiento mes" : dashPeriod === "rango" ? "Cumplimiento rango" : "Cumplimiento día"}</div>
                                        <div className="text-xs text-slate-400">{dashSummary.cumplidos} de {dashSummary.total}</div>
                                    </div>
                                    <div className="bg-white rounded-2xl p-4 shadow text-center">
                                        <div className="text-3xl font-bold text-blue-700">{dashSummary.cumplidos} <span className="text-slate-400 text-xl">/ {dashSummary.total}</span></div>
                                        <div className="text-xs text-slate-500 mt-1">{dashPeriod === "dia" ? "Cumplieron" : "Veces cumplidas"}</div>
                                    </div>
                                    {dashPeriod !== "dia" && (
                                        <div className="bg-white rounded-2xl p-4 shadow text-center">
                                            <div className="text-3xl font-bold text-slate-700">{dashSummary.totalAsignacionesPeriodo}</div>
                                            <div className="text-xs text-slate-500 mt-1">Asignaciones periodo</div>
                                        </div>
                                    )}
                                    {dashPeriod === "dia" && (
                                        <div className="bg-white rounded-2xl p-4 shadow text-center">
                                            <div className="text-2xl font-bold text-slate-700">{formatDuration(dashSummary.avgDurMin)}</div>
                                            <div className="text-xs text-slate-500 mt-1">Duración</div>
                                        </div>
                                    )}
                                    <div className="bg-white rounded-2xl p-4 shadow text-center">
                                        <div className={`text-xl font-bold ${(dashSummary.totalDifVal || 0) < 0 ? "text-red-600" : (dashSummary.totalDifVal || 0) > 0 ? "text-blue-700" : "text-green-700"}`}>
                                            {formatMoney(dashSummary.totalDifVal || 0)}
                                        </div>
                                        <div className="text-xs text-slate-500 mt-1">Dif. valorizada</div>
                                    </div>
                                </div>
                            )}

                            {/* Tabla dashboard */}
                            {filteredDashData.length > 0 ? (
                                <section className="bg-white rounded-3xl p-5 shadow space-y-3">
                                    <h3 className="font-bold text-slate-900">
                                        Detalle por tienda
                                        {dashPeriod !== "dia" && (
                                            <span className="ml-2 text-xs font-normal text-slate-400">(todo el periodo)</span>
                                        )}
                                    </h3>
                                    <div className="border rounded-2xl overflow-hidden">
                                        <div className="overflow-auto">
                                            <table className={`w-full text-sm ${dashPeriod === "dia" ? "min-w-[900px]" : "min-w-[760px]"}`}>
                                                <thead className="bg-slate-100 sticky top-0">
                                                    <tr>
                                                        <th className="p-2 border text-left">Tienda</th>
                                                        <th className="p-2 border">Asignados</th>
                                                        <th className="p-2 border text-green-700">OK</th>
                                                        <th className="p-2 border text-blue-700">Sobrantes</th>
                                                        <th className="p-2 border text-red-600">Faltantes</th>
                                                        <th className="p-2 border text-red-700">Dif. Val.</th>
                                                        <th className="p-2 border">ERI %</th>
                                                        <th className="p-2 border">Cumplimiento</th>
                                                        {dashPeriod === "dia" && <>
                                                            <th className="p-2 border">Hora inicio</th>
                                                            <th className="p-2 border">Hora fin</th>
                                                            <th className="p-2 border">Duración</th>
                                                        </>}
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {filteredDashData.map((r, i) => (
                                                        <tr key={i} className={r.cumplio ? "hover:bg-green-50" : "hover:bg-slate-50"}>
                                                            <td className="p-2 border font-medium">
                                                                {dashPeriod === "dia" ? (
                                                                    <button
                                                                        className="text-left text-blue-700 underline underline-offset-2 hover:text-blue-900 font-semibold transition-colors"
                                                                        title="Ver resumen por código de esta tienda"
                                                                        onClick={() => {
                                                                            setValStoreId(r.store_id);
                                                                            setValDate(dashDate);
                                                                            setResumenOverrides({}); setResumenDraft({});
                                                                            setResumenEditMode(false);
                                                                            setDashDrillSource(true);
                                                                            setValTab("resumen");
                                                                            loadValidadorData(r.store_id, dashDate);
                                                                        }}
                                                                    >
                                                                        {r.store_name}
                                                                    </button>
                                                                ) : r.store_name}
                                                            </td>
                                                            <td className="p-2 border text-center font-semibold">{r.total_asignados}</td>
                                                            <td className="p-2 border text-center text-green-700 font-semibold">{r.total_ok}</td>
                                                            <td className="p-2 border text-center text-blue-700 font-semibold">{r.total_sobrantes}</td>
                                                            <td className="p-2 border text-center text-red-600 font-semibold">{r.total_faltantes}</td>
                                                            <td className="p-2 border text-center text-xs font-semibold">
                                                                <span className={(r.dif_valorizada || 0) < 0 ? "text-red-600" : (r.dif_valorizada || 0) > 0 ? "text-blue-700" : "text-green-700"}>{formatMoney(r.dif_valorizada || 0)}</span>
                                                            </td>
                                                            <td className="p-2 border text-center">
                                                                <span className={`font-bold text-sm ${r.eri >= 90 ? "text-green-700" : r.eri >= 70 ? "text-amber-600" : "text-red-600"}`}>{r.eri}%</span>
                                                            </td>
                                                            <td className="p-2 border text-center">
                                                                {dashPeriod === "dia" ? (
                                                                    <span className={`font-bold text-sm ${r.cumplio ? "text-green-700" : "text-red-600"}`}>
                                                                        {r.cumplio ? "✓ Sí" : "✗ No"}
                                                                    </span>
                                                                ) : (
                                                                    <>
                                                                        <span className={`font-bold text-sm ${r.dias_cumplidos === r.dias_totales ? "text-green-700" : r.dias_cumplidos > 0 ? "text-amber-600" : "text-red-600"}`}>
                                                                            {r.dias_cumplidos}/{r.dias_totales} días
                                                                        </span>
                                                                        <div className="text-xs text-slate-400">{r.cumplimiento_pct}%</div>
                                                                    </>
                                                                )}
                                                            </td>
                                                            {dashPeriod === "dia" && <>
                                                                <td className="p-2 border text-center text-xs whitespace-nowrap">{r.hora_inicio ? formatDateTime(r.hora_inicio) : "—"}</td>
                                                                <td className="p-2 border text-center text-xs whitespace-nowrap">{r.hora_fin ? formatDateTime(r.hora_fin) : "—"}</td>
                                                                <td className="p-2 border text-center text-xs">{formatDuration(r.duracion_min)}</td>
                                                            </>}
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                </section>
                            ) : dashData.length === 0 && !dashLoading ? (
                                <div className="bg-white rounded-3xl p-8 shadow text-center text-slate-400">
                                    Presiona <b>Consultar</b> para cargar los datos del período seleccionado.
                                </div>
                            ) : null}
                        </>
                    )}

                    {/* ── SUB-TAB: ASIGNAR ─────────────────────────────── */}
                    {valTab === "asignar" && (
                        <>
                            <section className="bg-white rounded-3xl p-5 shadow space-y-4">
                                <div>
                                    <h3 className="text-lg font-bold text-slate-900">Asignar productos para contar</h3>
                                    <p className="text-slate-500 text-sm mt-1">Busca un producto del maestro global y asígnalo a la tienda/fecha seleccionada. También puedes cargar masivamente por Excel.</p>
                                </div>

                                <div className="space-y-2">
                                    <input
                                        className="w-full border rounded-2xl p-3 text-sm text-slate-900 bg-white"
                                        placeholder="Buscar por codsap completo, codigo o familia/descripcion..."
                                        value={assignSearch}
                                        onChange={e => searchProductsForAssign(e.target.value)}
                                    />
                                    {assignResults.length > 0 && (
                                        <div className="border rounded-2xl overflow-hidden">
                                            <div className="flex flex-wrap items-center gap-2 border-b bg-slate-50 p-3">
                                                <button
                                                    onClick={toggleAllAssignResults}
                                                    className="rounded-xl border bg-white px-3 py-2 text-xs font-bold text-slate-700"
                                                >
                                                    {assignResults.every(product => assignSelectedIds.has(product.id)) ? "Quitar seleccion" : "Seleccionar visibles"}
                                                </button>
                                                <button
                                                    onClick={assignFirst30Results}
                                                    disabled={assignBusy}
                                                    className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-bold text-white disabled:opacity-40"
                                                >
                                                    Asignar 30 primeros
                                                </button>
                                                <button
                                                    onClick={assignSelectedResults}
                                                    disabled={assignBusy || assignSelectedIds.size === 0}
                                                    className="rounded-xl bg-blue-700 px-4 py-2 text-xs font-bold text-white disabled:opacity-40"
                                                >
                                                    Asignar seleccionados ({assignResults.filter(product => assignSelectedIds.has(product.id)).length})
                                                </button>
                                                <span className="text-xs font-semibold text-slate-500">
                                                    {valStoreId === ALL_STORES_VALUE ? "Destino: todas las tiendas" : "Destino: tienda seleccionada"}
                                                </span>
                                            </div>
                                            <div className="max-h-72 overflow-auto">
                                                {assignResults.map(p => {
                                                    const alreadyAssigned = valStoreId !== ALL_STORES_VALUE && assignments.some(a => a.product_id === p.id);
                                                    const selected = assignSelectedIds.has(p.id);
                                                    return (
                                                        <div key={p.id} className={`flex items-center gap-3 p-3 border-b last:border-b-0 ${alreadyAssigned ? "bg-green-50" : "bg-white hover:bg-slate-50"}`}>
                                                            <input
                                                                type="checkbox"
                                                                checked={selected}
                                                                onChange={() => toggleAssignSelection(p.id)}
                                                                className="h-5 w-5 rounded border-slate-300"
                                                            />
                                                            <div className="flex-1 min-w-0">
                                                                <div className="font-semibold text-slate-900 text-sm">{p.sku}</div>
                                                                <div className="text-xs text-slate-600 truncate">{p.description}</div>
                                                                <div className="text-xs text-slate-400">UM: {p.unit} · Código: {p.barcode || "—"}</div>
                                                            </div>
                                                            <div className="flex items-center gap-2">
                                                                {alreadyAssigned ? (
                                                                    <span className="text-xs text-green-700 font-semibold px-3 py-2">✓ Asignado</span>
                                                                ) : (
                                                                    <button className="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold disabled:opacity-40" disabled={assignBusy} onClick={() => assignProduct(p)}>+ Asignar</button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div className="rounded-2xl border border-orange-200 bg-orange-50 p-3 space-y-3">
                                    <div className="flex flex-col gap-2 md:flex-row md:items-end">
                                        <div className="flex-1">
                                            <p className="text-sm font-bold text-slate-800">Codigos no inventariables</p>
                                            <p className="text-xs font-semibold text-slate-500">Estos codigos no apareceran para asignar en ciclicos ni en la carga masiva.</p>
                                        </div>
                                        <input
                                            className="min-w-0 flex-1 rounded-xl border bg-white px-3 py-2 text-sm text-slate-900"
                                            placeholder="Codsap exacto, uno o varios"
                                            value={nonInventoryInput}
                                            onChange={e => setNonInventoryInput(e.target.value)}
                                            onKeyDown={e => { if (e.key === "Enter") addNonInventoryCodes(); }}
                                        />
                                        <button
                                            onClick={addNonInventoryCodes}
                                            className="rounded-xl bg-orange-600 px-4 py-2 text-sm font-black text-white"
                                        >
                                            Agregar
                                        </button>
                                        <button
                                            onClick={() => nonInventoryExcelRef.current?.click()}
                                            disabled={nonInventoryExcelBusy}
                                            className="rounded-xl border border-orange-300 bg-white px-4 py-2 text-sm font-black text-orange-700 disabled:opacity-50"
                                        >
                                            {nonInventoryExcelBusy ? "Subiendo..." : "Subir Excel"}
                                        </button>
                                        <input
                                            ref={nonInventoryExcelRef}
                                            type="file"
                                            accept=".xlsx,.xls"
                                            className="hidden"
                                            onChange={e => uploadNonInventoryExcel(e.target.files?.[0] || null)}
                                        />
                                    </div>
                                    {nonInventoryExcelFileName && (
                                        <p className="text-xs font-semibold text-orange-700">
                                            Ultimo Excel: {nonInventoryExcelFileName}
                                        </p>
                                    )}
                                    {nonInventoryProducts.length > 0 && (
                                        <div className="flex max-h-28 flex-wrap gap-2 overflow-auto">
                                            {nonInventoryProducts.slice(0, 80).map(row => (
                                                <button
                                                    key={row.id}
                                                    onClick={() => removeNonInventoryCode(row)}
                                                    className="rounded-full border border-orange-300 bg-white px-3 py-1 text-xs font-bold text-orange-700 hover:bg-orange-100"
                                                    title="Quitar de no inventariables"
                                                >
                                                    {row.sku} x
                                                </button>
                                            ))}
                                            {nonInventoryProducts.length > 80 && <span className="px-2 py-1 text-xs font-bold text-slate-500">+{nonInventoryProducts.length - 80}</span>}
                                        </div>
                                    )}
                                </div>

                                {/* Carga masiva */}
                                <div className="border-t pt-4 space-y-3">
                                    <div>
                                        <p className="text-sm font-semibold text-slate-700">📦 Carga masiva por Excel — <span className="text-blue-700">Todas las tiendas</span></p>
                                        <div className="mt-1.5 rounded-2xl bg-blue-50 border border-blue-200 p-3 space-y-1 text-xs text-slate-600">
                                            <p>✅ <b>Formato multi-tienda recomendado:</b> <b>A: Tienda</b> · <b>B: Código</b>.<br/>
                                            El sistema busca descripción, UM y costo en el maestro, y toma el stock desde la sincronización por tienda.</p>
                                            <p className="text-slate-400">Formato simple: <b>A: Código</b>. Requiere tienda seleccionada arriba. Si incluyes una columna <b>Stock</b>, se usará como override manual.</p>
                                            <p className="text-blue-700 font-semibold">⚡ Puedes usar nombre, código o sede ERP de la tienda. Los códigos pueden ser SKU o código de barra.</p>
                                        </div>
                                    </div>
                                    {bulkAssignProgress && (
                                        <div className="rounded-2xl bg-blue-50 border border-blue-200 p-3 space-y-1">
                                            <p className="text-xs font-semibold text-blue-800">{bulkAssignProgress.step}</p>
                                            <div className="h-2 bg-blue-200 rounded-full overflow-hidden">
                                                <div className="h-full bg-blue-600 rounded-full transition-all" style={{ width: `${bulkAssignProgress.pct}%` }} />
                                            </div>
                                        </div>
                                    )}
                                    <div className="flex gap-3 flex-wrap items-center">
                                        <button className="px-4 py-2.5 rounded-2xl border font-semibold text-sm text-slate-700" onClick={() => bulkAssignRef.current?.click()}>
                                            {bulkAssignFileName || "📂 Seleccionar Excel"}
                                        </button>
                                        <input ref={bulkAssignRef} type="file" accept=".xlsx,.xls" className="hidden"
                                            onChange={e => { const f = e.target.files?.[0] || null; setBulkAssignFile(f); setBulkAssignFileName(f?.name || ""); e.target.value = ""; }} />
                                        {bulkAssignFile && (
                                            <button className="px-4 py-2.5 rounded-2xl bg-blue-700 text-white font-semibold text-sm" onClick={uploadBulkAssign}>
                                                🚀 Cargar todas las tiendas
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </section>

                            {/* Lista asignados del día */}
                            {valStoreId === ALL_STORES_VALUE && (
                                <section className="bg-white rounded-3xl p-5 shadow space-y-3">
                                    <div className="flex items-center justify-between gap-3 flex-wrap">
                                        <div>
                                            <h3 className="font-bold text-slate-900">Codigos asignados a todas las tiendas ({allStoreAssignmentSummary.length})</h3>
                                            <p className="text-xs text-slate-500">Resumen de codigos que existen en todas las tiendas activas para {valDate}.</p>
                                        </div>
                                        <button
                                            className="px-4 py-2 rounded-2xl border border-slate-300 text-slate-700 font-semibold text-xs hover:bg-slate-50 transition disabled:opacity-40"
                                            onClick={() => loadAllStoreAssignmentSummary(valDate)}
                                            disabled={allStoreSummaryLoading}
                                        >
                                            <RefreshCw size={14} className={`mr-1 inline ${allStoreSummaryLoading ? "animate-spin" : ""}`} /> Actualizar
                                        </button>
                                    </div>
                                    {allStoreSummaryLoading ? (
                                        <div className="rounded-2xl border border-dashed p-6 text-center text-sm font-semibold text-slate-500">Cargando resumen...</div>
                                    ) : allStoreAssignmentSummary.length === 0 ? (
                                        <div className="rounded-2xl border border-dashed p-6 text-center text-sm font-semibold text-slate-500">
                                            No hay codigos asignados a todas las tiendas para esta fecha.
                                        </div>
                                    ) : (
                                        <div className="border rounded-2xl overflow-hidden">
                                            <div className="max-h-80 overflow-auto">
                                                <table className="w-full text-sm">
                                                    <thead className="bg-slate-100 sticky top-0">
                                                        <tr>
                                                            <th className="p-2 border text-left">SKU</th>
                                                            <th className="p-2 border text-left">Descripcion</th>
                                                            <th className="p-2 border">UM</th>
                                                            <th className="p-2 border">Tiendas</th>
                                                            <th className="p-2 border">Asignaciones</th>
                                                            <th className="p-2 border">Accion</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {allStoreAssignmentSummary.map(row => (
                                                            <tr key={row.product_id}>
                                                                <td className="p-2 border font-medium">{row.sku}</td>
                                                                <td className="p-2 border text-slate-600">{row.description}</td>
                                                                <td className="p-2 border text-center">{row.unit}</td>
                                                                <td className="p-2 border text-center font-semibold">{row.store_count}</td>
                                                                <td className="p-2 border text-center">{row.assignment_count}</td>
                                                                <td className="p-2 border text-center">
                                                                    <button className="text-xs text-red-600 underline" onClick={() => removeAllStoresProductAssignments(row)}>
                                                                        Quitar de todas
                                                                    </button>
                                                                </td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    )}
                                </section>
                            )}

                            {assignments.length > 0 && (
                                <section className="bg-white rounded-3xl p-5 shadow space-y-3">
                                    <div className="flex items-center justify-between gap-3 flex-wrap">
                                        <h3 className="font-bold text-slate-900">Asignados este día ({assignments.length})</h3>
                                        <div className="flex gap-2 flex-wrap">
                                            <button
                                                className="px-4 py-2 rounded-2xl border border-blue-200 bg-blue-50 text-blue-700 font-semibold text-xs hover:bg-blue-100 transition disabled:opacity-40"
                                                onClick={refreshValidatorAssignedStocksForDate}
                                                disabled={bulkRefreshingStocks}
                                            >
                                                <RefreshCw size={14} className={`mr-1 inline ${bulkRefreshingStocks ? "animate-spin" : ""}`} /> Actualizar stock fecha
                                            </button>
                                            <button
                                                className="px-4 py-2 rounded-2xl border border-red-300 text-red-600 font-semibold text-xs hover:bg-red-50 transition"
                                                onClick={removeAllAssignments}
                                            >
                                                🗑️ Quitar todos
                                            </button>
                                        </div>
                                    </div>
                                    <div className="border rounded-2xl overflow-hidden">
                                        <div className="max-h-96 overflow-auto">
                                            <table className="w-full text-sm">
                                                <thead className="bg-slate-100 sticky top-0">
                                                    <tr>
                                                        <th className="p-2 border text-left">SKU</th>
                                                        <th className="p-2 border text-left">Descripción</th>
                                                        <th className="p-2 border">UM</th>
                                                        <th className="p-2 border">Stock Sis.</th>
                                                        <th className="p-2 border">Estado</th>
                                                        <th className="p-2 border">Acción</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {assignments.map(a => {
                                                        const c = counts.find(c => c.assignment_id === a.id);
                                                        return (
                                                            <tr key={a.id} className={c ? "bg-green-50" : ""}>
                                                                <td className="p-2 border font-medium">{a.sku}</td>
                                                                <td className="p-2 border text-slate-600">{a.description}</td>
                                                                <td className="p-2 border text-center">{a.unit}</td>
                                                                <td className="p-2 border text-center font-semibold">{formatNumber(a.system_stock)}</td>
                                                                <td className="p-2 border text-center">
                                                                    {c ? <span className={statusBadge(c.status)}>{c.status}</span> : <span className="text-xs text-amber-600 font-semibold">Pendiente</span>}
                                                                </td>
                                                                <td className="p-2 border text-center">
                                                                    <button className="text-xs text-red-600 underline" onClick={() => removeAssignment(a)}>Quitar</button>
                                                                </td>
                                                            </tr>
                                                        );
                                                    })}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                </section>
                            )}
                        </>
                    )}

                    {/* ── SUB-TAB: REGISTROS ─────────────────────────── */}
                    {valTab === "registros" && (
                        <section className="bg-white rounded-3xl p-5 shadow space-y-4">
                            <div className="flex flex-wrap gap-3 items-center justify-between">
                                <div>
                                    <h3 className="text-lg font-bold text-slate-900">Registros de conteo</h3>
                                    <p className="text-slate-500 text-xs mt-0.5">{filteredCounts.length} registro{filteredCounts.length !== 1 ? "s" : ""} encontrado{filteredCounts.length !== 1 ? "s" : ""}</p>
                                </div>
                                <div className="flex gap-2 flex-wrap">
                                    <button className="px-4 py-2 rounded-2xl border text-sm font-semibold text-slate-700" onClick={exportCounts}>↓ Excel registros</button>
                                    {/* Reversar cumplimiento — solo admin y validador */}
                                    {isValOrAdm && counts.length > 0 && (
                                        <button
                                            className="px-4 py-2 rounded-2xl border-2 border-orange-400 text-orange-700 bg-orange-50 hover:bg-orange-100 text-sm font-bold transition-colors"
                                            onClick={reversarCumplimiento}
                                            title="Elimina todos los conteos del día para que el operario pueda volver a registrar"
                                        >
                                            🔄 Reversar cumplimiento
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Aviso si hay conteos "sin stock" */}
                            {counts.some(c => c.location === "__sin_stock__") && (
                                <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 font-medium flex items-center gap-2">
                                    🚫 <span>Hay {counts.filter(c => c.location === "__sin_stock__").length} código{counts.filter(c => c.location === "__sin_stock__").length !== 1 ? "s" : ""} marcado{counts.filter(c => c.location === "__sin_stock__").length !== 1 ? "s" : ""} como <b>sin stock físico</b>.</span>
                                </div>
                            )}

                            <div className="flex gap-3 flex-wrap">
                                <input className="flex-1 border rounded-2xl p-3 text-sm text-slate-900 bg-white min-w-[180px]" placeholder="Buscar SKU, descripción, usuario..." value={valSearchText} onChange={e => setValSearchText(e.target.value)} />
                                <select className="border rounded-2xl p-3 text-sm text-slate-900 bg-white" value={valStatusFilter} onChange={e => setValStatusFilter(e.target.value)}>
                                    <option value="todos">Todos los estados</option>
                                    <option value="pendiente">Pendiente</option>
                                    <option value="diferencia">Diferencia</option>
                                    <option value="validado">Validado</option>
                                    <option value="corregido">Corregido</option>
                                </select>
                            </div>

                            <div className="border rounded-2xl overflow-hidden">
                                <div className="max-h-[500px] overflow-auto">
                                    <table className="w-full text-sm">
                                        <thead className="bg-slate-100 sticky top-0">
                                            <tr>
                                                <th className="p-2 border text-left">SKU</th>
                                                <th className="p-2 border text-left">Descripción</th>
                                                <th className="p-2 border">Stock usado</th>
                                                <th className="p-2 border">Ubicación</th>
                                                <th className="p-2 border">Cantidad</th>
                                                <th className="p-2 border">Usuario</th>
                                                <th className="p-2 border">Hora</th>
                                                <th className="p-2 border">Estado</th>
                                                <th className="p-2 border">Acción</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {filteredCounts.map(c => {
                                                const isSinStock = c.location === "__sin_stock__";
                                                return (
                                                <tr key={c.id} className={isSinStock ? "bg-red-50" : "hover:bg-slate-50"}>
                                                    <td className="p-2 border font-medium">{c.sku}</td>
                                                    <td className="p-2 border text-slate-600 max-w-[180px] truncate">{c.description}</td>
                                                    <td className="p-2 border text-center font-semibold">{c.stock_snapshot !== null && c.stock_snapshot !== undefined ? formatNumber(c.stock_snapshot) : c.system_stock !== null && c.system_stock !== undefined ? formatNumber(c.system_stock) : "—"}</td>
                                                    <td className="p-2 border text-center font-mono text-xs">
                                                        {isSinStock
                                                            ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-bold text-xs border border-red-200">🚫 Sin stock</span>
                                                            : c.location}
                                                    </td>
                                                    <td className="p-2 border text-center font-semibold">{formatNumber(c.counted_quantity)}</td>
                                                    <td className="p-2 border text-xs">{c.user_name}</td>
                                                    <td className="p-2 border text-xs text-slate-500 whitespace-nowrap">{formatDateTime(c.counted_at)}</td>
                                                    <td className="p-2 border text-center"><span className={statusBadge(c.status)}>{c.status}</span></td>
                                                    <td className="p-2 border text-center">
                                                        <button className="px-3 py-1.5 rounded-lg border text-xs font-semibold mr-1" onClick={() => openEditCount(c)}>Editar</button>
                                                        <button className="px-3 py-1.5 rounded-lg text-xs font-semibold text-red-600 border border-red-200" onClick={() => deleteCount(c)}>✕</button>
                                                    </td>
                                                </tr>
                                                );
                                            })}
                                            {filteredCounts.length === 0 && (
                                                <tr><td className="p-6 border text-center text-slate-400" colSpan={9}>No hay conteos registrados todavía.</td></tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </section>
                    )}

                    {/* ── SUB-TAB: RESUMEN POR CÓDIGO ─────────────────── */}
                    {valTab === "resumen" && (
                        <section className="bg-white rounded-3xl p-5 shadow space-y-4">
                            {/* Breadcrumb desde dashboard */}
                            {dashDrillSource && (
                                <div className="flex items-center gap-2 text-sm">
                                    <button
                                        className="flex items-center gap-1.5 text-blue-700 hover:text-blue-900 font-semibold transition-colors"
                                        onClick={() => { setDashDrillSource(false); setResumenOverrides({}); setResumenDraft({}); setResumenEditMode(false); setValTab("dashboard"); }}
                                    >
                                        ← Volver al Dashboard
                                    </button>
                                    <span className="text-slate-400">·</span>
                                    <span className="text-slate-600 font-medium">{allStores.find(s => s.id === valStoreId)?.name}</span>
                                    <span className="text-slate-400">·</span>
                                    <span className="text-slate-500">{valDate}</span>
                                </div>
                            )}
                            <div className="flex flex-wrap gap-3 items-center justify-between">
                                <div>
                                    <h3 className="text-lg font-bold text-slate-900">Resumen por código</h3>
                                    <p className="text-slate-500 text-xs mt-0.5">
                                        Diferencia valorizada total:&nbsp;
                                        <b className={resumenStats.valorizadaDif < 0 ? "text-red-600" : resumenStats.valorizadaDif > 0 ? "text-blue-700" : "text-green-700"}>
                                            {formatMoney(resumenStats.valorizadaDif)}
                                        </b>
                                    </p>
                                </div>
                                <div className="flex gap-2 flex-wrap">
                                    {/* Botón modo edición — solo en drill-down desde dashboard */}
                                    {dashDrillSource && (
                                        <button
                                            className={`px-4 py-2 rounded-2xl text-sm font-semibold border transition-all ${resumenEditMode ? "bg-amber-500 text-white border-amber-500" : "bg-white text-amber-700 border-amber-400 hover:bg-amber-50"}`}
                                            onClick={() => { setResumenEditMode(prev => !prev); if (resumenEditMode) { setResumenOverrides({}); setResumenDraft({}); setResumenSort(null); } }}
                                        >
                                            {resumenEditMode ? "✏️ Editando — Click para salir" : "✏️ Modo análisis"}
                                        </button>
                                    )}
                                    {resumenEditMode && (Object.keys(resumenDraft).length > 0 || Object.keys(resumenOverrides).length > 0) && (
                                        <button
                                            className="px-4 py-2 rounded-2xl text-sm font-semibold border border-slate-300 text-slate-600 hover:bg-slate-50"
                                            onClick={() => { setResumenOverrides({}); setResumenDraft({}); }}
                                        >
                                            🔄 Resetear cambios
                                        </button>
                                    )}
                                    {resumenEditMode && Object.keys(resumenDraft).length > 0 && (
                                        <button
                                            className={`px-4 py-2 rounded-2xl text-sm font-semibold transition-all ${savingAnalysis ? "bg-green-300 text-white cursor-not-allowed" : "bg-green-700 text-white hover:bg-green-800"}`}
                                            onClick={() => {
                                                // Merge draft into overrides FIRST (this triggers recalc), then save to BD
                                                const merged = { ...resumenOverrides, ...resumenDraft };
                                                setResumenOverrides(merged);
                                                setResumenDraft({});
                                                // saveResumenAnalysis uses resumenOverrides — give React one tick then call
                                                setTimeout(() => saveResumenAnalysis(merged), 0);
                                            }}
                                            disabled={savingAnalysis}
                                        >
                                            {savingAnalysis ? "Guardando..." : `💾 Guardar ${Object.keys(resumenDraft).length} cambio${Object.keys(resumenDraft).length !== 1 ? "s" : ""}`}
                                        </button>
                                    )}
                                    <button className="px-4 py-2 rounded-2xl border text-sm font-semibold text-slate-700" onClick={exportResumen}>↓ Excel resumen</button>
                                </div>
                            </div>

                            <input
                                className="w-full border rounded-2xl p-3 text-sm text-slate-900 bg-white"
                                placeholder="Buscar SKU o descripción..."
                                value={resumenSearch}
                                onChange={e => setResumenSearch(e.target.value)}
                            />

                            {filteredResumen.filter(r => counts.some(c => c.product_id === r.product_id)).length > 0 && (
                                <>
                                    <p className="text-sm font-semibold text-slate-700">✅ Códigos contados ({filteredResumen.filter(r => counts.some(c => c.product_id === r.product_id)).length})</p>
                                    {resumenEditMode && (
                                        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                                            ✏️ <b>Modo análisis activo:</b> Edita el <b>Stock sistema</b> o el <b>Total contado</b>. La diferencia y valorización se recalculan en tiempo real. Al presionar <b>💾 Guardar</b> los cambios se escriben en la base de datos: el stock actualiza <code>cyclic_assignments</code> y el conteo ajusta <code>cyclic_counts</code>.
                                        </p>
                                    )}
                                    <div className="border rounded-2xl overflow-hidden">
                                        <div className="max-h-[500px] overflow-auto">
                                            <table className="w-full text-sm">
                                                <thead className="bg-slate-100 sticky top-0">
                                                    <tr>
                                                        {([
                                                            { col: "sku",     label: "SKU",             align: "left"   as const, amber: false },
                                                            { col: "desc",    label: "Descripción",     align: "left"   as const, amber: false },
                                                            { col: "um",      label: "UM",              align: "center" as const, amber: false },
                                                            { col: "stock",   label: "Stock Sis.",      align: "center" as const, amber: true  },
                                                            { col: "contado", label: "Total Contado",   align: "center" as const, amber: true  },
                                                            { col: "dif",     label: "Diferencia",      align: "center" as const, amber: false },
                                                            { col: "costo",   label: "Costo",           align: "center" as const, amber: false },
                                                            { col: "val",     label: "Dif. Valorizada", align: "center" as const, amber: false },
                                                        ]).map(({ col, label, align, amber }) => {
                                                            const isActive = resumenSort?.col === col;
                                                            const isAsc    = isActive && resumenSort?.dir === "asc";
                                                            return (
                                                                <th
                                                                    key={col}
                                                                    onClick={() => setResumenSort(prev =>
                                                                        prev?.col === col
                                                                            ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
                                                                            : { col, dir: "asc" }
                                                                    )}
                                                                    className={`p-2 border cursor-pointer select-none whitespace-nowrap group transition-colors
                                                                        text-${align}
                                                                        ${amber && resumenEditMode ? "bg-amber-50 text-amber-800 hover:bg-amber-100" : "hover:bg-slate-200"}
                                                                        ${isActive ? "bg-blue-50 text-blue-800" : ""}
                                                                    `}
                                                                >
                                                                    <span className="inline-flex items-center gap-1">
                                                                        {label}
                                                                        <span className={`text-xs transition-opacity ${isActive ? "opacity-100" : "opacity-0 group-hover:opacity-40"}`}>
                                                                            {isAsc ? "↑" : "↓"}
                                                                        </span>
                                                                    </span>
                                                                </th>
                                                            );
                                                        })}
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {filteredResumen
                                                        .filter(r => counts.some(c => c.product_id === r.product_id))
                                                        .map(r => {
                                                        const hasOverride = !!resumenOverrides[r.product_id];
                                                        const hasDraft    = !!resumenDraft[r.product_id];
                                                        return (
                                                        <tr key={r.product_id} className={
                                                            hasDraft    ? "bg-amber-50 ring-1 ring-amber-300" :
                                                            hasOverride ? "bg-amber-50" :
                                                            r.difference !== 0 ? "bg-red-50" : "hover:bg-slate-50"
                                                        }>
                                                            <td className="p-2 border font-medium">{r.sku}</td>
                                                            <td className="p-2 border text-slate-600 max-w-[180px] truncate">{r.description}</td>
                                                            <td className="p-2 border text-center text-xs">{r.unit}</td>
                                                            <td className="p-2 border text-center">
                                                                {resumenEditMode ? (
                                                                    <input
                                                                        type="number"
                                                                        min="0"
                                                                        className="w-20 border border-amber-400 rounded-lg px-2 py-1 text-center text-sm font-semibold bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
                                                                        value={resumenDraft[r.product_id]?.system_stock !== undefined ? resumenDraft[r.product_id].system_stock : resumenOverrides[r.product_id]?.system_stock !== undefined ? resumenOverrides[r.product_id].system_stock : r.system_stock}
                                                                        onChange={e => {
                                                                            const val = Number(e.target.value);
                                                                            setResumenDraft(prev => ({
                                                                                ...prev,
                                                                                [r.product_id]: { ...prev[r.product_id], system_stock: isNaN(val) ? 0 : val }
                                                                            }));
                                                                        }}
                                                                    />
                                                                ) : r.system_stock}
                                                            </td>
                                                            <td className="p-2 border text-center font-semibold">
                                                                {resumenEditMode ? (
                                                                    <input
                                                                        type="number"
                                                                        min="0"
                                                                        className="w-20 border border-amber-400 rounded-lg px-2 py-1 text-center text-sm font-semibold bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
                                                                        value={resumenDraft[r.product_id]?.total_counted !== undefined ? resumenDraft[r.product_id].total_counted : resumenOverrides[r.product_id]?.total_counted !== undefined ? resumenOverrides[r.product_id].total_counted : r.total_counted}
                                                                        onChange={e => {
                                                                            const val = Number(e.target.value);
                                                                            setResumenDraft(prev => ({
                                                                                ...prev,
                                                                                [r.product_id]: { ...prev[r.product_id], total_counted: isNaN(val) ? 0 : val }
                                                                            }));
                                                                        }}
                                                                    />
                                                                ) : r.total_counted}
                                                            </td>
                                                            <td className="p-2 border text-center">{diffBadge(r.difference)}</td>
                                                            <td className="p-2 border text-center text-xs">{formatMoney(r.cost)}</td>
                                                            <td className="p-2 border text-center text-xs font-semibold">
                                                                <span className={r.dif_valorizada < 0 ? "text-red-600" : r.dif_valorizada > 0 ? "text-blue-700" : "text-green-700"}>
                                                                    {formatMoney(r.dif_valorizada)}
                                                                </span>
                                                            </td>
                                                        </tr>
                                                        );
                                                    })}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                </>
                            )}

                            {notCountedAssignments.length > 0 && (
                                <div className="space-y-3">
                                    <p className="text-sm font-semibold text-amber-700">⏳ Sin contar ({notCountedAssignments.length})</p>
                                    <div className="border border-amber-200 rounded-2xl overflow-hidden">
                                        <div className="max-h-[400px] overflow-auto">
                                            <table className="w-full text-sm">
                                                <thead className="bg-amber-50 sticky top-0">
                                                    <tr>
                                                        <th className="p-2 border border-amber-200 text-left">SKU</th>
                                                        <th className="p-2 border border-amber-200 text-left">Descripción</th>
                                                        <th className="p-2 border border-amber-200">UM</th>
                                                        <th className="p-2 border border-amber-200">Costo Unit.</th>
                                                        <th className="p-2 border border-amber-200">Stock Sis.</th>
                                                        <th className="p-2 border border-amber-200">Dif. Val. Potencial</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {notCountedAssignments
                                                        .filter(a => {
                                                            if (!resumenSearch.trim()) return true;
                                                            const q = resumenSearch.trim().toLowerCase();
                                                            return (a.sku || "").toLowerCase().includes(q) || (a.description || "").toLowerCase().includes(q);
                                                        })
                                                        .map(a => {
                                                            const difVal = -(a.system_stock) * (a.cost || 0);
                                                            return (
                                                                <tr key={a.id} className="bg-amber-50/50 hover:bg-amber-100/50">
                                                                    <td className="p-2 border border-amber-100 font-medium text-amber-900">{a.sku}</td>
                                                                    <td className="p-2 border border-amber-100 text-slate-600 max-w-[180px] truncate">{a.description}</td>
                                                                    <td className="p-2 border border-amber-100 text-center text-xs">{a.unit}</td>
                                                                    <td className="p-2 border border-amber-100 text-center text-xs">{formatMoney(a.cost || 0)}</td>
                                                                    <td className="p-2 border border-amber-100 text-center font-semibold">{formatNumber(a.system_stock)}</td>
                                                                    <td className="p-2 border border-amber-100 text-center text-xs text-red-600 font-semibold">
                                                                        {formatMoney(difVal)}
                                                                    </td>
                                                                </tr>
                                                            );
                                                        })}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {resumenPorCodigo.length === 0 && (
                                <div className="text-center text-slate-400 py-8">No hay productos asignados para esta tienda y fecha.</div>
                            )}
                        </section>
                    )}
                </>
            )}

            {/* ════════════════════════════════════════════════════════
                TAB ADMIN
            ════════════════════════════════════════════════════════ */}
            {activeTab === "admin" && isAdmin && (
                <>

                    {/* ── ADMIN: MAESTRO PRODUCTOS ──────────────────────── */}
                    {adminTab === "productos" && (
                        <>
                            <section className="bg-white rounded-3xl p-5 shadow space-y-4">
                                <div>
                                    <h2 className="text-xl font-bold text-slate-900">Maestro global de productos</h2>
                                    <p className="text-slate-500 text-sm mt-1">Sube 2 archivos: el <b>Maestro de productos</b> y los <b>Códigos de barra</b>.</p>
                                </div>

                                {/* ARCHIVO 1: Maestro de productos */}
                                <div className="rounded-2xl bg-slate-50 border p-4 space-y-2">
                                    <p className="text-sm font-semibold text-slate-700">📋 Archivo 1 — Maestro de productos</p>
                                    <p className="text-xs text-slate-400">Columnas por posición (la fila 1 se ignora): <b>A: Código</b> · <b>B: Descripción</b> · <b>C: Unidad de medida</b> · <b>D: Costo</b> · <b>E: Stock</b>. El encabezado no importa, solo el orden de columnas.</p>
                                    {uploadProgress && (
                                        <div className="rounded-xl bg-blue-50 border border-blue-200 p-3 space-y-1">
                                            <p className="text-xs font-semibold text-blue-800">{uploadProgress.step}</p>
                                            <div className="h-2 bg-blue-200 rounded-full overflow-hidden">
                                                <div className="h-full bg-blue-600 rounded-full transition-all" style={{ width: `${uploadProgress.pct}%` }} />
                                            </div>
                                        </div>
                                    )}
                                    <div className="flex gap-3 flex-wrap items-center">
                                        <button className="px-4 py-2.5 rounded-2xl border font-semibold text-sm bg-white text-slate-700" onClick={() => masterInputRef.current?.click()}>
                                            {masterFileName || "Seleccionar Excel"}
                                        </button>
                                        <input ref={masterInputRef} type="file" accept=".xlsx,.xls" className="hidden"
                                            onChange={e => { const f = e.target.files?.[0] || null; setMasterFile(f); setMasterFileName(f?.name || ""); e.target.value = ""; }} />
                                        {masterFile && (
                                            <button className="px-4 py-2.5 rounded-2xl bg-slate-900 text-white font-semibold text-sm" onClick={uploadMaster}>Subir maestro</button>
                                        )}
                                        <span className="text-xs text-slate-400">{products.length.toLocaleString()} productos activos</span>
                                    </div>
                                </div>

                                {/* ARCHIVO 2: Códigos de barra */}
                                <div className="rounded-2xl bg-slate-50 border p-4 space-y-2">
                                    <p className="text-sm font-semibold text-slate-700">🔖 Archivo 2 — Códigos de barra</p>
                                    <p className="text-xs text-slate-400">Columnas: <b>CODIGO</b>, <b>CODIGO DE BARRA 1</b>, <b>CODIGO DE BARRA 2</b>. Se sube 1 sola vez.</p>
                                    {barcodesProgress && (
                                        <div className="rounded-xl bg-blue-50 border border-blue-200 p-3 space-y-1">
                                            <p className="text-xs font-semibold text-blue-800">{barcodesProgress.step}</p>
                                            <div className="h-2 bg-blue-200 rounded-full overflow-hidden">
                                                <div className="h-full bg-blue-600 rounded-full transition-all" style={{ width: `${barcodesProgress.pct}%` }} />
                                            </div>
                                        </div>
                                    )}
                                    <div className="flex gap-3 flex-wrap items-center">
                                        <button className="px-4 py-2.5 rounded-2xl border font-semibold text-sm bg-white text-slate-700" onClick={() => barcodesInputRef.current?.click()}>
                                            {barcodesFileName || "Seleccionar Excel"}
                                        </button>
                                        <input ref={barcodesInputRef} type="file" accept=".xlsx,.xls" className="hidden"
                                            onChange={e => { const f = e.target.files?.[0] || null; setBarcodesFile(f); setBarcodesFileName(f?.name || ""); e.target.value = ""; }} />
                                        {barcodesFile && (
                                            <button className="px-4 py-2.5 rounded-2xl bg-slate-900 text-white font-semibold text-sm" onClick={uploadBarcodes}>Actualizar códigos</button>
                                        )}
                                    </div>
                                </div>
                            </section>

                            {/* Lista de productos */}
                            <section className="bg-white rounded-3xl p-5 shadow space-y-3">
                                <div className="flex items-center justify-between gap-3 flex-wrap">
                                    <h3 className="font-bold text-slate-900">Productos del maestro</h3>
                                    <input className="border rounded-2xl px-3 py-2 text-sm w-64 text-slate-900 bg-white" placeholder="Buscar SKU o descripción..." value={prodSearch} onChange={e => setProdSearch(e.target.value)} />
                                </div>
                                <div className="border rounded-2xl overflow-hidden">
                                    <div className="max-h-[450px] overflow-auto">
                                        <table className="w-full text-sm">
                                            <thead className="bg-slate-100 sticky top-0">
                                                <tr>
                                                    <th className="p-2 border text-left">SKU</th>
                                                    <th className="p-2 border text-left">Descripción</th>
                                                    <th className="p-2 border">UM</th>
                                                    <th className="p-2 border">Costo</th>
                                                    <th className="p-2 border">Código barra</th>
                                                    <th className="p-2 border">Acción</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {filteredProducts.map(p => (
                                                    <tr key={p.id} className="hover:bg-slate-50">
                                                        <td className="p-2 border font-medium">{p.sku}</td>
                                                        <td className="p-2 border text-slate-600 max-w-[200px] truncate">{p.description}</td>
                                                        <td className="p-2 border text-center">{p.unit}</td>
                                                        <td className="p-2 border text-center">{formatMoney(p.cost)}</td>
                                                        <td className="p-2 border text-center font-mono text-xs">{p.barcode || "—"}</td>
                                                        <td className="p-2 border text-center">
                                                            <button className="px-3 py-1.5 rounded-lg border text-xs font-semibold" onClick={() => { setEditingProduct(p); setEditProdSku(p.sku); setEditProdBarcode(p.barcode || ""); setEditProdDesc(p.description); setEditProdUnit(p.unit); setEditProdCost(String(p.cost)); }}>Editar</button>
                                                        </td>
                                                    </tr>
                                                ))}
                                                {filteredProducts.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-400">No hay productos.</td></tr>}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                                {!prodSearch && products.length > 100 && (
                                    <p className="text-xs text-slate-400 text-center">Mostrando primeros 100 de {products.length.toLocaleString()}. Usa el buscador para filtrar.</p>
                                )}
                            </section>
                        </>
                    )}

                    {/* ── ADMIN: TIENDAS ────────────────────────────────── */}
                    {adminTab === "tiendas" && (
                        <section className="bg-white rounded-3xl p-5 shadow space-y-4">
                            <h2 className="text-xl font-bold text-slate-900">Tiendas</h2>
                            <div className="rounded-2xl bg-slate-50 border p-4 space-y-3">
                                <p className="text-sm font-semibold text-slate-700">Nueva tienda</p>
                                <div className="flex gap-3 flex-wrap">
                                    <input className="flex-1 border rounded-2xl p-3 text-sm bg-white text-slate-900 min-w-[160px]" placeholder="Nombre de la tienda" value={newStoreName} onChange={e => setNewStoreName(e.target.value)} />
                                    <input className="w-32 border rounded-2xl p-3 text-sm bg-white text-slate-900" placeholder="Código" value={newStoreCode} onChange={e => setNewStoreCode(e.target.value)} />
                                    <button className="px-5 py-3 rounded-2xl bg-slate-900 text-white font-semibold text-sm" onClick={createStore}>+ Crear</button>
                                </div>
                            </div>
                            <div className="border rounded-2xl overflow-hidden">
                                <table className="w-full text-sm">
                                    <thead className="bg-slate-100">
                                        <tr>
                                            <th className="p-2 border text-left">Nombre</th>
                                            <th className="p-2 border">Código</th>
                                            <th className="p-2 border">Estado</th>
                                            <th className="p-2 border">Acción</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {allStores.map(s => (
                                            <tr key={s.id} className={!s.is_active ? "opacity-40" : ""}>
                                                <td className="p-2 border font-medium">{s.name}</td>
                                                <td className="p-2 border text-center font-mono text-xs">{s.code}</td>
                                                <td className="p-2 border text-center">
                                                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${s.is_active ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>{s.is_active ? "Activa" : "Inactiva"}</span>
                                                </td>
                                                <td className="p-2 border text-center">
                                                    <button className="text-xs underline text-slate-600" onClick={() => toggleStoreActive(s)}>{s.is_active ? "Desactivar" : "Activar"}</button>
                                                </td>
                                            </tr>
                                        ))}
                                        {allStores.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-slate-400">No hay tiendas.</td></tr>}
                                    </tbody>
                                </table>
                            </div>
                        </section>
                    )}

                    {/* ── ADMIN: USUARIOS ───────────────────────────────── */}
                    {adminTab === "usuarios" && (
                        <section className="bg-white rounded-3xl p-5 shadow space-y-4">
                            <h2 className="text-xl font-bold text-slate-900">Usuarios</h2>
                            <div className="rounded-2xl bg-slate-50 border p-4 space-y-3">
                                <p className="text-sm font-semibold text-slate-700">Crear nuevo usuario</p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <input className="border rounded-2xl p-3 text-sm bg-white text-slate-900" placeholder="Nombre de usuario" value={newUsername} onChange={e => setNewUsername(e.target.value)} />
                                    <input className="border rounded-2xl p-3 text-sm bg-white text-slate-900" placeholder="Contraseña" value={newPassword} onChange={e => setNewPassword(e.target.value)} />
                                    <input className="border rounded-2xl p-3 text-sm bg-white text-slate-900 md:col-span-2" placeholder="Nombre completo" value={newFullName} onChange={e => setNewFullName(e.target.value)} />
                                    <input className="border rounded-2xl p-3 text-sm bg-white text-slate-900 md:col-span-2" placeholder="WhatsApp (ej: 51987654321 — con código de país)" value={newUserWhatsapp} onChange={e => setNewUserWhatsapp(e.target.value)} />
                                    <div>
                                        <label className="text-xs text-slate-500 block mb-1">Rol</label>
                                        <select className="w-full border rounded-2xl p-3 text-sm bg-white text-slate-900" value={newRole} onChange={e => { setNewRole(e.target.value as Role); if (e.target.value !== "Operario") setNewUserAllStores(true); }}>
                                            <option value="Operario">Operario</option>
                                            <option value="Validador">Validador</option>
                                            <option value="Administrador">Administrador</option>
                                        </select>
                                    </div>
                                    {newRole === "Operario" && (
                                        <div>
                                            <label className="text-xs text-slate-500 block mb-1">Tienda asignada</label>
                                            <select className="w-full border rounded-2xl p-3 text-sm bg-white text-slate-900" value={newUserStoreId} onChange={e => setNewUserStoreId(e.target.value)}>
                                                <option value="">— Sin asignar —</option>
                                                {allStores.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                            </select>
                                        </div>
                                    )}
                                    <label className="flex items-center gap-3 rounded-2xl border bg-white p-3 text-sm font-semibold text-slate-700 md:col-span-2">
                                        <input type="checkbox" checked={newRole === "Administrador" || newUserAuditAccess} disabled={newRole === "Administrador"} onChange={e => setNewUserAuditAccess(e.target.checked)} />
                                        Puede acceder a auditorías
                                    </label>
                                </div>
                                <button className="px-5 py-3 rounded-2xl bg-slate-900 text-white font-semibold text-sm" onClick={createUser}>+ Crear usuario</button>
                            </div>

                            <div className="border rounded-2xl overflow-hidden">
                                <div className="max-h-[450px] overflow-auto">
                                    <table className="w-full text-sm">
                                        <thead className="bg-slate-100 sticky top-0">
                                            <tr>
                                                <th className="p-2 border text-left">Usuario</th>
                                                <th className="p-2 border text-left">Nombre</th>
                                                <th className="p-2 border">Rol</th>
                                                <th className="p-2 border">Tienda</th>
                                                <th className="p-2 border">WhatsApp</th>
                                                <th className="p-2 border">Auditoría</th>
                                                <th className="p-2 border">Estado</th>
                                                <th className="p-2 border">Acción</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {allUsers.map(u => {
                                                const store = allStores.find(s => s.id === u.store_id);
                                                return (
                                                    <tr key={u.id} className={!u.is_active ? "opacity-40" : ""}>
                                                        <td className="p-2 border font-mono text-xs">{u.username}</td>
                                                        <td className="p-2 border font-medium">{u.full_name}</td>
                                                        <td className="p-2 border text-center">
                                                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${u.role === "Administrador" ? "bg-purple-100 text-purple-700" : u.role === "Validador" ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-700"}`}>{u.role}</span>
                                                        </td>
                                                        <td className="p-2 border text-center text-xs">{u.can_access_all_stores ? "Todas" : (store?.name || "—")}</td>
                                                        <td className="p-2 border text-center text-xs">
                                                            {u.whatsapp
                                                                ? <a href={`https://wa.me/${u.whatsapp}`} target="_blank" rel="noreferrer" className="text-green-600 font-semibold hover:underline">📲 {u.whatsapp}</a>
                                                                : <span className="text-slate-400">—</span>}
                                                        </td>
                                                        <td className="p-2 border text-center">
                                                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${(u.role === "Administrador" || u.can_access_audit) ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-500"}`}>{(u.role === "Administrador" || u.can_access_audit) ? "Si" : "No"}</span>
                                                        </td>
                                                        <td className="p-2 border text-center">
                                                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${u.is_active ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>{u.is_active ? "Activo" : "Inactivo"}</span>
                                                        </td>
                                                        <td className="p-2 border text-center">
                                                            <button className="px-3 py-1.5 rounded-lg border text-xs font-semibold mr-1" onClick={() => openEditUser(u)}>Editar</button>
                                                            <button className="px-3 py-1.5 rounded-lg border text-xs font-semibold text-red-600 border-red-200" onClick={() => deleteUser(u)}>✕</button>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                            {allUsers.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-slate-400">No hay usuarios.</td></tr>}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </section>
                    )}

                </>
            )}

            </div>{/* end content space-y-4 */}

            {/* ════════════════════════════════════════════════════════
                MODAL — CONTEO (Operario) — MÚLTIPLES UBICACIONES
            ════════════════════════════════════════════════════════ */}
            {activeAssignment && (
                <div className="fixed inset-0 bg-black/50 flex items-end justify-center overflow-y-auto p-2 sm:items-center sm:p-4 z-50">
                    <div className="app-modal-panel bg-white rounded-2xl p-4 w-full max-w-md shadow-2xl sm:rounded-3xl sm:p-6">
                        <div className="flex items-start justify-between gap-3 mb-4">
                            <div className="min-w-0">
                                <h3 className="text-lg font-bold text-slate-900 sm:text-xl">Registrar conteo</h3>
                                <p className="break-words text-slate-700 font-semibold mt-0.5">{activeAssignment.sku}</p>
                                <p className="break-words text-sm text-slate-500">{activeAssignment.description}</p>
                                <div className="flex flex-wrap items-center gap-2 mt-1.5">
                                    <span className="text-xs bg-slate-100 text-slate-700 font-semibold px-2.5 py-1 rounded-full border">UM: {activeAssignment.unit}</span>
                                        <span className="max-w-full break-words text-xs bg-blue-50 text-blue-700 font-bold px-2.5 py-1 rounded-full border border-blue-200">📦 Stock sistema: {formatNumber(activeAssignment.system_stock)}</span>
                                    <button
                                        onClick={() => refreshAssignmentStock(activeAssignment)}
                                        disabled={refreshingStockId === activeAssignment.id || savingCount}
                                        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-blue-200 bg-white text-blue-700 disabled:opacity-40"
                                        title="Actualizar stock sistema"
                                    >
                                        <RefreshCw size={14} className={refreshingStockId === activeAssignment.id ? "animate-spin" : ""} />
                                    </button>
                                </div>
                            </div>
                            <button className="shrink-0 text-slate-400 hover:text-slate-600 text-2xl leading-none" onClick={() => setActiveAssignment(null)}>×</button>
                        </div>

                        <div className="space-y-3 mb-4">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <label className="block font-bold text-sm text-slate-800">Ubicaciones y cantidades</label>
                                <button
                                    className="text-xs px-3 py-2 rounded-xl bg-slate-100 text-slate-700 font-semibold border active:bg-slate-200 active:scale-95 transition-all"
                                    onClick={addLocationRow}
                                    disabled={sinStock}
                                >
                                    + Agregar ubicación
                                </button>
                            </div>

                            {/* ── Botón "Sin stock" ── */}
                            <button
                                className={`w-full py-3 rounded-2xl font-bold text-sm border-2 transition-all ${
                                    sinStock
                                        ? "bg-red-600 text-white border-red-600 shadow"
                                        : "bg-white text-red-600 border-red-300 hover:bg-red-50"
                                }`}
                                onClick={() => setSinStock(prev => !prev)}
                            >
                                {sinStock ? "🚫 Sin stock físico — toca para cancelar" : "🚫 Sin stock físico"}
                            </button>
                            {sinStock && (
                                <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 font-medium">
                                    Se registrará <b>cantidad 0</b> para <b>{activeAssignment?.sku}</b>. El producto quedará como contado con diferencia. No necesitas ingresar ubicación.
                                </div>
                            )}

                            {!sinStock && locationRows.map((row, i) => (
                                <div key={i} className="rounded-2xl border-2 border-slate-200 bg-slate-50 p-3 space-y-3 sm:p-4">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-sm font-bold text-slate-600">
                                            {locationRows.length > 1 ? `📍 Ubicación ${i + 1}` : "📍 Ubicación"}
                                        </span>
                                        {locationRows.length > 1 && (
                                            <button className="text-xs text-red-500 hover:text-red-700 font-semibold active:scale-95 transition-all" onClick={() => removeLocationRow(i)}>✕ Quitar</button>
                                        )}
                                    </div>
                                    <div>
                                        <div className="flex min-w-0 gap-2">
                                            <input
                                                className="min-w-0 flex-1 border-2 rounded-xl p-3 text-sm font-mono text-slate-900 bg-white focus:border-slate-400 focus:outline-none"
                                                placeholder="Ej: A-01-03"
                                                value={row.location}
                                                onChange={e => updateLocationRow(i, "location", e.target.value)}
                                            />
                                            <button
                                                className="px-3 py-2 rounded-xl bg-slate-800 text-white text-xs active:bg-slate-600 active:scale-95 transition-all"
                                                onClick={() => openScanner("location", i)}
                                                title="Escanear ubicación"
                                            >
                                                <QrCode size={16} />
                                            </button>
                                        </div>
                                    </div>
                                    <div>
                                        <label className="text-xs text-slate-500 block mb-1 font-semibold">CANTIDAD</label>
                                        <input
                                            className="w-full border-2 border-slate-300 rounded-xl p-4 text-2xl text-center font-bold text-slate-900 bg-white focus:border-slate-500 focus:outline-none"
                                            type="number"
                                            min="0"
                                            placeholder="0"
                                            value={row.qty}
                                            onChange={e => updateLocationRow(i, "qty", e.target.value)}
                                        />
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
                            <button
                                className={`flex-1 py-4 rounded-2xl font-bold text-base transition-all active:scale-95 ${savingCount ? "bg-slate-400 text-white cursor-not-allowed" : "bg-slate-900 text-white active:bg-slate-700"}`}
                                onClick={saveCount}
                                disabled={savingCount}
                            >
                                {savingCount ? "Guardando..." : "💾 Guardar conteo"}
                            </button>
                            <button
                                className="px-5 py-4 rounded-2xl border-2 font-semibold text-sm text-slate-700 active:bg-slate-100 active:scale-95 transition-all"
                                onClick={() => { setActiveAssignment(null); setSinStock(false); }}
                                disabled={savingCount}
                            >
                                Cancelar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ════════════════════════════════════════════════════════
                MODAL — EDITAR CONTEO (Validador)
            ════════════════════════════════════════════════════════ */}
            {editingCount && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center overflow-y-auto p-3 sm:p-4 z-50">
                    <div className="app-modal-panel bg-white rounded-3xl p-5 w-full max-w-sm space-y-4 shadow-2xl sm:p-6">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-xl font-bold text-slate-900">Editar registro</h3>
                                <p className="text-slate-600 text-sm">{editingCount.sku} — {editingCount.description}</p>
                            </div>
                            <button className="text-slate-400 hover:text-slate-600 text-2xl leading-none" onClick={() => setEditingCount(null)}>×</button>
                        </div>
                        <div className="space-y-3">
                            <div>
                                <label className="block text-sm font-semibold mb-1 text-slate-900">Cantidad contada</label>
                                <input className="w-full border rounded-2xl p-3 text-center font-semibold text-slate-900 bg-white" type="number" min="0" value={editQty} onChange={e => setEditQty(e.target.value)} />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold mb-1 text-slate-900">Ubicación</label>
                                <input className="w-full border rounded-2xl p-3 font-mono text-slate-900 bg-white" value={editLocation} onChange={e => setEditLocation(e.target.value)} />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold mb-1 text-slate-900">Estado</label>
                                <select className="w-full border rounded-2xl p-3 text-slate-900 bg-white" value={editStatus} onChange={e => setEditStatus(e.target.value as CountRecord["status"])}>
                                    <option value="Pendiente">Pendiente</option>
                                    <option value="Diferencia">Diferencia</option>
                                    <option value="Validado">Validado</option>
                                    <option value="Corregido">Corregido</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold mb-1 text-slate-900">Nota</label>
                                <input className="w-full border rounded-2xl p-3 text-slate-900 bg-white" placeholder="Opcional..." value={editNote} onChange={e => setEditNote(e.target.value)} />
                            </div>
                        </div>
                        <div className="flex gap-3 pt-1">
                            <button className="flex-1 py-3 rounded-2xl bg-slate-900 text-white font-semibold" onClick={saveEditCount}>Guardar</button>
                            <button className="px-5 py-3 rounded-2xl border font-semibold text-slate-700" onClick={() => setEditingCount(null)}>Cancelar</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ════════════════════════════════════════════════════════
                MODAL — EDITAR PRODUCTO (Admin)
            ════════════════════════════════════════════════════════ */}
            {editingProduct && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center overflow-y-auto p-3 sm:p-4 z-50">
                    <div className="app-modal-panel bg-white rounded-3xl p-5 w-full max-w-md space-y-4 shadow-2xl sm:p-6">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-xl font-bold text-slate-900">Editar producto</h3>
                                <p className="text-slate-600 text-sm">{editingProduct.sku}</p>
                            </div>
                            <button className="text-slate-400 hover:text-slate-600 text-2xl leading-none" onClick={() => setEditingProduct(null)}>×</button>
                        </div>
                        <div className="grid md:grid-cols-2 gap-4">
                            <div>
                                <label className="block font-semibold text-sm mb-1 text-slate-900">SKU</label>
                                <input className="w-full border rounded-2xl p-3 text-slate-900 bg-white" value={editProdSku} onChange={e => setEditProdSku(e.target.value)} />
                            </div>
                            <div>
                                <label className="block font-semibold text-sm mb-1 text-slate-900">Código de barra</label>
                                <input className="w-full border rounded-2xl p-3 font-mono text-slate-900 bg-white" value={editProdBarcode} onChange={e => setEditProdBarcode(e.target.value)} placeholder="Opcional" />
                            </div>
                            <div className="md:col-span-2">
                                <label className="block font-semibold text-sm mb-1 text-slate-900">Descripción</label>
                                <input className="w-full border rounded-2xl p-3 text-slate-900 bg-white" value={editProdDesc} onChange={e => setEditProdDesc(e.target.value)} />
                            </div>
                            <div>
                                <label className="block font-semibold text-sm mb-1 text-slate-900">Unidad de medida</label>
                                <input className="w-full border rounded-2xl p-3 text-slate-900 bg-white" value={editProdUnit} onChange={e => setEditProdUnit(e.target.value)} />
                            </div>
                            <div>
                                <label className="block font-semibold text-sm mb-1 text-slate-900">Costo unitario</label>
                                <input className="w-full border rounded-2xl p-3 text-slate-900 bg-white" type="number" value={editProdCost} onChange={e => setEditProdCost(e.target.value)} />
                            </div>
                        </div>
                        <div className="flex gap-3 pt-1">
                            <button className="flex-1 py-3 rounded-2xl bg-slate-900 text-white font-semibold" onClick={saveEditProduct}>Guardar cambios</button>
                            <button className="px-5 py-3 rounded-2xl border font-semibold text-slate-700" onClick={() => setEditingProduct(null)}>Cancelar</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ════════════════════════════════════════════════════════
                MODAL — EDITAR USUARIO (Admin)
            ════════════════════════════════════════════════════════ */}
            {editingUser && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center overflow-y-auto p-3 sm:p-4 z-50">
                    <div className="app-modal-panel bg-white rounded-3xl p-5 w-full max-w-md space-y-4 shadow-2xl sm:p-6">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-xl font-bold text-slate-900">Editar usuario</h3>
                                <p className="text-slate-600 text-sm">{editingUser.username} · {editingUser.full_name}</p>
                            </div>
                            <button className="text-slate-400 hover:text-slate-600 text-2xl leading-none" onClick={() => setEditingUser(null)}>×</button>
                        </div>
                        <div className="space-y-3">
                            <div>
                                <label className="block text-sm font-semibold mb-1 text-slate-900">Rol</label>
                                <select className="w-full border rounded-2xl p-3 text-slate-900 bg-white" value={editUserRole} onChange={e => { setEditUserRole(e.target.value as Role); if (e.target.value !== "Operario") setEditUserAllStores(true); }}>
                                    <option value="Operario">Operario</option>
                                    <option value="Validador">Validador</option>
                                    <option value="Administrador">Administrador</option>
                                </select>
                            </div>
                            {editUserRole === "Operario" && (
                                <div>
                                    <label className="block text-sm font-semibold mb-1 text-slate-900">Tienda asignada</label>
                                    <select className="w-full border rounded-2xl p-3 text-slate-900 bg-white" value={editUserStoreId} onChange={e => setEditUserStoreId(e.target.value)}>
                                        <option value="">— Sin asignar —</option>
                                        {allStores.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                    </select>
                                </div>
                            )}
                            <div>
                                <label className="block text-sm font-semibold mb-1 text-slate-900">Nueva contraseña <span className="text-slate-400 font-normal">(dejar vacío para no cambiar)</span></label>
                                <input className="w-full border rounded-2xl p-3 text-slate-900 bg-white" placeholder="Nueva contraseña..." value={editUserPassword} onChange={e => setEditUserPassword(e.target.value)} />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold mb-1 text-slate-900">WhatsApp <span className="text-slate-400 font-normal">(con código de país, ej: 51987654321)</span></label>
                                <input className="w-full border rounded-2xl p-3 text-slate-900 bg-white" placeholder="51987654321" value={editUserWhatsapp} onChange={e => setEditUserWhatsapp(e.target.value)} />
                            </div>
                            <label className="flex items-center gap-3 rounded-2xl border bg-white p-3 text-sm font-semibold text-slate-700">
                                <input type="checkbox" checked={editUserRole === "Administrador" || editUserAuditAccess} disabled={editUserRole === "Administrador"} onChange={e => setEditUserAuditAccess(e.target.checked)} />
                                Puede acceder a auditorías
                            </label>
                            <div>
                                <label className="block text-sm font-semibold mb-1 text-slate-900">Estado</label>
                                <div className="flex gap-3">
                                    <button className={`flex-1 py-2.5 rounded-xl font-semibold text-sm border ${editUserActive ? "bg-green-600 text-white border-green-600" : "bg-white text-slate-700 border-slate-300"}`} onClick={() => setEditUserActive(true)}>✓ Activo</button>
                                    <button className={`flex-1 py-2.5 rounded-xl font-semibold text-sm border ${!editUserActive ? "bg-red-500 text-white border-red-500" : "bg-white text-slate-700 border-slate-300"}`} onClick={() => setEditUserActive(false)}>Inactivo</button>
                                </div>
                            </div>
                        </div>
                        <div className="flex gap-3 pt-1">
                            <button className="flex-1 py-3 rounded-2xl bg-slate-900 text-white font-semibold" onClick={saveEditUser}>Guardar cambios</button>
                            <button className="px-5 py-3 rounded-2xl border font-semibold text-slate-700" onClick={() => setEditingUser(null)}>Cancelar</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ════════════════════════════════════════════════════════
                MODAL — CONFIRMAR RECONTEO (Operario)
            ════════════════════════════════════════════════════════ */}
            {showRecountConfirmModal && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center overflow-y-auto p-3 sm:p-4 z-50">
                    <div className="app-modal-panel bg-white rounded-3xl p-5 w-full max-w-sm space-y-5 shadow-2xl sm:p-6">
                        <div className="text-center space-y-2">
                            <div className="text-5xl">🔄</div>
                            <h3 className="text-xl font-bold text-slate-900">¿Iniciar reconteo?</h3>
                            <p className="text-slate-600 text-sm leading-relaxed">
                                Tienes <span className="font-bold text-orange-700">{difAssignments.length} código{difAssignments.length !== 1 ? "s" : ""} para recontar</span>
                                {pendingAssignments.length > 0 && (
                                    <>, incluyendo <span className="font-bold text-amber-700">{pendingAssignments.length} sin contar</span></>
                                )}.
                            </p>
                        </div>
                        {pendingAssignments.length > 0 && (
                            <div className="rounded-2xl bg-amber-50 border border-amber-200 p-3 max-h-36 overflow-auto">
                                <p className="text-xs font-bold text-amber-800 mb-2">Códigos no contados incluidos:</p>
                                <div className="flex flex-wrap gap-1.5">
                                    {pendingAssignments.map(a => (
                                        <span key={a.id} className="text-xs bg-amber-100 text-amber-900 rounded-xl px-2 py-0.5 font-semibold border border-amber-200">{a.sku}</span>
                                    ))}
                                </div>
                            </div>
                        )}
                        <div className="flex gap-3">
                            <button className="flex-1 py-3 rounded-2xl bg-slate-900 text-white font-bold text-sm" onClick={() => setShowRecountConfirmModal(false)}>
                                Cancelar
                            </button>
                            <button className="flex-1 py-3 rounded-2xl bg-orange-500 text-white font-bold text-sm" onClick={() => { setShowRecountConfirmModal(false); openRecountPanel(); }}>
                                Sí, recontar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ════════════════════════════════════════════════════════
                MODAL — TERMINAR CONTEO (Operario)
            ════════════════════════════════════════════════════════ */}
            {showFinishModal && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center overflow-y-auto p-3 sm:p-4 z-50">
                    <div className="app-modal-panel bg-white rounded-3xl p-5 w-full max-w-sm space-y-5 shadow-2xl sm:p-6">
                        <div className="text-center space-y-2">
                            <div className="text-5xl">⚠️</div>
                            <h3 className="text-xl font-bold text-slate-900">¿Terminar conteo?</h3>
                            <p className="text-slate-600 text-sm leading-relaxed">
                                Aún tienes <span className="font-bold text-amber-700">{pendingAssignments.length} código{pendingAssignments.length !== 1 ? "s" : ""} sin contar</span>.
                                ¿Deseas terminar de todas formas?
                            </p>
                        </div>
                        <div className="rounded-2xl bg-amber-50 border border-amber-200 p-3 max-h-40 overflow-auto">
                            <p className="text-xs font-bold text-amber-800 mb-2">Códigos pendientes:</p>
                            <div className="flex flex-wrap gap-1.5">
                                {pendingAssignments.map(a => (
                                    <span key={a.id} className="text-xs bg-amber-100 text-amber-900 rounded-xl px-2 py-0.5 font-semibold border border-amber-200">{a.sku}</span>
                                ))}
                            </div>
                        </div>
                        <div className="flex gap-3">
                            <button className="flex-1 py-3 rounded-2xl bg-slate-900 text-white font-bold text-sm" onClick={() => setShowFinishModal(false)}>
                                Volver a contar
                            </button>
                            <button className="flex-1 py-3 rounded-2xl bg-red-500 text-white font-bold text-sm" onClick={confirmFinishSession}>
                                Sí, terminar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ════════════════════════════════════════════════════════
                MODAL — WHATSAPP MASIVO POST-CARGA
            ════════════════════════════════════════════════════════ */}
            {showBulkWspModal && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center overflow-y-auto p-3 sm:p-4 z-50">
                    <div className="app-modal-panel bg-white rounded-3xl p-5 w-full max-w-lg shadow-2xl space-y-4 sm:p-6">

                        {/* ── FASE 1: Selección ── */}
                        {bulkWspSendingIdx < 0 ? (<>
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <h3 className="text-xl font-bold text-slate-900">📲 WhatsApp masivo</h3>
                                    <p className="text-slate-500 text-sm mt-1">Fecha: <b>{bulkWspDate}</b> · Selecciona las tiendas a notificar.</p>
                                </div>
                                <button className="text-slate-400 hover:text-slate-600 text-2xl leading-none" onClick={() => { setShowBulkWspModal(false); setBulkWspSendingIdx(-1); }}>×</button>
                            </div>

                            <div className="flex gap-2">
                                <button className="text-xs px-3 py-1.5 rounded-xl bg-slate-100 font-semibold text-slate-700 border"
                                    onClick={() => setBulkWspSelected(new Set(bulkWspStores.filter(s => s.operario?.whatsapp).map(s => s.id)))}>
                                    Seleccionar todas
                                </button>
                                <button className="text-xs px-3 py-1.5 rounded-xl bg-slate-100 font-semibold text-slate-700 border"
                                    onClick={() => setBulkWspSelected(new Set())}>
                                    Quitar todas
                                </button>
                                <span className="ml-auto text-xs text-slate-400 self-center">{bulkWspSelected.size} seleccionadas</span>
                            </div>

                            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                                {bulkWspStores.map(store => {
                                    const hasOp = !!store.operario?.whatsapp;
                                    const selected = bulkWspSelected.has(store.id);
                                    return (
                                        <div key={store.id}
                                            className={`flex items-center gap-3 rounded-2xl border p-3 transition ${!hasOp ? "opacity-35 cursor-not-allowed bg-slate-50" : selected ? "bg-green-50 border-green-300 cursor-pointer" : "bg-white border-slate-200 cursor-pointer hover:bg-slate-50"}`}
                                            onClick={() => {
                                                if (!hasOp) return;
                                                setBulkWspSelected(prev => { const n = new Set(prev); n.has(store.id) ? n.delete(store.id) : n.add(store.id); return n; });
                                            }}
                                        >
                                            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${selected && hasOp ? "bg-green-600 border-green-600" : "border-slate-300"}`}>
                                                {selected && hasOp && <span className="text-white text-xs font-bold">✓</span>}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="font-semibold text-sm text-slate-900 truncate">{store.name}</div>
                                                <div className="text-xs text-slate-500">
                                                    {store.count} código{store.count !== 1 ? "s" : ""}
                                                    {store.operario
                                                        ? <> · <span className="text-green-700">{store.operario.full_name} · {store.operario.whatsapp}</span></>
                                                        : <span className="text-red-400"> · Sin WhatsApp registrado</span>
                                                    }
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Preview del mensaje */}
                            {bulkWspQueue.length > 0 && (
                                <div className="rounded-2xl bg-slate-50 border p-3 space-y-1">
                                    <p className="text-xs font-semibold text-slate-600">Vista previa del mensaje:</p>
                                    <pre className="text-xs text-slate-700 whitespace-pre-wrap font-sans leading-relaxed">{buildWspMessage(bulkWspQueue[0])}</pre>
                                </div>
                            )}

                            <div className="flex gap-3 pt-1">
                                <button
                                    className="flex-1 py-3 rounded-2xl bg-green-600 text-white font-bold text-sm disabled:opacity-40"
                                    disabled={bulkWspQueue.length === 0}
                                    onClick={startBulkSend}
                                >
                                    📲 Iniciar envío a {bulkWspQueue.length} tienda{bulkWspQueue.length !== 1 ? "s" : ""}
                                </button>
                                <button className="px-5 py-3 rounded-2xl border font-semibold text-slate-700 text-sm" onClick={() => { setShowBulkWspModal(false); setBulkWspSendingIdx(-1); }}>
                                    Omitir
                                </button>
                            </div>
                        </>) : (
                        /* ── FASE 2: Envío paso a paso ── */
                        <>
                            <div className="text-center space-y-1">
                                <div className="text-4xl">📲</div>
                                <h3 className="text-xl font-bold text-slate-900">Enviando mensajes</h3>
                                <p className="text-slate-500 text-sm">{bulkWspSendingIdx + 1} de {bulkWspQueue.length} tiendas</p>
                            </div>

                            {/* Barra de progreso */}
                            <div className="space-y-1">
                                <div className="h-3 bg-slate-200 rounded-full overflow-hidden">
                                    <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${((bulkWspSendingIdx + 1) / bulkWspQueue.length) * 100}%` }} />
                                </div>
                                <div className="flex justify-between text-xs text-slate-400">
                                    <span>{bulkWspSendingIdx + 1} enviados</span>
                                    <span>{bulkWspQueue.length - bulkWspSendingIdx - 1} restantes</span>
                                </div>
                            </div>

                            {/* Tienda actual */}
                            {(() => {
                                const cur = bulkWspQueue[bulkWspSendingIdx];
                                return (
                                    <div className="rounded-2xl bg-green-50 border border-green-200 p-4 space-y-2">
                                        <div className="font-bold text-slate-900 text-base">{cur.name}</div>
                                        <div className="text-xs text-slate-500">{cur.operario?.full_name} · {cur.operario?.whatsapp}</div>
                                        <pre className="text-xs text-slate-700 whitespace-pre-wrap font-sans leading-relaxed bg-white rounded-xl p-3 border">{buildWspMessage(cur)}</pre>
                                        <p className="text-xs text-amber-700 font-semibold">⬆️ Se abrió WhatsApp con este mensaje. Presiona <b>Siguiente</b> cuando lo hayas enviado.</p>
                                    </div>
                                );
                            })()}

                            {/* Lista de pendientes */}
                            {bulkWspQueue.length > bulkWspSendingIdx + 1 && (
                                <div className="text-xs text-slate-500 space-y-1">
                                    <p className="font-semibold text-slate-600">Siguiente en la cola:</p>
                                    {bulkWspQueue.slice(bulkWspSendingIdx + 1, bulkWspSendingIdx + 4).map((s, i) => (
                                        <div key={s.id} className="flex items-center gap-2">
                                            <span className="text-slate-300">#{bulkWspSendingIdx + 2 + i}</span>
                                            <span>{s.name}</span>
                                            <span className="text-slate-400">· {s.operario?.whatsapp}</span>
                                        </div>
                                    ))}
                                    {bulkWspQueue.length > bulkWspSendingIdx + 4 && <p className="text-slate-400">... y {bulkWspQueue.length - bulkWspSendingIdx - 4} más</p>}
                                </div>
                            )}

                            <div className="flex gap-3 pt-1">
                                <button
                                    className="flex-1 py-4 rounded-2xl bg-green-600 text-white font-bold text-base"
                                    onClick={nextBulkSend}
                                >
                                    {bulkWspSendingIdx + 1 >= bulkWspQueue.length ? "✅ Finalizar" : `Siguiente → ${bulkWspQueue[bulkWspSendingIdx + 1]?.name}`}
                                </button>
                            </div>
                            <button className="w-full text-xs text-slate-400 underline" onClick={() => { setShowBulkWspModal(false); setBulkWspSendingIdx(-1); }}>
                                Cancelar envío
                            </button>
                        </>)}
                    </div>
                </div>
            )}

            {/* ════════════════════════════════════════════════════════
                OVERLAY — ESCÁNER DE CÁMARA
            ════════════════════════════════════════════════════════ */}
            {scannerTarget && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center overflow-y-auto p-3 sm:p-4 z-[60]">
                    <div className="app-modal-panel bg-white w-full max-w-lg rounded-3xl p-4 shadow-2xl space-y-4 sm:p-5">
                        <div>
                            <h3 className="text-xl font-bold text-slate-900">
                                {scannerTarget === "product" ? "Escanear producto" : `Escanear ubicación ${(locationRows.length > 1 || recountRows.length > 1) ? scanningRowIndex + 1 : ""}`}
                            </h3>
                            <p className="text-sm text-slate-500">
                                {scannerTarget === "product" ? "Escanea el codigo del producto." : "Escanea o escribe la ubicación."}
                            </p>
                        </div>
                        <div className="rounded-2xl overflow-hidden border bg-black min-h-[260px] flex items-center justify-center">
                            <div id={scannerContainerId} className="w-full" />
                        </div>
                        <div className="text-sm text-slate-500">{scannerRunning ? "Cámara activa. Apunta al código." : "Iniciando cámara..."}</div>
                        {torchAvailable && (
                            <button onClick={toggleTorch} className="w-full px-4 py-3 rounded-2xl bg-slate-900 text-white font-semibold">
                                {torchOn ? "Apagar linterna 🔦" : "Prender linterna 🔦"}
                            </button>
                        )}
                        <button onClick={closeScanner} className="w-full px-4 py-3 rounded-2xl border font-semibold text-slate-700">Cerrar cámara</button>
                    </div>
                </div>
            )}

            {/* ════════════════════════════════════════════════════════
                MODAL — CORREO GERENCIAL (Preview + Acciones)
            ════════════════════════════════════════════════════════ */}
            {showEmailModal && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center overflow-y-auto p-3 sm:p-4 z-50">
                    <div className="app-modal-panel bg-white rounded-3xl w-full max-w-4xl flex flex-col shadow-2xl">

                        {/* Header del modal */}
                        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b bg-white flex-shrink-0">
                            <div>
                                <h3 className="text-lg font-bold text-slate-900">✉️ Correo — Conteo Cíclico</h3>
                                <p className="text-slate-500 text-xs mt-0.5">Ingresa los destinatarios y envía directo a Gmail.</p>
                            </div>
                            <button className="text-slate-400 hover:text-slate-600 text-2xl leading-none flex-shrink-0" onClick={() => setShowEmailModal(false)}>×</button>
                        </div>

                        {/* Campo destinatarios + botones */}
                        <div className="flex flex-col gap-3 px-6 py-3 bg-slate-50 border-b flex-shrink-0">
                            <div className="flex flex-col gap-1">
                                <label className="text-xs font-semibold text-slate-600">Destinatarios (separados por coma)</label>
                                <input
                                    type="text"
                                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                                    placeholder="correo1@empresa.com, correo2@empresa.com"
                                    value={emailRecipients}
                                    onChange={e => setEmailRecipients(e.target.value)}
                                />
                            </div>
                            <div className="flex gap-3 flex-wrap items-center">
                                <button
                                    className="px-5 py-2.5 rounded-2xl bg-red-600 text-white font-semibold text-sm hover:bg-red-700 transition-colors"
                                    onClick={() => {
                                        // 1. Abrir el informe HTML en ventana nueva (para copiar contenido)
                                        const reportWin = window.open("", "_blank");
                                        if (reportWin) {
                                            reportWin.document.write(emailHTML);
                                            reportWin.document.close();
                                        }
                                        // 2. Abrir Gmail con asunto y destinatarios listos
                                        const to = emailRecipients.trim();
                                        const subject = encodeURIComponent(`Informe Conteo Cíclico — ${dashPeriod === "dia" ? dashDate : dashPeriod === "mes" ? dashMonth : `${dashRangeFrom} al ${dashRangeTo}`}`);
                                        const gmail = `https://mail.google.com/mail/?view=cm&fs=1${to ? `&to=${encodeURIComponent(to)}` : ""}&su=${subject}`;
                                        setTimeout(() => window.open(gmail, "_blank"), 400);
                                        showMessage("📋 Se abrieron 2 pestañas: el informe y Gmail. Selecciona todo el informe (Ctrl+A), cópialo (Ctrl+C) y pégalo en el cuerpo del correo (Ctrl+V).", "info");
                                    }}
                                >
                                    📧 Enviar por Gmail
                                </button>
                                <button
                                    className="px-5 py-2.5 rounded-2xl bg-indigo-700 text-white font-semibold text-sm hover:bg-indigo-800 transition-colors"
                                    onClick={() => {
                                        const blob = new Blob([emailHTML], { type: "text/html;charset=utf-8" });
                                        const url  = URL.createObjectURL(blob);
                                        const a    = document.createElement("a");
                                        a.href     = url;
                                        a.download = `informe_ciclicos_${dashPeriod === "dia" ? dashDate : dashPeriod === "mes" ? dashMonth : `${dashRangeFrom}_${dashRangeTo}`}.html`;
                                        a.click();
                                        URL.revokeObjectURL(url);
                                    }}
                                >
                                    ↓ Descargar HTML
                                </button>
                                <button
                                    className="px-5 py-2.5 rounded-2xl border border-slate-300 text-slate-700 font-semibold text-sm hover:bg-slate-100 transition-colors"
                                    onClick={() => {
                                        const w = window.open("", "_blank");
                                        if (w) { w.document.write(emailHTML); w.document.close(); w.print(); }
                                    }}
                                >
                                    🖨️ Imprimir / PDF
                                </button>
                            </div>
                        </div>

                        {/* Vista previa */}
                        <div className="flex-1 overflow-auto bg-slate-100 p-4">
                            <iframe
                                srcDoc={emailHTML}
                                className="w-full bg-white rounded-2xl shadow"
                                style={{ minHeight: "700px", border: "none" }}
                                title="Vista previa correo"
                            />
                        </div>
                    </div>
                </div>
            )}

            {manualProductCandidates.length > 1 && (
                <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-3 sm:p-4">
                    <div className="app-modal-panel w-full max-w-3xl rounded-2xl bg-white shadow-2xl">
                        <div className="flex items-center justify-between border-b px-4 py-3">
                            <div>
                                <h3 className="font-black">Elige el codigo</h3>
                                <p className="text-xs text-slate-500">El codigo visible {visibleProductCode(manualProductCodePending)} coincide con mas de un codsap.</p>
                            </div>
                            <button onClick={() => setManualProductCandidates([])} className="rounded-lg border px-3 py-1 text-sm font-bold">Cerrar</button>
                        </div>
                        <div className="grid max-h-[70vh] gap-3 overflow-auto p-4 md:grid-cols-2">
                            {manualProductCandidates.map(product => (
                                <button
                                    key={product.id}
                                    onClick={async () => {
                                        setManualProductCandidates([]);
                                        await openScannedProduct(product);
                                        setManualProductCode("");
                                    }}
                                    className="rounded-xl border p-4 text-left hover:border-blue-600 hover:bg-blue-50"
                                >
                                    <div className="text-sm font-black text-slate-900">{fullProductCode(product.sku)}</div>
                                    <div className="text-xs font-bold text-slate-500">Visible: {visibleProductCode(product.sku)}</div>
                                    <div className="mt-1 line-clamp-2 text-sm text-slate-600">{product.description}</div>
                                    <div className="mt-3 grid grid-cols-3 gap-2 text-xs font-bold text-slate-500">
                                        <span>UM: {product.unit || "N/D"}</span>
                                        <span>Costo: {formatMoney(product.cost)}</span>
                                        <span>Stock: {Number(product.system_stock || 0)}</span>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            </div>{/* end main flex column */}
        </main>
    );
}
