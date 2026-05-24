import { readSafeSheetObjects } from "@/lib/safeExcel";
import type {
  CountRow,
  InventoryLocation,
  ManualLocationDraft,
  Product,
  RecountCandidate,
  RecountItem,
  SessionStatus,
  SortDirection,
  SummaryRow,
} from "./types";

export const COUNTER_ACTIVE_GAP_MINUTES = 5;
export const OPERATOR_RECORDS_PAGE_SIZE = 20;

export function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}

export function normalizeCode(value: string | number | null | undefined) {
  return String(value ?? "").trim().replace(/\.0+$/, "");
}

export function normalizeLocationCode(value: string | number | null | undefined) {
  return normalizeCode(value)
    .replace(/\u00a0/g, " ")
    .replace(/['’‘´`]/g, "-")
    .trim()
    .toUpperCase();
}

export function locationZoneKey(value: string | number | null | undefined) {
  const clean = normalizeLocationCode(value);
  const zone = clean.split("-")[0] || clean;
  if (/^0+\d+$/.test(zone)) {
    const numeric = zone.replace(/^0+/, "");
    return numeric.padStart(2, "0");
  }
  return zone;
}

export function buildFullLocationFromParts(parts: Pick<ManualLocationDraft, "zone" | "zone_ref" | "lineal" | "reference">) {
  return [parts.zone, parts.zone_ref, parts.lineal, parts.reference]
    .map(value => value.trim())
    .filter(Boolean)
    .join(" - ");
}

export function numericLocationKey(value: string | number | null | undefined) {
  const clean = normalizeLocationCode(value);
  return /^\d+$/.test(clean) ? clean.replace(/^0+(?=\d)/, "") : "";
}

export function findInventoryLocation(locations: InventoryLocation[], value: string | number | null | undefined) {
  const target = normalizeLocationCode(value);
  if (!target) return null;

  const exact = locations.find(row =>
    normalizeLocationCode(row.location_code) === target ||
    normalizeLocationCode(row.ticket) === target
  );
  if (exact) return exact;

  const numericTarget = numericLocationKey(target);
  if (!numericTarget) return null;
  const numericMatches = locations.filter(row =>
    numericLocationKey(row.location_code) === numericTarget ||
    numericLocationKey(row.ticket) === numericTarget
  );
  return numericMatches.length === 1 ? numericMatches[0] : null;
}

export function isIosDevice() {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function searchWords(value: string) {
  return value.trim().toLowerCase().split(/\s+/).filter(word => word.length >= 2);
}

export function normalizeRecordSearch(value: string | number | null | undefined) {
  return normalizeCode(value).toLowerCase();
}

export function recordSkuMatchesNumber(sku: string, query: string) {
  const cleanQuery = query.replace(/\D/g, "");
  if (!cleanQuery) return true;
  const cleanSku = normalizeRecordSearch(sku);
  const skuNumbers = cleanSku.replace(/\D/g, "");
  return cleanSku === cleanQuery || skuNumbers === cleanQuery || skuNumbers.endsWith(cleanQuery) || skuNumbers.includes(cleanQuery);
}

export function recordTextFieldsMatch(row: CountRow, query: string) {
  const haystack = [
    row.description,
    row.location_code,
    row.operator_name,
  ].map(normalizeRecordSearch);
  return haystack.some(value => value.includes(query));
}

export function recordMatchesQuery(row: CountRow, rawQuery: string) {
  const query = normalizeRecordSearch(rawQuery);
  if (!query) return true;
  if (/^\d+$/.test(query)) return recordSkuMatchesNumber(row.sku, query);
  if (recordTextFieldsMatch(row, query)) return true;
  return normalizeRecordSearch(row.sku).includes(query);
}

export function summaryStatus(row: Pick<SummaryRow, "counted" | "diff">) {
  if (row.diff === 0) return "OK";
  return row.diff < 0 ? "Faltante" : "Sobrante";
}

export function operatorRecountItemMatchesQuery(row: RecountItem, rawQuery: string) {
  const query = normalizeRecordSearch(rawQuery);
  if (!query) return true;
  const typeLabel = row.recount_type === "missing" ? "faltante" : "sobrante";
  const fields = [
    row.sku,
    row.description,
    row.location_code,
    row.full_location,
    row.ticket,
    row.zone,
    row.zone_ref,
    row.lineal,
    row.assigned_operator_name,
    typeLabel,
    ...row.original_locations.flatMap(location => [
      location.location_code,
      location.full_location,
      location.ticket,
      location.zone,
      location.zone_ref,
      location.lineal,
    ]),
  ];
  return fields.map(normalizeRecordSearch).some(value => value.includes(query));
}

export function recountCandidateMatchesQuery(row: RecountCandidate, rawQuery: string) {
  const query = normalizeRecordSearch(rawQuery);
  if (!query) return true;
  const typeLabel = row.recount_type === "missing" ? "faltante" : "sobrante";
  const fields = [
    row.sku,
    row.description,
    row.location_code,
    row.full_location,
    row.ticket,
    row.zone,
    row.zone_ref,
    row.lineal,
    typeLabel,
    ...row.original_locations.flatMap(location => [
      location.location_code,
      location.full_location,
      location.ticket,
      location.zone,
      location.zone_ref,
      location.lineal,
    ]),
  ];
  return fields.map(normalizeRecordSearch).some(value => value.includes(query));
}

export function countRowKey(row: CountRow) {
  return [
    row.id,
    row.session_id,
    row.operator_id,
    row.location_id,
    row.location_code,
    row.product_id,
    row.sku,
    row.quantity,
    row.counted_at,
  ].map(value => String(value ?? "")).join("__");
}

export function codeMatchRank(product: Product, query: string) {
  const sku = normalizeCode(product.sku).toUpperCase();
  const barcode = normalizeCode(product.barcode).toUpperCase();
  const suffix = query.slice(-5);
  if (sku === query || barcode === query) return 0;
  if (query.length >= 4 && (sku.endsWith(query) || barcode.endsWith(query))) return 1;
  if (suffix.length >= 4 && (sku.endsWith(suffix) || barcode.endsWith(suffix))) return 2;
  if (query.length >= 4 && (sku.includes(query) || barcode.includes(query))) return 3;
  if (suffix.length >= 4 && (sku.includes(suffix) || barcode.includes(suffix))) return 4;
  return 5;
}

export function money(value: number) {
  return `S/ ${Number(value || 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function number2(value: number | string | null | undefined) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("es-PE", { maximumFractionDigits: 2 });
}

export function dateOnly(value: string | null | undefined) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("es-PE");
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

export function scannerPermissionMessage(error: unknown) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error || "");
  if (/notallowed|permission|permissions|denied|permiso|camera access/i.test(text)) {
    return "Permiso de camara denegado. Para volver a solicitarlo, abre los permisos del sitio o de la PWA, habilita Camara y vuelve a tocar Escanear.";
  }
  return "No se pudo iniciar la camara: " + (error instanceof Error ? error.message : text);
}

export function statusLabel(status: SessionStatus) {
  if (status === "planned") return "Planificado";
  if (status === "open") return "Abierto";
  if (status === "frozen") return "Stock congelado";
  if (status === "finished") return "Finalizado";
  return "Cancelado";
}

export function canOperatorEnter(status: SessionStatus) {
  return status === "open" || status === "frozen";
}

export async function readWorkbookRows(file: File): Promise<Record<string, string>[]> {
  return readSafeSheetObjects<Record<string, string>>(file, { maxRows: 12000, maxCols: 60, raw: false });
}

export function pickColumn(row: Record<string, string>, names: string[]) {
  const entries = Object.entries(row);
  for (const name of names) {
    const normalized = name.trim().toLowerCase();
    const found = entries.find(([key]) => key.trim().toLowerCase() === normalized);
    if (found) return String(found[1] ?? "").trim();
  }
  return "";
}

export function normalizeHeader(value: string) {
  return value.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/_\d+$/, "");
}

export function pickFirstMatchingColumn(row: Record<string, string>, names: string[]) {
  const normalizedNames = new Set(names.map(normalizeHeader));
  const found = Object.entries(row).find(([key]) => normalizedNames.has(normalizeHeader(key)));
  return String(found?.[1] ?? "").trim();
}

export function pickLastMatchingColumn(row: Record<string, string>, names: string[]) {
  const normalizedNames = new Set(names.map(normalizeHeader));
  const found = [...Object.entries(row)].reverse().find(([key]) => normalizedNames.has(normalizeHeader(key)));
  return String(found?.[1] ?? "").trim();
}

export function firstColumnValue(row: Record<string, string>) {
  const first = Object.values(row)[0];
  return String(first ?? "").trim();
}

export function compareValues(a: string | number, b: string | number, direction: SortDirection) {
  const multiplier = direction === "asc" ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * multiplier;
  return String(a).localeCompare(String(b), "es", { numeric: true, sensitivity: "base" }) * multiplier;
}

export function compareLocationByZone(a: string | number | null | undefined, b: string | number | null | undefined, direction: SortDirection = "asc") {
  const zoneCompare = compareValues(locationZoneKey(a), locationZoneKey(b), direction);
  if (zoneCompare !== 0) return zoneCompare;
  return compareValues(normalizeLocationCode(a), normalizeLocationCode(b), direction);
}

export function calculateActiveCounterMinutes(times: number[]) {
  const validTimes = times.filter(Number.isFinite).sort((a, b) => a - b);
  if (validTimes.length === 0) return { activeMinutes: 0, excludedPauseMinutes: 0 };
  if (validTimes.length === 1) return { activeMinutes: 1, excludedPauseMinutes: 0 };

  const maxActiveGapMs = COUNTER_ACTIVE_GAP_MINUTES * 60000;
  let blockStart = validTimes[0];
  let previous = validTimes[0];
  let activeMs = 0;
  let excludedPauseMs = 0;

  for (const time of validTimes.slice(1)) {
    const gap = time - previous;
    if (gap > maxActiveGapMs) {
      activeMs += Math.max(60000, previous - blockStart);
      excludedPauseMs += gap;
      blockStart = time;
    }
    previous = time;
  }

  activeMs += Math.max(60000, previous - blockStart);
  return {
    activeMinutes: Math.max(1, activeMs / 60000),
    excludedPauseMinutes: Math.max(0, excludedPauseMs / 60000),
  };
}

export function recountKey(row: Pick<RecountCandidate, "product_id" | "recount_type">) {
  return `${row.product_id}__${row.recount_type}`;
}

export function sortRecountAssignmentLines<T extends Pick<RecountCandidate, "value_diff" | "recount_type" | "sku">>(rows: T[]) {
  return [...rows].sort((a, b) => {
    const aValue = Number(a.value_diff || 0);
    const bValue = Number(b.value_diff || 0);
    const valueCompare = a.recount_type === "missing"
      ? aValue - bValue
      : bValue - aValue;
    if (valueCompare !== 0) return valueCompare;
    return String(a.sku || "").localeCompare(String(b.sku || ""), "es", { numeric: true, sensitivity: "base" });
  });
}

export function sortOperatorRecountCards<T extends Pick<RecountCandidate, "sku" | "value_diff" | "recount_type">>(rows: T[]) {
  return [...rows].sort((a, b) => {
    const aValue = Number(a.value_diff || 0);
    const bValue = Number(b.value_diff || 0);
    const valueCompare = a.recount_type === "missing"
      ? aValue - bValue
      : bValue - aValue;
    if (valueCompare !== 0) return valueCompare;
    const skuCompare = String(a.sku || "").localeCompare(String(b.sku || ""), "es", { numeric: true, sensitivity: "base" });
    if (skuCompare !== 0) return skuCompare;
    return 0;
  });
}
