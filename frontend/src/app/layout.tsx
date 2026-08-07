import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans_KR } from 'next/font/google';
import './globals.css';

/**
 * Carbon의 서체는 IBM Plex다(`DESIGN.md` — "IBM Plex Sans carries the entire
 * type hierarchy"). 한글판(`IBM Plex Sans KR`)을 쓰는 이유는 라틴판에 한글이
 * 없어서다 — 화면 글자의 대부분이 한글이라, 라틴판만 실으면 정작 보이는
 * 글자는 전부 대체 서체로 떨어진다. 한글판은 같은 설계의 라틴 글립도 함께
 * 갖고 있어 숫자와 한글이 한 서체 안에서 맞는다.
 *
 * 무게 셋은 `DESIGN.md`의 스케일이 실제로 쓰는 것 그대로다 — 300(디스플레이),
 * 400(본문), 600(강조). 더 싣지 않는다. 폰 회선에서 쓰지 않는 무게 하나가
 * 곧 낭비다.
 */
const plexSans = IBM_Plex_Sans_KR({
  variable: '--font-plex-sans',
  // `korean`을 못 적는다 — next/font의 폰트 목록이 이 가족의 subset을
  // latin / latin-ext로만 갖고 있다. 그래도 한글은 실린다: `subsets`는
  // **preload할 슬라이스를 고르는 데만** 쓰이고, Google에 보내는 URL에는
  // subset 인자가 붙지 않아 CSS의 unicode-range 조각이 전부 받아진다
  // (`@next/font/dist/google/loader.js` — `preload ? subsets : undefined`).
  // 결과적으로 한글 조각은 필요할 때 받는다. CJK에서는 그게 정상이다.
  subsets: ['latin'],
  weight: ['300', '400', '600'],
  display: 'swap',
});

/**
 * 모노는 **참가 OTP 한 곳**에만 쓴다.
 *
 * `DESIGN.md`는 "no mono on marketing surfaces — Plex Mono lives in product
 * surfaces only"라고 적는다. 여기는 제품 화면이고, OTP는 사람이 태블릿
 * 키패드에 그대로 옮겨 치는 값이다. 자릿수마다 폭이 같아야 눈이 자리를
 * 잃지 않는다.
 */
const plexMono = IBM_Plex_Mono({
  variable: '--font-plex-mono',
  subsets: ['latin'],
  weight: ['300', '400'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Playsync',
  description: '오프라인 홀덤 토너먼트 운영',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // `lang`은 ko다. 한글 문서를 en으로 선언하면 스크린리더가 영어 음성으로
  // 읽고, 브라우저가 줄바꿈 규칙도 라틴 것으로 고른다.
  return (
    <html lang="ko">
      <body className={`${plexSans.variable} ${plexMono.variable} antialiased`}>{children}</body>
    </html>
  );
}
