"use client";

import { supabase } from "@/lib/supabase/client";
import { getOrCreateDeviceId } from "@/lib/offline/clientIdentity";

const USER_KEY = "cyclic_user";
const SESSION_EVENT = "cyclic-session-expired";
const SESSION_REASON_KEY = "cyclic_session_expired_reason";
const OTHER_DEVICE_REASON = "Tu usuario supero el maximo de 3 dispositivos conectados.";

type SessionUser = {
  id: string;
  username?: string | null;
  full_name?: string | null;
  role?: string | null;
  cyclic_session_token?: string;
  cyclic_device_id?: string;
};

const ACTIVE_SESSION_GRACE_MS = 12 * 60 * 60 * 1000;
const MAX_ACTIVE_DEVICES = 3;

function randomToken() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizeAdminText(value: string | null | undefined) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function isPrincipalAdministrator(user: SessionUser | null | undefined) {
  if (!user) return false;
  return normalizeAdminText(user.role) === "administrador" &&
    normalizeAdminText(user.full_name) === "administrador principal";
}

export function readStoredUser<T extends SessionUser = SessionUser>(): T | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    localStorage.removeItem(USER_KEY);
    return null;
  }
}

export function writeStoredUser<T extends SessionUser>(user: T) {
  const current = readStoredUser<SessionUser>();
  const shouldPreserveSession = current?.id === user.id;
  const nextUser = shouldPreserveSession
    ? {
        ...user,
        cyclic_session_token: user.cyclic_session_token || current.cyclic_session_token,
        cyclic_device_id: user.cyclic_device_id || current.cyclic_device_id,
      }
    : user;
  localStorage.setItem(USER_KEY, JSON.stringify(nextUser));
}

export function readSessionExpiredReason() {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem(SESSION_REASON_KEY) || "";
}

export function consumeSessionExpiredReason() {
  const reason = readSessionExpiredReason();
  if (typeof window !== "undefined") sessionStorage.removeItem(SESSION_REASON_KEY);
  return reason;
}

export function clearStoredUser(reason = "") {
  if (reason) sessionStorage.setItem(SESSION_REASON_KEY, reason);
  localStorage.removeItem(USER_KEY);
  window.dispatchEvent(new CustomEvent(SESSION_EVENT, { detail: { reason } }));
}

export function onStoredSessionExpired(handler: (reason: string) => void) {
  const listener = (event: Event) => {
    const reason = event instanceof CustomEvent ? String(event.detail?.reason || "") : "";
    handler(reason || readSessionExpiredReason());
  };
  window.addEventListener(SESSION_EVENT, listener);
  return () => window.removeEventListener(SESSION_EVENT, listener);
}

export async function startSingleDeviceSession<T extends SessionUser>(user: T): Promise<T> {
  if (isPrincipalAdministrator(user)) {
    const nextUser = {
      ...user,
      cyclic_session_token: undefined,
      cyclic_device_id: undefined,
    };
    writeStoredUser(nextUser);
    return nextUser;
  }

  const deviceId = getOrCreateDeviceId();
  const now = Date.now();
  const cutoff = new Date(now - ACTIVE_SESSION_GRACE_MS).toISOString();

  await supabase
    .from("cyclic_user_sessions")
    .delete()
    .eq("user_id", user.id)
    .lt("last_seen_at", cutoff);

  const { data: sessions } = await supabase
    .from("cyclic_user_sessions")
    .select("session_token,device_id,last_seen_at")
    .eq("user_id", user.id)
    .order("last_seen_at", { ascending: false });

  const activeSessions = (sessions || []).filter((session) => {
    const lastSeenMs = session.last_seen_at ? new Date(session.last_seen_at).getTime() : 0;
    return now - lastSeenMs < ACTIVE_SESSION_GRACE_MS;
  });
  const existing = activeSessions.find((session) => session.device_id === deviceId);
  const lastSeenMs = existing?.last_seen_at ? new Date(existing.last_seen_at).getTime() : 0;
  const sameActiveDevice = existing?.device_id === deviceId && now - lastSeenMs < ACTIVE_SESSION_GRACE_MS;
  const token = sameActiveDevice && existing?.session_token ? existing.session_token : randomToken();
  const nextUser = { ...user, cyclic_session_token: token, cyclic_device_id: deviceId };

  if (!sameActiveDevice && activeSessions.length >= MAX_ACTIVE_DEVICES) {
    const sessionsToRemove = activeSessions
      .slice(MAX_ACTIVE_DEVICES - 1)
      .map((session) => session.session_token)
      .filter(Boolean);
    if (sessionsToRemove.length > 0) {
      await supabase
        .from("cyclic_user_sessions")
        .delete()
        .eq("user_id", user.id)
        .in("session_token", sessionsToRemove);
    }
  }

  const { error } = await supabase.from("cyclic_user_sessions").upsert({
    user_id: user.id,
    session_token: token,
    device_id: deviceId,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: "user_id,device_id" });

  if (error) throw error;
  writeStoredUser(nextUser);
  return nextUser;
}

export async function touchSingleDeviceSession(user = readStoredUser()) {
  if (!user?.id) return true;
  if (isPrincipalAdministrator(user)) return true;
  if (!user.cyclic_session_token) return true;
  const { data, error } = await supabase
    .from("cyclic_user_sessions")
    .select("session_token,device_id")
    .eq("user_id", user.id)
    .eq("session_token", user.cyclic_session_token)
    .maybeSingle();
  if (error) return true;

  const isCurrent =
    data?.session_token === user.cyclic_session_token &&
    (!user.cyclic_device_id || !data.device_id || data.device_id === user.cyclic_device_id);
  if (!isCurrent) return false;

  await supabase
    .from("cyclic_user_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .eq("session_token", user.cyclic_session_token);
  return true;
}

export async function endSingleDeviceSession(user = readStoredUser()) {
  if (user?.id && user.cyclic_session_token && !isPrincipalAdministrator(user)) {
    await supabase
      .from("cyclic_user_sessions")
      .delete()
      .eq("user_id", user.id)
      .eq("session_token", user.cyclic_session_token);
  }
  clearStoredUser();
}

export { OTHER_DEVICE_REASON };
