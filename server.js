/**
 * Spark Messenger v2 - server.js
 * Features: Real-time chat, Private Vault, Push Notifications, Group calls
 * Run: npm install && node server.js
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const webpush = require("web-push");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const JWT_SECRET =
  process.env.JWT_SECRET ||
  "spark_jwt_" + crypto.randomBytes(16).toString("hex");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");

let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  const keys = webpush.generateVAPIDKeys();
  VAPID_PUBLIC_KEY = keys.publicKey;
  VAPID_PRIVATE_KEY = keys.privateKey;
}

webpush.setVapidDetails(
  "mailto:admin@sparkmessenger.app",
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

[UPLOAD_DIR, PUBLIC_DIR, DATA_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── PERSISTENCE ──
function saveData(filename, data) {
  try {
    let out = data instanceof Map ? Array.from(data.entries()) : data;
    fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(out, null, 2));
  } catch (e) { console.error("Save error:", filename, e.message); }
}

function loadData(filename, isMap = false) {
  try {
    const p = path.join(DATA_DIR, filename);
    if (!fs.existsSync(p)) return isMap ? new Map() : null;
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    return isMap ? new Map(parsed) : parsed;
  } catch (e) {
    console.error("Load error:", filename, e.message);
    return isMap ? new Map() : null;
  }
}

function mapOfSets(filename) {
  const raw = loadData(filename, true);
  const result = new Map();
  for (const [k, v] of raw) result.set(k, new Set(Array.isArray(v) ? v : []));
  return result;
}

function saveMapOfSets(filename, map) {
  const out = new Map();
  for (const [k, v] of map) out.set(k, Array.from(v));
  saveData(filename, out);
}

const DB = {
  users:       loadData("users.json", true)       || new Map(),
  userByPhone: loadData("userByPhone.json", true)  || new Map(),
  messages:    loadData("messages.json", true)     || new Map(),
  groups:      loadData("groups.json", true)       || new Map(),
  statuses:    loadData("statuses.json", true)     || new Map(),
  wallpapers:  loadData("wallpapers.json", true)   || new Map(),
  pushSubs:    loadData("pushSubs.json", true)     || new Map(),
  callHistory: loadData("callHistory.json", true)  || new Map(),
  vaultPass:   loadData("vaultPass.json", true)    || new Map(), // userId -> bcrypt hash
  vaultChats:  loadData("vaultChats.json", true)   || new Map(), // userId -> Set<contactId>
  contacts:    mapOfSets("contacts.json"),
  pinned:      mapOfSets("pinned.json"),
  archived:    mapOfSets("archived.json"),
  starred:     mapOfSets("starred.json"),
  blocked:     mapOfSets("blocked.json"),
};

function saveAll() {
  saveData("users.json", DB.users);
  saveData("userByPhone.json", DB.userByPhone);
  saveData("messages.json", DB.messages);
  saveData("groups.json", DB.groups);
  saveData("statuses.json", DB.statuses);
  saveData("wallpapers.json", DB.wallpapers);
  saveData("pushSubs.json", DB.pushSubs);
  saveData("callHistory.json", DB.callHistory);
  saveData("vaultPass.json", DB.vaultPass);
  saveData("vaultChats.json", DB.vaultChats);
  saveMapOfSets("contacts.json", DB.contacts);
  saveMapOfSets("pinned.json", DB.pinned);
  saveMapOfSets("archived.json", DB.archived);
  saveMapOfSets("starred.json", DB.starred);
  saveMapOfSets("blocked.json", DB.blocked);
}

setInterval(saveAll, 30000);
process.on("SIGINT", () => { saveAll(); process.exit(0); });
process.on("SIGTERM", () => { saveAll(); process.exit(0); });

const getSet = (map, key) => { if (!map.has(key)) map.set(key, new Set()); return map.get(key); };
const getArr = (map, key) => { if (!map.has(key)) map.set(key, []); return map.get(key); };
const getObj = (map, key) => { if (!map.has(key)) map.set(key, {}); return map.get(key); };

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  maxHttpBufferSize: 100e6,
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

function auth(req, res, next) {
  const a = req.headers.authorization;
  if (!a?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.userId = jwt.verify(a.slice(7), JWT_SECRET).userId;
    next();
  } catch { res.status(401).json({ error: "Invalid token" }); }
}

const socketUserMap = new Map();
const userSocketMap = new Map();

const COLORS = ["#1565C0","#0D47A1","#1976D2","#2196F3","#00897B","#388E3C","#F57C00","#E64A19","#6A1B9A","#AD1457"];
const randColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];

function safeUser(u) {
  if (!u) return null;
  const { passwordHash, ...s } = u;
  return s;
}

function emitToUser(userId, event, data) {
  const sid = userSocketMap.get(userId);
  if (sid) io.to(sid).emit(event, data);
}

function broadcastToContacts(userId, event, data) {
  for (const [uid, set] of DB.contacts) {
    if (set.has(userId)) emitToUser(uid, event, data);
  }
}

function getConversation(a, b) {
  const msgs = [];
  for (const [, m] of DB.messages) {
    if (!m.groupId && ((m.fromUserId === a && m.toUserId === b) || (m.fromUserId === b && m.toUserId === a)))
      msgs.push(m);
  }
  return msgs.sort((x, y) => x.timestamp - y.timestamp);
}

async function pushNotify(userId, { title, body }) {
  const sub = DB.pushSubs.get(userId);
  if (!sub) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title, body, icon: "/icon-192.png", badge: "/icon-192.png" }));
  } catch (e) {
    if (e.statusCode === 410) DB.pushSubs.delete(userId);
  }
}

// ── AUTH ──
app.post("/api/login", async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: "Phone and password required" });
    const uid = DB.userByPhone.get(phone);
    if (!uid) return res.status(401).json({ error: "Phone number not registered" });
    const user = DB.users.get(uid);
    if (!await bcrypt.compare(password, user.passwordHash))
      return res.status(401).json({ error: "Wrong password" });
    const token = jwt.sign({ userId: uid }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ user: safeUser(user), token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/register", async (req, res) => {
  try {
    const { phone, displayName, password } = req.body;
    if (!phone || !displayName || !password) return res.status(400).json({ error: "All fields required" });
    if (DB.userByPhone.has(phone)) return res.status(400).json({ error: "Phone already registered" });
    if (password.length < 4) return res.status(400).json({ error: "Password too short (min 4)" });
    const uid = uuidv4();
    const user = {
      id: uid, phone, displayName,
      passwordHash: await bcrypt.hash(password, 10),
      avatarColor: randColor(), avatarImg: null,
      status: "Hey there! I'm on Spark.", about: "",
      lastSeen: Date.now(), createdAt: Date.now(),
    };
    DB.users.set(uid, user);
    DB.userByPhone.set(phone, uid);
    saveAll();
    res.json({ user: safeUser(user), token: jwt.sign({ userId: uid }, JWT_SECRET, { expiresIn: "30d" }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PROFILE ──
app.put("/api/profile", auth, (req, res) => {
  const u = DB.users.get(req.userId);
  if (!u) return res.status(404).json({ error: "Not found" });
  const { display_name, status, about, avatar_img } = req.body;
  if (display_name) u.displayName = display_name;
  if (status !== undefined) u.status = status;
  if (about !== undefined) u.about = about;
  if (avatar_img) u.avatarImg = avatar_img;
  DB.users.set(req.userId, u);
  saveAll();
  broadcastToContacts(req.userId, "profile_updated", safeUser(u));
  res.json(safeUser(u));
});

app.get("/api/profile", auth, (req, res) => {
  const u = DB.users.get(req.userId);
  if (!u) return res.status(404).json({ error: "Not found" });
  res.json(safeUser(u));
});

// ── PRIVATE VAULT ──
app.get("/api/vault/status", auth, (req, res) => {
  res.json({ hasPassword: DB.vaultPass.has(req.userId) });
});

app.post("/api/vault/set-password", auth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 4) return res.status(400).json({ error: "Password too short" });
    if (DB.vaultPass.has(req.userId)) return res.status(400).json({ error: "Password already set" });
    DB.vaultPass.set(req.userId, await bcrypt.hash(password, 10));
    saveAll();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/vault/unlock", auth, async (req, res) => {
  try {
    const { password } = req.body;
    const hash = DB.vaultPass.get(req.userId);
    if (!hash) return res.status(400).json({ error: "No vault password set" });
    if (!await bcrypt.compare(password, hash)) return res.status(401).json({ error: "Wrong Credentials" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/vault/add-chat", auth, (req, res) => {
  const { contactId } = req.body;
  if (!contactId) return res.status(400).json({ error: "contactId required" });
  getSet(DB.vaultChats, req.userId).add(contactId);
  saveAll();
  res.json({ ok: true });
});

app.post("/api/vault/remove-chat", auth, (req, res) => {
  const { contactId } = req.body;
  getSet(DB.vaultChats, req.userId).delete(contactId);
  saveAll();
  res.json({ ok: true });
});

app.get("/api/vault/chats", auth, (req, res) => {
  const ids = [...getSet(DB.vaultChats, req.userId)];
  const result = ids.map(id => {
    const u = DB.users.get(id);
    if (!u) return null;
    return { ...safeUser(u), online: userSocketMap.has(id) };
  }).filter(Boolean);
  res.json(result);
});

// ── CONTACTS ──
app.get("/api/contacts", auth, (req, res) => {
  const vault = getSet(DB.vaultChats, req.userId);
  const result = [];
  for (const cid of getSet(DB.contacts, req.userId)) {
    if (vault.has(cid)) continue; // exclude vault chats from normal list
    const u = DB.users.get(cid);
    if (!u) continue;
    result.push({ ...safeUser(u), online: userSocketMap.has(cid) });
  }
  res.json(result);
});

app.get("/api/contacts/all", auth, (req, res) => {
  const result = [];
  for (const cid of getSet(DB.contacts, req.userId)) {
    const u = DB.users.get(cid);
    if (!u) continue;
    result.push({ ...safeUser(u), online: userSocketMap.has(cid) });
  }
  res.json(result);
});

app.post("/api/contacts/add", auth, (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "Phone required" });
  const targetId = DB.userByPhone.get(phone);
  if (!targetId) return res.status(404).json({ error: "User not found with this number" });
  if (targetId === req.userId) return res.status(400).json({ error: "Cannot add yourself" });
  getSet(DB.contacts, req.userId).add(targetId);
  saveAll();
  const target = DB.users.get(targetId);
  const sid = userSocketMap.get(targetId);
  if (sid) io.to(sid).emit("contact_added", { user: safeUser(DB.users.get(req.userId)) });
  res.json({ user: { ...safeUser(target), online: userSocketMap.has(targetId) } });
});

app.delete("/api/contacts/:id", auth, (req, res) => {
  getSet(DB.contacts, req.userId).delete(req.params.id);
  saveAll();
  res.json({ ok: true });
});

// ── MESSAGES ──
app.get("/api/messages/:userId", auth, (req, res) => {
  res.json(getConversation(req.userId, req.params.userId));
});

app.post("/api/messages/:id/react", auth, (req, res) => {
  const { emoji } = req.body;
  const msg = DB.messages.get(req.params.id);
  if (!msg) return res.status(404).json({ error: "Not found" });
  if (!msg.reactions) msg.reactions = [];
  const idx = msg.reactions.findIndex(r => r.userId === req.userId && r.emoji === emoji);
  if (idx >= 0) msg.reactions.splice(idx, 1);
  else msg.reactions.push({ userId: req.userId, emoji });
  saveAll();
  const other = msg.fromUserId === req.userId ? msg.toUserId : msg.fromUserId;
  const payload = { messageId: msg.id, reactions: msg.reactions };
  emitToUser(other, "reaction_update", payload);
  emitToUser(req.userId, "reaction_update", payload);
  res.json({ ok: true });
});

app.post("/api/messages/:id/star", auth, (req, res) => {
  const s = getSet(DB.starred, req.userId);
  if (s.has(req.params.id)) s.delete(req.params.id);
  else s.add(req.params.id);
  saveAll();
  res.json({ ok: true });
});

app.get("/api/starred", auth, (req, res) => {
  const msgs = [...getSet(DB.starred, req.userId)]
    .map(id => DB.messages.get(id)).filter(Boolean)
    .sort((a, b) => b.timestamp - a.timestamp);
  res.json(msgs);
});

app.put("/api/messages/:id/edit", auth, (req, res) => {
  const { content } = req.body;
  const msg = DB.messages.get(req.params.id);
  if (!msg) return res.status(404).json({ error: "Not found" });
  if (msg.fromUserId !== req.userId) return res.status(403).json({ error: "Forbidden" });
  msg.content = content;
  msg.edited = true;
  saveAll();
  emitToUser(msg.toUserId, "message_edited", { messageId: msg.id, content });
  if (msg.groupId) {
    const g = DB.groups.get(msg.groupId);
    if (g) g.members.forEach(uid => { if (uid !== req.userId) emitToUser(uid, "message_edited", { messageId: msg.id, content }); });
  }
  res.json({ ok: true });
});

// ── GROUPS ──
app.get("/api/groups", auth, (req, res) => {
  const result = [];
  for (const [, g] of DB.groups) {
    if (g.members.includes(req.userId)) result.push(g);
  }
  res.json(result);
});

app.post("/api/groups", auth, (req, res) => {
  const { name, memberIds } = req.body;
  if (!name || !memberIds?.length) return res.status(400).json({ error: "Name and members required" });
  const gid = uuidv4();
  const members = [...new Set([req.userId, ...memberIds])];
  const group = {
    id: gid, name, members, admins: [req.userId],
    createdBy: req.userId, avatarColor: randColor(),
    avatarImg: null, description: "",
    canMembersSendMessages: true, createdAt: Date.now(),
  };
  DB.groups.set(gid, group);
  saveAll();
  members.forEach(uid => { if (uid !== req.userId) emitToUser(uid, "added_to_group", group); });
  res.json(group);
});

app.put("/api/groups/:id", auth, (req, res) => {
  const g = DB.groups.get(req.params.id);
  if (!g) return res.status(404).json({ error: "Not found" });
  const { name, description, avatarImg } = req.body;
  if (name) g.name = name;
  if (description !== undefined) g.description = description;
  if (avatarImg !== undefined) g.avatarImg = avatarImg;
  saveAll();
  g.members.forEach(uid => emitToUser(uid, "group_updated", g));
  res.json(g);
});

app.post("/api/groups/:id/leave", auth, (req, res) => {
  const g = DB.groups.get(req.params.id);
  if (!g) return res.status(404).json({ error: "Not found" });
  g.members = g.members.filter(m => m !== req.userId);
  g.admins = g.admins.filter(a => a !== req.userId);
  saveAll();
  g.members.forEach(uid => emitToUser(uid, "group_updated", g));
  res.json({ ok: true });
});

app.get("/api/groups/:id/messages", auth, (req, res) => {
  const g = DB.groups.get(req.params.id);
  if (!g || !g.members.includes(req.userId)) return res.status(403).json({ error: "Forbidden" });
  const msgs = [];
  for (const [, m] of DB.messages) {
    if (m.groupId === req.params.id) msgs.push(m);
  }
  res.json(msgs.sort((a, b) => a.timestamp - b.timestamp));
});

// ── STATUS ──
app.post("/api/status", auth, (req, res) => {
  const { content, type } = req.body;
  const arr = getArr(DB.statuses, req.userId);
  arr.push({ id: uuidv4(), content, type: type || "text", timestamp: Date.now() });
  const cutoff = Date.now() - 86400000;
  DB.statuses.set(req.userId, arr.filter(s => s.timestamp > cutoff));
  saveAll();
  broadcastToContacts(req.userId, "new_status", { userId: req.userId });
  res.json({ ok: true });
});

app.get("/api/statuses", auth, (req, res) => {
  const result = [];
  const mine = getSet(DB.contacts, req.userId);
  const cutoff = Date.now() - 86400000;
  for (const uid of [req.userId, ...mine]) {
    const u = DB.users.get(uid);
    if (!u) continue;
    const statuses = getArr(DB.statuses, uid).filter(s => s.timestamp > cutoff);
    if (uid === req.userId || statuses.length > 0)
      result.push({ user: safeUser(u), statuses, isMe: uid === req.userId });
  }
  res.json(result);
});

// ── META ──
app.get("/api/meta", auth, (req, res) => {
  res.json({
    pinned: [...getSet(DB.pinned, req.userId)],
    archived: [...getSet(DB.archived, req.userId)],
  });
});

app.post("/api/pin/:chatId", auth, (req, res) => { getSet(DB.pinned, req.userId).add(req.params.chatId); saveAll(); res.json({ ok: true }); });
app.post("/api/unpin/:chatId", auth, (req, res) => { getSet(DB.pinned, req.userId).delete(req.params.chatId); saveAll(); res.json({ ok: true }); });
app.post("/api/archive/:chatId", auth, (req, res) => { getSet(DB.archived, req.userId).add(req.params.chatId); saveAll(); res.json({ ok: true }); });
app.post("/api/unarchive/:chatId", auth, (req, res) => { getSet(DB.archived, req.userId).delete(req.params.chatId); saveAll(); res.json({ ok: true }); });
app.post("/api/block/:userId", auth, (req, res) => { getSet(DB.blocked, req.userId).add(req.params.userId); saveAll(); res.json({ ok: true }); });

// ── WALLPAPERS ──
app.get("/api/wallpapers", auth, (req, res) => { res.json(getObj(DB.wallpapers, req.userId)); });
app.put("/api/wallpaper/:chatId", auth, (req, res) => {
  const wp = getObj(DB.wallpapers, req.userId);
  wp[req.params.chatId] = req.body.wallpaper || "";
  saveAll();
  res.json({ ok: true });
});

// ── SEARCH ──
app.get("/api/search/messages", auth, (req, res) => {
  const q = (req.query.q || "").toLowerCase();
  if (!q || q.length < 2) return res.json([]);
  const results = [];
  for (const [, m] of DB.messages) {
    if (m.deleted) continue;
    if (m.fromUserId !== req.userId && m.toUserId !== req.userId && !m.groupId) continue;
    if (m.content && m.content.toLowerCase().includes(q)) results.push(m);
  }
  res.json(results.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50));
});

// ── UPLOAD ──
app.post("/api/upload", auth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  res.json({
    fileUrl: `/uploads/${req.file.filename}`,
    fileName: req.file.originalname,
    fileSize: req.file.size,
    fileMime: req.file.mimetype,
  });
});

// ── PUSH ──
app.get("/api/vapid-public-key", (req, res) => { res.json({ key: VAPID_PUBLIC_KEY }); });
app.post("/api/push-subscribe", auth, (req, res) => {
  DB.pushSubs.set(req.userId, req.body.subscription);
  saveAll();
  res.json({ ok: true });
});

// ── SOCKET.IO ──
const groupCalls = new Map();

io.on("connection", (socket) => {
  socket.on("authenticate", (token) => {
    try {
      const { userId } = jwt.verify(token, JWT_SECRET);
      socketUserMap.set(socket.id, userId);
      userSocketMap.set(userId, socket.id);
      socket.userId = userId;
      socket.emit("authenticated");
      const u = DB.users.get(userId);
      if (u) u.lastSeen = Date.now();
      broadcastToContacts(userId, "user_online", { userId });
    } catch { socket.emit("auth_error", "Invalid token"); }
  });

  socket.on("send_message", (data) => {
    if (!socket.userId) return;
    const { toUserId, content, type, fileUrl, fileName, fileSize, fileMime, replyToId, replyPreview, forwarded } = data;
    if (getSet(DB.blocked, toUserId).has(socket.userId)) return;
    const msg = {
      id: uuidv4(), fromUserId: socket.userId, toUserId,
      content: content || "", type: type || "text",
      fileUrl: fileUrl || null, fileName: fileName || null,
      fileSize: fileSize || null, fileMime: fileMime || null,
      replyToId: replyToId || null, replyPreview: replyPreview || null,
      forwarded: forwarded || false, reactions: [],
      read: false, edited: false, deleted: false, timestamp: Date.now(),
    };
    DB.messages.set(msg.id, msg);
    saveAll();
    const recipSock = userSocketMap.get(toUserId);
    if (recipSock) {
      io.to(recipSock).emit("new_message", msg);
      pushNotify(toUserId, {
        title: DB.users.get(socket.userId)?.displayName || "Message",
        body: type === "text" ? (content || "") : `Sent a ${type}`,
      });
    }
    socket.emit("message_sent", msg);
  });

  socket.on("send_group_message", (data) => {
    if (!socket.userId) return;
    const { groupId, content, type, fileUrl, fileName, fileSize, fileMime, replyToId, replyPreview } = data;
    const group = DB.groups.get(groupId);
    if (!group || !group.members.includes(socket.userId)) return;
    if (!group.canMembersSendMessages && !group.admins.includes(socket.userId)) return;
    const sender = DB.users.get(socket.userId);
    const msg = {
      id: uuidv4(), fromUserId: socket.userId,
      fromUsername: sender?.displayName || "Unknown",
      groupId, content: content || "", type: type || "text",
      fileUrl: fileUrl || null, fileName: fileName || null,
      fileSize: fileSize || null, fileMime: fileMime || null,
      replyToId: replyToId || null, replyPreview: replyPreview || null,
      reactions: [], edited: false, deleted: false, timestamp: Date.now(),
    };
    DB.messages.set(msg.id, msg);
    saveAll();
    group.members.forEach(uid => {
      if (uid === socket.userId) return;
      emitToUser(uid, "new_group_message", msg);
      pushNotify(uid, {
        title: `${sender?.displayName} in ${group.name}`,
        body: type === "text" ? (content || "") : `Sent a ${type}`,
      });
    });
    socket.emit("message_sent", msg);
  });

  socket.on("mark_read", ({ fromUserId }) => {
    if (!socket.userId) return;
    for (const [, m] of DB.messages) {
      if (m.fromUserId === fromUserId && m.toUserId === socket.userId && !m.read) m.read = true;
    }
    saveAll();
    emitToUser(fromUserId, "messages_read", { byUserId: socket.userId });
  });

  socket.on("delete_message", ({ messageId, toUserId }) => {
    if (!socket.userId) return;
    const msg = DB.messages.get(messageId);
    if (!msg || msg.fromUserId !== socket.userId) return;
    msg.deleted = true; msg.content = ""; msg.fileUrl = null;
    saveAll();
    if (toUserId) emitToUser(toUserId, "message_deleted", { messageId });
    if (msg.groupId) {
      const g = DB.groups.get(msg.groupId);
      if (g) g.members.forEach(uid => { if (uid !== socket.userId) emitToUser(uid, "message_deleted", { messageId }); });
    }
  });

  socket.on("typing_start", ({ toUserId }) => { if (socket.userId) emitToUser(toUserId, "user_typing", { userId: socket.userId }); });
  socket.on("typing_stop",  ({ toUserId }) => { if (socket.userId) emitToUser(toUserId, "user_stop_typing", { userId: socket.userId }); });

  socket.on("group_typing_start", ({ groupId }) => {
    if (!socket.userId) return;
    const g = DB.groups.get(groupId);
    if (g) g.members.forEach(uid => { if (uid !== socket.userId) emitToUser(uid, "user_typing", { userId: socket.userId, groupId }); });
  });
  socket.on("group_typing_stop", ({ groupId }) => {
    if (!socket.userId) return;
    const g = DB.groups.get(groupId);
    if (g) g.members.forEach(uid => { if (uid !== socket.userId) emitToUser(uid, "user_stop_typing", { userId: socket.userId, groupId }); });
  });

  // ── CALLS ──
  socket.on("call_user", ({ toUserId, offer, callId, callType }) => {
    if (!socket.userId) return;
    const caller = DB.users.get(socket.userId);
    emitToUser(toUserId, "incoming_call", {
      callId, fromUserId: socket.userId,
      fromUsername: caller?.displayName || "Unknown",
      fromAvatarColor: caller?.avatarColor,
      fromAvatarImg: caller?.avatarImg || null,
      offer, callType: callType || "voice",
    });
  });

  socket.on("answer_call", ({ callId, toUserId, answer }) => {
    if (!socket.userId) return;
    emitToUser(toUserId, "call_answered", { callId, answer });
  });

  socket.on("reject_call", ({ callId, toUserId }) => {
    if (!socket.userId) return;
    emitToUser(toUserId, "call_rejected", { callId });
  });

  socket.on("end_call", ({ callId, toUserId }) => {
    if (!socket.userId) return;
    emitToUser(toUserId, "call_ended", { callId });
  });

  socket.on("ice_candidate", ({ toUserId, candidate, callId }) => {
    if (!socket.userId) return;
    emitToUser(toUserId, "ice_candidate", { candidate, callId, fromUserId: socket.userId });
  });

  socket.on("disconnect", () => {
    const uid = socketUserMap.get(socket.id);
    if (uid) {
      socketUserMap.delete(socket.id);
      userSocketMap.delete(uid);
      const u = DB.users.get(uid);
      if (u) u.lastSeen = Date.now();
      broadcastToContacts(uid, "user_offline", { userId: uid, lastSeen: Date.now() });
    }
  });
});

// ── STATIC FALLBACK ──
app.get("*", (req, res) => {
  const p = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(p)) return res.sendFile(p);
  res.status(404).send("<h2>Place index.html in <code>public/</code> folder.</h2>");
});

// ── SW & MANIFEST ──
const manifest = {
  name: "Spark Messenger", short_name: "Spark", start_url: "/",
  display: "standalone", background_color: "#1565C0", theme_color: "#1565C0",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
};
const manifestPath = path.join(PUBLIC_DIR, "manifest.json");
if (!fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const swPath = path.join(PUBLIC_DIR, "sw.js");
if (!fs.existsSync(swPath)) {
  fs.writeFileSync(swPath, `
self.addEventListener('push', e => {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(d.title || 'Spark Messenger', {
    body: d.body || 'New message', icon: d.icon || '/icon-192.png',
    badge: '/icon-192.png', vibrate: [200, 100, 200],
    data: { url: '/' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) { if (c.url === '/' && 'focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow('/');
  }));
});
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
`);
}

server.listen(PORT, () => {
  console.log(`\n🚀 Spark Messenger v2 at http://localhost:${PORT}`);
  console.log(`📁 Public: ${PUBLIC_DIR}`);
  console.log(`📎 Uploads: ${UPLOAD_DIR}`);
  console.log(`💾 Data: ${DATA_DIR}\n`);
});
