Add-Type -AssemblyName System.IO.Compression.FileSystem
$IC = [System.Globalization.CultureInfo]::InvariantCulture

$SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqcnR0eXp2dmhhdW1kb2N4cGVpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Njc5MDY5MywiZXhwIjoyMDkyMzY2NjkzfQ.NOYBMl97Y9JUtLYuRdm1GwY6MUf1lCwliNeo-m6Nl54"
$ENDPOINT = "https://ejrttyzvvhaumdocxpei.supabase.co/rest/v1/stock_snapshot_daily"
$HDR_INS  = @{ "apikey"=$SUPA_KEY; "Authorization"="Bearer $SUPA_KEY"; "Content-Type"="application/json"; "Prefer"="return=minimal" }

function Get-ColLetter([string]$r) {
  $b = [System.Text.StringBuilder]::new(3)
  foreach ($c in $r.ToCharArray()) { if ([char]::IsLetter($c)) { [void]$b.Append($c) } else { break } }
  return $b.ToString()
}
function EscJ([string]$s) {
  if (-not $s) { return "" }
  $o = [System.Text.StringBuilder]::new($s.Length + 10)
  foreach ($c in $s.ToCharArray()) {
    $n = [int]$c
    if    ($c -eq '"')  { [void]$o.Append('\"') }
    elseif ($c -eq '\') { [void]$o.Append('\\') }
    elseif ($n -eq 13)  { }
    elseif ($n -eq 10)  { [void]$o.Append('\n') }
    elseif ($n -eq 9)   { [void]$o.Append('\t') }
    elseif ($n -ge 32)  { [void]$o.Append($c)   }
  }
  return $o.ToString()
}

$tmp = "$env:TEMP\ss_cap.xlsx"
Copy-Item "\\192.168.5.53\Users\cesar.quispe\erp-sync\stock-snapshots\2026-05-04\stock_todas_las_tiendas_2026-05-04_0800.xlsx" $tmp -Force
Write-Host "Copiado"

$colMap = @{ A=0;B=1;C=2;D=3;E=4;F=5;G=6;H=7;I=8 }
$zip    = [System.IO.Compression.ZipFile]::OpenRead($tmp)
$ent    = $zip.Entries | Where-Object { $_.FullName -eq "xl/worksheets/sheet1.xml" }
$stm    = $ent.Open()
$xr     = [System.Xml.XmlReader]::Create($stm)
$cells  = [string[]]::new(9); $cidx = -1
$batch  = [System.Collections.ArrayList]::new(500)
$nRow   = 0

while ($xr.Read()) {
  $nt = $xr.NodeType
  if ($nt -eq [System.Xml.XmlNodeType]::Element) {
    $ln = $xr.LocalName
    if    ($ln -eq "row") { $cells = [string[]]::new(9); $cidx = -1 }
    elseif ($ln -eq "c")  { $cidx = if ($colMap.ContainsKey((Get-ColLetter $xr.GetAttribute("r")))) { $colMap[(Get-ColLetter $xr.GetAttribute("r"))] } else { -1 } }
    elseif ($ln -eq "v" -and $cidx -ge 0) { $cells[$cidx] = $xr.ReadElementContentAsString(); continue }
  } elseif ($nt -eq [System.Xml.XmlNodeType]::EndElement -and $xr.LocalName -eq "row") {
    $sv = 0.0; [double]::TryParse($cells[6],[System.Globalization.NumberStyles]::Any,$IC,[ref]$sv) | Out-Null
    $iv = 0.0; [double]::TryParse($cells[8],[System.Globalization.NumberStyles]::Any,$IC,[ref]$iv) | Out-Null
    $cv = 0.0; [double]::TryParse($cells[7],[System.Globalization.NumberStyles]::Any,$IC,[ref]$cv) | Out-Null
    if ($cells[3] -and $cells[3] -ne "Cod.Sap" -and ($sv -gt 0 -or $iv -gt 0)) {
      $obj = '{"snapshot_date":"2026-05-04","store_name":"'+(EscJ $cells[2])+'","product_code":"'+(EscJ $cells[3])+'","description":"'+(EscJ $cells[4])+'","unit":"'+(EscJ $cells[5])+'","stock":'+$sv.ToString($IC)+',"cost":'+$cv.ToString($IC)+',"inventory_value":'+$iv.ToString($IC)+'}'
      [void]$batch.Add($obj)
      $nRow++
      if ($batch.Count -ge 500) { break }
    }
  }
}
$xr.Close(); $zip.Dispose()
Write-Host "Recopilados $nRow filas. Guardando batch..."

$json = "[" + ($batch -join ",") + "]"

# Guardar JSON a archivo para inspeccionar
[System.IO.File]::WriteAllText("$env:TEMP\batch_test.json", $json, [System.Text.Encoding]::UTF8)
Write-Host "JSON guardado en $env:TEMP\batch_test.json (largo=$($json.Length))"

# Intentar envio
Write-Host "Enviando..."
try {
  Invoke-RestMethod -Uri $ENDPOINT -Method Post -Headers $HDR_INS -Body $json -ErrorAction Stop | Out-Null
  Write-Host "EXITO" -ForegroundColor Green
} catch {
  $e = $_.ErrorDetails.Message; if (-not $e) { $e = $_.Exception.Message }
  Write-Host "ERROR: $e" -ForegroundColor Red

  # Intentar con encoding explícito UTF-8
  Write-Host "Intentando con UTF-8 bytes..."
  $HDR_UTF8 = @{ "apikey"=$SUPA_KEY; "Authorization"="Bearer $SUPA_KEY"; "Content-Type"="application/json; charset=utf-8"; "Prefer"="return=minimal" }
  try {
    Invoke-WebRequest -Uri $ENDPOINT -Method Post -Headers $HDR_UTF8 -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) -UseBasicParsing -ErrorAction Stop | Out-Null
    Write-Host "EXITO con UTF-8 bytes" -ForegroundColor Green
  } catch {
    $e2 = $_.ErrorDetails.Message; if (-not $e2) { $e2 = $_.Exception.Message }
    Write-Host "ERROR UTF-8: $e2" -ForegroundColor Red
  }
}
