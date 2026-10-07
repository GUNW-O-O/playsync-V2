import { Module } from '@nestjs/common';
import { DeviceController } from './device.controller';
import { DeviceService } from './device.service';

// PrismaModule · JwtModule이 전역이라 import할 것이 없다(`EntryModule`과 같다).
@Module({
  controllers: [DeviceController],
  providers: [DeviceService],
})
export class DeviceModule {}
