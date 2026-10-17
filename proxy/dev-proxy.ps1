# ROOMFIT local Gemini proxy — keeps GEMINI_API_KEY out of the browser.
# Windows PowerShell 5.1+, no other runtime needed.
#
#   $env:GEMINI_API_KEY = "your-key"        # or put GEMINI_API_KEY=... in ..\.env
#   powershell -ExecutionPolicy Bypass -File proxy\dev-proxy.ps1
#
# Then in ROOMFIT: Settings → Proxy URL → http://localhost:8787
# Images are forwarded to Gemini for one request and never written to disk.

param([int]$Port = 8787, [string]$Model = $(if ($env:GEMINI_MODEL) { $env:GEMINI_MODEL } else { 'gemini-2.5-flash' }))

$ErrorActionPreference = 'Stop'
if (-not $env:GEMINI_API_KEY) {
  $envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
  if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
      if ($line -match '^\s*GEMINI_API_KEY\s*=\s*(.+)\s*$') { $env:GEMINI_API_KEY = $Matches[1].Trim('"', "'", ' ') }
      if ($line -match '^\s*GEMINI_MODEL\s*=\s*(.+)\s*$') { $Model = $Matches[1].Trim('"', "'", ' ') }
    }
  }
}
if (-not $env:GEMINI_API_KEY) { Write-Error 'Set GEMINI_API_KEY (environment variable or .env file).'; exit 1 }

$allowedTasks = @('analyzeRoom', 'parseRequirements', 'explainLayout', 'readSpec', 'parseProductRequest')
$geminiUri = "https://generativelanguage.googleapis.com/v1beta/models/$($Model):generateContent"

# Same prompt as proxy/worker.js (productSearchPrompt). Keep them in sync.
$productPrompt = @'
You are the product-retrieval step of ROOMFIT, a furniture fit checker for homes in India.
Use Google Search to find furniture currently listed for sale (prefer Indian retailers and INR prices) that matches the request.

Rules — follow exactly:
- Only include products from pages you actually found in search results. productUrl must be the exact product page URL from those results.
- Never invent or estimate a value. If the page doesn't state it, use null.
- Dimensions in centimetres as printed on the listing (convert inches/mm/feet exactly). Copy the printed text into dimensionsText.
- dimensionsVerified = true only if the listing explicitly states width, depth and height.
- price = listed selling price in INR as a number. availability only if the page states it.
- Prefer products whose listed width/depth respect spatialConstraints, but list what you find; ROOMFIT checks fit itself.
- Do not include products named in excludeNames. Return at most 8 products.

Return ONLY a JSON object, no prose:
{"products":[{"name":"","brand":null,"retailer":"","category":"","price":null,"currency":"INR","dimensions":{"widthCm":null,"depthCm":null,"heightCm":null},"dimensionsText":null,"dimensionsVerified":false,"productUrl":"","sourceUrl":"","imageUrl":null,"description":null,"features":[],"material":null,"color":null,"availability":null}]}

Request: __REQUEST__
Room (dimensions only): __ROOM__
'@

function CallGemini([string]$json) {
  $out = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $geminiUri -Headers @{ 'x-goog-api-key' = $env:GEMINI_API_KEY } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json))
  return [Text.Encoding]::UTF8.GetString($out.RawContentStream.ToArray())
}

function CheckLink([string]$url) {
  if ($url -notmatch '^https://') { return 'unknown' }
  foreach ($method in @('Head', 'Get')) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Method $method -Uri $url -MaximumRedirection 5 -TimeoutSec 5 -Headers @{ 'User-Agent' = 'Mozilla/5.0 ROOMFIT link check' }
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) { return 'ok' }
    } catch {
      $code = 0
      if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
      if ($code -eq 404 -or $code -eq 410) { return 'missing' }
      if ($code -ne 405 -and $code -ne 403) { return 'unknown' }
    }
  }
  return 'unknown'
}
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "ROOMFIT Gemini proxy on http://localhost:$Port  (model: $Model). Ctrl+C to stop."

function Send($ctx, [int]$code, [string]$body) {
  $res = $ctx.Response
  $res.StatusCode = $code
  $res.Headers.Add('Access-Control-Allow-Origin', '*')
  $res.Headers.Add('Access-Control-Allow-Headers', 'Content-Type')
  $res.Headers.Add('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  $res.Headers.Add('Cache-Control', 'no-store')
  $res.ContentType = 'application/json'
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
  $res.Close()
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    try {
      if ($req.HttpMethod -eq 'OPTIONS') { Send $ctx 204 ''; continue }
      if ($req.Url.AbsolutePath -eq '/health') { Send $ctx 200 '{"ok":true}'; continue }
      $path = $req.Url.AbsolutePath
      if ($req.HttpMethod -ne 'POST' -or ($path -ne '/gemini' -and $path -ne '/api/products/search')) { Send $ctx 404 '{"error":"not found"}'; continue }
      if ($req.ContentLength64 -gt 20MB) { Send $ctx 413 '{"error":"request too large"}'; continue }
      $reader = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
      $raw = $reader.ReadToEnd()
      $in = $raw | ConvertFrom-Json

      if ($path -eq '/api/products/search') {
        if (-not $in.request) { Send $ctx 400 '{"error":"missing request"}'; continue }
        $reqJson = ($in.request | ConvertTo-Json -Depth 20 -Compress)
        $roomJson = ($in.roomContext | ConvertTo-Json -Depth 20 -Compress)
        if ($reqJson.Length -gt 4000) { $reqJson = $reqJson.Substring(0, 4000) }
        if ($roomJson.Length -gt 4000) { $roomJson = $roomJson.Substring(0, 4000) }
        $prompt = $productPrompt.Replace('__REQUEST__', $reqJson).Replace('__ROOM__', $roomJson)
        $body = @{ contents = @(@{ role = 'user'; parts = @(@{ text = $prompt }) }); tools = @(@{ google_search = @{} }); generationConfig = @{ temperature = 0.1 } } | ConvertTo-Json -Depth 10 -Compress
        $gem = CallGemini $body
        $checks = @{}
        try {
          $g = $gem | ConvertFrom-Json
          $text = ($g.candidates[0].content.parts | ForEach-Object { $_.text }) -join ''
          $text = $text -replace '```json', '' -replace '```', ''
          $a = $text.IndexOf('{'); $b = $text.LastIndexOf('}')
          if ($a -ge 0 -and $b -gt $a) {
            $products = ($text.Substring($a, $b - $a + 1) | ConvertFrom-Json).products
            foreach ($p in @($products | Select-Object -First 10)) {
              if ($p.productUrl -and -not $checks.ContainsKey($p.productUrl)) { $checks[$p.productUrl] = CheckLink $p.productUrl }
            }
          }
        } catch { Write-Host "could not read products for link checks: $($_.Exception.Message)" }
        $checksJson = if ($checks.Count) { $checks | ConvertTo-Json -Compress } else { '{}' }
        $stamp = (Get-Date).ToUniversalTime().ToString('o')
        Write-Host ("{0:HH:mm:ss} product search -> {1} links checked" -f (Get-Date), $checks.Count)
        Send $ctx 200 ('{"searchedAt":"' + $stamp + '","linkChecks":' + $checksJson + ',"gemini":' + $gem + '}')
        continue
      }

      if ($allowedTasks -notcontains $in.task) { Send $ctx 400 '{"error":"unknown task"}'; continue }
      $payload = $in.body | ConvertTo-Json -Depth 40 -Compress
      $content = CallGemini $payload
      Write-Host ("{0:HH:mm:ss} {1}" -f (Get-Date), $in.task)
      Send $ctx 200 $content
    } catch {
      Write-Host ("{0:HH:mm:ss} error: {1}" -f (Get-Date), $_.Exception.Message)
      try { Send $ctx 502 '{"error":"upstream failure"}' } catch { }
    }
  }
} finally { $listener.Stop() }
