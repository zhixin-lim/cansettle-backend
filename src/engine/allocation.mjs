/**
 * Splits `totalCents` across participants proportionally to `weight`.
 *
 * Rule (per the locked-in spec):
 *  - Every participant except the one with the largest weight gets their
 *    raw proportional share rounded to the nearest cent.
 *  - The participant with the largest weight absorbs whatever residual is
 *    left over, so the allocation always sums EXACTLY to totalCents.
 *  - Ties for "largest weight" are broken by array order (i.e. participant
 *    creation order) - the first participant in the array wins the tie.
 *  - If every weight is 0 (e.g. a bill with no priced items), all
 *    participants are treated as equal (weight 1) so the charge is split
 *    evenly instead of dividing by zero.
 *
 * @param {number} totalCents - integer cents to distribute
 * @param {{id: string, weight: number}[]} weights - in creation order
 * @returns {{id: string, amountCents: number}[]}
 */
export function allocateProportional(totalCents, weights) {
  if (weights.length === 0) {
    if (totalCents !== 0) {
      throw new Error('Cannot allocate a non-zero amount with no participants');
    }
    return [];
  }

  const sumWeights = weights.reduce((s, w) => s + w.weight, 0);
  const effective = sumWeights === 0 ? weights.map((w) => ({ ...w, weight: 1 })) : weights;
  const effectiveSum = effective.reduce((s, w) => s + w.weight, 0);

  let maxIdx = 0;
  for (let i = 1; i < effective.length; i++) {
    if (effective[i].weight > effective[maxIdx].weight) maxIdx = i;
  }

  let roundedSum = 0;
  const results = new Array(effective.length);

  effective.forEach((w, i) => {
    if (i === maxIdx) return; // filled in after the loop
    const raw = (totalCents * w.weight) / effectiveSum;
    const rounded = Math.round(raw);
    roundedSum += rounded;
    results[i] = { id: w.id, amountCents: rounded };
  });

  results[maxIdx] = { id: effective[maxIdx].id, amountCents: totalCents - roundedSum };

  return results;
}
