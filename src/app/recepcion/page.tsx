"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronLeft, Home, LogOut, Package, Printer, QrCode, RotateCw, Search, X } from "lucide-react";
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
  // Local state (no persisted until save)
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

function statusBadge(status: ReceptionRequest["reception_status"]) {
  if (status === "completed")  return <span className="rounded-full bg-green-100 text-green-700 text-xs font-bold px-2.5 py-0.5">Completado</span>;
  if (status === "in_progress") return <span className="rounded-full bg-amber-100 text-amber-700 text-xs font-bold px-2.5 py-0.5">En proceso</span>;
  return <span className="rounded-full bg-slate-100 text-slate-600 text-xs font-bold px-2.5 py-0.5">Pendiente</span>;
}

function fmt(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

function diffColor(diff: number) {
  if (diff === 0)  return "text-green-700 font-bold";
  if (diff > 0)   return "text-blue-700 font-bold";
  return "text-red-600 font-bold";
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function RecepcionPage() {
  const [user, setUser]       = useState<CyclicUser | null>(null);
  const [stores, setStores]   = useState<Store[]>([]);
  const [requests, setRequests] = useState<ReceptionRequest[]>([]);
  const [selected, setSelected] = useState<ReceptionRequest | null>(null);
  const [lines, setLines]     = useState<ReceptionLine[]>([]);
  const [records, setRecords] = useState<ReceptionRecord[]>([]);
  const [message, setMessage] = useState<{ text: string; type: "info" | "success" | "error" } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [view, setView]       = useState<"list" | "detail" | "report">("list");
  const [search, setSearch]   = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "pending" | "in_progress" | "completed">("all");
  const [scanTarget, setScanTarget] = useState<number | null>(null); // index of line being scanned
  const scannerRef = useRef<any>(null);
  const scannerContainerId = "recepcion-scanner";
  const [ready, setReady] = useState(false);

  const showMessage = useCallback((text: string, type: "info" | "success" | "error" = "info") => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 4000);
  }, []);

  // ─── Init ────────────────────────────────────────────────────────────────────

  useEffect(() => {
    const stored = readStoredUser<CyclicUser>();
    if (!stored || !canAccessModule(stored, "reception")) {
      window.location.replace("/");
      return;
    }
    setUser(stored);
    Promise.all([
      supabase.from("stores").select("id, code, name, erp_sede, is_active").order("name"),
    ]).then(([{ data: storeData }]) => {
      setStores((storeData || []) as Store[]);
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!ready || !user) return;
    void loadRequests();
  }, [ready, user]);

  // ─── Cargar requerimientos ───────────────────────────────────────────────────

  async function loadRequests() {
    setLoading(true);
    try {
      let query = supabase
        .from("reception_requests")
        .select("*")
        .order("creation_date", { ascending: false })
        .limit(200);

      // Operarios solo ven su tienda
      if (user?.role === "Operario" && user.store_id) {
        const store = stores.find(s => s.id === user.store_id);
        if (store) {
          query = query.or(`destination_store_code.eq.${store.code},destination_store_code.eq.${store.erp_sede ?? store.code}`);
        }
      }

      const { data, error } = await query;
      if (error) throw error;
      setRequests((data || []) as ReceptionRequest[]);
    } catch (e: any) {
      showMessage("Error cargando requerimientos: " + e.message, "error");
    } finally {
      setLoading(false);
    }
  }

  // ─── Abrir detalle ───────────────────────────────────────────────────────────

  async function openRequest(req: ReceptionRequest) {
    setSelected(req);
    setView("detail");
    setLoading(true);
    try {
      const [{ data: lineData }, { data: recordData }] = await Promise.all([
        supabase.from("reception_request_lines").select("*").eq("request_id", req.id).order("line_id"),
        supabase.from("reception_records").select("*").eq("request_id", req.id),
      ]);
      const existingRecords = (recordData || []) as ReceptionRecord[];
      const loadedLines = ((lineData || []) as ReceptionLine[]).map(line => {
        const existing = existingRecords.find(r => r.line_id === line.id);
        return {
          ...line,
          qty_received: existing?.qty_received ?? line.qty_pending,
          notes: existing?.notes ?? "",
        };
      });
      setLines(loadedLines);
      setRecords(existingRecords);
    } catch (e: any) {
      showMessage("Error cargando líneas: " + e.message, "error");
    } finally {
      setLoading(false);
    }
  }

  // ─── Guardar recepción ───────────────────────────────────────────────────────

  async function saveReception(markComplete: boolean) {
    if (!selected || !user) return;
    setSaving(true);
    try {
      const now = new Date().toISOString();

      // Upsert records por línea
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

      // Borra registros previos y reinserta (upsert por request_id + line_id no está disponible sin PK compuesta)
      await supabase.from("reception_records").delete().eq("request_id", selected.id);
      if (recordRows.length) {
        const { error } = await supabase.from("reception_records").insert(recordRows);
        if (error) throw error;
      }

      // Actualizar estado del request
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
      showMessage(markComplete ? "✅ Recepción completada." : "Guardado.", "success");
      if (markComplete) setView("report");
    } catch (e: any) {
      showMessage("Error guardando: " + e.message, "error");
    } finally {
      setSaving(false);
    }
  }

  // ─── Escaneo QR ──────────────────────────────────────────────────────────────

  async function openScanner(lineIndex: number) {
    setScanTarget(lineIndex);
    setTimeout(async () => {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        const scanner = new Html5Qrcode(scannerContainerId);
        scannerRef.current = scanner;
        const devices = await Html5Qrcode.getCameras();
        const cameraId = devices.find(d => /back|rear|environment/i.test(d.label))?.id || devices[0]?.id;
        if (!cameraId) { showMessage("No se encontró cámara.", "error"); return; }
        await scanner.start(cameraId, { fps: 10, qrbox: 250 }, (decoded) => {
          void scanner.stop();
          scannerRef.current = null;
          setScanTarget(null);
          // Buscar la línea que coincide con el código escaneado
          const match = lines.findIndex(l =>
            l.product_code === decoded || l.barcode === decoded || l.sku === decoded
          );
          if (match >= 0) {
            showMessage(`✅ Código encontrado: ${lines[match].product_code}`, "success");
            document.getElementById(`qty-input-${match}`)?.focus();
          } else {
            showMessage(`Código ${decoded} no encontrado en este requerimiento.`, "error");
          }
        }, () => {});
      } catch (e: any) {
        showMessage("Error escáner: " + e.message, "error");
      }
    }, 100);
  }

  function closeScanner() {
    if (scannerRef.current) { void scannerRef.current.stop(); scannerRef.current = null; }
    setScanTarget(null);
  }

  // ─── Reporte imprimible ──────────────────────────────────────────────────────

  async function printReport() {
    if (!selected) return;
    const { data: recs } = await supabase
      .from("reception_records").select("*").eq("request_id", selected.id);
    const reportRecords = (recs || []) as ReceptionRecord[];

    const rows = lines.map(line => {
      const rec = reportRecords.find(r => r.line_id === line.id);
      const received = rec?.qty_received ?? 0;
      const diff = received - line.qty_requested;
      return { line, received, diff };
    });

    const totalReq = rows.reduce((s, r) => s + r.line.qty_requested, 0);
    const totalRec = rows.reduce((s, r) => s + r.received, 0);
    const totalDiff = totalRec - totalReq;

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
      <title>Recepción ${selected.doc_number || selected.inv_request_no}</title>
      <style>
        body { font-family: Arial, sans-serif; font-size: 11px; margin: 20px; color: #111; }
        h2 { font-size: 14px; margin: 0 0 4px; }
        .info { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; border: 1px solid #ccc; padding: 8px; border-radius: 6px; }
        .info-item label { font-weight: bold; display: block; color: #555; font-size: 10px; }
        table { width: 100%; border-collapse: collapse; margin-top: 8px; }
        th { background: #1e293b; color: white; padding: 6px 4px; text-align: left; font-size: 10px; }
        td { padding: 5px 4px; border-bottom: 1px solid #e2e8f0; font-size: 10px; }
        tr:nth-child(even) td { background: #f8fafc; }
        .ok { color: #15803d; font-weight: bold; }
        .over { color: #1d4ed8; font-weight: bold; }
        .under { color: #dc2626; font-weight: bold; }
        .totals td { font-weight: bold; border-top: 2px solid #1e293b; }
        .footer { margin-top: 24px; display: flex; justify-content: space-between; }
        .sign-line { border-top: 1px solid #000; width: 180px; text-align: center; padding-top: 4px; font-size: 10px; }
        @media print { body { margin: 10px; } }
      </style></head><body>
      <h2>Reporte de Recepción</h2>
      <p style="color:#555;font-size:10px;margin:0 0 8px">Generado: ${new Date().toLocaleString("es-PE")}</p>
      <div class="info">
        <div class="info-item"><label>DOCUMENTO</label>${selected.doc_number || selected.inv_request_no || "-"}</div>
        <div class="info-item"><label>MOTIVO</label>${selected.reason || "-"}</div>
        <div class="info-item"><label>ORIGEN (CD)</label>${selected.source_store_name || selected.source_store_code}</div>
        <div class="info-item"><label>TIENDA DESTINO</label>${selected.destination_store_name || selected.destination_store_code}</div>
        <div class="info-item"><label>FECHA REQUERIMIENTO</label>${selected.request_date ? new Date(selected.request_date).toLocaleDateString("es-PE") : "-"}</div>
        <div class="info-item"><label>COMPLETADO POR</label>${selected.completed_by_name || "-"}</div>
      </div>
      <table>
        <thead><tr>
          <th>#</th><th>Código</th><th>Descripción</th><th>UM</th>
          <th style="text-align:right">Solicitado</th>
          <th style="text-align:right">Recibido</th>
          <th style="text-align:right">Diferencia</th>
          <th>Obs.</th>
        </tr></thead>
        <tbody>
          ${rows.map((r, i) => {
            const cls = r.diff === 0 ? "ok" : r.diff > 0 ? "over" : "under";
            const diffLabel = r.diff === 0 ? "OK" : r.diff > 0 ? `+${fmt(r.diff)}` : fmt(r.diff);
            const rec = reportRecords.find(rec => rec.line_id === r.line.id);
            return `<tr>
              <td>${i + 1}</td>
              <td style="font-weight:bold">${r.line.product_code}</td>
              <td>${r.line.description || "-"}</td>
              <td>${r.line.unit || "-"}</td>
              <td style="text-align:right">${fmt(r.line.qty_requested)}</td>
              <td style="text-align:right;font-weight:bold">${fmt(r.received)}</td>
              <td style="text-align:right" class="${cls}">${diffLabel}</td>
              <td>${rec?.notes || ""}</td>
            </tr>`;
          }).join("")}
        </tbody>
        <tfoot><tr class="totals">
          <td colspan="4">TOTAL</td>
          <td style="text-align:right">${fmt(totalReq)}</td>
          <td style="text-align:right">${fmt(totalRec)}</td>
          <td style="text-align:right" class="${totalDiff === 0 ? "ok" : totalDiff > 0 ? "over" : "under"}">
            ${totalDiff === 0 ? "OK" : totalDiff > 0 ? `+${fmt(totalDiff)}` : fmt(totalDiff)}
          </td>
          <td></td>
        </tr></tfoot>
      </table>
      <div class="footer">
        <div class="sign-line">Recibido por</div>
        <div class="sign-line">Verificado por</div>
        <div class="sign-line">CD — Firma despacho</div>
      </div>
      </body></html>`;

    const win = window.open("", "_blank");
    if (!win) { showMessage("Permite ventanas emergentes para imprimir.", "error"); return; }
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 400);
  }

  // ─── Filtros de lista ────────────────────────────────────────────────────────

  const filteredRequests = requests.filter(r => {
    if (filterStatus !== "all" && r.reception_status !== filterStatus) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return [r.doc_number, r.inv_request_no, r.destination_store_name, r.source_store_name, r.reason]
      .join(" ").toLowerCase().includes(q);
  });

  // ─── Render ───────────────────────────────────────────────────────────────────

  if (!ready) {
    return <main className="min-h-screen bg-slate-100 flex items-center justify-center"><p className="text-slate-500 font-semibold">Cargando...</p></main>;
  }

  return (
    <main className="min-h-screen bg-slate-100 flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white border-b shadow-sm px-4 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button onClick={() => window.location.href = "/"} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Menú principal">
            <Home size={18} />
          </button>
          {view !== "list" && (
            <button onClick={() => { setView("list"); setSelected(null); setLines([]); }} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Volver a lista">
              <ChevronLeft size={18} />
            </button>
          )}
          <div>
            <h1 className="font-bold text-slate-900 text-base">
              {view === "list" ? "Recepción de Requerimientos" : view === "report" ? "Reporte de Recepción" : selected?.doc_number || selected?.inv_request_no || "Detalle"}
            </h1>
            <p className="text-xs text-slate-400">{user?.full_name}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {view === "detail" && (
            <button onClick={() => setView("report")} className="hidden sm:flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">
              <Printer size={15} /> Reporte
            </button>
          )}
          {view === "report" && (
            <button onClick={printReport} className="flex items-center gap-1.5 rounded-xl bg-slate-900 text-white px-3 py-2 text-sm font-semibold">
              <Printer size={15} /> Imprimir
            </button>
          )}
          <button onClick={() => { void loadRequests(); showMessage("Actualizado.", "info"); }} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Actualizar">
            <RotateCw size={16} />
          </button>
          <button onClick={() => { if (user) void endSingleDeviceSession(user); localStorage.removeItem("cyclic_user"); window.location.replace("/"); }}
            className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">
            <LogOut size={15} /> Salir
          </button>
        </div>
      </header>

      {/* Mensaje */}
      {message && (
        <div className={`mx-4 mt-3 rounded-2xl px-4 py-3 text-sm font-semibold ${message.type === "success" ? "bg-green-50 text-green-700 border border-green-200" : message.type === "error" ? "bg-red-50 text-red-700 border border-red-200" : "bg-blue-50 text-blue-700 border border-blue-200"}`}>
          {message.text}
        </div>
      )}

      {/* ══════════════ LISTA ══════════════ */}
      {view === "list" && (
        <div className="flex-1 p-4 space-y-3 max-w-3xl w-full mx-auto">
          {/* Filtros */}
          <div className="flex gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[180px]">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input className="w-full border rounded-2xl pl-9 pr-3 py-2.5 text-sm bg-white text-slate-900"
                placeholder="Buscar documento, tienda..." value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <select className="border rounded-2xl px-3 py-2.5 text-sm bg-white text-slate-900"
              value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)}>
              <option value="all">Todos</option>
              <option value="pending">Pendiente</option>
              <option value="in_progress">En proceso</option>
              <option value="completed">Completados</option>
            </select>
          </div>

          {loading && <p className="text-slate-400 text-sm text-center py-8">Cargando...</p>}
          {!loading && filteredRequests.length === 0 && (
            <div className="text-center py-16 text-slate-400">
              <Package size={40} className="mx-auto mb-3 opacity-30" />
              <p className="font-semibold">No hay requerimientos{filterStatus !== "all" ? " en este estado" : ""}</p>
              <p className="text-xs mt-1">Los requerimientos aprobados por CD-GPC aparecerán aquí.</p>
            </div>
          )}
          {filteredRequests.map(req => (
            <button key={req.id} onClick={() => openRequest(req)}
              className="w-full text-left bg-white rounded-2xl border p-4 shadow-sm hover:shadow-md hover:border-teal-400 transition-all space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-bold text-slate-900">{req.doc_number || req.inv_request_no || req.erp_inv_request_id}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{req.reason || "Abastecimiento"}</p>
                </div>
                {statusBadge(req.reception_status)}
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
                <span><b>Origen:</b> {req.source_store_name || req.source_store_code}</span>
                <span><b>Destino:</b> {req.destination_store_name || req.destination_store_code}</span>
                <span><b>Líneas:</b> {req.line_count}</span>
                <span><b>Cant. total:</b> {fmt(req.qty_requested_total)}</span>
              </div>
              {req.reception_status === "completed" && req.completed_by_name && (
                <p className="text-xs text-green-600 font-semibold">✓ Completado por {req.completed_by_name}</p>
              )}
            </button>
          ))}
        </div>
      )}

      {/* ══════════════ DETALLE ══════════════ */}
      {view === "detail" && selected && (
        <div className="flex-1 p-4 max-w-3xl w-full mx-auto space-y-4">
          {/* Info cabecera */}
          <div className="bg-white rounded-2xl border p-4 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-bold text-slate-900 text-lg">{selected.doc_number || selected.inv_request_no}</p>
                <p className="text-sm text-slate-500">{selected.reason || "Abastecimiento"}</p>
              </div>
              {statusBadge(selected.reception_status)}
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
              <span><b>CD origen:</b> {selected.source_store_name || selected.source_store_code}</span>
              <span><b>Tienda:</b> {selected.destination_store_name || selected.destination_store_code}</span>
              <span><b>Líneas:</b> {selected.line_count}</span>
              <span><b>Total solicitado:</b> {fmt(selected.qty_requested_total)}</span>
            </div>
          </div>

          {/* Escáner */}
          {scanTarget !== null && (
            <div className="fixed inset-0 bg-black/70 z-50 flex flex-col items-center justify-center p-4 gap-4">
              <div id={scannerContainerId} className="rounded-2xl overflow-hidden w-full max-w-xs" />
              <button onClick={closeScanner} className="rounded-2xl bg-white px-6 py-3 font-bold text-slate-900">
                <X size={16} className="inline mr-2" />Cancelar
              </button>
            </div>
          )}

          {/* Líneas */}
          {loading ? <p className="text-slate-400 text-sm text-center py-8">Cargando líneas...</p> : (
            <div className="space-y-3">
              {lines.map((line, idx) => {
                const received = Number(line.qty_received ?? line.qty_pending);
                const diff = received - line.qty_requested;
                return (
                  <div key={line.id} className="bg-white rounded-2xl border p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-bold text-slate-900 text-sm">{line.product_code}</p>
                        <p className="text-xs text-slate-500 truncate">{line.description}</p>
                        {line.barcode && <p className="text-xs text-slate-400 font-mono">{line.barcode}</p>}
                      </div>
                      <button onClick={() => openScanner(idx)} className="shrink-0 rounded-xl border p-2 text-slate-600 hover:bg-slate-50">
                        <QrCode size={16} />
                      </button>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-xs text-center">
                      <div className="rounded-xl bg-slate-50 border p-2">
                        <p className="text-slate-500 font-semibold">Solicitado</p>
                        <p className="font-black text-slate-900">{fmt(line.qty_requested)} <span className="font-normal text-slate-400">{line.unit}</span></p>
                      </div>
                      <div className="rounded-xl bg-teal-50 border border-teal-200 p-2">
                        <p className="text-teal-600 font-semibold">Recibido</p>
                        <input
                          id={`qty-input-${idx}`}
                          type="number"
                          min="0"
                          step="1"
                          className="w-full text-center font-black text-teal-700 bg-transparent focus:outline-none text-sm"
                          value={line.qty_received ?? line.qty_pending}
                          onChange={e => setLines(prev => prev.map((l, i) => i === idx ? { ...l, qty_received: Number(e.target.value) } : l))}
                          disabled={selected.reception_status === "completed"}
                        />
                      </div>
                      <div className="rounded-xl bg-slate-50 border p-2">
                        <p className="text-slate-500 font-semibold">Diferencia</p>
                        <p className={`font-black text-sm ${diffColor(diff)}`}>
                          {diff === 0 ? "OK" : diff > 0 ? `+${fmt(diff)}` : fmt(diff)}
                        </p>
                      </div>
                    </div>

                    <input
                      className="w-full border rounded-xl px-3 py-2 text-xs text-slate-900 bg-white"
                      placeholder="Observación (opcional)"
                      value={line.notes ?? ""}
                      onChange={e => setLines(prev => prev.map((l, i) => i === idx ? { ...l, notes: e.target.value } : l))}
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
                className="flex-1 rounded-2xl border bg-white py-3.5 font-bold text-slate-700 text-sm disabled:opacity-50"
              >
                {saving ? "Guardando..." : "Guardar borrador"}
              </button>
              <button
                onClick={() => saveReception(true)}
                disabled={saving}
                className="flex-1 rounded-2xl bg-teal-600 text-white py-3.5 font-bold text-sm disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <CheckCircle2 size={16} />
                {saving ? "Guardando..." : "Marcar completado"}
              </button>
            </div>
          )}

          {selected.reception_status === "completed" && (
            <div className="flex gap-3 sticky bottom-4">
              <button onClick={() => setView("report")} className="flex-1 rounded-2xl bg-slate-900 text-white py-3.5 font-bold text-sm flex items-center justify-center gap-2">
                <Printer size={16} /> Ver reporte
              </button>
            </div>
          )}
        </div>
      )}

      {/* ══════════════ REPORTE ══════════════ */}
      {view === "report" && selected && (
        <div className="flex-1 p-4 max-w-3xl w-full mx-auto space-y-4">
          <div className="bg-white rounded-2xl border p-4 space-y-3">
            <div>
              <h2 className="font-bold text-slate-900 text-lg">Reporte: {selected.doc_number || selected.inv_request_no}</h2>
              <p className="text-sm text-slate-500">{selected.destination_store_name} ← {selected.source_store_name}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-900 text-white">
                  <tr>
                    <th className="p-2 text-left rounded-tl-xl">Código</th>
                    <th className="p-2 text-left">Descripción</th>
                    <th className="p-2 text-right">Solicitado</th>
                    <th className="p-2 text-right">Recibido</th>
                    <th className="p-2 text-right rounded-tr-xl">Dif.</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => {
                    const rec = records.find(r => r.line_id === line.id);
                    const received = rec?.qty_received ?? Number(line.qty_received ?? line.qty_pending);
                    const diff = received - line.qty_requested;
                    return (
                      <tr key={line.id} className={idx % 2 === 0 ? "bg-slate-50" : ""}>
                        <td className="p-2 font-bold">{line.product_code}</td>
                        <td className="p-2 text-slate-600 text-xs">{line.description}</td>
                        <td className="p-2 text-right">{fmt(line.qty_requested)}</td>
                        <td className="p-2 text-right font-bold">{fmt(received)}</td>
                        <td className={`p-2 text-right ${diffColor(diff)}`}>
                          {diff === 0 ? "OK" : diff > 0 ? `+${fmt(diff)}` : fmt(diff)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-900 font-bold">
                    <td className="p-2" colSpan={2}>TOTAL</td>
                    <td className="p-2 text-right">{fmt(lines.reduce((s, l) => s + l.qty_requested, 0))}</td>
                    <td className="p-2 text-right">{fmt(lines.reduce((s, l) => { const r = records.find(rc => rc.line_id === l.id); return s + (r?.qty_received ?? Number(l.qty_received ?? l.qty_pending)); }, 0))}</td>
                    <td className="p-2 text-right">
                      {(() => { const d = lines.reduce((s, l) => { const r = records.find(rc => rc.line_id === l.id); const recv = r?.qty_received ?? Number(l.qty_received ?? l.qty_pending); return s + (recv - l.qty_requested); }, 0); return <span className={diffColor(d)}>{d === 0 ? "OK" : d > 0 ? `+${fmt(d)}` : fmt(d)}</span>; })()}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <button onClick={printReport} className="w-full rounded-2xl bg-slate-900 text-white py-3.5 font-bold text-sm flex items-center justify-center gap-2">
              <Printer size={16} /> Imprimir reporte
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
