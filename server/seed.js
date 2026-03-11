import 'dotenv/config';
import bcrypt from 'bcrypt';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const defaultPassword = 'demo123';
const hash = await bcrypt.hash(defaultPassword, 10);

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  multipleStatements: true,
};

async function run() {
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    console.log('Creating database pbx_callcentre if not exists...');
    await conn.query('CREATE DATABASE IF NOT EXISTS pbx_callcentre DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci');
    await conn.query('USE pbx_callcentre');

    const schemaPath = join(__dirname, '..', 'docs', 'database-schema.sql');
    const schema = readFileSync(schemaPath, 'utf8');
    await conn.query(schema);
    console.log('Schema applied.');

    const migrationsDir = join(__dirname, '..', 'docs', 'migrations');
    try {
      const { readdirSync } = await import('fs');
      const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
      for (const file of files) {
        const sql = readFileSync(join(migrationsDir, file), 'utf8');
        await conn.query(sql);
        console.log(`Migration applied: ${file}`);
      }
    } catch (e) {
      console.log('Migrations folder read skipped:', e.message);
    }

    const [existing] = await conn.query('SELECT id FROM users WHERE username = ?', ['superadmin']);
    if (existing.length > 0) {
      console.log('Seed users already exist. Skipping seed.');
      process.exit(0);
    }

    await conn.query(
      `INSERT INTO users (username, password_hash, email, role, parent_id, account_status, change_password_required) VALUES
       ('superadmin', ?, 'superadmin@localhost', 1, NULL, 1, 0),
       ('admin', ?, 'admin@localhost', 2, NULL, 1, 0),
       ('user', ?, 'user@localhost', 3, NULL, 1, 0),
       ('agent', ?, 'agent@localhost', 5, 2, 1, 0),
       ('agent2', ?, 'agent2@localhost', 5, 2, 1, 0)`,
      [hash, hash, hash, hash, hash]
    );
    console.log('Seeded users: superadmin, admin, user, agent, agent2 (password: demo123)');
    await conn.query(
      `INSERT INTO sip_extensions (tenant_id, name) VALUES (2, '1001'), (2, '1002')`
    );
    console.log('Seeded SIP extensions 1001, 1002 for tenant 2. Agents (agent, agent2) share same tenant; one can take 1001, other 1002.');

    const [crmRows] = await conn.query('SELECT id FROM crm_customers WHERE tenant_id = 2 LIMIT 1').catch(() => [[]]);
    if (!crmRows || crmRows.length === 0) {
      await conn.query(
        `INSERT INTO crm_customers (tenant_id, customer_id, name, phone, email, notes) VALUES
         (2, 'C001', 'Acme Corp', '+15551234001', 'contact@acme.example.com', 'Preferred customer'),
         (2, 'C002', 'Jane Smith', '+15551234002', 'jane@example.com', NULL),
         (2, 'C003', 'John Doe', '+15551234003', NULL, 'Callback requested')`
      ).catch(() => {});
      console.log('Seeded CRM customers C001, C002, C003 for tenant 2.');
    }
  } catch (err) {
    console.error('Seed failed:', err.message || err.code || err);
    if (err.code === 'ECONNREFUSED') {
      console.error('MySQL is not running or not reachable. Start MySQL or set DB_HOST/DB_PORT in .env');
    }
    if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('Check DB_USER and DB_PASSWORD in .env');
    }
    process.exit(1);
  } finally {
    if (conn) await conn.end();
  }
}

run();
