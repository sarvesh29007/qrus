import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, tokens } from '../api/client.js';

const AuthContext = createContext(null);

const HOME_BY_ROLE = {
  patient: '/patient',
  doctor: '/doctor',
  admin: '/admin',
};

export function homeForRole(role) {
  return HOME_BY_ROLE[role] || '/login';
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(Boolean(tokens.access || tokens.refresh));

  const loadSession = useCallback(async () => {
    if (!tokens.access && !tokens.refresh) {
      setUser(null);
      setBooting(false);
      return;
    }
    try {
      const data = await api('/auth/me');
      setUser(data.user);
    } catch {
      tokens.clear();
      setUser(null);
    } finally {
      setBooting(false);
    }
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  const login = useCallback(async (email, password) => {
    const data = await api('/auth/login', { method: 'POST', body: { email, password }, auth: false });
    tokens.set(data.accessToken, data.refreshToken);
    setUser(data.user);
    return data.user;
  }, []);

  const register = useCallback(async (payload) => {
    const data = await api('/auth/register', { method: 'POST', body: payload, auth: false });
    tokens.set(data.accessToken, data.refreshToken);
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      if (tokens.access) await api('/auth/logout', { method: 'POST' });
    } catch {
      /* the local session is dropped either way */
    }
    tokens.clear();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, booting, login, register, logout, reload: loadSession, homeForRole }),
    [user, booting, login, register, logout, loadSession]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
