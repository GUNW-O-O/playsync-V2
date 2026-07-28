import { Module } from '@nestjs/common';
import { DealerModule } from 'src/dealer/dealer.module';
import { PlaysyncModule } from 'src/playsync/playsync.module';
import { WsGateway } from './ws.gateway';
import { WsTicketController } from './ws-ticket.controller';
import { WsTicketService } from './ws-ticket.service';

/**
 * 게이트웨이와 티켓이 한 모듈에 있는 이유: 티켓 발급과 소비가 같은 경계의
 * 양쪽이다. 발급 형식을 바꾸면 소비도 같이 바뀐다.
 *
 * PlaysyncModule을 여기서 다시 import하는 이유: `WsGateway`가
 * `PlaysyncService`를 직접 주입받는데, PlaysyncModule은 전역이 아니고
 * DealerModule도 그걸 재수출하지 않는다. 예전에는 `WsGateway`가
 * `AppModule`의 providers에 바로 있었고 AppModule이 PlaysyncModule을
 * 직접 import하고 있어서 우연히 풀렸을 뿐이다. 이 모듈로 옮기면서 같은
 * 배선을 명시적으로 다시 만들어야 부팅이 깨지지 않는다.
 * (RedisService·JwtService·EventEmitter2는 각각 `@Global()`이거나
 * `global: true`로 등록돼 있어 여기서 따로 import할 필요가 없다.)
 */
@Module({
  imports: [DealerModule, PlaysyncModule],
  controllers: [WsTicketController],
  providers: [WsGateway, WsTicketService],
})
export class WsModule {}
