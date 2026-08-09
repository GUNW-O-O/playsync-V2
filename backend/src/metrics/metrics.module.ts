import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * `LOAD_METRICS=1`일 때만 `AppModule`이 이 모듈을 들인다.
 *
 * 게이트를 모듈 등록에 두는 것이 요점이다. 컨트롤러 안에서 환경변수를 보면
 * 라우트는 존재하되 404를 내는 상태가 되고, 그러면 "꺼져 있다"와 "경로를
 * 잘못 쳤다"가 구분되지 않는다. 여기서는 꺼져 있을 때 히스토그램 타이머도
 * 돌지 않는다.
 */
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
})
export class MetricsModule {}
