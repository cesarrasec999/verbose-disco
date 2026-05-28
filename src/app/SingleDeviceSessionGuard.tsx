"use client";

import { useEffect, useRef } from "react";
import { clearStoredUser, readStoredUser, touchSingleDeviceSession } from "@/lib/singleDeviceSession";

const CHECK_INTERVAL_MS = 60000;

function expireCurrentBrowserSession() {
  clearStoredUser();
  if (window.location.pathname !== "/") window.location.replace("/");
}

export default function SingleDeviceSessionGuard() {
  const verifyingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function verify() {
      const user = readStoredUser();
      if (!user?.id) return;
      if (verifyingRef.current) return;
      verifyingRef.current = true;
      let isCurrent = true;
      try {
        isCurrent = await touchSingleDeviceSession(user);
      } catch {
        isCurrent = true;
      } finally {
        verifyingRef.current = false;
      }
      if (!cancelled && !isCurrent) expireCurrentBrowserSession();
    }

    void verify();
    const timer = window.setInterval(() => void verify(), CHECK_INTERVAL_MS);
    const onFocus = () => void verify();
    const onVisible = () => {
      if (document.visibilityState === "visible") void verify();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
