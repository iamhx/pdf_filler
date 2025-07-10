const express = require('express');
const pdfController = require('../controllers/pdfController');

const setupRoutes = (app) => {
    const router = express.Router();

    // PDF Routes - Session-based workflow only
    router.post('/pdf/upload-session', pdfController.uploadSession.bind(pdfController));
    router.get('/pdf/:fileId', pdfController.viewPdf.bind(pdfController));
    router.head('/pdf/:fileId', pdfController.viewPdf.bind(pdfController)); // Add HEAD support for validity checks
    router.post('/pdf/:fileId/sign', pdfController.signPdf.bind(pdfController));
    router.post('/pdf/:fileId/decline', pdfController.declinePdf.bind(pdfController));

    app.use('/api', router);
};

module.exports = { setupRoutes };
