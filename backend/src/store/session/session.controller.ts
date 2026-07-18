// src/store/session/session.controller.ts
import { Controller, Get, Post, Patch, Body, Param, UseGuards } from '@nestjs/common';
import { SessionService } from './session.service';
import { RolesGuard } from 'src/auth/guard/roles.guard';
import { Role } from '@prisma/client';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { CreateTournamentDto, UpdateTournamentDto } from 'shared/dto/tournament.dto';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.STORE_ADMIN, Role.PLATFORM_ADMIN)
@Controller('store/sessions')
export class SessionController {
  constructor(private readonly sessionService: SessionService) {}

  @Post()
  async create(@Body('dto') dto: CreateTournamentDto, @Body('blindStructure') blindStructure?: any) {
    return await this.sessionService.createSession(dto, blindStructure);
  }

  @Get(':storeId')
  async findAll(@Param('storeId') storeId: string) {
    return await this.sessionService.getStoreAllSessions(storeId);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateTournamentDto) {
    return await this.sessionService.updateSession(id, dto);
  }

  @Patch(':id/start')
  async start(@Param('id') id: string) {
    return await this.sessionService.startSession(id);
  }

  @Patch(':id/complete')
  async complete(@Param('id') id: string) {
    return await this.sessionService.completeSession(id);
  }
}