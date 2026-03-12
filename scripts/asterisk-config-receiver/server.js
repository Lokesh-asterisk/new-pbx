/**
 * Run this on the Asterisk server (e.g. 10.50.2.190).
 * The PBX app (10.50.7.181) POSTs config here; this script writes to Asterisk config files and reloads.
 * Also serves Asterisk log files for the Super Admin dashboard (GET /logs/:file).
 *
 * Env (optional):
 *   PORT=9999
 *   AGENTS_CONF_PATH=/etc/asterisk/agents.conf
 *   PJSIP_CUSTOM_PATH=/etc/asterisk/pjsip_custom.conf
 *   PJSIP_TRUNKS_PATH=/etc/asterisk/pjsip_trunks_custom.conf
 *   DIALPLAN_CONF_PATH=/etc/asterisk/callcentre.conf
 *   ASTERISK_LOG_DIR=/var/log/asterisk  (for GET /logs/:file)
 *   CONFIG_API_KEY=secret  (if set, requests must send header X-Config-API-Key: secret)
 *
 * Endpoints:
 *   POST /config/agents       body: { content: "..." }  -> write agents.conf, reload app_agent_pool
 *   POST /config/pjsip       body: { content: "..." }  -> write pjsip_custom.conf, reload pjsip
 *   POST /config/pjsip-trunks body: { content: "..." } -> write pjsip_trunks_custom.conf, reload pjsip
 *   POST /config/dialplan     body: { content: "..." }  -> write callcentre.conf, dialplan reload
 *   GET  /logs/:file         ?tail=N  -> last N lines of full|messages|queue_log (default tail=2000)
 *   GET  /logs/:file/stream  -> SSE stream of new lines (full|messages|queue_log)
 */

import http from 'http';
import fs from 'fs/promises';
import { execSync, spawn } from 'child_process';
import path from 'path';

const PORT = parseInt(process.env.PORT || '9999', 10);
const AGENTS_CONF = process.env.AGENTS_CONF_PATH || '/etc/asterisk/agents.conf';
const PJSIP_CUSTOM = process.env.PJSIP_CUSTOM_PATH || '/etc/asterisk/pjsip_custom.conf';
const PJSIP_TRUNKS = process.env.PJSIP_TRUNKS_PATH || '/etc/asterisk/pjsip_trunks_custom.conf';
const DIALPLAN_CONF = process.env.DIALPLAN_CONF_PATH || '/etc/asterisk/callcentre.conf';
const LOG_DIR = (process.env.ASTERISK_LOG_DIR || '/var/log/asterisk').replace(/\/$/, '');
const CONFIG_API_KEY = process.env.CONFIG_API_KEY?.trim() || '';

const ALLOWED_LOG_FILES = new Set(['full', 'messages', 'queue_log']);

function checkAuth(req) {
  if (!CONFIG_API_KEY) return true;
  const key = req.headers['x-config-api-key'];
  return key === CONFIG_API_KEY;
}

function getLogPath(file) {
  if (!file || !ALLOWED_LOG_FILES.has(file)) return null;
  return path.join(LOG_DIR, file);
}

async function writeAndReload(filePath, content, reloadCmd) {
  await fs.writeFile(filePath, content, 'utf8');
  try {
    execSync(reloadCmd, { stdio: 'inherit', timeout: 10000 });
  } catch (e) {
    console.error('Reload failed:', e.message);
    throw e;
  }
}

async function ensurePjsipFilesExist() {
  const minimal = '; Placeholder - overwritten by PBX app config sync\n';
  for (const file of [PJSIP_CUSTOM, PJSIP_TRUNKS]) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, minimal, 'utf8');
      console.log(`Created ${file}`);
    }
  }
}

/** GET /logs/:file?tail=N - return last N lines. */
async function handleLogsTail(req, res, file, tail) {
  const filePath = getLogPath(file);
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid log file. Use: full, messages, queue_log' }));
    return;
  }
  const n = Math.min(Math.max(parseInt(tail, 10) || 2000, 1), 50000);
  try {
    await fs.access(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Log file not found or not readable' }));
    return;
  }
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split(/\n/).filter(Boolean);
    const last = lines.slice(-n);
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, lines: last }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message || 'Read failed' }));
  }
}

/** GET /logs/:file/stream - SSE stream of new lines. */
function handleLogsStream(req, res, file) {
  const filePath = getLogPath(file);
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid log file. Use: full, messages, queue_log' }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

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
  req.on('close', () => {
    tail.kill('SIGTERM');
  });
}

const server = http.createServer(async (req, res) => {
  if (!checkAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const urlPath = req.url?.split('?')[0] || '';
  const qs = new URLSearchParams((req.url?.split('?')[1] || ''));

  if (req.method === 'GET') {
    const logMatch = urlPath.match(/^\/logs\/(full|messages|queue_log)(\/stream)?$/);
    if (logMatch) {
      const file = logMatch[1];
      if (logMatch[2] === '/stream') {
        return handleLogsStream(req, res, file);
      }
      return handleLogsTail(req, res, file, qs.get('tail'));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const allowedPaths = ['/config/agents', '/config/pjsip', '/config/pjsip-trunks', '/config/dialplan'];
  if (!allowedPaths.includes(urlPath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }
  const content = data?.content;
  if (typeof content !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid "content"' }));
    return;
  }
  try {
    if (urlPath === '/config/agents') {
      await writeAndReload(AGENTS_CONF, content, "asterisk -rx 'module reload app_agent_pool.so'");
    } else if (urlPath === '/config/pjsip-trunks') {
      await writeAndReload(PJSIP_TRUNKS, content, "asterisk -rx 'module reload res_pjsip.so'");
    } else if (urlPath === '/config/dialplan') {
      console.log(`Writing dialplan to ${DIALPLAN_CONF} (${content.length} bytes)`);
      await writeAndReload(DIALPLAN_CONF, content, "asterisk -rx 'dialplan reload'");
    } else {
      await writeAndReload(PJSIP_CUSTOM, content, "asterisk -rx 'module reload res_pjsip.so'");
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message || 'Write or reload failed' }));
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  await ensurePjsipFilesExist();
  console.log(`Asterisk config receiver listening on port ${PORT}`);
  console.log(`Config paths: agents=${AGENTS_CONF} pjsip=${PJSIP_CUSTOM} trunks=${PJSIP_TRUNKS} dialplan=${DIALPLAN_CONF}`);
  if (CONFIG_API_KEY) console.log('API key required (X-Config-API-Key)');
});
