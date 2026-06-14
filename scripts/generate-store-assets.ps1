$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$iconsDir = Join-Path $projectRoot 'assets\icons'
$storeAssetsDir = Join-Path $projectRoot 'docs\store-assets'
New-Item -ItemType Directory -Force -Path $iconsDir, $storeAssetsDir | Out-Null

function New-Canvas {
  param([int]$Width, [int]$Height, [string]$Path)

  $bitmap = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $graphics.Clear([System.Drawing.Color]::Transparent)

  return @{
    Bitmap = $bitmap
    Graphics = $graphics
    Path = $Path
  }
}

function Save-Canvas {
  param($Canvas)

  $absolutePath = Join-Path (Resolve-Path -LiteralPath (Split-Path -Parent $Canvas.Path)).Path (Split-Path -Leaf $Canvas.Path)
  $Canvas.Bitmap.Save($absolutePath, [System.Drawing.Imaging.ImageFormat]::Png)
  $Canvas.Graphics.Dispose()
  $Canvas.Bitmap.Dispose()
}

function New-Color {
  param([string]$Hex, [int]$Alpha = 255)

  $value = $Hex.TrimStart('#')
  return [System.Drawing.Color]::FromArgb(
    $Alpha,
    [Convert]::ToInt32($value.Substring(0, 2), 16),
    [Convert]::ToInt32($value.Substring(2, 2), 16),
    [Convert]::ToInt32($value.Substring(4, 2), 16)
  )
}

function New-RoundedRect {
  param([float]$X, [float]$Y, [float]$W, [float]$H, [float]$R)

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $R * 2
  $path.AddArc($X, $Y, $d, $d, 180, 90)
  $path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
  $path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
  $path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function Fill-Rounded {
  param($Graphics, $Brush, [float]$X, [float]$Y, [float]$W, [float]$H, [float]$R)

  $path = New-RoundedRect $X $Y $W $H $R
  $Graphics.FillPath($Brush, $path)
  $path.Dispose()
}

function Stroke-Rounded {
  param($Graphics, $Pen, [float]$X, [float]$Y, [float]$W, [float]$H, [float]$R)

  $path = New-RoundedRect $X $Y $W $H $R
  $Graphics.DrawPath($Pen, $path)
  $path.Dispose()
}

function Draw-TextBox {
  param(
    $Graphics,
    [string]$Text,
    $Font,
    $Brush,
    [float]$X,
    [float]$Y,
    [float]$W,
    [float]$H,
    [string]$Alignment = 'Near'
  )

  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::$Alignment
  $format.LineAlignment = [System.Drawing.StringAlignment]::Near
  $format.Trimming = [System.Drawing.StringTrimming]::EllipsisWord
  $format.FormatFlags = 0
  $Graphics.DrawString($Text, $Font, $Brush, [System.Drawing.RectangleF]::new($X, $Y, $W, $H), $format)
  $format.Dispose()
}

function Draw-Logo {
  param($Graphics, [float]$X, [float]$Y, [float]$Size)

  $background = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    [System.Drawing.RectangleF]::new($X, $Y, $Size, $Size),
    (New-Color '#11263A'),
    (New-Color '#07111F'),
    45
  )
  Fill-Rounded $Graphics $background $X $Y $Size $Size ([Math]::Round($Size * 0.23))
  $background.Dispose()

  $circleBrush = New-Object System.Drawing.SolidBrush((New-Color '#3DD6C6' 24))
  $Graphics.FillEllipse($circleBrush, $X + $Size * 0.16, $Y + $Size * 0.16, $Size * 0.68, $Size * 0.68)
  $circleBrush.Dispose()

  $ringPen = New-Object System.Drawing.Pen((New-Color '#3DD6C6' 46), [Math]::Max(1, $Size * 0.016))
  $Graphics.DrawEllipse($ringPen, $X + $Size * 0.17, $Y + $Size * 0.17, $Size * 0.66, $Size * 0.66)
  $ringPen.Dispose()

  $lockBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    [System.Drawing.RectangleF]::new($X + $Size * 0.27, $Y + $Size * 0.42, $Size * 0.46, $Size * 0.36),
    (New-Color '#55DED1'),
    (New-Color '#1F8E88'),
    90
  )
  $shacklePen = New-Object System.Drawing.Pen((New-Color '#55DED1'), [Math]::Max(2, $Size * 0.055))
  $shacklePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $shacklePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $Graphics.DrawArc($shacklePen, $X + $Size * 0.36, $Y + $Size * 0.23, $Size * 0.28, $Size * 0.36, 180, 180)
  Fill-Rounded $Graphics $lockBrush ($X + $Size * 0.27) ($Y + $Size * 0.43) ($Size * 0.46) ($Size * 0.35) ([Math]::Max(4, $Size * 0.09))

  $keyBrush = New-Object System.Drawing.SolidBrush((New-Color '#07111F' 150))
  $Graphics.FillEllipse($keyBrush, $X + $Size * 0.47, $Y + $Size * 0.57, $Size * 0.07, $Size * 0.07)
  Fill-Rounded $Graphics $keyBrush ($X + $Size * 0.485) ($Y + $Size * 0.62) ($Size * 0.04) ($Size * 0.105) ([Math]::Max(1, $Size * 0.02))

  $keyBrush.Dispose()
  $lockBrush.Dispose()
  $shacklePen.Dispose()
}

function Generate-ExtensionIcons {
  foreach ($size in 16, 32, 48, 128) {
    $canvas = New-Canvas $size $size (Join-Path $iconsDir "icon-$size.png")
    Draw-Logo $canvas.Graphics 0 0 $size
    Save-Canvas $canvas
  }
}

function Generate-StoreIcon {
  $canvas = New-Canvas 128 128 (Join-Path $storeAssetsDir 'store-icon-128.png')
  Draw-Logo $canvas.Graphics 16 16 96
  Save-Canvas $canvas
}

function Generate-SmallPromo {
  $canvas = New-Canvas 440 280 (Join-Path $storeAssetsDir 'small-promo-440x280.png')
  $g = $canvas.Graphics

  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush([System.Drawing.RectangleF]::new(0, 0, 440, 280), (New-Color '#07111F'), (New-Color '#11263A'), 35)
  $g.FillRectangle($bg, 0, 0, 440, 280)
  $bg.Dispose()

  $accent = New-Object System.Drawing.SolidBrush((New-Color '#3DD6C6' 30))
  $g.FillEllipse($accent, 250, -90, 260, 260)
  $accent.Dispose()

  Draw-Logo $g 42 58 82

  $titleFont = New-Object System.Drawing.Font('Segoe UI', 32, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $subFont = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $chipFont = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $white = New-Object System.Drawing.SolidBrush((New-Color '#F5F8FB'))
  $muted = New-Object System.Drawing.SolidBrush((New-Color '#A7B8C7'))
  $tealText = New-Object System.Drawing.SolidBrush((New-Color '#BDF7EF'))

  Draw-TextBox $g 'Local Masker' $titleFont $white 145 76 250 42
  Draw-TextBox $g 'Mask prompt details locally' $subFont $muted 147 119 260 28

  $chipBrush = New-Object System.Drawing.SolidBrush((New-Color '#3DD6C6' 28))
  $chipPen = New-Object System.Drawing.Pen((New-Color '#3DD6C6' 75), 1)
  Fill-Rounded $g $chipBrush 147 158 118 34 17
  Stroke-Rounded $g $chipPen 147 158 118 34 17
  $dot = New-Object System.Drawing.SolidBrush((New-Color '#3DD6C6'))
  $g.FillEllipse($dot, 162, 169, 8, 8)
  Draw-TextBox $g 'Local only' $chipFont $tealText 178 166 74 20

  foreach ($item in @($titleFont, $subFont, $chipFont, $white, $muted, $tealText, $chipBrush, $chipPen, $dot)) {
    $item.Dispose()
  }

  Save-Canvas $canvas
}

function Generate-MainScreenshot {
  $canvas = New-Canvas 1280 800 (Join-Path $storeAssetsDir 'screenshot-main-1280x800.png')
  $g = $canvas.Graphics

  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush([System.Drawing.RectangleF]::new(0, 0, 1280, 800), (New-Color '#F8FAFC'), (New-Color '#DFF1FF'), 30)
  $g.FillRectangle($bg, 0, 0, 1280, 800)
  $bg.Dispose()

  $fontLarge = New-Object System.Drawing.Font('Segoe UI', 34, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $fontInput = New-Object System.Drawing.Font('Segoe UI', 18, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $textDark = New-Object System.Drawing.SolidBrush((New-Color '#1D2A33'))
  $mutedPage = New-Object System.Drawing.SolidBrush((New-Color '#5C6975'))
  Draw-TextBox $g 'What can I help with?' $fontLarge $textDark 220 256 640 60 'Center'

  $inputBrush = New-Object System.Drawing.SolidBrush((New-Color '#FFFFFF' 245))
  $shadowBrush = New-Object System.Drawing.SolidBrush((New-Color '#6A8FB3' 22))
  Fill-Rounded $g $shadowBrush 222 345 640 70 35
  Fill-Rounded $g $inputBrush 220 340 640 70 35
  Draw-TextBox $g '+   Ask AI' $fontInput $mutedPage 252 362 200 30

  $panelBrush = New-Object System.Drawing.SolidBrush((New-Color '#07111F' 238))
  $cardBrush = New-Object System.Drawing.SolidBrush((New-Color '#111F2E' 225))
  $cardPen = New-Object System.Drawing.Pen((New-Color '#FFFFFF' 22), 1)
  $white = New-Object System.Drawing.SolidBrush((New-Color '#F5F8FB'))
  $muted = New-Object System.Drawing.SolidBrush((New-Color '#8FA2B3'))
  $teal = New-Object System.Drawing.SolidBrush((New-Color '#3DD6C6'))
  $hFont = New-Object System.Drawing.Font('Segoe UI', 19, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $smallFont = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sectionFont = New-Object System.Drawing.Font('Segoe UI', 23, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $promptFont = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $btnFont = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $monoFont = New-Object System.Drawing.Font('Consolas', 11, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

  Fill-Rounded $g $panelBrush 820 36 410 688 8

  Fill-Rounded $g $cardBrush 836 52 378 82 8
  Stroke-Rounded $g $cardPen 836 52 378 82 8
  Draw-Logo $g 856 70 36
  Draw-TextBox $g 'Local Masker' $hFont $white 906 70 180 28
  Draw-TextBox $g 'Private composer for AI prompts' $smallFont $muted 908 96 210 20

  $chipBrush = New-Object System.Drawing.SolidBrush((New-Color '#FFFFFF' 11))
  Fill-Rounded $g $chipBrush 1080 71 112 30 15
  $g.FillEllipse($teal, 1100, 83, 5, 5)
  Draw-TextBox $g 'Local only' $smallFont $white 1113 79 76 18

  Fill-Rounded $g $cardBrush 836 150 378 365 8
  Stroke-Rounded $g $cardPen 836 150 378 365 8
  Draw-TextBox $g 'Compose safely' $sectionFont $white 860 174 300 35
  Draw-TextBox $g 'Mask private details before sending to AI.' $smallFont $muted 860 204 320 22

  $textareaBrush = New-Object System.Drawing.SolidBrush((New-Color '#091420' 210))
  Fill-Rounded $g $textareaBrush 860 236 330 155 8
  Draw-TextBox $g 'Summarize the customer issue from a private email. Hide the API key and account number.' $promptFont $muted 878 258 285 58
  Draw-TextBox $g '122 chars / 17 words' $smallFont $muted 860 405 180 20

  $btnBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush([System.Drawing.RectangleF]::new(860, 435, 250, 46), (New-Color '#55DED1'), (New-Color '#2AA59C'), 90)
  Fill-Rounded $g $btnBrush 860 435 250 46 8
  $btnTextBrush = New-Object System.Drawing.SolidBrush((New-Color '#071421'))
  Draw-TextBox $g 'Mask & Insert' $btnFont $btnTextBrush 860 449 250 22 'Center'

  $secondaryBrush = New-Object System.Drawing.SolidBrush((New-Color '#FFFFFF' 14))
  Fill-Rounded $g $secondaryBrush 1120 435 70 46 8
  Stroke-Rounded $g $cardPen 1120 435 70 46 8
  Draw-TextBox $g 'Clear' $btnFont $white 1120 449 70 22 'Center'

  Fill-Rounded $g $cardBrush 836 532 378 155 8
  Stroke-Rounded $g $cardPen 836 532 378 155 8
  Draw-TextBox $g 'Masked prompt' $hFont $white 860 554 210 28
  $copyBrush = New-Object System.Drawing.SolidBrush((New-Color '#FFFFFF' 18))
  Fill-Rounded $g $copyBrush 1128 548 62 30 8
  Draw-TextBox $g 'Copy' $smallFont $white 1128 557 62 18 'Center'

  $maskedBrush = New-Object System.Drawing.SolidBrush((New-Color '#091420' 190))
  Fill-Rounded $g $maskedBrush 860 590 330 74 8
  Draw-TextBox $g "Customer [[LM_EMAIL_001]] used`n[[LM_SECRET_002]] for account`n[[LM_ACCOUNT_003]]." $monoFont $white 876 606 292 48

  foreach ($item in @(
    $fontLarge, $fontInput, $textDark, $mutedPage, $inputBrush, $shadowBrush, $panelBrush,
    $cardBrush, $cardPen, $white, $muted, $teal, $hFont, $smallFont, $sectionFont,
    $promptFont, $btnFont, $monoFont, $chipBrush, $textareaBrush, $btnBrush,
    $btnTextBrush, $secondaryBrush, $copyBrush, $maskedBrush
  )) {
    $item.Dispose()
  }

  Save-Canvas $canvas
}

Generate-ExtensionIcons
Generate-StoreIcon
Generate-SmallPromo
Generate-MainScreenshot

Get-ChildItem -File $iconsDir, $storeAssetsDir | Sort-Object FullName | Select-Object FullName, Length
