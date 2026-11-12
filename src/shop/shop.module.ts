import { DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MessagesModule } from '../messages/messages.module';
import { ShopGateway } from './shop.gateway';
import { ShopService } from './shop.service';
import {
  MongoShopRepository,
  SHOP_MODEL,
  SHOP_REPOSITORY,
  ShopRepository,
  ShopWalletSchema,
} from './shop.repository';

@Module({
  imports: [MessagesModule],
  providers: [ShopService, ShopGateway],
  exports: [ShopService],
})
export class ShopModule {
  static forMongo(): DynamicModule {
    return {
      module: ShopModule,
      imports: [
        MongooseModule.forFeature([
          { name: SHOP_MODEL, schema: ShopWalletSchema },
        ]),
      ],
      providers: [{ provide: SHOP_REPOSITORY, useClass: MongoShopRepository }],
    };
  }
  static withRepository(repository: ShopRepository): DynamicModule {
    return {
      module: ShopModule,
      providers: [{ provide: SHOP_REPOSITORY, useValue: repository }],
    };
  }
}
