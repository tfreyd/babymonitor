const socket = io();

const elements = {
  monitorCode: document.getElementById("monitorCode"),
  accessKey: document.getElementById("accessKey"),
  randomCodeBtn: document.getElementById("randomCodeBtn"),
  selectBabyBtn: document.getElementById("selectBabyBtn"),
  selectParentBtn: document.getElementById("selectParentBtn"),
  connectionStatus: document.getElementById("connectionStatus"),
  babyPanel: document.getElementById("babyPanel"),
  parentPanel: document.getElementById("parentPanel"),
  threshold: document.getElementById("threshold"),
  thresholdValue: document.getElementById("thresholdValue"),
  meterFill: document.getElementById("meterFill"),
  startMonitorBtn: document.getElementById("startMonitorBtn"),
  stopMonitorBtn: document.getElementById("stopMonitorBtn"),
  babyStatus: document.getElementById("babyStatus"),
  enablePushBtn: document.getElementById("enablePushBtn"),
  pushStatus: document.getElementById("pushStatus"),
  alertsList: document.getElementById("alertsList"),
  liveAudio: document.getElementById("liveAudio"),
  audioStatus: document.getElementById("audioStatus")
};

const state = {
  role: null,
  monitorCode: "",
  accessKey: "",
  localSocketId: "",
  threshold: Number(elements.threshold.value) / 100,
  cooldownMs: 3000,
  lastAlertAt: 0,
  monitoring: false,
  audioContext: null,
  analyser: null,
  microphoneStream: null,
  frameId: null,
  audioBuffer: null,
  swRegistration: null,
  publicVapidKey: null,
  peerConnections: new Map()
};

hydrateFromQueryString();

elements.randomCodeBtn.addEventListener("click", () => {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  elements.monitorCode.value = code;
  state.monitorCode = code;
  localStorage.setItem("monitorCode", code);
});

elements.monitorCode.addEventListener("input", () => {
  const code = normalizeMonitorCode(elements.monitorCode.value);
  elements.monitorCode.value = code;
  state.monitorCode = code;
  localStorage.setItem("monitorCode", code);
});

elements.accessKey.addEventListener("input", () => {
  const key = normalizeAccessKey(elements.accessKey.value);
  elements.accessKey.value = key;
  state.accessKey = key;
});

elements.selectBabyBtn.addEventListener("click", () => {
  setRole("baby");
  joinRoom();
});

elements.selectParentBtn.addEventListener("click", () => {
  setRole("parent");
  joinRoom();
});

elements.threshold.addEventListener("input", () => {
  state.threshold = Number(elements.threshold.value) / 100;
  elements.thresholdValue.textContent = `Threshold: ${elements.threshold.value}%`;
});

elements.startMonitorBtn.addEventListener("click", startMonitoring);
elements.stopMonitorBtn.addEventListener("click", stopMonitoring);
elements.enablePushBtn.addEventListener("click", enablePushNotifications);

socket.on("connect", () => {
  updateStatus(elements.connectionStatus, "Connected to server", "ok");
  if (state.role && state.monitorCode) {
    joinRoom();
  }
});

socket.on("disconnect", () => {
  updateStatus(elements.connectionStatus, "Disconnected", "error");
  closeAllPeerConnections();
});

socket.on("join-error", ({ message }) => {
  updateStatus(elements.connectionStatus, message || "Join failed", "error");
});

socket.on("joined-monitor", ({ monitorCode, role, socketId, peers }) => {
  state.localSocketId = socketId || "";
  updateStatus(
    elements.connectionStatus,
    `Joined ${monitorCode} as ${role === "baby" ? "Baby" : "Parent"}`,
    "ok"
  );

  if (role === "parent" && Array.isArray(peers)) {
    for (const peer of peers) {
      if (peer.role === "baby") {
        initiateOffer(peer.socketId);
      }
    }
  }
});

socket.on("peer-joined", ({ socketId, role }) => {
  if (!socketId || socketId === state.localSocketId) {
    return;
  }

  if (state.role === "parent" && role === "baby") {
    initiateOffer(socketId);
  }
});

socket.on("baby-ready-for-audio", ({ socketId }) => {
  if (state.role !== "parent" || !socketId) {
    return;
  }
  initiateOffer(socketId);
});

socket.on("peer-left", ({ socketId }) => {
  closePeerConnection(socketId);
});

socket.on("webrtc-offer", async ({ sourceId, offer }) => {
  if (state.role !== "baby" || !sourceId || !offer) {
    return;
  }
  if (!state.monitoring) {
    updateStatus(
      elements.babyStatus,
      "Parent requested audio. Press Start Monitoring to share microphone.",
      ""
    );
    return;
  }

  try {
    const peer = createPeerConnection(sourceId);
    await peer.setRemoteDescription(new RTCSessionDescription(offer));
    attachBabyTracks(peer);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    socket.emit("webrtc-answer", {
      monitorCode: state.monitorCode,
      targetId: sourceId,
      answer: peer.localDescription
    });
  } catch (_error) {
    updateStatus(elements.babyStatus, "Failed to create audio stream connection", "error");
  }
});

socket.on("webrtc-answer", async ({ sourceId, answer }) => {
  if (state.role !== "parent" || !sourceId || !answer) {
    return;
  }
  const peer = state.peerConnections.get(sourceId);
  if (!peer) {
    return;
  }
  try {
    await peer.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (_error) {
    closePeerConnection(sourceId);
  }
});

socket.on("webrtc-ice-candidate", async ({ sourceId, candidate }) => {
  if (!sourceId || !candidate) {
    return;
  }
  const peer = state.peerConnections.get(sourceId);
  if (!peer) {
    return;
  }
  try {
    await peer.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (_error) {
    // Ignore individual ICE candidate failures.
  }
});

socket.on("noise-alert", (alert) => {
  if (state.role !== "parent") {
    return;
  }

  const eventTime = new Date(alert.timestamp || Date.now()).toLocaleTimeString();
  const line = `Noise detected at ${eventTime} (level ${(alert.level * 100).toFixed(0)}%)`;
  prependAlert(line);
  showForegroundNotification(line, alert.monitorCode);
});

bootstrapServiceWorker();

function hydrateFromQueryString() {
  const params = new URLSearchParams(window.location.search);
  const rememberedCode = localStorage.getItem("monitorCode");
  const monitorCode = normalizeMonitorCode(params.get("monitor") || rememberedCode || "");
  const role = params.get("role");

  elements.monitorCode.value = monitorCode;
  state.monitorCode = monitorCode;
  state.accessKey = normalizeAccessKey(params.get("key") || "");
  elements.accessKey.value = state.accessKey;

  if (role === "baby" || role === "parent") {
    setRole(role);
  }
}

function setRole(role) {
  state.role = role;
  elements.babyPanel.classList.toggle("hidden", role !== "baby");
  elements.parentPanel.classList.toggle("hidden", role !== "parent");
}

function joinRoom() {
  if (!state.role) {
    updateStatus(elements.connectionStatus, "Choose Baby or Parent mode first", "error");
    return;
  }

  const monitorCode = normalizeMonitorCode(elements.monitorCode.value);
  const accessKey = normalizeAccessKey(elements.accessKey.value);
  if (!monitorCode) {
    updateStatus(elements.connectionStatus, "Set a monitor code first", "error");
    return;
  }
  if (!accessKey) {
    updateStatus(elements.connectionStatus, "Set an access key (minimum 6 characters)", "error");
    return;
  }

  closeAllPeerConnections();
  state.monitorCode = monitorCode;
  state.accessKey = accessKey;
  localStorage.setItem("monitorCode", monitorCode);
  socket.emit("join-monitor", { monitorCode, accessKey, role: state.role });
}

async function startMonitoring() {
  if (state.monitoring) {
    return;
  }

  if (!state.monitorCode) {
    updateStatus(elements.babyStatus, "Set monitor code before starting", "error");
    return;
  }

  try {
    await ensureMicrophoneStream();
    state.audioContext = new AudioContext();
    const source = state.audioContext.createMediaStreamSource(state.microphoneStream);
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 2048;
    state.audioBuffer = new Float32Array(state.analyser.fftSize);
    source.connect(state.analyser);

    state.monitoring = true;
    state.lastAlertAt = 0;
    elements.startMonitorBtn.disabled = true;
    elements.stopMonitorBtn.disabled = false;
    updateStatus(elements.babyStatus, "Listening for noise and streaming audio...", "ok");
    socket.emit("baby-ready-for-audio", { monitorCode: state.monitorCode });

    for (const peer of state.peerConnections.values()) {
      attachBabyTracks(peer);
    }
    detectNoiseFrame();
  } catch (_error) {
    updateStatus(elements.babyStatus, "Microphone permission denied or unavailable", "error");
  }
}

function stopMonitoring() {
  state.monitoring = false;
  elements.startMonitorBtn.disabled = false;
  elements.stopMonitorBtn.disabled = true;
  elements.meterFill.style.width = "0%";
  updateStatus(elements.babyStatus, "Microphone is off", "");

  if (state.frameId) {
    cancelAnimationFrame(state.frameId);
    state.frameId = null;
  }
  if (state.analyser) {
    state.analyser.disconnect();
    state.analyser = null;
  }
  if (state.audioContext) {
    state.audioContext.close();
    state.audioContext = null;
  }
  if (state.microphoneStream) {
    state.microphoneStream.getTracks().forEach((track) => track.stop());
    state.microphoneStream = null;
  }

  closeAllPeerConnections();
}

async function ensureMicrophoneStream() {
  if (state.microphoneStream) {
    return;
  }
  state.microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
}

function detectNoiseFrame() {
  if (!state.monitoring || !state.analyser) {
    return;
  }

  state.analyser.getFloatTimeDomainData(state.audioBuffer);
  let sumSquares = 0;
  for (let index = 0; index < state.audioBuffer.length; index += 1) {
    const sample = state.audioBuffer[index];
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / state.audioBuffer.length);
  const percentage = Math.min(100, Math.round(rms * 220));
  elements.meterFill.style.width = `${percentage}%`;

  const now = Date.now();
  if (rms > state.threshold && now - state.lastAlertAt > state.cooldownMs) {
    state.lastAlertAt = now;
    socket.emit("noise-detected", {
      monitorCode: state.monitorCode,
      level: rms,
      timestamp: now
    });
    updateStatus(elements.babyStatus, "Noise detected and alert sent", "ok");
  }

  state.frameId = requestAnimationFrame(detectNoiseFrame);
}

async function initiateOffer(remoteSocketId) {
  if (state.role !== "parent" || !remoteSocketId) {
    return;
  }

  try {
    const peer = createPeerConnection(remoteSocketId);
    if (peer.localDescription || peer.signalingState !== "stable") {
      return;
    }
    const hasAudioTransceiver = peer
      .getTransceivers()
      .some((transceiver) => transceiver.receiver?.track?.kind === "audio");
    if (!hasAudioTransceiver) {
      peer.addTransceiver("audio", { direction: "recvonly" });
    }
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    socket.emit("webrtc-offer", {
      monitorCode: state.monitorCode,
      targetId: remoteSocketId,
      offer: peer.localDescription
    });
  } catch (_error) {
    closePeerConnection(remoteSocketId);
    updateStatus(elements.audioStatus, "Could not start live audio", "error");
  }
}

function createPeerConnection(remoteSocketId) {
  if (state.peerConnections.has(remoteSocketId)) {
    return state.peerConnections.get(remoteSocketId);
  }

  const peer = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  peer.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }
    socket.emit("webrtc-ice-candidate", {
      monitorCode: state.monitorCode,
      targetId: remoteSocketId,
      candidate: event.candidate
    });
  };

  peer.onconnectionstatechange = () => {
    const status = peer.connectionState;
    if (status === "failed" || status === "closed" || status === "disconnected") {
      closePeerConnection(remoteSocketId);
    }
  };

  peer.ontrack = (event) => {
    if (state.role !== "parent") {
      return;
    }
    const [stream] = event.streams;
    if (!stream) {
      return;
    }
    elements.liveAudio.srcObject = stream;
    elements.liveAudio.play().catch(() => {});
    updateStatus(elements.audioStatus, "Live audio connected", "ok");
  };

  state.peerConnections.set(remoteSocketId, peer);
  return peer;
}

function attachBabyTracks(peer) {
  if (!state.microphoneStream || state.role !== "baby") {
    return;
  }
  const senders = peer.getSenders();
  const hasAudioTrack = senders.some((sender) => sender.track && sender.track.kind === "audio");
  if (hasAudioTrack) {
    return;
  }
  for (const track of state.microphoneStream.getAudioTracks()) {
    peer.addTrack(track, state.microphoneStream);
  }
}

function closePeerConnection(socketId) {
  const peer = state.peerConnections.get(socketId);
  if (!peer) {
    return;
  }
  peer.ontrack = null;
  peer.onicecandidate = null;
  peer.onconnectionstatechange = null;
  try {
    peer.close();
  } catch (_error) {
    // Ignore close errors.
  }
  state.peerConnections.delete(socketId);

  if (state.role === "parent" && state.peerConnections.size === 0) {
    elements.liveAudio.srcObject = null;
    updateStatus(elements.audioStatus, "Waiting for baby device audio", "");
  }
}

function closeAllPeerConnections() {
  const socketIds = [...state.peerConnections.keys()];
  for (const socketId of socketIds) {
    closePeerConnection(socketId);
  }
}

async function bootstrapServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    updateStatus(elements.pushStatus, "Service workers unsupported on this browser", "error");
    elements.enablePushBtn.disabled = true;
    return;
  }

  try {
    state.swRegistration = await navigator.serviceWorker.register("/sw.js");
  } catch (_error) {
    updateStatus(elements.pushStatus, "Could not register service worker", "error");
    elements.enablePushBtn.disabled = true;
  }
}

async function enablePushNotifications() {
  if (state.role !== "parent") {
    updateStatus(elements.pushStatus, "Switch to Parent mode to enable notifications", "error");
    return;
  }

  if (!state.monitorCode) {
    updateStatus(elements.pushStatus, "Set monitor code before enabling notifications", "error");
    return;
  }
  if (!state.accessKey) {
    updateStatus(elements.pushStatus, "Set access key before enabling notifications", "error");
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      updateStatus(elements.pushStatus, "Notification permission was not granted", "error");
      return;
    }

    if (!state.swRegistration) {
      updateStatus(elements.pushStatus, "Service worker not ready", "error");
      return;
    }

    if (!state.publicVapidKey) {
      const response = await fetch("/config");
      const config = await response.json();
      if (!config.pushEnabled || !config.publicVapidKey) {
        updateStatus(elements.pushStatus, "Push notifications disabled on server", "error");
        return;
      }
      state.publicVapidKey = config.publicVapidKey;
    }

    const subscription = await state.swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(state.publicVapidKey)
    });

    const response = await fetch("/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        monitorCode: state.monitorCode,
        accessKey: state.accessKey,
        subscription
      })
    });

    if (!response.ok) {
      updateStatus(elements.pushStatus, "Failed to register push subscription", "error");
      return;
    }

    updateStatus(elements.pushStatus, "Notifications enabled", "ok");
  } catch (_error) {
    updateStatus(elements.pushStatus, "Failed to enable notifications", "error");
  }
}

function showForegroundNotification(message, monitorCode) {
  if (Notification.permission !== "granted") {
    return;
  }

  if (state.swRegistration) {
    state.swRegistration.showNotification("Baby monitor alert", {
      body: message,
      data: { url: `/?role=parent&monitor=${monitorCode}` }
    });
  }
}

function prependAlert(text) {
  const item = document.createElement("li");
  item.textContent = text;
  elements.alertsList.prepend(item);

  while (elements.alertsList.children.length > 25) {
    elements.alertsList.removeChild(elements.alertsList.lastElementChild);
  }
}

function normalizeMonitorCode(rawCode) {
  return String(rawCode || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

function normalizeAccessKey(rawKey) {
  const key = String(rawKey || "").replace(/\s+/g, " ").trim();
  return key.length >= 6 ? key.slice(0, 64) : key;
}

function updateStatus(target, text, tone) {
  target.textContent = text;
  target.className = "status";
  if (tone) {
    target.classList.add(tone);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}
