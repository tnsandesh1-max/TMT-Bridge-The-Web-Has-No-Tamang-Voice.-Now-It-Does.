// TMT Bridge — Popup Script

const LANG_NAMES = { en: "English", ne: "Nepali", tmg: "Tamang" };

// ── Element refs ─────────────────────────────────────────────────────────────
const srcLangEl = document.getElementById("src-lang");
const tgtLangEl = document.getElementById("tgt-lang");
const inputEl = document.getElementById("input-text");
const translateBtn = document.getElementById("translate-btn");
const outputEl = document.getElementById("output-text");
const outputPlaceholder = document.getElementById("output-placeholder");
const outputActions = document.getElementById("output-actions");
const spinner = document.getElementById("spinner");
const confRow = document.getElementById("conf-row");
const confFill = document.getElementById("conf-fill");
const confPct = document.getElementById("conf-pct");
const pageToggle = document.getElementById("page-toggle");
const charNum = document.getElementById("char-num");

let currentTranslation = "";
let currentSrc = "en";
let currentTgt = "ne";

// ── Tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`page-${tab.dataset.tab}`).classList.add("active");
    if (tab.dataset.tab === "stats") loadStats();
    if (tab.dataset.tab === "settings") checkTTSServer();
  });
});

// ── Load settings on open ─────────────────────────────────────────────────────
chrome.storage.local.get(["srcLang", "tgtLang", "ttsEnabled", "confidenceEnabled"], (res) => {
  if (res.srcLang) { srcLangEl.value = res.srcLang; document.getElementById("default-src").value = res.srcLang; }
  if (res.tgtLang) { tgtLangEl.value = res.tgtLang; document.getElementById("default-tgt").value = res.tgtLang; }
  if (res.ttsEnabled) document.getElementById("tts-toggle").checked = res.ttsEnabled;
  if (res.confidenceEnabled !== false) document.getElementById("confidence-toggle").checked = true;
  currentSrc = srcLangEl.value;
  currentTgt = tgtLangEl.value;
});

// ── Char counter ─────────────────────────────────────────────────────────────
inputEl.addEventListener("input", () => {
  charNum.textContent = inputEl.value.length;
});

// ── Language swap ─────────────────────────────────────────────────────────────
document.getElementById("swap-btn").addEventListener("click", () => {
  const tmp = srcLangEl.value;
  srcLangEl.value = tgtLangEl.value;
  tgtLangEl.value = tmp;
  // Also swap input/output text if available
  if (currentTranslation) {
    const prevInput = inputEl.value;
    inputEl.value = currentTranslation;
    charNum.textContent = inputEl.value.length;
    currentTranslation = prevInput;
  }
  syncLangs();
});

function syncLangs() {
  currentSrc = srcLangEl.value;
  currentTgt = tgtLangEl.value;
  chrome.storage.local.set({ srcLang: currentSrc, tgtLang: currentTgt });
  notifyTabs({ type: "SETTINGS_UPDATED", settings: { srcLang: currentSrc, tgtLang: currentTgt } });
}

srcLangEl.addEventListener("change", () => {
  if (srcLangEl.value === tgtLangEl.value) {
    // Auto-pick a different target
    const others = ["en", "ne", "tmg"].filter(l => l !== srcLangEl.value);
    tgtLangEl.value = others[0];
  }
  syncLangs();
});
tgtLangEl.addEventListener("change", () => {
  if (tgtLangEl.value === srcLangEl.value) {
    const others = ["en", "ne", "tmg"].filter(l => l !== tgtLangEl.value);
    srcLangEl.value = others[0];
  }
  syncLangs();
});

// ── Translate button ──────────────────────────────────────────────────────────
translateBtn.addEventListener("click", doTranslate);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doTranslate();
});

function doTranslate() {
  const text = inputEl.value.trim();
  if (!text) return;

  const confidenceEnabled = document.getElementById("confidence-toggle").checked;

  setLoading(true);
  const sendTranslate = () => {
    chrome.runtime.sendMessage({
      type: "TRANSLATE",
      text,
      srcLang: srcLangEl.value,
      tgtLang: tgtLangEl.value,
      withConfidence: confidenceEnabled
    }, (result) => {
      if (chrome.runtime.lastError) {
        // Background worker woke up — retry once
        setTimeout(sendTranslate, 300);
        return;
      }
      setLoading(false);
    if (result?.success) {
      currentTranslation = result.translation;
      outputEl.textContent = result.translation;
      outputEl.style.display = "block";
      outputPlaceholder.style.display = "none";
      outputActions.style.display = "flex";

      // Confidence
      if (result.confidence != null && confidenceEnabled) {
        const pct = Math.round(result.confidence * 100);
        const color = pct >= 75 ? "#34d399" : pct >= 50 ? "#fbbf24" : "#f87171";
        confFill.style.width = `${pct}%`;
        confFill.style.background = color;
        confPct.textContent = `${pct}%`;
        confRow.style.display = "flex";
      } else {
        confRow.style.display = "none";
      }
    } else {
      outputEl.textContent = result?.error || "Translation failed";
      outputEl.style.display = "block";
      outputEl.className = "error-text";
      outputPlaceholder.style.display = "none";
    }
    });
  };
  sendTranslate();
}

function setLoading(on) {
  translateBtn.disabled = on;
  spinner.style.display = on ? "block" : "none";
  outputPlaceholder.style.display = on ? "none" : (outputEl.style.display === "none" ? "block" : "none");
}

// ── TTS ───────────────────────────────────────────────────────────────────────
// Routes through background.js → tts_server.py → gTTS → speechSynthesis
document.getElementById("tts-btn").addEventListener("click", () => {
  const text = inputEl.value.trim();
  if (text) doSpeak(text, srcLangEl.value);
});
document.getElementById("speak-btn")?.addEventListener("click", () => {
  if (currentTranslation) doSpeak(currentTranslation, tgtLangEl.value);
});

function doSpeak(text, lang) {
  // Ask background service worker to handle TTS
  // Background will send PLAY_AUDIO_B64 or SPEAK_SYNTH to the active tab's content script
  // For popup, we also handle audio directly here
  chrome.runtime.sendMessage({ type: "SPEAK", text, lang: lang.toLowerCase() }, (result) => {
    if (result?.provider) showToast(`🔊 ${result.provider}`);
  });

  // Also try to play audio directly in popup context for immediate feedback
  _popupSpeak(text, lang);
}

async function _popupSpeak(text, lang) {
  const langKey = (lang || "ne").toLowerCase();
  const gttsLangMap = { en: "en", eng: "en", english: "en", ne: "ne", nep: "ne", nepali: "ne", tmg: "ne", tamang: "ne" };
  const gttsLang = gttsLangMap[langKey] || "ne";

  // 1. Try local TTS server
  try {
    const resp = await fetch("http://localhost:7799/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang: langKey })
    });
    if (resp.ok) {
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
      return;
    }
  } catch (e) { /* server not running */ }

  // 2. gTTS proxy via Google Translate
  try {
    const encoded = encodeURIComponent(text);
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${gttsLang}&client=tw-ob`;
    const audio = new Audio(url);
    await audio.play();
    return;
  } catch (e) { /* blocked */ }

  // 3. speechSynthesis (may not have ne-NP voice)
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
    const bcp47map = { en: "en-US", eng: "en-US", ne: "ne-NP", nep: "ne-NP", tmg: "ne-NP", tamang: "ne-NP" };
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = bcp47map[langKey] || "ne-NP";
    utt.rate = 0.85;
    const voices = window.speechSynthesis.getVoices();
    const match = voices.find(v => v.lang.startsWith(utt.lang.split("-")[0]));
    if (match) utt.voice = match;
    window.speechSynthesis.speak(utt);
  }
}

// ── Copy ─────────────────────────────────────────────────────────────────────
document.getElementById("copy-btn")?.addEventListener("click", () => {
  if (currentTranslation) {
    navigator.clipboard.writeText(currentTranslation);
    showToast("Copied!");
  }
});

// ── Error report ──────────────────────────────────────────────────────────────
document.getElementById("flag-btn")?.addEventListener("click", () => {
  const box = document.getElementById("error-report-box");
  box.style.display = box.style.display === "none" ? "block" : "none";
});
document.getElementById("cancel-report-btn")?.addEventListener("click", () => {
  document.getElementById("error-report-box").style.display = "none";
});
document.querySelectorAll("#popup-err-types .tmt-err-type").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#popup-err-types .tmt-err-type").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
  });
});
document.getElementById("submit-report-btn")?.addEventListener("click", () => {
  const errorType = document.querySelector("#popup-err-types .tmt-err-type.selected")?.dataset.type;
  const note = document.getElementById("popup-err-note")?.value;
  if (!errorType) { showToast("Select an error type first"); return; }
  chrome.runtime.sendMessage({
    type: "LOG_ERROR_REPORT",
    data: {
      original: inputEl.value.trim(),
      translation: currentTranslation,
      errorType,
      note,
      srcLang: srcLangEl.value,
      tgtLang: tgtLangEl.value
    }
  }, () => {
    document.getElementById("error-report-box").style.display = "none";
    showToast("Report submitted. Thank you!");
  });
});

// ── Page translate toggle ─────────────────────────────────────────────────────
pageToggle.addEventListener("change", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) return;
    chrome.tabs.sendMessage(tabs[0].id, {
      type: "TRANSLATE_PAGE_CMD",
      srcLang: srcLangEl.value,
      tgtLang: tgtLangEl.value
    });
  });
});

// ── Settings ──────────────────────────────────────────────────────────────────
document.getElementById("save-settings-btn").addEventListener("click", () => {
  const settings = {
    srcLang: document.getElementById("default-src").value,
    tgtLang: document.getElementById("default-tgt").value,
    ttsEnabled: document.getElementById("tts-toggle").checked,
    confidenceEnabled: document.getElementById("confidence-toggle").checked
  };
  chrome.storage.local.set(settings, () => {
    notifyTabs({ type: "SETTINGS_UPDATED", settings });
    showStatusMsg("settings-status", "Settings saved!", "success");
  });
});

// ── Stats ─────────────────────────────────────────────────────────────────────
function loadStats() {
  chrome.runtime.sendMessage({ type: "GET_STATS" }, (stats) => {
    if (!stats) return;
    document.getElementById("stat-total").textContent = stats.total || 0;
    document.getElementById("stat-success").textContent = stats.successes || 0;
    document.getElementById("stat-reports").textContent = stats.userReports || 0;
    const conf = stats.avgConfidence > 0 ? `${Math.round(stats.avgConfidence * 100)}%` : "—";
    document.getElementById("stat-confidence").textContent = conf;
  });
}

document.getElementById("export-btn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "EXPORT_DATASET" }, (data) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tmt-bridge-dataset-${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Dataset exported!");
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function showToast(msg) {
  const toast = document.getElementById("tmt-toast");
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2200);
}

function showStatusMsg(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = `status-msg ${type}`;
  el.style.display = "block";
  setTimeout(() => { el.style.display = "none"; }, 3000);
}

function notifyTabs(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, msg).catch(() => {});
  });
}

async function checkTTSServer() {
  const dot = document.getElementById("tts-server-dot");
  const sub = document.getElementById("tts-server-sub");
  if (!dot || !sub) return;
  try {
    const resp = await fetch("http://localhost:7799/health", { method: "GET" });
    if (resp.ok) {
      const data = await resp.json();
      dot.style.background = "#34d399";
      const providers = [];
      if (data.google_tts) providers.push("Google ne-NP");
      if (data.elevenlabs) providers.push("ElevenLabs");
      providers.push("gTTS");
      sub.textContent = `Online · ${providers.join(" → ")}`;
    } else {
      throw new Error("bad status");
    }
  } catch (e) {
    dot.style.background = "#f59e0b";
    sub.textContent = "Not running · using gTTS fallback";
  }
}

// Check TTS server on open
checkTTSServer();
