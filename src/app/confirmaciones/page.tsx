"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Banknote, Camera, CheckCircle2, Clock, Edit3, Eye, Home, RotateCcw, Save, Search, Upload, XCircle } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";
import { writeStoredUser } from "@/lib/singleDeviceSession";
import type { CyclicUser, Store } from "@/features/ciclicos/types";

type ConfirmationStatus = "Pendiente" | "Confirmado" | "Anulacion solicitada" | "Anulado";
type PaymentMethod = "Yape" | "Plin" | "Deposito";

type PaymentConfirmation = {
  id: string;
  store_id: string | null;
  store_name: string;
  cashier_id: string | null;
  cashier_name: string;
  document_reference: string;
  amount: number;
  payment_method: PaymentMethod;
  photo_path: string;
  photo_taken_at: string;
  registered_at: string;
  status: ConfirmationStatus;
  opened_at: string | null;
  opened_by: string | null;
  opened_by_name: string | null;
  operation_number: string | null;
  bank: string | null;
  validator_id: string | null;
  validator_name: string | null;
  confirmed_at: string | null;
  cancellation_requested_at: string | null;
  cancellation_reason: string | null;
  cancellation_validator_id: string | null;
  cancellation_validator_name: string | null;
  cancelled_at: string | null;
  updated_at: string;
};

const BUCKET = "payment-confirmations";
const STATUS_ORDER: Record<ConfirmationStatus, number> = {
  "Pendiente": 0,
  "Anulacion solicitada": 1,
  "Confirmado": 2,
  "Anulado": 3,
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function dateStart(date: string) {
  return `${date}T00:00:00`;
}

function dateEnd(date: string) {
  return `${date}T23:59:59.999`;
}

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatMoney(value: number | string | null | undefined) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat("es-PE", {
    style: "currency",
    currency: "PEN",
  }).format(amount);
}

function parseAmount(value: string) {
  const normalized = value.replace(/[^\d.,]/g, "").replace(",", ".");
  const parts = normalized.split(".");
  if (parts.length > 2) {
    return Number(`${parts.slice(0, -1).join("")}.${parts.at(-1)}`);
  }
  return Number(normalized);
}

function normalizeOperation(value: string) {
  return value.trim().replace(/\s+/g, "").toUpperCase();
}

function statusClass(status: ConfirmationStatus) {
  if (status === "Pendiente") return "bg-amber-100 text-amber-800 border-amber-200";
  if (status === "Confirmado") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (status === "Anulacion solicitada") return "bg-orange-100 text-orange-800 border-orange-200";
  return "bg-slate-100 text-slate-600 border-slate-200";
}

function sortRows(rows: PaymentConfirmation[]) {
  return [...rows].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    if (a.status === "Confirmado" || a.status === "Anulado") {
      return new Date(a.registered_at).getTime() - new Date(b.registered_at).getTime();
    }
    return new Date(b.registered_at).getTime() - new Date(a.registered_at).getTime();
  });
}

async function stampPhoto(file: File, takenAt: Date) {
  const bitmap = await createImageBitmap(file);
  const maxWidth = 1600;
  const ratio = Math.min(1, maxWidth / bitmap.width);
  const width = Math.round(bitmap.width * ratio);
  const height = Math.round(bitmap.height * ratio);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No se pudo preparar la foto.");
  ctx.drawImage(bitmap, 0, 0, width, height);

  const stamp = new Intl.DateTimeFormat("es-PE", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(takenAt);
  const fontSize = Math.max(24, Math.round(width * 0.035));
  ctx.font = `700 ${fontSize}px Arial, sans-serif`;
  const padding = Math.round(fontSize * 0.65);
  const metrics = ctx.measureText(stamp);
  const boxW = metrics.width + padding * 2;
  const boxH = fontSize + padding * 1.5;
  const x = padding;
  const y = height - boxH - padding;
  ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
  ctx.fillRect(x, y, boxW, boxH);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(stamp, x + padding, y + fontSize + padding * 0.15);

  return new Promise<{ blob: Blob; previewUrl: string }>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("No se pudo generar la foto."));
        return;
      }
      resolve({ blob, previewUrl: canvas.toDataURL("image/jpeg", 0.88) });
    }, "image/jpeg", 0.88);
  });
}

export default function ConfirmacionesPage() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [rows, setRows] = useState<PaymentConfirmation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"info" | "success" | "error">("info");

  const [documentReference, setDocumentReference] = useState("");
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("Yape");
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [photoPreview, setPhotoPreview] = useState("");
  const [photoTakenAt, setPhotoTakenAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);

  const [filterDate, setFilterDate] = useState(todayISO());
  const [filterStoreId, setFilterStoreId] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<PaymentConfirmation | null>(null);
  const [operationNumber, setOperationNumber] = useState("");
  const [bank, setBank] = useState("");
  const [editDocument, setEditDocument] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editMethod, setEditMethod] = useState<PaymentMethod>("Yape");
  const [editing, setEditing] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  const beepTimerRef = useRef<number | null>(null);
  const realtimeRefreshRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const canValidate = Boolean(user && (user.role === "Administrador" || user.role === "Validador" || user.role === "Supervisor"));
  const canCashier = Boolean(user && (user.role === "Cajero" || user.role === "Administrador"));
  const visibleRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return sortRows(rows).filter((row) => {
      if (!term) return true;
      return [
        row.store_name,
        row.cashier_name,
        row.document_reference,
        row.operation_number || "",
        row.bank || "",
        row.payment_method,
        row.status,
      ].some((value) => value.toLowerCase().includes(term));
    });
  }, [rows, search]);
  const pendingUnopenedCount = useMemo(() => rows.filter((row) => row.status === "Pendiente" && !row.opened_at).length, [rows]);

  const showMessage = useCallback((text: string, type: "info" | "success" | "error" = "info") => {
    setMessage(text);
    setMessageType(type);
    window.setTimeout(() => setMessage(""), 4500);
  }, []);

  const loadStores = useCallback(async () => {
    const { data } = await supabase.from("stores").select("id,code,name,erp_sede,is_active").order("name");
    setStores((data || []) as Store[]);
  }, []);

  const loadRows = useCallback(async (currentUser: CyclicUser | null = user, options: { showLoading?: boolean } = {}) => {
    if (!currentUser) return;
    const showLoading = options.showLoading ?? false;
    if (showLoading) setLoading(true);
    else setRefreshing(true);
    let query = supabase
      .from("payment_confirmations")
      .select("*")
      .gte("registered_at", dateStart(filterDate))
      .lte("registered_at", dateEnd(filterDate))
      .order("registered_at", { ascending: false });

    if (canValidate) {
      if (filterStoreId) query = query.eq("store_id", filterStoreId);
    } else if (currentUser.store_id) {
      query = query.eq("store_id", currentUser.store_id);
    } else {
      query = query.eq("cashier_id", currentUser.id);
    }

    const { data, error } = await query;
    if (showLoading) setLoading(false);
    else setRefreshing(false);
    if (error) {
      showMessage("No se pudieron cargar confirmaciones: " + error.message, "error");
      return;
    }
    setRows((data || []) as PaymentConfirmation[]);
  }, [canValidate, filterDate, filterStoreId, showMessage, user]);

  useEffect(() => {
    const raw = localStorage.getItem("cyclic_user");
    if (!raw) {
      window.location.replace("/");
      return;
    }
    let parsed: CyclicUser;
    try {
      parsed = JSON.parse(raw) as CyclicUser;
    } catch {
      window.location.replace("/");
      return;
    }

    (async () => {
      const { data } = await supabase.from("cyclic_users").select("*").eq("id", parsed.id).maybeSingle();
      const current = (data || parsed) as CyclicUser;
      if (!current.is_active || !canAccessModule(current, "confirmations")) {
        localStorage.removeItem("cyclic_user");
        window.location.replace("/");
        return;
      }
      writeStoredUser(current);
      setUser(current);
      await loadStores();
      await loadRows(current, { showLoading: true });
    })();
  }, [loadRows, loadStores]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => void loadRows(user, { showLoading: true }), 0);
    return () => window.clearTimeout(timer);
  }, [loadRows, user]);

  useEffect(() => {
    const channel = supabase
      .channel("payment_confirmations_realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "payment_confirmations" },
        () => {
          if (realtimeRefreshRef.current) window.clearTimeout(realtimeRefreshRef.current);
          realtimeRefreshRef.current = window.setTimeout(() => void loadRows(user, { showLoading: false }), 250);
        }
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
      if (realtimeRefreshRef.current) window.clearTimeout(realtimeRefreshRef.current);
    };
  }, [loadRows, user]);

  function stopSound() {
    if (beepTimerRef.current) window.clearInterval(beepTimerRef.current);
    beepTimerRef.current = null;
  }

  const playBeep = useCallback(async (force = false) => {
    if (!soundEnabled && !force) return;
    try {
      const AudioCtor = window.AudioContext || (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) return;
      const ctx = audioRef.current || new AudioCtor();
      audioRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume();
      [980, 1240, 1560].forEach((frequency, index) => {
        const start = ctx.currentTime + index * 0.18;
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = "square";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.45, start + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.16);
      });
      setSoundBlocked(false);
    } catch {
      setSoundBlocked(true);
    }
  }, [soundEnabled]);

  useEffect(() => {
    stopSound();
    if (!canValidate || pendingUnopenedCount === 0 || !soundEnabled) return;
    const firstBeep = window.setTimeout(() => void playBeep(), 0);
    beepTimerRef.current = window.setInterval(() => void playBeep(), 950);
    return () => {
      window.clearTimeout(firstBeep);
      stopSound();
    };
  }, [canValidate, pendingUnopenedCount, playBeep, soundEnabled]);

  async function enableSound() {
    setSoundEnabled(true);
    await playBeep(true);
  }

  async function onPhotoChange(file: File | null) {
    if (!file) return;
    const taken = new Date();
    try {
      const stamped = await stampPhoto(file, taken);
      setPhotoBlob(stamped.blob);
      setPhotoPreview(stamped.previewUrl);
      setPhotoTakenAt(taken);
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "No se pudo procesar la foto.", "error");
    }
  }

  async function createConfirmation() {
    if (!user) return;
    if (!documentReference.trim()) {
      showMessage("El documento de referencia es obligatorio.", "error");
      return;
    }
    const parsedAmount = parseAmount(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      showMessage("Ingresa un monto valido en soles.", "error");
      return;
    }
    if (!photoBlob || !photoTakenAt) {
      showMessage("La foto es obligatoria. Puedes tomarla con camara o subirla desde galeria.", "error");
      return;
    }

    const store = stores.find((item) => item.id === user.store_id);
    if (!store && !user.can_access_all_stores) {
      showMessage("Tu usuario cajero no tiene tienda asignada.", "error");
      return;
    }

    setSaving(true);
    const path = `${user.store_id || "sin-tienda"}/${Date.now()}-${user.id}.jpg`;
    const upload = await supabase.storage.from(BUCKET).upload(path, photoBlob, {
      contentType: "image/jpeg",
      upsert: false,
    });
    if (upload.error) {
      setSaving(false);
      showMessage("No se pudo subir la foto. Revisa que el bucket exista.", "error");
      return;
    }

    const { error } = await supabase.from("payment_confirmations").insert({
      store_id: user.store_id || null,
      store_name: store?.name || "Sin tienda",
      cashier_id: user.id,
      cashier_name: user.full_name,
      document_reference: documentReference.trim(),
      amount: parsedAmount,
      payment_method: paymentMethod,
      photo_path: path,
      photo_taken_at: photoTakenAt.toISOString(),
      status: "Pendiente",
    });
    setSaving(false);
    if (error) {
      showMessage("No se pudo guardar la solicitud: " + error.message, "error");
      return;
    }
    setDocumentReference("");
    setAmount("");
    setPaymentMethod("Yape");
    setPhotoBlob(null);
    setPhotoPreview("");
    setPhotoTakenAt(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (galleryInputRef.current) galleryInputRef.current.value = "";
    showMessage("Solicitud registrada. Estado: Pendiente.", "success");
    await loadRows(user);
  }

  function photoUrl(path: string) {
    return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }

  async function openRecord(row: PaymentConfirmation) {
    setSelected(row);
    setOperationNumber(row.operation_number || "");
    setBank(row.bank || "");
    setEditDocument(row.document_reference);
    setEditAmount(String(row.amount));
    setEditMethod(row.payment_method);
    setEditing(false);
    if (canValidate && !row.opened_at && user) {
      await supabase.from("payment_confirmations").update({
        opened_at: new Date().toISOString(),
        opened_by: user.id,
        opened_by_name: user.full_name,
      }).eq("id", row.id);
      await loadRows();
    }
  }

  async function saveValidatorEdits() {
    if (!selected) return;
    const parsedAmount = parseAmount(editAmount);
    if (!editDocument.trim() || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      showMessage("Documento y monto valido son obligatorios.", "error");
      return;
    }
    const { error } = await supabase.from("payment_confirmations").update({
      document_reference: editDocument.trim(),
      amount: parsedAmount,
      payment_method: editMethod,
      operation_number: operationNumber ? normalizeOperation(operationNumber) : null,
      bank: bank.trim() || null,
    }).eq("id", selected.id);
    if (error) {
      showMessage("No se pudo editar el registro: " + error.message, "error");
      return;
    }
    showMessage("Registro actualizado.", "success");
    setEditing(false);
    await loadRows();
  }

  async function confirmRecord() {
    if (!selected || !user) return;
    const op = normalizeOperation(operationNumber);
    if (!op || !bank.trim()) {
      showMessage("Numero de operacion y banco son obligatorios para confirmar.", "error");
      return;
    }
    const duplicate = await supabase
      .from("payment_confirmations")
      .select("id,registered_at,store_name,operation_number")
      .neq("id", selected.id)
      .ilike("operation_number", op)
      .maybeSingle();
    if (duplicate.data) {
      window.alert(`Nro de Operacion repetida en ${formatDateTime(duplicate.data.registered_at)}, con ${duplicate.data.store_name}`);
      return;
    }

    const { error } = await supabase.from("payment_confirmations").update({
      status: "Confirmado",
      operation_number: op,
      bank: bank.trim(),
      validator_id: user.id,
      validator_name: user.full_name,
      confirmed_at: new Date().toISOString(),
    }).eq("id", selected.id);
    if (error) {
      if (error.code === "23505") {
        window.alert("Nro de Operacion repetida. Vuelve a buscar el registro duplicado.");
        return;
      }
      showMessage("No se pudo confirmar: " + error.message, "error");
      return;
    }
    showMessage("Registro confirmado.", "success");
    setSelected(null);
    await loadRows();
  }

  async function requestCancellation(row: PaymentConfirmation) {
    const reason = window.prompt("Motivo de anulacion");
    if (reason === null) return;
    const { error } = await supabase.from("payment_confirmations").update({
      status: "Anulacion solicitada",
      cancellation_reason: reason.trim() || "Solicitado por cajero",
      cancellation_requested_at: new Date().toISOString(),
    }).eq("id", row.id);
    if (error) {
      showMessage("No se pudo solicitar anulacion: " + error.message, "error");
      return;
    }
    showMessage("Anulacion solicitada. Esperando validador.", "success");
    await loadRows();
  }

  async function approveCancellation() {
    if (!selected || !user) return;
    const { error } = await supabase.from("payment_confirmations").update({
      status: "Anulado",
      cancellation_validator_id: user.id,
      cancellation_validator_name: user.full_name,
      cancelled_at: new Date().toISOString(),
    }).eq("id", selected.id);
    if (error) {
      showMessage("No se pudo anular: " + error.message, "error");
      return;
    }
    showMessage("Registro anulado.", "success");
    setSelected(null);
    await loadRows();
  }

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <header className="sticky top-0 z-30 border-b bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-rose-600 text-white">
              <Camera size={22} />
            </div>
            <div>
              <h1 className="text-lg font-black">Confirmaciones</h1>
              <p className="text-xs font-bold text-slate-500">{user?.full_name || "Cargando"} · {user?.role || ""}</p>
            </div>
          </div>
          <button onClick={() => window.location.assign("/")} className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-black text-slate-600">
            <Home size={16} /> Inicio
          </button>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[390px_1fr]">
        <section className="space-y-4">
          {message && (
            <div className={`rounded-2xl border px-4 py-3 text-sm font-bold ${messageType === "error" ? "border-red-200 bg-red-50 text-red-700" : messageType === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-blue-200 bg-blue-50 text-blue-700"}`}>
              {message}
            </div>
          )}

          {canCashier && (
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <h2 className="flex items-center gap-2 text-base font-black"><Banknote size={18} /> Nueva solicitud</h2>
              <div className="mt-4 space-y-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase text-slate-500">Documento referencia</span>
                  <input value={documentReference} onChange={(event) => setDocumentReference(event.target.value)} className="w-full rounded-xl border px-3 py-3 text-sm font-bold outline-none focus:border-rose-500" placeholder="Boleta, pedido, comprobante..." />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-black uppercase text-slate-500">Monto</span>
                    <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" className="w-full rounded-xl border px-3 py-3 text-sm font-bold outline-none focus:border-rose-500" placeholder="S/ 0.00" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-black uppercase text-slate-500">Medio</span>
                    <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)} className="w-full rounded-xl border bg-white px-3 py-3 text-sm font-bold outline-none focus:border-rose-500">
                      <option value="Yape">Yape</option>
                      <option value="Plin">Plin</option>
                      <option value="Deposito">Deposito</option>
                    </select>
                  </label>
                </div>
                <input ref={fileInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(event) => void onPhotoChange(event.target.files?.[0] || null)} />
                <input ref={galleryInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void onPhotoChange(event.target.files?.[0] || null)} />
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => fileInputRef.current?.click()} className="flex items-center justify-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-black text-rose-700">
                    <Camera size={18} /> Camara
                  </button>
                  <button onClick={() => galleryInputRef.current?.click()} className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-black text-slate-700">
                    <Upload size={18} /> Galeria
                  </button>
                </div>
                {photoTakenAt && <p className="text-xs font-bold text-slate-500">Hora registrada en la foto: {formatDateTime(photoTakenAt.toISOString())}</p>}
                {photoPreview && (
                  <div className="overflow-hidden rounded-xl border bg-black">
                    <img src={photoPreview} alt="Foto con fecha y hora" className="max-h-72 w-full object-contain" />
                  </div>
                )}
                <button onClick={createConfirmation} disabled={saving} className="w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-black text-white disabled:opacity-50">
                  {saving ? "Guardando..." : "Guardar solicitud"}
                </button>
              </div>
            </div>
          )}

          {canValidate && (
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <h2 className="flex items-center gap-2 text-base font-black"><Search size={18} /> Filtros</h2>
              <div className="mt-4 space-y-3">
                <input type="date" value={filterDate} onChange={(event) => setFilterDate(event.target.value)} className="w-full rounded-xl border px-3 py-3 text-sm font-bold" />
                <select value={filterStoreId} onChange={(event) => setFilterStoreId(event.target.value)} className="w-full rounded-xl border bg-white px-3 py-3 text-sm font-bold">
                  <option value="">Todas las tiendas</option>
                  {stores.filter((store) => store.is_active).map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
                </select>
                <input value={search} onChange={(event) => setSearch(event.target.value)} className="w-full rounded-xl border px-3 py-3 text-sm font-bold" placeholder="Buscar documento, tienda, operacion..." />
                <button onClick={enableSound} className="w-full rounded-xl border px-4 py-3 text-sm font-black text-slate-700">
                  {soundEnabled ? "Sonido activo" : "Activar sonido"}
                </button>
                {soundBlocked && <p className="text-xs font-bold text-amber-700">El navegador bloqueo el sonido. Presiona Activar sonido otra vez.</p>}
              </div>
            </div>
          )}
        </section>

        <section className="rounded-2xl border bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div>
              <h2 className="text-base font-black">Registros</h2>
              <p className="text-xs font-bold text-slate-500">{visibleRows.length} resultados · {pendingUnopenedCount} pendientes sin abrir</p>
            </div>
            <button onClick={() => void loadRows(user, { showLoading: true })} className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-black text-slate-600">
              <RotateCcw size={16} /> {refreshing ? "Actualizando" : "Actualizar"}
            </button>
          </div>

          <div className="divide-y">
            {loading && <div className="p-8 text-center text-sm font-bold text-slate-400">Cargando...</div>}
            {!loading && visibleRows.map((row) => (
              <div key={row.id} className="grid gap-3 p-4 hover:bg-slate-50 md:grid-cols-[1fr_auto]">
                <button onClick={() => void openRecord(row)} className="text-left">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${statusClass(row.status)}`}>{row.status}</span>
                    {!row.opened_at && row.status === "Pendiente" && <span className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-black text-red-700">Nuevo</span>}
                    <span className="font-black">{row.store_name}</span>
                    <span className="text-sm font-bold text-slate-500">{formatMoney(row.amount)}</span>
                  </div>
                  <div className="mt-2 grid gap-1 text-sm font-semibold text-slate-600 sm:grid-cols-2">
                    <span>Doc: {row.document_reference}</span>
                    <span>Cajero: {row.cashier_name}</span>
                    <span>Registro: {formatDateTime(row.registered_at)}</span>
                    <span>Medio: {row.payment_method}</span>
                  </div>
                </button>
                <div className="flex items-center gap-2 md:justify-end">
                  <button onClick={() => void openRecord(row)} className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-black text-slate-700">
                    <Eye size={15} /> Ver
                  </button>
                  {!canValidate && row.status === "Pendiente" && (
                    <button onClick={() => void requestCancellation(row)} className="inline-flex items-center gap-2 rounded-xl border border-orange-200 px-3 py-2 text-xs font-black text-orange-700">
                      <XCircle size={15} /> Anular
                    </button>
                  )}
                </div>
              </div>
            ))}
            {!loading && visibleRows.length === 0 && <div className="p-8 text-center text-sm font-bold text-slate-400">No hay registros para este filtro.</div>}
          </div>
        </section>
      </div>

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-3">
          <div className="w-full max-w-5xl rounded-2xl bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
              <div>
                <h3 className="text-lg font-black">{selected.store_name} · {formatMoney(selected.amount)}</h3>
                <p className="text-xs font-bold text-slate-500">Registrado {formatDateTime(selected.registered_at)} · Foto {formatDateTime(selected.photo_taken_at)}</p>
              </div>
              <button onClick={() => setSelected(null)} className="rounded-xl border px-3 py-2 text-sm font-black">Cerrar</button>
            </div>

            <div className="grid gap-4 p-4 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="overflow-hidden rounded-xl border bg-black">
                <img src={photoUrl(selected.photo_path)} alt="Comprobante de pago" className="max-h-[72vh] w-full object-contain" />
              </div>

              <div className="space-y-4">
                <div className={`rounded-xl border px-3 py-2 text-sm font-black ${statusClass(selected.status)}`}>{selected.status}</div>
                <div className="grid gap-2 text-sm font-semibold text-slate-700">
                  <span><Clock size={15} className="mr-1 inline" /> Abierto: {formatDateTime(selected.opened_at)}</span>
                  <span><CheckCircle2 size={15} className="mr-1 inline" /> Confirmado: {formatDateTime(selected.confirmed_at)}</span>
                  {selected.status !== "Pendiente" && selected.operation_number && <span>Operacion: {selected.operation_number}</span>}
                  {selected.bank && <span>Banco: {selected.bank}</span>}
                  {selected.cancellation_reason && <span>Motivo anulacion: {selected.cancellation_reason}</span>}
                </div>

                {canValidate && (
                  <div className="space-y-3 rounded-xl border bg-slate-50 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="font-black">Validacion</h4>
                      <button onClick={() => setEditing((prev) => !prev)} className="inline-flex items-center gap-2 rounded-lg border bg-white px-3 py-1.5 text-xs font-black">
                        <Edit3 size={14} /> Editar
                      </button>
                    </div>
                    {editing && (
                      <div className="grid gap-2">
                        <input value={editDocument} onChange={(event) => setEditDocument(event.target.value)} className="rounded-xl border px-3 py-2 text-sm font-bold" placeholder="Documento" />
                        <input value={editAmount} onChange={(event) => setEditAmount(event.target.value)} className="rounded-xl border px-3 py-2 text-sm font-bold" placeholder="Monto" inputMode="decimal" />
                        <select value={editMethod} onChange={(event) => setEditMethod(event.target.value as PaymentMethod)} className="rounded-xl border bg-white px-3 py-2 text-sm font-bold">
                          <option value="Yape">Yape</option>
                          <option value="Plin">Plin</option>
                          <option value="Deposito">Deposito</option>
                        </select>
                      </div>
                    )}
                    <input value={operationNumber} onChange={(event) => setOperationNumber(event.target.value)} className="w-full rounded-xl border px-3 py-3 text-sm font-bold" placeholder="Numero de operacion" />
                    <input value={bank} onChange={(event) => setBank(event.target.value)} className="w-full rounded-xl border px-3 py-3 text-sm font-bold" placeholder="Banco" />
                    <div className="grid gap-2 sm:grid-cols-2">
                      <button onClick={editing ? saveValidatorEdits : confirmRecord} disabled={selected.status === "Anulado"} className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                        {editing ? <Save size={16} /> : <CheckCircle2 size={16} />} {editing ? "Guardar" : "Confirmar"}
                      </button>
                      {selected.status === "Anulacion solicitada" && (
                        <button onClick={approveCancellation} className="inline-flex items-center justify-center gap-2 rounded-xl border border-orange-200 px-4 py-3 text-sm font-black text-orange-700">
                          <AlertTriangle size={16} /> Aprobar anulacion
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
