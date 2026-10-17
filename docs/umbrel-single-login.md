# One login instead of two (Umbrel app-store package)

Flix has its own accounts, but Umbrel puts every installed app behind the Umbrel password as well, so each family member
signs in twice. The Umbrel sign-in is switched off per app in the app-store package, not in this repo. I could not reach
the app-store repo from this session, so this is the change to make there (`blofstedt-flix/` in blofstedt/Autora).

## docker-compose.yml

Add one environment variable to the `app_proxy` service:

```yaml
services:
  app_proxy:
    environment:
      APP_HOST: blofstedt-flix_web_1   # keep whatever is already there
      APP_PORT: 8096                   # keep
      PROXY_AUTH_ADD: "false"          # new: do not put Umbrel's own login in front of Flix
```

With this, Flix's own login page is the only one. Nothing else in Flix changes.

## umbrel-app.yml

Bump `version` to the version in this repo's `package.json` (0.2.0) and describe the release in `releaseNotes`, or Umbrel will
not offer the update. If Umbrel complains about the setting, the same effect is available with
`PROXY_AUTH_WHITELIST: "/*"` in the same `environment:` block.

## Only do this if Flix is not on the open internet

With `PROXY_AUTH_ADD: "false"`, anyone who can reach the app's port reaches Flix's login page (not the Umbrel dashboard).
That is fine when the only way in is your home network or Tailscale. Do not combine it with a public port forward or
Tailscale Funnel. Flix's own protections (hashed passwords, 180-day sessions, accounts only the admin can create) are the
only gate in that setup.

## Handing out accounts without passwords

Family members should not have to type anything. In Flix: account menu, Family, **Sign-in link** next to their name. Send them
the link (or open it on their phone/TV). It signs that device in once, with no password, and expires in 7 days.

## Shipping 0.3.1 to Umbrel (order matters)

1. Merge this branch into `main` here. The image workflow publishes `ghcr.io/viberific/flix:0.3.1` (it refuses a version that already exists).
2. Wait for that workflow to go green. Umbrel fails an update with "manifest unknown" if the manifest names an image that isn't built yet.
3. In blofstedt/Autora, apply `docs/autora-flix-0.3.1.patch` (`git apply docs/autora-flix-0.3.1.patch`, then commit and push to `main`).
   It sets `version: "0.3.1"` and the image tag in `blofstedt-flix/`, writes the release notes, and adds `PROXY_AUTH_ADD: "false"` (the single login above).
   Autora's own "Flix store check" workflow will then confirm that registry, manifest and image tag agree, or open a `release-gap` issue if they don't.
4. Umbrel offers the update on its next store refresh; open the App Store on the Umbrel, or wait.
