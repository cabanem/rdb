"""Draw numbered callouts on a screenshot. Coordinates live here, next to the image they belong to,
so a re-snipped screenshot only needs its numbers re-placed. Run: python3 annotate.py"""
from PIL import Image, ImageDraw, ImageFont

CALLOUTS = {
    'img/01-dashboard.png': ('img/01-dashboard-annotated.png', [
        (1, 590, 12),   # heartbeat pills (above)
        (2, 892, 12),   # Refresh (above)
        (3, 960, 12),   # Settings (above)
        (4, 8, 105),    # drop zone (left margin)
        (5, 856, 105),  # Add from Drive (left of the button)
        (6, 380, 180),  # tiles (inside the first tile, top right)
        (7, 188, 323),  # In the queue (right of the count)
        (8, 210, 452),  # Errors (right of the count)
        (9, 92, 616),   # Today
    ]),
}

def font(size):
    for f in ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'):
        try: return ImageFont.truetype(f, size)
        except OSError: pass
    return ImageFont.load_default()

def annotate(src, dst, marks, r=15, pad=24):
    # A little canvas on the left so a badge in the margin is not clipped.
    src_im = Image.open(src).convert('RGB')
    im = Image.new('RGB', (src_im.width + pad, src_im.height), src_im.getpixel((0, 0)))
    im.paste(src_im, (pad, 0))
    marks = [(n, x + pad, y) for n, x, y in marks]
    d = ImageDraw.Draw(im)
    f = font(17)
    for n, x, y in marks:
        d.ellipse((x - r, y - r, x + r, y + r), fill='#D03B3B', outline='white', width=2)
        t = str(n)
        w = d.textlength(t, font=f)
        d.text((x - w / 2, y - 11), t, fill='white', font=f)
    im.save(dst)
    print('wrote', dst)

if __name__ == '__main__':
    for src, (dst, marks) in CALLOUTS.items():
        annotate(src, dst, marks)
