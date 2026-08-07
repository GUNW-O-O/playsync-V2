import LoginForm from './LoginForm';

/**
 * `next`는 미들웨어가 붙인다(`middleware.ts` — 로그인 없이 들어온 경로를
 * 쿼리에 담아 돌려보낸다). 서버 컴포넌트에서 읽어 폼에 넘기는 이유는
 * `useSearchParams`를 쓰면 이 페이지 전체가 Suspense 경계를 요구하기
 * 때문이다.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return <LoginForm next={next} />;
}
