# فُقّاعة (Faqqa) — Android WebView, Photo Picker & Share Intent Module

This is the companion Android module for **فُقّاعة — Faqqa**. It works alongside the PWA/Web app and ensures full native Android integration:

1. **`ComicWebViewActivity.kt`**:
   - Uses `WebChromeClient.onShowFileChooser` wired to `ActivityResultContracts.PickMultipleVisualMedia` (`ImageOnly`) whenever an `<input type="file" accept="image/*" multiple>` is triggered, opening Android's native **Photo Picker bottom sheet** without requesting broad storage permissions (`READ_MEDIA_IMAGES`).
   - Real Android `WebView` with JavaScript enabled, manual sign-in & verification support, permanent **Import Chapter** action, screenshot fallback, HTTP 403 detection, external browser handoff, and Privacy Mode.
2. **`ShareIntentReceiverActivity.kt`**: Android Share Sheet target (`ACTION_SEND` / `ACTION_SEND_MULTIPLE`) accepting `image/*`, `.cbz`, `.zip`, and `.pdf` shared from mobile browsers or comic reader apps.
3. **`PanelApiClient.kt`**: Uploads captured/shared pages straight to `POST /api/mobile/share-import` without forwarding website cookies or credentials.

## Building in Android Studio

1. Open `android-browser-module/` in Android Studio (JDK 17, Android SDK 35).
2. Update `serverBaseUrl` in `ComicWebViewActivity.kt` / `ShareIntentReceiverActivity.kt` to your deployed Faqqa server URL (or `http://10.0.2.2:3000` when testing against the local Android Emulator).
3. Run `./gradlew assembleDebug` to build the APK.
