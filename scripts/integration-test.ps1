<#
.SYNOPSIS
    tOS-Lite Remote 통합 테스트 (보드 없이 로컬 rclone SFTP 서버로 검증)

.DESCRIPTION
    격리된 사용자 데이터/확장 폴더로 VS Code 확장 개발 호스트를 실행해 test/integration/index.js를 수행한다.
    rclone 다운로드(인터넷), OpenSSH 클라이언트가 필요하다. 테스트 중 VS Code 창이 잠시 열린다.

.EXAMPLE
    .\scripts\integration-test.ps1 -CodePath "C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe"
#>
param(
    [string]$CodePath,
    [int]$Port = 22022,
    [int]$TimeoutSec = 300,
    [switch]$KeepWork,
    [switch]$SkipKorean
)

$ErrorActionPreference = 'Stop'
$ExtDir = Split-Path -Parent $PSScriptRoot

if (-not $CodePath) {
    $CodePath = @(
        (Get-Process -Name Code -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path),
        "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe",
        "$env:ProgramFiles\Microsoft VS Code\Code.exe"
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $CodePath) { throw 'Code.exe를 찾을 수 없습니다. -CodePath를 지정하세요.' }

$Work = Join-Path $env:TEMP "tos-lite-it-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$ServeDir = Join-Path $Work 'sftp-root'
$OutFile = Join-Path $Work 'result.txt'
New-Item -ItemType Directory -Force $ServeDir | Out-Null
New-Item -ItemType File -Force $OutFile | Out-Null

$env:TOS_IT_OUT = $OutFile
$env:TOS_IT_SERVE_DIR = $ServeDir
$env:TOS_IT_PORT = "$Port"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$codeArgs = @(
    "--extensionDevelopmentPath=`"$ExtDir`"",
    "--extensionTestsPath=`"$ExtDir\test\integration\index.js`"",
    "--user-data-dir=`"$Work\user-data`"",
    "--extensions-dir=`"$Work\extensions`"",
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--new-window'
)
Write-Host "VS Code: $CodePath"
Write-Host "Work:    $Work"

function Invoke-CodeTest([string[]]$extraArgs) {
    $p = Start-Process -FilePath $CodePath -ArgumentList ($codeArgs + $extraArgs) -PassThru
    if (-not $p.WaitForExit($TimeoutSec * 1000)) {
        Stop-Process -Id $p.Id -Force
        Add-Content $OutFile 'FAIL TIMEOUT' -Encoding UTF8
    }
    return $p.ExitCode
}

# 1단계: 설치·연결·업로드·복구·닫기, 마지막에 다시 연결해 둔 채 종료
$env:TOS_IT_PHASE = '1'
$exit1 = Invoke-CodeTest @()

# 확장 호스트가 끝난 뒤에도 분리 실행한 rclone 데몬이 살아 있는지 확인
$pidFile = Join-Path $Work 'daemon-pid.txt'
$exit2 = 0
if (Test-Path $pidFile) {
    $daemonPid = [int](Get-Content $pidFile)
    Start-Sleep -Seconds 2
    $daemon = Get-Process -Id $daemonPid -ErrorAction SilentlyContinue
    if ($daemon -and $daemon.ProcessName -eq 'rclone') {
        Add-Content $OutFile "PASS 확장 호스트 종료 후 rclone 데몬·마운트 유지 (pid $daemonPid)" -Encoding UTF8

        # 2단계: 생성된 작업 공간 파일로 VS Code를 열어 재연결(attach)·실행 경로 확인
        $rcloneExe = Get-Content (Join-Path $Work 'rclone-path.txt') -Encoding UTF8
        $server = Start-Process -FilePath $rcloneExe -ArgumentList @('serve', 'sftp', "`"$ServeDir`"", '--addr', "127.0.0.1:$Port", '--user', 'tos', '--pass', 'secret', '--config', 'NUL', '--dir-cache-time', '100ms') -WindowStyle Hidden -PassThru
        Start-Sleep -Seconds 2
        $env:TOS_IT_PHASE = '2'
        $workspaceFile = Get-Content (Join-Path $Work 'workspace-file.txt') -Encoding UTF8
        $exit2 = Invoke-CodeTest @("`"$workspaceFile`"")
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    } else {
        Add-Content $OutFile "FAIL 확장 호스트 종료와 함께 rclone 데몬이 종료됨 (pid $daemonPid)" -Encoding UTF8
    }
}

# 남은 테스트용 rclone 정리
Get-CimInstance Win32_Process -Filter "Name='rclone.exe'" | Where-Object { $_.CommandLine -like "*$Work*" } | ForEach-Object {
    $leftPid = [int]$_.ProcessId
    Add-Content $OutFile "INFO 남은 rclone 정리 (pid $leftPid)" -Encoding UTF8
    Stop-Process -Id $leftPid -Force -ErrorAction SilentlyContinue
}

# 3단계: 한국어 표시 언어 (한국어 언어 팩을 격리된 확장 폴더에 설치하고 --locale=ko로 실행)
$exitKo = 0
if (-not $SkipKorean) {
    $codeCli = Join-Path (Split-Path -Parent $CodePath) 'bin\code.cmd'
    & $codeCli --user-data-dir "$Work\user-data" --extensions-dir "$Work\extensions" --install-extension MS-CEINTL.vscode-language-pack-ko 2>$null | Out-Null
    if (Get-ChildItem "$Work\extensions" -Directory -Filter 'ms-ceintl.vscode-language-pack-ko*' -ErrorAction SilentlyContinue) {
        # 확장 테스트 모드에서는 언어 팩 캐시(clp)를 만들지 않으므로 일반 모드로 한 번 실행해 캐시를 만든다
        $warm = Start-Process -FilePath $CodePath -ArgumentList @('--locale=ko', "--user-data-dir=`"$Work\user-data`"", "--extensions-dir=`"$Work\extensions`"", '--new-window', '--disable-workspace-trust', '--skip-welcome') -PassThru
        for ($i = 0; $i -lt 60 -and -not (Test-Path "$Work\user-data\clp\*"); $i++) { Start-Sleep -Milliseconds 500 }
        Start-Sleep -Seconds 2
        Get-CimInstance Win32_Process -Filter "Name='$(Split-Path -Leaf $CodePath)'" | Where-Object { $_.CommandLine -like "*$Work*" } | ForEach-Object { Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue }
        $warm.WaitForExit(10000) | Out-Null
        $env:TOS_IT_PHASE = 'ko'
        $exitKo = Invoke-CodeTest @('--locale=ko')
    } else {
        Add-Content $OutFile 'FAIL [ko] 한국어 언어 팩을 설치하지 못했습니다 (네트워크 확인, 또는 -SkipKorean)' -Encoding UTF8
    }
}

Write-Host "`n--- 결과"
Get-Content $OutFile -Encoding UTF8 | ForEach-Object {
    $color = if ($_ -like 'PASS*') { 'Green' } elseif ($_ -like 'FAIL*') { 'Red' } else { 'Gray' }
    Write-Host $_ -ForegroundColor $color
}

$failed = @(Get-Content $OutFile -Encoding UTF8 | Where-Object { $_ -like 'FAIL*' }).Count
Write-Host "`nVS Code exit code: phase1=$exit1 phase2=$exit2 ko=$exitKo"
if (-not $KeepWork) {
    Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
if ($failed -or $exit1 -ne 0 -or $exit2 -ne 0 -or $exitKo -ne 0) { exit 1 }
