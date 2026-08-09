import { Controller, Get } from '@nestjs/common';
import { MetricsService } from './metrics.service';
// `isolatedModules` + `emitDecoratorMetadata` 조합에서는 데코레이터가 달린
// 시그니처의 타입을 `import type`으로 가져와야 한다(TS1272).
import type { MetricsSnapshot } from './metrics.service';

/**
 * 부하 실행 중에만 존재하는 계측 창구.
 *
 * **가드가 없다.** 이 리포는 컨트롤러 단위로 가드를 걸고 전역 가드가 없어서,
 * 여기 붙일 것을 고르려면 부하 실행용 신원을 새로 만들어야 한다. 그 대신
 * 세 겹으로 노출을 좁혔다.
 *
 * 1. `LOAD_METRICS=1`이 아니면 이 모듈 자체가 등록되지 않는다. 기본값은 꺼짐이라
 *    개발·운영 경로에는 라우트가 존재하지 않는다.
 * 2. 부하용 컨테이너는 포트를 `127.0.0.1`에만 묶는다(`docker-compose.test.yml`).
 * 3. 담는 값이 지연·CPU·메모리뿐이다. 대회도 사용자도 칩도 나오지 않는다.
 *
 * T32가 걷어낸 "라우트를 단 채 남은 수동 테스트 잔재"와 다른 종류다 — 그쪽은
 * **기본으로 켜져 있던** 경로였다.
 */
@Controller('internal')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  read(): MetricsSnapshot {
    return this.metrics.read();
  }
}
