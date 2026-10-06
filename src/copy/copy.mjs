// Every user-facing string lives here, not scattered through the app -
// so the voice stays consistent and it's one place to tweak later.
// Pattern: emoji + short punchy title naming the feeling, one plain
// sentence underneath that says what's actually needed. Slang stays in
// the title/asides; the instruction itself stays plain.

import { formatCents } from './money.mjs';

export function itemNeedsAssignment(item) {
  return {
    emoji: '⚠️',
    title: 'Alamak, one more item!',
    body: `${item.name} — ${formatCents(item.totalCents)} still needs to be assigned.\nWe don't want to anyhow assume who had it 😅`,
    action: 'Assign item',
  };
}

export function itemUnclaimed(item) {
  return {
    emoji: '👀',
    title: `Eh, nobody claimed the ${item.name} yet`,
    body: 'Check with the group who had it before we can settle.',
    action: 'Resolve',
  };
}

export function sharedClaimNote(claimant, item, sharedWith) {
  const others = sharedWith.join(' and ');
  return {
    emoji: '🍰',
    title: `${claimant} says they shared the ${item.name} with ${others}`,
    body: `Just flagging so ${others} know it's on their tab too.`,
    action: null, // informational, not blocking
  };
}

export function soloClaimCollision(item, claimants) {
  const names = claimants.join(' and ');
  return {
    emoji: '🤔',
    title: `Wait, both ${names} say they had the ${item.name} — solo`,
    body: 'Might be a mis-click, or maybe you guys did split it. Can you double check with them?',
    action: 'Sort it out',
  };
}

export function billDoesNotReconcile() {
  return {
    emoji: '🧐',
    title: "Hmm, the numbers don't add up",
    body: "This bill's total doesn't match what we calculated — might be a typo somewhere.",
    action: 'Check the details',
  };
}

export function allSettled(totalCents) {
  return {
    emoji: '✓',
    title: 'All settled!',
    body: `Everything's accounted for and the numbers match the receipt.\nTotal: ${formatCents(totalCents)}`,
  };
}

export function settlementTransfers(transfers, participantNameById) {
  return {
    emoji: null,
    title: 'Steady. Here\'s who pays who:',
    lines: transfers.map(
      (t) => `${participantNameById[t.from]} → ${participantNameById[t.to]} ${formatCents(t.amountCents)}`
    ),
    actions: ['View how we calculated this', 'Copy message'],
  };
}

export function shareableMessage({ sessionLabel, transfers, participantNameById, totalCents }) {
  const lines = transfers.map(
    (t) => `${participantNameById[t.from]} → ${participantNameById[t.to]} ${formatCents(t.amountCents)}`
  );
  return [
    `🍽️ ${sessionLabel} settled!`,
    ...lines,
    `✓ Numbers check out — Total: ${formatCents(totalCents)}`,
  ].join('\n');
}

export function sessionExpiringSoon(hoursLeft) {
  return {
    emoji: '⏰',
    title: `This session closes in ${hoursLeft} hours`,
    body: 'Get everyone to chop chop confirm before it auto-closes.',
  };
}

export function newSessionPrompt() {
  return {
    emoji: null,
    title: "Got a bill to settle? Chuck the receipt here and we'll sort out who owes what 👍",
  };
}

export function chooseOwnershipMode() {
  return {
    title: 'Know who had what already, or need to ask around?',
    actions: ['I know already', "Not sure, let's ask"],
  };
}

export function whoAreYouPrompt() {
  return {
    emoji: '👋',
    title: 'Who are you in this group?',
    body: "Pick your name below — if you're not on the list, ping the host.",
  };
}

export function receiptReviewPrompt() {
  return {
    emoji: '📸',
    title: "Here's what we managed to read off the receipt",
    body: 'Double-check the items below — foreign fonts and crumpled receipts confuse us sometimes 😅',
    actions: ['Looks right', 'Fix something'],
  };
}

export function manualEntryPrompt() {
  return {
    title: 'No receipt? No problem. Just tell us what was ordered and we\'ll take it from there.',
  };
}

export function responseStatus(responded, total, unresolvedCount) {
  const headline =
    responded === total
      ? `📋 ${responded} of ${total} replied — nice, no chasing needed`
      : `📬 ${responded} of ${total} have replied`;
  const body =
    unresolvedCount > 0
      ? `Just ${unresolvedCount} thing${unresolvedCount === 1 ? '' : 's'} left to sort out before we can settle.`
      : 'All good — ready to settle once you are.';
  return { title: headline, body };
}
