# rclone

보드와 파일을 주고받는 데 [rclone](https://rclone.org)을 사용합니다.

1. `https://downloads.rclone.org/version.txt`에서 최신 버전을 확인합니다.
2. Windows용 zip을 임시 폴더에 내려받고 `SHA256SUMS`로 무결성을 검증합니다.
3. `rclone.exe`만 확장 저장소에 설치합니다. 확장을 업데이트해도 유지됩니다.

설치는 한 번만 하며, 설치된 rclone을 다시 내려받거나 업데이트하지 않습니다.

오프라인 환경에서는 `rclone.exe`를 직접 준비해 설정 `tosRemote.rclonePath`에 경로를 지정하세요.