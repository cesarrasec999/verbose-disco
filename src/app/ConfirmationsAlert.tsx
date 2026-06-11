"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";
import type { CyclicUser } from "@/features/ciclicos/types";

function userCanValidate(user: CyclicUser | null) {
  return Boolean(
    user &&
    (user.role === "Administrador" || user.role === "Validador" || user.role === "Supervisor") &&
    canAccessModule(user, "confirmations")
  );
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// No sonamos si ya está en la página (tiene su propio sistema de alarma)
function isOnConfirmationsPage() {
  return typeof window !== "undefined" && window.location.pathname === "/confirmaciones";
}

export default function ConfirmationsAlert() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const audioRef = useRef<AudioContext | null>(null);
  const alarmRef = useRef<number | null>(null);
  const notifiedRef = useRef<Set<string>>(new Set());
  const realtimeRef = useRef<number | null>(null);

  // Cargar usuario desde localStorage
  useEffect(() => {
    function loadUser() {
      try {
        const raw = localStorage.getItem("cyclic_user");
        if (!raw) { setUser(null); return; }
        setUser(JSON.parse(raw) as CyclicUser);
      } catch { setUser(null); }
    }
    loadUser();
    window.addEventListener("storage", loadUser);
    return () => window.removeEventListener("storage", loadUser);
  }, []);

  const checkPending = useCallback(async () => {
    if (!userCanValidate(user)) return;
    const today = todayISO();
    const { data, error } = await supabase
      .from("payment_confirmations")
      .select("id, status, opened_at")
      .eq("status", "Pendiente")
      .gte("registered_at", `${today}T00:00:00`)
      .lte("registered_at", `${today}T23:59:59.999`);
    if (error || !data) return;

    const unopened = data.filter(r => !r.opened_at);
    setPendingCount(unopened.length);

    // Notificar por los nuevos que aún no avisamos
    if (!isOnConfirmationsPage()) {
      const newOnes = unopened.filter(r => !notifiedRef.current.has(r.id));
      if (newOnes.length > 0) {
        for (const r of newOnes) notifiedRef.current.add(r.id);
        showBrowserNotification(unopened.length);
      }
    }
  }, [user]);

  // Suscripción realtime + polling de respaldo
  useEffect(() => {
    if (!userCanValidate(user)) {
      setPendingCount(0);
      return;
    }

    void checkPending();

    const channel = supabase
      .channel("confirmations_alert_global")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "payment_confirmations" },
        () => {
          if (realtimeRef.current) window.clearTimeout(realtimeRef.current);
          realtimeRef.current = window.setTimeout(() => void checkPending(), 300);
        }
      )
      .subscribe();

    const poll = window.setInterval(() => void checkPending(), 30_000);

    return () => {
      void supabase.removeChannel(channel);
      window.clearInterval(poll);
      if (realtimeRef.current) window.clearTimeout(realtimeRef.current);
    };
  }, [user, checkPending]);

  // Alarma sonora (solo cuando no estamos en la página de confirmaciones)
  useEffect(() => {
    if (pendingCount > 0 && userCanValidate(user) && !isOnConfirmationsPage()) {
      startAlarm();
    } else {
      stopAlarm();
    }
    return () => stopAlarm();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCount, user]);

  function playBeep() {
    const AudioCtor =
      window.AudioContext ||
      (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    const ctx = audioRef.current ?? new AudioCtor();
    audioRef.current = ctx;
    if (ctx.state === "suspended") { void ctx.resume(); return; }
    [980, 1240, 1560].forEach((freq, i) => {
      const t = ctx.currentTime + i * 0.18;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.7, t + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.16);
    });
  }

  function startAlarm() {
    if (alarmRef.current) return;
    playBeep();
    alarmRef.current = window.setInterval(playBeep, 8_000);
  }

  function stopAlarm() {
    if (!alarmRef.current) return;
    window.clearInterval(alarmRef.current);
    alarmRef.current = null;
  }

  function showBrowserNotification(count: number) {
    if (typeof Notification === "undefined") return;
    const msg = `${count} confirmación${count !== 1 ? "es" : ""} pendiente${count !== 1 ? "s" : ""} de validar`;
    if (Notification.permission === "granted") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Notification("Confirmaciones pendientes", {
        body: msg,
        icon: "/icon.png",
        tag: "confirmations-alert",
        renotify: true,
      } as any);
    } else if (Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }

  // No renderizar nada si no hay pendientes o no tiene permiso
  if (pendingCount === 0 || !userCanValidate(user)) return null;
  // No mostrar badge si ya estamos en la página (tiene su propia UI)
  if (isOnConfirmationsPage()) return null;

  return (
    <a
      href="/confirmaciones"
      className="fixed bottom-6 right-6 z-[9998] flex items-center gap-2 rounded-2xl bg-amber-500 px-4 py-3 text-white shadow-2xl transition-all duration-150 ease-out hover:bg-amber-600 active:scale-[0.97]"
    >
      <span className="absolute inset-0 -z-10 animate-ping rounded-2xl bg-amber-400 opacity-30" />
      <span className="relative flex h-3 w-3">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
        <span className="relative inline-flex h-3 w-3 rounded-full bg-white" />
      </span>
      <span className="text-sm font-black">
        {pendingCount} confirmación{pendingCount !== 1 ? "es" : ""} pendiente{pendingCount !== 1 ? "s" : ""}
      </span>
    </a>
  );
}
