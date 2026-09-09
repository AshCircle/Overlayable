// transform.js — 상태 객체 {x, y, scale, rotation} 를 CSS transform 문자열로 직렬화.
// 콘텐츠 스크립트들은 같은 isolated world 스코프를 공유하므로, 공유 네임스페이스에 붙인다.
// 이 파일은 manifest content_scripts.js 배열에서 가장 먼저 로드된다.
(function () {
  'use strict';

  const NS = (window.__OVERLAYABLE__ = window.__OVERLAYABLE__ || {});

  // 변형값 제한 범위 (패널 슬라이더 범위와 일치시킨다).
  const SCALE_MIN = 0.1;
  const SCALE_MAX = 5;
  // 지도 줌 동기화로 scale 이 슬라이더 범위를 크게 벗어날 수 있으므로,
  // 상대 조작(휠/리사이즈/±스텝)은 슬라이더 범위로 스냅시키지 않고 하드 한계로만 제한한다.
  const SCALE_HARD_MIN = 1e-4;
  const SCALE_HARD_MAX = 1e4;
  const ROTATION_MIN = -180;
  const ROTATION_MAX = 180;
  // 핸들로 너무 작게 줄여 잡을 수 없게 되는 것을 막는 최소 변(px).
  const MIN_PX = 24;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function clampScale(scale) {
    return clamp(scale, SCALE_MIN, SCALE_MAX);
  }

  function clampScaleHard(scale) {
    return clamp(scale, SCALE_HARD_MIN, SCALE_HARD_MAX);
  }

  function clampRotation(rotation) {
    return clamp(rotation, ROTATION_MIN, ROTATION_MAX);
  }

  // 회전 핸들용: 임의 각도를 (-180, 180] 범위로 래핑(자유 회전 후 슬라이더 범위 유지).
  function normalizeRotation(rotation) {
    let d = rotation % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return d;
  }

  function degToRad(deg) {
    return (deg * Math.PI) / 180;
  }

  // 벡터 (x, y)에 회전행렬 R(deg)를 적용. 화면 y는 아래 방향이라 양수 deg가 시계방향(CSS rotate와 일치).
  // R(θ)·(x,y) = (x·cosθ − y·sinθ, x·sinθ + y·cosθ). 역회전은 deg에 음수를 넣는다.
  function rotateVec(x, y, deg) {
    const r = degToRad(deg);
    const c = Math.cos(r);
    const s = Math.sin(r);
    return { x: x * c - y * s, y: x * s + y * c };
  }

  // 숫자를 보기 좋게 자른다 (불필요한 소수점/부동소수 오차 방지).
  function round(value, digits) {
    const f = 10 ** digits;
    return Math.round(value * f) / f;
  }

  // {x, y, rotation} → "translate(-50%,-50%) translate(Xpx,Ypx) rotate(Rdeg)"
  // scale 은 frame 의 width/height(px)로 적용하므로 transform 에는 넣지 않는다
  // (그래야 frame 자식인 핸들이 함께 확대되지 않고 고정 크기를 유지한다).
  // -50% 베이스로 frame 을 뷰포트 중앙(top/left: 50%) 기준에 두므로,
  // x=y=0 이면 정확히 화면 중앙에 위치한다.
  function toTransform(state) {
    const x = round(state.x || 0, 2);
    const y = round(state.y || 0, 2);
    const rotation = round(state.rotation || 0, 2);
    return (
      'translate(-50%, -50%) ' +
      `translate(${x}px, ${y}px) ` +
      `rotate(${rotation}deg)`
    );
  }

  function sharedImageTransform(image) {
    const stable = { ...image };
    // Screen transforms are derived from each viewer's camera for anchored images.
    if (Number.isFinite(stable.geo?.lat) && Number.isFinite(stable.geo?.lng)) {
      delete stable.x; delete stable.y; delete stable.scale; delete stable.rotation;
    }
    return stable;
  }

  NS.transform = {
    sharedImageTransform,
    SCALE_MIN,
    SCALE_MAX,
    SCALE_HARD_MIN,
    SCALE_HARD_MAX,
    ROTATION_MIN,
    ROTATION_MAX,
    MIN_PX,
    clamp,
    clampScale,
    clampScaleHard,
    clampRotation,
    normalizeRotation,
    degToRad,
    rotateVec,
    round,
    toTransform,
  };
})();
