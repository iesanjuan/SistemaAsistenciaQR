import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useUI } from '../lib/UIContext';
import { seccionATurno, normalizarGrado, HORARIOS } from '../utils/turnos';
import Icon from './Icon';

// Herramienta para casos individuales (sin re-subir toda la nómina):
//  - Modificar un alumno buscándolo por su DNI/código (grado/sección, alta/baja).
//  - Agregar uno o dos alumnos nuevos manualmente.
export default function EditarAlumno() {
  const { toast } = useUI();
  const [modo, setModo] = useState('editar'); // 'editar' | 'nuevo'

  // --- Modo editar ---
  const [dni, setDni] = useState('');
  const [buscando, setBuscando] = useState(false);
  const [alumno, setAlumno] = useState(null);
  const [form, setForm] = useState(null);
  const [guardando, setGuardando] = useState(false);

  // --- Modo nuevo ---
  const [nuevo, setNuevo] = useState({ dni: '', apellidos: '', nombres: '', grado: '', seccion: '' });
  const [guardandoNuevo, setGuardandoNuevo] = useState(false);

  const [msg, setMsg] = useState(null);

  const turnoDerivado = form ? seccionATurno(form.seccion) : null;
  const turnoNuevo = seccionATurno(nuevo.seccion);

  function cambiarModo(m) {
    setModo(m);
    setMsg(null);
  }

  async function buscar(e) {
    e?.preventDefault();
    const q = dni.trim();
    if (!q) return;
    setBuscando(true);
    setMsg(null);
    setAlumno(null);
    setForm(null);

    const { data, error } = await supabase
      .from('estudiantes')
      .select('*')
      .eq('dni', q)
      .maybeSingle();

    setBuscando(false);
    if (error) {
      setMsg({ ok: false, texto: error.message });
      return;
    }
    if (!data) {
      setMsg({ ok: false, texto: `No se encontró ningún alumno con DNI/código ${q}.` });
      return;
    }
    setAlumno(data);
    setForm({
      nombres: data.nombres,
      apellidos: data.apellidos,
      grado: data.grado,
      seccion: data.seccion,
      activo: data.activo,
    });
  }

  async function guardar(e) {
    e.preventDefault();
    if (!alumno) return;
    if (!turnoDerivado) {
      setMsg({ ok: false, texto: 'La sección debe ser una letra A–H válida.' });
      return;
    }
    setGuardando(true);
    setMsg(null);

    const seccion = form.seccion.trim().toUpperCase();
    const { error } = await supabase
      .from('estudiantes')
      .update({
        nombres: form.nombres.trim(),
        apellidos: form.apellidos.trim(),
        grado: form.grado.trim(),
        seccion,
        turno: turnoDerivado,
        activo: form.activo,
      })
      .eq('id', alumno.id);

    setGuardando(false);
    if (error) {
      setMsg({ ok: false, texto: error.message });
      return;
    }
    setAlumno((a) => ({ ...a, ...form, seccion, turno: turnoDerivado }));
    setMsg({ ok: true, texto: 'Cambios guardados correctamente.' });
    toast('Alumno actualizado', 'exito');
  }

  async function guardarNuevo(e) {
    e.preventDefault();
    const dniN = nuevo.dni.trim().replace(/\s+/g, '');
    if (!/^\d{6,15}$/.test(dniN)) {
      setMsg({ ok: false, texto: 'DNI/código inválido: debe ser numérico, de 6 a 15 dígitos.' });
      return;
    }
    if (!nuevo.apellidos.trim() || !nuevo.nombres.trim() || !nuevo.grado.trim()) {
      setMsg({ ok: false, texto: 'Completa apellidos, nombres y grado.' });
      return;
    }
    if (!turnoNuevo) {
      setMsg({ ok: false, texto: 'La sección debe ser una letra A–H válida.' });
      return;
    }
    setGuardandoNuevo(true);
    setMsg(null);

    const { error } = await supabase.from('estudiantes').insert({
      dni: dniN,
      nombres: nuevo.nombres.trim(),
      apellidos: nuevo.apellidos.trim(),
      grado: normalizarGrado(nuevo.grado),
      seccion: nuevo.seccion.trim().toUpperCase(),
      turno: turnoNuevo,
      activo: true,
    });

    setGuardandoNuevo(false);
    if (error) {
      const dup = error.code === '23505' || /duplicate|unique/i.test(error.message || '');
      setMsg({
        ok: false,
        texto: dup
          ? `Ya existe un alumno con el DNI/código ${dniN}. Usa "Modificar existente" para editarlo.`
          : error.message,
      });
      return;
    }
    setMsg({
      ok: true,
      texto: `Alumno ${nuevo.apellidos.trim()}, ${nuevo.nombres.trim()} agregado correctamente.`,
    });
    toast('Alumno agregado', 'exito');
    setNuevo({ dni: '', apellidos: '', nombres: '', grado: '', seccion: '' });
  }

  const inputCls =
    'w-full px-3 py-2 bg-surface-container-lowest rounded-lg text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary';

  const TurnoBadge = ({ turno }) =>
    turno ? (
      <span
        className={`inline-flex items-center px-2 py-1 rounded-full text-[10px] font-bold border ${
          turno === 'MANANA'
            ? 'bg-amber-100 text-amber-800 border-amber-200'
            : 'bg-indigo-100 text-indigo-800 border-indigo-200'
        }`}
      >
        {HORARIOS[turno].label}
      </span>
    ) : (
      <span className="text-error inline-flex items-center gap-1">
        <Icon name="error" className="text-[16px]" /> Sección inválida
      </span>
    );

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      {/* Selector de modo */}
      <div className="inline-flex bg-surface-container-high rounded-lg p-1 self-start">
        {[
          { key: 'editar', label: 'Modificar existente', icon: 'edit' },
          { key: 'nuevo', label: 'Agregar nuevo', icon: 'person_add' },
        ].map((m) => (
          <button
            key={m.key}
            onClick={() => cambiarModo(m.key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-md font-label-md text-label-md transition-colors ${
              modo === m.key ? 'bg-surface-container-lowest text-primary shadow-sm' : 'text-on-surface-variant'
            }`}
          >
            <Icon name={m.icon} className="text-[18px]" />
            {m.label}
          </button>
        ))}
      </div>

      {msg && (
        <div
          className={`rounded-lg p-3 flex items-center gap-2 text-sm ${
            msg.ok ? 'bg-emerald-50 text-emerald-700 border border-emerald-300' : 'bg-red-50 text-error border border-red-300'
          }`}
        >
          <Icon name={msg.ok ? 'check_circle' : 'error'} className="text-[18px]" />
          {msg.texto}
        </div>
      )}

      {/* ───────────── Modo: modificar existente ───────────── */}
      {modo === 'editar' && (
        <>
          <div>
            <h3 className="font-title-lg text-title-lg text-on-surface">Modificar alumno por DNI</h3>
            <p className="font-body-md text-body-md text-on-surface-variant mt-1">
              Busca un alumno por su DNI o código y cambia su grado/sección (el turno se ajusta
              automáticamente) o su estado (activo/inactivo).
            </p>
          </div>

          <form onSubmit={buscar} className="flex gap-2">
            <input
              value={dni}
              onChange={(e) => setDni(e.target.value)}
              placeholder="DNI o código del alumno"
              inputMode="numeric"
              className={inputCls}
            />
            <button
              type="submit"
              disabled={buscando || !dni.trim()}
              className="shrink-0 px-5 py-2 bg-primary text-on-primary rounded-lg font-label-md text-label-md hover:bg-primary-container hover:text-on-primary-container transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              <Icon name="search" className="text-[18px]" />
              {buscando ? 'Buscando…' : 'Buscar'}
            </button>
          </form>

          {alumno && form && (
            <form
              onSubmit={guardar}
              className="bg-surface-container-lowest rounded-xl elevation-1 p-6 flex flex-col gap-4"
            >
              <div className="flex items-center gap-2 text-on-surface-variant text-sm">
                <Icon name="badge" className="text-[18px]" />
                {String(alumno.dni).length > 10 ? 'Código' : 'DNI'}:{' '}
                <strong className="text-on-surface">{alumno.dni}</strong>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-label-md text-label-md text-on-surface-variant mb-1">Apellidos</label>
                  <input
                    value={form.apellidos}
                    onChange={(e) => setForm((f) => ({ ...f, apellidos: e.target.value }))}
                    className={inputCls}
                    required
                  />
                </div>
                <div>
                  <label className="block font-label-md text-label-md text-on-surface-variant mb-1">Nombres</label>
                  <input
                    value={form.nombres}
                    onChange={(e) => setForm((f) => ({ ...f, nombres: e.target.value }))}
                    className={inputCls}
                    required
                  />
                </div>
                <div>
                  <label className="block font-label-md text-label-md text-on-surface-variant mb-1">Grado (ej: 3°)</label>
                  <input
                    value={form.grado}
                    onChange={(e) => setForm((f) => ({ ...f, grado: e.target.value }))}
                    className={inputCls}
                    required
                  />
                </div>
                <div>
                  <label className="block font-label-md text-label-md text-on-surface-variant mb-1">Sección (A–H)</label>
                  <input
                    value={form.seccion}
                    onChange={(e) => setForm((f) => ({ ...f, seccion: e.target.value.toUpperCase() }))}
                    maxLength={1}
                    className={inputCls}
                    required
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 text-sm">
                <span className="text-on-surface-variant">Turno resultante:</span>
                <TurnoBadge turno={turnoDerivado} />
              </div>

              <label className="flex items-center gap-2 text-body-md text-on-surface cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.activo}
                  onChange={(e) => setForm((f) => ({ ...f, activo: e.target.checked }))}
                />
                Alumno activo (desmárcalo para darlo de baja sin borrar su historial)
              </label>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="submit"
                  disabled={guardando || !turnoDerivado}
                  className="px-6 py-2 bg-brand-blue text-white rounded-lg hover:bg-brand-blue-dark transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  <Icon name="save" className="text-[18px]" />
                  {guardando ? 'Guardando…' : 'Guardar cambios'}
                </button>
              </div>
            </form>
          )}
        </>
      )}

      {/* ───────────── Modo: agregar nuevo ───────────── */}
      {modo === 'nuevo' && (
        <>
          <div>
            <h3 className="font-title-lg text-title-lg text-on-surface">Agregar alumno nuevo</h3>
            <p className="font-body-md text-body-md text-on-surface-variant mt-1">
              Registra uno o dos alumnos manualmente, sin subir un Excel. El turno se asigna solo
              según la sección. Tras guardar, el formulario queda listo para el siguiente.
            </p>
          </div>

          <form
            onSubmit={guardarNuevo}
            className="bg-surface-container-lowest rounded-xl elevation-1 p-6 flex flex-col gap-4"
          >
            <div>
              <label className="block font-label-md text-label-md text-on-surface-variant mb-1">
                DNI o código
              </label>
              <input
                value={nuevo.dni}
                onChange={(e) => setNuevo((n) => ({ ...n, dni: e.target.value }))}
                placeholder="Ej. 78654321"
                inputMode="numeric"
                className={inputCls}
                required
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block font-label-md text-label-md text-on-surface-variant mb-1">Apellidos</label>
                <input
                  value={nuevo.apellidos}
                  onChange={(e) => setNuevo((n) => ({ ...n, apellidos: e.target.value }))}
                  className={inputCls}
                  required
                />
              </div>
              <div>
                <label className="block font-label-md text-label-md text-on-surface-variant mb-1">Nombres</label>
                <input
                  value={nuevo.nombres}
                  onChange={(e) => setNuevo((n) => ({ ...n, nombres: e.target.value }))}
                  className={inputCls}
                  required
                />
              </div>
              <div>
                <label className="block font-label-md text-label-md text-on-surface-variant mb-1">Grado (ej: 3°)</label>
                <input
                  value={nuevo.grado}
                  onChange={(e) => setNuevo((n) => ({ ...n, grado: e.target.value }))}
                  placeholder="Ej. 3°"
                  className={inputCls}
                  required
                />
              </div>
              <div>
                <label className="block font-label-md text-label-md text-on-surface-variant mb-1">Sección (A–H)</label>
                <input
                  value={nuevo.seccion}
                  onChange={(e) => setNuevo((n) => ({ ...n, seccion: e.target.value.toUpperCase() }))}
                  maxLength={1}
                  className={inputCls}
                  required
                />
              </div>
            </div>

            <div className="flex items-center gap-2 text-sm">
              <span className="text-on-surface-variant">Turno resultante:</span>
              {nuevo.seccion.trim() ? (
                <TurnoBadge turno={turnoNuevo} />
              ) : (
                <span className="text-on-surface-variant/70">se define con la sección</span>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="submit"
                disabled={guardandoNuevo}
                className="px-6 py-2 bg-brand-blue text-white rounded-lg hover:bg-brand-blue-dark transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                <Icon name="person_add" className="text-[18px]" />
                {guardandoNuevo ? 'Guardando…' : 'Agregar alumno'}
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
