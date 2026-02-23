import bcrypt from 'bcrypt';
import { queryOne, query } from './db.js';

const ROLES = { 1: 'superadmin', 2: 'admin', 3: 'user', 4: 'campaign', 5: 'agent' };

export function roleName(roleId) {
  return ROLES[Number(roleId)] || 'user';
}

export async function findUserByUsername(username) {
  return queryOne(
    'SELECT id, username, password_hash, email, role, parent_id, account_status, permission_group_id, change_password_required, phone_login_name, phone_login_number FROM users WHERE username = ? LIMIT 1',
    [username]
  );
}

export async function verifyLogin(username, password) {
  const user = await findUserByUsername(username);
  if (!user) return null;
  if (user.account_status !== 1) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  return user;
}

export async function updateLastLogin(userId) {
  await query('UPDATE users SET last_login_at = NOW(), login_status = 1 WHERE id = ?', [userId]);
}

export async function updatePassword(userId, newPassword) {
  const hash = await bcrypt.hash(newPassword, 10);
  await query('UPDATE users SET password_hash = ?, change_password_required = 0 WHERE id = ?', [hash, userId]);
}

export async function verifyCurrentPassword(userId, password) {
  const row = await queryOne('SELECT password_hash FROM users WHERE id = ?', [userId]);
  if (!row) return false;
  return bcrypt.compare(password, row.password_hash);
}

export async function getPermissions(permissionGroupId) {
  if (!permissionGroupId) return {};
  const row = await queryOne('SELECT * FROM permission_groups WHERE id = ?', [permissionGroupId]);
  if (!row) return {};
  return {
    queue_cdr: !!row.queue_cdr,
    manual_cdr: !!row.manual_cdr,
    extension_cdr: !!row.extension_cdr,
    extension_route_cdr: !!row.extension_route_cdr,
    live_agents: !!row.live_agents,
    agent_apr: !!row.agent_apr,
    session_wise_agent_apr: !!row.session_wise_agent_apr,
    inbound_route: !!row.inbound_route,
    blacklist: !!row.blacklist,
    number_masking: !!row.number_masking,
  };
}

export function buildSessionUser(user, permissions = {}) {
  return {
    id: user.id,
    username: user.username,
    email: user.email || '',
    role: roleName(user.role),
    parent_id: user.parent_id,
    permission_group_id: user.permission_group_id,
    permissions,
    change_password_required: !!user.change_password_required,
    phone_login_name: user.phone_login_name,
    phone_login_number: user.phone_login_number,
  };
}
