type CardMediaInfo = import("./types.js").CardMediaInfo;
type EnrichmentPayload = import("./types.js").EnrichmentPayload;
type ExtensionResponse<T = unknown> = import("./types.js").ExtensionResponse<T>;
type SaveCardResult = import("./types.js").SaveCardResult;

/**
 * Content Script for SvenskaSpaced Chrome Extension (TypeScript)
 * Features:
 * 1. Universal webpage Swedish word selection -> Floating Dictionary + Google Image + Audio Card
 * 2. Dedicated SVT Play (svtplay.se) Interactive Subtitle Overlay:
 *    - Watches [data-rt="subtitles-container"] via MutationObserver
 *    - Renders high-z-index clickable word chips on top of the video player
 *    - Supports ⌘+Click (or Ctrl+Click) multi-word selection for Swedish partikelverb
 *    - Auto-pauses video[data-rt="video-player"] on subtitle hover & auto-resumes on leave/close
 *    - Fullscreen-aware mounting
 */

interface BoundingRectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width?: number;
}

interface SelectionLookupData {
  word: string;
  contextSentence: string;
  rect: BoundingRectLike;
}

interface SelectedSubtitleToken {
  word: string;
  tokenIndex: number;
  sentence: string;
  el: HTMLElement;
}

(function () {
  if (window.__svenskaSpacedInjected) return;
  window.__svenskaSpacedInjected = true;

  let hostEl: HTMLDivElement | null = null;
  let shadowRoot: ShadowRoot | null = null;
  let triggerBtn: HTMLButtonElement | null = null;
  let popoverEl: HTMLDivElement | null = null;

  // SVT Play Subtitle Overlay state
  let subOverlayWrap: HTMLDivElement | null = null;
  let subLinesEl: HTMLDivElement | null = null;
  let observedSubContainer: HTMLElement | null = null;
  let subMutationObserver: MutationObserver | null = null;
  let autoPausedVideo: HTMLVideoElement | null = null;
  let isCardOpen = false;
  let selectedSubtitleTokens: SelectedSubtitleToken[] = [];

  let currentSelectionData: SelectionLookupData | null = null;
  let currentEnrichment: EnrichmentPayload | null = null;
  let currentImageIdx = 0;

  function initShadowHost(): void {
    const targetParent =
      (document.fullscreenElement as HTMLElement | null) ||
      document.documentElement;
    if (hostEl) {
      if (hostEl.parentElement !== targetParent) {
        targetParent.appendChild(hostEl);
      }
      return;
    }

    hostEl = document.createElement("div");
    hostEl.id = "svenska-spaced-extension-root";
    hostEl.style.cssText =
      "all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0; pointer-events: none;";
    targetParent.appendChild(hostEl);
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
        pointer-events: auto;
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
        width: 355px;
        max-width: calc(100vw - 24px);
        background: #ffffff;
        color: #0f172a;
        border-radius: 16px;
        border: 1px solid #e2e8f0;
        box-shadow: 0 20px 45px rgba(15, 23, 42, 0.35), 0 0 0 1px rgba(15, 23, 42, 0.08);
        overflow: hidden;
        pointer-events: auto;
        z-index: 2147483647;
        animation: svFadeIn 0.14s ease-out;
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

      /* =====================================================
         SVT PLAY INTERACTIVE SUBTITLE OVERLAY STYLES
         ===================================================== */
      .sv-sub-overlay-wrap {
        position: fixed;
        display: none;
        flex-direction: column;
        align-items: center;
        pointer-events: none;
        z-index: 2147483646;
        transition: opacity 0.15s ease;
      }
      .sv-sub-bar {
        pointer-events: auto;
        background: rgba(10, 15, 28, 0.86);
        backdrop-filter: blur(6px);
        border: 1.5px solid rgba(255, 255, 255, 0.18);
        border-radius: 14px;
        padding: 8px 16px;
        display: flex;
        align-items: center;
        gap: 10px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
        max-width: 92%;
        user-select: text;
      }
      .sv-sub-bar:hover {
        border-color: #FECC02;
        background: rgba(10, 15, 28, 0.94);
      }
      .sv-sub-lines {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        text-align: center;
      }
      .sv-sub-line {
        font-size: clamp(16px, 2.1vw, 24px);
        line-height: 1.35;
        font-weight: 600;
        color: #ffffff;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
      }
      .sv-sub-word {
        display: inline-block;
        padding: 1px 4px;
        margin: 0 1px;
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.1s ease, color 0.1s ease, transform 0.1s ease;
      }
      .sv-sub-word:hover {
        background: rgba(254, 204, 2, 0.85);
        color: #0f172a;
        text-shadow: none;
        transform: translateY(-1px);
      }
      .sv-sub-word.selected {
        background: #FECC02;
        color: #0f172a;
        text-shadow: none;
        box-shadow: 0 0 0 2px #005B99;
      }
    `;
    shadowRoot.appendChild(style);

    // 1. Standard Selection Trigger Pill
    triggerBtn = document.createElement("button");
    triggerBtn.className = "sv-trigger-pill";
    triggerBtn.innerHTML = `<span>🇸🇪</span><span>Translate & Save</span>`;
    triggerBtn.addEventListener("mousedown", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (currentSelectionData) {
        openLookupPopover(currentSelectionData);
      }
    });
    shadowRoot.appendChild(triggerBtn);

    // 2. SVT Play Interactive Subtitle Overlay
    subOverlayWrap = document.createElement("div");
    subOverlayWrap.className = "sv-sub-overlay-wrap";
    subOverlayWrap.innerHTML = `
      <div class="sv-sub-bar" id="sv-sub-bar">
        <div class="sv-sub-lines" id="sv-sub-lines"></div>
      </div>
    `;

    ["mousedown", "mouseup", "click", "dblclick", "pointerdown"].forEach(
      (evtName) => {
        subOverlayWrap?.addEventListener(evtName, (e: Event) => {
          e.stopPropagation();
        });
      }
    );

    const subBar = subOverlayWrap.querySelector(
      "#sv-sub-bar"
    ) as HTMLDivElement | null;
    subLinesEl = subOverlayWrap.querySelector(
      "#sv-sub-lines"
    ) as HTMLDivElement | null;

    subBar?.addEventListener("mouseenter", () => {
      pauseVideoIfPlaying();
    });

    subBar?.addEventListener("mouseleave", () => {
      if (!isCardOpen) {
        resumeVideoIfAutoPaused();
      }
    });

    shadowRoot.appendChild(subOverlayWrap);

    // 3. Dictionary Lookup Card Popover
    popoverEl = document.createElement("div");
    popoverEl.className = "sv-popover";
    ["mousedown", "mouseup", "click", "dblclick"].forEach((evtName) => {
      popoverEl?.addEventListener(evtName, (e: Event) => e.stopPropagation());
    });
    shadowRoot.appendChild(popoverEl);
  }

  document.addEventListener("fullscreenchange", () => {
    initShadowHost();
    updateSubtitleOverlayPosition();
  });

  function getVideoElement(): HTMLVideoElement | null {
    return (
      document.querySelector<HTMLVideoElement>('video[data-rt="video-player"]') ||
      document.querySelector<HTMLVideoElement>("video")
    );
  }

  function pauseVideoIfPlaying(): void {
    const video = getVideoElement();
    if (video && !video.paused) {
      video.pause();
      autoPausedVideo = video;
    }
  }

  function resumeVideoIfAutoPaused(): void {
    if (autoPausedVideo && autoPausedVideo.paused) {
      autoPausedVideo.play().catch(() => {});
    }
    autoPausedVideo = null;
  }

  function clearSelectedSubtitleTokens(): void {
    for (const t of selectedSubtitleTokens) {
      t.el?.classList?.remove("selected");
    }
    selectedSubtitleTokens = [];
  }

  function handleSubtitleWordClick(
    e: MouseEvent,
    word: string,
    tokenIndex: number,
    fullSentence: string,
    wordSpan: HTMLElement
  ): void {
    e.preventDefault();
    e.stopPropagation();
    pauseVideoIfPlaying();

    const isMultiSelect = e.metaKey || e.ctrlKey;

    if (
      !isMultiSelect ||
      (selectedSubtitleTokens.length > 0 &&
        selectedSubtitleTokens[0].sentence !== fullSentence)
    ) {
      clearSelectedSubtitleTokens();
      selectedSubtitleTokens = [
        { word, tokenIndex, sentence: fullSentence, el: wordSpan }
      ];
      wordSpan.classList.add("selected");
    } else {
      const existingIdx = selectedSubtitleTokens.findIndex(
        (t) => t.tokenIndex === tokenIndex
      );
      if (existingIdx >= 0 && selectedSubtitleTokens.length > 1) {
        selectedSubtitleTokens[existingIdx].el?.classList?.remove("selected");
        selectedSubtitleTokens.splice(existingIdx, 1);
      } else if (existingIdx === -1) {
        selectedSubtitleTokens.push({
          word,
          tokenIndex,
          sentence: fullSentence,
          el: wordSpan
        });
        wordSpan.classList.add("selected");
      }
      selectedSubtitleTokens.sort((a, b) => a.tokenIndex - b.tokenIndex);
    }

    const combinedPhrase = selectedSubtitleTokens.map((t) => t.word).join(" ");
    const rect = wordSpan.getBoundingClientRect();
    openLookupPopover({
      word: combinedPhrase,
      contextSentence: fullSentence,
      rect: {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width
      }
    });
  }

  function renderTokenizedLine(
    lineText: string,
    fullSentence: string,
    startTokenIndex = 0
  ): { lineDiv: HTMLDivElement; nextTokenIndex: number } {
    const lineDiv = document.createElement("div");
    lineDiv.className = "sv-sub-line";
    let tokenCounter = startTokenIndex;

    const parts = lineText.split(/([\p{L}\p{N}-]+)/gu);
    for (const part of parts) {
      if (!part) continue;
      if (/^[\p{L}\p{N}-]+$/u.test(part)) {
        const thisIdx = tokenCounter++;
        const wordSpan = document.createElement("span");
        wordSpan.className = "sv-sub-word";
        wordSpan.textContent = part;
        wordSpan.title =
          "Click to look up • ⌘+Click (or Ctrl+Click) to combine multiple words (partikelverb)";
        wordSpan.addEventListener("click", (e: MouseEvent) =>
          handleSubtitleWordClick(e, part, thisIdx, fullSentence, wordSpan)
        );
        lineDiv.appendChild(wordSpan);
      } else {
        lineDiv.appendChild(document.createTextNode(part));
      }
    }
    return { lineDiv, nextTokenIndex: tokenCounter };
  }

  function syncSvtSubtitles(): void {
    if (!observedSubContainer) return;
    initShadowHost();
    if (!subOverlayWrap || !subLinesEl) return;

    observedSubContainer.style.opacity = "0";
    observedSubContainer.style.pointerEvents = "none";

    const leafSpans = Array.from(
      observedSubContainer.querySelectorAll("span")
    ).filter(
      (s) => s.children.length === 0 && (s.textContent || "").trim().length > 0
    );

    let lines = leafSpans.map((s) =>
      (s.textContent || "").replace(/\s+/g, " ").trim()
    );
    if (lines.length === 0) {
      const raw = observedSubContainer.innerText?.trim() || "";
      if (raw) {
        lines = raw
          .split(/\n+/)
          .map((l) => l.trim())
          .filter(Boolean);
      }
    }

    if (lines.length === 0) {
      subOverlayWrap.style.display = "none";
      return;
    }

    const fullSentence = lines.join(" ").replace(/\s+/g, " ").trim();

    subLinesEl.innerHTML = "";
    let runningTokenIndex = 0;
    for (const line of lines) {
      const { lineDiv, nextTokenIndex } = renderTokenizedLine(
        line,
        fullSentence,
        runningTokenIndex
      );
      runningTokenIndex = nextTokenIndex;
      subLinesEl.appendChild(lineDiv);
    }

    subOverlayWrap.style.display = "flex";
    updateSubtitleOverlayPosition();
  }

  function updateSubtitleOverlayPosition(): void {
    if (!subOverlayWrap || subOverlayWrap.style.display === "none") return;
    const video = getVideoElement() || observedSubContainer;
    if (!video) return;

    const rect = video.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const bottomOffset = Math.max(
      24,
      window.innerHeight - rect.bottom + Math.min(72, rect.height * 0.12)
    );
    subOverlayWrap.style.left = `${Math.round(rect.left)}px`;
    subOverlayWrap.style.width = `${Math.round(rect.width)}px`;
    subOverlayWrap.style.bottom = `${Math.round(bottomOffset)}px`;
  }

  function setupSvtPlayWatcher(): void {
    const checkContainer = () => {
      const container = document.querySelector<HTMLElement>(
        '[data-rt="subtitles-container"]'
      );
      if (container && container !== observedSubContainer) {
        observedSubContainer = container;
        if (subMutationObserver) subMutationObserver.disconnect();

        subMutationObserver = new MutationObserver(() => {
          syncSvtSubtitles();
        });
        subMutationObserver.observe(container, {
          childList: true,
          subtree: true,
          characterData: true
        });
        syncSvtSubtitles();
      } else if (!container && observedSubContainer) {
        observedSubContainer = null;
        if (subOverlayWrap) subOverlayWrap.style.display = "none";
      }
    };

    checkContainer();
    setInterval(checkContainer, 1000);
    window.addEventListener("resize", updateSubtitleOverlayPosition);
    window.addEventListener("scroll", updateSubtitleOverlayPosition, {
      passive: true
    });
  }

  setupSvtPlayWatcher();

  function extractContextSentence(selection: Selection | null): string {
    try {
      if (!selection || selection.rangeCount === 0) return "";
      const range = selection.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const blockText =
        (container.nodeType === Node.TEXT_NODE
          ? (container.parentElement as HTMLElement | null)?.innerText ||
            container.textContent
          : (container as HTMLElement).innerText || container.textContent) ||
        "";

      const selectedWord = selection.toString().trim();
      const cleanBlock = blockText.replace(/\s+/g, " ").trim();
      if (!cleanBlock) return selectedWord;

      const sentences = cleanBlock.split(/(?<=[.!?])\s+/);
      const found = sentences.find((s) =>
        s.toLowerCase().includes(selectedWord.toLowerCase())
      );
      return (found || cleanBlock).slice(0, 220);
    } catch {
      return selection?.toString()?.trim() || "";
    }
  }

  function hideAll(): void {
    if (triggerBtn) triggerBtn.style.display = "none";
    if (popoverEl) popoverEl.style.display = "none";
    clearSelectedSubtitleTokens();
    if (isCardOpen) {
      isCardOpen = false;
      resumeVideoIfAutoPaused();
    }
  }

  function positionElementNearRect(
    el: HTMLElement,
    rect: BoundingRectLike,
    width = 355,
    height = 390
  ): void {
    const margin = 12;
    const left = Math.min(
      Math.max(margin, rect.left + (rect.width || 0) / 2 - width / 2),
      window.innerWidth - width - margin
    );
    let top = rect.bottom + 10;
    if (
      rect.top > window.innerHeight * 0.55 ||
      top + height > window.innerHeight - margin
    ) {
      top = Math.max(margin, rect.top - height - 12);
    }
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(Math.max(margin, top))}px`;
  }

  function playPronunciation(media: Partial<CardMediaInfo> | undefined): void {
    const src = media?.audioBase64 || media?.audioUrl;
    if (!src) return;
    const audio = new Audio(src);
    audio.play().catch(() => {
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

  function openLookupPopover(selData: SelectionLookupData): void {
    initShadowHost();
    if (!triggerBtn || !popoverEl) return;
    isCardOpen = true;
    triggerBtn.style.display = "none";
    popoverEl.style.display = "block";
    positionElementNearRect(popoverEl, selData.rect, 355, 250);

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
      (response: ExtensionResponse<EnrichmentPayload>) => {
        if (chrome.runtime.lastError || !response?.ok || !response.data) {
          renderError(
            response?.error ||
              chrome.runtime.lastError?.message ||
              "Failed to look up word"
          );
          return;
        }
        currentEnrichment = response.data;
        currentImageIdx = 0;
        renderEnrichedCard(currentEnrichment, selData.rect);
      }
    );
  }

  function renderError(msg: string): void {
    const body = popoverEl?.querySelector(".sv-body");
    if (!body) return;
    body.innerHTML = `
      <div style="color:#dc2626; font-size:13px; padding:12px;">
        Could not enrich word: ${escapeHtml(msg)}
      </div>
    `;
  }

  function renderEnrichedCard(
    data: EnrichmentPayload,
    rect: BoundingRectLike
  ): void {
    if (!popoverEl) return;
    const sw = data.swedish || { surfaceForm: "", lemma: "" };
    const en = data.english || {};
    const media = data.media || {};
    const alternatives =
      media.imageAlternatives || (media.imageUrl ? [media.imageUrl] : []);

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
                ? `<div class="sv-sub-surface">In text: <b>${escapeHtml(
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
            <img id="sv-card-img" src="${escapeHtml(
              alternatives[0]
            )}" alt="${escapeHtml(sw.lemma)}" />
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
            ? `<div class="sv-meta-tag"><b>Forms:</b> ${escapeHtml(
                sw.inflections
              )}</div>`
            : ""
        }
        ${
          sw.definitionSv
            ? `<div class="sv-meta-tag"><b>Ordbok:</b> ${escapeHtml(
                sw.definitionSv
              )}</div>`
            : ""
        }

        ${
          sw.contextSentence
            ? `
          <div class="sv-context-box">
            <div class="sv-context-sv">”${escapeHtml(
              sw.contextSentence
            )}”</div>
            ${
              en.sentenceTranslation
                ? `<div class="sv-context-en">${escapeHtml(
                    en.sentenceTranslation
                  )}</div>`
                : ""
            }
          </div>
        `
            : ""
        }

        <button class="sv-save-btn" id="sv-save-card">
          <span>💾</span><span>Save to Cloud Deck</span>
        </button>
        <div class="sv-source-pill">🎙️ Audio: ${escapeHtml(
          media.audioSource || "Swedish Dictionary"
        )}</div>
      </div>
    `;

    positionElementNearRect(popoverEl, rect, 355, 420);

    popoverEl.querySelector("#sv-close")?.addEventListener("click", hideAll);
    popoverEl
      .querySelector("#sv-play-audio")
      ?.addEventListener("click", () => {
        playPronunciation(media);
      });

    const nextImgBtn = popoverEl.querySelector(
      "#sv-next-img"
    ) as HTMLButtonElement | null;
    const imgEl = popoverEl.querySelector(
      "#sv-card-img"
    ) as HTMLImageElement | null;
    if (nextImgBtn && imgEl && alternatives.length > 1) {
      nextImgBtn.addEventListener("click", () => {
        currentImageIdx = (currentImageIdx + 1) % alternatives.length;
        const chosen = alternatives[currentImageIdx];
        imgEl.src = chosen;
        if (currentEnrichment) {
          currentEnrichment.media.imageUrl = chosen;
        }
        nextImgBtn.textContent = `↻ Image ${currentImageIdx + 1}/${
          alternatives.length
        }`;
      });
    }

    const saveBtn = popoverEl.querySelector(
      "#sv-save-card"
    ) as HTMLButtonElement | null;
    saveBtn?.addEventListener("click", () => {
      if (saveBtn.classList.contains("saved")) return;
      saveBtn.textContent = "Saving…";
      chrome.runtime.sendMessage(
        {
          type: "SAVE_CARD",
          payload: currentEnrichment
        },
        (res: ExtensionResponse<SaveCardResult>) => {
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

    playPronunciation(media);
  }

  function escapeHtml(str: string | undefined): string {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  document.addEventListener("mouseup", (e: MouseEvent) => {
    setTimeout(() => {
      const sel = window.getSelection();
      const rawText = sel ? sel.toString().trim() : "";

      if (!rawText || rawText.length > 45 || rawText.split(/\s+/).length > 4) {
        if (triggerBtn && (!popoverEl || popoverEl.style.display === "none")) {
          triggerBtn.style.display = "none";
        }
        return;
      }

      if (!sel || sel.rangeCount === 0) return;
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
          right: rect.right,
          width: rect.width
        }
      };

      if (e.altKey) {
        openLookupPopover(currentSelectionData);
        return;
      }

      if (triggerBtn) {
        triggerBtn.style.display = "inline-flex";
        positionElementNearRect(triggerBtn, currentSelectionData.rect, 150, 36);
      }
    }, 15);
  });

  document.addEventListener("mousedown", () => {
    if (triggerBtn) triggerBtn.style.display = "none";
    if (popoverEl && popoverEl.style.display === "block") {
      hideAll();
    }
  });

  chrome.runtime.onMessage.addListener((msg: any) => {
    if (msg?.type === "TRIGGER_SELECTION_LOOKUP") {
      const sel = window.getSelection();
      const rect: BoundingRectLike =
        sel && sel.rangeCount > 0
          ? sel.getRangeAt(0).getBoundingClientRect()
          : {
              top: 80,
              bottom: 100,
              left: window.innerWidth / 2 - 175,
              right: window.innerWidth / 2,
              width: 100
            };

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
