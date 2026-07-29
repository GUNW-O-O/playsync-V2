import { Module } from '@nestjs/common';
import { DealerModule } from './dealer/dealer.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { SessionModule } from './store/session/session.module';
import { UserModule } from './user/user.module';
import { PlaysyncModule } from './playsync/playsync.module';
import { BullModule } from '@nestjs/bullmq';
import { PaymentModule } from './payment/payment.module';
import { AuthModule } from './auth/auth.module';
import { StoreModule } from './store/store.module';
import { WsModule } from './ws/ws.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EntryModule } from './entry/entry.module';

@Module({
  imports:[
    BullModule.forRoot({
      connection : {
        host : process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT),
        password: process.env.REDIS_PASSWORD,
      }
    }),
    EventEmitterModule.forRoot(),
    AuthModule,
    PlaysyncModule,
    PrismaModule,
    RedisModule,
    UserModule,
    SessionModule,
    DealerModule,
    PlaysyncModule,
    PaymentModule,
    StoreModule,
    WsModule,
    EntryModule,
  ],
})
export class AppModule {}
