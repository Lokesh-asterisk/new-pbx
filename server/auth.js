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

export async function getEnabledModules(roleId) {
  if (Number(roleId) === 1) return null; // superadmin = all modules
  try {
    const rows = await query(
      'SELECT module_key FROM role_modules WHERE role = ? AND enabled = 1',
      [Number(roleId)]
    );
    return rows.map(r => r.module_key);
  } catch {
    return [];
  }
}

export function buildSessionUser(user, modules) {
  return {
    id: user.id,
    username: user.username,
    email: user.email || '',
    role: roleName(user.role),
    parent_id: user.parent_id,
    modules, // null = superadmin (all access), array = enabled module keys
    change_password_required: !!user.change_password_required,
    phone_login_name: user.phone_login_name,
    phone_login_number: user.phone_login_number,
  };
}
