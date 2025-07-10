#!/usr/bin/env node

/**
 * PDF Filler Admin CLI Tool
 * Run with: node scripts/admin-cli.js [command]
 * Commands: stats, sessions, cleanup, reset, help
 */

const path = require('path');
const fs = require('fs').promises;

// Setup environment
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pdfService = require('../src/services/pdfService');
const database = require('../src/utils/database');
const { setupLogger } = require('../src/utils/logger');
const logger = setupLogger();

class AdminCLI {
    async run() {
        const command = process.argv[2] || 'help';
        
        switch (command) {
            case 'stats':
                await this.showStats();
                break;
            case 'sessions':
                await this.showSessions();
                break;
            case 'cleanup':
                await this.runCleanup();
                break;
            case 'reset':
                await this.fullReset();
                break;
            case 'help':
                this.showHelp();
                break;
            default:
                console.log(`Unknown command: ${command}`);
                this.showHelp();
        }
    }
    
    async showStats() {
        try {
            console.log('📊 PDF Filler - Session & File Statistics\n');
            
            // Wait for database to be initialized
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Get session statistics
            const sessionStats = await this.getSessionStats();
            console.log('📋 SESSIONS:');
            console.log(`  Total Sessions: ${sessionStats.total}`);
            console.log(`  Pending: ${sessionStats.pending}`);
            console.log(`  Completed: ${sessionStats.completed}`);
            console.log(`  Declined: ${sessionStats.declined}\n`);
            
            // Get file statistics
            const fileStats = await pdfService.getTempFileStats();
            console.log('📁 TEMPORARY FILES:');
            console.log(`  File Count: ${fileStats.fileCount}`);
            console.log(`  Total Size: ${this.formatBytes(fileStats.totalSize)}`);
            console.log(`  Directory: ${pdfService.tempDir}\n`);
            
            if (fileStats.files.length === 0) {
                console.log('✅ No temporary files found');
                return;
            }
            
            console.log('Files by Type:');
            console.log('─'.repeat(80));
            console.log('File Name'.padEnd(45) + 'Size'.padEnd(12) + 'Age');
            console.log('─'.repeat(80));
            
            const now = new Date();
            const originalFiles = fileStats.files.filter(f => !f.name.includes('_filled'));
            const filledFiles = fileStats.files.filter(f => f.name.includes('_filled'));
            
            if (originalFiles.length > 0) {
                console.log('📋 Original PDFs:');
                originalFiles.forEach(file => {
                    const age = this.getFileAge(file.modified, now);
                    console.log(
                        `  ${file.name.padEnd(43)}${this.formatBytes(file.size).padEnd(12)}${age}`
                    );
                });
            }
            
            if (filledFiles.length > 0) {
                console.log('📄 Filled PDFs:');
                filledFiles.forEach(file => {
                    const age = this.getFileAge(file.modified, now);
                    console.log(
                        `  ${file.name.padEnd(43)}${this.formatBytes(file.size).padEnd(12)}${age}`
                    );
                });
            }
            
            console.log('─'.repeat(80));
            
        } catch (error) {
            console.error('❌ Error getting stats:', error.message);
        }
    }
    
    async runCleanup() {
        try {
            console.log('🧹 Running session-based cleanup...\n');
            
            // Wait for database to be initialized
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Cleanup expired sessions
            console.log('Cleaning up expired sessions...');
            const deletedSessions = await database.cleanupExpiredSessions();
            console.log(`Sessions deleted: ${deletedSessions}`);
            
            // Cleanup temporary files
            console.log('\nCleaning up old temporary files...');
            const statsBefore = await pdfService.getTempFileStats();
            console.log(`Files before cleanup: ${statsBefore.fileCount}`);
            
            await pdfService.cleanupOldTemporaryFiles();
            
            const statsAfter = await pdfService.getTempFileStats();
            const deletedFiles = statsBefore.fileCount - statsAfter.fileCount;
            
            console.log(`Files after cleanup: ${statsAfter.fileCount}`);
            console.log(`Files deleted: ${deletedFiles}`);
            
            if (deletedSessions > 0 || deletedFiles > 0) {
                console.log(`\n✅ Cleanup completed successfully`);
            } else {
                console.log(`\n✅ No cleanup needed`);
            }
            
        } catch (error) {
            console.error('❌ Error during cleanup:', error.message);
        }
    }
    
    async showSessions() {
        try {
            console.log('� PDF Filler - Session Details\n');
            
            // Wait for database to be initialized
            await new Promise(resolve => setTimeout(resolve, 100));
            
            const sessions = await database.getAllSessions();
            
            console.log(`Total Sessions: ${sessions.length}\n`);
            
            if (sessions.length === 0) {
                console.log('✅ No sessions found');
                return;
            }
            
            console.log('Session Details:');
            console.log('═'.repeat(100));
            
            for (const session of sessions) {
                const documents = await database.getSessionDocuments(session.session_id);
                
                console.log(`📋 Session: ${session.session_id}`);
                console.log(`   Status: ${session.status.toUpperCase()}`);
                console.log(`   Created: ${new Date(session.created_at).toLocaleString()}`);
                console.log(`   Completed: ${session.completed_at ? new Date(session.completed_at).toLocaleString() : 'N/A'}`);
                console.log(`   Callback: ${session.callback_url}`);
                console.log(`   Documents (${documents.length}):`);
                
                documents.forEach((doc, index) => {
                    console.log(`     ${index + 1}. ${doc.document_type.toUpperCase()} - ${doc.status} ${doc.signed_at ? `(signed ${new Date(doc.signed_at).toLocaleString()})` : ''}`);
                    console.log(`        File: ${doc.file_id}`);
                });
                
                console.log('─'.repeat(100));
            }
            
        } catch (error) {
            console.error('❌ Error getting session details:', error.message);
        }
    }
    
    async getSessionStats() {
        try {
            const sessions = await database.getAllSessions();
            return {
                total: sessions.length,
                pending: sessions.filter(s => s.status === 'pending').length,
                completed: sessions.filter(s => s.status === 'completed').length,
                declined: sessions.filter(s => s.status === 'declined').length
            };
        } catch (error) {
            console.error('❌ Error getting session stats:', error.message);
            return { total: 0, pending: 0, completed: 0, declined: 0 };
        }
    }

    showHelp() {
        console.log(`
📁 PDF Filler Admin CLI (Session-Based System)

Usage: node scripts/admin-cli.js [command]

Commands:
  stats       Show session and file statistics overview
  sessions    Show detailed session information
  cleanup     Force cleanup of expired sessions and old temporary files
  reset       🔄 FULL RESET - Delete ALL sessions and temp files (requires confirmation)
  help        Show this help message

Examples:
  node scripts/admin-cli.js stats
  node scripts/admin-cli.js sessions
  node scripts/admin-cli.js cleanup
  node scripts/admin-cli.js reset

Configuration (from .env):
  URL_EXPIRY_HOURS:        ${process.env.URL_EXPIRY_HOURS || 168} (session expiry)
  MAX_TEMP_FILE_AGE_HOURS: ${process.env.MAX_TEMP_FILE_AGE_HOURS || 168} (file cleanup)
  CLEANUP_INTERVAL_HOURS:  ${process.env.CLEANUP_INTERVAL_HOURS || 1} (auto cleanup)
        `);
    }
    
    async fullReset() {
        try {
            console.log('🔄 FULL SYSTEM RESET');
            console.log('⚠️  WARNING: This will delete ALL sessions and temporary files!');
            console.log('');
            
            // Check for user confirmation
            const readline = require('readline');
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            
            const confirm = await new Promise((resolve) => {
                rl.question('Are you sure you want to proceed? Type "RESET" to confirm: ', (answer) => {
                    rl.close();
                    resolve(answer);
                });
            });
            
            if (confirm !== 'RESET') {
                console.log('❌ Reset cancelled.');
                return;
            }
            
            console.log('\n🗄️  Clearing database...');
            
            // Wait for database to be initialized
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Clear all sessions and documents
            await database.clearAllSessions();
            console.log('✅ Database cleared');
            
            console.log('\n📁 Clearing temporary files...');
            
            // Clear all temporary files
            const tempDir = path.join(__dirname, '..', 'src', 'temp');
            try {
                const files = await fs.readdir(tempDir);
                let deletedCount = 0;
                
                for (const file of files) {
                    if (file.endsWith('.pdf')) {
                        const filePath = path.join(tempDir, file);
                        await fs.unlink(filePath);
                        deletedCount++;
                        console.log(`  Deleted: ${file}`);
                    }
                }
                
                console.log(`✅ Deleted ${deletedCount} temporary files`);
            } catch (error) {
                console.log(`⚠️  Could not clear temp directory: ${error.message}`);
            }
            
            console.log('\n🎉 SYSTEM RESET COMPLETE');
            console.log('   • All sessions removed from database');
            console.log('   • All temporary PDF files deleted');
            console.log('   • System is now in fresh state');
            
        } catch (error) {
            console.error('❌ Error during reset:', error.message);
        }
    }
    
    formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
    
    getFileAge(modifiedDate, now) {
        const diffMs = now - new Date(modifiedDate);
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        
        if (diffHours >= 24) {
            const days = Math.floor(diffHours / 24);
            return `${days}d ${diffHours % 24}h`;
        } else if (diffHours >= 1) {
            return `${diffHours}h ${diffMins}m`;
        } else {
            return `${diffMins}m`;
        }
    }
}

// Run if called directly
if (require.main === module) {
    const cli = new AdminCLI();
    cli.run().catch(error => {
        console.error('❌ CLI Error:', error.message);
        process.exit(1);
    });
}

module.exports = AdminCLI;
