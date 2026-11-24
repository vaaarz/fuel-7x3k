# Fuel Bills

Installable web app (PWA): photo of a fuel receipt → Gemini reads invoice no., date, amount (₹), litres, rate → you verify → saved on the phone → export a reimbursement ZIP (CSV + photos) or a printable PDF report.

No server, no build step. Files: `index.html`, `app.js`, `style.css`, `sw.js`, `manifest.webmanifest`, `icon.svg`.

## Deploy free (HTTPS is required for camera + install)

**GitHub Pages**: push the folder contents to a repo → Settings → Pages → deploy from `main`.

## First use on the phone
1. Open the site URL in Chrome (Android) or Safari (iPhone).
2. Add to Home Screen (Chrome menu → *Install app*; Safari Share → *Add to Home Screen*).
3. ⚙ Settings → paste your Gemini API key → Save. (Optional: change the model name if Google retires `gemini-2.5-flash`.)
4. Scan → check the fields against the photo → Save.

## Notes
- Data (photos + details) lives in the browser's IndexedDB on that phone/browser only. Clearing site data or uninstalling the browser deletes it, so export a ZIP after each claim. Use the same installed app each time (Safari tab and Home Screen app have separate storage on iPhone).
- The API key is stored only in that browser. Since the site is public, don't bake the key into the code. In Google AI Studio / Cloud console you can restrict the key to the Generative Language API.
- Free-tier Gemini inputs may be used by Google to improve its products; receipts are low-sensitivity, but avoid photographing anything else.
- Photos are resized to 1600 px and saved as JPEG (~150–300 KB each).
