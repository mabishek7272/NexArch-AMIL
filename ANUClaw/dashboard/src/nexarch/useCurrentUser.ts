import { useEffect, useState } from 'react';
import type { DashRole } from './nav';

interface CurrentUser {
  id: string;
  role: DashRole;
  name?: string;
}

/** Same /auth/me endpoint App.tsx's TermsGuard already calls — just reads the role too. */
export function useCurrentUser() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch('/auth/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setUser(data?.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setLoaded(true));
  }, []);

  return { user, loaded };
}
