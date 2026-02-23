import { createContext, useContext, useState, useCallback, useEffect } from 'react';

const ROLES = {
  SUPERADMIN: 'superadmin',
  ADMIN: 'admin',
  USER: 'user',
  AGENT: 'agent',
};

const API_BASE = import.meta.env.VITE_API_URL || '';

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  return res;
}

// Demo fallback when API is not available
const DEMO_USERS = {
  superadmin: { password: 'demo123', name: 'Super Admin' },
  admin: { password: 'demo123', name: 'Admin' },
  user: { password: 'demo123', name: 'User' },
  agent: { password: 'demo123', name: 'Agent' },
};

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = sessionStorage.getItem('pbx_user');
    return stored ? JSON.parse(stored) : null;
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
    const effectiveUsername = (username || '').trim().toLowerCase();
    if (!effectiveUsername) {
      return { success: false, error: 'Username is required' };
    }

    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: effectiveUsername, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success && data.user) {
        const userData = {
          ...data.user,
          displayName: data.user.username?.charAt(0).toUpperCase() + data.user.username?.slice(1) || data.user.username,
        };
        persistUser(userData);
        return { success: true, user: userData };
      }
    } catch (_) {}

    const account = DEMO_USERS[effectiveUsername];
    if (account && account.password === password) {
      const userData = {
        username: effectiveUsername,
        role: effectiveUsername,
        displayName: account.name,
      };
      persistUser(userData);
      return { success: true, user: userData };
    }
    return { success: false, error: 'Invalid credentials. Use username agent/admin/user/superadmin and password demo123' };
  }, [persistUser]);

  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (_) {}
    persistUser(null);
  }, [persistUser]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/auth/me');
        const data = await res.json().catch(() => ({}));
        if (!cancelled && data.success && data.user) {
          const userData = {
            ...data.user,
            displayName: data.user.username?.charAt(0).toUpperCase() + data.user.username?.slice(1) || data.user.username,
          };
          persistUser(userData);
        }
      } catch (_) {}
      if (!cancelled) setAuthReady(true);
    })();
    return () => { cancelled = true; };
  }, [persistUser]);

  const value = { user, login, logout, authReady, ROLES };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export { ROLES };
