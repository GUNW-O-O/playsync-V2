import { Role } from "@prisma/client";

export interface JwtPayLoad {
  sub: string;
  nickname: string;
  role: Role;
}

export interface DealerToken {
  sub : string;
  tournamentId : string;
  tableId : string;
  role : Role;
}