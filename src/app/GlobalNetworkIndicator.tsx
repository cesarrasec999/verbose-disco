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
        setProgress(0);
        startedAtRef.current = null;
        return;
      }

      setProgress(100);
      const hideTimer = window.setTimeout(() => {
        setVisible(false);
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
      const estimated = Math.round(8 + (1 - Math.exp(-elapsedMs / 18000)) * 86);
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
    </div>
  );
}
