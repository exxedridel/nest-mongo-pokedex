import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { digest } from '../pvp/pvp.validation';
import {
  clone,
  fail,
  MAX_SHOP_PRICE,
  SHOP_CATALOG,
  ShopCatalog,
  ShopItemId,
} from './shop.types';
import {
  SHOP_CATALOG_REPOSITORY,
  ShopCatalogRecord,
  ShopCatalogRepository,
} from './shop-catalog.repository';

/** One replica serializes catalog writes with the final wallet commit. The
 * player's asynchronous PREPARE does not hold this queue. */
@Injectable()
export class ShopCatalogService implements OnModuleInit {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    @Inject(SHOP_CATALOG_REPOSITORY) readonly repository: ShopCatalogRepository,
  ) {}
  async onModuleInit() {
    await this.repository.ready();
    await this.record();
  }
  private async record(): Promise<ShopCatalogRecord> {
    const found = await this.repository.get();
    if (found) return found;
    const initial: ShopCatalogRecord = {
      revision: 0,
      prices: { ...SHOP_CATALOG },
      changes: [],
    };
    if (await this.repository.insert(initial)) return initial;
    const raced = await this.repository.get();
    if (!raced)
      fail('SHOP_UNAVAILABLE', 'No se pudo recuperar el catálogo de precios.');
    return raced;
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  async snapshot(): Promise<ShopCatalog> {
    const row = await this.record();
    return this.view(row);
  }
  private view(row: ShopCatalogRecord): ShopCatalog {
    return {
      revision: row.revision,
      prices: clone(row.prices),
      captureDifficulty: row.captureDifficulty ?? 0,
    };
  }
  private checkCaptureRevision(actual: number, expected: number) {
    if (actual !== expected)
      fail(
        'CAPTURE_RULES_CHANGED',
        'La dificultad cambió. Revisa el mínimo de captura y confirma de nuevo.',
      );
  }
  async captureQuote(expected: number | undefined): Promise<ShopCatalog> {
    const row = await this.snapshot();
    if (expected === undefined) {
      if (row.captureDifficulty !== 0)
        fail(
          'PLAYER_UPDATE_REQUIRED',
          'Actualiza y recarga la aplicación para usar la dificultad de captura vigente.',
        );
    } else this.checkCaptureRevision(row.revision, expected);
    return row;
  }
  commitCapture<T>(expected: number, operation: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const row = await this.record();
      this.checkCaptureRevision(row.revision, expected);
      return operation();
    });
  }
  async quote(expected: number | undefined): Promise<ShopCatalog> {
    const row = await this.snapshot();
    this.checkRevision(row.revision, expected);
    return row;
  }
  private checkRevision(actual: number, expected: number | undefined) {
    if (
      (expected === undefined && actual !== 0) ||
      (expected !== undefined && expected !== actual)
    )
      fail(
        'PRICE_CHANGED',
        'Los precios cambiaron. Actualiza la cotización antes de confirmar.',
      );
  }
  commit<T>(expected: number, operation: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const row = await this.record();
      this.checkRevision(row.revision, expected);
      return operation();
    });
  }
  setPrice(
    adminUserId: number,
    input: any,
    authorize?: () => Promise<void>,
  ): Promise<ShopCatalog> {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) =>
          !['requestId', 'itemId', 'price', 'expectedCatalogRevision'].includes(
            key,
          ),
      ) ||
      typeof input.requestId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.requestId) ||
      typeof input.itemId !== 'string' ||
      !Object.prototype.hasOwnProperty.call(SHOP_CATALOG, input.itemId) ||
      !Number.isSafeInteger(input.price) ||
      input.price < 0 ||
      input.price > MAX_SHOP_PRICE ||
      !Number.isSafeInteger(input.expectedCatalogRevision) ||
      input.expectedCatalogRevision < 0
    )
      fail('INVALID_INPUT', 'El precio debe ser un entero no negativo válido.');
    const hash = digest([
      adminUserId,
      input.itemId,
      input.price,
      input.expectedCatalogRevision,
    ]);
    return this.exclusive(async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const row = await this.record();
        const prior = row.changes.find(
          (change) =>
            change.adminUserId === adminUserId &&
            change.requestId === input.requestId,
        );
        if (prior) {
          if (prior.requestHash !== hash)
            fail(
              'REQUEST_CONFLICT',
              'La solicitud ya corresponde a otro cambio de precio.',
            );
          return this.view(row);
        }
        this.checkRevision(row.revision, input.expectedCatalogRevision);
        if (row.changes.length >= 4096)
          fail(
            'CATALOG_LIMIT',
            'Se alcanzó el límite de historial de precios de esta versión.',
          );
        const previous = row.revision;
        row.prices[input.itemId as ShopItemId] = input.price;
        row.revision++;
        row.changes.push({
          adminUserId,
          requestId: input.requestId,
          itemId: input.itemId,
          price: input.price,
          requestHash: hash,
          createdAt: Date.now(),
        });
        await authorize?.();
        if (await this.repository.compareAndSwap(row, previous))
          return this.view(row);
      }
      fail(
        'CATALOG_CONFLICT',
        'Otra operación cambió los precios. Sincroniza y reintenta.',
      );
    });
  }
  setCaptureDifficulty(
    adminUserId: number,
    input: any,
    authorize?: () => Promise<void>,
  ): Promise<ShopCatalog> {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) =>
          !['requestId', 'modifier', 'expectedCatalogRevision'].includes(key),
      ) ||
      typeof input.requestId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.requestId) ||
      !Number.isSafeInteger(input.modifier) ||
      input.modifier < 0 ||
      input.modifier > 20 ||
      !Number.isSafeInteger(input.expectedCatalogRevision) ||
      input.expectedCatalogRevision < 0
    )
      fail('INVALID_INPUT', 'La dificultad debe ser un entero entre 0 y 20.');
    const hash = digest([
      'capture-difficulty',
      adminUserId,
      input.modifier,
      input.expectedCatalogRevision,
    ]);
    return this.exclusive(async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const row = await this.record();
        const prior = row.changes.find(
          (change) =>
            change.adminUserId === adminUserId &&
            change.requestId === input.requestId,
        );
        if (prior) {
          if (prior.requestHash !== hash)
            fail(
              'REQUEST_CONFLICT',
              'La solicitud ya corresponde a otro cambio del catálogo.',
            );
          return this.view(row);
        }
        this.checkCaptureRevision(row.revision, input.expectedCatalogRevision);
        if (row.changes.length >= 4096)
          fail(
            'CATALOG_LIMIT',
            'Se alcanzó el límite de historial del catálogo de esta versión.',
          );
        const previous = row.revision;
        row.captureDifficulty = input.modifier;
        row.revision++;
        row.changes.push({
          kind: 'capture-difficulty',
          adminUserId,
          requestId: input.requestId,
          modifier: input.modifier,
          requestHash: hash,
          createdAt: Date.now(),
        });
        await authorize?.();
        if (await this.repository.compareAndSwap(row, previous))
          return this.view(row);
      }
      fail(
        'CATALOG_CONFLICT',
        'Otra operación cambió la dificultad. Sincroniza y reintenta.',
      );
    });
  }
}
