-- ============================================================================
-- Abrir los reportes a los AUXILIARES, limitados a su jurisdicción.
--
-- Antes, obtener_reporte_asistencia bloqueaba a todo el que no fuera ADMIN
-- (ver sql/restringir_reportes_a_admin.sql). Ahora se quita ese candado: la
-- función es SECURITY INVOKER, así que respeta las políticas RLS de
-- `estudiantes` y `asistencias`. Un auxiliar SOLO verá los alumnos de su
-- turno y de las secciones que tiene asignadas (turno = turno_actual() y
-- tiene_acceso(grado, seccion)); un admin sigue viéndolo todo.
--
-- Ejecutar en el SQL Editor de Supabase.
-- ============================================================================

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
  -- Sin candado de admin: RLS restringe cada usuario a su jurisdicción.
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
    and (p_turno is null or e.turno = p_turno)
    and (p_grado is null or e.grado = p_grado)
    and (p_seccion is null or e.seccion = p_seccion)
  group by e.id, e.dni, e.nombres, e.apellidos, e.grado, e.seccion, e.turno
  order by total_tarde desc, e.apellidos asc;
end;
$$;
