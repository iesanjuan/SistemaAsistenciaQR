import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import { useUI } from '../lib/UIContext';
import {
  estadoMarcacion,
  fechaLocalISO,
  formatearHora,
  formatearHoraDesdeTexto,
  HORA_MAXIMA_ESCANEO,
  HORA_MINIMA_ESCANEO,
  HORARIOS,
  ventanaEscaneo,
  turnoPorHora,
  TURNOS,
} from '../utils/turnos';
import Icon from './Icon';
import { desbloquearAudio, reproducirSonido } from '../utils/sonidos';

// ============================================================================
// Escáner USB (lector físico tipo "keyboard wedge", p. ej. Advance ADV-6012N).
// El lector se comporta como un TECLADO: "escribe" el código y termina con
// Enter. Aquí NO usamos cámara ni pantallas de color a pantalla completa: el
// resultado se muestra EN LÍNEA junto al campo, para que sea más rápido y no
// haya que tocar la pantalla entre lecturas.
//
// Optimización de velocidad: se PRECARGAN los alumnos una vez (búsqueda local
// instantánea), se detectan duplicados localmente y el registro es OPTIMISTA
// (feedback inmediato + guardado en segundo plano). La restricción UNIQUE de
// la tabla `asistencias` es el seguro final anti-duplicados.
// ============================================================================

const DURACION_RESET_MS = 6000; // el resultado vuelve a "listo" tras unos segundos

// Estilos en línea (no overlay) por tipo de resultado.
const RESULTADO_ESTILOS = {
  ASISTIO: { icon: 'check_circle', titulo: 'ASISTIÓ', card: 'bg-blue-50 border-blue-300', txt: 'text-blue-700' },
  TARDE: { icon: 'schedule', titulo: 'TARDE', card: 'bg-red-50 border-red-300', txt: 'text-red-700' },
  TURNO_INCORRECTO: { icon: 'warning', titulo: 'TURNO INCORRECTO', card: 'bg-amber-50 border-amber-300', txt: 'text-amber-700' },
  FUERA_DE_HORARIO: { icon: 'bedtime', titulo: 'FUERA DE HORARIO', card: 'bg-slate-100 border-slate-300', txt: 'text-slate-700' },
  DUPLICADO: { icon: 'block', titulo: 'YA REGISTRADO HOY', card: 'bg-slate-100 border-slate-300', txt: 'text-slate-700' },
  NO_ENCONTRADO: { icon: 'person_off', titulo: 'NO ENCONTRADO', card: 'bg-slate-100 border-slate-300', txt: 'text-slate-700' },
  ERROR: { icon: 'error', titulo: 'ERROR AL REGISTRAR', card: 'bg-slate-100 border-slate-300', txt: 'text-slate-700' },
};

const LOG_ESTILOS = {
  ASISTIO: { barra: 'bg-blue-600', chip: 'text-blue-600 bg-blue-50', label: 'PUNTUAL' },
  TARDE: { barra: 'bg-red-600', chip: 'text-red-600 bg-red-50', label: 'TARDE' },
  TURNO_INCORRECTO: { barra: 'bg-amber-500', chip: 'text-amber-700 bg-amber-50', label: 'TURNO INCORRECTO' },
};

function relojPartes(date) {
  const partes = new Intl.DateTimeFormat('es-PE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).formatToParts(date);
  let hora = '';
  let meridiano = '';
  for (const p of partes) {
    if (p.type === 'dayPeriod') meridiano = p.value;
    else hora += p.value;
  }
  return { hora: hora.trim(), meridiano };
}

// Tarjeta de resultado EN LÍNEA (reemplaza al overlay de pantalla completa).
function ResultadoInline({ resultado }) {
  if (!resultado) {
    return (
      <div className="w-full max-w-lg rounded-2xl border-2 border-dashed border-outline-variant p-6 flex flex-col items-center text-center text-on-surface-variant">
        <Icon name="barcode_reader" style={{ fontSize: 48 }} className="text-primary mb-2" />
        <p className="font-title-md text-title-md text-on-surface">Listo para escanear</p>
        <p className="font-body-md text-body-md">Apunta el lector al QR del carnet</p>
      </div>
    );
  }
  const e = RESULTADO_ESTILOS[resultado.tipo] || RESULTADO_ESTILOS.ERROR;
  return (
    <div className={`w-full max-w-lg rounded-2xl border-2 ${e.card} p-5 flex flex-col items-center text-center`}>
      <div className={`flex items-center gap-2 ${e.txt}`}>
        <Icon name={e.icon} fill className="text-[28px]" />
        <span className="text-2xl font-bold tracking-tight">{e.titulo}</span>
      </div>
      {resultado.nombreCompleto && (
        <p className="mt-2 font-title-lg text-title-lg text-on-surface font-bold">{resultado.nombreCompleto}</p>
      )}
      {(resultado.gradoSeccion || resultado.turnoLabel) && (
        <div className="flex flex-wrap justify-center gap-2 mt-2">
          {resultado.gradoSeccion && (
            <span className="px-3 py-1 rounded-full bg-surface-container-high text-on-surface font-body-md text-body-md">
              {resultado.gradoSeccion}
            </span>
          )}
          {resultado.turnoLabel && (
            <span className="px-3 py-1 rounded-full bg-surface-container-high text-on-surface font-body-md text-body-md">
              {resultado.turnoLabel}
            </span>
          )}
        </div>
      )}
      {resultado.detalle && <p className="mt-2 font-body-md text-body-md text-on-surface-variant">{resultado.detalle}</p>}
      {resultado.hora && <p className="mt-1 font-body-md text-body-md text-on-surface-variant tabular-nums">{resultado.hora}</p>}
    </div>
  );
}

export default function EscanerUSB() {
  const { perfil, esAdmin } = useAuth();
  const { toast } = useUI();
  const [turno, setTurno] = useState(perfil?.turno || turnoPorHora());
  const [turnoAuto, setTurnoAuto] = useState(true);
  const [resultado, setResultado] = useState(null);
  const [reloj, setReloj] = useState(new Date());
  const [registros, setRegistros] = useState([]);
  const [codigo, setCodigo] = useState('');
  const [panelAbierto, setPanelAbierto] = useState(false);
  const [cargandoDatos, setCargandoDatos] = useState(true);
  // Header plegable: en tablet permite ocultar los controles para dejar la
  // pantalla de escaneo más amplia y limpia. Se recuerda la preferencia.
  const [headerAbierto, setHeaderAbierto] = useState(() => {
    try {
      return localStorage.getItem('escaner-controles') !== 'oculto';
    } catch {
      return true;
    }
  });
  const inputRef = useRef(null);
  const cierreTimeoutRef = useRef(null);
  const audioListoRef = useRef(false);
  const estudiantesRef = useRef(new Map()); // dni -> estudiante (caché en memoria)
  const marcadosHoyRef = useRef(new Set()); // estudiante_id ya marcado hoy

  useEffect(() => {
    if (perfil?.turno && !esAdmin) setTurno(perfil.turno);
  }, [perfil, esAdmin]);

  useEffect(() => {
    const t = setInterval(() => setReloj(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('escaner-controles', headerAbierto ? 'visible' : 'oculto');
    } catch {
      /* noop */
    }
  }, [headerAbierto]);

  // Turno automático por hora (solo admin y mientras no lo haya cambiado a mano).
  useEffect(() => {
    if (!esAdmin || !turnoAuto) return;
    const t = turnoPorHora(reloj);
    setTurno((prev) => (prev === t ? prev : t));
  }, [esAdmin, turnoAuto, reloj]);

  useEffect(() => {
    cargarDatos();
  }, []);

  // Mantener el campo enfocado para que el lector siempre "escriba" aquí.
  useEffect(() => {
    if (!panelAbierto) inputRef.current?.focus();
  }, [panelAbierto]);

  useEffect(() => {
    const reenfocar = () => {
      if (!panelAbierto) inputRef.current?.focus();
    };
    window.addEventListener('focus', reenfocar);
    return () => window.removeEventListener('focus', reenfocar);
  }, [panelAbierto]);

  // Precarga: todos los alumnos activos (para búsqueda local instantánea) y las
  // marcaciones de hoy (para el registro reciente y el chequeo de duplicados).
  async function cargarDatos() {
    setCargandoDatos(true);
    const [resEst, resAsis] = await Promise.all([
      supabase.from('estudiantes').select('*').eq('activo', true),
      supabase
        .from('asistencias')
        .select('id, estudiante_id, hora_ingreso, estado, estudiantes(nombres, apellidos, grado, seccion)')
        .eq('fecha', fechaLocalISO())
        .order('hora_ingreso', { ascending: false })
        .limit(200),
    ]);

    const mapa = new Map();
    (resEst.data || []).forEach((e) => mapa.set(String(e.dni), e));
    estudiantesRef.current = mapa;

    const set = new Set();
    (resAsis.data || []).forEach((r) => r.estudiante_id && set.add(r.estudiante_id));
    marcadosHoyRef.current = set;

    setRegistros(
      (resAsis.data || []).map((r) => ({
        id: r.id,
        tipo: r.estado,
        nombre: `${r.estudiantes?.nombres || ''} ${r.estudiantes?.apellidos || ''}`.trim(),
        gradoSeccion: `${r.estudiantes?.grado || ''} "${r.estudiantes?.seccion || ''}"`,
        hora: r.hora_ingreso,
      }))
    );
    setCargandoDatos(false);
  }

  // El navegador solo deja sonar el audio tras un gesto del usuario; las teclas
  // del lector cuentan como gesto.
  function asegurarAudio() {
    if (audioListoRef.current) return;
    audioListoRef.current = true;
    desbloquearAudio();
  }

  function manejarSubmit(e) {
    e.preventDefault();
    const valor = codigo.trim();
    setCodigo('');
    if (!valor || cargandoDatos) return;
    procesar(valor);
    inputRef.current?.focus();
  }

  async function procesar(dni) {
    const ahora = new Date();

    // 1. Ventana horaria global.
    const ventana = ventanaEscaneo(ahora);
    if (ventana !== 'OK') {
      const detalle =
        ventana === 'ANTES'
          ? `Solo se puede marcar a partir de las ${formatearHoraDesdeTexto(HORA_MINIMA_ESCANEO)}.`
          : `Solo se puede marcar hasta las ${formatearHoraDesdeTexto(HORA_MAXIMA_ESCANEO)}.`;
      mostrarResultado({ tipo: 'FUERA_DE_HORARIO', detalle });
      return;
    }

    // 2. Búsqueda local; si no está en caché (alumno nuevo), consulta en vivo.
    let estudiante = estudiantesRef.current.get(String(dni));
    if (!estudiante) {
      const { data } = await supabase
        .from('estudiantes')
        .select('*')
        .eq('dni', dni)
        .eq('activo', true)
        .maybeSingle();
      if (data) {
        estudiante = data;
        estudiantesRef.current.set(String(data.dni), data);
      }
    }
    if (!estudiante) {
      mostrarResultado({ tipo: 'NO_ENCONTRADO', detalle: `Código leído: ${dni}` });
      return;
    }

    const nombreCompleto = `${estudiante.nombres} ${estudiante.apellidos}`;
    const gradoSeccion = `${estudiante.grado} "${estudiante.seccion}"`;

    // 3. Turno correcto.
    if (estudiante.turno !== turno) {
      mostrarResultado({
        tipo: 'TURNO_INCORRECTO',
        nombreCompleto,
        gradoSeccion,
        turnoLabel: HORARIOS[estudiante.turno].label,
        detalle: 'Por favor, esperar a su horario.',
      });
      return;
    }

    // 4. Estado según horario del turno (con límite superior en la salida).
    const estado = estadoMarcacion(turno, ahora);
    if (estado === 'FUERA_DE_TURNO') {
      mostrarResultado({
        tipo: 'FUERA_DE_HORARIO',
        nombreCompleto,
        gradoSeccion,
        turnoLabel: HORARIOS[turno].label,
        detalle: `El ${HORARIOS[turno].label.toLowerCase()} ya cerró (salida ${formatearHoraDesdeTexto(HORARIOS[turno].salida)}).`,
      });
      return;
    }

    // 5. Duplicado (chequeo local instantáneo).
    if (marcadosHoyRef.current.has(estudiante.id)) {
      mostrarResultado({
        tipo: 'DUPLICADO',
        nombreCompleto,
        gradoSeccion,
        turnoLabel: HORARIOS[estudiante.turno].label,
        detalle: 'Ya tiene una marcación registrada hoy.',
      });
      return;
    }

    // 6. Registro OPTIMISTA: feedback inmediato y guardado en segundo plano.
    const fecha = fechaLocalISO(ahora);
    const horaIngreso = ahora.toTimeString().slice(0, 8);
    const logId = `local-${Date.now()}`;
    marcadosHoyRef.current.add(estudiante.id);
    mostrarResultado({
      tipo: estado,
      nombreCompleto,
      gradoSeccion,
      turnoLabel: HORARIOS[estudiante.turno].label,
      hora: formatearHora(ahora),
    });
    agregarAlLog({ id: logId, tipo: estado, nombre: nombreCompleto, gradoSeccion, hora: horaIngreso });

    supabase
      .from('asistencias')
      .insert({ estudiante_id: estudiante.id, fecha, hora_ingreso: horaIngreso, estado, registrado_por: perfil?.id })
      .then(({ error }) => {
        if (!error) return;
        if (error.code === '23505') {
          // Otro dispositivo ya lo registró: corrige el mensaje (sigue marcado).
          mostrarResultado({
            tipo: 'DUPLICADO',
            nombreCompleto,
            gradoSeccion,
            turnoLabel: HORARIOS[estudiante.turno].label,
            detalle: 'Ya tenía una marcación registrada hoy.',
          });
        } else {
          // Error de red: revertir para permitir reintentar.
          marcadosHoyRef.current.delete(estudiante.id);
          setRegistros((prev) => prev.filter((r) => r.id !== logId));
          mostrarResultado({
            tipo: 'ERROR',
            nombreCompleto,
            detalle: 'No se pudo guardar (revisa el internet). Vuelve a escanear.',
          });
          toast('Error de red al registrar', 'error');
        }
      });
  }

  function agregarAlLog(item) {
    setRegistros((prev) => [item, ...prev].slice(0, 50));
  }

  function mostrarResultado(res) {
    setResultado(res);
    reproducirSonido(res.tipo);
    clearTimeout(cierreTimeoutRef.current);
    cierreTimeoutRef.current = setTimeout(() => setResultado(null), DURACION_RESET_MS);
  }

  const horario = HORARIOS[turno];

  return (
    <div className="flex-1 bg-background flex flex-col h-[calc(100dvh-64px-72px)] md:h-screen relative">
      {/* Control Header plegable: turno · reloj · registros. Se puede ocultar
          para dejar la pantalla de escaneo amplia y limpia (útil en tablet). */}
      <div className="bg-surface shadow-sm border-b border-outline-variant z-10 no-print">
       {headerAbierto && (
        <div className="px-margin-mobile md:px-margin-desktop py-4 flex flex-col md:flex-row md:items-center gap-3">
        {/* Turno + tolerancia (izquierda) */}
        <div className="flex flex-col gap-1 w-full md:w-auto md:flex-1 md:min-w-0">
          <label htmlFor="selector-turno-usb" className="text-on-surface-variant font-label-md text-label-md uppercase tracking-wider">
            Turno
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full md:w-40">
              <Icon
                name={turno === TURNOS.MANANA ? 'wb_sunny' : 'wb_twilight'}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-primary text-[16px]"
              />
              <select
                id="selector-turno-usb"
                value={turno}
                onChange={(e) => {
                  setTurno(e.target.value);
                  setTurnoAuto(false);
                }}
                disabled={!esAdmin && !!perfil?.turno}
                className="appearance-none w-full h-9 pl-8 pr-7 font-label-md text-label-md rounded-lg bg-surface-container-lowest text-on-surface border border-outline-variant focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <option value={TURNOS.MANANA}>Turno Mañana</option>
                <option value={TURNOS.TARDE}>Turno Tarde</option>
              </select>
              <Icon
                name="expand_more"
                className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-on-surface-variant text-[16px]"
              />
            </div>
            {esAdmin && (
              <button
                onClick={() => setTurnoAuto((v) => !v)}
                title={turnoAuto ? 'Turno automático por hora (activado)' : 'Volver a turno automático por hora'}
                className={`flex items-center gap-1 shrink-0 h-9 px-2.5 rounded-lg border font-label-md text-label-md transition-colors ${
                  turnoAuto
                    ? 'bg-primary text-on-primary border-primary'
                    : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant hover:bg-surface-container-high'
                }`}
              >
                <Icon name="schedule" className="text-[16px]" />
                Auto
              </button>
            )}
            <span
              title="Tolerancia: hora límite para marcar como ASISTIÓ"
              className="flex items-center gap-1 shrink-0 h-9 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-2.5 font-label-md text-label-md whitespace-nowrap tabular-nums"
            >
              <Icon name="timer" className="text-[16px]" />
              {formatearHoraDesdeTexto(horario.tolerancia)}
            </span>
          </div>
        </div>

        {/* Reloj y fecha (centro) */}
        <div className="flex flex-col items-center shrink-0">
          <div className="font-display-lg text-2xl md:text-4xl text-primary tracking-tight tabular-nums leading-none">
            {relojPartes(reloj).hora}
            <sup className="text-[0.4em] font-bold align-super ml-1 uppercase tracking-wide">
              {relojPartes(reloj).meridiano}
            </sup>
          </div>
          <div className="text-on-surface-variant font-label-md text-label-md uppercase tracking-wider mt-1 text-center">
            {reloj.toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </div>
        </div>

        {/* Botón "Registros" (abre el cajón), compacto, a la derecha. */}
        <div className="md:flex-1 flex justify-end shrink-0">
          <button
            onClick={() => setPanelAbierto(true)}
            title="Ver registro reciente de marcaciones"
            className="relative flex items-center gap-1.5 h-9 px-2.5 rounded-lg border border-outline-variant bg-surface-container-lowest text-on-surface hover:bg-surface-container-high transition-colors font-label-md text-label-md shrink-0"
          >
            <Icon name="history" className="text-primary text-[18px]" />
            <span className="hidden lg:inline">Registros</span>
            {registros.length > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-on-primary text-[10px] font-bold flex items-center justify-center">
                {registros.length}
              </span>
            )}
          </button>
        </div>

        </div>
       )}

        {/* Barra para plegar/desplegar los controles. */}
        <button
          onClick={() => setHeaderAbierto((v) => !v)}
          title={headerAbierto ? 'Ocultar controles' : 'Mostrar controles'}
          className="w-full flex items-center justify-center gap-1 py-1 text-on-surface-variant hover:bg-surface-container-high transition-colors"
        >
          <Icon name={headerAbierto ? 'expand_less' : 'expand_more'} className="text-[18px]" />
          <span className="font-label-md text-label-md">{headerAbierto ? 'Ocultar controles' : 'Mostrar controles'}</span>
        </button>
      </div>

      {/* Zona central: resultado en línea + campo de captura del lector USB */}
      <div className="flex-1 flex flex-col items-center justify-center overflow-auto relative p-6 gap-5">
        <ResultadoInline resultado={resultado} />

        <form onSubmit={manejarSubmit} className="w-full max-w-lg flex flex-col items-center text-center gap-4">
          <input
            ref={inputRef}
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
            onKeyDown={asegurarAudio}
            onFocus={asegurarAudio}
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            disabled={cargandoDatos}
            placeholder={cargandoDatos ? 'Cargando alumnos…' : 'Esperando lectura…'}
            className="w-full text-center text-2xl md:text-3xl tracking-widest tabular-nums py-4 px-4 rounded-2xl bg-surface-container-lowest text-on-surface border-2 border-outline-variant focus:outline-none focus-visible:border-primary transition-colors disabled:opacity-60"
          />

          <div className="flex items-center gap-2 text-on-surface-variant font-label-md text-label-md">
            <span className={`w-2.5 h-2.5 rounded-full ${cargandoDatos ? 'bg-amber-500' : 'bg-green-500 animate-pulse'}`} />
            {cargandoDatos ? 'Preparando…' : 'Listo para escanear'}
          </div>

          <button
            type="submit"
            disabled={!codigo.trim() || cargandoDatos}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-primary text-on-primary font-label-md text-label-md hover:bg-primary-container hover:text-on-primary-container transition-colors disabled:opacity-50"
          >
            <Icon name="check_circle" className="text-[20px]" />
            Registrar
          </button>
        </form>
      </div>

      {/* Cajón lateral de "Registro Reciente" */}
      {panelAbierto && (
        <>
          <div className="fixed inset-0 bg-black/40 z-40 no-print" onClick={() => setPanelAbierto(false)} />
          <aside className="fixed top-0 right-0 h-full w-full sm:w-[380px] max-w-full bg-surface z-50 shadow-2xl border-l border-outline-variant flex flex-col no-print">
            <div className="p-4 border-b border-outline-variant bg-surface-container-lowest flex justify-between items-center">
              <h3 className="font-title-lg text-title-lg text-on-surface flex items-center gap-2">
                <Icon name="history" className="text-primary" />
                Registro Reciente
              </h3>
              <div className="flex items-center gap-2">
                <span className="bg-surface-container-high text-primary px-2 py-1 rounded-md font-label-md text-label-md">
                  Hoy: {registros.length}
                </span>
                <button
                  onClick={() => setPanelAbierto(false)}
                  title="Cerrar"
                  className="p-1.5 rounded-full text-on-surface-variant hover:bg-surface-container-high hover:text-primary transition-colors"
                >
                  <Icon name="close" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
              {registros.length === 0 && (
                <p className="text-on-surface-variant text-sm text-center py-8">Aún no hay marcaciones hoy.</p>
              )}
              {registros.map((r) => {
                const estilo = LOG_ESTILOS[r.tipo] || LOG_ESTILOS.TARDE;
                return (
                  <div
                    key={r.id}
                    className="bg-surface-container-lowest border border-outline-variant rounded-lg p-3 flex items-center gap-3 hover:bg-surface-container-low transition-colors shadow-sm"
                  >
                    <div className={`w-2 h-full min-h-[48px] ${estilo.barra} rounded-full`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-start gap-2">
                        <p className="font-title-md text-title-md text-on-surface leading-tight truncate">{r.nombre}</p>
                        <span className="font-label-md text-label-md text-on-surface-variant shrink-0">
                          {formatearHoraDesdeTexto(r.hora)}
                        </span>
                      </div>
                      <div className="flex justify-between items-center mt-1 gap-2">
                        <p className="font-body-md text-body-md text-on-surface-variant truncate">{r.gradoSeccion}</p>
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-sm shrink-0 ${estilo.chip}`}>
                          {estilo.label}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
