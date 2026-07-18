import { ApolloClient, InMemoryCache, HttpLink } from '@apollo/client';

const httpLink = new HttpLink({
  uri: process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:3001/graphql',
});

export const client = new ApolloClient({
  link: httpLink,
  cache: new InMemoryCache(),
  // 클라이언트 측에서 쿠키를 포함해 보낼 수 있도록 설정
  defaultOptions: {
    watchQuery: { fetchPolicy: 'cache-and-network' },
  },
});