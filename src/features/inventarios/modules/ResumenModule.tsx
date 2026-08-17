"use client";

import { Download, Pencil, PackageSearch, RefreshCw, RotateCcw } from "lucide-react";
import type { SummaryRow, SummarySortKey, SortState } from "@/features/inventarios/types";
import { DonutKpi, Kpi, SortHeader, ValueBarKpi } from "@/features/inventarios/components/InventoryUi";
import { money, number2, summaryStatus } from "@/features/inventarios/utils";

const SUMMARY_PAGE_SIZE = 120;

type SummaryKpis = {
  skuProgress: number;
  countedCodes: number;
  totalCodes: number;
  valueProgress: number;
  countedValue: number;
  systemValue: number;
  eri: number;
  notCountedCodes: number;
  codesWithDifference: number;
  surplusValue: number;
  missingValue: number;
  surplusCodes: number;
  missingCodes: number;
  diffValue: number;
};

type ResumenModuleProps = {
  title: string;
  summaryLoading: boolean;
  kpis: SummaryKpis;
  summary: SummaryRow[];
  summaryQuery: string;
  inventoryNotesDraft: string;
  showValidationSummary: boolean;
  summarySort: SortState<SummarySortKey>;
  filteredSummary: SummaryRow[];
  totalSummaryRows: number;
  summaryPage: number;
  summaryTotalPages: number;
  observationDrafts: Record<string, string>;
  isSelectedSessionFinished: boolean;
  onGenerateGeneralInventoryReport: () => void;
  onGenerateInventoryCategoryReport: () => void | Promise<void>;
  onExportSummary: () => void;
  onSummaryQueryChange: (value: string) => void;
  onSummaryPageChange: (page: number) => void;
  onInventoryNotesDraftChange: (value: string) => void;
  onSaveInventoryNotes: () => void;
  onToggleSummarySort: (key: SummarySortKey) => void;
  onObservationDraftChange: (productId: string, value: string) => void;
  onSaveObservation: (row: SummaryRow) => void;
  onMarkSummaryAsNonInventory: (row: SummaryRow) => void;
  summaryQuantityStatusLabel: (value: number | null, status: "no" | "assigned" | "counted" | undefined) => string;
  canForceRefreshStock?: boolean;
  refreshingNonOkStock?: boolean;
  onForceRefreshNonOkStock?: () => void;
  canEditFinishedStock?: boolean;
  onEditSystemStock?: (row: SummaryRow) => void;
  canEditFinishedQuantity?: boolean;
  onEditFinishedQuantity?: (row: SummaryRow, mode: "count" | "recount" | "validation") => void;
};

export function ResumenModule({
  title,
  summaryLoading,
  kpis,
  summary,
  summaryQuery,
  inventoryNotesDraft,
  showValidationSummary,
  summarySort,
  filteredSummary,
  totalSummaryRows,
  summaryPage,
  summaryTotalPages,
  observationDrafts,
  isSelectedSessionFinished,
  onGenerateGeneralInventoryReport,
  onGenerateInventoryCategoryReport,
  onExportSummary,
  onSummaryQueryChange,
  onSummaryPageChange,
  onInventoryNotesDraftChange,
  onSaveInventoryNotes,
  onToggleSummarySort,
  onObservationDraftChange,
  onSaveObservation,
  onMarkSummaryAsNonInventory,
  summaryQuantityStatusLabel,
  canForceRefreshStock,
  refreshingNonOkStock,
  onForceRefreshNonOkStock,
  canEditFinishedStock,
  onEditSystemStock,
  canEditFinishedQuantity,
  onEditFinishedQuantity,
}: ResumenModuleProps) {
  const okCount = summary.filter(row => row.diff === 0 && row.counted > 0).length;
  const maxDifferenceValue = Math.max(Math.abs(kpis.surplusValue), Math.abs(kpis.missingValue), 1);
  const fromRow = totalSummaryRows === 0 ? 0 : ((summaryPage - 1) * SUMMARY_PAGE_SIZE) + 1;
  const toRow = Math.min(summaryPage * SUMMARY_PAGE_SIZE, totalSummaryRows);

  return (
    <>
      <section className="rounded-2xl border bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-black">{title}</h2>
          <div className="flex flex-wrap gap-2">
            {summaryLoading && <span className="inline-flex items-center gap-1 rounded-xl border px-3 py-2 text-xs font-black text-slate-500"><RefreshCw size={14} /> Actualizando...</span>}
            {canForceRefreshStock && (
              <button
                onClick={onForceRefreshNonOkStock}
                disabled={refreshingNonOkStock}
                title="Fuerza la actualización del stock desde el ERP para todos los productos que aún no están OK"
                className="inline-flex items-center gap-1 rounded-xl bg-orange-600 px-3 py-2 text-xs font-black text-white disabled:opacity-50"
              >
                <RotateCcw size={14} className={refreshingNonOkStock ? "animate-spin" : ""} />
                {refreshingNonOkStock ? "Actualizando..." : "Actualizar stock ERP"}
              </button>
            )}
            <button onClick={onGenerateGeneralInventoryReport} className="inline-flex items-center gap-1 rounded-xl bg-slate-900 px-3 py-2 text-xs font-black text-white"><Download size={15} /> Informe PDF</button>
            <button onClick={onGenerateInventoryCategoryReport} className="inline-flex items-center gap-1 rounded-xl bg-indigo-700 px-3 py-2 text-xs font-black text-white"><Download size={15} /> Reporte IG</button>
            <button onClick={onExportSummary} className="inline-flex items-center gap-1 rounded-xl bg-green-700 px-3 py-2 text-xs font-black text-white"><Download size={15} /> Resumen</button>
          </div>
        </div>
        <div className="grid gap-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <DonutKpi label="AVANCE POR SKU" value={kpis.skuProgress} detail={`${kpis.countedCodes} / ${kpis.totalCodes} codigos`} />
            <DonutKpi label="AVANCE POR VALORIZADO" value={kpis.valueProgress} detail={`${money(kpis.countedValue)} de ${money(kpis.systemValue)} total`} tone="blue" />
            <DonutKpi label="ERI" value={kpis.eri} detail={`${okCount} OK / ${kpis.totalCodes} total`} tone="green" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Kpi label="Codigos totales" value={kpis.totalCodes} />
            <Kpi label="Codigos contados" value={kpis.countedCodes} tone="green" />
            <Kpi label="Codigos OK" value={okCount} />
            <Kpi label="No contados" value={kpis.notCountedCodes} tone="amber" />
            <Kpi label="Codigos con diferencia" value={kpis.codesWithDifference} tone={kpis.codesWithDifference > 0 ? "amber" : "slate"} />
          </div>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <ValueBarKpi label="Sobrantes valorizados" value={kpis.surplusValue} maxValue={maxDifferenceValue} tone="blue" />
          <ValueBarKpi label="Faltantes valorizados" value={kpis.missingValue} maxValue={maxDifferenceValue} tone="red" />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Valor sistema" value={money(kpis.systemValue)} />
          <Kpi label="Codigos sobrantes" value={kpis.surplusCodes} tone="blue" />
          <Kpi label="Codigos faltantes" value={kpis.missingCodes} tone="red" />
          <Kpi label="Diferencia valorizada" value={money(kpis.diffValue)} tone={kpis.diffValue < 0 ? "red" : "blue"} />
        </div>
      </section>

      <section className="rounded-2xl border bg-white shadow-sm">
        <div className="border-b p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="inline-flex items-center gap-2 font-black"><PackageSearch size={18} /> Resumen por codigo</h2>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-xl bg-slate-50 px-3 py-2 text-xs font-black text-slate-600">
                {totalSummaryRows === 0 ? "Sin filas" : `Mostrando ${fromRow}-${toRow} de ${totalSummaryRows}`}
              </span>
              <button
                type="button"
                onClick={() => onSummaryPageChange(Math.max(1, summaryPage - 1))}
                disabled={summaryPage <= 1}
                className="rounded-xl border px-3 py-2 text-xs font-black text-slate-700 disabled:opacity-40"
              >
                Anterior
              </button>
              <button
                type="button"
                onClick={() => onSummaryPageChange(Math.min(summaryTotalPages, summaryPage + 1))}
                disabled={summaryPage >= summaryTotalPages}
                className="rounded-xl border px-3 py-2 text-xs font-black text-slate-700 disabled:opacity-40"
              >
                Siguiente
              </button>
              <input value={summaryQuery} onChange={event => onSummaryQueryChange(event.target.value)} placeholder="Buscar código, UPC/ALU, descripción u observación" className="w-full rounded-xl border px-3 py-2 text-sm md:w-96" />
            </div>
          </div>
        </div>
        <div className="border-b px-4 pb-4">
          <div className="rounded-2xl border bg-slate-50 p-3">
            <label className="text-xs font-black text-slate-500">Notas del validador para el informe</label>
            <textarea
              value={inventoryNotesDraft}
              onChange={event => onInventoryNotesDraftChange(event.target.value)}
              className="mt-2 min-h-20 w-full rounded-xl border bg-white px-3 py-2 text-sm outline-none focus:border-slate-500"
              placeholder="Escribe observaciones generales del inventario, incidencias, criterios aplicados o acuerdos con tienda."
            />
            <div className="mt-2 flex justify-end">
              <button onClick={onSaveInventoryNotes} disabled={isSelectedSessionFinished} className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-black text-white disabled:opacity-40">
                Guardar notas
              </button>
            </div>
          </div>
        </div>
        <div className="overflow-auto">
          <table className={`w-full text-sm ${showValidationSummary ? "min-w-[1360px]" : "min-w-[1280px]"}`}>
            <thead className="bg-slate-100 text-xs text-slate-600">
              <tr>
                <SortHeader label="Codigo" active={summarySort.key === "sku"} direction={summarySort.direction} onClick={() => onToggleSummarySort("sku")} align="left" />
                <SortHeader label="Descripcion" active={summarySort.key === "description"} direction={summarySort.direction} onClick={() => onToggleSummarySort("description")} align="left" />
                <SortHeader label="UM" active={summarySort.key === "unit"} direction={summarySort.direction} onClick={() => onToggleSummarySort("unit")} />
                <SortHeader label="Sistema" active={summarySort.key === "system_stock"} direction={summarySort.direction} onClick={() => onToggleSummarySort("system_stock")} />
                <SortHeader label="Conteo" active={summarySort.key === "counted_original"} direction={summarySort.direction} onClick={() => onToggleSummarySort("counted_original")} />
                <SortHeader label="Reconteo" active={summarySort.key === "recounted_qty"} direction={summarySort.direction} onClick={() => onToggleSummarySort("recounted_qty")} />
                {showValidationSummary && <SortHeader label="Validacion" active={summarySort.key === "validation_qty"} direction={summarySort.direction} onClick={() => onToggleSummarySort("validation_qty")} />}
                <SortHeader label="Dif." active={summarySort.key === "diff"} direction={summarySort.direction} onClick={() => onToggleSummarySort("diff")} />
                <th className="p-2 text-center">Status</th>
                <SortHeader label="Costo" active={summarySort.key === "cost"} direction={summarySort.direction} onClick={() => onToggleSummarySort("cost")} />
                <SortHeader label="Dif. Val." active={summarySort.key === "valueDiff"} direction={summarySort.direction} onClick={() => onToggleSummarySort("valueDiff")} />
                <SortHeader label="Observacion" active={summarySort.key === "observation"} direction={summarySort.direction} onClick={() => onToggleSummarySort("observation")} align="left" />
                <th className="p-2">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filteredSummary.map(row => (
                <tr key={row.product_id} className="border-b">
                  <td className="p-2 font-black">{row.sku}</td>
                  <td className="max-w-sm whitespace-normal break-words p-2">{row.description}</td>
                  <td className="p-2 text-center">{row.unit}</td>
                  <td className="p-2 text-center">
                    {canEditFinishedStock ? (
                      <button
                        type="button"
                        onClick={() => onEditSystemStock?.(row)}
                        title="Editar stock de sistema (inventario finalizado)"
                        className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2 py-1 font-bold text-red-700 hover:bg-red-50"
                      >
                        {number2(row.system_stock)} <Pencil size={12} />
                      </button>
                    ) : (
                      number2(row.system_stock)
                    )}
                  </td>
                  <td className="p-2 text-center font-bold">
                    {canEditFinishedQuantity && row.recount_status !== "counted" && row.validation_status !== "counted" ? (
                      <button
                        type="button"
                        onClick={() => onEditFinishedQuantity?.(row, "count")}
                        title="Editar conteo (inventario finalizado)"
                        className="inline-flex items-center gap-1 rounded-lg border border-amber-200 px-2 py-1 font-bold text-amber-700 hover:bg-amber-50"
                      >
                        {number2(row.counted_original)} <Pencil size={12} />
                      </button>
                    ) : (
                      number2(row.counted_original)
                    )}
                  </td>
                  <td className="p-2 text-center font-bold">
                    {canEditFinishedQuantity && row.recount_status === "counted" && row.validation_status !== "counted" ? (
                      <button
                        type="button"
                        onClick={() => onEditFinishedQuantity?.(row, "recount")}
                        title="Editar reconteo (inventario finalizado)"
                        className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 px-2 py-1 font-bold text-indigo-700 hover:bg-indigo-50"
                      >
                        {summaryQuantityStatusLabel(row.recounted_qty, row.recount_status)} <Pencil size={12} />
                      </button>
                    ) : (
                      summaryQuantityStatusLabel(row.recounted_qty, row.recount_status)
                    )}
                  </td>
                  {showValidationSummary && (
                    <td className="p-2 text-center font-bold">
                      {canEditFinishedQuantity && row.validation_status === "counted" ? (
                        <button
                          type="button"
                          onClick={() => onEditFinishedQuantity?.(row, "validation")}
                          title="Editar validación (inventario finalizado)"
                          className="inline-flex items-center gap-1 rounded-lg border border-violet-200 px-2 py-1 font-bold text-violet-700 hover:bg-violet-50"
                        >
                          {summaryQuantityStatusLabel(row.validation_qty, row.validation_status)} <Pencil size={12} />
                        </button>
                      ) : (
                        summaryQuantityStatusLabel(row.validation_qty, row.validation_status)
                      )}
                    </td>
                  )}
                  <td className={`p-2 text-center font-black ${row.diff < 0 ? "text-red-600" : row.diff > 0 ? "text-blue-700" : "text-green-700"}`}>{number2(row.diff)}</td>
                  <td className="p-2 text-center">
                    <span className={`rounded-full px-2 py-1 text-[11px] font-black ${summaryStatus(row) === "OK" ? "bg-green-100 text-green-700" : summaryStatus(row) === "Faltante" ? "bg-red-100 text-red-700" : summaryStatus(row) === "Sobrante" ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>
                      {summaryStatus(row)}
                    </span>
                  </td>
                  <td className="p-2 text-center">{money(row.cost)}</td>
                  <td className={`p-2 text-center font-black ${row.valueDiff < 0 ? "text-red-600" : row.valueDiff > 0 ? "text-blue-700" : "text-green-700"}`}>{money(row.valueDiff)}</td>
                  <td className="p-2">
                    <input value={observationDrafts[row.product_id] || ""} onChange={event => onObservationDraftChange(row.product_id, event.target.value)} className="w-full rounded-lg border px-2 py-1 text-xs" />
                  </td>
                  <td className="p-2 text-center">
                    <div className="flex justify-center gap-1">
                      <button onClick={() => onSaveObservation(row)} disabled={isSelectedSessionFinished} className="rounded-lg border px-2 py-1 text-xs font-black disabled:opacity-40">Guardar</button>
                      <button onClick={() => onMarkSummaryAsNonInventory(row)} disabled={isSelectedSessionFinished} className="rounded-lg border border-amber-300 px-2 py-1 text-xs font-black text-amber-700 disabled:opacity-40">No inv.</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
