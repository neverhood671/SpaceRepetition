export interface ExtensionSettings {
  firebaseProjectId: string;
  firebaseApiKey: string;
  geminiApiKey: string;
  autoPlayAudio: boolean;
}

export interface SwedishWordInfo {
  surfaceForm: string;
  lemma: string;
  article: string; // "en" | "ett" | ""
  partOfSpeech: string;
  inflections: string;
  definitionSv: string;
  contextSentence: string;
}

export interface EnglishTranslationInfo {
  lemmaTranslation: string;
  contextualTranslation: string;
  sentenceTranslation: string;
}

export interface CardMediaInfo {
  imageUrl: string;
  imageAlternatives?: string[];
  audioUrl: string;
  audioBase64: string;
  audioSource: string;
}

export interface FSRSState {
  due: string;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  state: number;
  lastReview: string | null;
}

export interface VocabCard {
  id: string;
  createdAt: string;
  sourceUrl: string;
  sourceTitle: string;
  swedish: SwedishWordInfo;
  english: EnglishTranslationInfo;
  media: CardMediaInfo;
  fsrs: FSRSState;
}

export interface EnrichmentPayload {
  id?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  alreadySaved?: boolean;
  existingCardId?: string;
  swedish: Partial<SwedishWordInfo> & { surfaceForm: string; lemma: string };
  english: Partial<EnglishTranslationInfo>;
  media: Partial<CardMediaInfo>;
}

export interface AnalyzeWordRequest {
  word: string;
  contextSentence: string;
  sourceUrl?: string;
  sourceTitle?: string;
}

export interface SaveCardResult {
  card: VocabCard;
  cloudSynced: boolean;
  cloudError: string | null;
  alreadyExisted?: boolean;
}

export type ExtensionMessage =
  | { type: "ANALYZE_WORD"; payload: AnalyzeWordRequest }
  | { type: "FETCH_AUDIO"; audioUrl: string }
  | { type: "SAVE_CARD"; payload: EnrichmentPayload }
  | { type: "GET_CARDS" }
  | { type: "DELETE_CARD"; cardId: string }
  | { type: "GET_SETTINGS" }
  | { type: "SAVE_SETTINGS"; payload: Partial<ExtensionSettings> }
  | { type: "SYNC_ALL" }
  | { type: "TRIGGER_SELECTION_LOOKUP"; selectionText?: string };

export interface ExtensionResponse<T = unknown> {
  ok: boolean;
  data?: T;
  count?: number;
  error?: string;
}

export interface SubtitleReplica {
  text: string;
  startTime: number;
}

export interface TextCueLike {
  startTime: number;
  endTime?: number;
  text?: string;
}

export function computePreviousReplicaSeek(
  currentTime: number,
  replicas: SubtitleReplica[],
  cues?: TextCueLike[]
): { targetTime: number; replicaLabel: string } {
  const curr = currentTime;
  let targetTime: number | null = null;
  let replicaLabel = "";

  // 1. Check native cues if provided
  if (cues && cues.length > 0) {
    const cuesArray = [...cues].sort((a, b) => a.startTime - b.startTime);
    const activeIdx = cuesArray.findIndex(
      (c) => curr >= c.startTime && curr <= (c.endTime ?? c.startTime + 4) + 0.3
    );
    if (activeIdx >= 0) {
      const activeCue = cuesArray[activeIdx];
      const cueText = activeCue.text || "";
      if (curr - activeCue.startTime > 1.2) {
        targetTime = Math.max(0, activeCue.startTime - 0.2);
        replicaLabel = cueText;
      } else if (activeIdx > 0) {
        const prevCue = cuesArray[activeIdx - 1];
        targetTime = Math.max(0, prevCue.startTime - 0.2);
        replicaLabel = prevCue.text || "";
      } else {
        targetTime = Math.max(0, activeCue.startTime - 0.2);
        replicaLabel = cueText;
      }
    } else {
      const pastCues = cuesArray.filter((c) => c.startTime < curr - 0.3);
      if (pastCues.length > 0) {
        const lastCue = pastCues[pastCues.length - 1];
        targetTime = Math.max(0, lastCue.startTime - 0.2);
        replicaLabel = lastCue.text || "";
      }
    }
  }

  // 2. Fallback to DOM-observed subtitleReplicas
  if (targetTime === null && replicas.length > 0) {
    const sorted = [...replicas].sort((a, b) => a.startTime - b.startTime);
    const past = sorted.filter((r) => r.startTime <= curr + 0.3);

    if (past.length > 0) {
      const currentOrLatest = past[past.length - 1];
      if (curr - currentOrLatest.startTime > 1.5) {
        targetTime = Math.max(0, currentOrLatest.startTime - 0.2);
        replicaLabel = currentOrLatest.text;
      } else if (past.length > 1) {
        const prevReplica = past[past.length - 2];
        targetTime = Math.max(0, prevReplica.startTime - 0.2);
        replicaLabel = prevReplica.text;
      } else {
        targetTime = Math.max(0, currentOrLatest.startTime - 0.2);
        replicaLabel = currentOrLatest.text;
      }
    }
  }

  // 3. Fallback: rewind 4 seconds if no replica was logged yet
  if (targetTime === null) {
    targetTime = Math.max(0, curr - 4);
    replicaLabel = `-${Math.round(curr - targetTime)}s`;
  }

  return {
    targetTime: Math.round(targetTime * 100) / 100,
    replicaLabel
  };
}
