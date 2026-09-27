import { useState } from 'react';

export type LibraryTab = 'Home' | 'Shapes' | 'Icons';

/** Owned by the panel/popover so closing a picker retains its browse state.
 *  `initialTab` is read once, when the owner mounts. */
export function useLibraryNavigation(
  initialTab: LibraryTab | (() => LibraryTab) = 'Home',
) {
  const [tab, setTab] = useState<LibraryTab>(initialTab);
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
