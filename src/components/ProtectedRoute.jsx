import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const ROLE_ROUTES = {
  superadmin: '/dashboard',
  admin: '/dashboard',
  user: '/dashboard',
  campaign: '/dashboard',
  agent: '/agent',
};

const ROLE_IDS = { 1: 'superadmin', 2: 'admin', 3: 'user', 4: 'campaign', 5: 'agent' };

function normalizeRole(role) {
  if (role == null) return 'user';
  const r = ROLE_IDS[Number(role)] || role;
  return typeof r === 'string' ? r : 'user';
}

export function ProtectedRoute({ children, allowedRoles }) {
  const { user } = useAuth();
  const location = useLocation();
  const role = user ? normalizeRole(user.role) : null;

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (allowedRoles && !allowedRoles.includes(role)) {
    const redirectTo = ROLE_ROUTES[role] || '/';
    return <Navigate to={redirectTo} replace />;
  }

  return children;
}

export function getRoleRedirectPath(role) {
  return ROLE_ROUTES[normalizeRole(role)] || '/';
}
