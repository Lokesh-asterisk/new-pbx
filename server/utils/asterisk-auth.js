/**
 * Middleware to authenticate Asterisk HTTP callbacks.
 * When ASTERISK_CALLBACK_SECRET is set, requires X-Asterisk-Key header to match.
 * When not set, allows all requests (development mode).
 */
export function asteriskAuthMiddleware(req, res, next) {
  const secret = (process.env.ASTERISK_CALLBACK_SECRET || '').trim();
  if (!secret) return next();

  const provided = (req.headers['x-asterisk-key'] || req.query.key || '').trim();
  if (provided === secret) return next();

  return res.status(403).json({ error: 'Forbidden: invalid Asterisk callback key' });
}
