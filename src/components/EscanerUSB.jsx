import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import {
  evaluarEstado,
  fechaLocalISO,
  formatearHora,
  formatearHoraDesdeTexto,
  HORA_MAXIMA_ESCANEO,
  HORA_MINIMA_ESCANEO,
  HORARIOS,
  ventanaEscaneo,
  TURNOS,
} from '../utils/turnos';
import Icon from './Icon';
import { desbloquearAudio, reproducirSonido } from '../utils/sonidos';

// ============================================================================
// Escáner USB (lector físico tipo "keyboard wedge", p. ej. Advance ADV-6012N).
// Estos lectores se comportan como un TECLADO: al leer un código lo "escriben"
// carácter por carácter y terminan con Enter. Por eso aquí NO usamos cámara:
// basta un campo de texto siempre enfocado que reciba lo tecleado y procese la
// marcación al presionar Enter. Reusa las mismas reglas de turnos.js que el
// escáner de cámara (ventana horaria, tolerancia, turno) y guarda en la misma
// tabla `asistencias`.
// ============================================================================

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
      <p className="mt-8 text-white/60 text-xs">Toca la pantalla para continuar</p>
    </div>
  );
}

export default function EscanerUSB() {
  const { perfil, esAdmin } = useAuth();
  const [turno, setTurno] = useState(perfil?.turno || TURNOS.MANANA);
  const [resultado, setResultado] = useState(null);
  const [procesando, setProcesando] = useState(false);
  const [reloj, setReloj] = useState(new Date());
  const [registros, setRegistros] = useState([]);
  const [codigo, setCodigo] = useState('');
  const [panelAbierto, setPanelAbierto] = useState(false);
  const inputRef = useRef(null);
  const cierreTimeoutRef = useRef(null);
  const audioListoRef = useRef(false);

  useEffect(() => {
    if (perfil?.turno && !esAdmin) setTurno(perfil.turno);
  }, [perfil, esAdmin]);

  useEffect(() => {
    const t = setInterval(() => setReloj(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    cargarRegistrosHoy();
  }, []);

  // Mantener el campo enfocado para que el lector USB siempre "escriba" aquí.
  // Se reenfoca al montar, al cerrar el overlay y al volver a la pestaña.
  useEffect(() => {
    if (!resultado && !panelAbierto) inputRef.current?.focus();
  }, [resultado, panelAbierto]);

  useEffect(() => {
    const reenfocar = () => {
      if (!resultado && !panelAbierto) inputRef.current?.focus();
    };
    window.addEventListener('focus', reenfocar);
    return () => window.removeEventListener('focus', reenfocar);
  }, [resultado, panelAbierto]);

  async function cargarRegistrosHoy() {
    const hoy = fechaLocalISO();
    const { data } = await supabase
      .from('asistencias')
      .select('id, hora_ingreso, estado, estudiantes(nombres, apellidos, grado, seccion)')
      .eq('fecha', hoy)
      .order('hora_ingreso', { ascending: false })
      .limit(50);
    if (data) {
      setRegistros(
        data.map((r) => ({
          id: r.id,
          tipo: r.estado,
          nombre: `${r.estudiantes?.nombres || ''} ${r.estudiantes?.apellidos || ''}`.trim(),
          gradoSeccion: `${r.estudiantes?.grado || ''} "${r.estudiantes?.seccion || ''}"`,
          hora: r.hora_ingreso,
        }))
      );
    }
  }

  // El navegador solo deja sonar el audio tras un gesto del usuario. Las
  // pulsaciones del lector USB cuentan como gesto, así que desbloqueamos el
  // audio la primera vez que llega una tecla o un clic.
  function asegurarAudio() {
    if (audioListoRef.current) return;
    audioListoRef.current = true;
    desbloquearAudio();
  }

  function manejarSubmit(e) {
    e.preventDefault();
    const valor = codigo.trim();
    setCodigo('');
    if (!valor || procesando) return;
    procesar(valor);
  }

  async function procesar(dni) {
    setProcesando(true);
    await registrarMarcacion(dni);
    setProcesando(false);
    inputRef.current?.focus();
  }

  async function registrarMarcacion(dni) {
    const ahora = new Date();

    // Compuerta horaria global: fuera del horario de atención no se registra.
    const ventana = ventanaEscaneo(ahora);
    if (ventana !== 'OK') {
      const detalle =
        ventana === 'ANTES'
          ? `Solo se puede marcar a partir de las ${formatearHoraDesdeTexto(HORA_MINIMA_ESCANEO)}.`
          : `Solo se puede marcar hasta las ${formatearHoraDesdeTexto(HORA_MAXIMA_ESCANEO)}.`;
      mostrarResultado({ tipo: 'FUERA_DE_HORARIO', detalle });
      return;
    }

    const { data: estudiante, error: errBusqueda } = await supabase
      .from('estudiantes')
      .select('*')
      .eq('dni', dni)
      .eq('activo', true)
      .maybeSingle();

    if (errBusqueda || !estudiante) {
      mostrarResultado({ tipo: 'NO_ENCONTRADO', detalle: `Código leído: ${dni}` });
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

    const estado = evaluarEstado(turno, ahora);
    const fecha = fechaLocalISO(ahora);
    const horaIngreso = ahora.toTimeString().slice(0, 8);

    const { error: errInsert } = await supabase.from('asistencias').insert({
      estudiante_id: estudiante.id,
      fecha,
      hora_ingreso: horaIngreso,
      estado,
      registrado_por: perfil?.id,
    });

    if (errInsert) {
      if (errInsert.code === '23505') {
        mostrarResultado({ tipo: 'DUPLICADO', nombreCompleto, detalle: 'Ya tiene una marcación registrada hoy.' });
      } else {
        mostrarResultado({ tipo: 'ERROR', nombreCompleto, detalle: errInsert.message });
      }
      return;
    }

    mostrarResultado({
      tipo: estado,
      nombreCompleto: `${nombreCompleto} - ${gradoSeccion}`,
      hora: formatearHora(ahora),
    });
    agregarAlLog({ tipo: estado, nombre: nombreCompleto, gradoSeccion, hora: horaIngreso });
  }

  function agregarAlLog(item) {
    setRegistros((prev) => [{ id: `${Date.now()}`, ...item }, ...prev].slice(0, 50));
  }

  function mostrarResultado(res) {
    setResultado(res);
    reproducirSonido(res.tipo);
    cierreTimeoutRef.current = setTimeout(() => cerrarOverlay(), DURACION_OVERLAY_MS);
  }

  function cerrarOverlay() {
    clearTimeout(cierreTimeoutRef.current);
    setResultado(null);
    inputRef.current?.focus();
  }

  const horario = HORARIOS[turno];

  return (
    <div className="flex-1 bg-background flex flex-col h-[calc(100dvh-64px-72px)] md:h-screen relative">
      {/* Control Header: turno + tolerancia (izq) · reloj (centro) · registros (der) */}
      <div className="bg-surface shadow-sm border-b border-outline-variant px-margin-mobile md:px-margin-desktop py-4 flex flex-col md:flex-row md:items-center gap-3 z-10 no-print">
        {/* Turno + tolerancia (izquierda) */}
        <div className="flex flex-col gap-1 w-full md:w-auto md:flex-1 md:min-w-0">
          <label htmlFor="selector-turno-usb" className="text-on-surface-variant font-label-md text-label-md uppercase tracking-wider">
            Turno
          </label>
          <div className="flex items-center gap-2">
            <div className="relative w-full md:w-40">
              <Icon
                name={turno === TURNOS.MANANA ? 'wb_sunny' : 'wb_twilight'}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-primary text-[16px]"
              />
              <select
                id="selector-turno-usb"
                value={turno}
                onChange={(e) => setTurno(e.target.value)}
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

      {/* Zona central: campo de captura del lector USB */}
      <div className="flex-1 flex items-center justify-center overflow-hidden relative p-6">
        <form onSubmit={manejarSubmit} className="w-full max-w-lg flex flex-col items-center text-center gap-6">
          <div className={`flex items-center justify-center w-24 h-24 rounded-full ${procesando ? 'bg-primary/20' : 'bg-primary-container'} transition-colors`}>
            <Icon name="barcode_reader" className="text-primary" style={{ fontSize: 56 }} />
          </div>

          <div>
            <h2 className="font-headline-lg-mobile md:font-headline-lg text-headline-lg-mobile md:text-headline-lg text-on-surface">
              Escáner USB
            </h2>
            <p className="font-body-md text-body-md text-on-surface-variant mt-1">
              Apunta el lector al QR del carnet. El código se registra automáticamente.
              También puedes escribir el DNI/código y presionar Enter.
            </p>
          </div>

          <input
            ref={inputRef}
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
            onKeyDown={asegurarAudio}
            onFocus={asegurarAudio}
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            placeholder="Esperando lectura…"
            className="w-full text-center text-2xl md:text-3xl tracking-widest tabular-nums py-4 px-4 rounded-2xl bg-surface-container-lowest text-on-surface border-2 border-outline-variant focus:outline-none focus-visible:border-primary transition-colors"
          />

          <div className="flex items-center gap-2 text-on-surface-variant font-label-md text-label-md">
            <span className={`w-2.5 h-2.5 rounded-full ${procesando ? 'bg-amber-500' : 'bg-green-500 animate-pulse'}`} />
            {procesando ? 'Registrando…' : 'Listo para escanear'}
          </div>

          <button
            type="submit"
            disabled={!codigo.trim() || procesando}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-primary text-on-primary font-label-md text-label-md hover:bg-primary-container hover:text-on-primary-container transition-colors disabled:opacity-50"
          >
            <Icon name="check_circle" className="text-[20px]" />
            Registrar
          </button>
        </form>

        <Overlay resultado={resultado} onCerrar={cerrarOverlay} />
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
