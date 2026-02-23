import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const ROLE_ROUTES = {
  superadmin: '/superadmin',
  admin: '/admin',
  user: '/user',
  agent: '/agent',
};

export function ProtectedRoute({ children, allowedRoles }) {
  const { user } = useAuth();
  const location = useLocation();

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    const redirectTo = ROLE_ROUTES[user.role] || '/';
    return <Navigate to={redirectTo} replace />;
  }

  return children;
}

export function getRoleRedirectPath(role) {
  return ROLE_ROUTES[role] || '/';
}
