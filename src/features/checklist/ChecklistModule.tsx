"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Home, Loader2, Plus, RefreshCw, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase/client";
import { readStoredUser } from "@/lib/singleDeviceSession";
import { canAccessModule } from "@/features/access/moduleAccess";
import { fetchDisabledModules, isModuleBlockedForUser } from "@/features/access/moduleFlags";
import ModuleDisabledScreen from "@/features/access/ModuleDisabledScreen";
import type { CyclicUser, Store } from "@/features/ciclicos/types";

// ─── Constantes ─────────────────────────────────────────────────────────────

type ChecklistStatus = "cumple" | "no_cumple" | "justificado";
type ChecklistItemKey =
  | "check_list_diario"
  | "fotos_almacen"
  | "orden_limpieza"
  | "documentos_al_dia"
  | "conteo_ciclico"
  | "reporte_incidencias"
  | "reduccion_productos_x";

// Los 7 puntos son fijos (ver hoja INFO del Sheet original) - no hace falta
// una tabla catalogo en BD para algo que no cambia.
const CHECKLIST_ITEMS: { key: ChecklistItemKey; label: string }[] = [
  { key: "check_list_diario", label: "Check list diario" },
  { key: "fotos_almacen", label: "Fotos de almacén" },
  { key: "orden_limpieza", label: "Orden y limpieza" },
  { key: "documentos_al_dia", label: "Documentos al día" },
  { key: "conteo_ciclico", label: "Conteo cíclico" },
  { key: "reporte_incidencias", label: "Reporte de incidencias" },
  { key: "reduccion_productos_x", label: "Reducción de productos X" },
];

const AUDITOR_ROLES = ["Validador", "Supervisor", "Administrador", "Operario"];

type MyStore = { id: string; store_id: string; store_name: string };
type Assignment = { id: string; store_id: string; auditor_user_id: string; store_name: string; auditor_name: string };
type ChecklistEntryRow = { item_key: string; entry_date: string; status: ChecklistStatus };
type ChecklistExportEntry = ChecklistEntryRow & {
  store_id: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type GeneralInventoryReportRow = {
  session_id: string;
  store_id: string;
  finished_at: string | null;
  total_codes: number;
  ok_codes: number;
  system_value: number;
  eri_pct: number;
  net_value_diff: number;
  sales_in_period: number | null;
  deviation_over_sales_pct: number | null;
};

type PeriodType = "dia" | "mes" | "rango";
type PeriodState = { type: PeriodType; date: string; month: string; from: string; to: string };

type ResumenRow = {
  store_id: string;
  store_name: string;
  auditor_name: string;
  cumplio: number;
  no_cumplio: number;
  justificado: number;
  pct: number;
  eri: number;
  session_count: number;
  cyclicEri: number;
  cyclicCountedItems: number;
  combined: number;
};

// >=90 verde, >=70 naranja, <70 rojo - pedido explicito del usuario para la
// columna final ponderada.
function scoreColorClass(value: number) {
  if (value >= 90) return "text-emerald-700";
  if (value >= 70) return "text-orange-600";
  return "text-red-600";
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function addDaysISO(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const current = new Date(year, month - 1, day);
  current.setDate(current.getDate() + days);
  return current.toISOString().slice(0, 10);
}
function monthLastDate(monthValue: string) {
  const [year, month] = monthValue.split("-").map(Number);
  return new Date(year, month, 0).getDate();
}
function localDateStartISO(date: string) {
  return new Date(`${date}T00:00:00`).toISOString();
}
function previousMonthValue(monthValue: string) {
  const [year, month] = monthValue.split("-").map(Number);
  const d = new Date(year, month - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function defaultPeriod(month: string): PeriodState {
  return { type: "mes", date: todayISO(), month, from: `${month}-01`, to: todayISO() };
}
function periodRange(p: PeriodState): { from: string; toExclusive: string; label: string } {
  if (p.type === "dia") {
    const date = p.date || todayISO();
    return { from: date, toExclusive: addDaysISO(date, 1), label: date };
  }
  if (p.type === "mes") {
    const month = p.month || todayISO().slice(0, 7);
    const to = `${month}-${String(monthLastDate(month)).padStart(2, "0")}`;
    return { from: `${month}-01`, toExclusive: addDaysISO(to, 1), label: month };
  }
  const rangeFrom = p.from || todayISO();
  const rangeTo = p.to || rangeFrom;
  const from = rangeFrom <= rangeTo ? rangeFrom : rangeTo;
  const to = rangeFrom <= rangeTo ? rangeTo : rangeFrom;
  return { from, toExclusive: addDaysISO(to, 1), label: `${from} al ${to}` };
}
function statusColor(status: ChecklistStatus | undefined) {
  if (status === "cumple") return "bg-emerald-100 text-emerald-700";
  if (status === "no_cumple") return "bg-red-100 text-red-600";
  if (status === "justificado") return "bg-amber-100 text-amber-700";
  return "bg-slate-100 text-slate-400";
}
function statusSymbol(status: ChecklistStatus | undefined) {
  if (status === "cumple") return "✓";
  if (status === "no_cumple") return "✗";
  if (status === "justificado") return "J";
  return "-";
}
function statusLabel(status: ChecklistStatus | undefined) {
  if (status === "cumple") return "Cumple";
  if (status === "no_cumple") return "No cumple";
  if (status === "justificado") return "Justificado";
  return "Sin registro";
}
function datesInRange(from: string, toExclusive: string) {
  const dates: string[] = [];
  for (let date = from; date < toExclusive; date = addDaysISO(date, 1)) dates.push(date);
  return dates;
}

// ─── Sub-componentes ────────────────────────────────────────────────────────

function PeriodPicker({ label, value, onChange }: { label: string; value: PeriodState; onChange: (next: PeriodState) => void }) {
  const tabClass = (active: boolean) => `rounded-lg px-2 py-1.5 text-xs font-black ${active ? "bg-slate-950 text-white" : "text-slate-500"}`;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <p className="mb-1 text-[11px] font-black uppercase text-slate-400">{label}</p>
        <div className="grid grid-cols-3 gap-1 rounded-xl border bg-slate-50 p-1">
          <button onClick={() => onChange({ ...value, type: "dia" })} className={tabClass(value.type === "dia")}>Dia</button>
          <button onClick={() => onChange({ ...value, type: "mes" })} className={tabClass(value.type === "mes")}>Mes</button>
          <button onClick={() => onChange({ ...value, type: "rango" })} className={tabClass(value.type === "rango")}>Rango</button>
        </div>
      </div>
      {value.type === "dia" && (
        <input type="date" value={value.date} onChange={e => onChange({ ...value, date: e.target.value })} className="rounded-xl border px-3 py-2 text-sm" />
      )}
      {value.type === "mes" && (
        <input type="month" value={value.month} onChange={e => onChange({ ...value, month: e.target.value })} className="rounded-xl border px-3 py-2 text-sm" />
      )}
      {value.type === "rango" && (
        <>
          <input type="date" value={value.from} onChange={e => onChange({ ...value, from: e.target.value })} className="rounded-xl border px-3 py-2 text-sm" />
          <input type="date" value={value.to} onChange={e => onChange({ ...value, to: e.target.value })} className="rounded-xl border px-3 py-2 text-sm" />
        </>
      )}
    </div>
  );
}

// ─── Página ─────────────────────────────────────────────────────────────────

export default function ChecklistModule() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [moduleDisabled, setModuleDisabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);

  // Vista auditor
  const [myStores, setMyStores] = useState<MyStore[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState("");
  // El auditor puede filtrar y modificar cualquier fecha pasada (no solo
  // hoy) - pedido explicito del usuario, antes solo se podia marcar el
  // dia actual.
  const [selectedDate, setSelectedDate] = useState(() => todayISO());
  const [dateEntries, setDateEntries] = useState<Record<string, ChecklistStatus>>({});
  const [savingItemKey, setSavingItemKey] = useState<string | null>(null);
  const [historyMonth, setHistoryMonth] = useState(todayISO().slice(0, 7));
  const [historyEntries, setHistoryEntries] = useState<ChecklistEntryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Vista admin/supervisor
  const [adminTab, setAdminTab] = useState<"resumen" | "asignaciones">("resumen");
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [checklistUsers, setChecklistUsers] = useState<CyclicUser[]>([]);
  const [newAssignmentStoreId, setNewAssignmentStoreId] = useState("");
  const [newAssignmentAuditorId, setNewAssignmentAuditorId] = useState("");
  const [savingAssignment, setSavingAssignment] = useState(false);
  const [deletingAssignmentId, setDeletingAssignmentId] = useState<string | null>(null);
  const [cumplimientoPeriod, setCumplimientoPeriod] = useState<PeriodState>(() => defaultPeriod(todayISO().slice(0, 7)));
  const [existenciaPeriod, setExistenciaPeriod] = useState<PeriodState>(() => defaultPeriod(previousMonthValue(todayISO().slice(0, 7))));
  const [resumenRows, setResumenRows] = useState<ResumenRow[]>([]);
  const [resumenLoading, setResumenLoading] = useState(false);
  const [downloadingDetail, setDownloadingDetail] = useState(false);
  const [downloadingEriConsolidated, setDownloadingEriConsolidated] = useState(false);

  const canManageChecklist = user?.role === "Administrador" || user?.role === "Supervisor";

  // ─── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    const stored = readStoredUser<CyclicUser>();
    if (!stored || !canAccessModule(stored, "checklist")) { window.location.replace("/"); return; }
    fetchDisabledModules().then(disabled => {
      if (!cancelled && isModuleBlockedForUser(disabled, "checklist", stored)) setModuleDisabled(true);
    });
    Promise.resolve().then(() => { if (!cancelled) setUser(stored); });
    supabase.from("stores").select("id,code,name,erp_sede,is_active").eq("is_active", true).order("name")
      .then(({ data }) => {
        if (cancelled) return;
        setStores((data || []) as Store[]);
        setReady(true);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!ready || !user) return;
    if (canManageChecklist) { void loadAssignments(); void loadChecklistUsers(); }
    else { void loadMyAssignments(user); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, user]);

  useEffect(() => {
    if (!selectedStoreId) return;
    void loadEntriesForDate(selectedStoreId, selectedDate);
    void loadMonthHistory(selectedStoreId, historyMonth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStoreId]);

  useEffect(() => {
    if (!selectedStoreId) return;
    void loadEntriesForDate(selectedStoreId, selectedDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  useEffect(() => {
    if (!selectedStoreId) return;
    void loadMonthHistory(selectedStoreId, historyMonth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyMonth]);

  useEffect(() => {
    if (canManageChecklist && stores.length > 0) void loadResumen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManageChecklist, stores, assignments, cumplimientoPeriod, existenciaPeriod]);

  // ─── Carga: vista auditor ───────────────────────────────────────────────────

  async function loadMyAssignments(currentUser: CyclicUser) {
    const { data, error } = await supabase
      .from("checklist_store_assignments")
      .select("id, store_id, stores(name)")
      .eq("auditor_user_id", currentUser.id)
      .order("id");
    if (error) { toast.error("Error cargando tiendas asignadas: " + error.message); return; }
    const rows = (data || []).map((r: any) => ({ id: r.id, store_id: r.store_id, store_name: r.stores?.name || "" })) as MyStore[];
    setMyStores(rows);
    if (rows.length > 0) setSelectedStoreId(prev => prev || rows[0].store_id);
  }

  async function loadEntriesForDate(storeId: string, date: string) {
    const { data, error } = await supabase
      .from("checklist_entries")
      .select("item_key, status")
      .eq("store_id", storeId)
      .eq("entry_date", date);
    if (error) { toast.error("Error cargando checklist del día: " + error.message); return; }
    const map: Record<string, ChecklistStatus> = {};
    for (const row of (data || []) as { item_key: string; status: ChecklistStatus }[]) map[row.item_key] = row.status;
    setDateEntries(map);
  }

  async function saveEntry(itemKey: ChecklistItemKey, status: ChecklistStatus) {
    if (!selectedStoreId || !user) return;
    setSavingItemKey(itemKey);
    try {
      const { error } = await supabase.from("checklist_entries").upsert({
        store_id: selectedStoreId,
        item_key: itemKey,
        entry_date: selectedDate,
        status,
        created_by: user.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: "store_id,item_key,entry_date" });
      if (error) throw error;
      setDateEntries(prev => ({ ...prev, [itemKey]: status }));
      if (historyMonth === selectedDate.slice(0, 7)) void loadMonthHistory(selectedStoreId, historyMonth);
    } catch (e: any) {
      toast.error("Error guardando: " + e.message);
    } finally {
      setSavingItemKey(null);
    }
  }

  async function loadMonthHistory(storeId: string, monthValue: string) {
    setHistoryLoading(true);
    try {
      const from = `${monthValue}-01`;
      const to = `${monthValue}-${String(monthLastDate(monthValue)).padStart(2, "0")}`;
      const { data, error } = await supabase
        .from("checklist_entries")
        .select("item_key, entry_date, status")
        .eq("store_id", storeId)
        .gte("entry_date", from)
        .lte("entry_date", to);
      if (error) throw error;
      setHistoryEntries((data || []) as ChecklistEntryRow[]);
    } catch (e: any) {
      toast.error("Error cargando historial: " + e.message);
    } finally {
      setHistoryLoading(false);
    }
  }

  // ─── Carga: vista admin/supervisor ─────────────────────────────────────────

  async function loadAssignments() {
    const { data, error } = await supabase
      .from("checklist_store_assignments")
      .select("id, store_id, auditor_user_id, stores(name), cyclic_users(full_name)")
      .order("created_at");
    if (error) { toast.error("Error cargando asignaciones: " + error.message); return; }
    setAssignments((data || []).map((r: any) => ({
      id: r.id,
      store_id: r.store_id,
      auditor_user_id: r.auditor_user_id,
      store_name: r.stores?.name || "",
      auditor_name: r.cyclic_users?.full_name || "",
    })));
  }

  async function loadChecklistUsers() {
    const { data, error } = await supabase
      .from("cyclic_users")
      .select("id, username, full_name, role, store_id, can_access_all_stores, module_access, is_active")
      .eq("is_active", true)
      .in("role", AUDITOR_ROLES)
      .order("full_name");
    if (error) { toast.error("Error cargando usuarios: " + error.message); return; }
    setChecklistUsers((data || []) as CyclicUser[]);
  }

  async function addAssignment() {
    if (!newAssignmentStoreId || !newAssignmentAuditorId) { toast.error("Selecciona tienda y auditor."); return; }
    setSavingAssignment(true);
    try {
      const { error } = await supabase.from("checklist_store_assignments").insert({
        store_id: newAssignmentStoreId,
        auditor_user_id: newAssignmentAuditorId,
      });
      if (error) throw error;
      setNewAssignmentStoreId("");
      setNewAssignmentAuditorId("");
      await loadAssignments();
    } catch (e: any) {
      toast.error(/duplicate key/i.test(e.message) ? "Esa tienda ya está asignada a ese auditor." : "Error asignando: " + e.message);
    } finally {
      setSavingAssignment(false);
    }
  }

  async function deleteAssignment(id: string) {
    setDeletingAssignmentId(id);
    try {
      const { error } = await supabase.from("checklist_store_assignments").delete().eq("id", id);
      if (error) throw error;
      setAssignments(prev => prev.filter(a => a.id !== id));
    } catch (e: any) {
      toast.error("Error quitando asignación: " + e.message);
    } finally {
      setDeletingAssignmentId(null);
    }
  }

  async function loadResumen() {
    setResumenLoading(true);
    try {
      const storeIds = stores.map(s => s.id);
      const cRange = periodRange(cumplimientoPeriod);
      const eRange = periodRange(existenciaPeriod);
      // El ERI de conteo ciclico usa el mismo periodo que Auditoria
      // Existencia (los dos son "ERI de existencia", solo cambia la fuente
      // de datos) - evita sumar un 3er selector de fecha a la pantalla.
      const [{ data: cData, error: cErr }, { data: eData, error: eErr }, { data: yData, error: yErr }] = await Promise.all([
        supabase.rpc("get_checklist_period_summary", { p_store_ids: storeIds, p_from: cRange.from, p_to: addDaysISO(cRange.toExclusive, -1) }),
        supabase.rpc("get_checklist_existencia_summary", { p_store_ids: storeIds, p_from: localDateStartISO(eRange.from), p_to: localDateStartISO(eRange.toExclusive) }),
        supabase.rpc("get_cyclic_period_summary", { p_store_ids: storeIds, p_from: eRange.from, p_to: addDaysISO(eRange.toExclusive, -1) }),
      ]);
      if (cErr) throw cErr;
      if (eErr) throw eErr;
      if (yErr) throw yErr;
      const cMap = new Map<string, { cumplio: number; no_cumplio: number; justificado: number; pct: number }>(
        (cData || []).map((r: any) => [r.store_id, r])
      );
      const eMap = new Map<string, { eri: number; session_count: number }>(
        (eData || []).map((r: any) => [r.store_id, r])
      );
      const yMap = new Map<string, { eri: number; counted_items: number }>(
        (yData || []).map((r: any) => [r.store_id, r])
      );
      const assignMap = new Map(assignments.map(a => [a.store_id, a.auditor_name]));
      const rows: ResumenRow[] = stores.map(s => {
        const c = cMap.get(s.id) || { cumplio: 0, no_cumplio: 0, justificado: 0, pct: 0 };
        const e = eMap.get(s.id) || { eri: 0, session_count: 0 };
        const y = yMap.get(s.id) || { eri: 0, counted_items: 0 };
        // La auditoría de existencia solo entra al promedio cuando tiene
        // sesiones. El checklist siempre participa y el cíclico sin datos
        // participa como 0, según la regla del indicador.
        const scoreParts: number[] = [Number(c.pct || 0), Number(y.eri || 0)];
        if (Number(e.session_count || 0) > 0) scoreParts.push(Number(e.eri || 0));
        const combined = scoreParts.length > 0
          ? Math.round(scoreParts.reduce((sum, value) => sum + value, 0) / scoreParts.length)
          : 0;
        return {
          store_id: s.id,
          store_name: s.name,
          auditor_name: assignMap.get(s.id) || "Sin asignar",
          cumplio: c.cumplio || 0,
          no_cumplio: c.no_cumplio || 0,
          justificado: c.justificado || 0,
          pct: c.pct || 0,
          eri: e.eri || 0,
          session_count: e.session_count || 0,
          cyclicEri: y.eri || 0,
          cyclicCountedItems: y.counted_items || 0,
          combined,
        };
      }).sort((a, b) => b.combined - a.combined);
      setResumenRows(rows);
    } catch (e: any) {
      toast.error("Error cargando resumen: " + e.message);
    } finally {
      setResumenLoading(false);
    }
  }

  async function downloadChecklistDetail() {
    if (stores.length === 0) return;
    setDownloadingDetail(true);
    try {
      const range = periodRange(cumplimientoPeriod);
      const storeIds = stores.map(store => store.id);
      const entries: ChecklistExportEntry[] = [];
      const pageSize = 1000;

      for (let from = 0; ; from += pageSize) {
        const { data, error } = await supabase
          .from("checklist_entries")
          .select("store_id, item_key, entry_date, status, notes, created_at, updated_at")
          .in("store_id", storeIds)
          .gte("entry_date", range.from)
          .lt("entry_date", range.toExclusive)
          .order("entry_date")
          .range(from, from + pageSize - 1);
        if (error) throw error;
        const page = (data || []) as ChecklistExportEntry[];
        entries.push(...page);
        if (page.length < pageSize) break;
      }

      const XLSX = await import("xlsx");
      const itemLabelByKey = new Map(CHECKLIST_ITEMS.map(item => [item.key, item.label]));
      const storeById = new Map(stores.map(store => [store.id, store.name]));
      const auditorByStoreId = new Map(assignments.map(assignment => [assignment.store_id, assignment.auditor_name]));
      const entriesByStoreDay = new Map<string, ChecklistExportEntry[]>();
      for (const entry of entries) {
        const key = `${entry.store_id}|${entry.entry_date}`;
        const current = entriesByStoreDay.get(key) || [];
        current.push(entry);
        entriesByStoreDay.set(key, current);
      }

      const dailyRows = stores.flatMap(store => datesInRange(range.from, range.toExclusive).map(date => {
        const dayEntries = entriesByStoreDay.get(`${store.id}|${date}`) || [];
        const statusByItem = new Map(dayEntries.map(entry => [entry.item_key, entry.status]));
        const cumplio = [...statusByItem.values()].filter(status => status === "cumple").length;
        const noCumplio = [...statusByItem.values()].filter(status => status === "no_cumple").length;
        const justificado = [...statusByItem.values()].filter(status => status === "justificado").length;
        const registrados = statusByItem.size;
        return {
          FECHA: date,
          TIENDA: store.name,
          AUDITOR_ASIGNADO: auditorByStoreId.get(store.id) || "Sin asignar",
          PUNTOS_CUMPLE: cumplio,
          PUNTOS_NO_CUMPLE: noCumplio,
          PUNTOS_JUSTIFICADOS: justificado,
          PUNTOS_SIN_REGISTRO: CHECKLIST_ITEMS.length - registrados,
          CUMPLIO_TODO_EL_DIA: cumplio === CHECKLIST_ITEMS.length ? "SI" : "NO",
          ESTADO_DIA: registrados === 0 ? "Sin registro" : cumplio === CHECKLIST_ITEMS.length ? "Cumplió" : "Con pendientes/incidencias",
        };
      }));

      const detailRows = entries.map(entry => ({
        FECHA: entry.entry_date,
        TIENDA: storeById.get(entry.store_id) || entry.store_id,
        AUDITOR_ASIGNADO: auditorByStoreId.get(entry.store_id) || "Sin asignar",
        PUNTO_CHECKLIST: itemLabelByKey.get(entry.item_key as ChecklistItemKey) || entry.item_key,
        ESTADO: statusLabel(entry.status),
        OBSERVACIONES: entry.notes || "",
        REGISTRADO_EL: entry.created_at,
        ACTUALIZADO_EL: entry.updated_at,
      })).sort((a, b) => (a.FECHA + a.TIENDA + a.PUNTO_CHECKLIST).localeCompare(b.FECHA + b.TIENDA + b.PUNTO_CHECKLIST));

      const dailySheet = XLSX.utils.json_to_sheet(dailyRows);
      dailySheet["!cols"] = [{ wch: 14 }, { wch: 28 }, { wch: 24 }, { wch: 15 }, { wch: 18 }, { wch: 20 }, { wch: 22 }, { wch: 22 }, { wch: 28 }];
      const detailSheet = XLSX.utils.json_to_sheet(detailRows);
      detailSheet["!cols"] = [{ wch: 14 }, { wch: 28 }, { wch: 24 }, { wch: 30 }, { wch: 16 }, { wch: 38 }, { wch: 23 }, { wch: 23 }];
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, dailySheet, "Cumplimiento diario");
      XLSX.utils.book_append_sheet(workbook, detailSheet, "Detalle por punto");
      XLSX.writeFile(workbook, `checklist_${range.from}_a_${addDaysISO(range.toExclusive, -1)}.xlsx`);
    } catch (e: any) {
      toast.error("Error descargando detalle: " + e.message);
    } finally {
      setDownloadingDetail(false);
    }
  }

  async function downloadEriConsolidated() {
    if (stores.length === 0) return;
    setDownloadingEriConsolidated(true);
    try {
      const range = periodRange(existenciaPeriod);
      const dateTo = addDaysISO(range.toExclusive, -1);
      const storeIds = stores.map(store => store.id);
      const readPages = async (queryFactory: (from: number, to: number) => any) => {
        const rows: any[] = [];
        const pageSize = 1000;
        for (let from = 0; ; from += pageSize) {
          const { data, error } = await queryFactory(from, from + pageSize - 1);
          if (error) throw error;
          rows.push(...(data || []));
          if (!data || data.length < pageSize) break;
        }
        return rows;
      };
      const [auditResponse, generalRows] = await Promise.all([
        supabase.rpc("get_checklist_existencia_summary", {
          p_store_ids: storeIds,
          p_from: localDateStartISO(range.from),
          p_to: localDateStartISO(range.toExclusive),
        }),
        readPages((from, to) => supabase.rpc("get_finished_general_inventory_report", {
          p_date_from: range.from,
          p_date_to: dateTo,
        }).range(from, to)),
      ]);
      if (auditResponse.error) throw auditResponse.error;

      const auditSessionRows = await readPages((from, to) => supabase
        .from("audit_sessions")
        .select("id,store_id")
        .in("store_id", storeIds)
        .eq("status", "finished")
        .gte("started_at", localDateStartISO(range.from))
        .lt("started_at", localDateStartISO(range.toExclusive))
        .range(from, to));
      const auditSessionIds = auditSessionRows.map(row => String(row.id)).filter(Boolean);
      const auditSessionStoreById = new Map(auditSessionRows.map(row => [String(row.id), String(row.store_id)]));
      const readInChunks = async (table: string, select: string, column: string, values: string[]) => {
        const rows: any[] = [];
        for (let i = 0; i < values.length; i += 500) {
          const chunk = values.slice(i, i + 500);
          rows.push(...await readPages((from, to) => supabase.from(table).select(select).in(column, chunk).range(from, to)));
        }
        return rows;
      };
      const [auditItems, auditCounts, cyclicAssignments] = await Promise.all([
        readInChunks("audit_session_items", "id,session_id,product_id,system_stock,cost_snapshot", "session_id", auditSessionIds),
        readInChunks("audit_counts", "item_id,session_id", "session_id", auditSessionIds),
        readPages((from, to) => supabase
          .from("cyclic_assignments")
          .select("id,store_id,product_id,system_stock,assigned_date")
          .in("store_id", storeIds)
          .gte("assigned_date", range.from)
          .lte("assigned_date", dateTo)
          .range(from, to)),
      ]);
      const cyclicAssignmentIds = cyclicAssignments.map(row => String(row.id || "")).filter(Boolean);
      const cyclicCounts = await readInChunks("cyclic_counts", "assignment_id,counted_quantity,location", "assignment_id", cyclicAssignmentIds);
      const cyclicProductIds = [...new Set(cyclicAssignments.map(row => String(row.product_id || "")).filter(Boolean))];
      const cyclicProducts = await readInChunks("cyclic_products", "id,cost", "id", cyclicProductIds);
      const cyclicCostByProduct = new Map(cyclicProducts.map(row => [String(row.id), Number(row.cost || 0)]));
      const countedAuditItemIds = new Set(auditCounts.map(row => String(row.item_id || "")).filter(Boolean));
      const auditValueByProduct = new Map<string, number>();
      for (const row of auditItems) {
        if (!countedAuditItemIds.has(String(row.id))) continue;
        const storeId = auditSessionStoreById.get(String(row.session_id));
        const productId = String(row.product_id || "");
        if (!storeId || !productId) continue;
        const key = `${storeId}|${productId}`;
        const value = Number(row.system_stock || 0) * Number(row.cost_snapshot || 0);
        auditValueByProduct.set(key, Math.max(auditValueByProduct.get(key) || 0, value));
      }
      const auditValueByStore = new Map<string, number>();
      for (const [key, value] of auditValueByProduct) {
        const storeId = key.split("|")[0];
        auditValueByStore.set(storeId, (auditValueByStore.get(storeId) || 0) + value);
      }
      const cyclicByAssignment = new Map(cyclicAssignments.map(row => [String(row.id), row]));
      const cyclicCountsByAssignment = new Map<string, any[]>();
      const cyclicFlagsByDay = new Map<string, Set<string>>();
      const cyclicFlagValues = new Set(["__session_counting__", "__session_finished__", "__recount_started__", "__recount_done__"]);
      for (const count of cyclicCounts) {
        const assignment = cyclicByAssignment.get(String(count.assignment_id));
        if (!assignment) continue;
        const dayKey = `${assignment.store_id}|${assignment.assigned_date}`;
        if (cyclicFlagValues.has(String(count.location || ""))) {
          const flags = cyclicFlagsByDay.get(dayKey) || new Set<string>();
          flags.add(String(count.location));
          cyclicFlagsByDay.set(dayKey, flags);
          continue;
        }
        const counts = cyclicCountsByAssignment.get(String(count.assignment_id)) || [];
        counts.push(count);
        cyclicCountsByAssignment.set(String(count.assignment_id), counts);
      }
      const cyclicDays = new Map<string, { store_id: string; date: string; assignments: any[] }>();
      for (const assignment of cyclicAssignments) {
        const dayKey = `${assignment.store_id}|${assignment.assigned_date}`;
        const day = cyclicDays.get(dayKey) || { store_id: String(assignment.store_id), date: String(assignment.assigned_date), assignments: [] };
        day.assignments.push(assignment);
        cyclicDays.set(dayKey, day);
      }
      const cyclicByStore = new Map<string, { eri: number; counted_items: number; ok_items: number }>();
      const cyclicValueByProduct = new Map<string, number>();
      for (const [dayKey, day] of cyclicDays) {
        const countedAssignmentIds = new Set(day.assignments.filter(assignment => (cyclicCountsByAssignment.get(String(assignment.id)) || []).length > 0).map(assignment => String(assignment.id)));
        const products = new Map<string, { system_stock: number; total_counted: number; counted: boolean }>();
        for (const assignment of day.assignments) {
          const productId = String(assignment.product_id || "");
          if (!productId) continue;
          const current = products.get(productId) || { system_stock: Number(assignment.system_stock || 0), total_counted: 0, counted: false };
          current.system_stock = Math.max(current.system_stock, Number(assignment.system_stock || 0));
          if (countedAssignmentIds.has(String(assignment.id))) current.counted = true;
          products.set(productId, current);
        }
        for (const assignment of day.assignments) {
          const product = products.get(String(assignment.product_id || ""));
          if (!product) continue;
          for (const count of cyclicCountsByAssignment.get(String(assignment.id)) || []) product.total_counted += Number(count.counted_quantity || 0);
        }
        const noContados = [...products.values()].filter(product => !product.counted).length;
        const cumplio = (cyclicFlagsByDay.get(dayKey) || new Set<string>()).has("__recount_done__") || (noContados === 0 && products.size > 0);
        if (!cumplio) continue;
        const stats = cyclicByStore.get(day.store_id) || { eri: 0, counted_items: 0, ok_items: 0 };
        for (const [productId, product] of products) {
          if (!product.counted) continue;
          stats.counted_items += 1;
          if (product.total_counted - product.system_stock === 0) stats.ok_items += 1;
          const key = `${day.store_id}|${productId}`;
          const value = product.system_stock * (cyclicCostByProduct.get(productId) || 0);
          cyclicValueByProduct.set(key, Math.max(cyclicValueByProduct.get(key) || 0, value));
        }
        stats.eri = stats.counted_items > 0 ? (stats.ok_items / stats.counted_items) * 100 : 0;
        cyclicByStore.set(day.store_id, stats);
      }
      const cyclicValueByStore = new Map<string, number>();
      for (const [key, value] of cyclicValueByProduct) {
        const storeId = key.split("|")[0];
        cyclicValueByStore.set(storeId, (cyclicValueByStore.get(storeId) || 0) + value);
      }

      const auditByStore = new Map<string, { eri: number; session_count: number; audited_items: number; ok_items: number }>(
        (auditResponse.data || []).map((row: any) => [String(row.store_id), {
          eri: Number(row.eri || 0),
          session_count: Number(row.session_count || 0),
          audited_items: Number(row.audited_items || 0),
          ok_items: Number(row.ok_items || 0),
        }])
      );
      const generalByStore = new Map<string, GeneralInventoryReportRow>();
      for (const raw of generalRows as GeneralInventoryReportRow[]) {
        const row = {
          ...raw,
          total_codes: Number(raw.total_codes || 0),
          ok_codes: Number(raw.ok_codes || 0),
          system_value: Number(raw.system_value || 0),
          eri_pct: Number(raw.eri_pct || 0),
          net_value_diff: Number(raw.net_value_diff || 0),
          sales_in_period: raw.sales_in_period === null || raw.sales_in_period === undefined ? null : Number(raw.sales_in_period),
          deviation_over_sales_pct: raw.deviation_over_sales_pct === null || raw.deviation_over_sales_pct === undefined ? null : Number(raw.deviation_over_sales_pct),
        };
        const existing = generalByStore.get(String(row.store_id));
        if (!existing || String(row.finished_at || "") > String(existing.finished_at || "")) generalByStore.set(String(row.store_id), row);
      }

      // El valorizado muestreado debe compararse contra la misma fotografía
      // del inventario general, no contra el stock de la asignación cíclica.
      // Solo se consultan los códigos muestreados y se leen por páginas.
      const generalSampleValueByKey = new Map<string, number>();
      const sampledProductIds = [...new Set([
        ...auditItems.filter(row => countedAuditItemIds.has(String(row.id))).map(row => String(row.product_id || "")),
        ...[...cyclicValueByProduct.keys()].map(key => key.split("|")[1]),
      ].filter(Boolean))];
      for (const general of generalByStore.values()) {
        for (let i = 0; i < sampledProductIds.length; i += 500) {
          const chunk = sampledProductIds.slice(i, i + 500);
          const snapshotRows = await readPages((from, to) => supabase
            .from("general_inventory_stock_snapshot")
            .select("product_id,system_stock,cost")
            .eq("session_id", general.session_id)
            .in("product_id", chunk)
            .range(from, to));
          for (const row of snapshotRows) {
            const key = `${general.store_id}|${String(row.product_id || "")}`;
            generalSampleValueByKey.set(key, Number(row.system_stock || 0) * Number(row.cost || 0));
          }
        }
      }
      auditValueByStore.clear();
      for (const key of auditValueByProduct.keys()) {
        const storeId = key.split("|")[0];
        if (!generalSampleValueByKey.has(key)) continue;
        auditValueByStore.set(storeId, (auditValueByStore.get(storeId) || 0) + (generalSampleValueByKey.get(key) || 0));
      }
      cyclicValueByStore.clear();
      for (const key of cyclicValueByProduct.keys()) {
        const storeId = key.split("|")[0];
        if (!generalSampleValueByKey.has(key)) continue;
        cyclicValueByStore.set(storeId, (cyclicValueByStore.get(storeId) || 0) + (generalSampleValueByKey.get(key) || 0));
      }

      const consolidatedRows = stores.map(store => {
        const audit = auditByStore.get(store.id) || { eri: 0, session_count: 0, audited_items: 0, ok_items: 0 };
        const cyclic = cyclicByStore.get(store.id) || { eri: 0, counted_items: 0, ok_items: 0 };
        const general = generalByStore.get(store.id);
        const totalCodes = Number(general?.total_codes || 0);
        const generalOkCodes = Number(general?.ok_codes || 0);
        const generalValue = general ? Number(general.system_value || 0) : 0;
        const auditSampleValue = auditValueByStore.get(store.id) || 0;
        const cyclicSampleValue = cyclicValueByStore.get(store.id) || 0;
        const coveredCodes = audit.audited_items + cyclic.counted_items;
        const remainingCodes = Math.max(totalCodes - coveredCodes, 0);
        const remainingOkCodes = Math.max(generalOkCodes - audit.ok_items - cyclic.ok_items, 0);
        const remainingEri = totalCodes === 0 ? null : remainingCodes > 0
          ? (remainingOkCodes / remainingCodes) * 100
          : generalOkCodes / totalCodes * 100;
        const auditCoverage = totalCodes > 0 ? Math.min((audit.audited_items / totalCodes) * 100, 100) : null;
        const cyclicCoverage = totalCodes > 0 ? Math.min((cyclic.counted_items / totalCodes) * 100, 100) : null;
        const auditValueCoverage = generalValue > 0 ? Math.min((auditSampleValue / generalValue) * 100, 100) : null;
        const cyclicValueCoverage = generalValue > 0 ? Math.min((cyclicSampleValue / generalValue) * 100, 100) : null;
        const combinedValueCoverage = generalValue > 0 ? Math.min(((auditSampleValue + cyclicSampleValue) / generalValue) * 100, 100) : null;
        const generalEri = general ? Number(general.eri_pct || 0) : null;
        return {
          TIENDA: store.name,
          "ERI CONTEO CICLICO": cyclic.counted_items > 0 ? cyclic.eri / 100 : 0,
          "ERI AUDITORIA": audit.session_count > 0 ? audit.eri / 100 : "",
          "ERI INVENTARIOS GENERALES": generalEri === null ? "" : generalEri / 100,
          "DESVIACION SOBRE LA VENTA": general ? Number(general.net_value_diff || 0) : "",
          "% DESVIACION SOBRE LA VENTA": general?.deviation_over_sales_pct === null || general?.deviation_over_sales_pct === undefined ? "" : Number(general.deviation_over_sales_pct) / 100,
          "VALORIZADO INVENTARIO GENERAL": general ? Number(generalValue.toFixed(2)) : "",
          "VALORIZADO MUESTREADO AUDITORIA": general ? Number(auditSampleValue.toFixed(2)) : "",
          "% VALORIZADO MUESTREADO AUDITORIA": auditValueCoverage === null ? "" : auditValueCoverage / 100,
          "VALORIZADO MUESTREADO CICLICO": general ? Number(cyclicSampleValue.toFixed(2)) : "",
          "% VALORIZADO MUESTREADO CICLICO": cyclicValueCoverage === null ? "" : cyclicValueCoverage / 100,
          "% VALORIZADO MUESTREADO TOTAL": combinedValueCoverage === null ? "" : combinedValueCoverage / 100,
          "ERI ESTIMADO RESTO": remainingEri === null ? "" : remainingEri / 100,
          "COBERTURA AUDITORIA %": auditCoverage === null ? "" : auditCoverage / 100,
          "COBERTURA CONTEO CICLICO %": cyclicCoverage === null ? "" : cyclicCoverage / 100,
          "CODIGOS INVENTARIO GENERAL": totalCodes || "",
          "CODIGOS AUDITADOS": totalCodes ? audit.audited_items : "",
          "CODIGOS CONTADOS CICLICO": totalCodes ? cyclic.counted_items : "",
          "CODIGOS RESTANTES ANALIZADOS": totalCodes ? remainingCodes : "",
        };
      });

      const XLSX = await import("xlsx");
      const sheet = XLSX.utils.json_to_sheet(consolidatedRows);
      const percentColumns = [1, 2, 3, 5, 8, 10, 11, 12, 13, 14];
      const amountColumns = [4, 6, 7, 9];
      for (let rowIndex = 1; rowIndex <= consolidatedRows.length; rowIndex += 1) {
        for (const columnIndex of percentColumns) {
          const cellAddress = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
          if (sheet[cellAddress] && typeof sheet[cellAddress].v === "number") sheet[cellAddress].z = "0.00%";
        }
        for (const columnIndex of amountColumns) {
          const cellAddress = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
          if (sheet[cellAddress] && typeof sheet[cellAddress].v === "number") sheet[cellAddress].z = "#,##0.00";
        }
      }
      sheet["!cols"] = [
        { wch: 30 }, { wch: 18 }, { wch: 16 }, { wch: 24 }, { wch: 24 }, { wch: 24 },
        { wch: 26 }, { wch: 24 }, { wch: 26 }, { wch: 24 }, { wch: 26 }, { wch: 26 },
        { wch: 34 }, { wch: 20 }, { wch: 24 }, { wch: 24 }, { wch: 18 }, { wch: 24 }, { wch: 28 },
      ];
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, sheet, "ERI consolidado");
      XLSX.writeFile(workbook, `eri_consolidado_${range.from}_a_${dateTo}.xlsx`);
      toast.success("Excel ERI consolidado descargado.");
    } catch (e: any) {
      toast.error("Error descargando ERI consolidado: " + e.message);
    } finally {
      setDownloadingEriConsolidated(false);
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (!ready || !user) return <p className="p-8 text-center text-sm font-bold text-slate-400">Cargando...</p>;
  if (moduleDisabled) return <ModuleDisabledScreen moduleLabel="Checklist" />;

  const days = Array.from({ length: monthLastDate(historyMonth) }, (_, i) => i + 1);

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex items-center gap-3">
          <button onClick={() => { window.location.href = "/"; }} className="rounded-xl border bg-white p-2 text-slate-600 hover:bg-slate-50" title="Menú principal">
            <Home size={18} />
          </button>
          <div>
            <p className="text-xs font-black uppercase text-slate-500">Auditoría de almacenes</p>
            <h1 className="text-2xl font-black text-slate-950">Checklist</h1>
          </div>
        </div>

        {canManageChecklist ? (
          <>
            <div className="grid grid-cols-2 gap-1 rounded-2xl border bg-white p-1 shadow-sm sm:w-80">
              <button onClick={() => setAdminTab("resumen")} className={`rounded-xl px-3 py-2 text-sm font-black ${adminTab === "resumen" ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-50"}`}>Resumen</button>
              <button onClick={() => setAdminTab("asignaciones")} className={`rounded-xl px-3 py-2 text-sm font-black ${adminTab === "asignaciones" ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-50"}`}>Asignaciones</button>
            </div>

            {adminTab === "resumen" && (
              <div className="space-y-4 rounded-2xl border bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div className="flex flex-wrap gap-6">
                    <PeriodPicker label="Período Cumplimiento" value={cumplimientoPeriod} onChange={setCumplimientoPeriod} />
                    <PeriodPicker label="Período ERI (Existencia + Conteo Cíclico)" value={existenciaPeriod} onChange={setExistenciaPeriod} />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => void downloadChecklistDetail()} disabled={downloadingDetail} className="flex items-center gap-2 rounded-xl bg-emerald-700 px-3 py-2.5 text-sm font-black text-white disabled:opacity-40">
                      {downloadingDetail ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />} Descargar detalle Excel
                    </button>
                    <button onClick={() => void downloadEriConsolidated()} disabled={downloadingEriConsolidated} className="flex items-center gap-2 rounded-xl bg-indigo-700 px-3 py-2.5 text-sm font-black text-white disabled:opacity-40">
                      {downloadingEriConsolidated ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />} Excel ERI consolidado
                    </button>
                    <button onClick={() => void loadResumen()} disabled={resumenLoading} className="flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-black text-slate-700 disabled:opacity-40">
                      {resumenLoading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} Actualizar
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] text-sm">
                    <thead>
                      <tr className="text-left text-[11px] font-black uppercase text-slate-400">
                        <th className="p-2">Tienda</th>
                        <th className="p-2">Auditor</th>
                        <th className="p-2 text-center">Cumplió</th>
                        <th className="p-2 text-center">No cumplió</th>
                        <th className="p-2 text-center">Justificado</th>
                        <th className="p-2 text-center">% Checklist</th>
                        <th className="p-2 text-center">Auditoría Existencia</th>
                        <th className="p-2 text-center">ERI Conteo Cíclico</th>
                        <th className="p-2 text-center">Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resumenRows.map(row => (
                        <tr key={row.store_id} className="border-t">
                          <td className="p-2 font-bold text-slate-800">{row.store_name}</td>
                          <td className="p-2 text-slate-500">{row.auditor_name}</td>
                          <td className="p-2 text-center text-emerald-700 font-black">{row.cumplio}</td>
                          <td className="p-2 text-center text-red-600 font-black">{row.no_cumplio}</td>
                          <td className="p-2 text-center text-amber-600 font-black">{row.justificado}</td>
                          <td className="p-2 text-center font-black">{row.pct}%</td>
                          <td className="p-2 text-center font-black">{row.session_count > 0 ? `${row.eri}%` : "Sin auditorías"}</td>
                          <td className="p-2 text-center font-black">{row.cyclicCountedItems > 0 ? `${row.cyclicEri}%` : "Sin conteos"}</td>
                          <td className={`p-2 text-center font-black ${scoreColorClass(row.combined)}`}>{row.combined}%</td>
                        </tr>
                      ))}
                      {!resumenLoading && resumenRows.length === 0 && (
                        <tr><td colSpan={9} className="p-8 text-center text-sm font-bold text-slate-400">Sin datos.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {adminTab === "asignaciones" && (
              <div className="space-y-4 rounded-2xl border bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-end gap-2">
                  <select value={newAssignmentStoreId} onChange={e => setNewAssignmentStoreId(e.target.value)} className="rounded-xl border px-3 py-2.5 text-sm font-bold">
                    <option value="">Tienda...</option>
                    {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <select value={newAssignmentAuditorId} onChange={e => setNewAssignmentAuditorId(e.target.value)} className="rounded-xl border px-3 py-2.5 text-sm font-bold">
                    <option value="">Auditor...</option>
                    {checklistUsers.map(u => <option key={u.id} value={u.id}>{u.full_name || u.username}</option>)}
                  </select>
                  <button onClick={() => void addAssignment()} disabled={savingAssignment} className="flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-black text-white disabled:opacity-40">
                    {savingAssignment ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Agregar
                  </button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] font-black uppercase text-slate-400">
                        <th className="p-2">Tienda</th>
                        <th className="p-2">Auditor</th>
                        <th className="p-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {assignments.map(a => (
                        <tr key={a.id} className="border-t">
                          <td className="p-2 font-bold text-slate-800">{a.store_name}</td>
                          <td className="p-2 text-slate-600">{a.auditor_name}</td>
                          <td className="p-2 text-right">
                            <button onClick={() => void deleteAssignment(a.id)} disabled={deletingAssignmentId === a.id} className="rounded-lg p-2 text-red-500 hover:bg-red-50 disabled:opacity-40">
                              {deletingAssignmentId === a.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                            </button>
                          </td>
                        </tr>
                      ))}
                      {assignments.length === 0 && (
                        <tr><td colSpan={3} className="p-8 text-center text-sm font-bold text-slate-400">Sin asignaciones todavía.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            {myStores.length === 0 ? (
              <div className="rounded-2xl border bg-white p-8 text-center text-sm font-bold text-slate-400 shadow-sm">
                No tienes tiendas asignadas en Checklist. Contacta a un administrador.
              </div>
            ) : (
              <>
                <select value={selectedStoreId} onChange={e => setSelectedStoreId(e.target.value)} className="w-full rounded-2xl border bg-white px-4 py-2.5 text-sm font-black shadow-sm sm:w-80">
                  {myStores.map(s => <option key={s.store_id} value={s.store_id}>{s.store_name}</option>)}
                </select>

                <div className="rounded-2xl border bg-white p-4 shadow-sm">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-black uppercase text-slate-500">
                      Checklist del día{selectedDate === todayISO() ? " (hoy)" : ""}
                    </p>
                    <input
                      type="date"
                      value={selectedDate}
                      max={todayISO()}
                      onChange={e => {
                        const next = e.target.value;
                        setSelectedDate(next);
                        if (next.slice(0, 7) !== historyMonth) setHistoryMonth(next.slice(0, 7));
                      }}
                      className="rounded-xl border px-3 py-2 text-xs font-bold"
                    />
                  </div>
                  <div className="space-y-2">
                    {CHECKLIST_ITEMS.map(item => {
                      const current = dateEntries[item.key];
                      const saving = savingItemKey === item.key;
                      return (
                        <div key={item.key} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3">
                          <span className="text-sm font-bold text-slate-800">{item.label}</span>
                          <div className="flex gap-1.5">
                            <button disabled={saving} onClick={() => void saveEntry(item.key, "cumple")}
                              className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-black ${current === "cumple" ? "bg-emerald-600 text-white" : "bg-emerald-50 text-emerald-700"}`}>
                              <CheckCircle2 size={14} /> Cumple
                            </button>
                            <button disabled={saving} onClick={() => void saveEntry(item.key, "no_cumple")}
                              className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-black ${current === "no_cumple" ? "bg-red-600 text-white" : "bg-red-50 text-red-600"}`}>
                              <XCircle size={14} /> No cumple
                            </button>
                            <button disabled={saving} onClick={() => void saveEntry(item.key, "justificado")}
                              className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-black ${current === "justificado" ? "bg-amber-600 text-white" : "bg-amber-50 text-amber-700"}`}>
                              <AlertTriangle size={14} /> Justificado
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-2xl border bg-white p-4 shadow-sm">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <p className="text-xs font-black uppercase text-slate-500">Historial del mes</p>
                    <input type="month" value={historyMonth} onChange={e => setHistoryMonth(e.target.value)} className="rounded-xl border px-3 py-2 text-xs font-bold" />
                  </div>
                  {historyLoading ? (
                    <p className="p-4 text-center text-sm font-bold text-slate-400">Cargando...</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="text-xs">
                        <thead>
                          <tr>
                            <th className="sticky left-0 bg-white p-1.5 text-left font-black uppercase text-slate-400">Ítem</th>
                            {days.map(d => <th key={d} className="p-1 text-center font-black text-slate-400">{d}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {CHECKLIST_ITEMS.map(item => (
                            <tr key={item.key} className="border-t">
                              <td className="sticky left-0 whitespace-nowrap bg-white p-1.5 font-bold text-slate-700">{item.label}</td>
                              {days.map(d => {
                                const dateStr = `${historyMonth}-${String(d).padStart(2, "0")}`;
                                const found = historyEntries.find(e => e.item_key === item.key && e.entry_date === dateStr);
                                return (
                                  <td key={d} className="p-0.5 text-center">
                                    <span className={`inline-flex h-5 w-5 items-center justify-center rounded font-black ${statusColor(found?.status)}`}>
                                      {statusSymbol(found?.status)}
                                    </span>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
