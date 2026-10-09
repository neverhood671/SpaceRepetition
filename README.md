# 🇸🇪 SvenskaSpaced — Swedish Vocabulary & Spaced Repetition System

An end-to-end personal Swedish vocabulary acquisition and spaced repetition system consisting of:
1. **Chrome Extension (`chrome-extension/`)**: Highlight any Swedish word on a webpage to get its dictionary base form (`lemma` + `en`/`ett` gender), English translation, context sentence, **native human voice recording** from Swedish dictionaries (*Swedish Wiktionary / Wikimedia Commons* & *Svenska.se SO*), and the **1st Google Image search result**, then save to **Firebase Cloud Firestore**.
2. **Android Spaced Repetition App (`android-app/`)**: Fetches your saved Swedish words from Cloud Firestore and schedules reviews using the modern **FSRS-4.5 (Free Spaced Repetition Scheduler)** algorithm with both **Recognition** (`🇸🇪 → 🇬🇧`) and **Cloze Active Recall** (`🖼️ + [___] → 🇸🇪`) modes.

---

## 🚀 Quick Start (5 Minutes, \$0.00 Cost)

### Step 1: Load the Chrome Extension
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select:
   `/Users/anastasiiamishunina/Downloads/SpaceRepetition/chrome-extension`
4. Open any Swedish website (e.g., `https://www.svt.se` or `https://www.dn.se`), highlight any Swedish word, and click the floating **`🇸🇪 Translate & Save`** pill (or hold `Alt` while selecting text).

---

### Step 2: Connect Free Firebase Cloud Firestore (No Credit Card Required)
1. Go to [Firebase Console](https://console.firebase.google.com/) and click **Create a project** (stays on the free **Spark Plan**).
2. In the left sidebar, go to **Build → Firestore Database** and click **Create database**.
3. Choose **Start in test mode** (or use the rules below for personal access) and click **Create**.
4. Copy your **Project ID** (found in **Project Settings → General**, e.g. `svenska-vocab-12345`).
5. Click the **SvenskaSpaced** extension icon in Chrome → **⚙️ Cloud Setup** tab → paste your **Firebase Project ID** (and optionally a free Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) for enhanced de-inflection) → click **Save Settings**.

---

### Step 3: Run the Android App

#### Option A: React Native (Expo) App
Located in `android-app/` ([App.tsx](file:///Users/anastasiiamishunina/Downloads/SpaceRepetition/android-app/App.tsx)):
```bash
cd android-app
npm install
npx expo start --android
```
*(Note: Expo SDK 51+ recommends Node.js 18+ when running the local Metro bundler).*

#### Option B: Instant Zero-Build Android PWA / Mobile Web Runner
You can also open or host [android-app/mobile-web/index.html](file:///Users/anastasiiamishunina/Downloads/SpaceRepetition/android-app/mobile-web/index.html) directly in Chrome on desktop or Android (**Menu → Add to Home screen**). It runs the exact same **FSRS-4.5 scheduler**, **native Swedish audio player**, and **Cloud Firestore sync** with zero build steps.
