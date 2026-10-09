import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { bcryptRounds, isWeakenedBcrypt } from './auth/bcrypt-cost';
import { observe } from './metrics/stage-timer';

async function bootstrap() {
  // 부하 무대 전용 노브가 제품 기동에 남으면 비밀번호가 약하게 구워진다.
  // 조용히 지나가면 안 되는 자리라 기동 때 한 번 크게 찍는다
  // (`auth/bcrypt-cost.ts`). 던지지는 않는다 — 무대에서는 이것이 정상이다.
  if (isWeakenedBcrypt()) {
    console.warn(
      `[경고] BCRYPT_ROUNDS=${bcryptRounds()} — 제품 값(10)보다 낮다. ` +
        '부하 무대가 아니면 지금 내려라. 이 값으로 구운 비밀번호는 그대로 남는다.',
    );
  }

  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin : ['http://localhost:3000'],
    credentials : true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist : true, forbidNonWhitelisted : true}));
  app.useWebSocketAdapter(new WsAdapter(app));
  // T119 계측. 가드까지 포함한 요청 전체 시간을 경로별로 쌓는다 — 풀을 누가 쓰는지 본다.
  if (process.env.LOAD_METRICS === '1') {
    app.use((req: { method: string; path: string }, res: { on: (e: string, f: () => void) => void; statusCode: number }, next: () => void) => {
      const start = performance.now();
      const route = req.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id');
      res.on('finish', () => observe(`http.${req.method} ${route}.${res.statusCode}`, performance.now() - start));
      next();
    });
  }
  // **접속 대기열을 넓힌다**(T119). Node의 기본값은 511이다. 서버가 죽었다 뜨면
  // 태블릿 전원이 소켓마다 새 TCP 연결을 여는데, 이벤트 루프가 수백 ms만 밀려도 그
  // 사이 도착분이 511을 넘어 커널이 연결을 버린다 — 667테이블 kill에서 부팅 45초
  // 동안 33,095건이 넘쳤고(`ListenOverflows`), 버려진 쪽은 수 초~30초 뒤에야 다시
  // 닿아 티켓(수명 30초)이 그 사이 낡았다. 커널 상한(`net.core.somaxconn`)이 이 값을
  // 다시 자른다.
  const backlog = Number(process.env.LISTEN_BACKLOG ?? 4096);
  // Nest의 타입에는 backlog 자리가 없지만 인자는 `http.Server.listen`으로 그대로 간다.
  await app.listen(process.env.PORT ?? 3001, backlog as never);
}
bootstrap();
