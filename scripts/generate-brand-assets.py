"""Build the LabSuite application and tray icons from the master brand mark.

Requires Pillow. The generated files are committed so end users do not need
Python or Pillow installed.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
BRAND = ASSETS / "brand"
MASTER_MARK = BRAND / "labsuite-mark.png"

APP_ICON_SIZE = 1024
TRAY_ICON_SIZE = 32
RESAMPLE = Image.Resampling.LANCZOS

STATUS_COLORS = {
    "idle": "#39D98A",
    "syncing": "#58A6FF",
    "paused": "#F3B64C",
    "error": "#FF667A",
    "setup": "#94A3B8",
    "labshot": "#A855F7",
}


def fit_image(image: Image.Image, max_width: int, max_height: int) -> Image.Image:
    width, height = image.size
    scale = min(max_width / width, max_height / height)
    return image.resize(
        (max(1, round(width * scale)), max(1, round(height * scale))),
        RESAMPLE,
    )


def trimmed_mark() -> Image.Image:
    source = Image.open(MASTER_MARK).convert("RGBA")
    bounds = source.getchannel("A").getbbox()
    if not bounds:
        raise RuntimeError(f"{MASTER_MARK} has no visible pixels")
    return source.crop(bounds)


def create_app_icon(mark: Image.Image) -> Image.Image:
    size = APP_ICON_SIZE
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tile_pixels = tile.load()
    top = (24, 47, 43)
    bottom = (8, 19, 18)
    for y in range(size):
        amount = y / max(1, size - 1)
        row = tuple(round(top[i] * (1 - amount) + bottom[i] * amount) for i in range(3))
        for x in range(size):
            tile_pixels[x, y] = (*row, 255)

    tile_mask = Image.new("L", (size, size), 0)
    mask_draw = ImageDraw.Draw(tile_mask)
    mask_draw.rounded_rectangle((48, 48, 976, 976), radius=218, fill=255)
    canvas.alpha_composite(Image.composite(tile, Image.new("RGBA", tile.size), tile_mask))

    border = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    border_draw = ImageDraw.Draw(border)
    border_draw.rounded_rectangle(
        (51, 51, 973, 973),
        radius=215,
        outline=(86, 151, 126, 118),
        width=6,
    )
    canvas.alpha_composite(border)

    fitted_mark = fit_image(mark, 660, 660)
    mark_x = (size - fitted_mark.width) // 2
    mark_y = (size - fitted_mark.height) // 2 - 4

    shadow_alpha = fitted_mark.getchannel("A").filter(ImageFilter.GaussianBlur(20))
    shadow = Image.new("RGBA", fitted_mark.size, (0, 0, 0, 0))
    shadow.putalpha(shadow_alpha.point(lambda value: round(value * 0.32)))
    canvas.alpha_composite(shadow, (mark_x + 6, mark_y + 16))
    canvas.alpha_composite(fitted_mark, (mark_x, mark_y))
    return canvas


def create_ui_mark(mark: Image.Image) -> Image.Image:
    canvas = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    fitted = fit_image(mark, 112, 112)
    canvas.alpha_composite(fitted, ((128 - fitted.width) // 2, (128 - fitted.height) // 2))
    return canvas


def create_tray_icon(mark: Image.Image, status_color: str) -> Image.Image:
    scale = 4
    size = TRAY_ICON_SIZE * scale
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    draw.ellipse((4, 4, size - 5, size - 5), fill="#0B1816", outline="#42675B", width=4)

    fitted = fit_image(mark, 78, 78)
    alpha = fitted.getchannel("A")
    monochrome = Image.new("RGBA", fitted.size, "#DDF7EC")
    monochrome.putalpha(alpha)
    canvas.alpha_composite(
        monochrome,
        ((size - fitted.width) // 2 - 3, (size - fitted.height) // 2 - 4),
    )

    badge_bounds = (82, 82, 124, 124)
    draw.ellipse(badge_bounds, fill="#081311")
    draw.ellipse((89, 89, 117, 117), fill=status_color)

    return canvas.resize((TRAY_ICON_SIZE, TRAY_ICON_SIZE), RESAMPLE)


def main() -> None:
    if not MASTER_MARK.exists():
        raise SystemExit(f"Missing master mark: {MASTER_MARK}")

    BRAND.mkdir(parents=True, exist_ok=True)
    mark = trimmed_mark()

    app_icon = create_app_icon(mark)
    app_icon.save(ASSETS / "icon.png", optimize=True)
    app_icon.save(
        ASSETS / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    create_ui_mark(mark).save(BRAND / "labsuite-mark-ui.png", optimize=True)

    for status, color in STATUS_COLORS.items():
        create_tray_icon(mark, color).save(ASSETS / f"tray-{status}.png", optimize=True)

    print("Generated LabSuite icon.png, icon.ico, UI mark, and five tray states.")


if __name__ == "__main__":
    main()
