import {
  cleanWord,
  parseWiktionarySection,
  querySwedishWiktionary,
  extractImagesFromHtml,
  fetchGoogleImages,
  fetchImageAsBase64,
  analyzeSwedishWord,
  isVerbPartOfSpeech,
  isAdverbPartOfSpeech
} from "../background.js";
import {
  createCardObject,
  cardToFirestoreDoc,
  firestoreDocToCard,
  saveCardToStorage,
  getAllCards
} from "../firestore.js";

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
    assertEqual(restored.fsrs.state, 0, "Initial FSRS state should be 0 (New)");
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
