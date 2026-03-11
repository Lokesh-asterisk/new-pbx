import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useBranding } from '../context/BrandingContext';
import { API_BASE } from '../utils/api';
import { getRoleRedirectPath } from '../components/ProtectedRoute';
import ThemeToggle from '../components/ThemeToggle';
import './Login.css';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const { login } = useAuth();
  const { branding } = useBranding();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from?.pathname || '/';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const result = await login(username.trim(), password);
    if (result.success) {
      const redirect = from !== '/' && from !== '/login' ? from : getRoleRedirectPath(result.user?.role);
      setTimeout(() => navigate(redirect, { replace: true }), 0);
    } else {
      setError(result.error || 'Login failed');
    }
  };

  const logoSrc = branding.logoUrl && (branding.logoUrl.startsWith('http') ? branding.logoUrl : `${API_BASE || ''}${branding.logoUrl}`);
  const logoContent = branding.logoUrl
    ? <img src={logoSrc} alt="" className="login-logo-img" />
    : <span className="logo-icon">📞</span>;

  return (
    <div className="login-page">
      <div className="login-theme-toggle"><ThemeToggle /></div>
      <div className="login-card">
        <div className="login-header">
          <div className="login-logo">
            {logoContent}
            <h1>{branding.productName}</h1>
            <p>{branding.tagline || 'Sign in to your account'}</p>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="login-form">
          {error && <div className="login-error" role="alert" aria-live="polite">{error}</div>}
          <div className="form-group">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter username"
              autoComplete="username"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />
          </div>
          <p className="login-hint">Sign in with a user created in Super Admin. Agents need extension and PIN set in Edit phone / PIN.</p>
          {import.meta.env.DEV && (
            <p className="login-hint login-hint-muted">After seed: superadmin, admin, user, agent, agent2 — password: demo123. Run API with <code>npm run server</code> (port 3001).</p>
          )}
          <button type="submit" className="btn-login">Sign in</button>
        </form>
      </div>
    </div>
  );
}
