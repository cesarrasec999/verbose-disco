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
      setVisible(false);
      setElapsed(0);
      startedAtRef.current = null;
      return;
    }

    const showTimer = window.setTimeout(() => setVisible(true), 250);
    const elapsedTimer = window.setInterval(() => {
      if (!startedAtRef.current) return;
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 500);

    return () => {
      window.clearTimeout(showTimer);
      window.clearInterval(elapsedTimer);
    };
  }, [pending]);

  if (!visible) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-[9999] pointer-events-none">
      <div className="h-1 w-full overflow-hidden bg-slate-200">
        <div className="h-full w-1/3 animate-[rasecorp-progress_1.1s_ease-in-out_infinite] rounded-full bg-orange-600" />
      </div>
      <div className="mx-auto mt-2 w-fit rounded-full border bg-white/95 px-4 py-2 text-xs font-black text-slate-800 shadow-lg backdrop-blur">
        Cargando informacion{elapsed >= 3 ? `... ${elapsed}s` : "..."}
      </div>
      <style jsx global>{`
        @keyframes rasecorp-progress {
          0% { transform: translateX(-120%); }
          55% { transform: translateX(120%); }
          100% { transform: translateX(320%); }
        }
      `}</style>
    </div>
  );
}
