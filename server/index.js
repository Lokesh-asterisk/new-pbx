import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import authRoutes from './routes/auth.js';
import agentRoutes from './routes/agent.js';
import superadminRoutes from './routes/superadmin.js';
import asteriskRoutes from './routes/asterisk.js';
import wallboardRoutes from './routes/wallboard.js';
import adminRoutes from './routes/admin.js';
import reportRoutes from './routes/reports.js';
import { startQueueStasisClient } from './ari-stasis-queue.js';
import { initRedis } from './redis-wallboard.js';
import { startReportAggregator } from './report-aggregator.js';

const app = express();
const PORT = process.env.PORT || 3001;

const sessionStore = new session.MemoryStore();
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
app.use(express.json());
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
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);
app.set('sessionStore', sessionStore);

app.use('/api/auth', authRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/superadmin', superadminRoutes);
app.use('/api/asterisk', asteriskRoutes);
app.use('/api/wallboard', wallboardRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/reports', reportRoutes);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: 'pbx_callcentre' });
});

app.listen(PORT, async () => {
  console.log(`PBX API running at http://localhost:${PORT}`);
  startQueueStasisClient();
  await initRedis().catch(() => {});
  startReportAggregator();
});
