param([Parameter(Mandatory=$true)][string]$AudioFixture)
$ErrorActionPreference='Stop'
# Only a controlled, public test phrase is played. Never capture user media.
$testPlayer=New-Object System.Media.SoundPlayer($AudioFixture)
try {$testPlayer.PlayLooping(); Start-Sleep -Seconds 360} finally {$testPlayer.Stop(); $testPlayer.Dispose()}
