import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
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

const LECTOR_ID = 'qr-reader-region';
const DURACION_OVERLAY_MS = 2500;

const OVERLAY_ESTILOS = {
  ASISTIO: { bg: 'bg-blue-600/90', icon: 'check_circle', titulo: '¡ASISTIÓ!' },
  TARDE: { bg: 'bg-red-600/90', icon: 'schedule', titulo: '¡TARDE!' },
  TURNO_INCORRECTO: { bg: 'bg-amber-600/90', icon: 'warning', titulo: '¡TURNO INCORRECTO!' },
  FUERA_DE_HORARIO: { bg: 'bg-slate-800/90', icon: 'bedtime', titulo: 'FUERA DE HORARIO' },
  DUPLICADO: { bg: 'bg-slate-700/90', icon: 'block', titulo: 'YA REGISTRADO HOY' },
  NO_ENCONTRADO: { bg: 'bg-slate-800/90', icon: 'person_off', titulo: 'NO ENCONTRADO' },
  ERROR: { bg: 'bg-slate-800/90', icon: 'error', titulo: 'ERROR AL REGISTRAR' },
};

const LOG_ESTILOS = {
  ASISTIO: { barra: 'bg-blue-600', chip: 'text-blue-600 bg-blue-50', label: 'PUNTUAL' },
  TARDE: { barra: 'bg-red-600', chip: 'text-red-600 bg-red-50', label: 'TARDE' },
  TURNO_INCORRECTO: { barra: 'bg-amber-500', chip: 'text-amber-700 bg-amber-50', label: 'TURNO INCORRECTO' },
};

// Separa la hora del meridiano (a. m. / p. m.) para poder mostrar el meridiano
// más pequeño y elevado, como un superíndice, en el reloj.
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

function Overlay({ resultado, onCerrar }) {
  if (!resultado) return null;
  const estilo = OVERLAY_ESTILOS[resultado.tipo];
  return (
    <div
      className={`feedback-overlay active absolute inset-0 ${estilo.bg} flex flex-col items-center justify-center z-20 cursor-pointer`}
      onClick={onCerrar}
    >
      <Icon name={estilo.icon} className="text-white mb-4" style={{ fontSize: 96 }} fill />
      <h2 className="text-white font-display-lg text-display-lg font-bold tracking-tight text-center leading-tight px-4">
        {estilo.titulo}
      </h2>
      {resultado.nombreCompleto && (
        <p className="text-white/90 font-title-lg text-title-lg mt-2 text-center px-4">{resultado.nombreCompleto}</p>
      )}
      {resultado.detalle && (
        <p className="text-white/80 font-body-lg text-body-lg mt-1 text-center px-4">{resultado.detalle}</p>
      )}
      {resultado.hora && <p className="text-white/90 font-body-lg text-body-lg mt-1">{resultado.hora}</p>}
      <p className="mt-8 text-white/60 text-xs">Toca la pantalla para continuar escaneando</p>
    </div>
  );
}

export default function EscanerQR() {
  const { perfil, esAdmin } = useAuth();
  const { toast } = useUI();
  const [turno, setTurno] = useState(perfil?.turno || turnoPorHora());
  // El admin puede escanear cualquier turno; por defecto sigue la HORA (auto).
  // Si cambia el selector a mano, se desactiva el automático.
  const [turnoAuto, setTurnoAuto] = useState(true);
  const [escaneando, setEscaneando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [procesando, setProcesando] = useState(false);
  const [reloj, setReloj] = useState(new Date());
  const [registros, setRegistros] = useState([]);
  const [panelAbierto, setPanelAbierto] = useState(false);
  const scannerRef = useRef(null);
  const cierreTimeoutRef = useRef(null);
  const estudiantesRef = useRef(new Map()); // dni -> estudiante (caché en memoria)
  const marcadosHoyRef = useRef(new Set()); // estudiante_id ya marcado hoy

  useEffect(() => {
    if (perfil?.turno && !esAdmin) setTurno(perfil.turno);
  }, [perfil, esAdmin]);

  useEffect(() => {
    const t = setInterval(() => setReloj(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Turno automático por hora (solo admin, mientras no lo cambie a mano y no
  // esté escaneando, para no cambiar el turno en medio de una captura).
  useEffect(() => {
    if (!esAdmin || !turnoAuto || escaneando) return;
    const t = turnoPorHora(reloj);
    setTurno((prev) => (prev === t ? prev : t));
  }, [esAdmin, turnoAuto, escaneando, reloj]);

  useEffect(() => {
    cargarDatos();
    return () => detenerCamara();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Precarga: todos los alumnos activos (para búsqueda local instantánea) y las
  // marcaciones de hoy (registro reciente + chequeo de duplicados local).
  async function cargarDatos() {
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
  }

  async function iniciarCamara() {
    // Iniciar la cámara es un gesto del usuario: aprovechamos para habilitar el
    // audio, si no el navegador bloquea el sonido de las marcaciones.
    desbloquearAudio();
    setEscaneando(true);
    const scanner = new Html5Qrcode(LECTOR_ID);
    scannerRef.current = scanner;
    try {
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 260, height: 260 } },
        (decodedText) => manejarLectura(decodedText),
        () => {}
      );
    } catch (err) {
      console.error('No se pudo iniciar la cámara:', err);
      setEscaneando(false);
    }
  }

  async function detenerCamara() {
    const scanner = scannerRef.current;
    if (scanner) {
      try {
        await scanner.stop();
        scanner.clear();
      } catch {
        /* ya estaba detenida */
      }
      scannerRef.current = null;
    }
    setEscaneando(false);
  }

  async function manejarLectura(dni) {
    if (procesando) return;
    setProcesando(true);
    if (scannerRef.current) {
      try {
        await scannerRef.current.pause(true);
      } catch {
        /* noop */
      }
    }
    await registrarMarcacion(dni.trim());
    setProcesando(false);
  }

  async function registrarMarcacion(dni) {
    const ahora = new Date();

    // Compuerta horaria global: fuera del horario de atención (antes de las
    // 5:59am o después de las 6:59pm) el escaneo no se registra, sin importar
    // el turno.
    const ventana = ventanaEscaneo(ahora);
    if (ventana !== 'OK') {
      const detalle =
        ventana === 'ANTES'
          ? `Solo se puede marcar a partir de las ${formatearHoraDesdeTexto(HORA_MINIMA_ESCANEO)}.`
          : `Solo se puede marcar hasta las ${formatearHoraDesdeTexto(HORA_MAXIMA_ESCANEO)}.`;
      mostrarResultado({ tipo: 'FUERA_DE_HORARIO', detalle });
      return;
    }

    // Búsqueda local (instantánea); si no está en caché (alumno nuevo), va en vivo.
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
      mostrarResultado({ tipo: 'NO_ENCONTRADO', detalle: `DNI escaneado: ${dni}` });
      return;
    }

    const nombreCompleto = `${estudiante.nombres} ${estudiante.apellidos}`;
    const gradoSeccion = `${estudiante.grado} "${estudiante.seccion}"`;

    if (estudiante.turno !== turno) {
      mostrarResultado({
        tipo: 'TURNO_INCORRECTO',
        nombreCompleto: `${nombreCompleto} - ${HORARIOS[estudiante.turno].label}`,
        detalle: 'Por favor, esperar a su horario.',
      });
      agregarAlLog({ tipo: 'TURNO_INCORRECTO', nombre: nombreCompleto, gradoSeccion, hora: ahora.toTimeString().slice(0, 8) });
      return;
    }

    const estado = estadoMarcacion(turno, ahora);
    // El turno ya cerró (después de la hora de salida): no cuenta como tarde.
    if (estado === 'FUERA_DE_TURNO') {
      mostrarResultado({
        tipo: 'FUERA_DE_HORARIO',
        nombreCompleto,
        detalle: `El ${HORARIOS[turno].label.toLowerCase()} ya cerró (salida ${formatearHoraDesdeTexto(HORARIOS[turno].salida)}).`,
      });
      return;
    }

    // Duplicado: chequeo local instantáneo.
    if (marcadosHoyRef.current.has(estudiante.id)) {
      mostrarResultado({ tipo: 'DUPLICADO', nombreCompleto, detalle: 'Ya tiene una marcación registrada hoy.' });
      return;
    }

    // Registro OPTIMISTA: feedback inmediato y guardado en segundo plano.
    const fecha = fechaLocalISO(ahora);
    const horaIngreso = ahora.toTimeString().slice(0, 8);
    const logId = `local-${Date.now()}`;
    marcadosHoyRef.current.add(estudiante.id);
    mostrarResultado({
      tipo: estado,
      nombreCompleto: `${nombreCompleto} - ${gradoSeccion}`,
      hora: formatearHora(ahora),
    });
    agregarAlLog({ id: logId, tipo: estado, nombre: nombreCompleto, gradoSeccion, hora: horaIngreso });

    supabase
      .from('asistencias')
      .insert({ estudiante_id: estudiante.id, fecha, hora_ingreso: horaIngreso, estado, registrado_por: perfil?.id })
      .then(({ error: errInsert }) => {
        if (!errInsert) return;
        if (errInsert.code === '23505') {
          mostrarResultado({ tipo: 'DUPLICADO', nombreCompleto, detalle: 'Ya tenía una marcación registrada hoy.' });
        } else {
          // Error de red: revertir para permitir reintentar.
          marcadosHoyRef.current.delete(estudiante.id);
          setRegistros((prev) => prev.filter((r) => r.id !== logId));
          mostrarResultado({ tipo: 'ERROR', nombreCompleto, detalle: 'No se pudo guardar (revisa el internet).' });
          toast('Error de red al registrar', 'error');
        }
      });
  }

  function agregarAlLog(item) {
    setRegistros((prev) => [{ id: `${Date.now()}`, ...item }, ...prev].slice(0, 50));
  }

  function mostrarResultado(res) {
    setResultado(res);
    reproducirSonido(res.tipo);
    cierreTimeoutRef.current = setTimeout(() => cerrarOverlay(), DURACION_OVERLAY_MS);
  }

  async function cerrarOverlay() {
    clearTimeout(cierreTimeoutRef.current);
    setResultado(null);
    if (scannerRef.current) {
      try {
        await scannerRef.current.resume();
      } catch {
        /* noop */
      }
    }
  }

  const horario = HORARIOS[turno];

  return (
    <div className="flex-1 bg-background flex flex-col h-[calc(100dvh-64px-72px)] md:h-screen relative">
      {/* Control Header — tres columnas iguales (turno · reloj · tolerancia) para
          que el reloj quede centrado de verdad y los extremos queden simétricos. */}
      <div className="bg-surface shadow-sm border-b border-outline-variant px-margin-mobile md:px-margin-desktop py-4 flex flex-col md:flex-row md:items-center gap-3 z-10 no-print">
        {/* Turno + tolerancia (izquierda) */}
        <div className="flex flex-col gap-1 w-full md:w-auto md:flex-1 md:min-w-0">
          <label htmlFor="selector-turno" className="text-on-surface-variant font-label-md text-label-md uppercase tracking-wider">
            Turno
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full md:w-40">
              <Icon
                name={turno === TURNOS.MANANA ? 'wb_sunny' : 'wb_twilight'}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-primary text-[16px]"
              />
              <select
                id="selector-turno"
                value={turno}
                onChange={(e) => {
                  setTurno(e.target.value);
                  setTurnoAuto(false);
                }}
                disabled={escaneando || (!esAdmin && !!perfil?.turno)}
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
            {/* Toggle de turno automático por hora (solo admin). */}
            {esAdmin && (
              <button
                onClick={() => setTurnoAuto((v) => !v)}
                disabled={escaneando}
                title={turnoAuto ? 'Turno automático por hora (activado)' : 'Volver a turno automático por hora'}
                className={`flex items-center gap-1 shrink-0 h-9 px-2.5 rounded-lg border font-label-md text-label-md transition-colors disabled:opacity-60 ${
                  turnoAuto
                    ? 'bg-primary text-on-primary border-primary'
                    : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant hover:bg-surface-container-high'
                }`}
              >
                <Icon name="schedule" className="text-[16px]" />
                Auto
              </button>
            )}
            {/* Tolerancia: chip compacto al costado del selector de turno. */}
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

      {/* Área de cámara (ocupa todo el espacio; el registro va en un cajón). */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Scanner Viewport */}
        <div className="flex-1 bg-black relative flex items-center justify-center overflow-hidden min-h-[320px]">
          {/* El tamaño/centrado del <video> y el ocultado de los elementos
              extra de html5-qrcode se controlan en index.css (#qr-reader-region),
              para ganarle a los estilos inline de la librería. */}
          <div id={LECTOR_ID} />

          {!escaneando && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-inverse-surface/60">
              <button
                onClick={iniciarCamara}
                className="bg-primary text-on-primary font-title-md text-title-md px-8 py-4 rounded-xl shadow-lg flex items-center gap-3 hover:bg-primary-container hover:text-on-primary-container transition-colors"
              >
                <Icon name="videocam" />
                Iniciar Cámara
              </button>
            </div>
          )}

          {escaneando && (
            <div className="relative w-64 h-64 md:w-80 md:h-80 z-10 pointer-events-none">
              <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-primary-container rounded-tl-lg" />
              <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-primary-container rounded-tr-lg" />
              <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-primary-container rounded-bl-lg" />
              <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-primary-container rounded-br-lg" />
              <div className="absolute top-0 left-0 w-full h-1 bg-secondary-container shadow-[0_0_8px_2px_rgba(91,184,254,0.6)] scanner-line" />
            </div>
          )}

          <Overlay resultado={resultado} onCerrar={cerrarOverlay} />

          {escaneando && (
            <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 flex gap-4 z-10">
              <button
                onClick={detenerCamara}
                className="bg-surface/90 backdrop-blur-sm text-primary px-4 h-14 rounded-full flex items-center gap-2 shadow-lg border border-outline-variant font-label-md text-label-md"
              >
                <Icon name="stop_circle" />
                Detener
              </button>
            </div>
          )}
        </div>

        {/* Cajón lateral de "Registro Reciente": se abre desde la derecha al
            tocar el botón "Registros". Por defecto la cámara ocupa todo. */}
        {panelAbierto && (
          <>
            <div
              className="fixed inset-0 bg-black/40 z-40 no-print"
              onClick={() => setPanelAbierto(false)}
            />
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
    </div>
  );
}
