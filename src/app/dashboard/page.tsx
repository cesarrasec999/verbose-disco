"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import * as XLSX from "xlsx";
import { QrCode } from "lucide-react";

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
    is_active: boolean;
    whatsapp?: string | null;
};

type Store = {
    id: string;
    code: string;
    name: string;
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

function formatDateTime(v: string) {
    if (!v) return "-";
    const d = new Date(v);
    if (isNaN(d.getTime())) return v;
    return d.toLocaleString("es-PE");
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
    if (diff > 0)   return <span className="text-blue-700 font-semibold">+{diff}</span>;
    return <span className="text-red-600 font-semibold">{diff}</span>;
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
    const [locationRows, setLocationRows]         = useState<LocationRow[]>([{ location: "", qty: "" }]);

    // ─── Operario: reconteo ──────────────────────────────────
    const [showRecount, setShowRecount]           = useState(false);
    const [recountAssignment, setRecountAssignment] = useState<Assignment | null>(null);
    const [recountRows, setRecountRows]           = useState<LocationRow[]>([{ location: "", qty: "" }]);

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
    const [valTab, setValTab]               = useState<"asignar"|"registros"|"resumen">("asignar");
    const [valStoreId, setValStoreId]       = useState("");
    const [valDate, setValDate]             = useState(todayISO());
    const [valSearchText, setValSearchText] = useState("");
    const [valStatusFilter, setValStatusFilter] = useState("todos");
    const [resumenSearch, setResumenSearch] = useState("");

    // ─── Validador: asignación ───────────────────────────────
    const [assignSearch, setAssignSearch]     = useState("");
    const [assignResults, setAssignResults]   = useState<Product[]>([]);
    const [assignStockMap, setAssignStockMap] = useState<Record<string,string>>({});
    const [bulkAssignFile, setBulkAssignFile] = useState<File|null>(null);
    const [bulkAssignFileName, setBulkAssignFileName] = useState("");
    const [bulkAssignProgress, setBulkAssignProgress] = useState<{step:string;pct:number}|null>(null);
    const bulkAssignRef = useRef<HTMLInputElement|null>(null);

    // ─── Validador: editar conteo ────────────────────────────
    const [editingCount, setEditingCount]   = useState<CountRecord|null>(null);
    const [editQty, setEditQty]             = useState("");
    const [editLocation, setEditLocation]   = useState("");
    const [editStatus, setEditStatus]       = useState<CountRecord["status"]>("Pendiente");
    const [editNote, setEditNote]           = useState("");

    // ─── Admin: maestro productos ────────────────────────────
    const [adminTab, setAdminTab]             = useState<"productos"|"tiendas"|"usuarios"|"dashboard">("productos");
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
    const [editingUser, setEditingUser]       = useState<CyclicUser|null>(null);
    const [editUserRole, setEditUserRole]     = useState<Role>("Operario");
    const [editUserWhatsapp, setEditUserWhatsapp] = useState("");

    // ─── WhatsApp masivo post-carga ──────────────────────────
    const [showBulkWspModal, setShowBulkWspModal] = useState(false);
    const [bulkWspStores, setBulkWspStores] = useState<{ id: string; name: string; count: number; operario: { full_name: string; whatsapp: string } | null }[]>([]);
    const [bulkWspSelected, setBulkWspSelected] = useState<Set<string>>(new Set());
    const [bulkWspDate, setBulkWspDate] = useState("");

    // ─── Terminar sesión de conteo ───────────────────────────
    const [showFinishModal, setShowFinishModal] = useState(false);
    const [showRecountConfirmModal, setShowRecountConfirmModal] = useState(false);
    const [sessionFinished, setSessionFinished] = useState(false);
    const [recountFinished, setRecountFinished] = useState(false);
    const [editUserStoreId, setEditUserStoreId] = useState("");
    const [editUserAllStores, setEditUserAllStores] = useState(false);
    const [editUserActive, setEditUserActive] = useState(true);
    const [editUserPassword, setEditUserPassword] = useState("");

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

                const savedValTab = sessionStorage.getItem("cyclic_val_tab") as "asignar"|"registros"|"resumen" | null;
                if (savedValTab) setValTab(savedValTab);

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
        if (user) { loadStores(); loadProducts(); if (user.role !== "Operario") loadAllUsers(); }
    }, [user]);

    useEffect(() => {
        if (!user) return;
        if (user.role === "Operario") {
            const sid = user.store_id || "";
            setSelectedStoreId(sid);
            if (sid) loadOperarioData(sid, selectedDate);
        } else if (user.role === "Administrador") {
            // Restaurar estado del operario para el admin si hay tienda guardada
            const savedStoreId = sessionStorage.getItem("cyclic_selected_store");
            const savedDate    = sessionStorage.getItem("cyclic_selected_date");
            if (savedStoreId) {
                setSelectedStoreId(savedStoreId);
                loadOperarioData(savedStoreId, savedDate || selectedDate);
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
    }, [valTab]);

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
                    { fps: 8, qrbox: { width: 220, height: 120 }, aspectRatio: 1.6 },
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
        const t = setTimeout(() => startScanner(), 150);
        return () => { cancelled = true; clearTimeout(t); stopScanner(); };
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

    function handleLogout() {
        localStorage.removeItem("cyclic_user");
        sessionStorage.removeItem("cyclic_active_tab");
        sessionStorage.removeItem("cyclic_val_tab");
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
    async function setSessionFlag(storeId: string, date: string, flag: "__session_finished__" | "__recount_started__" | "__recount_done__", active: boolean) {
        // Usamos el primer assignment de la tienda+fecha como anchor del flag
        const { data: asgns } = await supabase.from("cyclic_assignments").select("id").eq("store_id", storeId).eq("assigned_date", date).limit(1);
        if (!asgns || asgns.length === 0) return;
        const anchorId = asgns[0].id;
        if (active) {
            // Upsert: insertar solo si no existe ya
            const { data: existing } = await supabase.from("cyclic_counts").select("id").eq("assignment_id", anchorId).eq("location", flag).maybeSingle();
            if (!existing) {
                await supabase.from("cyclic_counts").insert({
                    assignment_id: anchorId,
                    store_id: storeId,
                    product_id: asgns[0].id, // dummy, no importa
                    counted_quantity: 0,
                    location: flag,
                    status: "Pendiente",
                    counted_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                });
            }
        } else {
            await supabase.from("cyclic_counts").delete().eq("assignment_id", anchorId).eq("location", flag);
        }
    }

    async function clearSessionFlags(storeId: string, date: string) {
        const { data: asgns } = await supabase.from("cyclic_assignments").select("id").eq("store_id", storeId).eq("assigned_date", date).limit(1);
        if (!asgns || asgns.length === 0) return;
        const anchorId = asgns[0].id;
        await supabase.from("cyclic_counts").delete().eq("assignment_id", anchorId).like("location", "__session_%");
    }

    async function confirmFinishSession() {
        setShowFinishModal(false);
        setSessionFinished(true);
        setRecountFinished(false);
        // Limpiar flags anteriores y escribir __session_finished__ en BD
        await clearSessionFlags(selectedStoreId, selectedDate);
        await setSessionFlag(selectedStoreId, selectedDate, "__session_finished__", true);
        showMessage(`✅ Conteo terminado. ${doneAssignments.length} producto${doneAssignments.length !== 1 ? "s" : ""} contado${doneAssignments.length !== 1 ? "s" : ""}. ¡Buen trabajo!`, "success");
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
            if (active.length > 0) setValStoreId(active[0].id);
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
        const sessionFlags = cRows.filter(c => c.location?.startsWith("__session_"));
        const isFinished    = sessionFlags.some(c => c.location === "__session_finished__");
        const isRecounting  = sessionFlags.some(c => c.location === "__recount_started__");
        const isRecountDone = sessionFlags.some(c => c.location === "__recount_done__");

        // Conteos reales (excluir filas de flags)
        const realCounts = cRows.filter(c => !c.location?.startsWith("__session_"));
        const enriched = realCounts.map(c => {
            const asg = rows.find(a => a.id === c.assignment_id);
            const diff = Number(c.counted_quantity) - Number(asg?.system_stock || 0);
            return { ...c, sku: asg?.sku, description: asg?.description, unit: asg?.unit, cost: asg?.cost, system_stock: asg?.system_stock, difference: diff };
        });
        setCounts(enriched);

        // Restaurar estado UI desde flags de BD
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
        const realCounts = cRows.filter(c => !c.location?.startsWith("__session_"));
        const enriched = realCounts.map(c => {
            const asg = rows.find(a => a.id === c.assignment_id);
            const diff = Number(c.counted_quantity) - Number(asg?.system_stock || 0);
            return { ...c, sku: asg?.sku, description: asg?.description, unit: asg?.unit, cost: asg?.cost, system_stock: asg?.system_stock, difference: diff, store_name: asg?.store_name };
        });
        setCounts(enriched);
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

            // ── Paso 3: traer counts por store_id + rango de fechas ─────────
            // Usamos store_id y rango de assigned_date para evitar el límite de Supabase con .in() de miles de IDs
            const asgnIds = asgnData.map((a: any) => a.id);
            const asgnIdSet = new Set<string>(asgnIds);
            const cntStoreIds = uniqueStoreIds; // ya calculado arriba
            let cntAll: CountRecord[] = [];
            const CNT_STORE_CHUNK = 50;
            const CNT_PAGE_SIZE = 1000;
            for (let i = 0; i < cntStoreIds.length; i += CNT_STORE_CHUNK) {
                const storeChunk = cntStoreIds.slice(i, i + CNT_STORE_CHUNK);
                let cntPage = 0;
                while (true) {
                    const { data: cChunk } = await supabase
                        .from("cyclic_counts")
                        .select("*")
                        .in("store_id", storeChunk)
                        .gte("counted_at", dateFilter.from + "T00:00:00.000Z")
                        .lte("counted_at", (() => { const d = new Date(dateFilter.to + "T23:59:59.999Z"); d.setDate(d.getDate() + 1); return d.toISOString(); })())
                        .range(cntPage * CNT_PAGE_SIZE, (cntPage + 1) * CNT_PAGE_SIZE - 1);
                    if (!cChunk || cChunk.length === 0) break;
                    cntAll = cntAll.concat(cChunk as CountRecord[]);
                    if (cChunk.length < CNT_PAGE_SIZE) break;
                    cntPage++;
                }
            }
            // Filtrar flags de sesión y solo los que pertenecen a assignments del período
            const counts = cntAll.filter((c: any) => !c.location?.startsWith("__session_") && asgnIdSet.has(c.assignment_id));

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
                const prodMap = new Map<string, { system_stock: number; total_counted: number }>();
                for (const a of g.asgns) {
                    if (!prodMap.has(a.product_id)) prodMap.set(a.product_id, { system_stock: a.system_stock, total_counted: 0 });
                }
                for (const c of g.cnts) {
                    const asgn = asgnById.get(c.assignment_id);
                    if (!asgn) continue;
                    const entry = prodMap.get(asgn.product_id);
                    if (entry) entry.total_counted += Number(c.counted_quantity);
                }
                const countedPids = new Set(g.cnts.map(c => {
                    const a = asgnById.get(c.assignment_id);
                    return a?.product_id;
                }));
                let ok = 0, sobrantes = 0, faltantes = 0, noContados = 0;
                for (const [pid, entry] of prodMap) {
                    if (!countedPids.has(pid)) { noContados++; faltantes++; continue; }
                    const diff = entry.total_counted - entry.system_stock;
                    if (diff === 0) ok++;
                    else if (diff > 0) sobrantes++;
                    else faltantes++;
                }
                const total = prodMap.size;
                const eri = total > 0 ? Math.round((ok / total) * 100) : 0;
                // Dif. valorizada: usar costo del assignment o del producto maestro
                let difValDay = 0;
                for (const [pid, entry] of prodMap) {
                    if (countedPids.has(pid)) {
                        const asgForPid = g.asgns.find((a: any) => a.product_id === pid);
                        const costo = parseCost(asgForPid?.cyclic_products?.cost);
                        const diff = entry.total_counted - entry.system_stock;
                        difValDay += diff * costo;
                    }
                }

                // Duración: desde el primer hasta el último código registrado (solo counted_at)
                const timestamps = g.cnts.map(c => new Date(c.counted_at).getTime()).filter(t => !isNaN(t));
                const horaInicio = timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : null;
                const horaFin = timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null;
                const duracion = horaInicio && horaFin ? Math.round((new Date(horaFin).getTime() - new Date(horaInicio).getTime()) / 60000) : null;
                const cumplio = g.cnts.some(c => c.status === "Corregido") || noContados === 0;
                dayMetrics.push({ store_id: g.store_id, store_name: g.store_name, date: g.date, ok, sobrantes, faltantes, noContados, total, eri, cumplio, horaInicio, horaFin, duracion, difVal: difValDay });
            }

            const rows: DashboardRow[] = [];

            if (dashPeriod === "dia" || dashPeriod === "rango") {
                // Vista día/rango: una fila por tienda+día
                for (const d of dayMetrics) {
                    // ERI exacto: códigos OK / total asignados (solo si cumplió; si no cumplió eri = 0)
                    const eriExacto = d.cumplio && d.total > 0 ? Math.round((d.ok / d.total) * 100) : 0;
                    rows.push({
                        store_id: d.store_id,
                        store_name: d.store_name,
                        date: d.date,
                        total_asignados: d.total,
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
                // Vista mes: agrupar días por tienda+mes
                const mesGroups = new Map<string, DayMetrics[]>();
                for (const d of dayMetrics) {
                    const k = `${d.store_id}__${d.date.slice(0,7)}`;
                    if (!mesGroups.has(k)) mesGroups.set(k, []);
                    mesGroups.get(k)!.push(d);
                }
                for (const [, days] of mesGroups) {
                    const first = days[0];
                    const diasTotales = days.length;
                    const diasCumplidos = days.filter(d => d.cumplio).length;
                    const cumplimientoPct = diasTotales > 0 ? Math.round((diasCumplidos / diasTotales) * 100) : 0;
                    const totalAsignados = days.reduce((s, d) => s + d.total, 0);
                    const totalOk = days.reduce((s, d) => s + d.ok, 0);
                    const totalSobrantes = days.reduce((s, d) => s + d.sobrantes, 0);
                    const totalFaltantes = days.reduce((s, d) => s + d.faltantes, 0);
                    const totalNoContados = days.reduce((s, d) => s + d.noContados, 0);
                    // ERI exacto: suma de códigos OK de días que cumplieron / suma de asignados de esos días
                    // Excluye días donde la tienda no cumplió (no contó todo)
                    const daysCumplieron = days.filter(d => d.cumplio);
                    const okCumplieron = daysCumplieron.reduce((s, d) => s + d.ok, 0);
                    const totalCumplieron = daysCumplieron.reduce((s, d) => s + d.total, 0);
                    const eriMes = totalCumplieron > 0 ? Math.round((okCumplieron / totalCumplieron) * 100) : 0;
                    const avgDur = days.filter(d => d.duracion !== null).length > 0
                        ? Math.round(days.filter(d => d.duracion !== null).reduce((s, d) => s + (d.duracion || 0), 0) / days.filter(d => d.duracion !== null).length)
                        : null;
                    rows.push({
                        store_id: first.store_id,
                        store_name: first.store_name,
                        date: first.date.slice(0, 7),
                        total_asignados: totalAsignados,
                        total_ok: totalOk,
                        total_sobrantes: totalSobrantes,
                        total_faltantes: totalFaltantes,
                        total_no_contados: totalNoContados,
                        dif_valorizada: days.reduce((s, d) => s + d.difVal, 0),
                        eri: eriMes,
                        cumplio: diasCumplidos === diasTotales,
                        cumplimiento_pct: cumplimientoPct,
                        dias_cumplidos: diasCumplidos,
                        dias_totales: diasTotales,
                        hora_inicio: null,
                        hora_fin: null,
                        duracion_min: avgDur,
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
    function openCount(asgn: Assignment) {
        const existing = counts.filter(c => c.assignment_id === asgn.id);
        if (existing.length > 0) {
            setLocationRows(existing.map(c => ({ location: c.location, qty: String(c.counted_quantity) })));
        } else {
            setLocationRows([{ location: "", qty: "" }]);
        }
        setActiveAssignment(asgn);
        clearMessage();
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
        if (!activeAssignment || !user) return;
        for (let i = 0; i < locationRows.length; i++) {
            const row = locationRows[i];
            if (!row.location.trim()) { showMessage(`Fila ${i + 1}: ingresa la ubicación.`, "error"); return; }
            if (row.qty === "") { showMessage(`Fila ${i + 1}: ingresa la cantidad.`, "error"); return; }
            const qty = Number(row.qty);
            if (isNaN(qty) || qty < 0) { showMessage(`Fila ${i + 1}: cantidad inválida.`, "error"); return; }
        }

        await supabase.from("cyclic_counts").delete().eq("assignment_id", activeAssignment.id);

        for (const row of locationRows) {
            const qty = Number(row.qty);
            const diff = qty - Number(activeAssignment.system_stock || 0);
            const status: CountRecord["status"] = diff === 0 ? "Pendiente" : "Diferencia";
            const { error } = await supabase.from("cyclic_counts").insert({
                assignment_id: activeAssignment.id,
                store_id: activeAssignment.store_id,
                product_id: activeAssignment.product_id,
                counted_quantity: qty,
                location: row.location.trim(),
                user_id: user.id,
                user_name: user.full_name,
                status,
                counted_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            });
            if (error) { showMessage("Error al guardar: " + error.message, "error"); return; }
        }

        showMessage(`✅ ${locationRows.length === 1 ? "Conteo guardado" : `${locationRows.length} ubicaciones guardadas`}.`, "success");
        setActiveAssignment(null);
        loadOperarioData(selectedStoreId, selectedDate);
    }

    // ════════════════════════════════════════════════════════
    //  OPERARIO — RECONTEO
    // ════════════════════════════════════════════════════════
    async function openRecountPanel() {
        setShowRecount(true);
        setRecountFinished(false);
        setRecountAssignment(null);
        setRecountRows([{ location: "", qty: "" }]);
        // Escribir flag __recount_started__ en BD
        await setSessionFlag(selectedStoreId, selectedDate, "__recount_started__", true);
        await setSessionFlag(selectedStoreId, selectedDate, "__recount_done__", false);
        clearMessage();
    }

    function openRecountItem(asgn: Assignment) {
        const existing = counts.filter(c => c.assignment_id === asgn.id);
        if (existing.length > 0) {
            setRecountRows(existing.map(c => ({ location: c.location, qty: String(c.counted_quantity) })));
        } else {
            setRecountRows([{ location: "", qty: "" }]);
        }
        setRecountAssignment(asgn);
    }

    function addRecountRow() { setRecountRows(prev => [...prev, { location: "", qty: "" }]); }
    function removeRecountRow(i: number) { setRecountRows(prev => prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)); }
    function updateRecountRow(i: number, field: keyof LocationRow, value: string) {
        setRecountRows(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: value } : r));
    }

    async function saveRecount() {
        if (!recountAssignment || !user) return;
        for (let i = 0; i < recountRows.length; i++) {
            const row = recountRows[i];
            if (!row.location.trim()) { showMessage(`Fila ${i + 1}: ingresa la ubicación.`, "error"); return; }
            if (row.qty === "") { showMessage(`Fila ${i + 1}: ingresa la cantidad.`, "error"); return; }
            const qty = Number(row.qty);
            if (isNaN(qty) || qty < 0) { showMessage(`Fila ${i + 1}: cantidad inválida.`, "error"); return; }
        }

        await supabase.from("cyclic_counts").delete().eq("assignment_id", recountAssignment.id);

        for (const row of recountRows) {
            const qty = Number(row.qty);
            const diff = qty - Number(recountAssignment.system_stock || 0);
            const status: CountRecord["status"] = diff === 0 ? "Corregido" : "Diferencia";
            const { error } = await supabase.from("cyclic_counts").insert({
                assignment_id: recountAssignment.id,
                store_id: recountAssignment.store_id,
                product_id: recountAssignment.product_id,
                counted_quantity: qty,
                location: row.location.trim(),
                user_id: user.id,
                user_name: user.full_name,
                status,
                counted_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            });
            if (error) { showMessage("Error al guardar reconteo: " + error.message, "error"); return; }
        }

        showMessage(`✅ Reconteo guardado para ${recountAssignment.sku}.`, "success");
        setRecountAssignment(null);
        setRecountRows([{ location: "", qty: "" }]);
        loadOperarioData(selectedStoreId, selectedDate);
    }

    async function finalizeRecount() {
        // Marcar todos los conteos reales con diferencia como "Corregido"
        const difCounts = counts.filter(c => c.difference !== 0);
        if (difCounts.length > 0) {
            await supabase.from("cyclic_counts")
                .update({ status: "Corregido", updated_at: new Date().toISOString() })
                .in("id", difCounts.map(c => c.id));
        }
        // Actualizar flags en BD: reconteo terminado
        await setSessionFlag(selectedStoreId, selectedDate, "__recount_started__", false);
        await setSessionFlag(selectedStoreId, selectedDate, "__recount_done__", true);
        setShowRecount(false);
        setRecountFinished(true);
        setRecountAssignment(null);
        showMessage("✅ Reconteo finalizado y marcado como cumplido.", "success");
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
    async function searchProductsForAssign(text: string) {
        setAssignSearch(text);
        if (!text.trim()) { setAssignResults([]); return; }
        const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
        let q = supabase.from("cyclic_products").select("*").eq("is_active", true);
        for (const w of words) q = q.ilike("description", `%${w}%`);
        const { data: byDesc } = await q.limit(200);
        let q2 = supabase.from("cyclic_products").select("*").eq("is_active", true);
        for (const w of words) q2 = q2.ilike("sku", `%${w}%`);
        const { data: bySku } = await q2.limit(200);
        const q3 = supabase.from("cyclic_products").select("*").eq("is_active", true).eq("barcode", text.trim());
        const { data: byBarcode } = await q3.limit(5);
        const combined = [...(byBarcode || []), ...(byDesc || []), ...(bySku || [])];
        const seen = new Set<string>();
        const deduped = combined.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
        setAssignResults(deduped.slice(0, 30) as Product[]);
    }

    async function assignProduct(product: Product) {
        if (!valStoreId || !valDate) { showMessage("Selecciona tienda y fecha.", "error"); return; }
        const stock = Number(assignStockMap[product.id] ?? 0);
        const { data: existing } = await supabase.from("cyclic_assignments")
            .select("id").eq("store_id", valStoreId).eq("product_id", product.id).eq("assigned_date", valDate).maybeSingle();
        if (existing) { showMessage("Este producto ya está asignado para esa tienda y fecha.", "error"); return; }
        const { error } = await supabase.from("cyclic_assignments").insert({
            store_id: valStoreId, product_id: product.id, system_stock: stock,
            assigned_date: valDate, assigned_by: user?.id,
        });
        if (error) { showMessage("Error al asignar: " + error.message, "error"); return; }
        showMessage(`✅ "${product.sku}" asignado.`, "success");
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

            // Detectar si hay columna de tienda (col A con "tda", "tienda", etc.)
            const hasStoreCol = headerRow.some((h: any) => ["tienda", "store", "almacen", "local", "tda"].some(n => String(h || "").toLowerCase().includes(n)));
            let colTienda = -1;
            let colCodigo: number, colCosto: number, colStock: number;

            if (hasStoreCol) {
                colTienda = findCol(["tienda", "store", "almacen", "local", "tda"]);
                colCodigo = findCol(["codigo", "code", "sku", "cod"]) >= 0 ? findCol(["codigo", "code", "sku", "cod"]) : (colTienda >= 0 ? colTienda + 1 : 1);
                colCosto  = findCol(["cost", "costo", "precio", "price", "ult.cost", "ult cost"]) >= 0 ? findCol(["cost", "costo", "precio", "price", "ult.cost", "ult cost"]) : (colTienda >= 0 ? colTienda + 4 : 4);
                colStock  = findCol(["stock", "cantidad", "qty", "saldo"]) >= 0 ? findCol(["stock", "cantidad", "qty", "saldo"]) : (colTienda >= 0 ? colTienda + 5 : 5);
            } else {
                colCodigo = findCol(["codigo", "code", "sku", "cod"]) >= 0 ? findCol(["codigo", "code", "sku", "cod"]) : 0;
                colCosto  = findCol(["cost", "costo", "precio", "price", "ult.cost", "ult cost"]) >= 0 ? findCol(["cost", "costo", "precio", "price", "ult.cost", "ult cost"]) : 3;
                colStock  = findCol(["stock", "cantidad", "qty", "saldo"]) >= 0 ? findCol(["stock", "cantidad", "qty", "saldo"]) : 4;
            }

            const dataRows = allRows.slice(1).filter(r => r.some((v: any) => String(v || "").trim()));

            // ── PASO 1: Construir mapa de tiendas ────────────────────────
            const storeNameMap = new Map<string, string>(); // nombre normalizado → id
            for (const s of allStores) storeNameMap.set(s.name.trim().toLowerCase(), s.id);

            // ── PASO 2: Extraer SKUs únicos del archivo ───────────────────
            setBulkAssignProgress({ step: "Leyendo archivo y buscando productos...", pct: 5 });
            const skusEnArchivo = new Set<string>();
            for (const row of dataRows) {
                const rawSku = cleanCode(String(row[colCodigo] || ""));
                if (rawSku) skusEnArchivo.add(rawSku);
            }

            // ── PASO 3: Traer todos los productos relevantes de una vez ───
            setBulkAssignProgress({ step: "Cargando productos del maestro...", pct: 15 });
            const skuArr = [...skusEnArchivo];
            const prodBySkuMap = new Map<string, Product>(); // sku → product
            const prodByBarcodeMap = new Map<string, Product>(); // barcode → product
            const CHUNK = 500;
            for (let i = 0; i < skuArr.length; i += CHUNK) {
                const chunk = skuArr.slice(i, i + CHUNK);
                const { data: prods } = await supabase.from("cyclic_products").select("*").in("sku", chunk);
                for (const p of prods || []) {
                    prodBySkuMap.set(p.sku, p as Product);
                    if (p.barcode) prodByBarcodeMap.set(String(p.barcode), p as Product);
                }
            }
            // Buscar también por barcode los que no se encontraron por SKU
            const notFoundBySku = skuArr.filter(s => !prodBySkuMap.has(s));
            for (let i = 0; i < notFoundBySku.length; i += CHUNK) {
                const chunk = notFoundBySku.slice(i, i + CHUNK);
                const { data: prods } = await supabase.from("cyclic_products").select("*").in("barcode", chunk);
                for (const p of prods || []) {
                    if (p.barcode) prodByBarcodeMap.set(String(p.barcode), p as Product);
                }
            }

            // ── PASO 4: Traer asignaciones existentes para la fecha ───────
            setBulkAssignProgress({ step: "Revisando asignaciones existentes...", pct: 30 });
            // Tiendas únicas del archivo
            const storeIdsDelArchivo = new Set<string>();
            if (hasStoreCol && colTienda >= 0) {
                for (const row of dataRows) {
                    const rawN = String(row[colTienda] || "").trim();
                    const sid = storeNameMap.get(rawN.toLowerCase());
                    if (sid) storeIdsDelArchivo.add(sid);
                }
            } else if (valStoreId) {
                storeIdsDelArchivo.add(valStoreId);
            }

            // Traer asignaciones existentes para esas tiendas en la fecha
            type ExistingAssignment = { id: string; store_id: string; product_id: string; system_stock: number };
            let existingAsgns: ExistingAssignment[] = [];
            const storeIdsArr = [...storeIdsDelArchivo];
            for (let i = 0; i < storeIdsArr.length; i += 100) {
                const chunk = storeIdsArr.slice(i, i + 100);
                const { data: ea } = await supabase.from("cyclic_assignments")
                    .select("id, store_id, product_id, system_stock")
                    .in("store_id", chunk)
                    .eq("assigned_date", valDate);
                existingAsgns = existingAsgns.concat((ea || []) as ExistingAssignment[]);
            }
            // key: storeId__productId → assignment
            const existingMap = new Map<string, ExistingAssignment>();
            for (const ea of existingAsgns) existingMap.set(`${ea.store_id}__${ea.product_id}`, ea);

            // ── PASO 5: Procesar filas y construir lotes ─────────────────
            setBulkAssignProgress({ step: "Preparando datos para inserción...", pct: 50 });
            let skip = 0, notFound = 0, storeNotFound = 0;
            const toInsert: any[] = [];
            const toUpdate: { id: string; system_stock: number; cost?: number }[] = [];
            const costUpdates: { id: string; cost: number }[] = [];

            for (const row of dataRows) {
                const rawSku = cleanCode(String(row[colCodigo] || ""));
                if (!rawSku) { skip++; continue; }

                let targetStoreId = valStoreId || "";
                if (hasStoreCol && colTienda >= 0) {
                    const rawN = String(row[colTienda] || "").trim();
                    if (!rawN) { skip++; continue; }
                    const sid = storeNameMap.get(rawN.toLowerCase());
                    if (!sid) { storeNotFound++; continue; }
                    targetStoreId = sid;
                }
                if (!targetStoreId) { skip++; continue; }

                const prod = prodBySkuMap.get(rawSku) || prodByBarcodeMap.get(rawSku) || null;
                if (!prod) { notFound++; continue; }

                const stock = Number(row[colStock] || 0);
                const cost = parseCost(row[colCosto]);
                if (cost > 0 && cost !== prod.cost) {
                    costUpdates.push({ id: prod.id, cost });
                }

                const key = `${targetStoreId}__${prod.id}`;
                const existing = existingMap.get(key);
                if (existing) {
                    if (existing.system_stock !== stock) toUpdate.push({ id: existing.id, system_stock: stock });
                } else {
                    toInsert.push({
                        store_id: targetStoreId, product_id: prod.id, system_stock: stock,
                        assigned_date: valDate, assigned_by: user?.id,
                    });
                }
            }

            // ── PASO 6: Ejecutar actualizaciones de costo en lote ────────
            setBulkAssignProgress({ step: "Actualizando costos...", pct: 60 });
            const now = new Date().toISOString();
            for (let i = 0; i < costUpdates.length; i += 200) {
                const chunk = costUpdates.slice(i, i + 200);
                await Promise.all(chunk.map(c =>
                    supabase.from("cyclic_products").update({ cost: c.cost, updated_at: now }).eq("id", c.id)
                ));
            }

            // ── PASO 7: Actualizaciones de stock en lote ─────────────────
            setBulkAssignProgress({ step: `Actualizando ${toUpdate.length} asignaciones...`, pct: 70 });
            for (let i = 0; i < toUpdate.length; i += 200) {
                const chunk = toUpdate.slice(i, i + 200);
                await Promise.all(chunk.map(u =>
                    supabase.from("cyclic_assignments").update({ system_stock: u.system_stock }).eq("id", u.id)
                ));
            }

            // ── PASO 8: Insertar nuevas asignaciones en lote ─────────────
            setBulkAssignProgress({ step: `Insertando ${toInsert.length} nuevas asignaciones...`, pct: 85 });
            const INSERT_BATCH = 200;
            let insertOk = 0;
            for (let i = 0; i < toInsert.length; i += INSERT_BATCH) {
                const batch = toInsert.slice(i, i + INSERT_BATCH);
                const { error } = await supabase.from("cyclic_assignments").insert(batch);
                if (!error) insertOk += batch.length;
                setBulkAssignProgress({ step: `Insertando... ${Math.min(i + INSERT_BATCH, toInsert.length)} / ${toInsert.length}`, pct: 85 + Math.round((i / toInsert.length) * 10) });
            }

            setBulkAssignProgress(null);
            const storeMsg = storeNotFound > 0 ? ` ${storeNotFound} tiendas no encontradas.` : "";
            showMessage(`✅ ${insertOk} nuevos asignados, ${toUpdate.length} actualizados. ${skip} vacíos. ${notFound} no encontrados en maestro.${storeMsg}`, insertOk > 0 || toUpdate.length > 0 ? "success" : "error");
            setBulkAssignFile(null); setBulkAssignFileName("");
            if (valStoreId) loadValidadorData(valStoreId, valDate);

            // ── PASO 9: Modal WhatsApp masivo ─────────────────────────────
            if (insertOk > 0 || toUpdate.length > 0) {
                // Contar asignaciones por tienda para el modal
                const countByStore = new Map<string, number>();
                for (const ins of toInsert) {
                    countByStore.set(ins.store_id, (countByStore.get(ins.store_id) || 0) + 1);
                }
                for (const upd of existingAsgns) {
                    // Solo agregar las tiendas que tienen asignaciones totales (no solo updates)
                }
                // Traer conteo total de asignaciones por tienda para la fecha
                const wspStoreIds = [...storeIdsDelArchivo];
                const wspStoresData: typeof bulkWspStores = [];
                for (const sid of wspStoreIds) {
                    const { count: cnt } = await supabase.from("cyclic_assignments")
                        .select("id", { count: "exact", head: true })
                        .eq("store_id", sid)
                        .eq("assigned_date", valDate);
                    const { data: op } = await supabase.from("cyclic_users")
                        .select("full_name, whatsapp")
                        .eq("store_id", sid).eq("role", "Operario").eq("is_active", true).maybeSingle();
                    const storeName = allStores.find(s => s.id === sid)?.name || sid;
                    wspStoresData.push({
                        id: sid,
                        name: storeName,
                        count: cnt || 0,
                        operario: op ? { full_name: op.full_name, whatsapp: op.whatsapp || "" } : null,
                    });
                }
                const withOperario = wspStoresData.filter(s => s.operario?.whatsapp);
                if (withOperario.length > 0) {
                    setBulkWspStores(wspStoresData);
                    setBulkWspSelected(new Set(withOperario.map(s => s.id)));
                    setBulkWspDate(valDate);
                    setShowBulkWspModal(true);
                }
            }
        } catch (e: any) {
            setBulkAssignProgress(null);
            showMessage("Error leyendo el archivo: " + e.message, "error");
        }
    }

    function sendBulkWhatsapp() {
        for (const store of bulkWspStores) {
            if (!bulkWspSelected.has(store.id)) continue;
            if (!store.operario?.whatsapp) continue;
            const mensaje = `Hola ${store.operario.full_name} 👋, se te han asignado *${store.count} código${store.count !== 1 ? "s" : ""}* para contar en *${store.name}* el día *${bulkWspDate}*. Por favor ingresa a la app para realizar el conteo cíclico. ¡Gracias!`;
            const url = `https://wa.me/${store.operario.whatsapp}?text=${encodeURIComponent(mensaje)}`;
            window.open(url, "_blank");
        }
        setShowBulkWspModal(false);
    }

    async function openBulkWspModal(date: string) {
        // Obtener todas las tiendas con asignaciones en esa fecha
        const { data: asgns } = await supabase
            .from("cyclic_assignments")
            .select("store_id")
            .eq("assigned_date", date);
        const storeIds = [...new Set((asgns || []).map((a: any) => a.store_id as string))];
        if (storeIds.length === 0) { showMessage("No hay tiendas con asignaciones en esta fecha.", "error"); return; }

        const wspStoresData: typeof bulkWspStores = [];
        for (const sid of storeIds) {
            const { count: cnt } = await supabase.from("cyclic_assignments")
                .select("id", { count: "exact", head: true })
                .eq("store_id", sid).eq("assigned_date", date);
            const { data: op } = await supabase.from("cyclic_users")
                .select("full_name, whatsapp")
                .eq("store_id", sid).eq("role", "Operario").eq("is_active", true).maybeSingle();
            const storeName = allStores.find(s => s.id === sid)?.name || sid;
            wspStoresData.push({
                id: sid,
                name: storeName,
                count: cnt || 0,
                operario: op ? { full_name: op.full_name, whatsapp: op.whatsapp || "" } : null,
            });
        }
        wspStoresData.sort((a, b) => a.name.localeCompare(b.name));
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
            updated_at: new Date().toISOString(),
        }).eq("id", editingCount.id);
        if (error) { showMessage("Error: " + error.message, "error"); return; }
        showMessage("✅ Registro actualizado.", "success");
        setEditingCount(null);
        loadValidadorData(valStoreId, valDate);
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

            const map = new Map<string, any>();
            for (const row of dataRows) {
                const rawSku = cleanCode(String(row[0] || ""));
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
                const rawSku = cleanCode(String(row["CODIGO"] || ""));
                if (!rawSku) continue;
                const b1 = cleanCode(String(row["CODIGO DE BARRA 1"] || ""));
                const b2 = cleanCode(String(row["CODIGO DE BARRA 2"] || ""));
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
            is_active: true,
            whatsapp: wsp || null,
        });
        if (error) { showMessage("Error: " + error.message, "error"); return; }
        showMessage("✅ Usuario creado.", "success");
        setNewUsername(""); setNewPassword(""); setNewFullName(""); setNewRole("Operario"); setNewUserStoreId(""); setNewUserWhatsapp("");
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
    }

    async function saveEditUser() {
        if (!editingUser) return;
        const wsp = editUserWhatsapp.trim().replace(/\D/g, "");
        const updates: any = {
            role: editUserRole,
            store_id: editUserRole === "Operario" ? (editUserStoreId || null) : null,
            can_access_all_stores: editUserRole !== "Operario",
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
            const clean = cleanCode(v);
            let found: Product | null = null;
            const { data: byB } = await supabase.from("cyclic_products").select("*").eq("barcode", clean).eq("is_active", true).maybeSingle();
            if (byB) found = byB as Product;
            if (!found) {
                const { data: byS } = await supabase.from("cyclic_products").select("*").eq("sku", clean).eq("is_active", true).maybeSingle();
                if (byS) found = byS as Product;
            }
            if (!found) {
                showMessage(`⚠️ Código "${clean}" no encontrado en el maestro.`, "error");
                scanHandledRef.current = false; return;
            }
            const inAssigned = assignments.find(a => a.product_id === found!.id);
            if (!inAssigned) {
                showMessage(`⚠️ "${found.sku}" no está asignado para hoy.`, "error");
                scanHandledRef.current = false; return;
            }
            openCount(inAssigned);
            closeScanner();
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

    function exportDashboard() {
        const rows = filteredDashData.map(r => {
            const base: any = {
                TIENDA: r.store_name,
                FECHA: r.date,
                ASIGNADOS: r.total_asignados,
                OK: r.total_ok,
                SOBRANTES: r.total_sobrantes,
                FALTANTES: r.total_faltantes,
                DIF_VALORIZADA: r.dif_valorizada || 0,
                ERI_PCT: r.eri,
                CUMPLIMIENTO_PCT: r.cumplimiento_pct,
                DIAS_CUMPLIDOS: r.dias_cumplidos,
                DIAS_TOTALES: r.dias_totales,
            };
            if (dashPeriod === "dia" || dashPeriod === "rango") {
                base.HORA_INICIO = r.hora_inicio ? formatDateTime(r.hora_inicio) : "—";
                base.HORA_FIN = r.hora_fin ? formatDateTime(r.hora_fin) : "—";
            }
            base.DURACION = r.duracion_min !== null ? formatDuration(r.duracion_min) : "—";
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
            const EXP_CNT_STORE_CHUNK = 50;
            const EXP_CNT_PAGE = 1000;
            let allCounts: CountRecord[] = [];
            for (let i = 0; i < expStoreIds.length; i += EXP_CNT_STORE_CHUNK) {
                const storeChunk = expStoreIds.slice(i, i + EXP_CNT_STORE_CHUNK);
                let cntPage = 0;
                while (true) {
                    const { data: cData } = await supabase
                        .from("cyclic_counts")
                        .select("*")
                        .in("store_id", storeChunk)
                        .gte("counted_at", from + "T00:00:00.000Z")
                        .lte("counted_at", (() => { const d = new Date(to + "T23:59:59.999Z"); d.setDate(d.getDate() + 1); return d.toISOString(); })())
                        .range(cntPage * EXP_CNT_PAGE, (cntPage + 1) * EXP_CNT_PAGE - 1);
                    if (!cData || cData.length === 0) break;
                    allCounts = allCounts.concat(cData as CountRecord[]);
                    if (cData.length < EXP_CNT_PAGE) break;
                    cntPage++;
                }
            }

            const countMap = new Map<string, CountRecord[]>();
            for (const c of allCounts.filter((c: any) => !c.location?.startsWith("__session_") && asgnIdSetExp.has(c.assignment_id))) {
                if (!countMap.has(c.assignment_id)) countMap.set(c.assignment_id, []);
                countMap.get(c.assignment_id)!.push(c);
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
                const prod = asg.cyclic_products || {};
                const tienda = asg.stores?.name || asg.store_id;
                const costo = parseCost(prod.cost);
                const stock = Number(asg.system_stock || 0);
                const cnts = countMap.get(asg.id) || [];
                const totalContado = cnts.reduce((s: number, c: any) => s + Number(c.counted_quantity), 0);
                // Determinar si cumplió: tiene al menos un conteo guardado (counted_at presente)
                const tienConteo = cnts.length > 0;
                const cumplioStr = tienConteo ? "SI" : "NO";

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
                // Si en cualquier assignment de ese producto hay conteo, marcarlo como cumplió
                if (tienConteo) row.cumplio = "SI";
            }

            // Calcular diferencias finales
            const exportRows: any[] = [];
            for (const r of resMap.values()) {
                r.diferencia = r.total_contado - r.stock_sistema;
                r.dif_valorizada = r.diferencia * r.costo;
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

            for (const ds of daySumMap.values()) {
                ds.cumplio = ds.faltantes === 0;
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
                ERI_PCT: ds.asignados > 0 && ds.cumplio ? Math.round((ds.ok / ds.asignados) * 100) : 0,
                CUMPLIMIENTO: ds.cumplio ? "SI" : "NO",
                HORA_INICIO: ds.horaInicio ? formatDateTime(ds.horaInicio) : "—",
                HORA_FIN: ds.horaFin ? formatDateTime(ds.horaFin) : "—",
                DURACION: ds.duracion !== null ? formatDuration(ds.duracion) : "—",
            }));

            const ws = XLSX.utils.json_to_sheet(exportRows);
            const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
            const wbk = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wbk, wsSummary, "Resumen Dashboard");
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
            entry.difference = entry.total_counted - entry.system_stock;
            entry.dif_valorizada = entry.difference * entry.cost;
        }
        return Array.from(map.values()).sort((a, b) => a.sku.localeCompare(b.sku));
    }, [assignments, counts]);

    const filteredResumen = useMemo(() => {
        if (!resumenSearch.trim()) return resumenPorCodigo;
        const q = resumenSearch.trim().toLowerCase();
        return resumenPorCodigo.filter(r =>
            r.sku.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
        );
    }, [resumenPorCodigo, resumenSearch]);

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
        const total = resumenPorCodigo.length;
        const contados = resumenPorCodigo.filter(r => r.total_counted > 0 || counts.some(c => c.product_id === r.product_id)).length;
        const pendientes = total - contados;
        const conDif = resumenPorCodigo.filter(r => {
            const wasCounted = counts.some(c => c.product_id === r.product_id);
            return wasCounted && r.difference !== 0;
        }).length;
        const valorizadaDif = resumenPorCodigo.reduce((s, r) => s + r.dif_valorizada, 0);
        return { total, contados, pendientes, conDif, valorizadaDif };
    }, [resumenPorCodigo, counts]);

    const filteredProducts = useMemo(() => {
        const text = prodSearch.trim().toLowerCase();
        if (!text) return products.slice(0, 100);
        return products.filter(p => [p.sku, p.description, p.barcode].join(" ").toLowerCase().includes(text)).slice(0, 100);
    }, [products, prodSearch]);

    const filteredDashData = useMemo(() => {
        if (!dashStoreFilter) return dashData;
        return dashData.filter(r => r.store_id === dashStoreFilter);
    }, [dashData, dashStoreFilter]);

    const dashSummary = useMemo(() => {
        if (filteredDashData.length === 0) return null;
        // ERI exacto: suma OKs de filas que cumplieron / suma asignados de filas que cumplieron
        // Se excluyen tiendas/días que no cumplieron (no contaron todos sus códigos)
        const filasQueCumplieron = filteredDashData.filter(r => r.cumplio);
        const okCumplieron = filasQueCumplieron.reduce((s, r) => s + r.total_ok, 0);
        const totalCumplieron = filasQueCumplieron.reduce((s, r) => s + r.total_asignados, 0);
        const avgEri = totalCumplieron > 0 ? Math.round((okCumplieron / totalCumplieron) * 100) : 0;
        const cumplidos = filteredDashData.filter(r => r.cumplio).length;
        const avgDurMin = filteredDashData.filter(r => r.duracion_min !== null).length > 0
            ? Math.round(filteredDashData.filter(r => r.duracion_min !== null).reduce((s, r) => s + (r.duracion_min || 0), 0) / filteredDashData.filter(r => r.duracion_min !== null).length)
            : null;
        const totalDifVal = filasQueCumplieron.reduce((s, r) => s + (r.dif_valorizada || 0), 0);
        return { avgEri, cumplidos, total: filteredDashData.length, avgDurMin, totalDifVal };
    }, [filteredDashData]);

    // ════════════════════════════════════════════════════════
    //  RENDER
    // ════════════════════════════════════════════════════════
    if (loading) {
        return (
            <main className="min-h-screen bg-slate-50 flex items-center justify-center">
                <div className="text-slate-500 text-lg">Cargando...</div>
            </main>
        );
    }

    const isAdmin    = user?.role === "Administrador";
    const isValOrAdm = user?.role === "Validador" || isAdmin;

    return (
        <main className="min-h-screen bg-slate-50 text-slate-900">
            {/* ── TOPBAR ──────────────────────────────────────────────── */}
            <div className="bg-white border-b sticky top-0 z-30 px-4 py-3 flex items-center justify-between gap-3">
                <div>
                    <h1 className="font-bold text-slate-900 text-base leading-tight">Cíclicos</h1>
                    <p className="text-xs text-slate-500">{user?.full_name} · {user?.role}</p>
                </div>
                <div className="flex items-center gap-2">
                    {user?.role === "Operario" && (
                        <span className="text-xs font-semibold bg-slate-100 text-slate-700 px-3 py-1.5 rounded-xl">{user.role}</span>
                    )}
                    {isValOrAdm && (
                        <div className="flex gap-1 flex-wrap">
                            {isAdmin && (
                                <button onClick={() => { setActiveTab("operario"); if (!selectedStoreId && allStores.filter(s=>s.is_active).length > 0) { const first = allStores.filter(s => s.is_active)[0]; setSelectedStoreId(first.id); loadOperarioData(first.id, selectedDate); } }} className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition ${activeTab === "operario" ? "bg-amber-600 text-white border-amber-600" : "bg-white text-slate-700 border-slate-300"}`}>Operario</button>
                            )}
                            <button onClick={() => setActiveTab("validador")} className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition ${activeTab === "validador" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-slate-700 border-slate-300"}`}>Validador</button>
                            {isAdmin && (
                                <button onClick={() => setActiveTab("admin")} className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition ${activeTab === "admin" ? "bg-purple-600 text-white border-purple-600" : "bg-white text-slate-700 border-slate-300"}`}>Admin</button>
                            )}
                        </div>
                    )}
                    <button onClick={handleLogout} className="text-xs px-3 py-1.5 rounded-xl border text-slate-600 font-semibold">Salir</button>
                </div>
            </div>

            {/* ── MENSAJE GLOBAL ──────────────────────────────────────── */}
            {message && (
                <div className={`mx-4 mt-3 rounded-2xl px-4 py-3 text-sm font-medium flex items-center justify-between gap-3 ${messageType === "success" ? "bg-green-50 text-green-800 border border-green-200" : messageType === "error" ? "bg-red-50 text-red-800 border border-red-200" : "bg-blue-50 text-blue-800 border border-blue-200"}`}>
                    <span>{message}</span>
                    <button className="text-lg leading-none opacity-60 hover:opacity-100" onClick={clearMessage}>×</button>
                </div>
            )}

            <div className="max-w-5xl mx-auto p-4 space-y-4">

            {/* ════════════════════════════════════════════════════════
                TAB OPERARIO
            ════════════════════════════════════════════════════════ */}
            {activeTab === "operario" && (user?.role === "Operario" || isAdmin) && !showRecount && (
                <>
                    <section className="bg-white rounded-3xl p-5 shadow space-y-3">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                            <div>
                                <h2 className="text-xl font-bold text-slate-900">Conteos del día</h2>
                                <p className="text-slate-500 text-sm">{allStores.find(s => s.id === selectedStoreId)?.name || "—"} · {selectedDate}</p>
                            </div>
                            <div className="flex gap-3 items-center flex-wrap">
                                {isAdmin && (
                                    <select
                                        className="border rounded-2xl px-3 py-2 text-sm text-slate-900 bg-white"
                                        value={selectedStoreId}
                                        onChange={e => { setSelectedStoreId(e.target.value); if (e.target.value) loadOperarioData(e.target.value, selectedDate); }}
                                    >
                                        <option value="">— Selecciona tienda —</option>
                                        {allStores.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                    </select>
                                )}
                                <input type="date" className="border rounded-2xl px-3 py-2 text-sm text-slate-900 bg-white" value={selectedDate} onChange={e => { setSelectedDate(e.target.value); if (selectedStoreId) loadOperarioData(selectedStoreId, e.target.value); }} />
                                <button className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-slate-900 text-white text-sm font-semibold" onClick={() => openScanner("product")}>
                                    <QrCode size={16} /> Escanear
                                </button>
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
                            <h3 className="font-bold text-slate-900">Pendientes ({pendingAssignments.length})</h3>
                            <div className="space-y-2">
                                {pendingAssignments.map(a => (
                                    <div key={a.id} className="flex items-center justify-between gap-3 border rounded-2xl p-3 bg-amber-50 border-amber-200">
                                        <div className="flex-1 min-w-0">
                                            <div className="font-semibold text-slate-900 truncate">{a.sku}</div>
                                            <div className="text-xs text-slate-600 truncate">{a.description}</div>
                                            <div className="text-xs text-slate-400">UM: {a.unit}</div>
                                        </div>
                                        <button className="px-4 py-2 rounded-2xl bg-slate-900 text-white text-sm font-semibold whitespace-nowrap" onClick={() => openCount(a)}>
                                            Contar
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    {/* Lista contados */}
                    {doneAssignments.length > 0 && (
                        <section className="bg-white rounded-3xl p-5 shadow space-y-3">
                            <h3 className="font-bold text-slate-900">Ya contados ({doneAssignments.length})</h3>
                            <div className="space-y-2">
                                {doneAssignments.map(a => {
                                    const asgCounts = counts.filter(c => c.assignment_id === a.id);
                                    const totalContado = asgCounts.reduce((s, c) => s + Number(c.counted_quantity), 0);
                                    const hasDiff = totalContado !== Number(a.system_stock);
                                    return (
                                        <div key={a.id} className={`border rounded-2xl p-3 ${hasDiff ? "bg-red-50 border-red-200" : "bg-green-50 border-green-200"}`}>
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="flex-1 min-w-0">
                                                    <div className="font-semibold text-slate-900 truncate">{a.sku}</div>
                                                    <div className="text-xs text-slate-600 truncate">{a.description}</div>
                                                    <div className="text-xs text-slate-500 mt-0.5">
                                                        Stock: <b>{a.system_stock}</b> · Total contado: <b>{totalContado}</b>
                                                        {hasDiff
                                                            ? <span className="text-red-600 font-semibold"> · Dif: {totalContado - Number(a.system_stock) > 0 ? "+" : ""}{totalContado - Number(a.system_stock)} ⚠️</span>
                                                            : <span className="text-green-600 font-semibold"> · ✓ OK</span>
                                                        }
                                                    </div>
                                                </div>
                                                <button className="px-3 py-2 rounded-xl border text-xs font-semibold" onClick={() => openCount(a)}>Editar</button>
                                            </div>
                                            {asgCounts.length > 0 && (
                                                <div className="mt-2 space-y-1">
                                                    {asgCounts.map((c, i) => (
                                                        <div key={c.id} className="text-xs text-slate-500 flex gap-2 bg-white rounded-xl px-2 py-1 border border-green-100">
                                                            <span className="font-semibold text-slate-700">Ubic {i + 1}:</span>
                                                            <span>{c.location}</span>
                                                            <span>·</span>
                                                            <span>Cant: <b>{c.counted_quantity}</b></span>
                                                            <span>·</span>
                                                            <span className={statusBadge(c.status)}>{c.status}</span>
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
                            <br />Contacta al validador para que asigne los conteos.
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

                        {/* Panel de edición de producto seleccionado */}
                        {recountAssignment ? (
                            <div className="rounded-2xl border bg-orange-50 border-orange-200 p-4 space-y-3">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <p className="font-bold text-slate-900">{recountAssignment.sku}</p>
                                        <p className="text-xs text-slate-600">{recountAssignment.description}</p>
                                        <p className="text-xs text-slate-400">UM: {recountAssignment.unit} · Stock sistema: <b>{recountAssignment.system_stock}</b></p>
                                    </div>
                                    <button onClick={() => { setRecountAssignment(null); setRecountRows([{ location: "", qty: "" }]); }} className="text-slate-400 text-xl">×</button>
                                </div>

                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <label className="block font-semibold text-sm text-slate-700">Ubicaciones y cantidades</label>
                                        <button className="text-xs px-3 py-1.5 rounded-xl bg-slate-100 text-slate-700 font-semibold border" onClick={addRecountRow}>+ Agregar ubicación</button>
                                    </div>
                                    {recountRows.map((row, i) => (
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
                                    <button className="flex-1 py-3 rounded-2xl bg-orange-600 text-white font-bold text-sm" onClick={saveRecount}>
                                        Guardar reconteo
                                    </button>
                                    <button className="px-5 py-3 rounded-2xl border font-semibold text-sm" onClick={() => { setRecountAssignment(null); setRecountRows([{ location: "", qty: "" }]); }}>
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
                                        onClick={() => openRecountItem(a)}
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="flex-1 min-w-0">
                                                <div className="font-semibold text-slate-900 truncate">{a.sku}</div>
                                                <div className="text-xs text-slate-600 truncate">{a.description}</div>
                                                <div className="text-xs text-slate-400 mt-0.5">
                                                    {isUncounted
                                                        ? <span className="text-amber-700 font-semibold">⏳ No contado · Stock: <b>{a.system_stock}</b></span>
                                                        : <>Stock: <b>{a.system_stock}</b> · Contado: <b>{totalContado}</b> · Dif: {diffBadge(diff)}</>
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
                    {/* Selector tienda/fecha */}
                    <section className="bg-white rounded-3xl p-5 shadow">
                        <div className="flex flex-wrap gap-3 items-end">
                            <div className="flex-1 min-w-[160px]">
                                <label className="block text-xs font-semibold text-slate-600 mb-1">Tienda</label>
                                <select className="w-full border rounded-2xl p-3 text-sm text-slate-900 bg-white" value={valStoreId} onChange={e => { setValStoreId(e.target.value); loadValidadorData(e.target.value, valDate); }}>
                                    <option value="">— Selecciona tienda —</option>
                                    {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-semibold text-slate-600 mb-1">Fecha</label>
                                <input type="date" className="border rounded-2xl p-3 text-sm text-slate-900 bg-white" value={valDate} onChange={e => { setValDate(e.target.value); if (valStoreId) loadValidadorData(valStoreId, e.target.value); }} />
                            </div>
                            {valStoreId && (
                                <button
                                    className="px-4 py-3 rounded-2xl border font-semibold text-sm text-slate-700 bg-white hover:bg-slate-50 transition flex items-center gap-2"
                                    onClick={() => loadValidadorData(valStoreId, valDate)}
                                >
                                    🔄 Actualizar
                                </button>
                            )}
                            <button
                                className="px-4 py-3 rounded-2xl bg-green-600 text-white font-semibold text-sm hover:bg-green-700 transition flex items-center gap-2"
                                onClick={() => openBulkWspModal(valDate)}
                                title="Enviar WhatsApp a todos los operarios con asignaciones en la fecha seleccionada"
                            >
                                📲 WhatsApp masivo
                            </button>
                            {valStoreId && (
                                <div className="flex gap-2 text-xs font-semibold text-slate-600 bg-slate-50 border rounded-2xl px-4 py-3 flex-wrap">
                                    <span>Asignados: <b>{resumenStats.total}</b></span>
                                    <span>·</span>
                                    <span className="text-green-700">Contados: <b>{resumenStats.contados}</b></span>
                                    <span>·</span>
                                    <span className="text-amber-600">Pend: <b>{resumenStats.pendientes}</b></span>
                                    <span>·</span>
                                    <span className="text-red-600">Con dif: <b>{resumenStats.conDif}</b></span>
                                </div>
                            )}
                            {valStoreId && resumenStats.total > 0 && (
                                <div className="w-full space-y-1 pt-1">
                                    <div className="h-2.5 bg-slate-200 rounded-full overflow-hidden">
                                        <div
                                            className="h-full rounded-full transition-all"
                                            style={{
                                                width: `${(resumenStats.contados / resumenStats.total) * 100}%`,
                                                background: resumenStats.contados === resumenStats.total ? "#16a34a" : "#f59e0b"
                                            }}
                                        />
                                    </div>
                                    <div className="text-xs text-slate-500 text-right">
                                        {Math.round((resumenStats.contados / resumenStats.total) * 100)}% completado
                                    </div>
                                </div>
                            )}
                        </div>
                    </section>

                    {/* Sub-tabs validador: Asignar | Registros | Resumen */}
                    <div className="flex gap-2 flex-wrap">
                        <button onClick={() => setValTab("asignar")} className={`px-5 py-2.5 rounded-2xl font-semibold text-sm border transition ${valTab === "asignar" ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-300"}`}>Asignar productos</button>
                        <button onClick={() => { setValTab("registros"); if (valStoreId) loadValidadorData(valStoreId, valDate); }} className={`px-5 py-2.5 rounded-2xl font-semibold text-sm border transition ${valTab === "registros" ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-300"}`}>Registros</button>
                        <button onClick={() => { setValTab("resumen"); if (valStoreId) loadValidadorData(valStoreId, valDate); }} className={`px-5 py-2.5 rounded-2xl font-semibold text-sm border transition ${valTab === "resumen" ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-300"}`}>Resumen por código</button>
                    </div>

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
                                        placeholder="Buscar por SKU, descripción o código de barra..."
                                        value={assignSearch}
                                        onChange={e => searchProductsForAssign(e.target.value)}
                                    />
                                    {assignResults.length > 0 && (
                                        <div className="border rounded-2xl overflow-hidden">
                                            <div className="max-h-72 overflow-auto">
                                                {assignResults.map(p => {
                                                    const alreadyAssigned = assignments.some(a => a.product_id === p.id);
                                                    return (
                                                        <div key={p.id} className={`flex items-center gap-3 p-3 border-b last:border-b-0 ${alreadyAssigned ? "bg-green-50" : "bg-white hover:bg-slate-50"}`}>
                                                            <div className="flex-1 min-w-0">
                                                                <div className="font-semibold text-slate-900 text-sm">{p.sku}</div>
                                                                <div className="text-xs text-slate-600 truncate">{p.description}</div>
                                                                <div className="text-xs text-slate-400">UM: {p.unit} · Código: {p.barcode || "—"}</div>
                                                            </div>
                                                            <div className="flex items-center gap-2">
                                                                <div>
                                                                    <label className="text-xs text-slate-500 block">Stock sistema</label>
                                                                    <input
                                                                        className="w-24 border rounded-xl p-1.5 text-sm text-slate-900 bg-white"
                                                                        type="number"
                                                                        placeholder="Stock"
                                                                        value={assignStockMap[p.id] ?? ""}
                                                                        onChange={e => setAssignStockMap(prev => ({ ...prev, [p.id]: e.target.value }))}
                                                                    />
                                                                </div>
                                                                {alreadyAssigned ? (
                                                                    <span className="text-xs text-green-700 font-semibold px-3 py-2">✓ Asignado</span>
                                                                ) : (
                                                                    <button className="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold" onClick={() => assignProduct(p)}>+ Asignar</button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Carga masiva */}
                                <div className="border-t pt-4 space-y-3">
                                    <div>
                                        <p className="text-sm font-semibold text-slate-700">📦 Carga masiva por Excel — <span className="text-blue-700">Todas las tiendas</span></p>
                                        <div className="mt-1.5 rounded-2xl bg-blue-50 border border-blue-200 p-3 space-y-1 text-xs text-slate-600">
                                            <p>✅ <b>Formato multi-tienda (recomendado):</b> <b>A: Tienda</b> · <b>B: Código</b> · <b>C: Descripción</b> · <b>D: Unidad</b> · <b>E: Costo</b> · <b>F: Stock</b>.<br/>
                                            El nombre de tienda en col A debe coincidir exactamente con el sistema. No necesitas seleccionar tienda arriba.</p>
                                            <p className="text-slate-400">Formato simple (sin col tienda): <b>A: Código</b> · <b>B: Desc</b> · <b>C: Unidad</b> · <b>D: Costo</b> · <b>E: Stock</b>. Requiere tienda seleccionada arriba.</p>
                                            <p className="text-blue-700 font-semibold">⚡ Carga optimizada: todos los productos se procesan en lote, sin esperar fila por fila.</p>
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
                            {assignments.length > 0 && (
                                <section className="bg-white rounded-3xl p-5 shadow space-y-3">
                                    <div className="flex items-center justify-between gap-3 flex-wrap">
                                        <h3 className="font-bold text-slate-900">Asignados este día ({assignments.length})</h3>
                                        <div className="flex gap-2 flex-wrap">
                                            <button
                                                className="px-4 py-2 rounded-2xl bg-green-600 text-white font-semibold text-xs hover:bg-green-700 transition"
                                                onClick={() => openBulkWspModal(valDate)}
                                                title="Enviar WhatsApp a todos los operarios con asignaciones en esta fecha"
                                            >
                                                📲 WhatsApp masivo
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
                                                                <td className="p-2 border text-center font-semibold">{a.system_stock}</td>
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
                                <button className="px-4 py-2 rounded-2xl border text-sm font-semibold text-slate-700" onClick={exportCounts}>↓ Excel registros</button>
                            </div>

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
                                                <th className="p-2 border">Ubicación</th>
                                                <th className="p-2 border">Cantidad</th>
                                                <th className="p-2 border">Usuario</th>
                                                <th className="p-2 border">Hora</th>
                                                <th className="p-2 border">Estado</th>
                                                <th className="p-2 border">Acción</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {filteredCounts.map(c => (
                                                <tr key={c.id} className="hover:bg-slate-50">
                                                    <td className="p-2 border font-medium">{c.sku}</td>
                                                    <td className="p-2 border text-slate-600 max-w-[180px] truncate">{c.description}</td>
                                                    <td className="p-2 border text-center font-mono text-xs">{c.location}</td>
                                                    <td className="p-2 border text-center font-semibold">{c.counted_quantity}</td>
                                                    <td className="p-2 border text-xs">{c.user_name}</td>
                                                    <td className="p-2 border text-xs text-slate-500 whitespace-nowrap">{formatDateTime(c.counted_at)}</td>
                                                    <td className="p-2 border text-center"><span className={statusBadge(c.status)}>{c.status}</span></td>
                                                    <td className="p-2 border text-center">
                                                        <button className="px-3 py-1.5 rounded-lg border text-xs font-semibold mr-1" onClick={() => openEditCount(c)}>Editar</button>
                                                        <button className="px-3 py-1.5 rounded-lg text-xs font-semibold text-red-600 border border-red-200" onClick={() => deleteCount(c)}>✕</button>
                                                    </td>
                                                </tr>
                                            ))}
                                            {filteredCounts.length === 0 && (
                                                <tr><td className="p-6 border text-center text-slate-400" colSpan={8}>No hay conteos registrados todavía.</td></tr>
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
                                <button className="px-4 py-2 rounded-2xl border text-sm font-semibold text-slate-700" onClick={exportResumen}>↓ Excel resumen</button>
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
                                    <div className="border rounded-2xl overflow-hidden">
                                        <div className="max-h-[500px] overflow-auto">
                                            <table className="w-full text-sm">
                                                <thead className="bg-slate-100 sticky top-0">
                                                    <tr>
                                                        <th className="p-2 border text-left">SKU</th>
                                                        <th className="p-2 border text-left">Descripción</th>
                                                        <th className="p-2 border">UM</th>
                                                        <th className="p-2 border">Stock Sis.</th>
                                                        <th className="p-2 border">Total Contado</th>
                                                        <th className="p-2 border">Diferencia</th>
                                                        <th className="p-2 border">Costo</th>
                                                        <th className="p-2 border">Dif. Valorizada</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {filteredResumen
                                                        .filter(r => counts.some(c => c.product_id === r.product_id))
                                                        .map(r => (
                                                        <tr key={r.product_id} className={r.difference !== 0 ? "bg-red-50" : "hover:bg-slate-50"}>
                                                            <td className="p-2 border font-medium">{r.sku}</td>
                                                            <td className="p-2 border text-slate-600 max-w-[180px] truncate">{r.description}</td>
                                                            <td className="p-2 border text-center text-xs">{r.unit}</td>
                                                            <td className="p-2 border text-center">{r.system_stock}</td>
                                                            <td className="p-2 border text-center font-semibold">{r.total_counted}</td>
                                                            <td className="p-2 border text-center">{diffBadge(r.difference)}</td>
                                                            <td className="p-2 border text-center text-xs">{formatMoney(r.cost)}</td>
                                                            <td className="p-2 border text-center text-xs font-semibold">
                                                                <span className={r.dif_valorizada < 0 ? "text-red-600" : r.dif_valorizada > 0 ? "text-blue-700" : "text-green-700"}>
                                                                    {formatMoney(r.dif_valorizada)}
                                                                </span>
                                                            </td>
                                                        </tr>
                                                    ))}
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
                                                                    <td className="p-2 border border-amber-100 text-center font-semibold">{a.system_stock}</td>
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
                    {/* Sub-tabs admin */}
                    <div className="flex gap-2 flex-wrap">
                        {(["productos","tiendas","usuarios","dashboard"] as const).map(t => (
                            <button key={t} onClick={() => setAdminTab(t)} className={`px-5 py-2.5 rounded-2xl font-semibold text-sm border capitalize transition ${adminTab === t ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-300"}`}>
                                {t === "productos" ? "🗃 Maestro" : t === "tiendas" ? "🏪 Tiendas" : t === "usuarios" ? "👤 Usuarios" : "📊 Dashboard"}
                            </button>
                        ))}
                    </div>

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
                                                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${u.is_active ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>{u.is_active ? "Activo" : "Inactivo"}</span>
                                                        </td>
                                                        <td className="p-2 border text-center">
                                                            <button className="px-3 py-1.5 rounded-lg border text-xs font-semibold mr-1" onClick={() => openEditUser(u)}>Editar</button>
                                                            <button className="px-3 py-1.5 rounded-lg border text-xs font-semibold text-red-600 border-red-200" onClick={() => deleteUser(u)}>✕</button>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                            {allUsers.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-400">No hay usuarios.</td></tr>}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </section>
                    )}

                    {/* ── ADMIN: DASHBOARD ──────────────────────────────── */}
                    {adminTab === "dashboard" && (
                        <>
                            <section className="bg-white rounded-3xl p-5 shadow space-y-4">
                                <div>
                                    <h2 className="text-xl font-bold text-slate-900">📊 Dashboard por tienda</h2>
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
                                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
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
                                        <div className="text-xs text-slate-500 mt-1">Cumplieron</div>
                                    </div>
                                    <div className="bg-white rounded-2xl p-4 shadow text-center">
                                        <div className="text-2xl font-bold text-slate-700">{formatDuration(dashSummary.avgDurMin)}</div>
                                        <div className="text-xs text-slate-500 mt-1">{dashPeriod === "mes" ? "Duración promedio" : dashPeriod === "rango" ? "Duración promedio" : "Duración"}</div>
                                    </div>
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
                                    <h3 className="font-bold text-slate-900">Detalle por tienda{dashPeriod === "mes" ? " y día" : ""}</h3>
                                    <div className="border rounded-2xl overflow-hidden">
                                        <div className="overflow-auto">
                                            <table className="w-full text-sm min-w-[900px]">
                                                <thead className="bg-slate-100 sticky top-0">
                                                    <tr>
                                                        <th className="p-2 border text-left">Tienda</th>
                                                        {(dashPeriod === "dia" || dashPeriod === "rango") && <th className="p-2 border">Fecha</th>}
                                                        <th className="p-2 border">Asignados</th>
                                                        <th className="p-2 border text-green-700">OK</th>
                                                        <th className="p-2 border text-blue-700">Sobrantes</th>
                                                        <th className="p-2 border text-red-600">Faltantes</th>
                                                        <th className="p-2 border text-red-700">Dif. Val.</th>
                                                        <th className="p-2 border">ERI %</th>
                                                        <th className="p-2 border">Cumplimiento</th>
                                                        {(dashPeriod === "dia" || dashPeriod === "rango") && <>
                                                            <th className="p-2 border">Hora inicio</th>
                                                            <th className="p-2 border">Hora fin</th>
                                                        </>}
                                                        <th className="p-2 border">{dashPeriod === "dia" ? "Duración" : "Duración prom."}</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {filteredDashData.map((r, i) => (
                                                        <tr key={i} className={r.cumplio ? "hover:bg-green-50" : "hover:bg-slate-50"}>
                                                            <td className="p-2 border font-medium">{r.store_name}</td>
                                                            {(dashPeriod === "dia" || dashPeriod === "rango") && <td className="p-2 border text-center text-xs">{r.date}</td>}
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
                                                                <span className={`font-bold text-sm ${r.cumplimiento_pct >= 100 ? "text-green-700" : r.cumplimiento_pct >= 50 ? "text-amber-600" : "text-red-600"}`}>
                                                                    {r.cumplimiento_pct}%
                                                                </span>
                                                                {dashPeriod === "mes" && (
                                                                    <div className="text-xs text-slate-400">{r.dias_cumplidos}/{r.dias_totales} días</div>
                                                                )}
                                                            </td>
                                                            {(dashPeriod === "dia" || dashPeriod === "rango") && <>
                                                                <td className="p-2 border text-center text-xs whitespace-nowrap">{r.hora_inicio ? formatDateTime(r.hora_inicio) : "—"}</td>
                                                                <td className="p-2 border text-center text-xs whitespace-nowrap">{r.hora_fin ? formatDateTime(r.hora_fin) : "—"}</td>
                                                            </>}
                                                            <td className="p-2 border text-center text-xs">{formatDuration(r.duracion_min)}</td>
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
                </>
            )}

            </div>{/* end max-w-5xl */}

            {/* ════════════════════════════════════════════════════════
                MODAL — CONTEO (Operario) — MÚLTIPLES UBICACIONES
            ════════════════════════════════════════════════════════ */}
            {activeAssignment && (
                <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-3xl p-6 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto">
                        <div className="flex items-start justify-between gap-3 mb-4">
                            <div>
                                <h3 className="text-xl font-bold text-slate-900">Registrar conteo</h3>
                                <p className="text-slate-600 text-sm mt-0.5">{activeAssignment.sku} — {activeAssignment.description}</p>
                                <p className="text-xs text-slate-400 mt-0.5">UM: {activeAssignment.unit}</p>
                            </div>
                            <button className="text-slate-400 hover:text-slate-600 text-2xl leading-none" onClick={() => setActiveAssignment(null)}>×</button>
                        </div>

                        <div className="space-y-3 mb-4">
                            <div className="flex items-center justify-between">
                                <label className="block font-semibold text-sm text-slate-700">Ubicaciones y cantidades</label>
                                <button
                                    className="text-xs px-3 py-1.5 rounded-xl bg-slate-100 text-slate-700 font-semibold border"
                                    onClick={addLocationRow}
                                >
                                    + Agregar ubicación
                                </button>
                            </div>
                            {locationRows.map((row, i) => (
                                <div key={i} className="rounded-2xl border bg-slate-50 p-3 space-y-2">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-xs font-semibold text-slate-500">Ubicación {locationRows.length > 1 ? i + 1 : ""}</span>
                                        {locationRows.length > 1 && (
                                            <button className="text-xs text-red-500 hover:text-red-700 font-semibold" onClick={() => removeLocationRow(i)}>Quitar</button>
                                        )}
                                    </div>
                                    <div>
                                        <label className="text-xs text-slate-500 block mb-1">Ubicación</label>
                                        <div className="flex gap-1">
                                            <input
                                                className="flex-1 border rounded-xl p-2.5 text-sm text-slate-900 bg-white"
                                                placeholder="Ej: A-01-03"
                                                value={row.location}
                                                onChange={e => updateLocationRow(i, "location", e.target.value)}
                                            />
                                            <button
                                                className="px-3 py-2 rounded-xl bg-slate-200 text-slate-700 text-xs"
                                                onClick={() => openScanner("location", i)}
                                                title="Escanear ubicación"
                                            >
                                                <QrCode size={14} />
                                            </button>
                                        </div>
                                    </div>
                                    <div>
                                        <label className="text-xs text-slate-500 block mb-1">Cantidad</label>
                                        <input
                                            className="w-full border rounded-xl p-3 text-lg text-center font-bold text-slate-900 bg-white"
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

                        <div className="flex gap-3">
                            <button className="flex-1 py-3 rounded-2xl bg-slate-900 text-white font-bold text-sm" onClick={saveCount}>
                                Guardar conteo
                            </button>
                            <button className="px-5 py-3 rounded-2xl border font-semibold text-sm text-slate-700" onClick={() => setActiveAssignment(null)}>
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
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-3xl p-6 w-full max-w-sm space-y-4 shadow-2xl">
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
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-3xl p-6 w-full max-w-md space-y-4 shadow-2xl">
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
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-3xl p-6 w-full max-w-md space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto">
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
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-3xl p-6 w-full max-w-sm space-y-5 shadow-2xl">
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
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-3xl p-6 w-full max-w-sm space-y-5 shadow-2xl">
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
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-3xl p-6 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto space-y-4">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-xl font-bold text-slate-900">📲 Enviar avisos por WhatsApp</h3>
                                <p className="text-slate-500 text-sm mt-1">Carga completada para <b>{bulkWspDate}</b>. Selecciona las tiendas a las que quieres notificar.</p>
                            </div>
                            <button className="text-slate-400 hover:text-slate-600 text-2xl leading-none" onClick={() => setShowBulkWspModal(false)}>×</button>
                        </div>

                        <div className="flex gap-2">
                            <button
                                className="text-xs px-3 py-1.5 rounded-xl bg-slate-100 font-semibold text-slate-700 border"
                                onClick={() => setBulkWspSelected(new Set(bulkWspStores.filter(s => s.operario?.whatsapp).map(s => s.id)))}
                            >
                                Seleccionar todas
                            </button>
                            <button
                                className="text-xs px-3 py-1.5 rounded-xl bg-slate-100 font-semibold text-slate-700 border"
                                onClick={() => setBulkWspSelected(new Set())}
                            >
                                Quitar todas
                            </button>
                        </div>

                        <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                            {bulkWspStores.map(store => {
                                const hasOp = !!store.operario?.whatsapp;
                                const selected = bulkWspSelected.has(store.id);
                                return (
                                    <div
                                        key={store.id}
                                        className={`flex items-center gap-3 rounded-2xl border p-3 transition ${!hasOp ? "opacity-40 cursor-not-allowed bg-slate-50" : selected ? "bg-green-50 border-green-300 cursor-pointer" : "bg-white border-slate-200 cursor-pointer hover:bg-slate-50"}`}
                                        onClick={() => {
                                            if (!hasOp) return;
                                            setBulkWspSelected(prev => {
                                                const next = new Set(prev);
                                                if (next.has(store.id)) next.delete(store.id);
                                                else next.add(store.id);
                                                return next;
                                            });
                                        }}
                                    >
                                        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${selected && hasOp ? "bg-green-600 border-green-600" : "border-slate-300"}`}>
                                            {selected && hasOp && <span className="text-white text-xs font-bold">✓</span>}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="font-semibold text-sm text-slate-900 truncate">{store.name}</div>
                                            <div className="text-xs text-slate-500">
                                                {store.count} código{store.count !== 1 ? "s" : ""} asignados
                                                {store.operario
                                                    ? <> · <span className="text-green-700">📲 {store.operario.full_name} ({store.operario.whatsapp})</span></>
                                                    : <span className="text-red-500"> · Sin operario con WhatsApp</span>
                                                }
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        <div className="flex gap-3 pt-1">
                            <button
                                className="flex-1 py-3 rounded-2xl bg-green-600 text-white font-bold text-sm disabled:opacity-40"
                                disabled={bulkWspSelected.size === 0}
                                onClick={sendBulkWhatsapp}
                            >
                                📲 Enviar a {bulkWspSelected.size} tienda{bulkWspSelected.size !== 1 ? "s" : ""}
                            </button>
                            <button className="px-5 py-3 rounded-2xl border font-semibold text-slate-700 text-sm" onClick={() => setShowBulkWspModal(false)}>
                                Omitir
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ════════════════════════════════════════════════════════
                OVERLAY — ESCÁNER DE CÁMARA
            ════════════════════════════════════════════════════════ */}
            {scannerTarget && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-[60]">
                    <div className="bg-white w-full max-w-lg rounded-3xl p-5 shadow-2xl space-y-4">
                        <div>
                            <h3 className="text-xl font-bold text-slate-900">
                                {scannerTarget === "product" ? "Escanear producto" : `Escanear ubicación ${(locationRows.length > 1 || recountRows.length > 1) ? scanningRowIndex + 1 : ""}`}
                            </h3>
                            <p className="text-sm text-slate-500">
                                {scannerTarget === "product" ? "Busca por código de barra del producto asignado." : "Escanea o escribe la ubicación."}
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
        </main>
    );
}