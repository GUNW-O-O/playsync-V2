import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateStoreDto, UpdateStoreDto } from 'shared/dto/store.dto';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class StoreService {
  constructor(private prisma: PrismaService) { };

  // 가맹점주 아이디의 가맹점들 조회
  async getUserStores(id: string) {
    return await this.prisma.store.findMany({
      where: { ownerId : id },
    });
  }

  // 특정 가맹점 상세 조회
  async getStoreDetail(id: string, ownerId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id },
      include : {
        blindStructures : true,
      }
    });
    if (!store) throw new NotFoundException('일시적인 오류 혹은 가맹점 정보가 없습니다.');
    if (store.ownerId !== ownerId) throw new ForbiddenException('본인의 가맹점이 아닙니다.');

    return store;
  }

  async createStore(ownerId: string, dto: CreateStoreDto) {
    return this.prisma.store.create({
      data: {
        name: dto.storeName,
        ownerId: ownerId,
      }
    });
  }

  async updateStore(storeId: string, dto: UpdateStoreDto) {
    await this.getStoreDetail(storeId, dto.ownerId);
    return this.prisma.store.update({
      where: { id: storeId },
      data: { name: dto.storeName },
    });
  }

  async removeStore(id: string, ownerId: string) {
    await this.getStoreDetail(id, ownerId);
    return this.prisma.store.delete({ where: { id } });
  }

}
