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
