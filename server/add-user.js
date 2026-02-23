import 'dotenv/config';
import bcrypt from 'bcrypt';
import { query } from './db.js';

const ROLE_IDS = { superadmin: 1, admin: 2, user: 3, campaign: 4, agent: 5 };

async function addUser(username, password, roleName, parentId) {
  const role = ROLE_IDS[roleName?.toLowerCase()];
  if (!role) {
    console.error('Role must be: superadmin, admin, user, or agent');
    process.exit(1);
  }
  if (!username || !password) {
    console.error('Usage: node server/add-user.js <username> <password> <role> [parent_id]');
    console.error('Example: node server/add-user.js myadmin mypass123 admin');
    console.error('For agents (to see extensions): node server/add-user.js agent2 demo123 agent 2');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 10);
  const parent = role === 5 && parentId != null ? parseInt(parentId, 10) : null;
  try {
    await query(
      `INSERT INTO users (username, password_hash, email, role, parent_id, account_status, change_password_required)
       VALUES (?, ?, ?, ?, ?, 1, 0)`,
      [username, hash, `${username}@localhost`, role, parent]
    );
    console.log(`User created: ${username} (role: ${roleName}${parent != null ? `, parent_id=${parent}` : ''})`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      console.error(`Username "${username}" already exists. Choose a different username.`);
    } else {
      console.error('Failed:', err.message);
    }
    process.exit(1);
  }
  process.exit(0);
}

const [, , username, password, role, parentId] = process.argv;
addUser(username, password, role, parentId);
