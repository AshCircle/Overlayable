# Overlayable - Image Overlay Chrome Extension

> 이 문서는 Claude(및 개발자)가 본 익스텐션을 구현할 때 참고하는 개발 기준 문서다.

---

## 1. 개요 / 목표

**geojson.io 전용** 크롬 익스텐션. geojson.io 지도 위에 사용자가 올린 이미지를 오버레이로 띄우고,
지도를 드래그/줌/회전하면 이미지가 지도에 지오-앵커된 것처럼 함께 움직인다. 이미지를 자유롭게
변형하면서도 필요할 때는 오버레이를 "투과"시켜 아래 지도를 그대로 조작할 수 있다.

### 수용 기준 체크리스트

- 사용자가 **여러 장의 이미지를 업로드**해 화면에 겹쳐 띄울 수 있다. (업로드할 때마다 스택에 추가)
- 각 이미지의 투명도(opacity)를 **개별** 조절할 수 있다. (겹친 영역이 투명도로 확인된다)
- 각 이미지를 **개별적으로** 자유롭게 확대/축소(scale)할 수 있다. (사진 모서리·꼭짓점 핸들 드래그 또는 마우스 휠)
- 각 이미지를 **개별적으로** 자유롭게 회전(rotate)할 수 있다. (상단 회전 핸들 드래그 또는 Shift+휠)
- 패널 목록 또는 페이지에서 이미지를 **선택**하면 그 이미지만 테두리·핸들이 활성화된다. (페이지에서 Ctrl 홀드 후 드래그하면 커서 아래 사진이 자동 선택됨)
- 패널 목록에서 각 이미지를 **삭제**할 수 있다.
- 키 입력(Ctrl 홀드)으로 "웹 조작 모드 / 이미지 조작 모드"를 전환할 수 있다.
- 웹 조작 모드에서는 이미지 위에 커서를 올려도 클릭이 웹 페이지로 통과된다.
- **지도 동기화**: geojson.io 지도를 팬/줌(관성 포함)/회전하면 사진이 지도에 고정된 채 매 프레임 함께 이동/확대/회전한다.
- **재앵커**: 사진을 수동 조작(드래그/핸들/휠/슬라이더/리셋)하면 새 위치/크기/각도로 지도에 다시 고정된다.
- **폴백**: 지도를 찾지 못하면 사진은 기존처럼 화면 고정으로 동작한다(기능 저하일 뿐 파손 아님).

---

## 2. 기술 결정 사항

| 항목 | 결정 | 비고 |
|------|------|------|
| 언어 | **Vanilla JS** + HTML/CSS | 빌드 도구 없음, 의존성 없음 |
| 매니페스트 | **Manifest V3** | `content_scripts` 자동 주입, Chrome 111+ |
| 대상 사이트 | **geojson.io 전용** | `matches: https://geojson.io/*` (사용자 결정) |
| 지도 연동 | **MAIN world 브리지 + postMessage** | 콘텐츠 스크립트(ISOLATED)는 페이지 전역 접근 불가 → `world: "MAIN"` 브리지가 지도 인스턴스를 찾아 카메라를 중계 |
| 좌표 모델 | **사진별 지리 앵커 + 메르카토르 재투영** | photo.geo(경위도+앵커 시점 카메라/변형)에서 매 프레임 x/y/scale/rotation 유도 |
| 컨트롤 UI | **인페이지 플로팅 패널** | 웹 페이지 안에 떠 있는 패널 |
| 모드 전환 | **Ctrl 홀드** | 누르는 동안만 이미지 조작, 놓으면 웹(지도) 조작 |
| 빌드/번들 | 없음 | 폴더를 그대로 "압축해제된 확장"으로 로드 |

> 향후 TypeScript/번들러 도입 시 `src/` 모듈 경계를 그대로 유지할 수 있게 분리해 둔다.

---

## 3. 파일 구조

```
Overlayable/
├─ manifest.json          # MV3. geojson.io 전용 content_scripts(ISOLATED + MAIN world), action(toggle)
├─ src/
│  ├─ content.js          # 진입점: 오버레이/패널 주입, 모드·키 상태 관리, 이벤트 배선, 지도 동기화
│  ├─ bridge.js           # MAIN world: 지도 인스턴스 발견 + 카메라 postMessage 중계
│  ├─ geo.js              # 구면 메르카토르 project/unproject (지도 카메라 ↔ 화면 좌표)
│  ├─ overlay.js          # 오버레이 프레임(이미지 + 리사이즈/회전 핸들) 생성 및 상태→DOM 반영
│  ├─ panel.js            # 플로팅 컨트롤 패널 UI 생성 및 이벤트 바인딩(지도 연동 상태 표시)
│  ├─ transform.js        # {x,y,scale,rotation} → CSS transform 문자열 직렬화 유틸
│  └─ styles.css          # 오버레이 + 패널 스타일(z-index, pointer-events 규칙)
└─ icons/                 # icon-16.png, icon-48.png, icon-128.png
```

---

## 4. 핵심 컴포넌트 설계

### 4.1 상태 모델 (단일 소스)

오버레이의 모든 변형은 하나의 상태 객체에서 파생된다.
다중 사진은 `photos[]` 배열 + 선택(`selectedId`)으로 표현하고, 사진별 변형값은 photo 객체가 보유한다.

```js
const state = {
  active: false,    // 패널 표시 여부 (툴바 토글)
  mode: 'web',      // 'web' | 'image' (전역)
  photos: [],       // 사진 배열 (배열 순서 = z-order, 뒤가 위)
  selectedId: null, // 현재 선택된 사진 id
  mapLinked: false, // geojson.io 지도 연동 여부 (브리지 카메라 첫 수신 시 true)
};
// photo: { id, name, src, x, y, scale, rotation, opacity, naturalW, naturalH, geo }
// geo:   null | { lng, lat, zoom, bearing, scale, rotation }
//        — 사진 중심의 지리 앵커 + 앵커 시점 카메라/변형 (4.6 지도 동기화 참고)
```

상태가 바뀔 때마다 `applyState()` 가 호출되어 사진별 프레임 DOM에 반영하고
(`frames` Map 으로 photos 배열과 reconcile), 패널 컨트롤·사진 목록도 동기화한다(양방향 동기화).
패널 슬라이더/리셋/제거는 **선택된 사진**을 대상으로 동작한다.

### 4.2 오버레이 이미지 (`overlay.js`)

- 최상위 `position: fixed` 컨테이너(`createContainer`) 1개 + **사진 1장당 프레임(`createFrame`) 1개**.
  - `content.js` 가 `photos` 배열에 맞춰 프레임을 생성/제거하고(배열 순서대로 append → z-order 결정), `applyFrame(els, photo, opts)` 로 사진별 상태를 반영한다.
- 프레임 구조: 변형(translate/rotate) + 크기(px) 기준 박스. 자식으로 **이미지 + 8개 리사이즈 핸들(꼭짓점 4 + 모서리 4) + 상단 회전 핸들**을 둔다.
  - 핸들은 프레임의 자식이라 회전을 함께 받지만, 프레임에 scale을 걸지 않으므로(크기는 width/height로 표현) 고정 크기를 유지한다.
- 매우 높은 `z-index` (예: 2147483646)로 페이지 최상위 보장. 사진 간 z-order는 배열(append) 순서로 결정(최신이 위).
- 변형 적용:
  - 프레임 `width/height` = `naturalW/H × scale`, `transform: translate(x,y) rotate(rdeg)` — `transform.js`로 직렬화
  - `opacity`는 이미지에만 적용(핸들 가시성에는 영향 없음). 사진마다 개별 opacity → 겹친 영역이 투명도로 비쳐 보인다.
- 컨테이너는 항상 `pointer-events: none`(클릭 통과). 이미지 모드에서는 **모든** 프레임의 이미지가 이벤트를 받아(어느 사진이든 잡아서 선택/이동) 조작 가능하고, **테두리·핸들은 선택된 사진(`imgovl-selected`)에만** 표시된다.

### 4.3 플로팅 컨트롤 패널 (`panel.js`)

웹 페이지 모서리에 고정된 패널. 항상 `pointer-events: auto`.

포함 컨트롤:
- **이미지 업로드**: `<input type="file" accept="image/*" multiple>` + 드래그앤드롭 영역(여러 장 한번에 추가)
- **사진 목록**: 썸네일 + 라벨 + 삭제(×) 버튼. 항목 클릭 → 선택(`selectedId`), × → 해당 사진 삭제·object URL revoke. 최신(위쪽 z-order)이 목록 맨 위.
- 아래 컨트롤은 모두 **선택된 사진** 대상(선택 없으면 비활성):
  - **투명도 슬라이더**: 0 ~ 100% → `photo.opacity`
  - **확대/축소**: 슬라이더(예: 10%~500%) + `+ / −` 버튼 → `photo.scale`
  - **회전**: 슬라이더(-180°~180°) + `±90°` 버튼 → `photo.rotation`
  - **리셋** 버튼: 선택 사진 변형값 초기화
  - **선택 사진 제거** 버튼: 선택 사진 제거 및 object URL revoke
- (옵션) 패널 **접기/펼치기** 토글, 현재 모드 표시 배지

### 4.4 모드 토글 — 가장 중요한 난점 (요구사항 5, 6)

`content.js`에서 Ctrl 키 상태를 추적한다.

- `keydown`(Ctrl) → `state.mode = 'image'`
- `keyup`(Ctrl)  → `state.mode = 'web'`
- 모드 반영:
  - **`web` 모드**: 오버레이 컨테이너 `pointer-events: none`
    → 이미지 위에서도 클릭/스크롤이 아래 웹 페이지로 통과 **(요구사항 6 충족)**
  - **`image` 모드**: 오버레이 컨테이너 `pointer-events: auto`
    → 드래그 이동, 휠 확대/축소, (옵션) Shift+휠 회전 가능
- **stuck 방지**: `window`의 `blur` 이벤트에서 모드를 강제로 `web`으로 초기화
  (Ctrl 누른 채 탭 전환 시 keyup 유실 대비).
- 패널 조작은 모드와 무관하게 항상 가능(패널은 `pointer-events: auto` 유지).

> 키 이벤트는 가능하면 **capture 단계**에서 받아 host 페이지 핸들러와의 충돌을 줄인다.

### 4.5 직접 상호작용 (이미지 조작 모드에서)

직접 상호작용은 **휠뿐 아니라 핸들 드래그**로도 가능해야 한다(요구사항: 사진 모서리·꼭짓점 드래그로 확대/축소/회전).

- **이동**: 이미지 본체를 `mousedown → mousemove → mouseup` 으로 드래그하여 `state.x/y` 갱신.
- **확대/축소**:
  - **핸들 드래그** — 8개 리사이즈 핸들. 드래그 시 반대편을 고정(anchor)하고 비율을 유지하며 `state.scale` 갱신.
    - 꼭짓점(`nw/ne/se/sw`): 두 축 비율 중 큰 값으로 커서를 따라 비율 유지 확대.
    - 좌/우 모서리(`e/w`): 가로 기준, 상/하 모서리(`n/s`): 세로 기준(나머지 축은 비율 추종).
  - **휠** — `wheel` 이벤트로 `state.scale` 조절(보조 수단).
- **회전**:
  - **회전 핸들 드래그** — 상단 회전 핸들을 드래그해 중심 기준 각도로 `state.rotation` 갱신.
  - **Shift + 휠**(옵션) — 보조 수단.
- 회전된 상태에서도 핸들 드래그가 정확하도록 커서 변위를 프레임 로컬 좌표로 역회전(`rotateVec`)해 계산한다.
- 모든 직접 상호작용은 패널 슬라이더 값과 즉시 동기화.

### 4.6 geojson.io 지도 동기화 (`bridge.js` + `geo.js` + `content.js`)

콘텐츠 스크립트는 ISOLATED world 라 페이지의 지도 객체에 접근할 수 없으므로 3계층으로 나눈다.

```
[MAIN world]  bridge.js ── 지도 발견(window.api.map → window.map → React fiber 탐색)
                │  map.on('move'|'resize') + 1초 rect 감시 + ping 응답
                ▼  postMessage { source:'overlayable-bridge', type:'camera',
                                 lng, lat, zoom, bearing, pitch, cx, cy, rect }
[ISOLATED]    content.js ── camera 저장 → rAF 병합 syncFromCamera()
                │            photo.geo 앵커에서 x/y/scale/rotation 유도 → applyFrames()
                ▼
              geo.js (NS.geo) ── 구면 메르카토르 project/unproject 순수 함수
```

- **카메라 페이로드**: `cx/cy` 는 지리적 중심(getCenter)을 화면 px 로 투영한 값(`map.project` 사용).
  지도 컨테이너 rect 중앙 대신 이 값을 피벗으로 쓰므로 mapbox padding 까지 정확하다.
- **좌표 유도** (pitch 0 에서 메르카토르→화면은 닮음변환이므로 정확):
  - `x/y` = `project(geo.lngLat, camera)` − 뷰포트 중앙
  - `scale` = `geo.scale × 2^(camera.zoom − geo.zoom)`
  - `rotation` = `normalizeRotation(geo.rotation − (camera.bearing − geo.bearing))`
  - 유도 경로는 unproject 를 쓰지 않으므로 왕복 누적 드리프트가 없다.
- **재앵커**: 수동 조작(이동/리사이즈/회전/휠/슬라이더/±스텝/리셋/업로드) 직후
  `reanchorPhoto` 가 사진 중심을 `unproject` 해 `photo.geo` 를 갱신한다. `withSelected` 가 패널
  경로의 단일 지점이고, 제스처/휠 경로는 각 mutation 지점 + `endGesture`(관성 흡수)에서 호출.
- **제스처 예외**: 드래그 중인 사진은 `syncFromCamera` 가 건너뛴다(커서 추종 우선).
  지도 관성 글라이드 중에 잡아도 지터 없이 따라오고, 놓는 순간 재앵커된다.
- **성능**: 카메라 경로는 `applyFrames()` 만 호출(멤버십 불변 → reconcile 생략)하고
  패널 sync 는 100ms trailing 스로틀. 카메라 메시지는 rAF 로 프레임당 1회 병합.
- **클램프 정책**: 슬라이더(절대 입력)만 [0.1, 5], 상대 조작(휠/핸들/±스텝)은 하드 한계
  [1e-4, 1e4]. 지도 줌으로 범위를 벗어난 scale 이 수동 조작 시 5 로 스냅되는 것을 막는다.
  렌더는 raw scale 을 쓰되 overlay.js 가 극단 크기(한 변 2^21px 초과)와 화면 밖 사진을 숨긴다.
- **엣지 케이스**: pitch≠0 은 근사(원근 미적용, pitch 0 복귀 시 정확) · antimeridian 은 Δlng
  선(先) wrap 으로 해결 · 창/에디터 분할선 리사이즈는 mapbox `resize` + window `resize` 로 커버.
- **폴백**: 지도를 못 찾으면 경고 1회 후 2초 간격 재탐색을 지속하고, 카메라 미수신 동안
  사진은 화면 고정으로 동작한다(`state.mapLinked` 로 패널에 연동 상태 표시).

---

## 5. 구현 순서 (단계별)

각 단계는 독립적으로 로드/검증 가능하도록 진행한다.

1. **부트스트랩**: `manifest.json` + 아이콘 + 빈 `content.js` 로 익스텐션이 로드되는지 확인.
2. **DOM 주입**: 오버레이 컨테이너 + 패널 주입, `styles.css`로 z-index/pointer-events 기본값 적용.
3. **이미지 업로드** (요구사항 1): file input / 드래그앤드롭 → `URL.createObjectURL` → 오버레이 표시.
4. **투명도** (요구사항 2): 슬라이더 ↔ `state.opacity` 연동.
5. **확대/축소** (요구사항 3): 슬라이더 + 휠 + **모서리·꼭짓점 핸들 드래그** → `state.scale`.
6. **회전** (요구사항 4): 슬라이더/버튼 + (옵션) Shift+휠 + **회전 핸들 드래그** → `state.rotation`.
7. **드래그 이동**: 이미지 조작 모드에서 이미지 본체 드래그로 위치 이동.
8. **모드 전환** (요구사항 5, 6): Ctrl 홀드 → `pointer-events` 토글 → 클릭 통과 검증.
9. **마무리**: 리셋/제거, object URL revoke, 패널 접기, 엣지 케이스(blur, 다중 탭) 처리.

---

## 6. 기술적 주의점

- **host 페이지 CSS 충돌 방지**: 패널/오버레이 요소에 고유 prefix 클래스(예: `imgovl-`) 사용.
  필요 시 핵심 스타일에 `!important`, 또는 **Shadow DOM**으로 격리.
  - 트레이드오프: Shadow DOM은 스타일 격리가 강력하나 구현/이벤트 처리가 다소 복잡 → 1차 구현은 prefix+`!important`, 충돌 발생 시 Shadow DOM 전환 고려.
- **z-index**: 페이지 최상위 보장(2147483646 등). 단, `web` 모드에서는 클릭이 통과되어야 함.
- **메모리 관리**: 이미지 교체/제거 시 이전 `objectURL`을 `URL.revokeObjectURL`로 해제.
- **키 충돌**: Ctrl/Shift 조합이 host 페이지나 브라우저 단축키와 충돌할 수 있음 → capture 단계 처리 및 필요한 경우만 `preventDefault`.
- **다중 탭/SPA**: content script는 탭마다 독립 동작. SPA 라우팅으로 DOM이 갈아끼워져도 오버레이가 유지되는지 확인.

---

## 7. 수동 검증 방법

1. `chrome://extensions` → **개발자 모드** 켜기 → **"압축해제된 확장 프로그램 로드"** 로 프로젝트 폴더 선택.
   - **manifest.json 이 바뀐 업데이트는 확장 카드의 ↻(새로고침) 필수** — 탭 새로고침은 스크립트 파일
     내용만 다시 읽고 manifest(주입 목록/MAIN world 엔트리)는 갱신하지 않는다. 카드의 버전 숫자가
     저장소의 `manifest.json` 버전과 같은지로 반영 여부를 확인한다.
   - geojson.io 탭 새로고침 후 콘솔에서 `[Overlayable] 브리지 로드됨` → `지도 연동 성공 (경로: react-fiber)`
     로그를 확인한다. 로그가 전무하면 확장 리로드 누락, "로드됨"만 있고 10초 후 경고가 뜨면 지도 탐색 실패.
2. <https://geojson.io> 에서 기본 기능 확인:
   - 접속만으로 패널에 **"지도 연동됨"** 이 표시되는가(핑 경로), 콘솔 에러가 없는가.
   - 패널에서 이미지 업로드 → 화면에 표시되는가. 투명도/확대축소/회전 슬라이더가 동작하는가.
   - **이미지 모서리·꼭짓점 핸들 드래그** 확대/축소(반대편 고정, 비율 유지), **회전 핸들 드래그** 회전이 되는가.
   - 조작 키(⌘/Ctrl)를 누르면 이미지 조작, 놓으면 **사진 위에서도 지도 조작이 통과**되는가.
3. 지도 동기화 확인 (사진 투명도를 ~50% 로 두고 지형지물에 맞춰서):
   - 지도 드래그(천천히/빠르게+관성 글라이드), 휠 줌(커서 위치 다양하게), 더블클릭 줌, 우클릭 회전
     → 사진이 매 프레임 1:1 로 따라오고 끝에서 점프하지 않는가.
   - 사진을 수동 조작(드래그/핸들/휠/슬라이더/리셋) 후 지도를 움직이면 **새 위치에 재고정**되는가.
   - 지도 플링 관성 중에 사진을 잡아도 지터 없이 커서를 따라오고, 놓은 자리에 앵커되는가.
   - scale 이 500% 를 넘은 상태에서 사진 휠 줌이 5 로 스냅되지 않고 이어지는가.
   - 에디터 분할선 드래그/창 리사이즈/브라우저 페이지 줌 후에도 사진이 지도에 붙어 있는가.
   - 극단 줌인 시 사진이 숨겨졌다가 줌아웃하면 제자리에 다시 나타나는가. 경도 ±180(피지 부근) 횡단 시 점프가 없는가.
4. 엣지 케이스: 조작 키 누른 채 탭 전환 후 복귀 시 모드 정상, 이미지 재업로드/제거 정상,
   지도 미발견 시(개편 등) 경고 1회 후 화면 고정 동작 + "지도 감지 대기 중" 표시.

---

## 8. 참고

- 완료 판정 기준은 **1. 수용 기준 체크리스트**이며, 각 항목은 **7. 검증**으로 확인한다.
- 다중 이미지(겹쳐 띄우기, 개별 변형, 선택, 삭제)와 geojson.io 지도 동기화(4.6)는 본 문서에 반영 완료.
- 프로덕션 geojson.io(2026-07 번들 실측)는 React 18 SPA 로 `window.api` 전역이 없다. 브리지는 fiber
  탐색 경로로 지도를 발견한다(지도 래퍼가 `this.map` 에 실제 지도를 보관하고 컴포넌트 useRef 와
  Context 양쪽에 저장됨을 확인). 사이트 재배포로 탐색이 실패하면 10초 후 콘솔 경고가 뜨므로 그때 재조사한다.
- 프리셋 저장(chrome.storage), z-order 재정렬 UI, 단축키 커스터마이즈, pitch 원근 대응(4점 투영 →
  matrix3d), 패널 위치 이동(geojson.io 에디터 겹침 회피)은 후속 과제로 분리.
