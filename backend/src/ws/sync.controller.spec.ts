import 'reflect-metadata';
import { ConflictException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RolesGuard } from 'src/auth/guard/roles.guard';
import { SyncController } from './sync.controller';

describe('SyncController', () => {
  const guard = new RolesGuard(new Reflector());
  function contextFor(handler: Function, role: Role): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => SyncController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext;
  }

  it.each([
    ['status', SyncController.prototype.status],
    ['force', SyncController.prototype.force],
  ])('%s는 STORE_ADMIN만 통과한다', (_name, handler) => {
    expect(guard.canActivate(contextFor(handler, Role.STORE_ADMIN))).toBe(true);
    expect(guard.canActivate(contextFor(handler, Role.PLATFORM_ADMIN))).toBe(false);
    expect(guard.canActivate(contextFor(handler, Role.DEALER))).toBe(false);
  });

  function make(forceResult = true) {
    const gateway = { syncStatus: jest.fn().mockResolvedValue({ syncing: false }), forceSync: jest.fn().mockResolvedValue(forceResult) };
    const sessions = { assertTournamentOwnership: jest.fn().mockResolvedValue(undefined) };
    return { gateway, sessions, controller: new SyncController(gateway as any, sessions as any) };
  }
  const req = { user: { userId: 'owner-1' } };

  /** 소유권이 먼저다 — 남의 대회면 게이트웨이에 닿지 않는다. */
  it('소유권이 실패하면 게이트웨이를 부르지 않는다', async () => {
    const { gateway, sessions, controller } = make();
    sessions.assertTournamentOwnership.mockRejectedValue(new ForbiddenException('본인의 매장이 아닙니다.'));
    await expect(controller.force(req, 't1')).rejects.toThrow(ForbiddenException);
    await expect(controller.status(req, 't1')).rejects.toThrow(ForbiddenException);
    expect(gateway.forceSync).not.toHaveBeenCalled();
    expect(gateway.syncStatus).not.toHaveBeenCalled();
  });

  it('풀지 못했으면 409다', async () => {
    const { controller } = make(false);
    await expect(controller.force(req, 't1')).rejects.toThrow(ConflictException);
  });

  it('풀었으면 ok', async () => {
    const { controller, sessions, gateway } = make(true);
    await expect(controller.force(req, 't1')).resolves.toEqual({ ok: true });
    expect(sessions.assertTournamentOwnership).toHaveBeenCalledWith('t1', 'owner-1');
    expect(gateway.forceSync).toHaveBeenCalledWith('t1', 'owner-1');
  });
});
