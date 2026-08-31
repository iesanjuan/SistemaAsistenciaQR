import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useUI } from '../lib/UIContext';
import { fechaLocalISO } from '../utils/turnos';
import Icon from './Icon';
import Cargador from './Cargador';

// Tipos de día no lectivo. La clave se guarda en la base; el resto es para la UI
// (etiqueta, ícono, color de la insignia y placeholder del motivo).
const TIPOS = {
  FERIADO: {
    label: 'Feriado',
    icon: 'flag',
    chip: 'bg-amber-100 text-amber-800 border-amber-200',
    placeholder: 'Ej. Fiestas Patrias',
  },
  VACACIONES: {
    label: 'Vacaciones',
    icon: 'beach_access',
    chip: 'bg-indigo-100 text-indigo-800 border-indigo-200',
    placeholder: 'Ej. Vacaciones de fin de año',
  },
  OTRO: {
    label: 'Día no lectivo',
    icon: 'event_busy',
    chip: 'bg-surface-variant text-on-surface-variant border-outline-variant',
    placeholder: 'Ej. Día del maestro / suspensión de clases',
  },
};

function tipoInfo(tipo) {
  return TIPOS[tipo] || TIPOS.OTRO;
}

// Muestra una fecha "YYYY-MM-DD" como "lun, 28 jul 2026".
function formatearFecha(fechaISO) {
  return new Date(`${fechaISO}T00:00:00`).toLocaleDateString('es-PE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

// Texto legible del rango: un día suelto o "del X al Y".
function textoRango(inicio, fin) {
  if (inicio === fin) return formatearFecha(inicio);
  return `Del ${formatearFecha(inicio)} al ${formatearFecha(fin)}`;
}

// Cantidad de días de calendario que abarca el rango (inclusivo).
function contarDias(inicio, fin) {
  const ms = new Date(`${fin}T00:00:00`) - new Date(`${inicio}T00:00:00`);
  return Math.round(ms / 86400000) + 1;
}

export default function DiasNoLectivos() {
  const { toast, confirmar } = useUI();
  const [rangos, setRangos] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [tipo, setTipo] = useState('FERIADO');
  const [inicio, setInicio] = useState(fechaLocalISO());
  const [fin, setFin] = useState(fechaLocalISO());
  const [motivo, setMotivo] = useState('');
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    cargar();
  }, []);

  async function cargar() {
    setCargando(true);
    const { data, error } = await supabase
      .from('dias_no_lectivos')
      .select('id, tipo, fecha_inicio, fecha_fin, motivo')
      .order('fecha_inicio', { ascending: false });
    if (error) toast('No se pudieron cargar los días no lectivos', 'error');
    setRangos(data || []);
    setCargando(false);
  }

  // Al cambiar "Desde", si "Hasta" quedó antes, lo empareja para no dejar un
  // rango inválido (y facilitar el caso de un día suelto).
  function cambiarInicio(valor) {
    setInicio(valor);
    if (fin < valor) setFin(valor);
  }

  async function agregar(e) {
    e.preventDefault();
    if (guardando) return;
    if (!inicio || !fin) {
      toast('Elige las fechas de inicio y fin.', 'error');
      return;
    }
    if (fin < inicio) {
      toast('La fecha "Hasta" no puede ser anterior a "Desde".', 'error');
      return;
    }

    setGuardando(true);
    const { error } = await supabase.from('dias_no_lectivos').insert({
      tipo,
      fecha_inicio: inicio,
      fecha_fin: fin,
      // El motivo es opcional: si se deja vacío, usamos la etiqueta del tipo.
      motivo: motivo.trim() || tipoInfo(tipo).label,
    });
    setGuardando(false);

    if (error) {
      toast(error.message || 'No se pudo guardar el rango.', 'error');
      return;
    }

    setMotivo('');
    await cargar();
    toast('Período no lectivo agregado.', 'exito');
  }

  async function eliminar(rango) {
    const ok = await confirmar({
      titulo: 'Eliminar período',
      mensaje: `¿Quitar "${rango.motivo}" (${textoRango(rango.fecha_inicio, rango.fecha_fin)})? Esos días volverán a contar como clase en los reportes.`,
      confirmLabel: 'Eliminar',
      tono: 'peligro',
      icon: 'delete',
    });
    if (!ok) return;

    const { error } = await supabase.from('dias_no_lectivos').delete().eq('id', rango.id);
    if (error) {
      toast(error.message || 'No se pudo eliminar el período.', 'error');
      return;
    }
    await cargar();
    toast('Período eliminado.', 'exito');
  }

  return (
    <div className="p-margin-mobile md:p-margin-desktop pb-24 md:pb-margin-desktop w-full max-w-max-width mx-auto">
      {/* Encabezado */}
      <div className="mb-8">
        <h2 className="font-headline-lg-mobile md:font-headline-lg text-headline-lg-mobile md:text-headline-lg text-on-surface">
          Días no lectivos
        </h2>
        <p className="font-body-md text-body-md text-on-surface-variant mt-1">
          Registra feriados, vacaciones o días sin clases (un solo día o un período completo).
          En esas fechas el sistema no contará falta a los alumnos.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Formulario para agregar */}
        <form
          onSubmit={agregar}
          className="lg:col-span-1 bg-surface rounded-xl border border-outline-variant elevation-1 p-6 h-fit"
        >
          <h3 className="font-title-md text-title-md text-on-surface flex items-center gap-2 mb-4">
            <Icon name="event_busy" className="text-primary" />
            Agregar período
          </h3>

          <label className="block font-label-md text-label-md text-on-surface-variant mb-1">Tipo</label>
          <div className="grid grid-cols-3 gap-2 mb-4">
            {Object.entries(TIPOS).map(([clave, info]) => (
              <button
                key={clave}
                type="button"
                onClick={() => setTipo(clave)}
                className={`flex flex-col items-center gap-1 px-2 py-2.5 rounded-lg border text-label-md font-label-md transition-colors ${
                  tipo === clave
                    ? 'bg-primary-container text-on-primary-container border-primary/40'
                    : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant hover:bg-surface-container-low'
                }`}
              >
                <Icon name={info.icon} className="text-[22px]" fill={tipo === clave} />
                <span className="text-center leading-tight">{info.label}</span>
              </button>
            ))}
          </div>

          <label className="block font-label-md text-label-md text-on-surface-variant mb-1">Desde</label>
          <input
            type="date"
            value={inicio}
            onChange={(e) => cambiarInicio(e.target.value)}
            className="w-full px-3 py-2 mb-4 bg-surface-container-lowest border border-outline-variant rounded-lg text-on-surface focus:outline-none focus:border-secondary"
          />

          <label className="block font-label-md text-label-md text-on-surface-variant mb-1">Hasta</label>
          <input
            type="date"
            value={fin}
            min={inicio}
            onChange={(e) => setFin(e.target.value)}
            className="w-full px-3 py-2 mb-1 bg-surface-container-lowest border border-outline-variant rounded-lg text-on-surface focus:outline-none focus:border-secondary"
          />
          <p className="text-on-surface-variant text-label-md mb-4">
            Para un solo día, deja "Hasta" igual a "Desde".
          </p>

          <label className="block font-label-md text-label-md text-on-surface-variant mb-1">
            Descripción <span className="text-on-surface-variant/70">(opcional)</span>
          </label>
          <input
            type="text"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder={tipoInfo(tipo).placeholder}
            className="w-full px-3 py-2 mb-4 bg-surface-container-lowest border border-outline-variant rounded-lg text-on-surface focus:outline-none focus:border-secondary"
          />

          <button
            type="submit"
            disabled={guardando}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-brand-blue text-white rounded-lg hover:bg-brand-blue-dark transition-colors disabled:opacity-50 font-title-md text-title-md"
          >
            <Icon name={guardando ? 'progress_activity' : 'add'} className={guardando ? 'animate-spin' : ''} />
            {guardando ? 'Guardando…' : 'Agregar'}
          </button>
        </form>

        {/* Lista de períodos registrados */}
        <div className="lg:col-span-2 bg-surface rounded-xl border border-outline-variant elevation-1 overflow-hidden flex flex-col">
          <div className="p-4 border-b border-outline-variant bg-surface-container-lowest flex justify-between items-center">
            <h3 className="font-title-md text-title-md text-on-surface">Períodos registrados</h3>
            <span className="bg-surface-container-high text-primary px-2 py-1 rounded-md font-label-md text-label-md">
              {rangos.length}
            </span>
          </div>

          {cargando ? (
            <Cargador texto="Cargando fechas…" className="py-10" />
          ) : rangos.length === 0 ? (
            <p className="p-8 text-center text-on-surface-variant text-sm">
              Aún no hay días no lectivos registrados.
            </p>
          ) : (
            <ul className="divide-y divide-outline-variant">
              {rangos.map((r) => {
                const dias = contarDias(r.fecha_inicio, r.fecha_fin);
                const info = tipoInfo(r.tipo);
                return (
                  <li key={r.id} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-container-low transition-colors">
                    <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-error-container text-on-error-container shrink-0">
                      <Icon name={info.icon} className="text-[20px]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${info.chip}`}>
                          {info.label.toUpperCase()}
                        </span>
                        <p className="font-title-md text-title-md text-on-surface truncate">{r.motivo}</p>
                      </div>
                      <p className="font-body-md text-body-md text-on-surface-variant truncate mt-0.5">
                        {textoRango(r.fecha_inicio, r.fecha_fin)}
                        {dias > 1 && <span className="text-on-surface-variant"> · {dias} días</span>}
                      </p>
                    </div>
                    <button
                      onClick={() => eliminar(r)}
                      className="text-error hover:opacity-70 transition-colors p-1 shrink-0"
                      title="Eliminar"
                    >
                      <Icon name="delete" className="text-[20px]" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
