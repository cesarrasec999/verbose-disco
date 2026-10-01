-- Seleccion auditable de diferencias que la empresa valida para su propio
-- reporte. El reporte original de la tienda se conserva sin modificaciones.

create table if not exists public.reception_difference_selections (
  report_id         uuid primary key
                    references public.reception_difference_reports(id) on delete cascade,
  selected_by       uuid references public.cyclic_users(id) on delete set null,
  selected_by_name  text,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_reception_diff_selections_created
  on public.reception_difference_selections (created_at desc);

alter table public.reception_difference_selections enable row level security;

do $$ begin
  create policy "anon_read_reception_diff_selections"
    on public.reception_difference_selections
    for select to anon, authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "anon_write_reception_diff_selections"
    on public.reception_difference_selections
    for all to anon, authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
