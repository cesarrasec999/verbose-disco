"use client";

import { ClipboardList, Download, Printer, Search, Trash2, X } from "lucide-react";
import type { CountRow, RecordsSortKey, SortState } from "@/features/inventarios/types";
import { SortHeader } from "@/features/inventarios/components/InventoryUi";
import { countRowKey, number2 } from "@/features/inventarios/utils";

type RegistrosModuleProps = {
  isValidator: boolean;
  canManageInventory: boolean;
  isSelectedSessionFinished: boolean;
  operatorId?: string | null;
  recordsOperatorFilter: string;
  recordsOperatorOptions: Array<{ id: string; name: string }>;
  recordsZoneFilter: string;
  recordsZoneOptions: string[];
  recordsQuery: string;
  recordsSort: SortState<RecordsSortKey>;
  recordsRenderKey: string;
  filteredCounts: CountRow[];
  countsTotal: number;
  onRecordsOperatorFilterChange: (value: string) => void;
  onRecordsZoneFilterChange: (value: string) => void;
  onRecordsQueryChange: (value: string) => void;
  onExportRecords: () => void;
  onPrintRecordsByZone: () => void;
  onToggleRecordsSort: (key: RecordsSortKey) => void;
  onEditCount: (row: CountRow) => void;
  onAdminEditCount: (row: CountRow) => void;
  onDeleteCount: (row: CountRow) => void;
};

export function RegistrosModule({
  isValidator,
  canManageInventory,
  isSelectedSessionFinished,
  operatorId,
  recordsOperatorFilter,
  recordsOperatorOptions,
  recordsZoneFilter,
  recordsZoneOptions,
  recordsQuery,
  recordsSort,
  recordsRenderKey,
  filteredCounts,
  countsTotal,
  onRecordsOperatorFilterChange,
  onRecordsZoneFilterChange,
  onRecordsQueryChange,
  onExportRecords,
  onPrintRecordsByZone,
  onToggleRecordsSort,
  onEditCount,
  onAdminEditCount,
  onDeleteCount,
}: RegistrosModuleProps) {
  return (
    <div className="space-y-4">
      <section className="rounded-2xl border bg-white shadow-sm">
        <div className="border-b p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="inline-flex items-center gap-2 font-black"><ClipboardList size={18} /> Registros</h2>
            <div className="flex flex-wrap items-center gap-2">
              {isValidator && (
                <select
                  value={recordsOperatorFilter}
                  onChange={event => onRecordsOperatorFilterChange(event.target.value)}
                  className="min-h-10 rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-700"
                >
                  <option value="">Todos los operadores</option>
                  {recordsOperatorOptions.map(row => (
                    <option key={row.id} value={row.id}>{row.name}</option>
                  ))}
                </select>
              )}
              <select
                value={recordsZoneFilter}
                onChange={event => onRecordsZoneFilterChange(event.target.value)}
                className="min-h-10 rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-700"
              >
                <option value="">Todas las zonas</option>
                {recordsZoneOptions.map(zone => (
                  <option key={zone} value={zone}>Zona {zone}</option>
                ))}
              </select>
              <div className="flex min-w-[220px] flex-1 items-center rounded-xl border px-3 py-2 md:w-96">
                <Search size={16} className="text-slate-400" />
                <input value={recordsQuery} onChange={event => onRecordsQueryChange(event.target.value)} placeholder="Buscar código, descripción o ubicación" className="min-w-0 flex-1 px-2 text-sm outline-none" />
                {recordsQuery && (
                  <button type="button" onClick={() => onRecordsQueryChange("")} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Limpiar busqueda">
                    <X size={14} />
                  </button>
                )}
              </div>
              <button onClick={onExportRecords} disabled={filteredCounts.length === 0} className="inline-flex items-center gap-1 rounded-xl bg-green-700 px-3 py-2 text-xs font-black text-white disabled:opacity-40">
                <Download size={15} /> Descargar Excel
              </button>
              <button onClick={onPrintRecordsByZone} disabled={countsTotal === 0} className="inline-flex items-center gap-1 rounded-xl bg-slate-900 px-3 py-2 text-xs font-black text-white disabled:opacity-40">
                <Printer size={15} /> Imprimir registros
              </button>
            </div>
          </div>
        </div>
        <div className="overflow-auto">
          <table className="w-full min-w-[920px] text-sm">
            <thead className="bg-slate-100 text-xs text-slate-600">
              <tr>
                <SortHeader label="Fecha" active={recordsSort.key === "counted_at"} direction={recordsSort.direction} onClick={() => onToggleRecordsSort("counted_at")} />
                <SortHeader label="Contador" active={recordsSort.key === "operator_name"} direction={recordsSort.direction} onClick={() => onToggleRecordsSort("operator_name")} align="left" />
                <SortHeader label="Ubicacion" active={recordsSort.key === "location_code"} direction={recordsSort.direction} onClick={() => onToggleRecordsSort("location_code")} />
                <SortHeader label="Codigo" active={recordsSort.key === "sku"} direction={recordsSort.direction} onClick={() => onToggleRecordsSort("sku")} />
                <SortHeader label="Descripcion" active={recordsSort.key === "description"} direction={recordsSort.direction} onClick={() => onToggleRecordsSort("description")} align="left" />
                <SortHeader label="UM" active={recordsSort.key === "unit"} direction={recordsSort.direction} onClick={() => onToggleRecordsSort("unit")} />
                <SortHeader label="Cantidad" active={recordsSort.key === "quantity"} direction={recordsSort.direction} onClick={() => onToggleRecordsSort("quantity")} />
                <th className="p-2 text-center">Acciones</th>
              </tr>
            </thead>
            <tbody key={recordsRenderKey}>
              {filteredCounts.map(row => (
                <tr key={countRowKey(row)} className="border-b">
                  <td className="p-2 text-center text-xs text-slate-500">{new Date(row.counted_at).toLocaleString("es-PE")}</td>
                  <td className="max-w-[180px] truncate p-2 font-bold text-slate-700">{row.operator_name || "Sin usuario"}</td>
                  <td className="p-2 text-center font-black text-slate-800">{row.location_code}</td>
                  <td className="p-2 text-center font-black text-blue-700">{row.sku}</td>
                  <td className="max-w-md whitespace-normal break-words p-2 text-slate-700">{row.description}</td>
                  <td className="p-2 text-center">{row.unit}</td>
                  <td className="p-2 text-center font-black">{number2(row.quantity)}</td>
                  <td className="p-2 text-center">
                    {(operatorId === row.operator_id || isValidator) && (
                      <div className="flex justify-center gap-1">
                        {operatorId === row.operator_id && !isValidator && (
                          <button onClick={() => onEditCount(row)} className="rounded-lg border px-2 py-1 text-xs font-black">Editar</button>
                        )}
                        {isValidator && (
                          <button onClick={() => onAdminEditCount(row)} disabled={isSelectedSessionFinished} className="rounded-lg border px-2 py-1 text-xs font-black disabled:opacity-40">Editar</button>
                        )}
                        {canManageInventory && (
                          <button onClick={() => onDeleteCount(row)} disabled={isSelectedSessionFinished} className="rounded-lg border px-2 py-1 text-red-600 disabled:opacity-40"><Trash2 size={14} /></button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {filteredCounts.length === 0 && (
                <tr><td colSpan={8} className="p-8 text-center text-sm text-slate-400">Sin registros.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
