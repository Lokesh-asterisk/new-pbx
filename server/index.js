import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import authRoutes from './routes/auth.js';
import agentRoutes from './routes/agent.js';
import superadminRoutes from './routes/superadmin.js';
import asteriskRoutes from './routes/asterisk.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(
  session({
    name: 'pbx.sid',
    secret: process.env.SESSION_SECRET || 'pbx-callcentre-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/superadmin', superadminRoutes);
app.use('/api/asterisk', asteriskRoutes);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: 'pbx_callcentre' });
});

app.listen(PORT, () => {
  console.log(`PBX API running at http://localhost:${PORT}`);
});
