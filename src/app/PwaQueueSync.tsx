"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { syncPendingOfflineItems } from "@/lib/offline/syncQueue";

export default function PwaQueueSync() {
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let running = false;

    const runSync = async () => {
      if (!navigator.onLine || running) return;
      running = true;
      setSyncing(true);
      try {
        const synced = await syncPendingOfflineItems(supabase);
        if (!cancelled && synced > 0) {
          setLastSynced(synced);
          window.dispatchEvent(new CustomEvent("rasecorp-offline-sync-complete", { detail: { synced } }));
        }
      } finally {
        if (!cancelled) {
          setSyncing(false);
          running = false;
          window.setTimeout(() => {
            if (!cancelled) setLastSynced(0);
          }, 2500);
        }
      }
    };

    window.addEventListener("online", runSync);
    void runSync();

    return () => {
      cancelled = true;
      window.removeEventListener("online", runSync);
    };
  }, []);

  if (!syncing && lastSynced === 0) return null;

  return (
    <div className="fixed inset-x-3 bottom-4 z-[9997] mx-auto max-w-md rounded-2xl border border-slate-900 bg-white p-3 text-xs font-black text-slate-900 shadow-2xl">
      {syncing ? "Sincronizando conteos pendientes..." : `${lastSynced} conteos sincronizados.`}
    </div>
  );
}
