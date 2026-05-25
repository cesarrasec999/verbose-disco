import type { Role } from "@/features/ciclicos/types";

export type ModuleAccessKey =
  | "cyclic"
  | "cyclic_count_take"
  | "cyclic_assign_products"
  | "cyclic_count_records"
  | "cyclic_summary_by_code"
  | "cyclic_store_progress"
  | "cyclic_dashboard"
  | "reports_non_inventory"
  | "reports_results"
  | "reports"
  | "locations"
  | "audit"
  | "general_inventory"
  | "consulta"
  | "users"
  | "picking"
  | "packing";

export const CYCLIC_SUBMODULE_KEYS: ModuleAccessKey[] = [
  "cyclic_count_take",
  "cyclic_assign_products",
  "cyclic_count_records",
  "cyclic_summary_by_code",
  "cyclic_store_progress",
  "cyclic_dashboard",
];

export const REPORT_SUBMODULE_KEYS: ModuleAccessKey[] = [
  "reports_non_inventory",
  "reports_results",
];

export const MODULE_ACCESS_OPTIONS: Array<{ key: ModuleAccessKey; label: string; group: string }> = [
  { key: "cyclic_count_take", label: "Toma de Conteo", group: "Ciclicos" },
  { key: "cyclic_assign_products", label: "Asignar productos", group: "Conteo ciclico" },
  { key: "cyclic_count_records", label: "Registros de conteo ciclico", group: "Conteo ciclico" },
  { key: "cyclic_summary_by_code", label: "Resumen por codigo", group: "Ciclicos" },
  { key: "cyclic_store_progress", label: "Progreso tiendas", group: "Ciclicos" },
  { key: "cyclic_dashboard", label: "Dashboard", group: "Ciclicos" },
  { key: "reports_non_inventory", label: "No inventariables", group: "Reportes" },
  { key: "reports_results", label: "Resultados", group: "Reportes" },
  { key: "locations", label: "Ubicaciones", group: "Modulos" },
  { key: "audit", label: "Auditorias", group: "Modulos" },
  { key: "general_inventory", label: "Inventarios", group: "Modulos" },
  { key: "consulta", label: "Consulta", group: "Modulos" },
  { key: "reports", label: "Reportes", group: "Modulos" },
  { key: "users", label: "Usuarios", group: "Administracion" },
  { key: "picking", label: "Picking", group: "Modulos" },
  { key: "packing", label: "Etiquetado/Packing", group: "Modulos" },
];

type AccessUser = {
  role: Role | string;
  can_access_audit?: boolean | null;
  module_access?: string[] | null;
};

export function legacyModuleAccessForRole(role: Role | string, canAccessAudit?: boolean | null): ModuleAccessKey[] {
  if (role === "Administrador") return MODULE_ACCESS_OPTIONS.map(option => option.key);
  if (role === "Supervisor") return [
    "cyclic_count_records",
    "cyclic_summary_by_code",
    "cyclic_store_progress",
    "cyclic_dashboard",
    "reports_results",
    "locations",
    "audit",
    "general_inventory",
    "consulta",
    "reports",
    "picking",
    "packing",
  ];
  if (role === "Validador") return [
    "cyclic_assign_products",
    "cyclic_count_records",
    "cyclic_summary_by_code",
    "cyclic_store_progress",
    "cyclic_dashboard",
    "reports_non_inventory",
    "reports_results",
    ...(canAccessAudit ? ["audit" as ModuleAccessKey] : []),
    "general_inventory",
    "consulta",
    "reports",
    "picking",
    "packing",
  ];
  return ["cyclic_count_take", "packing"];
}

export function expandLegacyModuleAccess(keys: string[], role: Role | string, canAccessAudit?: boolean | null): ModuleAccessKey[] {
  const expanded = new Set<ModuleAccessKey>();
  for (const key of keys) {
    if (key === "cyclic") {
      legacyModuleAccessForRole(role, canAccessAudit)
        .filter(item => CYCLIC_SUBMODULE_KEYS.includes(item) || REPORT_SUBMODULE_KEYS.includes(item))
        .forEach(item => expanded.add(item));
    } else if (key === "rotations") {
      expanded.add("reports");
    } else if (key === "replenishment") {
      continue;
    } else if (MODULE_ACCESS_OPTIONS.some(option => option.key === key)) {
      expanded.add(key as ModuleAccessKey);
    }
  }
  return [...expanded];
}

export function normalizedModuleAccess(userOrRole: AccessUser | Role | string, canAccessAudit?: boolean | null): ModuleAccessKey[] {
  if (typeof userOrRole !== "string" && Array.isArray(userOrRole.module_access) && userOrRole.module_access.length > 0) {
    return expandLegacyModuleAccess(userOrRole.module_access, userOrRole.role, userOrRole.can_access_audit);
  }
  const role = typeof userOrRole === "string" ? userOrRole : userOrRole.role;
  const audit = typeof userOrRole === "string" ? canAccessAudit : userOrRole.can_access_audit;
  return legacyModuleAccessForRole(role, audit);
}

export function hasExplicitModuleAccess(user: Pick<AccessUser, "module_access"> | null | undefined) {
  return Array.isArray(user?.module_access) && user.module_access.length > 0;
}

export function canAccessModule(user: AccessUser | null | undefined, key: ModuleAccessKey) {
  if (!user) return false;
  return normalizedModuleAccess(user).includes(key);
}

export function moduleLabel(key: string) {
  return MODULE_ACCESS_OPTIONS.find(option => option.key === key)?.label || key;
}
