# Athan → Alexa (TrueNAS SCALE)

A small container that:

1. Every day just after midnight, gets the prayer times for Harrison, NJ from the
   [Aladhan API](https://aladhan.com/prayer-times-api) (ISNA method).
2. At Fajr, Dhuhr, Asr, Maghrib and Isha, plays the athan on your Echo.

It uses the unofficial Alexa web API (the same one the Alexa website and Home
Assistant's Alexa Media Player use). You sign in to Amazon once. After that the
login refreshes automatically.

## Why the audio has to be public

Alexa can't play a file from your LAN. When Alexa is told to play a sound clip,
**Amazon's cloud** downloads it, not the Echo. The file must be:

- an MP3 at 48 kbps and 24 kHz, at most 240 seconds long
- on a public `https://` link

The Naghshbandi file on praytimes.org is 8 kbps / 11 kHz, so Alexa rejects it as
is. On first start the container downloads it and converts it with ffmpeg. You then
upload the converted copy somewhere public (step 5).

## Setup

### 1. Copy the files to TrueNAS

The dataset is `first_pool/Apps/athan-alexa` (SMB preset, mounted at
`/mnt/first_pool/Apps/athan-alexa`). From File Explorer, open
`\\192.168.1.200\athan-alexa` and copy `package.json` and the `src` folder into it.

### 2. Install the app

In the TrueNAS web UI, go to **Apps → Discover Apps → ⋮ (top right) → Install via YAML**.
Name it `athan-alexa`, paste the contents of `docker-compose.yaml`, and save.

On first start it installs ffmpeg and the Node package, which takes about a minute.

### 3. Sign in to Amazon (one time)

Open **http://192.168.1.200:3456** and sign in with the Amazon account your Echo
is registered to. 2-step verification works here.

Use exactly that address. The login proxy only works when the address in your
browser matches `PROXY_IP`. If you get an "alexa.amazon.com is deprecated" page
with a QR code, the address doesn't match.

Afterwards the app logs (**Apps → athan-alexa → Logs**) show something like:

```
Connected to Alexa. Speakers on this account: Living Room Echo, Kitchen Echo Dot
```

### 4. Pick your Echo

Edit the app and set `ALEXA_DEVICES` to the speaker name exactly as the log shows
it. For several speakers, separate the names with commas.

### 5. Host the converted athan

1. Download the converted file from **http://192.168.1.200:3457/athan.mp3**.
2. Upload it to a **public** GitHub repository (this repo has it as `athan.mp3`).
3. Use the file's *raw* link, not the github.com page link:
   `https://raw.githubusercontent.com/<user>/<repo>/main/athan.mp3`
   (for this repo: `https://raw.githubusercontent.com/yo955153/athan/main/athan.mp3`).
   Open it in a browser to check that it plays.
4. Edit the app and set `ATHAN_URL` to that link.

Any other public HTTPS host also works (S3, Cloudflare R2, your own domain).

Until `ATHAN_URL` is set, Alexa says "It is time for Dhuhr prayer" instead of
playing the athan. That still confirms the schedule works.

### 6. Test

- **http://192.168.1.200:3457/** shows the status and today's schedule.
- **http://192.168.1.200:3457/test** plays the athan right now.

## Settings

| Variable | Default | Notes |
|---|---|---|
| `LATITUDE` / `LONGITUDE` | `40.7465` / `-74.1563` | Harrison, NJ |
| `METHOD` | `2` | Aladhan method id. 2 is ISNA. |
| `TZ` | `America/New_York` | |
| `PRAYERS` | `Fajr,Dhuhr,Asr,Maghrib,Isha` | Remove any you don't want played |
| `TUNE` | – | Minute adjustments per prayer, e.g. `Dhuhr=1,Asr=-2` |
| `ALEXA_DEVICES` | – | Speaker name(s), comma-separated |
| `ATHAN_URL` | – | Public HTTPS link to the converted MP3 |
| `VOLUME` | – | 0–100. Sets the Echo's volume before playing; the Echo stays at that volume afterwards. |
| `MODE` | `speak` | `announce` plays Alexa's announcement chime first. Try this if `speak` doesn't work. |
| `PROXY_IP` / `PROXY_PORT` | `192.168.1.200` / `3456` | Address of the login page |
| `SOURCE_AUDIO_URL` | Naghshbandi (praytimes.org) | To change the audio, set this and delete `data/athan-alexa.mp3` |
| `DEBUG` | – | Set to `1` for verbose Alexa logs |

## Troubleshooting

- **Alexa says "Sorry, I'm having trouble…"** at prayer time. Amazon couldn't
  fetch or play the audio: check that `ATHAN_URL` opens in a private browser
  window. You can also try `MODE: announce`.
- **Nothing happens.** Check whether *Do Not Disturb* is on for the Echo, then
  look at the app logs.
- **Signed out after a long time, or after an Amazon password change.** Delete
  `data/alexa-cookie.json`, restart the app, and repeat step 3.
- **Times look off.** Check the timings at
  `https://api.aladhan.com/v1/timings?latitude=40.7465&longitude=-74.1563&method=2`
  and compare with your masjid's calendar or prayer app, then use `TUNE` to
  shift individual prayers by a few minutes.
