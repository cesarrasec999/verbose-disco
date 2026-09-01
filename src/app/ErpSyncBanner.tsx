"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Umbral por fuente: cuántos minutos puede estar sin actualizar antes de
// mostrar alerta. <= REALTIME_TIER_MAX_MINUTES se trata como "tiempo real"
// (banner rojo, urgente); el resto como "diario" (banner ámbar).
const SOURCE_THRESHOLDS: Record<string, number> = {
  picking_requests:         15,   // corre cada 5 min → alerta si pasan 15 min
  stock_general:            15,   // corre continuamente → alerta si pasan 15 min
  reception_requests:       15,   // corre cada 5 min → alerta si pasan 15 min
  erp_movements:            15,   // fuente central, corre cada 5 min
  erp_store_sales_daily:    26 * 60, // corre una vez al día → alerta si pasan 26 horas
  erp_product_sales_daily:  26 * 60, // corre una vez al día → alerta si pasan 26 horas
  product_rotation_monthly: 26 * 60, // corre una vez al día → alerta si pasan 26 horas
};

const SOURCE_LABELS: Record<string, string> = {
  picking_requests:         "picking",
  stock_general:            "stock",
  reception_requests:       "recepción",
  erp_movements:            "movimientos",
  erp_store_sales_daily:    "ventas por tienda",
  erp_product_sales_daily:  "ventas por producto",
  product_rotation_monthly: "rotación de productos",
};

const REALTIME_TIER_MAX_MINUTES = 60;

type SyncStatusRow = { id: string; synced_at: string };
type StaleSource = { id: string; label: string; minutesAgo: number };
type UserRole = "Administrador" | "Supervisor" | "Validador" | "Operario" | string;

function canSeeErpSyncWarnings() {
  if (typeof window === "undefined") return false;
  const rawUser = localStorage.getItem("cyclic_user");
  if (!rawUser) return false;
  try {
    const user = JSON.parse(rawUser) as { role?: UserRole };
    return user.role === "Administrador" || user.role === "Supervisor" || user.role === "Validador";
  } catch {
    return false;
  }
}

function formatElapsed(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}min` : `${hours}h`;
}

export default function ErpSyncBanner() {
  const [staleSources, setStaleSources] = useState<StaleSource[]>([]);
  const [canSeeWarnings, setCanSeeWarnings] = useState(false);

  useEffect(() => {
    const allowed = canSeeErpSyncWarnings();
    setCanSeeWarnings(allowed);
    if (!allowed) return;

    async function check() {
      const { data, error } = await supabase
        .from("erp_sync_status")
        .select("id, synced_at");

      if (error || !data?.length) return;

      const now = Date.now();
      const stale = (data as SyncStatusRow[])
        .filter(row => {
          const threshold = SOURCE_THRESHOLDS[row.id];
          if (!threshold) return false;
          const minutesAgo = (now - new Date(row.synced_at).getTime()) / 60000;
          return minutesAgo > threshold;
        })
        .map(row => ({
          id: row.id,
          label: SOURCE_LABELS[row.id] ?? row.id,
          minutesAgo: Math.round((now - new Date(row.synced_at).getTime()) / 60000),
        }))
        .sort((a, b) => b.minutesAgo - a.minutesAgo);

      setStaleSources(stale);
    }

    void check();
    const interval = setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  if (!canSeeWarnings || staleSources.length === 0) return null;

  const realtimeStale = staleSources.filter(s => SOURCE_THRESHOLDS[s.id] <= REALTIME_TIER_MAX_MINUTES);
  const dailyStale    = staleSources.filter(s => SOURCE_THRESHOLDS[s.id] > REALTIME_TIER_MAX_MINUTES);

  return (
    <div className={`text-white text-sm px-4 py-2 text-center font-medium z-50 ${realtimeStale.length > 0 ? "bg-red-600" : "bg-amber-500"}`}>
      {realtimeStale.length > 0 && (
        <span>
          ⚠ Sincronización ERP detenida — {realtimeStale.map(s => `${s.label} (${formatElapsed(s.minutesAgo)} sin actualizar)`).join(", ")}.
        </span>
      )}
      {realtimeStale.length > 0 && dailyStale.length > 0 && " "}
      {dailyStale.length > 0 && (
        <span>
          ⚠ Sincronización diaria pendiente — {dailyStale.map(s => `${s.label} (${formatElapsed(s.minutesAgo)})`).join(", ")}.
        </span>
      )}
    </div>
  );
}
