// localStorage can throw (cookies blocked for the site, sandboxed webviews,
// Safari private mode quota) — wrap every access so a storage-blocked browser
// degrades gracefully instead of crashing the component tree.
export const safeGet = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};

export const safeSet = (key: string, value: string): void => {
  try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
};

export const safeRemove = (key: string): void => {
  try { localStorage.removeItem(key); } catch { /* storage blocked */ }
};
