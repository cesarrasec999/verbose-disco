import { pickingPage, type PickingCursor } from "./transport";

export type PickingRpcClient = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};
export type TaskRow = {
  assignment: { id: string; created_at: string; request_id: string; line_id: string; picked_qty: number; assigned_qty: number; status: string };
  request: Record<string, unknown>;
  line: Record<string, unknown>;
};

async function rpc<T>(client: PickingRpcClient, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.rpc(name, args);
  if (result.error) throw result.error;
  if (result.data == null) throw new Error("Respuesta vacia de Picking; no se confirmo la operacion.");
  return result.data as T;
}

export async function readPickingTasks(client: PickingRpcClient, pickerId: string, date: string,
  requestId: string | null, cursor: PickingCursor | null = null) {
  const rows = await rpc<TaskRow[]>(client, "get_picking_tasks_page_v2", {
    p_picker_id: pickerId, p_date: date, p_request_id: requestId,
    p_before_at: cursor?.created_at || null, p_before_id: cursor?.id || null, p_limit: 51,
  });
  return pickingPage(rows, row => row.assignment);
}

export async function readPickingScans<T extends PickingCursor>(client: PickingRpcClient,
  pickerId: string, requestId: string, cursor: PickingCursor | null = null) {
  const rows = await rpc<T[]>(client, "get_picking_scans_page_v2", {
    p_picker_id: pickerId, p_request_id: requestId,
    p_before_at: cursor?.created_at || null, p_before_id: cursor?.id || null, p_limit: 51,
  });
  return pickingPage(rows, row => row);
}

export async function readPickingTotals(client: PickingRpcClient, pickerId: string, date: string, requestId: string | null) {
  const rows = await rpc<Array<{ codes: number; completed: number; assigned_qty: number; picked_qty: number }>>(
    client, "get_picking_task_totals_v2", { p_picker_id: pickerId, p_date: date, p_request_id: requestId });
  if (rows.length !== 1) throw new Error("Totales de Picking incompletos.");
  return rows[0];
}

/** The caller owns a persistent operation ID. Never retry with a new ID after an
 * uncertain response. Never silently fall back to the legacy two-step writer. */
export function writePickingScan<T>(client: PickingRpcClient, operationId: string,
  actorId: string, assignmentId: string, product: string, rows: Array<{ location: string; qty: number }>) {
  return rpc<T>(client, "save_picking_scan_v2", {
    p_operation_id: operationId, p_actor_id: actorId, p_assignment_id: assignmentId,
    p_product: product, p_rows: rows,
  });
}

export function assignPickingLines<T>(client: PickingRpcClient, operationId: string,
  actorId: string, pickerId: string, date: string, lineIds: string[]) {
  return rpc<T>(client, "assign_picking_lines_v2", {
    p_operation_id: operationId, p_actor_id: actorId, p_picker_id: pickerId,
    p_date: date, p_line_ids: [...new Set(lineIds)].sort(),
  });
}
