import type {
  EnrichmentPayload,
  ExtensionResponse,
  ExtensionSettings,
  SaveCardResult,
  VocabCard
} from "./types.js";

const tabButtons = document.querySelectorAll<HTMLButtonElement>(".tab-btn");
const sections: Record<string, HTMLElement | null> = {
  deck: document.getElementById("tab-deck"),
  lookup: document.getElementById("tab-lookup"),
  settings: document.getElementById("tab-settings")
};

const wordListEl = document.getElementById("word-list") as HTMLElement;
const deckCountEl = document.getElementById("deck-count") as HTMLElement;
const cloudStatusEl = document.getElementById("cloud-status") as HTMLElement;

const quickInput = document.getElementById(
  "quick-word-input"
) as HTMLInputElement;
const quickSearchBtn = document.getElementById(
  "quick-search-btn"
) as HTMLButtonElement;
const quickResultEl = document.getElementById("quick-result") as HTMLElement;

const cfgProjectId = document.getElementById(
  "cfg-project-id"
) as HTMLInputElement;
const cfgFirebaseKey = document.getElementById(
  "cfg-firebase-key"
) as HTMLInputElement;
const cfgGeminiKey = document.getElementById(
  "cfg-gemini-key"
) as HTMLInputElement;
const saveSettingsBtn = document.getElementById(
  "save-settings-btn"
) as HTMLButtonElement;
const syncCloudBtn = document.getElementById(
  "sync-cloud-btn"
) as HTMLButtonElement;
const settingsStatus = document.getElementById(
  "settings-status"
) as HTMLElement;

function switchTab(tabName: string | undefined): void {
  if (!tabName) return;
  tabButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  Object.entries(sections).forEach(([k, el]) => {
    if (el) el.style.display = k === tabName ? "block" : "none";
  });
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function escapeHtml(str: string | undefined): string {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function playCardAudio(card: VocabCard | EnrichmentPayload): void {
  const src = card?.media?.audioBase64 || card?.media?.audioUrl;
  if (src) {
    const audio = new Audio(src);
    audio.play().catch(() => {});
  } else if ("speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance(
      card?.swedish?.article
        ? `${card.swedish.article} ${card.swedish.lemma}`
        : card?.swedish?.lemma || ""
    );
    u.lang = "sv-SE";
    window.speechSynthesis.speak(u);
  }
}

function loadDeck(): void {
  chrome.runtime.sendMessage(
    { type: "GET_CARDS" },
    (res: ExtensionResponse<VocabCard[]>) => {
      const cards = res?.data || [];
      deckCountEl.textContent = String(cards.length);

      if (cards.length === 0) {
        wordListEl.innerHTML = `
        <div class="empty-state">
          <b>Your Swedish deck is empty!</b><br/><br/>
          Highlight any Swedish word on a webpage (or click subtitles on <i>svtplay.se</i>) and click <b>🇸🇪 Translate & Save</b>, or use the <b>+ Quick Add</b> tab.
        </div>
      `;
        return;
      }

      wordListEl.innerHTML = cards
        .map((c) => {
          const sw = c.swedish;
          const en = c.english;
          const badgeCls =
            sw.article === "en"
              ? "badge-en"
              : sw.article === "ett"
              ? "badge-ett"
              : "badge-other";
          const badgeTxt = sw.article || sw.partOfSpeech || "SV";
          const imgUrl = c.media?.imageUrl || "";

          return `
          <div class="word-item" data-id="${escapeHtml(c.id)}">
            ${
              imgUrl
                ? `<img class="word-thumb" src="${escapeHtml(imgUrl)}" alt="" />`
                : `<div class="word-thumb" style="display:flex;align-items:center;justify-content:center;font-size:20px;">🇸🇪</div>`
            }
            <div class="word-info">
              <div class="word-sv">
                <span class="badge ${badgeCls}">${escapeHtml(badgeTxt)}</span>
                <span>${escapeHtml(sw.lemma)}</span>
              </div>
              <div class="word-en">${escapeHtml(
                en.lemmaTranslation || en.contextualTranslation
              )}</div>
            </div>
            <div class="word-actions">
              <button class="icon-btn play-btn" data-id="${escapeHtml(
                c.id
              )}" title="Play Swedish audio">🔊</button>
              <button class="icon-btn del-btn" data-id="${escapeHtml(
                c.id
              )}" title="Delete card">🗑️</button>
            </div>
          </div>
        `;
        })
        .join("");

      wordListEl.querySelectorAll<HTMLButtonElement>(".play-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const card = cards.find((c) => c.id === btn.dataset.id);
          if (card) playCardAudio(card);
        });
      });

      wordListEl.querySelectorAll<HTMLButtonElement>(".del-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          chrome.runtime.sendMessage(
            { type: "DELETE_CARD", cardId: btn.dataset.id },
            () => loadDeck()
          );
        });
      });
    }
  );
}

function loadSettings(): void {
  chrome.runtime.sendMessage(
    { type: "GET_SETTINGS" },
    (res: ExtensionResponse<ExtensionSettings>) => {
      const s = res?.data;
      cfgProjectId.value = s?.firebaseProjectId || "";
      cfgFirebaseKey.value = s?.firebaseApiKey || "";
      cfgGeminiKey.value = s?.geminiApiKey || "";

      if (s?.firebaseProjectId && s.firebaseProjectId.trim()) {
        cloudStatusEl.textContent = `☁️ ${s.firebaseProjectId.trim()}`;
        cloudStatusEl.style.background = "rgba(74, 222, 128, 0.25)";
      } else {
        cloudStatusEl.textContent = "Local Mode";
        cloudStatusEl.style.background = "rgba(255, 255, 255, 0.16)";
      }
    }
  );
}

function showStatus(msg: string, isError = false): void {
  settingsStatus.style.display = "block";
  settingsStatus.style.background = isError ? "#fee2e2" : "#dcfce7";
  settingsStatus.style.color = isError ? "#991b1b" : "#166534";
  settingsStatus.textContent = msg;
}

saveSettingsBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage(
    {
      type: "SAVE_SETTINGS",
      payload: {
        firebaseProjectId: cfgProjectId.value.trim(),
        firebaseApiKey: cfgFirebaseKey.value.trim(),
        geminiApiKey: cfgGeminiKey.value.trim()
      }
    },
    (res: ExtensionResponse<ExtensionSettings>) => {
      if (res?.ok) {
        loadSettings();
        showStatus("✓ Settings saved! Future cards will sync with Firestore.");
      } else {
        showStatus(res?.error || "Failed to save settings", true);
      }
    }
  );
});

syncCloudBtn.addEventListener("click", () => {
  syncCloudBtn.textContent = "Syncing to Firestore…";
  chrome.runtime.sendMessage(
    { type: "SYNC_ALL" },
    (res: ExtensionResponse) => {
      syncCloudBtn.textContent = "☁️ Sync All Local Words to Firestore";
      if (res?.ok) {
        showStatus(`✓ Synced ${res.count || 0} card(s) to Cloud Firestore!`);
        loadDeck();
      } else {
        showStatus(
          res?.error || "Sync failed. Check Project ID & Firestore Rules.",
          true
        );
      }
    }
  );
});

function runQuickLookup(): void {
  const word = quickInput.value.trim();
  if (!word) return;
  quickResultEl.innerHTML = `<div class="empty-state">Querying Swedish dictionary & Google Images for <b>${escapeHtml(
    word
  )}</b>…</div>`;

  chrome.runtime.sendMessage(
    {
      type: "ANALYZE_WORD",
      payload: {
        word,
        contextSentence: word,
        sourceUrl: "chrome-extension://popup",
        sourceTitle: "Manual Lookup"
      }
    },
    (res: ExtensionResponse<EnrichmentPayload>) => {
      if (!res?.ok || !res.data) {
        quickResultEl.innerHTML = `<div class="empty-state" style="color:#dc2626;">Error: ${escapeHtml(
          res?.error || "Lookup failed"
        )}</div>`;
        return;
      }
      const d = res.data;
      const sw = d.swedish;
      const en = d.english;
      const media = d.media;
      const fullLemma = sw.article ? `${sw.article} ${sw.lemma}` : sw.lemma;

      quickResultEl.innerHTML = `
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <div>
              <div style="font-size:17px;font-weight:800;color:#005B99;">${escapeHtml(
                fullLemma
              )}</div>
              <div style="font-size:14px;font-weight:600;color:#0f172a;">${escapeHtml(
                en.lemmaTranslation || en.contextualTranslation
              )}</div>
            </div>
            <button class="icon-btn" id="q-play" title="Play pronunciation">🔊</button>
          </div>
          ${
            media.imageUrl
              ? `<img src="${escapeHtml(
                  media.imageUrl
                )}" style="width:100%;height:140px;object-fit:cover;border-radius:8px;margin-bottom:8px;" />`
              : ""
          }
          ${
            sw.definitionSv
              ? `<div style="font-size:11.5px;color:#475569;margin-bottom:8px;"><b>Ordbok:</b> ${escapeHtml(
                  sw.definitionSv
                )}</div>`
              : ""
          }
          <button class="btn-primary" id="q-save" style="width:100%;">💾 Save to Cloud Deck</button>
          <div style="font-size:10.5px;color:#64748b;text-align:center;margin-top:6px;">🎙️ ${escapeHtml(
            media.audioSource
          )}</div>
        </div>
      `;

      document.getElementById("q-play")?.addEventListener("click", () => {
        playCardAudio(d);
      });
      playCardAudio(d);

      const qSave = document.getElementById(
        "q-save"
      ) as HTMLButtonElement | null;
      qSave?.addEventListener("click", () => {
        qSave.textContent = "Saving…";
        chrome.runtime.sendMessage(
          { type: "SAVE_CARD", payload: d },
          (saveRes: ExtensionResponse<SaveCardResult>) => {
            if (saveRes?.ok) {
              qSave.style.background = "#16a34a";
              qSave.textContent = saveRes.data?.cloudSynced
                ? "✓ Saved to Cloud Firestore!"
                : "✓ Saved to Local Deck!";
              loadDeck();
            }
          }
        );
      });
    }
  );
}

quickSearchBtn.addEventListener("click", runQuickLookup);
quickInput.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter") runQuickLookup();
});

loadSettings();
loadDeck();
