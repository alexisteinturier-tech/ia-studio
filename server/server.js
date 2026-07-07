/* ═══════════════════════════════════════════════════════════════
   ia studio — serveur du site (front statique + API contact)
   Node ≥ 18, AUCUNE dépendance obligatoire pour démarrer.
   - Sert ../public (le site)
   - POST /api/contact : enregistre chaque message dans server/messages/
     et l'envoie par e-mail via l'API HTTP de Resend (server/.env)
   Démarrage : node server.js   (ou : npm start)

   ℹ Pourquoi l'API HTTP de Resend plutôt que le SMTP :
   la plupart des hébergeurs cloud (Render inclus) bloquent les
   connexions SMTP sortantes (port 465/587), ce qui fait échouer
   nodemailer avec un "Connection timeout". L'API HTTP de Resend
   passe par HTTPS standard (443), jamais bloqué.
   ═══════════════════════════════════════════════════════════════ */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', 'public');
const MSG_DIR = path.join(__dirname, 'messages');
const PORT = process.env.PORT || 3000;

/* .env minimaliste (server/.env) — pas de dépendance dotenv */
(function loadEnv() {
    try {
        fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
            const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
            if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        });
    } catch (e) { /* pas de .env : ok */ }
})();

/* Resend (API HTTP) : si RESEND_API_KEY absente, les messages sont
   quand même ENREGISTRÉS dans server/messages/ et le site répond ok. */
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'ia studio <bonjour@ia-studio.fr>';
if (RESEND_API_KEY) {
    console.log('✉  Resend configuré (API HTTP)');
} else {
    console.log('✉  RESEND_API_KEY absente (server/.env) → messages enregistrés dans server/messages/ uniquement');
}

function sendViaResend({ to, replyTo, subject, text }) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ from: MAIL_FROM, to: [to], reply_to: [replyTo], subject, text });
        const req = https.request({
            hostname: 'api.resend.com',
            path: '/emails',
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + RESEND_API_KEY,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 10000
        }, r => {
            let body = '';
            r.on('data', c => body += c);
            r.on('end', () => {
                if (r.statusCode >= 200 && r.statusCode < 300) resolve(body);
                else reject(new Error('Resend HTTP ' + r.statusCode + ' : ' + body));
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
    '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
    '.woff': 'font/woff', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json', '.xml': 'application/xml'
};

function send(res, code, body, type) {
    res.writeHead(code, {
        'Content-Type': type || 'application/json; charset=utf-8',
        /* en-têtes de sécurité de base */
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    res.end(body);
}

/* limitation de débit du formulaire : max 5 envois / 10 min / IP */
const RATE = new Map();
function rateLimited(ip) {
    const now = Date.now(), windowMs = 10 * 60 * 1000;
    const arr = (RATE.get(ip) || []).filter(t => now - t < windowMs);
    if (arr.length >= 5) { RATE.set(ip, arr); return true; }
    arr.push(now); RATE.set(ip, arr);
    if (RATE.size > 5000) RATE.clear();   // garde-fou mémoire
    return false;
}

const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');

    /* ── API CONTACT ── */
    if (req.method === 'POST' && u.pathname === '/api/contact') {
        if (rateLimited(req.socket.remoteAddress || '?')) {
            return send(res, 429, '{"ok":false,"error":"trop de tentatives, réessayez dans quelques minutes"}');
        }
        let raw = '';
        req.on('data', c => { raw += c; if (raw.length > 50000) req.destroy(); });
        req.on('end', async () => {
            let d;
            try { d = JSON.parse(raw || '{}'); }
            catch (e) { return send(res, 400, '{"ok":false,"error":"json"}'); }

            /* pot de miel anti-spam : champ caché rempli = robot → on répond ok sans rien faire */
            if (d.website) return send(res, 200, '{"ok":true}');

            const email = String(d.email || '').trim();
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !String(d.message || d.prenom || '').trim()) {
                return send(res, 400, '{"ok":false,"error":"champs"}');
            }

            const entry = {
                date: new Date().toISOString(),
                prenom: String(d.prenom || '').slice(0, 120),
                email: email.slice(0, 200),
                projet: String(d.projet || '').slice(0, 120),
                message: String(d.message || '').slice(0, 4000),
                ip: req.socket.remoteAddress
            };

            /* 1) toujours enregistrer (aucun message perdu, même sans SMTP) */
            try {
                fs.mkdirSync(MSG_DIR, { recursive: true });
                const name = entry.date.replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex') + '.json';
                fs.writeFileSync(path.join(MSG_DIR, name), JSON.stringify(entry, null, 2));
            } catch (e) {
                console.error('Stockage KO :', e.message);
                return send(res, 500, '{"ok":false,"error":"stockage"}');
            }

            /* 2) envoyer par e-mail si possible (API HTTP Resend) */
            if (RESEND_API_KEY) {
                try {
                    await sendViaResend({
                        to: process.env.CONTACT_TO || 'bonjour@ia-studio.fr',
                        replyTo: entry.email,
                        subject: 'Nouveau contact — ' + (entry.projet || 'projet') + (entry.prenom ? ' · ' + entry.prenom : ''),
                        text: 'Prénom : ' + entry.prenom + '\n' +
                              'Email : ' + entry.email + '\n' +
                              'Projet : ' + entry.projet + '\n\n' +
                              'Message :\n' + entry.message + '\n\n' +
                              '— envoyé depuis le site le ' + entry.date
                    });
                } catch (e) {
                    console.error('Resend KO (message conservé dans server/messages/) :', e.message);
                }
            }
            send(res, 200, '{"ok":true}');
        });
        return;
    }

    /* ── STATIQUE ── */
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '{"ok":false}');
    let p = decodeURIComponent(u.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) return send(res, 403, 'Interdit', 'text/plain; charset=utf-8');
    fs.readFile(file, (err, buf) => {
        if (err) return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
        send(res, 200, buf, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    });
});

server.listen(PORT, () => console.log('▲ ia studio → http://localhost:' + PORT));
