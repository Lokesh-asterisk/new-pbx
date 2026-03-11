import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
const MAX_SIZE = 2 * 1024 * 1024; // 2MB
const ALLOWED_TYPES = /^image\/(png|jpeg|jpg|gif|webp|svg\+xml|ico|x-icon)$/;

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    const safe = (file.originalname || 'file').replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 50);
    const name = `${Date.now()}-${safe}`.slice(0, 100);
    cb(null, name.endsWith(ext) ? name : name + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_TYPES.test(file.mimetype)) {
      return cb(new Error('Invalid file type. Use PNG, JPEG, GIF, WebP, SVG, or ICO.'));
    }
    cb(null, true);
  },
});

const router = express.Router();

router.post('/upload', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ success: false, error: 'File too large (max 2MB)' });
        }
      }
      return res.status(400).json({ success: false, error: err.message || 'Upload failed' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    const url = '/uploads/' + path.basename(req.file.filename);
    return res.json({ success: true, url });
  });
});

export default router;
