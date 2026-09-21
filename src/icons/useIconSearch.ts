import { useEffect, useState } from 'react';
import { loadManifest, searchManifest } from './manifest';
import type { ManifestEntry, ManifestVendor } from './types';

export type VendorRow = { entry: ManifestEntry; vendor: ManifestVendor };

export function useIconSearch(query: string) {
  const [vendor, setVendor] = useState<VendorRow[]>([]);
  const [manifestReady, setManifestReady] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    loadManifest()
      .then(() => {
        if (!cancelled) setManifestReady(true);
      })
      .catch(() => {
        if (!cancelled) setManifestReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!manifestReady) {
      setVendor([]);
      return;
    }
    const q = query.trim();
    if (!q) {
      setVendor([]);
      return;
    }
    setVendor(searchManifest(q, 80));
  }, [query, manifestReady]);

  return { vendor, manifestReady };
}
