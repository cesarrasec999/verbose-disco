"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { syncOfflineCatalog, type OfflineCatalogProgress } from "@/lib/offline/catalogCache";

const LAST_SYNC_KEY = "rasecorp.offline.catalog.lastSync";
const CATALOG_VERSION_KEY = "rasecorp.offline.catalog.version";
const CATALOG_VERSION = "2026-05-03-normalized-v1";
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

function isInstalledApp(): boolean {
  if (typeof window === "undefined") return false;
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || navigatorWithStandalone.standalone === true;
}

export default function PwaCatalogSync() {
  const [progress, setProgress] = useState<OfflineCatalogProgress | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (!isInstalledApp()) return;

    let cancelled = false;
    let running = false;
    const runCatalogSync = () => {
      if (!navigator.onLine || running) return;
      const lastSync = Number(localStorage.getItem(LAST_SYNC_KEY) || 0);
      const currentVersion = localStorage.getItem(CATALOG_VERSION_KEY);
      if (currentVersion === CATALOG_VERSION && lastSync && Date.now() - lastSync < SYNC_INTERVAL_MS) return;

      if (cancelled) return;
      running = true;
      setSyncing(true);

      syncOfflineCatalog(supabase, (nextProgress) => {
        if (!cancelled) setProgress(nextProgress);
      })
        .then(() => {
          localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
          localStorage.setItem(CATALOG_VERSION_KEY, CATALOG_VERSION);
        })
        .catch(() => {
          if (!cancelled) setProgress(null);
        })
        .finally(() => {
          if (!cancelled) {
            window.setTimeout(() => {
              setSyncing(false);
              setProgress(null);
            }, 900);
          }
          running = false;
        });
    };

    const startTimer = window.setTimeout(runCatalogSync, 0);
    window.addEventListener("online", runCatalogSync);

    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      window.removeEventListener("online", runCatalogSync);
    };
  }, []);

  if (!syncing || !progress) return null;

  const percent = progress.total ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 12;

  return (
    <div className="fixed inset-x-3 bottom-4 z-[9998] mx-auto max-w-md rounded-2xl border border-slate-900 bg-white p-4 text-slate-900 shadow-2xl">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs font-black">
        <span>Descargando datos offline: {progress.label}</span>
        <span className="text-orange-600">{percent}%</span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-orange-600 transition-all duration-300" style={{ width: `${Math.max(8, percent)}%` }} />
      </div>
      <div className="mt-2 text-[11px] font-bold text-slate-500">
        {progress.loaded.toLocaleString("es-PE")} registros{progress.total ? ` de ${progress.total.toLocaleString("es-PE")}` : ""}
      </div>
    </div>
  );
}
