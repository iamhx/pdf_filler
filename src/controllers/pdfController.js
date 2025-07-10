const pdfService = require('../services/pdfService');
const { setupLogger } = require('../utils/logger');
const database = require('../utils/database');
const sessionManager = require('../utils/sessionManager');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const logger = setupLogger();

// Helper function to validate annotations
function validateAnnotations(modifications) {
    if (!modifications || !modifications.pages) {
        return false;
    }

    // Check if any page has annotations
    for (const pageNum in modifications.pages) {
        const pageObjects = modifications.pages[pageNum];
        if (pageObjects && Array.isArray(pageObjects) && pageObjects.length > 0) {
            return true;
        }
    }

    return false;
}

class PdfController {
    async uploadSession(req, res, next) {
        try {
            const { callbackUrl, documents } = req.body;
            
            // Validate required fields
            if (!callbackUrl) {
                return res.status(400).json({ error: 'Callback URL is required' });
            }
            
            if (!documents || !Array.isArray(documents) || documents.length !== 2) {
                return res.status(400).json({ error: 'Exactly 2 documents are required' });
            }
            
            // Validate document structure
            for (const doc of documents) {
                if (!doc.type || !doc.contentBytes) {
                    return res.status(400).json({ error: 'Each document must have type and contentBytes' });
                }
            }
            
            // Validate document types
            const validTypes = ['original', 'dar'];
            const types = documents.map(doc => doc.type);
            for (const type of types) {
                if (!validTypes.includes(type)) {
                    return res.status(400).json({ error: 'Document type must be "original" or "dar"' });
                }
            }
            
            // Ensure we have both required document types
            if (!types.includes('original') || !types.includes('dar')) {
                return res.status(400).json({ error: 'Both "original" and "dar" document types are required' });
            }
            
            // Create the approval session
            const sessionResult = await sessionManager.createApprovalSession(
                callbackUrl,
                documents
            );
            
            // Build response with document URLs for PA to email to approver
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            const responseDocuments = sessionResult.documents.map(doc => ({
                type: doc.type,
                fileId: doc.fileId,
                url: `${baseUrl}${doc.viewUrl}`
            }));
            
            res.json({
                success: true,
                sessionId: sessionResult.sessionId,
                documents: responseDocuments,
                message: 'Approval session created successfully'
            });
            
        } catch (error) {
            logger.error('Error creating approval session:', error);
            next(error);
        }
    }

    async viewPdf(req, res, next) {
        try {
            const { fileId } = req.params;
            const { sessionId } = req.query;
            let documentStatus = null;
            
            // Set cache control headers to prevent browser caching
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            
            // Debug logging for request
            logger.info(`PDF view request for fileId: ${fileId}${sessionId ? `, sessionId: ${sessionId}` : ''}, method: ${req.method}`);
            
            // Enforce session ID requirement for all PDF access
            if (!sessionId) {
                logger.warn(`Attempt to access PDF ${fileId} without session ID`);
                return res.status(400).json({
                    error: 'Session ID required',
                    message: 'A valid session ID is required to access documents in this system.'
                });
            }
            
            // Session-centric approach: Check session status FIRST
            if (sessionId) {
                const session = await sessionManager.getSession(sessionId);
                if (!session) {
                    logger.info(`Session ${sessionId} not found for file ${fileId}`);
                    return res.status(404).json({
                        error: 'Session not found',
                        message: 'Invalid session ID. The approval session could not be found or has ended.'
                    });
                }
                
                // Check if session is completed
                if (session.status === 'completed') {
                    logger.info(`Session ${sessionId} is already completed for file ${fileId}`);
                    return res.status(404).json({
                        error: 'Session completed',
                        message: 'The approval session has ended and the document is no longer available.'
                    });
                }
                
                // Check if session is expired
                const isExpired = await sessionManager.isSessionExpired(sessionId);
                if (isExpired) {
                    logger.info(`Session ${sessionId} has expired for file ${fileId}`);
                    return res.status(410).json({
                        error: 'Session expired',
                        message: 'This approval session has expired and is no longer available.'
                    });
                }
                
                // Verify that the document belongs to this session
                documentStatus = await sessionManager.getDocumentStatus(sessionId, fileId);
                logger.info(`Document status check for ${fileId} in session ${sessionId}: ${JSON.stringify(documentStatus)}`);
                
                if (!documentStatus) {
                    logger.info(`Document ${fileId} not found in session ${sessionId}`);
                    return res.status(404).json({
                        error: 'Invalid document',
                        message: 'Invalid document. This file does not exist or is not part of the approval session.'
                    });
                }
                
                // Check if this document has already been signed in the session
                if (documentStatus.signed_at) {
                    logger.info(`Document ${fileId} is already signed in session ${sessionId}, returning 410 status`);
                    return res.status(410).json({
                        error: 'PDF already signed',
                        message: 'This document has already been signed in this approval session.',
                        signedAt: documentStatus.signed_at,
                        sessionId: sessionId
                    });
                }
            }
            
            // Now check file existence in the filesystem
            const fileStatus = await pdfService.checkFileExpiry(fileId);
            
            // File doesn't exist at all
            if (!fileStatus.exists) {
                // If we're in a session context, provide a session-focused message
                if (sessionId) {
                    logger.info(`File ${fileId} not found in filesystem for session ${sessionId}`);
                    return res.status(404).json({
                        error: 'Invalid document',
                        message: 'Invalid document. This file does not exist or is not part of the approval session.'
                    });
                }
                
                // For non-session files, return a generic file not found message
                logger.info(`File ${fileId} not found in filesystem (no session context)`);
                return res.status(404).json({
                    error: 'File not found',
                    message: 'The requested PDF file does not exist or the link is invalid.'
                });
            }
            
            // File exists but is expired
            if (fileStatus.expired) {
                logger.warn(`Access denied - URL expired for fileId: ${fileId} (age: ${fileStatus.ageHours || 'unknown'}h, max: ${fileStatus.maxAgeHours}h)`);
                return res.status(410).json({
                    error: 'URL expired',
                    message: `This PDF link has expired. URLs are valid for ${fileStatus.maxAgeHours} hours after creation.`,
                    ageHours: fileStatus.ageHours || 'unknown',
                    maxAgeHours: fileStatus.maxAgeHours
                });
            }
            
            // For HEAD requests, return status without content
            // At this point, all validation checks have passed, so return 200 OK
            if (req.method === 'HEAD') {
                res.setHeader('Content-Type', 'application/pdf');
                res.status(200).end();
                return;
            }
            
            // All checks passed, serve the PDF
            const pdfBuffer = await pdfService.loadPdf(fileId);
            
            res.setHeader('Content-Type', 'application/pdf');
            res.send(pdfBuffer);
        } catch (error) {
            logger.error(`Error in viewPdf: ${error.message}`);
            next(error);
        }
    }

    async signPdf(req, res, next) {
        try {
            const { fileId } = req.params;
            const { modifications } = req.body;
            const { sessionId } = req.query;

            // Debug logging
            logger.info(`Processing PDF submission for fileId: ${fileId}${sessionId ? ` (session: ${sessionId})` : ''}`);
            logger.info(`Request query parameters:`, req.query);
            logger.info(`SessionId extracted: ${sessionId || 'NONE'}`);
            
            // Session is now required for all PDF signing
            if (!sessionId) {
                return res.status(400).json({
                    error: 'Session ID required',
                    message: 'PDF signing requires a session ID. Please use the session-based upload workflow.',
                    migrationNote: 'Single PDF signing is no longer supported. Use dual-document session workflow.'
                });
            }

            // Session-centric approach: Verify session context first
            let session = await sessionManager.getSession(sessionId);
            if (!session) {
                return res.status(404).json({
                    error: 'Session not found',
                    message: 'The approval session has ended and the document is no longer available.'
                });
            }
            
            // Check if session is expired
            const isExpired = await sessionManager.isSessionExpired(sessionId);
            if (isExpired) {
                return res.status(410).json({
                    error: 'Session expired',
                    message: 'This approval session has expired and is no longer available.'
                });
            }

            // Check if file exists and is not expired
            const fileStatus = await pdfService.checkFileExpiry(fileId);
            
            if (!fileStatus.exists) {
                // For session-based files, always return session-focused message
                return res.status(404).json({
                    error: 'Session not found',
                    message: 'The approval session has ended and the document is no longer available.'
                });
            }
            
            if (fileStatus.expired) {
                logger.warn(`Sign attempt denied - URL expired for fileId: ${fileId} (age: ${fileStatus.ageHours}h, max: ${fileStatus.maxAgeHours}h)`);
                return res.status(410).json({
                    error: 'URL expired',
                    message: `This PDF link has expired. URLs are valid for ${fileStatus.maxAgeHours} hours after creation.`,
                    ageHours: fileStatus.ageHours,
                    maxAgeHours: fileStatus.maxAgeHours
                });
            }

            // Validate that there are annotations
            const hasAnnotations = validateAnnotations(modifications);
            if (!hasAnnotations) {
                logger.warn(`Submission rejected - no annotations found for fileId: ${fileId}`);
                return res.status(400).json({ 
                    error: 'Cannot submit PDF without annotations',
                    message: 'Please add at least one annotation, text, or signature before submitting.'
                });
            }

            // Process the PDF with annotations
            const filledFileId = await pdfService.savePdfWithChanges(fileId, modifications);
            
            logger.info(`PDF successfully processed and saved as: ${filledFileId}`);

            // Session is now required for all PDF signing
            if (!sessionId) {
                return res.status(400).json({
                    error: 'Session ID required',
                    message: 'PDF signing requires a session ID. Please use the session-based upload workflow.',
                    migrationNote: 'Single PDF signing is no longer supported. Use dual-document session workflow.'
                });
            }

            // Mark document as signed in session
            const sessionResult = await sessionManager.markDocumentSigned(sessionId, fileId);
            
            // Clean up this individual document's temp file immediately
            await this.cleanupIndividualDocumentFiles(fileId, filledFileId);
            
            if (sessionResult.isComplete) {
                // All documents signed - send to Power Automate with both documents
                await this.sendSessionCompletionToSuccessEndpoint(sessionId);
                
                // Mark session as completed in database immediately
                await database.updateSessionStatus(sessionId, 'completed');
                
                // Clean up session files after delay (keep files available for a while)
                setTimeout(async () => {
                    try {
                        await sessionManager.cleanupSession(sessionId);
                        logger.info(`Completed delayed cleanup for session ${sessionId}`);
                    } catch (error) {
                        logger.warn(`Error cleaning up session ${sessionId}:`, error.message);
                    }
                }, 5 * 60 * 1000); // 5 minutes delay
                
                res.json({
                    success: true,
                    message: 'All documents signed successfully - approval complete',
                    sessionId: sessionId,
                    filledFileId: filledFileId,
                    sessionComplete: true
                });
            } else {
                // Partial completion - get progress
                const progress = await sessionManager.getSessionProgress(sessionId);
                
                res.json({
                    success: true,
                    message: `Document signed successfully (${progress.signedCount} of ${progress.totalCount} documents completed)`,
                    sessionId: sessionId,
                    filledFileId: filledFileId,
                    sessionComplete: false,
                    progress: progress
                });
            }

        } catch (error) {
            logger.error(`Error processing PDF submission:`, error);
            next(error);
        }
    }

    async declinePdf(req, res, next) {
        try {
            const { fileId } = req.params;
            const { sessionId } = req.query;
            
            // Session is now required for decline as well
            if (!sessionId) {
                return res.status(400).json({
                    error: 'Session ID required',
                    message: 'PDF decline now requires a session ID. Please use the session-based workflow.',
                    migrationNote: 'Single PDF decline is no longer supported. Use dual-document session workflow.'
                });
            }
            
            // Verify session exists and is not expired
            const session = await sessionManager.getSession(sessionId);
            if (!session) {
                return res.status(404).json({
                    error: 'Session not found',
                    message: 'The approval session has ended and the document is no longer available.'
                });
            }
            
            // Check if session is expired
            const isSessionExpired = await sessionManager.isSessionExpired(sessionId);
            if (isSessionExpired) {
                return res.status(410).json({
                    error: 'Session expired',
                    message: 'This approval session has expired and is no longer available.'
                });
            }
            
            // Check if file exists and is not expired
            const fileStatus = await pdfService.checkFileExpiry(fileId);
            
            if (!fileStatus.exists) {
                // For session-based files, if file doesn't exist, it means session has ended
                return res.status(404).json({
                    error: 'File not available',
                    message: 'The document is no longer available. The approval session may have ended.'
                });
            }
            
            if (fileStatus.expired) {
                logger.warn(`Decline attempt denied - URL expired for fileId: ${fileId} (age: ${fileStatus.ageHours}h, max: ${fileStatus.maxAgeHours}h)`);
                return res.status(410).json({
                    error: 'URL expired',
                    message: `This PDF link has expired. URLs are valid for ${fileStatus.maxAgeHours} hours after creation.`,
                    ageHours: fileStatus.ageHours,
                    maxAgeHours: fileStatus.maxAgeHours
                });
            }
            
            // Mark entire session as declined
            await sessionManager.markSessionDeclined(sessionId, fileId);

            // Send decline notification to Decline Webhook (4th Flow)
            await this.sendSessionDeclineToDeclineEndpoint(sessionId);

            // Clean up temporary files for this session
            await sessionManager.cleanupSession(sessionId);
            
            res.json({
                message: 'PDF signing declined - session terminated',
                sessionId: sessionId
            });
        } catch (error) {
            next(error);
        }
    }

    async sendSessionCompletionToSuccessEndpoint(sessionId) {
        try {
            const session = await sessionManager.getSession(sessionId);
            if (!session) {
                throw new Error(`Session ${sessionId} not found`);
            }
            
            const signedDocuments = await sessionManager.getSignedDocuments(sessionId);
            if (signedDocuments.length !== 2) {
                throw new Error(`Expected 2 signed documents, got ${signedDocuments.length}`);
            }
            
            const successEndpoint = process.env.POWER_AUTOMATE_SUCCESS_ENDPOINT;
            
            // Prepare payload for Success Webhook (3rd Flow)
            const payload = {
                sessionId: sessionId,
                status: 'completed',
                documents: signedDocuments.map(doc => ({
                    type: doc.type,
                    fileId: doc.filledFileId,
                    signedPdfData: doc.base64Data
                })),
                completedAt: new Date().toISOString(),
                callbackUrl: session.callback_url
            };
            
            // Send to Success Webhook (3rd Flow)
            const response = await fetch(successEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload)
            });
            
            if (response.ok) {
                logger.info(`Successfully sent session completion to Success Webhook for session: ${sessionId}`);
            } else {
                logger.error(`Success Webhook responded with status: ${response.status} for session: ${sessionId}`);
            }
            
        } catch (error) {
            logger.error(`Error sending session completion to Success Webhook:`, error);
            throw error;
        }
    }

    async sendSessionDeclineToDeclineEndpoint(sessionId) {
        try {
            const session = await sessionManager.getSession(sessionId);
            if (!session) {
                throw new Error(`Session ${sessionId} not found`);
            }
            
            const declineEndpoint = process.env.POWER_AUTOMATE_DECLINE_ENDPOINT;
            
            // Prepare payload for Decline Webhook (4th Flow)
            const payload = {
                sessionId: sessionId,
                status: 'declined',
                declinedAt: new Date().toISOString(),
                callbackUrl: session.callback_url
            };
            
            // Send to Decline Webhook (4th Flow)
            const response = await fetch(declineEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload)
            });
            
            if (response.ok) {
                logger.info(`Successfully sent session decline to Decline Webhook for session: ${sessionId}`);
            } else {
                logger.error(`Decline Webhook responded with status: ${response.status} for session: ${sessionId}`);
            }
            
        } catch (error) {
            logger.error(`Error sending session decline to Decline Webhook:`, error);
            throw error;
        }
    }

    // Individual document cleanup for sessions
    async cleanupIndividualDocumentFiles(originalFileId, filledFileId) {
        try {
            // Clean up original file immediately (same as single PDF workflow)
            await pdfService.deleteTemporaryPdf(originalFileId);
            logger.info(`Cleaned up original file: ${originalFileId}`);

            // Note: For sessions, we keep the filled file until session completion
            // The filled file will be cleaned up when the session is cleaned up
            
        } catch (error) {
            logger.warn('Error during individual document cleanup:', error.message);
        }
    }
}

module.exports = new PdfController();
