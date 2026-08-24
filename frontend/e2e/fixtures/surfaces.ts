import { BrowserContext, Page, test as base } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { CURSOR_SCRIPT } from './cursor';
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
  /**
   * 전광판. 대회 내내 틀어 둔다.
   *
   * 1920×1080으로 찍지 않는다. 2×2 타일이 960×540이라 어차피 줄어들고, 면
   * 넷이 다 16:9라야 레터박스가 없다. 8GB 기계에서 픽셀이 2.25배인 소스를
   * 하나 더 물고 있을 이유가 없다(명세 §2·§6).
   */
  scoreboard: { viewport: { width: 1280, height: 720 } },
  /** 좌석 태블릿 · 딜러 콘솔. 16:9 고정. */
  tablet: { viewport: { width: 1280, height: 720 } },
  /** 참가자 폰. */
  phone: { viewport: { width: 390, height: 844 } },
} as const;

export type SurfaceName = keyof typeof SURFACES;

/** 면 하나를 연다. `label`이 그대로 영상 파일 이름이 된다. */
export type Stage = (surface: SurfaceName, label: string) => Promise<Page>;

/**
 * 장면 경계에 시각을 박는다. **자르는 것은 ffmpeg다.**
 *
 * 장면 다섯이 한 실행으로 도는 이유는 좌석이 컨텍스트에 매여 있기 때문이고
 * (앉은 자리는 그 태블릿의 쿠키다), 그래서 영상도 장면별로 끊기지 않는다.
 * 잘라 낼 구간을 사람이 눈으로 찾지 않도록 여기서 기록해 둔다.
 */
export type Mark = (name: string) => void;

/**
 * 영상 하나하나의 시계가 **서로 다르다.** 녹화는 컨텍스트를 연 순간부터
 * 시작하므로, 나중에 연 딜러 태블릿의 0초는 먼저 연 폰의 0초보다 늦다.
 * 그래서 면마다 "첫 면이 열린 시각으로부터 몇 ms 뒤에 열렸는지"를 같이
 * 남긴다 — 어떤 면의 어느 지점을 잘라야 하는지는
 * `장면 시각 - 그 면이 열린 시각`으로 나온다.
 */
type Film = {
  dir: string;
  startedAt: number | null;
  /**
   * 면 하나가 열린 시각과 닫힌 시각(촬영 시작 기준).
   *
   * **둘 다 필요하다.** Playwright의 webm은 프레임 간격이 등간격이 아니라
   * 파일 길이가 실제 흐른 시간과 다르다 — 같은 88초를 100.9초로 적어 둔
   * 파일과 74초를 101.5초로 적어 둔 파일이 한 촬영에서 같이 나왔다. 그래서
   * 자르는 쪽이 **파일마다 시계 배율**을 다시 계산해야 하고, 그러려면 이
   * 영상이 실제로 몇 초를 담고 있는지를 알아야 한다.
   */
  surfaces: { label: string; offsetMs: number; slateAtMs: number; closedAtMs?: number }[];
  marks: { name: string; offsetMs: number }[];
};

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
export const test = base.extend<{
  stage: Stage;
  mark: Mark;
  manifest: DemoManifest;
  film: Film;
}>({
  manifest: async ({}, use) => {
    await use(readManifest());
  },

  /**
   * `stage`와 `mark`가 같은 시계를 봐야 하므로 둘의 공통 바닥을 따로 둔다.
   * 테스트가 직접 쓸 일은 없다.
   */
  film: async ({}, use, testInfo) => {
    const dir = join(RECORDINGS_ROOT, slug(testInfo.title));
    mkdirSync(dir, { recursive: true });

    const film: Film = { dir, startedAt: null, surfaces: [], marks: [] };
    await use(film);

    // 면을 하나도 안 연 테스트(회귀 일부)는 남길 것이 없다.
    if (film.startedAt === null) return;
    writeFileSync(
      join(dir, 'timeline.json'),
      JSON.stringify({ startedAt: film.startedAt, surfaces: film.surfaces, marks: film.marks }, null, 2),
      'utf8',
    );
  },

  mark: async ({ film }, use) => {
    const mark: Mark = (name) => {
      // 면이 하나도 안 열렸으면 기준 시각이 없다. 첫 면이 열리는 순간이
      // 0초라, 그 전의 표시는 어느 영상에도 대응하는 지점이 없다.
      if (film.startedAt === null) return;
      const offsetMs = Date.now() - film.startedAt;
      film.marks.push({ name, offsetMs });
      // eslint-disable-next-line no-console
      console.log(`[장면] ${name} · +${(offsetMs / 1000).toFixed(1)}초`);
    };
    await use(mark);
  },

  stage: async ({ browser, film }, use, testInfo) => {
    const dir = film.dir;

    // 커서는 **촬영 프로젝트에만** 꽂는다. 회귀는 사람이 보는 영상이 아니라
    // 판정이고, 없는 DOM 노드를 하나 더 얹으면 그만큼 다른 것을 본다.
    const filming = testInfo.project.name !== 'regression';

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
      if (filming) await context.addInitScript(CURSOR_SCRIPT);
      const page = await context.newPage();
      opened.push({ label, context, page });

      const openedAt = Date.now();
      if (film.startedAt === null) film.startedAt = openedAt;

      /*
        **슬레이트(딱딱이).** 면을 열자마자 화면 전체를 0.15초 동안 자홍색으로
        덮고 그 시각을 적어 둔다. 자르는 쪽은 영상에서 그 색이 나타나는
        프레임을 찾아 "이 프레임이 그 시각"으로 못 박는다.

        시각을 **계산**하지 않고 영상 안에서 **읽는** 것이 요점이다. 컨텍스트를
        연 시각도, `닫힌 시각 − 파일 길이`도 인코더 사정만큼 흔들렸고, 그
        1초가 2×2 타일에서 "누르기도 전에 옆 화면이 먼저 바뀌는" 그림이 됐다.

        자홍색인 이유는 어느 화면에도 없는 색이라서다 — 태블릿은 검고 콘솔은
        희어서 흑백 번쩍임은 한쪽에서 묻힌다. 번쩍임은 첫 장면 표시보다
        앞이라 잘라낸 영상에는 남지 않는다.
      */
      // **여는 순간에 치지 않는다.** 녹화가 실제로 첫 프레임을 쓰기까지 얼마가
      // 걸릴지 모르고(그 지연이 흔들리는 것이 애초의 문제다), 그 전에 친
      // 슬레이트는 영상에 아예 없다 — 실제로 늦게 연 좌석 태블릿 하나가
      // 그렇게 통째로 놓쳤다. 한 박자 기다렸다가 넉넉히 친다.
      await page.waitForTimeout(800);
      const slateAt = Date.now();
      await page.evaluate(async () => {
        const flash = document.createElement('div');
        flash.setAttribute('aria-hidden', 'true');
        flash.style.cssText = [
          'position:fixed', 'inset:0',
          'background:#ff00ff',
          'pointer-events:none',
          'z-index:2147483647',
        ].join(';');
        document.documentElement.appendChild(flash);
        await new Promise((done) => setTimeout(done, 400));
        flash.remove();
      });

      /*
        **녹화는 컨텍스트를 연 순간부터다** — 단, 화면이 계속 그려질 때만
        그렇다. 멈춰 있는 면은 프레임이 안 나와 그 구간이 영상에서 통째로
        빠지고, 그만큼 뒤 내용이 앞으로 당겨진다. 그래서 커서 스크립트가
        보이지 않는 점 하나를 100ms마다 다시 칠한다(`cursor.ts`).

        그 하트비트를 넣기 전에는 면마다 시계가 제각각이었다. 빈 탭으로 열어
        둔 콘솔은 0초가 55초 뒤의 `goto` 시점이었고, 대기가 많은 좌석
        태블릿은 영상이 실제보다 11% 늘어나 있었다. 붙여 놓으면 **같은
        순간에 서로 다른 장면**이 나온다.
      */
      film.surfaces.push({
        label,
        offsetMs: openedAt - film.startedAt,
        slateAtMs: slateAt - film.startedAt,
      });

      return page;
    };

    await use(stage);

    for (const { label, context, page } of opened) {
      const video = page.video();
      // 닫는 순간이 이 영상의 끝이다. 컨텍스트를 하나씩 닫으며 인코딩을
      // 마치므로 면마다 끝나는 시각이 다르다.
      const entry = film.surfaces.find((s) => s.label === label);
      if (entry && film.startedAt !== null) entry.closedAtMs = Date.now() - film.startedAt;
      await context.close();
      if (video) {
        await video.saveAs(join(dir, `${label}.webm`));
        await video.delete();
      }
    }
  },
});

export { expect } from '@playwright/test';
