interface SampleIdentity {
  answer: string;
  date: string;
  certainty: "established" | "uncertain";
  scene: string;
  key: string;
  content?: string;
}

/** A confirmed typical answer first, then distinct dates, certainty and situations. */
export function representativeSamples<T>(items: readonly T[], identity: (item: T) => SampleIdentity): T[] {
  const candidates = items.map(item => ({ item, identity: identity(item) }));
  const support = new Map<string, Set<string>>();
  for (const candidate of candidates) if (candidate.identity.certainty === "established") {
    const answers = support.get(candidate.identity.scene) ?? new Set<string>();
    answers.add(candidate.identity.answer);
    support.set(candidate.identity.scene, answers);
  }
  candidates.sort((a, b) =>
    Number(b.identity.certainty === "established") - Number(a.identity.certainty === "established") ||
    (support.get(b.identity.scene)?.size ?? 0) - (support.get(a.identity.scene)?.size ?? 0) ||
    b.identity.date.localeCompare(a.identity.date) || a.identity.key.localeCompare(b.identity.key));
  const selected: typeof candidates = [];
  while (candidates.length && selected.length < 3) {
    const novelty = (candidate: typeof candidates[number]) =>
      Number(!selected.some(item => item.identity.certainty === candidate.identity.certainty)) * 4 +
      Number(!selected.some(item => item.identity.scene === candidate.identity.scene)) * 2 +
      Number(!selected.some(item => item.identity.date === candidate.identity.date));
    let index = 0;
    if (selected.length) for (let i = 1; i < candidates.length; i++)
      if (novelty(candidates[i]!) > novelty(candidates[index]!)) index = i;
    const [candidate] = candidates.splice(index, 1);
    selected.push(candidate!);
    for (let i = candidates.length - 1; i >= 0; i--)
      if (candidates[i]!.identity.answer === candidate!.identity.answer ||
        (candidate!.identity.content !== undefined && candidates[i]!.identity.content === candidate!.identity.content)) candidates.splice(i, 1);
  }
  return selected.map(({ item }) => item);
}
