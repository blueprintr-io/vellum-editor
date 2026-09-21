import { useState } from 'react';

/** Owned by the panel/popover so closing a picker retains its browse state. */
export function useLibraryNavigation() {
  const [tab, setTab] = useState<'Home' | 'Shapes' | 'Icons'>('Home');
  const [category, setCategory] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [openVendorRequest, setOpenVendorRequest] = useState<{
    vendor: string;
  } | null>(null);
  return {
    tab,
    setTab,
    category,
    setCategory,
    q,
    setQ,
    openVendorRequest,
    setOpenVendorRequest,
  };
}
