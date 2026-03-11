import express from 'express';
import fs from 'fs';
import path from 'path';
import { query, queryOne } from '../../db.js';
import ALL_MODULES from '../../modules.js';
import { validate, roleModuleSchema } from '../../utils/schemas.js';
import { getEffectiveTenantId, requireSuperadmin, ROLE_IDS } from './middleware.js';

const router = express.Router();

// --- Role Modules (dynamic module access control) ---

router.get('/role-modules', async (req, res) => {
  try {
    const rows = await query('SELECT role, module_key, enabled FROM role_modules');
    const roleModules = {};
    for (const roleId of [2, 3, 5]) {
      roleModules[roleId] = {};
      for (const mod of ALL_MODULES) {
        const row = rows.find(r => r.role === roleId && r.module_key === mod.key);
        roleModules[roleId][mod.key] = row ? !!row.enabled : false;
      }
    }
    return res.json({ success: true, role_modules: roleModules, modules: ALL_MODULES });
  } catch (err) {
    console.error('Get role-modules error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load role modules' });
  }
});

router.put('/role-modules', validate(roleModuleSchema), async (req, res) => {
  try {
    const { role, module_key, enabled } = req.body || {};
    if (![2, 3, 5].includes(Number(role))) {
      return res.status(400).json({ success: false, error: 'Invalid role. Use 2 (admin), 3 (user), or 5 (agent).' });
    }
    if (!ALL_MODULES.some(m => m.key === module_key)) {
      return res.status(400).json({ success: false, error: 'Invalid module key' });
    }
    await query(
      `INSERT INTO role_modules (role, module_key, enabled)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_at = NOW()`,
      [Number(role), module_key, enabled ? 1 : 0]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('Update role-module error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update role module' });
  }
});

// --- Asterisk logs (same server: ASTERISK_LOG_DIR; remote: ASTERISK_CONFIG_API_URL + config-receiver) ---

const ASTERISK_LOG_DIR = process.env.ASTERISK_LOG_DIR?.trim().replace(/\/$/, '') || '';
const ASTERISK_CONFIG_API_URL = process.env.ASTERISK_CONFIG_API_URL?.trim().replace(/\/$/, '') || '';
const ASTERISK_CONFIG_API_KEY = process.env.ASTERISK_CONFIG_API_KEY?.trim() || '';
const ALLOWED_LOG_FILES = new Set(['full', 'messages', 'queue_log']);

function getLogFilePath(file) {
  if (!file || !ALLOWED_LOG_FILES.has(file) || !ASTERISK_LOG_DIR) return null;
  const resolved = path.join(ASTERISK_LOG_DIR, file);
  if (!resolved.startsWith(path.resolve(ASTERISK_LOG_DIR))) return null;
  return resolved;
}

router.get('/asterisk-logs', requireSuperadmin, async (req, res) => {
  try {
    const file = (req.query.file || 'full').toLowerCase();
    const tail = Math.min(Math.max(parseInt(req.query.tail, 10) || 2000, 1), 50000);
    if (!ALLOWED_LOG_FILES.has(file)) {
      return res.status(400).json({ success: false, error: 'Invalid file. Use: full, messages, queue_log' });
    }

    if (ASTERISK_LOG_DIR) {
      const filePath = getLogFilePath(file);
      if (!filePath) return res.status(400).json({ success: false, error: 'Invalid log file' });
      try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const lines = content.split(/\n/).filter(Boolean);
        const last = lines.slice(-tail);
        return res.json({ success: true, lines: last, source: 'local' });
      } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ success: false, error: 'Log file not found' });
        console.error('Asterisk logs read error:', err);
        return res.status(500).json({ success: false, error: err.message || 'Read failed' });
      }
    }

    if (ASTERISK_CONFIG_API_URL) {
      const url = `${ASTERISK_CONFIG_API_URL}/logs/${file}?tail=${tail}`;
      const headers = { Accept: 'application/json' };
      if (ASTERISK_CONFIG_API_KEY) headers['X-Config-API-Key'] = ASTERISK_CONFIG_API_KEY;
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        const body = await resp.text();
        return res.status(resp.status).json({ success: false, error: body || resp.statusText });
      }
      const data = await resp.json();
      return res.json({ success: true, lines: data.lines || [], source: 'remote' });
    }

    return res.status(503).json({
      success: false,
      error: 'Asterisk logs not configured. Set ASTERISK_LOG_DIR (same server) or ASTERISK_CONFIG_API_URL (remote).',
    });
  } catch (err) {
    console.error('Asterisk logs error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to load logs' });
  }
});

router.get('/asterisk-logs/stream', requireSuperadmin, async (req, res) => {
  try {
    const file = (req.query.file || 'full').toLowerCase();
    if (!ALLOWED_LOG_FILES.has(file)) {
      return res.status(400).json({ success: false, error: 'Invalid file. Use: full, messages, queue_log' });
    }

    if (ASTERISK_LOG_DIR) {
      const filePath = getLogFilePath(file);
      if (!filePath) return res.status(400).json({ success: false, error: 'Invalid log file' });
      try {
        await fs.promises.access(filePath);
      } catch {
        return res.status(404).json({ success: false, error: 'Log file not found' });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.flushHeaders?.();
      const { spawn } = await import('child_process');
      const tail = spawn('tail', ['-f', '-n', '0', filePath], { stdio: ['ignore', 'pipe', 'ignore'] });
      tail.stdout.setEncoding('utf8');
      tail.stdout.on('data', (chunk) => {
        const lines = String(chunk).split(/\n/).filter(Boolean);
        for (const line of lines) {
          res.write(`data: ${line.replace(/\n/g, ' ')}\n\n`);
        }
        res.flush?.();
      });
      tail.on('error', (err) => {
        res.write(`data: [error] ${err.message}\n\n`);
      });
      req.on('close', () => tail.kill('SIGTERM'));
      return;
    }

    if (ASTERISK_CONFIG_API_URL) {
      const url = `${ASTERISK_CONFIG_API_URL}/logs/${file}/stream`;
      const headers = {};
      if (ASTERISK_CONFIG_API_KEY) headers['X-Config-API-Key'] = ASTERISK_CONFIG_API_KEY;
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        const body = await resp.text();
        return res.status(resp.status).json({ success: false, error: body || resp.statusText });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.flushHeaders?.();
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length) res.write(decoder.decode(value, { stream: true }));
            res.flush?.();
          }
        } catch (e) {
          console.error('Asterisk logs stream proxy error:', e.message);
        } finally {
          res.end();
        }
      })();
      req.on('close', () => reader.cancel?.());
      return;
    }

    return res.status(503).json({
      success: false,
      error: 'Asterisk logs not configured. Set ASTERISK_LOG_DIR (same server) or ASTERISK_CONFIG_API_URL (remote).',
    });
  } catch (err) {
    console.error('Asterisk logs stream error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to stream logs' });
  }
});

/** GET /asterisk-logs/config - returns how logs are configured (for UI). */
router.get('/asterisk-logs/config', requireSuperadmin, (req, res) => {
  const hasLocal = Boolean(ASTERISK_LOG_DIR);
  const hasRemote = Boolean(ASTERISK_CONFIG_API_URL);
  res.json({
    success: true,
    configured: hasLocal || hasRemote,
    source: hasLocal ? 'local' : (hasRemote ? 'remote' : null),
    message: hasLocal
      ? 'Reading from local Asterisk log directory (production-style).'
      : hasRemote
        ? 'Fetching from Asterisk server via config-receiver.'
        : 'Set ASTERISK_LOG_DIR (same server) or ASTERISK_CONFIG_API_URL (remote).',
  });
});

export default router;
