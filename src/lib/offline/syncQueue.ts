import type { SupabaseClient } from "@supabase/supabase-js";
import { listPendingOfflineItems, removeOfflineItemIfUnchanged } from "./pendingQueue";
import type { OfflineQueueItem } from "./types";

async function syncItem(supabase: SupabaseClient, item: OfflineQueueItem): Promise<boolean> {
  if (item.operation !== "insert") return false;

  const payload = item.payload as Record<string, unknown>;
  const confirmByClientUuid = async (table: "general_inventory_counts" | "general_inventory_recount_counts" | "general_inventory_validation_counts") => {
    if (!item.clientUuid || payload.client_uuid !== item.clientUuid) return false;
    const { data, error } = await supabase.from(table)
      .select("session_id,operator_id,product_id,location_id,location_code,sku,description,unit,quantity,cost_snapshot")
      .eq("client_uuid", item.clientUuid).maybeSingle();
    if (error || !data) return false;
    return data.session_id === payload.session_id && data.operator_id === payload.operator_id
      && data.product_id === payload.product_id && data.location_id === payload.location_id
      && data.location_code === payload.location_code && data.sku === payload.sku
      && data.description === payload.description && data.unit === payload.unit
      && Number(data.quantity) === Number(payload.quantity)
      && Number(data.cost_snapshot) === Number(payload.cost_snapshot);
  };

  if (item.entity === "general_inventory_counts") {
    const sessionId = (item.payload as { session_id?: string }).session_id;
    if (sessionId) {
      const { data } = await supabase
        .from("general_inventory_sessions")
        .select("status")
        .eq("id", sessionId)
        .maybeSingle();
      if (data?.status === "finished") return confirmByClientUuid("general_inventory_counts");
    }
    const { error } = await supabase.from("general_inventory_counts").insert(payload);
    if (!error || await confirmByClientUuid("general_inventory_counts")) return true;
    // The operator edited a pending row while an earlier version was in flight.
    // Update only that same device's row and only if it has not changed since read.
    const { data: existing } = await supabase.from("general_inventory_counts")
      .select("session_id,operator_id,client_device_id,updated_at")
      .eq("client_uuid", item.clientUuid).maybeSingle();
    if (!existing || existing.session_id !== payload.session_id || existing.operator_id !== payload.operator_id
      || existing.client_device_id !== payload.client_device_id
      || Date.parse(String(payload.updated_at)) <= Date.parse(existing.updated_at)) return false;
    const { data: updated, error: updateError } = await supabase.from("general_inventory_counts")
      .update({
        location_id: payload.location_id, location_code: payload.location_code,
        product_id: payload.product_id, sku: payload.sku, description: payload.description,
        unit: payload.unit, quantity: payload.quantity, cost_snapshot: payload.cost_snapshot,
        updated_at: payload.updated_at,
      })
      .eq("client_uuid", item.clientUuid).eq("updated_at", existing.updated_at)
      .select("session_id,operator_id,product_id,location_id,quantity").maybeSingle();
    return !updateError && !!updated && updated.session_id === payload.session_id
      && updated.operator_id === payload.operator_id && updated.product_id === payload.product_id
      && updated.location_id === payload.location_id && Number(updated.quantity) === Number(payload.quantity);
  }

  if (item.entity === "general_inventory_recount_counts") {
    const sessionId = (item.payload as { session_id?: string }).session_id;
    if (sessionId) {
      const { data } = await supabase
        .from("general_inventory_sessions")
        .select("status")
        .eq("id", sessionId)
        .maybeSingle();
      if (data?.status === "finished") return confirmByClientUuid("general_inventory_recount_counts");
    }
    const { error } = await supabase.from("general_inventory_recount_counts").insert(payload);
    return !error || await confirmByClientUuid("general_inventory_recount_counts");
  }

  if (item.entity === "general_inventory_validation_counts") {
    const sessionId = (item.payload as { session_id?: string }).session_id;
    if (sessionId) {
      const { data } = await supabase
        .from("general_inventory_sessions")
        .select("status")
        .eq("id", sessionId)
        .maybeSingle();
      if (data?.status === "finished") return confirmByClientUuid("general_inventory_validation_counts");
    }
    const { error } = await supabase.from("general_inventory_validation_counts").insert(item.payload as Record<string, unknown>);
    return !error || await confirmByClientUuid("general_inventory_validation_counts");
  }

  return false;
}

export async function syncPendingOfflineItems(supabase: SupabaseClient): Promise<number> {
  const pending = await listPendingOfflineItems();
  let synced = 0;

  for (const item of pending) {
    let ok = false;
    try { ok = await syncItem(supabase, item); } catch { /* Keep this item for the next retry. */ }
    if (ok) {
      if (await removeOfflineItemIfUnchanged(item.localId, item.updatedAt, item.payload)) synced += 1;
    }
  }

  return synced;
}
