"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { syncPendingOfflineItems } from "@/lib/offline/syncQueue";
import { countPendingOfflineItems } from "@/lib/offline/pendingQueue";

const OFFLINE_SYNC_INTERVAL_MS = 30000;
const MAX_SYNC_BATCH = 20;

export default function PwaQueueSync() {
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let running = false;
    let timer: number | undefined;

    const scheduleSync = (delayMs = Math.random() * 10_000) => {
      if (cancelled) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void runSync(); }, delayMs);
    };

    const runSync = async () => {
      if (!navigator.onLine || running) return;
      running = true;
      let pending = 0;
      let synced = 0;
      try {
        pending = await countPendingOfflineItems();
        if (pending > 0) {
          setSyncing(true);
          synced = await syncPendingOfflineItems(supabase, MAX_SYNC_BATCH);
          if (!cancelled && synced > 0) {
            setLastSynced(synced);
            window.dispatchEvent(new CustomEvent("rasecorp-offline-sync-complete", { detail: { synced } }));
          }
        }
      } catch {
        // Queue/database/network errors must never clear local records or stop future retries.
      } finally {
        if (!cancelled) {
          setSyncing(false);
          running = false;
          window.setTimeout(() => {
            if (!cancelled) setLastSynced(0);
          }, 2500);
          // Drain large queues in small serial batches. After a failed batch, retry
          // with jitter; IndexedDB nextAttemptAt applies the longer exponential backoff.
          scheduleSync(synced > 0 && pending > synced
            ? 1500 + Math.random() * 2500
            : pending > 0 ? 5000 + Math.random() * 5000 : OFFLINE_SYNC_INTERVAL_MS + Math.random() * 10_000);
        }
      }
    };

    const scheduleWhenVisible = () => {
      if (document.visibilityState === "visible") scheduleSync(1500 + Math.random() * 8500);
    };

    const scheduleAfterReconnect = () => scheduleSync(1500 + Math.random() * 8500);
    window.addEventListener("online", scheduleAfterReconnect);
    window.addEventListener("focus", scheduleAfterReconnect);
    document.addEventListener("visibilitychange", scheduleWhenVisible);
    scheduleSync(1000 + Math.random() * 9000);

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("online", scheduleAfterReconnect);
      window.removeEventListener("focus", scheduleAfterReconnect);
      document.removeEventListener("visibilitychange", scheduleWhenVisible);
    };
  }, []);

  if (!syncing && lastSynced === 0) return null;

  return (
    <div className="fixed inset-x-3 bottom-4 z-[9997] mx-auto max-w-md rounded-2xl border border-slate-900 bg-white p-3 text-xs font-black text-slate-900 shadow-2xl">
      {syncing ? "Sincronizando conteos pendientes..." : `${lastSynced} conteos sincronizados.`}
    </div>
  );
}
