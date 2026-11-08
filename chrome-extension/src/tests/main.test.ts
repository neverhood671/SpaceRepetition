import {
  cleanWord,
  parseWiktionarySection,
  querySwedishWiktionary,
  extractImagesFromHtml,
  fetchGoogleImages,
  fetchImageAsBase64,
  analyzeSwedishWord,
  isVerbPartOfSpeech,
  isAdverbPartOfSpeech,
  inferSwedishPosFromContext,
  hasSwedishAdjectiveMorphology,
  normalizeSwedishAdjectiveLemma
} from "../background.js";
import {
  createCardObject,
  cardToFirestoreDoc,
  firestoreDocToCard,
  saveCardToStorage,
  getAllCards,
  stripCardSavedAudio,
  cleanupSavedAudioInStorage,
  buildFallbackAudioUrl
} from "../firestore.js";
import {
  computePreviousReplicaSeek,
  updateSubtitleTokenSelection,
  parseSubtitleLinesFromHtml
} from "../types.js";

interface MockResponseInit {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  jsonData?: unknown;
  textData?: string;
  binaryData?: Uint8Array;
}

function createMockResponse(init: MockResponseInit): Response {
  const ok = init.ok ?? true;
  const status = init.status ?? (ok ? 200 : 404);
  const headerMap = new Map<string, string>();
  for (const [k, v] of Object.entries(init.headers || {})) {
    headerMap.set(k.toLowerCase(), v);
  }
  return {
    ok,
    status,
    headers: {
      get(name: string) {
        return headerMap.get(name.toLowerCase()) || null;
      }
    },
    async json() {
      return init.jsonData;
    },
    async text() {
      if (init.textData !== undefined) return init.textData;
      return JSON.stringify(init.jsonData ?? "");
    },
    async arrayBuffer() {
      if (init.binaryData) return init.binaryData.buffer;
      return new Uint8Array([255, 216, 255, 224]).buffer;
    }
  } as unknown as Response;
}

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

let passedTests = 0;
let failedTests = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failedTests++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err?.message || err}`);
  }
}

async function runTests(): Promise<void> {
  console.log("\n🇸🇪 SvenskaSpaced Automated Test Suite\n");

  // ---------------------------------------------------------------------------
  // 1. Word Cleaning & Swedish Character Normalization
  // ---------------------------------------------------------------------------
  console.log("1. Word Cleaning (cleanWord)");

  await test("strips punctuation while preserving Swedish characters å, ä, ö", () => {
    assertEqual(cleanWord("  ”höll”... "), "höll", "Should strip quotes and ellipsis");
    assertEqual(cleanWord("¡tågstationen!"), "tågstationen", "Should keep å");
    assertEqual(cleanWord("(känslorna),"), "känslorna", "Should keep ä");
    assertEqual(cleanWord("«översättning»"), "översättning", "Should keep ö");
  });

  await test("preserves multi-word Swedish partikelverb phrases", () => {
    assertEqual(
      cleanWord(" ”höll till.” "),
      "höll till",
      "Should preserve space inside multi-word partikelverb"
    );
  });

  // ---------------------------------------------------------------------------
  // 2. Image Extraction & Multi-Source Image Fetching
  // ---------------------------------------------------------------------------
  console.log("\n2. Image Search & Extraction (extractImagesFromHtml & fetchGoogleImages)");

  await test("extracts image thumbnails from Bing Images async HTML", () => {
    const sampleBingAsyncHtml = `
      <div class="imgpt">
        <a class="iusc" m="{&quot;cid&quot;:&quot;123&quot;,&quot;turl&quot;:&quot;https://tse1.mm.bing.net/th?id=OIP.abc123_hund&amp;pid=15.1&quot;,&quot;murl&quot;:&quot;https://example.com/photos/swedish_hund.jpg&quot;}"></a>
        <img src="https://th.bing.com/th/id/OIP.xyz987_hund?w=236&amp;h=180" />
      </div>
    `;
    const urls = extractImagesFromHtml(sampleBingAsyncHtml);
    assert(urls.length >= 2, "Should extract at least 2 image URLs from Bing HTML");
    assertEqual(
      urls[0],
      "https://tse1.mm.bing.net/th?id=OIP.abc123_hund&pid=15.1",
      "First URL should be decoded Bing turl thumbnail"
    );
    assert(
      urls.includes("https://th.bing.com/th/id/OIP.xyz987_hund?w=236&h=180"),
      "Should include direct th.bing.com OIP thumbnail"
    );
    assert(
      urls.includes("https://example.com/photos/swedish_hund.jpg"),
      "Should include murl full JPG image"
    );
  });

  await test("extracts image thumbnails from Google Images HTML", () => {
    const sampleGoogleHtml = `
      <script>AF_initDataCallback({data:[["https://cdn.example.org/victory.jpg",600,800]]});</script>
      <img src="https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcR_test_thumb\\u0026s" />
    `;
    const urls = extractImagesFromHtml(sampleGoogleHtml);
    assertEqual(urls.length, 2, "Should extract both gstatic thumbnail and direct JPG");
    assertEqual(
      urls[0],
      "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcR_test_thumb&s",
      "Should decode \\u0026 in gstatic thumbnail URL"
    );
    assertEqual(
      urls[1],
      "https://cdn.example.org/victory.jpg",
      "Should include direct JPG URL"
    );
  });

  await test("fetchGoogleImages falls back to Wikipedia/Commons when search HTML has no images", async () => {
    const requestedUrls: string[] = [];
    (globalThis as any).fetch = async (input: string | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("bing.com") || url.includes("google.com/search")) {
        // Simulate Google's JS redirect gate (0 images in HTML)
        return createMockResponse({ textData: "<html>Redirecting...</html>" });
      }
      if (url.includes("en.wikipedia.org/w/api.php")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "101": {
                  thumbnail: {
                    source: "https://upload.wikimedia.org/wikipedia/commons/thumb/dog_500px.jpg"
                  }
                }
              }
            }
          }
        });
      }
      if (url.includes("commons.wikimedia.org/w/api.php")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "202": {
                  imageinfo: [
                    {
                      thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/hund_400px.jpg"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      return createMockResponse({ ok: false });
    };

    const images = await fetchGoogleImages("att segra", ["segra", "conquer"]);
    assert(images.length >= 2, "Should return fallback images from Wikipedia & Commons");
    assertEqual(
      images[0],
      "https://upload.wikimedia.org/wikipedia/commons/thumb/dog_500px.jpg",
      "First fallback image should come from Wikipedia pageimages"
    );
    assert(
      requestedUrls.some((u) => u.includes("q=segra")),
      "Should strip 'att ' prefix when querying images for verbs"
    );
  });

  await test("fetchImageAsBase64 converts image/* binary responses into CSP-safe data URLs", async () => {
    (globalThis as any).fetch = async () =>
      createMockResponse({
        headers: { "content-type": "image/jpeg" },
        binaryData: new Uint8Array([255, 216, 255, 224])
      });

    const dataUrl = await fetchImageAsBase64("https://tse1.mm.bing.net/th?id=OIP.test");
    assert(
      dataUrl.startsWith("data:image/jpeg;base64,"),
      `Expected data:image/jpeg;base64,... but got ${dataUrl}`
    );
  });

  // ---------------------------------------------------------------------------
  // 3. Swedish Dictionary & Wiktionary Parsing
  // ---------------------------------------------------------------------------
  console.log("\n3. Swedish Dictionary & Wiktionary Parsing");

  await test("part-of-speech helpers never confuse 'adverb' with 'verb'", () => {
    assertEqual(isVerbPartOfSpeech("verb"), true, "'verb' should be a verb");
    assertEqual(isVerbPartOfSpeech("partikelverb"), true, "'partikelverb' should be a verb");
    assertEqual(isVerbPartOfSpeech("partikelverb", "ha ihjäl"), true, "multi-word 'ha ihjäl' is a partikelverb");
    assertEqual(isVerbPartOfSpeech("partikelverb", "ihjäl"), false, "single token 'ihjäl' cannot be a partikelverb");
    assertEqual(isVerbPartOfSpeech("verbpartikel"), false, "'verbpartikel' MUST NOT be classified as a verb");
    assertEqual(isVerbPartOfSpeech("partikel"), false, "'partikel' MUST NOT be classified as a verb");
    assertEqual(isVerbPartOfSpeech("adverb"), false, "'adverb' MUST NOT be classified as a verb");
    assertEqual(isVerbPartOfSpeech("Adverb"), false, "Case-insensitive check for 'adverb'");
    assertEqual(isVerbPartOfSpeech("adverbial"), false, "'adverbial' MUST NOT be classified as a verb");
    assertEqual(isVerbPartOfSpeech("noun"), false, "'noun' is not a verb");

    assertEqual(isAdverbPartOfSpeech("adverb"), true, "'adverb' is an adverb");
    assertEqual(isAdverbPartOfSpeech("verbpartikel"), true, "'verbpartikel' is an adverb");
    assertEqual(isAdverbPartOfSpeech("word", "ihjäl"), true, "'ihjäl' is recognized as an adverbial particle");
    assertEqual(isAdverbPartOfSpeech("word", "uppenbarligen"), true, "-ligen suffix marks adverb");
    assertEqual(isAdverbPartOfSpeech("word", "tydligen"), true, "-ligen suffix marks adverb");
    assertEqual(isAdverbPartOfSpeech("verb", "segra"), false, "'segra' is not an adverb");
  });

  await test("parses 'uppenbarligen' as adverb without adding 'att '", async () => {
    (globalThis as any).fetch = async () => createMockResponse({ jsonData: {} });
    const svSection = `
===Adverb===
{{adv|sv}}
'''uppenbarligen'''
#utan tvekan, [[bevisligen]], [[tydligen]], [[naturligtvis]]
*engelska: {{ö+|en|obviously}}
`;
    const parsed = await parseWiktionarySection("uppenbarligen", svSection);
    assertEqual(parsed.partOfSpeech, "adverb", "Should detect adverb");
    assertEqual(parsed.article, "", "Adverb must have empty article");
    assertEqual(parsed.englishFromWiktionary, "obviously", "Should extract 'obviously'");
  });

  await test("parses Swedish Wiktionary '===Verbpartikel===' ('ihjäl') as adverb without 'att '", async () => {
    (globalThis as any).fetch = async () => createMockResponse({ jsonData: {} });
    const svSection = `
===Verbpartikel===
{{verbpartikel|sv}}
'''ihjäl'''
# till [[döds]], så att [[döden]] [[inträffa]]r
#:''De slogs till blods, men inte '''ihjäl''' varandra.''
#:''Att ha '''ihjäl''' någon.''
*engelska: {{ö|en|to death}}
`;
    const parsed = await parseWiktionarySection("ihjäl", svSection);
    assertEqual(parsed.partOfSpeech, "adverb", "===Verbpartikel=== must be mapped to 'adverb'");
    assertEqual(parsed.article, "", "Verbpartikel must have empty article");
    assertEqual(parsed.englishFromWiktionary, "to death", "Should extract 'to death'");
  });

  await test("parses 'en' noun gender, Swedish definition, and English translations", async () => {
    (globalThis as any).fetch = async () =>
      createMockResponse({
        jsonData: {
          query: {
            pages: {
              "1": {
                imageinfo: [{ url: "https://upload.wikimedia.org/wikipedia/commons/Sv-hund.ogg" }]
              }
            }
          }
        }
      });

    const svSection = `
===Substantiv===
{{sv-subst-n}}
'''hund'''
# tamt [[rovddjur]] av arten ''Canis lupus''
*{{uttal|sv|ljud=Sv-hund.ogg}}
====Översättningar====
*engelska: {{ö+|en|dog}}, {{ö|en|hound}}
`;
    const parsed = await parseWiktionarySection("hund", svSection);
    assertEqual(parsed.partOfSpeech, "noun", "Should detect noun");
    assertEqual(parsed.article, "en", "Should detect 'en' gender");
    assertEqual(parsed.englishFromWiktionary, "dog, hound", "Should extract English translations");
    assert(parsed.definitionSv.includes("rovddjur"), "Should extract Swedish definition");
    assertEqual(
      parsed.audioUrl,
      "https://upload.wikimedia.org/wikipedia/commons/Sv-hund.ogg",
      "Should resolve native human audio URL"
    );
  });

  await test("parses 'ett' noun gender ({{sv-subst-t}})", async () => {
    (globalThis as any).fetch = async () => createMockResponse({ jsonData: {} });
    const svSection = `
===Substantiv===
{{sv-subst-t}}
'''bibliotek'''
# samling av böcker
*engelska: {{ö+|en|library}}
`;
    const parsed = await parseWiktionarySection("bibliotek", svSection);
    assertEqual(parsed.partOfSpeech, "noun", "Should detect noun");
    assertEqual(parsed.article, "ett", "Should detect 'ett' gender");
    assertEqual(parsed.englishFromWiktionary, "library", "Should extract 'library'");
  });

  await test("resolves multi-word Swedish partikelverb ('höll till' -> 'hålla till')", async () => {
    (globalThis as any).fetch = async (input: string | URL) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("titles=höll till")) {
        return createMockResponse({
          jsonData: { query: { pages: { "-1": { missing: "" } } } }
        });
      }
      if (url.includes("titles=höll")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "10": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Verb===\n#{{böjning|sv|verb|hålla}}"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      if (url.includes("titles=hålla till")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "20": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Verb===\n'''hålla till''' (partikelverb)\n# vistas på viss plats\n*engelska: {{ö+|en|hang out}}, {{ö+|en|stay}}"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      if (url.includes("titles=hålla")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "15": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Verb===\n'''hålla'''\n# ha i handen"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      return createMockResponse({ jsonData: {} });
    };

    const result = await querySwedishWiktionary("höll till");
    assert(result !== null, "Should resolve 'höll till'");
    assertEqual(result?.lemma, "hålla till", "Should resolve base lemma to 'hålla till'");
    assertEqual(result?.partOfSpeech, "partikelverb", "Should mark partOfSpeech as 'partikelverb'");
    assertEqual(result?.englishFromWiktionary, "hang out, stay", "Should extract partikelverb translation");
  });

  // ---------------------------------------------------------------------------
  // 4. Master Enrichment Pipeline: Verb "att " Prefix + Guaranteed Image URL
  // ---------------------------------------------------------------------------
  console.log("\n4. Master Enrichment Pipeline (analyzeSwedishWord)");

  await test("prefixes verbs with 'att ' (e.g. 'segrade' -> 'att segra') and attaches images", async () => {
    (globalThis as any).fetch = async (input: string | URL) => {
      const url = decodeURIComponent(String(input));

      // Wiktionary lookup for inflected verb "segrade" -> base verb "segra"
      if (url.includes("sv.wiktionary.org") && url.includes("titles=segrade")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "1": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Verb===\n#{{böjning|sv|verb|segra}}"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      if (url.includes("sv.wiktionary.org") && url.includes("titles=segra")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "2": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Verb===\n'''segra'''\n# vinna en seger\n*engelska: {{ö+|en|win}}, {{ö+|en|triumph}}"
                    }
                  ]
                }
              }
            }
          }
        });
      }

      // Google Translate endpoint
      if (url.includes("translate.googleapis.com/translate_a/single")) {
        return createMockResponse({
          jsonData: [
            [["won", "segrade"]],
            [["verb", ["win", "conquer", "triumph"], [], "segra"]]
          ]
        });
      }

      // Bing Images async endpoint
      if (url.includes("bing.com/images/async")) {
        return createMockResponse({
          textData: `<a m="{&quot;turl&quot;:&quot;https://tse1.mm.bing.net/th?id=OIP.segra_trophy&quot;}"></a>`
        });
      }

      // Thumbnail binary fetch for CSP-safe base64 conversion
      if (url.includes("tse1.mm.bing.net/th?id=OIP.segra_trophy")) {
        return createMockResponse({
          headers: { "content-type": "image/jpeg" },
          binaryData: new Uint8Array([255, 216, 255, 224])
        });
      }

      return createMockResponse({ jsonData: {} });
    };

    const enriched = await analyzeSwedishWord({
      word: "segrade",
      contextSentence: "Laget segrade till slut.",
      sourceUrl: "https://www.svtplay.se/video/123",
      sourceTitle: "SVT Play"
    });

    assertEqual(enriched.swedish.surfaceForm, "segrade", "Surface form should be 'segrade'");
    assertEqual(enriched.swedish.lemma, "att segra", "Verb lemma MUST be prefixed with 'att '");
    assertEqual(enriched.swedish.article, "", "Verbs must not have an en/ett article");
    assertEqual(enriched.swedish.partOfSpeech, "verb", "partOfSpeech should be 'verb'");
    assertEqual(enriched.english.lemmaTranslation, "win, triumph", "Should include English translation");
    const imgUrl = enriched.media.imageUrl || "";
    const imgAlts = enriched.media.imageAlternatives || [];
    assert(
      Boolean(imgUrl),
      "Enriched payload MUST include a non-empty media.imageUrl"
    );
    assert(
      imgUrl.startsWith("data:image/jpeg;base64,") ||
        imgUrl.startsWith("https://"),
      "media.imageUrl should be a valid data URL or https URL"
    );
    assert(
      imgAlts.length >= 1,
      "media.imageAlternatives should contain at least 1 image"
    );
  });

  await test("prefixes multi-word partikelverb with 'att ' ('höll till' -> 'att hålla till')", async () => {
    (globalThis as any).fetch = async (input: string | URL) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("sv.wiktionary.org") && url.includes("titles=höll till")) {
        return createMockResponse({
          jsonData: { query: { pages: { "-1": { missing: "" } } } }
        });
      }
      if (url.includes("sv.wiktionary.org") && url.includes("titles=höll")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "10": {
                  revisions: [{ "*": "==Svenska==\n===Verb===\n#{{böjning|sv|verb|hålla}}" }]
                }
              }
            }
          }
        });
      }
      if (url.includes("sv.wiktionary.org") && url.includes("titles=hålla till")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "20": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Verb===\n'''hålla till''' (partikelverb)\n# vistas\n*engelska: {{ö+|en|hang out}}"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      if (url.includes("sv.wiktionary.org") && url.includes("titles=hålla")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "15": {
                  revisions: [{ "*": "==Svenska==\n===Verb===\n'''hålla'''" }]
                }
              }
            }
          }
        });
      }
      if (url.includes("bing.com/images/async")) {
        return createMockResponse({
          textData: `<a m="{&quot;turl&quot;:&quot;https://tse1.mm.bing.net/th?id=OIP.hangout_img&quot;}"></a>`
        });
      }
      return createMockResponse({ jsonData: {} });
    };

    const enriched = await analyzeSwedishWord({
      word: "höll till",
      contextSentence: "Om man jobbade för Adidas, bodde man och höll oftast till på den sidan."
    });

    assertEqual(
      enriched.swedish.lemma,
      "att hålla till",
      "Partikelverb lemma MUST be prefixed with 'att '"
    );
    assertEqual(enriched.swedish.partOfSpeech, "partikelverb", "Should be 'partikelverb'");
    assert(Boolean(enriched.media.imageUrl), "Should include an image URL");
  });

  await test("recognizes adverb 'uppenbarligen' correctly as adverb without 'att ' prefix", async () => {
    (globalThis as any).fetch = async (input: string | URL) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("sv.wiktionary.org") && url.includes("titles=uppenbarligen")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "116": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Adverb===\n{{adv|sv}}\n'''uppenbarligen'''\n#utan tvekan, [[bevisligen]]\n*engelska: {{ö+|en|obviously}}"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      if (url.includes("translate.googleapis.com")) {
        return createMockResponse({
          jsonData: [
            [["obviously", "uppenbarligen"]],
            [["adverb", ["obviously", "apparently"], [], "uppenbarligen"]]
          ]
        });
      }
      return createMockResponse({ jsonData: {} });
    };

    const enriched = await analyzeSwedishWord({
      word: "uppenbarligen",
      contextSentence: "Vi och de-mekanismerna i oss har uppenbarligen varit flexibla nog–"
    });

    assertEqual(
      enriched.swedish.lemma,
      "uppenbarligen",
      "Adverb MUST NOT have 'att ' prepended"
    );
    assertEqual(
      enriched.swedish.partOfSpeech,
      "adverb",
      "partOfSpeech MUST be 'adverb'"
    );
    assertEqual(
      enriched.swedish.article,
      "",
      "Adverb must have no article"
    );
    assertEqual(
      enriched.english.lemmaTranslation,
      "obviously",
      "Should extract English translation 'obviously'"
    );
  });

  await test("recognizes verbal particle 'ihjäl' as adverb without 'att ' prefix in context", async () => {
    (globalThis as any).fetch = async (input: string | URL) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("sv.wiktionary.org") && url.includes("titles=ihjäl")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "101": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Verbpartikel===\n{{verbpartikel|sv}}\n'''ihjäl'''\n# till [[döds]], så att [[döden]] [[inträffa]]r\n*engelska: {{ö|en|to death}}"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      if (url.includes("translate.googleapis.com")) {
        return createMockResponse({
          jsonData: [
            [["to death", "ihjäl"]],
            [["adverb", ["to death"], [], "ihjäl"]]
          ]
        });
      }
      return createMockResponse({ jsonData: {} });
    };

    const enriched = await analyzeSwedishWord({
      word: "ihjäl",
      contextSentence: "Två personer som gjorde allt för att ha ihjäl varandra–"
    });

    assertEqual(
      enriched.swedish.lemma,
      "ihjäl",
      "Particle 'ihjäl' MUST NOT have 'att ' prepended"
    );
    assertEqual(
      enriched.swedish.partOfSpeech,
      "adverb",
      "Particle 'ihjäl' MUST have partOfSpeech 'adverb'"
    );
    assertEqual(
      enriched.swedish.article,
      "",
      "Particle 'ihjäl' must have empty article"
    );
  });

  await test("recognizes multi-word phrasal verb 'ha ihjäl' with 'att ' prefix", async () => {
    (globalThis as any).fetch = async (input: string | URL) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("sv.wiktionary.org") && url.includes("titles=ha ihjäl")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "202": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Verb===\n'''ha ihjäl''' (partikelverb)\n# [[döda]]\n*engelska: {{ö+|en|kill}}"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      if (url.includes("sv.wiktionary.org") && url.includes("titles=ha")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "201": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Verb===\n'''ha'''\n# äga"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      if (url.includes("translate.googleapis.com")) {
        return createMockResponse({
          jsonData: [
            [["kill", "ha ihjäl"]],
            [["verb", ["kill", "destroy"], [], "ha ihjäl"]]
          ]
        });
      }
      return createMockResponse({ jsonData: {} });
    };

    const enriched = await analyzeSwedishWord({
      word: "ha ihjäl",
      contextSentence: "Två personer som gjorde allt för att ha ihjäl varandra–"
    });

    assertEqual(
      enriched.swedish.lemma,
      "att ha ihjäl",
      "Phrasal verb 'ha ihjäl' MUST be prefixed with 'att '"
    );
    assertEqual(
      enriched.swedish.partOfSpeech,
      "partikelverb",
      "Phrasal verb 'ha ihjäl' MUST have partOfSpeech 'partikelverb'"
    );
    assertEqual(
      enriched.swedish.article,
      "",
      "Verb must have empty article"
    );
  });

  await test("disambiguates homograph 'pallar' as a verb ('att palla') in 'Det är då man ser om folk pallar.' even when Wiktionary lists Substantiv first", async () => {
    (globalThis as any).fetch = async (input: string | URL) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("sv.wiktionary.org") && url.includes("titles=pallar")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "501": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Substantiv===\n'''pallar'''\n#{{böjning|sv|subst|pall}}\n===Verb===\n'''pallar'''\n#{{böjning|sv|verb|palla}}"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      if (url.includes("sv.wiktionary.org") && url.includes("titles=palla")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "502": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Verb===\n{{sv-verb-ar}}\n'''palla'''\n#orka med, klara av\n*engelska: {{ö+|en|cope}}, {{ö+|en|manage}}"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      if (url.includes("sv.wiktionary.org") && url.includes("titles=pall")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "503": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Substantiv===\n{{sv-subst-n-ar}}\n'''pall'''\n#liten stol utan ryggstöd\n*engelska: {{ö+|en|stool}}"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      if (url.includes("translate.googleapis.com")) {
        return createMockResponse({
          jsonData: [
            [["stools", "pallar"]],
            [
              ["noun", ["stools", "pallets"], [], "pall"],
              ["verb", ["cope", "manage"], [], "palla"]
            ]
          ]
        });
      }
      return createMockResponse({ jsonData: {} });
    };

    const verbEnriched = await analyzeSwedishWord({
      word: "pallar",
      contextSentence: "Det är då man ser om folk pallar."
    });

    assertEqual(
      verbEnriched.swedish.partOfSpeech,
      "verb",
      "'pallar' in 'Det är då man ser om folk pallar.' MUST be recognized as a verb"
    );
    assertEqual(
      verbEnriched.swedish.lemma,
      "att palla",
      "Lemma MUST be 'att palla' (not 'pall')"
    );
    assertEqual(
      verbEnriched.swedish.article,
      "",
      "Verb 'att palla' must NOT have a noun article"
    );
    assertEqual(
      verbEnriched.english.lemmaTranslation,
      "cope, manage",
      "Should resolve verb translation ('cope, manage') rather than noun ('stool')"
    );
    assertEqual(
      verbEnriched.swedish.dictionaryUrl,
      "https://sv.wiktionary.org/wiki/palla#Svenska",
      "Should include direct link to Swedish Wiktionary entry for base lemma"
    );

    const nounEnriched = await analyzeSwedishWord({
      word: "pallar",
      contextSentence: "Vi köpte tre pallar."
    });

    assertEqual(
      nounEnriched.swedish.partOfSpeech,
      "noun",
      "'pallar' after quantifier 'tre' MUST be recognized as a noun"
    );
    assertEqual(
      nounEnriched.swedish.lemma,
      "pall",
      "Noun lemma should be 'pall'"
    );
    assertEqual(
      nounEnriched.swedish.article,
      "en",
      "Noun 'pall' should have article 'en'"
    );
  });

  await test("recognizes 'jätteknasigt' in 'Det blev jätteknasigt' as an adjective ('jätteknasig') and NEVER adds 'att '", async () => {
    // 1. Test when Wiktionary has base stem 'knasigt' -> 'knasig' (adjective), but no entry for compound 'jätteknasigt'
    (globalThis as any).fetch = async (input: string | URL) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("sv.wiktionary.org") && url.includes("titles=jätteknasig")) {
        return createMockResponse({
          jsonData: { query: { pages: { "-1": { missing: "" } } } }
        });
      }
      if (url.includes("sv.wiktionary.org") && url.includes("titles=knasigt")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "601": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Adjektiv===\n'''knasigt'''\n#{{böjning|sv|adj|knasig}}"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      if (url.includes("sv.wiktionary.org") && url.includes("titles=knasig")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "602": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Adjektiv===\n'''knasig'''\n#lite tokig eller konstig\n*engelska: {{ö+|en|crazy}}, {{ö+|en|weird}}"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      if (url.includes("translate.googleapis.com")) {
        return createMockResponse({
          jsonData: [[["really weird", "jätteknasigt"]]]
        });
      }
      return createMockResponse({ jsonData: {} });
    };

    const enrichedWithWikiStem = await analyzeSwedishWord({
      word: "jätteknasigt",
      contextSentence: "Det blev jätteknasigt."
    });

    assertEqual(
      enrichedWithWikiStem.swedish.partOfSpeech,
      "adjective",
      "'jätteknasigt' after copular 'blev' MUST be recognized as an adjective, never a verb"
    );
    assertEqual(
      enrichedWithWikiStem.swedish.lemma,
      "jätteknasig",
      "Lemma MUST be 'jätteknasig' without 'att ' and without neuter '-t'"
    );
    assert(
      !enrichedWithWikiStem.swedish.lemma.startsWith("att "),
      "Adjective lemma MUST NEVER start with 'att '"
    );
    assertEqual(
      enrichedWithWikiStem.swedish.article,
      "",
      "Adjective must have empty article"
    );

    // 2. Test when Wiktionary has NO entry at all (e.g., unknown compound adjective 'megaknasigt' in 'Det blev megaknasigt')
    (globalThis as any).fetch = async (input: string | URL) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("sv.wiktionary.org")) {
        return createMockResponse({
          jsonData: { query: { pages: { "-1": { missing: "" } } } }
        });
      }
      if (url.includes("translate.googleapis.com")) {
        return createMockResponse({
          jsonData: [[["super weird", "megaknasigt"]]]
        });
      }
      return createMockResponse({ jsonData: {} });
    };

    const enrichedWithoutWiki = await analyzeSwedishWord({
      word: "megaknasigt",
      contextSentence: "Det blev megaknasigt."
    });

    assertEqual(
      enrichedWithoutWiki.swedish.partOfSpeech,
      "adjective",
      "'megaknasigt' must still be classified as 'adjective' even without Wiktionary"
    );
    assertEqual(
      enrichedWithoutWiki.swedish.lemma,
      "megaknasig",
      "Neuter '-igt' adjective should normalize to '-ig' without 'att '"
    );
  });

  await test("syntax & POS context analysis (inferSwedishPosFromContext) avoids false verb positives across Swedish clause structures", () => {
    // 1. Copular verbs ('är', 'var', 'blir', 'blev', 'känns', 'låter', 'verkar') never force a following word to be a verb
    assertEqual(
      inferSwedishPosFromContext("jätteknasigt", "Det blev jätteknasigt."),
      "",
      "Word after copular 'blev' must not be inferred as a verb"
    );
    assertEqual(
      inferSwedishPosFromContext("konstigt", "Det är inte konstigt."),
      "",
      "Word after copular 'är inte' must not be inferred as a verb"
    );
    assertEqual(
      inferSwedishPosFromContext("pallar", "Det är pallar."),
      "",
      "Noun after copular 'är' ('Those are stools') must not be inferred as a verb"
    );

    // 2. Main-clause sentence adverbs ('ofta', 'alltid', 'inte', 'redan') before object nouns must not infer 'verb'
    assertEqual(
      inferSwedishPosFromContext("kaffe", "Hon dricker ofta kaffe."),
      "",
      "Object noun 'kaffe' after 'ofta' must not be inferred as a verb"
    );
    assertEqual(
      inferSwedishPosFromContext("tid", "Jag har inte tid."),
      "",
      "Object noun 'tid' after 'inte' must not be inferred as a verb"
    );

    // 3. 'har' / 'hade' + plural noun (-ar/-er) vs supine verb (-at/-it/-t)
    assertEqual(
      inferSwedishPosFromContext("tankar", "Jag har tankar om det."),
      "noun",
      "'-ar' word after 'har' ('Jag har tankar') must be inferred as a plural noun, never a verb"
    );
    assertEqual(
      inferSwedishPosFromContext("pallat", "Jag har inte pallat det."),
      "verb",
      "Supine '-at' after 'har inte' ('Jag har inte pallat') should be inferred as a verb"
    );

    // 4. Prepositional 'om' ('handlar om stora tankar') vs subjunction 'om' ('ser om folk pallar')
    assertEqual(
      inferSwedishPosFromContext("tankar", "Det handlar om stora tankar."),
      "",
      "'tankar' in 'handlar om stora tankar' (prepositional 'om') must NOT be inferred as a verb"
    );
    assertEqual(
      inferSwedishPosFromContext("pallar", "Det är då man ser om folk pallar."),
      "verb",
      "'pallar' in 'ser om folk pallar' (subjunction 'om' + subject 'folk') MUST be inferred as a verb"
    );

    // 5. Relative clause after a noun ('Boken jag läste var bra') must not treat the head noun as a verb
    assertEqual(
      inferSwedishPosFromContext("Boken", "Boken jag läste var bra."),
      "",
      "Head noun 'Boken' before relative clause subject 'jag' must NOT be inferred as a verb"
    );

    // 6. Modals + infinitives and determiners/prepositions + nouns
    assertEqual(
      inferSwedishPosFromContext("palla", "Man måste kunna palla trycket."),
      "verb",
      "Infinitive after modal 'kunna' should be inferred as a verb"
    );
    assertEqual(
      inferSwedishPosFromContext("pallar", "Vi köpte tre pallar."),
      "noun",
      "Word after numeral 'tre' should be inferred as a noun"
    );
    assertEqual(
      inferSwedishPosFromContext("pallar", "Lådorna står på pallar."),
      "noun",
      "Word after preposition 'på' should be inferred as a noun"
    );

    // 7. Adjective morphology helpers
    assertEqual(hasSwedishAdjectiveMorphology("jätteknasigt"), true, "'jätteknasigt' has adjective morphology");
    assertEqual(hasSwedishAdjectiveMorphology("otroligt"), true, "'otroligt' has adjective morphology");
    assertEqual(hasSwedishAdjectiveMorphology("stiga"), false, "Verb 'stiga' must be excluded from -iga adjective check");
    assertEqual(normalizeSwedishAdjectiveLemma("jätteknasigt"), "jätteknasig", "Should strip neuter -t from 'jätteknasigt'");
    assertEqual(isVerbPartOfSpeech("verb", "jätteknasigt"), false, "isVerbPartOfSpeech must reject words with adjective morphology");
  });

  await test("recognizes 'skav' in '–och blev till ett större skav över natten–' as a noun ('ett skav') and NEVER as a verb ('att skava')", async () => {
    (globalThis as any).fetch = async (input: string | URL) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("sv.wiktionary.org") && url.includes("titles=skav")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "701": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Substantiv===\n{{sv-subst-t-0}}\n'''skav'''\n#det att något [[skava|skaver]]; [[skavsår]]\n*engelska: {{ö+|en|chafing}}, {{ö+|en|abrasion}}\n===Verb===\n'''skav'''\n#{{böjning|sv|verb|skava}}"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      if (url.includes("sv.wiktionary.org") && url.includes("titles=skava")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "702": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Verb===\n'''skava'''\n#gnida, nöta\n*engelska: {{ö+|en|chafe}}, {{ö+|en|rub}}"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      if (url.includes("translate.googleapis.com")) {
        return createMockResponse({
          jsonData: [
            [["chafing", "skav"]],
            [
              ["verb", ["chafe", "scrape", "rub"], [], "skav"],
              ["noun", ["chafing", "abrasion"], [], "skav"]
            ]
          ]
        });
      }
      return createMockResponse({ jsonData: {} });
    };

    const contextSentence = "–och blev till ett större skav över natten–";
    assertEqual(
      inferSwedishPosFromContext("skav", contextSentence),
      "noun",
      "'skav' in 'ett större skav över natten' (Det + Adj + Noun) MUST be inferred as a noun"
    );

    const enriched = await analyzeSwedishWord({
      word: "skav",
      contextSentence
    });

    assertEqual(
      enriched.swedish.partOfSpeech,
      "noun",
      "'skav' in '–och blev till ett större skav över natten–' MUST be recognized as a noun, never a verb"
    );
    assertEqual(
      enriched.swedish.lemma,
      "skav",
      "Lemma MUST be 'skav' (not 'att skava' or 'att skav')"
    );
    assertEqual(
      enriched.swedish.article,
      "ett",
      "Noun 'skav' should have neuter article 'ett'"
    );
    assertEqual(
      enriched.english.lemmaTranslation,
      "chafing, abrasion",
      "Should extract noun translation ('chafing, abrasion') rather than verb ('chafe, rub')"
    );
  });

  // ---------------------------------------------------------------------------
  // 5. Cloud Firestore Document Round-Trip & Storage Deduplication
  // ---------------------------------------------------------------------------
  console.log("\n5. Firestore Serialization & Local Deck Storage");

  await test("round-trips a VocabCard through cardToFirestoreDoc and firestoreDocToCard", () => {
    const card = createCardObject({
      sourceUrl: "https://www.svtplay.se/",
      sourceTitle: "SVT Play",
      swedish: {
        surfaceForm: "segrade",
        lemma: "att segra",
        article: "",
        partOfSpeech: "verb",
        inflections: "att segra, segrar, segrade, segrat",
        definitionSv: "vinna en seger",
        contextSentence: "De segrade i finalen."
      },
      english: {
        lemmaTranslation: "to win, triumph",
        contextualTranslation: "won",
        sentenceTranslation: "They won in the final."
      },
      media: {
        imageUrl: "https://tse1.mm.bing.net/th?id=OIP.segra_trophy",
        imageAlternatives: ["https://tse1.mm.bing.net/th?id=OIP.segra_trophy"],
        audioUrl: "https://upload.wikimedia.org/wikipedia/commons/Sv-segra.ogg",
        audioBase64: "data:audio/ogg;base64,T2dnUw==",
        audioSource: "Swedish Wiktionary (Native Human)"
      }
    });

    const firestoreDoc = cardToFirestoreDoc(card);
    const restored = firestoreDocToCard(firestoreDoc);

    assertEqual(restored.id, card.id, "Card ID should survive round-trip");
    assertEqual(restored.swedish.lemma, "att segra", "Verb lemma with 'att' should survive");
    assertEqual(
      restored.media.imageUrl,
      "https://tse1.mm.bing.net/th?id=OIP.segra_trophy",
      "Image URL should survive Firestore serialization"
    );
    assertEqual(
      restored.media.audioUrl,
      "https://upload.wikimedia.org/wikipedia/commons/Sv-segra.ogg",
      "Audio link URL should be saved"
    );
    assertEqual(
      restored.media.audioBase64,
      "",
      "Raw audioBase64 must NOT be saved in cards"
    );
    assertEqual(restored.fsrs.state, 0, "Initial FSRS state should be 0 (New)");

    const legacyCardWithAudio = {
      ...restored,
      media: {
        ...restored.media,
        audioUrl: "",
        audioBase64: "data:audio/ogg;base64,T2dnUw=="
      }
    };
    const cleaned = stripCardSavedAudio(legacyCardWithAudio);
    assertEqual(cleaned.modified, true, "Legacy card with audioBase64 should be marked modified");
    assertEqual(cleaned.card.media.audioBase64, "", "Cleaned card must have empty audioBase64");
    assert(
      cleaned.card.media.audioUrl.startsWith("https://"),
      "Cleaned card must have an https audioUrl link"
    );
  });

  await test("does NOT save a word for the second time (returns alreadyExisted: true and preserves original card)", async () => {
    const payload = {
      swedish: {
        surfaceForm: "segrade",
        lemma: "att segra",
        article: "",
        partOfSpeech: "verb",
        inflections: "",
        definitionSv: "",
        contextSentence: "Första meningen."
      },
      english: {
        lemmaTranslation: "win",
        contextualTranslation: "won",
        sentenceTranslation: "First sentence."
      },
      media: {
        imageUrl: "https://tse1.mm.bing.net/th?id=OIP.img1",
        imageAlternatives: ["https://tse1.mm.bing.net/th?id=OIP.img1"],
        audioUrl: "",
        audioBase64: "",
        audioSource: ""
      }
    };

    const firstSave = await saveCardToStorage(payload);
    assertEqual(firstSave.alreadyExisted, false, "First save should have alreadyExisted: false");

    const secondSave = await saveCardToStorage({
      ...payload,
      swedish: { ...payload.swedish, contextSentence: "Andra meningen." }
    });

    assertEqual(
      secondSave.alreadyExisted,
      true,
      "Second save of the same word MUST return alreadyExisted: true"
    );
    assertEqual(
      secondSave.card.id,
      firstSave.card.id,
      "Should return the original existing card ID"
    );
    const allCards = await getAllCards();
    const matching = allCards.filter((c) => c.swedish.lemma === "att segra");
    assertEqual(matching.length, 1, "Deck should contain1 card for 'att segra'");
    assertEqual(
      matching[0].swedish.contextSentence,
      "Första meningen.",
      "Original card must NOT be overwritten when a second save is attempted"
    );
  });

  await test("flags alreadySaved: true when user checks translation of a saved word again (including inflected forms)", async () => {
    (globalThis as any).fetch = async (input: string | URL) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("sv.wiktionary.org") && url.includes("titles=segrade")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "1": {
                  revisions: [{ "*": "==Svenska==\n===Verb===\n#{{böjning|sv|verb|segra}}" }]
                }
              }
            }
          }
        });
      }
      if (url.includes("sv.wiktionary.org") && url.includes("titles=segra")) {
        return createMockResponse({
          jsonData: {
            query: {
              pages: {
                "2": {
                  revisions: [
                    {
                      "*": "==Svenska==\n===Verb===\n'''segra'''\n# vinna en seger\n*engelska: {{ö+|en|win}}"
                    }
                  ]
                }
              }
            }
          }
        });
      }
      return createMockResponse({ jsonData: {} });
    };

    // "att segra" was saved in the previous test; now user checks "segrade" again
    const enriched = await analyzeSwedishWord({
      word: "segrade",
      contextSentence: "De segrade igen."
    });

    assertEqual(
      enriched.alreadySaved,
      true,
      "Looking up an inflected form ('segrade') of an already-saved word ('att segra') MUST set alreadySaved: true"
    );
    assert(
      Boolean(enriched.existingCardId),
      "Should include existingCardId of the saved card"
    );
  });

  // ---------------------------------------------------------------------------
  // 6. Previous Replica Seeking & Video Subtitle Navigation
  // ---------------------------------------------------------------------------
  console.log("\n6. Previous Replica Seeking (Subtitle Cue Navigation)");

  await test("restarts current replica with pre-roll when user is >1.5s into the replica", () => {
    const replicas = [
      { text: "Första repliken", startTime: 10.0 },
      { text: "Andra repliken", startTime: 15.0 }
    ];
    // User is at 18.0s (3s into the second replica)
    const result = computePreviousReplicaSeek(18.0, replicas);
    assertEqual(
      result.targetTime,
      14.8,
      "Should seek to second replica start (15.0) minus 0.2s safety pre-roll = 14.8s"
    );
    assertEqual(
      result.replicaLabel,
      "Andra repliken",
      "Should label with current replica text"
    );
  });

  await test("jumps to previous replica when user is <=1.5s into current replica (or rapid re-click)", () => {
    const replicas = [
      { text: "Första repliken", startTime: 10.0 },
      { text: "Andra repliken", startTime: 15.0 },
      { text: "Tredje repliken", startTime: 22.0 }
    ];
    // User is at 22.5s (only 0.5s into third replica)
    const result = computePreviousReplicaSeek(22.5, replicas);
    assertEqual(
      result.targetTime,
      14.8,
      "Should jump back to previous (second) replica start (15.0 - 0.2 = 14.8s)"
    );
    assertEqual(
      result.replicaLabel,
      "Andra repliken",
      "Should label with previous replica text"
    );
  });

  await test("jumps to latest prior replica during pauses/silence between dialogue lines", () => {
    const replicas = [
      { text: "Det är en fin dag.", startTime: 30.0 },
      { text: "Ja, verkligen.", startTime: 34.0 }
    ];
    // Video is at 41.0s (silence after second line ended at ~36s)
    const result = computePreviousReplicaSeek(41.0, replicas);
    assertEqual(
      result.targetTime,
      33.8,
      "Should jump to start of latest replica (34.0 - 0.2 = 33.8s)"
    );
    assertEqual(
      result.replicaLabel,
      "Ja, verkligen.",
      "Should label with latest replica text"
    );
  });

  await test("falls back to 4-second rewind if no replicas have been recorded yet", () => {
    const result = computePreviousReplicaSeek(12.5, []);
    assertEqual(
      result.targetTime,
      8.5,
      "Fallback should seek current time - 4 seconds"
    );
    assertEqual(
      result.replicaLabel,
      "-4s",
      "Should label with relative rewind offset"
    );
  });

  await test("supports native HTML5 textTracks cues when present", () => {
    const cues = [
      { startTime: 5.0, endTime: 8.0, text: "Hej och välkomna!" },
      { startTime: 9.0, endTime: 13.0, text: "Idag ska vi prata om språkinlärning." }
    ];
    // At 12.0s (> 1.2s into cue 2)
    const r1 = computePreviousReplicaSeek(12.0, [], cues);
    assertEqual(r1.targetTime, 8.8, "Restarts cue 2 at 8.8s (9.0 - 0.2s)");
    assertEqual(
      r1.replicaLabel,
      "Idag ska vi prata om språkinlärning.",
      "Should match cue 2 text"
    );

    // At 9.5s (<= 1.2s into cue 2)
    const r2 = computePreviousReplicaSeek(9.5, [], cues);
    assertEqual(r2.targetTime, 4.8, "Jumps back to cue 1 at 4.8s (5.0 - 0.2s)");
    assertEqual(
      r2.replicaLabel,
      "Hej och välkomna!",
      "Should match cue 1 text"
    );
  });

  // ---------------------------------------------------------------------------
  // 7. Audio Quota Cleanup, Cmd Multi-Word Deferral & TV4 Play Subtitle Parsing
  // ---------------------------------------------------------------------------
  console.log("\n7. Audio Storage Cleanup, Cmd Multi-Word Deferral & TV4 Play Subtitles");

  await test("never persists audioBase64 in saveCardToStorage and cleans up legacy saved audio", async () => {
    const savedRes = await saveCardToStorage({
      swedish: {
        surfaceForm: "böcker",
        lemma: "bok",
        article: "en",
        partOfSpeech: "noun",
        inflections: "en bok, boken, böcker, böckerna",
        definitionSv: "tryckt verk",
        contextSentence: "Jag läser böcker."
      },
      english: {
        lemmaTranslation: "book",
        contextualTranslation: "books",
        sentenceTranslation: "I read books."
      },
      media: {
        imageUrl: "https://tse1.mm.bing.net/th?id=OIP.bok",
        audioUrl: "https://upload.wikimedia.org/wikipedia/commons/Sv-bok.ogg",
        audioBase64: "data:audio/ogg;base64,VERY_LARGE_BASE64_PAYLOAD_THAT_MUST_BE_STRIPPED",
        audioSource: "Swedish Wiktionary"
      }
    });

    assertEqual(
      savedRes.card.media.audioBase64,
      "",
      "Saved card MUST have empty audioBase64 to prevent kQuotaBytes exceeded"
    );
    assertEqual(
      savedRes.card.media.audioUrl,
      "https://upload.wikimedia.org/wikipedia/commons/Sv-bok.ogg",
      "Saved card MUST retain the audioUrl link"
    );

    const fallbackUrl = buildFallbackAudioUrl("bok", "en");
    assert(
      fallbackUrl.includes("translate_tts") && fallbackUrl.includes("en%20bok"),
      "buildFallbackAudioUrl should construct a valid Swedish TTS URL with article"
    );

    const cleanedCount = await cleanupSavedAudioInStorage();
    assertEqual(
      cleanedCount,
      0,
      "Already-clean storage should report 0 cards needing cleanup"
    );
  });

  await test("defers translation lookup while Cmd/Ctrl is held during multi-word selection", () => {
    const sentence = "Om man jobbade där höll man oftast till på den sidan.";

    // 1. User holds Cmd (isMultiSelect = true) and clicks first word "höll"
    const step1 = updateSubtitleTokenSelection(
      [],
      { word: "höll", tokenIndex: 4, sentence },
      true
    );
    assertEqual(step1.deferLookup, true, "Lookup MUST be deferred while Cmd is held on first word");
    assertEqual(step1.combinedPhrase, "höll", "First token should be 'höll'");

    // 2. Still holding Cmd, user clicks "till" (even out of order or non-adjacent)
    const step2 = updateSubtitleTokenSelection(
      step1.tokens,
      { word: "till", tokenIndex: 7, sentence },
      true
    );
    assertEqual(step2.deferLookup, true, "Lookup MUST remain deferred while Cmd is held on second word");
    assertEqual(
      step2.combinedPhrase,
      "höll till",
      "Selected tokens should combine in sentence order into 'höll till'"
    );

    // 3. Clicking an already-selected word while holding Cmd toggles it off
    const step3 = updateSubtitleTokenSelection(
      step2.tokens,
      { word: "till", tokenIndex: 7, sentence },
      true
    );
    assertEqual(step3.combinedPhrase, "höll", "Clicking selected token with Cmd should deselect it");

    // 4. Plain click without Cmd immediately triggers lookup (deferLookup = false)
    const step4 = updateSubtitleTokenSelection(
      step2.tokens,
      { word: "jobbade", tokenIndex: 2, sentence },
      false
    );
    assertEqual(step4.deferLookup, false, "Click without Cmd should trigger lookup immediately");
    assertEqual(step4.combinedPhrase, "jobbade", "Click without Cmd should reset selection to clicked word");
  });

  await test("parses subtitle lines from both SVT Play and TV4 Play (#html-subtitles) markup", () => {
    // SVT Play style: separate leaf <span> elements
    const svtHtml = `
      <div data-rt="subtitles-container">
        <div><span>Vi ses imorgon</span></div>
        <div><span>klockan åtta.</span></div>
      </div>
    `;
    const svtLines = parseSubtitleLinesFromHtml(svtHtml);
    assertEqual(svtLines.length, 2, "SVT Play markup should produce 2 lines");
    assertEqual(svtLines[0], "Vi ses imorgon", "First SVT line should match");
    assertEqual(svtLines[1], "klockan åtta.", "Second SVT line should match");

    // TV4 Play (#html-subtitles) style with <br> and inline <i> tags inside a span
    const tv4BrHtml = `
      <div id="html-subtitles">
        <span><i>Första raden</i> i programmet<br/>och andra raden här.</span>
      </div>
    `;
    const tv4BrLines = parseSubtitleLinesFromHtml(tv4BrHtml);
    assertEqual(tv4BrLines.length, 2, "TV4 Play <br> markup should split into 2 lines");
    assertEqual(tv4BrLines[0], "Första raden i programmet", "First TV4 line should unwrap <i> and trim");
    assertEqual(tv4BrLines[1], "och andra raden här.", "Second TV4 line after <br> should match");

    // TV4 Play (#html-subtitles) style with <div> / <p> blocks and no spans
    const tv4DivHtml = `
      <div id="html-subtitles">
        <div>Det här är TV4 Play</div>
        <div>med svenska undertexter.</div>
      </div>
    `;
    const tv4DivLines = parseSubtitleLinesFromHtml(tv4DivHtml);
    assertEqual(tv4DivLines.length, 2, "TV4 Play block div markup should produce 2 lines");
    assertEqual(tv4DivLines[0], "Det här är TV4 Play", "First TV4 div line should match");
    assertEqual(tv4DivLines[1], "med svenska undertexter.", "Second TV4 div line should match");
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log(
    `\n========================================\nTests finished: ${passedTests} passed, ${failedTests} failed\n========================================\n`
  );
  if (failedTests > 0) {
    throw new Error(`${failedTests} test(s) failed.`);
  }
}

runTests();
