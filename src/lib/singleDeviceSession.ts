"use client";

import { supabase } from "@/lib/supabase/client";
import { getOrCreateDeviceId } from "@/lib/offline/clientIdentity";

const USER_KEY = "cyclic_user";
const SESSION_EVENT = "cyclic-session-expired";

type SessionUser = {
  id: string;
  cyclic_session_token?: string;
  cyclic_device_id?: string;
};

function randomToken() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearStoredUser() {
  localStorage.removeItem(USER_KEY);
  window.dispatchEvent(new CustomEvent(SESSION_EVENT));
}

export function onStoredSessionExpired(handler: () => void) {
  window.addEventListener(SESSION_EVENT, handler);
  return () => window.removeEventListener(SESSION_EVENT, handler);
}

export async function startSingleDeviceSession<T extends SessionUser>(user: T): Promise<T> {
  const token = randomToken();
  const deviceId = getOrCreateDeviceId();
  const nextUser = { ...user, cyclic_session_token: token, cyclic_device_id: deviceId };

  const { error } = await supabase.from("cyclic_user_sessions").upsert({
    user_id: user.id,
    session_token: token,
    device_id: deviceId,
    last_seen_at: new Date().toISOString(),
  });

  if (error) throw error;
  writeStoredUser(nextUser);
  return nextUser;
}

export async function touchSingleDeviceSession(user = readStoredUser()) {
  if (!user?.id || !user.cyclic_session_token) return true;
  const { data, error } = await supabase
    .from("cyclic_user_sessions")
    .select("session_token")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return true;

  const isCurrent = data?.session_token === user.cyclic_session_token;
  if (!isCurrent) return false;

  await supabase
    .from("cyclic_user_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .eq("session_token", user.cyclic_session_token);
  return true;
}

export async function endSingleDeviceSession(user = readStoredUser()) {
  if (user?.id && user.cyclic_session_token) {
    await supabase
      .from("cyclic_user_sessions")
      .delete()
      .eq("user_id", user.id)
      .eq("session_token", user.cyclic_session_token);
  }
  clearStoredUser();
}
