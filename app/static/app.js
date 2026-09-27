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
  const nearbyTab = document.getElementById("nearbyTab");
  const nearbyView = document.getElementById("nearbyView");
  const nearbyStatus = document.getElementById("nearbyStatus");
  const deviceNameInput = document.getElementById("deviceName");
  const peerList = document.getElementById("peerList");
  const peerFileInput = document.getElementById("peerFileInput");
  const transferList = document.getElementById("transferList");
  const clearTransfersBtn = document.getElementById("clearTransfersBtn");
  const incomingTransfer = document.getElementById("incomingTransfer");
  const incomingFrom = document.getElementById("incomingFrom");
  const incomingFiles = document.getElementById("incomingFiles");
  const acceptTransferBtn = document.getElementById("acceptTransferBtn");
  const rejectTransferBtn = document.getElementById("rejectTransferBtn");

  let currentEntry = null;
  let savedText = "";
  let dirty = false;
  let incomingEntry = null;
  let ws = null;
  let reconnectTimer = null;
  let peers = [];
  let selectedPeerId = null;
  let incomingContext = null;
  const peerContexts = new Map();
  const pendingCandidates = new Map();
  const receivedUrls = [];

  const CHUNK_SIZE = 16 * 1024;
  const MAX_BUFFERED_AMOUNT = 1024 * 1024;
  const MAX_DIRECT_BYTES = 256 * 1024 * 1024;
  const WebRTCConnection = window.RTCPeerConnection;

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
    const showNearby = section === "nearby";
    clipboardView.classList.toggle("hidden", showFiles || showNearby);
    filesView.classList.toggle("hidden", !showFiles);
    nearbyView.classList.toggle("hidden", !showNearby);
    clipboardTab.classList.toggle("active", !showFiles && !showNearby);
    filesTab.classList.toggle("active", showFiles);
    nearbyTab.classList.toggle("active", showNearby);
    localStorage.setItem("section", section);
    if (showFiles) loadFiles().catch((error) => toast(error.message));
    if (showNearby) renderPeers();
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

  function detectDevice() {
    const agent = navigator.userAgent;
    if (/iPad/i.test(agent) || (/Macintosh/i.test(agent) && navigator.maxTouchPoints > 1)) {
      return { name: "iPad", type: "tablet" };
    }
    if (/iPhone/i.test(agent)) return { name: "iPhone", type: "phone" };
    if (/Android/i.test(agent) && /Mobile/i.test(agent)) return { name: "Android", type: "phone" };
    if (/Android/i.test(agent)) return { name: "Android планшет", type: "tablet" };
    if (/Macintosh|Mac OS X/i.test(agent)) return { name: "Mac", type: "desktop" };
    if (/Windows/i.test(agent)) return { name: "Windows", type: "desktop" };
    if (/Linux/i.test(agent)) return { name: "Linux", type: "desktop" };
    return { name: "Устройство", type: "desktop" };
  }

  const detectedDevice = detectDevice();
  deviceNameInput.value = localStorage.getItem("deviceName") || detectedDevice.name;

  function sendSocket(event, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ event, payload }));
    return true;
  }

  function registerPeer() {
    sendSocket("peer_register", {
      name: deviceNameInput.value.trim() || detectedDevice.name,
      device_type: detectedDevice.type
    });
  }

  function peerById(peerId) {
    return peers.find((peer) => peer.id === peerId);
  }

  function renderPeers() {
    peerList.innerHTML = "";
    if (!WebRTCConnection) {
      nearbyStatus.textContent = "Браузер не поддерживает прямую передачу";
      const unsupported = document.createElement("p");
      unsupported.className = "notice error";
      unsupported.textContent = "Обновите Safari, Chrome, Edge или Firefox. Файловое хранилище продолжает работать.";
      peerList.appendChild(unsupported);
      return;
    }
    nearbyStatus.textContent = peers.length ? `Найдено устройств: ${peers.length}` : "Других устройств пока нет";
    if (!peers.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "Откройте Local Clipboard на другом устройстве в этой сети.";
      peerList.appendChild(empty);
      return;
    }
    peers.forEach((peer) => {
      const card = document.createElement("div");
      card.className = "peer-card";
      const glyph = document.createElement("div");
      glyph.className = `device-glyph ${peer.device_type}`;
      glyph.setAttribute("aria-hidden", "true");
      const details = document.createElement("div");
      details.className = "peer-details";
      const name = document.createElement("span");
      name.className = "peer-name";
      name.textContent = peer.name;
      const send = document.createElement("button");
      send.type = "button";
      send.className = "primary";
      send.dataset.peerId = peer.id;
      send.textContent = "Отправить файлы";
      details.append(name, send);
      card.append(glyph, details);
      peerList.appendChild(card);
    });
  }

  function transferId() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  function createTransferNode(context, title, state) {
    const empty = transferList.querySelector(".empty-transfers");
    if (empty) empty.remove();
    const item = document.createElement("div");
    item.className = "transfer-item";
    item.dataset.state = "active";
    const header = document.createElement("div");
    header.className = "transfer-header";
    const titleNode = document.createElement("span");
    titleNode.className = "transfer-title";
    titleNode.textContent = title;
    const stateNode = document.createElement("span");
    stateNode.className = "transfer-state";
    stateNode.textContent = state;
    const progress = document.createElement("progress");
    progress.max = 100;
    progress.value = 0;
    const downloads = document.createElement("div");
    downloads.className = "transfer-downloads";
    header.append(titleNode, stateNode);
    item.append(header, progress, downloads);
    transferList.prepend(item);
    context.node = item;
    context.stateNode = stateNode;
    context.progressNode = progress;
    context.downloadsNode = downloads;
  }

  function setTransferState(context, state, completed) {
    if (!context.node) return;
    context.stateNode.textContent = state;
    if (completed) {
      context.node.dataset.state = "complete";
      context.progressNode.value = 100;
    }
  }

  function updateTransferProgress(context) {
    if (!context.node) return;
    const total = Math.max(context.totalBytes || 0, 1);
    context.progressNode.value = Math.min(100, Math.round((context.doneBytes / total) * 100));
    context.stateNode.textContent = `${formatBytes(context.doneBytes)} / ${formatBytes(context.totalBytes || 0)}`;
  }

  function signalPeer(peerId, signal) {
    sendSocket("peer_signal", { target: peerId, signal });
  }

  function createPeerContext(peerId, direction) {
    const pc = new WebRTCConnection({ iceServers: [] });
    const context = {
      id: transferId(),
      peerId,
      direction,
      pc,
      channel: null,
      files: [],
      totalBytes: 0,
      doneBytes: 0,
      currentFile: null,
      node: null,
      completed: false,
      connectTimer: null
    };
    peerContexts.set(peerId, context);
    pc.onicecandidate = (event) => {
      if (event.candidate) signalPeer(peerId, { candidate: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" && !context.completed) {
        setTransferState(context, "Соединение прервано", true);
        context.completed = true;
        if (incomingContext === context) {
          incomingContext = null;
          incomingTransfer.classList.add("hidden");
          toast("Передача прервана");
        }
      } else if (pc.connectionState === "disconnected" && !context.completed) {
        setTransferState(context, "Соединение нестабильно");
      }
    };
    const queued = pendingCandidates.get(peerId) || [];
    pendingCandidates.delete(peerId);
    context.queuedCandidates = queued;
    context.connectTimer = setTimeout(() => {
      if (!context.completed && (!context.channel || context.channel.readyState !== "open")) {
        setTransferState(context, "Не удалось соединиться. Проверьте сеть и HTTPS", true);
        context.completed = true;
        context.pc.close();
      }
    }, 20000);
    return context;
  }

  async function applyQueuedCandidates(context) {
    for (const candidate of context.queuedCandidates || []) {
      await context.pc.addIceCandidate(candidate).catch(() => {});
    }
    context.queuedCandidates = [];
  }

  function sendChannelJson(context, payload) {
    if (context.channel && context.channel.readyState === "open") {
      context.channel.send(JSON.stringify(payload));
    }
  }

  function addReceivedFile(context, metadata, chunks) {
    const blob = new Blob(chunks, { type: metadata.type || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    receivedUrls.push(url);
    const link = document.createElement("a");
    link.className = "download-link";
    link.href = url;
    link.download = metadata.name;
    link.textContent = `Сохранить ${metadata.name}`;
    context.downloadsNode.appendChild(link);
  }

  function showIncomingOffer(context, message) {
    if (incomingContext && incomingContext !== context) {
      sendChannelJson(context, { type: "response", accepted: false });
      return;
    }
    context.files = Array.isArray(message.files) ? message.files : [];
    context.totalBytes = Number(message.totalBytes) || 0;
    if (context.totalBytes > MAX_DIRECT_BYTES) {
      sendChannelJson(context, { type: "response", accepted: false });
      context.completed = true;
      context.pc.close();
      toast("Входящий пакет превышает лимит 256 МБ");
      return;
    }
    incomingContext = context;
    const peer = peerById(context.peerId);
    incomingFrom.textContent = `${peer ? peer.name : "Устройство"} хочет отправить ${context.files.length} ${fileWord(context.files.length)}, ${formatBytes(context.totalBytes)}`;
    incomingFiles.innerHTML = "";
    context.files.forEach((file) => {
      const row = document.createElement("div");
      row.className = "incoming-file";
      row.textContent = `${file.name} · ${formatBytes(file.size)}`;
      incomingFiles.appendChild(row);
    });
    incomingTransfer.classList.remove("hidden");
  }

  function handleChannelMessage(context, event) {
    if (typeof event.data !== "string") {
      if (!context.currentFile) return;
      context.currentFile.chunks.push(event.data);
      context.doneBytes += event.data.byteLength;
      updateTransferProgress(context);
      return;
    }
    let message;
    try { message = JSON.parse(event.data); } catch (_error) { return; }
    if (message.type === "offer") {
      showIncomingOffer(context, message);
    } else if (message.type === "response") {
      if (message.accepted) {
        setTransferState(context, "Отправка...");
        sendPeerFiles(context).catch(() => setTransferState(context, "Ошибка передачи", true));
      } else {
        setTransferState(context, "Получатель отклонил", true);
        context.completed = true;
        context.pc.close();
      }
    } else if (message.type === "file-start") {
      context.currentFile = { metadata: context.files[message.index], chunks: [] };
    } else if (message.type === "file-end" && context.currentFile) {
      addReceivedFile(context, context.currentFile.metadata, context.currentFile.chunks);
      context.currentFile = null;
    } else if (message.type === "complete") {
      context.completed = true;
      setTransferState(context, "Получено", true);
      setTimeout(() => context.pc.close(), 600);
    }
  }

  function wireDataChannel(context, channel) {
    context.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 256 * 1024;
    channel.onmessage = (event) => handleChannelMessage(context, event);
    channel.onerror = () => setTransferState(context, "Ошибка соединения", true);
    channel.onopen = () => {
      clearTimeout(context.connectTimer);
      if (context.direction === "send") {
        sendChannelJson(context, {
          type: "offer",
          files: context.files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
          totalBytes: context.totalBytes
        });
        setTransferState(context, "Ожидание подтверждения");
      }
    };
  }

  function waitForChannelBuffer(channel) {
    if (channel.bufferedAmount <= MAX_BUFFERED_AMOUNT) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold || channel.readyState !== "open") {
          channel.removeEventListener("bufferedamountlow", check);
          resolve();
        }
      };
      channel.addEventListener("bufferedamountlow", check);
      setTimeout(check, 100);
    });
  }

  async function sendPeerFiles(context) {
    for (let index = 0; index < context.files.length; index += 1) {
      const file = context.files[index];
      sendChannelJson(context, { type: "file-start", index });
      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        if (context.channel.readyState !== "open") throw new Error("channel closed");
        await waitForChannelBuffer(context.channel);
        const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
        context.channel.send(chunk);
        context.doneBytes += chunk.byteLength;
        updateTransferProgress(context);
      }
      sendChannelJson(context, { type: "file-end", index });
    }
    sendChannelJson(context, { type: "complete" });
    context.completed = true;
    setTransferState(context, "Отправлено", true);
    setTimeout(() => context.pc.close(), 1000);
  }

  async function startPeerTransfer(peerId, fileCollection) {
    const files = Array.from(fileCollection || []);
    if (!files.length) return;
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    if (totalBytes > MAX_DIRECT_BYTES) {
      toast("Для прямой передачи выберите не более 256 МБ за один раз");
      return;
    }
    const existing = peerContexts.get(peerId);
    if (existing && !existing.completed) {
      toast("Передача с этим устройством уже выполняется");
      return;
    }
    if (existing) existing.pc.close();
    const context = createPeerContext(peerId, "send");
    context.files = files;
    context.totalBytes = totalBytes;
    const peer = peerById(peerId);
    createTransferNode(context, `Для ${peer ? peer.name : "устройства"}: ${files.map((file) => file.name).join(", ")}`, "Подключение...");
    const channel = context.pc.createDataChannel("local-clipboard-files", { ordered: true });
    wireDataChannel(context, channel);
    const offer = await context.pc.createOffer();
    await context.pc.setLocalDescription(offer);
    signalPeer(peerId, { description: context.pc.localDescription });
  }

  async function handlePeerSignal(payload) {
    const peerId = payload.from;
    const signal = payload.signal || {};
    let context = peerContexts.get(peerId);
    if (signal.description && signal.description.type === "offer") {
      if (context) context.pc.close();
      context = createPeerContext(peerId, "receive");
      context.pc.ondatachannel = (event) => wireDataChannel(context, event.channel);
      await context.pc.setRemoteDescription(signal.description);
      await applyQueuedCandidates(context);
      const answer = await context.pc.createAnswer();
      await context.pc.setLocalDescription(answer);
      signalPeer(peerId, { description: context.pc.localDescription });
    } else if (signal.description && context) {
      await context.pc.setRemoteDescription(signal.description);
      await applyQueuedCandidates(context);
    } else if (signal.candidate) {
      if (context && context.pc.remoteDescription) {
        await context.pc.addIceCandidate(signal.candidate).catch(() => {});
      } else if (context) {
        context.queuedCandidates.push(signal.candidate);
      } else {
        const queued = pendingCandidates.get(peerId) || [];
        queued.push(signal.candidate);
        pendingCandidates.set(peerId, queued);
      }
    }
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
      if (data.event === "peer_identity") {
        registerPeer();
      }
      if (data.event === "peers_changed") {
        peers = data.payload.items || [];
        renderPeers();
        for (const [peerId, context] of peerContexts) {
          if (!peerById(peerId) && !context.completed) {
            setTransferState(context, "Устройство отключилось", true);
            context.completed = true;
            context.pc.close();
            if (incomingContext === context) {
              incomingContext = null;
              incomingTransfer.classList.add("hidden");
              toast("Отправитель отключился");
            }
          }
        }
      }
      if (data.event === "peer_signal") {
        await handlePeerSignal(data.payload).catch(() => toast("Не удалось установить прямое соединение"));
      }
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
  nearbyTab.addEventListener("click", () => switchSection("nearby"));
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

  deviceNameInput.addEventListener("change", () => {
    const value = deviceNameInput.value.trim() || detectedDevice.name;
    deviceNameInput.value = value;
    localStorage.setItem("deviceName", value);
    registerPeer();
  });
  peerList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-peer-id]");
    if (!button) return;
    selectedPeerId = button.dataset.peerId;
    peerFileInput.click();
  });
  peerFileInput.addEventListener("change", () => {
    if (selectedPeerId) {
      startPeerTransfer(selectedPeerId, peerFileInput.files).catch((error) => {
        const context = peerContexts.get(selectedPeerId);
        if (context) setTransferState(context, "Не удалось подключиться", true);
        toast(error && error.message ? error.message : "Не удалось начать передачу");
      });
    }
    peerFileInput.value = "";
  });
  acceptTransferBtn.addEventListener("click", () => {
    if (!incomingContext) return;
    const peer = peerById(incomingContext.peerId);
    createTransferNode(incomingContext, `От ${peer ? peer.name : "устройства"}: ${incomingContext.files.map((file) => file.name).join(", ")}`, "Получение...");
    sendChannelJson(incomingContext, { type: "response", accepted: true });
    incomingTransfer.classList.add("hidden");
    incomingContext = null;
  });
  rejectTransferBtn.addEventListener("click", () => {
    if (incomingContext) {
      const rejected = incomingContext;
      sendChannelJson(rejected, { type: "response", accepted: false });
      rejected.completed = true;
      setTimeout(() => rejected.pc.close(), 300);
    }
    incomingContext = null;
    incomingTransfer.classList.add("hidden");
  });
  clearTransfersBtn.addEventListener("click", () => {
    transferList.querySelectorAll('.transfer-item[data-state="complete"]').forEach((item) => item.remove());
    if (!transferList.querySelector(".transfer-item")) {
      transferList.innerHTML = '<p class="muted empty-transfers">Активных передач нет.</p>';
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
  const storedSection = localStorage.getItem("section");
  switchSection(["files", "nearby"].includes(storedSection) ? storedSection : "clipboard");

  window.addEventListener("unload", () => {
    peerContexts.forEach((context) => context.pc.close());
    receivedUrls.forEach((url) => URL.revokeObjectURL(url));
  });

  loadInitial().catch((error) => toast(error.message));
  connectWebSocket();
})();
