// All money in this engine is represented as integer cents.
// Never pass floating-point dollar amounts into the calculation functions.

/**
 * Convenience helper for writing test cases / manual-entry input in dollars.
 * Do not use this inside the calculation engine itself - only at the edges
 * (parsing user input, formatting output).
 */
export function dollarsToCents(dollars) {
  return Math.round(dollars * 100);
}

export function centsToDollars(cents) {
  return cents / 100;
}

export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}$${dollars}.${rem.toString().padStart(2, '0')}`;
}
