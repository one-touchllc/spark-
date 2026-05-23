import { Server as SocketServer } from 'socket.io';
import { DB, getSet, getArr, saveAll, JWT_SECRET } from './db';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

export const socketUserMap = new Map<string, string>(); // socketId -> userId
export const userSocketMap = new Map<string, string>(); // userId -> socketId
export let io: SocketServer | null = null;

export function emitToUser(userId: string, event: string, data: any) {
  const socketId = userSocketMap.get(userId);
  if (socketId && io) io.to(socketId).emit(event, data);
}

export function broadcastToContacts(userId: string, event: string, data: any) {
  for (const [uid, contactSet] of DB.contacts) {
    if (contactSet.has(userId)) emitToUser(uid, event, data);
  }
}

export function initSocket(server: any) {
  if (io) return io;
  io = new SocketServer(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
  });

  io.on('connection', (socket) => {
    socket.on('authenticate', (token: string) => {
      try {
        const { userId } = jwt.verify(token, JWT_SECRET) as any;
        socketUserMap.set(socket.id, userId);
        userSocketMap.set(userId, socket.id);
        (socket as any).userId = userId;
        socket.emit('authenticated');
        const user = DB.users.get(userId);
        if (user) user.lastSeen = Date.now();
        broadcastToContacts(userId, 'user_online', { userId });
      } catch {
        socket.emit('auth_error', 'Invalid token');
      }
    });

    socket.on('send_message', (data: any) => {
      const userId = (socket as any).userId;
      if (!userId) return;
      const { toUserId, content, type, fileUrl, fileName, fileSize, fileMime, replyToId, replyPreview, forwarded, pollId, location } = data;
      if (getSet(DB.blocked, toUserId).has(userId)) return;
      const msg = {
        id: uuidv4(), fromUserId: userId, toUserId,
        content: content || '', type: type || 'text',
        fileUrl: fileUrl || null, fileName: fileName || null,
        fileSize: fileSize || null, fileMime: fileMime || null,
        replyToId: replyToId || null, replyPreview: replyPreview || null,
        forwarded: forwarded || false, reactions: [], read: false,
        edited: false, deleted: false, timestamp: Date.now(),
        pollId: pollId || null, location: location || null,
      };
      DB.messages.set(msg.id, msg);
      saveAll();
      const recipientSocket = userSocketMap.get(toUserId);
      if (recipientSocket && io) io.to(recipientSocket).emit('new_message', msg);
      socket.emit('message_sent', msg);
    });

    socket.on('send_group_message', (data: any) => {
      const userId = (socket as any).userId;
      if (!userId) return;
      const { groupId, content, type, fileUrl, fileName, fileSize, fileMime, replyToId, replyPreview, pollId, location } = data;
      const group = DB.groups.get(groupId);
      if (!group || !group.members.includes(userId)) return;
      if (!group.canMembersSendMessages && !group.admins.includes(userId)) return;
      const sender = DB.users.get(userId);
      const msg = {
        id: uuidv4(), fromUserId: userId,
        fromUsername: sender?.displayName || 'Unknown', groupId,
        content: content || '', type: type || 'text',
        fileUrl: fileUrl || null, fileName: fileName || null,
        fileSize: fileSize || null, fileMime: fileMime || null,
        replyToId: replyToId || null, replyPreview: replyPreview || null,
        reactions: [], edited: false, deleted: false, timestamp: Date.now(),
        pollId: pollId || null, location: location || null,
      };
      DB.messages.set(msg.id, msg);
      saveAll();
      group.members.forEach((uid: string) => {
        if (uid !== userId) emitToUser(uid, 'new_group_message', msg);
      });
      socket.emit('message_sent', msg);
    });

    socket.on('mark_read', ({ fromUserId }: any) => {
      const userId = (socket as any).userId;
      if (!userId) return;
      for (const [, m] of DB.messages) {
        if (m.fromUserId === fromUserId && m.toUserId === userId && !m.read) m.read = true;
      }
      saveAll();
      emitToUser(fromUserId, 'messages_read', { byUserId: userId });
    });

    socket.on('delete_message', ({ messageId, toUserId }: any) => {
      const userId = (socket as any).userId;
      if (!userId) return;
      const msg = DB.messages.get(messageId);
      if (!msg || msg.fromUserId !== userId) return;
      msg.deleted = true; msg.content = ''; msg.fileUrl = null;
      saveAll();
      emitToUser(toUserId, 'message_deleted', { messageId });
    });

    socket.on('typing_start', ({ toUserId }: any) => {
      const userId = (socket as any).userId;
      if (!userId) return;
      emitToUser(toUserId, 'user_typing', { userId });
    });
    socket.on('typing_stop', ({ toUserId }: any) => {
      const userId = (socket as any).userId;
      if (!userId) return;
      emitToUser(toUserId, 'user_stop_typing', { userId });
    });
    socket.on('group_typing_start', ({ groupId }: any) => {
      const userId = (socket as any).userId;
      if (!userId) return;
      const group = DB.groups.get(groupId);
      if (!group) return;
      group.members.forEach((uid: string) => {
        if (uid !== userId) emitToUser(uid, 'user_typing', { userId, groupId });
      });
    });
    socket.on('group_typing_stop', ({ groupId }: any) => {
      const userId = (socket as any).userId;
      if (!userId) return;
      const group = DB.groups.get(groupId);
      if (!group) return;
      group.members.forEach((uid: string) => {
        if (uid !== userId) emitToUser(uid, 'user_stop_typing', { userId, groupId });
      });
    });

    socket.on('call_user', ({ toUserId, offer, callId, callType }: any) => {
      const userId = (socket as any).userId;
      if (!userId) return;
      const caller = DB.users.get(userId);
      emitToUser(toUserId, 'incoming_call', {
        callId, fromUserId: userId,
        fromUsername: caller?.displayName || 'Unknown',
        fromAvatarColor: caller?.avatarColor,
        fromAvatarImg: caller?.avatarImg || null,
        offer, callType: callType || 'voice',
      });
    });
    socket.on('answer_call', ({ callId, toUserId, answer }: any) => {
      emitToUser(toUserId, 'call_answered', { callId, answer });
    });
    socket.on('reject_call', ({ callId, toUserId }: any) => {
      emitToUser(toUserId, 'call_rejected', { callId });
    });
    socket.on('end_call', ({ callId, toUserId, duration, callType }: any) => {
      emitToUser(toUserId, 'call_ended', { callId });
    });
    socket.on('ice_candidate', ({ toUserId, candidate, callId }: any) => {
      emitToUser(toUserId, 'ice_candidate', { candidate, callId, fromUserId: (socket as any).userId });
    });

    socket.on('disconnect', () => {
      const userId = socketUserMap.get(socket.id);
      if (userId) {
        socketUserMap.delete(socket.id);
        userSocketMap.delete(userId);
        const user = DB.users.get(userId);
        if (user) user.lastSeen = Date.now();
        broadcastToContacts(userId, 'user_offline', { userId, lastSeen: Date.now() });
      }
    });
  });

  return io;
}
