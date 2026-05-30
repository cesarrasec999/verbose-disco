"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2, ChevronLeft, Home, LogOut, Package,
  Printer, QrCode, RefreshCw, Search, ScanLine, X,
} from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { endSingleDeviceSession, readStoredUser } from "@/lib/singleDeviceSession";
import { canAccessModule } from "@/features/access/moduleAccess";
import type { CyclicUser, Store } from "@/features/ciclicos/types";

// ─── Tipos ────────────────────────────────────────────────────────────────────

type ReceptionRequest = {
  id: string;
  erp_inv_request_id: string;
  inv_request_no: string | null;
  doc_number: string | null;
  status_code: string | null;
  request_date: string | null;
  creation_date: string | null;
  destination_store_code: string;
  destination_store_name: string | null;
  source_store_code: string;
  source_store_name: string | null;
  reason: string | null;
  notes: string | null;
  line_count: number;
  qty_requested_total: number;
  qty_pending_total: number;
  reception_status: "pending" | "in_progress" | "completed";
  completed_at: string | null;
  completed_by_name: string | null;
};

type ReceptionLine = {
  id: string;
  line_id: number;
  sku: string | null;
  product_code: string;
  barcode: string | null;
  description: string | null;
  unit: string | null;
  qty_requested: number;
  qty_pending: number;
  qty_received?: number;
  notes?: string;
};

type ReceptionRecord = {
  id: string;
  line_id: string;
  product_code: string;
  description: string | null;
  unit: string | null;
  qty_requested: number;
  qty_received: number;
  difference: number;
  notes: string | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

function normalize(v: string | null | undefined) {
  return String(v || "").trim().toUpperCase();
}

function diffLabel(diff: number) {
  if (diff === 0) return "OK";
  if (diff > 0)  return `+${fmt(diff)}`;
  return fmt(diff);
}

function diffClass(diff: number) {
  if (diff === 0) return "text-green-700 font-bold";
  if (diff > 0)  return "text-blue-700 font-bold";
  return "text-red-600 font-bold";
}

function StatusBadge({ status }: { status: ReceptionRequest["reception_status"] }) {
  if (status === "completed")
    return <span className="rounded-full bg-green-100 text-green-700 text-xs font-bold px-2.5 py-0.5">Completado</span>;
  if (status === "in_progress")
    return <span className="rounded-full bg-amber-100 text-amber-700 text-xs font-bold px-2.5 py-0.5">En proceso</span>;
  return <span className="rounded-full bg-slate-100 text-slate-600 text-xs font-bold px-2.5 py-0.5">Pendiente</span>;
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function RecepcionPage() {
  const [user, setUser]         = useState<CyclicUser | null>(null);
  const [stores, setStores]     = useState<Store[]>([]);
  const [requests, setRequests] = useState<ReceptionRequest[]>([]);
  const [selected, setSelected] = useState<ReceptionRequest | null>(null);
  const [lines, setLines]       = useState<ReceptionLine[]>([]);
  const [records, setRecords]   = useState<ReceptionRecord[]>([]);
  const [view, setView]         = useState<"list" | "detail" | "report">("list");
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [ready, setReady]       = useState(false);
  const [message, setMessage]   = useState<{ text: string; type: "info" | "success" | "error" } | null>(null);

  // Filtros lista
  const [search, setSearch]           = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "pending" | "in_progress" | "completed">("all");
  const [storeFilter, setStoreFilter] = useState("all"); // solo para admin/all-stores

  // Detalle — escáner y búsqueda de código
  const [scanCode, setScanCode]         = useState("");
  const [highlightLine, setHighlightLine] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen]   = useState(false);
  const scannerRef = useRef<any>(null);
  const scannerContainerId = "recepcion-scanner";
  const lineRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const showMsg = useCallback((text: string, type: "info" | "success" | "error" = "info") => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 4000);
  }, []);

  const canAdmin = useMemo(() =>
    user?.role === "Administrador" || user?.role === "Supervisor" || user?.can_access_all_stores,
  [user]);

  // ─── Init ────────────────────────────────────────────────────────────────────

  useEffect(() => {
    const stored = readStoredUser<CyclicUser>();
    if (!stored || !canAccessModule(stored, "reception")) {
      window.location.replace("/");
      return;
    }
    setUser(stored);
    supabase.from("stores").select("id, code, name, erp_sede, is_active").eq("is_active", true).order("name")
      .then(({ data }) => {
        setStores((data || []) as Store[]);
        setReady(true);
      });
  }, []);

  useEffect(() => {
    if (!ready || !user) return;
    void loadRequests();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, user]);

  // ─── Cargar requerimientos ───────────────────────────────────────────────────

  async function loadRequests() {
    setLoading(true);
    try {
      let query = supabase
        .from("reception_requests")
        .select("*")
        .order("creation_date", { ascending: false })
        .limit(300);

      // Admin/supervisor con filtro de tienda seleccionado
      if (canAdmin && storeFilter !== "all") {
        query = query.eq("destination_store_code", storeFilter);
      }
      // Operario: solo ve su tienda
      if (!canAdmin && user?.store_id) {
        const store = stores.find(s => s.id === user.store_id);
        if (store) {
          query = query.or(
            `destination_store_code.eq.${store.code},destination_store_code.eq.${store.erp_sede ?? store.code}`
          );
        }
      }

      const { data, error } = await query;
      if (error) throw error;
      setRequests((data || []) as ReceptionRequest[]);
    } catch (e: any) {
      showMsg("Error cargando requerimientos: " + e.message, "error");
    } finally {
      setLoading(false);
    }
  }

  // Recargar cuando cambia el filtro de tienda
  useEffect(() => {
    if (!ready || !user) return;
    void loadRequests();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeFilter, ready]);

  // ─── Abrir detalle ───────────────────────────────────────────────────────────

  async function openRequest(req: ReceptionRequest) {
    setSelected(req);
    setView("detail");
    setLoading(true);
    setScanCode("");
    setHighlightLine(null);
    try {
      const [{ data: lineData }, { data: recordData }] = await Promise.all([
        supabase.from("reception_request_lines").select("*").eq("request_id", req.id).order("line_id"),
        supabase.from("reception_records").select("*").eq("request_id", req.id),
      ]);
      const existingRecords = (recordData || []) as ReceptionRecord[];
      const loadedLines = ((lineData || []) as ReceptionLine[]).map(line => {
        const existing = existingRecords.find(r => r.line_id === line.id);
        return { ...line, qty_received: existing?.qty_received ?? line.qty_pending, notes: existing?.notes ?? "" };
      });
      setLines(loadedLines);
      setRecords(existingRecords);
    } catch (e: any) {
      showMsg("Error cargando líneas: " + e.message, "error");
    } finally {
      setLoading(false);
    }
  }

  // ─── Buscar código (scan o digitado) ─────────────────────────────────────────

  function searchCode(code: string) {
    const c = code.trim();
    if (!c) return;
    const idx = lines.findIndex(l =>
      normalize(l.product_code) === normalize(c) ||
      normalize(l.barcode)      === normalize(c) ||
      normalize(l.sku)          === normalize(c)
    );
    if (idx >= 0) {
      const lineId = lines[idx].id;
      setHighlightLine(lineId);
      setTimeout(() => {
        lineRefs.current[lineId]?.scrollIntoView({ behavior: "smooth", block: "center" });
        const input = document.getElementById(`qty-${lineId}`) as HTMLInputElement | null;
        input?.focus();
        input?.select();
      }, 50);
    } else {
      showMsg(`Código "${c}" no encontrado en este requerimiento.`, "error");
    }
    setScanCode("");
  }

  // ─── Escáner QR ──────────────────────────────────────────────────────────────

  async function openScanner() {
    setScannerOpen(true);
    setTimeout(async () => {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        const scanner = new Html5Qrcode(scannerContainerId);
        scannerRef.current = scanner;
        const devices = await Html5Qrcode.getCameras();
        const cameraId = devices.find(d => /back|rear|environment/i.test(d.label))?.id || devices[0]?.id;
        if (!cameraId) { showMsg("No se encontró cámara.", "error"); setScannerOpen(false); return; }
        await scanner.start(cameraId, { fps: 10, qrbox: 260 }, (decoded) => {
          void scanner.stop();
          scannerRef.current = null;
          setScannerOpen(false);
          searchCode(decoded);
        }, () => {});
      } catch (e: any) {
        showMsg("Error escáner: " + e.message, "error");
        setScannerOpen(false);
      }
    }, 100);
  }

  function closeScanner() {
    if (scannerRef.current) { void scannerRef.current.stop(); scannerRef.current = null; }
    setScannerOpen(false);
  }

  // ─── Guardar recepción ───────────────────────────────────────────────────────

  async function saveReception(markComplete: boolean) {
    if (!selected || !user) return;
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const recordRows = lines.map(line => ({
        request_id:    selected.id,
        line_id:       line.id,
        operator_id:   user.id,
        operator_name: user.full_name,
        product_code:  line.product_code,
        description:   line.description,
        unit:          line.unit,
        qty_requested: line.qty_requested,
        qty_received:  Number(line.qty_received ?? line.qty_pending),
        notes:         line.notes || null,
        updated_at:    now,
      }));

      await supabase.from("reception_records").delete().eq("request_id", selected.id);
      if (recordRows.length) {
        const { error } = await supabase.from("reception_records").insert(recordRows);
        if (error) throw error;
      }

      const newStatus = markComplete ? "completed" : "in_progress";
      const { error: reqErr } = await supabase.from("reception_requests").update({
        reception_status:  newStatus,
        completed_at:      markComplete ? now : null,
        completed_by_id:   markComplete ? user.id : null,
        completed_by_name: markComplete ? user.full_name : null,
        updated_at:        now,
      }).eq("id", selected.id);
      if (reqErr) throw reqErr;

      setSelected(prev => prev ? { ...prev, reception_status: newStatus } : null);
      setRequests(prev => prev.map(r => r.id === selected.id ? { ...r, reception_status: newStatus } : r));
      showMsg(markComplete ? "Recepción completada." : "Guardado.", "success");
      if (markComplete) setView("report");
    } catch (e: any) {
      showMsg("Error guardando: " + e.message, "error");
    } finally {
      setSaving(false);
    }
  }

  // ─── Filtros lista ────────────────────────────────────────────────────────────

  const filteredRequests = useMemo(() => requests.filter(r => {
    if (filterStatus !== "all" && r.reception_status !== filterStatus) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return [r.doc_number, r.inv_request_no, r.destination_store_name, r.source_store_name]
      .join(" ").toLowerCase().includes(q);
  }), [requests, filterStatus, search]);

  // Tiendas destino disponibles en los requests cargados (para filtro admin)
  const destStoreOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of requests) {
      if (r.destination_store_code)
        map.set(r.destination_store_code, r.destination_store_name || r.destination_store_code);
    }
    return [...map.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [requests]);

  // ─── Reporte imprimible ───────────────────────────────────────────────────────

  function printReport() {
    if (!selected) return;
    const rows = lines.map(line => {
      const rec = records.find(r => r.line_id === line.id);
      const received = rec?.qty_received ?? Number(line.qty_received ?? line.qty_pending);
      const diff = received - line.qty_requested;
      return { line, received, diff };
    });
    const totalReq = rows.reduce((s, r) => s + r.line.qty_requested, 0);
    const totalRec = rows.reduce((s, r) => s + r.received, 0);
    const totalDiff = totalRec - totalReq;
    const sobrantes = rows.filter(r => r.diff > 0).length;
    const faltantes = rows.filter(r => r.diff < 0).length;

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
    <title>Recepción ${selected.doc_number || selected.inv_request_no}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:11px;margin:20px;color:#111}
      h2{font-size:14px;margin:0 0 4px}
      .info{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px;border:1px solid #ccc;padding:8px;border-radius:6px}
      .info-item label{font-weight:bold;display:block;color:#555;font-size:10px}
      .stats{display:flex;gap:12px;margin-bottom:10px}
      .stat{background:#f1f5f9;border-radius:6px;padding:6px 10px;font-size:10px;font-weight:bold}
      .stat span{display:block;font-size:14px;font-weight:900}
      .stat.ok span{color:#15803d} .stat.over span{color:#1d4ed8} .stat.under span{color:#dc2626}
      table{width:100%;border-collapse:collapse;margin-top:4px}
      th{background:#1e293b;color:white;padding:5px 4px;text-align:left;font-size:10px}
      td{padding:4px;border-bottom:1px solid #e2e8f0;font-size:10px}
      tr:nth-child(even) td{background:#f8fafc}
      .ok{color:#15803d;font-weight:bold} .over{color:#1d4ed8;font-weight:bold} .under{color:#dc2626;font-weight:bold}
      .totals td{font-weight:bold;border-top:2px solid #1e293b}
      .obs{color:#6b7280}
      .signatures{margin-top:32px;display:flex;justify-content:space-around;gap:40px}
      .sign{text-align:center;width:200px}
      .sign-line{border-top:1px solid #000;padding-top:4px;margin-top:48px;font-size:10px;font-weight:bold}
      .sign-sub{font-size:9px;color:#555;margin-top:2px}
      @media print{body{margin:10px}}
    </style></head><body>
    <h2>Reporte de Recepción</h2>
    <p style="color:#555;font-size:10px;margin:0 0 8px">Generado: ${new Date().toLocaleString("es-PE")} &nbsp;|&nbsp; Registrado por: ${selected.completed_by_name || user?.full_name || "-"}</p>
    <div class="info">
      <div class="info-item"><label>DOCUMENTO</label>${selected.doc_number || selected.inv_request_no || "-"}</div>
      <div class="info-item"><label>MOTIVO</label>${selected.reason || "Salida por transferencia"}</div>
      <div class="info-item"><label>ORIGEN (CD)</label>${selected.source_store_name || selected.source_store_code}</div>
      <div class="info-item"><label>TIENDA DESTINO</label>${selected.destination_store_name || selected.destination_store_code}</div>
      <div class="info-item"><label>FECHA DOCUMENTO</label>${selected.request_date ? new Date(selected.request_date).toLocaleDateString("es-PE") : "-"}</div>
      <div class="info-item"><label>ESTADO</label>${selected.reception_status === "completed" ? "Completado" : "En proceso"}</div>
    </div>
    <div class="stats">
      <div class="stat"><label>CÓDIGOS</label><span>${rows.length}</span></div>
      <div class="stat ok"><label>OK</label><span>${rows.filter(r => r.diff === 0).length}</span></div>
      <div class="stat over"><label>SOBRANTES</label><span>${sobrantes}</span></div>
      <div class="stat under"><label>FALTANTES</label><span>${faltantes}</span></div>
    </div>
    <table>
      <thead><tr>
        <th>#</th><th>Código</th><th>Descripción</th><th>UM</th>
        <th style="text-align:right">Enviado</th>
        <th style="text-align:right">Recibido</th>
        <th style="text-align:right">Diferencia</th>
        <th>Estado</th>
        <th>Observación</th>
      </tr></thead>
      <tbody>
        ${rows.map((r, i) => {
          const cls = r.diff === 0 ? "ok" : r.diff > 0 ? "over" : "under";
          const st  = r.diff === 0 ? "OK" : r.diff > 0 ? "SOBRANTE" : "FALTANTE";
          const rec = records.find(rec => rec.line_id === r.line.id);
          return `<tr>
            <td>${i + 1}</td>
            <td style="font-weight:bold">${r.line.product_code}</td>
            <td>${r.line.description || "-"}</td>
            <td>${r.line.unit || "-"}</td>
            <td style="text-align:right">${fmt(r.line.qty_requested)}</td>
            <td style="text-align:right;font-weight:bold">${fmt(r.received)}</td>
            <td style="text-align:right" class="${cls}">${diffLabel(r.diff)}</td>
            <td class="${cls}">${st}</td>
            <td class="obs">${rec?.notes || ""}</td>
          </tr>`;
        }).join("")}
      </tbody>
      <tfoot><tr class="totals">
        <td colspan="4">TOTAL</td>
        <td style="text-align:right">${fmt(totalReq)}</td>
        <td style="text-align:right">${fmt(totalRec)}</td>
        <td style="text-align:right" class="${totalDiff === 0 ? "ok" : totalDiff > 0 ? "over" : "under"}">${diffLabel(totalDiff)}</td>
        <td colspan="2"></td>
      </tr></tfoot>
    </table>
    <div class="signatures">
      <div class="sign">
        <div class="sign-line">Jefe de Tienda</div>
        <div class="sign-sub">${selected.destination_store_name || selected.destination_store_code}</div>
      </div>
      <div class="sign">
        <div class="sign-line">Asesor de Almacén</div>
        <div class="sign-sub">CD-GPC</div>
      </div>
    </div>
    </body></html>`;

    const win = window.open("", "_blank");
    if (!win) { showMsg("Permite ventanas emergentes para imprimir.", "error"); return; }
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 400);
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  if (!ready) {
    return (
      <main className="min-h-screen bg-slate-100 flex items-center justify-center">
        <p className="text-slate-500 font-bold">Cargando...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-100 flex flex-col">

      {/* ── Header ── */}
      <header className="sticky top-0 z-40 bg-white border-b shadow-sm px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button onClick={() => window.location.href = "/"} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Menú">
            <Home size={18} />
          </button>
          {view !== "list" && (
            <button
              onClick={() => { setView("list"); setSelected(null); setLines([]); setRecords([]); }}
              className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50"
            >
              <ChevronLeft size={18} />
            </button>
          )}
          <div>
            <h1 className="font-black text-slate-900 text-base leading-tight">
              {view === "list" ? "Recepción"
                : view === "report" ? "Reporte"
                : selected?.doc_number || selected?.inv_request_no || "Detalle"}
            </h1>
            <p className="text-xs text-slate-400">{user?.full_name}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {view === "detail" && selected?.reception_status !== "completed" && (
            <button
              onClick={() => saveReception(false)}
              disabled={saving}
              className="hidden sm:flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {saving ? "Guardando..." : "Guardar borrador"}
            </button>
          )}
          {view === "detail" && (
            <button onClick={() => setView("report")} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Reporte">
              <Printer size={16} />
            </button>
          )}
          {view === "report" && (
            <button onClick={printReport} className="flex items-center gap-1.5 rounded-xl bg-slate-900 text-white px-3 py-2 text-sm font-bold">
              <Printer size={15} /> Imprimir
            </button>
          )}
          <button onClick={() => { void loadRequests(); showMsg("Actualizado.", "info"); }} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50">
            <RefreshCw size={16} />
          </button>
          <button
            onClick={() => { if (user) void endSingleDeviceSession(user); localStorage.removeItem("cyclic_user"); window.location.replace("/"); }}
            className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50"
          >
            <LogOut size={15} /> Salir
          </button>
        </div>
      </header>

      {/* ── Mensaje ── */}
      {message && (
        <div className={`mx-4 mt-3 rounded-2xl px-4 py-3 text-sm font-bold ${
          message.type === "success" ? "bg-green-50 text-green-700 border border-green-200"
          : message.type === "error" ? "bg-red-50 text-red-700 border border-red-200"
          : "bg-blue-50 text-blue-700 border border-blue-200"
        }`}>
          {message.text}
        </div>
      )}

      {/* ══════════════ LISTA ══════════════ */}
      {view === "list" && (
        <div className="flex-1 p-4 space-y-3 max-w-3xl w-full mx-auto">

          {/* Filtros */}
          <div className="flex flex-wrap gap-2">
            {/* Filtro de tienda: solo admin/supervisor/all-stores */}
            {canAdmin && (
              <select
                value={storeFilter}
                onChange={e => setStoreFilter(e.target.value)}
                className="border rounded-2xl px-3 py-2.5 text-sm bg-white text-slate-900 font-semibold min-w-[160px]"
              >
                <option value="all">Todas las tiendas</option>
                {destStoreOptions.map(s => (
                  <option key={s.code} value={s.code}>{s.name}</option>
                ))}
              </select>
            )}

            <div className="relative flex-1 min-w-[160px]">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                className="w-full border rounded-2xl pl-9 pr-3 py-2.5 text-sm bg-white text-slate-900"
                placeholder="Buscar documento, tienda..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>

            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value as any)}
              className="border rounded-2xl px-3 py-2.5 text-sm bg-white text-slate-900"
            >
              <option value="all">Todos</option>
              <option value="pending">Pendiente</option>
              <option value="in_progress">En proceso</option>
              <option value="completed">Completados</option>
            </select>
          </div>

          {/* Contador */}
          <p className="text-xs text-slate-400 font-semibold px-1">
            {filteredRequests.length} requerimiento{filteredRequests.length !== 1 ? "s" : ""}
          </p>

          {loading && <p className="text-slate-400 text-sm text-center py-12">Cargando...</p>}

          {!loading && filteredRequests.length === 0 && (
            <div className="text-center py-16 text-slate-400">
              <Package size={40} className="mx-auto mb-3 opacity-30" />
              <p className="font-bold">No hay requerimientos{filterStatus !== "all" ? " en este estado" : ""}</p>
              <p className="text-xs mt-1">Los slips en tránsito aparecerán aquí automáticamente.</p>
            </div>
          )}

          {filteredRequests.map(req => (
            <button
              key={req.id}
              onClick={() => openRequest(req)}
              className="w-full text-left bg-white rounded-2xl border p-4 shadow-sm hover:shadow-md hover:border-teal-400 transition-all"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-black text-slate-900">{req.doc_number || req.inv_request_no || req.erp_inv_request_id}</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {req.source_store_name || req.source_store_code} → {req.destination_store_name || req.destination_store_code}
                  </p>
                </div>
                <StatusBadge status={req.reception_status} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                <span><b className="text-slate-700">{req.line_count}</b> líneas</span>
                <span><b className="text-slate-700">{fmt(req.qty_requested_total)}</b> uds.</span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-slate-400">
                {req.creation_date && (
                  <span>Requerido: <b className="text-slate-600">{new Date(req.creation_date).toLocaleDateString("es-PE")}</b></span>
                )}
                {req.request_date && (
                  <span>En tránsito: <b className="text-teal-600">{new Date(req.request_date).toLocaleDateString("es-PE")}</b></span>
                )}
              </div>
              {req.reception_status === "completed" && req.completed_by_name && (
                <p className="mt-1.5 text-xs text-green-600 font-semibold">✓ {req.completed_by_name}</p>
              )}
            </button>
          ))}
        </div>
      )}

      {/* ══════════════ DETALLE ══════════════ */}
      {view === "detail" && selected && (
        <div className="flex-1 p-4 max-w-3xl w-full mx-auto space-y-3">

          {/* Info cabecera */}
          <div className="bg-white rounded-2xl border p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-black text-slate-900 text-lg">{selected.doc_number || selected.inv_request_no}</p>
                <p className="text-sm text-slate-500">{selected.source_store_name} → {selected.destination_store_name}</p>
              </div>
              <StatusBadge status={selected.reception_status} />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              <span><b className="text-slate-700">{selected.line_count}</b> líneas</span>
              <span><b className="text-slate-700">{fmt(selected.qty_requested_total)}</b> uds. enviadas</span>
              {selected.creation_date && (
                <span>Requerido: <b>{new Date(selected.creation_date).toLocaleDateString("es-PE")}</b></span>
              )}
              {selected.request_date && (
                <span>Tránsito: <b className="text-teal-600">{new Date(selected.request_date).toLocaleDateString("es-PE")}</b></span>
              )}
            </div>
          </div>

          {/* Barra de búsqueda / escaneo */}
          {selected.reception_status !== "completed" && (
            <div className="bg-white rounded-2xl border p-3 flex gap-2">
              <div className="relative flex-1">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  className="w-full border rounded-xl pl-9 pr-3 py-2.5 text-sm bg-white text-slate-900"
                  placeholder="Digitar código de producto..."
                  value={scanCode}
                  onChange={e => setScanCode(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") searchCode(scanCode); }}
                />
              </div>
              <button
                onClick={() => searchCode(scanCode)}
                className="rounded-xl bg-teal-600 text-white px-4 py-2 text-sm font-bold"
              >
                <ScanLine size={16} />
              </button>
              <button
                onClick={openScanner}
                className="rounded-xl border px-3 py-2 text-slate-700 hover:bg-slate-50"
                title="Escanear código"
              >
                <QrCode size={16} />
              </button>
            </div>
          )}

          {/* Escáner modal */}
          {scannerOpen && (
            <div className="fixed inset-0 bg-black/75 z-50 flex flex-col items-center justify-center gap-4 p-4">
              <p className="text-white font-bold text-sm">Apunta al código del producto</p>
              <div id={scannerContainerId} className="rounded-2xl overflow-hidden w-full max-w-xs" />
              <button onClick={closeScanner} className="rounded-2xl bg-white px-6 py-3 font-black text-slate-900">
                <X size={16} className="inline mr-2" />Cancelar
              </button>
            </div>
          )}

          {/* Líneas */}
          {loading ? (
            <p className="text-slate-400 text-sm text-center py-10">Cargando líneas...</p>
          ) : (
            <div className="space-y-2">
              {lines.map((line) => {
                const received = Number(line.qty_received ?? line.qty_pending);
                const diff = received - line.qty_requested;
                const isHighlighted = highlightLine === line.id;
                return (
                  <div
                    key={line.id}
                    ref={el => { lineRefs.current[line.id] = el; }}
                    className={`bg-white rounded-2xl border p-3 transition-all ${isHighlighted ? "border-teal-500 ring-2 ring-teal-300 shadow-md" : "border-slate-200"}`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0">
                        <p className="font-black text-slate-900 text-sm">{line.product_code}</p>
                        <p className="text-xs text-slate-500 truncate">{line.description}</p>
                        {line.barcode && <p className="text-xs text-slate-400 font-mono">{line.barcode}</p>}
                      </div>
                      <span className={`shrink-0 text-xs font-black rounded-full px-2 py-0.5 ${
                        diff === 0 ? "bg-green-100 text-green-700"
                        : diff > 0 ? "bg-blue-100 text-blue-700"
                        : "bg-red-100 text-red-600"
                      }`}>
                        {diffLabel(diff)}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-xs text-center">
                      <div className="rounded-xl bg-slate-50 border p-2">
                        <p className="text-slate-500 font-semibold">Enviado</p>
                        <p className="font-black text-slate-900">{fmt(line.qty_requested)} <span className="font-normal text-slate-400 text-[10px]">{line.unit}</span></p>
                      </div>
                      <div className="rounded-xl bg-teal-50 border border-teal-200 p-2">
                        <p className="text-teal-600 font-semibold">Recibido</p>
                        <input
                          id={`qty-${line.id}`}
                          type="number"
                          min="0"
                          step="1"
                          className="w-full text-center font-black text-teal-700 bg-transparent focus:outline-none text-sm"
                          value={line.qty_received ?? line.qty_pending}
                          onChange={e => setLines(prev => prev.map(l => l.id === line.id ? { ...l, qty_received: Number(e.target.value) } : l))}
                          disabled={selected.reception_status === "completed"}
                        />
                      </div>
                      <div className="rounded-xl bg-slate-50 border p-2">
                        <p className="text-slate-500 font-semibold">Diferencia</p>
                        <p className={`font-black text-sm ${diffClass(diff)}`}>{diffLabel(diff)}</p>
                      </div>
                    </div>

                    <input
                      className="mt-2 w-full border rounded-xl px-3 py-2 text-xs text-slate-900 bg-white placeholder:text-slate-400"
                      placeholder="Observación (opcional)"
                      value={line.notes ?? ""}
                      onChange={e => setLines(prev => prev.map(l => l.id === line.id ? { ...l, notes: e.target.value } : l))}
                      disabled={selected.reception_status === "completed"}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {/* Botones de acción */}
          {selected.reception_status !== "completed" && (
            <div className="sticky bottom-4 flex gap-3">
              <button
                onClick={() => saveReception(false)}
                disabled={saving}
                className="flex-1 rounded-2xl border bg-white py-3.5 font-black text-slate-700 text-sm disabled:opacity-50"
              >
                {saving ? "Guardando..." : "Guardar borrador"}
              </button>
              <button
                onClick={() => saveReception(true)}
                disabled={saving}
                className="flex-1 rounded-2xl bg-teal-600 text-white py-3.5 font-black text-sm disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <CheckCircle2 size={16} />
                {saving ? "Guardando..." : "Marcar completado"}
              </button>
            </div>
          )}

          {selected.reception_status === "completed" && (
            <div className="sticky bottom-4">
              <button onClick={() => setView("report")} className="w-full rounded-2xl bg-slate-900 text-white py-3.5 font-black text-sm flex items-center justify-center gap-2">
                <Printer size={16} /> Ver / Imprimir reporte
              </button>
            </div>
          )}
        </div>
      )}

      {/* ══════════════ REPORTE ══════════════ */}
      {view === "report" && selected && (
        <div className="flex-1 p-4 max-w-3xl w-full mx-auto space-y-4">
          <div className="bg-white rounded-2xl border p-4 space-y-4">

            {/* Cabecera reporte */}
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-black text-slate-900 text-lg">{selected.doc_number || selected.inv_request_no}</h2>
                <p className="text-sm text-slate-500">{selected.source_store_name} → {selected.destination_store_name}</p>
                {selected.completed_by_name && (
                  <p className="text-xs text-green-600 font-bold mt-0.5">✓ Registrado por {selected.completed_by_name}</p>
                )}
              </div>
              <StatusBadge status={selected.reception_status} />
            </div>

            {/* Resumen diferencias */}
            {(() => {
              const rows = lines.map(l => {
                const rec = records.find(r => r.line_id === l.id);
                const received = rec?.qty_received ?? Number(l.qty_received ?? l.qty_pending);
                return { ...l, received, diff: received - l.qty_requested };
              });
              const ok        = rows.filter(r => r.diff === 0).length;
              const sobrantes = rows.filter(r => r.diff > 0).length;
              const faltantes = rows.filter(r => r.diff < 0).length;
              return (
                <div className="grid grid-cols-4 gap-2 text-xs text-center">
                  {[
                    { label: "Códigos", val: rows.length, cls: "bg-slate-100 text-slate-700" },
                    { label: "OK",       val: ok,        cls: "bg-green-100 text-green-700" },
                    { label: "Sobrantes", val: sobrantes, cls: "bg-blue-100 text-blue-700" },
                    { label: "Faltantes", val: faltantes, cls: "bg-red-100 text-red-600" },
                  ].map(({ label, val, cls }) => (
                    <div key={label} className={`rounded-xl p-2 font-bold ${cls}`}>
                      <p className="text-[10px] font-semibold mb-0.5">{label}</p>
                      <p className="text-xl font-black">{val}</p>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Tabla detalle */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-900 text-white text-xs">
                    <th className="p-2 text-left rounded-tl-xl">#</th>
                    <th className="p-2 text-left">Código</th>
                    <th className="p-2 text-left">Descripción</th>
                    <th className="p-2 text-right">Enviado</th>
                    <th className="p-2 text-right">Recibido</th>
                    <th className="p-2 text-right">Dif.</th>
                    <th className="p-2 text-center rounded-tr-xl">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => {
                    const rec = records.find(r => r.line_id === line.id);
                    const received = rec?.qty_received ?? Number(line.qty_received ?? line.qty_pending);
                    const diff = received - line.qty_requested;
                    return (
                      <tr key={line.id} className={idx % 2 === 0 ? "bg-slate-50" : ""}>
                        <td className="p-2 text-slate-400 text-xs">{idx + 1}</td>
                        <td className="p-2 font-black text-slate-900 text-xs">{line.product_code}</td>
                        <td className="p-2 text-slate-600 text-xs">{line.description || "-"}</td>
                        <td className="p-2 text-right text-xs">{fmt(line.qty_requested)}</td>
                        <td className="p-2 text-right font-black text-xs">{fmt(received)}</td>
                        <td className={`p-2 text-right text-xs ${diffClass(diff)}`}>{diffLabel(diff)}</td>
                        <td className={`p-2 text-center text-xs font-black ${diffClass(diff)}`}>
                          {diff === 0 ? "OK" : diff > 0 ? "SOBRE" : "FALTA"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-900 font-black">
                    <td className="p-2 text-xs" colSpan={3}>TOTAL</td>
                    <td className="p-2 text-right text-xs">{fmt(lines.reduce((s, l) => s + l.qty_requested, 0))}</td>
                    <td className="p-2 text-right text-xs">{fmt(lines.reduce((s, l) => {
                      const r = records.find(rc => rc.line_id === l.id);
                      return s + (r?.qty_received ?? Number(l.qty_received ?? l.qty_pending));
                    }, 0))}</td>
                    <td className="p-2 text-right text-xs" colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Observaciones con diferencias */}
            {records.some(r => r.notes) && (
              <div className="border-t pt-3">
                <p className="text-xs font-black text-slate-700 mb-2">Observaciones</p>
                {records.filter(r => r.notes).map(r => {
                  const line = lines.find(l => l.id === r.line_id);
                  return (
                    <p key={r.id} className="text-xs text-slate-600">
                      <b>{line?.product_code}:</b> {r.notes}
                    </p>
                  );
                })}
              </div>
            )}

            {/* Firmas */}
            <div className="border-t pt-4 mt-2">
              <div className="flex justify-around gap-8">
                {["Jefe de Tienda", "Asesor de Almacén"].map(role => (
                  <div key={role} className="flex-1 text-center">
                    <div className="border-t-2 border-slate-400 pt-2 mt-12 mx-4">
                      <p className="text-xs font-black text-slate-700">{role}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">
                        {role === "Jefe de Tienda"
                          ? selected.destination_store_name || selected.destination_store_code
                          : "CD-GPC"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <button onClick={printReport} className="w-full rounded-2xl bg-slate-900 text-white py-3.5 font-black text-sm flex items-center justify-center gap-2">
              <Printer size={16} /> Imprimir reporte
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
