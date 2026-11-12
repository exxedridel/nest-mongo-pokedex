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
import { Namespace, Socket } from 'socket.io';
import { isAllowedFrontendOrigin } from '../config/frontend-origins';
import { PlayerActivityError } from '../messages/player-activity.service';
import {
  AuthIdentityService,
  MessageAuthError,
} from '../messages/auth-identity.service';
import { PvpService } from './pvp.service';
import { Actor, Battle, PvpError } from './pvp.types';
import { id } from './pvp.validation';

@WebSocketGateway({
  namespace: '/pvp',
  maxHttpBufferSize: 4 * 1024 * 1024,
  cors: {
    origin: (origin, callback) =>
      callback(null, isAllowedFrontendOrigin(origin)),
    credentials: true,
  },
  allowRequest: (request, callback) =>
    callback(null, isAllowedFrontendOrigin(request.headers.origin)),
})
export class PvpGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleDestroy
{
  @WebSocketServer() private namespace: Namespace;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private publishing: Promise<void> = Promise.resolve();
  constructor(
    private readonly service: PvpService,
    private readonly auth: AuthIdentityService,
  ) {}
  afterInit(namespace: Namespace) {
    this.namespace = namespace;
    namespace.use((socket, next) => {
      void (async () => {
        id(socket.handshake.auth?.clientId);
        const identity = await this.auth.authenticate(
          socket.handshake.auth?.token,
        );
        socket.data = {
          token: socket.handshake.auth.token,
          clientId: socket.handshake.auth.clientId,
          identity,
        };
      })().then(
        () => next(),
        (error) => {
          const detail = this.detail(error);
          next(Object.assign(new Error(detail.message), { data: detail }));
        },
      );
    });
  }
  handleConnection(socket: Socket) {
    this.service.connect(this.actorValue(socket));
    this.scheduleExpiration(socket);
    void this.publish();
  }
  handleDisconnect(socket: Socket) {
    this.service.disconnect(socket.id);
    const timer = this.timers.get(socket.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(socket.id);
    void this.publish();
  }
  private actorValue(socket: Socket): Actor {
    return {
      user: socket.data.identity.user,
      clientId: socket.data.clientId,
      socketId: socket.id,
      token: socket.data.token,
    };
  }
  private async actor(socket: Socket) {
    const identity = await this.auth.authenticate(socket.data.token);
    if (!socket.connected || identity.user.id !== socket.data.identity?.user.id)
      throw new MessageAuthError(
        'SESSION_REVOKED',
        'La sesión ya no es válida.',
      );
    socket.data.identity = identity;
    const actor = this.actorValue(socket);
    this.service.connect(actor);
    return actor;
  }
  private scheduleExpiration(socket: Socket) {
    const delay = Math.min(
      2147483647,
      Math.max(0, socket.data.identity.expiresAt - Date.now()),
    );
    const timer = setTimeout(() => {
      this.timers.delete(socket.id);
      if (!socket.connected) return;
      if (Date.now() < socket.data.identity.expiresAt)
        this.scheduleExpiration(socket);
      else {
        socket.emit('pvp:error', {
          code: 'TOKEN_EXPIRED',
          message: 'La sesión expiró. La batalla sigue reservada.',
        });
        socket.disconnect();
      }
    }, delay);
    timer.unref();
    this.timers.set(socket.id, timer);
  }
  private detail(error: any) {
    if (
      error instanceof PvpError ||
      error instanceof MessageAuthError ||
      error instanceof PlayerActivityError
    )
      return { code: error.code, message: error.message };
    return {
      code: 'PVP_UNAVAILABLE',
      message:
        'No se pudo guardar o recuperar la batalla. Conserva el bloqueo y reintenta.',
    };
  }
  private handleError(socket: Socket, error: any) {
    const detail = this.detail(error);
    if (error instanceof MessageAuthError && detail.code !== 'AUTH_UNAVAILABLE')
      setImmediate(() => {
        socket.emit('pvp:error', detail);
        socket.disconnect();
      });
    return { ok: false, error: detail };
  }
  private publish(changed?: Battle): Promise<void> {
    this.publishing = this.publishing
      .catch(() => {})
      .then(async () => {
        if (!this.namespace) return;
        for (const socket of [...this.namespace.sockets.values()]) {
          try {
            const actor = await this.actor(socket);
            if (
              changed &&
              (changed.adminId === actor.user.id ||
                Object.values(changed.players).some(
                  (player) => player.user.id === actor.user.id,
                ))
            )
              socket.data.battleId = changed.battleId;
            const response = await this.service.sync(
              actor,
              socket.data.battleId ? { battleId: socket.data.battleId } : {},
            );
            if (response.state) socket.data.battleId = response.state.battleId;
            socket.emit('pvp:state', response.state);
            socket.emit('pvp:lobby', response.lobby);
          } catch (error) {
            socket.emit('pvp:error', this.detail(error));
            this.handleError(socket, error);
          }
        }
      });
    return this.publishing;
  }
  private async run(socket: Socket, operation: string, payload: any) {
    try {
      const actor = await this.actor(socket);
      if (operation === 'sync') {
        const response = await this.service.sync(actor, payload ?? {});
        if (response.state) socket.data.battleId = response.state.battleId;
        return response;
      }
      let battle: Battle;
      if (operation === 'create')
        battle = await this.service.create(actor, payload);
      else if (operation === 'snapshot')
        battle = await this.service.snapshot(actor, payload);
      else if (operation === 'claim')
        battle = await this.service.claim(actor, payload);
      else if (operation === 'command')
        battle = await this.service.command(actor, payload);
      else if (operation === 'checkpoint')
        battle = await this.service.checkpoint(actor, payload);
      else if (operation === 'finalize')
        battle = await this.service.finalize(actor, payload);
      else if (operation === 'applied')
        battle = await this.service.applied(actor, payload);
      else
        battle = await this.service.cancel(
          actor,
          payload,
          operation === 'decline',
        );
      socket.data.battleId = battle.battleId;
      const state = this.service.view(battle, actor);
      await this.publish(battle);
      return { ok: true, state };
    } catch (error) {
      return this.handleError(socket, error);
    }
  }
  @SubscribeMessage('pvp:sync') sync(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'sync', payload);
  }
  @SubscribeMessage('pvp:create') create(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'create', payload);
  }
  @SubscribeMessage('pvp:snapshot') snapshot(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'snapshot', payload);
  }
  @SubscribeMessage('pvp:claim') claim(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'claim', payload);
  }
  @SubscribeMessage('pvp:command') command(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'command', payload);
  }
  @SubscribeMessage('pvp:checkpoint') checkpoint(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'checkpoint', payload);
  }
  @SubscribeMessage('pvp:finalize') finalize(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'finalize', payload);
  }
  @SubscribeMessage('pvp:applied') applied(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'applied', payload);
  }
  @SubscribeMessage('pvp:cancel') cancel(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'cancel', payload);
  }
  @SubscribeMessage('pvp:decline') decline(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'decline', payload);
  }
  onModuleDestroy() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.service.actors.clear();
  }
}
