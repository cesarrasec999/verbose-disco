"use client";

import type { ReactNode } from "react";
import { UserCheck } from "lucide-react";
import type { InventoryOperator, RecountFilter, RecountManagerTab } from "@/features/inventarios/types";

type ReconteoModuleProps = {
  isValidationManagerTab: boolean;
  isAdmin: boolean;
  validationEnabled: boolean;
  isSelectedSessionFinished: boolean;
  recountFilter: RecountFilter;
  recountOperatorId: string;
  sessionOperators: InventoryOperator[];
  filteredUnassignedCount: number;
  unassignedCount: number;
  activeAssignedRecountCount: number;
  recountManagerTab: RecountManagerTab;
  assignedCount: number;
  manualCount: number;
  recordsLabel: string;
  recordsCount: number;
  selectedPendingCount: number;
  children: ReactNode;
  onToggleValidationPlan: () => void;
  onAssignRecountBlock: (limit: number) => void;
  onAssignSelectedRecountRows: () => void;
  onChangeRecountFilter: (filter: RecountFilter) => void;
  onRecountOperatorChange: (operatorId: string) => void;
  onRecountManagerTabChange: (tab: RecountManagerTab) => void;
};

export function ReconteoModule({
  isValidationManagerTab,
  isAdmin,
  validationEnabled,
  isSelectedSessionFinished,
  recountFilter,
  recountOperatorId,
  sessionOperators,
  filteredUnassignedCount,
  unassignedCount,
  activeAssignedRecountCount,
  recountManagerTab,
  assignedCount,
  manualCount,
  recordsLabel,
  recordsCount,
  selectedPendingCount,
  children,
  onToggleValidationPlan,
  onAssignRecountBlock,
  onAssignSelectedRecountRows,
  onChangeRecountFilter,
  onRecountOperatorChange,
  onRecountManagerTabChange,
}: ReconteoModuleProps) {
  return (
    <section className="space-y-4">
      <section className="rounded-2xl border bg-white p-4 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="inline-flex items-center gap-2 font-black"><UserCheck size={18} /> {isValidationManagerTab ? "Validacion" : "Reconteo"}</h2>
            <p className="text-xs text-slate-500">{isValidationManagerTab ? "Asigna diferencias ya recontadas para una validacion final." : "Asigna diferencias por bloques a operadores activos."}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {isAdmin && (
              <button
                onClick={onToggleValidationPlan}
                disabled={isSelectedSessionFinished}
                className={`rounded-xl border px-4 py-3 text-sm font-black disabled:opacity-40 ${validationEnabled ? "border-green-300 bg-green-50 text-green-800" : "text-slate-800"}`}
              >
                {validationEnabled ? "Validacion activa" : "Activar validacion"}
              </button>
            )}
            <button onClick={() => onAssignRecountBlock(10)} disabled={isSelectedSessionFinished} className="rounded-xl border px-4 py-3 text-sm font-black text-slate-800 disabled:opacity-40">
              Asignar 10 primeros
            </button>
            <button onClick={() => onAssignRecountBlock(20)} disabled={isSelectedSessionFinished} className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
              Asignar 20 primeros
            </button>
            <button onClick={onAssignSelectedRecountRows} disabled={selectedPendingCount === 0 || isSelectedSessionFinished} className="rounded-xl border px-4 py-3 text-sm font-black text-slate-800 disabled:opacity-40">
              Asignar seleccionados
            </button>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_220px]">
          <div className="grid grid-cols-2 overflow-hidden rounded-xl border p-1 md:grid-cols-4">
            <button onClick={() => onChangeRecountFilter("surplus")} className={`rounded-lg px-3 py-2 text-xs font-black ${recountFilter === "surplus" ? "bg-blue-700 text-white" : "text-slate-600"}`}>Sobrantes</button>
            <button onClick={() => onChangeRecountFilter("surplus_zero_stock")} className={`rounded-lg px-3 py-2 text-xs font-black ${recountFilter === "surplus_zero_stock" ? "bg-blue-700 text-white" : "text-slate-600"}`}>Sobrante stock 0</button>
            <button onClick={() => onChangeRecountFilter("missing")} className={`rounded-lg px-3 py-2 text-xs font-black ${recountFilter === "missing" ? "bg-red-600 text-white" : "text-slate-600"}`}>Faltantes</button>
            <button onClick={() => onChangeRecountFilter("missing_not_counted")} className={`rounded-lg px-3 py-2 text-xs font-black ${recountFilter === "missing_not_counted" ? "bg-red-600 text-white" : "text-slate-600"}`}>Faltante no contado</button>
          </div>

          <select value={recountOperatorId} onChange={event => onRecountOperatorChange(event.target.value)} disabled={isSelectedSessionFinished} className="rounded-xl border bg-white px-3 py-3 text-sm disabled:opacity-40">
            <option value="">Operador</option>
            {sessionOperators.map(row => <option key={row.id} value={row.id}>{row.full_name}</option>)}
          </select>

          <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm font-black text-slate-700">
            {filteredUnassignedCount}{filteredUnassignedCount !== unassignedCount ? ` de ${unassignedCount}` : ""} pendientes | {activeAssignedRecountCount} asignados
          </div>
        </div>
        <p className="mt-3 text-xs font-bold text-slate-500">Orden operativo: sobrantes por mayor diferencia valorizada y faltantes por menor diferencia valorizada.</p>
      </section>

      <div className="grid overflow-hidden rounded-2xl border bg-white p-1 shadow-sm md:grid-cols-4">
        <button
          onClick={() => onRecountManagerTabChange("pendientes")}
          className={`rounded-xl px-4 py-3 text-sm font-black ${recountManagerTab === "pendientes" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
        >
          Pendientes por asignar ({unassignedCount})
        </button>
        <button
          onClick={() => onRecountManagerTabChange("asignados")}
          className={`rounded-xl px-4 py-3 text-sm font-black ${recountManagerTab === "asignados" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
        >
          {isValidationManagerTab ? "Validaciones asignadas" : "Reconteos asignados"} ({assignedCount})
        </button>
        <button
          onClick={() => onRecountManagerTabChange("manual")}
          className={`rounded-xl px-4 py-3 text-sm font-black ${recountManagerTab === "manual" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
        >
          {isValidationManagerTab ? "Validacion manual" : "Reconteo manual"} ({manualCount})
        </button>
        <button
          onClick={() => onRecountManagerTabChange("registros")}
          className={`rounded-xl px-4 py-3 text-sm font-black ${recountManagerTab === "registros" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
        >
          {recordsLabel} ({recordsCount})
        </button>
      </div>

      {children}
    </section>
  );
}
