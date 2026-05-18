import type { SupabaseClient } from "@supabase/supabase-js";
import { listPendingOfflineItems, removeOfflineItem } from "./pendingQueue";
import type { OfflineQueueItem } from "./types";

async function syncItem(supabase: SupabaseClient, item: OfflineQueueItem): Promise<boolean> {
  if (item.operation !== "insert") return false;

  if (item.entity === "general_inventory_counts") {
    const sessionId = (item.payload as { session_id?: string }).session_id;
    if (sessionId) {
      const { data } = await supabase
        .from("general_inventory_sessions")
        .select("status")
        .eq("id", sessionId)
        .maybeSingle();
      if (data?.status === "finished") return false;
    }
    const { error } = await supabase.from("general_inventory_counts").insert(item.payload as Record<string, unknown>);
    if (!error || error.code === "23505") return true;
    return false;
  }

  if (item.entity === "general_inventory_recount_counts") {
    const sessionId = (item.payload as { session_id?: string }).session_id;
    if (sessionId) {
      const { data } = await supabase
        .from("general_inventory_sessions")
        .select("status")
        .eq("id", sessionId)
        .maybeSingle();
      if (data?.status === "finished") return false;
    }
    const { error } = await supabase.from("general_inventory_recount_counts").insert(item.payload as Record<string, unknown>);
    if (!error || error.code === "23505") return true;
    return false;
  }

  return false;
}

export async function syncPendingOfflineItems(supabase: SupabaseClient): Promise<number> {
  const pending = await listPendingOfflineItems();
  let synced = 0;

  for (const item of pending) {
    const ok = await syncItem(supabase, item);
    if (ok) {
      await removeOfflineItem(item.localId);
      synced += 1;
    }
  }

  return synced;
}
