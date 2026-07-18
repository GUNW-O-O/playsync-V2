/**
 * 이 패키지는 경계 검증 로직을 담으므로 자체 테스트를 가진다.
 * 인프라가 없는 순수 스키마 검증이라 단위 테스트 계층에 속한다.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\.spec\.ts$',
};
