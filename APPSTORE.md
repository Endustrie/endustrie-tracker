# App Store submission guide — Endustrie Tracker v1.001

The iOS project is scaffolded and ready in `ios/` (Capacitor 8, Swift Package Manager —
no CocoaPods needed). Icons and splash screens are generated. What remains needs your
Apple identity.

## Your two prerequisites (do these first)

1. **Apple Developer Program** — enroll at https://developer.apple.com/programs/enroll/
   with your Apple ID ($99/year). Approval usually takes 24–48 hours.
2. **Xcode** — install from the Mac App Store (free, ~12 GB). Open it once and accept the license.

## Build & submit (once both are done)

```sh
cd ~/Documents/endustrie-tracker-app
npm run build:single && npx cap sync ios
npx cap open ios          # opens the project in Xcode
```

In Xcode:
1. Select the **App** target → *Signing & Capabilities* → check **Automatically manage signing**
   and pick your team (appears after enrollment).
2. Bundle identifier is already set: `com.endustrie.tracker`. Version 1.001, build 1.
3. Product → **Archive**, then in the Organizer window: **Distribute App → App Store Connect**.

In App Store Connect (https://appstoreconnect.apple.com):
1. **My Apps → + → New App** — platform iOS, bundle id `com.endustrie.tracker`, SKU `endustrie-tracker`.
2. Paste the listing copy below, upload screenshots (take them in Simulator: iPhone 15 Pro Max
   for 6.7", iPad Pro 12.9" if you enable iPad).
3. Privacy policy URL: `https://endustrie.github.io/endustrie-tracker/privacy.html`
4. **App Privacy** questionnaire: answer **"Data Not Collected"** for every category — truthful
   because sync/shares are end-to-end encrypted and tied to no identity.
5. Submit for review.

## Listing copy (paste-ready)

- **Name**: Endustrie Tracker
- **Subtitle**: Encrypted music production HQ
- **Category**: Music (secondary: Productivity)
- **Keywords**: `music,production,tracker,album,catalog,stems,mixing,encrypted,private,studio,demo,manager`
- **Description**:

> Run your album like a label — without giving your catalog to anyone.
>
> Endustrie Tracker is a production headquarters for independent artists: every song, its stage
> in the pipeline (writing → recorded → mixing → exported → mastered → video), keys, BPMs,
> features, stems status, artwork, and production notes — all in one place, all encrypted on
> your device.
>
> • UPLOAD YOUR MIXES — attach the actual audio to each song straight from Files or Voice Memos
> and play it back inside the app.
> • WORK QUEUE — the app turns your catalog into a to-do list: stems to chase, exports to run,
> notes to resolve. Marking done updates the song. Undo anything.
> • SEQUENCE THE ALBUM — drag-and-drop tracklist with running length.
> • SHARE SECURELY — send a read-only link of one song or the whole project. Recipients can
> look and listen, never edit. Revoke any time. Links are end-to-end encrypted.
> • MONEY — quarterly revenue, expense reports with receipt photos, P&L at a glance.
> • PRIVATE BY ARCHITECTURE — passphrase-encrypted profiles (AES-256), optional end-to-end
> encrypted sync between your phone and computer, encrypted backups. No account. No tracking.
> We couldn't read your data if we wanted to.

- **Review notes (App Review box)**:

> The app is fully functional without any account. On first launch, tap "New profile", choose
> any passphrase (8+ chars), then tap "Load Reality example" to populate a full demo catalog.
> All user data is stored on-device encrypted; the optional sync/share feature uploads only
> end-to-end-encrypted blobs (we hold no keys and no user identities), which is why the app
> has no login and collects no data.

## Known iOS notes

- Touch ID / Face ID unlock (WebAuthn) is not available inside the iOS app shell — the
  passphrase is used there. (It still works in Safari/installed PWA.)
- "Link audio folder" (desktop Chrome feature) hides itself on iOS; per-song uploads are the
  path on the phone.
- If review pushes back with guideline 4.2 (web wrapper), respond citing: offline-first
  operation, on-device encryption, native file handling for audio uploads, and no equivalent
  reliance on the website. Adding a couple of Capacitor native plugins (haptics, share sheet)
  is the escalation path — the codebase is ready for them.
