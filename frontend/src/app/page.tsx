import { redirect } from 'next/navigation';

// 랜딩 페이지는 두지 않는다. 익명 사용자는 미들웨어가 로그인으로 돌려보내지만
// 로그인한 사용자가 /를 열면 404가 되므로 여기서도 로그인으로 보낸다.
// 역할별 홈으로 나누는 것은 이후 계획에서 다룬다.
export default function HomePage() {
  redirect('/login');
}
