// TMT Bridge — Content Script
(function () {
  if (window.__tmtBridgeLoaded) return;
  window.__tmtBridgeLoaded = true;

  // ── State ─────────────────────────────────────────────────────────────────
  let settings = { srcLang: "en", tgtLang: "ne", bilingualMode: false, ttsEnabled: false };
  let tooltip = null;
  let pageTranslated = false;
  let originalNodes = new Map(); // nodeId → originalText

  // ── Load settings ─────────────────────────────────────────────────────────
  chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (res) => {
    if (res) settings = { ...settings, ...res };
  });

  // ── Sentence splitter ─────────────────────────────────────────────────────
  function splitSentences(text) {
    // Split on sentence-ending punctuation, keeping the punctuation
    return text.match(/[^.!?।]+[.!?।]*/g)?.map(s => s.trim()).filter(Boolean) || [text];
  }

  // ── Extract text nodes from page ──────────────────────────────────────────
  function getTextNodes(root = document.body) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName?.toLowerCase();
          if (["script", "style", "noscript", "head", "meta", "link", "tmt-tooltip", "tmt-badge"].includes(tag))
            return NodeFilter.FILTER_REJECT;
          if (parent.closest("tmt-tooltip, tmt-badge, [data-tmt-translated]"))
            return NodeFilter.FILTER_REJECT;
          const text = node.textContent?.trim();
          if (!text || text.length < 3) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }

  // ── Create tooltip ────────────────────────────────────────────────────────
  function createTooltip() {
    if (tooltip) return;
    tooltip = document.createElement("div");
    tooltip.id = "tmt-tooltip";
    tooltip.innerHTML = `
      <div class="tmt-tooltip-inner">
        <div class="tmt-tooltip-header">
          <span class="tmt-lang-badge" id="tmt-lang-badge">EN → NE</span>
          <div class="tmt-tooltip-actions">
            <button class="tmt-btn-icon" id="tmt-tts-btn" title="Read aloud">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
            </button>
            <button class="tmt-btn-icon" id="tmt-report-btn" title="Report error">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            </button>
            <button class="tmt-btn-icon" id="tmt-close-btn" title="Close">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="tmt-tooltip-body">
          <div class="tmt-loading" id="tmt-loading">
            <div class="tmt-spinner"></div>
            <span>Translating...</span>
          </div>
          <div class="tmt-translation" id="tmt-translation" style="display:none"></div>
          <div class="tmt-confidence" id="tmt-confidence" style="display:none"></div>
        </div>
        <div class="tmt-error-panel" id="tmt-error-panel" style="display:none">
          <p>What's wrong with this translation?</p>
          <div class="tmt-error-types">
            <button class="tmt-err-type" data-type="wrong_meaning">Wrong meaning</button>
            <button class="tmt-err-type" data-type="missing_words">Missing words</button>
            <button class="tmt-err-type" data-type="wrong_script">Wrong script</button>
            <button class="tmt-err-type" data-type="unnatural">Unnatural</button>
            <button class="tmt-err-type" data-type="other">Other</button>
          </div>
          <textarea id="tmt-error-note" placeholder="Optional: describe the issue..." rows="2"></textarea>
          <div style="display:flex;gap:6px;margin-top:6px">
            <button class="tmt-submit-report">Submit Report</button>
            <button class="tmt-cancel-report">Cancel</button>
          </div>
        </div>
        <div class="tmt-footer">
          <span class="tmt-powered">TMT Bridge</span>
        </div>
      </div>
    `;
    document.body.appendChild(tooltip);

    // Close
    tooltip.querySelector("#tmt-close-btn").addEventListener("click", hideTooltip);

    // TTS
    tooltip.querySelector("#tmt-tts-btn").addEventListener("click", () => {
      const text = tooltip.querySelector("#tmt-translation")?.textContent;
      if (text) speakText(text, settings.tgtLang);
    });

    // Report error button
    tooltip.querySelector("#tmt-report-btn").addEventListener("click", () => {
      tooltip.querySelector("#tmt-error-panel").style.display = "block";
    });

    // Cancel report
    tooltip.querySelector(".tmt-cancel-report").addEventListener("click", () => {
      tooltip.querySelector("#tmt-error-panel").style.display = "none";
    });

    // Submit report
    tooltip.querySelector(".tmt-submit-report").addEventListener("click", () => {
      const selectedType = tooltip.querySelector(".tmt-err-type.selected")?.dataset.type;
      const note = tooltip.querySelector("#tmt-error-note")?.value;
      const original = tooltip.dataset.originalText;
      const translation = tooltip.querySelector("#tmt-translation")?.textContent;
      if (selectedType) {
        chrome.runtime.sendMessage({
          type: "LOG_ERROR_REPORT",
          data: {
            original,
            translation,
            errorType: selectedType,
            note,
            srcLang: settings.srcLang,
            tgtLang: settings.tgtLang,
            pageUrl: window.location.href
          }
        });
        tooltip.querySelector("#tmt-error-panel").style.display = "none";
        showFeedback("Report submitted. Thank you!");
      }
    });

    // Error type selection
    tooltip.querySelectorAll(".tmt-err-type").forEach(btn => {
      btn.addEventListener("click", () => {
        tooltip.querySelectorAll(".tmt-err-type").forEach(b => b.classList.remove("selected"));
        btn.classList.add("selected");
      });
    });

    document.addEventListener("mousedown", (e) => {
      if (!tooltip.contains(e.target)) hideTooltip();
    });
  }

  function positionTooltip(x, y) {
    if (!tooltip) return;
    tooltip.style.display = "block";
    const tw = tooltip.offsetWidth || 300;
    const th = tooltip.offsetHeight || 160;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = x + 10;
    let top = y + 10;
    if (left + tw > vw - 10) left = x - tw - 10;
    if (top + th > vh - 10) top = y - th - 10;
    tooltip.style.left = `${Math.max(6, left)}px`;
    tooltip.style.top = `${Math.max(6, top)}px`;
  }

  function hideTooltip() {
    if (tooltip) tooltip.style.display = "none";
  }

  function showFeedback(msg) {
    const el = tooltip.querySelector("#tmt-translation");
    if (el) { el.textContent = msg; el.style.display = "block"; }
  }

  // ── Confidence bar ────────────────────────────────────────────────────────
  function renderConfidence(score) {
    if (score == null) return;
    const el = tooltip.querySelector("#tmt-confidence");
    const pct = Math.round(score * 100);
    const color = pct >= 75 ? "#22c55e" : pct >= 50 ? "#f59e0b" : "#ef4444";
    el.style.display = "flex";
    el.innerHTML = `
      <span class="tmt-conf-label">Confidence</span>
      <div class="tmt-conf-bar">
        <div class="tmt-conf-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <span class="tmt-conf-pct">${pct}%</span>
    `;
  }

  // ── Selection translation ─────────────────────────────────────────────────
  document.addEventListener("mouseup", async (e) => {
    const selected = window.getSelection()?.toString().trim();
    if (!selected || selected.length < 2) { hideTooltip(); return; }

    // Don't translate if inside our own tooltip
    if (e.target.closest("#tmt-tooltip")) return;

    createTooltip();
    tooltip.dataset.originalText = selected;
    tooltip.querySelector("#tmt-loading").style.display = "flex";
    tooltip.querySelector("#tmt-translation").style.display = "none";
    tooltip.querySelector("#tmt-confidence").style.display = "none";
    tooltip.querySelector("#tmt-error-panel").style.display = "none";

    const langLabel = `${settings.srcLang.toUpperCase()} → ${settings.tgtLang.toUpperCase()}`;
    tooltip.querySelector("#tmt-lang-badge").textContent = langLabel;

    positionTooltip(e.pageX, e.pageY);

    // Check glossary first
    const glossaryHit = checkGlossary(selected, settings.tgtLang);
    if (glossaryHit) {
      tooltip.querySelector("#tmt-loading").style.display = "none";
      const el = tooltip.querySelector("#tmt-translation");
      el.textContent = glossaryHit;
      el.style.display = "block";
      const badge = tooltip.querySelector(".tmt-powered");
      if (badge) badge.textContent = "TMT Bridge · Glossary";
      return;
    }

    const doTranslate = (retried) => {
    chrome.runtime.sendMessage({
      type: "TRANSLATE",
      text: selected,
      srcLang: settings.srcLang,
      tgtLang: settings.tgtLang,
      withConfidence: true
    }, (result) => {
      if (chrome.runtime.lastError) {
        if (!retried) { setTimeout(() => doTranslate(true), 300); return; }
        tooltip.querySelector("#tmt-loading").style.display = "none";
        const el = tooltip.querySelector("#tmt-translation");
        el.textContent = "Extension restarting, please try again.";
        el.style.display = "block";
        el.style.color = "#ef4444";
        return;
      }
      tooltip.querySelector("#tmt-loading").style.display = "none";
      if (result?.success) {
        const el = tooltip.querySelector("#tmt-translation");
        el.textContent = result.translation;
        el.style.display = "block";
        renderConfidence(result.confidence);
        if (settings.ttsEnabled) speakText(result.translation, settings.tgtLang);
      } else {
        const el = tooltip.querySelector("#tmt-translation");
        el.textContent = result?.error || "Translation failed";
        el.style.display = "block";
        el.style.color = "#ef4444";
      }
    });
    };
    doTranslate(false);
  });

  // ── Glossary check ────────────────────────────────────────────────────────
  function checkGlossary(text, tgtLang) {
    const lower = text.toLowerCase().trim();
    const langMap = { ne: "ne", nep: "ne", nepali: "ne", tmg: "tmg", tamang: "tmg" };
    const lang = langMap[tgtLang.toLowerCase()] || null;
    if (!lang) return null;

    const GLOSSARY = {
      "hospital": { ne: "अस्पताल", tmg: "अस्पताल" },
      "doctor": { ne: "डाक्टर", tmg: "डाक्टर" },
      "medicine": { ne: "औषधि", tmg: "औषधि" },
      "school": { ne: "विद्यालय", tmg: "विद्यालय" },
      "teacher": { ne: "शिक्षक", tmg: "गुरु" },
      "student": { ne: "विद्यार्थी", tmg: "छात्र" },
      "government": { ne: "सरकार", tmg: "सरकार" },
      "election": { ne: "निर्वाचन", tmg: "निर्वाचन" },
      "citizen": { ne: "नागरिक", tmg: "नागरिक" },
      "water": { ne: "पानी", tmg: "ति" },
      "food": { ne: "खाना", tmg: "सा" },
      "house": { ne: "घर", tmg: "इम" },
      "mother": { ne: "आमा", tmg: "आमा" },
      "father": { ne: "बुबा", tmg: "पा" }
    };

    return GLOSSARY[lower]?.[lang] || null;
  }

  // ── TTS ───────────────────────────────────────────────────────────────────
  // Routes to background.js which tries:
  //   1. Local tts_server.py (Google ne-NP → ElevenLabs → gTTS)
  //   2. gTTS proxy
  //   3. speechSynthesis (last resort)
  function speakText(text, lang) {
    if (!text || !text.trim()) return;
    // Ask background to handle TTS — it will message us back with PLAY_AUDIO_B64 or SPEAK_SYNTH
    chrome.runtime.sendMessage({ type: "SPEAK", text, lang: lang || "ne" });
  }

  // ── Audio playback from base64 (received from background TTS) ───────────
  function playAudioBase64(base64Data, mimeType = "audio/mpeg") {
    try {
      const byteChars = atob(base64Data);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const blob = new Blob([bytes], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      audio.onerror = (e) => {
        console.warn("TMT Bridge: audio playback error", e);
        URL.revokeObjectURL(url);
      };
      audio.play().catch(e => console.warn("TMT Bridge: play() rejected", e));
    } catch (e) {
      console.warn("TMT Bridge: audio decode error", e);
    }
  }

  // ── speechSynthesis fallback ──────────────────────────────────────────────
  function speakSynth(text, lang) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = lang || "ne-NP";
    utt.rate = 0.85;
    // Try to find a matching voice
    const voices = window.speechSynthesis.getVoices();
    const match = voices.find(v => v.lang.startsWith(utt.lang.split("-")[0]));
    if (match) utt.voice = match;
    window.speechSynthesis.speak(utt);
  }

  // ── Page translation (bilingual mode) ────────────────────────────────────
  async function translatePageBilingual(srcLang, tgtLang) {
    if (pageTranslated) {
      restorePage();
      return;
    }
    const nodes = getTextNodes();
    const allSentences = [];
    const nodeMap = [];

    nodes.forEach((node, nodeIdx) => {
      const sentences = splitSentences(node.textContent);
      sentences.forEach((s, si) => {
        allSentences.push(s);
        nodeMap.push({ nodeIdx, sentenceIdx: si, total: sentences.length });
      });
    });

    // Batch translate
    chrome.runtime.sendMessage({
      type: "TRANSLATE_PAGE",
      sentences: allSentences,
      srcLang,
      tgtLang
    }, (result) => {
      if (!result?.translations) return;

      // Group translations back by node
      const nodeTranslations = {};
      nodeMap.forEach(({ nodeIdx, sentenceIdx }, i) => {
        if (!nodeTranslations[nodeIdx]) nodeTranslations[nodeIdx] = {};
        nodeTranslations[nodeIdx][sentenceIdx] = result.translations[i];
      });

      nodes.forEach((node, nodeIdx) => {
        const parent = node.parentElement;
        if (!parent || parent.dataset.tmtTranslated) return;
        originalNodes.set(nodeIdx, node.textContent);
        parent.dataset.tmtTranslated = "true";

        const translations = nodeTranslations[nodeIdx];
        if (!translations) return;

        const translatedText = Object.values(translations).join(" ");
        const wrapper = document.createElement("span");
        wrapper.className = "tmt-bilingual-wrap";
        wrapper.innerHTML = `
          <span class="tmt-original">${escapeHtml(node.textContent)}</span>
          <span class="tmt-translated">${escapeHtml(translatedText)}</span>
        `;
        node.parentElement.insertBefore(wrapper, node);
        node.remove();
      });

      pageTranslated = true;
    });
  }

  function restorePage() {
    document.querySelectorAll(".tmt-bilingual-wrap").forEach(wrap => {
      const original = wrap.querySelector(".tmt-original");
      if (original) {
        const textNode = document.createTextNode(original.textContent);
        wrap.parentElement.insertBefore(textNode, wrap);
        wrap.remove();
      }
    });
    document.querySelectorAll("[data-tmt-translated]").forEach(el => {
      delete el.dataset.tmtTranslated;
    });
    pageTranslated = false;
  }

  function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ── Message listener (from popup/background) ──────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // ── Audio playback messages from background TTS ──
    if (msg.type === "PLAY_AUDIO_B64") {
      playAudioBase64(msg.audioB64, msg.mimeType || "audio/mpeg");
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "SPEAK_SYNTH") {
      speakSynth(msg.text, msg.lang);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "SETTINGS_UPDATED") {
      settings = { ...settings, ...msg.settings };
    }
    if (msg.type === "TRANSLATE_PAGE_CMD") {
      translatePageBilingual(msg.srcLang, msg.tgtLang);
      sendResponse({ ok: true });
    }
    if (msg.type === "TRANSLATE_SELECTION") {
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const rect = range?.getBoundingClientRect();
      createTooltip();
      tooltip.dataset.originalText = msg.text;
      tooltip.querySelector("#tmt-loading").style.display = "flex";
      tooltip.querySelector("#tmt-translation").style.display = "none";
      tooltip.querySelector("#tmt-error-panel").style.display = "none";
      positionTooltip(
        rect ? rect.left + window.scrollX : window.innerWidth / 2,
        rect ? rect.bottom + window.scrollY : window.innerHeight / 2
      );
      chrome.runtime.sendMessage({
        type: "TRANSLATE",
        text: msg.text,
        srcLang: msg.srcLang,
        tgtLang: msg.tgtLang,
        withConfidence: true
      }, (result) => {
        if (chrome.runtime.lastError) {
          setTimeout(() => chrome.runtime.sendMessage({ type: "TRANSLATE", text: msg.text, srcLang: msg.srcLang, tgtLang: msg.tgtLang, withConfidence: true }, (r) => {
            tooltip.querySelector("#tmt-loading").style.display = "none";
            const el = tooltip.querySelector("#tmt-translation");
            el.textContent = r?.success ? r.translation : (r?.error || "Translation failed");
            el.style.display = "block";
            if (r?.success) renderConfidence(r.confidence);
          }), 300);
          return;
        }
        tooltip.querySelector("#tmt-loading").style.display = "none";
        const el = tooltip.querySelector("#tmt-translation");
        el.textContent = result?.success ? result.translation : result?.error;
        el.style.display = "block";
        if (result?.success) renderConfidence(result.confidence);
      });
    }
    if (msg.type === "OPEN_ERROR_REPORT") {
      createTooltip();
      tooltip.querySelector("#tmt-error-panel").style.display = "block";
      tooltip.dataset.originalText = msg.text;
      positionTooltip(window.innerWidth / 2 - 150, window.innerHeight / 2 - 100);
    }
    return true;
  });

})();
