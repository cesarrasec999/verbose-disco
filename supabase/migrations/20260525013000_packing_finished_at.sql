-- Hora de fin para Etiquetado/Packing.
-- La hora de inicio es created_at; finished_at se llena solo cuando el registro pasa a "hecho".
alter table public.packing_label_tasks
    add column if not exists finished_at timestamptz;
