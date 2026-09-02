import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import { useUI } from '../lib/UIContext';
import { claveGradoSeccion, fechaLocalISO, formatearHoraDesdeTexto, gradoNumero, HORARIOS } from '../utils/turnos';
import Icon from './Icon';
import Cargador from './Cargador';

function hoyISO() {
  return fechaLocalISO();
}
function haceNDiasISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return fechaLocalISO(d);
}
function iniciales(nombres, apellidos) {
  return `${(apellidos || '?')[0] || ''}${(nombres || '?')[0] || ''}`.toUpperCase();
}

// Fecha ISO -> "Lunes 01/09/2026" (con el día de la semana para identificarlo).
function fechaConDia(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  const dia = d.toLocaleDateString('es-PE', { weekday: 'long' });
  const [y, m, dd] = iso.split('-');
  return `${dia.charAt(0).toUpperCase()}${dia.slice(1)} ${dd}/${m}/${y}`;
}

// Número con animación de conteo (count-up) desde el valor anterior hasta el
// nuevo, con easing suave. Anima al cargar y cada vez que el número cambia.
function Contador({ valor, className, duracion = 700 }) {
  const [mostrado, setMostrado] = useState(0);
  const desdeRef = useRef(0);
  const rafRef = useRef(0);

  useEffect(() => {
    const desde = desdeRef.current;
    const objetivo = Number(valor) || 0;
    const inicio = performance.now();
    cancelAnimationFrame(rafRef.current);

    const tick = (ahora) => {
      const t = Math.min(1, (ahora - inicio) / duracion);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setMostrado(Math.round(desde + (objetivo - desde) * eased));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else desdeRef.current = objetivo;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [valor, duracion]);

  return <span className={className}>{mostrado.toLocaleString('es-PE')}</span>;
}

export default function ReportesAuxiliar() {
  const { perfil, esAdmin } = useAuth();
  const { toast } = useUI();

  // Por defecto se mide SOLO el día de hoy (ambas fechas = hoy). Para ver un
  // rango, el usuario cambia la fecha de inicio.
  const [fechaInicio, setFechaInicio] = useState(hoyISO());
  const [fechaFin, setFechaFin] = useState(hoyISO());
  const [vista, setVista] = useState('CONSOLIDADO'); // CONSOLIDADO | MANANA | TARDE
  const [auxiliarSel, setAuxiliarSel] = useState(''); // '' = todos los auxiliares

  const [filas, setFilas] = useState([]);
  const [auxiliares, setAuxiliares] = useState([]);
  const [tardanzasRaw, setTardanzasRaw] = useState([]);
  const [marcaciones, setMarcaciones] = useState([]); // marcaciones reales (con hora)
  const [cargando, setCargando] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  // Modal de detalle: null | 'asistieron' | 'tardanzas' | 'faltones'. Muestra
  // la lista completa de alumnos al tocar la card correspondiente.
  const [detalle, setDetalle] = useState(null);
  // Filtro de grado+sección DENTRO del modal ('' = todas).
  const [detalleFiltro, setDetalleFiltro] = useState('');
  // Justificaciones (anotaciones de tardanza/falta) del rango.
  const [justificaciones, setJustificaciones] = useState([]);
  // Diálogo de justificación: null | { estudiante_id, nombre, fecha, tipo }.
  const [justificando, setJustificando] = useState(null);
  const [motivoInput, setMotivoInput] = useState('');
  const [guardandoJust, setGuardandoJust] = useState(false);

  useEffect(() => {
    if (perfil) {
      consultar();
      cargarAuxiliares();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perfil]);

  // Al abrir/cambiar el modal, se limpia el filtro de grado/sección.
  useEffect(() => {
    setDetalleFiltro('');
  }, [detalle]);

  // Auto-refresco silencioso cada 30 s: trae marcaciones nuevas sin que el
  // usuario tenga que actualizar (útil sobre todo viendo "hoy").
  useEffect(() => {
    if (!perfil) return;
    const id = setInterval(() => consultar(fechaInicio, fechaFin, true), 30000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perfil, fechaInicio, fechaFin]);

  async function cargarAuxiliares() {
    const { data } = await supabase
      .from('perfiles_auxiliares')
      .select('id, nombres, turno, auxiliar_secciones(grado, seccion)')
      .eq('rol', 'AUXILIAR')
      .order('nombres');
    setAuxiliares(data || []);
  }

  // `silencioso` = refresco en segundo plano (auto): no muestra el loader ni
  // borra los datos actuales si algo falla, para no interrumpir la vista.
  async function consultar(inicio = fechaInicio, fin = fechaFin, silencioso = false) {
    if (!silencioso) setCargando(true);
    setErrorMsg('');

    const [reporte, porDia, marc] = await Promise.all([
      // Se trae TODO el rango (sin filtrar turno) y el filtrado por turno /
      // auxiliar se hace del lado del cliente, para que cambiar de filtro
      // sea instantáneo sin volver a consultar la base.
      supabase.rpc('obtener_reporte_asistencia', {
        p_fecha_inicio: inicio,
        p_fecha_fin: fin,
        p_turno: null,
      }),
      cargarTardanzasRaw(inicio, fin),
      cargarMarcaciones(inicio, fin),
    ]);

    if (!silencioso) setCargando(false);
    if (reporte.error) {
      if (!silencioso) {
        setErrorMsg(reporte.error.message);
        toast('No se pudo cargar el reporte', 'error');
        setFilas([]);
      }
      return;
    }
    setFilas(reporte.data || []);
    setTardanzasRaw(porDia);
    setMarcaciones(marc);
    setJustificaciones(await cargarJustificaciones(inicio, fin));
  }

  async function cargarJustificaciones(inicio = fechaInicio, fin = fechaFin) {
    const { data } = await supabase
      .from('justificaciones')
      .select('estudiante_id, fecha, tipo, motivo')
      .gte('fecha', inicio)
      .lte('fecha', fin);
    return data || [];
  }

  // Guarda (o actualiza) la justificación del alumno para la fecha dada.
  async function guardarJustificacion() {
    if (!justificando || !motivoInput.trim()) return;
    setGuardandoJust(true);
    const { error } = await supabase.from('justificaciones').upsert(
      {
        estudiante_id: justificando.estudiante_id,
        fecha: justificando.fecha,
        tipo: justificando.tipo,
        motivo: motivoInput.trim(),
        registrado_por: perfil?.id,
      },
      { onConflict: 'estudiante_id,fecha' }
    );
    setGuardandoJust(false);
    if (error) {
      toast('No se pudo guardar la justificación', 'error');
      return;
    }
    toast('Justificación guardada', 'exito');
    setJustificando(null);
    setJustificaciones(await cargarJustificaciones(fechaInicio, fechaFin));
  }

  function abrirJustificar(f, tipo, fecha, motivoActual) {
    setJustificando({ estudiante_id: f.estudiante_id, nombre: `${f.apellidos}, ${f.nombres}`, tipo, fecha });
    setMotivoInput(motivoActual || '');
  }

  // Quita la justificación: el alumno vuelve a contar como falta/tardanza.
  async function eliminarJustificacion() {
    if (!justificando) return;
    setGuardandoJust(true);
    const { error } = await supabase
      .from('justificaciones')
      .delete()
      .eq('estudiante_id', justificando.estudiante_id)
      .eq('fecha', justificando.fecha);
    setGuardandoJust(false);
    if (error) {
      toast('No se pudo quitar la justificación', 'error');
      return;
    }
    toast('Justificación quitada', 'info');
    setJustificando(null);
    setJustificaciones(await cargarJustificaciones(fechaInicio, fechaFin));
  }

  // Marcaciones reales del rango (con hora), para mostrar a qué hora llegó
  // cada alumno en el detalle.
  async function cargarMarcaciones(inicio = fechaInicio, fin = fechaFin) {
    const { data } = await supabase
      .from('asistencias')
      .select('estudiante_id, fecha, hora_ingreso, estado')
      .gte('fecha', inicio)
      .lte('fecha', fin)
      .order('hora_ingreso', { ascending: true });
    return data || [];
  }

  async function cargarTardanzasRaw(inicio = fechaInicio, fin = fechaFin) {
    const { data } = await supabase
      .from('asistencias')
      .select('fecha, estudiantes!inner(turno, grado, seccion)')
      .eq('estado', 'TARDE')
      .gte('fecha', inicio)
      .lte('fecha', fin);
    return data || [];
  }

  // Conjunto de secciones "grado|seccion" del auxiliar seleccionado (o null = todas).
  const seccionesAux = useMemo(() => {
    if (!auxiliarSel) return null;
    const aux = auxiliares.find((a) => a.id === auxiliarSel);
    if (!aux) return null;
    return new Set((aux.auxiliar_secciones || []).map((s) => claveGradoSeccion(s.grado, s.seccion)));
  }, [auxiliarSel, auxiliares]);

  // El filtro de turno (vista) solo aplica cuando NO hay un auxiliar
  // seleccionado; sus secciones ya definen el turno por sí solas.
  const filtroTurno = seccionesAux ? 'CONSOLIDADO' : vista;

  // Filas visibles = aplica el filtro de turno y el de auxiliar.
  const filasVisibles = useMemo(() => {
    return filas.filter((f) => {
      if (filtroTurno !== 'CONSOLIDADO' && f.turno !== filtroTurno) return false;
      if (seccionesAux && !seccionesAux.has(claveGradoSeccion(f.grado, f.seccion))) return false;
      return true;
    });
  }, [filas, filtroTurno, seccionesAux]);

  const tardanzasPorDia = useMemo(() => {
    const conteo = {};
    tardanzasRaw.forEach((r) => {
      if (filtroTurno !== 'CONSOLIDADO' && r.estudiantes.turno !== filtroTurno) return;
      if (seccionesAux && !seccionesAux.has(claveGradoSeccion(r.estudiantes.grado, r.estudiantes.seccion))) return;
      conteo[r.fecha] = (conteo[r.fecha] || 0) + 1;
    });
    return conteo;
  }, [tardanzasRaw, filtroTurno, seccionesAux]);

  const ranking = useMemo(
    () => [...filasVisibles].sort((a, b) => b.total_tarde - a.total_tarde).slice(0, 10),
    [filasVisibles]
  );

  const consolidado = useMemo(() => {
    return filasVisibles.reduce(
      (acc, f) => {
        acc.asistio += Number(f.total_asistio) || 0;
        acc.tarde += Number(f.total_tarde) || 0;
        acc.falta += Number(f.total_falta) || 0;
        return acc;
      },
      { asistio: 0, tarde: 0, falta: 0 }
    );
  }, [filasVisibles]);

  const porcentajeAsistencia = useMemo(() => {
    const total = consolidado.asistio + consolidado.tarde + consolidado.falta;
    return total === 0 ? 0 : Math.round(((consolidado.asistio + consolidado.tarde) / total) * 100);
  }, [consolidado]);

  // Desglose legible de la tarjeta de asistencia:
  //  - presentes  = veces que un alumno marcó (asistió + tarde cuentan como presente)
  //  - posibles   = oportunidades totales de marcar (alumnos × días de clase del rango)
  //  - alumnos/días son los dos factores que explican de dónde sale "posibles".
  const resumenAsistencia = useMemo(() => {
    const presentes = consolidado.asistio + consolidado.tarde;
    const posibles = presentes + consolidado.falta;
    const alumnos = filasVisibles.length;
    const dias = alumnos > 0 ? Math.round(posibles / alumnos) : 0;
    return { presentes, posibles, alumnos, dias };
  }, [consolidado, filasVisibles]);

  // Listas por categoría. En un solo día son mutuamente excluyentes
  // (asistieron + tardanzas + faltones = todos los alumnos):
  //  - asistieron = marcó PUNTUAL al menos una vez.
  //  - tardanzas  = marcó TARDE al menos una vez.
  //  - faltones   = no marcó nunca (posibles ausentes).
  const ordenar = (lista) =>
    [...lista].sort((a, b) => `${a.apellidos} ${a.nombres}`.localeCompare(`${b.apellidos} ${b.nombres}`, 'es'));

  const asistieronLista = useMemo(
    () => ordenar(filasVisibles.filter((f) => Number(f.total_asistio) > 0)),
    [filasVisibles]
  );
  const tardanzasLista = useMemo(
    () => ordenar(filasVisibles.filter((f) => Number(f.total_tarde) > 0)),
    [filasVisibles]
  );
  // Justificaciones indexadas por "estudiante_id|fecha".
  const justMap = useMemo(() => {
    const m = new Map();
    justificaciones.forEach((j) => m.set(`${j.estudiante_id}|${j.fecha}`, j));
    return m;
  }, [justificaciones]);

  // Justificaciones de FALTA por alumno (ordenadas por fecha). Cada una
  // descuenta una falta del conteo.
  const justFaltasPorEstudiante = useMemo(() => {
    const m = {};
    justificaciones.forEach((j) => {
      if (j.tipo !== 'FALTA') return;
      (m[j.estudiante_id] ||= []).push(j);
    });
    Object.values(m).forEach((arr) => arr.sort((a, b) => a.fecha.localeCompare(b.fecha)));
    return m;
  }, [justificaciones]);

  // Faltas efectivas = faltas del rango menos las justificadas.
  const faltasEfectivas = (f) =>
    Math.max(0, Number(f.total_falta || 0) - (justFaltasPorEstudiante[f.estudiante_id]?.length || 0));

  // Posibles faltas = alumnos que aún tienen faltas efectivas (>0).
  const faltonesLista = useMemo(
    () => ordenar(filasVisibles.filter((f) => faltasEfectivas(f) > 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filasVisibles, justFaltasPorEstudiante]
  );

  // Justificados = alumnos con al menos una falta justificada en el rango.
  const justificadosLista = useMemo(
    () => ordenar(filasVisibles.filter((f) => (justFaltasPorEstudiante[f.estudiante_id]?.length || 0) > 0)),
    [filasVisibles, justFaltasPorEstudiante]
  );

  // Hora de llegada por alumno y por estado (para el detalle). En un solo día
  // es único; en un rango con varias marcaciones, queda la última de cada tipo.
  const horaPorEstudiante = useMemo(() => {
    const m = {};
    marcaciones.forEach((r) => {
      if (!m[r.estudiante_id]) m[r.estudiante_id] = {};
      m[r.estudiante_id][r.estado] = { hora: r.hora_ingreso, fecha: r.fecha };
    });
    return m;
  }, [marcaciones]);

  const barrasDiarias = useMemo(() => {
    const fechas = Object.keys(tardanzasPorDia).sort().slice(-5);
    const max = Math.max(1, ...fechas.map((f) => tardanzasPorDia[f]));
    return fechas.map((f) => ({
      fecha: f,
      valor: tardanzasPorDia[f],
      alturaPct: Math.round((tardanzasPorDia[f] / max) * 100),
      diaLabel: new Date(`${f}T00:00:00`).toLocaleDateString('es-PE', { weekday: 'short' }),
    }));
  }, [tardanzasPorDia]);

  const distribucion = useMemo(() => {
    const manana = filasVisibles.filter((f) => f.turno === 'MANANA').reduce((s, f) => s + Number(f.total_tarde), 0);
    const tarde = filasVisibles.filter((f) => f.turno === 'TARDE').reduce((s, f) => s + Number(f.total_tarde), 0);
    const total = manana + tarde;
    return {
      total,
      pctManana: total === 0 ? 0 : Math.round((manana / total) * 100),
      pctTarde: total === 0 ? 0 : Math.round((tarde / total) * 100),
    };
  }, [filasVisibles]);

  const nombreAuxSel = auxiliares.find((a) => a.id === auxiliarSel)?.nombres || '';

  // Texto distintivo de justificación para el Excel (solo aplica a un día).
  // Ej.: "Falta justificada: cita médica". Vacío si no tiene justificación.
  function textoJustificacion(f) {
    const arr = justFaltasPorEstudiante[f.estudiante_id] || [];
    if (!arr.length) return '';
    if (fechaInicio === fechaFin) return `Falta justificada: ${arr[0].motivo}`;
    return arr.map((j) => `${j.fecha.slice(8, 10)}/${j.fecha.slice(5, 7)}: ${j.motivo}`).join('; ');
  }

  function exportarExcel(soloTurno) {
    let base = filasVisibles;
    if (soloTurno) base = base.filter((f) => f.turno === soloTurno);
    if (base.length === 0) {
      toast('No hay datos para exportar con este filtro', 'error');
      return;
    }
    const filasExport = base.map((f) => ({
      DNI: f.dni,
      Apellidos: f.apellidos,
      Nombres: f.nombres,
      Grado: f.grado,
      Sección: f.seccion,
      Turno: f.turno,
      Asistencias: f.total_asistio,
      Tardanzas: f.total_tarde,
      Faltas: faltasEfectivas(f),
      'Faltas justificadas': justFaltasPorEstudiante[f.estudiante_id]?.length || 0,
      'Días evaluados': f.total_dias,
      Justificación: textoJustificacion(f),
    }));
    const hoja = XLSX.utils.json_to_sheet(filasExport);
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, 'Reporte');
    const sufijoTurno = soloTurno ? `_${soloTurno}` : '';
    const sufijoAux = nombreAuxSel ? `_${nombreAuxSel.split(' ')[0]}` : '';
    XLSX.writeFile(libro, `reporte_asistencia${sufijoAux}${sufijoTurno}_${fechaInicio}_a_${fechaFin}.xlsx`);
    toast(`Reporte exportado (${base.length} alumno(s))`, 'exito');
  }

  // Exporta a Excel una lista puntual (asistieron / faltones) desde el modal.
  function exportarLista(lista, tipo) {
    if (!lista.length) return;
    const filasExport = lista.map((f) => {
      const marca = horaPorEstudiante[f.estudiante_id];
      const hora = tipo === 'tardanzas' ? marca?.TARDE?.hora : tipo === 'asistieron' ? marca?.ASISTIO?.hora : '';
      return {
        DNI: f.dni,
        Apellidos: f.apellidos,
        Nombres: f.nombres,
        Grado: f.grado,
        Sección: f.seccion,
        Turno: f.turno,
        'Hora de llegada': hora ? formatearHoraDesdeTexto(hora) : '',
        Asistencias: f.total_asistio,
        Tardanzas: f.total_tarde,
        Faltas: faltasEfectivas(f),
        'Faltas justificadas': justFaltasPorEstudiante[f.estudiante_id]?.length || 0,
        Justificación: textoJustificacion(f),
      };
    });
    const hoja = XLSX.utils.json_to_sheet(filasExport);
    const libro = XLSX.utils.book_new();
    const nombreHoja = { faltones: 'Faltones', tardanzas: 'Tardanzas', asistieron: 'Asistieron' }[tipo] || 'Reporte';
    XLSX.utils.book_append_sheet(libro, hoja, nombreHoja);
    XLSX.writeFile(libro, `${tipo}_${fechaInicio}_a_${fechaFin}.xlsx`);
    toast(`Lista exportada (${lista.length} alumno(s))`, 'exito');
  }

  const dasharrayManana = `${distribucion.pctManana}, 100`;
  const dasharrayTarde = `${distribucion.pctTarde}, 100`;

  return (
    <div className="p-margin-mobile md:p-margin-desktop pb-24 md:pb-margin-desktop w-full max-w-max-width mx-auto">
      {/* Header + Filters */}
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 mb-8">
        <div>
          <h2 className="font-headline-lg text-headline-lg-mobile md:text-headline-lg text-on-surface mb-1">
            Panel de Reportes
          </h2>
          <p className="font-body-md text-body-md text-on-surface-variant">
            {esAdmin
              ? auxiliarSel
                ? `Reporte del auxiliar: ${nombreAuxSel} — solo sus secciones a cargo.`
                : 'Análisis consolidado de asistencia y tardanzas por turno.'
              : `Restringido a tu jurisdicción: ${HORARIOS[perfil?.turno]?.label || ''} · ${
                  perfil?.secciones?.length
                    ? perfil.secciones.map((s) => `${s.grado} "${s.seccion}"`).join(', ')
                    : 'sin secciones asignadas'
                }`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
          <div className="flex gap-3 w-full sm:w-auto">
            <input
              type="date"
              value={fechaInicio}
              onChange={(e) => {
                setFechaInicio(e.target.value);
                if (e.target.value) consultar(e.target.value, fechaFin);
              }}
              className="flex-1 sm:flex-none bg-surface border border-outline-variant text-on-surface font-body-md text-body-md rounded-lg px-3 py-2 min-w-0"
            />
            <input
              type="date"
              value={fechaFin}
              onChange={(e) => {
                setFechaFin(e.target.value);
                if (e.target.value) consultar(fechaInicio, e.target.value);
              }}
              className="flex-1 sm:flex-none bg-surface border border-outline-variant text-on-surface font-body-md text-body-md rounded-lg px-3 py-2 min-w-0"
            />
          </div>
          {esAdmin && (
            <div className="relative w-full sm:w-auto">
              <select
                value={auxiliarSel}
                onChange={(e) => setAuxiliarSel(e.target.value)}
                className="w-full appearance-none bg-surface border border-outline-variant text-on-surface font-body-md text-body-md rounded-lg pl-4 pr-10 py-2 focus:outline-none focus:ring-2 focus:ring-secondary focus:border-transparent"
              >
                <option value="">Todos los auxiliares</option>
                {auxiliares.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nombres}
                    {a.auxiliar_secciones?.length
                      ? ` (${a.auxiliar_secciones.map((s) => `${s.grado}${s.seccion}`).join(', ')})`
                      : ''}
                  </option>
                ))}
              </select>
              <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-outline">
                person_search
              </span>
            </div>
          )}
          {esAdmin && !auxiliarSel && (
            <div className="flex w-full sm:w-auto overflow-x-auto bg-surface-container-low rounded-lg p-1 border border-outline-variant">
              {[
                { key: 'CONSOLIDADO', label: 'Consolidado' },
                { key: 'MANANA', label: 'Mañana (A-E)' },
                { key: 'TARDE', label: 'Tarde (F-H)' },
              ].map((op) => (
                <button
                  key={op.key}
                  onClick={() => setVista(op.key)}
                  className={`flex-1 sm:flex-none whitespace-nowrap px-4 py-2 rounded-md font-label-md text-label-md transition-colors ${
                    vista === op.key
                      ? 'bg-white shadow-sm text-primary border border-outline-variant/30'
                      : 'text-on-surface-variant hover:bg-surface-variant'
                  }`}
                >
                  {op.label}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => consultar()}
            title="Volver a traer los datos del rango (marcaciones nuevas)"
            className="w-full sm:w-auto flex items-center justify-center gap-2 bg-primary text-on-primary rounded-lg px-4 py-2 font-label-md text-label-md hover:bg-primary-container hover:text-on-primary-container transition-colors"
          >
            <Icon name="refresh" className="text-[18px]" />
            Actualizar
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="bg-red-50 border border-red-300 text-error rounded-lg p-3 mb-6 text-sm">{errorMsg}</div>
      )}

      {/* KPI Bento Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 mb-8">
        {/* Asistieron — tocable: muestra la lista de quienes marcaron puntual. */}
        <button
          type="button"
          onClick={() => asistieronLista.length && setDetalle('asistieron')}
          className="text-left bg-surface rounded-xl p-6 border border-outline-variant elevation-1 elevation-interactive transition-all border-t-4 border-t-primary hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <div className="flex justify-between items-start mb-4">
            <h3 className="font-title-md text-title-md text-on-surface">Asistió temprano</h3>
            <div className="p-2 bg-primary-fixed rounded-lg text-on-primary-fixed">
              <Icon name="how_to_reg" />
            </div>
          </div>
          <div className="flex items-end gap-2 mb-2">
            <Contador valor={asistieronLista.length} className="font-display-lg text-display-lg text-primary" />
          </div>
          <p className="font-label-md text-label-md text-on-surface-variant">
            {asistieronLista.length === 1 ? 'alumno asistió temprano' : 'alumnos asistieron temprano'}
          </p>
          <p className="font-label-md text-label-md text-on-surface-variant/70 mt-0.5">
            de {filasVisibles.length.toLocaleString('es-PE')} alumnos en total
          </p>
          <p className="mt-4 font-label-md text-label-md text-primary flex items-center gap-1">
            Ver lista <Icon name="arrow_forward" className="text-[16px]" />
          </p>
        </button>

        {/* Tardanzas — tocable: muestra la lista de alumnos que llegaron tarde. */}
        <button
          type="button"
          onClick={() => tardanzasLista.length && setDetalle('tardanzas')}
          className="text-left bg-surface rounded-xl p-6 border border-outline-variant elevation-1 elevation-interactive transition-all border-t-4 border-t-error hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <div className="flex justify-between items-start mb-4">
            <h3 className="font-title-md text-title-md text-on-surface">Asistió tarde</h3>
            <div className="p-2 bg-error-container rounded-lg text-on-error-container">
              <Icon name="schedule" />
            </div>
          </div>
          <div className="flex items-end gap-2 mb-2">
            <Contador valor={tardanzasLista.length} className="font-display-lg text-display-lg text-error" />
          </div>
          <p className="font-label-md text-label-md text-on-surface-variant">
            {tardanzasLista.length === 1 ? 'alumno asistió tarde' : 'alumnos asistieron tarde'}
          </p>
          <p className="font-label-md text-label-md text-on-surface-variant/70 mt-0.5">
            {consolidado.tarde.toLocaleString('es-PE')} {consolidado.tarde === 1 ? 'tardanza' : 'tardanzas'} en total
          </p>
          {barrasDiarias.length > 0 && (
            <div className="mt-4 flex gap-1 h-8 items-end">
              {barrasDiarias.map((b) => (
                <div
                  key={b.fecha}
                  className="w-1/5 bg-error rounded-t transition-colors"
                  style={{ height: `${Math.max(8, b.alturaPct)}%` }}
                  title={`${b.diaLabel}: ${b.valor}`}
                />
              ))}
            </div>
          )}
          <p className="mt-4 font-label-md text-label-md text-primary flex items-center gap-1">
            Ver lista <Icon name="arrow_forward" className="text-[16px]" />
          </p>
        </button>

        {/* Posibles Faltones — tocable: alumnos que NO marcaron en el rango. */}
        <button
          type="button"
          onClick={() => faltonesLista.length && setDetalle('faltones')}
          className="text-left bg-surface rounded-xl p-6 border border-outline-variant elevation-1 elevation-interactive transition-all border-t-4 border-t-amber-500 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <div className="flex justify-between items-start mb-4">
            <h3 className="font-title-md text-title-md text-on-surface">Posibles faltas</h3>
            <div className="p-2 bg-amber-100 rounded-lg text-amber-700">
              <Icon name="person_alert" />
            </div>
          </div>
          <div className="flex items-end gap-2 mb-2">
            <Contador valor={faltonesLista.length} className="font-display-lg text-display-lg text-amber-600" />
          </div>
          <p className="font-label-md text-label-md text-on-surface-variant">
            {faltonesLista.length === 1 ? 'alumno no marcó' : 'alumnos no marcaron'} en el período
          </p>
          <p className="font-label-md text-label-md text-on-surface-variant/70 mt-0.5">
            de {filasVisibles.length.toLocaleString('es-PE')} alumnos en total
          </p>
          <p className="mt-4 font-label-md text-label-md text-primary flex items-center gap-1">
            Ver lista <Icon name="arrow_forward" className="text-[16px]" />
          </p>
        </button>

        {/* Justificados — alumnos con falta(s) justificada(s). */}
        <button
          type="button"
          onClick={() => justificadosLista.length && setDetalle('justificados')}
          className="text-left bg-surface rounded-xl p-6 border border-outline-variant elevation-1 elevation-interactive transition-all border-t-4 border-t-green-500 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <div className="flex justify-between items-start mb-4">
            <h3 className="font-title-md text-title-md text-on-surface">Justificados</h3>
            <div className="p-2 bg-green-100 rounded-lg text-green-700">
              <Icon name="verified" />
            </div>
          </div>
          <div className="flex items-end gap-2 mb-2">
            <Contador valor={justificadosLista.length} className="font-display-lg text-display-lg text-green-600" />
          </div>
          <p className="font-label-md text-label-md text-on-surface-variant">
            {justificadosLista.length === 1 ? 'alumno con falta justificada' : 'alumnos con falta justificada'}
          </p>
          <p className="font-label-md text-label-md text-on-surface-variant/70 mt-0.5">
            cada justificación descuenta una falta
          </p>
          <p className="mt-4 font-label-md text-label-md text-primary flex items-center gap-1">
            Ver lista <Icon name="arrow_forward" className="text-[16px]" />
          </p>
        </button>

        {/* Exportar */}
        <div className="bg-surface-container-lowest rounded-xl p-6 border border-outline-variant elevation-1 flex flex-col justify-between relative overflow-hidden">
          <div className="absolute -right-6 -top-6 text-primary-fixed-dim opacity-20">
            <Icon name="file_download" style={{ fontSize: 120 }} />
          </div>
          <div className="relative z-10">
            <h3 className="font-title-md text-title-md text-on-surface mb-2">Exportar Datos</h3>
            <p className="font-body-md text-body-md text-on-surface-variant mb-6">
              Genera reportes consolidados o por turno en formato Excel.
            </p>
          </div>
          <div className="flex flex-col gap-2 relative z-10">
            <button
              onClick={() => exportarExcel(null)}
              disabled={filas.length === 0}
              className="flex items-center justify-between w-full px-4 py-2 bg-primary text-on-primary rounded-lg font-label-md text-label-md hover:bg-primary-container hover:text-on-primary-container transition-colors shadow-sm disabled:opacity-50"
            >
              <span className="flex items-center gap-2">
                <Icon name="table_view" className="text-[18px]" /> Consolidado
              </span>
              <Icon name="download" className="text-[18px]" />
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => exportarExcel('MANANA')}
                disabled={filas.length === 0}
                className="flex items-center justify-center gap-1 px-3 py-2 border border-outline-variant text-primary rounded-lg font-label-md text-label-md hover:bg-surface-container-low transition-colors bg-surface disabled:opacity-50"
              >
                Turno Mañana
              </button>
              <button
                onClick={() => exportarExcel('TARDE')}
                disabled={filas.length === 0}
                className="flex items-center justify-center gap-1 px-3 py-2 border border-outline-variant text-primary rounded-lg font-label-md text-label-md hover:bg-surface-container-low transition-colors bg-surface disabled:opacity-50"
              >
                Turno Tarde
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Data Section */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Ranking */}
        <div className="xl:col-span-2 bg-surface rounded-xl border border-outline-variant elevation-1 overflow-hidden flex flex-col">
          <div className="p-6 border-b border-outline-variant flex justify-between items-center bg-surface-container-lowest">
            <div>
              <h3 className="font-title-md text-title-md text-on-surface">Ranking de Impuntualidad</h3>
              <p className="font-label-md text-label-md text-on-surface-variant mt-1">
                Estudiantes con mayor incidencia de tardanzas en el período
              </p>
            </div>
          </div>
          <div className="overflow-x-auto flex-1">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-outline-variant bg-surface-container-low/50 font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">
                  <th className="py-3 px-6 font-medium">Estudiante</th>
                  <th className="py-3 px-6 font-medium">Grado/Sección</th>
                  <th className="py-3 px-6 font-medium">Turno</th>
                  <th className="py-3 px-6 font-medium text-center">Tardanzas</th>
                </tr>
              </thead>
              <tbody className="font-body-md text-body-md text-on-surface">
                {ranking.map((f, i) => (
                  <tr key={f.estudiante_id} className="border-b border-outline-variant hover:bg-surface-container-low transition-colors group">
                    <td className="py-3 px-6">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs ${
                            i === 0
                              ? 'bg-error-container text-on-error-container'
                              : 'bg-surface-variant text-on-surface-variant'
                          }`}
                        >
                          {iniciales(f.nombres, f.apellidos)}
                        </div>
                        <span className="font-medium">
                          {f.apellidos}, {f.nombres}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 px-6 text-on-surface-variant">
                      {f.grado} {f.seccion}
                    </td>
                    <td className="py-3 px-6">
                      <span
                        className={`inline-flex items-center px-2 py-1 rounded-full text-[10px] font-bold border ${
                          f.turno === 'MANANA'
                            ? 'bg-amber-100 text-amber-800 border-amber-200'
                            : 'bg-indigo-100 text-indigo-800 border-indigo-200'
                        }`}
                      >
                        {f.turno === 'MANANA' ? 'MAÑANA' : 'TARDE'}
                      </span>
                    </td>
                    <td className="py-3 px-6 text-center">
                      <span className={`font-title-md ${f.total_tarde > 0 ? 'text-error' : 'text-on-surface'}`}>
                        {f.total_tarde}
                      </span>
                    </td>
                  </tr>
                ))}
                {!cargando && ranking.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-6 text-center text-on-surface-variant">
                      No hay datos para el rango seleccionado.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Distribution Donut */}
        <div className="bg-surface rounded-xl border border-outline-variant elevation-1 flex flex-col">
          <div className="p-6 border-b border-outline-variant bg-surface-container-lowest">
            <h3 className="font-title-md text-title-md text-on-surface">Distribución por Turno</h3>
            <p className="font-label-md text-label-md text-on-surface-variant mt-1">Comparativa de tardanzas</p>
          </div>
          <div className="p-6 flex-1 flex flex-col justify-center items-center">
            <div className="relative w-48 h-48 mb-6">
              <svg className="w-full h-full transform -rotate-90" viewBox="0 0 36 36">
                <path
                  className="text-surface-variant"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="text-primary"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  stroke="currentColor"
                  strokeDasharray={dasharrayManana}
                  strokeWidth="4"
                />
                <path
                  className="text-tertiary-container"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  stroke="currentColor"
                  strokeDasharray={dasharrayTarde}
                  strokeDashoffset={-distribucion.pctManana}
                  strokeWidth="4"
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <Contador valor={distribucion.total} className="font-display-lg text-3xl font-bold text-on-surface" />
                <span className="font-label-md text-label-md text-on-surface-variant">Total</span>
              </div>
            </div>
            <div className="w-full flex flex-col gap-3">
              <div className="flex items-center justify-between p-2 rounded bg-surface-container-low">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-primary" />
                  <span className="font-body-md text-body-md text-on-surface">Mañana (A-E)</span>
                </div>
                <span className="font-title-md text-title-md text-on-surface">{distribucion.pctManana}%</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-surface-container-low">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-tertiary-container" />
                  <span className="font-body-md text-body-md text-on-surface">Tarde (F-H)</span>
                </div>
                <span className="font-title-md text-title-md text-on-surface">{distribucion.pctTarde}%</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {cargando && <Cargador texto="Cargando reporte…" className="mt-8" />}

      {/* Modal de detalle: lista completa de asistieron / tardanzas / faltones. */}
      {detalle &&
        (() => {
          const CFG = {
            asistieron: { titulo: 'Asistió temprano', icon: 'how_to_reg', color: 'text-primary', lista: asistieronLista },
            tardanzas: { titulo: 'Asistió tarde', icon: 'schedule', color: 'text-error', lista: tardanzasLista },
            faltones: { titulo: 'Posibles faltas (no marcaron)', icon: 'person_alert', color: 'text-amber-600', lista: faltonesLista },
            justificados: { titulo: 'Faltas justificadas', icon: 'verified', color: 'text-green-600', lista: justificadosLista },
          };
          const cfg = CFG[detalle];
          const lista = cfg.lista;
          const esUnDia = fechaInicio === fechaFin;
          const rangoLabel = esUnDia
            ? fechaConDia(fechaInicio)
            : `${fechaConDia(fechaInicio)} a ${fechaConDia(fechaFin)}`;

          // Opciones de grado+sección presentes en esta lista (orden 1ro→5to).
          const opcionesGS = Array.from(
            lista
              .reduce((m, f) => {
                const key = `${f.grado}|${f.seccion}`;
                if (!m.has(key)) {
                  m.set(key, {
                    key,
                    grado: Number(gradoNumero(f.grado)) || 0,
                    seccion: String(f.seccion || '').trim().toUpperCase(),
                    label: `${f.grado} "${f.seccion}"`,
                  });
                }
                return m;
              }, new Map())
              .values()
          ).sort((a, b) => a.grado - b.grado || a.seccion.localeCompare(b.seccion, 'es'));

          const listaFiltrada = detalleFiltro
            ? lista.filter((f) => `${f.grado}|${f.seccion}` === detalleFiltro)
            : lista;
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/40" onClick={() => setDetalle(null)} />
              <div className="relative bg-surface rounded-2xl border border-outline-variant shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
                <div className="p-5 border-b border-outline-variant flex justify-between items-center bg-surface-container-lowest rounded-t-2xl">
                  <div className="min-w-0">
                    <h3 className="font-title-lg text-title-lg text-on-surface flex items-center gap-2">
                      <Icon name={cfg.icon} className={cfg.color} />
                      {cfg.titulo}
                    </h3>
                    <p className="font-label-md text-label-md text-on-surface-variant mt-0.5">
                      {listaFiltrada.length}
                      {detalleFiltro ? ` de ${lista.length}` : ''}{' '}
                      {listaFiltrada.length === 1 ? 'alumno' : 'alumnos'} · {rangoLabel}
                    </p>
                  </div>
                  <button
                    onClick={() => setDetalle(null)}
                    title="Cerrar"
                    className="p-2 rounded-full text-on-surface-variant hover:bg-surface-container-high hover:text-primary transition-colors shrink-0"
                  >
                    <Icon name="close" />
                  </button>
                </div>

                {/* Filtro rápido por grado y sección dentro del modal. */}
                <div className="px-4 pt-3 pb-1 border-b border-outline-variant">
                  <label className="block font-label-md text-label-md text-on-surface-variant mb-1">
                    Grado y sección
                  </label>
                  <select
                    value={detalleFiltro}
                    onChange={(e) => setDetalleFiltro(e.target.value)}
                    className="w-full bg-surface border border-outline-variant text-on-surface font-body-md text-body-md rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-secondary"
                  >
                    <option value="">Todos los grados y secciones ({lista.length})</option>
                    {opcionesGS.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
                  {listaFiltrada.length === 0 && (
                    <p className="text-center text-on-surface-variant py-8">Sin alumnos para mostrar.</p>
                  )}
                  {listaFiltrada.map((f) => (
                    <div
                      key={f.estudiante_id}
                      className="flex items-center gap-3 p-3 rounded-lg border border-outline-variant bg-surface-container-lowest"
                    >
                      <div className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-xs bg-surface-variant text-on-surface-variant shrink-0">
                        {iniciales(f.nombres, f.apellidos)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-title-md text-title-md text-on-surface truncate">
                          {f.apellidos}, {f.nombres}
                        </p>
                        <p className="font-label-md text-label-md text-on-surface-variant">
                          {f.grado} "{f.seccion}" · {f.turno === 'MANANA' ? 'Mañana' : 'Tarde'}
                        </p>
                        {(() => {
                          if (detalle === 'faltones') return null;
                          const marca = horaPorEstudiante[f.estudiante_id];
                          const h = detalle === 'tardanzas' ? marca?.TARDE?.hora : marca?.ASISTIO?.hora;
                          if (!h) return null;
                          return (
                            <p className="font-label-md text-label-md text-primary flex items-center gap-1 mt-0.5">
                              <Icon name="schedule" className="text-[14px]" /> Llegó {formatearHoraDesdeTexto(h)}
                            </p>
                          );
                        })()}
                        {detalle === 'justificados' &&
                          (() => {
                            const arr = justFaltasPorEstudiante[f.estudiante_id] || [];
                            if (!arr.length) return null;
                            return (
                              <div className="mt-0.5 flex flex-col gap-0.5">
                                {arr.map((j) => (
                                  <p
                                    key={j.fecha}
                                    className="font-label-md text-label-md text-green-700 flex items-start gap-1"
                                  >
                                    <Icon name="verified" className="text-[14px] mt-0.5" />
                                    <span>
                                      {esUnDia ? '' : `${j.fecha.slice(8, 10)}/${j.fecha.slice(5, 7)}: `}
                                      {j.motivo}
                                    </span>
                                  </p>
                                ))}
                              </div>
                            );
                          })()}
                      </div>
                      {detalle === 'asistieron' && (
                        <div className="shrink-0 flex gap-1.5 font-label-md text-label-md">
                          <span className="text-blue-700 bg-blue-50 rounded px-2 py-0.5 whitespace-nowrap">
                            {f.total_asistio} puntual
                          </span>
                          {Number(f.total_tarde) > 0 && (
                            <span className="text-red-700 bg-red-50 rounded px-2 py-0.5 whitespace-nowrap">
                              {f.total_tarde} tarde
                            </span>
                          )}
                        </div>
                      )}
                      {(detalle === 'tardanzas' || detalle === 'faltones') &&
                        (() => {
                          const tipoJ = detalle === 'tardanzas' ? 'TARDE' : 'FALTA';
                          const just = esUnDia ? justMap.get(`${f.estudiante_id}|${fechaInicio}`) : null;
                          const tieneEnRango =
                            !esUnDia && justificaciones.some((j) => j.estudiante_id === f.estudiante_id);
                          return (
                            <div className="shrink-0 flex flex-col items-end gap-1">
                              {detalle === 'faltones' ? (
                                <span className="text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-1 font-label-md text-label-md whitespace-nowrap">
                                  {faltasEfectivas(f)} {faltasEfectivas(f) === 1 ? 'falta' : 'faltas'}
                                </span>
                              ) : (
                                <span className="text-red-700 bg-red-50 border border-red-200 rounded-full px-2.5 py-1 font-label-md text-label-md whitespace-nowrap">
                                  {f.total_tarde} {Number(f.total_tarde) === 1 ? 'tardanza' : 'tardanzas'}
                                </span>
                              )}
                              {just ? (
                                <button
                                  onClick={() => abrirJustificar(f, tipoJ, fechaInicio, just.motivo)}
                                  title={`Justificado: ${just.motivo} (toca para editar)`}
                                  className="text-green-700 bg-green-50 border border-green-200 rounded-full px-2.5 py-0.5 font-label-md text-label-md flex items-center gap-1 hover:bg-green-100 transition-colors"
                                >
                                  <Icon name="verified" className="text-[14px]" /> Justificado
                                </button>
                              ) : esUnDia ? (
                                <button
                                  onClick={() => abrirJustificar(f, tipoJ, fechaInicio, '')}
                                  className="text-primary border border-primary/40 rounded-full px-2.5 py-0.5 font-label-md text-label-md flex items-center gap-1 hover:bg-primary/10 transition-colors"
                                >
                                  <Icon name="edit_note" className="text-[16px]" /> Justificar
                                </button>
                              ) : tieneEnRango ? (
                                <span className="text-green-700 font-label-md text-label-md flex items-center gap-1">
                                  <Icon name="verified" className="text-[14px]" /> Justificado
                                </span>
                              ) : null}
                            </div>
                          );
                        })()}
                      {detalle === 'justificados' && (
                        <div className="shrink-0 flex flex-col items-end gap-1">
                          <span className="text-green-700 bg-green-50 border border-green-200 rounded-full px-2.5 py-1 font-label-md text-label-md whitespace-nowrap">
                            {justFaltasPorEstudiante[f.estudiante_id]?.length || 0} justificada
                            {(justFaltasPorEstudiante[f.estudiante_id]?.length || 0) === 1 ? '' : 's'}
                          </span>
                          {esUnDia && (
                            <button
                              onClick={() =>
                                abrirJustificar(f, 'FALTA', fechaInicio, justMap.get(`${f.estudiante_id}|${fechaInicio}`)?.motivo)
                              }
                              className="text-primary border border-primary/40 rounded-full px-2.5 py-0.5 font-label-md text-label-md flex items-center gap-1 hover:bg-primary/10 transition-colors"
                            >
                              <Icon name="edit_note" className="text-[16px]" /> Editar
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <div className="p-3 border-t border-outline-variant flex justify-end rounded-b-2xl">
                  <button
                    onClick={() => exportarLista(listaFiltrada, detalle)}
                    disabled={listaFiltrada.length === 0}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-on-primary font-label-md text-label-md hover:bg-primary-container hover:text-on-primary-container transition-colors disabled:opacity-50"
                  >
                    <Icon name="download" className="text-[18px]" /> Exportar lista
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

      {/* Diálogo para escribir/editar la justificación (encima del modal). */}
      {justificando && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setJustificando(null)} />
          <div className="relative bg-surface rounded-2xl border border-outline-variant shadow-2xl w-full max-w-md flex flex-col">
            <div className="p-5 border-b border-outline-variant">
              <h3 className="font-title-lg text-title-lg text-on-surface flex items-center gap-2">
                <Icon name="edit_note" className="text-primary" />
                Justificar {justificando.tipo === 'TARDE' ? 'tardanza' : 'falta'}
              </h3>
              <p className="font-label-md text-label-md text-on-surface-variant mt-0.5">
                {justificando.nombre} · {fechaConDia(justificando.fecha)}
              </p>
            </div>
            <div className="p-5">
              <label className="block font-label-md text-label-md text-on-surface-variant mb-1">Motivo</label>
              <textarea
                value={motivoInput}
                onChange={(e) => setMotivoInput(e.target.value)}
                rows={4}
                autoFocus
                placeholder="Ej. Cita médica, permiso de los padres, problema de transporte…"
                className="w-full bg-surface border border-outline-variant rounded-lg px-3 py-2 text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary transition-all resize-none"
              />
            </div>
            <div className="p-3 border-t border-outline-variant flex justify-between gap-2">
              <div>
                {justMap.has(`${justificando.estudiante_id}|${justificando.fecha}`) && (
                  <button
                    onClick={eliminarJustificacion}
                    disabled={guardandoJust}
                    className="flex items-center gap-1 px-3 py-2 rounded-lg font-label-md text-label-md text-error hover:bg-error-container/40 transition-colors disabled:opacity-50"
                  >
                    <Icon name="delete" className="text-[18px]" /> Quitar
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setJustificando(null)}
                  className="px-4 py-2 rounded-lg font-label-md text-label-md text-on-surface-variant hover:bg-surface-container-high transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={guardarJustificacion}
                  disabled={!motivoInput.trim() || guardandoJust}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-on-primary font-label-md text-label-md hover:bg-primary-container hover:text-on-primary-container transition-colors disabled:opacity-50"
                >
                  <Icon name="save" className="text-[18px]" />
                  {guardandoJust ? 'Guardando…' : 'Guardar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
