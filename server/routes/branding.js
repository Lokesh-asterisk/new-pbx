import express from 'express';
import { queryOne } from '../db.js';

const router = express.Router();

const DEFAULTS = {
  productName: 'PBX Call Centre',
  companyName: '',
  logoUrl: null,
  tagline: null,
  faviconUrl: null,
  primaryColor: null,
};

router.get('/', async (req, res) => {
  try {
    const user = req.session?.user;
    if (!user) return res.json({ success: true, branding: { ...DEFAULTS } });

    const tenantId = user.parent_id ?? null;
    if (tenantId == null) {
      if (user.role === 'superadmin') {
        const first = await queryOne('SELECT id FROM tenants ORDER BY id LIMIT 1');
        if (first) {
          const row = await queryOne(
            'SELECT name, product_name, logo_url, tagline, primary_color, favicon_url FROM tenants WHERE id = ?',
            [first.id]
          );
          if (row) return res.json({ success: true, branding: toBranding(row) });
        }
      }
      return res.json({ success: true, branding: { ...DEFAULTS } });
    }

    const row = await queryOne(
      'SELECT name, product_name, logo_url, tagline, primary_color, favicon_url FROM tenants WHERE id = ?',
      [tenantId]
    );
    if (!row) return res.json({ success: true, branding: { ...DEFAULTS } });
    return res.json({ success: true, branding: toBranding(row) });
  } catch (err) {
    console.error('Branding fetch error:', err);
    return res.json({ success: true, branding: { ...DEFAULTS } });
  }
});

function toBranding(row) {
  return {
    productName: row.product_name || DEFAULTS.productName,
    companyName: row.name || '',
    logoUrl: row.logo_url || null,
    tagline: row.tagline || null,
    faviconUrl: row.favicon_url || null,
    primaryColor: row.primary_color || null,
  };
}

export default router;
