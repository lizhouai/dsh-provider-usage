"""Screenshot the dsh-provider-quota panel in both languages."""
from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:3080'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.goto(URL)
    page.wait_for_load_state('domcontentloaded')
    page.wait_for_timeout(5000)

    trigger = page.locator('.dsh-quota-trigger')
    trigger.wait_for(state='visible', timeout=15000)
    trigger.click()

    panel = page.locator('.dsh-quota-panel')
    panel.wait_for(state='visible', timeout=5000)
    # Wait for the first fetch to settle (cards or an error message).
    page.wait_for_selector('.dsh-quota-card, .dsh-quota-message', timeout=20000)
    page.wait_for_timeout(500)

    # Screenshot A: whatever language the panel starts in.
    panel.screenshot(path='shot_a.png')
    lang_label = page.locator('.dsh-quota-lang span').inner_text()
    print('initial lang:', lang_label)

    # Toggle to the other language, wait a beat, screenshot B.
    page.locator('.dsh-quota-lang').click()
    page.wait_for_timeout(300)
    panel.screenshot(path='shot_b.png')
    print('toggled lang:', page.locator('.dsh-quota-lang span').inner_text())

    # Full-page context shot for reference.
    page.screenshot(path='shot_context.png')
    browser.close()
print('done')
