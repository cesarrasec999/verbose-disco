"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Banknote, Camera, CheckCircle2, Clock, Download, Edit3, Eye, Home, RotateCcw, Save, Search, Trash2, Upload, XCircle } from "lucide-react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";
import { writeStoredUser } from "@/lib/singleDeviceSession";
import type { CyclicUser, Store } from "@/features/ciclicos/types";

type ConfirmationStatus = "Pendiente" | "Confirmado" | "Denegado" | "Anulacion solicitada" | "Anulado";
type PaymentMethod = "Yape" | "Plin" | "Deposito";
type PaymentPurpose = "Anticipo" | "Pago total";
type UsageStatus = "Pendiente de uso" | "Usado";

type PaymentConfirmation = {
  id: string;
  store_id: string | null;
  store_name: string;
  cashier_id: string | null;
  cashier_name: string;
  document_reference: string;
  cashier_observation: string | null;
  amount: number;
  payment_method: PaymentMethod;
  payment_purpose: PaymentPurpose;
  usage_status: UsageStatus;
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
  denied_reason: string | null;
  denied_at: string | null;
  cancellation_requested_at: string | null;
  cancellation_reason: string | null;
  cancellation_validator_id: string | null;
  cancellation_validator_name: string | null;
  cancelled_at: string | null;
  updated_at: string;
};

const BUCKET = "payment-confirmations";
const SOUND_ENABLED_KEY = "payment_confirmations_sound_enabled";
const CONFIRMATIONS_POLL_MS = 10000;
const STATUS_ORDER: Record<ConfirmationStatus, number> = {
  "Pendiente": 0,
  "Anulacion solicitada": 1,
  "Confirmado": 2,
  "Denegado": 3,
  "Anulado": 4,
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

function responseAt(row: PaymentConfirmation) {
  return row.confirmed_at || row.denied_at || null;
}

function responseMs(row: PaymentConfirmation) {
  const end = responseAt(row);
  if (!end) return null;
  const diff = new Date(end).getTime() - new Date(row.registered_at).getTime();
  return Number.isFinite(diff) && diff >= 0 ? diff : null;
}

function formatDurationMs(value: number | null | undefined) {
  if (value == null) return "-";
  const totalMinutes = Math.max(0, Math.round(value / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes} min`;
  return `${hours} h ${minutes} min`;
}

function usageStatusForPurpose(purpose: PaymentPurpose): UsageStatus {
  return purpose === "Pago total" ? "Usado" : "Pendiente de uso";
}

function usageStatusClass(status: UsageStatus | null | undefined) {
  if (status === "Usado") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  return "bg-sky-100 text-sky-800 border-sky-200";
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
  if (status === "Denegado") return "bg-red-100 text-red-800 border-red-200";
  if (status === "Anulacion solicitada") return "bg-orange-100 text-orange-800 border-orange-200";
  return "bg-slate-100 text-slate-600 border-slate-200";
}

function userCanValidate(user: CyclicUser | null) {
  return Boolean(user && (user.role === "Administrador" || user.role === "Validador" || user.role === "Supervisor"));
}

function sortRows(rows: PaymentConfirmation[]) {
  return [...rows].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    if (a.status === "Confirmado" || a.status === "Denegado" || a.status === "Anulado") {
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
  const fontSize = Math.max(18, Math.round(width * 0.022));
  ctx.font = `700 ${fontSize}px Arial, sans-serif`;
  const padding = Math.round(fontSize * 0.45);
  const metrics = ctx.measureText(stamp);
  const boxW = metrics.width + padding * 2;
  const boxH = fontSize + padding * 1.35;
  const margin = Math.max(14, Math.round(width * 0.018));
  const x = Math.max(margin, width - boxW - margin);
  const y = margin;
  ctx.fillStyle = "rgba(15, 23, 42, 0.58)";
  ctx.fillRect(x, y, boxW, boxH);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.72)";
  ctx.lineWidth = Math.max(1, Math.round(width * 0.0015));
  ctx.strokeRect(x, y, boxW, boxH);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(stamp, x + padding, y + fontSize + padding * 0.1);

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
  const [cashierObservation, setCashierObservation] = useState("");
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("Yape");
  const [paymentPurpose, setPaymentPurpose] = useState<PaymentPurpose>("Anticipo");
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [photoPreview, setPhotoPreview] = useState("");
  const [photoTakenAt, setPhotoTakenAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);

  const [filterDate, setFilterDate] = useState(todayISO());
  const [filterStoreId, setFilterStoreId] = useState("");
  const [filterUsageStatus, setFilterUsageStatus] = useState<"todos" | UsageStatus>("todos");
  const [filterPaymentPurpose, setFilterPaymentPurpose] = useState<"todos" | PaymentPurpose>("todos");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<PaymentConfirmation | null>(null);
  const [operationNumber, setOperationNumber] = useState("");
  const [bank, setBank] = useState("");
  const [editDocument, setEditDocument] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editMethod, setEditMethod] = useState<PaymentMethod>("Yape");
  const [editPurpose, setEditPurpose] = useState<PaymentPurpose>("Anticipo");
  const [editing, setEditing] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(SOUND_ENABLED_KEY) === "1";
  });
  const [soundBlocked, setSoundBlocked] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  const beepTimerRef = useRef<number | null>(null);
  const realtimeRefreshRef = useRef<number | null>(null);
  const loadSeqRef = useRef(0);
  const confirmedNotifiedRef = useRef<Set<string>>(new Set());
  const validatorPendingNotifiedRef = useRef<Set<string>>(new Set());
  const cashierConfirmSoundReadyRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const canValidate = userCanValidate(user);
  const canCashier = Boolean(user && (user.role === "Cajero" || user.role === "Administrador"));
  const visibleRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const orderedRows = canValidate
      ? sortRows(rows)
      : [...rows].sort((a, b) => new Date(b.registered_at).getTime() - new Date(a.registered_at).getTime());
    return orderedRows.filter((row) => {
      if (filterUsageStatus !== "todos" && (row.usage_status || usageStatusForPurpose(row.payment_purpose || "Anticipo")) !== filterUsageStatus) return false;
      if (!canValidate && filterPaymentPurpose !== "todos" && (row.payment_purpose || "Anticipo") !== filterPaymentPurpose) return false;
      if (!term) return true;
      return [
        row.store_name,
        row.cashier_name,
        row.cashier_observation || "",
        row.document_reference,
        row.operation_number || "",
        row.bank || "",
        row.payment_method,
        row.payment_purpose || "",
        row.usage_status || "",
        row.status,
      ].some((value) => value.toLowerCase().includes(term));
    });
  }, [canValidate, filterPaymentPurpose, filterUsageStatus, rows, search]);
  const pendingUnopenedCount = useMemo(() => rows.filter((row) => row.status === "Pendiente" && !row.opened_at).length, [rows]);
  const answeredRows = useMemo(() => rows.filter((row) => responseMs(row) != null), [rows]);
  const averageResponseMs = useMemo(() => {
    if (answeredRows.length === 0) return null;
    const total = answeredRows.reduce((sum, row) => sum + (responseMs(row) || 0), 0);
    return total / answeredRows.length;
  }, [answeredRows]);
  const pendingRowsCount = useMemo(() => rows.filter((row) => row.status === "Pendiente").length, [rows]);

  const notifyPendingConfirmation = useCallback((count = 1) => {
    if (!canValidate || !soundEnabled) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const title = count > 1 ? `${count} confirmaciones pendientes` : "Nueva confirmacion pendiente";
    const body = count > 1
      ? "Hay pagos esperando validacion."
      : "Hay un pago esperando validacion.";
    new Notification(title, {
      body,
      icon: "/icon.png",
      tag: "payment-confirmations-pending",
    });
  }, [canValidate, soundEnabled]);

  const playCashierConfirmedSound = useCallback(async () => {
    try {
      const AudioCtor = window.AudioContext || (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) return;
      const ctx = audioRef.current || new AudioCtor();
      audioRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume();
      [660, 880].forEach((frequency, index) => {
        const start = ctx.currentTime + index * 0.16;
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.28, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.2);
      });
    } catch {
      // Si el navegador bloquea autoplay, no interrumpimos al cajero.
    }
  }, []);

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
    const seq = ++loadSeqRef.current;
    const showLoading = options.showLoading ?? false;
    if (showLoading) setLoading(true);
    else setRefreshing(true);
    let query = supabase
      .from("payment_confirmations")
      .select("*")
      .gte("registered_at", dateStart(filterDate))
      .lte("registered_at", dateEnd(filterDate))
      .order("registered_at", { ascending: false });

    if (userCanValidate(currentUser)) {
      if (filterStoreId) query = query.eq("store_id", filterStoreId);
    } else if (currentUser.store_id) {
      query = query.eq("store_id", currentUser.store_id);
    } else {
      query = query.eq("cashier_id", currentUser.id);
    }

    const { data, error } = await query;
    if (showLoading) setLoading(false);
    else setRefreshing(false);
    if (seq !== loadSeqRef.current) return;
    if (error) {
      showMessage("No se pudieron cargar confirmaciones: " + error.message, "error");
      return;
    }
    setRows((data || []) as PaymentConfirmation[]);
  }, [filterDate, filterStoreId, showMessage, user]);

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
    // La autenticacion inicial no debe re-ejecutarse con cada refresh realtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => void loadRows(user, { showLoading: false }), 0);
    return () => window.clearTimeout(timer);
  }, [filterDate, filterStoreId, loadRows, user]);

  useEffect(() => {
    const channel = supabase
      .channel("payment_confirmations_realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "payment_confirmations" },
        (payload) => {
          const next = payload.new as Partial<PaymentConfirmation> | null;
          if (next?.status === "Pendiente" && canValidate && soundEnabled) {
            notifyPendingConfirmation(1);
          }
          if (realtimeRefreshRef.current) window.clearTimeout(realtimeRefreshRef.current);
          realtimeRefreshRef.current = window.setTimeout(() => void loadRows(user, { showLoading: false }), 250);
        }
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
      if (realtimeRefreshRef.current) window.clearTimeout(realtimeRefreshRef.current);
    };
  }, [canValidate, loadRows, notifyPendingConfirmation, soundEnabled, user]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => void loadRows(user, { showLoading: false }), CONFIRMATIONS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadRows, user]);

  function stopSound() {
    if (beepTimerRef.current) window.clearInterval(beepTimerRef.current);
    beepTimerRef.current = null;
  }

  const playBeep = useCallback(async () => {
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
        gain.gain.exponentialRampToValueAtTime(0.7, start + 0.025);
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
  }, []);

  const startAlarm = useCallback(() => {
    if (beepTimerRef.current) return;
    void playBeep();
    beepTimerRef.current = window.setInterval(() => void playBeep(), 900);
  }, [playBeep]);

  useEffect(() => {
    if (canValidate && pendingUnopenedCount > 0 && soundEnabled) startAlarm();
    else stopSound();
    return stopSound;
  }, [canValidate, pendingUnopenedCount, soundEnabled, startAlarm]);

  useEffect(() => {
    if (!canValidate || !soundEnabled) return;
    const newPendingIds = rows
      .filter((row) => row.status === "Pendiente" && !row.opened_at)
      .map((row) => row.id)
      .filter((id) => !validatorPendingNotifiedRef.current.has(id));
    if (newPendingIds.length === 0) return;
    for (const id of newPendingIds) validatorPendingNotifiedRef.current.add(id);
    void playBeep();
    notifyPendingConfirmation(newPendingIds.length);
  }, [canValidate, notifyPendingConfirmation, playBeep, rows, soundEnabled]);

  useEffect(() => {
    if (!user || canValidate) return;
    for (const row of rows) {
      if (row.status !== "Confirmado") continue;
      if (!cashierConfirmSoundReadyRef.current) {
        confirmedNotifiedRef.current.add(row.id);
        continue;
      }
      if (confirmedNotifiedRef.current.has(row.id)) continue;
      confirmedNotifiedRef.current.add(row.id);
      void playCashierConfirmedSound();
    }
    cashierConfirmSoundReadyRef.current = true;
  }, [canValidate, playCashierConfirmedSound, rows, user]);

  async function enableSound() {
    const AudioCtor = window.AudioContext || (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioCtor && !audioRef.current) audioRef.current = new AudioCtor();
    if (audioRef.current?.state === "suspended") await audioRef.current.resume();
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    localStorage.setItem(SOUND_ENABLED_KEY, "1");
    setSoundEnabled(true);
    if (canValidate && pendingUnopenedCount > 0) startAlarm();
    else await playBeep();
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
      cashier_observation: cashierObservation.trim() || null,
      amount: parsedAmount,
      payment_method: paymentMethod,
      payment_purpose: paymentPurpose,
      usage_status: usageStatusForPurpose(paymentPurpose),
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
    setCashierObservation("");
    setAmount("");
    setPaymentMethod("Yape");
    setPaymentPurpose("Anticipo");
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

  function exportRowsToExcel() {
    if (visibleRows.length === 0) {
      showMessage("No hay registros para exportar.", "error");
      return;
    }

    const headers = [
      "Estado",
      "Estado de uso",
      "Tienda",
      "Cajero",
      "Documento",
      "Observaciones",
      "Monto",
      "Medio",
      "Tipo deposito",
      "Fecha registro",
      "Fecha foto",
      "Abierto",
      "Confirmado",
      "Denegado",
      "Tiempo respuesta",
      "Operacion",
      "Banco",
      "Validador",
      "Razon denegado",
      "Motivo anulacion",
      "Foto",
    ];
    const body = visibleRows.map((row) => [
      row.status,
      row.usage_status || usageStatusForPurpose(row.payment_purpose || "Anticipo"),
      row.store_name,
      row.cashier_name,
      row.document_reference,
      row.cashier_observation || "",
      Number(row.amount || 0),
      row.payment_method,
      row.payment_purpose || "Anticipo",
      formatDateTime(row.registered_at),
      formatDateTime(row.photo_taken_at),
      formatDateTime(row.opened_at),
      formatDateTime(row.confirmed_at),
      formatDateTime(row.denied_at),
      formatDurationMs(responseMs(row)),
      row.operation_number || "",
      row.bank || "",
      row.validator_name || "",
      row.denied_reason || "",
      row.cancellation_reason || "",
      "Abrir foto",
    ]);
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...body]);
    visibleRows.forEach((row, index) => {
      const cellAddress = XLSX.utils.encode_cell({ r: index + 1, c: headers.length - 1 });
      const cell = worksheet[cellAddress];
      if (cell) cell.l = { Target: photoUrl(row.photo_path), Tooltip: "Abrir foto del registro" };
    });
    worksheet["!cols"] = headers.map((header) => ({ wch: Math.max(14, Math.min(32, header.length + 6)) }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Confirmaciones");
    const filename = `confirmaciones_${filterDate || todayISO()}.xlsx`;
    XLSX.writeFile(workbook, filename);
  }

  async function openRecord(row: PaymentConfirmation) {
    setSelected(row);
    setOperationNumber(row.operation_number || "");
    setBank(row.bank || "");
    setEditDocument(row.document_reference);
    setEditAmount(String(row.amount));
    setEditMethod(row.payment_method);
    setEditPurpose(row.payment_purpose || "Anticipo");
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
      payment_purpose: editPurpose,
      usage_status: usageStatusForPurpose(editPurpose),
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

  async function denyRecord() {
    if (!selected || !user) return;
    const reason = window.prompt("Razon para denegar la confirmacion");
    if (reason === null) return;
    if (!reason.trim()) {
      showMessage("La razon es obligatoria para denegar.", "error");
      return;
    }
    const { error } = await supabase.from("payment_confirmations").update({
      status: "Denegado",
      denied_reason: reason.trim(),
      denied_at: new Date().toISOString(),
      validator_id: user.id,
      validator_name: user.full_name,
    }).eq("id", selected.id);
    if (error) {
      showMessage("No se pudo denegar: " + error.message, "error");
      return;
    }
    showMessage("Registro denegado.", "success");
    setSelected(null);
    await loadRows();
  }

  async function markAsUsed(row: PaymentConfirmation) {
    if (!canValidate) return;
    const { error } = await supabase
      .from("payment_confirmations")
      .update({ usage_status: "Usado" })
      .eq("id", row.id);
    if (error) {
      showMessage("No se pudo marcar como usado: " + error.message, "error");
      return;
    }
    showMessage("Deposito marcado como usado.", "success");
    if (selected?.id === row.id) setSelected({ ...selected, usage_status: "Usado" });
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

  async function deleteRecord(row: PaymentConfirmation) {
    if (user?.role !== "Administrador") {
      showMessage("Solo el administrador puede eliminar registros.", "error");
      return;
    }
    if (!window.confirm(`Eliminar registro de ${row.store_name} por ${formatMoney(row.amount)}?`)) return;
    const { error } = await supabase.from("payment_confirmations").delete().eq("id", row.id);
    if (error) {
      showMessage("No se pudo eliminar: " + error.message, "error");
      return;
    }
    showMessage("Registro eliminado.", "success");
    if (selected?.id === row.id) setSelected(null);
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

      <div className={canValidate ? "mx-auto max-w-7xl space-y-4 p-4" : "mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[390px_1fr]"}>
        <section className={canValidate ? "space-y-4" : "space-y-4"}>
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
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase text-slate-500">Observaciones</span>
                  <textarea value={cashierObservation} onChange={(event) => setCashierObservation(event.target.value)} className="min-h-20 w-full rounded-xl border px-3 py-3 text-sm font-bold outline-none focus:border-rose-500" placeholder="Opcional" />
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
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase text-slate-500">Tipo de deposito</span>
                  <select value={paymentPurpose} onChange={(event) => setPaymentPurpose(event.target.value as PaymentPurpose)} className="w-full rounded-xl border bg-white px-3 py-3 text-sm font-bold outline-none focus:border-rose-500">
                    <option value="Anticipo">Anticipo</option>
                    <option value="Pago total">Pago total</option>
                  </select>
                </label>
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

          {!canValidate && (
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2 text-base font-black"><Search size={18} /> Filtros de mis registros</div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <input type="date" value={filterDate} onChange={(event) => setFilterDate(event.target.value)} className="w-full rounded-xl border px-3 py-3 text-sm font-bold" />
                <select value={filterPaymentPurpose} onChange={(event) => setFilterPaymentPurpose(event.target.value as "todos" | PaymentPurpose)} className="w-full rounded-xl border bg-white px-3 py-3 text-sm font-bold">
                  <option value="todos">Todos los tipos</option>
                  <option value="Anticipo">Anticipo</option>
                  <option value="Pago total">Pago total</option>
                </select>
              </div>
            </div>
          )}

          {canValidate && (
            <div className="border bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2 text-base font-black"><Search size={18} /> Filtros</div>
              <div className="mt-4 grid gap-3 md:grid-cols-[180px_1fr_220px_1.4fr_auto]">
                <input type="date" value={filterDate} onChange={(event) => setFilterDate(event.target.value)} className="w-full rounded-xl border px-3 py-3 text-sm font-bold" />
                <select value={filterStoreId} onChange={(event) => setFilterStoreId(event.target.value)} className="w-full rounded-xl border bg-white px-3 py-3 text-sm font-bold">
                  <option value="">Todas las tiendas</option>
                  {stores.filter((store) => store.is_active).map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
                </select>
                <select value={filterUsageStatus} onChange={(event) => setFilterUsageStatus(event.target.value as "todos" | UsageStatus)} className="w-full rounded-xl border bg-white px-3 py-3 text-sm font-bold">
                  <option value="todos">Todos los usos</option>
                  <option value="Pendiente de uso">Pendiente de uso</option>
                  <option value="Usado">Usado</option>
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

        {canValidate && (
          <section className="grid gap-3 md:grid-cols-4">
            <div className="border bg-white p-4">
              <p className="text-xs font-black uppercase text-slate-500">Tiempo promedio de respuesta</p>
              <p className="mt-2 text-2xl font-black text-slate-950">{formatDurationMs(averageResponseMs)}</p>
              <p className="text-xs font-bold text-slate-500">{answeredRows.length} respondidos en el dia</p>
            </div>
            <div className="border bg-white p-4">
              <p className="text-xs font-black uppercase text-slate-500">Pendientes</p>
              <p className="mt-2 text-2xl font-black text-amber-700">{pendingRowsCount}</p>
            </div>
            <div className="border bg-white p-4">
              <p className="text-xs font-black uppercase text-slate-500">Sin abrir</p>
              <p className="mt-2 text-2xl font-black text-red-700">{pendingUnopenedCount}</p>
            </div>
            <div className="border bg-white p-4">
              <p className="text-xs font-black uppercase text-slate-500">Total registros</p>
              <p className="mt-2 text-2xl font-black text-slate-950">{rows.length}</p>
            </div>
          </section>
        )}

        <section className={canValidate ? "border bg-white shadow-sm" : "rounded-2xl border bg-white shadow-sm"}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div>
              <h2 className="text-base font-black">Registros</h2>
              <p className="text-xs font-bold text-slate-500">{visibleRows.length} resultados · {pendingUnopenedCount} pendientes sin abrir</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={exportRowsToExcel} className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-black text-emerald-800">
                <Download size={16} /> Descargar Excel
              </button>
              <button onClick={() => void loadRows(user, { showLoading: rows.length === 0 })} className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-black text-slate-600">
                <RotateCcw size={16} /> {refreshing ? "Actualizando" : "Actualizar"}
              </button>
            </div>
          </div>

          <div className="divide-y">
            {loading && rows.length === 0 && <div className="p-8 text-center text-sm font-bold text-slate-400">Cargando...</div>}
            {visibleRows.map((row) => (
              <div key={row.id} className="grid gap-3 border-b p-3 last:border-b-0 hover:bg-slate-50 md:grid-cols-[1fr_auto]">
                <button onClick={() => void openRecord(row)} className="text-left">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${statusClass(row.status)}`}>{row.status}</span>
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${usageStatusClass(row.usage_status || usageStatusForPurpose(row.payment_purpose || "Anticipo"))}`}>
                      {row.usage_status || usageStatusForPurpose(row.payment_purpose || "Anticipo")}
                    </span>
                    {!row.opened_at && row.status === "Pendiente" && <span className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-black text-red-700">Nuevo</span>}
                    <span className="font-black">{row.store_name}</span>
                    <span className="text-sm font-bold text-slate-500">{formatMoney(row.amount)}</span>
                    <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-black text-slate-700">
                      Respuesta: {formatDurationMs(responseMs(row))}
                    </span>
                  </div>
                  <div className="mt-2 grid gap-1 text-sm font-semibold text-slate-600 sm:grid-cols-3">
                    <span>Doc: {row.document_reference}</span>
                    {row.cashier_observation && <span>Obs: {row.cashier_observation}</span>}
                    <span>Cajero: {row.cashier_name}</span>
                    <span>Registro: {formatDateTime(row.registered_at)}</span>
                    <span>Medio: {row.payment_method}</span>
                    <span>Tipo: {row.payment_purpose || "Anticipo"}</span>
                    <span>Respuesta: {formatDurationMs(responseMs(row))}</span>
                    <span>{responseAt(row) ? `Respondido: ${formatDateTime(responseAt(row))}` : "Sin respuesta"}</span>
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
                  {user?.role === "Administrador" && (
                    <button onClick={() => void deleteRecord(row)} className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-3 py-2 text-xs font-black text-red-700">
                      <Trash2 size={15} /> Eliminar
                    </button>
                  )}
                  {canValidate && (row.usage_status || usageStatusForPurpose(row.payment_purpose || "Anticipo")) === "Pendiente de uso" && (
                    <button onClick={() => void markAsUsed(row)} className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 px-3 py-2 text-xs font-black text-emerald-700">
                      <CheckCircle2 size={15} /> Marcar usado
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
                  <span>Tiempo respuesta: {formatDurationMs(responseMs(selected))}</span>
                  <span>Tipo deposito: {selected.payment_purpose || "Anticipo"}</span>
                  <span>Estado de uso: {selected.usage_status || usageStatusForPurpose(selected.payment_purpose || "Anticipo")}</span>
                  {selected.cashier_observation && <span>Observaciones: {selected.cashier_observation}</span>}
                  {selected.status !== "Pendiente" && selected.operation_number && <span>Operacion: {selected.operation_number}</span>}
                  {selected.bank && <span>Banco: {selected.bank}</span>}
                  {selected.denied_reason && <span>Razon denegado: {selected.denied_reason}</span>}
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
                        <select value={editPurpose} onChange={(event) => setEditPurpose(event.target.value as PaymentPurpose)} className="rounded-xl border bg-white px-3 py-2 text-sm font-bold">
                          <option value="Anticipo">Anticipo</option>
                          <option value="Pago total">Pago total</option>
                        </select>
                      </div>
                    )}
                    <input value={operationNumber} onChange={(event) => setOperationNumber(event.target.value)} className="w-full rounded-xl border px-3 py-3 text-sm font-bold" placeholder="Numero de operacion" />
                    <input value={bank} onChange={(event) => setBank(event.target.value)} className="w-full rounded-xl border px-3 py-3 text-sm font-bold" placeholder="Banco" />
                    <div className="grid gap-2 sm:grid-cols-2">
                      <button onClick={editing ? saveValidatorEdits : confirmRecord} disabled={selected.status === "Anulado"} className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                        {editing ? <Save size={16} /> : <CheckCircle2 size={16} />} {editing ? "Guardar" : "Confirmar"}
                      </button>
                      {selected.status === "Pendiente" && !editing && (
                        <button onClick={denyRecord} className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 px-4 py-3 text-sm font-black text-red-700">
                          <XCircle size={16} /> Denegar
                        </button>
                      )}
                      {selected.status === "Anulacion solicitada" && (
                        <button onClick={approveCancellation} className="inline-flex items-center justify-center gap-2 rounded-xl border border-orange-200 px-4 py-3 text-sm font-black text-orange-700">
                          <AlertTriangle size={16} /> Aprobar anulacion
                        </button>
                      )}
                      {user?.role === "Administrador" && (
                        <button onClick={() => void deleteRecord(selected)} className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 px-4 py-3 text-sm font-black text-red-700">
                          <Trash2 size={16} /> Eliminar
                        </button>
                      )}
                      {(selected.usage_status || usageStatusForPurpose(selected.payment_purpose || "Anticipo")) === "Pendiente de uso" && (
                        <button onClick={() => void markAsUsed(selected)} className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-200 px-4 py-3 text-sm font-black text-emerald-700">
                          <CheckCircle2 size={16} /> Marcar usado
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
