import { DynamicModule, Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MessagesModule } from '../messages/messages.module';
import { ShopGateway } from './shop.gateway';
import { ShopService } from './shop.service';
import { ShopCatalogService } from './shop-catalog.service';
import {
  MemoryShopCatalogRepository,
  MongoShopCatalogRepository,
  SHOP_CATALOG_MODEL,
  SHOP_CATALOG_REPOSITORY,
  ShopCatalogRepository,
  ShopCatalogSchema,
} from './shop-catalog.repository';
import {
  MongoShopRepository,
  SHOP_MODEL,
  SHOP_REPOSITORY,
  ShopRepository,
  ShopWalletSchema,
} from './shop.repository';

@Global()
@Module({
  imports: [MessagesModule],
  providers: [ShopService, ShopGateway, ShopCatalogService],
  exports: [ShopService, ShopCatalogService],
})
export class ShopModule {
  static forMongo(): DynamicModule {
    return {
      module: ShopModule,
      imports: [
        MongooseModule.forFeature([
          { name: SHOP_MODEL, schema: ShopWalletSchema },
          { name: SHOP_CATALOG_MODEL, schema: ShopCatalogSchema },
        ]),
      ],
      providers: [
        { provide: SHOP_REPOSITORY, useClass: MongoShopRepository },
        {
          provide: SHOP_CATALOG_REPOSITORY,
          useClass: MongoShopCatalogRepository,
        },
      ],
    };
  }
  static withRepository(
    repository: ShopRepository,
    catalogRepository: ShopCatalogRepository = new MemoryShopCatalogRepository(),
  ): DynamicModule {
    return {
      module: ShopModule,
      providers: [
        { provide: SHOP_REPOSITORY, useValue: repository },
        { provide: SHOP_CATALOG_REPOSITORY, useValue: catalogRepository },
      ],
    };
  }
}
