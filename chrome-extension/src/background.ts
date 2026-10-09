import {
  getSettings,
  saveSettings,
  saveCardToStorage,
  getAllCards,
  deleteCard,
  syncAllLocalToCloud
} from "./firestore.js";
import {
  AnalyzeWordRequest,
  EnrichmentPayload,
  ExtensionMessage
} from "./types.js";

interface WiktionaryParseResult {
  lemma: string;
  article: string;
  partOfSpeech: string;
  audioUrl: string;
  audioSource: string;
  englishFromWiktionary: string;
  definitionSv: string;
}

interface GoogleTranslateResult {
  wordTranslation: string;
  sentenceTranslation: string;
  detectedLemma: string;
  partOfSpeech: string;
  article: string;
  synonyms: string[];
}

interface GeminiEnrichmentResult {
  lemma?: string;
  article?: string;
  partOfSpeech?: string;
  inflections?: string;
  lemmaTranslation?: string;
  contextualTranslation?: string;
  sentenceTranslation?: string;
  imageSearchQuery?: string;
}

/**
 * Clean selected text to a Swedish word or short phrase
 */
function cleanWord(raw: string | undefined): string {
  return (raw || "")
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .slice(0, 80);
}

/**
 * 1. Query Swedish Wiktionary (sv.wiktionary.org) for:
 *    - Inflection -> Base Lemma resolution ({{böjning|sv|...|lemma}})
 *    - Multi-word Swedish partikelverb resolution ("höll till" -> "hålla till")
 *    - Grammatical gender (en vs ett via {{sv-subst-n...}} / {{sv-subst-t...}})
 *    - Native human audio filename (ljud=Sv-xxx.ogg)
 *    - Swedish definition & English translations ({{ö+|en|...}})
 */
async function querySwedishWiktionary(
  word: string
): Promise<WiktionaryParseResult | null> {
  const candidates = [word, word.toLowerCase()];
  for (const candidate of candidates) {
    try {
      const url = `https://sv.wiktionary.org/w/api.php?action=query&titles=${encodeURIComponent(
        candidate
      )}&prop=revisions&rvprop=content&format=json&origin=*`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const pages = data?.query?.pages || {};
      const page: any = Object.values(pages)[0];
      if (!page || page.missing !== undefined) continue;
      const wikitext: string = page.revisions?.[0]?.["*"] || "";
      if (!wikitext.includes("==Svenska==")) continue;

      const svSection =
        wikitext.split("==Svenska==")[1]?.split(/\n==[^=]/)[0] || wikitext;

      // Check if this entry is an inflection of a base lemma: {{böjning|sv|subst|hund}}
      const inflectionMatch = svSection.match(
        /\{\{böjning\|sv\|([^|}]+)\|([^|}]+)/i
      );
      if (inflectionMatch && inflectionMatch[2]) {
        const baseLemma = inflectionMatch[2].trim();
        if (baseLemma.toLowerCase() !== candidate.toLowerCase()) {
          const baseResult = await parseWiktionarySwedishEntry(baseLemma);
          if (baseResult) {
            return {
              ...baseResult,
              lemma: baseLemma
            };
          }
        }
      }

      const parsed = await parseWiktionarySection(candidate, svSection);
      if (parsed) return parsed;
    } catch (e) {
      console.warn("Wiktionary lookup error:", e);
    }
  }

  // Handle multi-word Swedish partikelverb (e.g. "höll till" -> de-inflect "höll" to "hålla" -> query "hålla till")
  const tokens = word.trim().split(/\s+/);
  if (tokens.length >= 2) {
    const firstWordInfo = await querySwedishWiktionary(tokens[0]);
    if (firstWordInfo?.lemma) {
      const reconstructedLemma = [
        firstWordInfo.lemma.toLowerCase(),
        ...tokens.slice(1).map((t) => t.toLowerCase())
      ].join(" ");
      if (reconstructedLemma !== word.toLowerCase()) {
        const particleEntry = await parseWiktionarySwedishEntry(
          reconstructedLemma
        );
        if (particleEntry) {
          return {
            ...particleEntry,
            lemma: reconstructedLemma,
            partOfSpeech: "partikelverb"
          };
        }
      }
      return {
        lemma: reconstructedLemma,
        article: "",
        partOfSpeech: "partikelverb",
        audioUrl: firstWordInfo.audioUrl || "",
        audioSource: firstWordInfo.audioSource || "",
        englishFromWiktionary: "",
        definitionSv: ""
      };
    }
  }

  return null;
}

async function parseWiktionarySwedishEntry(
  lemma: string
): Promise<WiktionaryParseResult | null> {
  try {
    const url = `https://sv.wiktionary.org/w/api.php?action=query&titles=${encodeURIComponent(
      lemma
    )}&prop=revisions&rvprop=content&format=json&origin=*`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const page: any = Object.values(data?.query?.pages || {})[0];
    if (!page || page.missing !== undefined) return null;
    const wikitext: string = page.revisions?.[0]?.["*"] || "";
    const svSection =
      wikitext.split("==Svenska==")[1]?.split(/\n==[^=]/)[0] || wikitext;
    return await parseWiktionarySection(lemma, svSection);
  } catch {
    return null;
  }
}

async function parseWiktionarySection(
  lemma: string,
  svSection: string
): Promise<WiktionaryParseResult> {
  let partOfSpeech = "word";
  if (/partikelverb|partikel=/i.test(svSection)) partOfSpeech = "partikelverb";
  else if (/===Substantiv===/i.test(svSection)) partOfSpeech = "noun";
  else if (/===Verb===/i.test(svSection)) partOfSpeech = "verb";
  else if (/===Adjektiv===/i.test(svSection)) partOfSpeech = "adjective";
  else if (/===Adverb===/i.test(svSection)) partOfSpeech = "adverb";

  let article = "";
  if (partOfSpeech === "noun") {
    if (
      /\{\{sv-subst-n/i.test(svSection) ||
      /text=en\s+/i.test(svSection) ||
      /\{\{u\}\}/i.test(svSection)
    ) {
      article = "en";
    } else if (
      /\{\{sv-subst-t/i.test(svSection) ||
      /text=ett\s+/i.test(svSection) ||
      /\{\{n\}\}/i.test(svSection)
    ) {
      article = "ett";
    }
  }

  let audioFileName: string | null = null;
  const audioMatch = svSection.match(
    /ljud\s*=\s*([^|}\n]+\.(?:ogg|mp3|wav|oga))/i
  );
  if (audioMatch) {
    audioFileName = audioMatch[1].trim();
  }

  let audioUrl = "";
  if (audioFileName) {
    audioUrl = await resolveWikimediaAudioUrl(audioFileName);
  } else {
    audioUrl = await resolveWikimediaAudioUrl(`Sv-${lemma.toLowerCase()}.ogg`);
  }

  const englishTranslations: string[] = [];
  const engLineMatch = svSection.match(/\*engelska:([^\n]+)/i);
  if (engLineMatch) {
    const matches = engLineMatch[1].matchAll(/\{\{ö\+?\s*\|en\|([^|}]+)/gi);
    for (const m of matches) {
      if (m[1] && !englishTranslations.includes(m[1].trim())) {
        englishTranslations.push(m[1].trim());
      }
    }
  }

  let definitionSv = "";
  const defMatch = svSection.match(/\n#(?![:*])([^\n]+)/);
  if (defMatch) {
    definitionSv = defMatch[1]
      .replace(/\{\{[^}]+\}\}/g, "")
      .replace(/\[\[(?:[^|\]]+\|)?([^\]]+)\]\]/g, "$1")
      .replace(/''+/g, "")
      .trim();
  }

  return {
    lemma,
    article,
    partOfSpeech,
    audioUrl,
    audioSource: audioUrl ? "Swedish Wiktionary (Native Human)" : "",
    englishFromWiktionary: englishTranslations.slice(0, 4).join(", "),
    definitionSv
  };
}

/**
 * Resolve a Wikimedia Commons File:Sv-xxx.ogg to a playable URL
 */
async function resolveWikimediaAudioUrl(fileName: string): Promise<string> {
  try {
    const cleanName = fileName.replace(/^File:/i, "").trim();
    const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=File:${encodeURIComponent(
      cleanName
    )}&prop=imageinfo&iiprop=url&format=json&origin=*`;
    const res = await fetch(apiUrl);
    if (!res.ok) return "";
    const data = await res.json();
    const pages = data?.query?.pages || {};
    const page: any = Object.values(pages)[0];
    return page?.imageinfo?.[0]?.url || "";
  } catch {
    return "";
  }
}

/**
 * 2. Query Svenska.se (Svensk Ordbok - SO) for native Swedish Academy audio (isolve-so-service.appspot.com)
 */
async function querySvenskaSeAudio(lemma: string): Promise<string> {
  try {
    const url = `https://svenska.se/tri/f_so.php?sok=${encodeURIComponent(
      lemma
    )}`;
    const res = await fetch(url);
    if (!res.ok) return "";
    const html = await res.text();
    const mp3Match = html.match(
      /https:\/\/isolve-so-service\.appspot\.com\/pronounce\?id=\d+\.mp3/i
    );
    if (mp3Match) {
      return mp3Match[0];
    }
  } catch {
    // Ignore errors
  }
  return "";
}

/**
 * 3. Query Google Translate Dictionary endpoint (zero-key) for translation, dictionary entries, and sentence translation
 */
async function queryGoogleTranslateDictionary(
  word: string,
  contextSentence: string
): Promise<GoogleTranslateResult> {
  const result: GoogleTranslateResult = {
    wordTranslation: "",
    sentenceTranslation: "",
    detectedLemma: "",
    partOfSpeech: "",
    article: "",
    synonyms: []
  };

  try {
    const wordUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=sv&tl=en&hl=en&dt=t&dt=bd&dt=md&dt=rw&q=${encodeURIComponent(
      word
    )}`;
    const res = await fetch(wordUrl);
    if (res.ok) {
      const data = await res.json();
      result.wordTranslation = (data?.[0] || [])
        .map((seg: any) => seg?.[0] || "")
        .join("")
        .trim();

      if (Array.isArray(data?.[1]) && data[1].length > 0) {
        const firstDict = data[1][0];
        result.partOfSpeech = firstDict?.[0] || "";
        const terms: string[] = (firstDict?.[1] || []).slice(0, 4);
        if (terms.length > 0) {
          result.synonyms = terms;
        }
        if (firstDict?.[3]) {
          result.detectedLemma = firstDict[3];
        }
      }
    }

    if (
      contextSentence &&
      contextSentence.trim() &&
      contextSentence.trim() !== word.trim()
    ) {
      const sentUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=sv&tl=en&dt=t&q=${encodeURIComponent(
        contextSentence
      )}`;
      const sentRes = await fetch(sentUrl);
      if (sentRes.ok) {
        const sentData = await sentRes.json();
        result.sentenceTranslation = (sentData?.[0] || [])
          .map((seg: any) => seg?.[0] || "")
          .join("")
          .trim();
      }
    }
  } catch (e) {
    console.warn("Google Translate lookup error:", e);
  }
  return result;
}

/**
 * 4. Optional Gemini Flash enrichment (if user configures a free Gemini API key in Settings)
 */
async function queryGeminiFlash(
  word: string,
  contextSentence: string,
  apiKey: string | undefined
): Promise<GeminiEnrichmentResult | null> {
  if (!apiKey || !apiKey.trim()) return null;
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
      apiKey.trim()
    )}`;
    const prompt = `You are a Swedish linguistics and vocabulary expert.
Analyze the highlighted Swedish word or partikelverb "${word}" from the context sentence: "${
      contextSentence || word
    }".
Return ONLY a JSON object with these keys:
- "lemma": dictionary base form in Swedish without article (e.g. "tågstation", "hålla till", "stor")
- "article": "en" or "ett" if noun, otherwise ""
- "partOfSpeech": "noun", "verb", "partikelverb", "adjective", "adverb", or "phrase"
- "inflections": standard Swedish inflection forms
- "lemmaTranslation": concise English translation of the base word
- "contextualTranslation": English meaning of "${word}" in this specific sentence
- "sentenceTranslation": natural English translation of the context sentence
- "imageSearchQuery": a concrete 1-3 word query to find a clear picture on Google Images`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text) as GeminiEnrichmentResult;
  } catch (e) {
    console.warn("Gemini enrichment error:", e);
    return null;
  }
}

/**
 * 5. Fetch First Image from Google Image Search
 */
async function fetchGoogleImages(query: string): Promise<string[]> {
  const images: string[] = [];
  try {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(
      query
    )}&tbm=isch&hl=sv&safe=active`;
    const res = await fetch(searchUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });
    if (res.ok) {
      const html = await res.text();

      const fullImgMatches = html.matchAll(
        /\["(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp))",\d+,\d+\]/gi
      );
      for (const m of fullImgMatches) {
        const url = m[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&");
        if (
          !url.includes("gstatic.com") &&
          !url.includes("google.com") &&
          !images.includes(url)
        ) {
          images.push(url);
          if (images.length >= 6) break;
        }
      }

      const tbnMatches = html.matchAll(
        /https:\/\/encrypted-tbn0\.gstatic\.com\/images\?q=tbn:[^"'\s\\&]+/gi
      );
      for (const m of tbnMatches) {
        const url = m[0].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&");
        if (!images.includes(url)) {
          images.unshift(url);
          if (images.length >= 8) break;
        }
      }
    }
  } catch (e) {
    console.warn("Google Images fetch error:", e);
  }

  if (images.length === 0) {
    try {
      const wikiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=filetype:bitmap+${encodeURIComponent(
        query
      )}&gsrlimit=4&prop=imageinfo&iiprop=url&iiurlwidth=400&format=json&origin=*`;
      const res = await fetch(wikiUrl);
      if (res.ok) {
        const data = await res.json();
        const pages: any[] = Object.values(data?.query?.pages || {});
        for (const p of pages) {
          const thumb = p?.imageinfo?.[0]?.thumburl || p?.imageinfo?.[0]?.url;
          if (thumb) images.push(thumb);
        }
      }
    } catch {
      // Ignore fallback error
    }
  }

  return images;
}

/**
 * Convert an audio URL into a compact Base64 Data URL (~12KB)
 */
async function fetchAudioAsBase64(audioUrl: string): Promise<string> {
  if (!audioUrl) return "";
  try {
    const res = await fetch(audioUrl);
    if (!res.ok) return "";
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 350 * 1024) {
      return "";
    }
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const contentType = res.headers.get("content-type") || "audio/mpeg";
    return `data:${contentType};base64,${btoa(binary)}`;
  } catch {
    return "";
  }
}

/**
 * Master pipeline: Enrich a selected Swedish word
 */
async function analyzeSwedishWord({
  word,
  contextSentence,
  sourceUrl,
  sourceTitle
}: AnalyzeWordRequest): Promise<EnrichmentPayload> {
  const cleaned = cleanWord(word);
  if (!cleaned) {
    throw new Error("No valid Swedish word selected.");
  }

  const settings = await getSettings();

  const [wikiData, gTrans, geminiData] = await Promise.all([
    querySwedishWiktionary(cleaned),
    queryGoogleTranslateDictionary(cleaned, contextSentence),
    queryGeminiFlash(cleaned, contextSentence, settings.geminiApiKey)
  ]);

  const lemma =
    geminiData?.lemma ||
    wikiData?.lemma ||
    gTrans?.detectedLemma ||
    cleaned.toLowerCase();

  let finalWiki = wikiData;
  if (!finalWiki && lemma.toLowerCase() !== cleaned.toLowerCase()) {
    finalWiki = await parseWiktionarySwedishEntry(lemma);
  }

  let baseGTrans: GoogleTranslateResult | null = null;
  if (
    lemma.toLowerCase() !== cleaned.toLowerCase() &&
    !geminiData?.lemmaTranslation &&
    !finalWiki?.englishFromWiktionary
  ) {
    baseGTrans = await queryGoogleTranslateDictionary(lemma, "");
  }

  const article = geminiData?.article || finalWiki?.article || "";
  const partOfSpeech =
    geminiData?.partOfSpeech ||
    finalWiki?.partOfSpeech ||
    gTrans?.partOfSpeech ||
    "word";

  const lemmaTranslation =
    geminiData?.lemmaTranslation ||
    finalWiki?.englishFromWiktionary ||
    (baseGTrans?.synonyms?.length
      ? baseGTrans.synonyms.slice(0, 3).join(", ")
      : "") ||
    baseGTrans?.wordTranslation ||
    (gTrans?.synonyms?.length ? gTrans.synonyms.slice(0, 3).join(", ") : "") ||
    gTrans?.wordTranslation ||
    "";

  const contextualTranslation =
    geminiData?.contextualTranslation ||
    gTrans?.wordTranslation ||
    lemmaTranslation;

  const sentenceTranslation =
    geminiData?.sentenceTranslation || gTrans?.sentenceTranslation || "";

  let audioUrl = finalWiki?.audioUrl || "";
  let audioSource = finalWiki?.audioSource || "";

  if (!audioUrl) {
    const soAudio = await querySvenskaSeAudio(lemma);
    if (soAudio) {
      audioUrl = soAudio;
      audioSource = "Svenska.se SO (Native Dictionary)";
    }
  }

  if (!audioUrl) {
    const spokenText = article ? `${article} ${lemma}` : lemma;
    audioUrl = `https://translate.googleapis.com/translate_tts?ie=UTF-8&tl=sv&client=tw-ob&q=${encodeURIComponent(
      spokenText
    )}`;
    audioSource = "Swedish Pronunciation TTS (Fallback)";
  }

  const imageQuery =
    geminiData?.imageSearchQuery ||
    `${lemma} ${lemmaTranslation.split(",")[0] || ""}`.trim();
  const [audioBase64, images] = await Promise.all([
    fetchAudioAsBase64(audioUrl),
    fetchGoogleImages(imageQuery)
  ]);

  return {
    sourceUrl: sourceUrl || "",
    sourceTitle: sourceTitle || "",
    swedish: {
      surfaceForm: cleaned,
      lemma,
      article,
      partOfSpeech,
      inflections: geminiData?.inflections || "",
      definitionSv: finalWiki?.definitionSv || "",
      contextSentence: contextSentence || cleaned
    },
    english: {
      lemmaTranslation,
      contextualTranslation,
      sentenceTranslation
    },
    media: {
      imageUrl: images[0] || "",
      imageAlternatives: images,
      audioUrl,
      audioBase64,
      audioSource
    }
  };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "svenska-spaced-lookup",
    title: "🇸🇪 Look up '%s' in SvenskaSpaced",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "svenska-spaced-lookup" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      type: "TRIGGER_SELECTION_LOOKUP",
      selectionText: info.selectionText
    });
  }
});

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse) => {
    (async () => {
      try {
        switch (message.type) {
          case "ANALYZE_WORD": {
            const result = await analyzeSwedishWord(message.payload);
            sendResponse({ ok: true, data: result });
            break;
          }
          case "SAVE_CARD": {
            const saved = await saveCardToStorage(message.payload);
            sendResponse({ ok: true, data: saved });
            break;
          }
          case "GET_CARDS": {
            const cards = await getAllCards();
            sendResponse({ ok: true, data: cards });
            break;
          }
          case "DELETE_CARD": {
            const remaining = await deleteCard(message.cardId);
            sendResponse({ ok: true, data: remaining });
            break;
          }
          case "GET_SETTINGS": {
            const settings = await getSettings();
            sendResponse({ ok: true, data: settings });
            break;
          }
          case "SAVE_SETTINGS": {
            const updated = await saveSettings(message.payload);
            sendResponse({ ok: true, data: updated });
            break;
          }
          case "SYNC_ALL": {
            const count = await syncAllLocalToCloud();
            sendResponse({ ok: true, count });
            break;
          }
          default:
            sendResponse({ ok: false, error: "Unknown message type" });
        }
      } catch (err: any) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }
);
