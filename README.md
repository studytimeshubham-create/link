# Secure Chat (steps 1-2: login + end-to-end encrypted 1-to-1 text)

## Run locally (no Firebase needed)
    npm install
    npm start
Open http://localhost:3000 in two different browsers (or one normal + one private window), sign in with two different numbers (the dev code is filled in automatically), then message one number from the other.

## Store data in Firebase
1. Firebase console > Build > Firestore Database > Create database.
2. Project settings > Service accounts > Generate new private key.
3. Start with the key:
       FIREBASE_SERVICE_ACCOUNT="$(cat serviceAccount.json)" JWT_SECRET="long-random-string" NODE_ENV=production npm start
Firestore then holds `users` (phone + public key) and `messages` (ciphertext only).

## Before going live
- Replace `sendSms()` in server.js with a real provider (Aliyun or Tencent SMS for +86, MSG91 or Twilio for +91). In production the code is never returned to the browser.
- Serve over HTTPS (required for the Web Crypto API outside localhost).
- Host the gateway in Hong Kong or Singapore first; add a mainland node (ICP filing) for best speed in China.
- Lock Firestore rules to deny all client access (`allow read, write: if false;`), since only the gateway uses the Admin SDK.

## Known limits of this first version
- Keys are per browser: signing in on another browser or device cannot read old messages (encrypted key backup is a later step).
- No forward secrecy yet (a Signal-style ratchet is a later upgrade).
- No safety-number check yet, so the server could swap a public key. Fingerprint verification comes next.
- Next steps: image/video upload (encrypted before upload), groups, then calls.

## Deploy on AWS Hong Kong (ap-east-1)
Why Hong Kong: it is a normal global AWS region, so a regular AWS account works and no Chinese business license or ICP filing is needed. (AWS's mainland regions, Beijing and Ningxia, need a separate China account, a Chinese business license, and ICP.) Firebase is reachable from Hong Kong, so the gateway there can talk to Firestore for users in both countries.

1. Enable the region: AWS console > Account > AWS Regions > enable Asia Pacific (Hong Kong). It can take a few minutes.
2. In ap-east-1, launch one EC2 instance: Amazon Linux 2023, t3.small. Security group: port 22 from your IP only, ports 80 and 443 from anywhere.
3. Allocate an Elastic IP and attach it. Create a DNS A record for your domain pointing to it.
4. Copy the files up and run the setup (needs your Firebase serviceAccount.json):
       scp -i your-key.pem secure-chat.zip serviceAccount.json ec2-user@ELASTIC_IP:~
       ssh -i your-key.pem ec2-user@ELASTIC_IP
       sudo dnf install -y unzip && unzip secure-chat.zip && cd secure-chat
       sudo bash deploy/setup-ec2.sh chat.example.com ~/serviceAccount.json
5. Open https://chat.example.com. Logs: `sudo journalctl -u secure-chat -f`.

Important:
- Run exactly ONE instance. Login codes and online presence are kept in memory, so a second server would break them. To scale later, move those to Redis (Amazon ElastiCache).
- In production the SMS stub only prints codes to the server log, so real users cannot sign in until you implement `sendSms()` with a provider that supports +86 and +91.
- Firestore rules: deny all client access.
- Test speed from real mainland networks before launch. Hong Kong uses standard internet routing to the mainland, so quality can vary by carrier and hour.
