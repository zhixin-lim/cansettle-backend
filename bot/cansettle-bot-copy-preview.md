# CanSettle bot: copy preview

(Bold shows as **bold**. Button labels are listed at the end.)

## For BotFather

**Description** (/setdescription, shown under 'What can this bot do?')

```
Splitting a makan bill? Send me a photo of the receipt. I'll read the items, you say who had what, and CanSettle works out exactly who pays whom, GST and service charge included. No accounts, nothing permanent. Tap Start to begin 🧾
```

**About** (/setabouttext)

```
Snap the receipt, split the bill. GST and service charge sorted, no accounts. 🧾
```

**Commands** (/setcommands)

```
start - Start a new settlement
help - How CanSettle works
cancel - Drop the current settlement
```

## Messages the bot sends

### /start

> **Hi, I'm CanSettle 🧾**
> Got a bill to settle? Send me a photo of the receipt and I will read it for you.
> 
> Then you check what I read, open the app, and say who had what. I'll work out exactly who pays whom, GST and service charge included.
> 
> Heads up: Google's Gemini AI reads your photo. /help explains what that means.
> 
> Send the receipt photo whenever you are ready 📸

### /help

> **How CanSettle works**
> 1. Send a photo of the receipt (one photo per receipt).
> 2. Check the items I read. Wrong? You can fix them in the app.
> 3. Add more receipts if there are any.
> 4. Open the app and say who had what.
> 
> **About your receipt**
> Google's Gemini AI reads the photo to pull out the items. I do not keep the photo, but on Google's free plan Google may use what it receives to improve its products, and people there may read it.
> So crop out card numbers and names first, or skip the photo and add the bill by hand in the app.
> 
> Nothing is permanent: a settlement is cleared after 24 hours. No accounts.
> 
> /start — start a new settlement
> /cancel — drop the current one

### Photo received

> Reading your receipt… 🧾

### Review (numbers add up)

> **Receipt 1 — Otter & Pebbles**
> 
> Baco-Mentaiko Udon — $17.90
> 3x Teh peng — $5.40
> Basque Cheesecake — $11.50
> 
> Service charge — $3.48
> GST — $3.43
> **Total — $38.71**
> 
> ⚠️ Alamak, the items and charges add up to $41.71, not $38.71. I may have misread something. You can fix it in the app.
> 
> Does this look right?

### Review (numbers do NOT add up)

> **Receipt 1 — Otter & Pebbles**
> 
> Baco-Mentaiko Udon — $17.90
> 3x Teh peng — $5.40
> Basque Cheesecake — $11.50
> 
> Service charge — $3.48
> GST — $3.43
> **Total — $42.00**
> 
> ⚠️ Alamak, the items and charges add up to $41.71, not $42.00. I may have misread something. You can fix it in the app.
> 
> Does this look right?

### After "Looks right"

> Got it ✅ Otter & Pebbles — $38.71

### Ask for more receipts

> 1 receipt so far. Got another one from this outing?

### Ready to open the app

> **All set 🎉**
> 2 receipts, $196.25 in total.
> Tap below and say who had what 👇

### /cancel

> Okay, dropped. Send a new receipt photo whenever you want to start again.

### /cancel with nothing active

> Nothing to cancel right now. Send a receipt photo to get started 📸

### Problem: unreadable photo

> Alamak, I couldn't read that one. Try a clearer photo: flat, well lit, with the whole receipt in the frame.

### Problem: not a receipt

> Hmm, that doesn't look like a receipt to me. Send a photo of the receipt itself 📸

### Problem: reader busy / limit hit

> I'm a bit busy right now. Try again in a minute, or add the bill by hand in the app.

### Problem: sent text or a file

> Send me a photo of the receipt 📸 (a photo, not a file or text).

### Problem: settlement expired

> That settlement has expired (we only keep them for 24 hours). Send a receipt photo to start a new one.

## Buttons

- looksRight: Looks right ✅
- retake: Retake photo 📸
- anotherYes: Yes, another receipt
- anotherNo: That's all
- openApp: Open CanSettle
