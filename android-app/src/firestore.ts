import { FSRSState } from "./fsrs";

export interface VocabCard {
  id: string;
  createdAt: string;
  sourceUrl?: string;
  sourceTitle?: string;
  swedish: {
    surfaceForm: string;
    lemma: string;
    article: string; // 'en' | 'ett' | ''
    partOfSpeech: string;
    inflections?: string;
    definitionSv?: string;
    contextSentence?: string;
  };
  english: {
    lemmaTranslation: string;
    contextualTranslation: string;
    sentenceTranslation?: string;
  };
  media: {
    imageUrl: string;
    audioUrl: string;
    audioBase64?: string;
    audioSource?: string;
  };
  fsrs: FSRSState;
}

export interface CloudSettings {
  firebaseProjectId: string;
  firebaseApiKey?: string;
}

export const STARTER_SWEDISH_DECK: VocabCard[] = [
  {
    id: "starter_hund",
    createdAt: "2026-10-09T18:00:00Z",
    sourceUrl: "https://sv.wiktionary.org/wiki/hund",
    swedish: {
      surfaceForm: "hundarna",
      lemma: "hund",
      article: "en",
      partOfSpeech: "noun",
      inflections: "en hund, hunden, hundar, hundarna",
      definitionSv: "tam underart till vargen; sällskapsdjur",
      contextSentence: "Går du ut på promenad med hundarna i parken?"
    },
    english: {
      lemmaTranslation: "dog, hound",
      contextualTranslation: "the dogs",
      sentenceTranslation: "Are you going out for a walk with the dogs in the park?"
    },
    media: {
      imageUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d9/Collage_of_Nine_Dogs.jpg/640px-Collage_of_Nine_Dogs.jpg",
      audioUrl: "https://upload.wikimedia.org/wikipedia/commons/b/bb/Sv-hund.ogg",
      audioSource: "Swedish Wiktionary (Native Human)"
    },
    fsrs: {
      due: new Date().toISOString(),
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 0,
      lapses: 0,
      state: 0,
      lastReview: null
    }
  },
  {
    id: "starter_fika",
    createdAt: "2026-10-09T18:05:00Z",
    sourceUrl: "https://sv.wiktionary.org/wiki/fika",
    swedish: {
      surfaceForm: "fikade",
      lemma: "fika",
      article: "en",
      partOfSpeech: "verb / noun",
      inflections: "att fika, fikar, fikade, fikat",
      definitionSv: "dricka kaffe eller te med fikabröd i sällskap",
      contextSentence: "Vi fikade på ett mysigt kafé i Gamla stan."
    },
    english: {
      lemmaTranslation: "coffee break / to have coffee & pastry",
      contextualTranslation: "had coffee",
      sentenceTranslation: "We had a coffee break at a cozy café in the Old Town."
    },
    media: {
      imageUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a0/Fika_med_kanelbulle.jpg/640px-Fika_med_kanelbulle.jpg",
      audioUrl: "https://upload.wikimedia.org/wikipedia/commons/6/67/Sv-fika.ogg",
      audioSource: "Swedish Wiktionary (Native Human)"
    },
    fsrs: {
      due: new Date().toISOString(),
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 0,
      lapses: 0,
      state: 0,
      lastReview: null
    }
  },
  {
    id: "starter_bibliotek",
    createdAt: "2026-10-09T18:10:00Z",
    sourceUrl: "https://sv.wiktionary.org/wiki/bibliotek",
    swedish: {
      surfaceForm: "biblioteket",
      lemma: "bibliotek",
      article: "ett",
      partOfSpeech: "noun",
      inflections: "ett bibliotek, biblioteket, bibliotek, biblioteken",
      definitionSv: "samling av böcker eller byggnad där böcker lånas ut",
      contextSentence: "Jag lånade tre svenska romaner på biblioteket igår."
    },
    english: {
      lemmaTranslation: "library",
      contextualTranslation: "the library",
      sentenceTranslation: "I borrowed three Swedish novels at the library yesterday."
    },
    media: {
      imageUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/60/Stockholms_stadsbibliotek_interi%C3%B6r_2015.jpg/640px-Stockholms_stadsbibliotek_interi%C3%B6r_2015.jpg",
      audioUrl: "https://upload.wikimedia.org/wikipedia/commons/5/51/Sv-bibliotek.ogg",
      audioSource: "Swedish Wiktionary (Native Human)"
    },
    fsrs: {
      due: new Date().toISOString(),
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 0,
      lapses: 0,
      state: 0,
      lastReview: null
    }
  }
];

function toFirestoreValue(val: any): any {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number") {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === "string") return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFirestoreValue) } };
  }
  if (typeof val === "object") {
    const fields: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFirestoreValue(fv: any): any {
  if (!fv || typeof fv !== "object") return null;
  if ("nullValue" in fv) return null;
  if ("booleanValue" in fv) return Boolean(fv.booleanValue);
  if ("integerValue" in fv) return Number(fv.integerValue);
  if ("doubleValue" in fv) return Number(fv.doubleValue);
  if ("stringValue" in fv) return fv.stringValue;
  if ("timestampValue" in fv) return fv.timestampValue;
  if ("arrayValue" in fv) return (fv.arrayValue.values || []).map(fromFirestoreValue);
  if ("mapValue" in fv) {
    const out: Record<string, any> = {};
    const fields = fv.mapValue.fields || {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = fromFirestoreValue(v);
    }
    return out;
  }
  return null;
}

export async function fetchCardsFromCloud(settings: CloudSettings): Promise<VocabCard[]> {
  const projectId = settings.firebaseProjectId?.trim();
  if (!projectId) return [];
  const keyParam = settings.firebaseApiKey?.trim()
    ? `&key=${encodeURIComponent(settings.firebaseApiKey.trim())}`
    : "";
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    projectId
  )}/databases/(default)/documents/cards?pageSize=200${keyParam}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Firestore HTTP ${res.status}`);
  }
  const data = await res.json();
  const docs = data.documents || [];
  return docs.map((doc: any) => {
    const card: any = {};
    for (const [k, v] of Object.entries(doc.fields || {})) {
      card[k] = fromFirestoreValue(v);
    }
    if (!card.id && doc.name) {
      const parts = doc.name.split("/");
      card.id = parts[parts.length - 1];
    }
    return card as VocabCard;
  });
}

export async function updateCardInCloud(card: VocabCard, settings: CloudSettings): Promise<void> {
  const projectId = settings.firebaseProjectId?.trim();
  if (!projectId) return;
  const keyParam = settings.firebaseApiKey?.trim()
    ? `?key=${encodeURIComponent(settings.firebaseApiKey.trim())}`
    : "";
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    projectId
  )}/databases/(default)/documents/cards/${encodeURIComponent(card.id)}${keyParam}`;

  const fields: Record<string, any> = {};
  for (const [k, v] of Object.entries(card)) {
    if (v !== undefined) fields[k] = toFirestoreValue(v);
  }

  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) {
    throw new Error(`Firestore update HTTP ${res.status}`);
  }
}
