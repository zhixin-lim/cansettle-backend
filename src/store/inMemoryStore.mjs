// A minimal in-memory stand-in for the Supabase-backed store, so the API
// and the calculation engine can be built and tested before (or without)
// a live database connection. Same method names/shapes as supabaseStore.mjs
// - swapping one for the other should not require touching server.mjs.

import { randomUUID } from 'node:crypto';

const sessions = new Map(); // id -> session record (with nested participants/bills/items)

function nowIso() {
  return new Date().toISOString();
}

export function createSession({ label } = {}) {
  const id = randomUUID();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const session = { id, label: label ?? null, createdAt, expiresAt, participants: [], bills: [] };
  sessions.set(id, session);
  return { id, label: session.label, createdAt, expiresAt };
}

export function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return session; // includes nested participants/bills for convenience
}

function requireSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  return session;
}

export function addParticipant(sessionId, { name, telegramUserId = null }) {
  const session = requireSession(sessionId);
  const participant = { id: randomUUID(), sessionId, name, telegramUserId, createdAt: nowIso() };
  session.participants.push(participant); // array order = creation order
  return participant;
}

export function renameParticipant(sessionId, participantId, name) {
  const session = requireSession(sessionId);
  const participant = session.participants.find((p) => p.id === participantId);
  if (!participant) throw new Error(`Participant not found: ${participantId}`);
  participant.name = name;
  return participant;
}

// Removes a participant, and strips them from every item allocation across
// the session so nothing is left pointing at a person who no longer
// exists. Refuses if they're the payer on any bill - reassign the payer
// first (or delete that bill) rather than leaving a bill with no payer.
export function deleteParticipant(sessionId, participantId) {
  const session = requireSession(sessionId);
  const isPayerSomewhere = session.bills.some((b) => b.payerId === participantId);
  if (isPayerSomewhere) {
    const err = new Error('Cannot remove a participant who is the payer on a bill');
    err.code = 'PARTICIPANT_IS_PAYER';
    throw err;
  }
  session.participants = session.participants.filter((p) => p.id !== participantId);
  for (const bill of session.bills) {
    for (const item of bill.items) {
      item.allocations = item.allocations.filter((a) => a.participantId !== participantId);
    }
  }
}

export function addBill(sessionId, { source, payerId, serviceChargeCents = 0, gstCents = 0, totalCents, items }) {
  const session = requireSession(sessionId);
  const billId = randomUUID();
  const bill = {
    id: billId,
    sessionId,
    source,
    payerId,
    serviceChargeCents,
    gstCents,
    totalCents,
    createdAt: nowIso(),
    items: items.map((item) => ({
      id: randomUUID(),
      billId,
      name: item.name,
      quantity: item.quantity ?? 1,
      unitPriceCents: item.unitPriceCents ?? null,
      totalCents: item.totalCents,
      allocations: [],
    })),
  };
  session.bills.push(bill);
  return bill;
}

export function deleteBill(sessionId, billId) {
  const session = requireSession(sessionId);
  session.bills = session.bills.filter((b) => b.id !== billId);
}

function findItem(session, itemId) {
  for (const bill of session.bills) {
    const item = bill.items.find((i) => i.id === itemId);
    if (item) return { bill, item };
  }
  return null;
}

// allocations: [{ participantId, quantity? }] - quantity defaults to 1,
// so a plain list of participantIds-with-no-quantity is an equal split.
export function setItemAllocation(sessionId, itemId, allocations) {
  const session = requireSession(sessionId);
  const found = findItem(session, itemId);
  if (!found) throw new Error(`Item not found: ${itemId}`);
  found.item.allocations = allocations.map((a) => ({ participantId: a.participantId, quantity: a.quantity ?? 1 }));
  return found.item;
}

// Wipes everything - only for tests.
export function _resetAll() {
  sessions.clear();
}
