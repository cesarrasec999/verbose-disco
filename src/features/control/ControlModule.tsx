"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase/client";
import { readStoredUser } from "@/lib/singleDeviceSession";
import type { ModuleAccessKey } from "@/features/access/moduleAccess";
import type { CyclicUser } from "@/features/ciclicos/types";

// Panel exclusivo de la cuenta "admin" (Administrador Principal) - a
// proposito NO pasa por canAccessModule/module_access (que cualquier
// Administrador puede autoconcederse desde Usuarios). El gate es por id
// de usuario hardcodeado, no por rol.
export const CONTROL_OWNER_ID = "6640b556-8944-4921-8b13-c547c834fb05";

// Los 15 modulos de nivel superior (mismos que src/app/page.tsx
// DESTINATION_MODULE) - Conteo Ciclico cubre tanto /dashboard como
// /conteos-ciclicos/*, son el mismo modulo para este kill switch.
const KILL_SWITCH_MODULES: { key: ModuleAccessKey; label: string }[] = [
  { key: "cyclic_count_take", label: "Conteo Cíclico" },
  { key: "locations", label: "Ubicaciones" },
  { key: "audit", label: "Auditorías" },
  { key: "general_inventory", label: "Inventarios" },
  { key: "picking", label: "Picking" },
  { key: "packing", label: "Etiquetado/Packing" },
  { key: "consulta", label: "Consulta" },
  { key: "reports", label: "Reportes" },
  { key: "analysis", label: "Análisis" },
  { key: "reports_non_inventory", label: "No Inventariables" },
  { key: "users", label: "Usuarios" },
  { key: "reception", label: "Recepción" },
  { key: "ajustes_provisionales", label: "Ajustes Provisionales" },
  { key: "credit_sales", label: "Créditos y Cobranzas" },
  { key: "checklist", label: "Checklist" },
  { key: "inventory_differences", label: "Diferencias de Inventario" },
];

type ModuleFlagRow = {
  module_key: string;
  enabled: boolean;
  disabled_reason: string | null;
  updated_at: string;
};

export default function ControlModule() {
  const [ready, setReady] = useState(false);
  const [flags, setFlags] = useState<Map<string, ModuleFlagRow>>(new Map());
  const [reasonDrafts, setReasonDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [user, setUser] = useState<CyclicUser | null>(null);

  useEffect(() => {
    const stored = readStoredUser<CyclicUser>();
    if (!stored || stored.id !== CONTROL_OWNER_ID) { window.location.replace("/"); return; }
    setUser(stored);
    void loadFlags();
  }, []);

  async function loadFlags() {
    const { data, error } = await supabase.from("module_flags").select("*");
    if (error) { toast.error("Error cargando estado de módulos: " + error.message); setReady(true); return; }
    const map = new Map<string, ModuleFlagRow>();
    for (const row of (data || []) as ModuleFlagRow[]) map.set(row.module_key, row);
    setFlags(map);
    setReady(true);
  }

  async function toggleModule(key: ModuleAccessKey, nextEnabled: boolean) {
    if (!user) return;
    setSavingKey(key);
    try {
      const { error } = await supabase.from("module_flags").upsert({
        module_key: key,
        enabled: nextEnabled,
        disabled_reason: nextEnabled ? null : (reasonDrafts[key]?.trim() || null),
        updated_at: new Date().toISOString(),
        updated_by: user.id,
      }, { onConflict: "module_key" });
      if (error) throw error;
      await loadFlags();
      toast.success(nextEnabled ? "Módulo habilitado." : "Módulo deshabilitado.");
    } catch (e: any) {
      toast.error("No se pudo actualizar: " + e.message);
    } finally {
      setSavingKey(null);
    }
  }

  if (!ready) return <p className="p-8 text-center text-sm font-bold text-slate-400">Cargando...</p>;

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-100 text-red-600">
            <ShieldAlert size={24} />
          </div>
          <div>
            <p className="text-xs font-black uppercase text-slate-500">Solo administrador principal</p>
            <h1 className="text-2xl font-black text-slate-950">Control de módulos</h1>
          </div>
        </div>
        <p className="text-sm font-bold text-slate-500">
          Al deshabilitar un módulo, todos los roles salvo Administrador ven un
          mensaje de &ldquo;Módulo deshabilitado&rdquo; al intentar entrar. Administrador
          siempre mantiene acceso.
        </p>

        <div className="divide-y rounded-2xl border bg-white shadow-sm">
          {KILL_SWITCH_MODULES.map(({ key, label }) => {
            const flag = flags.get(key);
            const enabled = flag?.enabled ?? true;
            const saving = savingKey === key;
            return (
              <div key={key} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <p className="text-sm font-black text-slate-900">{label}</p>
                  {!enabled && flag?.disabled_reason && (
                    <p className="text-xs font-bold text-slate-400">Motivo: {flag.disabled_reason}</p>
                  )}
                  {!enabled && (
                    <p className="text-xs font-bold text-red-600">Deshabilitado</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {enabled && (
                    <input
                      value={reasonDrafts[key] || ""}
                      onChange={e => setReasonDrafts(prev => ({ ...prev, [key]: e.target.value }))}
                      placeholder="Motivo (opcional)"
                      className="w-40 rounded-xl border px-3 py-2 text-xs font-bold"
                    />
                  )}
                  <button
                    onClick={() => void toggleModule(key, !enabled)}
                    disabled={saving}
                    className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-black disabled:opacity-40 ${enabled ? "bg-slate-950 text-white" : "bg-emerald-600 text-white"}`}
                  >
                    {saving ? <Loader2 size={14} className="animate-spin" /> : null}
                    {enabled ? "Deshabilitar" : "Habilitar"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
