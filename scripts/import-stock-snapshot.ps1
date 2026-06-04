param(
  [string]$Date     = "",
  [switch]$Backfill = $false
)

$SUPA_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqcnR0eXp2dmhhdW1kb2N4cGVpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Njc5MDY5MywiZXhwIjoyMDkyMzY2NjkzfQ.NOYBMl97Y9JUtLYuRdm1GwY6MUf1lCwliNeo-m6Nl54"
$SHARE     = "\\192.168.5.53\Users\cesar.quispe\erp-sync\stock-snapshots"
$ENDPOINT  = "https://ejrttyzvvhaumdocxpei.supabase.co/rest/v1/stock_snapshot_daily"
$BSIZE     = 500

$HDR_INS = @{
  "apikey"        = $SUPA_KEY
  "Authorization" = "Bearer $SUPA_KEY"
  "Content-Type"  = "application/json"
  "Prefer"        = "return=minimal,resolution=merge-duplicates"
}
$HDR_DEL = @{
  "apikey"        = $SUPA_KEY
  "Authorization" = "Bearer $SUPA_KEY"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$IC = [System.Globalization.CultureInfo]::InvariantCulture

function Get-ColLetter([string]$ref) {
  $sb = [System.Text.StringBuilder]::new(3)
  foreach ($ch in $ref.ToCharArray()) {
    if ([char]::IsLetter($ch)) { [void]$sb.Append($ch) } else { break }
  }
  return $sb.ToString()
}

function EscJ([string]$s) {
  if (-not $s) { return "" }
  $out = [System.Text.StringBuilder]::new($s.Length + 10)
  foreach ($ch in $s.ToCharArray()) {
    $code = [int]$ch
    if    ($ch -eq '"')         { [void]$out.Append('\"') }
    elseif ($ch -eq '\')        { [void]$out.Append('\\') }
    elseif ($code -eq 13)       { }
    elseif ($code -eq 10)       { [void]$out.Append('\n') }
    elseif ($code -eq 9)        { [void]$out.Append('\t') }
    elseif ($code -ge 32)       { [void]$out.Append($ch)  }
  }
  return $out.ToString()
}

function Send-Batch([System.Collections.ArrayList]$items, [string]$day) {
  $json  = "[" + ($items -join ",") + "]"
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  try {
    # Invoke-RestMethod en PS5.1 usa Windows-1252; WebRequest con bytes UTF-8 evita la corrupcion de acentos
    $r = Invoke-WebRequest -Uri $ENDPOINT -Method Post -Headers $HDR_INS `
           -Body $bytes -UseBasicParsing -ErrorAction Stop
    if ($r.StatusCode -ge 300) { throw "HTTP $($r.StatusCode)" }
    return $true
  } catch {
    $e = $_.ErrorDetails.Message; if (-not $e) { $e = $_.Exception.Message }
    Write-Host "  Lote error: $e" -ForegroundColor Red
    return $false
  }
}

function Import-Day([string]$xlPath, [string]$day) {
  $t0 = Get-Date
  Write-Host "$day  $(Split-Path $xlPath -Leaf)" -ForegroundColor Cyan

  $tmpId = [System.Guid]::NewGuid().ToString("N").Substring(0,8)
  $tmp   = "$env:TEMP\ss_$tmpId.xlsx"
  Copy-Item $xlPath $tmp -Force
  $tc = [math]::Round(((Get-Date)-$t0).TotalSeconds,1)
  Write-Host "  copy ${tc}s  parsing..."

  $zip = [System.IO.Compression.ZipFile]::OpenRead($tmp)
  $ent = $zip.Entries | Where-Object { $_.FullName -eq "xl/worksheets/sheet1.xml" }
  $stm = $ent.Open()
  $xr  = [System.Xml.XmlReader]::Create($stm)

  $colMap = @{ A=0;B=1;C=2;D=3;E=4;F=5;G=6;H=7;I=8 }
  $cells  = [string[]]::new(9)
  $cidx   = -1

  $batch  = [System.Collections.ArrayList]::new($BSIZE)
  $nRow   = 0
  $nBatch = 0
  $nErr   = 0

  while ($xr.Read()) {
    $nt = $xr.NodeType
    if ($nt -eq [System.Xml.XmlNodeType]::Element) {
      $ln = $xr.LocalName
      if ($ln -eq "row") {
        $cells = [string[]]::new(9); $cidx = -1
      } elseif ($ln -eq "c") {
        $cidx = if ($colMap.ContainsKey((Get-ColLetter $xr.GetAttribute("r")))) { $colMap[(Get-ColLetter $xr.GetAttribute("r"))] } else { -1 }
      } elseif ($ln -eq "v" -and $cidx -ge 0) {
        $cells[$cidx] = $xr.ReadElementContentAsString()
        continue
      }
    } elseif ($nt -eq [System.Xml.XmlNodeType]::EndElement -and $xr.LocalName -eq "row") {
      $sku   = $cells[3]
      $store = $cells[2]
      if ($sku -and $store -and $sku -ne "Cod.Sap") {
        $sv = 0.0; [double]::TryParse($cells[6],[System.Globalization.NumberStyles]::Any,$IC,[ref]$sv) | Out-Null
        $cv = 0.0; [double]::TryParse($cells[7],[System.Globalization.NumberStyles]::Any,$IC,[ref]$cv) | Out-Null
        $iv = 0.0; [double]::TryParse($cells[8],[System.Globalization.NumberStyles]::Any,$IC,[ref]$iv) | Out-Null
        if ($sv -gt 0 -or $iv -gt 0) {
          $obj = '{"snapshot_date":"' + $day              + '",' +
                 '"store_name":"'     + (EscJ $store)     + '",' +
                 '"product_code":"'   + (EscJ $sku)       + '",' +
                 '"description":"'    + (EscJ $cells[4])  + '",' +
                 '"unit":"'           + (EscJ $cells[5])  + '",' +
                 '"stock":'           + $sv.ToString($IC) + ',' +
                 '"cost":'            + $cv.ToString($IC) + ',' +
                 '"inventory_value":' + $iv.ToString($IC) + '}'
          [void]$batch.Add($obj)
          $nRow++
          if ($batch.Count -ge $BSIZE) {
            $nBatch++
            if (-not (Send-Batch $batch $day)) { $nErr++ }
            $batch.Clear()
          }
        }
      }
    }
  }
  if ($batch.Count -gt 0) {
    $nBatch++
    if (-not (Send-Batch $batch $day)) { $nErr++ }
  }

  $xr.Close(); $zip.Dispose()
  try { [System.IO.File]::Delete($tmp) } catch {}

  $el = [math]::Round(((Get-Date)-$t0).TotalSeconds,1)
  Write-Host ("  {0} filas  {1} lotes  {2} errores  {3}s" -f $nRow,$nBatch,$nErr,$el) -ForegroundColor Green
}

function Get-Xlsx([string]$d) {
  $f = Get-ChildItem (Join-Path $SHARE $d) -Filter "*.xlsx" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($f) { return $f.FullName } else { return $null }
}

function Delete-Day([string]$d) {
  try { Invoke-RestMethod -Uri ($ENDPOINT + "?snapshot_date=eq." + $d) -Method Delete -Headers $HDR_DEL | Out-Null } catch {}
}

if ($Backfill) {
  $dirs = Get-ChildItem $SHARE -Directory | Sort-Object Name
  Write-Host "Backfill $($dirs.Count) dias..." -ForegroundColor Yellow
  foreach ($dir in $dirs) {
    $xl = Get-Xlsx $dir.Name
    if ($xl) { Delete-Day $dir.Name; Import-Day $xl $dir.Name }
    else      { Write-Host "  $($dir.Name): sin xlsx" }
  }
  Write-Host "Backfill listo." -ForegroundColor Green

} elseif ($Date -ne "") {
  $xl = Get-Xlsx $Date
  if ($xl) { Delete-Day $Date; Import-Day $xl $Date }
  else      { Write-Host "Sin archivo para $Date" -ForegroundColor Red; exit 1 }

} else {
  $d  = Get-Date -Format "yyyy-MM-dd"
  $xl = Get-Xlsx $d
  if ($xl) { Delete-Day $d; Import-Day $xl $d }
  else      { Write-Host "Sin archivo para hoy ($d)" -ForegroundColor Red; exit 1 }
}
