"use client";

import { ArrowLeft, ClipboardList, LogIn, LogOut, PackageSearch, RefreshCw } from "lucide-react";
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
  onLogoutUser: () => void;
  onLogin: () => void;
  onOpenOperatorCountMode: () => void;
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
  onLogoutUser,
  onLogin,
  onOpenOperatorCountMode,
  onOpenOperatorRecountMode,
}: InventoryHeaderProps) {
  const operatorOnly = Boolean(operator && !user);

  return (
    <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-2 px-2 py-3 sm:gap-3 sm:px-3">
        <button
          onClick={onBack}
          className="shrink-0 rounded-xl border p-2 text-slate-600 hover:bg-slate-50"
          title={operatorOnly ? (operatorMode === "reconteo" ? "Volver a conteo" : "Cerrar sesion") : "Volver"}
        >
          {operatorOnly ? (operatorMode === "reconteo" ? <ClipboardList size={18} /> : <LogOut size={18} />) : <ArrowLeft size={18} />}
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
        {user && (
          <button onClick={onLogoutUser} className="inline-flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-sm font-black text-slate-700 hover:bg-slate-50" title="Cerrar sesion">
            <LogOut size={18} />
            <span className="hidden sm:inline">Cerrar sesion</span>
          </button>
        )}
        {operatorOnly && !selectedSession?.manual_recount_enabled && (
          <button onClick={operatorMode === "reconteo" ? onOpenOperatorCountMode : onOpenOperatorRecountMode} className={`inline-flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-sm font-black hover:bg-slate-50 ${operatorMode === "reconteo" ? "bg-slate-900 text-white hover:bg-slate-800" : "text-slate-700"}`} title={operatorMode === "reconteo" ? "Volver a conteo" : "Modo reconteo"}>
            {operatorMode === "reconteo" ? <ClipboardList size={18} /> : <PackageSearch size={18} />}
            <span className="hidden sm:inline">{operatorMode === "reconteo" ? "Conteo" : "Reconteo"}</span>
          </button>
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
