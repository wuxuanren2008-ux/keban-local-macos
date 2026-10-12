"""Render the existing website's 听 logo as a Windows application icon."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
image = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((8, 8, 504, 504), radius=105, fill='#2f6650')
font = ImageFont.truetype(str(root / 'dist/vendor/NotoSansSC.ttf'), 300)
draw.text((256, 250), '听', font=font, fill='#ffffff', anchor='mm')
image.save(root / 'desktop/icon.ico', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
image.resize((1024,1024)).save(root / 'desktop/icon.icns')
