/*(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const views = ["homeView", "voiceView", "documentsView", "settingsView"];
  const transcript = $("transcript");
  const titleInput = $("documentTitle");
  const toastEl = $("toast");
  let recognition = null;
  let isRecording = false;
  let startedAt = 0;
  let timerHandle = null;
  let undoStack = [];
  let activeDocumentId = null;
  let documents = [];
  let toastTimer = null;

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
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options
    });
    if (response.status === 401) { window.location.href = "/login"; throw new Error("Please sign in again."); }
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || "Something went wrong.");
    return data;
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  }
  function setView(viewId) {
    if (!views.includes(viewId)) return;
    views.forEach(id => {
      const el = $(id);
      if (el) { el.classList.toggle("active-view", id === viewId); el.classList.toggle("hidden", id !== viewId); }
    });
    document.querySelectorAll("[data-view]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.view === viewId);
    });
    document.querySelector(".sidebar")?.classList.remove("sidebar-open");
    if (viewId === "documentsView") loadDocuments();
    if (viewId === "homeView") loadDocuments();
    if (viewId === "voiceView") setTimeout(() => transcript?.focus({ preventScroll: true }), 80);
  }
  document.querySelectorAll("[data-view]").forEach(btn => btn.addEventListener("click", () => setView(btn.dataset.view)));
  $("mobileMenu")?.addEventListener("click", () => document.querySelector(".sidebar")?.classList.toggle("sidebar-open"));

  function updateCount() {
    const value = transcript?.value || "";
    const words = value.trim() ? value.trim().split(/\s+/).length : 0;
    if ($("wordCount")) $("wordCount").textContent = `${words} words · ${value.length} characters`;
  }
  function pushUndo() {
    if (!transcript) return;
    undoStack.push(transcript.value);
    if (undoStack.length > 40) undoStack.shift();
  }
  transcript?.addEventListener("beforeinput", () => pushUndo());
  transcript?.addEventListener("input", () => { updateCount(); saveDraftSoon(); });
  let draftTimer;
  function saveDraftSoon() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => api("/api/draft", { method: "PUT", body: JSON.stringify({ content: transcript.value }) }).catch(() => {}), 700);
  }

  function cleanText(value) {
    return value.replace(/[ \t]+/g, " ").replace(/\s+([,.!?;:])/g, "$1")
      .replace(/([,.!?])(?=[A-Za-z])/g, "$1 ")
      .replace(/\n{3,}/g, "\n\n").trim();
  }
  function applyVoicePhrase(rawPhrase) {
    const phrase = String(rawPhrase || "").trim();
    if (!phrase) return "";
    const lower = phrase.toLowerCase().replace(/[.!?]+$/, "").trim();
    // Spoken editing commands are intercepted instead of being inserted as dictation.
    if (/^(undo that|undo last|go back)$/.test(lower)) { undo(); return ""; }
    if (/^(cancel that|scratch that|delete that|remove that|take that out)$/.test(lower)) {
      pushUndo();
      transcript.value = transcript.value.replace(/\s*[^.!?\n]+[.!?]?\s*$/, " ").trimEnd();
      updateCount(); saveDraftSoon(); toast("Last phrase removed."); return "";
    }
    if (/^(new paragraph|start a new paragraph)$/.test(lower)) { pushUndo(); transcript.value = transcript.value.trimEnd() + "\n\n"; updateCount(); saveDraftSoon(); return ""; }
    if (/^(new line|next line)$/.test(lower)) { pushUndo(); transcript.value = transcript.value.trimEnd() + "\n"; updateCount(); saveDraftSoon(); return ""; }
    if (/^(delete last sentence|remove last sentence)$/.test(lower)) { pushUndo(); transcript.value = transcript.value.replace(/(?:^|\s)[^.!?]*[.!?]?\s*$/, " ").trimEnd(); updateCount(); saveDraftSoon(); toast("Last sentence removed."); return ""; }
    if (/^(period|full stop)$/.test(lower)) return ". ";
    if (/^(comma)$/.test(lower)) return ", ";
    if (/^(question mark)$/.test(lower)) return "? ";
    if (/^(exclamation mark|exclamation point)$/.test(lower)) return "! ";
    const change = phrase.match(/^change\s+(.+?)\s+to\s+(.+)$/i);
    if (change) {
      const oldText = change[1].trim(), newText = change[2].trim();
      if (!oldText || !newText) { toast("Say: change old words to new words."); return ""; }
      const escaped = oldText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "ig");
      if (!regex.test(transcript.value)) { toast(`Couldn't find “${oldText}”.`); return ""; }
      pushUndo(); transcript.value = transcript.value.replace(regex, newText); updateCount(); saveDraftSoon(); toast(`Changed “${oldText}” to “${newText}”.`); return "";
    }
    if (/^(stop listening|stop dictation)$/.test(lower)) { recognition?.stop(); return ""; }
    return phrase;
  }

  function runCommand(command) {
    const cmd = command.toLowerCase().trim();
    if (!cmd) { toast("Enter a command first."); return; }
    if (cmd === "undo") { undo(); return; }
    if (cmd === "copy text" || cmd === "copy") { copyText(); return; }
    pushUndo();
    const current = transcript.value;
    if (cmd.includes("clear text") || cmd === "clear") transcript.value = "";
    else if (cmd.includes("new paragraph")) insertAtCursor("\n\n");
    else if (cmd.includes("new line")) insertAtCursor("\n");
    else if (cmd.includes("clean") || cmd.includes("fix spacing")) transcript.value = cleanText(current);
    else if (cmd.includes("uppercase")) transcript.value = current.toUpperCase();
    else if (cmd.includes("lowercase")) transcript.value = current.toLowerCase();
    else if (cmd.includes("capitalize")) transcript.value = current.replace(/\b\w/g, c => c.toUpperCase());
    else if (cmd.includes("professional") || cmd.includes("summar") || cmd.includes("improve") || cmd.includes("translate") || cmd.includes("to-do") || cmd.includes("rewrite")) {
      toast("Connect an AI model to enable this action.");
      undoStack.pop();
      return;
    } else {
      toast("Try clean text, uppercase, lowercase, capitalize, or new paragraph.");
      undoStack.pop();
      return;
    }
    updateCount(); saveDraftSoon(); toast("Text updated.");
  }
  function insertAtCursor(text) {
    const start = transcript.selectionStart, end = transcript.selectionEnd;
    transcript.setRangeText(text, start, end, "end");
    transcript.focus();
    updateCount(); saveDraftSoon();
  }
  function undo() {
    if (!undoStack.length) { toast("Nothing to undo yet."); return; }
    transcript.value = undoStack.pop(); updateCount(); saveDraftSoon(); toast("Last change undone.");
  }
  $("undoButton")?.addEventListener("click", undo);
  $("cleanButton")?.addEventListener("click", () => runCommand("clean text"));
  $("runCommandButton")?.addEventListener("click", () => { runCommand($("commandInput").value); $("commandInput").value = ""; });
  $("commandInput")?.addEventListener("keydown", e => { if (e.key === "Enter") $("runCommandButton").click(); });
  document.querySelectorAll("[data-command]").forEach(btn => btn.addEventListener("click", () => runCommand(btn.dataset.command)));
  document.querySelectorAll("[data-ai-command]").forEach(btn => btn.addEventListener("click", () => {
    const command = btn.dataset.aiCommand;
    if (transcript.value.trim()) { $("commandInput").value = command; setView("voiceView"); toast("Command ready. Connect an AI model for advanced actions."); }
    else { setView("voiceView"); toast("Add some text in your workspace first."); }
  }));
  $("copyButton")?.addEventListener("click", copyText);
  async function copyText() {
    if (!transcript.value.trim()) return toast("There is no text to copy.");
    try { await navigator.clipboard.writeText(transcript.value); toast("Copied to clipboard."); }
    catch { transcript.select(); document.execCommand("copy"); toast("Text copied."); }
  }

  function startTimer() {
    startedAt = Date.now();
    clearInterval(timerHandle);
    timerHandle = setInterval(() => {
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      $("recordingTimer").textContent = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
    }, 500);
  }
  function stopTimer() { clearInterval(timerHandle); timerHandle = null; }
  function setupRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return null;
    const rec = new SpeechRecognition();
    rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
    rec.lang = $("languageSelect")?.value || "en-IN";
    let finalText = "";
    rec.onstart = () => {
      isRecording = true; $("recordingStatus").textContent = "Listening to you…";
      $("micHint").textContent = "Tap the microphone to stop"; $("micButton").classList.add("recording");
      $("waveform").classList.add("is-active"); $("micIcon").textContent = "■"; startTimer();
    };
    rec.onresult = event => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const phrase = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          const before = transcript.value;
          const result = applyVoicePhrase(phrase);
          if (result) {
            if (!undoStack.length || undoStack[undoStack.length - 1] !== before) pushUndo();
            const needsSpace = transcript.value && !/[\s\n]$/.test(transcript.value);
            transcript.value += (needsSpace ? " " : "") + result;
          }
          finalText = transcript.value;
        } else interim += phrase;
      }
      // Interim words are previewed but are not committed until the browser finalizes them.
      if (interim) {
        const base = transcript.value;
        transcript.dataset.interimBase = base;
        const needsSpace = base && !/[\s\n]$/.test(base);
        transcript.value = base + (needsSpace ? " " : "") + interim;
      }
      updateCount(); saveDraftSoon();
    };
    rec.onerror = event => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") toast("Allow microphone access in your browser.");
      else if (event.error !== "no-speech") toast(`Voice recognition: ${event.error}`);
    };
    rec.onend = () => {
      isRecording = false; stopTimer();
      $("recordingStatus").textContent = "Ready when you are";
      $("micHint").textContent = "Tap to start speaking"; $("micButton").classList.remove("recording");
      $("waveform").classList.remove("is-active"); $("micIcon").textContent = "🎙";
      finalText = transcript.value ? transcript.value + " " : "";
    };
    rec._resetFinal = () => { finalText = transcript.value ? transcript.value + " " : ""; };
    return rec;
  }
  $("micButton")?.addEventListener("click", () => {
    if (isRecording) { recognition?.stop(); return; }
    if (!recognition) recognition = setupRecognition();
    if (!recognition) return toast("Voice recognition is not supported in this browser. Try Chrome or Edge.");
    recognition.lang = $("languageSelect").value;
    recognition._resetFinal();
    try { recognition.start(); } catch { toast("Voice input is already starting. Please wait."); }
  });
  $("languageSelect")?.addEventListener("change", () => {
    if ($("settingsLanguageSelect")) $("settingsLanguageSelect").value = $("languageSelect").value;
  });
  $("settingsLanguageSelect")?.addEventListener("change", () => {
    if ($("languageSelect")) $("languageSelect").value = $("settingsLanguageSelect").value;
    try { localStorage.setItem("bloom-language", $("settingsLanguageSelect").value); } catch {}
    toast("Language preference updated.");
  });

  // Voice is handled by the local Windows companion, not browser speech APIs.
  $("speakButton")?.addEventListener("click", () => {
    const text = transcript?.value?.trim();
    if (!text) return toast("Write some text first.");
    toast("For local text-to-speech, run the Windows voice companion and use its speak command. Browser speech is disabled.");
  });
  $("pauseSpeakButton")?.addEventListener("click", () => toast("Pause/resume is available in the local voice companion."));
  $("stopSpeakButton")?.addEventListener("click", () => toast("Stop speech in the local voice companion."));

  function docIcon(id) { return ["mint", "pink", "violet", "blue", "orange"][id % 5]; }
  function renderDocuments() {
    const query = ($("documentSearchInput")?.value || "").toLowerCase().trim();
    const filtered = documents.filter(d => `${d.title} ${d.content}`.toLowerCase().includes(query));
    const list = $("documentsList");
    if (list) {
      list.innerHTML = filtered.map(d => `<article class="document-row"><div class="doc-icon ${docIcon(d.id)}">▤</div><button class="document-open" data-open-doc="${d.id}"><b>${escapeHtml(d.title)}</b><small>${escapeHtml((d.content || "No text yet").slice(0, 100))}</small><span>${escapeHtml(d.updated_at || d.created_at || "")}</span></button><button class="doc-delete" data-delete-doc="${d.id}" aria-label="Delete ${escapeHtml(d.title)}" title="Delete">⋯</button></article>`).join("");
      list.querySelectorAll("[data-open-doc]").forEach(btn => btn.addEventListener("click", () => openDocument(Number(btn.dataset.openDoc))));
      list.querySelectorAll("[data-delete-doc]").forEach(btn => btn.addEventListener("click", () => deleteDocument(Number(btn.dataset.deleteDoc))));
    }
    const empty = $("emptyDocuments");
    if (empty) empty.classList.toggle("hidden", filtered.length !== 0);
    if ($("documentCountBadge")) $("documentCountBadge").textContent = `${filtered.length} ${filtered.length === 1 ? "item" : "items"}`;
    const recent = documents.slice(0, 3);
    const homeList = $("homeDocumentsList");
    if (homeList) homeList.innerHTML = recent.map(d => `<article class="document-row"><div class="doc-icon ${docIcon(d.id)}">▤</div><button class="document-open" data-home-open="${d.id}"><b>${escapeHtml(d.title)}</b><small>${escapeHtml((d.content || "No text yet").slice(0, 76))}</small><span>${escapeHtml(d.updated_at || d.created_at || "")}</span></button><span class="row-chevron">›</span></article>`).join("");
    homeList?.querySelectorAll("[data-home-open]").forEach(btn => btn.addEventListener("click", () => openDocument(Number(btn.dataset.homeOpen))));
    $("homeDocumentsEmpty")?.classList.toggle("hidden", documents.length > 0);
  }
  async function loadDocuments() {
    try { documents = await api("/api/documents"); renderDocuments(); }
    catch (error) { toast(error.message); }
  }
  async function saveDocument() {
    const content = transcript.value.trim();
    if (!content) return toast("Add some text before saving.");
    const title = (titleInput?.value || "").trim() || content.split(/\s+/).slice(0, 5).join(" ") || "Untitled Document";
    try {
      const saved = activeDocumentId
        ? await api(`/api/documents/${activeDocumentId}`, { method: "PUT", body: JSON.stringify({ title, content }) })
        : await api("/api/documents", { method: "POST", body: JSON.stringify({ title, content }) });
      activeDocumentId = saved.id;
      if (titleInput) titleInput.value = saved.title;
      toast("Document saved to your Bloom account.");
      await loadDocuments();
    } catch (error) { toast(error.message); }
  }
  $("saveButton")?.addEventListener("click", saveDocument);
  function newDocument() {
    pushUndo(); activeDocumentId = null; transcript.value = ""; if (titleInput) titleInput.value = "";
    updateCount(); saveDraftSoon(); setView("voiceView"); toast("A fresh document is ready.");
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
      activeDocumentId = doc.id; transcript.value = doc.content || "";
      if (titleInput) titleInput.value = doc.title || "";
      updateCount(); setView("voiceView"); toast("Document opened.");
    } catch (error) { toast(error.message); }
  }
  async function deleteDocument(id) {
    if (!confirm("Delete this document permanently?")) return;
    try {
      await api(`/api/documents/${id}`, { method: "DELETE" });
      if (activeDocumentId === id) { activeDocumentId = null; transcript.value = ""; if (titleInput) titleInput.value = ""; updateCount(); }
      toast("Document deleted."); await loadDocuments();
    } catch (error) { toast(error.message); }
  }
  $("clearDocumentsButton")?.addEventListener("click", async () => {
    if (!confirm("Delete all your saved documents? This cannot be undone.")) return;
    try {
      const latest = await api("/api/documents");
      for (const doc of latest) await api(`/api/documents/${doc.id}`, { method: "DELETE" });
      activeDocumentId = null; documents = []; renderDocuments(); toast("All saved documents deleted.");
    } catch (error) { toast(error.message); }
  });
  $("uploadHintButton")?.addEventListener("click", () => toast("File upload is planned for a future version."));

  async function restoreDraft() {
    try {
      const draft = await api("/api/draft");
      if (transcript && !transcript.value.trim()) transcript.value = draft.content || "";
      const savedLanguage = localStorage.getItem("bloom-language");
      if (savedLanguage && $("languageSelect")) $("languageSelect").value = savedLanguage;
      if (savedLanguage && $("settingsLanguageSelect")) $("settingsLanguageSelect").value = savedLanguage;
      updateCount();
    } catch {}
  }
  updateCount();
  restoreDraft();
  loadDocuments();
})();
*/

(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const views = ["homeView", "voiceView", "documentsView", "settingsView"];
  const transcript = $("transcript");
  const titleInput = $("documentTitle");
  const toastEl = $("toast");

  let recognition = null;
  let isRecording = false;
  let timerHandle = null;
  let startedAt = 0;
  let undoStack = [];
  let activeDocumentId = null;
  let documents = [];
  let toastTimer = null;
  let draftTimer = null;

  // =====================================================
  // GENERAL HELPERS
  // =====================================================

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
      const el = $(id);
      if (!el) return;
      el.classList.toggle("active-view", id === viewId);
      el.classList.toggle("hidden", id !== viewId);
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

  // =====================================================
  // UNDO AND TEXT EDITING
  // =====================================================

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
      transcript.value = current.replace(/\b\w/g, c => c.toUpperCase());
    } else if (cmd === "clear" || cmd.includes("clear text")) {
      pushUndo();
      transcript.value = "";
    } else if (
        /professional|summar|improve|translate|to-do|rewrite/.test(cmd)
    ) {
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

  // =====================================================
  // VOICE DICTATION
  // =====================================================

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

  function applyVoicePhrase(raw) {
    const phrase = String(raw || "").trim();
    if (!phrase) return "";

    const lower = phrase.toLowerCase().replace(/[.!?]+$/, "").trim();

    if (/^(undo that|undo last|go back)$/.test(lower)) {
      undo();
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
        toast(`Couldn't find “${oldText}”.`);
        return "";
      }

      pushUndo();
      transcript.value = transcript.value.replace(regex, newText);
      updateCount();
      saveDraftSoon();
      toast(`Changed “${oldText}” to “${newText}”.`);
      return "";
    }

    if (/^(stop listening|stop dictation)$/.test(lower)) {
      recognition?.stop();
      return "";
    }

    return phrase;
  }

  function setupRecognition() {
    const SpeechRecognition =
        window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) return null;

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = $("languageSelect")?.value || "en-IN";

    let interimPreview = "";

    rec.onstart = () => {
      isRecording = true;
      $("recordingStatus").textContent = "Listening to you…";
      $("micHint").textContent = "Tap the microphone to stop";
      $("micButton")?.classList.add("recording");
      $("waveform")?.classList.add("is-active");
      $("micIcon").textContent = "■";
      startTimer();
    };

    rec.onresult = event => {
      let interim = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const phrase = event.results[i][0].transcript;

        if (event.results[i].isFinal) {
          if (interimPreview) {
            transcript.value = transcript.value.slice(0, -interimPreview.length);
            interimPreview = "";
          }

          const before = transcript.value;
          const result = applyVoicePhrase(phrase);

          if (result) {
            if (!undoStack.length || undoStack[undoStack.length - 1] !== before) {
              pushUndo();
            }

            const needsSpace =
                transcript.value && !/[\s\n]$/.test(transcript.value);

            transcript.value += (needsSpace ? " " : "") + result;
          }
        } else {
          interim += phrase;
        }
      }

      if (interimPreview) {
        transcript.value = transcript.value.slice(0, -interimPreview.length);
        interimPreview = "";
      }

      if (interim) {
        const needsSpace = transcript.value && !/[\s\n]$/.test(transcript.value);
        interimPreview = (needsSpace ? " " : "") + interim;
        transcript.value += interimPreview;
      }

      updateCount();
      saveDraftSoon();
    };

    rec.onerror = event => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        toast("Allow microphone access in your browser.");
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        toast(`Voice recognition: ${event.error}`);
      }
    };

    rec.onend = () => {
      isRecording = false;
      stopTimer();

      if (interimPreview) {
        transcript.value = transcript.value.slice(0, -interimPreview.length);
        interimPreview = "";
        updateCount();
        saveDraftSoon();
      }

      $("recordingStatus").textContent = "Ready when you are";
      $("micHint").textContent = "Tap to start speaking";
      $("micButton")?.classList.remove("recording");
      $("waveform")?.classList.remove("is-active");
      $("micIcon").textContent = "🎙";
    };

    return rec;
  }

  $("micButton")?.addEventListener("click", () => {
    if (isRecording) {
      recognition?.stop();
      return;
    }

    if (!recognition) recognition = setupRecognition();

    if (!recognition) {
      toast("Voice recognition is not supported. Try Chrome or Edge.");
      return;
    }

    recognition.lang = $("languageSelect")?.value || "en-IN";

    try {
      recognition.start();
    } catch {
      toast("Voice input is already starting. Please wait.");
    }
  });

  $("languageSelect")?.addEventListener("change", () => {
    if ($("settingsLanguageSelect")) {
      $("settingsLanguageSelect").value = $("languageSelect").value;
    }
    if (recognition && !isRecording) {
      recognition.lang = $("languageSelect").value;
    }
  });

  $("settingsLanguageSelect")?.addEventListener("change", () => {
    const language = $("settingsLanguageSelect").value;

    if ($("languageSelect")) $("languageSelect").value = language;

    try {
      localStorage.setItem("bloom-language", language);
    } catch {}

    if (recognition && !isRecording) recognition.lang = language;
    toast("Language preference updated.");
  });

  // =====================================================
  // TEXT TO SPEECH — READ ALOUD
  // =====================================================

  const ttsLanguage = $("ttsLanguage");
  const ttsVoice = $("ttsVoice");
  const ttsRate = $("ttsRate");
  const speakButton = $("speakButton");
  const pauseSpeakButton = $("pauseSpeakButton");
  const stopSpeakButton = $("stopSpeakButton");

  const speechEngine = "speechSynthesis" in window
      ? window.speechSynthesis
      : null;

  let availableVoices = [];
  let currentUtterance = null;

  function normalizeLanguage(language) {
    return String(language || "").toLowerCase().replace(/_/g, "-");
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

    const list = matchingVoices.length ? matchingVoices : availableVoices;

    ttsVoice.innerHTML = "";

    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = matchingVoices.length
        ? "System default"
        : "System default (matching voice unavailable)";

    ttsVoice.appendChild(defaultOption);

    list.forEach(voice => {
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
    speechEngine.addEventListener("voiceschanged", loadTTSVoices);
  } else {
    if (speakButton) speakButton.disabled = true;
    if (pauseSpeakButton) pauseSpeakButton.disabled = true;
    if (stopSpeakButton) stopSpeakButton.disabled = true;
  }

  ttsLanguage?.addEventListener("change", () => {
    if (speechEngine?.speaking) speechEngine.cancel();

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
      speakButton.textContent = "▶ Reading…";
      pauseSpeakButton.textContent = "Ⅱ Pause";
      toast("Reading text aloud…");
    };

    utterance.onend = () => {
      if (currentUtterance !== utterance) return;
      currentUtterance = null;
      speakButton.textContent = "▶ Read aloud";
      pauseSpeakButton.textContent = "Ⅱ Pause";
    };

    utterance.onerror = event => {
      if (currentUtterance !== utterance) return;

      currentUtterance = null;
      speakButton.textContent = "▶ Read aloud";
      pauseSpeakButton.textContent = "Ⅱ Pause";

      if (event.error !== "canceled" && event.error !== "interrupted") {
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

  // =====================================================
  // DOCUMENT MANAGEMENT
  // =====================================================

  function docIcon(id) {
    return ["mint", "pink", "violet", "blue", "orange"][id % 5];
  }

  function renderDocuments() {
    const query = ($("documentSearchInput")?.value || "").toLowerCase().trim();
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
    if (!confirm("Delete all your saved documents? This cannot be undone.")) return;

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

  // =====================================================
  // RESTORE SAVED DRAFT AND PREFERENCES
  // =====================================================

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
      // Keep the workspace usable if restoring the draft fails.
    }
  }

  updateCount();
  restoreDraft();
  loadDocuments();
})();
