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

function formatMoney(v: number) {
    return `S/ ${Number(v || 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDateTime(v: string) {
    if (!v) return "-";
    const d = new Date(v);
    if (isNaN(d.getTime())) return v;
    return d.toLocaleString("es-PE");
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

    // ─── Operario: conteo activo — ahora con múltiples filas ─
    const [activeAssignment, setActiveAssignment] = useState<Assignment | null>(null);
    const [locationRows, setLocationRows]         = useState<LocationRow[]>([{ location: "", qty: "" }]);

    // ─── Escáner ─────────────────────────────────────────────
    const [scannerTarget, setScannerTarget]   = useState<"product"|"location"|null>(null);
    const [scannerRunning, setScannerRunning] = useState(false);
    const [torchAvailable, setTorchAvailable] = useState(false);
    const [torchOn, setTorchOn]               = useState(false);
    const [scanningRowIndex, setScanningRowIndex] = useState<number>(0);
    const scannerRef         = useRef<any>(null);
    const scanHandledRef     = useRef(false);
    const overlayOpenedRef   = useRef(false);
    const scannerContainerId = "cyclic-scanner";

    // ─── Validador: filtros ──────────────────────────────────
    // valTab ahora tiene 3 valores: "asignar" | "registros" | "resumen"
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
    const [editingUser, setEditingUser]       = useState<CyclicUser|null>(null);
    const [editUserRole, setEditUserRole]     = useState<Role>("Operario");

    // ─── Terminar sesión de conteo ───────────────────────────
    const [showFinishModal, setShowFinishModal] = useState(false);
    const [sessionFinished, setSessionFinished] = useState(false);
    const [editUserStoreId, setEditUserStoreId] = useState("");
    const [editUserAllStores, setEditUserAllStores] = useState(false);
    const [editUserActive, setEditUserActive] = useState(true);
    const [editUserPassword, setEditUserPassword] = useState("");

    // ════════════════════════════════════════════════════════
    //  INIT — con persistencia de tab activo en sessionStorage
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

                // Restaurar tab guardado o usar el default según rol
                const savedTab = sessionStorage.getItem("cyclic_active_tab") as TabKey | null;
                if (savedTab) {
                    // Validar que el tab guardado sea accesible según rol
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

                // Restaurar sub-tab del validador
                const savedValTab = sessionStorage.getItem("cyclic_val_tab") as "asignar"|"registros"|"resumen" | null;
                if (savedValTab) setValTab(savedValTab);

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
        }
    }, [user]);

    // Guardar tab activo en sessionStorage cuando cambia
    useEffect(() => {
        if (activeTab) sessionStorage.setItem("cyclic_active_tab", activeTab);
    }, [activeTab]);

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
        const anyOpen = !!scannerTarget || !!editingCount || !!editingProduct || !!activeAssignment || !!editingUser;
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
        };
        window.addEventListener("popstate", handler);
        return () => window.removeEventListener("popstate", handler);
    }, [scannerTarget, editingCount, editingProduct, activeAssignment, editingUser]);

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

    function confirmFinishSession() {
        setShowFinishModal(false);
        setSessionFinished(true);
        showMessage(`✅ Sesión de conteo finalizada. ${doneAssignments.length} producto${doneAssignments.length !== 1 ? "s" : ""} contado${doneAssignments.length !== 1 ? "s" : ""}. ¡Buen trabajo!`, "success");
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
            cost: a.cyclic_products?.cost,
        }));
        setAssignments(rows);

        if (rows.length === 0) { setCounts([]); return; }
        const assignIds = rows.map(r => r.id);
        const { data: cnts } = await supabase.from("cyclic_counts").select("*").in("assignment_id", assignIds);
        const cRows = (cnts || []) as CountRecord[];
        const enriched = cRows.map(c => {
            const asg = rows.find(a => a.id === c.assignment_id);
            const diff = Number(c.counted_quantity) - Number(asg?.system_stock || 0);
            return { ...c, sku: asg?.sku, description: asg?.description, unit: asg?.unit, cost: asg?.cost, system_stock: asg?.system_stock, difference: diff };
        });
        setCounts(enriched);
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
            cost: a.cyclic_products?.cost, store_name: a.stores?.name,
        }));
        setAssignments(rows);

        if (rows.length === 0) { setCounts([]); return; }
        const assignIds = rows.map(r => r.id);
        const { data: cnts } = await supabase.from("cyclic_counts").select("*").in("assignment_id", assignIds);
        const cRows = (cnts || []) as CountRecord[];
        const enriched = cRows.map(c => {
            const asg = rows.find(a => a.id === c.assignment_id);
            const diff = Number(c.counted_quantity) - Number(asg?.system_stock || 0);
            return { ...c, sku: asg?.sku, description: asg?.description, unit: asg?.unit, cost: asg?.cost, system_stock: asg?.system_stock, difference: diff, store_name: asg?.store_name };
        });
        setCounts(enriched);
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

    async function uploadBulkAssign() {
        if (!bulkAssignFile) { showMessage("Selecciona un archivo Excel.", "error"); return; }
        if (!valStoreId || !valDate) { showMessage("Selecciona tienda y fecha antes.", "error"); return; }
        try {
            const data = await bulkAssignFile.arrayBuffer();
            const wb = XLSX.read(data, { type: "array" });
            const sheet = wb.Sheets[wb.SheetNames[0]];
            const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
            let ok = 0, skip = 0, notFound = 0;
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                setBulkAssignProgress({ step: `Procesando ${i + 1} / ${rows.length}...`, pct: Math.round(((i + 1) / rows.length) * 100) });
                const rawSku = cleanCode(String(row["CODIGO"] || ""));
                const stock = Number(row["Stock"] || row["STOCK"] || 0);
                const cost = Number(row["COSTO"] || 0);
                if (!rawSku) { skip++; continue; }
                let prod: Product | null = null;
                const { data: byS } = await supabase.from("cyclic_products").select("*").eq("sku", rawSku).maybeSingle();
                if (byS) prod = byS as Product;
                if (!prod) {
                    const { data: byB } = await supabase.from("cyclic_products").select("*").ilike("barcode", rawSku).maybeSingle();
                    if (byB) prod = byB as Product;
                }
                if (!prod) { notFound++; continue; }
                const { data: existing } = await supabase.from("cyclic_assignments")
                    .select("id").eq("store_id", valStoreId).eq("product_id", prod.id).eq("assigned_date", valDate).maybeSingle();
                if (existing) { skip++; continue; }
                if (cost > 0) {
                    await supabase.from("cyclic_products").update({ cost, updated_at: new Date().toISOString() }).eq("id", prod.id);
                }
                await supabase.from("cyclic_assignments").insert({
                    store_id: valStoreId, product_id: prod.id, system_stock: stock,
                    assigned_date: valDate, assigned_by: user?.id,
                });
                ok++;
            }
            setBulkAssignProgress(null);
            showMessage(`✅ ${ok} productos asignados. ${skip} duplicados. ${notFound} no encontrados en maestro.`, ok > 0 ? "success" : "error");
            setBulkAssignFile(null); setBulkAssignFileName("");
            loadValidadorData(valStoreId, valDate);
        } catch (e: any) {
            setBulkAssignProgress(null);
            showMessage("Error leyendo el archivo: " + e.message, "error");
        }
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
            const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
            const map = new Map<string, any>();
            for (const row of rows) {
                const rawSku = (row["CODIGO SHELL"] || row["CODIGO"] || row["SKU"] || row["sku"] || row["codigo"] || "");
                const sku = cleanCode(String(rawSku));
                if (!sku) continue;
                const desc = String(row["Descripcion 1"] || row["DESCRIPCION"] || row["description"] || "").trim();
                if (!desc) continue;
                const unit = String(row["U.Minima"] || row["Un.Min."] || row["UNIDAD DE MEDIDA"] || row["unit"] || "NIU").trim() || "NIU";
                const cost = Number(row["Costo Prom"] || row["Ult Costo"] || row["COSTO"] || row["cost"] || 0);
                const barcode = cleanCode(String(row["Cod.Barra"] || row["UPC"] || row["BARCODE"] || row["barcode"] || "")) || null;
                map.set(normalizeText(sku), {
                    sku, barcode, description: desc, unit, cost, is_active: true,
                    updated_at: new Date().toISOString(),
                });
            }
            if (map.size === 0) { showMessage("Archivo sin filas válidas. Columnas buscadas: CODIGO SHELL (o SKU), Descripcion 1 (o DESCRIPCION).", "error"); return; }
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
        const { error } = await supabase.from("cyclic_users").insert({
            username: newUsername.trim().toLowerCase(), password: newPassword.trim(),
            full_name: newFullName.trim(), role: newRole,
            store_id: newRole === "Operario" ? (newUserStoreId || null) : null,
            can_access_all_stores: newRole !== "Operario",
            is_active: true,
        });
        if (error) { showMessage("Error: " + error.message, "error"); return; }
        showMessage("✅ Usuario creado.", "success");
        setNewUsername(""); setNewPassword(""); setNewFullName(""); setNewRole("Operario"); setNewUserStoreId("");
        loadAllUsers();
    }

    function openEditUser(u: CyclicUser) {
        setEditingUser(u);
        setEditUserRole(u.role);
        setEditUserStoreId(u.store_id || "");
        setEditUserAllStores(u.can_access_all_stores);
        setEditUserActive(u.is_active);
        setEditUserPassword("");
    }

    async function saveEditUser() {
        if (!editingUser) return;
        const updates: any = {
            role: editUserRole,
            store_id: editUserRole === "Operario" ? (editUserStoreId || null) : null,
            can_access_all_stores: editUserRole !== "Operario",
            is_active: editUserActive,
            updated_at: new Date().toISOString(),
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
    }

    function openScanner(target: "product"|"location", rowIndex: number = 0) {
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

    // ════════════════════════════════════════════════════════
    //  COMPUTED
    // ════════════════════════════════════════════════════════
    const myAssignments = useMemo(() => {
        const myCountIds = new Set(counts.map(c => c.assignment_id));
        return assignments.map(a => ({ ...a, counted: myCountIds.has(a.id), count_id: counts.find(c => c.assignment_id === a.id)?.id }));
    }, [assignments, counts]);

    const pendingAssignments = useMemo(() => myAssignments.filter(a => !a.counted), [myAssignments]);
    const doneAssignments    = useMemo(() => myAssignments.filter(a =>  a.counted), [myAssignments]);

    // Filtro para la vista "Registros" (sin diferencia/stock, solo registros individuales)
    const filteredCounts = useMemo(() => {
        return counts.filter(c => {
            const text = [c.sku, c.description, c.location, c.user_name, c.validator_name].join(" ").toLowerCase();
            const textOk = valSearchText ? text.includes(valSearchText.toLowerCase()) : true;
            const statusOk = valStatusFilter === "todos" ? true : c.status.toLowerCase() === valStatusFilter;
            return textOk && statusOk;
        });
    }, [counts, valSearchText, valStatusFilter]);

    // Resumen agrupado por product_id (suma conteos del mismo código)
    const resumenPorCodigo = useMemo((): ResumenRow[] => {
        const map = new Map<string, ResumenRow>();

        // Primero cargar todos los asignados
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
            }
        }

        // Sumar conteos por product_id
        for (const c of counts) {
            const entry = map.get(c.product_id);
            if (entry) {
                entry.total_counted += Number(c.counted_quantity);
            }
        }

        // Calcular diferencia y diferencia valorizada
        for (const entry of map.values()) {
            entry.difference = entry.total_counted - entry.system_stock;
            entry.dif_valorizada = entry.difference * entry.cost;
        }

        return Array.from(map.values()).sort((a, b) => a.sku.localeCompare(b.sku));
    }, [assignments, counts]);

    // Filtro para el resumen por código
    const filteredResumen = useMemo(() => {
        if (!resumenSearch.trim()) return resumenPorCodigo;
        const q = resumenSearch.trim().toLowerCase();
        return resumenPorCodigo.filter(r =>
            r.sku.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
        );
    }, [resumenPorCodigo, resumenSearch]);

    // Productos sin contar (ningún conteo registrado para su assignment)
    const notCountedAssignments = useMemo(() => {
        const countedProductIds = new Set(counts.map(c => c.product_id));
        // Necesitamos los que no tienen NINGÚN conteo para ese product_id en el día
        const countedPids = new Set<string>();
        for (const c of counts) countedPids.add(c.product_id);
        // Devolver assignments únicos por product_id que no fueron contados
        const seen = new Set<string>();
        return assignments.filter(a => {
            if (seen.has(a.product_id)) return false;
            seen.add(a.product_id);
            return !countedPids.has(a.product_id);
        });
    }, [assignments, counts]);

    const resumenStats = useMemo(() => {
        const total = resumenPorCodigo.length; // conteo por código único
        const contados = resumenPorCodigo.filter(r => r.total_counted > 0 || counts.some(c => c.product_id === r.product_id)).length;
        const pendientes = total - contados;
        // conDif: por código (diferencia != 0)
        const conDif = resumenPorCodigo.filter(r => {
            // solo considerar si fue contado
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
        <main className="min-h-screen bg-slate-50">
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
                        <div className="flex gap-1">
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
            {activeTab === "operario" && user?.role === "Operario" && (
                <>
                    <section className="bg-white rounded-3xl p-5 shadow space-y-3">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                            <div>
                                <h2 className="text-xl font-bold text-slate-900">Mis conteos de hoy</h2>
                                <p className="text-slate-500 text-sm">{allStores.find(s => s.id === selectedStoreId)?.name || "—"} · {selectedDate}</p>
                            </div>
                            <div className="flex gap-3 items-center">
                                <input type="date" className="border rounded-2xl px-3 py-2 text-sm" value={selectedDate} onChange={e => { setSelectedDate(e.target.value); loadOperarioData(selectedStoreId, e.target.value); }} />
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
                            {!sessionFinished ? (
                                <button
                                    onClick={handleFinishSessionClick}
                                    className="w-full mt-2 py-3 rounded-2xl font-bold text-sm border-2 border-green-600 text-green-700 bg-green-50 hover:bg-green-100 transition-colors flex items-center justify-center gap-2"
                                >
                                    <span>🏁</span> Terminar mi conteo de hoy
                                </button>
                            ) : (
                                <div className="w-full mt-2 py-3 rounded-2xl font-bold text-sm bg-green-100 text-green-800 text-center flex items-center justify-center gap-2 border border-green-300">
                                    <span>✅</span> Sesión finalizada — {doneAssignments.length} producto{doneAssignments.length !== 1 ? "s" : ""} contado{doneAssignments.length !== 1 ? "s" : ""}
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
                                    return (
                                        <div key={a.id} className="border rounded-2xl p-3 bg-green-50 border-green-200">
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="flex-1 min-w-0">
                                                    <div className="font-semibold text-slate-900 truncate">{a.sku}</div>
                                                    <div className="text-xs text-slate-600 truncate">{a.description}</div>
                                                </div>
                                                <button className="px-3 py-2 rounded-xl border text-xs font-semibold" onClick={() => openCount(a)}>Recontar</button>
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
                TAB VALIDADOR
            ════════════════════════════════════════════════════════ */}
            {activeTab === "validador" && isValOrAdm && (
                <>
                    {/* Selector tienda/fecha */}
                    <section className="bg-white rounded-3xl p-5 shadow">
                        <div className="flex flex-wrap gap-3 items-end">
                            <div className="flex-1 min-w-[160px]">
                                <label className="block text-xs font-semibold text-slate-600 mb-1">Tienda</label>
                                <select className="w-full border rounded-2xl p-3 text-sm" value={valStoreId} onChange={e => { setValStoreId(e.target.value); loadValidadorData(e.target.value, valDate); }}>
                                    <option value="">— Selecciona tienda —</option>
                                    {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-semibold text-slate-600 mb-1">Fecha</label>
                                <input type="date" className="border rounded-2xl p-3 text-sm" value={valDate} onChange={e => { setValDate(e.target.value); if (valStoreId) loadValidadorData(valStoreId, e.target.value); }} />
                            </div>
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
                            {/* Barra de progreso del validador */}
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

                                {/* Búsqueda individual */}
                                <div className="space-y-2">
                                    <input
                                        className="w-full border rounded-2xl p-3 text-sm"
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
                                                                        className="w-24 border rounded-xl p-1.5 text-sm"
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
                                        <p className="text-sm font-semibold text-slate-700">Carga masiva por Excel</p>
                                        <p className="text-xs text-slate-400 mt-0.5">Columnas: <b>CODIGO</b>, <b>DESCRIPCION</b>, <b>COSTO</b>, <b>UNIDAD DE MEDIDA</b>, <b>Stock</b>.</p>
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
                                        <button className="px-4 py-2.5 rounded-2xl border font-semibold text-sm" onClick={() => bulkAssignRef.current?.click()}>
                                            {bulkAssignFileName || "Seleccionar Excel"}
                                        </button>
                                        <input ref={bulkAssignRef} type="file" accept=".xlsx,.xls" className="hidden"
                                            onChange={e => { const f = e.target.files?.[0] || null; setBulkAssignFile(f); setBulkAssignFileName(f?.name || ""); e.target.value = ""; }} />
                                        {bulkAssignFile && (
                                            <button className="px-4 py-2.5 rounded-2xl bg-slate-900 text-white font-semibold text-sm" onClick={uploadBulkAssign}>Cargar</button>
                                        )}
                                    </div>
                                </div>
                            </section>

                            {/* Lista asignados del día */}
                            {assignments.length > 0 && (
                                <section className="bg-white rounded-3xl p-5 shadow space-y-3">
                                    <h3 className="font-bold text-slate-900">Asignados este día ({assignments.length})</h3>
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

                    {/* ── SUB-TAB: REGISTROS ───────────────────────────────
                        Muestra cada registro individual: SKU, Descripción,
                        Ubicación, Cantidad contada, Usuario, Hora.
                        SIN diferencia ni stock de sistema.
                    ════════════════════════════════════════════════════ */}
                    {valTab === "registros" && (
                        <section className="bg-white rounded-3xl p-5 shadow space-y-4">
                            <div className="flex flex-wrap gap-3 items-center justify-between">
                                <div>
                                    <h3 className="text-lg font-bold text-slate-900">Registros de conteo</h3>
                                    <p className="text-slate-500 text-xs mt-0.5">{filteredCounts.length} registro{filteredCounts.length !== 1 ? "s" : ""} encontrado{filteredCounts.length !== 1 ? "s" : ""}</p>
                                </div>
                                <button className="px-4 py-2 rounded-2xl border text-sm font-semibold" onClick={exportCounts}>↓ Excel registros</button>
                            </div>

                            {/* Filtros */}
                            <div className="flex gap-3 flex-wrap">
                                <input className="flex-1 border rounded-2xl p-3 text-sm min-w-[180px]" placeholder="Buscar SKU, descripción, usuario..." value={valSearchText} onChange={e => setValSearchText(e.target.value)} />
                                <select className="border rounded-2xl p-3 text-sm" value={valStatusFilter} onChange={e => setValStatusFilter(e.target.value)}>
                                    <option value="todos">Todos los estados</option>
                                    <option value="pendiente">Pendiente</option>
                                    <option value="diferencia">Diferencia</option>
                                    <option value="validado">Validado</option>
                                    <option value="corregido">Corregido</option>
                                </select>
                            </div>

                            {/* Tabla de registros individuales */}
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

                    {/* ── SUB-TAB: RESUMEN POR CÓDIGO ──────────────────────
                        Agrupa conteos por SKU, suma cantidades de múltiples
                        registros del mismo código, calcula diferencia
                        (total_contado - stock_sistema) y diferencia
                        valorizada (diferencia × costo).
                        Incluye tabla de productos NO contados con datos
                        completos: código, descripción, UM, costo, stock,
                        diferencia valorizada potencial.
                    ════════════════════════════════════════════════════ */}
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
                                <button className="px-4 py-2 rounded-2xl border text-sm font-semibold" onClick={exportResumen}>↓ Excel resumen</button>
                            </div>

                            {/* Búsqueda en resumen */}
                            <input
                                className="w-full border rounded-2xl p-3 text-sm"
                                placeholder="Buscar SKU o descripción..."
                                value={resumenSearch}
                                onChange={e => setResumenSearch(e.target.value)}
                            />

                            {/* Tabla resumen por código (solo contados) */}
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

                            {/* Tabla productos NO contados con datos completos */}
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
                        {(["productos","tiendas","usuarios"] as const).map(t => (
                            <button key={t} onClick={() => setAdminTab(t)} className={`px-5 py-2.5 rounded-2xl font-semibold text-sm border capitalize transition ${adminTab === t ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-300"}`}>
                                {t === "productos" ? "🗃 Maestro" : t === "tiendas" ? "🏪 Tiendas" : "👤 Usuarios"}
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
                                    <p className="text-xs text-slate-400">Columnas: <b>CODIGO</b> (o CODIGO SHELL / SKU), <b>DESCRIPCION</b> (o Descripcion 1), <b>UNIDAD DE MEDIDA</b></p>
                                    {uploadProgress && (
                                        <div className="rounded-xl bg-blue-50 border border-blue-200 p-3 space-y-1">
                                            <p className="text-xs font-semibold text-blue-800">{uploadProgress.step}</p>
                                            <div className="h-2 bg-blue-200 rounded-full overflow-hidden">
                                                <div className="h-full bg-blue-600 rounded-full transition-all" style={{ width: `${uploadProgress.pct}%` }} />
                                            </div>
                                        </div>
                                    )}
                                    <div className="flex gap-3 flex-wrap items-center">
                                        <button className="px-4 py-2.5 rounded-2xl border font-semibold text-sm bg-white" onClick={() => masterInputRef.current?.click()}>
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
                                        <button className="px-4 py-2.5 rounded-2xl border font-semibold text-sm bg-white" onClick={() => barcodesInputRef.current?.click()}>
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
                                    <input className="border rounded-2xl px-3 py-2 text-sm w-64" placeholder="Buscar SKU o descripción..." value={prodSearch} onChange={e => setProdSearch(e.target.value)} />
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
                                    <input className="flex-1 border rounded-2xl p-3 text-sm bg-white min-w-[160px]" placeholder="Nombre de la tienda" value={newStoreName} onChange={e => setNewStoreName(e.target.value)} />
                                    <input className="w-32 border rounded-2xl p-3 text-sm bg-white" placeholder="Código" value={newStoreCode} onChange={e => setNewStoreCode(e.target.value)} />
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
                                    <input className="border rounded-2xl p-3 text-sm bg-white" placeholder="Nombre de usuario" value={newUsername} onChange={e => setNewUsername(e.target.value)} />
                                    <input className="border rounded-2xl p-3 text-sm bg-white" placeholder="Contraseña" value={newPassword} onChange={e => setNewPassword(e.target.value)} />
                                    <input className="border rounded-2xl p-3 text-sm bg-white md:col-span-2" placeholder="Nombre completo" value={newFullName} onChange={e => setNewFullName(e.target.value)} />
                                    <div>
                                        <label className="text-xs text-slate-500 block mb-1">Rol</label>
                                        <select className="w-full border rounded-2xl p-3 text-sm bg-white" value={newRole} onChange={e => { setNewRole(e.target.value as Role); if (e.target.value !== "Operario") setNewUserAllStores(true); }}>
                                            <option value="Operario">Operario</option>
                                            <option value="Validador">Validador</option>
                                            <option value="Administrador">Administrador</option>
                                        </select>
                                    </div>
                                    {newRole === "Operario" && (
                                        <div>
                                            <label className="text-xs text-slate-500 block mb-1">Tienda asignada</label>
                                            <select className="w-full border rounded-2xl p-3 text-sm bg-white" value={newUserStoreId} onChange={e => setNewUserStoreId(e.target.value)}>
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
                                <p className="text-xs text-slate-400 mt-0.5">UM: {activeAssignment.unit} · Stock sistema: <b>{activeAssignment.system_stock}</b></p>
                            </div>
                            <button className="text-slate-400 hover:text-slate-600 text-2xl leading-none" onClick={() => setActiveAssignment(null)}>×</button>
                        </div>

                        {/* Filas de ubicación + cantidad */}
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
                                    <div className="flex gap-2">
                                        <div className="flex-1">
                                            <label className="text-xs text-slate-500 block mb-1">Ubicación</label>
                                            <div className="flex gap-1">
                                                <input
                                                    className="flex-1 border rounded-xl p-2.5 text-sm"
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
                                        <div className="w-24">
                                            <label className="text-xs text-slate-500 block mb-1">Cantidad</label>
                                            <input
                                                className="w-full border rounded-xl p-2.5 text-sm text-center font-semibold"
                                                type="number"
                                                min="0"
                                                placeholder="0"
                                                value={row.qty}
                                                onChange={e => updateLocationRow(i, "qty", e.target.value)}
                                            />
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="flex gap-3">
                            <button className="flex-1 py-3 rounded-2xl bg-slate-900 text-white font-bold text-sm" onClick={saveCount}>
                                Guardar conteo
                            </button>
                            <button className="px-5 py-3 rounded-2xl border font-semibold text-sm" onClick={() => setActiveAssignment(null)}>
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
                                <label className="block text-sm font-semibold mb-1">Cantidad contada</label>
                                <input className="w-full border rounded-2xl p-3 text-center font-semibold" type="number" min="0" value={editQty} onChange={e => setEditQty(e.target.value)} />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold mb-1">Ubicación</label>
                                <input className="w-full border rounded-2xl p-3 font-mono" value={editLocation} onChange={e => setEditLocation(e.target.value)} />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold mb-1">Estado</label>
                                <select className="w-full border rounded-2xl p-3" value={editStatus} onChange={e => setEditStatus(e.target.value as CountRecord["status"])}>
                                    <option value="Pendiente">Pendiente</option>
                                    <option value="Diferencia">Diferencia</option>
                                    <option value="Validado">Validado</option>
                                    <option value="Corregido">Corregido</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold mb-1">Nota</label>
                                <input className="w-full border rounded-2xl p-3" placeholder="Opcional..." value={editNote} onChange={e => setEditNote(e.target.value)} />
                            </div>
                        </div>
                        <div className="flex gap-3 pt-1">
                            <button className="flex-1 py-3 rounded-2xl bg-slate-900 text-white font-semibold" onClick={saveEditCount}>Guardar</button>
                            <button className="px-5 py-3 rounded-2xl border font-semibold" onClick={() => setEditingCount(null)}>Cancelar</button>
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
                                <label className="block font-semibold text-sm mb-1">SKU</label>
                                <input className="w-full border rounded-2xl p-3" value={editProdSku} onChange={e => setEditProdSku(e.target.value)} />
                            </div>
                            <div>
                                <label className="block font-semibold text-sm mb-1">Código de barra</label>
                                <input className="w-full border rounded-2xl p-3 font-mono" value={editProdBarcode} onChange={e => setEditProdBarcode(e.target.value)} placeholder="Opcional" />
                            </div>
                            <div className="md:col-span-2">
                                <label className="block font-semibold text-sm mb-1">Descripción</label>
                                <input className="w-full border rounded-2xl p-3" value={editProdDesc} onChange={e => setEditProdDesc(e.target.value)} />
                            </div>
                            <div>
                                <label className="block font-semibold text-sm mb-1">Unidad de medida</label>
                                <input className="w-full border rounded-2xl p-3" value={editProdUnit} onChange={e => setEditProdUnit(e.target.value)} />
                            </div>
                            <div>
                                <label className="block font-semibold text-sm mb-1">Costo unitario</label>
                                <input className="w-full border rounded-2xl p-3" type="number" value={editProdCost} onChange={e => setEditProdCost(e.target.value)} />
                            </div>
                        </div>
                        <div className="flex gap-3 pt-1">
                            <button className="flex-1 py-3 rounded-2xl bg-slate-900 text-white font-semibold" onClick={saveEditProduct}>Guardar cambios</button>
                            <button className="px-5 py-3 rounded-2xl border font-semibold" onClick={() => setEditingProduct(null)}>Cancelar</button>
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
                                <label className="block text-sm font-semibold mb-1">Rol</label>
                                <select className="w-full border rounded-2xl p-3" value={editUserRole} onChange={e => { setEditUserRole(e.target.value as Role); if (e.target.value !== "Operario") setEditUserAllStores(true); }}>
                                    <option value="Operario">Operario</option>
                                    <option value="Validador">Validador</option>
                                    <option value="Administrador">Administrador</option>
                                </select>
                            </div>
                            {editUserRole === "Operario" && (
                                <div>
                                    <label className="block text-sm font-semibold mb-1">Tienda asignada</label>
                                    <select className="w-full border rounded-2xl p-3" value={editUserStoreId} onChange={e => setEditUserStoreId(e.target.value)}>
                                        <option value="">— Sin asignar —</option>
                                        {allStores.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                    </select>
                                </div>
                            )}
                            <div>
                                <label className="block text-sm font-semibold mb-1">Nueva contraseña <span className="text-slate-400 font-normal">(dejar vacío para no cambiar)</span></label>
                                <input className="w-full border rounded-2xl p-3" placeholder="Nueva contraseña..." value={editUserPassword} onChange={e => setEditUserPassword(e.target.value)} />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold mb-1">Estado</label>
                                <div className="flex gap-3">
                                    <button className={`flex-1 py-2.5 rounded-xl font-semibold text-sm border ${editUserActive ? "bg-green-600 text-white border-green-600" : "bg-white text-slate-700 border-slate-300"}`} onClick={() => setEditUserActive(true)}>✓ Activo</button>
                                    <button className={`flex-1 py-2.5 rounded-xl font-semibold text-sm border ${!editUserActive ? "bg-red-500 text-white border-red-500" : "bg-white text-slate-700 border-slate-300"}`} onClick={() => setEditUserActive(false)}>Inactivo</button>
                                </div>
                            </div>
                        </div>
                        <div className="flex gap-3 pt-1">
                            <button className="flex-1 py-3 rounded-2xl bg-slate-900 text-white font-semibold" onClick={saveEditUser}>Guardar cambios</button>
                            <button className="px-5 py-3 rounded-2xl border font-semibold" onClick={() => setEditingUser(null)}>Cancelar</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ════════════════════════════════════════════════════════
                MODAL — TERMINAR SESIÓN DE CONTEO (Operario)
            ════════════════════════════════════════════════════════ */}
            {showFinishModal && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-3xl p-6 w-full max-w-sm space-y-5 shadow-2xl">
                        <div className="text-center space-y-2">
                            <div className="text-5xl">⚠️</div>
                            <h3 className="text-xl font-bold text-slate-900">¿Terminar conteo?</h3>
                            <p className="text-slate-600 text-sm leading-relaxed">
                                Aún tienes <span className="font-bold text-amber-700">{pendingAssignments.length} código{pendingAssignments.length !== 1 ? "s" : ""} sin contar</span>.
                                ¿Deseas terminar tu sesión de hoy de todas formas?
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
                OVERLAY — ESCÁNER DE CÁMARA
            ════════════════════════════════════════════════════════ */}
            {scannerTarget && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-[60]">
                    <div className="bg-white w-full max-w-lg rounded-3xl p-5 shadow-2xl space-y-4">
                        <div>
                            <h3 className="text-xl font-bold text-slate-900">
                                {scannerTarget === "product" ? "Escanear producto" : `Escanear ubicación ${locationRows.length > 1 ? scanningRowIndex + 1 : ""}`}
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
                        <button onClick={closeScanner} className="w-full px-4 py-3 rounded-2xl border font-semibold">Cerrar cámara</button>
                    </div>
                </div>
            )}
        </main>
    );
}