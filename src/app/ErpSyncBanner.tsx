"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

const STALE_MINUTES = 15;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

type SyncStatusRow = { id: string; synced_at: string };

export default function ErpSyncBanner() {
  const [isStale, setIsStale] = useState(false);

  useEffect(() => {
    async function check() {
      const { data, error } = await supabase
        .from("erp_sync_status")
        .select("id, synced_at");

      if (error || !data?.length) return;

      const now = Date.now();
      const anyStale = (data as SyncStatusRow[]).some(row => {
        const minutesAgo = (now - new Date(row.synced_at).getTime()) / 60000;
        return minutesAgo > STALE_MINUTES;
      });

      setIsStale(anyStale);
    }

    void check();
    const interval = setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  if (!isStale) return null;

  return (
    <div className="bg-amber-500 text-white text-sm px-4 py-2 text-center font-medium z-50">
      ⚠ Sincronización ERP atrasada (más de {STALE_MINUTES} min sin actualizar). Datos pueden no estar al día.
    </div>
  );
}
