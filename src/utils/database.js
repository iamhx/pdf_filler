const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { setupLogger } = require('./logger');

const logger = setupLogger();

class DatabaseService {
    constructor() {
        this.dbPath = path.join(__dirname, '../data/sessions.db');
        this.db = null;
        this.initDatabase();
    }

    async initDatabase() {
        return new Promise((resolve, reject) => {
            // Ensure data directory exists
            const fs = require('fs');
            const dataDir = path.dirname(this.dbPath);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    logger.error('Error opening database:', err);
                    reject(err);
                } else {
                    logger.info('Connected to SQLite database for approval sessions');
                    this.createTables().then(resolve).catch(reject);
                }
            });
        });
    }

    async createTables() {
        return new Promise((resolve, reject) => {
            // Create session tables for dual-document approval workflow
            const createSessionTableSQL = `
                CREATE TABLE IF NOT EXISTS approval_sessions (
                    session_id TEXT PRIMARY KEY,
                    callback_url TEXT NOT NULL,
                    status TEXT DEFAULT 'pending',
                    total_documents INTEGER DEFAULT 2,
                    completed_documents INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    completed_at DATETIME NULL
                )
            `;

            const createSessionDocumentsTableSQL = `
                CREATE TABLE IF NOT EXISTS session_documents (
                    session_id TEXT,
                    file_id TEXT,
                    document_type TEXT,
                    status TEXT DEFAULT 'pending',
                    signed_at DATETIME NULL,
                    PRIMARY KEY (session_id, file_id),
                    FOREIGN KEY (session_id) REFERENCES approval_sessions(session_id)
                )
            `;

            // Create approval_sessions table
            this.db.run(createSessionTableSQL, (err) => {
                if (err) {
                    logger.error('Error creating approval_sessions table:', err);
                    reject(err);
                    return;
                }
                logger.info('Approval sessions table ready');

                // Create session_documents table
                this.db.run(createSessionDocumentsTableSQL, (err) => {
                    if (err) {
                        logger.error('Error creating session_documents table:', err);
                        reject(err);
                    } else {
                        logger.info('Session documents table ready');
                        resolve();
                    }
                });
            });
        });
    }

    // === SESSION MANAGEMENT METHODS ===
    
    async createApprovalSession(sessionId, callbackUrl) {
        return new Promise((resolve, reject) => {
            const sql = `INSERT INTO approval_sessions (session_id, callback_url) VALUES (?, ?)`;
            
            this.db.run(sql, [sessionId, callbackUrl], function(err) {
                if (err) {
                    logger.error('Error creating approval session:', err);
                    reject(err);
                } else {
                    logger.info(`Created approval session: ${sessionId}`);
                    resolve(sessionId);
                }
            });
        });
    }

    async addDocumentToSession(sessionId, fileId, documentType) {
        return new Promise((resolve, reject) => {
            const sql = `INSERT INTO session_documents (session_id, file_id, document_type) VALUES (?, ?, ?)`;
            
            this.db.run(sql, [sessionId, fileId, documentType], function(err) {
                if (err) {
                    logger.error('Error adding document to session:', err);
                    reject(err);
                } else {
                    logger.info(`Added document ${fileId} (${documentType}) to session ${sessionId}`);
                    resolve();
                }
            });
        });
    }

    async getApprovalSession(sessionId) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT s.*, 
                       COUNT(sd.file_id) as total_documents,
                       COUNT(CASE WHEN sd.status = 'signed' THEN 1 END) as completed_documents
                FROM approval_sessions s
                LEFT JOIN session_documents sd ON s.session_id = sd.session_id
                WHERE s.session_id = ?
                GROUP BY s.session_id
            `;
            
            this.db.get(sql, [sessionId], (err, row) => {
                if (err) {
                    logger.error('Error getting approval session:', err);
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    async getSessionDocuments(sessionId) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM session_documents WHERE session_id = ? ORDER BY document_type`;
            
            this.db.all(sql, [sessionId], (err, rows) => {
                if (err) {
                    logger.error('Error getting session documents:', err);
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async markDocumentSigned(sessionId, fileId) {
        return new Promise((resolve, reject) => {
            const sql = `UPDATE session_documents SET status = 'signed', signed_at = CURRENT_TIMESTAMP WHERE session_id = ? AND file_id = ?`;
            
            this.db.run(sql, [sessionId, fileId], function(err) {
                if (err) {
                    logger.error('Error marking document as signed:', err);
                    reject(err);
                } else {
                    logger.info(`Marked document ${fileId} as signed in session ${sessionId}`);
                    resolve();
                }
            });
        });
    }

    async updateDocumentStatus(fileId, status) {
        return new Promise((resolve, reject) => {
            const sql = `UPDATE session_documents SET status = ?, signed_at = CURRENT_TIMESTAMP WHERE file_id = ?`;
            
            this.db.run(sql, [status, fileId], function(err) {
                if (err) {
                    logger.error('Error updating document status:', err);
                    reject(err);
                } else {
                    logger.info(`Updated document ${fileId} status to ${status}`);
                    resolve();
                }
            });
        });
    }

    async updateSessionStatus(sessionId, status) {
        return new Promise((resolve, reject) => {
            const completedAt = status === 'completed' ? 'CURRENT_TIMESTAMP' : 'NULL';
            const sql = `UPDATE approval_sessions SET status = ?, completed_at = ${completedAt} WHERE session_id = ?`;
            
            this.db.run(sql, [status, sessionId], function(err) {
                if (err) {
                    logger.error('Error updating session status:', err);
                    reject(err);
                } else {
                    logger.info(`Updated session ${sessionId} status to ${status}`);
                    resolve();
                }
            });
        });
    }

    async isSessionComplete(sessionId) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT 
                    COUNT(*) as total_documents,
                    COUNT(CASE WHEN status = 'signed' THEN 1 END) as completed_documents
                FROM session_documents 
                WHERE session_id = ?
            `;
            
            this.db.get(sql, [sessionId], (err, row) => {
                if (err) {
                    logger.error('Error checking session completion:', err);
                    reject(err);
                } else {
                    const isComplete = row.total_documents > 0 && row.total_documents === row.completed_documents;
                    resolve(isComplete);
                }
            });
        });
    }

    async getSessionByFileId(fileId) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT s.*, sd.document_type
                FROM approval_sessions s
                JOIN session_documents sd ON s.session_id = sd.session_id
                WHERE sd.file_id = ?
            `;
            
            this.db.get(sql, [fileId], (err, row) => {
                if (err) {
                    logger.error('Error getting session by file ID:', err);
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    async removeApprovalSession(sessionId) {
        return new Promise((resolve, reject) => {
            // First remove session documents
            const deleteDocumentsSQL = `DELETE FROM session_documents WHERE session_id = ?`;
            
            this.db.run(deleteDocumentsSQL, [sessionId], (err) => {
                if (err) {
                    logger.error('Error removing session documents:', err);
                    reject(err);
                    return;
                }
                
                // Then remove the session
                const deleteSessionSQL = `DELETE FROM approval_sessions WHERE session_id = ?`;
                
                this.db.run(deleteSessionSQL, [sessionId], (err) => {
                    if (err) {
                        logger.error('Error removing approval session:', err);
                        reject(err);
                    } else {
                        logger.info(`Removed approval session: ${sessionId}`);
                        resolve();
                    }
                });
            });
        });
    }

    async cleanupExpiredSessions(maxAgeHours = 168) {
        return new Promise((resolve, reject) => {
            const cutoffTime = new Date(Date.now() - (maxAgeHours * 60 * 60 * 1000)).toISOString();
            
            // Get expired sessions
            const selectSQL = `SELECT session_id FROM approval_sessions WHERE created_at < ?`;
            
            this.db.all(selectSQL, [cutoffTime], (err, rows) => {
                if (err) {
                    logger.error('Error finding expired sessions:', err);
                    reject(err);
                    return;
                }
                
                if (rows.length === 0) {
                    resolve(0);
                    return;
                }
                
                // Remove expired sessions
                let removedCount = 0;
                const removePromises = rows.map(row => this.removeApprovalSession(row.session_id));
                
                Promise.all(removePromises)
                    .then(() => {
                        logger.info(`Cleaned up ${rows.length} expired approval sessions`);
                        resolve(rows.length);
                    })
                    .catch(reject);
            });
        });
    }

    async close() {
        if (this.db) {
            return new Promise((resolve) => {
                this.db.close((err) => {
                    if (err) {
                        logger.error('Error closing database:', err);
                    } else {
                        logger.info('Database connection closed');
                    }
                    resolve();
                });
            });
        }
    }

    async getAllSessions() {
        return new Promise((resolve, reject) => {
            const sql = 'SELECT * FROM approval_sessions ORDER BY created_at DESC';
            this.db.all(sql, [], (err, rows) => {
                if (err) {
                    logger.error('Error getting all sessions:', err);
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async clearAllSessions() {
        return new Promise((resolve, reject) => {
            // First clear all session documents
            const clearDocumentsSQL = 'DELETE FROM session_documents';
            
            this.db.run(clearDocumentsSQL, [], (err) => {
                if (err) {
                    logger.error('Error clearing session documents:', err);
                    reject(err);
                    return;
                }
                
                // Then clear all sessions
                const clearSessionsSQL = 'DELETE FROM approval_sessions';
                
                this.db.run(clearSessionsSQL, [], (err) => {
                    if (err) {
                        logger.error('Error clearing approval sessions:', err);
                        reject(err);
                    } else {
                        logger.info('All sessions and documents cleared from database');
                        resolve();
                    }
                });
            });
        });
    }
}

module.exports = new DatabaseService();
