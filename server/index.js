import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import { asteriskAuthMiddleware } from './utils/asterisk-auth.js';
import authRoutes from './routes/auth.js';
import agentRoutes from './routes/agent.js';
import superadminRoutes from './routes/superadmin.js';
import asteriskRoutes from './routes/asterisk.js';
import wallboardRoutes from './routes/wallboard.js';
import adminRoutes from './routes/admin.js';
import reportRoutes from './routes/reports.js';
import brandingRoutes from './routes/branding.js';
import { startQueueStasisClient } from './ari-stasis-queue.js';
import { initRedis } from './redis-wallboard.js';
import { startReportAggregator } from './report-aggregator.js';
import { initAriRedisState } from './ari-state-redis.js';

const app = express();
const PORT = process.env.PORT || 3001;

let sessionStore;
const redisUrl = (process.env.REDIS_URL || '').trim();
if (redisUrl) {
  try {
    const { default: RedisStore } = await import('connect-redis');
    const { createClient } = await import('redis');
    const redisSessionClient = createClient({ url: redisUrl, socket: { connectTimeoutMs: 3000, reconnectStrategy: false } });
    let redisErrLogged = false;
    redisSessionClient.on('error', (err) => {
      if (!redisErrLogged) { console.warn('[session-redis]', err.message || 'connection error'); redisErrLogged = true; }
    });
    await redisSessionClient.connect();
    sessionStore = new RedisStore({ client: redisSessionClient, prefix: 'sess:' });
    console.log('[startup] Session store: Redis');
  } catch (err) {
    console.warn('[startup] Redis session store unavailable, falling back to MemoryStore:', err?.message || err);
    sessionStore = new session.MemoryStore();
  }
} else {
  sessionStore = new session.MemoryStore();
}
const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (!corsOrigins.length) corsOrigins.push('http://localhost:5173');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (corsOrigins.includes(origin)) return cb(null, origin);
    return cb(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(
  session({
    name: 'pbx.sid',
    secret: process.env.SESSION_SECRET || 'pbx-callcentre-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);
app.set('sessionStore', sessionStore);

const loginRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { success: false, error: 'Too many login attempts. Try again later.' },
});
app.use('/api/auth/login', loginRateLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/superadmin', superadminRoutes);
app.use('/api/asterisk', asteriskAuthMiddleware, asteriskRoutes);
app.use('/api/wallboard', wallboardRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/branding', brandingRoutes);

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: 'pbx_callcentre' });
});

app.listen(PORT, async () => {
  const sessionSecret = process.env.SESSION_SECRET || '';
  const defaultSecret = 'pbx-callcentre-secret-change-in-production';
  if (!sessionSecret || sessionSecret === defaultSecret) {
    console.warn('[startup] SESSION_SECRET is not set or using default value. Set a secure SESSION_SECRET in production.');
  }
  console.log(`PBX API running at http://localhost:${PORT}`);
  await initRedis().catch(e => console.warn('[startup] Redis unavailable:', e?.message));
  await initAriRedisState().catch(e => console.warn('[startup] ARI Redis state unavailable:', e?.message));
  await startQueueStasisClient();
  startReportAggregator();
});
