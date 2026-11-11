import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuthIdentityService } from '../messages/auth-identity.service';
import { PVP_REPOSITORY, PvpRepository } from './pvp.repository';
import {
  Actor,
  Battle,
  clone,
  fail,
  humanSides,
  Result,
  Side,
  SIDES,
} from './pvp.types';
import { scaleTrainerTeam, trainerPreset } from './pvp.trainers';
import {
  digest,
  hp,
  id,
  integer,
  object,
  PRIMARY,
  requestKey,
  size,
  stableJson,
  validateChoice,
  validateSession,
  validateSnapshot,
} from './pvp.validation';

@Injectable()
export class PvpService implements OnModuleInit {
  readonly actors = new Map<string, Actor>();
  constructor(
    @Inject(PVP_REPOSITORY) readonly repository: PvpRepository,
    private readonly auth: AuthIdentityService,
  ) {}
  async onModuleInit() {
    await this.repository.ready();
  }
  connect(actor: Actor) {
    this.actors.set(actor.socketId, actor);
  }
  disconnect(socketId: string) {
    this.actors.delete(socketId);
  }
  private current(userId: number, clientId?: string): Actor | undefined {
    return [...this.actors.values()]
      .reverse()
      .find(
        (actor) =>
          actor.user.id === userId &&
          (!clientId || actor.clientId === clientId),
      );
  }
  private ownSide(battle: Battle, actor: Actor): Side | undefined {
    return humanSides(battle).find(
      (side) => battle.players[side].user.id === actor.user.id,
    );
  }
  private member(battle: Battle, actor: Actor) {
    if (battle.adminId !== actor.user.id && !this.ownSide(battle, actor))
      fail('FORBIDDEN', 'No participas en esta batalla.');
  }
  private host(battle: Battle, actor: Actor, epoch?: number) {
    if (
      actor.user.role !== 'admin' ||
      battle.adminId !== actor.user.id ||
      battle.host.clientId !== actor.clientId ||
      this.current(actor.user.id, actor.clientId)?.socketId !== actor.socketId
    )
      fail(
        'HOST_REQUIRED',
        'Solo el anfitrión administrador puede realizar esta acción.',
      );
    if (epoch !== undefined && battle.host.epoch !== epoch)
      fail('HOST_FENCED', 'Otro anfitrión reclamó esta batalla.');
  }
  private owner(battle: Battle, actor: Actor): Side {
    const side = this.ownSide(battle, actor);
    if (
      !side ||
      battle.players[side].clientId !== actor.clientId ||
      this.current(actor.user.id, actor.clientId)?.socketId !== actor.socketId
    )
      fail(
        'OWNER_REQUIRED',
        'Esta partida pertenece a otra instancia del jugador.',
      );
    return side;
  }
  private async ownersOnline(battle: Battle) {
    for (const side of humanSides(battle)) {
      const player = battle.players[side];
      const actor = this.current(player.user.id, player.clientId);
      if (!actor)
        fail(
          'PLAYER_OFFLINE',
          'La batalla está pausada hasta que regresen sus jugadores.',
        );
      try {
        await this.auth.authenticate(actor.token);
      } catch (error) {
        if (error?.code !== 'AUTH_UNAVAILABLE') this.disconnect(actor.socketId);
        throw error;
      }
    }
  }
  private async load(battleId: string, actor: Actor): Promise<Battle> {
    const battle = await this.repository.get(id(battleId));
    if (!battle)
      fail(
        'BATTLE_NOT_FOUND',
        'No se encontró la batalla; conserva el bloqueo local.',
      );
    this.member(battle, actor);
    return battle;
  }
  private async mutate(
    battleId: string,
    actor: Actor,
    update: (battle: Battle) => Promise<boolean | void> | boolean | void,
  ): Promise<Battle> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const battle = await this.load(battleId, actor);
      const previous = battle.revision;
      if ((await update(battle)) === false) return battle;
      battle.revision++;
      size(battle, 4 * 1024 * 1024);
      if (await this.repository.compareAndSwap(battle, previous)) return battle;
    }
    fail('REVISION_CONFLICT', 'La batalla cambió; sincroniza y reintenta.');
  }
  async lobby(actor: Actor): Promise<any[]> {
    if (actor.user.role !== 'admin') return [];
    const busy = new Set(
      (await this.repository.locked()).flatMap(
        (battle) => battle.lockedUserIds,
      ),
    );
    const players = new Map<number, Actor>();
    for (const candidate of this.actors.values())
      if (candidate.user.role === 'player')
        players.set(candidate.user.id, candidate);
    return [...players.values()].map((candidate) => ({
      user: clone(candidate.user),
      clientId: candidate.clientId,
      online: true,
      busy: busy.has(candidate.user.id),
    }));
  }
  view(battle: Battle, actor: Actor): any {
    this.member(battle, actor);
    const admin =
      actor.user.role === 'admin' && battle.adminId === actor.user.id;
    if (battle.adminId === actor.user.id && !admin)
      fail('FORBIDDEN', 'Esta cuenta ya no es administradora.');
    const players: any = {};
    for (const side of humanSides(battle)) {
      const player = battle.players[side];
      players[side] = {
        user: clone(player.user),
        clientId: player.clientId,
        online: Boolean(this.current(player.user.id, player.clientId)),
      };
      if (admin && player.snapshot)
        players[side].snapshot = clone(player.snapshot);
    }
    const state: any = {
      battleId: battle.battleId,
      phase: battle.phase,
      revision: battle.revision,
      checkpointRevision: battle.checkpointRevision,
      host: {
        ...battle.host,
        online: Boolean(this.current(battle.adminId, battle.host.clientId)),
      },
      players,
      applied: clone(battle.applied),
    };
    if (battle.mode === 'trainer') {
      state.mode = 'trainer';
      const { team, ...descriptor } = battle.trainer;
      state.trainer = admin ? clone(battle.trainer) : clone(descriptor);
    }
    if (admin) {
      state.session = clone(battle.session);
      state.commands = clone(battle.commands);
      return state;
    }
    const side = this.ownSide(battle, actor);
    state.side = side;
    if (battle.players[side].snapshot)
      state.snapshot = clone(battle.players[side].snapshot);
    if (battle.session) {
      state.team = clone(battle.session.teams[side]);
      if (battle.session.runtime) {
        state.request = clone(battle.session.runtime.requests[side]);
        state.requestKey = requestKey(battle.session, side);
        state.pending =
          Boolean(battle.session.runtime.pending[side]) ||
          battle.commands.some((command) => command.side === side);
      }
    }
    if (battle.results) state.result = clone(battle.results[side]);
    return state;
  }
  async sync(actor: Actor, payload: any) {
    object(payload, ['battleId']);
    const battle = payload.battleId
      ? await this.load(payload.battleId, actor)
      : (await this.repository.locked()).find(
          (entry) =>
            entry.adminId === actor.user.id || this.ownSide(entry, actor),
        );
    return {
      ok: true,
      state: battle ? this.view(battle, actor) : null,
      lobby: await this.lobby(actor),
    };
  }
  async create(actor: Actor, payload: any) {
    object(payload, ['commandId', 'playerAId', 'playerBId', 'trainerPresetId']);
    id(payload.commandId);
    integer(payload.playerAId, 1);
    const isTrainer = payload.trainerPresetId !== undefined;
    const trainer = isTrainer
      ? trainerPreset(payload.trainerPresetId)
      : undefined;
    if (isTrainer && payload.playerBId !== undefined)
      fail('INVALID_PLAYERS', 'Selecciona un Trainer o un segundo jugador.');
    if (!isTrainer) integer(payload.playerBId, 1);
    if (
      actor.user.role !== 'admin' ||
      this.current(actor.user.id, actor.clientId)?.socketId !== actor.socketId
    )
      fail('ADMIN_REQUIRED', 'Se necesita un administrador conectado.');
    if (payload.playerAId === payload.playerBId)
      fail('INVALID_PLAYERS', 'Selecciona dos jugadores distintos.');
    const creationKey = digest([actor.user.id, payload.commandId]);
    const creationHash = digest(
      isTrainer
        ? ['trainer', payload.playerAId, trainer.presetId]
        : [payload.playerAId, payload.playerBId],
    );
    const replay = await this.repository.byCreationKey(creationKey);
    if (replay) {
      if (replay.creationHash !== creationHash)
        fail(
          'COMMAND_CONFLICT',
          'El identificador ya corresponde a otra selección.',
        );
      return replay;
    }
    const contacts = await this.auth.contacts(actor.token, actor.user.id);
    const players: any = {};
    const selections: [Side, number][] = [['a', payload.playerAId]];
    if (!isTrainer) selections.push(['b', payload.playerBId]);
    for (const [side, userId] of selections) {
      const candidate = this.current(userId);
      const user = contacts.find((entry) => entry.id === userId);
      if (!candidate || user?.role !== 'player')
        fail('PLAYER_OFFLINE', 'El jugador seleccionado no está disponible.');
      const valid = await this.auth.authenticate(candidate.token);
      if (valid.user.id !== userId || valid.user.role !== 'player')
        fail('INVALID_PLAYERS', 'Cuenta de jugador no válida.');
      players[side] = { user: valid.user, clientId: candidate.clientId };
    }
    const battle: Battle = {
      battleId: randomUUID(),
      ...(isTrainer ? { mode: 'trainer' as const, trainer } : {}),
      creationKey,
      creationHash,
      phase: 'collecting',
      revision: 0,
      checkpointRevision: 0,
      lockHeld: true,
      lockedUserIds: selections.map(([, userId]) => userId),
      adminId: actor.user.id,
      host: { userId: actor.user.id, clientId: actor.clientId, epoch: 1 },
      players,
      session: null,
      commands: [],
      commandHashes: {},
      applied: { a: false, b: isTrainer },
    };
    try {
      await this.repository.insert(battle);
    } catch (error) {
      const existing = await this.repository.byCreationKey(creationKey);
      if (existing && existing.creationHash === creationHash) return existing;
      throw error;
    }
    return battle;
  }
  async snapshot(actor: Actor, payload: any) {
    object(payload, ['snapshot']);
    const snapshot = validateSnapshot(payload.snapshot);
    return this.mutate(snapshot.battleId, actor, (battle) => {
      const side = this.owner(battle, actor);
      if (
        snapshot.userId !== actor.user.id ||
        snapshot.clientId !== actor.clientId
      )
        fail('OWNER_REQUIRED', 'La instantánea no pertenece a esta sesión.');
      const previous = battle.players[side].snapshot;
      if (previous) {
        if (stableJson(previous) !== stableJson(snapshot))
          fail(
            'SNAPSHOT_CONFLICT',
            'El equipo ya fue confirmado con otros datos.',
          );
        return false;
      }
      if (battle.phase !== 'collecting')
        fail('INVALID_PHASE', 'La batalla no está recopilando equipos.');
      battle.players[side].snapshot = clone(snapshot);
      if (battle.mode === 'trainer')
        battle.trainer.team = scaleTrainerTeam(
          battle.trainer,
          snapshot.hpMultiplier,
        );
      if (humanSides(battle).every((key) => battle.players[key].snapshot))
        battle.phase = 'ready';
    });
  }
  async claim(actor: Actor, payload: any) {
    object(payload, ['battleId']);
    return this.mutate(payload.battleId, actor, (battle) => {
      if (
        actor.user.role !== 'admin' ||
        actor.user.id !== battle.adminId ||
        this.current(actor.user.id, actor.clientId)?.socketId !== actor.socketId
      )
        fail(
          'ADMIN_REQUIRED',
          'Solo el administrador de esta batalla puede reclamarla.',
        );
      if (!battle.lockHeld) fail('INVALID_PHASE', 'La batalla ya terminó.');
      battle.host.clientId = actor.clientId;
      battle.host.epoch++;
    });
  }
  async command(actor: Actor, payload: any) {
    object(payload, ['battleId', 'commandId', 'requestKey', 'choice', 'side']);
    id(payload.commandId);
    const choice = validateChoice(payload.choice);
    if (
      !SIDES.includes(payload.side) ||
      typeof payload.requestKey !== 'string' ||
      payload.requestKey.length > 20000
    )
      fail('INVALID_CHOICE', 'Acción de turno no válida.');
    return this.mutate(payload.battleId, actor, async (battle) => {
      this.host(battle, actor);
      const command = {
        commandId: payload.commandId,
        userId: actor.user.id,
        side: payload.side as Side,
        requestKey: payload.requestKey,
        choice,
      };
      const key = digest([actor.user.id, payload.commandId]);
      const hash = digest(command);
      if (battle.commandHashes[key]) {
        if (battle.commandHashes[key] !== hash)
          fail(
            'COMMAND_CONFLICT',
            'El identificador ya corresponde a otra acción.',
          );
        return false;
      }
      if (
        battle.phase !== 'active' ||
        !battle.session?.runtime ||
        payload.requestKey !== requestKey(battle.session, payload.side)
      )
        fail('STALE_REQUEST', 'La solicitud de turno cambió.');
      await this.ownersOnline(battle);
      const team = battle.session.teams[payload.side];
      const request = battle.session.runtime.requests[payload.side];
      const pending = Boolean(battle.session.runtime.pending[payload.side]);
      if (choice.kind === 'cancel') {
        if (!pending)
          fail('INVALID_CHOICE', 'No hay una elección pendiente que cancelar.');
      } else {
        if (pending || request.waiting)
          fail(
            'INVALID_CHOICE',
            'Ese equipo debe esperar su siguiente solicitud de turno.',
          );
        if (choice.kind === 'move' && request.forceSwitch)
          fail('INVALID_CHOICE', 'Esta solicitud requiere otra acción.');
        if (
          choice.kind === 'switch' &&
          !request.forceSwitch &&
          (request.trapped || request.locked)
        )
          fail('INVALID_CHOICE', 'Ese equipo no puede cambiar ahora.');
        if (choice.kind === 'wait')
          fail(
            'INVALID_CHOICE',
            'Elige el movimiento forzado para continuar; no se puede omitir el turno.',
          );
      }
      if (
        battle.commands.some(
          (queued) =>
            queued.side === payload.side &&
            queued.requestKey === payload.requestKey,
        )
      )
        fail(
          'COMMAND_PENDING',
          'Ya se está procesando una acción de ese equipo.',
        );
      if (
        choice.kind === 'switch' &&
        !team.pokemons.some(
          (entry: any) => entry.captureId === choice.captureId && hp(entry) > 0,
        )
      )
        fail('INVALID_CHOICE', 'Ese Pokémon no puede entrar.');
      if (
        choice.kind === 'move' &&
        !battle.session.runtime.requests[payload.side].moves.some(
          (move: any) =>
            move.id === choice.moveId &&
            !move.disabled &&
            (move.pp > 0 ||
              request.locked ||
              (move.id === 165 && move.pp === 0 && move.maxpp === 0)) &&
            (choice.moveId !== 0 || request.locked),
        )
      )
        fail('INVALID_CHOICE', 'Ese movimiento no está disponible.');
      if (
        battle.commands.length >= 128 ||
        Object.keys(battle.commandHashes).length >= 8192
      )
        fail('COMMAND_LIMIT', 'La cola de acciones alcanzó su límite.');
      battle.commands.push(clone(command));
      battle.commandHashes[key] = hash;
    });
  }
  async checkpoint(actor: Actor, payload: any) {
    object(payload, [
      'battleId',
      'hostEpoch',
      'expectedCheckpointRevision',
      'session',
      'processedCommandIds',
    ]);
    integer(payload.hostEpoch, 1);
    integer(payload.expectedCheckpointRevision);
    if (
      !Array.isArray(payload.processedCommandIds) ||
      payload.processedCommandIds.length > 128 ||
      new Set(payload.processedCommandIds).size !==
        payload.processedCommandIds.length
    )
      fail('INVALID_CHECKPOINT', 'Identificadores procesados no válidos.');
    payload.processedCommandIds.forEach(id);
    const fingerprint = digest([payload.session, payload.processedCommandIds]);
    return this.mutate(payload.battleId, actor, async (battle) => {
      this.host(battle, actor, payload.hostEpoch);
      if (
        battle.lastCheckpoint?.hash === fingerprint &&
        battle.lastCheckpoint.expectedRevision ===
          payload.expectedCheckpointRevision &&
        battle.lastCheckpoint.epoch === payload.hostEpoch
      )
        return false;
      if (!['ready', 'active'].includes(battle.phase))
        fail('INVALID_PHASE', 'No se puede avanzar esta batalla.');
      if (battle.checkpointRevision !== payload.expectedCheckpointRevision)
        fail('CHECKPOINT_CONFLICT', 'Otro checkpoint ya fue guardado.');
      await this.ownersOnline(battle);
      validateSession(payload.session, battle);
      if (
        payload.processedCommandIds.some(
          (commandId) =>
            !battle.commands.some((command) => command.commandId === commandId),
        )
      )
        fail(
          'INVALID_CHECKPOINT',
          'El checkpoint confirma acciones desconocidas.',
        );
      if (
        battle.session?.runtime &&
        payload.session.runtime &&
        (payload.session.runtime.serial < battle.session.runtime.serial ||
          payload.session.runtime.turn < battle.session.runtime.turn)
      )
        fail('INVALID_CHECKPOINT', 'El motor no puede retroceder.');
      if (battle.phase === 'active' && payload.session.phase === 'setup')
        fail('INVALID_CHECKPOINT', 'No se puede volver a preparación.');
      battle.session = clone(payload.session);
      battle.commands = battle.commands.filter(
        (command) => !payload.processedCommandIds.includes(command.commandId),
      );
      battle.checkpointRevision++;
      battle.lastCheckpoint = {
        hash: fingerprint,
        expectedRevision: payload.expectedCheckpointRevision,
        epoch: payload.hostEpoch,
      };
      battle.phase =
        payload.session.phase === 'finished'
          ? 'finished'
          : payload.session.phase === 'battle'
            ? 'active'
            : 'ready';
    });
  }
  async finalize(actor: Actor, payload: any) {
    object(payload, ['battleId', 'hostEpoch']);
    integer(payload.hostEpoch, 1);
    return this.mutate(payload.battleId, actor, (battle) => {
      this.host(battle, actor, payload.hostEpoch);
      if (battle.results && ['finalizing', 'finalized'].includes(battle.phase))
        return false;
      if (battle.phase !== 'finished' || !battle.session?.runtime?.ended)
        fail('INVALID_PHASE', 'Finaliza solo una batalla terminada.');
      const results: any = {};
      for (const side of humanSides(battle)) {
        const snapshot = battle.players[side].snapshot;
        const winner = battle.session.runtime.winner;
        const result: Result = {
          battleId: battle.battleId,
          resultId: randomUUID(),
          userId: snapshot.userId,
          snapshotId: snapshot.snapshotId,
          baseHash: snapshot.baseHash,
          outcome:
            winner === 'draw' ? 'draw' : winner === side ? 'win' : 'lose',
          patches: snapshot.pokemons.map((original) => {
            const mon = battle.session.teams[side].pokemons.find(
              (entry: any) => entry.captureId === original.captureId,
            );
            const statuses = (mon.statuses ?? []).filter((status: string) =>
              PRIMARY.includes(status),
            );
            const statusTurns =
              statuses.includes('asleep') && mon.statusTurns?.asleep
                ? { asleep: mon.statusTurns.asleep }
                : {};
            return {
              captureId: original.captureId,
              hp: hp(mon),
              statuses,
              statusTurns,
            };
          }),
        };
        results[side] = result;
      }
      battle.results = results;
      battle.commands = [];
      battle.phase = 'finalizing';
    });
  }
  async applied(actor: Actor, payload: any) {
    object(payload, ['battleId', 'resultId', 'snapshotId', 'baseHash']);
    id(payload.resultId);
    id(payload.snapshotId);
    return this.mutate(payload.battleId, actor, (battle) => {
      const side = this.owner(battle, actor);
      const result = battle.results?.[side];
      if (
        !result ||
        !['finalizing', 'finalized'].includes(battle.phase) ||
        result.resultId !== payload.resultId ||
        result.snapshotId !== payload.snapshotId ||
        result.baseHash !== payload.baseHash
      )
        fail(
          'RESULT_CONFLICT',
          'La confirmación no coincide con el resultado propio.',
        );
      if (battle.applied[side]) return false;
      battle.applied[side] = true;
      if (humanSides(battle).every((key) => battle.applied[key])) {
        battle.phase = 'finalized';
        battle.lockHeld = false;
      }
    });
  }
  async cancel(actor: Actor, payload: any, decline = false) {
    object(
      payload,
      decline ? ['battleId', 'reason'] : ['battleId', 'hostEpoch'],
    );
    if (
      decline &&
      (typeof payload.reason !== 'string' || payload.reason.length > 500)
    )
      fail('INVALID_INPUT', 'Motivo no válido.');
    if (!decline) integer(payload.hostEpoch, 1);
    return this.mutate(payload.battleId, actor, (battle) => {
      if (decline) this.owner(battle, actor);
      else this.host(battle, actor, payload.hostEpoch);
      if (battle.phase === 'cancelled') return false;
      if (!['collecting', 'ready'].includes(battle.phase))
        fail(
          'INVALID_PHASE',
          'Una batalla activa no se puede abandonar; usa rendición y finalización.',
        );
      battle.phase = 'cancelled';
      battle.lockHeld = false;
      battle.commands = [];
    });
  }
}
