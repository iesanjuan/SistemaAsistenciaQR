-- ============================================================================
-- Días no lectivos (feriados, vacaciones, días sin clases) — POR RANGOS.
-- El administrador registra un rango de fechas (fecha_inicio → fecha_fin) con
-- un motivo. Un día suelto es simplemente un rango de un día
-- (fecha_inicio = fecha_fin). El reporte de asistencia EXCLUYE cualquier día
-- que caiga dentro de algún rango: en esas fechas NO se cuenta falta a los
-- alumnos ni se suman al total de días posibles.
--
-- Este script:
--   1) Crea la tabla si no existe (estructura de rangos).
--   2) Si ya existe la versión antigua (columna "fecha" por día), la migra a
--      rangos SIN perder los registros que ya tenías.
--   3) Reescribe la función de reportes para excluir los rangos.
--
-- Ejecutar completo en el SQL Editor de Supabase. Seguro de re-ejecutar.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tabla (estructura de rangos). Para instalaciones nuevas.
-- ----------------------------------------------------------------------------

create table if not exists dias_no_lectivos (
  id            uuid primary key default gen_random_uuid(),
  tipo          text not null default 'OTRO',   -- FERIADO | VACACIONES | OTRO
  fecha_inicio  date not null,
  fecha_fin     date not null,
  motivo        text not null,
  created_at    timestamptz not null default now(),
  constraint dias_no_lectivos_rango_valido check (fecha_fin >= fecha_inicio),
  constraint dias_no_lectivos_tipo_valido  check (tipo in ('FERIADO', 'VACACIONES', 'OTRO'))
);

comment on table dias_no_lectivos is
  'Rangos de fechas sin clases (feriados/vacaciones). El reporte de asistencia '
  'los excluye para no contar falta a los alumnos esos días.';

-- ----------------------------------------------------------------------------
-- 2. Migración de la versión antigua (una fila por día, PK sobre "fecha")
--    a la nueva estructura de rangos. Idempotente: si ya está migrada, no hace
--    nada.
-- ----------------------------------------------------------------------------

-- 2.1 Agrega las columnas nuevas si faltan (tabla antigua).
alter table dias_no_lectivos add column if not exists id           uuid default gen_random_uuid();
alter table dias_no_lectivos add column if not exists fecha_inicio date;
alter table dias_no_lectivos add column if not exists fecha_fin    date;
alter table dias_no_lectivos add column if not exists tipo         text not null default 'OTRO';

-- 2.2 Copia cada día antiguo a un rango de un solo día.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'dias_no_lectivos' and column_name = 'fecha'
  ) then
    update dias_no_lectivos
      set fecha_inicio = coalesce(fecha_inicio, fecha),
          fecha_fin    = coalesce(fecha_fin, fecha);
  end if;
end $$;

-- 2.3 Asegura id en filas viejas.
update dias_no_lectivos set id = gen_random_uuid() where id is null;

-- 2.4 Cambia la PK de "fecha" a "id" y elimina la columna antigua "fecha".
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'dias_no_lectivos' and column_name = 'fecha'
  ) then
    alter table dias_no_lectivos drop constraint if exists dias_no_lectivos_pkey;
    alter table dias_no_lectivos drop column fecha;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'dias_no_lectivos_pkey') then
    alter table dias_no_lectivos add primary key (id);
  end if;
end $$;

-- 2.5 Restricciones finales (not null + rango válido). Idempotente.
alter table dias_no_lectivos alter column fecha_inicio set not null;
alter table dias_no_lectivos alter column fecha_fin    set not null;
alter table dias_no_lectivos drop constraint if exists dias_no_lectivos_rango_valido;
alter table dias_no_lectivos add  constraint dias_no_lectivos_rango_valido check (fecha_fin >= fecha_inicio);
alter table dias_no_lectivos drop constraint if exists dias_no_lectivos_tipo_valido;
alter table dias_no_lectivos add  constraint dias_no_lectivos_tipo_valido check (tipo in ('FERIADO', 'VACACIONES', 'OTRO'));

-- ----------------------------------------------------------------------------
-- 3. Row Level Security
--    Cualquier usuario autenticado puede leerlas; solo el admin las gestiona.
-- ----------------------------------------------------------------------------

alter table dias_no_lectivos enable row level security;

drop policy if exists "dias_no_lectivos_select_autenticado" on dias_no_lectivos;
create policy "dias_no_lectivos_select_autenticado"
  on dias_no_lectivos for select
  using (auth.uid() is not null);

drop policy if exists "dias_no_lectivos_admin_gestiona" on dias_no_lectivos;
create policy "dias_no_lectivos_admin_gestiona"
  on dias_no_lectivos for all
  using (es_admin())
  with check (es_admin());

-- ----------------------------------------------------------------------------
-- 4. Reescribe obtener_reporte_asistencia para EXCLUIR los rangos no lectivos.
--    Mismo código que en schema.sql, con un único filtro nuevo en el WHERE.
-- ----------------------------------------------------------------------------

create or replace function public.obtener_reporte_asistencia(
  p_fecha_inicio date,
  p_fecha_fin    date,
  p_turno        turno_enum default null,
  p_grado        text default null,
  p_seccion      text default null
)
returns table (
  estudiante_id  uuid,
  dni            text,
  nombres        text,
  apellidos      text,
  grado          text,
  seccion        text,
  turno          turno_enum,
  total_asistio  bigint,
  total_tarde    bigint,
  total_falta    bigint,
  total_dias     bigint
)
language plpgsql
security invoker
as $$
begin
  if not es_admin() then
    raise exception 'Acceso denegado: los reportes son exclusivos de administradores';
  end if;

  return query
  select
    e.id,
    e.dni,
    e.nombres,
    e.apellidos,
    e.grado,
    e.seccion,
    e.turno,
    count(*) filter (where a.estado = 'ASISTIO')                     as total_asistio,
    count(*) filter (where a.estado = 'TARDE')                       as total_tarde,
    count(*) filter (where a.estado is null)                         as total_falta,
    count(*)                                                         as total_dias
  from estudiantes e
  cross join lateral generate_series(p_fecha_inicio, p_fecha_fin, interval '1 day') as d(fecha)
  left join asistencias a
    on a.estudiante_id = e.id and a.fecha = d.fecha::date
  where e.activo = true
    and extract(dow from d.fecha) not in (0, 6) -- excluye sábado y domingo
    and not exists (                            -- excluye días dentro de un rango no lectivo
      select 1 from dias_no_lectivos dnl
      where d.fecha::date between dnl.fecha_inicio and dnl.fecha_fin
    )
    and (p_turno is null or e.turno = p_turno)
    and (p_grado is null or e.grado = p_grado)
    and (p_seccion is null or e.seccion = p_seccion)
  group by e.id, e.dni, e.nombres, e.apellidos, e.grado, e.seccion, e.turno
  order by total_tarde desc, e.apellidos asc;
end;
$$;
