/* eslint-disable @typescript-eslint/no-explicit-any */

import type { CountRow } from "./types";
import { normalizeLocationCode, normalizeRecordSearch, OPERATOR_RECORDS_PAGE_SIZE } from "./utils";

type SupabaseLike = {
  from: (table: string) => any;
};

export async function fetchOperatorCountsPage(
  supabase: SupabaseLike,
  params: {
    sessionId: string;
    operatorId: string;
    page: number;
    query: string;
  }
): Promise<{ rows: CountRow[]; total: number }> {
  const from = Math.max(0, (params.page - 1) * OPERATOR_RECORDS_PAGE_SIZE);
  const to = from + OPERATOR_RECORDS_PAGE_SIZE - 1;
  const queryText = normalizeRecordSearch(params.query).replace(/[,%()]/g, " ").trim();

  let request = supabase
    .from("general_inventory_counts")
    .select("*, general_inventory_operators(full_name)", { count: "exact" })
    .eq("session_id", params.sessionId)
    .eq("operator_id", params.operatorId)
    .order("counted_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  if (queryText) {
    const term = `%${queryText}%`;
    request = /^\d+$/.test(queryText)
      ? request.or(`sku.ilike.${term}`)
      : request.or(`sku.ilike.${term},description.ilike.${term},location_code.ilike.${term}`);
  }

  const { data, error, count } = await request;
  if (error) throw error;

  const rows = ((data || []).map((row: any) => ({
    ...row,
    location_code: normalizeLocationCode(row.location_code),
    operator_name: row.general_inventory_operators?.full_name || null,
  })) as CountRow[]);

  return { rows, total: Number(count || 0) };
}
