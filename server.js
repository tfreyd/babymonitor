const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
require("dotenv").config();
const express = require("express");
const { Server } = require("socket.io");
const webpush = require("web-push");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_VAPID_KEY = process.env.PUBLIC_VAPID_KEY || "";
const PRIVATE_VAPID_KEY = process.env.PRIVATE_VAPID_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@babymonitor.local";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY, Boolean(process.env.RENDER));
const PUSH_ENABLED = Boolean(PUBLIC_VAPID_KEY && PRIVATE_VAPID_KEY);

if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, PUBLIC_VAPID_KEY, PRIVATE_VAPID_KEY);
} else {
  // eslint-disable-next-line no-console
  console.warn("Push notifications disabled: missing PUBLIC_VAPID_KEY/PRIVATE_VAPID_KEY");
}

const app = express();
app.set("trust proxy", TRUST_PROXY);
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN,
    methods: ["GET", "POST"]
  }
});

// In-memory subscription store by monitor code.
const subscriptionsByMonitor = new Map();
const roomSecrets = new Map();

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/config", (_req, res) => {
  res.json({ publicVapidKey: PUSH_ENABLED ? PUBLIC_VAPID_KEY : null, pushEnabled: PUSH_ENABLED });
});

app.post("/subscribe", (req, res) => {
  const monitorCode = normalizeMonitorCode(req.body?.monitorCode);
  const accessKey = normalizeAccessKey(req.body?.accessKey);
  const subscription = req.body?.subscription;

  if (!monitorCode || !accessKey || !subscription || !subscription.endpoint) {
    res.status(400).json({ error: "Invalid monitorCode or subscription" });
    return;
  }
  if (!isRoomAccessValid(monitorCode, accessKey)) {
    res.status(403).json({ error: "Unauthorized room access" });
    return;
  }

  const roomSubscriptions = subscriptionsByMonitor.get(monitorCode) || new Map();
  roomSubscriptions.set(subscription.endpoint, subscription);
  subscriptionsByMonitor.set(monitorCode, roomSubscriptions);

  res.status(201).json({ ok: true });
});

io.on("connection", (socket) => {
  socket.on("join-monitor", ({ monitorCode, accessKey, role }) => {
    if (isRateLimited(socket, "join", 12, 60 * 1000)) {
      socket.emit("join-error", { message: "Too many join attempts. Try again in a minute." });
      return;
    }

    const room = normalizeMonitorCode(monitorCode);
    const normalizedAccessKey = normalizeAccessKey(accessKey);
    if (!room || !isValidRole(role)) {
      socket.emit("join-error", { message: "Invalid monitor code or role" });
      return;
    }
    if (!normalizedAccessKey) {
      socket.emit("join-error", { message: "Access key must be at least 6 characters" });
      return;
    }
    if (!roomSecrets.has(room) && role !== "baby") {
      socket.emit("join-error", { message: "Baby device must start this monitor first" });
      return;
    }
    if (!roomSecrets.has(room)) {
      roomSecrets.set(room, normalizedAccessKey);
    }
    if (!isRoomAccessValid(room, normalizedAccessKey)) {
      socket.emit("join-error", { message: "Wrong access key" });
      return;
    }

    if (socket.data.monitorCode) {
      socket.leave(socket.data.monitorCode);
    }

    socket.join(room);
    socket.data.role = role;
    socket.data.monitorCode = room;
    socket.data.accessKey = normalizedAccessKey;

    const peers = getRoomPeers(room, socket.id);
    socket.emit("joined-monitor", { monitorCode: room, role, socketId: socket.id, peers });
    socket.to(room).emit("peer-joined", { socketId: socket.id, role });
    socket.to(room).emit("presence", { role, connected: true });
  });

  socket.on("noise-detected", async ({ monitorCode, level, timestamp }) => {
    if (isRateLimited(socket, "noise", 30, 60 * 1000)) {
      return;
    }
    const room = normalizeMonitorCode(monitorCode);
    if (!room || socket.data.monitorCode !== room || socket.data.role !== "baby") {
      return;
    }

    const alert = {
      monitorCode: room,
      level: Number(level) || 0,
      timestamp: Number(timestamp) || Date.now()
    };

    io.to(room).emit("noise-alert", alert);
    await sendPushAlert(room, alert);
  });

  socket.on("webrtc-offer", ({ monitorCode, targetId, offer }) => {
    if (isRateLimited(socket, "signal", 180, 60 * 1000)) {
      return;
    }
    relayWebRtcMessage(socket, {
      monitorCode,
      targetId,
      event: "webrtc-offer",
      payload: { sourceId: socket.id, offer }
    });
  });

  socket.on("webrtc-answer", ({ monitorCode, targetId, answer }) => {
    if (isRateLimited(socket, "signal", 180, 60 * 1000)) {
      return;
    }
    relayWebRtcMessage(socket, {
      monitorCode,
      targetId,
      event: "webrtc-answer",
      payload: { sourceId: socket.id, answer }
    });
  });

  socket.on("webrtc-ice-candidate", ({ monitorCode, targetId, candidate }) => {
    if (isRateLimited(socket, "signal", 180, 60 * 1000)) {
      return;
    }
    relayWebRtcMessage(socket, {
      monitorCode,
      targetId,
      event: "webrtc-ice-candidate",
      payload: { sourceId: socket.id, candidate }
    });
  });

  socket.on("disconnect", () => {
    const room = socket.data.monitorCode;
    const role = socket.data.role;
    if (!room || !role) {
      return;
    }
    socket.to(room).emit("peer-left", { socketId: socket.id, role });
    socket.to(room).emit("presence", { role, connected: false });
    cleanupRoomIfEmpty(room);
  });

  socket.on("baby-ready-for-audio", ({ monitorCode }) => {
    const room = normalizeMonitorCode(monitorCode);
    if (!room || room !== socket.data.monitorCode || socket.data.role !== "baby") {
      return;
    }
    socket.to(room).emit("baby-ready-for-audio", { socketId: socket.id });
  });

  socket.on("baby-not-ready-for-audio", ({ monitorCode, targetId, reason }) => {
    relayWebRtcMessage(socket, {
      monitorCode,
      targetId,
      event: "baby-not-ready-for-audio",
      payload: { sourceId: socket.id, reason: String(reason || "Baby monitoring is not started") }
    });
  });
});

async function sendPushAlert(monitorCode, alert) {
  if (!PUSH_ENABLED) {
    return;
  }
  const roomSubscriptions = subscriptionsByMonitor.get(monitorCode);
  if (!roomSubscriptions || roomSubscriptions.size === 0) {
    return;
  }

  const notification = JSON.stringify({
    title: "Baby monitor alert",
    body: `Noise detected for monitor ${monitorCode}`,
    monitorCode,
    timestamp: alert.timestamp,
    level: alert.level,
    url: `/?role=parent&monitor=${monitorCode}`
  });

  const deliveries = [...roomSubscriptions.values()].map(async (subscription) => {
    try {
      await webpush.sendNotification(subscription, notification);
    } catch (error) {
      // Remove expired subscriptions to keep memory clean.
      if (error.statusCode === 404 || error.statusCode === 410) {
        roomSubscriptions.delete(subscription.endpoint);
      }
    }
  });

  await Promise.allSettled(deliveries);
}

function normalizeMonitorCode(raw) {
  const cleaned = String(raw || "")
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9]/g, "");

  return cleaned.slice(0, 8);
}

function normalizeAccessKey(raw) {
  const normalized = String(raw || "")
    .trim()
    .replace(/\s+/g, " ");
  if (normalized.length < 6 || normalized.length > 64) {
    return "";
  }
  return normalized;
}

function isValidRole(role) {
  return role === "baby" || role === "parent";
}

function isRoomAccessValid(monitorCode, accessKey) {
  const stored = roomSecrets.get(monitorCode);
  if (!stored || !accessKey) {
    return false;
  }
  return safeEqual(stored, accessKey);
}

function getRoomPeers(monitorCode, currentSocketId) {
  const roomSet = io.sockets.adapter.rooms.get(monitorCode);
  if (!roomSet) {
    return [];
  }

  const peers = [];
  for (const socketId of roomSet.values()) {
    if (socketId === currentSocketId) {
      continue;
    }
    const peerSocket = io.sockets.sockets.get(socketId);
    if (!peerSocket || !isValidRole(peerSocket.data.role)) {
      continue;
    }
    peers.push({ socketId, role: peerSocket.data.role });
  }
  return peers;
}

function relayWebRtcMessage(socket, { monitorCode, targetId, event, payload }) {
  const room = normalizeMonitorCode(monitorCode);
  if (!room || room !== socket.data.monitorCode || !targetId) {
    return;
  }

  const targetSocket = io.sockets.sockets.get(targetId);
  if (!targetSocket || targetSocket.data.monitorCode !== room) {
    return;
  }

  targetSocket.emit(event, payload);
}

function cleanupRoomIfEmpty(monitorCode) {
  const roomSet = io.sockets.adapter.rooms.get(monitorCode);
  if (roomSet && roomSet.size > 0) {
    return;
  }
  roomSecrets.delete(monitorCode);
  subscriptionsByMonitor.delete(monitorCode);
}

function isRateLimited(socket, key, limit, windowMs) {
  const now = Date.now();
  const allBuckets = socket.data.rateBuckets || {};
  const bucket = allBuckets[key] || [];
  const recent = bucket.filter((timestamp) => now - timestamp < windowMs);
  recent.push(now);
  allBuckets[key] = recent;
  socket.data.rateBuckets = allBuckets;
  return recent.length > limit;
}

function safeEqual(a, b) {
  const aBuffer = Buffer.from(String(a));
  const bBuffer = Buffer.from(String(b));
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function parseTrustProxy(rawValue, isRender) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return isRender ? 1 : false;
  }
  const lowered = String(rawValue).trim().toLowerCase();
  if (lowered === "true") {
    return true;
  }
  if (lowered === "false") {
    return false;
  }
  const asNumber = Number(lowered);
  if (Number.isInteger(asNumber) && asNumber >= 0) {
    return asNumber;
  }
  return rawValue;
}

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Baby monitor running on http://${HOST}:${PORT}`);
});
