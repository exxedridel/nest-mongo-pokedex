import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MessagesGateway } from './messages.gateway';
import { AuthIdentityService } from './auth-identity.service';
import { PlayerActivityService } from './player-activity.service';

@Module({
  imports: [ConfigModule],
  providers: [MessagesGateway, AuthIdentityService, PlayerActivityService],
  exports: [AuthIdentityService, PlayerActivityService],
})
export class MessagesModule {}
