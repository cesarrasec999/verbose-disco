Add-Type -AssemblyName System.IO.Compression.FileSystem

$tmp = "$env:TEMP\ss_debug2.xlsx"
Copy-Item "\\192.168.5.53\Users\cesar.quispe\erp-sync\stock-snapshots\2026-05-04\stock_todas_las_tiendas_2026-05-04_0800.xlsx" $tmp -Force

$zip = [System.IO.Compression.ZipFile]::OpenRead($tmp)
$ent = $zip.Entries | Where-Object { $_.FullName -eq "xl/worksheets/sheet1.xml" }
$stm = $ent.Open()
$xr  = [System.Xml.XmlReader]::Create($stm)

$colMap = @{ A=0;B=1;C=2;D=3;E=4;F=5;G=6;H=7;I=8 }
$cells  = [string[]]::new(9)
$cidx   = -1

function Get-ColLetter([string]$ref) {
  $sb2 = [System.Text.StringBuilder]::new()
  foreach ($ch in $ref.ToCharArray()) {
    if ([char]::IsLetter($ch)) { [void]$sb2.Append($ch) } else { break }
  }
  return $sb2.ToString()
}

function EscJ([string]$s) {
  if (-not $s) { return "" }
  $s = $s.Replace('\','\\').Replace('"','\"').Replace("`r",'').Replace("`n",'\n').Replace("`t",'\t')
  # Eliminar otros control chars
  $clean = [System.Text.StringBuilder]::new()
  foreach ($ch in $s.ToCharArray()) {
    if ([int]$ch -ge 32) { [void]$clean.Append($ch) }
  }
  return $clean.ToString()
}

$found = 0
$rows  = [System.Collections.ArrayList]::new()

while ($xr.Read() -and $found -lt 5) {
  $nt = $xr.NodeType
  if ($nt -eq [System.Xml.XmlNodeType]::Element) {
    $ln = $xr.LocalName
    if ($ln -eq "row") { $cells = [string[]]::new(9); $cidx = -1 }
    elseif ($ln -eq "c") { $cidx = if ($colMap.ContainsKey((Get-ColLetter $xr.GetAttribute("r")))) { $colMap[(Get-ColLetter $xr.GetAttribute("r"))] } else { -1 } }
    elseif ($ln -eq "v" -and $cidx -ge 0) { $cells[$cidx] = $xr.ReadElementContentAsString(); continue }
  } elseif ($nt -eq [System.Xml.XmlNodeType]::EndElement -and $xr.LocalName -eq "row") {
    $sv = 0.0; [double]::TryParse($cells[6],[System.Globalization.NumberStyles]::Any,[System.Globalization.CultureInfo]::InvariantCulture,[ref]$sv) | Out-Null
    $cv = 0.0; [double]::TryParse($cells[7],[System.Globalization.NumberStyles]::Any,[System.Globalization.CultureInfo]::InvariantCulture,[ref]$cv) | Out-Null
    $iv = 0.0; [double]::TryParse($cells[8],[System.Globalization.NumberStyles]::Any,[System.Globalization.CultureInfo]::InvariantCulture,[ref]$iv) | Out-Null
    if ($cells[3] -and $cells[3] -ne "Cod.Sap" -and ($sv -gt 0 -or $iv -gt 0)) {
      $ic = [System.Globalization.CultureInfo]::InvariantCulture
      $obj = '{"snapshot_date":"2026-05-04",' +
             '"store_name":"'      + (EscJ $cells[2]) + '",' +
             '"product_code":"'    + (EscJ $cells[3]) + '",' +
             '"description":"'     + (EscJ $cells[4]) + '",' +
             '"unit":"'            + (EscJ $cells[5]) + '",' +
             '"stock":'            + $sv.ToString($ic) + ',' +
             '"cost":'             + $cv.ToString($ic) + ',' +
             '"inventory_value":' + $iv.ToString($ic) + '}'
      [void]$rows.Add($obj)
      $found++
    }
  }
}
$xr.Close(); $zip.Dispose()

Write-Host "Primeros $found registros validos:"
$rows | ForEach-Object { Write-Host $_ }

# Enviar como JSON array
$json = "[" + ($rows -join ",") + "]"
Write-Host ""
Write-Host "JSON a enviar:"
Write-Host $json

$SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqcnR0eXp2dmhhdW1kb2N4cGVpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Njc5MDY5MywiZXhwIjoyMDkyMzY2NjkzfQ.NOYBMl97Y9JUtLYuRdm1GwY6MUf1lCwliNeo-m6Nl54"
$EP  = "https://ejrttyzvvhaumdocxpei.supabase.co/rest/v1/stock_snapshot_daily"
$HDR = @{
  "apikey"        = $SUPA_KEY
  "Authorization" = "Bearer $SUPA_KEY"
  "Content-Type"  = "application/json"
  "Prefer"        = "return=minimal"
}
try {
  Invoke-RestMethod -Uri $EP -Method Post -Headers $HDR -Body $json -ErrorAction Stop | Out-Null
  Write-Host "INSERT OK" -ForegroundColor Green
} catch {
  Write-Host "ERROR: $($_.ErrorDetails.Message)" -ForegroundColor Red
}
