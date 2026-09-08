type Props = { page: number; hasNext: boolean; busy?: boolean; onPage: (page: number) => void; total?: number };

export default function ReadPagination({ page, hasNext, busy = false, onPage, total }: Props) {
  return <div className="flex flex-wrap items-center justify-between gap-3 border-t p-3 text-xs font-bold text-slate-600" aria-label="Paginación">
    <span aria-live="polite">{busy ? "Cargando…" : `Página ${page + 1}${total === undefined ? " · hasta 50 registros" : ` de ${Math.max(1, Math.ceil(total / 50))} · ${total} códigos`}`}</span>
    <div className="flex gap-2">
      <button type="button" disabled={busy || page === 0} onClick={() => onPage(page - 1)} className="rounded-lg border px-3 py-2 disabled:opacity-40">Anterior</button>
      <button type="button" disabled={busy || !hasNext} onClick={() => onPage(page + 1)} className="rounded-lg border px-3 py-2 disabled:opacity-40">Siguiente</button>
    </div>
  </div>;
}
