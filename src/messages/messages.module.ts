import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MessagesGateway } from './messages.gateway';
import { AuthIdentityService } from './auth-identity.service';

@Module({
  imports: [ConfigModule],
  providers: [MessagesGateway, AuthIdentityService],
})
export class MessagesModule {}
