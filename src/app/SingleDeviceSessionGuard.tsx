"use client";

import { useEffect } from "react";
import { supabase } from "@/lib/supabase/client";
import { clearStoredUser, readStoredUser, touchSingleDeviceSession } from "@/lib/singleDeviceSession";

function expireCurrentBrowserSession() {
  clearStoredUser();
  if (window.location.pathname !== "/") window.location.replace("/");
}

export default function SingleDeviceSessionGuard() {
  useEffect(() => {
    let cancelled = false;
    const user = readStoredUser();
    if (!user?.id) return;
    if (!user.cyclic_session_token) {
      expireCurrentBrowserSession();
      return;
    }

    async function verify() {
      const isCurrent = await touchSingleDeviceSession(user);
      if (!cancelled && !isCurrent) expireCurrentBrowserSession();
    }

    void verify();
    const timer = window.setInterval(() => void verify(), 15000);
    const channel = supabase
      .channel(`single-device-session-${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "cyclic_user_sessions", filter: `user_id=eq.${user.id}` },
        payload => {
          const nextToken = (payload.new as { session_token?: string } | null)?.session_token;
          if (nextToken && nextToken !== user.cyclic_session_token) expireCurrentBrowserSession();
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      void supabase.removeChannel(channel);
    };
  }, []);

  return null;
}
