const express = require('express');
const puppeteer = require('puppeteer');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const jobs = {};

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/scrape', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const jobId = uuidv4();
    jobs[jobId] = {
        status: 'starting',
        progress: 0,
        totalImages: 0,
        downloadedImages: 0,
        message: 'Initializing...',
        zipReady: false
    };

    res.json({ jobId });
    scrapeImages(jobId, url).catch(err => {
        jobs[jobId].status = 'error';
        jobs[jobId].message = err.message;
    });
});

app.get('/api/status/:jobId', (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

app.get('/api/download/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs[jobId];
    if (!job || !job.zipReady) return res.status(404).json({ error: 'ZIP not ready' });

    const zipPath = path.join(__dirname, 'temp', jobId, 'images.zip');
    if (!fs.existsSync(zipPath)) return res.status(404).json({ error: 'ZIP file not found' });

    res.download(zipPath, 'scraped-images.zip', (err) => {
        if (err) console.error('Download error:', err);
        setTimeout(() => cleanupJob(jobId), 60000);
    });
});

async function scrapeImages(jobId, url) {
    const tempDir = path.join(__dirname, 'temp', jobId);
    const imagesDir = path.join(tempDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });

    jobs[jobId].status = 'launching_browser';
    jobs[jobId].message = 'Launching browser...';

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        jobs[jobId].status = 'loading_page';
        jobs[jobId].message = 'Loading page...';

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        jobs[jobId].message = 'Scrolling page to load all images...';
        await autoScroll(page);
        await delay(2000);

        jobs[jobId].status = 'collecting';
        jobs[jobId].message = 'Collecting image URLs...';

        const imageData = await page.evaluate(() => {
            const results = [];
            const seen = new Set();

            function getBestSrc(el) {
                const srcset = el.getAttribute('srcset');
                if (srcset) {
                    const candidates = srcset.split(',').map(s => {
                        const parts = s.trim().split(/\s+/);
                        const url = parts[0];
                        const descriptor = parts[1] || '1x';
                        let weight = 1;
                        if (descriptor.endsWith('w')) weight = parseInt(descriptor);
                        else if (descriptor.endsWith('x')) weight = parseFloat(descriptor) * 1000;
                        return { url, weight };
                    });
                    candidates.sort((a, b) => b.weight - a.weight);
                    if (candidates.length > 0) return candidates[0].url;
                }
                const dataSrc = el.getAttribute('data-src') ||
                    el.getAttribute('data-original') ||
                    el.getAttribute('data-lazy-src') ||
                    el.getAttribute('data-full-src');
                if (dataSrc) return dataSrc;
                return el.src || el.currentSrc;
            }

            document.querySelectorAll('img').forEach((img, index) => {
                const src = getBestSrc(img);
                if (src && !seen.has(src) && !src.startsWith('data:')) {
                    if (img.naturalWidth > 50 || img.width > 50 || !img.naturalWidth) {
                        seen.add(src);
                        results.push({
                            src,
                            isClickable: !!(img.closest('a') || img.closest('[data-fancybox]') || img.closest('[class*="gallery"]') || img.closest('[class*="thumb"]')),
                            parentLink: img.closest('a') ? img.closest('a').href : null,
                            index
                        });
                    }
                }
            });

            document.querySelectorAll('*').forEach(el => {
                const bg = getComputedStyle(el).backgroundImage;
                if (bg && bg !== 'none') {
                    const match = bg.match(/url\(["']?(.*?)["']?\)/);
                    if (match && match[1] && !match[1].startsWith('data:') && !seen.has(match[1])) {
                        seen.add(match[1]);
                        results.push({ src: match[1], isClickable: false, parentLink: null, index: results.length });
                    }
                }
            });

            return results;
        });

        jobs[jobId].totalImages = imageData.length;
        jobs[jobId].message = `Found ${imageData.length} images. Getting highest quality...`;

        const highQualityUrls = [];

        for (let i = 0; i < imageData.length; i++) {
            const img = imageData[i];
            let bestUrl = img.src;

            jobs[jobId].message = `Checking image ${i + 1}/${imageData.length} for higher quality...`;
            jobs[jobId].progress = Math.round(((i + 1) / imageData.length) * 50);

            try {
                if (img.parentLink) {
                    const link = img.parentLink;
                    if (/\.(jpg|jpeg|png|gif|webp|bmp|tiff|svg)(\?.*)?$/i.test(link)) {
                        bestUrl = link;
                    } else {
                        const newPage = await browser.newPage();
                        try {
                            await newPage.goto(link, { waitUntil: 'networkidle2', timeout: 15000 });
                            const largestImg = await newPage.evaluate(() => {
                                let best = null, bestArea = 0;
                                document.querySelectorAll('img').forEach(img => {
                                    const area = (img.naturalWidth || 0) * (img.naturalHeight || 0);
                                    if (area > bestArea && img.src && !img.src.startsWith('data:')) {
                                        bestArea = area;
                                        best = img.src;
                                    }
                                });
                                return best;
                            });
                            if (largestImg) bestUrl = largestImg;
                        } catch (e) {
                        } finally {
                            await newPage.close();
                        }
                    }
                }

                const upgradedUrl = tryUpgradeUrl(bestUrl);
                if (upgradedUrl !== bestUrl) bestUrl = upgradedUrl;
            } catch (err) {
                console.log(`Could not upgrade image ${i}: ${err.message}`);
            }

            try {
                bestUrl = new URL(bestUrl, url).href;
            } catch (e) {
                continue;
            }

            if (!highQualityUrls.includes(bestUrl)) highQualityUrls.push(bestUrl);
        }

        jobs[jobId].status = 'downloading';
        jobs[jobId].totalImages = highQualityUrls.length;
        jobs[jobId].message = `Downloading ${highQualityUrls.length} images...`;

        let downloaded = 0;

        for (let i = 0; i < highQualityUrls.length; i++) {
            const imgUrl = highQualityUrls[i];
            try {
                jobs[jobId].message = `Downloading image ${i + 1}/${highQualityUrls.length}...`;
                const ext = getExtension(imgUrl);
                const filename = `image_${String(i + 1).padStart(4, '0')}${ext}`;
                const filepath = path.join(imagesDir, filename);
                await downloadFile(page, imgUrl, filepath);
                downloaded++;
                jobs[jobId].downloadedImages = downloaded;
                jobs[jobId].progress = 50 + Math.round(((i + 1) / highQualityUrls.length) * 45);
            } catch (err) {
                console.log(`Failed to download ${imgUrl}: ${err.message}`);
            }
        }

        jobs[jobId].status = 'zipping';
        jobs[jobId].message = 'Creating ZIP file...';
        jobs[jobId].progress = 95;

        const zipPath = path.join(tempDir, 'images.zip');
        await createZip(imagesDir, zipPath);

        jobs[jobId].status = 'done';
        jobs[jobId].progress = 100;
        jobs[jobId].zipReady = true;
        jobs[jobId].downloadedImages = downloaded;
        jobs[jobId].message = `Done! ${downloaded} images ready.`;

    } finally {
        await browser.close();
    }
}

function tryUpgradeUrl(url) {
    let u = url;
    u = u.replace(/-\d+x\d+(\.\w+)(\?.*)?$/, '$1$2');
    u = u.replace(/_\d+x(\.\w+)/, '$1');
    u = u.replace(/[?&](w|h|width|height|resize|size|quality|q)=[^&]*/gi, '');
    u = u.replace(/\/thumb(nail)?s?\//i, '/');
    u = u.replace(/\/small\//i, '/large/');
    u = u.replace(/\/medium\//i, '/large/');
    u = u.replace(/=s\d+(-c)?$/, '=s0');
    u = u.replace(/=w\d+-h\d+(-c)?$/, '=s0');
    u = u.replace(/\/cdn-cgi\/image\/[^/]+\//i, '/');
    u = u.replace(/\?$/, '');
    return u;
}

async function downloadFile(page, url, filepath) {
    try {
        const buffer = await page.evaluate(async (downloadUrl) => {
            const response = await fetch(downloadUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            const arrayBuffer = await blob.arrayBuffer();
            return Array.from(new Uint8Array(arrayBuffer));
        }, url);
        fs.writeFileSync(filepath, Buffer.from(buffer));
    } catch (e) {
        await downloadFileDirect(url, filepath);
    }
}

function downloadFileDirect(url, filepath) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(filepath);
        protocol.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
            }
        }, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                file.close();
                try { fs.unlinkSync(filepath); } catch(e) {}
                return downloadFileDirect(response.headers.location, filepath).then(resolve).catch(reject);
            }
            if (response.statusCode !== 200) {
                file.close();
                try { fs.unlinkSync(filepath); } catch(e) {}
                return reject(new Error(`HTTP ${response.statusCode}`));
            }
            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
            file.on('error', (err) => { try { fs.unlinkSync(filepath); } catch(e) {} reject(err); });
        }).on('error', (err) => { try { fs.unlinkSync(filepath); } catch(e) {} reject(err); });
    });
}

function createZip(sourceDir, outputPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 5 } });
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        const files = fs.readdirSync(sourceDir);
        for (const file of files) {
            const filePath = path.join(sourceDir, file);
            const stat = fs.statSync(filePath);
            if (stat.isFile() && stat.size > 0) archive.file(filePath, { name: file });
        }
        archive.finalize();
    });
}

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 500;
            const timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= document.body.scrollHeight) {
                    clearInterval(timer);
                    window.scrollTo(0, 0);
                    resolve();
                }
            }, 200);
            setTimeout(() => { clearInterval(timer); window.scrollTo(0, 0); resolve(); }, 30000);
        });
    });
}

function getExtension(url) {
    try {
        const pathname = new URL(url).pathname;
        const match = pathname.match(/\.(jpg|jpeg|png|gif|webp|bmp|svg|tiff|avif)$/i);
        if (match) return '.' + match[1].toLowerCase();
    } catch (e) {}
    return '.jpg';
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function cleanupJob(jobId) {
    const tempDir = path.join(__dirname, 'temp', jobId);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    delete jobs[jobId];
}

setInterval(() => {
    const tempBase = path.join(__dirname, 'temp');
    if (fs.existsSync(tempBase)) {
        const dirs = fs.readdirSync(tempBase);
        for (const dir of dirs) {
            const dirPath = path.join(tempBase, dir);
            try {
                const stat = fs.statSync(dirPath);
                if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) {
                    fs.rmSync(dirPath, { recursive: true, force: true });
                    delete jobs[dir];
                }
            } catch (e) {}
        }
    }
}, 5 * 60 * 1000);

app.listen(PORT, () => console.log(`Running on port ${PORT}`));
