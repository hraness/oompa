$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Fixed Windows CI build only. No caller path, command, download or repair input.
if ($args.Count -ne 0 -or -not $IsWindows -or $env:RUNNER_ARCH -ne 'X64' -or $env:CI -ne 'true') { throw 'WINDOWS_DIRECTORY_BUILD_REFUSED' }
if ($env:ImageVersion -notmatch '^[0-9.]{1,80}$' -or $env:RUNNER_TEMP -notmatch '^[A-Za-z]:\\[^\x00-\x1f]{1,180}$') { throw 'WINDOWS_DIRECTORY_BUILD_REFUSED' }
$source = [IO.Path]::GetFullPath($PSScriptRoot)
$output = Join-Path $env:RUNNER_TEMP 'oompa-windows-directory-build'
if (Test-Path -LiteralPath $output) { throw 'WINDOWS_DIRECTORY_BUILD_ALREADY_EXISTS' }
# Fixed VS2026 root from the observed Windows image inventory in contract.md.
$vs = Join-Path ${env:ProgramFiles} 'Microsoft Visual Studio\18\Enterprise'
$versionPath = Join-Path $vs 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt'
$toolsVersion = ([IO.File]::ReadAllText($versionPath)).Trim()
if ($toolsVersion -notmatch '^14\.[0-9.]{1,32}$') { throw 'WINDOWS_DIRECTORY_COMPILER_REFUSED' }
$tools = Join-Path $vs "VC\Tools\MSVC\$toolsVersion"
$compiler = Join-Path $tools 'bin\Hostx64\x64\cl.exe'
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$sdkVersion = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Include') -Directory |
  Where-Object { $_.Name -match '^10\.0\.[0-9]+\.0$' } |
  Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1 -ExpandProperty Name
if (-not $sdkVersion -or -not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'WINDOWS_DIRECTORY_SDK_REFUSED' }
$inputs = @('directory-security.h', 'directory-security.c', 'directory-security.fixture.c', 'build-fixture.ps1')
function Get-Inputs {
  @($inputs | ForEach-Object {
    $path = Join-Path $source $_
    $item = Get-Item -LiteralPath $path
    if ($item.Length -gt 131072 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'WINDOWS_DIRECTORY_SOURCE_REFUSED' }
    [ordered]@{ path = $_; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
  })
}
function Get-ToolIdentity {
  $toolVersion = (Get-Item -LiteralPath $compiler).VersionInfo.FileVersion
  if ($toolVersion -notmatch '^[0-9. ]{1,80}$') { throw 'WINDOWS_DIRECTORY_COMPILER_VERSION_REFUSED' }
  [ordered]@{ compilerVersion = $toolVersion.Trim();
    compilerSha256 = (Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash.ToLowerInvariant();
    sdkHeaderSha256 = (Get-FileHash -LiteralPath (Join-Path $sdkRoot "Include\$sdkVersion\um\winnt.h") -Algorithm SHA256).Hash.ToLowerInvariant() }
}
function Get-CompilerDiagnostics([IO.MemoryStream[]] $captured) {
  $diagnostics = [Collections.Generic.List[object]]::new()
  # Raw diagnostics never leave memory. Only these public source names and
  # bounded numeric locations/codes may enter a failed-build summary.
  foreach ($stream in $captured) {
    foreach ($line in ([Text.Encoding]::UTF8.GetString($stream.ToArray()) -split "`n")) {
      foreach ($name in @('directory-security.h', 'directory-security.c', 'directory-security.fixture.c')) {
        $location = '(?:' + [regex]::Escape((Join-Path $source $name)) + '|' + [regex]::Escape($name) + ')'
        $pattern = '^' + $location + '\(([1-9][0-9]{0,5})(?:,([1-9][0-9]{0,5}))?\)[ \t]{0,8}:[ \t]{0,8}(fatal error|error|warning)[ \t]{1,8}((?:C|D|LNK)[0-9]{4})[ \t]{0,8}:'
        if ($line -cmatch $pattern) {
          $diagnostics.Add([ordered]@{ tool = 'cl'; source = $name; line = [int]$Matches[1];
            column = if ($Matches.ContainsKey(2)) { [int]$Matches[2] } else { $null };
            severity = $Matches[3]; code = $Matches[4] })
          if ($diagnostics.Count -ge 32) { return $diagnostics.ToArray() }
          break
        }
      }
      if ($line -cmatch '^(cl|LINK)[ \t]{0,8}:[ \t]{0,8}(Command line error|Command line warning|fatal error|error|warning)[ \t]{1,8}((?:C|D|LNK)[0-9]{4})[ \t]{0,8}:') {
        $severity = switch -CaseSensitive ($Matches[2]) {
          'Command line error' { 'error' }
          'Command line warning' { 'warning' }
          default { $Matches[2] }
        }
        $diagnostics.Add([ordered]@{ tool = $Matches[1]; source = $null; line = $null; column = $null;
          severity = $severity; code = $Matches[3] })
        if ($diagnostics.Count -ge 32) { return $diagnostics.ToArray() }
      }
    }
  }
  return $diagnostics.ToArray()
}
$before = Get-Inputs
$toolBefore = Get-ToolIdentity
$include = @((Join-Path $tools 'include')) + @('ucrt','shared','um','winrt' | ForEach-Object { Join-Path $sdkRoot "Include\$sdkVersion\$_" })
$libs = @((Join-Path $tools 'lib\x64'), (Join-Path $sdkRoot "Lib\$sdkVersion\ucrt\x64"), (Join-Path $sdkRoot "Lib\$sdkVersion\um\x64"))
foreach ($directory in @($include + $libs)) { if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'WINDOWS_DIRECTORY_SDK_REFUSED' } }
$null = New-Item -ItemType Directory -Path $output
$executable = Join-Path $output 'directory-security.fixture.exe'
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $compiler
$start.WorkingDirectory = $output
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.CreateNoWindow = $true
# MSVC consumes CL/_CL_ and linker/environment search options. Inherit none.
$start.Environment.Clear()
$start.Environment['SystemRoot'] = $env:SystemRoot
$start.Environment['WINDIR'] = $env:SystemRoot
$start.Environment['TEMP'] = $output
$start.Environment['TMP'] = $output
$start.Environment['INCLUDE'] = $include -join ';'
$start.Environment['LIB'] = $libs -join ';'
$start.Environment['PATH'] = (Split-Path $compiler) + ';' + $env:SystemRoot + '\System32'
foreach ($argument in @('/nologo','/std:c17','/W4','/WX','/O1','/GS','/guard:cf','/DWD_TESTING','/DUNICODE','/D_UNICODE','/D_WIN32_WINNT=0x0A00',
  (Join-Path $source 'directory-security.c'), (Join-Path $source 'directory-security.fixture.c'),
  "/Fe:$executable", "/Fo:$output\", '/link','/DYNAMICBASE','/NXCOMPAT','/GUARD:CF','advapi32.lib','ole32.lib')) { $start.ArgumentList.Add($argument) }
$child = [Diagnostics.Process]::new()
$child.StartInfo = $start
$started = $false
$joined = $false
$bytes = 0
$captured = @([IO.MemoryStream]::new(), [IO.MemoryStream]::new())
$clock = [Diagnostics.Stopwatch]::StartNew()
try {
  $started = $child.Start()
  if (-not $started) { throw 'WINDOWS_DIRECTORY_COMPILER_START_REFUSED' }
  $streams = @($child.StandardOutput.BaseStream, $child.StandardError.BaseStream)
  $buffers = @([byte[]]::new(4096), [byte[]]::new(4096))
  $reads = @($streams[0].ReadAsync($buffers[0], 0, 4096), $streams[1].ReadAsync($buffers[1], 0, 4096))
  $eof = @($false, $false)
  while (-not $child.HasExited -or -not ($eof[0] -and $eof[1])) {
    if ($clock.ElapsedMilliseconds -ge 60000) { throw 'WINDOWS_DIRECTORY_COMPILER_DEADLINE' }
    for ($index = 0; $index -lt 2; $index++) {
      if (-not $eof[$index] -and $reads[$index].IsCompleted) {
        $count = $reads[$index].GetAwaiter().GetResult()
        $bytes += $count
        if ($bytes -gt 131072) { throw 'WINDOWS_DIRECTORY_COMPILER_OUTPUT_LIMIT' }
        if ($count -eq 0) { $eof[$index] = $true }
        else {
          $captured[$index].Write($buffers[$index], 0, $count)
          $reads[$index] = $streams[$index].ReadAsync($buffers[$index], 0, 4096)
        }
      }
    }
    if (-not $child.HasExited -or -not ($eof[0] -and $eof[1])) { Start-Sleep -Milliseconds 10 }
  }
  $joined = $true
  if ($child.ExitCode -ne 0) {
    [ordered]@{ schema = 1; source = 'credential_free_win32_compile_failure';
      compilerExit = $child.ExitCode; compilerStdoutEof = $true; compilerStderrEof = $true;
      outputBytes = $bytes; diagnostics = @(Get-CompilerDiagnostics $captured) } | ConvertTo-Json -Depth 5 -Compress
    throw 'WINDOWS_DIRECTORY_COMPILER_FAILED'
  }
  $after = Get-Inputs
  if (($before | ConvertTo-Json -Compress) -cne ($after | ConvertTo-Json -Compress)) { throw 'WINDOWS_DIRECTORY_SOURCE_CHANGED' }
  $toolAfter = Get-ToolIdentity
  if (($toolBefore | ConvertTo-Json -Compress) -cne ($toolAfter | ConvertTo-Json -Compress)) { throw 'WINDOWS_DIRECTORY_TOOLCHAIN_CHANGED' }
  $proof = [ordered]@{ schema = 1; source = 'credential_free_win32_build'; imageVersion = $env:ImageVersion;
    compilerVersion = $toolBefore.compilerVersion; compilerSha256 = $toolBefore.compilerSha256;
    toolsVersion = $toolsVersion; sdkVersion = $sdkVersion;
    sdkHeaderSha256 = $toolBefore.sdkHeaderSha256;
    executableSha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant();
    inputs = $after; compilerExit = 0; compilerStdoutEof = $true; compilerStderrEof = $true; outputBytes = $bytes }
  [IO.File]::WriteAllText((Join-Path $output 'build.json'), (($proof | ConvertTo-Json -Depth 5 -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
  $proof | ConvertTo-Json -Depth 5 -Compress
} finally {
  if ($started -and -not $joined) {
    # The exact compiler/tree is terminated once; no uncertain build is admitted
    # or automatically retried. CI retains its fresh build directory.
    if (-not $child.HasExited) { $child.Kill($true) }
    if (-not $child.WaitForExit(5000)) { throw 'WINDOWS_DIRECTORY_COMPILER_CLEANUP_UNCERTAIN' }
  }
  $child.Dispose()
  foreach ($stream in $captured) { $stream.Dispose() }
}
