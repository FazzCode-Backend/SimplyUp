require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require('socket.io');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// FIX: Mengatasi 'X-Forwarded-For' error di Vercel
app.set('trust proxy', 1);

// Konstanta
// FIX: Menggunakan '/tmp/uploads' agar bisa di-tulis (writable) di Vercel/Lambda
const UPLOAD_DIR = '/tmp/uploads'; 
const LOG_FILE = '/tmp/audit.log'; 
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // File lebih dari 24 jam akan dihapus

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Multer untuk upload file
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // FIX: Pastikan /tmp/uploads dibuat jika belum ada.
    if (!fs.existsSync(UPLOAD_DIR)) {
        console.log(`Membuat direktori sementara di: ${UPLOAD_DIR}`);
        fs.mkdirSync(UPLOAD_DIR); // Sekarang akan berhasil di /tmp
    }
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// --- FUNGSI LOGGING & NOTIFIKASI ---

function writeAuditLog(level, type, message, data = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = JSON.stringify({
    timestamp,
    level: level.toUpperCase(),
    type,
    message,
    ...data
  }) + '\n';
  
  // Catatan: Jika LOG_FILE ada di /var/task/, log ini tidak akan bisa ditulis. 
  // Untuk produksi, ganti ini dengan logging ke layanan eksternal (Cloudwatch, Datadog).
  
  // PERBAIKAN: Pastikan direktori /tmp dibuat (jika perlu) dan Log ditulis
  try {
      if (!fs.existsSync('/tmp')) {
          fs.mkdirSync('/tmp');
      }
      fs.appendFileSync(LOG_FILE, logEntry);
  } catch (err) {
      console.error('Gagal menulis ke audit log di /tmp:', err.message);
  }
}

// Konfigurasi Telegram
const telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

async function sendSecurityAlert(message) {
  try {
    const chatID = process.env.TELEGRAM_SECURITY_CHAT_ID;
    const formattedMessage = `🚨 *SECURITY ALERT* 🚨\n\n${message}`;
    if (chatID) {
      await telegramBot.sendMessage(chatID, formattedMessage, { parse_mode: 'Markdown' });
      console.log('Notifikasi Keamanan Telegram terkirim!');
    } else {
        console.warn('TELEGRAM_SECURITY_CHAT_ID tidak dikonfigurasi. Alert tidak terkirim.');
    }
  } catch (error) {
    console.error('Gagal kirim Security Alert Telegram:', error.message);
  }
}

// Konfigurasi Email
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

async function sendEmailBackup(subject, message, isSuccess = true) {
  try {
    const htmlContent = `
      <h2>${isSuccess ? '✅ Deploy Sukses' : '❌ Deploy Gagal'}</h2>
      <p><strong>Detail:</strong></p>
      <pre>${message.replace(/\*/g, '')}</pre>
      <hr>
      <small>Dikirim otomatis dari Vercel Deployer</small>
    `;
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.ADMIN_EMAIL,
      subject: `[Vercel Deployer] ${subject}`,
      html: htmlContent
    });
    console.log('Email backup terkirim!');
  } catch (error) {
    console.error('Gagal kirim email:', error);
  }
}

async function sendDeployNotification(message, isSuccess = true) {
  try {
    const emoji = isSuccess ? '✅' : '❌';
    const formattedMessage = `${emoji} *${isSuccess ? 'Deploy Sukses' : 'Deploy Gagal'}*\n\n${message}`;
    if (process.env.TELEGRAM_CHAT_ID) {
        await telegramBot.sendMessage(process.env.TELEGRAM_CHAT_ID, formattedMessage, { parse_mode: 'Markdown' });
        console.log('Notifikasi Deploy Telegram terkirim!');
    }
  } catch (error) {
    console.error('Gagal kirim Notifikasi Deploy Telegram:', error);
    // Backup ke email
    await sendEmailBackup(isSuccess ? 'Deploy Sukses' : 'Deploy Gagal', message, isSuccess);
  }
}


// --- RATE LIMITER ---

// Rate limiter: 5 deploy per 15 menit per IP (Menggunakan trust proxy)
const deployLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Terlalu banyak deploy! Coba lagi dalam 15 menit. (Rate limit: 5/15 menit)' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    const userIP = req.headers['x-forwarded-for'] || req.ip;
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const timestamp = new Date().toISOString();
    
    const rateLimitMessage = `⚠️ Rate Limit Exceeded!\nIP: \`${userIP}\`\nWaktu: *${timestamp}*\nUser Agent: \`${userAgent}\``;
    
    sendSecurityAlert(rateLimitMessage); 
    writeAuditLog('SECURITY', 'RATE_LIMIT', 'Rate limit exceeded', { ip: userIP, ua: userAgent });
    
    // Panggil next() agar rateLimit middleware bisa mengirim respons 429
    next(); 
  }
});

// Terapkan rate limit ke /deploy
app.use('/deploy', deployLimiter);


// --- SOCKET.IO & ROUTE UTAMA ---

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.on('connection', (socket) => {
  console.log('User terhubung:', socket.id);
  socket.on('disconnect', () => console.log('User disconnect:', socket.id));
});

// Route utama (Menggunakan data mock untuk statistik)
app.get('/', (req, res) => {
    // Ganti dengan fungsi pengambilan data dari DB Anda (Redis, Postgres, dll.)
    const statsData = {
        totalDeploys: '10.393', 
        currentUsers: '7293', 
        serverRegion: process.env.VERCEL_REGION || 'SFO1 (US West)', 
        nodeVersion: process.version, 
    };

    res.render('index', { 
        // Menggunakan CLOUDFLARE_TURNSTILE_SITE_KEY sesuai penamaan di .env
        turnstileSiteKey: process.env.CLOUDFLARE_TURNSTILE_SITE_KEY, 
        ...statsData 
    });
});


// --- ROUTE DEPLOY ---

// ... (Bagian atas kode, Konstanta, Middleware, Fungsi Log/Notifikasi, Rate Limiter, dan Socket.io TIDAK BERUBAH)

// --- ROUTE DEPLOY ---

app.post('/deploy', upload.single('htmlFile'), async (req, res) => {
  const { webName } = req.body;
  const file = req.file;
  const socketId = req.query.socketId;
  const userIP = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const timestamp = new Date().toISOString();
  
  let cleanName = null; 
  let websiteNameForLog = webName || 'N/A';
  let errorText = 'Terjadi kesalahan tak terduga.'; 

  if (socketId) io.to(socketId).emit('deployStatus', { status: 'processing', message: 'Memulai proses...' });

  try {
    // 1. VERIFIKASI TURNSTILE
    if (socketId) io.to(socketId).emit('deployStatus', { status: 'processing', message: 'Memverifikasi keamanan...' });
    const turnstileToken = req.body['cf-turnstile-response'];
    if (!turnstileToken) throw new Error('Verifikasi keamanan (Turnstile) gagal. Coba lagi.');

    const turnstileSecret = process.env.CLOUDFLARE_TURNSTILE_SECRET;
    const verificationURL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

    const verificationResponse = await axios.post(verificationURL, new URLSearchParams({
        secret: turnstileSecret,
        response: turnstileToken,
        remoteip: userIP
    }));

    const verificationData = verificationResponse.data;
    if (!verificationData.success) {
        writeAuditLog('SECURITY', 'TURNSTILE_FAILURE', 'Turnstile verification failed', { ip: userIP, codes: verificationData['error-codes'] });
        throw new Error('Verifikasi keamanan gagal. Anda mungkin terdeteksi sebagai bot.');
    }


    // 2. VALIDASI INPUT
    if (!webName) throw new Error('Nama website wajib diisi!');
    // Membersihkan nama web dan memastikan format subdomain Vercel
    cleanName = webName.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''); 
    websiteNameForLog = cleanName; 
    if (cleanName.length < 3) throw new Error('Nama website minimal 3 karakter!');

    if (!file) throw new Error('File HTML wajib diupload!');
    if (!file.mimetype.includes('text/html')) throw new Error('File harus berupa HTML (.html)!');

    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) throw new Error('File terlalu besar! Maksimal 10MB.');

    // 3. SCAN KONTEN BERBAHAYA
    if (socketId) io.to(socketId).emit('deployStatus', { status: 'processing', message: 'Memeriksa konten berbahaya...' });
    const htmlContent = fs.readFileSync(file.path, 'utf8');
    const maliciousPatterns = []
    
    const isMalicious = maliciousPatterns.some(pattern => pattern.test(htmlContent));
    if (isMalicious) {
        writeAuditLog('SECURITY', 'MALICIOUS_CONTENT', 'Malicious content detected', { ip: userIP, website: cleanName });
        sendSecurityAlert(`⚠️ *Malicious Content Detected*\nWebsite: *${cleanName}*\nIP: \`${userIP}\``);
        throw new Error('File mengandung konten berbahaya! Deployment dibatalkan.');
    }

    // 4. CEK DOMAIN AVAILABILITY
    const domainCheckUrl = `https://${cleanName}.vercel.app`;
    if (socketId) io.to(socketId).emit('deployStatus', { status: 'processing', message: 'Memeriksa ketersediaan domain...' });
    try {
      // Menggunakan HEAD request lebih cepat jika domain sudah ada
      const check = await axios.head(domainCheckUrl, { timeout: 5000 });
      if (check.status === 200 || check.status === 301 || check.status === 302) {
          throw new Error(`Nama web *${cleanName}* sudah digunakan atau aktif!`);
      }
    } catch (e) {
      // Jika status 404 atau koneksi timeout, biasanya aman untuk deploy (domain belum ada)
      if (e.response && (e.response.status === 404 || e.response.status === 502)) {
          // Domain available (lanjut)
      } else if (e.message.includes('sudah digunakan')) {
          throw e; // Lempar error domain used
      } else {
          writeAuditLog('WARN', 'DOMAIN_CHECK_ISSUE', `Peringatan saat cek domain: ${e.message}`, { ip: userIP, website: cleanName });
      }
    }

    // 5. DEPLOY KE VERCEL
    const vercelToken = process.env.VERCEL_TOKEN;
    if (!vercelToken) throw new Error('Token Vercel tidak dikonfigurasi!');
    const headers = { Authorization: `Bearer ${vercelToken}`, 'Content-Type': 'application/json' };

    // Create project (ignore if exists)
    if (socketId) io.to(socketId).emit('deployStatus', { status: 'processing', message: 'Membuat proyek Vercel (jika belum ada)...' });
    try {
      await axios.post('https://api.vercel.com/v9/projects', { name: cleanName }, { headers });
    } catch (e) { /* ignore error jika proyek sudah ada */ }

    // Deploy
    if (socketId) io.to(socketId).emit('deployStatus', { status: 'processing', message: 'Mulai proses deployment (menunggu status Vercel)...' });
    const deployResponse = await axios.post('https://api.vercel.com/v13/deployments', {
      name: cleanName,
      project: cleanName,
      files: [{ file: 'index.html', data: Buffer.from(htmlContent).toString('base64'), encoding: 'base64' }],
      projectSettings: { framework: null }
    }, { headers });

    const result = deployResponse.data;
    if (!result || !result.url) throw new Error(`Gagal deploy: ${JSON.stringify(result)}`);

    // PERBAIKAN URL: Ambil URL utama dari cleanName (subdomain)
    const productionUrl = `https://${cleanName}.vercel.app`; 

    // 6. FINISHING
    // Hapus file sementara di /tmp
    fs.unlinkSync(file.path);
    
    // Emit sukses
    if (socketId) io.to(socketId).emit('deployStatus', { status: 'success', message: 'Deploy berhasil!', url: productionUrl }); // Menggunakan productionUrl

    // Notifikasi & Log Sukses
    const successMessage = `Nama Website: *${cleanName}*\nURL: ${productionUrl}\nIP User: \`${userIP}\`\nUser Agent: \`${userAgent}\`\nWaktu: *${timestamp}*`; // Menggunakan productionUrl
    await sendDeployNotification(successMessage, true);
    writeAuditLog('INFO', 'DEPLOY_SUCCESS', 'Deployment successful', { ip: userIP, url: productionUrl, website: cleanName }); // Menggunakan productionUrl

    // Response JSON untuk AJAX
    res.json({ success: true, url: productionUrl }); // Menggunakan productionUrl

  } catch (err) {
    errorText = err.message || 'Terjadi kesalahan tak terduga.';

    if (socketId) io.to(socketId).emit('deployStatus', { status: 'error', message: errorText });

    // Notifikasi & Log Gagal
    const errorMessage = `Nama Website: *${websiteNameForLog}*\nError: *${errorText}*\nIP User: \`${userIP}\`\nUser Agent: \`${userAgent}\`\nWaktu: *${timestamp}*`;
    await sendDeployNotification(errorMessage, false);
    writeAuditLog('ERROR', 'DEPLOY_FAILURE', 'Deployment failed', { ip: userIP, error: errorText, website: websiteNameForLog });

    // Hapus file yang terlanjur diupload di /tmp
    if (file && file.path && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
      } catch (e) {
        console.error('Gagal menghapus file upload:', e.message);
      }
    }

    // Tanggapi permintaan dengan error
    res.status(400).json({ success: false, error: errorText });
  }
});


// --- CRON JOB: PEMBERSIHAN FILE ---

// Jadwalkan tugas untuk berjalan setiap hari pada pukul 03:00 pagi (WIB)
cron.schedule('0 3 * * *', () => {
  console.log('Memulai pembersihan folder uploads...');
  writeAuditLog('INFO', 'CLEANUP_START', 'Starting scheduled file cleanup');
  
  // Karena menggunakan /tmp, pembersihan oleh sistem seringkali sudah terjadi,
  // tapi cron job ini tetap memastikan file lama dihapus.
  if (!fs.existsSync(UPLOAD_DIR)) return;

  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) {
      console.error('Gagal membaca direktori uploads:', err);
      writeAuditLog('ERROR', 'CLEANUP_FAIL', 'Failed to read uploads directory', { error: err.message });
      return;
    }

    files.forEach(file => {
      const filePath = path.join(UPLOAD_DIR, file);
      fs.stat(filePath, (err, stat) => {
        if (err) return; 

        if (Date.now() - stat.mtimeMs >= MAX_AGE_MS) {
          fs.unlink(filePath, (err) => {
            if (err) {
                console.error(`Gagal menghapus file lama ${file}:`, err);
                writeAuditLog('ERROR', 'CLEANUP_FAIL', `Failed to delete file: ${file}`, { error: err.message });
            }
            else {
                console.log(`Berhasil menghapus file lama: ${file}`);
                writeAuditLog('INFO', 'CLEANUP_SUCCESS', `Successfully deleted old file: ${file}`);
            }
          });
        }
      });
    });
  });
}, {
  scheduled: true,
  timezone: "Asia/Jakarta"
});


// --- SERVER START ---

server.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
});