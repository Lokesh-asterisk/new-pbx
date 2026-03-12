import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useAuth } from './AuthContext';
import { apiFetch } from '../utils/api.js';

const DEFAULTS = {
  productName: 'PBX Call Centre',
  companyName: '',
  logoUrl: null,
  tagline: null,
  faviconUrl: null,
  primaryColor: null,
};

const BrandingContext = createContext({ branding: DEFAULTS, loading: false, refetch: () => {} });

export function BrandingProvider({ children }) {
  const { user } = useAuth();
  const [branding, setBranding] = useState(DEFAULTS);
  const [loading, setLoading] = useState(false);

  const fetchBranding = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/branding');
      const data = await res.json().catch(() => ({}));
      if (data.success && data.branding) {
        setBranding({ ...DEFAULTS, ...data.branding });
      } else {
        setBranding(DEFAULTS);
      }
    } catch {
      setBranding(DEFAULTS);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) {
      fetchBranding();
    } else {
      setBranding(DEFAULTS);
    }
  }, [user, fetchBranding]);

  useEffect(() => {
    document.title = branding.productName || 'PBX Call Centre';
  }, [branding.productName]);

  useEffect(() => {
    const base = import.meta.env.VITE_API_URL || '';
    const href = !branding.faviconUrl ? '/vite.svg' : (branding.faviconUrl.startsWith('http') ? branding.faviconUrl : `${base}${branding.faviconUrl}`);
    let link = document.querySelector("link[rel~='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = href;
  }, [branding.faviconUrl]);

  useEffect(() => {
    if (branding.primaryColor) {
      document.documentElement.style.setProperty('--brand-primary', branding.primaryColor);
      document.documentElement.style.setProperty('--brand-primary-hover', branding.primaryColor);
    } else {
      document.documentElement.style.removeProperty('--brand-primary');
      document.documentElement.style.removeProperty('--brand-primary-hover');
    }
  }, [branding.primaryColor]);

  return (
    <BrandingContext.Provider value={{ branding, loading, refetch: fetchBranding }}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding() {
  return useContext(BrandingContext);
}

export { DEFAULTS as BRANDING_DEFAULTS };
