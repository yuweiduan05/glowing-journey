# 业务接口冒烟（对应路线规划 P1 产出 scripts/smoke-tools.ps1）
# 用法：powershell -ExecutionPolicy Bypass -File scripts/smoke-tools.ps1
# 前置：business-api 已在 127.0.0.1:8082 启动（BUSINESS_SEED=1）

$ErrorActionPreference = 'Stop'
$base = if ($env:BUSINESS_API_BASE_URL) { $env:BUSINESS_API_BASE_URL } else { 'http://127.0.0.1:8082' }
$headers = @{ 'X-Customer-Id' = 'C-10087' }
$failed = 0

function Assert-True([bool]$cond, [string]$name, [string]$detail) {
    if ($cond) {
        Write-Host "[PASS] $name  $detail" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] $name  $detail" -ForegroundColor Red
        $script:failed++
    }
}

Write-Host "== health ==" -ForegroundColor Cyan
$health = Invoke-RestMethod "$base/health"
Assert-True ($health.status -eq 'ok') 'health' "chunks/products=$($health.checks.sqlite.detail)"

Write-Host "== T1 单仓 ==" -ForegroundColor Cyan
$inv = Invoke-RestMethod "$base/v1/inventory/SKU-A1B2C3?warehouse_code=WH-SZ"
Assert-True ($inv.available -eq 17) 'available=on_hand-reserved' "available=$($inv.available)"
Assert-True ($inv.below_safety -eq $true) 'below_safety' "safety=$($inv.safety_stock)"

Write-Host "== T1 跨仓 ==" -ForegroundColor Cyan
$all = Invoke-RestMethod "$base/v1/inventory/SKU-A1B2C3"
Assert-True ($all.warehouse -eq 'ALL' -and $all.by_warehouse.Count -eq 3) 'cross-warehouse' "available=$($all.available)"

Write-Host "== T2 订单（本人 / 越权）==" -ForegroundColor Cyan
$order = Invoke-RestMethod "$base/v1/orders/SO-20261012-007" -Headers $headers
Assert-True ($order.status -eq 'SHIPPED') 'order status' "tracking=$($order.shipment.tracking_no)"

try {
    Invoke-RestMethod "$base/v1/orders/SO-20261012-007" -Headers @{ 'X-Customer-Id' = 'C-10099' } | Out-Null
    Assert-True $false 'forbidden' 'should be 403'
} catch {
    $code = ($_.ErrorDetails.Message | ConvertFrom-Json).code
    Assert-True ($code -eq 'FORBIDDEN_DATA_SCOPE') 'forbidden' "code=$code"
}

Write-Host "== T3 工单（幂等 / 冲突）==" -ForegroundColor Cyan
$key = [guid]::NewGuid().ToString()
$body = @{
    category        = 'INVOICE'
    severity        = 'S4'
    summary         = '客户要求补开订单的增值税专用发票，需要核对开票资料并回传电子版。'
    order_no        = 'SO-20261012-007'
    idempotency_key = $key
} | ConvertTo-Json

$t1 = Invoke-RestMethod "$base/v1/tickets" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
Assert-True ($t1.deduplicated -eq $false) 'ticket created' "ticket=$($t1.ticket_no)"

$t2 = Invoke-RestMethod "$base/v1/tickets" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
Assert-True ($t2.deduplicated -eq $true -and $t2.ticket_no -eq $t1.ticket_no) 'idempotent replay' "ticket=$($t2.ticket_no)"

$body2 = @{
    category        = 'INVOICE'
    severity        = 'S4'
    summary         = '客户要求补开订单的增值税专用发票，需要核对开票资料并回传电子版。'
    order_no        = 'SO-20261012-007'
    idempotency_key = [guid]::NewGuid().ToString()
} | ConvertTo-Json
try {
    Invoke-RestMethod "$base/v1/tickets" -Method Post -Headers $headers -ContentType 'application/json' -Body $body2 | Out-Null
    Assert-True $false 'duplicate ticket' 'should be 409'
} catch {
    $code = ($_.ErrorDetails.Message | ConvertFrom-Json).code
    Assert-True ($code -eq 'DUPLICATE_TICKET') 'duplicate ticket' "code=$code"
}

Write-Host "== 故障注入 ==" -ForegroundColor Cyan
try {
    Invoke-RestMethod "$base/v1/inventory/SKU-A1B2C3?chaos=500" | Out-Null
    Assert-True $false 'chaos=500' 'should be 500'
} catch {
    Assert-True ($_.Exception.Response.StatusCode.value__ -eq 500) 'chaos=500' 'injected 500'
}

Write-Host ""
if ($failed -gt 0) {
    Write-Host "$failed 项失败" -ForegroundColor Red
    exit 1
}
Write-Host "全部通过" -ForegroundColor Green
