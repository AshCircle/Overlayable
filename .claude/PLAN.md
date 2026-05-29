# Overlayable - Image Overlay Chrome Extension

> 이 문서는 Claude(및 개발자)가 본 익스텐션을 구현할 때 참고하는 개발 기준 문서다.

---

## 1. 개요 / 목표

웹 페이지 위에 사용자가 올린 이미지를 오버레이로 띄우고, 자유롭게 변형하면서도
필요할 때는 오버레이를 "투과"시켜 아래 웹 페이지를 그대로 사용할 수 있는 크롬 익스텐션.

### 수용 기준 체크리스트

- 사용자가 이미지를 업로드해 화면에 띄울 수 있다.
- 해당 이미지의 투명도(opacity)를 조절할 수 있다.
- 해당 이미지를 자유롭게 확대/축소(scale)할 수 있다.
- 해당 이미지를 자유롭게 회전(rotate)할 수 있다.
- 키 입력(Ctrl 홀드)으로 "웹 조작 모드 / 이미지 조작 모드"를 전환할 수 있다.
- 웹 조작 모드에서는 이미지 위에 커서를 올려도 클릭이 웹 페이지로 통과된다.

---

## 2. 기술 결정 사항

| 항목 | 결정 | 비고 |
|------|------|------|
| 언어 | **Vanilla JS** + HTML/CSS | 빌드 도구 없음, 의존성 없음 |
| 매니페스트 | **Manifest V3** | `content_scripts` 자동 주입 |
| 컨트롤 UI | **인페이지 플로팅 패널** | 웹 페이지 안에 떠 있는 패널 |
| 모드 전환 | **Ctrl 홀드** | 누르는 동안만 이미지 조작, 놓으면 웹 조작 |
| 빌드/번들 | 없음 | 폴더를 그대로 "압축해제된 확장"으로 로드 |

> 향후 TypeScript/번들러 도입 시 `src/` 모듈 경계를 그대로 유지할 수 있게 분리해 둔다.

---

## 3. 파일 구조

```
Overlayable/
├─ manifest.json          # MV3. content_scripts, action(toggle), permissions
├─ src/
│  ├─ content.js          # 진입점: 오버레이/패널 주입, 모드·키 상태 관리, 이벤트 배선
│  ├─ overlay.js          # 오버레이 이미지 요소 생성 및 상태→DOM 반영
│  ├─ panel.js            # 플로팅 컨트롤 패널 UI 생성 및 이벤트 바인딩
│  ├─ transform.js        # {x,y,scale,rotation} → CSS transform 문자열 직렬화 유틸
│  └─ styles.css          # 오버레이 + 패널 스타일(z-index, pointer-events 규칙)
└─ icons/                 # icon-16.png, icon-48.png, icon-128.png
```

---

## 4. 핵심 컴포넌트 설계

### 4.1 상태 모델 (단일 소스)

오버레이의 모든 변형은 하나의 상태 객체에서 파생된다.

```js
const state = {
  src: null,        // object URL (또는 dataURL)
  x: 0, y: 0,       // translate (px)
  scale: 1,         // 확대/축소 배율
  rotation: 0,      // 회전 (deg)
  opacity: 1,       // 투명도 0~1
  visible: false,   // 오버레이 표시 여부
  mode: 'web',      // 'web' | 'image'
};
```

상태가 바뀔 때마다 `applyState()` 가 호출되어 오버레이 DOM에 반영하고,
패널 컨트롤 값도 동기화한다(양방향 동기화).

### 4.2 오버레이 이미지 (`overlay.js`)

- 최상위 `position: fixed` 컨테이너 + 내부 `<img>`.
- 매우 높은 `z-index` (예: 2147483646)로 페이지 최상위 보장.
- 변형 적용:
  - `transform: translate(x,y) scale(s) rotate(rdeg)` — `transform.js`로 직렬화
  - `opacity: state.opacity`
- 컨테이너의 `pointer-events`는 **모드에 따라 토글**(4.4 참조).

### 4.3 플로팅 컨트롤 패널 (`panel.js`)

웹 페이지 모서리에 고정된 패널. 항상 `pointer-events: auto`.

포함 컨트롤:
- **이미지 업로드**: `<input type="file" accept="image/*">` + 드래그앤드롭 영역
- **투명도 슬라이더**: 0 ~ 100% → `state.opacity`
- **확대/축소**: 슬라이더(예: 10%~500%) + `+ / −` 버튼 → `state.scale`
- **회전**: 슬라이더(-180°~180°) + `±90°` 버튼 → `state.rotation`
- **리셋** 버튼: 변형값 초기화
- **제거** 버튼: 오버레이 제거 및 object URL revoke
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

- **이동**: `mousedown → mousemove → mouseup` 으로 `state.x/y` 갱신(드래그).
- **확대/축소**: `wheel` 이벤트로 `state.scale` 조절(가능하면 커서 위치 기준 줌).
- **회전(옵션)**: `Shift + wheel` 로 `state.rotation` 조절.
- 모든 직접 상호작용은 패널 슬라이더 값과 즉시 동기화.

---

## 5. 구현 순서 (단계별)

각 단계는 독립적으로 로드/검증 가능하도록 진행한다.

1. **부트스트랩**: `manifest.json` + 아이콘 + 빈 `content.js` 로 익스텐션이 로드되는지 확인.
2. **DOM 주입**: 오버레이 컨테이너 + 패널 주입, `styles.css`로 z-index/pointer-events 기본값 적용.
3. **이미지 업로드** (요구사항 1): file input / 드래그앤드롭 → `URL.createObjectURL` → 오버레이 표시.
4. **투명도** (요구사항 2): 슬라이더 ↔ `state.opacity` 연동.
5. **확대/축소** (요구사항 3): 슬라이더 + 휠 → `state.scale`.
6. **회전** (요구사항 4): 슬라이더/버튼 + (옵션) Shift+휠 → `state.rotation`.
7. **드래그 이동**: 이미지 조작 모드에서 드래그로 위치 이동.
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
2. 임의의 웹페이지(예: 뉴스 사이트, 링크가 많은 페이지)에서 다음을 확인:
   - 패널에서 이미지 업로드 → 화면에 표시되는가.
   - 투명도 슬라이더로 반투명/불투명 조절되는가.
   - 확대/축소 슬라이더·휠로 크기 변하는가.
   - 회전 슬라이더/버튼으로 회전되는가.
   - Ctrl을 누르면 이미지 조작(드래그/휠)이 되는가.
   - Ctrl을 놓은 상태에서 **이미지 위의 링크/버튼을 클릭하면 웹 페이지가 동작**하는가.
3. 엣지 케이스: Ctrl 누른 채 탭 전환 후 돌아왔을 때 모드가 정상 복귀하는지, 이미지 재업로드/제거가 깔끔한지.

---

## 8. 참고

- 완료 판정 기준은 **1. 수용 기준 체크리스트**이며, 각 항목은 **7. 검증**으로 확인한다.
- 본 단계의 범위는 위 6개 요구사항. 프리셋 저장, 다중 이미지, 단축키 커스터마이즈 등은 후속 과제로 분리.
