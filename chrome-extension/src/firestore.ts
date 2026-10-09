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

export async function getSettings(): Promise<ExtensionSettings> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
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
  await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
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
 * Save card to local storage and (if configured) Firebase Cloud Firestore
 */
export async function saveCardToStorage(
  enrichmentData: EnrichmentPayload
): Promise<SaveCardResult> {
  const card = createCardObject(enrichmentData);
  const settings = await getSettings();

  // 1. Save to local Chrome storage
  const store = await chrome.storage.local.get(LOCAL_CARDS_KEY);
  const cards: VocabCard[] = store[LOCAL_CARDS_KEY] || [];
  const existingIdx = cards.findIndex(
    (c) =>
      c.swedish?.lemma?.toLowerCase() === card.swedish.lemma.toLowerCase() &&
      c.swedish?.article === card.swedish.article
  );
  if (existingIdx >= 0) {
    card.id = cards[existingIdx].id;
    card.fsrs = cards[existingIdx].fsrs || card.fsrs;
    cards[existingIdx] = card;
  } else {
    cards.unshift(card);
  }
  await chrome.storage.local.set({ [LOCAL_CARDS_KEY]: cards });

  // 2. Sync to Firebase Cloud Firestore if firebaseProjectId is set
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

  return { card, cloudSynced, cloudError };
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
  const store = await chrome.storage.local.get(LOCAL_CARDS_KEY);
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
      await chrome.storage.local.set({ [LOCAL_CARDS_KEY]: merged });
      return merged;
    } catch (e) {
      console.warn("Falling back to local cards:", e);
    }
  }
  return localCards;
}

export async function deleteCard(cardId: string): Promise<VocabCard[]> {
  const settings = await getSettings();
  const store = await chrome.storage.local.get(LOCAL_CARDS_KEY);
  const localCards: VocabCard[] = (store[LOCAL_CARDS_KEY] || []).filter(
    (c: VocabCard) => c.id !== cardId
  );
  await chrome.storage.local.set({ [LOCAL_CARDS_KEY]: localCards });

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
  const store = await chrome.storage.local.get(LOCAL_CARDS_KEY);
  const localCards: VocabCard[] = store[LOCAL_CARDS_KEY] || [];
  let syncedCount = 0;
  for (const card of localCards) {
    await pushCardToFirestore(card, settings);
    syncedCount++;
  }
  return syncedCount;
}
