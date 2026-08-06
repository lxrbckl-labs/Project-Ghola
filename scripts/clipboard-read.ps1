# clipboard-read.ps1 — Read an image from the Windows clipboard and write it
# to a temp file. Prints the absolute path of the file on stdout. Exit 0 on
# success, non-zero on failure with an error message on stderr.
#
# Contract: this script is invoked by the tool.clipboard-image module. The
# caller reads exactly one line from stdout (the temp file path) and checks
# the exit code.

param(
    [string]$TempDir = ''
)

Add-Type -AssemblyName System.Windows.Forms

$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $img) {
    Write-Error 'Clipboard does not contain an image'
    exit 1
}

if ($TempDir -and (Test-Path $TempDir -PathType Container)) {
    $dir = $TempDir
} else {
    $dir = [System.IO.Path]::GetTempPath()
}

$filename = "ghola-clipboard-$(Get-Date -Format 'yyyyMMdd-HHmmss-fff').png"
$filepath = Join-Path $dir $filename

try {
    $img.Save($filepath, [System.Drawing.Imaging.ImageFormat]::Png)
    $img.Dispose()
    Write-Output $filepath
    exit 0
} catch {
    Write-Error "Failed to save clipboard image: $_"
    exit 1
}
