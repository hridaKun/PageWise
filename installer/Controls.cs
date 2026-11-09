// Pagewise Setup: small owner-drawn controls (rounded buttons, switches, a thin
// progress bar) so the installer looks like Pagewise rather than a 2005 wizard.

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace PagewiseSetup
{
    class Palette
    {
        public Color Back, Surface, Text, Muted, Line, Accent, OnAccent, Track;
        public bool Dark;
        // Screen scaling (1 at 100%, 1.5 at 150%...). All sizes are in 96-dpi units times this.
        public float Scale = 1f;
        public int S(float value) { return (int)Math.Round(value * Scale); }

        public static Palette ForSystemTheme()
        {
            bool dark = false;
            try
            {
                object value = Microsoft.Win32.Registry.GetValue(
                    @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1);
                dark = value is int && (int)value == 0;
            }
            catch { }
            Palette p = new Palette { Dark = dark };
            if (dark)
            {
                p.Back = Color.FromArgb(18, 18, 20); p.Surface = Color.FromArgb(32, 32, 36);
                p.Text = Color.FromArgb(242, 242, 244); p.Muted = Color.FromArgb(154, 154, 162);
                p.Line = Color.FromArgb(48, 48, 54); p.Accent = Color.FromArgb(255, 154, 61);
                p.OnAccent = Color.FromArgb(27, 16, 7); p.Track = Color.FromArgb(60, 60, 66);
            }
            else
            {
                p.Back = Color.FromArgb(246, 246, 248); p.Surface = Color.White;
                p.Text = Color.FromArgb(18, 18, 20); p.Muted = Color.FromArgb(110, 110, 118);
                p.Line = Color.FromArgb(226, 226, 232); p.Accent = Color.FromArgb(255, 138, 31);
                p.OnAccent = Color.White; p.Track = Color.FromArgb(214, 214, 220);
            }
            return p;
        }

        public static GraphicsPath Rounded(RectangleF r, float radius)
        {
            GraphicsPath path = new GraphicsPath();
            float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    abstract class SmoothControl : Control
    {
        protected readonly Palette P;
        protected bool Hover;

        protected SmoothControl(Palette palette)
        {
            P = palette;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.UserPaint | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Cursor = Cursors.Hand;
        }

        protected override void OnMouseEnter(EventArgs e) { Hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { Hover = false; Invalidate(); base.OnMouseLeave(e); }
    }

    class PillButton : SmoothControl
    {
        public bool Primary;

        public PillButton(Palette palette, string text, bool primary) : base(palette)
        {
            Text = text;
            Primary = primary;
            Size = new Size(palette.S(primary ? 150 : 110), palette.S(44));
            Font = new Font(Setup.UiFont, 10.5f, primary ? FontStyle.Bold : FontStyle.Regular);
            TabStop = true;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            RectangleF r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
            using (GraphicsPath path = Palette.Rounded(r, Height / 2f))
            {
                if (Primary)
                {
                    Color fill = Enabled ? (Hover ? ControlPaint.Light(P.Accent, 0.12f) : P.Accent) : P.Track;
                    using (SolidBrush b = new SolidBrush(fill)) g.FillPath(b, path);
                }
                else
                {
                    using (SolidBrush b = new SolidBrush(Hover ? P.Line : P.Surface)) g.FillPath(b, path);
                    using (Pen pen = new Pen(P.Line)) g.DrawPath(pen, path);
                }
            }
            Color text = Primary ? P.OnAccent : P.Text;
            TextRenderer.DrawText(g, Text, Font, ClientRectangle, text,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
            if (Focused && ShowFocusCues)
            {
                using (Pen pen = new Pen(P.Accent, 2))
                using (GraphicsPath ring = Palette.Rounded(new RectangleF(2, 2, Width - 5, Height - 5), Height / 2f - 2))
                {
                    if (!Primary) g.DrawPath(pen, ring);
                }
            }
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter || e.KeyCode == Keys.Space) OnClick(EventArgs.Empty);
            base.OnKeyDown(e);
        }

        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
    }

    // One UI-style switch with its label.
    class Switch : SmoothControl
    {
        bool on;
        public event EventHandler Changed;

        public Switch(Palette palette, string text, bool initial) : base(palette)
        {
            Text = text;
            on = initial;
            Font = new Font(Setup.UiFont, 10.5f);
            Size = new Size(palette.S(460), palette.S(34));
            TabStop = true;
        }

        public bool Checked
        {
            get { return on; }
            set { on = value; Invalidate(); if (Changed != null) Changed(this, EventArgs.Empty); }
        }

        protected override void OnClick(EventArgs e) { Checked = !Checked; base.OnClick(e); }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Space) Checked = !Checked;
            base.OnKeyDown(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            float k = P.Scale;
            RectangleF track = new RectangleF(1, (Height - 22 * k) / 2f, 40 * k, 22 * k);
            using (GraphicsPath path = Palette.Rounded(track, 11 * k))
            using (SolidBrush b = new SolidBrush(on ? P.Accent : P.Track))
            {
                g.FillPath(b, path);
            }
            float knobX = on ? track.Right - 19 * k : track.X + 3 * k;
            using (SolidBrush knob = new SolidBrush(Color.White))
            {
                g.FillEllipse(knob, knobX, track.Y + 3 * k, 16 * k, 16 * k);
            }
            Rectangle textRect = new Rectangle(P.S(54), 0, Width - P.S(54), Height);
            TextRenderer.DrawText(g, Text, Font, textRect, P.Text,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
            if (Focused && ShowFocusCues)
            {
                using (Pen pen = new Pen(P.Accent, 1.5f))
                using (GraphicsPath ring = Palette.Rounded(new RectangleF(-1, track.Y - 3 * k, 44 * k, 28 * k), 14 * k))
                {
                    g.DrawPath(pen, ring);
                }
            }
        }
    }

    class ThinProgress : Control
    {
        readonly Palette P;
        float value;

        public ThinProgress(Palette palette)
        {
            P = palette;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Size = new Size(palette.S(460), palette.S(8));
        }

        public float Value
        {
            get { return value; }
            set { this.value = Math.Max(0, Math.Min(1, value)); Invalidate(); }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath track = Palette.Rounded(new RectangleF(0, 0, Width - 1, Height - 1), Height / 2f))
            using (SolidBrush b = new SolidBrush(P.Track))
            {
                g.FillPath(b, track);
            }
            float w = Math.Max(Height, (Width - 1) * value);
            if (value > 0)
            {
                using (GraphicsPath fill = Palette.Rounded(new RectangleF(0, 0, w, Height - 1), Height / 2f))
                using (SolidBrush b = new SolidBrush(P.Accent))
                {
                    g.FillPath(b, fill);
                }
            }
        }
    }

    // Plain text that keeps the form's background (no flicker, wraps nicely).
    class TextBlock : Control
    {
        public Color Color;
        public TextFormatFlags Flags = TextFormatFlags.Left | TextFormatFlags.WordBreak;

        public TextBlock(string text, Font font, Color color)
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor | ControlStyles.ResizeRedraw, true);
            BackColor = Color.Transparent;
            Text = text;
            Font = font;
            Color = color;
        }

        protected override void OnTextChanged(EventArgs e) { Invalidate(); base.OnTextChanged(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, Color, Flags);
        }
    }
}
