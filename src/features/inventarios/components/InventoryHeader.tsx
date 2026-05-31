"use client";

import { ClipboardList, Home, LogIn, LogOut, PackageSearch, RefreshCw, Search } from "lucide-react";
import type { CyclicUser, InventoryOperator, InventorySession, OperatorMode } from "../types";

type InventoryHeaderProps = {
  user: CyclicUser | null;
  operator: InventoryOperator | null;
  operatorMode: OperatorMode;
  selectedSession: InventorySession | null | undefined;
  isMobileAccess: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onGoModule: (path: string) => void;
  onLogin: () => void;
  onOpenOperatorCountMode: () => void;
  onOpenOperatorLookupMode: () => void;
  onOpenOperatorRecountMode: () => void;
};

export function InventoryHeader({
  user,
  operator,
  operatorMode,
  selectedSession,
  isMobileAccess,
  onBack,
  onRefresh,
  onGoModule,
  onLogin,
  onOpenOperatorCountMode,
  onOpenOperatorLookupMode,
  onOpenOperatorRecountMode,
}: InventoryHeaderProps) {
  const operatorOnly = Boolean(operator && !user);
  const operatorModeButtonClass = (mode: OperatorMode, disabled = false) =>
    `inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border px-2.5 py-2 text-xs font-black transition sm:px-3 sm:text-sm ${
      operatorMode === mode
        ? "border-slate-900 bg-slate-900 text-white"
        : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
    } ${disabled ? "cursor-not-allowed opacity-45 hover:bg-white" : ""}`;

  return (
    <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-2 py-3 sm:gap-3 sm:px-3">
        <button
          onClick={onBack}
          className="shrink-0 rounded-xl border p-2 text-slate-600 hover:bg-slate-50"
          title={operatorOnly ? (operatorMode === "reconteo" || operatorMode === "consulta" ? "Volver a conteo" : "Cerrar sesion") : "Menu principal"}
        >
          {operatorOnly ? (operatorMode === "reconteo" || operatorMode === "consulta" ? <ClipboardList size={18} /> : <LogOut size={18} />) : <Home size={18} />}
        </button>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-600 font-black text-white">R</div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-black leading-tight">Inventarios generales</h1>
          <p className="truncate text-xs text-slate-500">RASECORP - conteo por ubicaciones</p>
        </div>
        <button onClick={onRefresh} className="shrink-0 rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Actualizar">
          <RefreshCw size={18} />
        </button>
        {user && (
          <button onClick={() => onGoModule("/consulta-stock")} className="shrink-0 rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Consulta de stock">
            <PackageSearch size={18} />
          </button>
        )}
        {!isMobileAccess && (user?.role === "Administrador" || user?.role === "Supervisor") && (
          <select
            value="/inventarios"
            onChange={event => onGoModule(event.target.value)}
            className="hidden shrink-0 rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-700 md:block"
            title="Cambiar modulo"
          >
            <option value="/dashboard">Ciclicos</option>
            <option value="/auditoria">Auditorias</option>
            <option value="/inventarios">Inventarios</option>
          </select>
        )}
        {operatorOnly && (
          <div className="order-last grid w-full grid-cols-3 gap-2 sm:order-none sm:w-auto sm:flex">
            <button onClick={onOpenOperatorCountMode} className={operatorModeButtonClass("conteo")} title="Modo conteo">
              <ClipboardList size={18} />
              <span>Conteo</span>
            </button>
            <button
              onClick={selectedSession?.manual_recount_enabled ? undefined : onOpenOperatorRecountMode}
              disabled={Boolean(selectedSession?.manual_recount_enabled)}
              className={operatorModeButtonClass("reconteo", Boolean(selectedSession?.manual_recount_enabled))}
              title={selectedSession?.manual_recount_enabled ? "Reconteo manual impreso activo" : "Modo reconteo"}
            >
              <PackageSearch size={18} />
              <span>Reconteo</span>
            </button>
            <button onClick={onOpenOperatorLookupMode} className={operatorModeButtonClass("consulta")} title="Buscar registros por codigo">
              <Search size={18} />
              <span>Busqueda</span>
            </button>
          </div>
        )}
        {!user && !operator && (
          <button onClick={onLogin} className="inline-flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-sm font-black text-slate-700 hover:bg-slate-50" title="Iniciar sesion">
            <LogIn size={18} />
            <span className="hidden sm:inline">Iniciar sesion</span>
          </button>
        )}
      </div>
    </header>
  );
}
