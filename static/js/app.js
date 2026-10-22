
(() => {
  "use strict";

  // =========================================================
  // BLOOM VOICE — COMPLETE FRONTEND JAVASCRIPT
  // =========================================================

  const $ = id => document.getElementById(id);
  const views = ["homeView", "voiceView", "documentsView", "settingsView"];
  const transcript = $("transcript");
  const titleInput = $("documentTitle");
  const toastEl = $("toast");

  let recognition = null;
  let isRecording = false;
  let shouldKeepListening = false;
  let recognitionBlocked = false;
  let recognitionRestartTimer = null;
  let recognitionSessionId = 0;

  let startedAt = 0;
  let timerHandle = null;
  let undoStack = [];
  let activeDocumentId = null;
  let documents = [];
  let toastTimer = null;
  let draftTimer = null;

  // =========================================================
  // GENERAL HELPERS
  // =========================================================

  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });

    if (response.status === 401) {
      window.location.href = "/login";
      throw new Error("Please sign in again.");
    }

    const data = response.status === 204
        ? null
        : await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data?.error || "Something went wrong.");
    }

    return data;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char]));
  }

  function setView(viewId) {
    if (!views.includes(viewId)) return;

    views.forEach(id => {
      const element = $(id);
      if (!element) return;

      element.classList.toggle("active-view", id === viewId);
      element.classList.toggle("hidden", id !== viewId);
    });

    document.querySelectorAll("[data-view]").forEach(button => {
      button.classList.toggle("active", button.dataset.view === viewId);
    });

    document.querySelector(".sidebar")?.classList.remove("sidebar-open");

    if (viewId === "homeView" || viewId === "documentsView") {
      loadDocuments();
    }

    if (viewId === "voiceView") {
      setTimeout(() => transcript?.focus({ preventScroll: true }), 80);
    }
  }

  document.querySelectorAll("[data-view]").forEach(button => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });

  $("mobileMenu")?.addEventListener("click", () => {
    document.querySelector(".sidebar")?.classList.toggle("sidebar-open");
  });

  function updateCount() {
    const value = transcript?.value || "";
    const words = value.trim() ? value.trim().split(/\s+/).length : 0;

    if ($("wordCount")) {
      $("wordCount").textContent =
          `${words} words · ${value.length} characters`;
    }
  }

  function pushUndo() {
    if (!transcript) return;

    undoStack.push(transcript.value);
    if (undoStack.length > 40) undoStack.shift();
  }

  transcript?.addEventListener("beforeinput", pushUndo);

  transcript?.addEventListener("input", () => {
    updateCount();
    saveDraftSoon();
  });

  function saveDraftSoon() {
    clearTimeout(draftTimer);

    draftTimer = setTimeout(() => {
      if (!transcript) return;

      api("/api/draft", {
        method: "PUT",
        body: JSON.stringify({ content: transcript.value })
      }).catch(() => {});
    }, 700);
  }

  function cleanText(value) {
    return value
        .replace(/[ \t]+/g, " ")
        .replace(/\s+([,.!?;:])/g, "$1")
        .replace(/([,.!?])(?=[A-Za-z])/g, "$1 ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
  }

  // =========================================================
  // UNDO AND TEXT EDITING
  // =========================================================

  function undo() {
    if (!undoStack.length) {
      toast("Nothing to undo yet.");
      return;
    }

    transcript.value = undoStack.pop();
    updateCount();
    saveDraftSoon();
    toast("Last change undone.");
  }

  function insertAtCursor(text) {
    if (!transcript) return;

    transcript.setRangeText(
        text,
        transcript.selectionStart,
        transcript.selectionEnd,
        "end"
    );

    transcript.focus();
    updateCount();
    saveDraftSoon();
  }

  function applyVoicePhrase(rawPhrase) {
    const phrase = String(rawPhrase || "").trim();
    if (!phrase) return "";

    const lower = phrase.toLowerCase().replace(/[.!?]+$/, "").trim();

    if (/^(undo that|undo last|go back)$/.test(lower)) {
      undo();
      return "";
    }

    if (/^(cancel that|scratch that|delete that|remove that|take that out)$/.test(lower)) {
      pushUndo();

      transcript.value = transcript.value
          .replace(/\s*[^.!?\n]+[.!?]?\s*$/, " ")
          .trimEnd();

      updateCount();
      saveDraftSoon();
      toast("Last phrase removed.");
      return "";
    }

    if (/^(new paragraph|start a new paragraph)$/.test(lower)) {
      pushUndo();
      transcript.value = transcript.value.trimEnd() + "\n\n";
      updateCount();
      saveDraftSoon();
      return "";
    }

    if (/^(new line|next line)$/.test(lower)) {
      pushUndo();
      transcript.value = transcript.value.trimEnd() + "\n";
      updateCount();
      saveDraftSoon();
      return "";
    }

    if (/^(delete last sentence|remove last sentence)$/.test(lower)) {
      pushUndo();

      transcript.value = transcript.value
          .replace(/(?:^|\s)[^.!?]*[.!?]?\s*$/, " ")
          .trimEnd();

      updateCount();
      saveDraftSoon();
      toast("Last sentence removed.");
      return "";
    }

    if (/^(period|full stop)$/.test(lower)) return ". ";
    if (lower === "comma") return ", ";
    if (lower === "question mark") return "? ";
    if (/^(exclamation mark|exclamation point)$/.test(lower)) return "! ";

    const change = phrase.match(/^change\s+(.+?)\s+to\s+(.+)$/i);

    if (change) {
      const oldText = change[1].trim();
      const newText = change[2].trim();

      const escaped = oldText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "ig");

      if (!regex.test(transcript.value)) {
        toast(`Couldn't find "${oldText}".`);
        return "";
      }

      pushUndo();
      transcript.value = transcript.value.replace(regex, newText);
      updateCount();
      saveDraftSoon();
      toast(`Changed "${oldText}" to "${newText}".`);
      return "";
    }

    if (/^(stop listening|stop dictation)$/.test(lower)) {
      stopDictation();
      return "";
    }

    return phrase;
  }

  function runCommand(command) {
    const cmd = String(command || "").toLowerCase().trim();

    if (!cmd) {
      toast("Enter a command first.");
      return;
    }

    if (cmd === "undo") return undo();
    if (cmd === "copy" || cmd === "copy text") return copyText();

    const current = transcript.value;

    if (cmd.includes("new paragraph")) {
      pushUndo();
      insertAtCursor("\n\n");
    } else if (cmd.includes("new line")) {
      pushUndo();
      insertAtCursor("\n");
    } else if (cmd.includes("clean") || cmd.includes("fix spacing")) {
      pushUndo();
      transcript.value = cleanText(current);
    } else if (cmd.includes("uppercase")) {
      pushUndo();
      transcript.value = current.toUpperCase();
    } else if (cmd.includes("lowercase")) {
      pushUndo();
      transcript.value = current.toLowerCase();
    } else if (cmd.includes("capitalize")) {
      pushUndo();
      transcript.value = current.replace(/\b\w/g, char => char.toUpperCase());
    } else if (cmd === "clear" || cmd.includes("clear text")) {
      pushUndo();
      transcript.value = "";
    } else if (/professional|summar|improve|translate|to-do|rewrite/.test(cmd)) {
      toast("Connect an AI model to enable this action.");
      return;
    } else {
      toast("Try clean text, uppercase, lowercase, capitalize, or new paragraph.");
      return;
    }

    updateCount();
    saveDraftSoon();
    toast("Text updated.");
  }

  $("undoButton")?.addEventListener("click", undo);
  $("cleanButton")?.addEventListener("click", () => runCommand("clean text"));

  $("runCommandButton")?.addEventListener("click", () => {
    runCommand($("commandInput").value);
    $("commandInput").value = "";
  });

  $("commandInput")?.addEventListener("keydown", event => {
    if (event.key === "Enter") $("runCommandButton")?.click();
  });

  document.querySelectorAll("[data-command]").forEach(button => {
    button.addEventListener("click", () => runCommand(button.dataset.command));
  });

  document.querySelectorAll("[data-ai-command]").forEach(button => {
    button.addEventListener("click", () => {
      setView("voiceView");

      if (transcript.value.trim()) {
        $("commandInput").value = button.dataset.aiCommand;
        toast("Command ready. Connect an AI model for advanced actions.");
      } else {
        toast("Add some text in your workspace first.");
      }
    });
  });

  $("copyButton")?.addEventListener("click", copyText);

  async function copyText() {
    if (!transcript?.value.trim()) {
      toast("There is no text to copy.");
      return;
    }

    try {
      await navigator.clipboard.writeText(transcript.value);
      toast("Copied to clipboard.");
    } catch {
      transcript.select();
      document.execCommand("copy");
      toast("Text copied.");
    }
  }

  // =========================================================
  // SPEECH-TO-TEXT — BROWSER RECOGNITION TEST
  // =========================================================

  function startTimer() {
    startedAt = Date.now();
    clearInterval(timerHandle);

    timerHandle = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      const timer = $("recordingTimer");

      if (timer) {
        timer.textContent =
            `${String(Math.floor(seconds / 60)).padStart(2, "0")}:` +
            `${String(seconds % 60).padStart(2, "0")}`;
      }
    }, 500);
  }

  function stopTimer() {
    clearInterval(timerHandle);
    timerHandle = null;
  }

  function setListeningUI(listening) {
    isRecording = listening;

    if ($("recordingStatus")) {
      $("recordingStatus").textContent =
          listening ? "Listening to you…" : "Ready when you are";
    }

    if ($("micHint")) {
      $("micHint").textContent =
          listening ? "Tap the microphone to stop" : "Tap to start speaking";
    }

    $("micButton")?.classList.toggle("recording", listening);
    $("waveform")?.classList.toggle("is-active", listening);

    if ($("micIcon")) {
      $("micIcon").textContent = listening ? "■" : "🎙";
    }

    if (listening) startTimer();
    else stopTimer();
  }

  function stopDictation() {
    shouldKeepListening = false;
    clearTimeout(recognitionRestartTimer);

    try {
      recognition?.stop();
    } catch {}

    setListeningUI(false);
  }

  function scheduleRecognitionRestart(sessionId) {
    clearTimeout(recognitionRestartTimer);

    if (!shouldKeepListening || recognitionBlocked) return;
    if (sessionId !== recognitionSessionId) return;

    recognitionRestartTimer = setTimeout(() => {
      if (!shouldKeepListening || recognitionBlocked) return;
      if (sessionId !== recognitionSessionId) return;

      startRecognitionSession();
    }, 500);
  }

  function setupRecognition(sessionId) {
    const SpeechRecognition =
        window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) return null;

    const rec = new SpeechRecognition();

    rec.continuous = true;

    // Interim results are deliberately disabled to prevent duplicate previews.
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.lang = $("languageSelect")?.value || "en-IN";

    const processedResults = new Set();

    rec.onstart = () => {
      if (sessionId !== recognitionSessionId) return;
      setListeningUI(true);
    };

    rec.onresult = event => {
      if (sessionId !== recognitionSessionId) return;

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const resultItem = event.results[i];

        if (!resultItem?.isFinal || processedResults.has(i)) continue;
        processedResults.add(i);

        const phrase = String(resultItem[0]?.transcript || "").trim();
        if (!phrase) continue;

        const committed = applyVoicePhrase(phrase);
        if (!committed) continue;

        // Prevent a repeated final result from being appended twice.
        const existing = transcript.value.trimEnd().toLocaleLowerCase();
        const incoming = committed.trim().toLocaleLowerCase();

        if (incoming && existing.endsWith(incoming)) continue;

        pushUndo();

        const needsSpace =
            transcript.value && !/[\s\n]$/.test(transcript.value);

        transcript.value += (needsSpace ? " " : "") + committed;
      }

      updateCount();
      saveDraftSoon();
    };

    rec.onerror = event => {
      if (sessionId !== recognitionSessionId) return;

      if (
          event.error === "not-allowed" ||
          event.error === "service-not-allowed"
      ) {
        recognitionBlocked = true;
        shouldKeepListening = false;
        toast("Allow microphone access in your browser.");
      } else if (event.error === "audio-capture") {
        recognitionBlocked = true;
        shouldKeepListening = false;
        toast("No microphone found. Check your microphone connection.");
      } else if (event.error === "language-not-supported") {
        recognitionBlocked = true;
        shouldKeepListening = false;
        toast("This language is not supported by your browser.");
      } else if (
          event.error !== "no-speech" &&
          event.error !== "aborted"
      ) {
        toast(`Voice recognition: ${event.error}`);
      }
    };

    rec.onend = () => {
      if (sessionId !== recognitionSessionId) return;

      setListeningUI(false);

      if (shouldKeepListening && !recognitionBlocked) {
        scheduleRecognitionRestart(sessionId);
      } else {
        shouldKeepListening = false;
      }
    };

    return rec;
  }

  function startRecognitionSession() {
    if (!shouldKeepListening || recognitionBlocked) return;

    clearTimeout(recognitionRestartTimer);

    // Each new session gets a fresh recognizer and fresh result indexes.
    recognitionSessionId += 1;
    const sessionId = recognitionSessionId;

    const newRecognition = setupRecognition(sessionId);

    if (!newRecognition) {
      shouldKeepListening = false;
      setListeningUI(false);
      toast("Speech recognition is unavailable. Try the latest Chrome or Edge.");
      return;
    }

    recognition = newRecognition;
    recognition.lang = $("languageSelect")?.value || "en-IN";

    try {
      recognition.start();
    } catch {
      scheduleRecognitionRestart(sessionId);
    }
  }

  $("micButton")?.addEventListener("click", () => {
    if (shouldKeepListening || isRecording) {
      stopDictation();
      return;
    }

    recognitionBlocked = false;
    shouldKeepListening = true;
    startRecognitionSession();
  });

  $("languageSelect")?.addEventListener("change", () => {
    const language = $("languageSelect").value;

    if ($("settingsLanguageSelect")) {
      $("settingsLanguageSelect").value = language;
    }

    if (shouldKeepListening) {
      stopDictation();
      recognitionBlocked = false;
      shouldKeepListening = true;
      startRecognitionSession();
    } else if (recognition && !isRecording) {
      recognition.lang = language;
    }
  });

  $("settingsLanguageSelect")?.addEventListener("change", () => {
    const language = $("settingsLanguageSelect").value;

    if ($("languageSelect")) {
      $("languageSelect").value = language;
    }

    try {
      localStorage.setItem("bloom-language", language);
    } catch {}

    if (shouldKeepListening) {
      stopDictation();
      recognitionBlocked = false;
      shouldKeepListening = true;
      startRecognitionSession();
    } else if (recognition && !isRecording) {
      recognition.lang = language;
    }

    toast("Language preference updated.");
  });

  // =========================================================
  // TEXT-TO-SPEECH — READ ALOUD
  // =========================================================

  const ttsLanguage = $("ttsLanguage");
  const ttsVoice = $("ttsVoice");
  const ttsRate = $("ttsRate");
  const speakButton = $("speakButton");
  const pauseSpeakButton = $("pauseSpeakButton");
  const stopSpeakButton = $("stopSpeakButton");

  const speechEngine =
      "speechSynthesis" in window ? window.speechSynthesis : null;

  let availableVoices = [];
  let currentUtterance = null;

  function normalizeLanguage(language) {
    return String(language || "")
        .toLowerCase()
        .replace(/_/g, "-");
  }

  function loadTTSVoices() {
    if (!speechEngine || !ttsVoice) return;

    availableVoices = speechEngine.getVoices();

    const language = normalizeLanguage(ttsLanguage?.value || "en-IN");
    const previousVoice = ttsVoice.value;

    const matchingVoices = availableVoices.filter(voice => {
      const voiceLanguage = normalizeLanguage(voice.lang);

      return voiceLanguage === language ||
          voiceLanguage.startsWith(`${language}-`);
    });

    const voicesToShow =
        matchingVoices.length ? matchingVoices : availableVoices;

    ttsVoice.innerHTML = "";

    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = matchingVoices.length
        ? "System default"
        : "System default (matching voice unavailable)";

    ttsVoice.appendChild(defaultOption);

    voicesToShow.forEach(voice => {
      const option = document.createElement("option");
      option.value = voice.voiceURI;
      option.textContent = `${voice.name} (${voice.lang})`;
      ttsVoice.appendChild(option);
    });

    if ([...ttsVoice.options].some(option => option.value === previousVoice)) {
      ttsVoice.value = previousVoice;
    }
  }

  if (speechEngine) {
    loadTTSVoices();

    if ("onvoiceschanged" in speechEngine) {
      speechEngine.addEventListener("voiceschanged", loadTTSVoices);
    }
  } else {
    if (speakButton) speakButton.disabled = true;
    if (pauseSpeakButton) pauseSpeakButton.disabled = true;
    if (stopSpeakButton) stopSpeakButton.disabled = true;
  }

  ttsLanguage?.addEventListener("change", () => {
    speechEngine?.cancel();
    currentUtterance = null;

    if (speakButton) speakButton.textContent = "▶ Read aloud";
    if (pauseSpeakButton) pauseSpeakButton.textContent = "Ⅱ Pause";

    loadTTSVoices();
  });

  speakButton?.addEventListener("click", () => {
    const text = transcript?.value?.trim();

    if (!text) {
      toast("Write or dictate some text first.");
      return;
    }

    if (!speechEngine || typeof SpeechSynthesisUtterance === "undefined") {
      toast("Text-to-speech is not supported in this browser.");
      return;
    }

    speechEngine.cancel();

    const utterance = new SpeechSynthesisUtterance(text);

    utterance.lang = ttsLanguage?.value || "en-IN";
    utterance.rate = Number(ttsRate?.value || 1);
    utterance.pitch = 1;

    const selectedVoice = availableVoices.find(
        voice => voice.voiceURI === ttsVoice?.value
    );

    if (selectedVoice) {
      utterance.voice = selectedVoice;
      utterance.lang = selectedVoice.lang;
    }

    utterance.onstart = () => {
      if (currentUtterance !== utterance) return;

      if (speakButton) speakButton.textContent = "▶ Reading…";
      if (pauseSpeakButton) pauseSpeakButton.textContent = "Ⅱ Pause";

      toast("Reading text aloud…");
    };

    utterance.onend = () => {
      if (currentUtterance !== utterance) return;

      currentUtterance = null;

      if (speakButton) speakButton.textContent = "▶ Read aloud";
      if (pauseSpeakButton) pauseSpeakButton.textContent = "Ⅱ Pause";
    };

    utterance.onerror = event => {
      if (currentUtterance !== utterance) return;

      currentUtterance = null;

      if (speakButton) speakButton.textContent = "▶ Read aloud";
      if (pauseSpeakButton) pauseSpeakButton.textContent = "Ⅱ Pause";

      if (
          event.error !== "canceled" &&
          event.error !== "interrupted"
      ) {
        toast("Speech playback failed. Try another installed voice.");
      }
    };

    currentUtterance = utterance;
    speechEngine.speak(utterance);
  });

  pauseSpeakButton?.addEventListener("click", () => {
    if (!speechEngine?.speaking) {
      toast("There is no speech playing.");
      return;
    }

    if (speechEngine.paused) {
      speechEngine.resume();
      pauseSpeakButton.textContent = "Ⅱ Pause";
      toast("Reading resumed.");
    } else {
      speechEngine.pause();
      pauseSpeakButton.textContent = "▶ Resume";
      toast("Reading paused.");
    }
  });

  stopSpeakButton?.addEventListener("click", () => {
    speechEngine?.cancel();
    currentUtterance = null;

    if (speakButton) speakButton.textContent = "▶ Read aloud";
    if (pauseSpeakButton) pauseSpeakButton.textContent = "Ⅱ Pause";

    toast("Reading stopped.");
  });

  // =========================================================
  // DOCUMENT MANAGEMENT
  // =========================================================

  function docIcon(id) {
    return ["mint", "pink", "violet", "blue", "orange"][id % 5];
  }

  function renderDocuments() {
    const query = ($("documentSearchInput")?.value || "")
        .toLowerCase()
        .trim();

    const filtered = documents.filter(doc =>
        `${doc.title} ${doc.content}`.toLowerCase().includes(query)
    );

    const list = $("documentsList");

    if (list) {
      list.innerHTML = filtered.map(doc => `
        <article class="document-row">
          <div class="doc-icon ${docIcon(doc.id)}">▤</div>
          <button class="document-open" data-open-doc="${doc.id}">
            <b>${escapeHtml(doc.title)}</b>
            <small>${escapeHtml((doc.content || "No text yet").slice(0, 100))}</small>
            <span>${escapeHtml(doc.updated_at || doc.created_at || "")}</span>
          </button>
          <button class="doc-delete" data-delete-doc="${doc.id}"
            aria-label="Delete ${escapeHtml(doc.title)}" title="Delete">⋯</button>
        </article>
      `).join("");

      list.querySelectorAll("[data-open-doc]").forEach(button => {
        button.addEventListener("click", () =>
            openDocument(Number(button.dataset.openDoc))
        );
      });

      list.querySelectorAll("[data-delete-doc]").forEach(button => {
        button.addEventListener("click", () =>
            deleteDocument(Number(button.dataset.deleteDoc))
        );
      });
    }

    $("emptyDocuments")?.classList.toggle("hidden", filtered.length !== 0);

    if ($("documentCountBadge")) {
      $("documentCountBadge").textContent =
          `${filtered.length} ${filtered.length === 1 ? "item" : "items"}`;
    }

    const homeList = $("homeDocumentsList");

    if (homeList) {
      homeList.innerHTML = documents.slice(0, 3).map(doc => `
        <article class="document-row">
          <div class="doc-icon ${docIcon(doc.id)}">▤</div>
          <button class="document-open" data-home-open="${doc.id}">
            <b>${escapeHtml(doc.title)}</b>
            <small>${escapeHtml((doc.content || "No text yet").slice(0, 76))}</small>
            <span>${escapeHtml(doc.updated_at || doc.created_at || "")}</span>
          </button>
          <span class="row-chevron">›</span>
        </article>
      `).join("");

      homeList.querySelectorAll("[data-home-open]").forEach(button => {
        button.addEventListener("click", () =>
            openDocument(Number(button.dataset.homeOpen))
        );
      });
    }

    $("homeDocumentsEmpty")?.classList.toggle("hidden", documents.length > 0);
  }

  async function loadDocuments() {
    try {
      documents = await api("/api/documents");
      renderDocuments();
    } catch (error) {
      toast(error.message);
    }
  }

  async function saveDocument() {
    const content = transcript.value.trim();

    if (!content) {
      toast("Add some text before saving.");
      return;
    }

    const title = titleInput?.value.trim() ||
        content.split(/\s+/).slice(0, 5).join(" ") ||
        "Untitled Document";

    try {
      const saved = activeDocumentId
          ? await api(`/api/documents/${activeDocumentId}`, {
            method: "PUT",
            body: JSON.stringify({ title, content })
          })
          : await api("/api/documents", {
            method: "POST",
            body: JSON.stringify({ title, content })
          });

      activeDocumentId = saved.id;

      if (titleInput) titleInput.value = saved.title;

      toast("Document saved to your Bloom account.");
      await loadDocuments();
    } catch (error) {
      toast(error.message);
    }
  }

  $("saveButton")?.addEventListener("click", saveDocument);

  function newDocument() {
    pushUndo();

    activeDocumentId = null;
    transcript.value = "";

    if (titleInput) titleInput.value = "";

    updateCount();
    saveDraftSoon();
    setView("voiceView");
    toast("A fresh document is ready.");
  }

  $("newDocumentButton")?.addEventListener("click", newDocument);
  $("homeNewDocument")?.addEventListener("click", newDocument);
  $("startWritingButton")?.addEventListener("click", newDocument);
  $("quickNoteButton")?.addEventListener("click", newDocument);
  $("quickWriteButton")?.addEventListener("click", newDocument);

  $("documentSearchInput")?.addEventListener("input", renderDocuments);

  async function openDocument(id) {
    try {
      const doc = await api(`/api/documents/${id}`);

      activeDocumentId = doc.id;
      transcript.value = doc.content || "";

      if (titleInput) titleInput.value = doc.title || "";

      updateCount();
      setView("voiceView");
      toast("Document opened.");
    } catch (error) {
      toast(error.message);
    }
  }

  async function deleteDocument(id) {
    if (!confirm("Delete this document permanently?")) return;

    try {
      await api(`/api/documents/${id}`, { method: "DELETE" });

      if (activeDocumentId === id) {
        activeDocumentId = null;
        transcript.value = "";

        if (titleInput) titleInput.value = "";

        updateCount();
      }

      toast("Document deleted.");
      await loadDocuments();
    } catch (error) {
      toast(error.message);
    }
  }

  $("clearDocumentsButton")?.addEventListener("click", async () => {
    if (!confirm("Delete all your saved documents? This cannot be undone.")) {
      return;
    }

    try {
      const latest = await api("/api/documents");

      for (const doc of latest) {
        await api(`/api/documents/${doc.id}`, { method: "DELETE" });
      }

      activeDocumentId = null;
      documents = [];

      renderDocuments();
      toast("All saved documents deleted.");
    } catch (error) {
      toast(error.message);
    }
  });

  $("uploadHintButton")?.addEventListener("click", () => {
    toast("File upload is planned for a future version.");
  });

  // =========================================================
  // RESTORE DRAFT AND PREFERENCES
  // =========================================================

  async function restoreDraft() {
    try {
      const draft = await api("/api/draft");

      if (transcript && !transcript.value.trim()) {
        transcript.value = draft.content || "";
      }

      let savedLanguage = null;

      try {
        savedLanguage = localStorage.getItem("bloom-language");
      } catch {}

      if (savedLanguage && $("languageSelect")) {
        $("languageSelect").value = savedLanguage;
      }

      if (savedLanguage && $("settingsLanguageSelect")) {
        $("settingsLanguageSelect").value = savedLanguage;
      }

      updateCount();
    } catch {
      // The workspace remains usable if draft restoration fails.
    }
  }

  // =========================================================
  // INITIALIZATION
  // =========================================================

  updateCount();
  restoreDraft();
  loadDocuments();
})();
