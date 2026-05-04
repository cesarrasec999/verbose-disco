export function cyclicRealtimeChannel(storeId: string, inventoryDate: string): string {
  return `cyclic:${storeId}:${inventoryDate}`;
}

export function auditRealtimeChannel(sessionId: string): string {
  return `audit:${sessionId}`;
}

export function generalInventoryRealtimeChannel(sessionId: string): string {
  return `general-inventory:${sessionId}`;
}

export function stockLookupRealtimeChannel(storeId: string): string {
  return `stock-lookup:${storeId}`;
}
