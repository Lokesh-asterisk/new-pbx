import { createContext, useContext, useState, useCallback, useEffect } from 'react';

const ROLES = {
  SUPERADMIN: 'superadmin',
  ADMIN: 'admin',
  USER: 'user',
  AGENT: 'agent',
};

const ROLE_IDS = { 1: 'superadmin', 2: 'admin', 3: 'user', 4: 'campaign', 5: 'agent' };
function normalizeRole(role) {
  if (role == null) return 'user';
  const r = ROLE_IDS[Number(role)] || role;
  return typeof r === 'string' ? r : 'user';
}

const API_BASE = import.meta.env.DEV ? '' : (import.meta.env.VITE_API_URL || '');

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  return res;
}

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      const stored = sessionStorage.getItem('pbx_user');
      if (!stored) return null;
      const u = JSON.parse(stored);
      if (u) u.role = normalizeRole(u.role);
      return u;
    } catch {
      return null;
    }
  });
  const [authReady, setAuthReady] = useState(false);

  const persistUser = useCallback((userData) => {
    setUser(userData);
    if (userData) {
      sessionStorage.setItem('pbx_user', JSON.stringify(userData));
    } else {
      sessionStorage.removeItem('pbx_user');
    }
  }, []);

  const login = useCallback(async (username, password) => {
    const effectiveUsername = (username || '').trim();
    if (!effectiveUsername) {
      return { success: false, error: 'Username is required' };
    }

    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: effectiveUsername, password }),
      });
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { error: 'Server returned an invalid response. Is the API running (e.g. port 3001)?' };
      }
      if (res.ok && data.success && data.user) {
        const userData = {
          ...data.user,
          role: normalizeRole(data.user.role),
          displayName: data.user.username?.charAt(0).toUpperCase() + data.user.username?.slice(1) || data.user.username,
        };
        persistUser(userData);
        return { success: true, user: userData };
      }
      return { success: false, error: data.error || 'Invalid credentials' };
    } catch (e) {
      const msg = e?.message || '';
      const isNetwork = /failed to fetch|network|load/i.test(msg) || (e?.name === 'TypeError' && !msg);
      return {
        success: false,
        error: isNetwork
          ? 'Cannot reach server. Start the API (e.g. npm run server on port 3001) and check your connection.'
          : 'Login failed. Check your connection.',
      };
    }
  }, [persistUser]);

  const logout = useCallback(async () => {
    try {
      if (user?.role === 'agent') {
        await apiFetch('/api/agent/logout', { method: 'POST' });
      }
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (_) {}
    persistUser(null);
  }, [persistUser, user?.role]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/auth/me');
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.status === 401 || !res.ok) {
          persistUser(null);
        } else if (data.success && data.user) {
          const userData = {
            ...data.user,
            role: normalizeRole(data.user.role),
            displayName: data.user.username?.charAt(0).toUpperCase() + data.user.username?.slice(1) || data.user.username,
          };
          persistUser(userData);
        }
      } catch (_) {}
      if (!cancelled) setAuthReady(true);
    })();
    return () => { cancelled = true; };
  }, [persistUser]);

  // Periodic auth check: when session is destroyed (e.g. force-logout), clear user so app redirects to login
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(async () => {
      try {
        const res = await apiFetch('/api/auth/me');
        if (res.status === 401) {
          persistUser(null);
        }
      } catch (_) {}
    }, 20000);
    return () => clearInterval(interval);
  }, [user, persistUser]);

  const value = { user, login, logout, authReady, ROLES };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export { ROLES };
