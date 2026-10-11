import {
  generateFourOptions,
  isTranslationMatch,
  createLessonQueue,
  ExerciseItem
} from "../learningFlow.js";
import { STARTER_SWEDISH_DECK } from "../firestore.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual:   ${JSON.stringify(actual)}`
    );
  }
}

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

async function run() {
  console.log("\n🧪 Running Mobile Duolingo-Style Learning Flow Tests\n");

  await test("generateFourOptions returns 4 unique choices with correct answer included", () => {
    const correct = "dog, hound";
    const options = generateFourOptions(correct, STARTER_SWEDISH_DECK);
    assertEqual(options.length, 4, "Must generate exactly 4 options");
    assert(options.includes(correct), "Options must include the correct answer");
    const unique = new Set(options);
    assertEqual(unique.size, 4, "All 4 options must be distinct");
  });

  await test("isTranslationMatch accepts exact, case-insensitive, and punctuated matches", () => {
    const res1 = isTranslationMatch("dog", "dog, hound");
    assertEqual(res1.isMatch, true, "'dog' should match 'dog, hound'");
    assertEqual(res1.isTypo, false, "Should not be marked as typo");

    const res2 = isTranslationMatch("HOUND!", "dog, hound");
    assertEqual(res2.isMatch, true, "'HOUND!' should match 'dog, hound'");

    const res3 = isTranslationMatch("dog, hound", "dog, hound");
    assertEqual(res3.isMatch, true, "Full translation matches");
  });

  await test("isTranslationMatch handles verbs with or without 'to ' prefix", () => {
    const res1 = isTranslationMatch("win", "to win, triumph");
    assertEqual(res1.isMatch, true, "'win' matches 'to win, triumph'");

    const res2 = isTranslationMatch("to win", "win, conquer");
    assertEqual(res2.isMatch, true, "'to win' matches 'win, conquer'");
  });

  await test("isTranslationMatch tolerates minor typos (Levenshtein distance <= 1)", () => {
    const res = isTranslationMatch("librari", "library");
    assertEqual(res.isMatch, true, "'librari' should match 'library' with typo tolerance");
    assertEqual(res.isTypo, true, "Should be flagged as typo");
  });

  await test("isTranslationMatch rejects completely incorrect answers", () => {
    const res = isTranslationMatch("cat", "dog, hound");
    assertEqual(res.isMatch, false, "'cat' should not match 'dog, hound'");
  });

  await test("createLessonQueue structures linear scaffold: 1 option -> 4 options -> keyboard", () => {
    const queue = createLessonQueue(STARTER_SWEDISH_DECK, STARTER_SWEDISH_DECK);
    // 3 starter cards * 3 stages = 9 exercises
    assertEqual(queue.length, 9, "Queue should contain 9 exercises (3 cards x 3 stages)");

    // Level 1: First 3 items
    for (let i = 0; i < 3; i++) {
      assertEqual(queue[i].stage, "select_1", `Item ${i} should be stage 1`);
      assertEqual(queue[i].stageNumber, 1, `Item ${i} should have stageNumber 1`);
      assertEqual(queue[i].options.length, 1, `Stage 1 item must have exactly 1 option`);
    }

    // Level 2: Middle 3 items
    for (let i = 3; i < 6; i++) {
      assertEqual(queue[i].stage, "select_4", `Item ${i} should be stage 2`);
      assertEqual(queue[i].stageNumber, 2, `Item ${i} should have stageNumber 2`);
      assertEqual(queue[i].options.length, 4, `Stage 2 item must have exactly 4 options`);
    }

    // Level 3: Final 3 items
    for (let i = 6; i < 9; i++) {
      assertEqual(queue[i].stage, "keyboard", `Item ${i} should be stage 3`);
      assertEqual(queue[i].stageNumber, 3, `Item ${i} should have stageNumber 3`);
      assertEqual(queue[i].options.length, 0, `Stage 3 item does not need options (keyboard)`);
    }
  });

  console.log(`\n========================================`);
  console.log(`Tests finished: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    throw new Error(`${failed} test(s) failed.`);
  }
}

run();
