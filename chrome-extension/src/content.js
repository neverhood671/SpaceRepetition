/**
 * Content Script for SvenskaSpaced Chrome Extension
 * Uses Shadow DOM so webpage styles never conflict with the floating lookup card.
 */

(function () {
  if (window.__svenskaSpacedInjected) return;
  window.__svenskaSpacedInjected = true;

  let hostEl = null;
  let shadowRoot = null;
  let triggerBtn = null;
  let popoverEl = null;
  let currentSelectionData = null;
  let currentEnrichment = null;
  let currentImageIdx = 0;

  function initShadowHost() {
    if (hostEl) return;
    hostEl = document.createElement("div");
    hostEl.id = "svenska-spaced-extension-root";
    hostEl.style.cssText = "all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0;";
    document.documentElement.appendChild(hostEl);
    shadowRoot = hostEl.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      * {
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
      }
      .sv-trigger-pill {
        position: fixed;
        display: none;
        align-items: center;
        gap: 6px;
        background: #005B99;
        color: #ffffff;
        border: 2px solid #FECC02;
        border-radius: 999px;
        padding: 5px 12px;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
        user-select: none;
        transition: transform 0.12s ease, background 0.12s ease;
        z-index: 2147483647;
      }
      .sv-trigger-pill:hover {
        background: #004777;
        transform: translateY(-1px) scale(1.03);
      }
      .sv-popover {
        position: fixed;
        display: none;
        width: 350px;
        max-width: calc(100vw - 24px);
        background: #ffffff;
        color: #0f172a;
        border-radius: 16px;
        border: 1px solid #e2e8f0;
        box-shadow: 0 20px 40px rgba(15, 23, 42, 0.24), 0 0 0 1px rgba(15, 23, 42, 0.05);
        overflow: hidden;
        z-index: 2147483647;
        animation: svFadeIn 0.15s ease-out;
      }
      @keyframes svFadeIn {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .sv-header {
        background: linear-gradient(135deg, #005B99 0%, #003d66 100%);
        color: #ffffff;
        padding: 12px 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .sv-header-left {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .sv-badge {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        flex-shrink: 0;
      }
      .sv-badge-en {
        background: #38bdf8;
        color: #082f49;
      }
      .sv-badge-ett {
        background: #4ade80;
        color: #052e16;
      }
      .sv-badge-other {
        background: #FECC02;
        color: #1e293b;
      }
      .sv-word-title {
        font-size: 18px;
        font-weight: 700;
        color: #ffffff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sv-close-btn {
        background: rgba(255, 255, 255, 0.15);
        border: none;
        color: #ffffff;
        width: 26px;
        height: 26px;
        border-radius: 50%;
        cursor: pointer;
        font-size: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .sv-close-btn:hover {
        background: rgba(255, 255, 255, 0.28);
      }
      .sv-body {
        padding: 14px;
        max-height: 440px;
        overflow-y: auto;
      }
      .sv-loading {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 28px 16px;
        gap: 10px;
        color: #475569;
        font-size: 13px;
      }
      .sv-spinner {
        width: 26px;
        height: 26px;
        border: 3px solid #e2e8f0;
        border-top-color: #005B99;
        border-radius: 50%;
        animation: svSpin 0.7s linear infinite;
      }
      @keyframes svSpin {
        to { transform: rotate(360deg); }
      }
      .sv-row-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
      }
      .sv-translation-main {
        font-size: 17px;
        font-weight: 700;
        color: #0f172a;
      }
      .sv-sub-surface {
        font-size: 12px;
        color: #64748b;
        margin-top: 2px;
      }
      .sv-audio-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        background: #f1f5f9;
        border: 1px solid #cbd5e1;
        color: #0f172a;
        padding: 6px 10px;
        border-radius: 10px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        flex-shrink: 0;
        transition: all 0.12s ease;
      }
      .sv-audio-btn:hover {
        background: #e2e8f0;
      }
      .sv-image-wrap {
        position: relative;
        width: 100%;
        height: 155px;
        background: #f8fafc;
        border-radius: 12px;
        overflow: hidden;
        border: 1px solid #e2e8f0;
        margin-bottom: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .sv-image-wrap img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .sv-next-img-btn {
        position: absolute;
        bottom: 8px;
        right: 8px;
        background: rgba(15, 23, 42, 0.78);
        color: #ffffff;
        border: none;
        border-radius: 8px;
        padding: 4px 8px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        backdrop-filter: blur(4px);
      }
      .sv-next-img-btn:hover {
        background: rgba(15, 23, 42, 0.92);
      }
      .sv-meta-tag {
        font-size: 11px;
        color: #475569;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 6px 9px;
        margin-bottom: 8px;
      }
      .sv-context-box {
        background: #f8fafc;
        border-left: 3px solid #005B99;
        padding: 8px 10px;
        border-radius: 0 8px 8px 0;
        font-size: 12px;
        color: #334155;
        margin-bottom: 12px;
      }
      .sv-context-sv {
        font-style: italic;
        margin-bottom: 4px;
        color: #0f172a;
      }
      .sv-context-en {
        color: #64748b;
      }
      .sv-save-btn {
        width: 100%;
        background: #005B99;
        color: #ffffff;
        border: none;
        border-radius: 10px;
        padding: 10px 14px;
        font-size: 13.5px;
        font-weight: 700;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        transition: background 0.15s ease;
      }
      .sv-save-btn:hover {
        background: #004677;
      }
      .sv-save-btn.saved {
        background: #16a34a;
        cursor: default;
      }
      .sv-source-pill {
        font-size: 10.5px;
        color: #64748b;
        text-align: center;
        margin-top: 6px;
      }
    `;
    shadowRoot.appendChild(style);

    triggerBtn = document.createElement("button");
    triggerBtn.className = "sv-trigger-pill";
    triggerBtn.innerHTML = `<span>🇸🇪</span><span>Translate & Save</span>`;
    triggerBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (currentSelectionData) {
        openLookupPopover(currentSelectionData);
      }
    });
    shadowRoot.appendChild(triggerBtn);

    popoverEl = document.createElement("div");
    popoverEl.className = "sv-popover";
    popoverEl.addEventListener("mousedown", (e) => e.stopPropagation());
    shadowRoot.appendChild(popoverEl);
  }

  /**
   * Extract the sentence surrounding the user's text selection
   */
  function extractContextSentence(selection) {
    try {
      if (!selection || selection.rangeCount === 0) return "";
      const range = selection.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const blockText = (
        container.nodeType === Node.TEXT_NODE
          ? container.parentElement?.innerText || container.textContent
          : container.innerText || container.textContent
      ) || "";

      const selectedWord = selection.toString().trim();
      const cleanBlock = blockText.replace(/\s+/g, " ").trim();
      if (!cleanBlock) return selectedWord;

      // Split into sentences and find the one containing the selected word
      const sentences = cleanBlock.split(/(?<=[.!?])\s+/);
      const found = sentences.find((s) =>
        s.toLowerCase().includes(selectedWord.toLowerCase())
      );
      return (found || cleanBlock).slice(0, 220);
    } catch {
      return selection?.toString()?.trim() || "";
    }
  }

  function hideAll() {
    if (triggerBtn) triggerBtn.style.display = "none";
    if (popoverEl) popoverEl.style.display = "none";
  }

  function positionElementNearRect(el, rect, width = 350, height = 380) {
    const margin = 10;
    let left = Math.min(
      Math.max(margin, rect.left),
      window.innerWidth - width - margin
    );
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - margin && rect.top > height + margin) {
      top = rect.top - height - 8;
    }
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(Math.max(margin, top))}px`;
  }

  function playPronunciation(media) {
    const src = media?.audioBase64 || media?.audioUrl;
    if (!src) return;
    const audio = new Audio(src);
    audio.play().catch((err) => {
      console.warn("Audio playback fallback:", err);
      // Browser speechSynthesis fallback if remote stream is blocked
      if ("speechSynthesis" in window && currentEnrichment?.swedish?.lemma) {
        const utter = new SpeechSynthesisUtterance(
          currentEnrichment.swedish.article
            ? `${currentEnrichment.swedish.article} ${currentEnrichment.swedish.lemma}`
            : currentEnrichment.swedish.lemma
        );
        utter.lang = "sv-SE";
        window.speechSynthesis.speak(utter);
      }
    });
  }

  function openLookupPopover(selData) {
    initShadowHost();
    triggerBtn.style.display = "none";
    popoverEl.style.display = "block";
    positionElementNearRect(popoverEl, selData.rect, 350, 260);

    popoverEl.innerHTML = `
      <div class="sv-header">
        <div class="sv-header-left">
          <span class="sv-badge sv-badge-other">🇸🇪 SV</span>
          <span class="sv-word-title">${escapeHtml(selData.word)}</span>
        </div>
        <button class="sv-close-btn" id="sv-close">✕</button>
      </div>
      <div class="sv-body">
        <div class="sv-loading">
          <div class="sv-spinner"></div>
          <div>Querying Swedish dictionary & Google Images…</div>
        </div>
      </div>
    `;
    popoverEl.querySelector("#sv-close")?.addEventListener("click", hideAll);

    chrome.runtime.sendMessage(
      {
        type: "ANALYZE_WORD",
        payload: {
          word: selData.word,
          contextSentence: selData.contextSentence,
          sourceUrl: window.location.href,
          sourceTitle: document.title
        }
      },
      (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          renderError(response?.error || chrome.runtime.lastError?.message || "Failed to look up word");
          return;
        }
        currentEnrichment = response.data;
        currentImageIdx = 0;
        renderEnrichedCard(currentEnrichment, selData.rect);
      }
    );
  }

  function renderError(msg) {
    const body = popoverEl.querySelector(".sv-body");
    if (!body) return;
    body.innerHTML = `
      <div style="color:#dc2626; font-size:13px; padding:12px;">
        Could not enrich word: ${escapeHtml(msg)}
      </div>
    `;
  }

  function renderEnrichedCard(data, rect) {
    const sw = data.swedish || {};
    const en = data.english || {};
    const media = data.media || {};
    const alternatives = media.imageAlternatives || (media.imageUrl ? [media.imageUrl] : []);

    const badgeClass =
      sw.article === "en"
        ? "sv-badge-en"
        : sw.article === "ett"
        ? "sv-badge-ett"
        : "sv-badge-other";
    const badgeLabel = sw.article || sw.partOfSpeech || "SV";
    const fullLemma = sw.article ? `${sw.article} ${sw.lemma}` : sw.lemma;

    popoverEl.innerHTML = `
      <div class="sv-header">
        <div class="sv-header-left">
          <span class="sv-badge ${badgeClass}">${escapeHtml(badgeLabel)}</span>
          <span class="sv-word-title">${escapeHtml(fullLemma)}</span>
        </div>
        <button class="sv-close-btn" id="sv-close">✕</button>
      </div>
      <div class="sv-body">
        <div class="sv-row-top">
          <div>
            <div class="sv-translation-main">${escapeHtml(
              en.lemmaTranslation || en.contextualTranslation || "—"
            )}</div>
            ${
              sw.surfaceForm.toLowerCase() !== sw.lemma.toLowerCase()
                ? `<div class="sv-sub-surface">On page: <b>${escapeHtml(
                    sw.surfaceForm
                  )}</b> (${escapeHtml(en.contextualTranslation)})</div>`
                : ""
            }
          </div>
          <button class="sv-audio-btn" id="sv-play-audio" title="Play Swedish pronunciation">
            <span>🔊</span><span>Listen</span>
          </button>
        </div>

        ${
          alternatives.length > 0
            ? `
          <div class="sv-image-wrap">
            <img id="sv-card-img" src="${escapeHtml(alternatives[0])}" alt="${escapeHtml(sw.lemma)}" />
            ${
              alternatives.length > 1
                ? `<button class="sv-next-img-btn" id="sv-next-img">↻ Image 1/${alternatives.length}</button>`
                : ""
            }
          </div>
        `
            : ""
        }

        ${
          sw.inflections
            ? `<div class="sv-meta-tag"><b>Forms:</b> ${escapeHtml(sw.inflections)}</div>`
            : ""
        }
        ${
          sw.definitionSv
            ? `<div class="sv-meta-tag"><b>Ordbok:</b> ${escapeHtml(sw.definitionSv)}</div>`
            : ""
        }

        ${
          sw.contextSentence
            ? `
          <div class="sv-context-box">
            <div class="sv-context-sv">”${escapeHtml(sw.contextSentence)}”</div>
            ${
              en.sentenceTranslation
                ? `<div class="sv-context-en">${escapeHtml(en.sentenceTranslation)}</div>`
                : ""
            }
          </div>
        `
            : ""
        }

        <button class="sv-save-btn" id="sv-save-card">
          <span>💾</span><span>Save to Cloud Deck</span>
        </button>
        <div class="sv-source-pill">🎙️ Audio: ${escapeHtml(media.audioSource || "Swedish Dictionary")}</div>
      </div>
    `;

    positionElementNearRect(popoverEl, rect, 350, 420);

    popoverEl.querySelector("#sv-close")?.addEventListener("click", hideAll);
    popoverEl.querySelector("#sv-play-audio")?.addEventListener("click", () => {
      playPronunciation(media);
    });

    const nextImgBtn = popoverEl.querySelector("#sv-next-img");
    const imgEl = popoverEl.querySelector("#sv-card-img");
    if (nextImgBtn && imgEl && alternatives.length > 1) {
      nextImgBtn.addEventListener("click", () => {
        currentImageIdx = (currentImageIdx + 1) % alternatives.length;
        const chosen = alternatives[currentImageIdx];
        imgEl.src = chosen;
        currentEnrichment.media.imageUrl = chosen;
        nextImgBtn.textContent = `↻ Image ${currentImageIdx + 1}/${alternatives.length}`;
      });
    }

    const saveBtn = popoverEl.querySelector("#sv-save-card");
    saveBtn?.addEventListener("click", () => {
      if (saveBtn.classList.contains("saved")) return;
      saveBtn.textContent = "Saving…";
      chrome.runtime.sendMessage(
        {
          type: "SAVE_CARD",
          payload: currentEnrichment
        },
        (res) => {
          if (res?.ok) {
            saveBtn.classList.add("saved");
            const synced = res.data?.cloudSynced;
            saveBtn.innerHTML = synced
              ? "<span>✓</span><span>Saved to Cloud Firestore!</span>"
              : "<span>✓</span><span>Saved to Deck (Local)</span>";
          } else {
            saveBtn.textContent = "⚠️ Retry Save";
          }
        }
      );
    });

    // Auto-play pronunciation upon lookup
    playPronunciation(media);
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Listen for text selection on any webpage
  document.addEventListener("mouseup", (e) => {
    setTimeout(() => {
      const sel = window.getSelection();
      const rawText = sel ? sel.toString().trim() : "";

      // Ignore empty selections or long paragraphs (>45 chars or >4 words)
      if (!rawText || rawText.length > 45 || rawText.split(/\s+/).length > 4) {
        if (triggerBtn && (!popoverEl || popoverEl.style.display === "none")) {
          triggerBtn.style.display = "none";
        }
        return;
      }

      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      initShadowHost();
      currentSelectionData = {
        word: rawText,
        contextSentence: extractContextSentence(sel),
        rect: {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right
        }
      };

      // If user held Alt while selecting, open the full card immediately
      if (e.altKey) {
        openLookupPopover(currentSelectionData);
        return;
      }

      // Otherwise show the small floating "🇸🇪 Translate & Save" pill
      triggerBtn.style.display = "inline-flex";
      positionElementNearRect(triggerBtn, currentSelectionData.rect, 150, 36);
    }, 15);
  });

  // Hide trigger pill when clicking elsewhere
  document.addEventListener("mousedown", () => {
    if (triggerBtn) triggerBtn.style.display = "none";
    if (popoverEl && popoverEl.style.display === "block") {
      popoverEl.style.display = "none";
    }
  });

  // Listen for right-click context menu trigger
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "TRIGGER_SELECTION_LOOKUP") {
      const sel = window.getSelection();
      const rect =
        sel && sel.rangeCount > 0
          ? sel.getRangeAt(0).getBoundingClientRect()
          : { top: 80, bottom: 100, left: window.innerWidth / 2 - 175, right: window.innerWidth / 2 };

      currentSelectionData = {
        word: msg.selectionText || sel?.toString()?.trim() || "",
        contextSentence: extractContextSentence(sel),
        rect
      };
      if (currentSelectionData.word) {
        openLookupPopover(currentSelectionData);
      }
    }
  });
})();
