/**
 * @file Code.gs — serves the interactive user guide as a web app.
 *
 * The page (guide.html) is BUILT, not authored here: build.sh renders guide.md + the screenshots into one
 * self-contained HTML file, copies it into this folder, and `clasp push` uploads it. This function only
 * serves it. Deploy once as "Execute as: Me", "Who has access: Anyone in <org>"; after that build.sh
 * updates the same deployment with `clasp deploy -i <id>` and the link never changes.
 *
 * Nothing here reads the reader's identity or any data. There is nothing to authorise beyond the web app.
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('guide')
    .setTitle('Contract Intake — user guide')
    // HtmlService drops a <meta viewport> inside the file; this is the only way to set it.
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}
