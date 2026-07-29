import { Module } from '@nestjs/common';
import { EntryController } from './entry.controller';
import { EntryService } from './entry.service';

// PrismaModule · RedisModule · JwtModule · EventEmitterModule이 전부 전역이라
// import할 것이 없다.
@Module({
  controllers: [EntryController],
  providers: [EntryService],
  exports: [EntryService],
})
export class EntryModule {}
