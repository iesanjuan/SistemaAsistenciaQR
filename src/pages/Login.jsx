import { useState } from 'react';
import { useAuth } from '../lib/AuthContext';
import { useUI } from '../lib/UIContext';
import Icon from '../components/Icon';

function leer(clave) {
  try {
    return localStorage.getItem(clave);
  } catch {
    return null;
  }
}

export default function Login() {
  const { iniciarSesion } = useAuth();
  const { toast } = useUI();
  // Si el usuario marcó "recordar", precargamos su correo.
  const recordado = leer('login-recordar') === '1';
  const [email, setEmail] = useState(recordado ? leer('login-email') || '' : '');
  const [password, setPassword] = useState('');
  const [verPass, setVerPass] = useState(false);
  const [recordar, setRecordar] = useState(recordado);
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function manejarSubmit(e) {
    e.preventDefault();
    setEnviando(true);
    setError('');
    const { error } = await iniciarSesion(email, password);
    setEnviando(false);
    if (error) {
      setError('Correo o contraseña incorrectos.');
      toast('Correo o contraseña incorrectos', 'error');
      return;
    }
    // Recordar (solo) el correo para no volver a escribirlo. La contraseña la
    // guarda el gestor del navegador (más seguro que en la app).
    try {
      if (recordar) {
        localStorage.setItem('login-recordar', '1');
        localStorage.setItem('login-email', email);
      } else {
        localStorage.removeItem('login-recordar');
        localStorage.removeItem('login-email');
      }
    } catch {
      /* almacenamiento no disponible */
    }
    toast('Bienvenido', 'exito');
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background font-body-md px-4">
      <form
        onSubmit={manejarSubmit}
        className="bg-surface-container-lowest rounded-xl shadow-md border border-outline-variant p-8 w-full max-w-sm"
      >
        <div className="flex flex-col items-center text-center gap-2 mb-6">
          <img src="/logo.png" alt="Escudo Colegio San Juan" className="w-16 h-16 object-contain shrink-0" />
          <div>
            <h1 className="font-headline-md text-headline-md font-black text-primary leading-tight">
              Asistencia San Juan
            </h1>
            <p className="text-on-surface-variant text-label-md">Acceso de auxiliares y administración</p>
          </div>
        </div>

        <label htmlFor="login-email" className="block font-label-md text-label-md text-on-surface-variant mb-1">
          Correo
        </label>
        <input
          id="login-email"
          name="email"
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-3 py-2 mb-4 bg-surface border border-outline-variant rounded-lg text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary transition-all"
        />

        <label htmlFor="login-password" className="block font-label-md text-label-md text-on-surface-variant mb-1">
          Contraseña
        </label>
        <div className="relative mb-4">
          <input
            id="login-password"
            name="password"
            type={verPass ? 'text' : 'password'}
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2 pr-11 bg-surface border border-outline-variant rounded-lg text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary transition-all"
          />
          <button
            type="button"
            onClick={() => setVerPass((v) => !v)}
            title={verPass ? 'Ocultar contraseña' : 'Ver contraseña'}
            aria-label={verPass ? 'Ocultar contraseña' : 'Ver contraseña'}
            tabIndex={-1}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-colors"
          >
            <Icon name={verPass ? 'visibility_off' : 'visibility'} className="text-[20px]" />
          </button>
        </div>

        <label className="flex items-center gap-2 mb-4 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={recordar}
            onChange={(e) => setRecordar(e.target.checked)}
            className="w-4 h-4 accent-primary"
          />
          <span className="font-label-md text-label-md text-on-surface-variant">Recordar mi correo</span>
        </label>

        {error && (
          <p className="text-error text-sm mb-4 flex items-center gap-1">
            <Icon name="error" className="text-[16px]" />
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={enviando}
          className="bg-brand-blue hover:bg-brand-blue-dark disabled:opacity-50 text-on-primary font-title-md text-title-md w-full py-2.5 rounded-lg transition-colors"
        >
          {enviando ? 'Ingresando...' : 'Ingresar'}
        </button>
      </form>
    </div>
  );
}
