import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { JwtPayload, sign, verify } from 'jsonwebtoken';
import { io, Socket } from 'socket.io-client';
import { MessagesModule } from '../src/messages/messages.module';
import {
  MessageAck,
  MessageContact,
  TestMessage,
  UserPublic,
} from '../src/messages/messages.types';

const TEST_SECRET = 'messages-e2e-only-secret-never-used-outside-this-suite';
const WAIT_MS = 4500;
type StoredUser = UserPublic & { tokenVersion: number };
type Peer = {
  socket: Socket;
  messages: TestMessage[];
  contacts: MessageContact[][];
};

function nextEvent<T>(
  socket: Socket,
  event: string,
  predicate: (value: T) => boolean = () => true,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}`));
    }, WAIT_MS);
    const listener = (value: T) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(value);
    };
    socket.on(event, listener);
  });
}

function requestAck<T>(
  socket: Socket,
  event: string,
  payload?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    socket
      .timeout(WAIT_MS)
      .emit(event, payload, (error: Error | null, ack: T) => {
        if (error) reject(error);
        else resolve(ack);
      });
  });
}

describe('Dynamic authenticated private messages (Socket.IO + local fake auth HTTP)', () => {
  let app: INestApplication;
  let upstream: Server;
  let baseUrl: string;
  let peers: Peer[];
  let users: Map<number, StoredUser>;
  let authMode: 'ok' | 'unavailable' | 'malformed' | 'mismatch' | 'timeout';
  let authRequests: number;

  function tokenFor(
    id: number,
    options: { expiresIn?: number; legacy?: boolean } = {},
  ): string {
    const user = users.get(id);
    return sign(
      {
        id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        ...(options.legacy
          ? {}
          : { role: user.role, tokenVersion: user.tokenVersion }),
      },
      TEST_SECRET,
      { algorithm: 'HS256', expiresIn: options.expiresIn ?? 60 },
    );
  }

  function publicUser(user: StoredUser): UserPublic {
    const { tokenVersion: _private, ...visible } = user;
    return visible;
  }

  beforeEach(async () => {
    peers = [];
    authRequests = 0;
    authMode = 'ok';
    users = new Map([
      [
        101,
        {
          id: 101,
          email: 'hevedrios@gmail.com',
          first_name: 'Player',
          last_name: 'One',
          role: 'player',
          tokenVersion: 0,
        },
      ],
      [
        202,
        {
          id: 202,
          email: 'najerad2223@gmail.com',
          first_name: 'Admin',
          last_name: 'Two',
          role: 'admin',
          tokenVersion: 0,
        },
      ],
      [
        303,
        {
          id: 303,
          email: 'new-player@example.test',
          first_name: 'New',
          last_name: 'Player',
          role: 'player',
          tokenVersion: 0,
        },
      ],
    ]);
    upstream = createServer((req, res) => {
      authRequests++;
      res.setHeader('Content-Type', 'application/json');
      if (authMode === 'timeout') return;
      if (authMode === 'unavailable') {
        res.statusCode = 503;
        res.end(JSON.stringify({ message: 'Simulated temporary outage' }));
        return;
      }
      let claims: JwtPayload;
      try {
        claims = verify(
          req.headers.authorization?.replace(/^Bearer /, '') ?? '',
          TEST_SECRET,
          { algorithms: ['HS256'] },
        ) as JwtPayload;
      } catch {
        res.statusCode = 401;
        res.end(JSON.stringify({ code: 'SESSION_REVOKED' }));
        return;
      }
      const user = users.get(claims.id);
      if (
        !user ||
        (claims.tokenVersion ?? 0) !== user.tokenVersion ||
        claims.email !== user.email ||
        (claims.role !== undefined && claims.role !== user.role)
      ) {
        res.statusCode = 401;
        res.end(
          JSON.stringify({
            code: user ? 'SESSION_REVOKED' : 'ACCOUNT_NOT_FOUND',
          }),
        );
        return;
      }
      if (req.url === '/api/auth/me') {
        const profile =
          authMode === 'mismatch'
            ? publicUser(users.get(202))
            : publicUser(user);
        res.end(
          JSON.stringify({
            user: authMode === 'malformed' ? { id: user.id } : profile,
          }),
        );
      } else if (req.url === '/api/users/contacts') {
        res.end(
          JSON.stringify({
            users: [...users.values()]
              .filter((entry) => entry.id !== user.id)
              .map(publicUser),
          }),
        );
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const authUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const moduleRef = await Test.createTestingModule({
      imports: [MessagesModule],
    })
      .overrideProvider(ConfigService)
      .useValue({
        getOrThrow: (name: string) => {
          if (name === 'JWT_SECRET') return TEST_SECRET;
          if (name === 'AUTH_API_URL') return authUrl;
          throw new Error(`Unexpected configuration key ${name}`);
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  });

  afterEach(async () => {
    for (const peer of peers) {
      peer.socket.disconnect();
      peer.socket.removeAllListeners();
    }
    if (app) await app.close();
    if (upstream) {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  async function connect(
    token: string | undefined,
    namespace = '/mensajes-prueba',
  ): Promise<Peer> {
    const socket = io(`${baseUrl}${namespace}`, {
      auth: token === undefined ? {} : { token },
      transports: ['websocket'],
      autoConnect: false,
      reconnection: false,
      forceNew: true,
      timeout: WAIT_MS,
      extraHeaders: { Origin: 'http://localhost:5173' },
    });
    const peer: Peer = { socket, messages: [], contacts: [] };
    peers.push(peer);
    socket.on('mensajes:recibir', (message: TestMessage) =>
      peer.messages.push(message),
    );
    socket.on('mensajes:contactos', ({ users: contacts }) =>
      peer.contacts.push(contacts),
    );
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    return peer;
  }

  function send(
    peer: Peer,
    toUserId: number,
    clientMessageId: string,
    text = 'Hello',
  ): Promise<MessageAck> {
    return requestAck(peer.socket, 'mensajes:enviar', {
      toUserId,
      clientMessageId,
      text,
    });
  }

  async function deliver(
    sender: Peer,
    recipient: Peer,
    toUserId: number,
    clientMessageId: string,
    text = 'Hello',
  ): Promise<TestMessage> {
    const receiving = nextEvent<TestMessage>(
      recipient.socket,
      'mensajes:recibir',
      (msg) => msg.clientMessageId === clientMessageId,
    );
    const [ack, message] = await Promise.all([
      send(sender, toUserId, clientMessageId, text),
      receiving,
    ]);
    expect(ack).toEqual({ ok: true, message });
    expect(message).toMatchObject({
      toUserId,
      clientMessageId,
      text: text.trim(),
    });
    expect(Number.isNaN(Date.parse(message.sentAt))).toBe(false);
    return message;
  }

  it('admits a newly registered account and routes privately by stable IDs in both directions', async () => {
    const player = await connect(tokenFor(101));
    const admin = await connect(tokenFor(202));
    const newcomer = await connect(tokenFor(303));
    const first = await deliver(newcomer, admin, 202, 'new-to-admin', ' Hola ');
    expect(first).toMatchObject({
      fromUserId: 303,
      from: users.get(303).email,
      to: users.get(202).email,
    });
    await deliver(admin, newcomer, 303, 'admin-to-new');
    await deliver(player, admin, 202, 'privacy-barrier');
    expect(player.messages.map((message) => message.clientMessageId)).toEqual([
      'privacy-barrier',
    ]);
    expect(
      newcomer.messages.map((message) => message.clientMessageId),
    ).not.toContain('privacy-barrier');
  });

  it.each(['missing', 'malformed', 'expired', 'forged', 'unsigned'])(
    'rejects %s JWT before contacting HTTP',
    async (kind) => {
      const token =
        kind === 'missing'
          ? undefined
          : kind === 'malformed'
            ? 'not-a-jwt'
            : kind === 'expired'
              ? tokenFor(101, { expiresIn: -1 })
              : kind === 'forged'
                ? sign(
                    { id: 101, email: users.get(101).email },
                    'wrong-secret',
                    { expiresIn: 60 },
                  )
                : sign(
                    {
                      id: 101,
                      email: users.get(101).email,
                      exp: Math.floor(Date.now() / 1000) + 60,
                    },
                    null,
                    { algorithm: 'none' },
                  );
      const code =
        kind === 'missing'
          ? 'TOKEN_REQUIRED'
          : kind === 'expired'
            ? 'TOKEN_EXPIRED'
            : 'INVALID_TOKEN';
      await expect(connect(token)).rejects.toMatchObject({ data: { code } });
      expect(authRequests).toBe(0);
    },
  );

  it('rejects deleted accounts and stale token versions even with a valid signature', async () => {
    const removed = tokenFor(303);
    users.delete(303);
    await expect(connect(removed)).rejects.toMatchObject({
      data: { code: 'ACCOUNT_NOT_FOUND' },
    });
    const stale = tokenFor(101);
    users.get(101).tokenVersion++;
    await expect(connect(stale)).rejects.toMatchObject({
      data: { code: 'SESSION_REVOKED' },
    });
  });

  it('allows legacy version-zero JWT only while the authoritative account remains valid', async () => {
    const legacy = tokenFor(101, { legacy: true });
    const player = await connect(legacy);
    const admin = await connect(tokenFor(202));
    await deliver(player, admin, 202, 'legacy-works');
    users.get(101).tokenVersion++;
    const disconnected = nextEvent<string>(player.socket, 'disconnect');
    expect(await send(player, 202, 'legacy-revoked')).toMatchObject({
      ok: false,
      error: { code: 'SESSION_REVOKED' },
    });
    await disconnected;
  });

  it.each(['unavailable', 'malformed', 'mismatch', 'timeout'] as const)(
    'fails closed for %s auth HTTP responses',
    async (mode) => {
      authMode = mode;
      await expect(connect(tokenFor(101))).rejects.toMatchObject({
        data: {
          code: mode === 'mismatch' ? 'SESSION_REVOKED' : 'AUTH_UNAVAILABLE',
        },
      });
    },
  );

  it.each(['deleted', 'password', 'email', 'role'])(
    'revalidates an open sender after %s changes',
    async (change) => {
      const player = await connect(tokenFor(101));
      const admin = await connect(tokenFor(202));
      const closed = nextEvent<string>(player.socket, 'disconnect');
      if (change === 'deleted') users.delete(101);
      else {
        users.get(101).tokenVersion++;
        if (change === 'email') users.get(101).email = 'changed@example.test';
        if (change === 'role') users.get(101).role = 'admin';
      }
      expect(await send(player, 202, 'must-not-send')).toMatchObject({
        ok: false,
        error: {
          code: change === 'deleted' ? 'ACCOUNT_NOT_FOUND' : 'SESSION_REVOKED',
        },
      });
      await closed;
      expect(admin.messages).toEqual([]);
    },
  );

  it('prevents a revoked recipient tab from reading later messages', async () => {
    const player = await connect(tokenFor(101));
    const admin = await connect(tokenFor(202));
    users.get(202).tokenVersion++;
    const closed = nextEvent<string>(admin.socket, 'disconnect');
    expect(await send(player, 202, 'revoked-recipient')).toMatchObject({
      ok: true,
    });
    await closed;
    expect(admin.messages).toEqual([]);
  });

  it('keeps valid sockets usable after a temporary upstream outage without accepting messages', async () => {
    const player = await connect(tokenFor(101));
    const admin = await connect(tokenFor(202));
    authMode = 'unavailable';
    expect(await send(player, 202, 'during-outage')).toMatchObject({
      ok: false,
      error: { code: 'AUTH_UNAVAILABLE' },
    });
    expect(player.socket.connected).toBe(true);
    authMode = 'ok';
    await deliver(player, admin, 202, 'after-outage');
    expect(admin.messages.map((message) => message.clientMessageId)).toEqual([
      'after-outage',
    ]);
  });

  it('returns contacts and tracks presence across several tabs', async () => {
    const player = await connect(tokenFor(101));
    const tab1 = await connect(tokenFor(202));
    const tab2 = await connect(tokenFor(202));
    const ack = await requestAck<{ ok: boolean; users: MessageContact[] }>(
      player.socket,
      'mensajes:contactos:solicitar',
    );
    expect(ack.ok).toBe(true);
    expect(ack.users.find((user) => user.id === 202)).toMatchObject({
      online: true,
      role: 'admin',
    });
    expect(ack.users.some((user) => user.id === 101)).toBe(false);
    const receives1 = nextEvent<TestMessage>(tab1.socket, 'mensajes:recibir');
    const receives2 = nextEvent<TestMessage>(tab2.socket, 'mensajes:recibir');
    await Promise.all([send(player, 202, 'all-tabs'), receives1, receives2]);
    tab1.socket.disconnect();
    await deliver(tab2, player, 101, 'last-tab-active');
    const stillOnline = await requestAck<{ users: MessageContact[] }>(
      player.socket,
      'mensajes:contactos:solicitar',
    );
    expect(stillOnline.users.find((user) => user.id === 202).online).toBe(true);
    const offline = nextEvent<{ users: MessageContact[] }>(
      player.socket,
      'mensajes:contactos',
      (value) => !value.users.find((user) => user.id === 202)?.online,
    );
    tab2.socket.disconnect();
    await offline;
  });

  it('rejects unknown recipients and extra forged identity fields', async () => {
    const player = await connect(tokenFor(101));
    expect(await send(player, 999, 'unknown')).toMatchObject({
      ok: false,
      error: { code: 'RECIPIENT_NOT_FOUND' },
    });
    for (const extra of [
      { from: 'forged@example.test' },
      { fromUserId: 202 },
      { to: 'forged@example.test' },
    ]) {
      expect(
        await requestAck(player.socket, 'mensajes:enviar', {
          toUserId: 202,
          clientMessageId: 'forged',
          text: 'Hello',
          ...extra,
        }),
      ).toMatchObject({ ok: false, error: { code: 'INVALID_MESSAGE' } });
    }
  });

  it.each([
    { toUserId: 202, clientMessageId: 'invalid', text: '' },
    { toUserId: 202, clientMessageId: 'invalid', text: '   \n ' },
    { toUserId: 202, clientMessageId: 'invalid', text: 'a'.repeat(1001) },
    { toUserId: '202', clientMessageId: 'invalid', text: 'Hello' },
    { toUserId: 202, clientMessageId: 'not a valid id', text: 'Hello' },
    { toUserId: 202, text: 'Hello' },
  ])('rejects malformed messages %#', async (payload) => {
    const player = await connect(tokenFor(101));
    expect(
      await requestAck(player.socket, 'mensajes:enviar', payload),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_MESSAGE' } });
  });

  it('deduplicates concurrent retries and rejects reuse across text or conversation', async () => {
    const player = await connect(tokenFor(101));
    const admin = await connect(tokenFor(202));
    const first = await deliver(player, admin, 202, 'retry');
    const repeated = await Promise.all([
      send(player, 202, 'retry'),
      send(player, 202, 'retry'),
    ]);
    expect(repeated).toEqual([
      { ok: true, message: first },
      { ok: true, message: first },
    ]);
    expect(await send(player, 202, 'retry', 'Different')).toMatchObject({
      ok: false,
      error: { code: 'MESSAGE_ID_CONFLICT' },
    });
    expect(await send(player, 303, 'retry')).toMatchObject({
      ok: false,
      error: { code: 'MESSAGE_ID_CONFLICT' },
    });
    await deliver(player, admin, 202, 'barrier');
    expect(
      admin.messages.filter((message) => message.clientMessageId === 'retry'),
    ).toHaveLength(1);
    const reverse = await deliver(admin, player, 101, 'retry');
    expect(reverse.id).not.toBe(first.id);
  });

  it('ends an open socket at token expiry and removes presence', async () => {
    const player = await connect(tokenFor(101, { expiresIn: 2 }));
    const admin = await connect(tokenFor(202));
    const error = nextEvent<{ code: string }>(player.socket, 'mensajes:error');
    const closed = nextEvent<string>(player.socket, 'disconnect');
    const offline = nextEvent<{ users: MessageContact[] }>(
      admin.socket,
      'mensajes:contactos',
      (value) => !value.users.find((user) => user.id === 101)?.online,
    );
    expect((await error).code).toBe('TOKEN_EXPIRED');
    await Promise.all([closed, offline]);
  });

  it('keeps private protocol out of the root namespace', async () => {
    const player = await connect(tokenFor(101));
    const admin = await connect(tokenFor(202));
    const outside = await connect(undefined, '/');
    await deliver(player, admin, 202, 'namespace');
    expect(outside.messages).toEqual([]);
    expect(outside.contacts).toEqual([]);
  });
});
