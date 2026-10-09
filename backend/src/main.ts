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
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
