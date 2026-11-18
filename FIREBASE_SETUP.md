# Firebase sign-in setup

This app keeps Firebase Authentication for email/password and Google sign-in.
Render serves the website and API. Supabase stores app records and chat uploads;
the current app data layer no longer uses Firestore.

## Firebase web app

1. In Firebase Console, create or open the Firebase project.
2. Enable the authentication providers used by the site (Email/Password and
   Google; enable Phone only if the site will use it).
3. Register a Firebase web app and copy its web configuration into
   `public/firebase-config.js`.
4. Add the Render site URL to Firebase Authentication's authorized domains.

The web configuration is public. Do not place Firebase Admin credentials or
AI/Supabase secret keys in `public/`.

## Firebase Admin on Render

In the Render web service's Environment settings, keep these server-only
variables configured so the API can verify Firebase ID tokens:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`

The frontend sends the signed-in user's Firebase token to the Render API. The
API verifies the token before reading or writing that user's Supabase data.

## Render and Supabase

The existing Render web service serves both the website and the API. Configure
Supabase using the instructions in [SUPABASE_SETUP.md](SUPABASE_SETUP.md).
Do not deploy Firebase Hosting for this setup. Firestore rules are not used by
the new app data paths.

## One-to-one video calls

Video calls use browser WebRTC for media and the authenticated Socket.IO chat
connection for signaling. Media is peer-to-peer when the users' networks allow
it. The API supplies Google STUN servers by default, so no video vendor account
or paid video API is required. Camera and microphone access requires HTTPS.

For stronger connectivity across restrictive NATs, configure a TURN relay that
supports the coturn REST shared-secret credential format in Render:

- `TURN_URLS`: comma-separated `turn:` or `turns:` URLs, including transport
  options when needed (for example `turn:turn.example.net:3478?transport=udp`).
- `TURN_SHARED_SECRET`: the long random secret configured as the TURN server's
  `static-auth-secret`.
- `WEBRTC_ICE_SERVERS` (optional): a JSON array of additional credential-free
  ICE server objects. The API always appends its fallback STUN servers.

The API generates one-hour, user-bound TURN credentials and returns them only
to authenticated users. Do not put the TURN shared secret in browser files.
Without TURN, some school, mobile-carrier, or corporate networks may block a
direct peer-to-peer connection; a TURN relay forwards encrypted WebRTC traffic
and needs its own reachable server and bandwidth.

### Test from a phone on your local Wi-Fi

The server supports local HTTPS when `LOCAL_HTTPS_CERT` and `LOCAL_HTTPS_KEY`
point to a certificate and private key. Use a locally trusted development
certificate (for example, `mkcert`) containing both `localhost` and the PC's
LAN IP address. Install the mkcert root CA certificate on the phone so its
browser trusts the local certificate. Keep the root CA private key on the PC.

Set the two `LOCAL_HTTPS_*` values in `.env`, restart the server, then open
`https://localhost:3000` on the PC and `https://<PC-LAN-IP>:3000` on the phone.
Both devices must be on the same Wi-Fi, and the PC firewall must allow the app's
port on the private network. The phone's camera permission requires a trusted
HTTPS certificate.

## Password reset

In Firebase Console, open **Authentication > Templates > Password reset** and
set the redirect URL to the Render website URL after deployment.
