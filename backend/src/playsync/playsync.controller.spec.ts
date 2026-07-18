import { Test, TestingModule } from '@nestjs/testing';
import { PlaysyncController } from './playsync.controller';

describe('PlaysyncController', () => {
  let controller: PlaysyncController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PlaysyncController],
    }).compile();

    controller = module.get<PlaysyncController>(PlaysyncController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
