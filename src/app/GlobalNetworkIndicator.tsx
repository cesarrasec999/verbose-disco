"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useRef, useState } from "react";

type PatchedWindow = Window & {
  __rasecorpOriginalFetch?: typeof window.fetch;
  __rasecorpFetchUsers?: number;
};

export default function GlobalNetworkIndicator() {
  const [pending, setPending] = useState(0);
  const [visible, setVisible] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState(0);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    const patchedWindow = window as PatchedWindow;
    patchedWindow.__rasecorpFetchUsers = (patchedWindow.__rasecorpFetchUsers || 0) + 1;

    if (!patchedWindow.__rasecorpOriginalFetch) {
      const originalFetch = window.fetch.bind(window);
      patchedWindow.__rasecorpOriginalFetch = originalFetch;

      window.fetch = async (...args) => {
        window.dispatchEvent(new CustomEvent("rasecorp-network-start"));
        try {
          return await originalFetch(...args);
        } finally {
          window.dispatchEvent(new CustomEvent("rasecorp-network-end"));
        }
      };
    }

    const onStart = () => {
      startedAtRef.current = startedAtRef.current || Date.now();
      setPending(count => count + 1);
    };
    const onEnd = () => {
      setPending(count => Math.max(0, count - 1));
    };

    window.addEventListener("rasecorp-network-start", onStart);
    window.addEventListener("rasecorp-network-end", onEnd);

    return () => {
      window.removeEventListener("rasecorp-network-start", onStart);
      window.removeEventListener("rasecorp-network-end", onEnd);
      patchedWindow.__rasecorpFetchUsers = Math.max(0, (patchedWindow.__rasecorpFetchUsers || 1) - 1);
      if (patchedWindow.__rasecorpFetchUsers === 0 && patchedWindow.__rasecorpOriginalFetch) {
        window.fetch = patchedWindow.__rasecorpOriginalFetch;
        delete patchedWindow.__rasecorpOriginalFetch;
      }
    };
  }, []);

  useEffect(() => {
    if (pending <= 0) {
      if (!visible) {
        setElapsed(0);
        setProgress(0);
        startedAtRef.current = null;
        return;
      }

      setProgress(100);
      const hideTimer = window.setTimeout(() => {
        setVisible(false);
        setElapsed(0);
        setProgress(0);
        startedAtRef.current = null;
      }, 450);
      return () => window.clearTimeout(hideTimer);
    }

    if (!startedAtRef.current) {
      startedAtRef.current = Date.now();
      setProgress(current => Math.max(current, 8));
    }

    const updateProgress = () => {
      if (!startedAtRef.current) return;
      const elapsedMs = Date.now() - startedAtRef.current;
      const seconds = Math.floor(elapsedMs / 1000);
      const estimated = Math.round(8 + (1 - Math.exp(-elapsedMs / 18000)) * 86);
      setElapsed(seconds);
      setProgress(current => Math.min(94, Math.max(current, estimated)));
    };

    updateProgress();
    const showTimer = window.setTimeout(() => setVisible(true), 250);
    const elapsedTimer = window.setInterval(updateProgress, 350);

    return () => {
      window.clearTimeout(showTimer);
      window.clearInterval(elapsedTimer);
    };
  }, [pending, visible]);

  if (!visible) return null;

  const boundedProgress = Math.max(1, Math.min(100, progress));

  return (
    <div className="fixed inset-x-0 top-0 z-[9999] pointer-events-none">
      <div className="h-1.5 w-full overflow-hidden bg-slate-200">
        <div className="h-full rounded-r-full bg-orange-600 transition-all duration-500" style={{ width: `${Math.max(8, boundedProgress)}%` }} />
      </div>
      <div className="mx-auto mt-3 w-[min(92vw,420px)] rounded-2xl border border-slate-200 bg-white/95 p-3 text-xs font-black text-slate-800 shadow-xl backdrop-blur">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span>{boundedProgress >= 100 ? "Proceso terminado" : "Calculando datos..."}</span>
          <span className="text-orange-600">{boundedProgress}%</span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-orange-600 transition-all duration-500" style={{ width: `${Math.max(8, boundedProgress)}%` }} />
        </div>
        <div className="mt-2 text-[11px] font-bold text-slate-500">
          {boundedProgress >= 100 ? "Listo." : `Progreso estimado${elapsed >= 3 ? ` - ${elapsed}s` : ""}`}
        </div>
      </div>
    </div>
  );
}
