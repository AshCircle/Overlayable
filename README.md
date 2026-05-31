# Overlayable

웹 페이지 위에 이미지를 오버레이로 띄우고 자유롭게 변형하면서도, 필요할 때는 오버레이를 "투과"시켜 아래 웹 페이지를 그대로 사용할 수 있는 Manifest V3 크롬 익스텐션. 빌드 도구·의존성 없이 Vanilla JS로 작성되었습니다.

## 설치 (압축해제된 확장 로드)

1. Chrome 주소창에 `chrome://extensions` 입력
2. 우측 상단 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램 로드** 클릭 → 이 프로젝트 폴더(`Overlayable/`) 선택

> `file://` 로컬 HTML에서도 쓰려면 확장 상세 페이지에서 **파일 URL에 대한 액세스 허용**을 켜세요.

## 사용법

- **패널 열기/닫기**: 툴바의 Overlayable 아이콘 클릭 (기본은 숨김 상태)
- **이미지 올리기**: 패널의 드롭존을 클릭해 선택하거나 이미지를 끌어다 놓기
- **투명도 / 확대축소 / 회전**: 패널 슬라이더와 `+`/`−`, `±90°` 버튼으로 조절
- **이미지 직접 조작**: `Ctrl` 키를 **누르고 있는 동안** 이미지 조작 모드
  - 드래그 → 이동
  - 휠 → 커서 위치 기준 확대/축소
  - `Shift` + 휠 → 회전
- **웹 조작 모드**: `Ctrl`을 떼면 이미지 위에서도 클릭/스크롤이 아래 웹 페이지로 통과
- **리셋**: 변형값(위치/크기/회전/투명도) 초기화 · **제거**: 오버레이 제거
- **접기 버튼(▾)**: 패널 본문 접기/펼치기

## 구조

```
manifest.json     # MV3: content_scripts, action, background, activeTab
background.js     # 툴바 클릭 → 콘텐츠 스크립트에 토글 메시지
src/
  transform.js    # 상태 → CSS transform 직렬화
  overlay.js      # 오버레이 DOM 생성 + 상태 반영
  panel.js        # 플로팅 컨트롤 패널
  content.js      # 진입점: 상태/키·모드/직접 상호작용/메시지
  styles.css      # 스타일 (imgovl- prefix + !important 격리)
icons/            # 16/48/128 아이콘 (scripts/gen-icons.mjs 로 생성)
scripts/
  gen-icons.mjs   # 플레이스홀더 아이콘 생성기 (node scripts/gen-icons.mjs)
```

설계 배경과 수용 기준은 [.claude/PLAN.md](.claude/PLAN.md) 참고.
