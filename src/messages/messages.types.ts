export const MESSAGE_ACCOUNTS = [
  'hevedrios@gmail.com',
  'najerad2223@gmail.com',
] as const;

export type MessageAccount = (typeof MESSAGE_ACCOUNTS)[number];

export type MessageIdentity = {
  userId: string;
  email: MessageAccount;
  expiresAt: number;
};

export type TestMessage = {
  id: string;
  clientMessageId: string;
  from: MessageAccount;
  to: MessageAccount;
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
