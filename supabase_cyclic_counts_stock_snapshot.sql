alter table public.cyclic_counts
add column if not exists stock_snapshot numeric;

comment on column public.cyclic_counts.stock_snapshot is
'Stock sistema usado como foto historica al momento de guardar o editar el conteo.';
