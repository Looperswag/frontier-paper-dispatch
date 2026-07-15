export function precisionAtK(relevant: readonly boolean[], k: number): number {
  const limit = Math.max(0, Math.min(k, relevant.length));
  if (!limit) return 0;
  return relevant.slice(0, limit).filter(Boolean).length / limit;
}

export function ndcgAtK(relevance: readonly number[], k: number): number {
  const limit = Math.max(0, Math.min(k, relevance.length));
  if (!limit) return 0;
  const dcg = relevance.slice(0, limit).reduce((sum, value, index) => sum + (2 ** Math.max(0, value) - 1) / Math.log2(index + 2), 0);
  const ideal = [...relevance].sort((a, b) => b - a).slice(0, limit)
    .reduce((sum, value, index) => sum + (2 ** Math.max(0, value) - 1) / Math.log2(index + 2), 0);
  return ideal ? dcg / ideal : 0;
}
