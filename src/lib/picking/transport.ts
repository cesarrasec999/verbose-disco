/** Framework-neutral contract shared with the APK. A failed/uncertain write must
 * retry its original operationId and payload; never fall back to a direct insert. */
export type PickingCursor = { created_at: string; id: string };
export const PICKING_PAGE_SIZE = 50;

export function pickingPage<T>(rows: readonly T[], cursorOf: (row: T) => PickingCursor) {
  const items = rows.slice(0, PICKING_PAGE_SIZE);
  return {
    items,
    hasNext: rows.length > PICKING_PAGE_SIZE,
    next: rows.length > PICKING_PAGE_SIZE && items.length ? cursorOf(items[items.length - 1]) : null,
  };
}

/** Retain IDs through network failures. Editing an uncertain payload is rejected
 * until the original operation is resolved, avoiding a new ID for the same scan. */
export class PickingSubmission {
  private pending: { id: string; fingerprint: string } | null = null;
  private busy = false;
  private readonly createId: () => string;
  constructor(createId: () => string) { this.createId = createId; }

  begin(payload: unknown): string {
    if (this.busy) throw new Error("El envio sigue en proceso.");
    const fingerprint = JSON.stringify(payload);
    if (this.pending && this.pending.fingerprint !== fingerprint) {
      throw new Error("Primero reintenta el envio anterior sin cambiar sus datos para confirmar si se guardo.");
    }
    if (!this.pending) this.pending = { id: this.createId(), fingerprint };
    this.busy = true;
    return this.pending.id;
  }

  confirmed() { this.pending = null; this.busy = false; }
  uncertain() { this.busy = false; }
  /** Only for errors that guarantee the transaction did not commit. */
  rejected() { this.pending = null; this.busy = false; }
}

export function isPickingTransactionRejected(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code || "";
  // PostgreSQL errors are returned after rollback, unlike fetch/HTTP timeouts.
  return /^(22|23|40)/.test(code) || ["P0001", "42501", "55P03", "57014"].includes(code);
}
