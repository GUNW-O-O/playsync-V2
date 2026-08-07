import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  /**
   * 개발 서버가 화면 왼쪽 아래에 띄우는 동그란 배지를 끈다.
   *
   * 촬영과 e2e가 **개발 서버에 붙기 때문**이다(`playwright.config.ts`의
   * `webServer`). 배지는 폰 하단 탭 위에 겹쳐 앉아서 스크린샷과 영상마다
   * 대회 탭을 반쯤 가린다. 프로덕션 빌드에는 원래 없는 것이라, 끄는 쪽이
   * 실제 화면에 가깝다.
   */
  devIndicators: false,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:3001/:path*',
      },
    ];
  },
};

export default nextConfig;
