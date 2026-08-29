import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import { useUI } from '../lib/UIContext';
import { HORARIOS } from '../utils/turnos';
import Icon from './Icon';

// Longitud mínima de contraseña que exige Supabase Auth por defecto.
const MIN_PASSWORD = 6;

// Iniciales para el avatar: primeras letras de los dos primeros nombres.
function iniciales(perfil) {
  const base = perfil?.nombres || perfil?.email || '';
  const partes = base.trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '';
  return partes
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
}

// Fila de dato (etiqueta + valor) con ícono, para el bloque de detalles.
function Dato({ icon, etiqueta, valor }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <Icon name={icon} className="text-primary shrink-0 mt-0.5" />
      <div className="min-w-0">
        <p className="text-on-surface-variant text-label-md font-label-md uppercase tracking-wider">{etiqueta}</p>
        <p className="text-on-surface text-body-lg font-body-lg break-words">{valor || '—'}</p>
      </div>
    </div>
  );
}

export default function Perfil() {
  const { perfil, cerrarSesion } = useAuth();
  const { confirmar, toast } = useUI();

  const [nueva, setNueva] = useState('');
  const [confirmacion, setConfirmacion] = useState('');
  const [verClave, setVerClave] = useState(false);
  const [guardando, setGuardando] = useState(false);

  const esAdmin = perfil?.rol === 'ADMIN';
  const ini = iniciales(perfil);
  const rolTexto = esAdmin ? 'Administrador' : 'Auxiliar';
  const turnoTexto = esAdmin
    ? 'Ambos turnos'
    : perfil?.turno
      ? HORARIOS[perfil.turno]?.label || perfil.turno
      : 'Sin turno asignado';

  async function manejarCerrarSesion() {
    const ok = await confirmar({
      titulo: 'Cerrar sesión',
      mensaje: '¿Seguro que quieres salir de tu cuenta?',
      confirmLabel: 'Cerrar sesión',
      tono: 'peligro',
      icon: 'logout',
    });
    if (!ok) return;
    toast('Sesión cerrada', 'info');
    await cerrarSesion();
  }

  async function manejarCambioClave(e) {
    e.preventDefault();
    if (guardando) return;

    if (nueva.length < MIN_PASSWORD) {
      toast(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`, 'error');
      return;
    }
    if (nueva !== confirmacion) {
      toast('Las contraseñas no coinciden.', 'error');
      return;
    }

    setGuardando(true);
    const { error } = await supabase.auth.updateUser({ password: nueva });
    setGuardando(false);

    if (error) {
      toast(error.message || 'No se pudo actualizar la contraseña.', 'error');
      return;
    }

    setNueva('');
    setConfirmacion('');
    setVerClave(false);
    toast('Contraseña actualizada correctamente.', 'exito');
  }

  return (
    <div className="bg-background min-h-full">
      {/* Encabezado de la pantalla */}
      <div className="bg-surface shadow-sm px-margin-mobile md:px-margin-desktop py-4">
        <h2 className="font-headline-md text-headline-md font-black text-primary flex items-center gap-2">
          <Icon name="account_circle" className="text-primary" fill />
          Mi Perfil
        </h2>
      </div>

      <div className="px-margin-mobile md:px-margin-desktop py-6 max-w-2xl mx-auto">
        {/* Tarjeta de cabecera con avatar */}
        <div className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 flex items-center gap-4">
          <div className="flex items-center justify-center w-16 h-16 rounded-full bg-primary-container text-on-primary-container font-headline-md text-headline-md font-bold shrink-0">
            {ini || <Icon name="person" />}
          </div>
          <div className="min-w-0">
            <p className="text-on-surface text-title-lg font-title-lg font-bold truncate">
              {perfil?.nombres || perfil?.email}
            </p>
            <span className="inline-flex items-center gap-1 mt-1 bg-primary-container text-on-primary-container px-2.5 py-0.5 rounded-full font-label-md text-label-md">
              <Icon name={esAdmin ? 'shield_person' : 'badge'} className="text-[16px]" />
              {rolTexto}
            </span>
          </div>
        </div>

        {/* Detalles de la cuenta */}
        <div className="bg-surface-container-low border border-outline-variant rounded-2xl mt-4 px-6 py-2 divide-y divide-outline-variant/50">
          <Dato icon="mail" etiqueta="Correo" valor={perfil?.email} />
          <Dato icon="badge" etiqueta="DNI" valor={perfil?.dni} />
          <Dato icon="schedule" etiqueta="Turno" valor={turnoTexto} />
          {!esAdmin && (
            <div className="flex items-start gap-3 py-3">
              <Icon name="school" className="text-primary shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-on-surface-variant text-label-md font-label-md uppercase tracking-wider">
                  Secciones a cargo
                </p>
                {perfil?.secciones?.length ? (
                  <div className="flex flex-wrap gap-2 mt-1.5">
                    {perfil.secciones.map((s) => (
                      <span
                        key={`${s.grado}-${s.seccion}`}
                        className="bg-surface-container-high text-on-surface px-2.5 py-1 rounded-md font-label-md text-label-md border border-outline-variant"
                      >
                        {s.grado} "{s.seccion}"
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-on-surface text-body-lg font-body-lg">Sin secciones asignadas</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Cambiar contraseña */}
        <form
          onSubmit={manejarCambioClave}
          className="bg-surface-container-low border border-outline-variant rounded-2xl mt-4 p-6"
        >
          <h3 className="font-title-lg text-title-lg text-on-surface flex items-center gap-2">
            <Icon name="lock" className="text-primary" />
            Cambiar contraseña
          </h3>
          <p className="text-on-surface-variant text-body-md font-body-md mt-1">
            Cambia la contraseña temporal que te asignó el administrador por una propia.
          </p>

          <div className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-on-surface-variant text-label-md font-label-md">Nueva contraseña</span>
              <input
                type={verClave ? 'text' : 'password'}
                value={nueva}
                onChange={(e) => setNueva(e.target.value)}
                autoComplete="new-password"
                placeholder={`Mínimo ${MIN_PASSWORD} caracteres`}
                className="w-full px-3 py-2 rounded-lg bg-surface-container-lowest text-on-surface border border-outline-variant focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-on-surface-variant text-label-md font-label-md">Confirmar contraseña</span>
              <input
                type={verClave ? 'text' : 'password'}
                value={confirmacion}
                onChange={(e) => setConfirmacion(e.target.value)}
                autoComplete="new-password"
                placeholder="Repite la nueva contraseña"
                className="w-full px-3 py-2 rounded-lg bg-surface-container-lowest text-on-surface border border-outline-variant focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              />
            </label>

            <label className="flex items-center gap-2 text-on-surface-variant text-body-md font-body-md cursor-pointer select-none">
              <input
                type="checkbox"
                checked={verClave}
                onChange={(e) => setVerClave(e.target.checked)}
                className="accent-primary w-4 h-4"
              />
              Mostrar contraseña
            </label>

            <button
              type="submit"
              disabled={guardando}
              className="mt-1 w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-brand-blue text-white hover:bg-brand-blue-dark transition-colors font-title-md text-title-md disabled:opacity-60"
            >
              <Icon name={guardando ? 'progress_activity' : 'save'} className={guardando ? 'animate-spin' : ''} />
              {guardando ? 'Guardando…' : 'Actualizar contraseña'}
            </button>
          </div>
        </form>

        {/* Cerrar sesión */}
        <button
          onClick={manejarCerrarSesion}
          className="mt-6 w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-error/40 text-error hover:bg-error/10 transition-colors font-title-md text-title-md"
        >
          <Icon name="logout" />
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}
