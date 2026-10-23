# Publish the Prospect Mailer phone app (about 10 minutes, once)

The app is a set of files that needs a free web address. GitHub Pages works well.

## 1. Put it on GitHub Pages
1. Sign in at https://github.com (create a free account if needed).
2. Click **+ ▸ New repository**. Name it `prospect-mailer-mobile`, choose **Public**, click **Create repository**.
3. On the new repo page click **uploading an existing file**. Drag **everything inside** the `prospect-mailer-mobile` folder (not the folder itself — `index.html` must be at the top level) and click **Commit changes**.
4. Go to **Settings ▸ Pages**. Under *Branch* pick **main** and **/ (root)**, click **Save**.
5. After a minute the page shows your address, e.g. `https://YOUR-NAME.github.io/prospect-mailer-mobile/`.

## 2. Allow that address in Google Cloud (same project as the extension)
1. Open https://console.cloud.google.com/auth/clients and click your **Web application** client (the one the extension uses).
2. **Authorized JavaScript origins** ▸ Add URI: `https://YOUR-NAME.github.io`
3. **Authorized redirect URIs** ▸ Add URI: `https://YOUR-NAME.github.io/prospect-mailer-mobile/` (with the slash at the end)
4. Click **Save**. Google can take 5 minutes (sometimes longer) to apply it.

## 3. Update the cloud script (so the phone can find emails with SalesQL)
1. In the extension: **Settings ▸ Cloud reports ▸ Copy the script** (or use the Code.gs file).
2. In your Apps Script project: select all, paste, **Save**.
3. **Deploy ▸ Manage deployments ▸ ✏ (edit) ▸ Version: New version ▸ Deploy**. The URL stays the same.

## 4. On your phone
1. Open your address in **Safari** (iPhone) or **Chrome** (Android) and tap **Sign in with Google** — use the account you sync the extension with.
2. Add it to your home screen:
   - iPhone: **Share ▸ Add to Home Screen**
   - Android: **⋮ ▸ Install app**. After installing, **Prospect** appears in the LinkedIn app's **Share** menu.

## Updating later
Upload the new files over the old ones in the same GitHub repo (Add file ▸ Upload files). The app picks up the new version the next time it opens.
