import { OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { randomUUID } from 'crypto';
import { TokenExpiredError, verify } from 'jsonwebtoken';
import { Namespace, Socket } from 'socket.io';
import { isAllowedFrontendOrigin } from '../config/frontend-origins';
import {
  MESSAGE_ACCOUNTS,
  MessageAccount,
  MessageAck,
  MessageError,
  MessageIdentity,
  TestMessage,
} from './messages.types';

type MessageSocket = Socket<
  Record<string, (...args: any[]) => void>,
  Record<string, (...args: any[]) => void>,
  Record<string, (...args: any[]) => void>,
  { identity?: MessageIdentity }
>;

type CachedMessage = {
  message: TestMessage;
  expiresAt: number;
};

const DEDUP_TTL_MS = 15 * 60 * 1000;
const MAX_DEDUP_ENTRIES = 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

@WebSocketGateway({
  namespace: '/mensajes-prueba',
  maxHttpBufferSize: 16 * 1024,
  cors: {
    origin: (origin, callback) => {
      callback(null, isAllowedFrontendOrigin(origin));
    },
    credentials: true,
  },
  allowRequest: (request, callback) => {
    callback(null, isAllowedFrontendOrigin(request.headers.origin));
  },
})
export class MessagesGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleDestroy
{
  @WebSocketServer()
  private namespace: Namespace;

  private readonly secret: string;
  private readonly connections = new Map<MessageAccount, Set<string>>();
  private readonly expirationTimers = new Map<string, NodeJS.Timeout>();
  private readonly dedup = new Map<string, CachedMessage>();

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('JWT_SECRET');
    if (!this.secret.trim()) {
      throw new Error('JWT_SECRET es obligatorio para mensajes de prueba.');
    }
  }

  afterInit(namespace: Namespace): void {
    this.namespace = namespace;
    namespace.use((socket: MessageSocket, next) => {
      try {
        socket.data.identity = this.authenticate(socket.handshake.auth?.token);
        next();
      } catch (error) {
        const detail = this.authenticationError(error);
        const connectionError = Object.assign(new Error(detail.message), {
          data: detail,
        });
        next(connectionError);
      }
    });
  }

  async handleConnection(socket: MessageSocket): Promise<void> {
    const identity = socket.data.identity;
    if (!identity || identity.expiresAt <= Date.now()) {
      this.closeExpiredSession(socket);
      return;
    }

    await socket.join(this.accountRoom(identity.email));
    if (!socket.connected) return;

    const sockets = this.connections.get(identity.email) ?? new Set<string>();
    sockets.add(socket.id);
    this.connections.set(identity.email, sockets);
    this.scheduleExpiration(socket, identity);
    this.publishPresence();
  }

  handleDisconnect(socket: MessageSocket): void {
    const timer = this.expirationTimers.get(socket.id);
    if (timer) clearTimeout(timer);
    this.expirationTimers.delete(socket.id);

    const identity = socket.data.identity;
    if (!identity) return;
    const sockets = this.connections.get(identity.email);
    if (!sockets?.delete(socket.id)) return;
    if (sockets.size === 0) this.connections.delete(identity.email);
    this.publishPresence();
  }

  @SubscribeMessage('mensajes:enviar')
  sendMessage(
    @ConnectedSocket() socket: MessageSocket,
    @MessageBody() payload: unknown,
  ): MessageAck {
    const identity = socket.data.identity;
    if (!identity || identity.expiresAt <= Date.now()) {
      const error = this.expiredError();
      // Let Nest return the error ACK before ending the namespace session.
      setImmediate(() => this.closeExpiredSession(socket));
      return { ok: false, error };
    }

    const input = this.validateMessage(payload);
    if (!input) {
      return {
        ok: false,
        error: {
          code: 'INVALID_MESSAGE',
          message:
            'Envía solo clientMessageId (1 a 128 caracteres) y texto de 1 a 1000 caracteres.',
        },
      };
    }

    this.pruneDedup();
    const key = `${identity.userId}\u0000${input.clientMessageId}`;
    const previous = this.dedup.get(key);
    if (previous) {
      if (previous.message.text !== input.text) {
        return {
          ok: false,
          error: {
            code: 'MESSAGE_ID_CONFLICT',
            message: 'Este identificador ya se usó para otro mensaje.',
          },
        };
      }
      return { ok: true, message: previous.message };
    }

    const message: TestMessage = {
      id: randomUUID(),
      clientMessageId: input.clientMessageId,
      from: identity.email,
      to: this.peer(identity.email),
      text: input.text,
      sentAt: new Date().toISOString(),
    };
    this.dedup.set(key, {
      message,
      expiresAt: Date.now() + DEDUP_TTL_MS,
    });
    this.pruneDedup();

    this.namespace
      .to(this.accountRoom(message.from))
      .to(this.accountRoom(message.to))
      .emit('mensajes:recibir', message);

    // This confirms acceptance; disconnected peers do not receive a backlog.
    return { ok: true, message };
  }

  onModuleDestroy(): void {
    for (const timer of this.expirationTimers.values()) clearTimeout(timer);
    this.expirationTimers.clear();
    this.connections.clear();
    this.dedup.clear();
  }

  private authenticate(token: unknown): MessageIdentity {
    if (typeof token !== 'string' || !token.trim()) {
      throw this.error(
        'TOKEN_REQUIRED',
        'Inicia sesión para conectar el chat.',
      );
    }
    if (token.length > 8192) {
      throw this.error('INVALID_TOKEN', 'La sesión no es válida.');
    }

    const payload = verify(token, this.secret, {
      algorithms: ['HS256'],
    });
    if (!payload || typeof payload !== 'object') {
      throw this.error('INVALID_TOKEN', 'La sesión no es válida.');
    }
    const validId =
      (typeof payload.id === 'number' &&
        Number.isSafeInteger(payload.id) &&
        payload.id > 0) ||
      (typeof payload.id === 'string' &&
        payload.id.trim().length > 0 &&
        payload.id.length <= 128);
    if (
      !validId ||
      typeof payload.email !== 'string' ||
      !Number.isFinite(payload.exp) ||
      payload.exp * 1000 <= Date.now()
    ) {
      throw this.error('INVALID_TOKEN', 'La sesión no es válida.');
    }

    const email = payload.email.trim().toLowerCase();
    if (!MESSAGE_ACCOUNTS.includes(email as MessageAccount)) {
      throw this.error(
        'ACCOUNT_NOT_ALLOWED',
        'Esta cuenta no participa en la prueba de mensajes.',
      );
    }
    return {
      userId: String(payload.id),
      email: email as MessageAccount,
      expiresAt: payload.exp * 1000,
    };
  }

  private validateMessage(
    payload: unknown,
  ): { clientMessageId: string; text: string } | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    const input = payload as Record<string, unknown>;
    const keys = Object.keys(input);
    if (
      keys.length !== 2 ||
      !keys.includes('clientMessageId') ||
      !keys.includes('text') ||
      typeof input.clientMessageId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.clientMessageId) ||
      typeof input.text !== 'string' ||
      input.text.length > 1000
    ) {
      return null;
    }
    const text = input.text.trim();
    if (!text) return null;
    return { clientMessageId: input.clientMessageId, text };
  }

  private pruneDedup(): void {
    const now = Date.now();
    for (const [key, entry] of this.dedup) {
      if (entry.expiresAt <= now) this.dedup.delete(key);
    }
    while (this.dedup.size > MAX_DEDUP_ENTRIES) {
      this.dedup.delete(this.dedup.keys().next().value);
    }
  }

  private publishPresence(): void {
    for (const email of MESSAGE_ACCOUNTS) {
      const peerEmail = this.peer(email);
      this.namespace.to(this.accountRoom(email)).emit('mensajes:estado', {
        selfEmail: email,
        peerEmail,
        peerOnline: (this.connections.get(peerEmail)?.size ?? 0) > 0,
      });
    }
  }

  private scheduleExpiration(
    socket: MessageSocket,
    identity: MessageIdentity,
  ): void {
    const delay = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(0, identity.expiresAt - Date.now()),
    );
    const timer = setTimeout(() => {
      this.expirationTimers.delete(socket.id);
      if (!socket.connected) return;
      if (identity.expiresAt > Date.now()) {
        this.scheduleExpiration(socket, identity);
      } else {
        this.closeExpiredSession(socket);
      }
    }, delay);
    timer.unref();
    this.expirationTimers.set(socket.id, timer);
  }

  private closeExpiredSession(socket: MessageSocket): void {
    socket.emit('mensajes:error', this.expiredError());
    socket.disconnect();
  }

  private expiredError(): MessageError {
    return this.error(
      'TOKEN_EXPIRED',
      'Tu sesión caducó. Inicia sesión de nuevo para continuar.',
    );
  }

  private authenticationError(error: unknown): MessageError {
    if (error instanceof TokenExpiredError) return this.expiredError();
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      'message' in error &&
      typeof error.code === 'string' &&
      typeof error.message === 'string'
    ) {
      return { code: error.code, message: error.message };
    }
    return this.error('INVALID_TOKEN', 'La sesión no es válida.');
  }

  private error(code: string, message: string): MessageError {
    return { code, message };
  }

  private accountRoom(email: MessageAccount): string {
    return `mensajes-prueba:cuenta:${email}`;
  }

  private peer(email: MessageAccount): MessageAccount {
    return email === MESSAGE_ACCOUNTS[0]
      ? MESSAGE_ACCOUNTS[1]
      : MESSAGE_ACCOUNTS[0];
  }
}
