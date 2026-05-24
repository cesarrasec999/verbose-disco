import type { CountRecord, Product } from "./types";

export const ALL_STORES_VALUE = "__all_stores__";

export const SESSION_FLAG_LOCATIONS = new Set([
  "__session_counting__",
  "__session_finished__",
  "__recount_started__",
  "__recount_done__",
]);

export function scannerPermissionMessage(error: unknown) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error || "");
  if (/notallowed|permission|permissions|denied|permiso|camera access/i.test(text)) {
    return "Permiso de camara denegado. Para volver a solicitarlo, abre los permisos del sitio o de la PWA, habilita Camara y vuelve a tocar Escanear.";
  }
  return "No se pudo iniciar la camara: " + (error instanceof Error ? error.message : text);
}

export function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

export function cleanCode(value: string | null | undefined): string {
  if (!value) return "";
  let s = String(value).trim();
  s = s.replace(/^['"''""\u2018\u2019\u201C\u201D]+/, "").replace(/['"''""\u2018\u2019\u201C\u201D]+$/, "").trim();
  if (/[Ee][+-]/.test(s) && !isNaN(Number(s))) {
    const n = Number(s);
    if (isFinite(n)) s = Math.round(n).toString();
  }
  s = s.replace(/\.0+$/, "");
  if (/^\d+$/.test(s)) {
    s = s.replace(/^0+/, "");
    if (s === "") s = "0";
  }
  return s;
}

export function fullProductCode(value: string | number | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let s = raw.replace(/^['"''""\u2018\u2019\u201C\u201D]+/, "").replace(/['"''""\u2018\u2019\u201C\u201D]+$/, "").trim();
  if (/[Ee][+-]/.test(s) && !isNaN(Number(s))) {
    const n = Number(s);
    if (isFinite(n)) s = Math.round(n).toString();
  }
  return s.replace(/\.0+$/, "");
}

export function normalizeUnit(value: string | null | undefined): string {
  return String(value || "").trim().toUpperCase();
}

export function resultLabel(counted: boolean, difference: number) {
  if (!counted) return "Sin conteo";
  if (difference === 0) return "OK";
  return difference < 0 ? "Faltante" : "Sobrante";
}

export function resultMotive(result: string, detail?: string | null) {
  const cleanDetail = String(detail || "").trim();
  const base = result === "OK"
    ? "Conteo coincide con stock"
    : result === "Faltante"
      ? "Conteo menor al stock"
      : result === "Sobrante"
        ? "Conteo mayor al stock"
        : "Sin registros de conteo";
  return cleanDetail ? `${base}. ${cleanDetail}` : base;
}

export function visibleProductCode(value: string | number | null | undefined): string {
  const full = fullProductCode(value);
  const digits = full.replace(/\D/g, "");
  const suffix = (digits || full).slice(-5);
  return cleanCode(suffix);
}

export function isShortVisibleOnlyCode(value: string | number | null | undefined): boolean {
  return /^\d{1,5}$/.test(fullProductCode(value));
}

export function preferFullCodsapProducts<T extends Product>(rows: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = visibleProductCode(row.sku) || fullProductCode(row.sku);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const result: T[] = [];
  for (const group of groups.values()) {
    const hasFullCode = group.some(row => !isShortVisibleOnlyCode(row.sku));
    result.push(...(hasFullCode ? group.filter(row => !isShortVisibleOnlyCode(row.sku)) : group));
  }
  return result;
}

export function codeCandidates(value: string | null | undefined): string[] {
  const raw = String(value || "").trim();
  const clean = cleanCode(raw);
  const withoutPrefix = raw.replace(/^[A-Za-z]+/, "");
  const withoutPrefixClean = cleanCode(withoutPrefix);
  const withAuPrefix = withoutPrefixClean ? `AU${withoutPrefixClean.padStart(7, "0")}` : "";
  const padded = withoutPrefixClean ? withoutPrefixClean.padStart(7, "0") : "";
  return Array.from(new Set([raw, clean, withoutPrefix, withoutPrefixClean, padded, withAuPrefix].filter(Boolean)));
}

export function mappedProductCodeCandidates(row: Record<string, unknown> | null | undefined): string[] {
  if (!row) return [];
  const value = row.codsap ?? row.codigosap ?? row.ProductReference ?? row.productreference ?? row.sku;
  const full = fullProductCode(String(value ?? ""));
  return full ? [full] : [];
}

export function normalizeText(v: string | null | undefined) {
  return String(v || "").trim().toLowerCase();
}

export function parseCost(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") return 0;
  if (typeof raw === "number") return isNaN(raw) ? 0 : raw;
  let s = String(raw).trim().replace(/\s/g, "");
  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/,/g, "");
  } else if (s.includes(",")) {
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length <= 2) s = s.replace(",", ".");
    else s = s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

export function formatMoney(v: number) {
  return `S/ ${Number(v || 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatNumber(v: number | string | null | undefined) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("es-PE", { maximumFractionDigits: 2 });
}

export function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] || char));
}

export function r2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

export function formatDateTime(v: string) {
  if (!v) return "-";
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  return d.toLocaleString("es-PE");
}

export function isSessionFlagLocation(location: string | null | undefined): boolean {
  return SESSION_FLAG_LOCATIONS.has(String(location || ""));
}

export function formatDuration(minutes: number | null): string {
  if (minutes === null || minutes < 0) return "-";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return `${h}h ${m}m`;
}

export function statusBadge(status: CountRecord["status"]) {
  const base = "inline-block px-2 py-0.5 rounded-full text-xs font-semibold";
  switch (status) {
    case "Pendiente": return `${base} bg-slate-100 text-slate-700`;
    case "Diferencia": return `${base} bg-red-100 text-red-700`;
    case "Validado": return `${base} bg-green-100 text-green-700`;
    case "Corregido": return `${base} bg-blue-100 text-blue-700`;
    default: return `${base} bg-slate-100 text-slate-700`;
  }
}

export function diffCardClass(diff: number) {
  if (diff === 0) return "bg-green-50 border-green-300";
  if (diff > 0) return "bg-blue-50 border-blue-300";
  return "bg-red-50 border-red-300";
}

export function diffPillClass(diff: number) {
  if (diff === 0) return "bg-green-100 text-green-700 border-green-200";
  if (diff > 0) return "bg-blue-100 text-blue-700 border-blue-200";
  return "bg-red-100 text-red-700 border-red-200";
}
