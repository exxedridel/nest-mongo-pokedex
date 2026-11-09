import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MessagesGateway } from './messages.gateway';

@Module({
  imports: [ConfigModule],
  providers: [MessagesGateway],
})
export class MessagesModule {}
