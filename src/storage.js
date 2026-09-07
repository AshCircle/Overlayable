// storage.js — 오버레이 상태의 영속화(chrome.storage.local)와 파일 export/import 를 담당한다.
// 이미지는 base64 data URL(photo.src) 그대로 직렬화하므로 런타임/저장/파일이 같은 표현을 쓴다.
// 위치의 진짜 소스는 photo.geo(위경도 앵커)라 x/y 는 파생값이지만, 지도 미연동(geo=null) 시의
// fallback 을 위해 x/y 도 함께 저장한다(geo 가 있으면 카메라 동기화가 덮어쓴다).
// 로드 순서: panel.js 다음, content.js 이전.
(function () {
  'use strict';

  const NS = (window.__OVERLAYABLE__ = window.__OVERLAYABLE__ || {});

  const STORAGE_KEY = 'overlayable_state';
  const SCHEMA_VERSION = 1;

  // 한 장의 사진에서 직렬화 대상 필드만 추린다(id/uid 포함 여부는 호출부가 결정).
  function pickPhoto(p, { withId }) {
    const rec = {
      uid: p.uid,
      remoteId: p.remoteId,
      name: p.name,
      src: p.src, // base64 data URL
      scale: p.scale,
      rotation: p.rotation,
      opacity: p.opacity,
      x: p.x,
      y: p.y,
      naturalW: p.naturalW,
      naturalH: p.naturalH,
      geo: p.geo, // null | { lng, lat, zoom, bearing, scale, rotation }
    };
    if (withId) rec.id = p.id;
    return rec;
  }

  // src(base64 data URL)를 가진 사진만 저장/내보내기 대상으로 삼는다
  // (업로드 직후 FileReader 완료 전에는 src 가 비어 있을 수 있다).
  function storablePhotos(state) {
    return (state.photos || []).filter((p) => typeof p.src === 'string' && p.src.startsWith('data:'));
  }

  // ---- chrome.storage.local 영속화 ----

  // state → 저장 페이로드(런타임 id/nextId/selectedId/active 포함).
  function serialize(state) {
    return {
      version: SCHEMA_VERSION,
      nextId: state.nextId,
      selectedId: state.selectedId,
      active: state.active,
      photos: storablePhotos(state).map((p) => pickPhoto(p, { withId: true })),
    };
  }

  // 디바운스 저장. chrome.storage.local.set 은 Promise 를 반환한다(MV3).
  function save(state) {
    return chrome.storage.local
      .set({ [STORAGE_KEY]: serialize(state) })
      .catch((err) => {
        // 쿼터 초과 등 저장 실패는 조작을 막지 않도록 로그만 남긴다.
        console.warn('[Overlayable] 상태 저장 실패:', err);
      });
  }

  // 저장된 상태를 읽는다. 없거나 손상되면 null.
  async function load() {
    try {
      const got = await chrome.storage.local.get(STORAGE_KEY);
      const saved = got && got[STORAGE_KEY];
      if (!saved || !Array.isArray(saved.photos)) return null;
      return saved;
    } catch (err) {
      console.warn('[Overlayable] 상태 로드 실패:', err);
      return null;
    }
  }

  // ---- 파일 export / import ----

  // 현재 상태를 공유용 JSON Blob 으로. 런타임 id 는 제외하고 uid 로 정체성을 유지한다
  // (import 시 새 id 를 부여하고 uid 로 중복만 거른다).
  function toExportBlob(state) {
    const payload = {
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      photos: storablePhotos(state).map((p) => pickPhoto(p, { withId: false })),
    };
    return new Blob([JSON.stringify(payload)], { type: 'application/json' });
  }

  // import 파일 텍스트 → 검증된 photo 레코드 배열(런타임 id 없음). 실패 시 throw.
  function parseImport(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('JSON 파싱에 실패했습니다.');
    }
    if (!data || !Array.isArray(data.photos)) {
      throw new Error('올바른 Overlayable 파일이 아닙니다(photos 배열 없음).');
    }
    const out = [];
    for (const p of data.photos) {
      // 최소 유효성: 이미지 데이터가 있어야 한다.
      if (!p || typeof p.src !== 'string' || !p.src.startsWith('data:')) continue;
      out.push({
        uid: typeof p.uid === 'string' ? p.uid : undefined,
        name: typeof p.name === 'string' ? p.name : '이미지',
        src: p.src,
        scale: Number.isFinite(p.scale) ? p.scale : 1,
        rotation: Number.isFinite(p.rotation) ? p.rotation : 0,
        opacity: Number.isFinite(p.opacity) ? p.opacity : 1,
        x: Number.isFinite(p.x) ? p.x : 0,
        y: Number.isFinite(p.y) ? p.y : 0,
        naturalW: Number.isFinite(p.naturalW) ? p.naturalW : 0,
        naturalH: Number.isFinite(p.naturalH) ? p.naturalH : 0,
        geo: isValidGeo(p.geo) ? p.geo : null,
      });
    }
    if (!out.length) throw new Error('가져올 수 있는 이미지가 없습니다.');
    return out;
  }

  function isValidGeo(g) {
    return (
      g &&
      Number.isFinite(g.lng) &&
      Number.isFinite(g.lat) &&
      Number.isFinite(g.zoom) &&
      Number.isFinite(g.bearing) &&
      Number.isFinite(g.scale) &&
      Number.isFinite(g.rotation)
    );
  }

  NS.storage = { STORAGE_KEY, serialize, save, load, toExportBlob, parseImport };
})();
