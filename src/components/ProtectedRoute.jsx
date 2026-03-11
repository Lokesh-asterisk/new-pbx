import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { normalizeRole, getRoleRedirectPath } from '../utils/roles.js';

export function ProtectedRoute({ children, allowedRoles }) {
  const { user } = useAuth();
  const location = useLocation();
  const role = user ? normalizeRole(user.role) : null;

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (allowedRoles && !allowedRoles.includes(role)) {
    const redirectTo = getRoleRedirectPath(role);
    return <Navigate to={redirectTo} replace />;
  }

  return children;
}

export { getRoleRedirectPath };
