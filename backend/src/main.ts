import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin : ['http://localhost:3000'],
    credentials : true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist : true, forbidNonWhitelisted : true}));
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
