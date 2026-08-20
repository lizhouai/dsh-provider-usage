"""Screenshot the dsh-provider-usage panel + floating ball in both languages."""
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:3080"
# Region covering the floating ball (bottom-left dock) and the open panel.
CLIP = {"x": 240, "y": 400, "width": 430, "height": 500}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    # Deterministic docked position + follow the harness language first.
    ctx.add_init_script(
        "localStorage.removeItem('dsh.provider-usage.floatPos');"
        "localStorage.removeItem('dsh.provider-usage.lang');"
    )
    page = ctx.new_page()
    page.goto(URL)
    page.wait_for_load_state("domcontentloaded")
    ball = page.locator(".dsh-usage-ball")
    ball.wait_for(state="visible", timeout=20000)
    page.wait_for_timeout(2500)
    print("ball:", ball.get_attribute("style"))

    ball.click()
    panel = page.locator(".dsh-usage-panel")
    panel.wait_for(state="visible", timeout=5000)
    # Wait for the first fetch to settle (cards or an error message).
    page.wait_for_selector(".dsh-usage-card, .dsh-usage-message", timeout=20000)
    page.wait_for_timeout(600)

    lang_label = page.locator(".dsh-usage-lang span").inner_text()
    print("initial lang:", lang_label)
    # Harness is zh -> first shot is the Chinese one.
    first = "docs/panel-zh.png" if lang_label == "中" else "docs/panel-en.png"
    page.screenshot(path=first, clip=CLIP)
    print("saved", first)

    # Toggle to the other language, wait a beat, second shot.
    page.locator(".dsh-usage-lang").click()
    page.wait_for_timeout(400)
    second = "docs/panel-en.png" if lang_label == "中" else "docs/panel-zh.png"
    page.screenshot(path=second, clip=CLIP)
    print("saved", second)

    # Full-page context shot for reference.
    page.screenshot(path=".dev/shot_context.png")
    browser.close()
print("done")
