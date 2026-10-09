import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { bcryptRounds, isWeakenedBcrypt } from './auth/bcrypt-cost';
import { observe } from './metrics/stage-timer';
import { createServer } from 'net';

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
  // **리스너를 여럿 둔다**(T119, `LISTEN_SOCKETS`). Node는 이벤트 루프 한 바퀴에 리스너
  // 하나당 접속을 **하나만** 받는다(libuv 1.51에서 실측) — 루프가 바쁠수록 받는 속도가
  // 떨어져, 667테이블 kill에서 티켓은 초당 200장 나가는데 접속은 초당 57대만 받았다.
  // 같은 포트에 `SO_REUSEPORT` 리스너 K개를 두면 한 바퀴에 K개를 받는다. 받은 소켓은
  // Nest의 HTTP 서버에 그대로 넘긴다 — 라우팅도 WS 업그레이드도 그 서버가 한다.
  //
  // 기본값 1은 지금까지와 같은 `app.listen`이다. `reusePort`는 리눅스에서만 된다.
  const port = Number(process.env.PORT ?? 3001);
  const listeners = Number(process.env.LISTEN_SOCKETS ?? 1);
  if (listeners > 1) {
    await app.init();
    const http = app.getHttpServer();
    for (let i = 0; i < listeners; i++) {
      const acceptor = createServer((socket) => http.emit('connection', socket));
      await new Promise<void>((resolve) => acceptor.listen({ port, reusePort: true }, resolve));
    }
  } else {
    await app.listen(port);
  }
}
bootstrap();
