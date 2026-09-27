(function () {
  const textArea = document.getElementById("clipboardText");
  const preview = document.getElementById("preview");
  const pasteBtn = document.getElementById("pasteBtn");
  const copyBtn = document.getElementById("copyBtn");
  const saveBtn = document.getElementById("saveBtn");
  const clearBtn = document.getElementById("clearBtn");
  const editorBtn = document.getElementById("editorBtn");
  const previewBtn = document.getElementById("previewBtn");
  const historyList = document.getElementById("historyList");
  const charCount = document.getElementById("charCount");
  const byteCount = document.getElementById("byteCount");
  const lastSaved = document.getElementById("lastSaved");
  const connection = document.getElementById("connection");
  const toastHost = document.getElementById("toastHost");
  const clearHistoryBtn = document.getElementById("clearHistoryBtn");
  const conflictToast = document.getElementById("conflictToast");
  const openIncomingBtn = document.getElementById("openIncomingBtn");
  const keepCurrentBtn = document.getElementById("keepCurrentBtn");
  const themeToggle = document.getElementById("themeToggle");
  const csrfToken = document.querySelector("meta[name='csrf-token']").content;
  const clipboardTab = document.getElementById("clipboardTab");
  const filesTab = document.getElementById("filesTab");
  const clipboardView = document.getElementById("clipboardView");
  const filesView = document.getElementById("filesView");
  const chooseFilesBtn = document.getElementById("chooseFilesBtn");
  const fileInput = document.getElementById("fileInput");
  const dropZone = document.getElementById("dropZone");
  const uploadQueue = document.getElementById("uploadQueue");
  const fileList = document.getElementById("fileList");
  const storageUsage = document.getElementById("storageUsage");

  let currentEntry = null;
  let savedText = "";
  let dirty = false;
  let incomingEntry = null;
  let ws = null;
  let reconnectTimer = null;

  function request(path, options) {
    const opts = options || {};
    opts.headers = Object.assign({
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken
    }, opts.headers || {});
    return fetch(path, opts).then(async (response) => {
      if (!response.ok) {
        const body = await response.json().catch(() => ({ detail: "Ошибка запроса" }));
        throw new Error(body.detail || "Ошибка запроса");
      }
      if (response.status === 204) return null;
      return response.json();
    });
  }

  function toast(message) {
    const node = document.createElement("div");
    node.className = "toast";
    node.textContent = message;
    toastHost.appendChild(node);
    setTimeout(() => node.remove(), 2200);
  }

  function bytesOf(value) {
    return new TextEncoder().encode(value).length;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 10240 ? 0 : 1)} КБ`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} ГБ`;
  }

  function formatDate(value) {
    if (!value) return "нет данных";
    return new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "short",
      timeStyle: "medium"
    }).format(new Date(value));
  }

  function fileWord(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return "файл";
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "файла";
    return "файлов";
  }

  function updateMeta() {
    const value = textArea.value;
    charCount.textContent = `${Array.from(value).length} символов`;
    byteCount.textContent = formatBytes(bytesOf(value));
  }

  function setEntry(entry, notify) {
    currentEntry = entry;
    savedText = entry ? entry.text : "";
    textArea.value = savedText;
    dirty = false;
    lastSaved.textContent = `Последнее сохранение: ${entry ? formatDate(entry.updated_at) : "нет данных"}`;
    updateMeta();
    renderPreview();
    if (notify) toast("Получен новый текст");
  }

  function safeLink(url) {
    try {
      const parsed = new URL(url, window.location.origin);
      return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? url : "";
    } catch (_error) {
      return "";
    }
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function inlineMarkdown(value) {
    let output = escapeHtml(value);
    output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
    output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    output = output.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
      const cleanHref = safeLink(href);
      return cleanHref ? `<a href="${escapeHtml(cleanHref)}" rel="noreferrer" target="_blank">${label}</a>` : label;
    });
    return output;
  }

  function renderTable(lines) {
    const rows = lines.map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => inlineMarkdown(cell.trim())));
    const head = rows[0] || [];
    const body = rows.slice(2);
    return `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }

  function markdownToHtml(markdown) {
    const lines = markdown.split(/\r?\n/);
    const html = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const code = [];
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i])) {
          code.push(lines[i]);
          i += 1;
        }
        html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      } else if (/^\|.+\|$/.test(line) && lines[i + 1] && /^\|?[\s:-]+\|/.test(lines[i + 1])) {
        const table = [];
        while (i < lines.length && /^\|.+\|$/.test(lines[i])) {
          table.push(lines[i]);
          i += 1;
        }
        html.push(renderTable(table));
        continue;
      } else if (/^#{1,3}\s+/.test(line)) {
        const level = line.match(/^#+/)[0].length;
        html.push(`<h${level}>${inlineMarkdown(line.replace(/^#{1,3}\s+/, ""))}</h${level}>`);
      } else if (/^>\s?/.test(line)) {
        html.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ""))}</blockquote>`);
      } else if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(`<li>${inlineMarkdown(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`);
          i += 1;
        }
        html.push(`<ul>${items.join("")}</ul>`);
        continue;
      } else if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(`<li>${inlineMarkdown(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
          i += 1;
        }
        html.push(`<ol>${items.join("")}</ol>`);
        continue;
      } else if (line.trim() === "") {
        html.push("");
      } else {
        html.push(`<p>${inlineMarkdown(line)}</p>`);
      }
      i += 1;
    }
    return html.join("\n");
  }

  function renderPreview() {
    preview.innerHTML = markdownToHtml(textArea.value);
  }

  function switchMode(mode) {
    const viewing = mode === "preview";
    preview.classList.toggle("hidden", !viewing);
    textArea.classList.toggle("hidden", viewing);
    editorBtn.classList.toggle("active", !viewing);
    previewBtn.classList.toggle("active", viewing);
    if (viewing) renderPreview();
  }

  async function loadInitial() {
    const latest = await request("/api/clipboard");
    setEntry(latest, false);
    await loadHistory();
  }

  async function loadHistory() {
    const data = await request("/api/history");
    historyList.innerHTML = "";
    if (!data.items.length) {
      historyList.innerHTML = "<p class=\"history-time\">История пуста.</p>";
      return;
    }
    data.items.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "history-item";
      const previewText = entry.text.length > 180 ? `${entry.text.slice(0, 180)}...` : entry.text;
      item.innerHTML = `
        <div class="history-preview"></div>
        <div><span class="history-time">${formatDate(entry.updated_at)}</span> · <span class="history-size">${formatBytes(entry.size_bytes)}</span></div>
        <div class="history-actions">
          <button type="button" data-open="${entry.id}">Открыть</button>
          <button type="button" data-copy="${entry.id}">Копировать</button>
          <button type="button" class="danger ghost" data-delete="${entry.id}">Удалить</button>
        </div>`;
      item.querySelector(".history-preview").textContent = previewText;
      historyList.appendChild(item);
    });
  }

  function switchSection(section) {
    const showFiles = section === "files";
    clipboardView.classList.toggle("hidden", showFiles);
    filesView.classList.toggle("hidden", !showFiles);
    clipboardTab.classList.toggle("active", !showFiles);
    filesTab.classList.toggle("active", showFiles);
    localStorage.setItem("section", section);
    if (showFiles) loadFiles().catch((error) => toast(error.message));
  }

  async function loadFiles() {
    const data = await request("/api/files");
    fileList.innerHTML = "";
    storageUsage.textContent = `${data.items.length} ${fileWord(data.items.length)}, занято ${formatBytes(data.total_bytes)}`;
    if (!data.items.length) {
      fileList.innerHTML = "<p class=\"muted\">Файлов пока нет.</p>";
      return;
    }
    data.items.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "file-item";
      item.innerHTML = `
        <div class="file-info">
          <span class="file-name"></span>
          <span class="file-meta">${formatBytes(entry.size_bytes)} · ${formatDate(entry.created_at)}</span>
        </div>
        <div class="file-actions">
          <a class="download-link" href="/api/files/${entry.id}/download">Скачать</a>
          <button type="button" class="danger ghost" data-delete-file="${entry.id}">Удалить</button>
        </div>`;
      item.querySelector(".file-name").textContent = entry.original_name;
      fileList.appendChild(item);
    });
  }

  function uploadFile(file) {
    return new Promise((resolve, reject) => {
      const item = document.createElement("div");
      item.className = "upload-item";
      const label = document.createElement("span");
      label.className = "file-name";
      label.textContent = file.name;
      const progress = document.createElement("progress");
      progress.max = 100;
      progress.value = 0;
      item.append(label, progress);
      uploadQueue.classList.remove("hidden");
      uploadQueue.appendChild(item);

      const form = new FormData();
      form.append("upload", file, file.name);
      form.append("source", "web");
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/files");
      xhr.setRequestHeader("X-CSRF-Token", csrfToken);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) progress.value = Math.round((event.loaded / event.total) * 100);
      };
      xhr.onload = () => {
        item.remove();
        if (!uploadQueue.children.length) uploadQueue.classList.add("hidden");
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else {
          let message = "Не удалось загрузить файл";
          try { message = JSON.parse(xhr.responseText).detail || message; } catch (_error) { /* response is not JSON */ }
          reject(new Error(message));
        }
      };
      xhr.onerror = () => {
        item.remove();
        if (!uploadQueue.children.length) uploadQueue.classList.add("hidden");
        reject(new Error("Соединение прервано во время загрузки"));
      };
      xhr.send(form);
    });
  }

  async function uploadFiles(files) {
    const selected = Array.from(files || []);
    if (!selected.length) return;
    let uploaded = 0;
    for (const file of selected) {
      try {
        await uploadFile(file);
        uploaded += 1;
      } catch (error) {
        toast(`${file.name}: ${error.message}`);
      }
    }
    fileInput.value = "";
    await loadFiles();
    if (uploaded) toast(uploaded === 1 ? "Файл загружен" : `Загружено файлов: ${uploaded}`);
  }

  async function saveText() {
    const body = JSON.stringify({ text: textArea.value, source: "web" });
    const entry = await request("/api/clipboard", { method: "POST", body });
    setEntry(entry, false);
    await loadHistory();
    toast("Текст сохранён");
  }

  async function pasteText() {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error("clipboard denied");
      textArea.value = await navigator.clipboard.readText();
      dirty = textArea.value !== savedText;
      updateMeta();
      renderPreview();
      toast("Текст вставлен");
    } catch (_error) {
      toast("Браузер не разрешил чтение буфера обмена. Используйте Ctrl+V или вставку через контекстное меню");
      textArea.focus();
    }
  }

  async function copyText(value) {
    const text = value == null ? textArea.value : value;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const previous = textArea.value;
        textArea.value = text;
        textArea.focus();
        textArea.select();
        if (!document.execCommand("copy")) throw new Error("copy failed");
        textArea.value = previous;
      }
      toast("Текст скопирован");
    } catch (_error) {
      textArea.focus();
      textArea.select();
      if (document.execCommand("copy")) toast("Текст скопирован");
      else toast("Не удалось скопировать текст. Выделите его и используйте Ctrl+C");
    }
  }

  function setConnection(state) {
    connection.className = `status ${state}`;
    connection.textContent = state === "connected" ? "Подключено" : state === "reconnecting" ? "Переподключение" : "Нет соединения";
  }

  function connectWebSocket() {
    clearTimeout(reconnectTimer);
    setConnection("reconnecting");
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${scheme}://${window.location.host}/ws`);
    ws.onopen = () => setConnection("connected");
    ws.onclose = () => {
      setConnection("disconnected");
      reconnectTimer = setTimeout(connectWebSocket, 1800);
    };
    ws.onmessage = async (message) => {
      const data = JSON.parse(message.data);
      if (data.event === "clipboard_updated") {
        await loadHistory();
        if (dirty) {
          incomingEntry = data.payload;
          conflictToast.classList.remove("hidden");
        } else {
          setEntry(data.payload, true);
        }
      }
      if (data.event === "history_changed") {
        await loadHistory();
      }
      if (data.event === "files_changed" && !filesView.classList.contains("hidden")) {
        await loadFiles();
      }
    };
  }

  textArea.addEventListener("input", () => {
    dirty = textArea.value !== savedText;
    updateMeta();
    renderPreview();
  });
  window.addEventListener("beforeunload", (event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  pasteBtn.addEventListener("click", pasteText);
  copyBtn.addEventListener("click", () => copyText());
  saveBtn.addEventListener("click", () => saveText().catch((error) => toast(error.message)));
  clearBtn.addEventListener("click", () => {
    textArea.value = "";
    dirty = textArea.value !== savedText;
    updateMeta();
    renderPreview();
    toast("Поле очищено");
  });
  editorBtn.addEventListener("click", () => switchMode("editor"));
  previewBtn.addEventListener("click", () => switchMode("preview"));
  openIncomingBtn.addEventListener("click", () => {
    if (incomingEntry) setEntry(incomingEntry, true);
    incomingEntry = null;
    conflictToast.classList.add("hidden");
  });
  keepCurrentBtn.addEventListener("click", () => {
    incomingEntry = null;
    conflictToast.classList.add("hidden");
  });

  historyList.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const history = await request("/api/history");
    const id = Number(button.dataset.open || button.dataset.copy || button.dataset.delete);
    const entry = history.items.find((item) => item.id === id);
    if (button.dataset.open && entry) setEntry(entry, false);
    if (button.dataset.copy && entry) copyText(entry.text);
    if (button.dataset.delete && entry && confirm("Удалить эту запись?")) {
      await request(`/api/clipboard/${entry.id}`, { method: "DELETE" });
      await loadHistory();
    }
  });

  clearHistoryBtn.addEventListener("click", async () => {
    if (confirm("Очистить всю историю?")) {
      await request("/api/history", { method: "DELETE" });
      setEntry(null, false);
      await loadHistory();
    }
  });

  clipboardTab.addEventListener("click", () => switchSection("clipboard"));
  filesTab.addEventListener("click", () => switchSection("files"));
  chooseFilesBtn.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => uploadFiles(fileInput.files));
  ["dragenter", "dragover"].forEach((name) => dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((name) => dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  }));
  dropZone.addEventListener("drop", (event) => uploadFiles(event.dataTransfer.files));
  fileList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-delete-file]");
    if (!button || !confirm("Удалить этот файл?")) return;
    try {
      await request(`/api/files/${button.dataset.deleteFile}`, { method: "DELETE" });
      await loadFiles();
      toast("Файл удалён");
    } catch (error) {
      toast(error.message);
    }
  });

  themeToggle.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme || "auto";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
  });
  const storedTheme = localStorage.getItem("theme");
  if (storedTheme) document.documentElement.dataset.theme = storedTheme;
  switchSection(localStorage.getItem("section") === "files" ? "files" : "clipboard");

  loadInitial().catch((error) => toast(error.message));
  connectWebSocket();
})();
