"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Umbral por fuente: cuántos minutos puede estar sin actualizar antes de mostrar alerta
const SOURCE_THRESHOLDS: Record<string, number> = {
  picking_requests:      15,   // corre cada 5 min → alerta si pasan 15 min
  stock_general:         15,   // corre continuamente → alerta si pasan 15 min
  erp_store_sales_daily:    26 * 60, // corre una vez al día → alerta si pasan 26 horas
  erp_product_sales_daily:  26 * 60, // corre una vez al día → alerta si pasan 26 horas
};

type SyncStatusRow = { id: string; synced_at: string };
type StaleSource = { id: string; minutesAgo: number };

export default function ErpSyncBanner() {
  const [staleSources, setStaleSources] = useState<StaleSource[]>([]);

  useEffect(() => {
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
          minutesAgo: Math.round((now - new Date(row.synced_at).getTime()) / 60000),
        }));

      setStaleSources(stale);
    }

    void check();
    const interval = setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  if (staleSources.length === 0) return null;

  const hasRealtimeIssue = staleSources.some(s => s.id === "picking_requests" || s.id === "stock_general");
  const hasSalesIssue    = staleSources.some(s => s.id.includes("sales"));

  return (
    <div className={`text-white text-sm px-4 py-2 text-center font-medium z-50 ${hasRealtimeIssue ? "bg-red-600" : "bg-amber-500"}`}>
      {hasRealtimeIssue && "⚠ Sincronización ERP detenida — picking o stock sin actualizar. "}
      {hasSalesIssue && "⚠ Ventas del día anterior aún no sincronizadas."}
    </div>
  );
}
