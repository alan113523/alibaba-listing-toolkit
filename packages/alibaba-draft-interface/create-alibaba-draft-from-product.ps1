param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$MaterialKey,

    [Parameter(Mandatory = $false)]
    [string]$OutputFile = (Join-Path $PSScriptRoot 'created-draft-result.json')
)

$ErrorActionPreference = 'Stop'
$helper = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\skills\accio-alibaba-data-advisor\scripts\accio_data_advisor.ps1'
$arguments = @{
    material = $MaterialKey
    publishType = 'draft'
} | ConvertTo-Json -Compress

[pscustomobject]@{
    tool = 'new_publish_product'
    keyParameters = @{
        material = $MaterialKey
        publishType = 'draft'
    }
    draftGuarantee = 'publishType is hard-coded to draft; no submit, publish, or repost tool is called'
    outputFile = $OutputFile
} | ConvertTo-Json -Depth 10

& $helper `
    -Action call-tool `
    -ToolName 'new_publish_product' `
    -ArgumentsJson $arguments `
    -AllowExternalAction `
    -OutputFile $OutputFile
