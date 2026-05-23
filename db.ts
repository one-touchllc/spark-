import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function saveFile(filename: string, data: Map<any, any> | any) {
  try {
    let toSave: any;
    if (data instanceof Map) {
      toSave = Array.from(data.entries()).map(([k, v]) => {
        if (v instanceof Set) return [k, Array.from(v)];
        return [k, v];
      });
    } else {
      toSave = data;
    }
    fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(toSave, null, 2));
  } catch (e: any) {
    console.error(`Save error ${filename}:`, e.message);
  }
}

function loadFile(filename: string, isMap = false, isSetMap = false): any {
  try {
    const p = path.join(DATA_DIR, filename);
    if (!fs.existsSync(p)) return isMap ? new Map() : null;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (isMap) {
      const m = new Map(parsed);
      if (isSetMap) {
        const sm = new Map();
        for (const [k, v] of m) sm.set(k, new Set(v as any[]));
        return sm;
      }
      return m;
    }
    return parsed;
  } catch {
    return isMap ? new Map() : null;
  }
}

export const DB = {
  users: loadFile('users.json', true) as Map<string, any>,
  userByPhone: loadFile('userByPhone.json', true) as Map<string, string>,
  messages: loadFile('messages.json', true) as Map<string, any>,
  groups: loadFile('groups.json', true) as Map<string, any>,
  statuses: loadFile('statuses.json', true) as Map<string, any[]>,
  contacts: loadFile('contacts.json', true, true) as Map<string, Set<string>>,
  pinned: loadFile('pinned.json', true, true) as Map<string, Set<string>>,
  archived: loadFile('archived.json', true, true) as Map<string, Set<string>>,
  wallpapers: loadFile('wallpapers.json', true) as Map<string, any>,
  starred: loadFile('starred.json', true, true) as Map<string, Set<string>>,
  blocked: loadFile('blocked.json', true, true) as Map<string, Set<string>>,
  pushSubs: loadFile('pushSubs.json', true) as Map<string, any>,
  callHistory: loadFile('callHistory.json', true) as Map<string, any[]>,
  polls: loadFile('polls.json', true) as Map<string, any>,
  privateVaultPasswords: loadFile('privateVaultPasswords.json', true) as Map<string, string>,
  privateVaultChats: loadFile('privateVaultChats.json', true, true) as Map<string, Set<string>>,
};

export function saveAll() {
  saveFile('users.json', DB.users);
  saveFile('userByPhone.json', DB.userByPhone);
  saveFile('messages.json', DB.messages);
  saveFile('groups.json', DB.groups);
  saveFile('statuses.json', DB.statuses);
  saveFile('wallpapers.json', DB.wallpapers);
  saveFile('pushSubs.json', DB.pushSubs);
  saveFile('callHistory.json', DB.callHistory);
  saveFile('polls.json', DB.polls);
  saveFile('privateVaultPasswords.json', DB.privateVaultPasswords);
  saveFile('contacts.json', DB.contacts);
  saveFile('pinned.json', DB.pinned);
  saveFile('archived.json', DB.archived);
  saveFile('starred.json', DB.starred);
  saveFile('blocked.json', DB.blocked);
  saveFile('privateVaultChats.json', DB.privateVaultChats);
}

setInterval(saveAll, 30000);

export const getSet = (map: Map<string, Set<string>>, key: string) => {
  if (!map.has(key)) map.set(key, new Set());
  return map.get(key)!;
};
export const getArr = (map: Map<string, any[]>, key: string) => {
  if (!map.has(key)) map.set(key, []);
  return map.get(key)!;
};
export const getObj = (map: Map<string, any>, key: string) => {
  if (!map.has(key)) map.set(key, {});
  return map.get(key)!;
};

export const AVATAR_COLORS = [
  '#1565C0','#0D47A1','#1976D2','#2196F3','#00897B',
  '#388E3C','#F57C00','#E64A19','#6A1B9A','#AD1457','#00838F','#37474F'
];
export const randomColor = () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

export function getConversation(userA: string, userB: string) {
  const msgs: any[] = [];
  for (const [, m] of DB.messages) {
    if (!m.groupId && ((m.fromUserId === userA && m.toUserId === userB) || (m.fromUserId === userB && m.toUserId === userA))) {
      msgs.push(m);
    }
  }
  return msgs.sort((a, b) => a.timestamp - b.timestamp);
}

export const JWT_SECRET = process.env.JWT_SECRET || 'spark_secret_' + crypto.randomBytes(8).toString('hex');
export const UPLOADS_PATH = UPLOADS_DIR;
