// geo.js — 구면 메르카토르 투영(project/unproject) 순수 함수. 지도 카메라 ↔ 화면 좌표 변환.
// camera: { lng, lat, zoom, bearing, cx, cy }
//  - lng/lat/zoom/bearing: bridge.js 가 중계하는 Mapbox GL 카메라 상태
//  - cx/cy: 지리적 중심(getCenter)을 화면(클라이언트) px 로 투영한 지점.
//    지도 컨테이너 rect 의 중앙 대신 이 값을 피벗으로 쓰므로 mapbox 의 padding 까지 정확하다.
// pitch=0 에서 메르카토르 → 화면 변환은 닮음변환(균일 스케일 512·2^zoom + 회전 −bearing + 평행이동)
// 이므로, 중심점 투영 + 2^Δzoom 스케일 + Δbearing 회전만으로 사진이 지도와 1:1 로 맞는다.
// (pitch≠0 은 원근이 개입해 근사가 된다 — content.js 는 pitch 를 무시하고 중심 앵커를 유지한다)
// 로드 순서: transform.js 다음, overlay.js 이전.
(function () {
  'use strict';

  const NS = (window.__OVERLAYABLE__ = window.__OVERLAYABLE__ || {});
  const T = NS.transform;

  // mapbox-gl 의 월드 좌표 기준 타일 크기. 월드 폭 = 512 · 2^zoom (px).
  const TILE_SIZE = 512;
  // tan(π/2) 발산 방지용 위도 한계 (메르카토르 유효 범위 ±85.05° 보다 넉넉히 바깥).
  const MAX_LAT = 89.9999;

  function worldSize(zoom) {
    return TILE_SIZE * Math.pow(2, zoom);
  }

  // 위도(도) → 정규화 메르카토르 Y (0=북단, 0.5=적도, 1=남단; 화면과 같은 y-아래 방향).
  function mercY(lat) {
    const clamped = T.clamp(lat, -MAX_LAT, MAX_LAT);
    return 0.5 - Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) / (2 * Math.PI);
  }

  // mercY 의 역함수. atan(exp(...)) 는 점근적이라 ±90 을 넘지 않아 왕복이 안정적이다.
  function latFromMercY(yn) {
    return ((2 * Math.atan(Math.exp(Math.PI - 2 * Math.PI * yn)) - Math.PI / 2) * 180) / Math.PI;
  }

  // Δ경도를 (-180, 180] 로 래핑 — antimeridian(±180) 횡단 시 월드 폭만큼 점프하는 것을 막는다.
  // normalizeRotation 이 정확히 같은 래핑이므로 재사용한다.
  const wrapDeg = T.normalizeRotation;

  // 지리 좌표 → 화면(클라이언트) px. 화면 오프셋 = R(−bearing)·월드Δ (bearing: 북쪽 기준 시계방향).
  function project(lngLat, cam) {
    const w = worldSize(cam.zoom);
    const dx = (wrapDeg(lngLat.lng - cam.lng) / 360) * w;
    const dy = (mercY(lngLat.lat) - mercY(cam.lat)) * w;
    const r = T.rotateVec(dx, dy, -cam.bearing);
    return { x: cam.cx + r.x, y: cam.cy + r.y };
  }

  // 화면(클라이언트) px → 지리 좌표. project 의 역변환(+bearing 으로 역회전).
  function unproject(pt, cam) {
    const w = worldSize(cam.zoom);
    const r = T.rotateVec(pt.x - cam.cx, pt.y - cam.cy, cam.bearing);
    return {
      lng: wrapDeg(cam.lng + (r.x / w) * 360),
      lat: latFromMercY(mercY(cam.lat) + r.y / w),
    };
  }

  NS.geo = { project, unproject };
})();
