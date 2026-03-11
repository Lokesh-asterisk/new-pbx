import { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { apiFetch } from '../../utils/api';

const ROLE_LABEL = { 2: 'Admin', 3: 'User', 5: 'Agent' };
const MANAGEABLE_ROLES = [2, 3, 5];

const RolePermissionsView = memo(function RolePermissionsView() {
  const [roleModules, setRoleModules] = useState({});
  const [modules, setModules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/superadmin/role-modules');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setRoleModules(data.role_modules || {});
        setModules(data.modules || []);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = async (roleId, moduleKey, currentValue) => {
    const key = `${roleId}_${moduleKey}`;
    setSaving(key);
    try {
      const res = await apiFetch('/api/superadmin/role-modules', {
        method: 'PUT',
        body: JSON.stringify({ role: roleId, module_key: moduleKey, enabled: !currentValue }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setRoleModules(prev => ({
          ...prev,
          [roleId]: { ...(prev[roleId] || {}), [moduleKey]: !currentValue },
        }));
      }
    } catch { /* ignore */ }
    finally { setSaving(null); }
  };

  const groups = useMemo(() => {
    const map = {};
    for (const m of modules) {
      if (!map[m.group]) map[m.group] = [];
      map[m.group].push(m);
    }
    return Object.entries(map);
  }, [modules]);

  if (loading) return <p className="superadmin-loading">Loading role permissions…</p>;

  return (
    <section className="dashboard-section">
      <h2 className="superadmin-section-title">Role Permissions</h2>
      <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
        Enable or disable modules for each role. SuperAdmin always has full access. Changes take effect on next login.
      </p>
      {groups.map(([groupName, mods]) => (
        <div key={groupName} style={{ marginBottom: '2rem' }}>
          <h3 style={{ color: '#e2e8f0', fontSize: '1rem', marginBottom: '0.75rem', borderBottom: '1px solid #334155', paddingBottom: '0.5rem' }}>
            {groupName}
          </h3>
          <div className="superadmin-table-wrap">
            <table className="superadmin-table">
              <thead>
                <tr>
                  <th style={{ minWidth: '200px' }}>Module</th>
                  {MANAGEABLE_ROLES.map(r => (
                    <th key={r} style={{ textAlign: 'center', minWidth: '100px' }}>{ROLE_LABEL[r]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {mods.map(mod => (
                  <tr key={mod.key}>
                    <td>{mod.label}</td>
                    {MANAGEABLE_ROLES.map(roleId => {
                      const enabled = !!(roleModules[roleId] || {})[mod.key];
                      const isSaving = saving === `${roleId}_${mod.key}`;
                      return (
                        <td key={roleId} style={{ textAlign: 'center' }}>
                          <button
                            type="button"
                            onClick={() => toggle(roleId, mod.key, enabled)}
                            disabled={!!isSaving}
                            className={`role-perm-toggle ${enabled ? 'enabled' : 'disabled'}`}
                            title={enabled ? 'Click to disable' : 'Click to enable'}
                          >
                            {isSaving ? '…' : (enabled ? 'ON' : 'OFF')}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
});

export default RolePermissionsView;
