import { OnModuleDestroy } from '@nestjs/common';
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
import { Namespace, Socket } from 'socket.io';
import { isAllowedFrontendOrigin } from '../config/frontend-origins';
import { AuthIdentityService, MessageAuthError } from './auth-identity.service';
import {
  ContactsAck,
  MessageAck,
  MessageContact,
  MessageError,
  MessageIdentity,
  TestMessage,
  UserPublic,
} from './messages.types';

type MessageSocket = Socket<
  Record<string, (...args: any[]) => void>,
  Record<string, (...args: any[]) => void>,
  Record<string, (...args: any[]) => void>,
  { identity?: MessageIdentity; token?: string; contacts?: UserPublic[] }
>;

type SendInput = { clientMessageId: string; text: string; toUserId: number };
type CachedMessage = { message: TestMessage; expiresAt: number };
const DEDUP_TTL_MS = 15 * 60 * 1000;
const MAX_DEDUP_ENTRIES = 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

@WebSocketGateway({
  namespace: '/mensajes-prueba',
  maxHttpBufferSize: 4 * 1024 * 1024,
  cors: {
    origin: (origin, callback) =>
      callback(null, isAllowedFrontendOrigin(origin)),
    credentials: true,
  },
  allowRequest: (request, callback) =>
    callback(null, isAllowedFrontendOrigin(request.headers.origin)),
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

  private readonly sockets = new Map<string, MessageSocket>();
  private readonly connections = new Map<number, Set<string>>();
  private readonly expirationTimers = new Map<string, NodeJS.Timeout>();
  private readonly dedup = new Map<string, CachedMessage>();

  constructor(private readonly auth: AuthIdentityService) {}

  afterInit(namespace: Namespace): void {
    this.namespace = namespace;
    namespace.use((socket: MessageSocket, next) => {
      void this.prepareSocket(socket).then(
        () => next(),
        (error) => {
          const detail = this.publicError(error);
          next(Object.assign(new Error(detail.message), { data: detail }));
        },
      );
    });
  }

  async handleConnection(socket: MessageSocket): Promise<void> {
    const identity = socket.data.identity;
    if (!identity || identity.expiresAt <= Date.now()) {
      this.closeSession(socket, this.expiredError());
      return;
    }
    await socket.join(this.accountRoom(identity.user.id));
    if (!socket.connected) return;
    this.sockets.set(socket.id, socket);
    const tabs = this.connections.get(identity.user.id) ?? new Set<string>();
    tabs.add(socket.id);
    this.connections.set(identity.user.id, tabs);
    this.scheduleExpiration(socket, identity);
    socket.emit('mensajes:estado', {
      selfEmail: identity.user.email,
      selfUserId: identity.user.id,
    });
    this.publishPresence();
  }

  handleDisconnect(socket: MessageSocket): void {
    const timer = this.expirationTimers.get(socket.id);
    if (timer) clearTimeout(timer);
    this.expirationTimers.delete(socket.id);
    this.sockets.delete(socket.id);
    const userId = socket.data.identity?.user.id;
    const tabs = this.connections.get(userId);
    if (!tabs?.delete(socket.id)) return;
    if (!tabs.size) this.connections.delete(userId);
    this.publishPresence();
  }

  @SubscribeMessage('mensajes:contactos:solicitar')
  async refreshContacts(
    @ConnectedSocket() socket: MessageSocket,
  ): Promise<ContactsAck> {
    try {
      const identity = await this.revalidate(socket);
      socket.data.contacts = await this.auth.contacts(
        socket.data.token,
        identity.user.id,
      );
      if (!socket.connected) return { ok: false, error: this.expiredError() };
      const users = this.contactViews(socket);
      socket.emit('mensajes:contactos', { users });
      return { ok: true, users };
    } catch (error) {
      return { ok: false, error: this.handleFailure(socket, error) };
    }
  }

  @SubscribeMessage('mensajes:enviar')
  async sendMessage(
    @ConnectedSocket() socket: MessageSocket,
    @MessageBody() payload: unknown,
  ): Promise<MessageAck> {
    const input = this.validateMessage(payload);
    if (!input) {
      return {
        ok: false,
        error: {
          code: 'INVALID_MESSAGE',
          message:
            'Envía solo clientMessageId, toUserId y texto de 1 a 1000 caracteres.',
        },
      };
    }
    try {
      const identity = await this.revalidate(socket);
      const contacts = await this.auth.contacts(
        socket.data.token,
        identity.user.id,
      );
      socket.data.contacts = contacts;
      const recipient = contacts.find((user) => user.id === input.toUserId);
      if (!recipient) {
        return {
          ok: false,
          error: {
            code: 'RECIPIENT_NOT_FOUND',
            message: 'El destinatario ya no está disponible.',
          },
        };
      }

      // A revoked recipient must not keep reading through an already-open tab.
      const destinationTabs = [
        ...(this.connections.get(recipient.id) ?? []),
        ...(this.connections.get(identity.user.id) ?? []),
      ]
        .filter((id) => id !== socket.id)
        .map((id) => this.sockets.get(id))
        .filter((tab): tab is MessageSocket => Boolean(tab));
      const validDestinations = await Promise.all(
        destinationTabs.map(async (tab) => {
          try {
            await this.revalidate(tab);
            return tab.connected ? tab : null;
          } catch (error) {
            this.handleFailure(tab, error);
            return null;
          }
        }),
      );
      if (!socket.connected || identity.expiresAt <= Date.now()) {
        throw new MessageAuthError(
          'TOKEN_EXPIRED',
          this.expiredError().message,
        );
      }

      this.pruneDedup();
      const key = `${identity.user.id}\u0000${input.clientMessageId}`;
      const previous = this.dedup.get(key);
      if (previous) {
        if (
          previous.message.text !== input.text ||
          previous.message.toUserId !== input.toUserId
        ) {
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
        from: identity.user.email,
        to: recipient.email,
        fromUserId: identity.user.id,
        toUserId: recipient.id,
        text: input.text,
        sentAt: new Date().toISOString(),
      };
      this.dedup.set(key, { message, expiresAt: Date.now() + DEDUP_TTL_MS });
      this.pruneDedup();
      socket.emit('mensajes:recibir', message);
      for (const tab of validDestinations)
        tab?.emit('mensajes:recibir', message);
      this.publishPresence();
      // Acceptance is not durable storage or a promise of offline delivery.
      return { ok: true, message };
    } catch (error) {
      return { ok: false, error: this.handleFailure(socket, error) };
    }
  }

  onModuleDestroy(): void {
    for (const timer of this.expirationTimers.values()) clearTimeout(timer);
    this.expirationTimers.clear();
    this.sockets.clear();
    this.connections.clear();
    this.dedup.clear();
  }

  private async prepareSocket(socket: MessageSocket): Promise<void> {
    const token = socket.handshake.auth?.token;
    const identity = await this.auth.authenticate(token);
    const contacts = await this.auth.contacts(token, identity.user.id);
    socket.data = { token, identity, contacts };
  }

  private async revalidate(socket: MessageSocket): Promise<MessageIdentity> {
    const identity = await this.auth.authenticate(socket.data.token);
    if (
      socket.data.identity &&
      socket.data.identity.user.id !== identity.user.id
    ) {
      throw new MessageAuthError(
        'SESSION_REVOKED',
        'La sesión ya no es válida.',
      );
    }
    socket.data.identity = identity;
    return identity;
  }

  private validateMessage(payload: unknown): SendInput | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      return null;
    const input = payload as Record<string, unknown>;
    const keys = Object.keys(input);
    if (
      keys.length !== 3 ||
      !keys.includes('clientMessageId') ||
      !keys.includes('text') ||
      !keys.includes('toUserId') ||
      typeof input.clientMessageId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.clientMessageId) ||
      !Number.isSafeInteger(input.toUserId) ||
      (input.toUserId as number) <= 0 ||
      typeof input.text !== 'string' ||
      input.text.length > 1000 ||
      !input.text.trim()
    )
      return null;
    return {
      clientMessageId: input.clientMessageId,
      text: input.text.trim(),
      toUserId: input.toUserId as number,
    };
  }

  private contactViews(socket: MessageSocket): MessageContact[] {
    return (socket.data.contacts ?? []).map((user) => ({
      ...user,
      online: (this.connections.get(user.id)?.size ?? 0) > 0,
    }));
  }

  private publishPresence(): void {
    for (const socket of this.sockets.values()) {
      socket.emit('mensajes:contactos', { users: this.contactViews(socket) });
    }
  }

  private pruneDedup(): void {
    const now = Date.now();
    for (const [key, entry] of this.dedup) {
      if (entry.expiresAt <= now) this.dedup.delete(key);
    }
    while (this.dedup.size > MAX_DEDUP_ENTRIES)
      this.dedup.delete(this.dedup.keys().next().value);
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
      if (identity.expiresAt > Date.now())
        this.scheduleExpiration(socket, identity);
      else this.closeSession(socket, this.expiredError());
    }, delay);
    timer.unref();
    this.expirationTimers.set(socket.id, timer);
  }

  private handleFailure(socket: MessageSocket, error: unknown): MessageError {
    const detail = this.publicError(error);
    if (detail.code !== 'AUTH_UNAVAILABLE') {
      // Preserve the error ACK before disconnecting an invalid session.
      setImmediate(() => this.closeSession(socket, detail));
    } else socket.emit('mensajes:error', detail);
    return detail;
  }

  private closeSession(socket: MessageSocket, error: MessageError): void {
    socket.emit('mensajes:error', error);
    socket.disconnect();
  }

  private publicError(error: unknown): MessageError {
    return error instanceof MessageAuthError
      ? error.toPublic()
      : {
          code: 'AUTH_UNAVAILABLE',
          message: 'No se pudo verificar la cuenta. Inténtalo de nuevo.',
        };
  }

  private expiredError(): MessageError {
    return {
      code: 'TOKEN_EXPIRED',
      message: 'Tu sesión caducó. Inicia sesión de nuevo para continuar.',
    };
  }

  private accountRoom(userId: number): string {
    return `mensajes-prueba:usuario:${userId}`;
  }
}
