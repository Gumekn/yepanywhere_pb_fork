function Test-ServicePortValue($value) {
  if (-not ($value -is [string] -or $value -is [int] -or $value -is [long])) {
    return $false
  }
  $parsed = 0
  return [int]::TryParse([string]$value, [ref]$parsed) -and $parsed -ge 1 -and $parsed -le 65535
}

function Test-NullableServiceString($value) {
  if ($null -eq $value) { return $true }
  return $value -is [string] -and -not [string]::IsNullOrWhiteSpace($value)
}

function Set-ServiceProxyEnvironment($internetSettings = $null) {
  if ($null -eq $internetSettings) {
    try {
      $internetSettings = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction Stop
    } catch {
      return $false
    }
  }
  if ([int]$internetSettings.ProxyEnable -ne 1) { return $false }

  $proxyServer = [string]$internetSettings.ProxyServer
  if ([string]::IsNullOrWhiteSpace($proxyServer)) { return $false }
  $proxyServer = $proxyServer.Trim()
  if ($proxyServer.Contains("=")) {
    $protocolProxies = @{}
    foreach ($entry in ($proxyServer -split ";")) {
      $parts = $entry -split "=", 2
      if ($parts.Count -eq 2) {
        $protocolProxies[$parts[0].Trim().ToLowerInvariant()] = $parts[1].Trim()
      }
    }
    foreach ($protocol in @("https", "http")) {
      if ($protocolProxies.ContainsKey($protocol) -and $protocolProxies[$protocol]) {
        $proxyServer = [string]$protocolProxies[$protocol]
        break
      }
    }
  }
  if ($proxyServer -notmatch "^[a-z][a-z0-9+.-]*://") {
    $proxyServer = "http://$proxyServer"
  }
  $proxyUri = $null
  if (-not [Uri]::TryCreate($proxyServer, [UriKind]::Absolute, [ref]$proxyUri) -or
      $proxyUri.Scheme -notin @("http", "https")) {
    return $false
  }

  $changed = $false
  foreach ($name in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY")) {
    if (-not [Environment]::GetEnvironmentVariable($name, "Process")) {
      [Environment]::SetEnvironmentVariable($name, $proxyUri.AbsoluteUri, "Process")
      $changed = $true
    }
  }
  $noProxy = @([string]$env:NO_PROXY -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  foreach ($localAddress in @("127.0.0.1", "localhost", "::1")) {
    if ($noProxy -notcontains $localAddress) { $noProxy += $localAddress }
  }
  $env:NO_PROXY = $noProxy -join ","
  return $changed
}

function Test-ServiceConfigSchema($config) {
  if ($null -eq $config -or $config -is [array]) { return $false }
  $required = @("Version", "ServerPort", "BasePath", "Profile", "DataDir", "AllowedImagePaths", "CodexPort", "ClaudePort")
  foreach ($propertyName in $required) {
    if ($config.PSObject.Properties.Name -notcontains $propertyName) { return $false }
  }
  if (-not ($config.Version -is [int]) -or $config.Version -ne 1) { return $false }
  foreach ($propertyName in @("ServerPort", "CodexPort", "ClaudePort")) {
    if (-not (Test-ServicePortValue $config.$propertyName)) { return $false }
  }
  if (-not ($config.BasePath -is [string]) -or
      [string]::IsNullOrWhiteSpace($config.BasePath) -or
      -not $config.BasePath.StartsWith("/")) {
    return $false
  }
  foreach ($propertyName in @("Profile", "DataDir", "AllowedImagePaths", "ReportsDir")) {
    if (-not (Test-NullableServiceString $config.$propertyName)) { return $false }
  }
  return $true
}

function Assert-ServiceConfigSchema($config, $path) {
  if (-not (Test-ServiceConfigSchema $config)) {
    throw "Invalid production service configuration schema: $path"
  }
}
