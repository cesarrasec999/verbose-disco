Add-Type -AssemblyName System.IO.Compression.FileSystem

$xlPath = "\\192.168.5.53\Users\cesar.quispe\erp-sync\stock-snapshots\2026-05-04\stock_todas_las_tiendas_2026-05-04_0800.xlsx"
$tmp = "$env:TEMP\ss_debug.xlsx"
Copy-Item $xlPath $tmp -Force
Write-Host "Copiado OK"

$zip = [System.IO.Compression.ZipFile]::OpenRead($tmp)
$ent = $zip.Entries | Where-Object { $_.FullName -eq "xl/worksheets/sheet1.xml" }
$stm = $ent.Open()
$xr  = [System.Xml.XmlReader]::Create($stm)

$colMap = @{ A=0;B=1;C=2;D=3;E=4;F=5;G=6;H=7;I=8 }
$cells  = [string[]]::new(9)
$cidx   = -1
$found  = 0
$total  = 0

# Funcion para extraer letra de columna sin regex
function Get-ColLetter([string]$ref) {
  $sb = [System.Text.StringBuilder]::new()
  foreach ($ch in $ref.ToCharArray()) {
    if ([char]::IsLetter($ch)) { $sb.Append($ch) | Out-Null } else { break }
  }
  return $sb.ToString()
}

while ($xr.Read()) {
  $nt = $xr.NodeType
  if ($nt -eq [System.Xml.XmlNodeType]::Element) {
    $ln = $xr.LocalName
    if ($ln -eq "row") {
      $cells = [string[]]::new(9); $cidx = -1; $total++
    } elseif ($ln -eq "c") {
      $col  = Get-ColLetter $xr.GetAttribute("r")
      $cidx = if ($colMap.ContainsKey($col)) { $colMap[$col] } else { -1 }
    } elseif ($ln -eq "v" -and $cidx -ge 0) {
      $cells[$cidx] = $xr.ReadElementContentAsString()
      continue
    }
  } elseif ($nt -eq [System.Xml.XmlNodeType]::EndElement -and $xr.LocalName -eq "row") {
    $sv = 0.0; [double]::TryParse($cells[6],[ref]$sv) | Out-Null
    $iv = 0.0; [double]::TryParse($cells[8],[ref]$iv) | Out-Null
    if ($cells[3] -and $cells[3] -ne "Cod.Sap" -and ($sv -gt 0 -or $iv -gt 0)) {
      $found++
      if ($found -le 3) {
        Write-Host "ROW $total store='$($cells[2])' sku='$($cells[3])' stock=$sv cost=$($cells[7]) iv=$iv"
      }
    }
  }
  if ($total -gt 5000) { break }   # solo las primeras 5000 filas
}

$xr.Close(); $zip.Dispose()
Write-Host "Procesadas $total filas - encontradas $found con stock>0"

# Construir un JSON de prueba con los primeros datos encontrados
# y enviarlo a Supabase para ver si el error es del contenido o de otro lado
$SUPA_URL = "https://ejrttyzvvhaumdocxpei.supabase.co"
$SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqcnR0eXp2dmhhdW1kb2N4cGVpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Njc5MDY5MywiZXhwIjoyMDkyMzY2NjkzfQ.NOYBMl97Y9JUtLYuRdm1GwY6MUf1lCwliNeo-m6Nl54"
$EP = "$SUPA_URL/rest/v1/stock_snapshot_daily"
$HDR = @{
  "apikey"        = $SUPA_KEY
  "Authorization" = "Bearer $SUPA_KEY"
  "Content-Type"  = "application/json"
  "Prefer"        = "return=minimal"
}

# Test 1: JSON hardcoded
$j1 = '[{"snapshot_date":"2026-05-04","store_name":"GPC001 LIM - PERLA","product_code":"AU0005478","description":"TEST","unit":"NIU","stock":10.0,"cost":5.5,"inventory_value":55.0}]'
Write-Host "Enviando JSON hardcoded..."
Write-Host "JSON: $j1"
try {
  Invoke-RestMethod -Uri $EP -Method Post -Headers $HDR -Body $j1 | Out-Null
  Write-Host "EXITO con JSON hardcoded" -ForegroundColor Green
} catch {
  Write-Host "ERROR: $($_.ErrorDetails.Message)" -ForegroundColor Red
}
