import { useState, useEffect, useCallback } from 'react';
import Layout from '../components/Layout';
import './Dashboard.css';
import './SuperAdmin.css';

const API_BASE = import.meta.env.VITE_API_URL || '';

function api(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
}

const ROLES = ['superadmin', 'admin', 'user', 'agent'];

export default function SuperAdmin() {
  const [view, setView] = useState('overview');
  const [users, setUsers] = useState([]);
  const [extensions, setExtensions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [createUserRole, setCreateUserRole] = useState('user');
  const [showCreateExtension, setShowCreateExtension] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [editPhoneNumber, setEditPhoneNumber] = useState('');
  const [editPhonePassword, setEditPhonePassword] = useState('');
  const [createFormRole, setCreateFormRole] = useState('user');
  const [editingExtension, setEditingExtension] = useState(null);
  const [editExtName, setEditExtName] = useState('');
  const [editExtSecret, setEditExtSecret] = useState('');
  const [editExtContext, setEditExtContext] = useState('');
  const [editExtHost, setEditExtHost] = useState('');
  const [editExtType, setEditExtType] = useState('friend');
  const [editExtTenantId, setEditExtTenantId] = useState('');

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api('/api/superadmin/users');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setUsers(data.users || []);
      else setError(data.error || 'Failed to load users');
    } catch (e) {
      setError('Failed to load users');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadExtensions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api('/api/superadmin/sip-extensions');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setExtensions(data.extensions || []);
      else setError(data.error || 'Failed to load SIP extensions');
    } catch (e) {
      setError('Failed to load SIP extensions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === 'users') loadUsers();
  }, [view, loadUsers]);

  useEffect(() => {
    if (view === 'extensions') loadExtensions();
  }, [view, loadExtensions]);

  const openAddUser = (role) => {
    setView('users');
    setCreateUserRole(role);
    setCreateFormRole(role);
    setShowCreateUser(true);
  };

  const handleCreateUser = async (e) => {
    e.preventDefault();
    const form = e.target;
    const username = form.username?.value?.trim();
    const password = form.password?.value;
    const role = createFormRole;
    const email = form.email?.value?.trim();
    const parent_id = form.parent_id?.value?.trim();
    const phone_login_number = form.phone_login_number?.value?.trim();
    const phone_login_password = form.phone_login_password?.value;
    setError('');
    if (!username || !password) {
      setError('Username and password required');
      return;
    }
    if (role === 'agent' && (!phone_login_number || !phone_login_password)) {
      setError('Agents require phone login number (extension) and PIN');
      return;
    }
    setLoading(true);
    try {
      const body = { username, password, role, email, parent_id: parent_id || undefined };
      if (role === 'agent') {
        body.phone_login_number = phone_login_number;
        body.phone_login_password = phone_login_password;
      }
      const res = await api('/api/superadmin/users', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setShowCreateUser(false);
        form.reset();
        loadUsers();
      } else {
        setError(data.error || 'Failed to create user');
      }
    } catch (e) {
      setError('Failed to create user');
    } finally {
      setLoading(false);
    }
  };

  const openEditAgent = (u) => {
    if (u.role !== 'agent') return;
    setEditingUser(u);
    setEditPhoneNumber(u.phone_login_number || '');
    setEditPhonePassword('');
    setError('');
  };

  const handleUpdateAgentPhone = async (e) => {
    e.preventDefault();
    if (!editingUser) return;
    setError('');
    if (!editPhoneNumber.trim()) {
      setError('Phone login number (extension) required');
      return;
    }
    if (!editPhonePassword.trim()) {
      setError('PIN required');
      return;
    }
    setLoading(true);
    try {
      const res = await api(`/api/superadmin/users/${editingUser.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          phone_login_number: editPhoneNumber.trim(),
          phone_login_password: editPhonePassword,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setEditingUser(null);
        setEditPhoneNumber('');
        setEditPhonePassword('');
        loadUsers();
      } else {
        setError(data.error || 'Failed to update agent');
      }
    } catch (e) {
      setError('Failed to update agent');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateExtension = async (e) => {
    e.preventDefault();
    const form = e.target;
    const tenant_id = form.tenant_id?.value?.trim();
    const name = form.name?.value?.trim();
    const secret = form.secret?.value?.trim();
    const context = form.context?.value?.trim();
    const host = form.host?.value?.trim();
    const type = form.type?.value?.trim() || 'friend';
    setError('');
    if (!tenant_id || !name) {
      setError('Tenant ID and extension name required');
      return;
    }
    setLoading(true);
    try {
      const res = await api('/api/superadmin/sip-extensions', {
        method: 'POST',
        body: JSON.stringify({ tenant_id, name, secret, context, host, type }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setShowCreateExtension(false);
        form.reset();
        loadExtensions();
      } else {
        setError(data.error || 'Failed to create SIP extension');
      }
    } catch (e) {
      setError('Failed to create SIP extension');
    } finally {
      setLoading(false);
    }
  };

  const openEditExtension = (ext) => {
    setEditingExtension(ext);
    setEditExtName(ext.name || '');
    setEditExtSecret(''); // leave blank to keep existing
    setEditExtContext(ext.context || '');
    setEditExtHost(ext.host || '');
    setEditExtType(ext.type || 'friend');
    setEditExtTenantId(String(ext.tenant_id ?? ''));
    setError('');
  };

  const handleUpdateExtension = async (e) => {
    e.preventDefault();
    if (!editingExtension) return;
    setError('');
    if (!editExtName.trim()) {
      setError('Extension name required');
      return;
    }
    setLoading(true);
    try {
      const body = {
        tenant_id: editExtTenantId.trim() || undefined,
        name: editExtName.trim(),
        context: editExtContext.trim() || undefined,
        host: editExtHost.trim() || undefined,
        type: editExtType.trim() || 'friend',
      };
      if (editExtSecret.trim() !== '') body.secret = editExtSecret.trim();
      const res = await api(`/api/superadmin/sip-extensions/${editingExtension.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setEditingExtension(null);
        setEditExtName('');
        setEditExtSecret('');
        setEditExtContext('');
        setEditExtHost('');
        setEditExtType('friend');
        setEditExtTenantId('');
        loadExtensions();
      } else {
        setError(data.error || 'Failed to update extension');
      }
    } catch (e) {
      setError('Failed to update extension');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteUser = async (u) => {
    if (!window.confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    setError('');
    setLoading(true);
    try {
      const res = await api(`/api/superadmin/users/${u.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        loadUsers();
      } else {
        setError(data.error || 'Failed to delete user');
      }
    } catch (e) {
      setError('Failed to delete user');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteExtension = async (ext) => {
    if (!window.confirm(`Delete SIP extension "${ext.name}" (tenant ${ext.tenant_id})? This cannot be undone.`)) return;
    setError('');
    setLoading(true);
    try {
      const res = await api(`/api/superadmin/sip-extensions/${ext.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        loadExtensions();
      } else {
        setError(data.error || 'Failed to delete extension');
      }
    } catch (e) {
      setError('Failed to delete extension');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout title="Super Admin" subtitle="PBX Call Centre — Full system control">
      <div className="dashboard">
        <section className="dashboard-section">
          <h2>Quick actions</h2>
          <div className="action-list">
            <button type="button" className="action-btn" onClick={() => openAddUser('superadmin')}>
              Add superadmin
            </button>
            <button type="button" className="action-btn" onClick={() => openAddUser('admin')}>
              Add admin
            </button>
            <button type="button" className="action-btn" onClick={() => openAddUser('user')}>
              Add user
            </button>
            <button type="button" className="action-btn" onClick={() => openAddUser('agent')}>
              Add agent
            </button>
            <button type="button" className="action-btn" onClick={() => setView('users')}>
              View users list
            </button>
            <button type="button" className="action-btn" onClick={() => setView('extensions')}>
              View SIP extensions
            </button>
            {view !== 'overview' && (
              <button type="button" className="action-btn" onClick={() => setView('overview')}>
                Back to overview
              </button>
            )}
            <button type="button" className="action-btn">
              Manage tenants
            </button>
            <button type="button" className="action-btn">
              System settings
            </button>
            <button type="button" className="action-btn">
              Audit logs
            </button>
            <button type="button" className="action-btn">
              Backup & restore
            </button>
          </div>
        </section>

        {view === 'overview' && (
          <section className="dashboard-section">
            <h2>System overview</h2>
            <div className="card-grid">
              <div className="stat-card">
                <span className="stat-value">12</span>
                <span className="stat-label">Active agents</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">48</span>
                <span className="stat-label">Queued calls</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">1,240</span>
                <span className="stat-label">Calls today</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">4</span>
                <span className="stat-label">Admins</span>
              </div>
            </div>
          </section>
        )}

        {view === 'users' && (
          <section className="dashboard-section">
            <h2>Users</h2>
            {error && <p className="superadmin-error">{error}</p>}
            <button type="button" className="action-btn superadmin-add-btn" onClick={() => openAddUser('user')}>
              Add user
            </button>
            {showCreateUser && (
              <form className="superadmin-form" onSubmit={handleCreateUser}>
                <h3>Create user</h3>
                <label>
                  Username <input name="username" type="text" required />
                </label>
                <label>
                  Password <input name="password" type="password" required minLength={6} />
                </label>
                <label>
                  Role
                  <select
                    name="role"
                    value={createFormRole}
                    onChange={(e) => setCreateFormRole(e.target.value)}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Email <input name="email" type="email" placeholder="optional" />
                </label>
                <label className="superadmin-parent-label">
                  Tenant / parent_id (for agents)
                  <input name="parent_id" type="number" min="1" placeholder="e.g. 2" />
                </label>
                {createFormRole === 'agent' && (
                  <>
                    <label>
                      Phone login number (extension)
                      <input name="phone_login_number" type="text" placeholder="e.g. 1001" required />
                    </label>
                    <label>
                      Phone login password (PIN)
                      <input name="phone_login_password" type="password" placeholder="e.g. 1234" required minLength={1} />
                    </label>
                  </>
                )}
                <div className="superadmin-form-actions">
                  <button type="submit" className="action-btn" disabled={loading}>
                    Create
                  </button>
                  <button type="button" className="action-btn" onClick={() => setShowCreateUser(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {editingUser && (
              <form className="superadmin-form" onSubmit={handleUpdateAgentPhone}>
                <h3>Edit agent: {editingUser.username}</h3>
                <label>
                  Phone login number (extension)
                  <input
                    type="text"
                    value={editPhoneNumber}
                    onChange={(e) => setEditPhoneNumber(e.target.value)}
                    placeholder="e.g. 1001"
                  />
                </label>
                <label>
                  Phone login password (PIN)
                  <input
                    type="password"
                    value={editPhonePassword}
                    onChange={(e) => setEditPhonePassword(e.target.value)}
                    placeholder="Enter new PIN"
                  />
                </label>
                <div className="superadmin-form-actions">
                  <button type="submit" className="action-btn" disabled={loading}>
                    Update
                  </button>
                  <button
                    type="button"
                    className="action-btn"
                    onClick={() => {
                      setEditingUser(null);
                      setEditPhoneNumber('');
                      setEditPhonePassword('');
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {loading && users.length === 0 ? (
              <p className="superadmin-loading">Loading users…</p>
            ) : (
              <div className="superadmin-table-wrap">
                <table className="superadmin-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Username</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Parent ID</th>
                      <th>Phone number</th>
                      <th>PIN</th>
                      <th>Status</th>
                      <th>Created</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id}>
                        <td>{u.id}</td>
                        <td>{u.username}</td>
                        <td>{u.email}</td>
                        <td>{u.role}</td>
                        <td>{u.parent_id ?? '—'}</td>
                        <td>{u.phone_login_number || '—'}</td>
                        <td>{u.phone_login_set ? 'Set' : '—'}</td>
                        <td>{u.account_status === 1 ? 'Active' : 'Inactive'}</td>
                        <td>{u.created_at ? new Date(u.created_at).toLocaleString() : '—'}</td>
                        <td>
                          {u.role === 'agent' && (
                            <button
                              type="button"
                              className="action-btn"
                              onClick={() => openEditAgent(u)}
                            >
                              Edit phone / PIN
                            </button>
                          )}
                          <button
                            type="button"
                            className="action-btn superadmin-delete-btn"
                            onClick={() => handleDeleteUser(u)}
                            title="Delete user"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {view === 'extensions' && (
          <section className="dashboard-section">
            <h2>SIP extensions</h2>
            {error && <p className="superadmin-error">{error}</p>}
            <button type="button" className="action-btn superadmin-add-btn" onClick={() => setShowCreateExtension(true)}>
              Add SIP extension
            </button>
            {showCreateExtension && (
              <form className="superadmin-form" onSubmit={handleCreateExtension}>
                <h3>Create SIP extension</h3>
                <label>
                  Tenant ID <input name="tenant_id" type="number" min="1" required />
                </label>
                <label>
                  Extension name <input name="name" type="text" required placeholder="e.g. 1001" />
                </label>
                <label>
                  Secret <input name="secret" type="text" placeholder="optional" />
                </label>
                <label>
                  Context <input name="context" type="text" placeholder="optional" />
                </label>
                <label>
                  Host <input name="host" type="text" placeholder="optional" />
                </label>
                <label>
                  Type <input name="type" type="text" defaultValue="friend" placeholder="friend" />
                </label>
                <div className="superadmin-form-actions">
                  <button type="submit" className="action-btn" disabled={loading}>
                    Create
                  </button>
                  <button type="button" className="action-btn" onClick={() => setShowCreateExtension(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {editingExtension && (
              <form className="superadmin-form" onSubmit={handleUpdateExtension}>
                <h3>Edit SIP extension: {editingExtension.name}</h3>
                <label>
                  Tenant ID
                  <input
                    type="number"
                    min="1"
                    value={editExtTenantId}
                    onChange={(e) => setEditExtTenantId(e.target.value)}
                  />
                </label>
                <label>
                  Extension name
                  <input
                    type="text"
                    value={editExtName}
                    onChange={(e) => setEditExtName(e.target.value)}
                    placeholder="e.g. 1001"
                    required
                  />
                </label>
                <label>
                  Secret <input type="text" value={editExtSecret} onChange={(e) => setEditExtSecret(e.target.value)} placeholder="leave blank to keep" />
                </label>
                <label>
                  Context <input type="text" value={editExtContext} onChange={(e) => setEditExtContext(e.target.value)} placeholder="optional" />
                </label>
                <label>
                  Host <input type="text" value={editExtHost} onChange={(e) => setEditExtHost(e.target.value)} placeholder="optional" />
                </label>
                <label>
                  Type <input type="text" value={editExtType} onChange={(e) => setEditExtType(e.target.value)} placeholder="friend" />
                </label>
                <div className="superadmin-form-actions">
                  <button type="submit" className="action-btn" disabled={loading}>
                    Update
                  </button>
                  <button
                    type="button"
                    className="action-btn"
                    onClick={() => {
                      setEditingExtension(null);
                      setEditExtName('');
                      setEditExtSecret('');
                      setEditExtContext('');
                      setEditExtHost('');
                      setEditExtType('friend');
                      setEditExtTenantId('');
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {loading && extensions.length === 0 ? (
              <p className="superadmin-loading">Loading SIP extensions…</p>
            ) : (
              <div className="superadmin-table-wrap">
                <table className="superadmin-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Tenant ID</th>
                      <th>Name</th>
                      <th>Secret</th>
                      <th>Context</th>
                      <th>Host</th>
                      <th>Type</th>
                      <th>Created</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {extensions.map((ext) => (
                      <tr key={ext.id}>
                        <td>{ext.id}</td>
                        <td>{ext.tenant_id}</td>
                        <td>{ext.name}</td>
                        <td>{ext.secret ? '••••' : '—'}</td>
                        <td>{ext.context || '—'}</td>
                        <td>{ext.host || '—'}</td>
                        <td>{ext.type || '—'}</td>
                        <td>{ext.created_at ? new Date(ext.created_at).toLocaleString() : '—'}</td>
                        <td>
                          <button type="button" className="action-btn" onClick={() => openEditExtension(ext)}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="action-btn superadmin-delete-btn"
                            onClick={() => handleDeleteExtension(ext)}
                            title="Delete extension"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </Layout>
  );
}
