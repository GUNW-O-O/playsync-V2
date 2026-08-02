import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * 시드가 리포 루트에 떨어뜨린 데모 무대의 좌표(`backend/prisma/seed.ts`).
 *
 * 촬영 스크립트는 대회를 **이름이 아니라 id로** 가리킨다. 이름으로 찾으려면
 * 목록 화면이 먼저 있어야 하는데, 그러면 아직 만들지 않은 화면 하나가
 * 모든 장면의 선행 조건이 된다.
 */
export type DemoManifest = {
  seededAt: string;
  password: string;
  store: { id: string; name: string };
  tournament: {
    id: string;
    name: string;
    entryFee: number;
    startStack: number;
    rebuyUntil: number;
    blindStructure: { lv: number; sb: number; ante: boolean; duration: number }[];
  };
  /** 해시로만 저장된다. 시드 실행 시점 말고는 여기서만 볼 수 있다. */
  dealerOtp: string;
  tables: { id: string; tableOrder: number }[];
  /** 결제까지 마친 참가자. `playerOtp`는 설계상 평문으로 남는다. */
  players: { nickname: string; otp: string }[];
  /** 폰 흐름(참가 → OTP 수령)을 찍기 위해 결제하지 않은 계정. */
  unpaidPlayer: string;
};

const MANIFEST_PATH = resolve(__dirname, '../../../.demo-seed.json');

/**
 * 없으면 **거기서 멈춘다.** 무대가 없는 채로 진행하면 첫 실패가 로그인 실패나
 * 404로 나타나서, 원인이 "시드를 안 돌렸다"라는 사실이 두세 겹 아래 묻힌다.
 */
export function readManifest(): DemoManifest {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(
      [
        `데모 시드 매니페스트가 없다: ${MANIFEST_PATH}`,
        '',
        '  cd backend && docker compose up -d      (인프라 + 마이그레이션 + 시드)',
        '  또는 호스트에서 npm run seed -w backend',
        '',
        '시드는 DB를 지우고 다시 만든다. 개발 DB의 기존 데이터가 사라진다.',
      ].join('\n'),
    );
  }
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as DemoManifest;
}

/** 테이블 번호(1-based)로 고른다. 시드가 만든 것은 1번과 2번 둘이다. */
export function tableByOrder(manifest: DemoManifest, tableOrder: number) {
  const table = manifest.tables.find((t) => t.tableOrder === tableOrder);
  if (!table) {
    const had = manifest.tables.map((t) => t.tableOrder).join(', ');
    throw new Error(`${tableOrder}번 테이블이 시드에 없다. 있는 것: ${had}`);
  }
  return table;
}

/** 닉네임으로 참가자를 고른다. 참가 OTP가 태블릿 입장에 그대로 들어간다. */
export function playerByNickname(manifest: DemoManifest, nickname: string) {
  const player = manifest.players.find((p) => p.nickname === nickname);
  if (!player) {
    const had = manifest.players.map((p) => p.nickname).join(', ');
    throw new Error(`참가자 ${nickname}이 시드에 없다. 있는 것: ${had}`);
  }
  return player;
}
