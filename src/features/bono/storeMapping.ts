export type BonusStore = { id: string; name: string; code?: string | null; erp_sede?: string | null };
export const normalizeStore = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();

/** Names and ERP numeric IDs are separate namespaces; never derive RMS IDs from the GPC prefix. */
export function bonusStoreKeys(store: BonusStore) {
  const result = new Set<string>();
  for (const source of [store.code, store.name, store.erp_sede]) {
    if (!source) continue;
    result.add(normalizeStore(source));
    if (source.includes("-")) result.add(normalizeStore(source.slice(source.lastIndexOf("-") + 1)));
  }
  const code = String(store.code || "").trim();
  if (/^\d+$/.test(code)) {
    result.add(String(Number(code)));
    result.add(String(1000 + Number(code)));
  }
  return result;
}

export function createBonusStoreResolver<T extends BonusStore>(stores: T[]) {
  const map = new Map<string, T>();
  for (const store of stores) for (const key of bonusStoreKeys(store)) {
    const previous = map.get(key);
    if (previous && previous.id !== store.id) throw new Error(`Identificador de tienda ambiguo: ${key}`);
    map.set(key, store);
  }
  return (value: unknown) => map.get(normalizeStore(value));
}

/** Include exact source spellings for indexed SQL joins as well as normalized aliases. */
export function bonusSqlMapping(stores: BonusStore[]) {
  // Rotation/valuation sources use full store names, not RMS numeric IDs.
  // Broad aliases make PostgreSQL choose a scan of the historical partition.
  return stores.map(store => ({ id: store.id, keys: [...new Set([store.name, store.erp_sede].filter(Boolean).flatMap(value => [String(value).trim().toUpperCase(), normalizeStore(value)]))] }));
}
