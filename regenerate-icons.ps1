$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$code = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public class IconBuilder
{
    static readonly int[] SIZES = new int[] { 16, 24, 32, 48, 64, 128, 256 };

    // 生成多尺寸 .ico：圆角 + 4 倍超采样抗锯齿
    // 小尺寸写成传统 DIB（BMP）条目，128/256 写成 PNG —— 兼容性最好的经典组合
    public static void Build(string src, string dst, double radiusRatio, string anchor)
    {
        List<byte[]> datas = new List<byte[]>();
        using (Bitmap bmp = new Bitmap(src))
        {
            int side = Math.Min(bmp.Width, bmp.Height);
            int sx = (bmp.Width - side) / 2;
            int sy;
            if (anchor == "bottom") sy = bmp.Height - side;
            else if (anchor == "top") sy = 0;
            else sy = (bmp.Height - side) / 2;
            Rectangle crop = new Rectangle(sx, sy, side, side);

            foreach (int s in SIZES)
            {
                using (Bitmap ico = Render(bmp, crop, s, radiusRatio))
                {
                    datas.Add(s <= 64 ? EncodeDib(ico) : EncodePng(ico));
                }
            }
        }
        WriteIco(dst, SIZES, datas);
    }

    static Bitmap Render(Bitmap src, Rectangle crop, int size, double radiusRatio)
    {
        int ss = 4;
        int big = size * ss;
        Bitmap result = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (Bitmap tmp = new Bitmap(big, big, PixelFormat.Format32bppArgb))
        {
            using (Graphics g = Graphics.FromImage(tmp))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                // 圆角之外填「白色透明」而不是默认的「黑色透明」：
                // 缩小时插值不会把黑边混进圆角边缘（这几张图本来就是白底）
                g.Clear(Color.FromArgb(0, 255, 255, 255));
                using (GraphicsPath p = RoundedPath(new RectangleF(0, 0, big, big), (float)(big * radiusRatio)))
                {
                    g.SetClip(p);
                    g.DrawImage(src, new Rectangle(0, 0, big, big), crop, GraphicsUnit.Pixel);
                }
            }
            using (Graphics g = Graphics.FromImage(result))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.CompositingMode = CompositingMode.SourceCopy;
                g.Clear(Color.Transparent);
                g.DrawImage(tmp, new Rectangle(0, 0, size, size));
            }
        }
        return result;
    }

    static GraphicsPath RoundedPath(RectangleF r, float radius)
    {
        GraphicsPath p = new GraphicsPath();
        if (radius <= 0.01f) { p.AddRectangle(r); return p; }
        float d = radius * 2f;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    static byte[] EncodePng(Bitmap bmp)
    {
        using (MemoryStream ms = new MemoryStream())
        {
            bmp.Save(ms, ImageFormat.Png);
            return ms.ToArray();
        }
    }

    // 经典 ICO 内嵌位图：BITMAPINFOHEADER + 自下而上的 BGRA + 全 0 的 AND 掩码
    static byte[] EncodeDib(Bitmap bmp)
    {
        int w = bmp.Width, h = bmp.Height;
        int xorSize = w * h * 4;
        int andStride = ((w + 31) / 32) * 4;
        int andSize = andStride * h;
        byte[] buf = new byte[40 + xorSize + andSize];   // AND 区保持全 0

        using (MemoryStream ms = new MemoryStream(buf))
        using (BinaryWriter bw = new BinaryWriter(ms))
        {
            bw.Write(40);                       // biSize
            bw.Write(w);                        // biWidth
            bw.Write(h * 2);                    // biHeight = XOR + AND
            bw.Write((ushort)1);                // biPlanes
            bw.Write((ushort)32);               // biBitCount
            bw.Write(0);                        // biCompression = BI_RGB
            bw.Write(xorSize);                  // biSizeImage
            bw.Write(0); bw.Write(0);           // 分辨率
            bw.Write(0); bw.Write(0);           // 调色板
        }

        BitmapData bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            for (int y = 0; y < h; y++)
            {
                IntPtr row = (IntPtr)((long)bd.Scan0 + (long)(h - 1 - y) * bd.Stride);  // DIB 自下而上
                Marshal.Copy(row, buf, 40 + y * w * 4, w * 4);
            }
        }
        finally { bmp.UnlockBits(bd); }
        return buf;
    }

    // 全透明图标：用来顶掉桌面快捷方式左下角的小箭头
    public static void MakeBlank(string dst)
    {
        int[] sizes = new int[] { 16, 32, 48, 256 };
        List<byte[]> datas = new List<byte[]>();
        foreach (int s in sizes)
        {
            using (Bitmap b = new Bitmap(s, s, PixelFormat.Format32bppArgb))
            {
                datas.Add(s <= 64 ? EncodeDib(b) : EncodePng(b));
            }
        }
        WriteIco(dst, sizes, datas);
    }

    static void WriteIco(string dst, int[] sizes, List<byte[]> datas)
    {
        using (FileStream fs = new FileStream(dst, FileMode.Create, FileAccess.Write))
        using (BinaryWriter w = new BinaryWriter(fs))
        {
            w.Write((ushort)0);              // reserved
            w.Write((ushort)1);              // type = icon
            w.Write((ushort)sizes.Length);   // count
            int offset = 6 + 16 * sizes.Length;
            for (int i = 0; i < sizes.Length; i++)
            {
                w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));  // 宽（0 表示 256）
                w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));  // 高
                w.Write((byte)0);            // 调色板数
                w.Write((byte)0);            // reserved
                w.Write((ushort)1);          // planes
                w.Write((ushort)32);         // bpp
                w.Write((uint)datas[i].Length);
                w.Write((uint)offset);
                offset += datas[i].Length;
            }
            for (int i = 0; i < datas.Count; i++) w.Write(datas[i]);
        }
    }
}
'@

Add-Type -TypeDefinition $code -Language CSharp -ReferencedAssemblies System.Drawing

# ==================================================================
#  配置：三张图片来源
#  优先读同目录下的 icons.config.json（已被 .gitignore 排除，适合放个人路径）：
#      [ { "name": "开启", "src": "D:\\pics\\on.jpg", "anchor": "bottom" } ]
#  没有该文件时用下面这份占位配置 —— 记得改成你自己的图片路径。
#
#  anchor 是裁切基准，用于图片长宽比与图标不是 1:1 的情况：
#      center = 居中裁切；bottom = 贴底裁切（主体在下半部分时用）
#  name 即输出文件名，可自由增删条目。
# ==================================================================
$cfgPath = Join-Path $PSScriptRoot 'icons.config.json'
if (Test-Path -LiteralPath $cfgPath) {
  $jobs = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
  $jobs = @(
    @{ name = '开启'; src = 'C:\path\to\your\on.jpg';   anchor = 'bottom' },
    @{ name = '查看'; src = 'C:\path\to\your\view.jpg'; anchor = 'center' },
    @{ name = '关闭'; src = 'C:\path\to\your\off.jpg';  anchor = 'center' }
  )
}

# 图标输出目录：本脚本同级的 icons\
$iconDir = Join-Path $PSScriptRoot 'icons'
if (-not (Test-Path -LiteralPath $iconDir)) { New-Item -ItemType Directory -Path $iconDir | Out-Null }

# 缺图时给出人话提示，而不是抛一堆 .NET 异常
$missing = @($jobs | Where-Object { -not (Test-Path -LiteralPath $_.src) })
if ($missing.Count -gt 0) {
  Write-Output '以下图片路径不存在，请修改本脚本的 $jobs 配置，或改用 icons.config.json：'
  foreach ($m in $missing) { Write-Output ('  缺：' + $m.src) }
  exit 1
}

foreach ($j in $jobs) {
  $dst = Join-Path $iconDir ($j.name + '.ico')
  [IconBuilder]::Build($j.src, $dst, 0.15, $j.anchor)
  Write-Output ("生成 {0}.ico  ({1:N0} KB)" -f $j.name, ((Get-Item -LiteralPath $dst).Length / 1KB))
}

[IconBuilder]::MakeBlank((Join-Path $iconDir 'blank.ico'))
Write-Output ("生成 blank.ico  ({0:N0} 字节)" -f (Get-Item -LiteralPath (Join-Path $iconDir 'blank.ico')).Length)
