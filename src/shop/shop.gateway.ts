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
import {
  AuthIdentityService,
  MessageAuthError,
} from '../messages/auth-identity.service';
import {
  PlayerActivityError,
  PlayerActivityService,
} from '../messages/player-activity.service';
import { Actor } from '../pvp/pvp.types';
import { ShopError } from './shop.types';
import { ShopService } from './shop.service';

@WebSocketGateway({
  namespace: '/shop',
  maxHttpBufferSize: 4 * 1024 * 1024,
  cors: {
    origin: (origin, callback) =>
      callback(null, isAllowedFrontendOrigin(origin)),
    credentials: true,
  },
  allowRequest: (request, callback) =>
    callback(null, isAllowedFrontendOrigin(request.headers.origin)),
})
export class ShopGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleDestroy
{
  @WebSocketServer() private namespace: Namespace;
  private publishing: Promise<void> = Promise.resolve();
  private unsubscribe?: () => void;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  constructor(
    private readonly service: ShopService,
    private readonly auth: AuthIdentityService,
    private readonly activity: PlayerActivityService,
  ) {}
  afterInit(namespace: Namespace) {
    this.namespace = namespace;
    this.unsubscribe = this.activity.subscribe(() => {
      void this.publish();
    });
    this.service.setPrepareHandler(
      (actor, request) =>
        new Promise((resolve, reject) => {
          const socket = this.namespace.sockets.get(actor.socketId);
          if (!socket?.connected) {
            reject(
              new ShopError(
                'PLAYER_OFFLINE',
                'El jugador se desconectó antes de reservar su partida.',
              ),
            );
            return;
          }
          socket
            .timeout(5000)
            .emit(
              'shop:prepare',
              request,
              (error: Error | null, acknowledgement: any) => {
                if (error)
                  reject(
                    new ShopError(
                      'PLAYER_NOT_READY',
                      'El jugador no confirmó la reserva de la compra. Sincroniza antes de reintentar.',
                    ),
                  );
                else resolve(acknowledgement);
              },
            );
        }),
    );
    namespace.use((socket, next) => {
      void (async () => {
        const clientId = socket.handshake.auth?.clientId;
        if (
          typeof clientId !== 'string' ||
          !/^[A-Za-z0-9_.:-]{1,128}$/.test(clientId)
        )
          throw new ShopError(
            'INVALID_INPUT',
            'Identificador de navegador no válido.',
          );
        const identity = await this.auth.authenticate(
          socket.handshake.auth?.token,
        );
        socket.data = {
          token: socket.handshake.auth.token,
          clientId,
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
    clearTimeout(this.timers.get(socket.id));
    this.timers.delete(socket.id);
    void this.publish();
  }
  private actorValue(socket: Socket): Actor {
    return {
      user: socket.data.identity.user,
      token: socket.data.token,
      clientId: socket.data.clientId,
      socketId: socket.id,
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
        socket.emit('shop:error', {
          code: 'TOKEN_EXPIRED',
          message:
            'La sesión expiró. Reconecta para recuperar tus Pokedollars.',
        });
        socket.disconnect();
      }
    }, delay);
    timer.unref();
    this.timers.set(socket.id, timer);
  }
  private detail(error: any) {
    if (
      error instanceof ShopError ||
      error instanceof MessageAuthError ||
      error instanceof PlayerActivityError
    )
      return { code: error.code, message: error.message };
    return {
      code: 'SHOP_UNAVAILABLE',
      message:
        'No se pudo guardar o recuperar la tienda. Actualiza la conexión antes de reintentar.',
    };
  }
  private handleError(socket: Socket, error: any) {
    const detail = this.detail(error);
    if (error instanceof MessageAuthError && detail.code !== 'AUTH_UNAVAILABLE')
      setImmediate(() => {
        socket.emit('shop:error', detail);
        socket.disconnect();
      });
    return { ok: false, error: detail };
  }
  private publish(): Promise<void> {
    this.publishing = this.publishing
      .catch(() => {})
      .then(async () => {
        if (!this.namespace) return;
        for (const socket of [...this.namespace.sockets.values()]) {
          try {
            const actor = await this.actor(socket);
            const state = await this.service.sync(actor, {});
            if (socket.connected) socket.emit('shop:state', state);
          } catch (error) {
            socket.emit('shop:error', this.detail(error));
            this.handleError(socket, error);
          }
        }
      });
    return this.publishing;
  }
  private async run(
    socket: Socket,
    operation:
      | 'sync'
      | 'presence'
      | 'purchase'
      | 'applied'
      | 'reset'
      | 'resetApplied'
      | 'resetCancel'
      | 'use'
      | 'useApplied'
      | 'useCancel'
      | 'priceSet'
      | 'balanceAdjust'
      | 'balanceApplied',
    payload: any,
  ) {
    try {
      const actor = await this.actor(socket);
      const state = await this.service[operation](actor, payload ?? {});
      if (operation !== 'sync') await this.publish();
      return { ok: true, ...state };
    } catch (error) {
      const response = this.handleError(socket, error);
      // A failed/aborted preflight must still release its player's local lock
      // through a fresh serialized state. No debit is rolled back on a timeout.
      if (operation === 'purchase' || operation === 'balanceAdjust')
        await this.publish();
      return response;
    }
  }
  @SubscribeMessage('shop:sync') sync(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'sync', payload);
  }
  @SubscribeMessage('shop:presence') presence(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'presence', payload);
  }
  @SubscribeMessage('shop:purchase') purchase(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'purchase', payload);
  }
  @SubscribeMessage('shop:price-set') priceSet(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'priceSet', payload);
  }
  @SubscribeMessage('shop:balance-adjust') balanceAdjust(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'balanceAdjust', payload);
  }
  @SubscribeMessage('shop:balance-applied') balanceApplied(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'balanceApplied', payload);
  }
  @SubscribeMessage('shop:applied') applied(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'applied', payload);
  }
  @SubscribeMessage('shop:reset') reset(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'reset', payload);
  }
  @SubscribeMessage('shop:use') use(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'use', payload);
  }
  @SubscribeMessage('shop:use-applied') useApplied(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'useApplied', payload);
  }
  @SubscribeMessage('shop:use-cancel') useCancel(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'useCancel', payload);
  }
  @SubscribeMessage('shop:reset-applied') resetApplied(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'resetApplied', payload);
  }
  @SubscribeMessage('shop:reset-cancel') resetCancel(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: any,
  ) {
    return this.run(socket, 'resetCancel', payload);
  }
  onModuleDestroy() {
    this.unsubscribe?.();
    this.service.setPrepareHandler(undefined);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.service.actors.clear();
  }
}
