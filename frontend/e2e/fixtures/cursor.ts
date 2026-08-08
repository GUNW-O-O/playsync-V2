/**
 * 촬영용 가짜 커서.
 *
 * Playwright는 **커서를 그리지 않는다.** 실제 마우스를 움직이는 것이 아니라
 * CDP 입력 이벤트를 쏘기 때문이고, 헤드리스든 헤디드든 같다. 그래서 지금까지
 * 찍힌 영상에는 클릭이 아예 안 보였다 — 화면이 그냥 갑자기 바뀐다.
 *
 * 이 스크립트를 **제품 코드에 넣지 않는 이유**는 명확하다. 촬영에만 필요한
 * 것이고, 앱에 들어가는 순간 아무도 안 보는 DOM 노드와 리스너가 모든 화면에
 * 상주하게 된다. `addInitScript`로 촬영 컨텍스트에만 꽂는다.
 *
 * 페이지가 넘어가도 살아남는다 — `addInitScript`는 **문서마다** 다시 돈다.
 */
export const CURSOR_SCRIPT = `(() => {
  const ID = '__demo_cursor__';
  if (document.getElementById(ID)) return;

  function mount() {
    if (!document.body || document.getElementById(ID)) return;

    const dot = document.createElement('div');
    dot.id = ID;
    dot.setAttribute('aria-hidden', 'true');
    // 화면 밖에서 시작한다. 첫 mousemove가 오기 전에 (0,0)에 점이 찍혀 있으면
    // 영상 첫 프레임에 왼쪽 위 구석의 점이 남는다.
    //
    // 크기를 28px로 잡는다. 2×2 타일에서 이 화면은 절반 이하로 줄어드는데,
    // 18px 점은 그 크기에서 그냥 안 보였다.
    dot.style.cssText = [
      'position:fixed', 'left:-100px', 'top:-100px',
      'width:28px', 'height:28px', 'margin:-14px 0 0 -14px',
      'border-radius:50%',
      'border:3px solid rgba(255,255,255,0.98)',
      'background:rgba(0,0,0,0.35)',
      'box-shadow:0 0 0 2px rgba(0,0,0,0.55), 0 0 12px rgba(0,0,0,0.5)',
      'pointer-events:none',
      'z-index:2147483647',
      'transition:transform 80ms ease-out, background 80ms ease-out',
    ].join(';');
    document.body.appendChild(dot);

    // 누른 자리에서 퍼지는 파문. **무엇을 눌렀는지**가 프레임에 남는 것은
    // 이쪽이다 — 점이 잠깐 오므라드는 것만으로는 영상에서 알아볼 수 없었고,
    // 실제로 "무슨 조작을 했는지 확인이 안 된다"는 지적이 나왔다.
    const style = document.createElement('style');
    style.textContent =
      '@keyframes __demo_ping__{0%{transform:scale(0.35);opacity:0.9}' +
      '100%{transform:scale(1);opacity:0}}';
    document.head.appendChild(style);

    function ripple(x, y) {
      const ring = document.createElement('div');
      ring.setAttribute('aria-hidden', 'true');
      ring.style.cssText = [
        'position:fixed',
        'left:' + x + 'px', 'top:' + y + 'px',
        'width:92px', 'height:92px', 'margin:-46px 0 0 -46px',
        'border-radius:50%',
        'border:4px solid rgba(80,200,170,0.95)',
        'box-shadow:0 0 18px rgba(80,200,170,0.55)',
        'pointer-events:none',
        'z-index:2147483646',
        'animation:__demo_ping__ 650ms ease-out forwards',
      ].join(';');
      document.body.appendChild(ring);
      setTimeout(() => ring.remove(), 700);
    }

    /*
      **화면이 멈춰 있으면 녹화 시계가 밀린다.**

      Playwright의 녹화는 컴포지터가 프레임을 낼 때만 받아 적는다. 좌석
      태블릿처럼 남의 차례를 기다리며 몇십 초씩 가만히 있는 면은 그 구간에
      프레임이 거의 없고, 그만큼 영상 길이가 실제 흐른 시간과 어긋난다 —
      실측으로 좌석 영상이 11% 늘어나 있었다(딜러·콘솔은 1%). 면을 나란히
      붙이는 촬영에서는 그 차이가 **같은 순간에 다른 장면**으로 나타난다.

      그래서 눈에 안 보이는 점 하나를 100ms마다 다시 칠해 프레임이 계속
      나오게 한다. 알파가 0.02와 0.04라 어느 배경에서도 보이지 않는다.
    */
    const beat = document.createElement('div');
    beat.setAttribute('aria-hidden', 'true');
    beat.style.cssText = [
      'position:fixed', 'left:0', 'bottom:0',
      'width:2px', 'height:2px',
      'pointer-events:none',
      'z-index:2147483645',
    ].join(';');
    document.body.appendChild(beat);
    let on = false;
    setInterval(() => {
      on = !on;
      beat.style.background = on ? 'rgba(128,128,128,0.04)' : 'rgba(128,128,128,0.02)';
    }, 100);

    addEventListener('mousemove', (e) => {
      dot.style.left = e.clientX + 'px';
      dot.style.top = e.clientY + 'px';
    }, { passive: true, capture: true });

    addEventListener('mousedown', (e) => {
      dot.style.transform = 'scale(0.6)';
      dot.style.background = 'rgba(80,200,170,0.9)';
      ripple(e.clientX, e.clientY);
    }, { passive: true, capture: true });

    addEventListener('mouseup', () => {
      dot.style.transform = 'scale(1)';
      dot.style.background = 'rgba(0,0,0,0.35)';
    }, { passive: true, capture: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();`;
