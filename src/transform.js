// transform.js — 상태 객체 {x, y, scale, rotation} 를 CSS transform 문자열로 직렬화.
// 콘텐츠 스크립트들은 같은 isolated world 스코프를 공유하므로, 공유 네임스페이스에 붙인다.
// 이 파일은 manifest content_scripts.js 배열에서 가장 먼저 로드된다.
(function () {
  'use strict';

  const NS = (window.__OVERLAYABLE__ = window.__OVERLAYABLE__ || {});

  // 변형값 제한 범위 (패널 슬라이더 범위와 일치시킨다).
  const SCALE_MIN = 0.1;
  const SCALE_MAX = 5;
  const ROTATION_MIN = -180;
  const ROTATION_MAX = 180;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function clampScale(scale) {
    return clamp(scale, SCALE_MIN, SCALE_MAX);
  }

  function clampRotation(rotation) {
    return clamp(rotation, ROTATION_MIN, ROTATION_MAX);
  }

  // 숫자를 보기 좋게 자른다 (불필요한 소수점/부동소수 오차 방지).
  function round(value, digits) {
    const f = 10 ** digits;
    return Math.round(value * f) / f;
  }

  // {x, y, scale, rotation} → "translate(-50%,-50%) translate(Xpx,Ypx) scale(S) rotate(Rdeg)"
  // -50% 베이스로 이미지를 뷰포트 중앙(top/left: 50%) 기준에 두므로,
  // x=y=0 이면 정확히 화면 중앙에 위치한다.
  function toTransform(state) {
    const x = round(state.x || 0, 2);
    const y = round(state.y || 0, 2);
    const scale = round(clampScale(state.scale ?? 1), 4);
    const rotation = round(clampRotation(state.rotation || 0), 2);
    return (
      'translate(-50%, -50%) ' +
      `translate(${x}px, ${y}px) ` +
      `scale(${scale}) ` +
      `rotate(${rotation}deg)`
    );
  }

  NS.transform = {
    SCALE_MIN,
    SCALE_MAX,
    ROTATION_MIN,
    ROTATION_MAX,
    clamp,
    clampScale,
    clampRotation,
    round,
    toTransform,
  };
})();
