require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const { setupRoutes } = require('./src/routes');
const { setupLogger } = require('./src/utils/logger');
const { errorHandler } = require('./src/middleware/errorHandler');

const app = express();
const logger = setupLogger();

// Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "'unsafe-eval'",
                "blob:",
                "https://cdn.jsdelivr.net",
                "https://cdnjs.cloudflare.com"
            ],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'", "blob:"],
            fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'self'"],
            workerSrc: ["'self'", "blob:"]
        },
    }
}));
app.use(cors());
app.use(express.json({ limit: process.env.MAX_FILE_SIZE }));
app.use(express.urlencoded({ extended: true }));

// Add cache control for sensitive pages and API responses
app.use((req, res, next) => {
    // For HTML pages that contain PDF editing functionality, prevent caching
    if (req.path.endsWith('.html') && (req.path.includes('test') || req.path.includes('index'))) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    
    // For all API requests, prevent caching to ensure fresh responses
    if (req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Routes
setupRoutes(app);

// Error Handler
app.use(errorHandler);

// Initialize cleanup service
const pdfService = require('./src/services/pdfService');
const database = require('./src/utils/database');

// Schedule periodic cleanup of old temporary files and expired sessions
const cleanupIntervalHours = parseInt(process.env.CLEANUP_INTERVAL_HOURS) || 1;
setInterval(async () => {
    await pdfService.cleanupOldTemporaryFiles();
    await database.cleanupExpiredSessions();
}, cleanupIntervalHours * 60 * 60 * 1000); // Configurable interval

// Initial cleanup on server start
setTimeout(async () => {
    logger.info('Performing initial cleanup of old temporary files and expired sessions...');
    await pdfService.cleanupOldTemporaryFiles();
    await database.cleanupExpiredSessions();
}, 5000); // Wait 5 seconds after server start

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
});
