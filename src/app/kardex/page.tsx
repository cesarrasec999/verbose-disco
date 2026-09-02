"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Home,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";
import type { CyclicUser, Store } from "@/features/ciclicos/types";

const PAGE_SIZE = 100;

type Movement = {
  movement_key: string;
  source_type: string;
  source_id: string | null;
  store_code: string;
  movement_date: string;
  operation: string;
  document_no: string | null;
  product_code: string;
  description: string | null;
  unit: string | null;
  cost: number | null;
  quantity: number;
  balance_after: number | null;
  value_total: number | null;
  reason: string | null;
  status: string | null;
  transfer_store_code: string | null;
};

const MOVEMENT_COLUMNS =
  "movement_key,source_type,source_id,store_code,movement_date,operation,document_no,product_code,description,unit,cost,quantity,balance_after,value_total,reason,status,transfer_store_code";

const GPC_STORE_NUMBER_OVERRIDES: Record<number, number> = {
  2: 4,
  3: 5,
  4: 2,
  5: 3,
};

function erpStoreCode(store: Store): string | null {
  const label = String(store.erp_sede || store.name || "");
  if (/CD-GPC|CENTRO DISTRIBUCION/i.test(label)) return "1000";
  const match = label.match(/^GPC0*(\d+)/i);
  if (!match) return null;
  const storeNumber = Number(match[1]);
  return String(
    1000 + (GPC_STORE_NUMBER_OVERRIDES[storeNumber] ?? storeNumber),
  );
}

function localToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("es-PE", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatNumber(value: number | null) {
  return new Intl.NumberFormat("es-PE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function formatMoney(value: number | null) {
  return new Intl.NumberFormat("es-PE", {
    style: "currency",
    currency: "PEN",
  }).format(Number(value || 0));
}

function dateForExcel(value: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(value));
  const part = (type: string) =>
    Number(parts.find((item) => item.type === type)?.value || 0);
  return new Date(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
}

export default function KardexPage() {
  const today = useMemo(localToday, []);
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [from, setFrom] = useState(() => addDays(localToday(), -30));
  const [to, setTo] = useState(today);
  const [storeCode, setStoreCode] = useState("");
  const [productCode, setProductCode] = useState("");
  const [rows, setRows] = useState<Movement[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("cyclic_user");
      if (raw) setUser(JSON.parse(raw) as CyclicUser);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void supabase
      .from("stores")
      .select("id,code,name,is_active,erp_sede,erp_store_no")
      .order("name")
      .then(({ data }) => setStores((data || []) as Store[]));
  }, []);

  const canAccess = Boolean(
    user &&
    (canAccessModule(user, "analysis") ||
      canAccessModule(user, "ajustes_provisionales")),
  );
  const canViewAllStores =
    user?.role === "Administrador" ||
    user?.role === "Supervisor" ||
    user?.role === "Validador" ||
    Boolean(user?.can_access_all_stores);
  const currentStoreCode = useMemo(() => {
    if (canViewAllStores || !user?.store_id) return "";
    const store = stores.find((item) => item.id === user.store_id);
    return store ? erpStoreCode(store) || "" : "";
  }, [canViewAllStores, stores, user]);
  const effectiveStore = canViewAllStores ? storeCode : currentStoreCode;
  const displayStores = useMemo(() => {
    const result = new Map<string, string>();
    for (const store of stores) {
      const code = erpStoreCode(store);
      if (code) result.set(code, store.name);
    }
    return result;
  }, [stores]);

  const buildQuery = useCallback(
    (count = false) => {
      let query = supabase
        .from("erp_movements")
        .select(MOVEMENT_COLUMNS, count ? { count: "exact" } : undefined)
        .gte("movement_date", `${from}T00:00:00-05:00`)
        .lt("movement_date", `${addDays(to, 1)}T00:00:00-05:00`)
        .order("movement_date", { ascending: false })
        .order("movement_key", { ascending: false });

      if (effectiveStore) query = query.eq("store_code", effectiveStore);
      // Código exacto: permite utilizar el índice tienda/código/fecha incluso
      // sobre un historial grande. El buscador no hace búsquedas globales lentas.
      if (productCode.trim())
        query = query.eq("product_code", productCode.trim().toUpperCase());
      return query;
    },
    [effectiveStore, from, productCode, to],
  );

  const load = useCallback(
    async (targetPage = page) => {
      if (!from || !to || from > to) {
        toast.error("Selecciona un rango de fechas válido.");
        return;
      }
      setLoading(true);
      try {
        const first = targetPage * PAGE_SIZE;
        const { data, error, count } = await buildQuery(true).range(
          first,
          first + PAGE_SIZE - 1,
        );
        if (error) throw error;
        setRows((data || []) as Movement[]);
        setTotal(count || 0);
        setPage(targetPage);
        setLoaded(true);
      } catch (error) {
        toast.error(
          `No se pudo consultar Kardex: ${error instanceof Error ? error.message : "error desconocido"}`,
        );
      } finally {
        setLoading(false);
      }
    },
    [buildQuery, from, page, to],
  );

  useEffect(() => {
    if (canAccess && stores.length > 0 && !loaded && !loading) void load(0);
  }, [canAccess, loaded, loading, load, stores.length]);

  const exportExcel = useCallback(async () => {
    if (!loaded) return;
    setExporting(true);
    try {
      const XLSX = await import("xlsx");
      const allRows: Movement[] = [];
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await buildQuery(false).range(
          offset,
          offset + 999,
        );
        if (error) throw error;
        const batch = (data || []) as Movement[];
        allRows.push(...batch);
        if (batch.length < 1000) break;
      }
      const excelRows = allRows.map((row) => ({
        Tienda: displayStores.get(row.store_code) || row.store_code,
        "Fecha y hora": dateForExcel(row.movement_date),
        Operación: row.operation,
        Documento: row.document_no || "",
        Motivo: row.reason || "",
        Código: row.product_code,
        Descripción: row.description || "",
        UM: row.unit || "",
        Cantidad: Number(row.quantity || 0),
        "Saldo posterior":
          row.balance_after === null ? null : Number(row.balance_after),
        Costo: row.cost === null ? null : Number(row.cost),
        "Valor total":
          row.value_total === null ? null : Number(row.value_total),
        Estado: row.status || "",
        "Tienda relacionada": row.transfer_store_code
          ? displayStores.get(row.transfer_store_code) ||
            row.transfer_store_code
          : "",
      }));
      const worksheet = XLSX.utils.json_to_sheet(excelRows);
      for (let index = 2; index <= excelRows.length + 1; index += 1) {
        if (worksheet[`B${index}`])
          worksheet[`B${index}`].z = "dd/mm/yyyy hh:mm:ss";
      }
      worksheet["!cols"] = [
        { wch: 30 },
        { wch: 20 },
        { wch: 28 },
        { wch: 20 },
        { wch: 35 },
        { wch: 18 },
        { wch: 55 },
        { wch: 10 },
        { wch: 14 },
        { wch: 16 },
        { wch: 14 },
        { wch: 16 },
        { wch: 16 },
        { wch: 30 },
      ];
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Kardex");
      XLSX.writeFile(
        workbook,
        `kardex_${from}_a_${to}${productCode ? `_${productCode.trim()}` : ""}.xlsx`,
      );
      toast.success(
        `${allRows.length.toLocaleString("es-PE")} movimientos exportados.`,
      );
    } catch (error) {
      toast.error(
        `No se pudo exportar Kardex: ${error instanceof Error ? error.message : "error desconocido"}`,
      );
    } finally {
      setExporting(false);
    }
  }, [buildQuery, displayStores, from, loaded, productCode, to]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (!user)
    return (
      <div className="min-h-screen bg-slate-50 grid place-items-center text-sm text-slate-500">
        Cargando sesión...
      </div>
    );
  if (!canAccess)
    return (
      <div className="min-h-screen bg-slate-50 grid place-items-center text-sm font-bold text-slate-600">
        No tienes acceso al Kardex.
      </div>
    );

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6">
      <div className="mx-auto max-w-[1800px] space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="rounded-xl border border-slate-200 p-2 text-slate-600 hover:bg-slate-50"
              aria-label="Ir al inicio"
            >
              <Home size={18} />
            </Link>
            <div>
              <h1 className="text-xl font-black text-slate-950">Kardex</h1>
              <p className="text-xs font-medium text-slate-500">
                Movimientos ERP, del más reciente al más antiguo
              </p>
            </div>
          </div>
          <div className="text-xs font-semibold text-slate-500">
            Fuente: Movimientos ERP centralizados
          </div>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5 xl:items-end">
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500">
              Desde
              <input
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </label>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500">
              Hasta
              <input
                type="date"
                value={to}
                max={today}
                onChange={(event) => setTo(event.target.value)}
                className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </label>
            {canViewAllStores ? (
              <label className="text-xs font-bold uppercase tracking-wide text-slate-500">
                Tienda
                <select
                  value={storeCode}
                  onChange={(event) => setStoreCode(event.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
                >
                  <option value="">Todas las tiendas</option>
                  {stores
                    .filter((store) => store.is_active && erpStoreCode(store))
                    .map((store) => (
                      <option key={store.id} value={erpStoreCode(store)!}>
                        {store.name}
                      </option>
                    ))}
                </select>
              </label>
            ) : (
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500">
                Tienda
                <div className="mt-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm normal-case text-slate-700">
                  {displayStores.get(currentStoreCode) || "Mi tienda"}
                </div>
              </div>
            )}
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500">
              Código
              <input
                value={productCode}
                onChange={(event) => setProductCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void load(0);
                }}
                placeholder="Código exacto"
                className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono text-slate-900"
              />
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => void load(0)}
                disabled={loading}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60"
              >
                <RefreshCw
                  size={15}
                  className={loading ? "animate-spin" : ""}
                />
                {loading ? "Consultando" : "Consultar"}
              </button>
              <button
                onClick={() => void exportExcel()}
                disabled={!loaded || exporting || total === 0}
                className="flex items-center justify-center gap-2 rounded-xl border border-emerald-600 px-4 py-2.5 text-sm font-bold text-emerald-700 disabled:opacity-50"
              >
                <Download size={15} />
                {exporting ? "Exportando" : "Excel"}
              </button>
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            El código es exacto para mantener la consulta indexada. El Excel
            incluye todas las filas del filtro, no solo la página visible.
          </p>
        </section>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-black text-slate-800">
              {loaded
                ? `${total.toLocaleString("es-PE")} movimientos`
                : "Consulta Kardex"}
            </p>
            {loaded && (
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                <button
                  onClick={() => void load(page - 1)}
                  disabled={loading || page === 0}
                  className="rounded-lg border border-slate-200 p-1.5 disabled:opacity-40"
                >
                  <ChevronLeft size={16} />
                </button>
                <span>
                  Página {page + 1} de {pageCount}
                </span>
                <button
                  onClick={() => void load(page + 1)}
                  disabled={loading || page + 1 >= pageCount}
                  className="rounded-lg border border-slate-200 p-1.5 disabled:opacity-40"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-[11px] font-black uppercase tracking-wide text-slate-500">
                <tr>
                  {[
                    "Fecha y hora",
                    "Tienda",
                    "Operación",
                    "Documento",
                    "Motivo",
                    "Código",
                    "Descripción",
                    "UM",
                    "Cantidad",
                    "Saldo",
                    "Costo",
                    "Valor",
                    "Estado",
                  ].map((label) => (
                    <th key={label} className="whitespace-nowrap px-4 py-3">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr
                    key={`${row.movement_key}-${row.movement_date}`}
                    className="hover:bg-slate-50"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-600">
                      {formatDateTime(row.movement_date)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-700">
                      {displayStores.get(row.store_code) || row.store_code}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-800">
                      {row.operation}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-600">
                      {row.document_no || "—"}
                    </td>
                    <td className="max-w-[230px] px-4 py-3 text-xs text-slate-600">
                      {row.reason || "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs font-bold text-slate-800">
                      {row.product_code}
                    </td>
                    <td className="min-w-[260px] px-4 py-3 text-slate-700">
                      {row.description || "—"}
                    </td>
                    <td className="px-4 py-3 text-center text-xs text-slate-600">
                      {row.unit || "—"}
                    </td>
                    <td
                      className={`whitespace-nowrap px-4 py-3 text-right font-black ${row.quantity < 0 ? "text-red-600" : "text-emerald-700"}`}
                    >
                      {formatNumber(row.quantity)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-semibold text-slate-700">
                      {row.balance_after === null
                        ? "—"
                        : formatNumber(row.balance_after)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-slate-600">
                      {row.cost === null ? "—" : formatMoney(row.cost)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-semibold text-slate-700">
                      {row.value_total === null
                        ? "—"
                        : formatMoney(row.value_total)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs font-bold text-slate-600">
                      {row.status || "—"}
                    </td>
                  </tr>
                ))}
                {loaded && rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={13}
                      className="px-4 py-12 text-center text-sm text-slate-500"
                    >
                      No hay movimientos para esos filtros.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
