const DEVICE_ID_KEY = "rasecorp.offline.deviceId";

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

function randomToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createClientUuid(prefix = "op"): string {
  return `${prefix}-${randomToken()}`;
}

export function getOrCreateDeviceId(storage = browserStorage()): string {
  if (!storage) return `device-${randomToken()}`;

  const current = storage.getItem(DEVICE_ID_KEY);
  if (current) return current;

  const next = `device-${randomToken()}`;
  storage.setItem(DEVICE_ID_KEY, next);
  return next;
}
