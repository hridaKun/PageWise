param([string]$Out, [string]$Preview)
# Draws Pagewise's icon (an open book with a highlighted line, on an orange
# rounded square) and writes a multi-size .ico (PNG frames: 16, 24, 32, 48,
# 64, 128, 256). -Preview x.png also saves each frame as x-<size>.png.
Add-Type -AssemblyName System.Drawing

function Color($a, $r, $g, $b) { [System.Drawing.Color]::FromArgb($a, $r, $g, $b) }
function Brush($c) { New-Object System.Drawing.SolidBrush $c }

function New-Frame([int]$s) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $k = $s / 256.0
  function P($x, $y) { New-Object System.Drawing.PointF ($x * $k), ($y * $k) }
  function RoundRect($x, $y, $w, $h, $r) {
    $x *= $k; $y *= $k; $w *= $k; $h *= $k; $r *= $k
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc($x, $y, 2*$r, 2*$r, 180, 90); $p.AddArc($x+$w-2*$r, $y, 2*$r, 2*$r, 270, 90)
    $p.AddArc($x+$w-2*$r, $y+$h-2*$r, 2*$r, 2*$r, 0, 90); $p.AddArc($x, $y+$h-2*$r, 2*$r, 2*$r, 90, 90)
    $p.CloseFigure(); return $p
  }
  # One page of the open book. $d = -1 for the left page, 1 for the right;
  # $dy shifts it down (for the cover underneath).
  function Page($d, $dy) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddBezier((P 128 (88+$dy)), (P (128+18*$d) (72+$dy)), (P (128+60*$d) (66+$dy)), (P (128+94*$d) (74+$dy)))
    $p.AddLine((P (128+94*$d) (74+$dy)), (P (128+94*$d) (186+$dy)))
    $p.AddBezier((P (128+94*$d) (186+$dy)), (P (128+60*$d) (178+$dy)), (P (128+18*$d) (184+$dy)), (P 128 (200+$dy)))
    $p.CloseFigure(); return $p
  }

  # Background: orange rounded square with a soft top-to-bottom gradient.
  $bg = RoundRect 8 8 240 240 56
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush ((P 0 8), (P 0 248), (Color 255 255 160 64), (Color 255 247 120 16))
  $g.FillPath($grad, $bg)

  # Cover peeking out under the pages, then the two white pages.
  $cover = Brush (Color 255 150 62 0)
  $g.FillPath($cover, (Page -1 10)); $g.FillPath($cover, (Page 1 10))
  $g.FillPath([System.Drawing.Brushes]::White, (Page -1 0))
  $g.FillPath((Brush (Color 255 246 244 240)), (Page 1 0))
  # Spine shadow
  $g.FillRectangle((Brush (Color 60 120 60 10)), 126*$k, 88*$k, 4*$k, 112*$k)

  if ($s -ge 32) {
    $line = Brush (Color 255 200 200 208)
    $t = [Math]::Max(1, 9*$k)
    foreach ($y in 104, 126, 148) { $g.FillPath($line, (RoundRect 54 $y 56 9 4.5)) }
    $g.FillPath($line, (RoundRect 146 104 56 9 4.5))
    $g.FillPath($line, (RoundRect 146 148 40 9 4.5))
  }
  # The highlighted line: a bold yellow marker stroke across the right page.
  $g.FillPath((Brush (Color 255 255 214 0)), (RoundRect 140 118 68 24 6))
  if ($s -ge 32) { $g.FillPath((Brush (Color 255 120 96 40)), (RoundRect 146 126 56 9 4.5)) }

  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return ,$ms.ToArray()
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$frames = @(); foreach ($s in $sizes) { $frames += ,(New-Frame $s) }
if ($Preview) { for ($i = 0; $i -lt $sizes.Count; $i++) { [System.IO.File]::WriteAllBytes(($Preview -replace ".png$", "-$($sizes[$i]).png"), $frames[$i]) } }
$ico = New-Object System.IO.MemoryStream
$w = [System.IO.BinaryWriter]::new($ico)
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $len = $frames[$i].Length
  $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s }))); $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$len); $w.Write([uint32]$offset); $offset += $len
}
foreach ($f in $frames) { $w.Write($f) }
$w.Flush()
if ($Out) { [System.IO.File]::WriteAllBytes($Out, $ico.ToArray()) }
