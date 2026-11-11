import { DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MessagesModule } from '../messages/messages.module';
import { PvpGateway } from './pvp.gateway';
import { PvpService } from './pvp.service';
import {
  MongoPvpRepository,
  PVP_MODEL,
  PVP_REPOSITORY,
  PvpBattleSchema,
  PvpRepository,
} from './pvp.repository';

@Module({
  imports: [MessagesModule],
  providers: [PvpService, PvpGateway],
  exports: [PvpService],
})
export class PvpModule {
  static forMongo(): DynamicModule {
    return {
      module: PvpModule,
      imports: [
        MongooseModule.forFeature([
          { name: PVP_MODEL, schema: PvpBattleSchema },
        ]),
      ],
      providers: [{ provide: PVP_REPOSITORY, useClass: MongoPvpRepository }],
    };
  }
  static withRepository(repository: PvpRepository): DynamicModule {
    return {
      module: PvpModule,
      providers: [{ provide: PVP_REPOSITORY, useValue: repository }],
    };
  }
}
