import { ShieldOff } from "lucide-react";

export default function ModuleDisabledScreen({ moduleLabel, reason }: { moduleLabel: string; reason?: string | null }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="max-w-md rounded-2xl border bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-100 text-red-600">
          <ShieldOff size={28} />
        </div>
        <p className="text-xs font-black uppercase text-slate-400">{moduleLabel}</p>
        <h1 className="mt-1 text-xl font-black text-slate-950">Módulo deshabilitado</h1>
        <p className="mt-3 text-sm font-bold text-slate-600">
          Ponte en contacto con el administrador.
        </p>
        {reason && <p className="mt-3 rounded-xl bg-slate-50 p-3 text-xs font-bold text-slate-500">{reason}</p>}
      </div>
    </div>
  );
}
