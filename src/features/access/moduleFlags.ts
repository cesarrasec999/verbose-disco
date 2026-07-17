import { supabase } from "@/lib/supabase/client";
import type { ModuleAccessKey } from "./moduleAccess";

// Kill switch de modulos (ver panel /control, exclusivo de la cuenta
// "admin"). Diseno fail-open: si la query falla, se trata como "nada
// deshabilitado" en vez de bloquear la app entera por un problema de
// infraestructura ajeno a esta feature.
export async function fetchDisabledModules(): Promise<Set<ModuleAccessKey>> {
  try {
    const { data, error } = await supabase
      .from("module_flags")
      .select("module_key")
      .eq("enabled", false);
    if (error) return new Set();
    return new Set((data || []).map(row => row.module_key as ModuleAccessKey));
  } catch {
    return new Set();
  }
}

// Administrador siempre pasa, sin importar cual cuenta desactivo el modulo -
// asi ninguna de las cuentas admin queda encerrada afuera de un modulo que
// necesite para reaccionar en una emergencia.
export function isModuleBlockedForUser(
  disabled: Set<ModuleAccessKey>,
  key: ModuleAccessKey,
  user: { role?: string | null } | null | undefined,
): boolean {
  if (!disabled.has(key)) return false;
  return user?.role !== "Administrador";
}
