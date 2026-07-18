// src/prisma/prisma.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('❌ DATABASE_URL 환경 변수가 설정되지 않았습니다.');
    }
    // 2. pg Pool을 명시적으로 생성하여 어댑터에 전달 (권장 방식)
    const pool = new Pool({ connectionString });
    const adapter = new PrismaPg(pool);
    // const adapter = new PrismaPg({ url: process.env.DATABASE_URL });
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}