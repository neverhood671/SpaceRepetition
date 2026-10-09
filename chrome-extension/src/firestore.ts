import {
  ExtensionSettings,
  VocabCard,
  EnrichmentPayload,
  SaveCardResult
} from "./types.js";

/**
 * Lightweight Firebase Cloud Firestore REST Client (Spark Free Plan compatible)
 * Works natively in Chrome MV3 Service Workers.
 * Also mirrors cards to chrome.storage.local for instant offline access.
 */

const LOCAL_CARDS_KEY = "svenska_cards";
const SETTINGS_KEY = "svenska_settings";

export interface FirestoreValue {
  nullValue?: null;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  stringValue?: string;
  timestampValue?: string;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
}

export interface FirestoreDocument {
  name?: string;
  fields?: Record<string, FirestoreValue>;
}

const memoryStore: Record<string, any> = {};

async function storageGet(key: string): Promise<Record<string, any>> {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return await chrome.storage.local.get(key);
  }
  return { [key]: memoryStore[key] };
}

async function storageSet(items: Record<string, any>): Promise<void> {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set(items);
    return;
  }
  Object.assign(memoryStore, items);
}

export async function getSettings(): Promise<ExtensionSettings> {
  const data = await storageGet(SETTINGS_KEY);
  return {
    firebaseProjectId: "",
    firebaseApiKey: "",
    geminiApiKey: "",
    autoPlayAudio: true,
    ...(data[SETTINGS_KEY] || {})
  };
}

export async function saveSettings(
  newSettings: Partial<ExtensionSettings>
): Promise<ExtensionSettings> {
  const current = await getSettings();
  const merged: ExtensionSettings = { ...current, ...newSettings };
  await storageSet({ [SETTINGS_KEY]: merged });
  return merged;
}

/**
 * Convert a plain JS value into Firestore REST API Value object
 */
function toFirestoreValue(val: unknown): FirestoreValue {
  if (val === null || val === undefined) {
    return { nullValue: null };
  }
  if (typeof val === "boolean") {
    return { booleanValue: val };
  }
  if (typeof val === "number") {
    if (Number.isInteger(val)) {
      return { integerValue: String(val) };
    }
    return { doubleValue: val };
  }
  if (typeof val === "string") {
    return { stringValue: val };
  }
  if (Array.isArray(val)) {
    return {
      arrayValue: {
        values: val.map(toFirestoreValue)
      }
    };
  }
  if (typeof val === "object") {
    const fields: Record<string, FirestoreValue> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) {
        fields[k] = toFirestoreValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

/**
 * Convert a Firestore REST API Value object back to a plain JS value
 */
export function fromFirestoreValue(firestoreVal: FirestoreValue | undefined): any {
  if (!firestoreVal || typeof firestoreVal !== "object") return null;
  if ("nullValue" in firestoreVal) return null;
  if ("booleanValue" in firestoreVal) return Boolean(firestoreVal.booleanValue);
  if ("integerValue" in firestoreVal) return Number(firestoreVal.integerValue);
  if ("doubleValue" in firestoreVal) return Number(firestoreVal.doubleValue);
  if ("stringValue" in firestoreVal) return firestoreVal.stringValue;
  if ("timestampValue" in firestoreVal) return firestoreVal.timestampValue;
  if ("arrayValue" in firestoreVal) {
    return (firestoreVal.arrayValue?.values || []).map(fromFirestoreValue);
  }
  if ("mapValue" in firestoreVal) {
    const out: Record<string, any> = {};
    const fields = firestoreVal.mapValue?.fields || {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = fromFirestoreValue(v);
    }
    return out;
  }
  return null;
}

export function cardToFirestoreDoc(card: VocabCard): { fields: Record<string, FirestoreValue> } {
  const fields: Record<string, FirestoreValue> = {};
  for (const [k, v] of Object.entries(card)) {
    if (v !== undefined) {
      fields[k] = toFirestoreValue(v);
    }
  }
  return { fields };
}

export function firestoreDocToCard(doc: FirestoreDocument): VocabCard {
  const card: Record<string, any> = {};
  const fields = doc.fields || {};
  for (const [k, v] of Object.entries(fields)) {
    card[k] = fromFirestoreValue(v);
  }
  if (!card.id && doc.name) {
    const parts = doc.name.split("/");
    card.id = parts[parts.length - 1];
  }
  return card as VocabCard;
}

/**
 * Create a new Vocabulary Card with initial FSRS scheduling state
 */
export function createCardObject(enrichment: EnrichmentPayload): VocabCard {
  const nowIso = new Date().toISOString();
  const id =
    enrichment.id ||
    `sv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    createdAt: nowIso,
    sourceUrl: enrichment.sourceUrl || "",
    sourceTitle: enrichment.sourceTitle || "",
    swedish: {
      surfaceForm: enrichment.swedish?.surfaceForm || "",
      lemma: enrichment.swedish?.lemma || enrichment.swedish?.surfaceForm || "",
      article: enrichment.swedish?.article || "", // 'en' | 'ett' | ''
      partOfSpeech: enrichment.swedish?.partOfSpeech || "word",
      inflections: enrichment.swedish?.inflections || "",
      definitionSv: enrichment.swedish?.definitionSv || "",
      contextSentence: enrichment.swedish?.contextSentence || ""
    },
    english: {
      lemmaTranslation: enrichment.english?.lemmaTranslation || "",
      contextualTranslation: enrichment.english?.contextualTranslation || "",
      sentenceTranslation: enrichment.english?.sentenceTranslation || ""
    },
    media: {
      imageUrl: enrichment.media?.imageUrl || "",
      audioUrl: enrichment.media?.audioUrl || "",
      audioBase64: enrichment.media?.audioBase64 || "",
      audioSource: enrichment.media?.audioSource || "Swedish Dictionary"
    },
    fsrs: {
      due: nowIso,
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 0,
      lapses: 0,
      state: 0,
      lastReview: null
    }
  };
}

/**
 * Check whether an existing saved card matches a Swedish lemma/article/surfaceForm
 * (handles verbs with or without "att " prefix)
 */
export function isSameSwedishWord(
  card: VocabCard,
  lemma: string,
  article = "",
  surfaceForm = ""
): boolean {
  const normLemma = (lemma || "").trim().toLowerCase();
  const bareLemma = normLemma.replace(/^att\s+/i, "").trim();
  const normSurface = (surfaceForm || "")
    .trim()
    .toLowerCase()
    .replace(/^att\s+/i, "")
    .trim();

  const cardLemma = (card.swedish?.lemma || "").trim().toLowerCase();
  const cardBareLemma = cardLemma.replace(/^att\s+/i, "").trim();
  const cardSurface = (card.swedish?.surfaceForm || "")
    .trim()
    .toLowerCase()
    .replace(/^att\s+/i, "")
    .trim();

  const cardArticle = (card.swedish?.article || "").trim().toLowerCase();
  const targetArticle = (article || "").trim().toLowerCase();
  if (cardArticle && targetArticle && cardArticle !== targetArticle) {
    return false;
  }

  if (bareLemma && cardBareLemma === bareLemma) {
    return true;
  }
  if (normSurface && (cardBareLemma === normSurface || cardSurface === normSurface)) {
    return true;
  }
  return false;
}

/**
 * Find an existing saved card matching the given Swedish lemma / surface form
 */
export async function findExistingCard(
  lemma: string,
  article = "",
  surfaceForm = ""
): Promise<VocabCard | null> {
  const store = await storageGet(LOCAL_CARDS_KEY);
  let cards: VocabCard[] = store[LOCAL_CARDS_KEY] || [];

  if (cards.length === 0) {
    const settings = await getSettings();
    if (settings.firebaseProjectId && settings.firebaseProjectId.trim()) {
      try {
        cards = await getAllCards();
      } catch {
        // Ignore network errors
      }
    }
  }

  const found = cards.find((c) =>
    isSameSwedishWord(c, lemma, article, surfaceForm)
  );
  return found || null;
}

/**
 * Save card to local storage and (if configured) Firebase Cloud Firestore.
 * If the word is already saved, do NOT save it a second time.
 */
export async function saveCardToStorage(
  enrichmentData: EnrichmentPayload
): Promise<SaveCardResult> {
  const card = createCardObject(enrichmentData);
  const settings = await getSettings();

  const store = await storageGet(LOCAL_CARDS_KEY);
  const cards: VocabCard[] = store[LOCAL_CARDS_KEY] || [];
  const existingIdx = cards.findIndex((c) =>
    isSameSwedishWord(
      c,
      card.swedish.lemma,
      card.swedish.article,
      card.swedish.surfaceForm
    )
  );

  // Do NOT save a second time if the word already exists in the deck
  if (existingIdx >= 0) {
    return {
      card: cards[existingIdx],
      cloudSynced: false,
      cloudError: null,
      alreadyExisted: true
    };
  }

  cards.unshift(card);
  await storageSet({ [LOCAL_CARDS_KEY]: cards });

  // Sync to Firebase Cloud Firestore if firebaseProjectId is set
  let cloudSynced = false;
  let cloudError: string | null = null;
  if (settings.firebaseProjectId && settings.firebaseProjectId.trim()) {
    try {
      await pushCardToFirestore(card, settings);
      cloudSynced = true;
    } catch (err: any) {
      cloudError = err?.message || String(err);
      console.warn("Firestore sync error:", cloudError);
    }
  }

  return { card, cloudSynced, cloudError, alreadyExisted: false };
}

export async function pushCardToFirestore(
  card: VocabCard,
  settings: ExtensionSettings
): Promise<unknown> {
  const projectId = settings.firebaseProjectId.trim();
  const apiKeyParam = settings.firebaseApiKey
    ? `?key=${encodeURIComponent(settings.firebaseApiKey.trim())}`
    : "";
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    projectId
  )}/databases/(default)/documents/cards/${encodeURIComponent(card.id)}${apiKeyParam}`;

  const body = cardToFirestoreDoc(card);
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firestore HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  return await res.json();
}

export async function fetchCardsFromFirestore(
  settings: ExtensionSettings
): Promise<VocabCard[]> {
  const projectId = settings?.firebaseProjectId?.trim();
  if (!projectId) return [];
  const apiKeyParam = settings.firebaseApiKey
    ? `&key=${encodeURIComponent(settings.firebaseApiKey.trim())}`
    : "";
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    projectId
  )}/databases/(default)/documents/cards?pageSize=200${apiKeyParam}`;

  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firestore HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = (await res.json()) as { documents?: FirestoreDocument[] };
  const docs = data.documents || [];
  return docs
    .map(firestoreDocToCard)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

export async function getAllCards(): Promise<VocabCard[]> {
  const settings = await getSettings();
  const store = await storageGet(LOCAL_CARDS_KEY);
  const localCards: VocabCard[] = store[LOCAL_CARDS_KEY] || [];

  if (settings.firebaseProjectId && settings.firebaseProjectId.trim()) {
    try {
      const cloudCards = await fetchCardsFromFirestore(settings);
      const map = new Map<string, VocabCard>();
      for (const c of localCards) map.set(c.id, c);
      for (const c of cloudCards) map.set(c.id, c);
      const merged = Array.from(map.values()).sort((a, b) =>
        (b.createdAt || "").localeCompare(a.createdAt || "")
      );
      await storageSet({ [LOCAL_CARDS_KEY]: merged });
      return merged;
    } catch (e) {
      console.warn("Falling back to local cards:", e);
    }
  }
  return localCards;
}

export async function deleteCard(cardId: string): Promise<VocabCard[]> {
  const settings = await getSettings();
  const store = await storageGet(LOCAL_CARDS_KEY);
  const localCards: VocabCard[] = (store[LOCAL_CARDS_KEY] || []).filter(
    (c: VocabCard) => c.id !== cardId
  );
  await storageSet({ [LOCAL_CARDS_KEY]: localCards });

  if (settings.firebaseProjectId && settings.firebaseProjectId.trim()) {
    const projectId = settings.firebaseProjectId.trim();
    const apiKeyParam = settings.firebaseApiKey
      ? `?key=${encodeURIComponent(settings.firebaseApiKey.trim())}`
      : "";
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      projectId
    )}/databases/(default)/documents/cards/${encodeURIComponent(cardId)}${apiKeyParam}`;
    await fetch(url, { method: "DELETE" }).catch(() => {});
  }
  return localCards;
}

export async function syncAllLocalToCloud(): Promise<number> {
  const settings = await getSettings();
  if (!settings.firebaseProjectId?.trim()) {
    throw new Error("Please configure your Firebase Project ID first.");
  }
  const store = await storageGet(LOCAL_CARDS_KEY);
  const localCards: VocabCard[] = store[LOCAL_CARDS_KEY] || [];
  let syncedCount = 0;
  for (const card of localCards) {
    await pushCardToFirestore(card, settings);
    syncedCount++;
  }
  return syncedCount;
}
