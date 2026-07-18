import { Test, TestingModule } from '@nestjs/testing';
import { PlaysyncService } from './playsync.service';

describe('PlaysyncService', () => {
  let service: PlaysyncService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PlaysyncService],
    }).compile();

    service = module.get<PlaysyncService>(PlaysyncService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
