/**
 * FSRS-4.5 (Free Spaced Repetition Scheduler) Implementation
 * Tracks Stability (S), Difficulty (D), and Retrievability (R) for optimal memory retention.
 */

export type Rating = 1 | 2 | 3 | 4; // 1 = Again, 2 = Hard, 3 = Good, 4 = Easy

export interface FSRSState {
  due: string; // ISO timestamp
  stability: number; // S: days until retrievability drops to 90%
  difficulty: number; // D: 1.0 (easiest) to 10.0 (hardest)
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  state: number; // 0 = New, 1 = Learning, 2 = Review, 3 = Relearning
  lastReview: string | null;
}

// Default FSRS-4.5 weights trained on millions of flashcard reviews
const W = [
  0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616,
  0.1544, 1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407, 2.9466, 0.5034, 0.6567
];

const REQUEST_RETENTION = 0.9; // 90% target recall probability
const DECAY = -0.5;
const FACTOR = 19 / 81; // (0.9^(1/DECAY) - 1)

function clampDifficulty(d: number): number {
  return Math.min(Math.max(d, 1.0), 10.0);
}

function initDifficulty(rating: Rating): number {
  return clampDifficulty(W[4] - Math.exp(W[5] * (rating - 1)) + 1);
}

function initStability(rating: Rating): number {
  return Math.max(W[rating - 1], 0.1);
}

function nextDifficulty(d: number, rating: Rating): number {
  const nextD = d - W[6] * (rating - 3);
  // Mean reversion toward initial Good difficulty
  const meanReverted = W[7] * initDifficulty(3) + (1 - W[7]) * nextD;
  return clampDifficulty(meanReverted);
}

export function calculateRetrievability(elapsedDays: number, stability: number): number {
  if (stability <= 0) return 0;
  return Math.pow(1 + (FACTOR * elapsedDays) / stability, DECAY);
}

function nextIntervalDays(stability: number): number {
  const interval = (stability / FACTOR) * (Math.pow(REQUEST_RETENTION, 1 / DECAY) - 1);
  return Math.max(1, Math.round(interval));
}

function nextRecallStability(
  d: number,
  s: number,
  r: number,
  rating: Rating
): number {
  const hardPenalty = rating === 2 ? W[15] : 1;
  const easyBonus = rating === 4 ? W[16] : 1;
  return (
    s *
    (1 +
      Math.exp(W[8]) *
        (11 - d) *
        Math.pow(s, -W[9]) *
        (Math.exp((1 - r) * W[10]) - 1) *
        hardPenalty *
        easyBonus)
  );
}

function nextForgetStability(d: number, s: number, r: number): number {
  return (
    W[11] *
    Math.pow(d, -W[12]) *
    (Math.pow(s + 1, W[13]) - 1) *
    Math.exp((1 - r) * W[14])
  );
}

/**
 * Compute updated FSRS state when user grades a flashcard
 */
export function scheduleCard(
  current: FSRSState | undefined,
  rating: Rating,
  now: Date = new Date()
): { nextState: FSRSState; intervalLabel: string } {
  const stateObj: FSRSState = current || {
    due: now.toISOString(),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    lastReview: null
  };

  const elapsedDays = stateObj.lastReview
    ? Math.max(0, (now.getTime() - new Date(stateObj.lastReview).getTime()) / 86400000)
    : 0;

  let stability = stateObj.stability;
  let difficulty = stateObj.difficulty;
  let lapses = stateObj.lapses;
  let state = stateObj.state;
  let scheduledDays = 0;
  let dueTimeMs = now.getTime();
  let intervalLabel = "";

  if (stateObj.state === 0 || stateObj.reps === 0) {
    // First review of a New card
    difficulty = initDifficulty(rating);
    stability = initStability(rating);

    if (rating === 1) {
      // Again -> 10 minutes
      state = 1;
      scheduledDays = 0;
      dueTimeMs = now.getTime() + 10 * 60 * 1000;
      intervalLabel = "10m";
    } else if (rating === 2) {
      // Hard -> 1 day
      state = 1;
      scheduledDays = 1;
      dueTimeMs = now.getTime() + 86400000;
      intervalLabel = "1d";
    } else if (rating === 3) {
      // Good -> stability interval (typically 3 days)
      state = 2;
      scheduledDays = nextIntervalDays(stability);
      dueTimeMs = now.getTime() + scheduledDays * 86400000;
      intervalLabel = `${scheduledDays}d`;
    } else {
      // Easy -> stability interval
      state = 2;
      scheduledDays = Math.max(4, nextIntervalDays(stability));
      dueTimeMs = now.getTime() + scheduledDays * 86400000;
      intervalLabel = `${scheduledDays}d`;
    }
  } else {
    // Subsequent review
    const r = calculateRetrievability(Math.max(elapsedDays, 0.5), stability);
    difficulty = nextDifficulty(difficulty, rating);

    if (rating === 1) {
      // Forgot card (Lapse)
      lapses += 1;
      state = 3; // Relearning
      stability = Math.max(0.2, nextForgetStability(difficulty, stability, r));
      scheduledDays = 0;
      dueTimeMs = now.getTime() + 15 * 60 * 1000;
      intervalLabel = "15m";
    } else {
      state = 2; // Review
      stability = nextRecallStability(difficulty, stability, r, rating);
      scheduledDays = nextIntervalDays(stability);
      if (rating === 2) {
        scheduledDays = Math.max(1, Math.round(scheduledDays * 0.8));
      } else if (rating === 4) {
        scheduledDays = Math.max(scheduledDays + 1, Math.round(scheduledDays * 1.3));
      }
      dueTimeMs = now.getTime() + scheduledDays * 86400000;
      intervalLabel = `${scheduledDays}d`;
    }
  }

  return {
    nextState: {
      due: new Date(dueTimeMs).toISOString(),
      stability: Number(stability.toFixed(2)),
      difficulty: Number(difficulty.toFixed(2)),
      elapsedDays: Number(elapsedDays.toFixed(1)),
      scheduledDays,
      reps: (stateObj.reps || 0) + 1,
      lapses,
      state,
      lastReview: now.toISOString()
    },
    intervalLabel
  };
}

/**
 * Preview intervals for all 4 buttons (Again, Hard, Good, Easy)
 */
export function previewIntervals(current: FSRSState | undefined): Record<Rating, string> {
  const now = new Date();
  return {
    1: scheduleCard(current, 1, now).intervalLabel,
    2: scheduleCard(current, 2, now).intervalLabel,
    3: scheduleCard(current, 3, now).intervalLabel,
    4: scheduleCard(current, 4, now).intervalLabel
  };
}
