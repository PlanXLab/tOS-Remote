# tOS Remote

[English](README.md) | **한국어**

PC의 VS Code에서 tOS(tOS-Lite, Raspberry Pi 5) 보드의 작업 공간을 열고, 비전 추론 코드를 편집·실행·디버깅하는 VS Code 확장입니다. Jupyter 셀(Python 파일의 `#%%`, 노트북)도 보드에서 실행합니다.

보드에 VS Code Server를 설치하지 않습니다. 보드에서 이미 실행 중인 Dropbear SSH(SFTP)만 사용하므로 보드 메모리를 추가로 점유하지 않습니다.

## 주요 기능

- **원격 작업 공간 열기/닫기**: 보드의 작업 폴더(기본 `/home/tos/Workspace`)를 Windows 드라이브로 연결하고 VS Code 창에서 엽니다.
- **사이드바 패널**: 보드 주소·계정·경로 설정, 연결 테스트, SSH 키 등록, 준비 상태(WinFsp·rclone·OpenSSH·uv), 보드 도구(debugpy·Jupyter), 도구 모음
- **시작 가이드**: WinFsp 설치 → rclone 준비 → 보드 정보 → SSH 키 등록 → 작업 공간 열기를 단계별로 안내
- **SSH 터미널**: 작업 공간의 기본 터미널이 보드의 셸로 열립니다.
- **실행/디버깅** (원격 작업 공간 창에서 Python 파일 기준)

  | 동작 | 방법 |
  |---|---|
  | tOS에서 디버깅 | `F5`, Run 버튼 메뉴의 **tOS에서 디버그** (영어: Debug on tOS) |
  | tOS에서 바로 실행 (디버거 없음) | `Ctrl+F5`, 편집기 오른쪽 위 Run 버튼(**tOS에서 실행**, 영어: Run on tOS) |

  - 실행 결과는 터미널 패널의 `tOS에서 실행: <파일>` 작업에 표시되며, 실행 전에 저장과 보드 업로드 완료를 기다립니다.
  - 터미널에는 프로그램 출력만 표시됩니다. ssh 실행 명령과 작업 안내 문구는 보이지 않으며, 보드 연결이 끊긴 경우에만 한 줄로 알립니다.
  - 보드에 `debugpy`가 없으면 `F5`에서 설치를 안내하고(**보드 도구** 참고), 설치 후 디버깅을 시작합니다.
  - Run 버튼 메뉴의 `Run Python File`(Python 확장)은 PC의 로컬 Python으로 실행하므로 원격 작업 공간에서는 사용하지 마세요. Run 버튼은 마지막에 고른 항목을 기억합니다.
  - tOS에서 실행하는 데 `Ctrl+Shift+B`(빌드 작업)는 필요하지 않습니다.
- **보드 도구**: 보드 전역 Python 환경에 `debugpy`(원격 디버깅)와 `jupyter_server`·`ipykernel`(Jupyter)이 없으면 설치합니다. 이미 있으면 설치하지 않습니다.
  - 보드는 인터넷에 연결되어 있지 않아도 됩니다. PC가 [uv](https://docs.astral.sh/uv/)로 보드의 Python 버전·플랫폼에 맞는 패키지를 해석해 PyPI에서 내려받고(SHA-256 검증), 보드 임시 폴더로 복사한 뒤 `sudo pip install`로 설치합니다(tOS의 `pip`은 uv로 전역 환경에 설치). 임시 폴더는 설치 후 지웁니다.
  - 패키지가 지원하는 범위에서 보드의 Python 3 버전은 무엇이든 사용할 수 있습니다(Python 3.8~3.14 확인).
  - sudo 비밀번호는 저장된 보드 비밀번호를 사용하고, 없거나 맞지 않으면 입력받습니다. SSH로 보드에 보내는 스크립트 안에만 넣으며 명령줄이나 로그에는 남기지 않습니다.
  - `/usr/local/bin/run_debug.sh`(tOS 이미지의 debugpy 실행 스크립트)가 없으면 실행 권한으로 만듭니다. 이미 있으면 바꾸지 않습니다.
- **보드에서 Jupyter 실행**: 보드에서 Jupyter 서버를 백그라운드로 시작하고(`127.0.0.1`에서만, 토큰 사용), SSH로 PC에 포워딩한 뒤 Jupyter 확장의 커널 선택기에 **tOS Remote**로 등록합니다. 셀(Python 파일의 `#%%`, 노트북)은 보드에서 실행되며 셀 사이의 상태가 유지됩니다.
- **터미널 경로 링크**: 터미널에 출력된 `/home/tos/Workspace/...` 경로(Python traceback, gcc, pdb 형식)를 `Ctrl+클릭`하면 로컬 파일의 해당 줄이 열립니다. 보드 site-packages 경로는 로컬 캐시 파일로 연결됩니다.
- **IntelliSense**: 보드의 Python 패키지 중 `.py`/`.pyi`만 로컬에 복사해 Pylance가 분석합니다.
  - 전역 site-packages(`/var/lib/tos/...`)는 **필수**로 동기화하며 실패하면 알림을 표시합니다.
  - `~/.local` 사용자 패키지와 작업 공간의 가상 환경(`uv venv` 등으로 만든 `pyvenv.cfg` 폴더, 2단계 깊이까지)은 **선택**으로 동기화하며, 없거나 실패해도 알림 없이 로그만 남깁니다.
  - 작업 중 새로 만든 가상 환경은 패널의 **Python 라이브러리 동기화**를 누르면 다시 감지해 반영합니다.
- **연결 감시**: rclone이 종료되거나 마운트가 끊기면 같은 드라이브로 자동 재연결합니다.
- **SSH 터미널 안정화**: 연결 단계에서 실패하면 2초 간격으로 최대 3회 다시 시도하고, 세션이 끝날 때 원격 셸의 종료 코드로 인한 알림을 표시하지 않습니다.
- **표시 언어**: VS Code 표시 언어가 한국어이면 한국어로, 그 밖의 언어에서는 영어로 표시합니다(영어·한국어만 지원). 한국어로 보려면 VS Code에 Korean Language Pack을 설치하고 표시 언어를 한국어로 바꿉니다. 출력 패널의 로그는 영어로만 기록합니다. 확장 정보의 Details/Changelog 탭은 VS Code가 언어별 문서를 지원하지 않아 영어(`README.md`, `CHANGELOG.md`)로 표시되며, 한국어 문서는 `README.ko.md`, `CHANGELOG.ko.md`입니다.

## 요구 사항

| 항목 | 설명 |
|---|---|
| Windows 10/11 (x64, arm64) | 현재 Windows만 지원합니다. |
| [WinFsp](https://winfsp.dev) | 가상 드라이브. 패널/시작 가이드에서 `winget`으로 설치(관리자 승인 필요) |
| OpenSSH 클라이언트 | Windows 기본 포함(`C:\Windows\System32\OpenSSH\ssh.exe`) |
| [rclone](https://rclone.org) | 확장이 처음 사용할 때 최신 버전을 내려받아 SHA-256 검증 후 설치. 한 번 설치하면 다시 내려받거나 업데이트하지 않습니다. 오프라인 환경은 `tosRemote.rclonePath` 지정 |
| Python Debugger 확장 (`ms-python.debugpy`) | 원격 디버깅(F5)에 필요 |
| Jupyter 확장 (`ms-toolsai.jupyter`) | 보드에서 Jupyter 셀을 실행하는 데 필요 |
| [uv](https://docs.astral.sh/uv/) | 보드 도구 설치에만 필요. 처음 설치할 때 PyPI에서 내려받아 SHA-256을 검증합니다(약 15 MB). 처음 해석할 때 uv용 Python(약 21 MB)도 내려받습니다. 보드 도구를 설치할 때 PC는 인터넷에 연결되어 있어야 합니다. |
| 보드의 `debugpy`, `jupyter_server`, `ipykernel` | 없으면 패널(**보드 도구**)에서 설치 |

## 사용 방법

1. 확장을 설치하면 **시작 가이드**가 열립니다. 닫았다면 명령 팔레트에서 `tOS: 시작 가이드`(영어: `tOS: Getting Started`)를 실행합니다.
2. 활동 표시줄의 **tOS Remote** 아이콘을 눌러 보드 주소·계정·작업 경로를 확인하고 **연결 테스트**를 누릅니다.
   - 작업 공간은 사용자에게 모든 권한이 있는 홈 디렉터리 아래에만 둘 수 있습니다. /home/<계정>/은 **계정** 칸에 따라 자동으로 표시되며, 그 이후 경로만 입력합니다(예: Workspace, class/vision). 폴더가 없으면 작업 공간을 열 때 중간 폴더까지 보드에 자동으로 만듭니다.
3. **SSH 키 등록**을 누르고 보드 비밀번호를 한 번 입력합니다. PC에 키가 없으면 `~/.ssh/id_ed25519`를 생성해 보드의 `~/.ssh/authorized_keys`에 등록합니다.
4. **원격 작업 공간 열기**를 누릅니다. 드라이브가 마운트되고 창이 작업 공간으로 다시 로드됩니다.
5. 작업이 끝나면 **원격 작업 공간 닫기**를 누릅니다. 보드로 업로드가 끝난 것을 확인한 뒤 마운트를 해제합니다.

- 원격 작업 공간은 한 창에서만 열 수 있습니다. 다른 창에서 열기를 누르면 이미 열린 창으로 이동합니다.
- 작업 공간을 닫지 않고 VS Code를 종료하면 드라이브 마운트는 유지되며, 다시 실행하면 자동으로 이어서 연결합니다. 패널에서 **마운트 해제**를 누르면 해제됩니다.
- 비밀번호로만 연결한 경우 터미널과 **tOS에서 실행**은 매번 비밀번호를 묻습니다. 디버깅·보드 도구·Jupyter는 저장된 비밀번호를 사용합니다. SSH 키 등록을 권장합니다.

### 보드에서 Jupyter 셀 실행

1. 원격 작업 공간을 열고 패널의 **보드 도구**를 확인합니다. Jupyter가 없으면 **설치**를 누릅니다(보드의 sudo 비밀번호를 물을 수 있습니다).
2. Jupyter 서버 옆의 **시작**을 누릅니다(또는 `tOS: tOS에서 Jupyter 시작`). 보드에서 서버가 시작되고 PC로 포워딩됩니다.
3. Python 파일에 `#%%`로 셀을 만들고 **Run Cell**을 누릅니다. **커널 선택(Select Kernel)**에서 **tOS Remote**와 Python 커널을 고릅니다. 서버가 아직 실행 중이 아니면 **tOS Remote**를 고를 때 시작합니다.
4. 끝나면 **정지**를 누릅니다. 원격 작업 공간을 닫아도 서버가 정지됩니다. 연결이 없는 유휴 커널은 1시간 뒤에 종료되고, 커널과 요청이 모두 없으면 1시간 뒤에 서버도 종료됩니다.

```python
#%%
import sys
#%%
print(sys.path)   # 보드에서 실행
```

## 설정

| 설정 | 기본값 | 설명 |
|---|---|---|
| `tosRemote.host` | `192.168.254.1` | 보드 IP 주소 |
| `tosRemote.port` | `22` | SSH 포트 |
| `tosRemote.user` | `tos` | 보드 계정 |
| `tosRemote.remoteWorkspace` | `Workspace` | 사용자 홈 디렉터리(`/home/<계정>/`) 아래의 작업 공간 폴더. 홈 이후 경로만 입력하며 `/home/<계정>/`은 계정으로 자동 입력됩니다. 보드에 없으면 자동으로 만듭니다. |
| `tosRemote.driveLetter` | (자동) | 마운트 드라이브. 비우면 Z:부터 빈 문자 |
| `tosRemote.identityFile` | (자동) | SSH 개인 키 경로 |
| `tosRemote.pythonCommand` | `python3` | 보드 Python 명령 |
| `tosRemote.debugPort` | `5678` | debugpy 포트 |
| `tosRemote.pythonLibraryPaths` | (자동 감지) | IntelliSense용으로 복사할 보드 패키지 경로. 지정하면 모두 필수로 처리 |
| `tosRemote.pathMappings` | `[]` | 터미널 링크용 추가 경로 매핑 |
| `tosRemote.rclonePath` | (자동 설치) | 직접 준비한 rclone.exe 경로 |
| `tosRemote.packageExcludeNewer` | (비움) | 보드 패키지를 이 날짜 기준 버전으로 설치합니다(예: `2026-10-01`). 모든 PC에 같은 날짜를 지정하면 실습실 보드에 같은 버전이 설치됩니다. 비우면 보드 Python과 호환되는 최신 버전을 사용합니다. |

모든 설정은 PC별(machine) 설정이며 설정 동기화로 다른 PC에 복사되지 않습니다. 비밀번호는 설정이 아닌 VS Code 보안 저장소(SecretStorage)에만 저장됩니다.

## 동작 방식

```
VS Code (확장) ──HTTP(127.0.0.1, 무작위 포트·계정)──▶ rclone rcd (분리 실행)
     │                                                  │ SFTP
     │ ssh.exe (터미널·실행·디버그)                      ▼
     └──────────────────────────────────────────────▶ Dropbear (보드)
                                     WinFsp 드라이브 ◀── rclone mount
```

- rclone은 확장 프로세스와 분리된 제어 서버(`rclone rcd`)로 실행되어 창 재로드·VS Code 종료 후에도 마운트가 유지됩니다.
- 작업 공간 파일(`.code-workspace`)은 PC의 확장 저장소에 생성되며 보드에는 아무것도 쓰지 않습니다.
- 저장 후 실행·디버깅 전에 rclone 쓰기 대기열이 빌 때까지 기다려 보드에서 이전 파일이 실행되지 않게 합니다.
- SSH 터미널은 확장 저장소의 `ssh-terminal.cmd`(cmd.exe)로 실행되어 연결 실패 재시도와 종료 코드 처리를 담당합니다. **tOS에서 실행**은 `run-on-tos.cmd`로 실행되며, ssh 명령을 환경 변수로 받아 터미널에 표시되지 않게 합니다.
- Python 라이브러리 동기화는 보드(Dropbear)의 동시 접속 제한을 고려해 SSH 연결을 4개 이내로 사용하며, 작업 공간이 열린 뒤 15초 후에 시작합니다. 보드 도구(debugpy·Jupyter)는 작업 공간을 열 때 같은 SSH 연결에서 확인합니다.
- 드라이브 쓰기는 200ms 지연 후 업로드되고, 보드에서 생성된 파일은 최대 10초 안에 보입니다(바로 보려면 **드라이브 새로 고침**).
- 보드 도구: PC의 uv가 보드 기준으로 패키지를 해석합니다(보드의 `--python-version`·`--python-platform`, 휠만, 보드에 이미 있는 패키지는 유지). 휠은 PyPI에서 내려받아 SHA-256으로 검증하고, rclone으로 `/tmp/tos-remote.XXXXXX`(권한 0700)에 복사한 뒤 `sudo pip install --no-index --find-links`로 설치합니다. 해석 도구는 확장 저장소(`uv.exe`, uv용 Python)와 `%LOCALAPPDATA%\tOS Remote\uv-cache`에 둡니다.
- Jupyter: 서버는 보드 사용자 권한으로 실행되며(`python3 -m jupyter_server`, `127.0.0.1`, 무작위 포트·토큰, 터미널 기능 끔), 상태와 로그는 `~/.local/state/tos-remote`(권한 0700)에 둡니다. PC는 빈 로컬 포트를 `ssh -N -L`로 포워딩하고 Jupyter 확장에 등록합니다(`createJupyterServerCollection`). 포워딩이 끊기면 서버가 실행 중인 동안 자동으로 다시 연결합니다.
- 비밀번호 인증에서는 화면 없이 실행하는 ssh 명령이 저장된 비밀번호를 `SSH_ASKPASS`로 받습니다. 작은 도우미(`askpass.cmd`, VS Code에 포함된 Node.js로 실행)가 확장이 연 일회용 named pipe에서 읽습니다.

## 보안 참고

- 보드 재설치로 호스트 키가 바뀌어도 접속되도록 **SSH 호스트 키를 검증하지 않습니다**. 신뢰할 수 있는 네트워크(직결·실습망)에서 사용하세요.
- 원격 디버깅 중 debugpy는 보드의 `0.0.0.0:5678`에서 연결을 기다립니다.
- rclone 제어 서버는 `127.0.0.1`에서만 열리며 실행할 때마다 무작위 계정·비밀번호를 사용합니다.
- Jupyter 서버는 보드의 `127.0.0.1`에서만 열리고 무작위 토큰을 요구하며, SSH 터널로만 접속합니다.
- 보드 패키지는 sudo로 전역 Python 환경에 설치합니다. 이 기능은 sudo 비밀번호를 저장하지 않으며, 패널에 저장한 보드 비밀번호가 있으면 다시 사용합니다.

## 문제 해결

- 패널의 **로그 보기**(출력 패널 `tOS Remote`)와 **rclone 로그**를 확인하세요. 보드 도구 설치 출력도 같은 로그에 기록됩니다.
- 드라이브가 사용 중이라는 오류: 패널에서 드라이브를 `자동`으로 두거나 다른 문자를 선택하세요.
- 보드 연결이 끊기면 상태 표시줄에 `다시 연결 중`이 표시되고 자동으로 재시도합니다.
- Jupyter 셀이 보드가 아닌 PC에서 실행되면 **커널 선택(Select Kernel)** → **tOS Remote**를 고르세요. 보드의 서버 로그는 패널의 **Jupyter 로그**에서 볼 수 있습니다.
- 보드 도구 설치가 해석 오류로 실패하면 보드 Python 버전이 패키지에 비해 너무 오래되었을 수 있습니다. 로그의 `[uv]` 줄을 확인하세요.

## 개발

```
src/            확장 소스 (빌드 단계 없는 순수 JavaScript, 런타임 의존성 없음)
media/          사이드바 패널(html/css/js), 아이콘, 시작 가이드 문서(영어, ko/ 한국어)
l10n/           런타임 문자열 한국어 번역 (bundle.l10n.ko.json, 원문은 소스의 영어)
package.nls*.json  매니페스트 문자열 (영어 기본, .ko 한국어)
test/run.js     단위 테스트 (node test/run.js, 번역 누락·자리표시자 검사 포함)
test/integration/  VS Code 확장 호스트 통합 테스트 (보드 대신 로컬 rclone SFTP 서버, 영어·한국어 표시 언어)
scripts/build-vsix.ps1         Node 없이 로컬 설치 테스트용 .vsix(*-local.vsix) 생성. Marketplace 업로드용 아님
scripts/integration-test.ps1   통합 테스트 실행
```

```powershell
node test/run.js                       # 단위 테스트
.\scripts\build-vsix.ps1               # 로컬 설치 테스트용 dist\tos-remote-<버전>-local.vsix (Node 불필요)
npx @vscode/vsce package --out dist/   # Marketplace용 패키징·검증 (Node 필요)
npx @vscode/vsce publish               # Marketplace 게시 (vsce login PlanXLab 후)
.\scripts\integration-test.ps1 -CodePath <Code.exe>
```

통합 테스트는 다른 VS Code 인스턴스가 같은 사용자 데이터로 실행 중이면 시작할 수 없습니다. 포터블 VS Code를 사용 중이라면 `data` 폴더를 제외한 복사본의 `Code.exe`를 지정하세요.

### 다국어

- 사용자에게 보이는 문자열은 소스에 영어로 쓰고 `t('...')`(`src/i18n.js`, 내부적으로 `vscode.l10n.t`)로 감쌉니다. 작은따옴표 문자열만 사용합니다.
- 문서는 영어(`README.md`, `CHANGELOG.md`)와 한국어(`README.ko.md`, `CHANGELOG.ko.md`)를 함께 갱신합니다.
- 한국어 번역은 `l10n/bundle.l10n.ko.json`에 영어 원문을 키로 추가합니다. 매니페스트 문자열은 `package.nls.json`/`package.nls.ko.json`에 같은 키로 추가합니다.
- `node test/run.js`가 번역 누락·미사용 항목과 `{0}` 자리표시자 불일치를 검사합니다.
- 통합 테스트는 한국어 언어 팩(`MS-CEINTL.vscode-language-pack-ko`)을 격리된 확장 폴더에 설치하고 `--locale=ko`로 한 번 더 실행합니다. 네트워크가 없으면 `-SkipKorean`을 지정하세요.

## 라이선스

[GPL-3.0-or-later](LICENSE). Copyright (C) PlanXLab.

이 확장은 rclone, WinFsp, uv를 포함하지 않습니다. rclone(MIT)은 처음 사용할 때 공식 사이트에서 내려받고, uv(MIT 또는 Apache-2.0)는 보드 도구를 처음 설치할 때 PyPI에서 내려받으며, WinFsp(GPLv3, FLOSS 예외)는 사용자가 winget으로 설치합니다. 보드 패키지(debugpy, Jupyter)는 설치할 때 PyPI에서 내려받습니다.
