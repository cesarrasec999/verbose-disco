import type { ValidatorTab } from "../types";

type InventoryTabsProps = {
  activeTab: ValidatorTab;
  canManageInventory: boolean;
  isAdmin: boolean;
  validationEnabled: boolean;
  onTabChange: (tab: ValidatorTab) => void;
};

const MANAGER_TABS: Array<{ key: ValidatorTab; label: string; requiresManage?: boolean; requiresValidation?: boolean; adminOnly?: boolean }> = [
  { key: "preparacion", label: "Preparacion", requiresManage: true },
  { key: "registros", label: "Registros" },
  { key: "productividad", label: "Productividad" },
  { key: "reconteo", label: "Reconteo", requiresManage: true },
  { key: "validacion", label: "Validacion", requiresManage: true, requiresValidation: true },
  { key: "resumen", label: "Resumen" },
  { key: "usuarios", label: "Usuarios", adminOnly: true },
];

export function InventoryTabs({
  activeTab,
  canManageInventory,
  isAdmin,
  validationEnabled,
  onTabChange,
}: InventoryTabsProps) {
  const visibleTabs = MANAGER_TABS.filter(tab => {
    if (tab.requiresManage && !canManageInventory) return false;
    if (tab.requiresValidation && !validationEnabled) return false;
    if (tab.adminOnly && !isAdmin) return false;
    return true;
  });

  return (
    <section className="rounded-2xl border bg-white p-2 shadow-sm">
      <div className={`grid gap-2 ${isAdmin ? "grid-cols-2 md:grid-cols-7" : "grid-cols-2 md:grid-cols-6"}`}>
        {visibleTabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => onTabChange(tab.key)}
            className={`rounded-xl px-3 py-2 text-xs font-black ${
              activeTab === tab.key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </section>
  );
}
