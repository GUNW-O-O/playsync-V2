import '@testing-library/jest-dom/vitest';

// 테스트 환경에서는 상대 경로 fetch가 불가능하다. 오리진을 고정해 두고
// apiUrl()이 이 값을 앞에 붙인다.
process.env.NEXT_PUBLIC_API_BASE = 'http://localhost:3000';
