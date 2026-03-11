import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useBranding } from '../context/BrandingContext';
import { API_BASE } from '../utils/api';
import ThemeToggle from './ThemeToggle';
import './Layout.css';

function logoSrc(url) {
  return url && (url.startsWith('http') ? url : `${API_BASE || ''}${url}`);
}

export default function Layout({ children, title, subtitle }) {
  const { user, logout } = useAuth();
  const { branding } = useBranding();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const logoContent = branding.logoUrl
    ? <img src={logoSrc(branding.logoUrl)} alt="" className="header-logo header-logo-img" />
    : <span className="header-logo">📞</span>;

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="header-left">
          {logoContent}
          <div>
            <h1 className="header-title">{title}</h1>
            {subtitle && <p className="header-subtitle">{subtitle}</p>}
          </div>
        </div>
        <div className="header-right">
          <ThemeToggle />
          <span className="user-badge">{user?.displayName || user?.role}</span>
          <span className="role-tag">{user?.role}</span>
          <button type="button" className="btn-logout" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
