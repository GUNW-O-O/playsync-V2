import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CreateStoreDto, UpdateStoreDto } from 'shared/dto/store.dto';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { RolesGuard } from 'src/auth/guard/roles.guard';
import { StoreService } from './store.service';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';

@Controller('store')
@UseGuards(JwtAuthGuard, RolesGuard )
@Roles(Role.STORE_ADMIN, Role.PLATFORM_ADMIN)
export class StoreController {
  constructor(private storeService: StoreService) { };

  @Post()
  async createStore(@Req() req, @Body() dto: CreateStoreDto) {
    return this.storeService.createStore(req.user.userId, dto);
  }

  @Get()
  async getUserStores(@Req() req) {
    return this.storeService.getUserStores(req.user.userId);
  }

  @Get('/:id')
  async getStoreDetail(@Req() req, @Param('id') id: string) {
    return this.storeService.getStoreDetail(id, req.user.userId);
  }

  @Put(':id')
  async updateStore(@Param('id') id: string, @Body() dto: UpdateStoreDto) {
    return this.storeService.updateStore(id, dto);
  }

  @Delete(':ownerId/:id')
  async removeStore(@Param('id') id: string, @Param('ownerId') ownerId: string) {
    return this.storeService.removeStore(id, ownerId);
  }

}