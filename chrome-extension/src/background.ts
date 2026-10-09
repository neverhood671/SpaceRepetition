import {
  getSettings,
  saveSettings,
  saveCardToStorage,
  findExistingCard,
  getAllCards,
  deleteCard,
  syncAllLocalToCloud
} from "./firestore.js";
import {
  AnalyzeWordRequest,
  EnrichmentPayload,
  ExtensionMessage
} from "./types.js";

export interface WiktionaryParseResult {
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
export function cleanWord(raw: string | undefined): string {
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
export async function querySwedishWiktionary(
  word: string
): Promise<WiktionaryParseResult | null> {
  const stripped = word.replace(/^att\s+/i, "").trim();
  const candidates = Array.from(
    new Set([ stripped, stripped.toLowerCase(), word, word.toLowerCase() ])
  ).filter(Boolean);
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

      // Check if this entry is an inflection of a base lemma: {{böjning|sv|subst|hund}} or {{böjning|sv|verb|segra}}
      const inflectionMatch = svSection.match(
        /\{\{böjning\|sv\|([^|}]+)\|([^|}]+)/i
      );
      if (inflectionMatch && inflectionMatch[2]) {
        const inflectedPos = inflectionMatch[1].trim().toLowerCase();
        const baseLemma = inflectionMatch[2].trim();
        if (baseLemma.toLowerCase() !== candidate.toLowerCase()) {
          const baseResult = await parseWiktionarySwedishEntry(baseLemma);
          if (baseResult) {
            return {
              ...baseResult,
              lemma: baseLemma,
              partOfSpeech:
                baseResult.partOfSpeech !== "word"
                  ? baseResult.partOfSpeech
                  : inflectedPos === "verb"
                  ? "verb"
                  : inflectedPos === "subst"
                  ? "noun"
                  : baseResult.partOfSpeech
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

export async function parseWiktionarySection(
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
 * Extract image URLs from Bing Images async HTML or Google Images HTML
 */
export function extractImagesFromHtml(html: string): string[] {
  const images: string[] = [];
  const normalized = (html || "")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u0026/gi, "&")
    .replace(/&amp;/gi, "&");

  const pushUnique = (rawUrl: string) => {
    const cleaned = rawUrl.replace(/&quot;.*$/i, "").trim();
    if (cleaned.startsWith("https://") && !images.includes(cleaned)) {
      images.push(cleaned);
    }
  };

  // 1. Bing Images async thumbnail URLs (turl&quot;:&quot;https://...&quot;)
  const bingTurlMatches = normalized.matchAll(
    /turl(?:&quot;|"):\s*(?:&quot;|")(https:\/\/[^"'<>\\\s]+?)(?:&quot;|")/gi
  );
  for (const m of bingTurlMatches) {
    pushUnique(m[1]);
    if (images.length >= 8) return images;
  }

  // 2. Direct Bing OIP thumbnail URLs (th.bing.com / tse*.mm.bing.net)
  const bingOipMatches = normalized.matchAll(
    /https:\/\/(?:th\.bing\.com|tse\d+\.mm\.bing\.net)\/th(?:\?id=|\/id\/)OIP\.[^"'<>\\\s]+/gi
  );
  for (const m of bingOipMatches) {
    pushUnique(m[0]);
    if (images.length >= 8) return images;
  }

  // 3. Bing murl full image URLs
  const bingMurlMatches = normalized.matchAll(
    /murl(?:&quot;|"):\s*(?:&quot;|")(https:\/\/[^"'<>\\\s]+\.(?:jpg|jpeg|png|webp))(?=&quot;|")/gi
  );
  for (const m of bingMurlMatches) {
    pushUnique(m[1]);
    if (images.length >= 8) return images;
  }

  // 4. Google Images encrypted-tbn0 thumbnails
  const tbnMatches = normalized.matchAll(
    /https:\/\/encrypted-tbn0\.gstatic\.com\/images\?q=tbn:[^"'\s\\<>]+/gi
  );
  for (const m of tbnMatches) {
    pushUnique(m[0]);
    if (images.length >= 8) return images;
  }

  // 5. Google Images direct URLs
  const fullImgMatches = normalized.matchAll(
    /\["(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp))",\d+,\d+\]/gi
  );
  for (const m of fullImgMatches) {
    const candidate = m[1];
    if (!candidate.includes("gstatic.com") && !candidate.includes("google.com")) {
      pushUnique(candidate);
      if (images.length >= 8) return images;
    }
  }

  return images;
}

/**
 * 5. Fetch Images for a Swedish Word using:
 *    - Bing Images async endpoint (static HTML thumbnails, no JS redirect gate)
 *    - Google Images search endpoint
 *    - Wikipedia PageImages API & Wikimedia Commons API (single-language queries)
 */
export async function fetchGoogleImages(
  query: string,
  fallbackQueries: string[] = []
): Promise<string[]> {
  const images: string[] = [];
  const pushUnique = (url: string) => {
    if (url && url.startsWith("https://") && !images.includes(url)) {
      images.push(url);
    }
  };

  const searchTerms = Array.from(
    new Set(
      [query, ...fallbackQueries]
        .map((q) => (q || "").replace(/^att\s+/i, "").trim())
        .filter(Boolean)
    )
  );
  if (searchTerms.length === 0) return images;

  const primaryQuery = searchTerms[0];

  // A. Query Bing Images async endpoint (fast static HTML with high-reliability thumbnails)
  try {
    const bingUrl = `https://www.bing.com/images/async?q=${encodeURIComponent(
      primaryQuery
    )}&first=1&count=8&adlt=strict`;
    const res = await fetch(bingUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });
    if (res.ok) {
      const html = await res.text();
      for (const img of extractImagesFromHtml(html)) {
        pushUnique(img);
      }
    }
  } catch (e) {
    console.warn("Bing Images fetch error:", e);
  }

  // B. Query Google Images endpoint if still needed
  if (images.length < 2) {
    try {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(
        primaryQuery
      )}&tbm=isch&hl=sv&safe=active`;
      const res = await fetch(searchUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7"
        }
      });
      if (res.ok) {
        const html = await res.text();
        for (const img of extractImagesFromHtml(html)) {
          pushUnique(img);
        }
      }
    } catch (e) {
      console.warn("Google Images fetch error:", e);
    }
  }

  // C. Query Wikipedia pageimages & Wikimedia Commons using clean single-language terms
  if (images.length < 3) {
    for (const term of searchTerms) {
      if (images.length >= 6) break;
      try {
        const wikiPageImgUrl = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
          term
        )}&gsrlimit=4&prop=pageimages&piprop=thumbnail&pithumbsize=500&format=json&origin=*`;
        const wpRes = await fetch(wikiPageImgUrl);
        if (wpRes.ok) {
          const wpData = await wpRes.json();
          const pages: any[] = Object.values(wpData?.query?.pages || {});
          for (const p of pages) {
            if (p?.thumbnail?.source) {
              pushUnique(p.thumbnail.source);
            }
          }
        }
      } catch {
        // Ignore Wikipedia error
      }

      if (images.length >= 6) break;

      try {
        const commonsUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=filetype:bitmap+${encodeURIComponent(
          term
        )}&gsrlimit=4&prop=imageinfo&iiprop=url&iiurlwidth=400&format=json&origin=*`;
        const res = await fetch(commonsUrl);
        if (res.ok) {
          const data = await res.json();
          const pages: any[] = Object.values(data?.query?.pages || {});
          for (const p of pages) {
            const thumb = p?.imageinfo?.[0]?.thumburl || p?.imageinfo?.[0]?.url;
            if (thumb) pushUnique(thumb);
          }
        }
      } catch {
        // Ignore Wikimedia Commons error
      }
    }
  }

  return images.slice(0, 8);
}

/**
 * Convert an image URL into a Base64 Data URL in the Service Worker
 * so strict host webpage CSPs (like svtplay.se img-src) never block rendering
 */
export async function fetchImageAsBase64(imageUrl: string): Promise<string> {
  if (!imageUrl || imageUrl.startsWith("data:")) return imageUrl || "";
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return "";
    const contentType = res.headers?.get?.("content-type") || "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return "";
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > 220 * 1024) {
      return "";
    }
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return `data:${contentType.split(";")[0]};base64,${btoa(binary)}`;
  } catch {
    return "";
  }
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
    const contentType = res.headers?.get?.("content-type") || "audio/mpeg";
    return `data:${contentType};base64,${btoa(binary)}`;
  } catch {
    return "";
  }
}

/**
 * Master pipeline: Enrich a selected Swedish word
 */
export async function analyzeSwedishWord({
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

  const rawLemma =
    geminiData?.lemma ||
    wikiData?.lemma ||
    gTrans?.detectedLemma ||
    cleaned.toLowerCase();

  const bareLemma = rawLemma.replace(/^att\s+/i, "").trim();

  let finalWiki = wikiData;
  if (!finalWiki && bareLemma.toLowerCase() !== cleaned.toLowerCase()) {
    finalWiki = await parseWiktionarySwedishEntry(bareLemma);
  }

  let baseGTrans: GoogleTranslateResult | null = null;
  if (
    bareLemma.toLowerCase() !== cleaned.toLowerCase() &&
    !geminiData?.lemmaTranslation &&
    !finalWiki?.englishFromWiktionary
  ) {
    baseGTrans = await queryGoogleTranslateDictionary(bareLemma, "");
  }

  const partOfSpeech =
    geminiData?.partOfSpeech ||
    finalWiki?.partOfSpeech ||
    gTrans?.partOfSpeech ||
    (/^att\s+/i.test(cleaned) ? "verb" : "word");

  const isVerb = /verb/i.test(partOfSpeech) || /^att\s+/i.test(rawLemma);
  const article = isVerb ? "" : geminiData?.article || finalWiki?.article || "";
  const formattedLemma = isVerb ? `att ${bareLemma}` : bareLemma;

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
    const soAudio = await querySvenskaSeAudio(bareLemma);
    if (soAudio) {
      audioUrl = soAudio;
      audioSource = "Svenska.se SO (Native Dictionary)";
    }
  }

  if (!audioUrl) {
    const spokenText = article ? `${article} ${formattedLemma}` : formattedLemma;
    audioUrl = `https://translate.googleapis.com/translate_tts?ie=UTF-8&tl=sv&client=tw-ob&q=${encodeURIComponent(
      spokenText
    )}`;
    audioSource = "Swedish Pronunciation TTS (Fallback)";
  }

  const englishPrimary = (
    lemmaTranslation.split(",")[0] ||
    contextualTranslation.split(",")[0] ||
    ""
  )
    .replace(/^to\s+/i, "")
    .trim();

  const primaryImageQuery =
    geminiData?.imageSearchQuery || englishPrimary || bareLemma;
  const fallbackImageQueries = [bareLemma, englishPrimary].filter(Boolean);

  const [audioBase64, rawImages, existingCard] = await Promise.all([
    fetchAudioAsBase64(audioUrl),
    fetchGoogleImages(primaryImageQuery, fallbackImageQueries),
    findExistingCard(formattedLemma, article, cleaned)
  ]);

  // Convert first image to a CSP-safe data URL if possible, while keeping alternatives
  const images = [...rawImages];
  if (images.length > 0) {
    const firstBase64 = await fetchImageAsBase64(images[0]);
    if (firstBase64) {
      images[0] = firstBase64;
    }
  } else if (existingCard?.media?.imageUrl) {
    images.push(existingCard.media.imageUrl);
  }

  return {
    sourceUrl: sourceUrl || "",
    sourceTitle: sourceTitle || "",
    alreadySaved: Boolean(existingCard),
    existingCardId: existingCard?.id,
    swedish: {
      surfaceForm: cleaned,
      lemma: formattedLemma,
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

if (typeof chrome !== "undefined" && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
      id: "svenska-spaced-lookup",
      title: "🇸🇪 Look up '%s' in SvenskaSpaced",
      contexts: ["selection"]
    });
  });
}

if (typeof chrome !== "undefined" && chrome.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "svenska-spaced-lookup" && tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: "TRIGGER_SELECTION_LOOKUP",
        selectionText: info.selectionText
      });
    }
  });
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
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
}
