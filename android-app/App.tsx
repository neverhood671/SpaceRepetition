import React, { useEffect, useState, useMemo, useRef } from "react";
import {
  SafeAreaView,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Image,
  ScrollView,
  TextInput,
  StatusBar,
  ActivityIndicator,
  Modal,
  KeyboardAvoidingView,
  Platform
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Audio } from "expo-av";
import {
  VocabCard,
  CloudSettings,
  STARTER_SWEDISH_DECK,
  fetchCardsFromCloud,
  updateCardInCloud
} from "./src/firestore";
import { scheduleCard, previewIntervals, Rating } from "./src/fsrs";
import {
  ExerciseItem,
  createLessonQueue,
  isTranslationMatch
} from "./src/learningFlow";

const STORAGE_CARDS_KEY = "@svenska_spaced_cards_v1";
const STORAGE_SETTINGS_KEY = "@svenska_spaced_settings_v1";

export default function App() {
  const [cards, setCards] = useState<VocabCard[]>(STARTER_SWEDISH_DECK);
  const [settings, setSettings] = useState<CloudSettings>({
    firebaseProjectId: "",
    firebaseApiKey: ""
  });
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  // Linear Exercise Session State
  const [queue, setQueue] = useState<ExerciseItem[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);
  const [initialTotal, setInitialTotal] = useState(0);

  // Current Exercise Interaction State
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [typedAnswer, setTypedAnswer] = useState("");
  const [isChecked, setIsChecked] = useState(false);
  const [isCorrect, setIsCorrect] = useState(false);
  const [isTypo, setIsTypo] = useState(false);
  const [cardMistakes, setCardMistakes] = useState<Record<string, number>>({});
  const [sessionCompleted, setSessionCompleted] = useState(false);

  const textInputRef = useRef<TextInput>(null);

  // 1. Initial Storage & Firestore Load
  useEffect(() => {
    (async () => {
      try {
        const [savedCardsRaw, savedSettingsRaw] = await Promise.all([
          AsyncStorage.getItem(STORAGE_CARDS_KEY),
          AsyncStorage.getItem(STORAGE_SETTINGS_KEY)
        ]);

        let loadedCards = STARTER_SWEDISH_DECK;
        if (savedCardsRaw) {
          const parsed = JSON.parse(savedCardsRaw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            loadedCards = parsed;
            setCards(parsed);
          }
        }

        if (savedSettingsRaw) {
          const parsedCfg = JSON.parse(savedSettingsRaw);
          setSettings(parsedCfg);
          if (parsedCfg.firebaseProjectId) {
            syncWithFirestore(parsedCfg, loadedCards);
          }
        }

        // Initialize linear lesson queue
        startNewLesson(loadedCards);
      } catch (e) {
        console.warn("Storage load error:", e);
      }
    })();
  }, []);

  function startNewLesson(deck: VocabCard[]) {
    const nowIso = new Date().toISOString();
    let due = deck.filter((c) => !c.fsrs?.due || c.fsrs.due <= nowIso);
    if (due.length === 0) {
      due = deck; // If all caught up, practice all cards in deck
    }
    // Limit to batch of 4 cards per lesson for ideal micro-learning chunk
    const lessonBatch = due.slice(0, 4);
    const newQueue = createLessonQueue(lessonBatch, deck);

    setQueue(newQueue);
    setQueueIndex(0);
    setCompletedCount(0);
    setInitialTotal(newQueue.length);
    setSelectedOption(null);
    setTypedAnswer("");
    setIsChecked(false);
    setIsCorrect(false);
    setIsTypo(false);
    setCardMistakes({});
    setSessionCompleted(false);

    if (newQueue.length > 0) {
      const firstCard = deck.find((c) => c.id === newQueue[0].cardId);
      if (firstCard) playSwedishAudio(firstCard);
    }
  }

  async function syncWithFirestore(cfg: CloudSettings, currentCards: VocabCard[]) {
    if (!cfg.firebaseProjectId?.trim()) return;
    setSyncing(true);
    setSyncMessage("");
    try {
      const cloudCards = await fetchCardsFromCloud(cfg);
      if (cloudCards.length > 0) {
        const mergedMap = new Map<string, VocabCard>();
        for (const c of currentCards) mergedMap.set(c.id, c);
        for (const c of cloudCards) mergedMap.set(c.id, c);
        const merged = Array.from(mergedMap.values());
        setCards(merged);
        await AsyncStorage.setItem(STORAGE_CARDS_KEY, JSON.stringify(merged));
        setSyncMessage(`✓ Synced ${cloudCards.length} cards from Firestore`);
      } else {
        setSyncMessage("Connected to Firestore (0 cloud cards)");
      }
    } catch (err: any) {
      setSyncMessage(`⚠️ Sync error: ${err.message || String(err)}`);
    } finally {
      setSyncing(false);
    }
  }

  async function playSwedishAudio(card?: VocabCard | null) {
    if (!card) return;
    const uri = card.media?.audioBase64 || card.media?.audioUrl;
    if (!uri) return;
    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true }
      );
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          sound.unloadAsync();
        }
      });
    } catch (e) {
      console.warn("Audio play error:", e);
    }
  }

  const currentExercise: ExerciseItem | null = queue[queueIndex] || null;
  const currentCard: VocabCard | null = useMemo(() => {
    if (!currentExercise) return null;
    return cards.find((c) => c.id === currentExercise.cardId) || null;
  }, [currentExercise, cards]);

  // Handle Level 1 tap: immediately selects and checks
  function handleSelectStage1(opt: string) {
    if (isChecked) return;
    setSelectedOption(opt);
    setIsChecked(true);
    setIsCorrect(true);
    setIsTypo(false);
    if (currentCard) playSwedishAudio(currentCard);
  }

  // Handle Level 2 option selection
  function handleSelectStage2(opt: string) {
    if (isChecked) return;
    setSelectedOption(opt);
  }

  // Check the answer (for Level 2 multiple choice or Level 3 keyboard input)
  function handleCheckAnswer() {
    if (!currentExercise || !currentCard || isChecked) return;

    if (currentExercise.stage === "select_4") {
      if (!selectedOption) return;
      const target = currentCard.english.lemmaTranslation.trim().toLowerCase();
      const chosen = selectedOption.trim().toLowerCase();
      const correct = chosen === target;

      setIsChecked(true);
      setIsCorrect(correct);
      setIsTypo(false);

      if (!correct) {
        setCardMistakes((prev) => ({
          ...prev,
          [currentCard.id]: (prev[currentCard.id] || 0) + 1
        }));
      } else {
        playSwedishAudio(currentCard);
      }
    } else if (currentExercise.stage === "keyboard") {
      if (!typedAnswer.trim()) return;
      const matchResult = isTranslationMatch(
        typedAnswer,
        currentCard.english.lemmaTranslation,
        currentCard.english.contextualTranslation
      );

      setIsChecked(true);
      setIsCorrect(matchResult.isMatch);
      setIsTypo(matchResult.isTypo);

      if (!matchResult.isMatch) {
        setCardMistakes((prev) => ({
          ...prev,
          [currentCard.id]: (prev[currentCard.id] || 0) + 1
        }));
      } else {
        playSwedishAudio(currentCard);
      }
    }
  }

  function handleDontRemember() {
    if (!currentExercise || !currentCard || isChecked) return;
    setIsChecked(true);
    setIsCorrect(false);
    setIsTypo(false);
    setCardMistakes((prev) => ({
      ...prev,
      [currentCard.id]: (prev[currentCard.id] || 0) + 1
    }));
    playSwedishAudio(currentCard);
  }

  // Advance to the next exercise in the linear flow
  async function handleContinue() {
    if (!currentExercise || !currentCard) return;

    let nextQueue = [...queue];

    if (!isCorrect) {
      // Re-queue the failed exercise at the end of the queue so the user masters it
      nextQueue.push({
        ...currentExercise,
        mistakes: currentExercise.mistakes + 1
      });
    } else {
      setCompletedCount((c) => c + 1);

      // If this was the final keyboard production stage, schedule card in FSRS
      if (currentExercise.stage === "keyboard") {
        const mistakes = cardMistakes[currentCard.id] || 0;
        const rating: Rating = mistakes === 0 ? 3 : mistakes === 1 ? 2 : 1;
        const { nextState } = scheduleCard(currentCard.fsrs, rating, new Date());
        const updatedCard: VocabCard = { ...currentCard, fsrs: nextState };

        const nextCards = cards.map((c) => (c.id === updatedCard.id ? updatedCard : c));
        setCards(nextCards);
        await AsyncStorage.setItem(STORAGE_CARDS_KEY, JSON.stringify(nextCards));

        if (settings.firebaseProjectId?.trim()) {
          updateCardInCloud(updatedCard, settings).catch((e) =>
            console.warn("Cloud update failed:", e)
          );
        }
      }
    }

    const nextIndex = queueIndex + 1;
    if (nextIndex >= nextQueue.length) {
      // All exercises completed!
      setSessionCompleted(true);
      setQueue([]);
      setQueueIndex(0);
    } else {
      setQueue(nextQueue);
      setQueueIndex(nextIndex);
      setSelectedOption(null);
      setTypedAnswer("");
      setIsChecked(false);
      setIsCorrect(false);
      setIsTypo(false);

      const nextItem = nextQueue[nextIndex];
      const nextCardObj = cards.find((c) => c.id === nextItem.cardId);
      if (nextCardObj) playSwedishAudio(nextCardObj);
    }
  }

  function getBannerColor(article?: string) {
    if (article === "en") return "#0284c7";
    if (article === "ett") return "#16a34a";
    return "#005B99";
  }

  const progressPercent = useMemo(() => {
    if (initialTotal <= 0) return 100;
    return Math.min(100, Math.round((completedCount / initialTotal) * 100));
  }, [completedCount, initialTotal]);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#004270" />

      {/* TOP HEADER: Duolingo Linear Progress Bar */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.brandTitle}>🇸🇪 SvenskaSpaced</Text>
          <TouchableOpacity
            style={styles.settingsIconBtn}
            onPress={() => setShowSettingsModal(true)}
          >
            <Text style={{ fontSize: 18 }}>⚙️</Text>
          </TouchableOpacity>
        </View>

        {/* Linear Progress Bar */}
        <View style={styles.progressBarBackground}>
          <View
            style={[styles.progressBarFill, { width: `${progressPercent}%` }]}
          />
        </View>
        <Text style={styles.progressSubtext}>
          {sessionCompleted
            ? "100% Complete"
            : `Exercise ${Math.min(completedCount + 1, initialTotal)} of ${initialTotal}`}
        </Text>
      </View>

      {/* MAIN EXERCISE BODY */}
      {sessionCompleted ? (
        <ScrollView contentContainerStyle={styles.centerContainer}>
          <View style={styles.completeCard}>
            <Text style={styles.celebrateEmoji}>🎉</Text>
            <Text style={styles.completeTitle}>Bra jobbat!</Text>
            <Text style={styles.completeSubtitle}>
              You have completed all 3 levels (1-choice introduction, 4-choice discrimination, and keyboard recall) for your due Swedish cards!
            </Text>

            <TouchableOpacity
              style={styles.duoPrimaryBtn}
              onPress={() => startNewLesson(cards)}
            >
              <Text style={styles.duoPrimaryBtnText}>↻ Practice Again</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.duoSecondaryBtn, { marginTop: 12 }]}
              onPress={() => setShowSettingsModal(true)}
            >
              <Text style={styles.duoSecondaryBtnText}>📚 View Word Deck & Sync</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      ) : !currentCard || !currentExercise ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#005B99" />
        </View>
      ) : (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView contentContainerStyle={styles.exerciseContent}>
            {/* Level Badge & Instructions */}
            <View style={styles.instructionRow}>
              <View
                style={[
                  styles.levelPill,
                  {
                    backgroundColor:
                      currentExercise.stageNumber === 1
                        ? "#e0f2fe"
                        : currentExercise.stageNumber === 2
                        ? "#fef3c7"
                        : "#dcfce7"
                  }
                ]}
              >
                <Text
                  style={[
                    styles.levelPillText,
                    {
                      color:
                        currentExercise.stageNumber === 1
                          ? "#0369a1"
                          : currentExercise.stageNumber === 2
                          ? "#b45309"
                          : "#15803d"
                    }
                  ]}
                >
                  {currentExercise.stageNumber === 1
                    ? "LEVEL 1 • 1 OPTION"
                    : currentExercise.stageNumber === 2
                    ? "LEVEL 2 • 4 CHOICES"
                    : "LEVEL 3 • TYPE FROM KEYBOARD"}
                </Text>
              </View>

              <Text style={styles.instructionText}>
                {currentExercise.stage === "select_1"
                  ? "Tap to confirm the translation:"
                  : currentExercise.stage === "select_4"
                  ? "Select the correct translation:"
                  : "Type the translation in English:"}
              </Text>
            </View>

            {/* Prompt Card */}
            <View style={styles.promptCard}>
              <View
                style={[
                  styles.promptBanner,
                  {
                    backgroundColor: getBannerColor(currentCard.swedish.article)
                  }
                ]}
              >
                <Text style={styles.bannerGenderText}>
                  {currentCard.swedish.article
                    ? `${currentCard.swedish.article.toUpperCase()}-ORD`
                    : currentCard.swedish.partOfSpeech.toUpperCase()}
                </Text>
                <TouchableOpacity
                  style={styles.speakerPill}
                  onPress={() => playSwedishAudio(currentCard)}
                >
                  <Text style={styles.speakerPillText}>🔊 Pronunciation</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.promptBody}>
                {currentCard.media?.imageUrl ? (
                  <Image
                    source={{ uri: currentCard.media.imageUrl }}
                    style={styles.promptImage}
                    resizeMode="cover"
                  />
                ) : null}

                <Text style={styles.swedishWordText}>
                  {currentCard.swedish.article
                    ? `${currentCard.swedish.article} ${currentCard.swedish.lemma}`
                    : currentCard.swedish.lemma}
                </Text>

                {currentCard.swedish.contextSentence ? (
                  <View style={styles.contextBubble}>
                    <Text style={styles.contextSentenceText}>
                      ”{currentCard.swedish.contextSentence}”
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>

            {/* LEVEL 1: SINGLE OPTION CONFIRMATION */}
            {currentExercise.stage === "select_1" && (
              <View style={styles.optionsContainer}>
                {currentExercise.options.map((opt, idx) => {
                  const isChosen = selectedOption === opt;
                  return (
                    <TouchableOpacity
                      key={idx}
                      style={[
                        styles.optionCard,
                        isChosen && styles.optionCardCorrect
                      ]}
                      onPress={() => handleSelectStage1(opt)}
                      activeOpacity={0.8}
                    >
                      <View style={[styles.optionKeyCircle, isChosen && styles.optionKeyCircleCorrect]}>
                        <Text style={[styles.optionKeyText, isChosen && styles.optionKeyTextCorrect]}>
                          1
                        </Text>
                      </View>
                      <Text
                        style={[
                          styles.optionTitle,
                          isChosen && styles.optionTitleCorrect
                        ]}
                      >
                        {opt}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* LEVEL 2: 4 OPTIONS MULTIPLE CHOICE */}
            {currentExercise.stage === "select_4" && (
              <View style={styles.optionsContainer}>
                {currentExercise.options.map((opt, idx) => {
                  const isSelected = selectedOption === opt;
                  const isTarget =
                    opt.trim().toLowerCase() ===
                    currentCard.english.lemmaTranslation.trim().toLowerCase();

                  let cardStyle = styles.optionCard;
                  let keyCircleStyle = styles.optionKeyCircle;
                  let keyTextStyle = styles.optionKeyText;
                  let titleStyle = styles.optionTitle;

                  if (isChecked) {
                    if (isTarget) {
                      cardStyle = styles.optionCardCorrect;
                      keyCircleStyle = styles.optionKeyCircleCorrect;
                      keyTextStyle = styles.optionKeyTextCorrect;
                      titleStyle = styles.optionTitleCorrect;
                    } else if (isSelected && !isTarget) {
                      cardStyle = styles.optionCardWrong;
                      keyCircleStyle = styles.optionKeyCircleWrong;
                      keyTextStyle = styles.optionKeyTextWrong;
                      titleStyle = styles.optionTitleWrong;
                    }
                  } else if (isSelected) {
                    cardStyle = styles.optionCardSelected;
                    keyCircleStyle = styles.optionKeyCircleSelected;
                    keyTextStyle = styles.optionKeyTextSelected;
                    titleStyle = styles.optionTitleSelected;
                  }

                  return (
                    <TouchableOpacity
                      key={idx}
                      style={cardStyle}
                      onPress={() => handleSelectStage2(opt)}
                      activeOpacity={0.7}
                    >
                      <View style={keyCircleStyle}>
                        <Text style={keyTextStyle}>{idx + 1}</Text>
                      </View>
                      <Text style={titleStyle}>{opt}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* LEVEL 3: KEYBOARD PRODUCTION ENTRY */}
            {currentExercise.stage === "keyboard" && (
              <View style={styles.keyboardContainer}>
                <TextInput
                  ref={textInputRef}
                  style={[
                    styles.keyboardInput,
                    isChecked && isCorrect && styles.keyboardInputCorrect,
                    isChecked && !isCorrect && styles.keyboardInputWrong
                  ]}
                  placeholder="Type translation in English..."
                  placeholderTextColor="#94a3b8"
                  value={typedAnswer}
                  onChangeText={setTypedAnswer}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isChecked}
                  onSubmitEditing={handleCheckAnswer}
                  returnKeyType="done"
                  autoFocus
                />

                {!isChecked && (
                  <TouchableOpacity
                    style={styles.dontRememberBtn}
                    onPress={handleDontRemember}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.dontRememberText}>
                      🤷‍♂️ I don't remember
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </ScrollView>

          {/* BOTTOM DUOLINGO ACTION BAR & FEEDBACK SHEET */}
          <View
            style={[
              styles.bottomBar,
              isChecked && (isCorrect ? styles.bottomBarCorrect : styles.bottomBarWrong)
            ]}
          >
            {isChecked ? (
              <View style={styles.feedbackContainer}>
                <View style={styles.feedbackHeaderRow}>
                  <Text
                    style={[
                      styles.feedbackTitle,
                      { color: isCorrect ? "#15803d" : "#b91c1c" }
                    ]}
                  >
                    {isCorrect
                      ? isTypo
                        ? "✓ Good (Minor typo accepted)!"
                        : "✓ Excellent / Rätt!"
                      : typedAnswer.trim()
                      ? "✗ Not quite!"
                      : "🤷‍♂️ No worries, let's learn it!"}
                  </Text>
                </View>

                {!isCorrect ? (
                  <Text style={styles.feedbackExpectedText}>
                    Correct translation:{" "}
                    <Text style={{ fontWeight: "800" }}>
                      {currentCard.english.lemmaTranslation}
                    </Text>
                  </Text>
                ) : currentCard.swedish.inflections ? (
                  <Text style={styles.feedbackMetaText}>
                    Forms: {currentCard.swedish.inflections}
                  </Text>
                ) : null}

                <TouchableOpacity
                  style={[
                    styles.continueBtn,
                    { backgroundColor: isCorrect ? "#22c55e" : "#ef4444" }
                  ]}
                  onPress={handleContinue}
                >
                  <Text style={styles.continueBtnText}>CONTINUE</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                style={[
                  styles.checkBtn,
                  (currentExercise.stage === "select_1" ||
                    (currentExercise.stage === "select_4" && selectedOption) ||
                    (currentExercise.stage === "keyboard" && typedAnswer.trim()))
                    ? styles.checkBtnActive
                    : styles.checkBtnDisabled
                ]}
                onPress={handleCheckAnswer}
                disabled={
                  currentExercise.stage === "select_4"
                    ? !selectedOption
                    : currentExercise.stage === "keyboard"
                    ? !typedAnswer.trim()
                    : true
                }
              >
                <Text
                  style={[
                    styles.checkBtnText,
                    (currentExercise.stage === "select_1" ||
                      (currentExercise.stage === "select_4" && selectedOption) ||
                      (currentExercise.stage === "keyboard" && typedAnswer.trim()))
                      ? styles.checkBtnTextActive
                      : styles.checkBtnTextDisabled
                  ]}
                >
                  CHECK
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </KeyboardAvoidingView>
      )}

      {/* SETTINGS & CLOUD SYNC MODAL */}
      <Modal visible={showSettingsModal} animationType="slide">
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>⚙️ Settings & Vocabulary</Text>
            <TouchableOpacity
              style={styles.modalCloseBtn}
              onPress={() => setShowSettingsModal(false)}
            >
              <Text style={{ fontSize: 18, fontWeight: "700" }}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.modalContent}>
            {/* Firestore Cloud Sync */}
            <View style={styles.settingsSection}>
              <Text style={styles.sectionHeading}>☁️ Firestore Sync</Text>
              <Text style={styles.sectionDesc}>
                Enter the Firebase Project ID from your Chrome Extension to sync captured Swedish words.
              </Text>

              <Text style={styles.inputLabel}>Firebase Project ID</Text>
              <TextInput
                style={styles.modalInput}
                placeholder="e.g. svenska-vocab-12345"
                value={settings.firebaseProjectId}
                onChangeText={(t) =>
                  setSettings((s) => ({ ...s, firebaseProjectId: t }))
                }
                autoCapitalize="none"
              />

              <Text style={styles.inputLabel}>Web API Key (Optional)</Text>
              <TextInput
                style={styles.modalInput}
                placeholder="AIzaSy..."
                value={settings.firebaseApiKey}
                onChangeText={(t) =>
                  setSettings((s) => ({ ...s, firebaseApiKey: t }))
                }
                autoCapitalize="none"
                secureTextEntry
              />

              <TouchableOpacity
                style={styles.duoPrimaryBtn}
                onPress={async () => {
                  await AsyncStorage.setItem(
                    STORAGE_SETTINGS_KEY,
                    JSON.stringify(settings)
                  );
                  await syncWithFirestore(settings, cards);
                }}
              >
                {syncing ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.duoPrimaryBtnText}>Save & Sync Now</Text>
                )}
              </TouchableOpacity>

              {syncMessage ? (
                <Text style={styles.syncStatusMsg}>{syncMessage}</Text>
              ) : null}
            </View>

            {/* Deck List */}
            <View style={styles.settingsSection}>
              <Text style={styles.sectionHeading}>
                📚 Saved Words ({cards.length})
              </Text>
              {cards.map((c) => (
                <View key={c.id} style={styles.wordRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.wordRowSv}>
                      {c.swedish.article ? `${c.swedish.article} ` : ""}
                      {c.swedish.lemma}
                    </Text>
                    <Text style={styles.wordRowEn}>
                      {c.english.lemmaTranslation}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.wordRowAudioBtn}
                    onPress={() => playSwedishAudio(c)}
                  >
                    <Text style={{ fontSize: 18 }}>🔊</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f8fafc"
  },
  header: {
    backgroundColor: "#005B99",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12
  },
  headerTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8
  },
  brandTitle: {
    color: "#ffffff",
    fontSize: 19,
    fontWeight: "800"
  },
  settingsIconBtn: {
    backgroundColor: "rgba(255,255,255,0.18)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8
  },
  progressBarBackground: {
    height: 10,
    backgroundColor: "rgba(255,255,255,0.25)",
    borderRadius: 999,
    overflow: "hidden"
  },
  progressBarFill: {
    height: "100%",
    backgroundColor: "#FECC02",
    borderRadius: 999
  },
  progressSubtext: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 11,
    fontWeight: "700",
    marginTop: 4,
    textAlign: "right"
  },
  exerciseContent: {
    padding: 16,
    paddingBottom: 24
  },
  instructionRow: {
    marginBottom: 12
  },
  levelPill: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginBottom: 6
  },
  levelPillText: {
    fontSize: 10.5,
    fontWeight: "800",
    letterSpacing: 0.5
  },
  instructionText: {
    fontSize: 17,
    fontWeight: "800",
    color: "#0f172a"
  },
  promptCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    overflow: "hidden",
    marginBottom: 16,
    elevation: 2,
    shadowColor: "#0f172a",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 }
  },
  promptBanner: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center"
  },
  bannerGenderText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "800"
  },
  speakerPill: {
    backgroundColor: "rgba(255,255,255,0.22)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999
  },
  speakerPillText: {
    color: "#ffffff",
    fontSize: 11.5,
    fontWeight: "700"
  },
  promptBody: {
    padding: 16,
    alignItems: "center"
  },
  promptImage: {
    width: "100%",
    height: 150,
    borderRadius: 12,
    marginBottom: 12,
    backgroundColor: "#e2e8f0"
  },
  swedishWordText: {
    fontSize: 28,
    fontWeight: "800",
    color: "#0f172a",
    marginBottom: 10,
    textAlign: "center"
  },
  contextBubble: {
    backgroundColor: "#f8fafc",
    borderLeftWidth: 4,
    borderLeftColor: "#005B99",
    padding: 10,
    borderRadius: 8,
    width: "100%"
  },
  contextSentenceText: {
    fontSize: 14,
    color: "#334155",
    fontStyle: "italic",
    textAlign: "center"
  },
  optionsContainer: {
    gap: 10
  },
  optionCard: {
    backgroundColor: "#ffffff",
    borderWidth: 2,
    borderColor: "#e2e8f0",
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12
  },
  optionCardSelected: {
    borderColor: "#005B99",
    backgroundColor: "#f0f9ff"
  },
  optionCardCorrect: {
    borderColor: "#22c55e",
    backgroundColor: "#f0fdf4"
  },
  optionCardWrong: {
    borderColor: "#ef4444",
    backgroundColor: "#fef2f2"
  },
  optionKeyCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "#cbd5e1",
    alignItems: "center",
    justifyContent: "center"
  },
  optionKeyCircleSelected: {
    borderColor: "#005B99",
    backgroundColor: "#005B99"
  },
  optionKeyCircleCorrect: {
    borderColor: "#22c55e",
    backgroundColor: "#22c55e"
  },
  optionKeyCircleWrong: {
    borderColor: "#ef4444",
    backgroundColor: "#ef4444"
  },
  optionKeyText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#64748b"
  },
  optionKeyTextSelected: {
    color: "#ffffff"
  },
  optionKeyTextCorrect: {
    color: "#ffffff"
  },
  optionKeyTextWrong: {
    color: "#ffffff"
  },
  optionTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#1e293b",
    flex: 1
  },
  optionTitleSelected: {
    color: "#005B99"
  },
  optionTitleCorrect: {
    color: "#15803d"
  },
  optionTitleWrong: {
    color: "#b91c1c"
  },
  keyboardContainer: {
    marginTop: 6
  },
  keyboardInput: {
    backgroundColor: "#ffffff",
    borderWidth: 2,
    borderColor: "#cbd5e1",
    borderRadius: 14,
    padding: 14,
    fontSize: 18,
    fontWeight: "600",
    color: "#0f172a"
  },
  keyboardInputCorrect: {
    borderColor: "#22c55e",
    backgroundColor: "#f0fdf4"
  },
  keyboardInputWrong: {
    borderColor: "#ef4444",
    backgroundColor: "#fef2f2"
  },
  dontRememberBtn: {
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#cbd5e1",
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center"
  },
  dontRememberText: {
    fontSize: 14.5,
    fontWeight: "700",
    color: "#64748b"
  },
  bottomBar: {
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    padding: 16,
    backgroundColor: "#ffffff"
  },
  bottomBarCorrect: {
    backgroundColor: "#dcfce7",
    borderTopColor: "#86efac"
  },
  bottomBarWrong: {
    backgroundColor: "#fee2e2",
    borderTopColor: "#fca5a5"
  },
  checkBtn: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center"
  },
  checkBtnDisabled: {
    backgroundColor: "#e2e8f0"
  },
  checkBtnActive: {
    backgroundColor: "#005B99"
  },
  checkBtnText: {
    fontSize: 15,
    fontWeight: "800"
  },
  checkBtnTextDisabled: {
    color: "#94a3b8"
  },
  checkBtnTextActive: {
    color: "#ffffff"
  },
  feedbackContainer: {
    gap: 8
  },
  feedbackHeaderRow: {
    flexDirection: "row",
    alignItems: "center"
  },
  feedbackTitle: {
    fontSize: 18,
    fontWeight: "800"
  },
  feedbackExpectedText: {
    fontSize: 14.5,
    color: "#b91c1c",
    lineHeight: 20
  },
  feedbackMetaText: {
    fontSize: 12.5,
    color: "#166534"
  },
  continueBtn: {
    marginTop: 6,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center"
  },
  continueBtnText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "800"
  },
  centerContainer: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 20
  },
  completeCard: {
    backgroundColor: "#ffffff",
    borderRadius: 20,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e2e8f0"
  },
  celebrateEmoji: {
    fontSize: 48,
    marginBottom: 10
  },
  completeTitle: {
    fontSize: 24,
    fontWeight: "800",
    color: "#0f172a",
    marginBottom: 8
  },
  completeSubtitle: {
    fontSize: 14.5,
    color: "#475569",
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 20
  },
  duoPrimaryBtn: {
    backgroundColor: "#005B99",
    paddingVertical: 13,
    paddingHorizontal: 20,
    borderRadius: 12,
    width: "100%",
    alignItems: "center"
  },
  duoPrimaryBtnText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "800"
  },
  duoSecondaryBtn: {
    backgroundColor: "#f1f5f9",
    paddingVertical: 13,
    paddingHorizontal: 20,
    borderRadius: 12,
    width: "100%",
    alignItems: "center"
  },
  duoSecondaryBtnText: {
    color: "#334155",
    fontSize: 14.5,
    fontWeight: "700"
  },
  modalContainer: {
    flex: 1,
    backgroundColor: "#f8fafc"
  },
  modalHeader: {
    padding: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
    backgroundColor: "#ffffff"
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#0f172a"
  },
  modalCloseBtn: {
    padding: 6
  },
  modalContent: {
    padding: 16
  },
  settingsSection: {
    backgroundColor: "#ffffff",
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    marginBottom: 16
  },
  sectionHeading: {
    fontSize: 16,
    fontWeight: "800",
    color: "#0f172a",
    marginBottom: 6
  },
  sectionDesc: {
    fontSize: 13,
    color: "#64748b",
    lineHeight: 18,
    marginBottom: 14
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#334155",
    marginBottom: 4
  },
  modalInput: {
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    padding: 10,
    fontSize: 14,
    marginBottom: 12,
    color: "#0f172a"
  },
  syncStatusMsg: {
    marginTop: 10,
    fontSize: 13,
    fontWeight: "700",
    color: "#005B99",
    textAlign: "center"
  },
  wordRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9"
  },
  wordRowSv: {
    fontSize: 15,
    fontWeight: "700",
    color: "#0f172a"
  },
  wordRowEn: {
    fontSize: 13,
    color: "#64748b",
    marginTop: 2
  },
  wordRowAudioBtn: {
    padding: 8
  }
});
