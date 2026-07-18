import { Module } from '@nestjs/common';
import { UserModule } from 'src/user/user.module';
import { StoreService } from './store.service';
import { StoreController } from './store.controller';
import { SessionModule } from './session/session.module';

@Module({
  imports : [UserModule, SessionModule],
  controllers : [StoreController],
  providers : [StoreService,]
})
export class StoreModule {}
