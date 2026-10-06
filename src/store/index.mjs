// Everything else in the app imports from here, never directly from
// inMemoryStore.mjs or supabaseStore.mjs - so swapping the backing store
// is a one-line env change, not a code change.

const useMemory = (process.env.STORE ?? 'memory') === 'memory';

const impl = useMemory
  ? await import('./inMemoryStore.mjs')
  : await import('./supabaseStore.mjs');

export const createSession = impl.createSession;
export const getSession = impl.getSession;
export const addParticipant = impl.addParticipant;
export const addBill = impl.addBill;
export const setItemAllocation = impl.setItemAllocation;
