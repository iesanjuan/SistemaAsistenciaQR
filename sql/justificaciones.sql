-- ============================================================================
-- Justificaciones de tardanzas y faltas.
--
-- Una FALTA no tiene fila en `asistencias` (es la ausencia de marcación ese
-- día), por eso las justificaciones viven en su propia tabla, indexadas por
-- (estudiante, fecha). Sirve tanto para TARDE como para FALTA. Es una
-- ANOTACIÓN: no cambia los conteos del reporte, solo deja constancia del
-- motivo.
--
-- Seguridad: un AUXILIAR solo puede ver/registrar justificaciones de alumnos
-- de su jurisdicción (su turno + secciones asignadas); un ADMIN, todo.
--
-- Ejecutar en el SQL Editor de Supabase.
-- ============================================================================

create table if not exists justificaciones (
  id             uuid primary key default gen_random_uuid(),
  estudiante_id  uuid not null references estudiantes(id) on delete cascade,
  fecha          date not null,
  tipo           text not null check (tipo in ('TARDE', 'FALTA')),
  motivo         text not null,
  registrado_por uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (estudiante_id, fecha)
);

create index if not exists idx_justificaciones_estudiante on justificaciones (estudiante_id);
create index if not exists idx_justificaciones_fecha on justificaciones (fecha);

alter table justificaciones enable row level security;

-- Ver: admin todo; auxiliar solo su jurisdicción.
drop policy if exists "justificaciones_select_jurisdiccion" on justificaciones;
create policy "justificaciones_select_jurisdiccion"
  on justificaciones for select
  using (
    es_admin()
    or exists (
      select 1 from estudiantes e
      where e.id = justificaciones.estudiante_id
        and e.turno = turno_actual()
        and tiene_acceso(e.grado, e.seccion)
    )
  );

-- Insertar: admin, o auxiliar en su jurisdicción (y queda como autor).
drop policy if exists "justificaciones_insert_jurisdiccion" on justificaciones;
create policy "justificaciones_insert_jurisdiccion"
  on justificaciones for insert
  with check (
    es_admin()
    or (
      registrado_por = auth.uid()
      and exists (
        select 1 from estudiantes e
        where e.id = justificaciones.estudiante_id
          and e.turno = turno_actual()
          and tiene_acceso(e.grado, e.seccion)
      )
    )
  );

-- Actualizar: admin, o auxiliar en su jurisdicción.
drop policy if exists "justificaciones_update_jurisdiccion" on justificaciones;
create policy "justificaciones_update_jurisdiccion"
  on justificaciones for update
  using (
    es_admin()
    or exists (
      select 1 from estudiantes e
      where e.id = justificaciones.estudiante_id
        and e.turno = turno_actual()
        and tiene_acceso(e.grado, e.seccion)
    )
  )
  with check (
    es_admin()
    or exists (
      select 1 from estudiantes e
      where e.id = justificaciones.estudiante_id
        and e.turno = turno_actual()
        and tiene_acceso(e.grado, e.seccion)
    )
  );

-- Eliminar: admin, o auxiliar en su jurisdicción.
drop policy if exists "justificaciones_delete_jurisdiccion" on justificaciones;
create policy "justificaciones_delete_jurisdiccion"
  on justificaciones for delete
  using (
    es_admin()
    or exists (
      select 1 from estudiantes e
      where e.id = justificaciones.estudiante_id
        and e.turno = turno_actual()
        and tiene_acceso(e.grado, e.seccion)
    )
  );
