import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { sign } from 'jsonwebtoken';
import { io, Socket } from 'socket.io-client';
import { MessagesModule } from '../src/messages/messages.module';

const TEST_SECRET = 'messages-e2e-only-secret-never-used-outside-this-suite';
const PLAYER_EMAIL = 'hevedrios@gmail.com';
const ADMIN_EMAIL = 'najerad2223@gmail.com';
const NAMESPACE = '/mensajes-prueba';
const WAIT_MS = 2500;

interface Message {
  id: string;
  clientMessageId: string;
  from: string;
  to: string;
  text: string;
  sentAt: string;
}

interface Presence {
  selfEmail: string;
  peerEmail: string;
  peerOnline: boolean;
}

type Ack =
  | { ok: true; message: Message }
  | { ok: false; error: { code: string; message: string } };

interface Peer {
  socket: Socket;
  messages: Message[];
  states: Presence[];
}

function tokenFor(email: string, expiresIn: number = 60): string {
  // Match the existing MySQL login claims. No database or real login is used.
  return sign(
    {
      id: email === PLAYER_EMAIL ? 101 : 202,
      email,
      first_name: 'Integration',
      last_name: 'Test',
    },
    TEST_SECRET,
    { algorithm: 'HS256', expiresIn },
  );
}

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

function send(socket: Socket, payload: unknown): Promise<Ack> {
  return new Promise((resolve, reject) => {
    socket
      .timeout(WAIT_MS)
      .emit('mensajes:enviar', payload, (error: Error | null, ack: Ack) => {
        if (error) reject(error);
        else resolve(ack);
      });
  });
}

describe('Authenticated test messages (real Socket.IO gateway, isolated module)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let peers: Peer[];

  beforeEach(async () => {
    peers = [];
    const moduleRef = await Test.createTestingModule({
      imports: [MessagesModule],
    })
      .overrideProvider(ConfigService)
      .useValue({
        get: (name: string) =>
          name === 'JWT_SECRET' ? TEST_SECRET : undefined,
        getOrThrow: (name: string) => {
          if (name === 'JWT_SECRET') return TEST_SECRET;
          throw new Error(`Unexpected test configuration key: ${name}`);
        },
      })
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const peer of peers) {
      peer.socket.disconnect();
      peer.socket.removeAllListeners();
    }
    if (app) await app.close();
  });

  async function connect(
    token: string | undefined,
    namespace: string = NAMESPACE,
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
    const peer: Peer = { socket, messages: [], states: [] };
    peers.push(peer);
    socket.on('mensajes:recibir', (message: Message) =>
      peer.messages.push(message),
    );
    socket.on('mensajes:estado', (state: Presence) => peer.states.push(state));

    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        socket.off('connect_error', reject);
        resolve();
      });
      socket.once('connect_error', reject);
      socket.connect();
    });
    return peer;
  }

  async function expectAuthError(token: string | undefined, code: string) {
    await expect(connect(token)).rejects.toMatchObject({ data: { code } });
    expect(peers.every((peer) => !peer.socket.connected)).toBe(true);
  }

  async function expectDelivery(
    sender: Peer,
    recipient: Peer,
    from: string,
    to: string,
    clientMessageId: string,
    text: string,
  ): Promise<Message> {
    const recipientMessage = nextEvent<Message>(
      recipient.socket,
      'mensajes:recibir',
      (message) => message.clientMessageId === clientMessageId,
    );
    const senderMessage = nextEvent<Message>(
      sender.socket,
      'mensajes:recibir',
      (message) => message.clientMessageId === clientMessageId,
    );
    const [ack, received, echoed] = await Promise.all([
      send(sender.socket, { clientMessageId, text }),
      recipientMessage,
      senderMessage,
    ]);
    expect(ack.ok).toBe(true);
    if (ack.ok !== true)
      throw new Error('Expected successful message acknowledgement');
    expect(echoed).toEqual(received);
    expect(ack.message).toEqual(received);
    expect(received).toMatchObject({
      clientMessageId,
      from,
      to,
      text: text.trim(),
    });
    expect(typeof received.id).toBe('string');
    expect(received.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(received.sentAt))).toBe(false);
    return received;
  }

  it('delivers between both allowed accounts, with authenticated sender and server acknowledgement', async () => {
    const player = await connect(tokenFor(PLAYER_EMAIL));
    const admin = await connect(tokenFor(ADMIN_EMAIL));
    await expectDelivery(
      player,
      admin,
      PLAYER_EMAIL,
      ADMIN_EMAIL,
      'player-1',
      ' Hola admin ',
    );
    await expectDelivery(
      admin,
      player,
      ADMIN_EMAIL,
      PLAYER_EMAIL,
      'admin-1',
      'Hola jugador',
    );
  });

  it.each([
    ['missing token', undefined, 'TOKEN_REQUIRED'],
    ['malformed token', 'not-a-jwt', 'INVALID_TOKEN'],
    ['expired token', tokenFor(PLAYER_EMAIL, -1), 'TOKEN_EXPIRED'],
    [
      'different account',
      tokenFor('outsider@example.test'),
      'ACCOUNT_NOT_ALLOWED',
    ],
    [
      'forged signature',
      sign({ id: 101, email: PLAYER_EMAIL }, 'wrong-e2e-secret', {
        expiresIn: 60,
      }),
      'INVALID_TOKEN',
    ],
  ])('rejects connection with %s', async (_label, token, code) => {
    await expectAuthError(token, code as string);
  });

  it('rejects an unsigned token even when the payload names an allowed account', async () => {
    const unsigned = sign(
      { id: 101, email: PLAYER_EMAIL, exp: Math.floor(Date.now() / 1000) + 60 },
      null,
      { algorithm: 'none' },
    );
    await expectAuthError(unsigned, 'INVALID_TOKEN');
  });

  it('ends a connected session when its signed token expires and updates presence', async () => {
    const admin = await connect(tokenFor(ADMIN_EMAIL));
    const online = nextEvent<Presence>(
      admin.socket,
      'mensajes:estado',
      (state) => state.peerOnline,
    );
    const [player] = await Promise.all([
      connect(tokenFor(PLAYER_EMAIL, 2)),
      online,
    ]);
    const expired = nextEvent<{ code: string }>(
      player.socket,
      'mensajes:error',
    );
    const disconnected = nextEvent<string>(player.socket, 'disconnect');
    const offline = nextEvent<Presence>(
      admin.socket,
      'mensajes:estado',
      (state) => !state.peerOnline,
    );
    const [error, reason, state] = await Promise.all([
      expired,
      disconnected,
      offline,
    ]);
    expect(error.code).toBe('TOKEN_EXPIRED');
    expect(reason).toBe('io server disconnect');
    expect(state.peerOnline).toBe(false);
    expect(player.socket.connected).toBe(false);
  });

  it('rejects a sender or recipient supplied by the client', async () => {
    const player = await connect(tokenFor(PLAYER_EMAIL));
    const admin = await connect(tokenFor(ADMIN_EMAIL));
    for (const extra of [
      { from: ADMIN_EMAIL },
      { to: 'outsider@example.test' },
    ]) {
      expect(
        await send(player.socket, {
          clientMessageId: 'spoof-attempt',
          text: 'forged identity',
          ...extra,
        }),
      ).toMatchObject({ ok: false, error: { code: 'INVALID_MESSAGE' } });
    }
    await expectDelivery(
      player,
      admin,
      PLAYER_EMAIL,
      ADMIN_EMAIL,
      'after-spoof',
      'Identity remains authenticated',
    );
    expect(admin.messages.map((message) => message.clientMessageId)).toEqual([
      'after-spoof',
    ]);
  });

  it.each([
    ['empty text', { clientMessageId: 'invalid', text: '' }],
    ['whitespace', { clientMessageId: 'invalid', text: '   \n\t ' }],
    [
      'non-string text',
      { clientMessageId: 'invalid', text: { message: 'hello' } },
    ],
    ['oversized text', { clientMessageId: 'invalid', text: 'a'.repeat(1001) }],
    ['missing message id', { text: 'hello' }],
    [
      'invalid message id',
      { clientMessageId: 'not a valid id', text: 'hello' },
    ],
  ])('rejects %s without delivering it', async (_label, payload) => {
    const player = await connect(tokenFor(PLAYER_EMAIL));
    const admin = await connect(tokenFor(ADMIN_EMAIL));
    expect(await send(player.socket, payload)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_MESSAGE' },
    });
    await expectDelivery(
      player,
      admin,
      PLAYER_EMAIL,
      ADMIN_EMAIL,
      'valid-after-invalid',
      'valid',
    );
    expect(admin.messages.map((message) => message.clientMessageId)).toEqual([
      'valid-after-invalid',
    ]);
  });

  it('acknowledges a duplicate id with the original message and delivers only once', async () => {
    const player = await connect(tokenFor(PLAYER_EMAIL));
    const admin = await connect(tokenFor(ADMIN_EMAIL));
    const first = await expectDelivery(
      player,
      admin,
      PLAYER_EMAIL,
      ADMIN_EMAIL,
      'retry-1',
      'Only once',
    );
    expect(
      await send(player.socket, {
        clientMessageId: 'retry-1',
        text: 'Only once',
      }),
    ).toEqual({ ok: true, message: first });
    // A later delivery provides a processing barrier for all preceding messages.
    await expectDelivery(
      player,
      admin,
      PLAYER_EMAIL,
      ADMIN_EMAIL,
      'after-retry',
      'Barrier',
    );
    expect(
      player.messages.filter(
        (message) => message.clientMessageId === 'retry-1',
      ),
    ).toHaveLength(1);
    expect(
      admin.messages.filter((message) => message.clientMessageId === 'retry-1'),
    ).toHaveLength(1);
  });

  it('rejects reuse of an id with changed text', async () => {
    const player = await connect(tokenFor(PLAYER_EMAIL));
    const admin = await connect(tokenFor(ADMIN_EMAIL));
    await expectDelivery(
      player,
      admin,
      PLAYER_EMAIL,
      ADMIN_EMAIL,
      'conflict-1',
      'Original',
    );
    expect(
      await send(player.socket, {
        clientMessageId: 'conflict-1',
        text: 'Changed',
      }),
    ).toMatchObject({ ok: false, error: { code: 'MESSAGE_ID_CONFLICT' } });
    await expectDelivery(
      player,
      admin,
      PLAYER_EMAIL,
      ADMIN_EMAIL,
      'after-conflict',
      'Barrier',
    );
    expect(
      admin.messages.filter(
        (message) => message.clientMessageId === 'conflict-1',
      ),
    ).toHaveLength(1);
  });

  it('allows each account to use the same client message id independently', async () => {
    const player = await connect(tokenFor(PLAYER_EMAIL));
    const admin = await connect(tokenFor(ADMIN_EMAIL));
    const fromPlayer = await expectDelivery(
      player,
      admin,
      PLAYER_EMAIL,
      ADMIN_EMAIL,
      'shared-id',
      'Player text',
    );
    const fromAdmin = await expectDelivery(
      admin,
      player,
      ADMIN_EMAIL,
      PLAYER_EMAIL,
      'shared-id',
      'Admin text',
    );
    expect(fromPlayer.id).not.toEqual(fromAdmin.id);
  });

  it('reports presence until the last tab disconnects and broadcasts to every tab', async () => {
    const admin = await connect(tokenFor(ADMIN_EMAIL));
    // Capture before connecting: initial presence may arrive immediately after connect.
    const becameOnline = nextEvent<Presence>(
      admin.socket,
      'mensajes:estado',
      (state) => state.peerOnline,
    );
    const [playerTab1, onlineState] = await Promise.all([
      connect(tokenFor(PLAYER_EMAIL)),
      becameOnline,
    ]);
    expect(onlineState).toMatchObject({
      selfEmail: ADMIN_EMAIL,
      peerEmail: PLAYER_EMAIL,
      peerOnline: true,
    });
    const playerTab2 = await connect(tokenFor(PLAYER_EMAIL));
    const tab1Delivery = nextEvent<Message>(
      playerTab1.socket,
      'mensajes:recibir',
    );
    const tab2Delivery = nextEvent<Message>(
      playerTab2.socket,
      'mensajes:recibir',
    );
    const [ack, receivedOnTab1, receivedOnTab2] = await Promise.all([
      send(admin.socket, { clientMessageId: 'both-tabs', text: 'Both tabs' }),
      tab1Delivery,
      tab2Delivery,
    ]);
    expect(ack.ok).toBe(true);
    expect(receivedOnTab1).toEqual(receivedOnTab2);

    playerTab1.socket.disconnect();
    // A message from the remaining tab proves that socket and its room are still active.
    await expectDelivery(
      playerTab2,
      admin,
      PLAYER_EMAIL,
      ADMIN_EMAIL,
      'remaining-tab',
      'Still here',
    );
    expect(admin.states[admin.states.length - 1].peerOnline).toBe(true);

    const becameOffline = nextEvent<Presence>(
      admin.socket,
      'mensajes:estado',
      (state) => !state.peerOnline,
    );
    playerTab2.socket.disconnect();
    expect(await becameOffline).toMatchObject({
      selfEmail: ADMIN_EMAIL,
      peerEmail: PLAYER_EMAIL,
      peerOnline: false,
    });
  });

  it('keeps the protocol within its namespace', async () => {
    const player = await connect(tokenFor(PLAYER_EMAIL));
    const admin = await connect(tokenFor(ADMIN_EMAIL));
    const outside = await connect(tokenFor(PLAYER_EMAIL), '/');
    await expectDelivery(
      player,
      admin,
      PLAYER_EMAIL,
      ADMIN_EMAIL,
      'namespace-test',
      'Only the message namespace',
    );
    expect(outside.messages).toEqual([]);
    expect(outside.states).toEqual([]);
    await expect(
      send(outside.socket, {
        clientMessageId: 'outside-send',
        text: 'Wrong namespace',
      }),
    ).rejects.toThrow();
    expect(admin.messages.map((message) => message.clientMessageId)).toEqual([
      'namespace-test',
    ]);
  });
});
