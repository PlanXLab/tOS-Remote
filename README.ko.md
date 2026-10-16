# tOS Remote

[English](README.md) | **한국어**

PC의 VS Code에서 tOS(tOS-Lite, Raspberry Pi 5) 보드의 작업 공간을 열고, 비전 추론 코드를 편집·실행·디버깅하는 VS Code 확장입니다. Jupyter 셀(Python 파일의 `#%%`, 노트북)도 보드에서 실행합니다.

보드에 VS Code Server를 설치하지 않습니다. 보드에서 이미 실행 중인 Dropbear SSH(SFTP)만 사용하므로 보드 메모리를 추가로 점유하지 않습니다.

## 주요 기능

- **원격 작업 공간 열기/닫기**: 보드의 작업 폴더(기본 `/home/tos/Workspace`)를 사용자가 지정한 로컬 SSD 폴더로 동기화하고 VS Code 창에서 엽니다. 저장 시 SFTP로 즉시 업로드됩니다.
- **사이드바 패널**: 보드 주소·계정·원격 경로·로컬 폴더 설정, 연결 테스트, SSH 키 등록, 준비 상태(rclone·OpenSSH·uv), 보드 도구(debugpy·Jupyter), 도구 모음
- **시작 가이드**: rclone 준비 → 보드 정보 → SSH 키 등록 → 작업 공간 열기를 단계별로 안내합니다. 이미 마친 단계는 자동으로 완료 표시되므로 **Mark Done**을 누르지 않아도 됩니다.
- **SSH 터미널**: 작업 공간의 기본 터미널이 보드의 셸로 열립니다. 작업 공간 창이 열릴 때 VS Code가 이전 세션의 로컬 터미널을 복원하면 보드 터미널로 바꿉니다.
- **실행/디버깅** (원격 작업 공간 창에서 Python 파일 기준)

  | 동작 | 방법 |
  |---|---|
  | tOS에서 디버깅 | `F5`, Run 버튼 메뉴의 **tOS에서 디버그** (영어: Debug on tOS) |
  | tOS에서 바로 실행 (디버거 없음) | `Ctrl+F5`, 편집기 오른쪽 위 Run 버튼(**tOS에서 실행**, 영어: Run on tOS) |

  - 실행 결과는 터미널 패널의 `tOS에서 실행: <파일>` 작업에 표시되며, 실행 전에 저장과 보드 업로드 완료를 기다립니다. 프로그램이 종료되면 종료 메시지를 표시하고 키 입력을 기다립니다.
  - ssh 실행 명령은 표시되지 않으며, 보드 연결이 끊긴 경우 한 줄로 알립니다.
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
- **연결 감시**: rclone 데몬이 종료되거나 연결이 끊기면 자동으로 복구 및 재연결합니다.
- **SSH 터미널 안정화**: 연결 단계에서 실패하면 2초 간격으로 최대 3회 다시 시도합니다. 실행 작업은 프로세스 종료 메시지를 표시하고 키 입력을 기다립니다.
- **표시 언어**: VS Code 표시 언어가 한국어이면 한국어로, 그 밖의 언어에서는 영어로 표시합니다(영어·한국어만 지원). 한국어로 보려면 VS Code에 Korean Language Pack을 설치하고 표시 언어를 한국어로 바꿉니다. 출력 패널의 로그는 영어로만 기록합니다. 확장 정보의 Details/Changelog 탭은 VS Code가 언어별 문서를 지원하지 않아 영어(`README.md`, `CHANGELOG.md`)로 표시되며, 한국어 문서는 `README.ko.md`, `CHANGELOG.ko.md`입니다.

## 요구 사항

| 항목 | 설명 |
|---|---|
| Windows 10/11, Linux, macOS | x64·arm64 |
| OpenSSH 클라이언트 | OS에 맞는 OpenSSH 클라이언트와 키 생성기(`ssh`, `ssh-keygen`)가 필요합니다. Windows는 선택적 OpenSSH 클라이언트 기능을 제공합니다. |
| [rclone](https://rclone.org) | 1.65.0 이상. 설치된 지원 버전을 먼저 사용합니다. 없으면 터미널에서 winget/Scoop/Chocolatey, Homebrew/MacPorts 또는 apt/dnf/pacman/zypper/yum/apk를 실행합니다(관리자/sudo 승인을 요청할 수 있음). 사용할 수 없거나 버전이 맞지 않으면 SHA-256을 검증한 공식 다운로드를 선택할 수 있습니다. Linux의 다운로드 대체 설치에는 `unzip` 또는 `bsdtar`가 필요합니다. 오프라인 환경은 `tosRemote.rclonePath`를 지정하세요. |
| Python Debugger 확장 (`ms-python.debugpy`) | 원격 디버깅(F5)에 필요 |
| Jupyter 확장 (`ms-toolsai.jupyter`) | 선택 사항입니다. 보드에서 Jupyter 셀을 실행하려 할 때 설치하세요. |
| [uv](https://docs.astral.sh/uv/) | 0.8.0 이상, 보드 도구 설치에만 필요합니다. 이미 설치된 지원 버전을 업데이트 없이 재사용하며, 없으면 OS에 맞는 실행 파일을 PyPI에서 내려받아 SHA-256을 검증합니다. 처음 해석할 때 uv용 Python(약 21 MB)도 내려받습니다. 보드 도구를 설치할 때 PC는 인터넷에 연결되어 있어야 합니다. |
| 보드의 `debugpy`, `jupyter_server`, `ipykernel` | 없으면 패널(**보드 도구**)에서 설치 |

## 사용 방법

1. 확장을 설치하면 **시작 가이드**가 열립니다. 닫았다면 명령 팔레트에서 `tOS: 시작 가이드`(영어: `tOS: Getting Started`)를 실행합니다.
2. 활동 표시줄의 **tOS Remote** 아이콘을 눌러 보드 주소·계정·작업 경로를 확인하고 **연결 테스트**를 누릅니다.
   - 작업 공간은 사용자에게 모든 권한이 있는 홈 디렉터리 아래에만 둘 수 있습니다. /home/<계정>/은 **계정** 칸에 따라 자동으로 표시되며, 그 이후 경로만 입력합니다(예: Workspace, class/vision). 폴더가 없으면 작업 공간을 열 때 중간 폴더까지 보드에 자동으로 만듭니다.
3. **SSH 키 등록**을 누르고 보드 비밀번호를 한 번 입력합니다. PC에 키가 없으면 `~/.ssh/id_ed25519`를 생성해 보드의 `~/.ssh/authorized_keys`에 등록합니다.
4. **원격 작업 공간 열기**를 누릅니다. 로컬 폴더가 아직 지정되지 않았으면 PC의 폴더를 선택한 뒤 현재 VS Code 창에서 열지, 새 창에서 열지 선택합니다.
5. 작업이 끝나면 **원격 작업 공간 닫기**를 누릅니다. 보드로 대기 중인 업로드가 모두 끝난 것을 확인한 뒤 세션을 종료합니다.

- 원격 작업 공간은 한 창에서만 열 수 있습니다. 다른 창에 이미 열려 있으면 **그 창으로 이동**을 눌러 VS Code 창 전환기를 여세요. 현재 폴더를 원격 작업 공간으로 덮어쓰지 않습니다. VS Code, 파일 관리자, 원격 터미널에서 변경한 내용은 양방향으로 동기화되며, 같은 파일을 양쪽에서 수정하면 수정 시각이 더 늦은 쪽을 유지합니다.
- 작업 공간을 닫지 않고 VS Code를 종료해도 로컬 작업 사본은 유지되며, 다시 실행하면 자동으로 연결됩니다.
- 비밀번호로만 연결한 경우 터미널과 **tOS에서 실행**은 매번 비밀번호를 묻습니다. 디버깅·보드 도구·Jupyter는 저장된 비밀번호를 사용합니다. SSH 키 등록을 권장합니다.

### 보드에서 Jupyter 셀 실행

1. 원격 작업 공간을 열고 패널의 **보드 도구**를 확인합니다. Jupyter가 없으면 **설치**를 누릅니다(보드의 sudo 비밀번호를 물을 수 있습니다).
2. 노트북이나 `#%%` 셀이 있는 Python 파일을 엽니다. 보드에서 Jupyter가 자동으로 시작되고 PC로 포워딩됩니다(Jupyter 서버 옆의 **시작**이나 `tOS: tOS에서 Jupyter 시작`으로 직접 시작할 수도 있습니다).
3. 보드 커널이 자동으로 선택됩니다. 보드마다 처음 한 번은 보드 커널 목록이 표시되니 Python 커널(별 표시)을 고르세요. 이 선택을 기억해, 이후 노트북과 Interactive 창은 묻지 않고 보드 커널을 사용합니다. 끄려면 `tosRemote.jupyterAutoSelectKernel`을 `false`로 바꾸고 **커널 선택(Select Kernel)**에서 **tOS Remote**를 직접 고릅니다.
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
| `tosRemote.localWorkspace` | (첫 연결 시 선택) | 원격 작업 공간 파일 사본을 보관하고 동기화할 이 PC의 로컬 폴더 경로 |
| `tosRemote.driveLetter` | (자동) | 기존 가상 드라이브 설정 |
| `tosRemote.identityFile` | (자동) | SSH 개인 키 경로 |
| `tosRemote.pythonCommand` | `python3` | 보드 Python 명령 |
| `tosRemote.debugPort` | `5678` | debugpy 포트 |
| `tosRemote.pythonLibraryPaths` | (자동 감지) | IntelliSense용으로 복사할 보드 패키지 경로. 지정하면 모두 필수로 처리 |
| `tosRemote.pathMappings` | `[]` | 터미널 링크용 추가 경로 매핑 |
| `tosRemote.rclonePath` | (자동 설치) | 직접 준비한 rclone 실행 파일 경로 |
| `tosRemote.packageExcludeNewer` | (비움) | 보드 패키지를 이 날짜 기준 버전으로 설치합니다(예: `2026-10-01`). 모든 PC에 같은 날짜를 지정하면 실습실 보드에 같은 버전이 설치됩니다. 비우면 보드 Python과 호환되는 최신 버전을 사용합니다. |
| `tosRemote.jupyterAutoSelectKernel` | `true` | 노트북이나 `#%%` 파일을 열면 보드에서 Jupyter를 시작하고 보드 커널을 자동으로 선택합니다. |

모든 설정은 PC별(machine) 설정이며 설정 동기화로 다른 PC에 복사되지 않습니다. 비밀번호는 설정이 아닌 VS Code 보안 저장소(SecretStorage)에만 저장됩니다.

## 동작 방식

```
VS Code (확장) ──HTTP(127.0.0.1, 무작위 포트·계정)──▶ rclone rcd (분리 실행)
     │                                                  │ SFTP
     │ ssh (터미널·실행·디버그)                          ▼
     └──────────────────────────────────────────────▶ Dropbear (보드)
                                    로컬 SSD 작업 사본 ◀──▶ 즉시 SFTP 동기화
```

- rclone은 확장 프로세스와 분리된 제어 서버(`rclone rcd`)로 실행되어 창 재로드·VS Code 종료 후에도 유지됩니다.
- 작업 공간 파일(`.code-workspace`)은 PC의 확장 저장소에 생성되며 보드에는 아무것도 쓰지 않습니다.
- 저장 후 실행·디버깅 전에 동기화 대기열을 모두 플러시해 보드에서 이전 파일이 실행되지 않게 합니다.
- SSH 터미널은 확장 저장소의 플랫폼별 스크립트(Windows는 `.cmd`, Linux/macOS는 `.sh`)로 실행되어 연결 실패 재시도와 종료 코드 처리를 담당합니다. **tOS에서 실행**도 같은 방식으로 ssh 명령을 터미널 출력에서 숨깁니다.
- Python 라이브러리 동기화는 보드(Dropbear)의 동시 접속 제한을 고려해 SSH 연결을 4개 이내로 사용하며, 작업 공간이 열린 뒤 15초 후에 시작합니다. 보드 도구(debugpy·Jupyter)는 작업 공간을 열 때 같은 SSH 연결에서 확인합니다.
- 로컬 작업 사본의 파일 변경은 200ms 디바운스 후 보드로 즉시 업로드됩니다(`operations/copyfile` / `operations/deletefile`). 보드에서 직접 생성·수정한 파일은 패널의 **보드에서 가져오기**로 가져옵니다.
- 보드 도구: PC의 uv가 보드 기준으로 패키지를 해석합니다(보드의 `--python-version`·`--python-platform`, 휠만, 보드에 이미 있는 패키지는 유지). `PATH`, `~/.local/bin`, 일반적인 패키지 관리자 실행 경로의 기존 지원 `uv`를 재사용하며, 없으면 OS에 맞는 실행 파일을 PyPI에서 내려받아 SHA-256을 검증합니다. 휠도 PyPI에서 내려받아 검증하고, rclone으로 `/tmp/tos-remote.XXXXXX`(권한 0700)에 복사한 뒤 `sudo pip install --no-index --find-links`로 설치합니다. 해석 자료(uv용 Python 포함)는 확장 저장소에 둡니다. 캐시는 Windows의 `%LOCALAPPDATA%\tOS Remote`, macOS의 `~/Library/Caches/tOS Remote`, Linux의 `$XDG_CACHE_HOME/tOS Remote` 또는 `~/.cache/tOS Remote`에 저장합니다.
- Jupyter: 서버는 보드 사용자 권한으로 실행되며(`python3 -m jupyter_server`, `127.0.0.1`, 무작위 포트·토큰, 터미널 기능 끔), 상태와 로그는 `~/.local/state/tos-remote`(권한 0700)에 둡니다. PC는 빈 로컬 포트를 `ssh -N -L`로 포워딩하고 Jupyter 확장에 등록합니다(`createJupyterServerCollection`). 포워딩이 끊기면 서버가 실행 중인 동안 자동으로 다시 연결합니다.
- 비밀번호 인증에서는 화면 없이 실행하는 ssh 명령이 저장된 비밀번호를 `SSH_ASKPASS`로 받습니다. 작은 도우미 스크립트(Windows는 `.cmd`, Linux/macOS는 `.sh`)가 VS Code의 Node.js를 실행해 확장이 연 일회용 로컬 채널에서 읽습니다.

## 보안 참고

- 보드 재설치로 호스트 키가 바뀌어도 접속되도록 **SSH 호스트 키를 검증하지 않습니다**. 신뢰할 수 있는 네트워크(직결·실습망)에서 사용하세요.
- 원격 디버깅 중 debugpy는 보드의 `127.0.0.1:5678`(루프백)에서만 연결을 기다리며, SSH 터널을 통해 안전하게 통신합니다.
- 디버거에서 연결을 끊어도 원격 프로세스와 SSH 터널은 유지됩니다. 프로세스가 끝난 뒤 다시 시작하면 원격 디버그 프로세스를 새로 준비합니다.
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
test/install.js 플랫폼별 실제 다운로드·설치 검증 후 로컬 SFTP 서버를 이용한 전체 테스트
test/integration/  VS Code 확장 호스트 통합 테스트 (보드 대신 로컬 rclone SFTP 서버, 영어·한국어 표시 언어)
scripts/build-vsix.ps1         Node와 빌드 도구 없이 Marketplace에 업로드할 .vsix 생성
scripts/integration-test.ps1   통합 테스트 실행
```

```powershell
node test/run.js                       # 단위 테스트
node test/install.js                   # rclone·uv 다운로드·검증 후 실제 SFTP를 포함한 전체 테스트
.\scripts\build-vsix.ps1               # dist\tos-remote-<버전>.vsix (Node·빌드 도구 불필요)
.\scripts\integration-test.ps1 -CodePath <Code.exe>
```

생성된 `.vsix` 파일을 Visual Studio Marketplace 게시자 페이지에서 업로드합니다. 확장 패키징에 Node.js나 `vsce` 설치가 필요하지 않습니다.

통합 테스트는 다른 VS Code 인스턴스가 같은 사용자 데이터로 실행 중이면 시작할 수 없습니다. 포터블 VS Code를 사용 중이라면 `data` 폴더를 제외한 복사본의 `Code.exe`를 지정하세요.

단위 테스트는 모든 플랫폼에서 실행할 수 있습니다. 제공된 통합 테스트 실행 스크립트는 Windows용 PowerShell이며, 확장 호스트 테스트 코드는 OS 독립 경로를 사용하므로 Linux/macOS에서는 VS Code에서 직접 실행할 수 있습니다.

CI는 Windows·Linux·macOS에서 설치기와 SFTP 테스트를 통과한 뒤 모든 플랫폼에 공통인 VSIX를 만듭니다. 플랫폼별 네이티브 실행 파일은 확장에 포함하지 않습니다.

### 다국어

- 사용자에게 보이는 문자열은 소스에 영어로 쓰고 `t('...')`(`src/i18n.js`, 내부적으로 `vscode.l10n.t`)로 감쌉니다. 작은따옴표 문자열만 사용합니다.
- 문서는 영어(`README.md`, `CHANGELOG.md`)와 한국어(`README.ko.md`, `CHANGELOG.ko.md`)를 함께 갱신합니다.
- 한국어 번역은 `l10n/bundle.l10n.ko.json`에 영어 원문을 키로 추가합니다. 매니페스트 문자열은 `package.nls.json`/`package.nls.ko.json`에 같은 키로 추가합니다.
- `node test/run.js`가 번역 누락·미사용 항목과 `{0}` 자리표시자 불일치를 검사합니다.
- 통합 테스트는 한국어 언어 팩(`MS-CEINTL.vscode-language-pack-ko`)을 격리된 확장 폴더에 설치하고 `--locale=ko`로 한 번 더 실행합니다. 네트워크가 없으면 `-SkipKorean`을 지정하세요.

## 라이선스

[GPL-3.0-or-later](LICENSE). Copyright (C) PlanXLab.

이 확장은 rclone, uv를 포함하지 않습니다. 가능한 경우 PC에 이미 설치된 지원 버전을 사용합니다. 그 외에는 rclone(MIT)을 사용 가능한 패키지 관리자로 설치하거나 공식 사이트에서 내려받아 SHA-256을 검증하고, uv(MIT 또는 Apache-2.0)는 보드 도구를 처음 설치할 때 PyPI에서 내려받아 SHA-256을 검증합니다. 보드 패키지(debugpy, Jupyter)는 설치할 때 PyPI에서 내려받습니다.
