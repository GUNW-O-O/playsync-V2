import { BrowserContext, Page, test as base } from '@playwright/test';
import { mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { DemoManifest, readManifest } from './manifest';

/**
 * 면 넷. 크기가 곧 설계다 — `frontend/wireframes/`가 정한 것과 같은 값이다.
 *
 * 뷰포트를 면마다 따로 두는 이유는 화면들이 서로 다른 거리에서 읽히기
 * 때문이다. 전광판은 10m 밖에서, 태블릿은 팔 길이에서, 폰은 손 안에서 읽힌다.
 * 하나의 크기로 찍으면 그 차이가 영상에서 사라진다.
 *
 * 태블릿이 1280x720인 것은 16:9라서다. 좌석 태블릿과 딜러 콘솔은 스크롤이
 * 없는 화면이라, 세로가 모자라면 그 자리에서 설계가 틀렸다는 뜻이 된다.
 */
export const SURFACES = {
  /** 상점 콘솔. 데스크톱 브라우저. */
  console: { viewport: { width: 1440, height: 900 } },
  /** 전광판. 대회 내내 틀어 둔다. */
  scoreboard: { viewport: { width: 1920, height: 1080 } },
  /** 좌석 태블릿 · 딜러 콘솔. 16:9 고정. */
  tablet: { viewport: { width: 1280, height: 720 } },
  /** 참가자 폰. */
  phone: { viewport: { width: 390, height: 844 } },
} as const;

export type SurfaceName = keyof typeof SURFACES;

/** 면 하나를 연다. `label`이 그대로 영상 파일 이름이 된다. */
export type Stage = (surface: SurfaceName, label: string) => Promise<Page>;

const RECORDINGS_ROOT = resolve(__dirname, '../recordings');

/** 영상이 들어갈 폴더 이름. 테스트 제목이 한국어라 문자류만 남긴다. */
export function slug(title: string) {
  return title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
}

/**
 * `stage`와 `manifest`를 얹은 test.
 *
 * 영상은 컨텍스트를 닫아야 파일로 떨어진다(Playwright가 닫는 시점에 인코딩을
 * 마친다). 그래서 열어 둔 것을 전부 기억했다가 뒷정리에서 닫고, 그제서야
 * `label`이 붙은 이름으로 옮긴다 — 기본 이름은 무작위 해시라 넷을 나란히
 * 놓으면 어느 것이 폰인지 알 수 없다.
 */
export const test = base.extend<{ stage: Stage; manifest: DemoManifest }>({
  manifest: async ({}, use) => {
    await use(readManifest());
  },

  stage: async ({ browser }, use, testInfo) => {
    const dir = join(RECORDINGS_ROOT, slug(testInfo.title));
    mkdirSync(dir, { recursive: true });

    const opened: { label: string; context: BrowserContext; page: Page }[] = [];

    const stage: Stage = async (surface, label) => {
      if (opened.some((o) => o.label === label)) {
        throw new Error(`이미 연 면과 이름이 같다: ${label}. 영상 파일이 덮어써진다.`);
      }
      const { viewport } = SURFACES[surface];
      const context = await browser.newContext({
        viewport,
        // 영상 크기를 뷰포트에 맞춘다. 기본값은 800x450으로 줄여 버려서
        // 전광판의 큰 숫자가 뭉갠 채로 남는다.
        recordVideo: { dir, size: viewport },
      });
      const page = await context.newPage();
      opened.push({ label, context, page });
      return page;
    };

    await use(stage);

    for (const { label, context, page } of opened) {
      const video = page.video();
      await context.close();
      if (video) {
        await video.saveAs(join(dir, `${label}.webm`));
        await video.delete();
      }
    }
  },
});

export { expect } from '@playwright/test';
