const database = require('./database');
const { setupLogger } = require('./logger');
const { v4: uuidv4 } = require('uuid');

const logger = setupLogger();

class SessionManager {
    
    /**
     * Create a new approval session with multiple documents
     * @param {string} callbackUrl - The Power Automate callback URL
     * @param {Array} documents - Array of document objects with type and base64 content
     * @returns {Promise<Object>} Session info with file IDs and URLs
     */
    async createApprovalSession(callbackUrl, documents) {
        try {
            const sessionId = uuidv4();
            
            // Create the approval session
            await database.createApprovalSession(sessionId, callbackUrl);
            
            // Process each document and create file entries
            const pdfService = require('../services/pdfService');
            const documentResults = [];
            
            for (const doc of documents) {
                const fileId = await pdfService.savePdfFromBase64(doc.contentBytes);
                await database.addDocumentToSession(sessionId, fileId, doc.type);
                
                documentResults.push({
                    type: doc.type,
                    fileId: fileId,
                    viewUrl: `/?fileId=${fileId}&sessionId=${sessionId}`
                });
            }
            
            logger.info(`Created approval session ${sessionId} with ${documents.length} documents`);
            
            return {
                sessionId,
                documents: documentResults,
                status: 'pending'
            };
            
        } catch (error) {
            logger.error('Error creating approval session:', error);
            throw error;
        }
    }
    
    /**
     * Get session information by session ID
     * @param {string} sessionId - The session ID
     * @returns {Promise<Object>} Session information
     */
    async getSession(sessionId) {
        try {
            const session = await database.getApprovalSession(sessionId);
            if (!session) {
                return null;
            }
            
            const documents = await database.getSessionDocuments(sessionId);
            
            return {
                ...session,
                documents: documents
            };
            
        } catch (error) {
            logger.error('Error getting session:', error);
            throw error;
        }
    }
    
    /**
     * Get session by file ID
     * @param {string} fileId - The file ID
     * @returns {Promise<Object>} Session information
     */
    async getSessionByFileId(fileId) {
        try {
            return await database.getSessionByFileId(fileId);
        } catch (error) {
            logger.error('Error getting session by file ID:', error);
            throw error;
        }
    }
    
    /**
     * Mark a document as signed and check if session is complete
     * @param {string} sessionId - The session ID
     * @param {string} fileId - The file ID that was signed
     * @returns {Promise<Object>} Session completion status
     */
    async markDocumentSigned(sessionId, fileId) {
        try {
            // Mark the document as signed
            await database.markDocumentSigned(sessionId, fileId);
            
            // Check if the session is now complete
            const isComplete = await database.isSessionComplete(sessionId);
            
            if (isComplete) {
                await database.updateSessionStatus(sessionId, 'completed');
                logger.info(`Approval session ${sessionId} completed - all documents signed`);
            }
            
            return {
                sessionId,
                isComplete,
                fileId
            };
            
        } catch (error) {
            logger.error('Error marking document as signed:', error);
            throw error;
        }
    }
    
    /**
     * Mark a session as declined
     * @param {string} sessionId - The session ID
     * @param {string} fileId - The file ID that was declined
     * @returns {Promise<Object>} Session decline result
     */
    async markSessionDeclined(sessionId, fileId) {
        try {
            // Mark session as declined
            await database.updateSessionStatus(sessionId, 'declined');
            
            // Mark all documents in session as declined
            const documents = await database.getSessionDocuments(sessionId);
            for (const doc of documents) {
                await database.updateDocumentStatus(doc.file_id, 'declined');
            }
            
            logger.info(`Session ${sessionId} marked as declined due to decline of document ${fileId}`);
            
            return {
                sessionId,
                status: 'declined',
                declinedAt: new Date().toISOString()
            };
            
        } catch (error) {
            logger.error('Error marking session as declined:', error);
            throw error;
        }
    }
    
    /**
     * Get all signed documents for a completed session
     * @param {string} sessionId - The session ID
     * @returns {Promise<Array>} Array of signed document information
     */
    async getSignedDocuments(sessionId) {
        try {
            const documents = await database.getSessionDocuments(sessionId);
            const signedDocuments = documents.filter(doc => doc.status === 'signed');
            
            // Get the filled PDF file paths for each signed document
            const pdfService = require('../services/pdfService');
            const results = [];
            
            for (const doc of signedDocuments) {
                // Look for the filled PDF file
                const filledFileId = `${doc.file_id}_filled`;
                try {
                    const filledPdfPath = require('path').join(pdfService.tempDir, `${filledFileId}.pdf`);
                    const fs = require('fs').promises;
                    const pdfBuffer = await fs.readFile(filledPdfPath);
                    
                    results.push({
                        type: doc.document_type,
                        originalFileId: doc.file_id,
                        filledFileId: filledFileId,
                        base64Data: pdfBuffer.toString('base64'),
                        signedAt: doc.signed_at
                    });
                } catch (error) {
                    logger.warn(`Could not read filled PDF for ${doc.file_id}:`, error.message);
                }
            }
            
            return results;
            
        } catch (error) {
            logger.error('Error getting signed documents:', error);
            throw error;
        }
    }
    
    /**
     * Clean up a session and its associated files
     * @param {string} sessionId - The session ID
     * @returns {Promise<void>}
     */
    async cleanupSession(sessionId) {
        try {
            // Get all documents in the session
            const documents = await database.getSessionDocuments(sessionId);
            
            // Log the cleanup process
            logger.info(`Starting cleanup for session ${sessionId} with ${documents.length} documents`);
            
            // Clean up PDF files
            const pdfService = require('../services/pdfService');
            for (const doc of documents) {
                try {
                    // If document was signed, log its status before deletion
                    if (doc.status === 'signed') {
                        logger.info(`Cleaning up signed document ${doc.file_id} from session ${sessionId}`);
                    }
                    
                    await pdfService.deleteTemporaryPdf(doc.file_id);
                    // Also try to clean up filled versions
                    await pdfService.deleteTemporaryPdf(`${doc.file_id}_filled`);
                } catch (error) {
                    logger.warn(`Could not clean up PDF files for ${doc.file_id}:`, error.message);
                }
            }
            
            // Remove session from database
            await database.removeApprovalSession(sessionId);
            
            logger.info(`Cleaned up approval session ${sessionId}`);
            
        } catch (error) {
            logger.error('Error cleaning up session:', error);
            throw error;
        }
    }
    
    /**
     * Check if a session is expired
     * @param {string} sessionId - The session ID
     * @returns {Promise<boolean>} True if session is expired
     */
    async isSessionExpired(sessionId) {
        try {
            const session = await database.getApprovalSession(sessionId);
            if (!session) {
                return true;
            }
            
            const maxAgeHours = parseInt(process.env.URL_EXPIRY_HOURS) || 168;
            const sessionAge = Date.now() - new Date(session.created_at).getTime();
            const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
            
            return sessionAge > maxAgeMs;
            
        } catch (error) {
            logger.error('Error checking session expiry:', error);
            return true;
        }
    }
    
    /**
     * Get session progress information
     * @param {string} sessionId - The session ID
     * @returns {Promise<Object>} Progress information
     */
    async getSessionProgress(sessionId) {
        try {
            const session = await database.getApprovalSession(sessionId);
            if (!session) {
                return null;
            }
            
            const documents = await database.getSessionDocuments(sessionId);
            const signedCount = documents.filter(doc => doc.status === 'signed').length;
            const totalCount = documents.length;
            
            return {
                sessionId,
                signedCount,
                totalCount,
                isComplete: signedCount === totalCount,
                documents: documents.map(doc => ({
                    type: doc.document_type,
                    fileId: doc.file_id,
                    status: doc.status,
                    signedAt: doc.signed_at
                }))
            };
            
        } catch (error) {
            logger.error('Error getting session progress:', error);
            throw error;
        }
    }
    
    /**
     * Get the status of a specific document in a session
     * @param {string} sessionId - The session ID
     * @param {string} fileId - The file ID
     * @returns {Promise<Object|null>} Document status or null if not found
     */
    async getDocumentStatus(sessionId, fileId) {
        try {
            const documents = await database.getSessionDocuments(sessionId);
            const document = documents.find(doc => doc.file_id === fileId);
            
            if (!document) {
                return null;
            }
            
            return {
                fileId: document.file_id,
                type: document.document_type,
                status: document.status,
                signed_at: document.signed_at,
                filled_file_id: document.filled_file_id
            };
            
        } catch (error) {
            logger.error('Error getting document status:', error);
            throw error;
        }
    }
}

module.exports = new SessionManager();
