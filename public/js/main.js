document.addEventListener('DOMContentLoaded', function() {
    const form = document.getElementById('deployForm');
    const deployBtn = document.getElementById('deployBtn');
    const progressBar = document.getElementById('progressBar');
    const progressFill = document.getElementById('progressFill');
    const statusMessage = document.getElementById('statusMessage');
    const themeToggle = document.getElementById('themeToggle');
    const themeIcon = document.getElementById('themeIcon');
    const socket = io();

    // Dark/Light Mode Toggle
    const currentTheme = localStorage.getItem('theme') || 'dark';
    document.body.setAttribute('data-bs-theme', currentTheme);
    themeIcon.className = currentTheme === 'dark' ? 'bi bi-sun-fill' : 'bi bi-moon-stars-fill';
    
    themeToggle.addEventListener('click', () => {
        const newTheme = document.body.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
        document.body.setAttribute('data-bs-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        themeIcon.className = newTheme === 'dark' ? 'bi bi-sun-fill' : 'bi bi-moon-stars-fill';
        
        // Update Bootstrap theme (reload CSS jika perlu, tapi ini cukup untuk basic)
        document.documentElement.setAttribute('data-bs-theme', newTheme);
    });

    // File Preview Function
    window.previewFile = function(input) {
        const file = input.files[0];
        const previewSection = document.getElementById('previewSection');
        const iframe = document.getElementById('htmlPreview');
        
        if (file) {
            // Validasi ukuran client-side
            if (file.size > 10 * 1024 * 1024) {
                showStatus('File terlalu besar! Maksimal 10MB.', 'error');
                input.value = '';
                previewSection.style.display = 'none';
                return;
            }
            
            // Preview HTML
            const reader = new FileReader();
            reader.onload = function(e) {
                iframe.srcdoc = e.target.result;
                previewSection.style.display = 'block';
                showStatus('Preview berhasil dimuat.', 'info');
            };
            reader.onerror = function() {
                showStatus('Gagal membaca file.', 'error');
                previewSection.style.display = 'none';
            };
            reader.readAsText(file);
        } else {
            previewSection.style.display = 'none';
        }
    };

    // Form Submit dengan AJAX & Socket.io
    form.addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(form);
        const webName = formData.get('webName');
        const file = formData.get('htmlFile');

        if (!webName || !file) {
            showStatus('Mohon lengkapi form (nama website dan file HTML)!', 'error');
            return;
        }

        // Reset status
        deployBtn.disabled = true;
        deployBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Deploying...';
        progressBar.style.display = 'block';
        progressFill.style.width = '10%';
        showStatus('Memvalidasi input...', 'info');

        try {
            // Emit start ke server via Socket.io
            socket.emit('deployStart', { socketId: socket.id });

            const response = await fetch(`/deploy?socketId=${socket.id}`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const result = await response.json();

            if (result.success) {
                progressFill.style.width = '100%';
                showStatus(`✅ Deploy berhasil! URL: <a href="${result.url}" target="_blank" class="text-decoration-none">${result.url}</a>`, 'success');
                form.reset();
                previewSection.style.display = 'none';  // Hide preview setelah sukses
            } else {
                progressBar.style.display = 'none';
                showStatus(`❌ ${result.error}`, 'error');
            }
        } catch (err) {
            progressBar.style.display = 'none';
            showStatus(`❌ Koneksi error: ${err.message}`, 'error');
        } finally {
            deployBtn.disabled = false;
            deployBtn.innerHTML = 'Deploy ke Vercel';
            setTimeout(() => progressBar.style.display = 'none', 3000);
        }
    });

    // Socket.io Listeners untuk Real-time Updates
    socket.on('deployStatus', (data) => {
        showStatus(data.message, data.status);
        switch (data.status) {
            case 'processing':
                progressFill.style.width = '50%';
                break;
            case 'success':
                progressFill.style.width = '100%';
                break;
            case 'error':
                progressBar.style.display = 'none';
                break;
        }
    });

    // Fungsi Show Status (Alert Dinamis)
    function showStatus(message, type) {
        const alertClass = type === 'success' ? 'alert-success' : type === 'error' ? 'alert-danger' : 'alert-info';
        const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
        statusMessage.innerHTML = `<div class="alert ${alertClass} d-flex align-items-center"><i class="bi ${icon === 'ℹ️' ? 'bi-info-circle' : icon === '✅' ? 'bi-check-circle' : 'bi-x-circle'} me-2"></i>${message}</div>`;
        
        if (type !== 'info') {
            setTimeout(() => {
                const alert = statusMessage.querySelector('.alert');
                if (alert) alert.remove();
            }, 5000);
        }
    }

    // Smooth Scroll untuk Navbar
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({ behavior: 'smooth' });
            }
        });
    });

    // Navbar fixed-top adjustment (padding untuk hero)
    const navbar = document.querySelector('.navbar');
    document.querySelector('.hero').style.paddingTop = navbar.offsetHeight + 'px';
});