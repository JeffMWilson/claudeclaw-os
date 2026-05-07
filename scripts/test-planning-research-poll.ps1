param(
    [int]$TimeoutSec = 240,
    [int]$PollIntervalSec = 3,
    [int]$MaxTokens = 180,
    [int]$Ctx = 2048
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$runId = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$tempDoc = Join-Path $projectRoot "store\planning-research-test-$runId.md"

try {
    New-Item -ItemType Directory -Path (Join-Path $projectRoot "store") -Force | Out-Null
    @"
# Claude Code planning notes (excerpt)
- Break work into explicit phases before editing.
- Validate assumptions by reading code paths before proposing changes.
- Prefer small reversible edits and verify with targeted tests.

# Codex planning notes (excerpt)
- Keep a clear execution plan with checkpoints.
- Re-evaluate after each checkpoint and adjust safely.
- Prefer deterministic, inspectable steps over broad unverified changes.
"@ | Set-Content -Path $tempDoc -Encoding UTF8

    Write-Host "Queueing planning research task..." -ForegroundColor Cyan
    $enqueueOutput = npm run research:planning -- --file $tempDoc --title "Planning research poll test $runId" --focus "planning,checkpoints,verification" --max-tokens $MaxTokens --ctx $Ctx --priority 9 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Queue command failed.`n$enqueueOutput"
    }

    $enqueueText = ($enqueueOutput | Out-String)
    $taskMatch = [regex]::Match($enqueueText, 'Queued planning research task:\s*([a-f0-9]+)')
    if (-not $taskMatch.Success) {
        throw "Could not parse queued task id from output.`n$enqueueText"
    }
    $taskId = $taskMatch.Groups[1].Value
    Write-Host "Task queued: $taskId" -ForegroundColor Green

    Write-Host "Polling for completion..." -ForegroundColor Cyan
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $finalOutput = $null

    while ((Get-Date) -lt $deadline) {
        $rowJson = node -e "const Database=require('better-sqlite3');const db=new Database('store/claudeclaw.db',{readonly:true});const id=process.argv[1];const r=db.prepare('SELECT status, output, error FROM local_llm_queue WHERE id = ?').get(id);process.stdout.write(JSON.stringify(r||{}));" $taskId
        if ($LASTEXITCODE -ne 0) {
            throw "Polling query failed for task $taskId"
        }
        $row = $rowJson | ConvertFrom-Json

        if ($row.status -eq 'completed') {
            $finalOutput = [string]$row.output
            break
        }

        if ($row.status -eq 'failed' -or $row.status -eq 'cancelled') {
            $errText = if ($row.error) { [string]$row.error } else { "Task ended with status $($row.status)" }
            throw "Task $taskId did not complete successfully: $errText"
        }

        Start-Sleep -Seconds $PollIntervalSec
    }

    if (-not $finalOutput) {
        throw "Timed out waiting for task $taskId to complete within $TimeoutSec seconds."
    }

    Write-Host "`nPASS: polling retrieved completed output for task $taskId" -ForegroundColor Green
    Write-Host "Output preview (first 600 chars):" -ForegroundColor Yellow
    if ($finalOutput.Length -gt 600) {
        Write-Output ($finalOutput.Substring(0, 600) + "...")
    } else {
        Write-Output $finalOutput
    }
}
finally {
    if (Test-Path $tempDoc) {
        Remove-Item -Path $tempDoc -Force -ErrorAction SilentlyContinue
    }
}
