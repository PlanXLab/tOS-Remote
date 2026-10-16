# rclone

보드와 파일을 주고받는 데 [rclone](https://rclone.org)을 사용합니다.

1. 설치된 지원 버전이 있으면 먼저 사용합니다.
2. rclone이 없으면 사용 가능한 패키지 관리자(winget/Scoop/Chocolatey, Homebrew/MacPorts 또는 주요 Linux 패키지 관리자)로 설치합니다.
3. 관리자가 없거나 버전이 오래되면 OS에 맞는 Windows·Linux·macOS 공식 실행 파일을 내려받아 `SHA256SUMS`로 무결성을 검증합니다.

검증된 실행 파일은 확장 저장소에 보관합니다. 패키지 관리자로 설치한 rclone은 해당 관리자가 관리하며 확장이 자동 업데이트하지 않습니다.

오프라인 환경에서는 rclone 실행 파일을 직접 준비해 설정 `tosRemote.rclonePath`에 경로를 지정하세요.