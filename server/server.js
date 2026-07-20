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
            const tel = String(d.telephone || '').replace(/[^\d+]/g, '');
            const hasEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
            const hasPhone = tel.length >= 8;
            /* Un moyen de contact suffit : email valide OU numéro de téléphone
               (le formulaire « être rappelé » n'a plus de champ email). */
            if ((!hasEmail && !hasPhone) || !String(d.message || d.prenom || '').trim()) {
                return send(res, 400, '{"ok":false,"error":"champs"}');
            }

            const entry = {
                date: new Date().toISOString(),
                prenom: String(d.prenom || '').slice(0, 120),
                email: email.slice(0, 200),
                telephone: String(d.telephone || '').slice(0, 40),
                horaire: String(d.horaire || '').slice(0, 60),
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
                        replyTo: entry.email || undefined,
                        subject: 'Nouveau contact — ' + (entry.projet || 'projet') + (entry.prenom ? ' · ' + entry.prenom : ''),
                        text: 'Prénom : ' + entry.prenom + '\n' +
                              'Email : ' + (entry.email || '—') + '\n' +
                              'Téléphone : ' + (entry.telephone || '—') + '\n' +
                              'Rappel souhaité : ' + (entry.horaire || '—') + '\n' +
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
    /* ── Envoi statique AVEC support des requêtes Range ──
       Safari iOS n'accepte de lire une <video> que si le serveur sait répondre
       206 Partial Content à un en-tête Range. Sans ça il n'affiche même pas le
       poster : juste un cadre noir avec un bouton « lecture » barré. Chrome
       desktop, lui, se contente d'un 200 — d'où un bug invisible sur ordinateur
       et bloquant sur iPhone. */
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
        const ext = path.extname(file).toLowerCase();
        const type = MIME[ext] || 'application/octet-stream';
        /* Le HTML doit rester FRAIS (sinon une mise en ligne n'est pas visible
           avant 24 h) ; seuls les médias et fichiers versionnés sont mis en cache. */
        const cache = (ext === '.html' || ext === '.webmanifest' || ext === '.xml')
            ? 'no-cache'
            : 'public, max-age=86400';
        const secu = {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
        };
        const range = req.headers.range;
        const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (m) {
            let start = m[1] === '' ? null : parseInt(m[1], 10);
            let end = m[2] === '' ? null : parseInt(m[2], 10);
            if (start === null) {            /* forme « bytes=-N » : les N derniers octets */
                if (end === null || end === 0) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
                start = Math.max(0, st.size - end); end = st.size - 1;
            } else if (end === null || end >= st.size) { end = st.size - 1; }
            if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
            res.writeHead(206, Object.assign({}, secu, {
                'Content-Type': type,
                'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size,
                'Accept-Ranges': 'bytes',
                'Content-Length': end - start + 1,
                'Cache-Control': cache
            }));
            if (req.method === 'HEAD') return res.end();
            const s = fs.createReadStream(file, { start, end });
            s.on('error', () => res.destroy()); s.pipe(res);
            return;
        }
        res.writeHead(200, Object.assign({}, secu, {
            'Content-Type': type,
            'Content-Length': st.size,
            'Accept-Ranges': 'bytes',
            'Cache-Control': cache
        }));
        if (req.method === 'HEAD') return res.end();
        const s = fs.createReadStream(file);
        s.on('error', () => res.destroy()); s.pipe(res);
    });
});

server.listen(PORT, () => console.log('▲ ia studio → http://localhost:' + PORT));
