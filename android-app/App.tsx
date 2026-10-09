import React, { useEffect, useState, useMemo } from "react";
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
  ActivityIndicator
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

const STORAGE_CARDS_KEY = "@svenska_spaced_cards_v1";
const STORAGE_SETTINGS_KEY = "@svenska_spaced_settings_v1";

type TabType = "review" | "deck" | "settings";
type StudyMode = "auto" | "recognition" | "cloze";

export default function App() {
  const [activeTab, setActiveTab] = useState<TabType>("review");
  const [cards, setCards] = useState<VocabCard[]>(STARTER_SWEDISH_DECK);
  const [settings, setSettings] = useState<CloudSettings>({
    firebaseProjectId: "",
    firebaseApiKey: ""
  });
  const [isRevealed, setIsRevealed] = useState(false);
  const [studyMode, setStudyMode] = useState<StudyMode>("auto");
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [savedCardsRaw, savedSettingsRaw] = await Promise.all([
          AsyncStorage.getItem(STORAGE_CARDS_KEY),
          AsyncStorage.getItem(STORAGE_SETTINGS_KEY)
        ]);
        if (savedCardsRaw) {
          const parsed = JSON.parse(savedCardsRaw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setCards(parsed);
          }
        }
        if (savedSettingsRaw) {
          const parsedCfg = JSON.parse(savedSettingsRaw);
          setSettings(parsedCfg);
          if (parsedCfg.firebaseProjectId) {
            syncWithFirestore(parsedCfg, savedCardsRaw ? JSON.parse(savedCardsRaw) : STARTER_SWEDISH_DECK);
          }
        }
      } catch (e) {
        console.warn("Storage load error:", e);
      }
    })();
  }, []);

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
        setSyncMessage("Connected to Firestore (0 cloud cards yet)");
      }
    } catch (err: any) {
      setSyncMessage(`⚠️ Sync error: ${err.message || String(err)}`);
    } finally {
      setSyncing(false);
    }
  }

  async function playSwedishAudio(card: VocabCard) {
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

  // Filter cards that are due right now
  const dueCards = useMemo(() => {
    const nowIso = new Date().toISOString();
    return cards
      .filter((c) => !c.fsrs?.due || c.fsrs.due <= nowIso)
      .sort((a, b) => (a.fsrs?.due || "").localeCompare(b.fsrs?.due || ""));
  }, [cards]);

  const currentCard = dueCards[0] || null;

  // Determine whether current card uses Recognition or Active Recall (Cloze)
  const effectiveMode = useMemo(() => {
    if (!currentCard) return "recognition";
    if (studyMode !== "auto") return studyMode;
    // Educational tactic: Use Recognition for new cards, switch to Cloze Active Recall once Stability >= 2 days
    return (currentCard.fsrs?.stability || 0) >= 2 ? "cloze" : "recognition";
  }, [currentCard, studyMode]);

  const intervals = useMemo(() => {
    return previewIntervals(currentCard?.fsrs);
  }, [currentCard]);

  async function handleRate(rating: Rating) {
    if (!currentCard) return;
    const { nextState } = scheduleCard(currentCard.fsrs, rating, new Date());
    const updatedCard: VocabCard = {
      ...currentCard,
      fsrs: nextState
    };

    const nextDeck = cards.map((c) => (c.id === updatedCard.id ? updatedCard : c));
    setCards(nextDeck);
    setIsRevealed(false);
    await AsyncStorage.setItem(STORAGE_CARDS_KEY, JSON.stringify(nextDeck));

    if (settings.firebaseProjectId?.trim()) {
      updateCardInCloud(updatedCard, settings).catch((e) =>
        console.warn("Cloud update failed:", e)
      );
    }
  }

  function renderClozeSentence(sentence?: string, surface?: string, lemma?: string) {
    if (!sentence) return "—";
    const target = surface || lemma || "";
    if (!target) return sentence;
    const regex = new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    if (regex.test(sentence)) {
      return sentence.replace(regex, "[ ______ ]");
    }
    return sentence;
  }

  function getGenderColors(article?: string) {
    if (article === "en") return { bg: "#0284c7", badgeBg: "#bae6fd", badgeText: "#0369a1" };
    if (article === "ett") return { bg: "#16a34a", badgeBg: "#bbf7d0", badgeText: "#15803d" };
    return { bg: "#005B99", badgeBg: "#fef08a", badgeText: "#854d0e" };
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#004270" />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.brandTitle}>🇸🇪 SvenskaSpaced</Text>
          <View style={styles.statsPill}>
            <Text style={styles.statsPillText}>
              Due: {dueCards.length} / {cards.length}
            </Text>
          </View>
        </View>

        <View style={styles.navBar}>
          {(["review", "deck", "settings"] as TabType[]).map((tab) => (
            <TouchableOpacity
              key={tab}
              style={[styles.navBtn, activeTab === tab && styles.navBtnActive]}
              onPress={() => setActiveTab(tab)}
            >
              <Text
                style={[
                  styles.navBtnText,
                  activeTab === tab && styles.navBtnTextActive
                ]}
              >
                {tab === "review"
                  ? `🎯 Review (${dueCards.length})`
                  : tab === "deck"
                  ? `📚 Words (${cards.length})`
                  : "☁️ Cloud Sync"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* TAB 1: SPACED REPETITION FLASHCARD REVIEW */}
      {activeTab === "review" && (
        <ScrollView contentContainerStyle={styles.mainContent}>
          {/* Study Mode Selector */}
          <View style={styles.modeRow}>
            {(["auto", "recognition", "cloze"] as StudyMode[]).map((m) => (
              <TouchableOpacity
                key={m}
                style={[styles.modeChip, studyMode === m && styles.modeChipActive]}
                onPress={() => setStudyMode(m)}
              >
                <Text
                  style={[
                    styles.modeChipText,
                    studyMode === m && styles.modeChipTextActive
                  ]}
                >
                  {m === "auto"
                    ? "🧠 Smart FSRS Mode"
                    : m === "recognition"
                    ? "🇸🇪→🇬🇧 Recognition"
                    : "🖼️→🇸🇪 Cloze Recall"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {!currentCard ? (
            <View style={styles.doneCard}>
              <Text style={styles.doneEmoji}>🎉</Text>
              <Text style={styles.doneTitle}>Bra jobbat! All caught up!</Text>
              <Text style={styles.doneSubtitle}>
                You have reviewed all due Swedish words for now. Highlight new words in Chrome or reset a card to practice again.
              </Text>
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={() => {
                  const reset = cards.map((c) => ({
                    ...c,
                    fsrs: { ...c.fsrs, due: new Date().toISOString() }
                  }));
                  setCards(reset);
                }}
              >
                <Text style={styles.primaryBtnText}>↻ Practice All Cards Now</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.flashcard}>
              {/* Card Top Bar */}
              <View
                style={[
                  styles.cardBanner,
                  { backgroundColor: getGenderColors(currentCard.swedish.article).bg }
                ]}
              >
                <View style={styles.genderBadge}>
                  <Text style={styles.genderBadgeText}>
                    {currentCard.swedish.article
                      ? `${currentCard.swedish.article.toUpperCase()}-ORD`
                      : currentCard.swedish.partOfSpeech.toUpperCase()}
                  </Text>
                </View>
                <Text style={styles.cardMetaText}>
                  S: {currentCard.fsrs?.stability || 0}d • Reps: {currentCard.fsrs?.reps || 0}
                </Text>
              </View>

              <View style={styles.cardBody}>
                {effectiveMode === "recognition" ? (
                  <>
                    {/* FRONT: SWEDISH WORD + AUDIO + CONTEXT */}
                    <Text style={styles.swedishPrompt}>
                      {currentCard.swedish.article
                        ? `${currentCard.swedish.article} ${currentCard.swedish.lemma}`
                        : currentCard.swedish.lemma}
                    </Text>

                    <TouchableOpacity
                      style={styles.audioButton}
                      onPress={() => playSwedishAudio(currentCard)}
                    >
                      <Text style={styles.audioButtonText}>
                        🔊 Play Native Pronunciation
                      </Text>
                    </TouchableOpacity>

                    {currentCard.swedish.contextSentence ? (
                      <View style={styles.contextQuote}>
                        <Text style={styles.contextSvText}>
                          ”{currentCard.swedish.contextSentence}”
                        </Text>
                      </View>
                    ) : null}
                  </>
                ) : (
                  <>
                    {/* FRONT (CLOZE ACTIVE RECALL): IMAGE + ENGLISH + CLOZE BLANK */}
                    {currentCard.media.imageUrl ? (
                      <Image
                        source={{ uri: currentCard.media.imageUrl }}
                        style={styles.cardImage}
                        resizeMode="cover"
                      />
                    ) : null}
                    <Text style={styles.englishPrompt}>
                      {currentCard.english.lemmaTranslation}
                    </Text>
                    <View style={styles.contextQuote}>
                      <Text style={styles.contextSvText}>
                        ”
                        {renderClozeSentence(
                          currentCard.swedish.contextSentence,
                          currentCard.swedish.surfaceForm,
                          currentCard.swedish.lemma
                        )}
                        ”
                      </Text>
                    </View>
                  </>
                )}

                {!isRevealed ? (
                  <TouchableOpacity
                    style={styles.revealBtn}
                    onPress={() => {
                      setIsRevealed(true);
                      playSwedishAudio(currentCard);
                    }}
                  >
                    <Text style={styles.revealBtnText}>👀 Show Answer & Audio</Text>
                  </TouchableOpacity>
                ) : (
                  <View style={styles.answerSection}>
                    <View style={styles.divider} />

                    {effectiveMode === "recognition" && currentCard.media.imageUrl ? (
                      <Image
                        source={{ uri: currentCard.media.imageUrl }}
                        style={styles.cardImage}
                        resizeMode="cover"
                      />
                    ) : null}

                    <Text style={styles.answerHeadline}>
                      {effectiveMode === "recognition"
                        ? currentCard.english.lemmaTranslation
                        : `${
                            currentCard.swedish.article
                              ? currentCard.swedish.article + " "
                              : ""
                          }${currentCard.swedish.lemma}`}
                    </Text>

                    {currentCard.swedish.inflections ? (
                      <Text style={styles.inflectionsText}>
                        Forms: {currentCard.swedish.inflections}
                      </Text>
                    ) : null}

                    {currentCard.swedish.definitionSv ? (
                      <Text style={styles.definitionText}>
                        🇸🇪 Ordbok: {currentCard.swedish.definitionSv}
                      </Text>
                    ) : null}

                    {currentCard.english.sentenceTranslation ? (
                      <Text style={styles.sentenceTransText}>
                        🇬🇧 ”{currentCard.english.sentenceTranslation}”
                      </Text>
                    ) : null}

                    {/* 4 FSRS Rating Buttons */}
                    <View style={styles.ratingRow}>
                      <TouchableOpacity
                        style={[styles.rateBtn, { backgroundColor: "#ef4444" }]}
                        onPress={() => handleRate(1)}
                      >
                        <Text style={styles.rateInterval}>{intervals[1]}</Text>
                        <Text style={styles.rateLabel}>Again</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[styles.rateBtn, { backgroundColor: "#f59e0b" }]}
                        onPress={() => handleRate(2)}
                      >
                        <Text style={styles.rateInterval}>{intervals[2]}</Text>
                        <Text style={styles.rateLabel}>Hard</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[styles.rateBtn, { backgroundColor: "#10b981" }]}
                        onPress={() => handleRate(3)}
                      >
                        <Text style={styles.rateInterval}>{intervals[3]}</Text>
                        <Text style={styles.rateLabel}>Good</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[styles.rateBtn, { backgroundColor: "#0284c7" }]}
                        onPress={() => handleRate(4)}
                      >
                        <Text style={styles.rateInterval}>{intervals[4]}</Text>
                        <Text style={styles.rateLabel}>Easy</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            </View>
          )}
        </ScrollView>
      )}

      {/* TAB 2: SAVED VOCABULARY DECK */}
      {activeTab === "deck" && (
        <ScrollView contentContainerStyle={styles.mainContent}>
          {cards.map((card) => (
            <View key={card.id} style={styles.deckItem}>
              {card.media.imageUrl ? (
                <Image
                  source={{ uri: card.media.imageUrl }}
                  style={styles.deckThumb}
                />
              ) : (
                <View style={styles.deckThumbPlaceholder}>
                  <Text style={{ fontSize: 22 }}>🇸🇪</Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.deckWordSv}>
                  {card.swedish.article ? `${card.swedish.article} ` : ""}
                  {card.swedish.lemma}
                </Text>
                <Text style={styles.deckWordEn}>
                  {card.english.lemmaTranslation}
                </Text>
                <Text style={styles.deckWordMeta}>
                  Stability: {card.fsrs?.stability || 0}d • Reps: {card.fsrs?.reps || 0}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.deckAudioBtn}
                onPress={() => playSwedishAudio(card)}
              >
                <Text style={{ fontSize: 18 }}>🔊</Text>
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      {/* TAB 3: CLOUD FIRESTORE SETTINGS */}
      {activeTab === "settings" && (
        <ScrollView contentContainerStyle={styles.mainContent}>
          <View style={styles.settingsCard}>
            <Text style={styles.settingsTitle}>
              ☁️ Firebase Cloud Firestore Sync
            </Text>
            <Text style={styles.settingsSubtitle}>
              Enter the same Firebase Project ID configured in your Chrome Extension to fetch saved Swedish words and sync FSRS review intervals.
            </Text>

            <Text style={styles.inputLabel}>Firebase Project ID</Text>
            <TextInput
              style={styles.textInput}
              placeholder="e.g. svenska-vocab-12345"
              value={settings.firebaseProjectId}
              onChangeText={(text) =>
                setSettings((s) => ({ ...s, firebaseProjectId: text }))
              }
              autoCapitalize="none"
            />

            <Text style={styles.inputLabel}>Firebase Web API Key (Optional)</Text>
            <TextInput
              style={styles.textInput}
              placeholder="AIzaSy..."
              value={settings.firebaseApiKey}
              onChangeText={(text) =>
                setSettings((s) => ({ ...s, firebaseApiKey: text }))
              }
              autoCapitalize="none"
              secureTextEntry
            />

            <TouchableOpacity
              style={styles.primaryBtn}
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
                <Text style={styles.primaryBtnText}>
                  ☁️ Save & Sync with Firestore Now
                </Text>
              )}
            </TouchableOpacity>

            {syncMessage ? (
              <Text style={styles.syncStatusText}>{syncMessage}</Text>
            ) : null}
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f1f5f9"
  },
  header: {
    backgroundColor: "#005B99",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10
  },
  headerTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10
  },
  brandTitle: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "800"
  },
  statsPill: {
    backgroundColor: "rgba(255,255,255,0.18)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999
  },
  statsPillText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700"
  },
  navBar: {
    flexDirection: "row",
    gap: 8
  },
  navBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center"
  },
  navBtnActive: {
    backgroundColor: "#FECC02"
  },
  navBtnText: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 12,
    fontWeight: "600"
  },
  navBtnTextActive: {
    color: "#0f172a",
    fontWeight: "800"
  },
  mainContent: {
    padding: 16
  },
  modeRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 12
  },
  modeChip: {
    flex: 1,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: "#e2e8f0",
    borderRadius: 8,
    alignItems: "center"
  },
  modeChipActive: {
    backgroundColor: "#005B99"
  },
  modeChipText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#475569"
  },
  modeChipTextActive: {
    color: "#ffffff"
  },
  flashcard: {
    backgroundColor: "#ffffff",
    borderRadius: 18,
    overflow: "hidden",
    elevation: 4,
    shadowColor: "#0f172a",
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 }
  },
  cardBanner: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center"
  },
  genderBadge: {
    backgroundColor: "rgba(255,255,255,0.24)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6
  },
  genderBadgeText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "800"
  },
  cardMetaText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "600"
  },
  cardBody: {
    padding: 18,
    alignItems: "center"
  },
  swedishPrompt: {
    fontSize: 30,
    fontWeight: "800",
    color: "#0f172a",
    marginBottom: 12,
    textAlign: "center"
  },
  englishPrompt: {
    fontSize: 22,
    fontWeight: "800",
    color: "#0f172a",
    marginVertical: 10,
    textAlign: "center"
  },
  audioButton: {
    backgroundColor: "#f1f5f9",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    marginBottom: 14
  },
  audioButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#0f172a"
  },
  contextQuote: {
    backgroundColor: "#f8fafc",
    borderLeftWidth: 4,
    borderLeftColor: "#005B99",
    padding: 12,
    borderRadius: 8,
    width: "100%",
    marginBottom: 16
  },
  contextSvText: {
    fontSize: 15,
    fontStyle: "italic",
    color: "#1e293b",
    textAlign: "center"
  },
  cardImage: {
    width: "100%",
    height: 185,
    borderRadius: 12,
    marginBottom: 12,
    backgroundColor: "#e2e8f0"
  },
  revealBtn: {
    backgroundColor: "#005B99",
    width: "100%",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 6
  },
  revealBtnText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "800"
  },
  answerSection: {
    width: "100%",
    alignItems: "center"
  },
  divider: {
    height: 1,
    backgroundColor: "#e2e8f0",
    width: "100%",
    marginVertical: 14
  },
  answerHeadline: {
    fontSize: 24,
    fontWeight: "800",
    color: "#005B99",
    textAlign: "center",
    marginBottom: 6
  },
  inflectionsText: {
    fontSize: 13,
    color: "#475569",
    marginBottom: 6,
    textAlign: "center"
  },
  definitionText: {
    fontSize: 13,
    color: "#334155",
    backgroundColor: "#f8fafc",
    padding: 8,
    borderRadius: 8,
    width: "100%",
    textAlign: "center",
    marginBottom: 8
  },
  sentenceTransText: {
    fontSize: 13,
    color: "#64748b",
    marginBottom: 16,
    textAlign: "center"
  },
  ratingRow: {
    flexDirection: "row",
    gap: 8,
    width: "100%",
    marginTop: 6
  },
  rateBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center"
  },
  rateInterval: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 11,
    fontWeight: "600"
  },
  rateLabel: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "800"
  },
  doneCard: {
    backgroundColor: "#ffffff",
    borderRadius: 18,
    padding: 28,
    alignItems: "center"
  },
  doneEmoji: {
    fontSize: 48,
    marginBottom: 10
  },
  doneTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#0f172a",
    marginBottom: 6
  },
  doneSubtitle: {
    fontSize: 14,
    color: "#64748b",
    textAlign: "center",
    marginBottom: 20,
    lineHeight: 20
  },
  primaryBtn: {
    backgroundColor: "#005B99",
    paddingVertical: 13,
    paddingHorizontal: 20,
    borderRadius: 12,
    width: "100%",
    alignItems: "center"
  },
  primaryBtnText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "800"
  },
  deckItem: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12
  },
  deckThumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: "#e2e8f0"
  },
  deckThumbPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: "#e2e8f0",
    alignItems: "center",
    justifyContent: "center"
  },
  deckWordSv: {
    fontSize: 16,
    fontWeight: "800",
    color: "#0f172a"
  },
  deckWordEn: {
    fontSize: 14,
    color: "#475569"
  },
  deckWordMeta: {
    fontSize: 11,
    color: "#94a3b8",
    marginTop: 2
  },
  deckAudioBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: "#f1f5f9",
    alignItems: "center",
    justifyContent: "center"
  },
  settingsCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 18
  },
  settingsTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#0f172a",
    marginBottom: 6
  },
  settingsSubtitle: {
    fontSize: 13,
    color: "#64748b",
    marginBottom: 16,
    lineHeight: 19
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#334155",
    marginBottom: 4
  },
  textInput: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 14
  },
  syncStatusText: {
    marginTop: 12,
    fontSize: 13,
    fontWeight: "600",
    color: "#005B99",
    textAlign: "center"
  }
});
