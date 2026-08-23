// src/store/session/session.controller.ts
import { Controller, Delete, Get, Post, Patch, Body, Param, Req, UseGuards } from '@nestjs/common';
import { SessionService } from './session.service';
import { RolesGuard } from 'src/auth/guard/roles.guard';
import { Role } from '@prisma/client';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { UpdateTournamentDto } from 'shared/dto/tournament.dto';
import { ReleaseSeatsDto } from 'shared/dto/seat-release.dto';
import { CreateSessionBody } from 'shared/dto/create-session-body.dto';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.STORE_ADMIN, Role.PLATFORM_ADMIN)
@Controller('store/sessions')
export class SessionController {
  constructor(private readonly sessionService: SessionService) {}

  // 생성·목록은 대회가 아니라 **상점**을 가리키는 경로라 소유권의 근거가
  // `dto.storeId`/`:storeId`다. 그 값을 그대로 믿으면 다른 상점 관리자가
  // 남의 상점에 대회를 세우고 남의 대회 목록을 읽는다 — 확인은 다른 운영
  // 조작과 같은 자리, 서비스 메서드 안(`assertStoreOwnership`)이다.
  //
  // `dto`·`blindStructure`를 **봉투 하나**(`CreateSessionBody`)로 받는다.
  // 예전에는 파라미터 둘로 나눠 받았는데, 선택값인 `blindStructure`에 붙인
  // `@IsOptional()`이 필드 데코레이터라 파라미터 레벨에서는 아무 효과가
  // 없었다 — `blindStructure`를 생략한 정상 요청(`dto.blindId`로 기존 구조를
  // 재사용하는 경로)까지 400으로 막혔다. 근거는 `CreateSessionBody`의 주석.
  // Prisma가 `structure`를 Json 컬럼에 넣는 것은 **저장 타입의 문제지 입력
  // 타입의 문제가 아니다** — 저장 쪽은 서비스에서 `as any`로 이미 넘긴다.
  @Post()
  async create(@Req() req, @Body() body: CreateSessionBody) {
    return await this.sessionService.createSession(body.dto, req.user.userId, body.blindStructure);
  }

  @Get(':storeId')
  async findAll(@Req() req, @Param('storeId') storeId: string) {
    return await this.sessionService.getStoreAllSessions(storeId, req.user.userId);
  }

  // 수정도 남의 대회를 건드릴 수 없어야 한다. 참가비·시작 스택·블라인드
  // 구조·상금 분배율이 전부 이 경로로 바뀐다. 소유권 확인은 다른 운영 조작과
  // 같은 자리 — 서비스 메서드 안이다.
  @Roles(Role.STORE_ADMIN)
  @Patch(':id')
  async update(@Req() req, @Param('id') id: string, @Body() dto: UpdateTournamentDto) {
    return await this.sessionService.updateSession(id, dto, req.user.userId);
  }

  // 시작도 남의 대회를 건드릴 수 없어야 한다. 소유권 확인은 서비스 메서드
  // 안이고, 다른 운영 조작 경로와 같은 이유다.
  @Patch(':id/start')
  async start(@Req() req, @Param('id') id: string) {
    return await this.sessionService.startSession(id, req.user.userId);
  }

  // 종료도 남의 대회를 건드릴 수 없어야 한다 — 대회를 닫고 정산을 확정한다.
  // 소유권 확인은 다른 운영 조작과 같은 자리, 서비스 메서드 안이다.
  @Patch(':id/complete')
  async complete(@Req() req, @Param('id') id: string) {
    return await this.sessionService.completeSession(id, req.user.userId);
  }

  // 취소는 참가비를 돌려주는 **돈 경로**다. 재발급/내보내기와 같은 문을 쓴다 —
  // 소유권 확인은 서비스 메서드 안이고, PLATFORM_ADMIN까지 우회 길을 늘리지
  // 않는다.
  @Roles(Role.STORE_ADMIN)
  @Post(':id/cancel')
  async cancel(@Req() req, @Param('id') id: string) {
    await this.sessionService.cancelSession(id, req.user.userId);
    return { ok: true };
  }

  // 중단도 돈 경로다. 취소와 문을 나누는 이유는 **규칙이 달라서**다 — 취소는
  // 시작 전 전액 환불, 중단은 진행 중인 사람 100% · 탈락한 사람 50%이고 남은
  // 돈은 상점 몫이다. 한 라우트에 담으면 어느 규칙이 도는지가 대회 상태에
  // 숨어, 누르는 사람이 무엇이 일어날지 모른 채 누른다.
  @Roles(Role.STORE_ADMIN)
  @Post(':id/abort')
  async abort(@Req() req, @Param('id') id: string) {
    return await this.sessionService.abortSession(id, req.user.userId);
  }

  // 딜(ICM 찹)도 돈 경로다. 중단과 문을 나누는 이유는 **뜻이 달라서**다 —
  // 중단은 대회가 못 열려서 되돌리는 것이고, 딜은 정상적인 마무리다. 남는
  // 기록도 다르다(중단은 `REFUND`, 딜은 `PRIZE`).
  @Roles(Role.STORE_ADMIN)
  @Post(':id/chop')
  async chop(@Req() req, @Param('id') id: string) {
    await this.sessionService.chopSession(id, req.user.userId);
    return { ok: true };
  }

  // 재발급/내보내기는 다른 상점의 대회를 건드릴 수 없어야 한다 — 재발급은
  // 평문 OTP를 응답에 실어 돌려주므로 역할만 확인하고 지나가면 그대로
  // 남의 대회 딜러 접근권을 만들어내는 경로가 된다. 소유권 확인은
  // 컨트롤러가 아니라 서비스 메서드 안에서 한다(session.service.ts의
  // assertTournamentOwnership 주석 참고) — 여기서는 호출자 id만 넘긴다.
  //
  // 클래스 수준 권한은 STORE_ADMIN·PLATFORM_ADMIN 둘 다 허용하지만, 이
  // 둘은 평문 OTP를 돌려주는 돈 경로라 PLATFORM_ADMIN까지 우회 길을
  // 늘리지 않는다 — STORE_ADMIN 전용으로 메서드 수준에서 좁힌다.
  @Roles(Role.STORE_ADMIN)
  @Post(':id/dealer-otp/reissue')
  async reissueDealerOtp(@Req() req, @Param('id') tournamentId: string) {
    return await this.sessionService.reissueDealerOtp(tournamentId, req.user.userId);
  }

  @Roles(Role.STORE_ADMIN)
  @Post(':id/dealer-session/revoke')
  async revokeDealerSession(@Req() req, @Param('id') tournamentId: string) {
    await this.sessionService.revokeDealerSession(tournamentId, req.user.userId);
    return { ok: true };
  }

  // 테이블 추가/삭제도 남의 대회를 건드릴 수 없어야 한다. 소유권 확인은
  // 재발급/내보내기와 같은 자리 — 서비스 메서드 안이다. PLATFORM_ADMIN을
  // 빼는 이유도 같다: 운영 조작 경로에 우회 길을 늘리지 않는다.
  @Roles(Role.STORE_ADMIN)
  @Post(':id/tables')
  async createTable(@Req() req, @Param('id') tournamentId: string) {
    return await this.sessionService.createTable(tournamentId, req.user.userId);
  }

  @Roles(Role.STORE_ADMIN)
  @Delete(':id/tables/:tableId')
  async deleteTable(
    @Req() req,
    @Param('id') tournamentId: string,
    @Param('tableId') tableId: string,
  ) {
    await this.sessionService.deleteTable(tournamentId, tableId, req.user.userId);
    return { ok: true };
  }

  // 좌석 해제도 남의 대회를 건드릴 수 없어야 한다. 소유권 확인은 서비스
  // 메서드 안이고, PLATFORM_ADMIN을 빼는 것도 테이블 추가/삭제와 같은 이유다.
  @Roles(Role.STORE_ADMIN)
  @Post(':id/tables/:tableId/seats/release')
  async releaseSeats(
    @Req() req,
    @Param('id') tournamentId: string,
    @Param('tableId') tableId: string,
    @Body() dto: ReleaseSeatsDto,
  ) {
    await this.sessionService.releaseSeats(tournamentId, tableId, dto.seats, req.user.userId);
    return { ok: true };
  }

  // 좌석 해제의 입력이다. 남의 대회 참가자의 userId·닉네임이 그대로 나가면
  // 안 되므로 다른 운영 조작 경로와 같은 문(STORE_ADMIN 전용, 소유권 확인)을
  // 쓴다 — session.service.ts의 getSeatOccupants 주석 참고.
  @Roles(Role.STORE_ADMIN)
  @Get(':id/seats')
  async getSeatOccupants(@Req() req, @Param('id') tournamentId: string) {
    return await this.sessionService.getSeatOccupants(tournamentId, req.user.userId);
  }
}
