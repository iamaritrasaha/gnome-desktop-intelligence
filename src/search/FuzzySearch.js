/*
 * Fuzzy matching adapted from Rudra by NarkAgni.
 * Copyright (C) 2026 NarkAgni
 * Copyright (C) 2026 GDI contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function fuzzyMatchScore(query, text) {
  if (!query)
    return 0;
  if (!text)
    return -1;

  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let queryIndex = 0;
  let textIndex = 0;
  let score = 0;
  let consecutive = 0;

  while (queryIndex < q.length && textIndex < t.length) {
    const scanLimit = Math.min(textIndex + 15, t.length);
    let bestIndex = -1;
    let bestScore = -1;

    for (let index = textIndex; index < scanLimit; index++) {
      if (q[queryIndex] !== t[index])
        continue;

      let characterScore = 10;
      if (index === 0)
        characterScore += 50;
      else if ([' ', '-', '_', '.'].includes(t[index - 1]))
        characterScore += 40;
      else if (text[index] >= 'A' && text[index] <= 'Z' &&
          text[index - 1] >= 'a' && text[index - 1] <= 'z')
        characterScore += 30;

      if (index === textIndex && consecutive > 0)
        characterScore += 15 + consecutive * 5;
      characterScore -= index - textIndex;

      if (characterScore > bestScore) {
        bestScore = characterScore;
        bestIndex = index;
      }
    }

    if (bestIndex < 0) {
      let found = false;
      for (let index = scanLimit; index < t.length; index++) {
        if (q[queryIndex] !== t[index])
          continue;
        score += 10 - Math.floor((index - textIndex) / 3);
        consecutive = 1;
        textIndex = index + 1;
        queryIndex++;
        found = true;
        break;
      }
      if (!found)
        return -1;
      continue;
    }

    score += bestScore;
    if (bestIndex === textIndex)
      consecutive++;
    else {
      consecutive = 1;
      score -= Math.floor((bestIndex - textIndex) / 3);
    }
    textIndex = bestIndex + 1;
    queryIndex++;
  }

  if (queryIndex < q.length)
    return -1;

  score -= (t.length - q.length) * 0.5;
  return Math.max(0, score);
}
