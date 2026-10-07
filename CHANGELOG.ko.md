# 변경 내역

[English](CHANGELOG.md) | **한국어**

## 0.2.0

- 확장 이름 변경: **tOS-Lite Remote → tOS Remote**
  - 확장 ID `PlanXLab.tos-lite-remote` → `PlanXLab.tos-remote` (새 확장으로 설치됨)
  - 설정 키 `tosLite.*` → `tosRemote.*`, 디버그 유형 `tos-lite` → `tos-remote`
  - 이전 확장의 설정·저장된 비밀번호·rclone은 이어지지 않습니다. 보드 기본값(192.168.254.1, tos)은 같습니다.
- 명령 이름 변경: **보드에서 실행/디버그 → tOS에서 실행/디버그** (영어: Run on tOS / Debug on tOS)
- 표시 언어 지원: 영어(기본)와 한국어. VS Code 표시 언어가 한국어일 때만 한국어로 표시
  - 매니페스트(`package.nls.json`, `package.nls.ko.json`), 런타임 메시지(`l10n/bundle.l10n.ko.json`), 사이드바 패널, 시작 가이드 문서(`media/walkthrough`, `media/walkthrough/ko`), SSH 터미널 안내 문구
  - 출력 패널 로그는 영어로만 기록
- 사이드바 패널 상태 카드를 3줄로 표시: 계정·IP / 작업 공간 → 가상 드라이브 / 인증
- rclone 업데이트 기능 제거: 한 번 설치하면 다시 내려받지 않으며, 패널에 업데이트 링크를 표시하지 않음
- 확장 정보(Details/Changelog) 문서를 영어 기본으로 변경하고 한국어 문서(`README.ko.md`, `CHANGELOG.ko.md`)를 분리
- Marketplace 정보 추가: GPL-3.0-or-later 라이선스, 아이콘, GitHub 저장소(github.com/PlanXLab/tOS-Remote)

## 0.1.2

- Run 버튼(편집기 오른쪽 위): **보드에서 실행**이 기본 항목이 되도록 순서 조정 (이전에는 Python 확장의 로컬 `Run Python File`이 앞에 표시될 수 있었음)
- Run 버튼 메뉴에 **보드에서 디버그** 추가 (선택된 launch 구성과 관계없이 보드에서 디버깅)
- `Ctrl+F5`(디버그 없이 실행)로 보드에서 바로 실행되는 것을 통합 테스트로 확인

## 0.1.1

- SSH 터미널: 작업 공간을 열 때 `ssh.exe ... terminated with exit code: 255` 알림이 뜨는 문제 수정
  - 연결 단계 실패 시 최대 3회 자동 재시도, 최종 실패는 알림 대신 터미널에 원인 표시
  - 세션 종료 시 원격 셸 종료 코드(예: `exit` 후 1)로 알림이 뜨지 않도록 처리
- Python 라이브러리 동기화
  - 전역 경로는 필수, `~/.local`·작업 공간 가상 환경은 선택으로 구분 (선택 경로는 없거나 실패해도 알림 없음)
  - 작업 공간의 가상 환경(`pyvenv.cfg`) 자동 감지·동기화, 수동 동기화 시 다시 감지
  - 심볼릭 링크로 중복된 경로를 하나로 합쳐 중복 동기화 제거
  - 동시 SSH 연결 수 제한(최대 4), 작업 공간 열림 15초 후 시작
- 사이드바 패널: 새 창을 열 때마다 rclone이 "내려받기"로 잠깐 표시되던 문제 수정 (마지막 점검 결과 표시, 점검 중 표시)

## 0.1.0

- 첫 버전
- 원격 작업 공간 열기/닫기 (rclone rcd + WinFsp 마운트, 한 창 제한, VS Code 종료 후 마운트 유지)
- 사이드바 패널, 상태 표시줄, 시작 가이드
- rclone 최신 버전 자동 다운로드(SHA-256 검증), WinFsp winget 설치
- SSH 키 등록, 비밀번호 보안 저장소 저장
- SSH 터미널, 보드 실행(Ctrl+F5), debugpy 원격 디버깅(F5)
- 터미널 경로 링크 (기존 tOS-Lite Remote Path Link 기능 통합)
- Python 라이브러리 로컬 캐시(Pylance), 연결 감시·자동 재연결
