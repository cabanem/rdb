# Publishing the guide as an Apps Script web app

One-time:
1. Create an empty Apps Script project (script.new), name it "Contract Intake — user guide".
2. Copy its Script ID (Project Settings) into `.clasp.json` (start from `.clasp.json.example`).
3. From this folder: `clasp push` — this uploads Code.js, appsscript.json and the built guide.html.
4. Deploy > New deployment > Web app, Execute as **Me**, Who has access **Anyone in <org>**. Copy the
   Deployment ID from the deployment's row.
5. Put that ID in the top-level `build.sh` as `DEPLOY_ID`. Share the /exec URL.

Every time after: `./build.sh` at the top level rebuilds guide.html, pushes, and updates the SAME deployment.
Readers see the new version at the same link on their next load.

Notes
- `guide.html` in this folder is generated. Edit `../guide.md` and the screenshots, not this file.
- `oauthScopes` is empty on purpose: the web app reads nothing and calls nothing.
- If `clasp push` ever refuses `guide.html` for size, build with images served from a Drive folder instead of
  inlined — ask for the `--images=drive` variant of build_html.py.
