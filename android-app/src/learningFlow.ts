import { VocabCard } from "./firestore";

export type ExerciseStage = "select_1" | "select_4" | "keyboard";

export interface ExerciseItem {
  id: string;
  cardId: string;
  stage: ExerciseStage;
  stageNumber: 1 | 2 | 3;
  options: string[];
  mistakes: number;
}

export const FALLBACK_DISTRACTORS: string[] = [
  "dog, hound",
  "coffee break / pastry",
  "library, book hall",
  "train station",
  "to win, conquer",
  "city, town",
  "house, building",
  "friend, companion",
  "morning newspaper",
  "travel, journey",
  "to speak, talk",
  "food, lunch",
  "window, glass",
  "weather, climate",
  "book, novel",
  "family, relatives",
  "music, song",
  "street, road",
  "question, inquiry",
  "answer, reply",
  "obviously, clearly",
  "to understand, grasp"
];

export function shuffleArray<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function generateFourOptions(
  correctTranslation: string,
  allCards: VocabCard[]
): string[] {
  const pool = new Set<string>();
  const normalizedCorrect = correctTranslation.trim().toLowerCase();

  for (const c of allCards) {
    const t = c.english.lemmaTranslation?.trim();
    if (t && t.toLowerCase() !== normalizedCorrect) {
      pool.add(t);
    }
  }

  for (const f of FALLBACK_DISTRACTORS) {
    if (f.toLowerCase() !== normalizedCorrect) {
      pool.add(f);
    }
  }

  const poolArray = shuffleArray(Array.from(pool));
  const distractors = poolArray.slice(0, 3);
  return shuffleArray([correctTranslation, ...distractors]);
}

export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > 2) return 99;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

export function normalizeText(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"'«»”]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isTranslationMatch(
  userInput: string,
  targetTranslation: string,
  contextualTranslation?: string
): { isMatch: boolean; isTypo: boolean } {
  const cleanInput = normalizeText(userInput)
    .replace(/^to\s+/, "")
    .replace(/^(a|an|the)\s+/, "");

  if (!cleanInput) return { isMatch: false, isTypo: false };

  const rawTargets = [targetTranslation, contextualTranslation || ""];
  const candidates: string[] = [];

  for (const raw of rawTargets) {
    if (!raw) continue;
    // Split by commas, slashes, semicolons, parentheses
    const parts = raw
      .split(/[,/;\n()]+/)
      .map((p) =>
        normalizeText(p)
          .replace(/^to\s+/, "")
          .replace(/^(a|an|the)\s+/, "")
      )
      .filter((p) => p.length > 0);

    candidates.push(...parts);

    const fullNorm = normalizeText(raw)
      .replace(/^to\s+/, "")
      .replace(/^(a|an|the)\s+/, "");
    if (fullNorm) candidates.push(fullNorm);
  }

  // 1. Exact match against any candidate synonym
  for (const candidate of candidates) {
    if (cleanInput === candidate) {
      return { isMatch: true, isTypo: false };
    }
  }

  // 2. Substring matching for multi-word phrases (e.g. candidate: "coffee and pastry", input: "coffee")
  for (const candidate of candidates) {
    if (candidate.length >= 4 && cleanInput.length >= 4) {
      if (candidate.includes(cleanInput) || cleanInput.includes(candidate)) {
        return { isMatch: true, isTypo: false };
      }
    }
  }

  // 3. Typo tolerance: Levenshtein distance <= 1 for candidate length >= 4
  for (const candidate of candidates) {
    if (candidate.length >= 4) {
      if (levenshteinDistance(cleanInput, candidate) <= 1) {
        return { isMatch: true, isTypo: true };
      }
    }
  }

  return { isMatch: false, isTypo: false };
}

/**
 * Creates the linear scaffolded lesson queue:
 * For each card:
 * Level 1: 1 Option (Introduction / Association)
 * Level 2: 4 Options (Discrimination Multiple Choice)
 * Level 3: Keyboard Entry (Active Production)
 */
export function createLessonQueue(
  studyCards: VocabCard[],
  allCards: VocabCard[]
): ExerciseItem[] {
  if (studyCards.length === 0) return [];

  const queue: ExerciseItem[] = [];

  // Stage 1 for all cards in the batch
  for (const card of studyCards) {
    queue.push({
      id: `${card.id}_s1`,
      cardId: card.id,
      stage: "select_1",
      stageNumber: 1,
      options: [card.english.lemmaTranslation],
      mistakes: 0
    });
  }

  // Stage 2 for all cards in the batch
  for (const card of studyCards) {
    queue.push({
      id: `${card.id}_s2`,
      cardId: card.id,
      stage: "select_4",
      stageNumber: 2,
      options: generateFourOptions(card.english.lemmaTranslation, allCards),
      mistakes: 0
    });
  }

  // Stage 3 for all cards in the batch
  for (const card of studyCards) {
    queue.push({
      id: `${card.id}_s3`,
      cardId: card.id,
      stage: "keyboard",
      stageNumber: 3,
      options: [],
      mistakes: 0
    });
  }

  return queue;
}
