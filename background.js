// TMT Bridge — Background Service Worker
const API_URL = "https://tmt.ilprl.ku.edu.np/lang-translate";

// ── TTS Configuration ────────────────────────────────────────────────────────
// Priority chain extracted from HealthVoice Nepal app.py:
//   1. Local tts_server.py  (Google ne-NP → ElevenLabs → gTTS)
//   2. gTTS via public API proxy
//   3. Browser speechSynthesis (last resort, may lack ne-NP voice)
const TTS_LOCAL_SERVER = "http://localhost:7799/tts";

// Map language codes to gTTS-compatible codes
const GTTS_LANG_MAP = {
  en: "en", eng: "en", english: "en",
  ne: "ne", nep: "ne", nepali: "ne",
  tmg: "ne", tamang: "ne"  // Tamang → Nepali (closest available)
};

// Map extension lang codes to BCP-47 for speechSynthesis fallback
const SPEECH_SYNTH_LANG = {
  en: "en-US", eng: "en-US", english: "en-US",
  ne: "ne-NP", nep: "ne-NP", nepali: "ne-NP",
  tmg: "ne-NP", tamang: "ne-NP"
};

// ── TTS: try local server first, then gTTS proxy, then speechSynthesis ───────
async function speakViaTTS(text, lang, tabId) {
  const langKey = (lang || "ne").toLowerCase();

  // 1. Try local tts_server.py (best quality — Google ne-NP or ElevenLabs)
  try {
    const resp = await fetch(TTS_LOCAL_SERVER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang: langKey })
    });
    if (resp.ok) {
      const blob = await resp.blob();
      const reader = new FileReader();
      const base64Audio = await new Promise((res, rej) => {
        reader.onloadend = () => res(reader.result.split(",")[1]);
        reader.onerror = rej;
        reader.readAsDataURL(blob);
      });
      // Send base64 audio to content script to play
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          type: "PLAY_AUDIO_B64",
          audioB64: base64Audio,
          mimeType: "audio/mpeg"
        }).catch(() => {});
      }
      return { provider: "tts_server" };
    }
  } catch (e) {
    console.log("TTS local server not available, trying gTTS proxy…", e.message);
  }

  // 2. Try gTTS via Google Translate endpoint (no key needed)
  const gttsLang = GTTS_LANG_MAP[langKey] || "ne";
  try {
    const encoded = encodeURIComponent(text);
    const gttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${gttsLang}&client=tw-ob`;
    const resp = await fetch(gttsUrl);
    if (resp.ok) {
      const blob = await resp.blob();
      const reader = new FileReader();
      const base64Audio = await new Promise((res, rej) => {
        reader.onloadend = () => res(reader.result.split(",")[1]);
        reader.onerror = rej;
        reader.readAsDataURL(blob);
      });
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          type: "PLAY_AUDIO_B64",
          audioB64: base64Audio,
          mimeType: "audio/mpeg"
        }).catch(() => {});
      }
      return { provider: "gtts_proxy" };
    }
  } catch (e) {
    console.log("gTTS proxy failed, falling back to speechSynthesis…");
  }

  // 3. Last resort: browser speechSynthesis (sent to content script)
  const bcp47 = SPEECH_SYNTH_LANG[langKey] || "ne-NP";
  if (tabId) {
    chrome.tabs.sendMessage(tabId, {
      type: "SPEAK_SYNTH",
      text,
      lang: bcp47
    }).catch(() => {});
  }
  return { provider: "speechSynthesis", lang: bcp47 };
}

// ── Cache (session-level, avoids duplicate API calls) ──────────────────────
const translationCache = new Map();
function cacheKey(text, src, tgt) {
  return `${src}|${tgt}|${text.trim()}`;
}

// ── Domain glossary (research contribution: domain-specific terms) ──────────
const GLOSSARY = {
  // Health terms
  "hospital": { ne: "अस्पताल", tmg: "अस्पताल" },
  "doctor": { ne: "डाक्टर", tmg: "डाक्टर" },
  "medicine": { ne: "औषधि", tmg: "औषधि" },
  // Education
  "school": { ne: "विद्यालय", tmg: "विद्यालय" },
  "teacher": { ne: "शिक्षक", tmg: "गुरु" },
  "student": { ne: "विद्यार्थी", tmg: "छात्र" },
  // Government
  "government": { ne: "सरकार", tmg: "सरकार" },
  "election": { ne: "निर्वाचन", tmg: "निर्वाचन" },
  "citizen": { ne: "नागरिक", tmg: "नागरिक" }
};

// ── Error taxonomy (research contribution: classify TMT API failures) ────────
// Stored locally, can be exported for NLP research
async function logTranslationEvent(event) {
  const { storage } = chrome;
  const result = await storage.local.get("translationLog");
  const log = result.translationLog || [];
  log.push({
    ...event,
    timestamp: new Date().toISOString(),
    pageUrl: event.pageUrl || "unknown"
  });
  // Keep last 500 events
  if (log.length > 500) log.splice(0, log.length - 500);
  await storage.local.set({ translationLog: log });
}

// ── Back-translation confidence scoring ────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function confidenceScore(original, backTranslated) {
  const a = original.toLowerCase().trim();
  const b = backTranslated.toLowerCase().trim();
  if (a === b) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshtein(a, b);
  return Math.max(0, 1 - dist / maxLen);
}

// ── Core translation function ────────────────────────────────────────────────
async function translate(text, srcLang, tgtLang, apiKey, withConfidence = false) {
  if (!text || !text.trim()) return { success: false, error: "Empty text" };
  if (!apiKey || !apiKey.trim()) return { success: false, error: "API key not set. Please configure in extension settings." };

  const ck = cacheKey(text, srcLang, tgtLang);
  if (translationCache.has(ck)) {
    return { ...translationCache.get(ck), cached: true };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10-second timeout
    const resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({ text: text.trim(), src_lang: srcLang, tgt_lang: tgtLang }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const data = await resp.json();

    if (data.message_type === "SUCCESS") {
      let confidence = null;

      // Back-translation confidence scoring
      if (withConfidence && data.output) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000); // 5-second timeout
          const backResp = await fetch(API_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({ text: data.output, src_lang: tgtLang, tgt_lang: srcLang }),
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          const backData = await backResp.json();
          if (backData.message_type === "SUCCESS") {
            confidence = confidenceScore(text, backData.output);
          }
        } catch (e) {
          // Back-translation failed silently (timeout or network error)
          console.log("Back-translation failed:", e.message);
        }
      }

      const result = {
        success: true,
        translation: data.output,
        srcLang: data.src_lang,
        tgtLang: data.target_lang,
        original: text,
        confidence,
        timestamp: data.timestamp
      };

      translationCache.set(ck, result);
      logTranslationEvent({ type: "success", text, srcLang, tgtLang, confidence }); // fire-and-forget
      return result;

    } else {
      logTranslationEvent({ type: "failure", text, srcLang, tgtLang, error: data.message }); // fire-and-forget
      return { success: false, error: data.message || "Translation failed" };
    }

  } catch (err) {
    const errorMsg = err.name === 'AbortError' ? "Request timed out. The translation service may be unavailable." : "Network error. Check your connection.";
    logTranslationEvent({ type: "network_error", text, srcLang, tgtLang, error: err.message }); // fire-and-forget
    return { success: false, error: errorMsg };
  }
}

// ── Translate full page (sentence-level as required by API) ─────────────────
async function translatePage(sentences, srcLang, tgtLang, apiKey) {
  const results = [];
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (!s.trim()) { results.push(""); continue; }
    // Add small delay to avoid rate limiting (as per API docs)
    if (i > 0 && i % 5 === 0) await new Promise(r => setTimeout(r, 300));
    const res = await translate(s, srcLang, tgtLang, apiKey, false);
    results.push(res.success ? res.translation : s);
  }
  return results;
}

// ── Context menu setup ────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "tmt-translate-selection",
    title: "Translate with TMT Bridge",
    contexts: ["selection"]
  });
  chrome.contextMenus.create({
    id: "tmt-report-error",
    title: "Report translation error",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "tmt-translate-selection") {
    const { srcLang = "en", tgtLang = "ne" } = await chrome.storage.local.get(["srcLang", "tgtLang"]);
    const { apiKey = "" } = await chrome.storage.sync.get("apiKey");
    chrome.tabs.sendMessage(tab.id, {
      type: "TRANSLATE_SELECTION",
      text: info.selectionText,
      srcLang,
      tgtLang
    });
  }
  if (info.menuItemId === "tmt-report-error") {
    chrome.tabs.sendMessage(tab.id, {
      type: "OPEN_ERROR_REPORT",
      text: info.selectionText
    });
  }
});

// ── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const { apiKey = "" } = await chrome.storage.sync.get("apiKey");

    if (msg.type === "TRANSLATE") {
      const result = await translate(msg.text, msg.srcLang, msg.tgtLang, apiKey, msg.withConfidence);
      sendResponse(result);
    }

    else if (msg.type === "TRANSLATE_PAGE") {
      const results = await translatePage(msg.sentences, msg.srcLang, msg.tgtLang, apiKey);
      sendResponse({ translations: results });
    }

    else if (msg.type === "GET_SETTINGS") {
      const settings = await chrome.storage.local.get(["srcLang", "tgtLang", "bilingualMode", "ttsEnabled"]);
      const { apiKey = "" } = await chrome.storage.sync.get("apiKey");
      sendResponse({ ...settings, apiKey });
    }

    else if (msg.type === "SAVE_SETTINGS") {
      await chrome.storage.local.set(msg.settings);
      sendResponse({ ok: true });
    }

    else if (msg.type === "LOG_ERROR_REPORT") {
      await logTranslationEvent({ type: "user_report", ...msg.data });
      const { errorReports } = await chrome.storage.local.get("errorReports");
      const reports = errorReports || [];
      reports.push({ ...msg.data, timestamp: new Date().toISOString() });
      await chrome.storage.local.set({ errorReports: reports });
      sendResponse({ ok: true });
    }

    else if (msg.type === "GET_STATS") {
      const { translationLog, errorReports } = await chrome.storage.local.get(["translationLog", "errorReports"]);
      const log = translationLog || [];
      const successes = log.filter(e => e.type === "success").length;
      const failures = log.filter(e => e.type === "failure" || e.type === "network_error").length;
      const userReports = (errorReports || []).length;
      const avgConfidence = log
        .filter(e => e.confidence != null)
        .reduce((s, e, _, a) => s + e.confidence / a.length, 0);
      sendResponse({ total: log.length, successes, failures, userReports, avgConfidence });
    }

    else if (msg.type === "EXPORT_DATASET") {
      const { translationLog, errorReports } = await chrome.storage.local.get(["translationLog", "errorReports"]);
      sendResponse({ translationLog: translationLog || [], errorReports: errorReports || [] });
    }

    else if (msg.type === "SPEAK") {
      const tabId = sender?.tab?.id || null;
      const result = await speakViaTTS(msg.text, msg.lang, tabId);
      sendResponse(result);
    }

    else if (msg.type === "CHECK_TTS_SERVER") {
      try {
        const resp = await fetch("http://localhost:7799/health");
        const data = await resp.json();
        sendResponse({ available: true, ...data });
      } catch (e) {
        sendResponse({ available: false });
      }
    }
  })();
  return true; // keep channel open for async
});