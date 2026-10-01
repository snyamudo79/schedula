# Turning on accounts & sync (one-time, ~5 minutes)

Schedula uses a free **Firebase** project (by Google) for accounts and syncing. You do this once; after that anyone using your copy of Schedula can create an account and sync their phone and desktop. The free "Spark" plan is plenty for personal use.

## 1. Create the project
1. Go to **https://console.firebase.google.com** and sign in with a Google account.
2. **Create a project** → name it `schedula` → you can turn **Google Analytics off** → **Create project**.

## 2. Switch on sign-in
1. Left menu: **Build → Authentication → Get started**.
2. **Sign-in method** tab:
   - **Email/Password** → enable the first switch → **Save**.
   - **Add new provider → Google** → enable → pick your support email → **Save**.
3. **Settings** tab → **Authorized domains** → **Add domain** → `snyamudo79.github.io` → **Add**.
   (`localhost` is already there, for testing on your PC.)

## 3. Create the database
1. Left menu: **Build → Firestore Database → Create database**.
2. Pick a location near you (it can't be changed later) → **Next**.
3. Choose **Start in production mode** → **Create**.
4. Open the **Rules** tab, replace everything with the rules below, and click **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Each person can only read and write their own data.
    match /users/{uid}/items/{item} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if request.auth != null && request.auth.uid == uid
        && request.resource.data.keys().hasOnly(['k', 'v', 't', 'dev', 'st'])
        && request.resource.data.k == item;
    }
  }
}
```

## 4. Connect the app
1. Click the **gear icon → Project settings**. Under **Your apps**, click the **web icon `</>`**.
2. Nickname: `Schedula web` → **Register app**. Don't tick Firebase Hosting.
3. You'll see a `firebaseConfig` block. Copy these four values into **`firebase-config.js`**:

```js
window.SCHEDULA_FIREBASE = {
  apiKey: 'AIza…',
  authDomain: 'schedula-xxxx.firebaseapp.com',
  projectId: 'schedula-xxxx',
  appId: '1:…:web:…',
};
```

4. Increase `VERSION` in `sw.js`, then commit and push. Within about a minute the live app shows **Settings → Account & sync**.

> These values are **public by design**. Every web app ships them to the browser. Your data is protected by the security rules above, which only let a signed-in person reach their own data.

## How sync behaves
- **Optional.** Without signing in, Schedula works exactly as before: local only, fully offline.
- **First sign-in on a device.** If the account is empty, this device's data is uploaded. If the account already has data and this device has its own, you choose between **Use my account's data** (best for a new phone) and **Merge both**. Merging combines matching habits and keeps both histories.
- **Every change** is saved on the device first, then uploaded. Other signed-in devices update within seconds.
- **Offline edits** are queued and uploaded when you reconnect.
- **When two devices change the same thing while offline**, the most recent edit wins. Schedule days are merged block by block instead, and a check-in always beats "missed".
- **Sign out** stops syncing on that device and keeps its data. **Reset everything** signs the device out first, so your account is never wiped.

To verify the sync logic yourself: `node tools/sync-test.js` (simulated server and devices, no Firebase needed).
