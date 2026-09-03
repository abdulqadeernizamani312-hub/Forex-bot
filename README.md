# Forex WhatsApp Bot — Setup Guide (Mobile-only)

Ye bot aapke WhatsApp par `!analyze EURUSD` jaisa command bhejne par live price,
RSI, aur moving average analysis reply karta hai. **Ye financial advice nahi hai** —
sirf technical data dikhata hai, decision aapka hoga.

---

## Step 1: Free API key lein (2 min)
1. Mobile browser mein https://twelvedata.com/pricing kholein
2. "Free" plan sign up karein (email se)
3. Dashboard se apni **API Key** copy karein

## Step 2: Code GitHub par upload karein
1. https://github.com par account banayein (agar nahi hai)
2. New repository banayein (e.g. `forex-bot`)
3. Mobile browser se "Upload files" option se ye saari files upload karein:
   `index.js`, `analysis.js`, `package.json`, `.env.example`
4. Commit karein

## Step 3: Railway par deploy karein (free, 24/7 chalta hai)
1. https://railway.app par GitHub se sign up karein
2. "New Project" → "Deploy from GitHub repo" → apna `forex-bot` repo select karein
3. Deploy hone ke baad, **Variables** tab mein jaake add karein:
   - `TWELVE_DATA_API_KEY` = (Step 1 wali key)
   - `ALLOWED_NUMBER` = aapka WhatsApp number bina + ke (e.g. `923001234567`)
4. **Settings → Start Command**: `node index.js`

## Step 4: WhatsApp se link karein (QR scan)
1. Railway dashboard mein **Deployments → View Logs** kholein
2. Ek QR code (text/ASCII pattern) dikhega
3. Apne phone mein WhatsApp kholein → Settings → **Linked Devices** → **Link a Device**
4. Screen ko zoom karke QR ko scan karein (screenshot lekar zoom karna aasan hoga)
5. Logs mein "✅ Bot is ready" dikhega — matlab connect ho gaya

## Step 5: Use karein
Apne WhatsApp se khud ko (ya jis number se allowed hai) message bhejein:
```
!analyze EURUSD
!analyze XAUUSD
!analyze USDJPY
help
```

---

## Important Notes
- `whatsapp-web.js` ek unofficial library hai — WhatsApp ka official Business API
  nahi hai. Isse account restriction ka chhota risk hota hai; isliye ise apne
  personal experiments ke liye use karein, spam ya bulk messaging ke liye nahi.
- Free Twelve Data plan: 800 requests/day — normal personal use ke liye kaafi hai.
- Bot koi guarantee wali trading prediction nahi deta — sirf RSI aur moving
  average jaise standard technical indicators dikhata hai. Trading mein risk
  hamesha hota hai; apni research aur risk-tolerance se decision lein.
