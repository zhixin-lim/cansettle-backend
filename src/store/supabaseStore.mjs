// Same method names/shapes as inMemoryStore.mjs. Not runnable inside this
// sandbox (no network path to supabase.co here), but this is the real
// implementation to run once SUPABASE_URL / SUPABASE_ANON_KEY are set.

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
  const { data, error } = await supabase
    .from('sessions')
    .insert({ label: label ?? null })
    .select()
    .single();
  throwIfError(error, 'createSession');
  return { id: data.id, label: data.label, createdAt: data.created_at, expiresAt: data.expires_at };
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
        totalCents: i.total_cents,
        allocatedTo: i.allocated_to ?? [],
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
  return { id: data.id, sessionId: data.session_id, name: data.name, telegramUserId: data.telegram_user_id, createdAt: data.created_at };
}

export async function addBill(sessionId, { source, payerId, serviceChargeCents = 0, gstCents = 0, totalCents, items }) {
  const { data: bill, error: billError } = await supabase
    .from('bills')
    .insert({
      session_id: sessionId,
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
    total_cents: item.totalCents,
  }));
  const { data: insertedItems, error: itemsError } = await supabase.from('items').insert(itemRows).select();
  throwIfError(itemsError, 'addBill/items');

  return {
    id: bill.id,
    sessionId: bill.session_id,
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
      totalCents: i.total_cents,
      allocatedTo: i.allocated_to ?? [],
    })),
  };
}

export async function setItemAllocation(_sessionId, itemId, participantIds) {
  const { data, error } = await supabase
    .from('items')
    .update({ allocated_to: participantIds })
    .eq('id', itemId)
    .select()
    .single();
  throwIfError(error, 'setItemAllocation');
  return {
    id: data.id,
    billId: data.bill_id,
    name: data.name,
    quantity: data.quantity,
    totalCents: data.total_cents,
    allocatedTo: data.allocated_to ?? [],
  };
}
