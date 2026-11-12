import { createHash } from 'crypto';
import {
  Battle,
  Capture,
  Choice,
  fail,
  SIDES,
  Side,
  Snapshot,
} from './pvp.types';

const STATS = [
  'hp',
  'attack',
  'defense',
  'special-attack',
  'special-defense',
  'speed',
];
export const PRIMARY = [
  'burned',
  'frozen',
  'paralyzed',
  'asleep',
  'poisoned',
  'badly-poisoned',
];
const STATUSES = [
  ...PRIMARY,
  'confused',
  'infatuated',
  'taunted',
  'tormented',
  'flinched',
  'bound',
  'trapped',
  'disabled',
  'encored',
  'perish-song',
  'leech-seed',
];
const TIMED = [
  'asleep',
  'confused',
  'taunted',
  'bound',
  'disabled',
  'encored',
  'perish-song',
];
export function stableJson(value: any): string {
  const normalize = (input: any): any =>
    Array.isArray(input)
      ? input.map(normalize)
      : input && typeof input === 'object'
        ? Object.fromEntries(
            Object.keys(input)
              .filter((key) => input[key] !== undefined)
              .sort()
              .map((key) => [key, normalize(input[key])]),
          )
        : input;
  return JSON.stringify(normalize(value));
}
export const digest = (value: any) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : stableJson(value))
    .digest('hex');
export function object(
  value: any,
  keys?: string[],
): asserts value is Record<string, any> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (keys && Object.keys(value).some((key) => !keys.includes(key)))
  )
    fail('INVALID_INPUT', 'Datos PvP no válidos.');
}
export function id(value: any): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value))
    fail('INVALID_INPUT', 'Identificador PvP no válido.');
  return value;
}
export function integer(
  value: any,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail('INVALID_INPUT', 'Valor numérico fuera de rango.');
  return value;
}
function text(value: any, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail('INVALID_SNAPSHOT', 'Texto del equipo no válido.');
}
export function size(value: any, max: number) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > max)
    fail('PAYLOAD_TOO_LARGE', 'Datos PvP demasiado grandes.');
}
export function hp(capture: Capture): number {
  return capture.pokemon.stats.find((stat: any) => stat.name === 'hp').value;
}
export function maxHp(capture: Capture): number {
  const p = capture.pokemon;
  const base = p.baseStats.find((stat: any) => stat.name === 'hp').value;
  return Math.floor(
    (Math.floor((base * p.level) / 50) + p.level + 10) *
      (p.hpMultiplier ?? 1.3),
  );
}
function stats(value: any, base: boolean) {
  if (!Array.isArray(value) || value.length !== 6)
    fail('INVALID_SNAPSHOT', 'El equipo debe contener las seis estadísticas.');
  for (const name of STATS) {
    const matches = value.filter((stat) => stat?.name === name);
    if (matches.length !== 1)
      fail('INVALID_SNAPSHOT', 'Estadísticas duplicadas o incompletas.');
    object(matches[0], ['name', 'value']);
    integer(
      matches[0].value,
      base ? 1 : name === 'hp' ? 0 : 1,
      base ? 1024 : 100000,
    );
  }
}
function capture(value: any) {
  object(value, [
    'captureId',
    'origin',
    'moves',
    'initialMovesChosen',
    'pokemon',
    'statuses',
    'statusTurns',
    'legacyStats',
    'trainerStatusContext',
  ]);
  id(value.captureId);
  object(value.pokemon, [
    'id',
    'name',
    'image',
    'types',
    'stats',
    'learnset',
    'progressionVersion',
    'level',
    'hpMultiplier',
    'baseStats',
    'battleStages',
  ]);
  const p = value.pokemon;
  integer(p.id, 1, 386);
  text(p.name, 100);
  integer(p.level, 1, 100);
  if (p.progressionVersion !== 1)
    fail(
      'INVALID_SNAPSHOT',
      'El Pokémon necesita datos de progresión vigentes.',
    );
  if (
    p.image !== null &&
    p.image !== undefined &&
    (typeof p.image !== 'string' || p.image.length > 2048)
  )
    fail('INVALID_SNAPSHOT', 'Imagen no válida.');
  if (
    !Array.isArray(p.types) ||
    p.types.length < 1 ||
    p.types.length > 2 ||
    p.types.some((type) => typeof type !== 'string' || type.length > 30)
  )
    fail('INVALID_SNAPSHOT', 'Tipos no válidos.');
  if (
    p.hpMultiplier !== undefined &&
    (!Number.isFinite(p.hpMultiplier) ||
      p.hpMultiplier < 1 ||
      p.hpMultiplier > 2)
  )
    fail('INVALID_SNAPSHOT', 'Multiplicador de HP no válido.');
  stats(p.baseStats, true);
  stats(p.stats, false);
  if (hp(value as Capture) > maxHp(value as Capture))
    fail(
      'INVALID_SNAPSHOT',
      'El HP actual supera su máximo; no se corregirá automáticamente.',
    );
  object(p.battleStages);
  const stageKeys = [
    'attack',
    'defense',
    'special-attack',
    'special-defense',
    'speed',
    'accuracy',
    'evasiveness',
  ];
  if (
    Object.keys(p.battleStages).length !== 7 ||
    stageKeys.some(
      (name) => !Object.prototype.hasOwnProperty.call(p.battleStages, name),
    )
  )
    fail('INVALID_SNAPSHOT', 'Modificadores incompletos.');
  for (const name of stageKeys) integer(p.battleStages[name], -6, 6);
  if (
    !Array.isArray(value.moves) ||
    value.moves.length < 1 ||
    value.moves.length > 4 ||
    new Set(value.moves.map((move) => move?.id)).size !== value.moves.length
  )
    fail('INVALID_SNAPSHOT', 'Envía de uno a cuatro movimientos por Pokémon.');
  for (const move of value.moves) {
    object(move, [
      'id',
      'name',
      'displayName',
      'type',
      'damageClass',
      'power',
      'accuracy',
      'pp',
      'priority',
      'description',
      'source',
    ]);
    integer(move.id, 1, 354);
    text(move.name, 100);
    text(move.displayName, 100);
    text(move.type, 30);
    if (
      !['physical', 'special', 'status'].includes(move.damageClass) ||
      !['starter', 'wild', 'tm', 'hm'].includes(move.source)
    )
      fail('INVALID_SNAPSHOT', 'Movimiento incompatible.');
    if (move.power !== null) integer(move.power, 0, 1000);
    if (move.accuracy !== null) integer(move.accuracy, 0, 100);
    if (move.pp !== null) integer(move.pp, 0, 100);
    integer(move.priority, -7, 7);
    if (typeof move.description !== 'string' || move.description.length > 10000)
      fail('INVALID_SNAPSHOT', 'Descripción de movimiento no válida.');
  }
  if (
    value.statuses !== undefined &&
    (!Array.isArray(value.statuses) ||
      value.statuses.length > STATUSES.length ||
      new Set(value.statuses).size !== value.statuses.length ||
      value.statuses.some((status) => !STATUSES.includes(status)) ||
      value.statuses.filter((status) => PRIMARY.includes(status)).length > 1)
  )
    fail('INVALID_SNAPSHOT', 'Condiciones no válidas.');
  if (value.statusTurns !== undefined) {
    object(value.statusTurns, TIMED);
    for (const [status, turns] of Object.entries(value.statusTurns)) {
      integer(turns, 1, 6);
      if (!value.statuses?.includes(status))
        fail('INVALID_SNAPSHOT', 'Contador sin condición.');
    }
  }
  if (p.learnset !== undefined) {
    object(p.learnset, ['versionGroup', 'moves']);
    if (
      p.learnset.versionGroup !== 'emerald' ||
      !Array.isArray(p.learnset.moves) ||
      p.learnset.moves.length > 354
    )
      fail('INVALID_SNAPSHOT', 'Catálogo incompatible.');
    for (const move of p.learnset.moves) {
      object(move, ['id', 'name']);
      integer(move.id, 1, 354);
      text(move.name, 100);
    }
  }
  if (value.initialMovesChosen !== undefined)
    integer(value.initialMovesChosen, 0, 4);
  if (
    value.origin !== undefined &&
    !['starter', 'wild', 'legacy'].includes(value.origin)
  )
    fail('INVALID_SNAPSHOT', 'Origen no válido.');
  if (value.legacyStats !== undefined) stats(value.legacyStats, false);
  if (value.trainerStatusContext !== undefined) {
    object(value.trainerStatusContext, [
      'disabledMoveId',
      'encoredMoveId',
      'gender',
    ]);
    for (const key of ['disabledMoveId', 'encoredMoveId'])
      if (value.trainerStatusContext[key] !== undefined)
        integer(value.trainerStatusContext[key], 1, 354);
    if (
      value.trainerStatusContext.gender !== undefined &&
      !['M', 'F'].includes(value.trainerStatusContext.gender)
    )
      fail('INVALID_SNAPSHOT', 'Contexto no válido.');
  }
}
export function validateSnapshot(value: any): Snapshot {
  object(value, [
    'version',
    'battleId',
    'snapshotId',
    'userId',
    'clientId',
    'dataVersion',
    'baseHash',
    'pokemons',
    'activeCaptureId',
    'hpMultiplier',
  ]);
  size(value, 512 * 1024);
  if (value.version !== 1 || value.dataVersion !== '1.6.0')
    fail('INVALID_SNAPSHOT', 'Versión de equipo incompatible.');
  id(value.battleId);
  id(value.snapshotId);
  id(value.clientId);
  integer(value.userId, 1);
  if (
    !Number.isFinite(value.hpMultiplier) ||
    value.hpMultiplier < 1 ||
    value.hpMultiplier > 2
  )
    fail('INVALID_SNAPSHOT', 'Multiplicador no válido.');
  if (
    !Array.isArray(value.pokemons) ||
    value.pokemons.length < 1 ||
    value.pokemons.length > 6 ||
    new Set(value.pokemons.map((mon) => mon?.captureId)).size !==
      value.pokemons.length
  )
    fail('INVALID_SNAPSHOT', 'Envía entre uno y seis Pokémon distintos.');
  value.pokemons.forEach(capture);
  if (
    !value.pokemons.some(
      (mon) => mon.captureId === value.activeCaptureId && hp(mon) > 0,
    )
  )
    fail('INVALID_SNAPSHOT', 'El Pokémon activo debe estar vivo.');
  if (value.baseHash !== digest(value.pokemons))
    fail('SNAPSHOT_HASH_MISMATCH', 'El equipo no coincide con su huella.');
  return value as Snapshot;
}
export function validateChoice(value: any): Choice {
  object(value);
  if (value.kind === 'move') {
    object(value, ['kind', 'moveId']);
    // Native simulator uses move 0 for recharge; its contextual availability is
    // checked against the side's locked request, never against the team moves.
    integer(value.moveId, 0, 354);
  } else if (value.kind === 'switch') {
    object(value, ['kind', 'captureId']);
    id(value.captureId);
  } else if (value.kind === 'item') {
    object(value, ['kind', 'item', 'captureId']);
    if (value.item !== 'full-restore')
      fail('INVALID_CHOICE', 'Objeto no disponible.');
    id(value.captureId);
  } else if (['wait', 'cancel', 'forfeit'].includes(value.kind))
    object(value, ['kind']);
  else fail('INVALID_CHOICE', 'Acción PvP no válida.');
  return value as Choice;
}
export function requestKey(session: any, side: Side): string {
  return session?.runtime
    ? stableJson([
        session.phase,
        session.runtime.turn,
        session.teams[side].activeCaptureId,
        session.runtime.requests[side],
        Boolean(session.runtime.pending[side]),
      ])
    : '';
}
function staticCapture(value: Capture) {
  const output = structuredClone(value);
  delete output.statuses;
  delete output.statusTurns;
  delete output.trainerStatusContext;
  delete output.pokemon.battleStages;
  output.pokemon.stats = output.pokemon.stats.filter(
    (stat: any) => stat.name !== 'hp',
  );
  return output;
}
export function validateSession(session: any, battle: Battle) {
  object(session, [
    'version',
    'id',
    'networkBattleId',
    'phase',
    'hpMultiplier',
    'teams',
    'weather',
    'runtime',
    'history',
    'networkItems',
  ]);
  size(session, 2 * 1024 * 1024);
  if (
    session.version !== 1 ||
    !['setup', 'battle', 'finished'].includes(session.phase)
  )
    fail('INVALID_CHECKPOINT', 'Sesión de combate no válida.');
  id(session.id);
  if (
    session.id !== battle.battleId ||
    (session.networkBattleId !== undefined &&
      session.networkBattleId !== battle.battleId)
  )
    fail('INVALID_CHECKPOINT', 'La sesión corresponde a otra batalla.');
  if (
    !Number.isFinite(session.hpMultiplier) ||
    session.hpMultiplier < 1 ||
    session.hpMultiplier > 2
  )
    fail('INVALID_CHECKPOINT', 'Multiplicador de sesión no válido.');
  object(session.teams, SIDES);
  for (const side of SIDES) {
    const team = session.teams[side];
    object(team, ['name', 'pokemons', 'activeCaptureId']);
    text(team.name, 200);
    const npc = battle.mode === 'trainer' && side === 'b';
    const original = npc
      ? battle.trainer?.team
      : battle.players[side]?.snapshot;
    if (
      !original ||
      !Array.isArray(team.pokemons) ||
      team.pokemons.length !== original.pokemons.length
    )
      fail('INVALID_CHECKPOINT', 'El equipo cambió durante el combate.');
    if (npc && team.name !== battle.trainer.team.name)
      fail('INVALID_CHECKPOINT', 'El Trainer debe conservar su preset.');
    const ids = new Set<string>();
    for (const mon of team.pokemons) {
      capture(mon);
      ids.add(mon.captureId);
      const before = original.pokemons.find(
        (entry) => entry.captureId === mon.captureId,
      );
      if (
        !before ||
        stableJson(staticCapture(mon)) !== stableJson(staticCapture(before))
      )
        fail(
          'INVALID_CHECKPOINT',
          'El checkpoint modifica datos permanentes del equipo.',
        );
      if (!battle.session && hp(mon) !== hp(before))
        fail('INVALID_CHECKPOINT', 'El inicio debe conservar el HP enviado.');
      if (
        npc &&
        !battle.session &&
        (stableJson(mon.statuses ?? []) !== stableJson(before.statuses ?? []) ||
          stableJson(mon.statusTurns ?? {}) !==
            stableJson(before.statusTurns ?? {}) ||
          stableJson(mon.pokemon.battleStages) !==
            stableJson(before.pokemon.battleStages) ||
          stableJson(mon.trainerStatusContext) !==
            stableJson(before.trainerStatusContext))
      )
        fail(
          'INVALID_CHECKPOINT',
          'El Trainer debe iniciar con su estado original.',
        );
    }
    if (
      ids.size !== team.pokemons.length ||
      (team.activeCaptureId !== null && !ids.has(team.activeCaptureId))
    )
      fail('INVALID_CHECKPOINT', 'Pokémon activo no válido.');
    if (
      npc &&
      !battle.session &&
      team.activeCaptureId !== battle.trainer.team.activeCaptureId
    )
      fail(
        'INVALID_CHECKPOINT',
        'El Trainer debe iniciar con el primer Pokémon del preset.',
      );
  }
  if (!Array.isArray(session.history) || session.history.length > 500)
    fail('INVALID_CHECKPOINT', 'Historial demasiado grande.');
  if (session.phase === 'setup') {
    if (session.runtime !== null)
      fail('INVALID_CHECKPOINT', 'Runtime inesperado.');
    return;
  }
  const runtime = session.runtime;
  object(runtime, [
    'engine',
    'serial',
    'turn',
    'pending',
    'requests',
    'ended',
    'winner',
  ]);
  if (
    typeof runtime.engine !== 'string' ||
    runtime.engine.length < 2 ||
    typeof runtime.ended !== 'boolean' ||
    !['a', 'b', 'draw', null].includes(runtime.winner)
  )
    fail('INVALID_CHECKPOINT', 'Runtime no válido.');
  try {
    const engine = JSON.parse(runtime.engine);
    if (!engine || typeof engine !== 'object' || Array.isArray(engine))
      throw new Error();
  } catch {
    fail('INVALID_CHECKPOINT', 'Motor serializado no válido.');
  }
  integer(runtime.serial);
  integer(runtime.turn);
  object(runtime.pending, SIDES);
  object(runtime.requests, SIDES);
  for (const side of SIDES) {
    if (runtime.pending[side] !== undefined)
      validateChoice(runtime.pending[side]);
    const request = runtime.requests[side];
    object(request, [
      'moves',
      'forceSwitch',
      'waiting',
      'locked',
      'trapped',
      'gender',
      'semiInvulnerable',
    ]);
    for (const flag of ['forceSwitch', 'waiting', 'locked', 'trapped'])
      if (typeof request[flag] !== 'boolean')
        fail('INVALID_CHECKPOINT', 'Solicitud de turno no válida.');
    if (
      typeof request.gender !== 'string' ||
      request.gender.length > 10 ||
      !Array.isArray(request.moves) ||
      request.moves.length > 4
    )
      fail('INVALID_CHECKPOINT', 'Movimientos de turno no válidos.');
    for (const move of request.moves) {
      object(move, ['id', 'name', 'pp', 'maxpp', 'disabled']);
      integer(move.id, 0, 354);
      if (move.id === 0 && !request.locked)
        fail(
          'INVALID_CHECKPOINT',
          'La recarga requiere una solicitud forzada.',
        );
      text(move.name, 100);
      integer(move.maxpp, 0, 100);
      integer(move.pp, 0, move.maxpp);
      if (typeof move.disabled !== 'boolean')
        fail('INVALID_CHECKPOINT', 'Movimiento de turno no válido.');
    }
    if (
      request.semiInvulnerable !== undefined &&
      !['dig', 'fly', 'dive', 'bounce'].includes(request.semiInvulnerable)
    )
      fail('INVALID_CHECKPOINT', 'Solicitud de turno no válida.');
    if (
      runtime.pending[side]?.kind === 'move' &&
      runtime.pending[side].moveId === 0 &&
      (!request.locked ||
        !request.moves.some((move) => move.id === 0 && !move.disabled))
    )
      fail('INVALID_CHECKPOINT', 'La acción de recarga no está disponible.');
  }
  if (
    (session.phase === 'finished') !== runtime.ended ||
    (runtime.ended ? runtime.winner === null : runtime.winner !== null)
  )
    fail('INVALID_CHECKPOINT', 'Ganador y fase no coinciden.');
}
