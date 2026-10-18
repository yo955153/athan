'use strict';

// Athan → Alexa
// Fetches today's prayer times from the Aladhan API and plays the athan on
// one or more Echo devices at each prayer time.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const Alexa = require('alexa-remote2');

const env = (key, fallback) => {
    const v = process.env[key];
    return v === undefined || v === '' ? fallback : v;
};
const list = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);

const config = {
    latitude: env('LATITUDE', '40.7465'),     // Harrison, NJ
    longitude: env('LONGITUDE', '-74.1563'),
    method: env('METHOD', '2'),               // 2 = ISNA
    timezone: env('TZ', 'America/New_York'),
    prayers: list(env('PRAYERS', 'Fajr,Dhuhr,Asr,Maghrib,Isha')),
    tune: env('TUNE', ''),                    // per-prayer minute offsets, e.g. "Dhuhr=1,Asr=-2"
    devices: list(env('ALEXA_DEVICES', '')),
    athanUrl: env('ATHAN_URL', ''),           // public HTTPS link to the converted MP3
    sourceAudioUrl: env('SOURCE_AUDIO_URL', 'https://praytimes.org/audio/sunni/Naghshbandi.mp3'),
    volume: env('VOLUME', ''),                // 0-100, optional
    mode: env('MODE', 'speak'),               // "speak" (no chime) or "announce" (announcement chime first)
    proxyIp: env('PROXY_IP', '192.168.1.200'),
    proxyPort: Number(env('PROXY_PORT', '3456')),
    statusPort: Number(env('STATUS_PORT', '3457')),
    dataDir: env('DATA_DIR', '/data'),
    debug: env('DEBUG', '') !== '',
};

const cookiePath = path.join(config.dataDir, 'alexa-cookie.json');
const sourceAudioPath = path.join(config.dataDir, 'athan-source.mp3');
const alexaAudioPath = path.join(config.dataDir, 'athan-alexa.mp3');

const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const stampFmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: config.timezone, dateStyle: 'short', timeStyle: 'medium',
});

function log(msg) {
    console.log(`[${stampFmt.format(new Date())}] ${msg}`);
}

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, (err, stdout, stderr) => {
            if (err) return reject(new Error(`${cmd} failed: ${stderr || err.message}`));
            resolve(stdout.trim());
        });
    });
}

// ---------------------------------------------------------------------------
// Audio: Alexa only plays SSML <audio> clips that are MP3, 48 kbps,
// 16/22.05/24 kHz, at most 240 s, served over public HTTPS. We convert the
// source once and expose it at http://<server>:3457/athan.mp3 so it can be
// uploaded somewhere public.
// ---------------------------------------------------------------------------

async function prepareAudio() {
    if (fs.existsSync(alexaAudioPath)) return;
    log(`Downloading athan audio from ${config.sourceAudioUrl}`);
    const res = await fetch(config.sourceAudioUrl, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading athan audio`);
    fs.writeFileSync(sourceAudioPath, Buffer.from(await res.arrayBuffer()));

    await run('ffmpeg', [
        '-y', '-loglevel', 'error', '-i', sourceAudioPath,
        '-t', '239', '-af', 'loudnorm=I=-14:TP=-1.5',
        '-ac', '2', '-codec:a', 'libmp3lame', '-b:a', '48k', '-ar', '24000', '-write_xing', '0',
        alexaAudioPath,
    ]);
    const duration = await run('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', alexaAudioPath,
    ]);
    log(`Converted athan for Alexa (${Math.round(Number(duration))} s) -> ${alexaAudioPath}`);
}

// ---------------------------------------------------------------------------
// Alexa connection (unofficial Alexa web API via alexa-remote2). The first
// time, sign in to Amazon through the login proxy on PROXY_PORT; the tokens
// are saved to /data and refreshed automatically after that.
// ---------------------------------------------------------------------------

const alexa = new Alexa();
let alexaReady = false;
let alexaStatus = 'starting';

alexa.on('cookie', () => {
    if (!alexa.cookieData) return;
    fs.writeFileSync(cookiePath, JSON.stringify(alexa.cookieData));
    log('Saved Amazon login tokens');
});

function startAlexa() {
    let saved;
    try {
        saved = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
    } catch {
        saved = undefined;
    }

    const options = {
        cookie: saved,
        formerRegistrationData: saved,
        proxyOnly: true,
        setupProxy: true,
        proxyOwnIp: config.proxyIp,
        proxyPort: config.proxyPort,
        proxyListenBind: '0.0.0.0',
        proxyLogLevel: 'warn',
        amazonPage: 'amazon.com',
        baseAmazonPage: 'amazon.com',
        alexaServiceHost: 'pitangui.amazon.com',
        acceptLanguage: 'en-US',
        amazonPageProxyLanguage: 'en_US',
        cookieRefreshInterval: 4 * 24 * 60 * 60 * 1000,
        logger: config.debug ? console.log : undefined,
    };
    if (saved && saved.macDms) options.macDms = saved.macDms;

    // This callback fires more than once: first with a "Please open ..." error
    // while waiting for the proxy login, then again after login and after
    // every automatic token refresh.
    alexa.init(options, (err) => {
        if (err) {
            if (/Please open/.test(err.message)) {
                alexaStatus = `waiting for Amazon login at http://${config.proxyIp}:${config.proxyPort}/`;
                log(`Amazon login needed: open http://${config.proxyIp}:${config.proxyPort}/ in a browser and sign in.`);
            } else {
                alexaStatus = `error: ${err.message}`;
                log(`Alexa connection failed: ${err.message}. Retrying in 5 minutes.`);
                setTimeout(startAlexa, 5 * 60 * 1000);
            }
            return;
        }
        alexaReady = true;
        alexaStatus = 'connected';
        log(`Connected to Alexa. Speakers on this account: ${speakerNames().join(', ') || '(none found)'}`);
        const missing = config.devices.filter((d) => !alexa.find(d));
        if (!config.devices.length) {
            log('ALEXA_DEVICES is empty: set it to one or more of the speaker names above.');
        } else if (missing.length) {
            log(`Unknown device name(s) in ALEXA_DEVICES: ${missing.join(', ')}`);
        }
    });
}

function speakerNames() {
    const seen = new Set();
    return Object.values(alexa.serialNumbers)
        .filter((d) => d.isControllable && !seen.has(d.serialNumber) && seen.add(d.serialNumber))
        .map((d) => d.accountName);
}

function escapeXml(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function playAthan(prayer) {
    if (!alexaReady) {
        log(`${prayer}: skipped, not signed in to Amazon (${alexaStatus})`);
        return;
    }
    if (!config.devices.length) {
        log(`${prayer}: skipped, ALEXA_DEVICES is empty`);
        return;
    }
    const ssml = config.athanUrl
        ? `<speak><audio src="${escapeXml(config.athanUrl)}"/></speak>`
        : `<speak>It is time for ${prayer} prayer.</speak>`;

    for (const device of config.devices) {
        const commands = [];
        if (config.volume !== '') commands.push({ command: 'volume', value: Number(config.volume) });
        commands.push({ command: config.mode === 'announce' ? 'ssml' : 'speak', value: ssml });

        alexa.sendMultiSequenceCommand(device, commands, 'SerialNode', null, (err) => {
            if (err) log(`${prayer}: failed on "${device}": ${err.message}`);
            else log(`${prayer}: athan sent to "${device}"`);
        });
    }
}

// ---------------------------------------------------------------------------
// Prayer times (Aladhan API). iso8601=true returns full timestamps with the
// UTC offset, so daylight-saving changes are handled for us.
// ---------------------------------------------------------------------------

let schedule = [];   // [{ prayer, at: Date }]
let timers = [];

function localDateParts(date) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-GB', {
            timeZone: config.timezone, day: '2-digit', month: '2-digit', year: 'numeric',
        }).formatToParts(date).map((p) => [p.type, p.value]),
    );
    return parts;
}

// Aladhan's "tune" parameter: minute offsets in this fixed order.
const TUNE_ORDER = ['Imsak', 'Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Sunset', 'Isha', 'Midnight'];

function tuneParam() {
    const offsets = Object.fromEntries(TUNE_ORDER.map((name) => [name, 0]));
    for (const entry of list(config.tune)) {
        const [name, minutes] = entry.split('=').map((s) => s.trim());
        const key = TUNE_ORDER.find((n) => n.toLowerCase() === (name || '').toLowerCase());
        if (!key || !/^[+-]?\d+$/.test(minutes || '')) {
            log(`Ignoring invalid TUNE entry "${entry}" (expected e.g. Dhuhr=1 or Asr=-2)`);
            continue;
        }
        offsets[key] = Number(minutes);
    }
    return TUNE_ORDER.map((name) => offsets[name]).join(',');
}

async function fetchTimings(date) {
    const { day, month, year } = localDateParts(date);
    const params = new URLSearchParams({
        latitude: config.latitude,
        longitude: config.longitude,
        method: config.method,
        timezonestring: config.timezone,
        iso8601: 'true',
    });
    if (config.tune) params.set('tune', tuneParam());
    const url = `https://api.aladhan.com/v1/timings/${day}-${month}-${year}?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.code !== 200) {
        throw new Error(`Aladhan API: HTTP ${res.status} ${body ? JSON.stringify(body.data) : ''}`);
    }
    return body.data.timings;
}

async function scheduleToday() {
    timers.forEach(clearTimeout);
    timers = [];
    const now = new Date();

    let timings;
    try {
        timings = await fetchTimings(now);
    } catch (err) {
        log(`Could not fetch prayer times (${err.message}). Retrying in 10 minutes.`);
        timers.push(setTimeout(scheduleToday, 10 * 60 * 1000));
        return;
    }

    schedule = [];
    for (const prayer of config.prayers) {
        const at = new Date(timings[prayer]);
        if (!timings[prayer] || Number.isNaN(at.getTime())) {
            log(`Unknown prayer name "${prayer}" in PRAYERS (valid: ${Object.keys(timings).join(', ')})`);
            continue;
        }
        schedule.push({ prayer, at });
        if (at > now) timers.push(setTimeout(() => playAthan(prayer), at - now));
    }
    log(`Today's times: ${schedule.map((s) => `${s.prayer} ${timeFmt.format(s.at)}`).join(', ')}`);

    // Refresh at 00:05 tomorrow. The process runs with TZ set to the same
    // timezone, so local-time date math here is correct across DST changes.
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 5, 0, 0);
    timers.push(setTimeout(scheduleToday, tomorrow - now));
}

// ---------------------------------------------------------------------------
// Status page on STATUS_PORT:
//   /           status and today's schedule
//   /test       play the athan right now
//   /athan.mp3  the converted Alexa-ready file (upload this somewhere public)
// ---------------------------------------------------------------------------

function startStatusServer() {
    http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/athan.mp3' && fs.existsSync(alexaAudioPath)) {
            res.writeHead(200, {
                'Content-Type': 'audio/mpeg',
                'Content-Disposition': 'attachment; filename="athan-alexa.mp3"',
            });
            fs.createReadStream(alexaAudioPath).pipe(res);
            return;
        }
        if (url.pathname === '/test') {
            playAthan('Test');
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Sent the athan to Alexa. Check the container logs if nothing plays.\n');
            return;
        }
        if (url.pathname !== '/') {
            res.writeHead(404).end();
            return;
        }
        const now = new Date();
        const next = schedule.find((s) => s.at > now);
        const lines = [
            'Athan -> Alexa',
            '',
            `Alexa:          ${alexaStatus}`,
            `Devices:        ${config.devices.join(', ') || '(ALEXA_DEVICES not set)'}`,
            `Available:      ${alexaReady ? speakerNames().join(', ') : '-'}`,
            `Athan URL:      ${config.athanUrl || '(not set, Alexa will speak the prayer name instead)'}`,
            `Location:       ${config.latitude}, ${config.longitude}  method ${config.method}`,
            `Adjustments:    ${config.tune || 'none'}`,
            '',
            "Today's schedule:",
            ...schedule.map((s) => `  ${s.prayer.padEnd(8)} ${timeFmt.format(s.at)}${s.at <= now ? '  (passed)' : ''}`),
            '',
            `Next:           ${next ? `${next.prayer} at ${timeFmt.format(next.at)}` : 'tomorrow'}`,
            '',
            '/test       play the athan now',
            '/athan.mp3  download the Alexa-ready MP3',
        ];
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(lines.join('\n') + '\n');
    }).listen(config.statusPort, () => log(`Status page on port ${config.statusPort}`));
}

async function main() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    log(`Starting: ${config.latitude}, ${config.longitude}, method ${config.method}, tz ${config.timezone}`);
    if (!config.athanUrl) {
        log('ATHAN_URL is not set: Alexa will say the prayer name instead of playing the athan.');
    }
    startStatusServer();
    try {
        await prepareAudio();
    } catch (err) {
        log(`Audio conversion failed: ${err.message}`);
    }
    startAlexa();
    await scheduleToday();
}

main();
