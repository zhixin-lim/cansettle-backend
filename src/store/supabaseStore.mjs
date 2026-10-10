// Same method names/shapes as inMemoryStore.mjs.

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set to use the Supabase store');
}

const supabase = createClient(supabaseUrl, supabaseKey);

function throwIfError(error, context) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

export async function createSession({ label } = {}) {
  const { data, error } = await supabase.from('sessions').insert({ label: label ?? null }).select().single();
  throwIfError(error, 'createSession');
  return { id: data.id, label: data.label, createdAt: data.created_at, expiresAt: data.expires_at };
}

// Lightweight lookup used by the expiry guard in server.mjs (one small query
// instead of the three getSession makes). A malformed id counts as "not found".
export async function getSessionMeta(sessionId) {
  const { data, error } = await supabase
    .from('sessions')
    .select('id, expires_at')
    .eq('id', sessionId)
    .maybeSingle();
  if (error) {
    if (error.code === '22P02') return null; // not a valid uuid
    throw new Error(`getSessionMeta: ${error.message}`);
  }
  return data ? { id: data.id, expiresAt: data.expires_at } : null;
}

// Deletes every expired session. participants, bills, items and claims go
// with it via the ON DELETE CASCADE foreign keys. Returns how many were removed.
export async function deleteExpiredSessions() {
  const { data, error } = await supabase
    .from('sessions')
    .delete()
    .lt('expires_at', new Date().toISOString())
    .select('id');
  throwIfError(error, 'deleteExpiredSessions');
  return data.length;
}

export async function getSession(sessionId) {
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .single();
  if (sessionError) return null;

  const { data: participants, error: pError } = await supabase
    .from('participants')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  throwIfError(pError, 'getSession/participants');

  const { data: bills, error: bError } = await supabase
    .from('bills')
    .select('*, items(*)')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  throwIfError(bError, 'getSession/bills');

  return {
    id: session.id,
    label: session.label,
    createdAt: session.created_at,
    expiresAt: session.expires_at,
    participants: participants.map((p) => ({
      id: p.id,
      sessionId: p.session_id,
      name: p.name,
      telegramUserId: p.telegram_user_id,
      createdAt: p.created_at,
    })),
    bills: bills.map((b) => ({
      id: b.id,
      sessionId: b.session_id,
      name: b.name,
      source: b.source,
      payerId: b.payer_id,
      serviceChargeCents: b.service_charge_cents,
      gstCents: b.gst_cents,
      totalCents: b.total_cents,
      createdAt: b.created_at,
      items: (b.items ?? []).map((i) => ({
        id: i.id,
        billId: i.bill_id,
        name: i.name,
        quantity: i.quantity,
        unitPriceCents: i.unit_price_cents,
        totalCents: i.total_cents,
        allocations: i.allocations ?? [],
      })),
    })),
  };
}

export async function addParticipant(sessionId, { name, telegramUserId = null }) {
  const { data, error } = await supabase
    .from('participants')
    .insert({ session_id: sessionId, name, telegram_user_id: telegramUserId })
    .select()
    .single();
  throwIfError(error, 'addParticipant');
  return {
    id: data.id,
    sessionId: data.session_id,
    name: data.name,
    telegramUserId: data.telegram_user_id,
    createdAt: data.created_at,
  };
}

export async function renameParticipant(_sessionId, participantId, name) {
  const { data, error } = await supabase
    .from('participants')
    .update({ name })
    .eq('id', participantId)
    .select()
    .single();
  throwIfError(error, 'renameParticipant');
  return {
    id: data.id,
    sessionId: data.session_id,
    name: data.name,
    telegramUserId: data.telegram_user_id,
    createdAt: data.created_at,
  };
}

export async function deleteParticipant(sessionId, participantId) {
  const { data: payerBills, error: checkError } = await supabase
    .from('bills')
    .select('id')
    .eq('session_id', sessionId)
    .eq('payer_id', participantId);
  throwIfError(checkError, 'deleteParticipant/check');
  if (payerBills.length > 0) {
    const err = new Error('Cannot remove a participant who is the payer on a bill');
    err.code = 'PARTICIPANT_IS_PAYER';
    throw err;
  }

  // Strip this participant out of every item's allocations jsonb array.
  // Supabase doesn't cascade into jsonb content, so this is done in code:
  // fetch every item in the session, filter, write back the ones that changed.
  const { data: bills, error: billsError } = await supabase
    .from('bills')
    .select('items(id, allocations)')
    .eq('session_id', sessionId);
  throwIfError(billsError, 'deleteParticipant/items');

  for (const bill of bills) {
    for (const item of bill.items ?? []) {
      const allocations = item.allocations ?? [];
      if (allocations.some((a) => a.participantId === participantId)) {
        const next = allocations.filter((a) => a.participantId !== participantId);
        const { error: updateError } = await supabase.from('items').update({ allocations: next }).eq('id', item.id);
        throwIfError(updateError, 'deleteParticipant/strip-allocation');
      }
    }
  }

  const { error } = await supabase.from('participants').delete().eq('id', participantId);
  throwIfError(error, 'deleteParticipant');
}

export async function addBill(sessionId, { name = null, source, payerId, serviceChargeCents = 0, gstCents = 0, totalCents, items }) {
  const { data: bill, error: billError } = await supabase
    .from('bills')
    .insert({
      session_id: sessionId,
      name,
      source,
      payer_id: payerId,
      service_charge_cents: serviceChargeCents,
      gst_cents: gstCents,
      total_cents: totalCents,
    })
    .select()
    .single();
  throwIfError(billError, 'addBill');

  const itemRows = items.map((item) => ({
    bill_id: bill.id,
    name: item.name,
    quantity: item.quantity ?? 1,
    unit_price_cents: item.unitPriceCents ?? null,
    total_cents: item.totalCents,
  }));
  const { data: insertedItems, error: itemsError } = await supabase.from('items').insert(itemRows).select();
  throwIfError(itemsError, 'addBill/items');

  return {
    id: bill.id,
    sessionId: bill.session_id,
    name: bill.name,
    source: bill.source,
    payerId: bill.payer_id,
    serviceChargeCents: bill.service_charge_cents,
    gstCents: bill.gst_cents,
    totalCents: bill.total_cents,
    createdAt: bill.created_at,
    items: insertedItems.map((i) => ({
      id: i.id,
      billId: i.bill_id,
      name: i.name,
      quantity: i.quantity,
      unitPriceCents: i.unit_price_cents,
      totalCents: i.total_cents,
      allocations: i.allocations ?? [],
    })),
  };
}

export async function deleteBill(_sessionId, billId) {
  const { error } = await supabase.from('bills').delete().eq('id', billId);
  throwIfError(error, 'deleteBill');
}

export async function setItemAllocation(_sessionId, itemId, allocations) {
  const normalised = allocations.map((a) => ({ participantId: a.participantId, quantity: a.quantity ?? 1 }));
  const { data, error } = await supabase
    .from('items')
    .update({ allocations: normalised })
    .eq('id', itemId)
    .select()
    .single();
  throwIfError(error, 'setItemAllocation');
  return {
    id: data.id,
    billId: data.bill_id,
    name: data.name,
    quantity: data.quantity,
    unitPriceCents: data.unit_price_cents,
    totalCents: data.total_cents,
    allocations: data.allocations ?? [],
  };
}
