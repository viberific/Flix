# Flix on Android Auto through Google Play internal testing

A guide for an agent (or a person) with access to the owner's Play Console, Google Cloud console, GitHub repository
settings and Android phone. It gets the Flix app onto the owner's phone from Google Play, so that its car screen shows
up in Android Auto.

## Why this is needed

Flix's car screen is a Car App Library app (`android/app/src/main/java/com/viberific/flix/car/`). Recent Android Auto
releases hide sideloaded apps of that kind even with Android Auto's developer setting *Unknown sources* turned on.
The log shows `Package DENIED; failed all other checks`. Installs from Google Play are not hidden, and internal testing
is the private way to install from Play: there is no public listing and no wait for review.

## What is already in the repository

- `android/app/build.gradle` has two flavors:
  - **sideload**: the APK on the GitHub releases page. It updates itself from there.
  - **play**: the bundle for Play. It has no self-updater and no `REQUEST_INSTALL_PACKAGES` permission, since Play
    handles updates.
- Both flavors use the package name **`com.viberific.flix`** and include the Android Auto service.
- `.github/workflows/android.yml` ("Build Android / TV app"):
  - On every run where the signing secrets are set, it builds `flix-play-<version>.aab` and keeps it as a run
    artifact named `flix-play-<version>-aab`.
  - On a push to `main` where `PLAY_SERVICE_ACCOUNT_JSON` is also set, it uploads that bundle to the **internal**
    track with status `completed`.
- `versionCode` is the GitHub Actions run number. Play only accepts a versionCode higher than any it has seen, so
  re-running an old workflow run (which keeps its old run number) fails to upload. Start a new run instead.

## Facts to collect from the owner first

- **Play developer account**: the Google account that owns the Play Console developer account. It may differ from
  the owner's main account.
- **Owner's main account**: the Google account signed in on the phone's Play Store. This is the tester. Use the
  owner's main email.
- **Repository**: `viberific/flix` on GitHub. The changes in this guide's commit must be merged into `main`.

## Step 1: Signing secrets in GitHub

In the repository's **Settings → Secrets and variables → Actions**, check whether these exist:
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (and `ANDROID_KEY_PASSWORD` if the key
has its own password).

If they all exist, go on to step 2. The existing key becomes Play's *upload key*.

If they are missing, make a key on a trusted machine and add it:

```sh
keytool -genkeypair -keystore flix-upload.jks -storetype PKCS12 -alias flix -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Flix" -storepass '<a long random password>'
base64 -w0 flix-upload.jks   # the value of ANDROID_KEYSTORE_BASE64 (on macOS: base64 -i flix-upload.jks)
```

Then set `ANDROID_KEYSTORE_PASSWORD` to the password and `ANDROID_KEY_ALIAS` to `flix`. Give the `.jks` file and its
password to the owner to keep somewhere safe. If they are lost, Play will only accept new uploads after an
upload-key reset through Play support.

## Step 2: Get the first bundle

Play's API cannot create an app, so the first bundle is uploaded by hand.

1. In GitHub, go to **Actions → Build Android / TV app → Run workflow** on `main`. Wait for it to succeed.
2. Download the run's `flix-play-<version>-aab` artifact and unzip it to get `flix-play-<version>.aab`.
3. If the artifact is missing, the signing secrets were not picked up. The run log warns
   "No ANDROID_KEYSTORE_BASE64 secret". Go back to step 1.

## Step 3: Create the app in Play Console

Sign in to https://play.google.com/console with the **Play developer account**.

1. **Create app**: name *Flix*, default language English, type **App**, **Free**. Accept the declarations.
2. On the dashboard, go to **Test and release → Testing → Internal testing**.
3. **Testers** tab:
   1. **Create email list** named "Flix testers" containing the **owner's main email**. Save it and tick the list.
   2. Leave the feedback URL/email at its defaults or set it to the owner's email.
   3. Save.
4. **Releases** tab → **Create new release**:
   1. If it asks about Play App Signing, choose **Use Google-generated key** (the default).
   2. Upload `flix-play-<version>.aab`. The package name it shows must be `com.viberific.flix`.
   3. Use the Flix version, for example `0.3.83`, as the release name. Save, then **Next**.
   4. Fix any **errors** shown, then **Save and publish / Start rollout to Internal testing**. Warnings, such as
      missing deobfuscation files or debug symbols, can be ignored.
5. Back on the **Testers** tab, copy the **opt-in link**:
   `https://play.google.com/apps/internaltest/...`. You need it in step 6.
6. **Android Auto opt-in**: go to **Test and release → Advanced settings → Form factors**, choose **Add form factor →
   Android Auto**, and accept the Android for Cars terms if asked.
   - If the console then shows a separate Android Auto testing track, give that track the same tester list and
     release the same bundle there.
   - Note the track's API name and tell the Flix developer. The workflow's `track: internal` must be changed to it.
7. If the console marks any **App content** item as blocking the internal release, complete it. These can include a
   privacy policy, app access, ads, content rating, target audience or data safety. Flix:
   - has no ads
   - collects nothing for the developer (it talks only to the owner's own Flix server)
   - needs a sign-in to a private server (for "App access", say it is a private home media server with no public
     demo account)

## Step 4: Service account so CI can upload

1. Go to https://console.cloud.google.com, signed in with the **Play developer account**. Create or choose a project
   such as "flix-play".
2. **APIs & Services → Library**: enable **Google Play Android Developer API**.
3. **IAM & Admin → Service accounts → Create service account**, named e.g. `flix-ci`. Do not grant it any project role.
4. Open the service account and go to **Keys → Add key → Create new key → JSON**. A `.json` file downloads.
5. In **Play Console → Users and permissions → Invite new users**:
   1. Enter the service account's email (`flix-ci@<project>.iam.gserviceaccount.com`).
   2. Under **App permissions**, add *Flix* with **Release apps to testing tracks** and **Manage testing tracks and
      edit tester lists**. No account-level permissions are needed.
   3. Invite. Service accounts are accepted automatically.
6. In GitHub, add a repository secret **`PLAY_SERVICE_ACCOUNT_JSON`** set to the whole contents of the JSON file.
   Then delete the local copy of the file.

## Step 5: Check that CI uploads

1. Push any commit to `main`, or use **Run workflow**. Note that only a push to `main` uploads; a manual run only
   builds.
2. Check that the step **Upload to Google Play (internal testing)** is green.
3. Check that Play Console → Internal testing shows a new release with the higher version code.

Known errors:
- `The caller does not have permission`: the invite in step 4.5 is missing a permission, or was sent less than a
  few minutes ago. Wait and push again.
- `Only releases with status draft may be created on draft app`: the first manual release in step 3.4 was not rolled
  out. Roll it out.
- `APK specifies a version code that has already been used`: the run re-used an old run number. Start a new run.

## Step 6: Install on the phone from Play

1. Uninstall the sideloaded Flix on the phone. Play's version is signed with a different key, so it cannot install
   over it. Signing in and entering the server address again is needed afterwards; watch history is on the server.
   - With adb: `adb uninstall com.viberific.flix`
2. Make sure the phone's Play Store is using the **owner's main account**: tap the profile picture in Play Store.
3. Open the **opt-in link** from step 3.5 on the phone or in a browser signed into the main account. Tap
   **Become a tester**, then **Download it on Google Play** and install.
   - The first time, the app can take from a few minutes to a few hours to appear for the tester.
4. Open Flix, enter the server address and sign in.
5. Check the install came from Play: `adb shell pm list packages -i com.viberific.flix` should show
   `installer=com.android.vending`.

## Step 7: Android Auto

1. On the phone, go to **Android Auto settings → Customize launcher** and make sure **Flix** is ticked.
2. Connect to the car, or use Google's Desktop Head Unit. Flix should be in the app launcher.
3. If it is not there, while connected run:
   ```sh
   adb logcat -d | grep -iE "flix|DENIED" | tail -50
   ```
   Send the output to the Flix developer, along with:
   - the Android Auto version (Android Auto settings → scroll to the bottom)
   - the Android version
   - the installer line from step 6.5

Notes:
- The car screen works only while parked. Flix pauses and covers the page when the car reports that it is moving.
- The phone's Flix must have been opened and signed in at least once. Otherwise the car shows
  "Open Flix on your phone and enter your server's address first."
- TVs can keep using the sideloaded APK from the GitHub releases page, or install from Play the same way.
