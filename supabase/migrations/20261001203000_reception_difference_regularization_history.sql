-- Historial inmutable de cambios en la atención de diferencias. Permite
-- corregir un rechazo sin perder quién lo rechazó, por qué ni cuándo cambió.

create table if not exists public.reception_difference_regularization_history (
  id                         uuid primary key default gen_random_uuid(),
  diff_key                   text not null,
  previous_status            text,
  new_status                 text,
  previous_requirement_ref   text,
  new_requirement_ref        text,
  previous_notes             text,
  new_notes                  text,
  changed_by                 uuid references public.cyclic_users(id) on delete set null,
  changed_by_name            text,
  changed_at                 timestamptz not null default now()
);

create index if not exists idx_reception_diff_reg_history_key_date
  on public.reception_difference_regularization_history (diff_key, changed_at desc);

alter table public.reception_difference_regularization_history enable row level security;

do $$ begin
  create policy "anon_read_reception_diff_reg_history"
    on public.reception_difference_regularization_history
    for select to anon, authenticated using (true);
exception when duplicate_object then null; end $$;

create or replace function public.log_reception_difference_regularization_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from new.status
     or old.requirement_ref is distinct from new.requirement_ref
     or old.notes is distinct from new.notes then
    insert into public.reception_difference_regularization_history (
      diff_key,
      previous_status,
      new_status,
      previous_requirement_ref,
      new_requirement_ref,
      previous_notes,
      new_notes,
      changed_by,
      changed_by_name,
      changed_at
    ) values (
      new.diff_key,
      old.status,
      new.status,
      old.requirement_ref,
      new.requirement_ref,
      old.notes,
      new.notes,
      new.attended_by,
      new.attended_by_name,
      now()
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_reception_diff_reg_history
  on public.reception_difference_regularizations;
create trigger trg_reception_diff_reg_history
after update on public.reception_difference_regularizations
for each row execute function public.log_reception_difference_regularization_change();

revoke all on function public.log_reception_difference_regularization_change()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
