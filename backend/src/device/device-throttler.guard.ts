import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { deviceTokenFrom, verifyDeviceToken } from './device-token';

/**
 * 요청율 상한의 버킷을 기기로 가른다(T112).
 *
 * 브라우저 요청은 전부 Next 프로세스 하나의 주소로 오므로(`auth/throttle.ts`),
 * IP로만 가르면 아무나 그 버킷을 채워 매장 태블릿 전체를 막는다. 서명이
 * 검증된 기기 토큰이면 `device:<id>`로 따로 센다.
 *
 * **검증 전에 가르지 않는다.** 토큰 문자열로 가르면 아무 문자열이나 보내는
 * 쪽이 요청마다 새 버킷을 얻는다. 버전 대조(DB)는 여기서 하지 않는다 —
 * 해제된 기기는 자기 버킷을 쓰다가 `DeviceGuard`에서 막히고, 그 버킷은
 * 아무에게도 피해가 없다.
 */
@Injectable()
export class DeviceThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwt: JwtService,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const device = verifyDeviceToken(this.jwt, deviceTokenFrom(req));
    return device ? `device:${device.deviceId}` : req.ip;
  }
}
