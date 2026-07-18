import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from '../decorator/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) { }

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles) return true;

    const req = this.getRequest(context);
    const user = req.user;

    // 유저의 role이 요구사항에 포함되는지 확인 
    return user && requiredRoles.includes(user.role);
  }

  private getRequest(context: ExecutionContext) {
    return context.switchToHttp().getRequest();
  }
}