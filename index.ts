export interface User {
  id: string;
  phone: string;
  displayName: string;
  avatarColor: string;
  avatarImg: string | null;
  status: string;
  about: string;
  lastSeen: number;
  createdAt: number;
  online?: boolean;
}

export interface Message {
  id: string;
  fromUserId: string;
  toUserId?: string;
  groupId?: string;
  fromUsername?: string;
  content: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'location' | 'poll';
  fileUrl?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  fileMime?: string | null;
  replyToId?: string | null;
  replyPreview?: string | null;
  forwarded?: boolean;
  reactions: Reaction[];
  read: boolean;
  edited: boolean;
  deleted: boolean;
  timestamp: number;
  pollId?: string | null;
  location?: { lat: number; lng: number; label?: string } | null;
}

export interface Reaction {
  userId: string;
  emoji: string;
}

export interface Group {
  id: string;
  name: string;
  members: string[];
  admins: string[];
  createdBy: string;
  avatarColor: string;
  avatarImg: string | null;
  description: string;
  canMembersSendMessages: boolean;
  createdAt: number;
}

export interface Status {
  id: string;
  content: string;
  type: 'text' | 'image' | 'video';
  overlays?: any[];
  bgColor?: string | null;
  textStyle?: string | null;
  timestamp: number;
}

export interface UserStatus {
  user: User;
  statuses: Status[];
  isMe: boolean;
}

export interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  createdBy: string;
  multipleAnswers: boolean;
  createdAt: number;
}

export interface PollOption {
  id: number;
  text: string;
  voters: string[];
}

export interface CallRecord {
  id: string;
  type: 'incoming' | 'outgoing';
  status: 'completed' | 'missed' | 'rejected';
  callType: 'voice' | 'video';
  userId: string;
  userName: string;
  duration: number;
  timestamp: number;
}

export interface Chat {
  id: string;
  type: 'direct' | 'group';
  name: string;
  avatarColor: string;
  avatarImg: string | null;
  lastMessage?: Message;
  unreadCount: number;
  pinned: boolean;
  archived: boolean;
  user?: User;
  group?: Group;
  isPrivateVault?: boolean;
}
