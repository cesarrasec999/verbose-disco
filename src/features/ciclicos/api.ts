/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Assignment, CountRecord } from "./types";
import { isSessionFlagLocation, r2 } from "./utils";

type SupabaseLike = {
  from: (table: string) => any;
};

type FetchCyclicDayDataParams = {
  storeId: string;
  date: string;
  includeStoreName?: boolean;
};

export type CyclicDayData = {
  assignments: Assignment[];
  counts: CountRecord[];
  sessionFlags: CountRecord[];
};

function mapAssignment(row: any, includeStoreName: boolean): Assignment {
  return {
    id: row.id,
    store_id: row.store_id,
    product_id: row.product_id,
    system_stock: Number(row.system_stock || 0),
    assigned_date: row.assigned_date,
    assigned_by: row.assigned_by,
    sku: row.cyclic_products?.sku,
    barcode: row.cyclic_products?.barcode,
    description: row.cyclic_products?.description,
    unit: row.cyclic_products?.unit,
    cost: Number(row.cyclic_products?.cost) || 0,
    store_name: includeStoreName ? row.stores?.name : undefined,
  };
}

function enrichCounts(countRows: CountRecord[], assignments: Assignment[], includeStoreName: boolean): CountRecord[] {
  const assignmentById = new Map(assignments.map(row => [row.id, row]));
  return countRows.map(count => {
    const assignment = assignmentById.get(count.assignment_id);
    const difference = r2(Number(count.counted_quantity) - Number(assignment?.system_stock || 0));
    return {
      ...count,
      sku: assignment?.sku,
      description: assignment?.description,
      unit: assignment?.unit,
      cost: assignment?.cost,
      system_stock: assignment?.system_stock,
      difference,
      store_name: includeStoreName ? assignment?.store_name : count.store_name,
    };
  });
}

export async function fetchCyclicDayData(
  supabase: SupabaseLike,
  params: FetchCyclicDayDataParams
): Promise<CyclicDayData> {
  if (!params.storeId || !params.date) return { assignments: [], counts: [], sessionFlags: [] };

  const select = params.includeStoreName
    ? "*, cyclic_products(sku, barcode, description, unit, cost), stores(name)"
    : "*, cyclic_products(sku, barcode, description, unit, cost)";

  const { data: assignmentRows, error: assignmentsError } = await supabase
    .from("cyclic_assignments")
    .select(select)
    .eq("store_id", params.storeId)
    .eq("assigned_date", params.date)
    .order("created_at");
  if (assignmentsError) throw assignmentsError;

  const assignments = ((assignmentRows || []) as any[]).map((row: any) => mapAssignment(row, Boolean(params.includeStoreName)));
  if (assignments.length === 0) return { assignments, counts: [], sessionFlags: [] };

  const assignmentIds = assignments.map(row => row.id);
  const { data: countRows, error: countsError } = await supabase
    .from("cyclic_counts")
    .select("*")
    .in("assignment_id", assignmentIds);
  if (countsError) throw countsError;

  const allCounts = (countRows || []) as CountRecord[];
  const sessionFlags = allCounts.filter(count => isSessionFlagLocation(count.location));
  const realCounts = allCounts.filter(count => !isSessionFlagLocation(count.location));

  return {
    assignments,
    counts: enrichCounts(realCounts, assignments, Boolean(params.includeStoreName)),
    sessionFlags,
  };
}
