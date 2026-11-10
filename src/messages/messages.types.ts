export type UserPublic = {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  role: 'player' | 'admin';
};

export type MessageIdentity = {
  user: UserPublic;
  expiresAt: number;
};

export type MessageContact = UserPublic & { online: boolean };

export type TestMessage = {
  id: string;
  clientMessageId: string;
  from: string;
  to: string;
  fromUserId: number;
  toUserId: number;
  text: string;
  sentAt: string;
};

export type MessageError = {
  code: string;
  message: string;
};

export type MessageAck =
  | { ok: true; message: TestMessage }
  | { ok: false; error: MessageError };

export type ContactsAck =
  | { ok: true; users: MessageContact[] }
  | { ok: false; error: MessageError };
