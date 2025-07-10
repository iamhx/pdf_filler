const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { setupLogger } = require('../utils/logger');
const logger = setupLogger();

class PdfService {
    constructor() {
        // Always resolve temp directory relative to project root, not current working directory
        const projectRoot = path.resolve(__dirname, '..', '..');
        const tempDirFromEnv = process.env.TEMP_FILE_DIR || 'src/temp';
        this.tempDir = path.resolve(projectRoot, tempDirFromEnv);
    }

    async savePdfFromBase64(base64Data) {
        const pdfBuffer = Buffer.from(base64Data, 'base64');
        const fileId = uuidv4();
        const filePath = path.join(this.tempDir, `${fileId}.pdf`);
        
        await fs.writeFile(filePath, pdfBuffer);
        return fileId;
    }

    async loadPdf(fileId) {
        // First try to load the filled version if it exists (for signed documents)
        try {
            const filledPath = path.join(this.tempDir, `${fileId}_filled.pdf`);
            const stats = await fs.stat(filledPath);
            if (stats.isFile()) {
                return await fs.readFile(filledPath);
            }
        } catch (error) {
            // If filled version doesn't exist, continue to original
            if (error.code !== 'ENOENT') {
                throw error; // Re-throw if not a "file not found" error
            }
        }
        
        // Load the original file
        const filePath = path.join(this.tempDir, `${fileId}.pdf`);
        return await fs.readFile(filePath);
    }

    async checkFileExpiry(fileId) {
        try {
            const filePath = path.join(this.tempDir, `${fileId}.pdf`);
            const stats = await fs.stat(filePath);
            const fileAge = Date.now() - stats.mtime.getTime();
            const maxAge = parseInt(process.env.URL_EXPIRY_HOURS) || 168; // hours
            const maxAgeMs = maxAge * 60 * 60 * 1000;
            const ageHours = Math.floor(fileAge / (60 * 60 * 1000));
            
            logger.info(`File age check for ${fileId}: ${ageHours}h old, max age: ${maxAge}h`);
            
            return {
                exists: true,
                expired: fileAge > maxAgeMs,
                ageHours: ageHours,
                maxAgeHours: maxAge
            };
        } catch (error) {
            if (error.code === 'ENOENT') {
                const maxAge = parseInt(process.env.URL_EXPIRY_HOURS) || 168; // hours
                logger.info(`File ${fileId} not found during expiry check`);
                return { 
                    exists: false, 
                    expired: true, 
                    ageHours: 0,
                    maxAgeHours: maxAge 
                };
            }
            logger.error(`Error checking file expiry for ${fileId}: ${error.message}`);
            throw error;
        }
    }

    async savePdfWithChanges(fileId, modifications) {
        try {
            const originalFilePath = path.join(this.tempDir, `${fileId}.pdf`);
            const modifiedFilePath = path.join(this.tempDir, `${fileId}_filled.pdf`);
            
            logger.info(`Loading PDF for flattening: ${originalFilePath}`);
            
            const existingPdfBytes = await this.loadPdf(fileId);
            
            // Load PDF with encryption handling
            let pdfDoc;
            try {
                pdfDoc = await PDFDocument.load(existingPdfBytes, { ignoreEncryption: true });
                logger.info('PDF loaded successfully (encryption handled)');
            } catch (encryptionError) {
                logger.error('Failed to load PDF even with encryption handling:', encryptionError);
                throw new Error(`Unable to process PDF: ${encryptionError.message}`);
            }
            
            logger.info(`Processing ${Object.keys(modifications.pages || {}).length} pages with annotations`);
            
            // Apply modifications page by page
            for (const pageNumStr in modifications.pages) {
                const pageNum = parseInt(pageNumStr);
                const pageObjects = modifications.pages[pageNumStr];
                
                if (!pageObjects || pageObjects.length === 0) continue;
                
                logger.info(`Processing page ${pageNum} with ${pageObjects.length} annotations`);
                
                const page = pdfDoc.getPage(pageNum - 1); // PDF pages are 0-indexed
                await this.addAnnotationsToPage(page, pageObjects);
            }
            
            // Save the modified PDF
            const modifiedPdfBytes = await pdfDoc.save();
            await fs.writeFile(modifiedFilePath, modifiedPdfBytes);
            
            logger.info(`Filled PDF saved: ${modifiedFilePath}`);
            
            return `${fileId}_filled`;
        } catch (error) {
            logger.error('Error flattening PDF:', error);
            throw error;
        }
    }

    async addAnnotationsToPage(page, pageObjects) {
        const { width: pageWidth, height: pageHeight } = page.getSize();
        
        for (const objData of pageObjects) {
            try {
                if (objData.type === 'i-text') {
                    // Add text annotation
                    await this.addTextToPage(page, objData, pageWidth, pageHeight);
                } else if (objData.type === 'path') {
                    // Add drawing/path annotation
                    await this.addPathToPage(page, objData, pageWidth, pageHeight);
                } else if (objData.type === 'image') {
                    // Add image/signature annotation
                    await this.addImageToPage(page, objData, pageWidth, pageHeight);
                }
            } catch (error) {
                logger.error(`Error adding annotation to page:`, error);
                // Continue with other annotations even if one fails
            }
        }
    }

    async addTextToPage(page, textData, pageWidth, pageHeight) {
        try {
            const baseFontSize = textData.fontSize || 20;
            
            // Use the same approach as paths and images - direct scaling
            const scaleX = textData.manualScaleX || textData.scaleX || 1;
            const scaleY = textData.manualScaleY || textData.scaleY || 1;
            
            // For text, use the average scale to determine font size (just like frontend)
            const averageScale = (scaleX + scaleY) / 2;
            let actualFontSize = baseFontSize * averageScale;
            
            // Set reasonable limits but allow dynamic scaling
            const minFontSize = 6;
            const maxFontSize = 72; // Allow larger text for headers/emphasis
            actualFontSize = Math.max(minFontSize, Math.min(maxFontSize, actualFontSize));
            
            const color = this.parseColor(textData.fill || '#000000');
            const text = textData.text || '';
            
            if (!text.trim()) {
                return;
            }
            
            // Use the same coordinate system as paths and images, but adjust for text baseline
            const x = textData.left || 0;
            // For text, we need to account for the baseline - text is drawn from the baseline up
            // Apply vertical positioning adjustment
            const y = pageHeight - (textData.top || 0) - (actualFontSize * 0.87);
            
            // Use Helvetica to match common web fonts
            const font = await page.doc.embedFont(StandardFonts.Helvetica);
            
            page.drawText(text, {
                x,
                y,
                size: actualFontSize,
                color: rgb(color.r, color.g, color.b),
                font
            });
        } catch (error) {
            logger.error('Error adding text to page:', error);
            throw error;
        }
    }

    async addPathToPage(page, pathData, pageWidth, pageHeight) {
        try {
            // For drawing paths, we need to render the actual path instead of placeholder
            const color = this.parseColor(pathData.stroke || '#000000');
            const strokeWidth = pathData.strokeWidth || 2;
            
            // Check if we have actual path data
            if (pathData.path && (
                (typeof pathData.path === 'string' && pathData.path.length > 0) ||
                (typeof pathData.path === 'object' && Object.keys(pathData.path).length > 0)
            )) {
                // Render actual SVG path
                await this.renderSVGPath(page, pathData, pageWidth, pageHeight, color, strokeWidth);
            } else {
                // Use path bounds if available
                await this.renderPathBoundingBox(page, pathData, pageWidth, pageHeight, color, strokeWidth);
            }
        } catch (error) {
            logger.error('Error adding path to page:', error);
            // Don't throw, continue with other annotations
        }
    }

    async renderSVGPath(page, pathData, pageWidth, pageHeight, color, strokeWidth) {
        try {
            // Parse the SVG path string into commands
            const pathCommands = this.parseSVGPath(pathData.path);
            
            // Parse and render the actual path
            await this.drawSVGPathCommands(page, pathCommands, pathData, pageHeight, color, strokeWidth);
        } catch (error) {
            logger.error('Error rendering SVG path:', error);
            // Fallback to bounding box
            await this.renderPathBoundingBox(page, pathData, pageWidth, pageHeight, color, strokeWidth);
        }
    }

    parseSVGPath(pathData) {
        if (!pathData) {
            logger.warn('No path data provided');
            return [];
        }
        
        // Handle Fabric.js toObject() format (array of arrays)
        if (Array.isArray(pathData)) {
            const commands = [];
            
            for (const pathCommand of pathData) {
                if (Array.isArray(pathCommand) && pathCommand.length > 0) {
                    const command = pathCommand[0]; // First element is the command (M, L, Q, etc.)
                    commands.push(command.toUpperCase());
                    
                    // Add coordinates (skip the first element which is the command)
                    for (let i = 1; i < pathCommand.length; i++) {
                        commands.push(parseFloat(pathCommand[i]));
                    }
                }
            }
            
            return commands;
        }
        
        // Handle Fabric.js path format (object with numbered keys) - legacy support
        if (typeof pathData === 'object' && !Array.isArray(pathData)) {
            const commands = [];
            
            // Convert object to array sorted by keys
            const sortedKeys = Object.keys(pathData).sort((a, b) => parseInt(a) - parseInt(b));
            
            for (const key of sortedKeys) {
                const pathCommand = pathData[key];
                if (Array.isArray(pathCommand) && pathCommand.length > 0) {
                    const command = pathCommand[0]; // First element is the command (M, L, Q, etc.)
                    commands.push(command.toUpperCase());
                    
                    // Add coordinates (skip the first element which is the command)
                    for (let i = 1; i < pathCommand.length; i++) {
                        commands.push(parseFloat(pathCommand[i]));
                    }
                }
            }
            
            return commands;
        }
        
        // Handle traditional SVG path string format
        if (typeof pathData === 'string') {
            // Clean up the path string - remove extra spaces and normalize
            const cleaned = pathData.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
            
            // Split into tokens (commands and numbers)
            const tokens = cleaned.split(/(?=[MLHVCSQTAZ])/i).filter(token => token.trim());
            const commands = [];
            
            for (const token of tokens) {
                const parts = token.trim().split(/\s+/);
                const command = parts[0];
                const coords = parts.slice(1).map(parseFloat).filter(n => !isNaN(n));
                
                // Add command
                commands.push(command.toUpperCase());
                
                // Add coordinates
                if (command.toUpperCase() === 'M' || command.toUpperCase() === 'L') {
                    // MoveTo or LineTo: x, y
                    if (coords.length >= 2) {
                        commands.push(coords[0], coords[1]);
                    }
                } else if (command.toUpperCase() === 'Q') {
                    // QuadraticCurveTo: cx, cy, x, y
                    if (coords.length >= 4) {
                        commands.push(coords[0], coords[1], coords[2], coords[3]);
                    }
                } else if (command.toUpperCase() === 'C') {
                    // CubicCurveTo: cx1, cy1, cx2, cy2, x, y
                    if (coords.length >= 6) {
                        commands.push(coords[0], coords[1], coords[2], coords[3], coords[4], coords[5]);
                    }
                }
                // Z command has no coordinates
            }
            
            return commands;
        }
        
        logger.warn('Invalid path data format:', typeof pathData, pathData);
        return [];
    }

    async drawSVGPathCommands(page, pathCommands, pathData, pageHeight, color, strokeWidth) {
        // Apply scaling and positioning
        const scaleX = pathData.scaleX || 1;
        const scaleY = pathData.scaleY || 1;
        const objectLeft = pathData.left || 0;
        const objectTop = pathData.top || 0;
        
        // For Fabric.js paths, we need to understand the coordinate relationship:
        // - The path coordinates are absolute from when drawn
        // - The object's left/top is its position on canvas  
        // - We need to use the object position as the base, not the path's internal coordinates
        
        // Find the path's bounding box to understand its internal coordinate system
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < pathCommands.length; i++) {
            const cmd = pathCommands[i];
            if (typeof cmd === 'string') {
                if (cmd === 'M' || cmd === 'L') {
                    const x = pathCommands[i + 1];
                    const y = pathCommands[i + 2];
                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    maxX = Math.max(maxX, x);
                    maxY = Math.max(maxY, y);
                    i += 2;
                } else if (cmd === 'Q') {
                    const cp1x = pathCommands[i + 1], cp1y = pathCommands[i + 2];
                    const x = pathCommands[i + 3], y = pathCommands[i + 4];
                    minX = Math.min(minX, cp1x, x);
                    minY = Math.min(minY, cp1y, y);
                    maxX = Math.max(maxX, cp1x, x);
                    maxY = Math.max(maxY, cp1y, y);
                    i += 4;
                } else if (cmd === 'C') {
                    const cp1x = pathCommands[i + 1], cp1y = pathCommands[i + 2];
                    const cp2x = pathCommands[i + 3], cp2y = pathCommands[i + 4];
                    const x = pathCommands[i + 5], y = pathCommands[i + 6];
                    minX = Math.min(minX, cp1x, cp2x, x);
                    minY = Math.min(minY, cp1y, cp2y, y);
                    maxX = Math.max(maxX, cp1x, cp2x, x);
                    maxY = Math.max(maxY, cp1y, cp2y, y);
                    i += 6;
                }
            }
        }
        
        // Create RGB color object
        const colorObj = rgb(color.r, color.g, color.b);
        
        // Collect path segments to draw
        let pathSegments = [];
        let currentSegment = [];
        let currentX = 0;
        let currentY = 0;
        
        for (let i = 0; i < pathCommands.length; i++) {
            const cmd = pathCommands[i];
            
            if (typeof cmd === 'string') {
                // Command type (M, L, Q, Z, etc.)
                if (cmd === 'M') {
                    // Move to - start new segment
                    if (currentSegment.length > 0) {
                        pathSegments.push(currentSegment);
                        currentSegment = [];
                    }
                    
                    // Transform coordinates: path internal coords -> relative to object -> PDF coords
                    const pathX = pathCommands[i + 1];
                    const pathY = pathCommands[i + 2];
                    
                    // Convert path coordinates to relative coordinates within the object bounds
                    const relativeX = (pathX - minX) * scaleX;
                    const relativeY = (pathY - minY) * scaleY;
                    
                    // Position relative to the object's position on the page
                    const x = objectLeft + relativeX;
                    const y = pageHeight - (objectTop + relativeY);
                    
                    currentSegment.push({ x, y });
                    currentX = x;
                    currentY = y;
                    i += 2; // Skip the x, y coordinates
                    
                } else if (cmd === 'L') {
                    // Line to
                    const pathX = pathCommands[i + 1];
                    const pathY = pathCommands[i + 2];
                    
                    // Convert path coordinates to relative coordinates within the object bounds
                    const relativeX = (pathX - minX) * scaleX;
                    const relativeY = (pathY - minY) * scaleY;
                    
                    // Position relative to the object's position on the page
                    const x = objectLeft + relativeX;
                    const y = pageHeight - (objectTop + relativeY);
                    
                    currentSegment.push({ x, y });
                    currentX = x;
                    currentY = y;
                    i += 2; // Skip the x, y coordinates
                    
                } else if (cmd === 'Q') {
                    // Quadratic curve - approximate with line segments
                    const pathCpx = pathCommands[i + 1];
                    const pathCpy = pathCommands[i + 2];
                    const pathX = pathCommands[i + 3];
                    const pathY = pathCommands[i + 4];
                    
                    // Convert path coordinates to relative coordinates within the object bounds
                    const relativeCpx = (pathCpx - minX) * scaleX;
                    const relativeCpy = (pathCpy - minY) * scaleY;
                    const relativeX = (pathX - minX) * scaleX;
                    const relativeY = (pathY - minY) * scaleY;
                    
                    // Position relative to the object's position on the page
                    const cpx = objectLeft + relativeCpx;
                    const cpy = pageHeight - (objectTop + relativeCpy);
                    const x = objectLeft + relativeX;
                    const y = pageHeight - (objectTop + relativeY);
                    
                    // Approximate curve with multiple points
                    for (let t = 0.1; t <= 1; t += 0.1) {
                        const curveX = (1 - t) * (1 - t) * currentX + 2 * (1 - t) * t * cpx + t * t * x;
                        const curveY = (1 - t) * (1 - t) * currentY + 2 * (1 - t) * t * cpy + t * t * y;
                        currentSegment.push({ x: curveX, y: curveY });
                    }
                    
                    currentX = x;
                    currentY = y;
                    i += 4; // Skip the control point and end point coordinates
                    
                } else if (cmd === 'C') {
                    // Cubic curve - approximate with line segments
                    const pathCp1x = pathCommands[i + 1];
                    const pathCp1y = pathCommands[i + 2];
                    const pathCp2x = pathCommands[i + 3];
                    const pathCp2y = pathCommands[i + 4];
                    const pathX = pathCommands[i + 5];
                    const pathY = pathCommands[i + 6];
                    
                    // Convert path coordinates to relative coordinates within the object bounds
                    const relativeCp1x = (pathCp1x - minX) * scaleX;
                    const relativeCp1y = (pathCp1y - minY) * scaleY;
                    const relativeCp2x = (pathCp2x - minX) * scaleX;
                    const relativeCp2y = (pathCp2y - minY) * scaleY;
                    const relativeX = (pathX - minX) * scaleX;
                    const relativeY = (pathY - minY) * scaleY;
                    
                    // Position relative to the object's position on the page
                    const cp1x = objectLeft + relativeCp1x;
                    const cp1y = pageHeight - (objectTop + relativeCp1y);
                    const cp2x = objectLeft + relativeCp2x;
                    const cp2y = pageHeight - (objectTop + relativeCp2y);
                    const x = objectLeft + relativeX;
                    const y = pageHeight - (objectTop + relativeY);
                    
                    // Approximate cubic curve with multiple points
                    for (let t = 0; t <= 1; t += 0.1) {
                        const curveX = Math.pow(1 - t, 3) * currentX + 
                                      3 * Math.pow(1 - t, 2) * t * cp1x +
                                      3 * (1 - t) * Math.pow(t, 2) * cp2x +
                                      Math.pow(t, 3) * x;
                        const curveY = Math.pow(1 - t, 3) * currentY + 
                                      3 * Math.pow(1 - t, 2) * t * cp1y +
                                      3 * (1 - t) * Math.pow(t, 2) * cp2y +
                                      Math.pow(t, 3) * y;
                        currentSegment.push({ x: curveX, y: curveY });
                    }
                    
                    currentX = x;
                    currentY = y;
                    i += 6; // Skip all the control points and end point coordinates
                    
                } else if (cmd === 'Z') {
                    // Close path
                    if (currentSegment.length > 0) {
                        currentSegment.push(currentSegment[0]); // Close the path
                    }
                }
            }
        }
        
        // Add the final segment
        if (currentSegment.length > 0) {
            pathSegments.push(currentSegment);
        }
        
        // Draw each path segment using PDF-lib's drawing methods
        for (const segment of pathSegments) {
            if (segment.length > 1) {
                this.drawPathSegment(page, segment, colorObj, strokeWidth);
            }
        }
        
    }

    drawPathSegment(page, points, color, strokeWidth) {
        if (points.length < 2) return;
        
        try {
            // Use PDF-lib's drawLine method for each segment
            for (let i = 1; i < points.length; i++) {
                page.drawLine({
                    start: { x: points[i-1].x, y: points[i-1].y },
                    end: { x: points[i].x, y: points[i].y },
                    thickness: strokeWidth,
                    color: color,
                    opacity: 1,
                });
            }
        } catch (error) {
            logger.error('Error drawing path segment:', error);
        }
    }

    async renderPathBoundingBox(page, pathData, pageWidth, pageHeight, color, strokeWidth) {
        // Calculate actual size including scaling
        const baseWidth = pathData.width || 0;
        const baseHeight = pathData.height || 0;
        const scaleX = pathData.scaleX || 1;
        const scaleY = pathData.scaleY || 1;
        
        const actualWidth = baseWidth * scaleX;
        const actualHeight = baseHeight * scaleY;
        
        if (pathData.left !== undefined && pathData.top !== undefined && actualWidth > 0 && actualHeight > 0) {
            // Convert coordinates
            const x = pathData.left;
            const y = pageHeight - pathData.top - actualHeight;
            
            // For now, draw a simple representation of the drawing area
            page.drawRectangle({
                x,
                y,
                width: actualWidth,
                height: actualHeight,
                borderColor: rgb(color.r, color.g, color.b),
                borderWidth: Math.max(1, strokeWidth)
                // Clean outline only - no text or fill
            });
        }
    }

    async addImageToPage(page, imageData, pageWidth, pageHeight) {
        try {
            // For signatures/images, render the actual image instead of placeholder
            
            // Calculate actual size including scaling
            const baseWidth = imageData.width || 120;
            const baseHeight = imageData.height || 60;
            const scaleX = imageData.scaleX || 1;
            const scaleY = imageData.scaleY || 1;
            
            const actualWidth = baseWidth * scaleX;
            const actualHeight = baseHeight * scaleY;
            
            const x = imageData.left || 0;
            const y = pageHeight - (imageData.top || 0) - actualHeight; // Remove upward shift, use direct mapping
            
            // Ensure the signature stays within page bounds
            const adjustedX = Math.max(0, Math.min(x, pageWidth - actualWidth));
            const adjustedY = Math.max(0, Math.min(y, pageHeight - actualHeight));
            
            // Check if we have actual image data
            if (imageData.src && imageData.src.startsWith('data:image/')) {
                // Render actual signature image
                await this.renderSignatureImage(page, imageData, adjustedX, adjustedY, actualWidth, actualHeight);
            } else {
                // Fallback to enhanced placeholder for signatures without image data
                await this.renderSignaturePlaceholder(page, adjustedX, adjustedY, actualWidth, actualHeight);
            }
        } catch (error) {
            logger.error('Error adding image to page:', error);
            // Don't throw, continue with other annotations
        }
    }

    async renderSignatureImage(page, imageData, x, y, width, height) {
        try {
            // Extract image data from data URL
            const imageDataUrl = imageData.src;
            const base64Data = imageDataUrl.split(',')[1];
            const imageBytes = Buffer.from(base64Data, 'base64');
            
            // Determine image type
            let image;
            if (imageDataUrl.startsWith('data:image/png')) {
                image = await page.doc.embedPng(imageBytes);
            } else if (imageDataUrl.startsWith('data:image/jpeg') || imageDataUrl.startsWith('data:image/jpg')) {
                image = await page.doc.embedJpg(imageBytes);
            } else {
                // Default to PNG
                image = await page.doc.embedPng(imageBytes);
            }
            
            // Draw the actual signature image
            page.drawImage(image, {
                x,
                y,
                width,
                height
            });
        } catch (error) {
            logger.error('Error rendering signature image:', error);
            // Fallback to placeholder
            await this.renderSignaturePlaceholder(page, x, y, width, height);
        }
    }

    async renderSignaturePlaceholder(page, x, y, width, height) {
        // Enhanced placeholder for signatures
        page.drawRectangle({
            x,
            y,
            width,
            height,
            borderColor: rgb(0.4, 0.4, 0.8), // Blue border for signature
            borderWidth: 1,
            color: rgb(0.9, 0.9, 1.0, 0.3) // Light blue fill
        });
        
        // Add signature text
        const font = await page.doc.embedFont(StandardFonts.Helvetica);
        const fontSize = Math.min(10, height / 3, width / 8);
        
        if (fontSize > 6) {
            page.drawText('SIGNATURE', {
                x: x + 5,
                y: y + height/2 - fontSize/2,
                size: fontSize,
                color: rgb(0.4, 0.4, 0.8),
                font
            });
        }
    }

    parseColor(colorString) {
        // Parse color from various formats (#RRGGBB, rgb(), etc.)
        if (colorString.startsWith('#')) {
            const hex = colorString.slice(1);
            return {
                r: parseInt(hex.slice(0, 2), 16) / 255,
                g: parseInt(hex.slice(2, 4), 16) / 255,
                b: parseInt(hex.slice(4, 6), 16) / 255
            };
        }
        
        // Default to black
        return { r: 0, g: 0, b: 0 };
    }

    async deleteTemporaryPdf(fileId) {
        try {
            const filePath = path.join(this.tempDir, `${fileId}.pdf`);
            await fs.unlink(filePath);
            logger.info(`Successfully deleted temporary file: ${fileId}.pdf`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.warn(`Temporary file not found for deletion: ${fileId}.pdf`);
            } else {
                logger.error(`Error deleting temporary file ${fileId}.pdf:`, error);
                throw error;
            }
        }
    }

    async cleanupOldTemporaryFiles() {
        try {
            const tempDir = this.tempDir;
            const files = await fs.readdir(tempDir);
            const maxAge = parseInt(process.env.MAX_TEMP_FILE_AGE_HOURS) || parseInt(process.env.URL_EXPIRY_HOURS) || 24; // hours
            const cutoffTime = Date.now() - (maxAge * 60 * 60 * 1000);
            
            let deletedCount = 0;
            
            for (const file of files) {
                if (file.endsWith('.pdf')) {
                    const filePath = path.join(tempDir, file);
                    const stats = await fs.stat(filePath);
                    
                    if (stats.mtime.getTime() < cutoffTime) {
                        try {
                            await fs.unlink(filePath);
                            deletedCount++;
                            logger.info(`Deleted old temporary file: ${file}`);
                        } catch (error) {
                            logger.warn(`Failed to delete old file ${file}:`, error.message);
                        }
                    }
                }
            }
            
            if (deletedCount > 0) {
                logger.info(`Cleanup completed: deleted ${deletedCount} old temporary files`);
            }
        } catch (error) {
            logger.error('Error during temporary files cleanup:', error);
        }
    }

    async getTempFileStats() {
        try {
            const tempDir = this.tempDir;
            const files = await fs.readdir(tempDir);
            const pdfFiles = files.filter(file => file.endsWith('.pdf'));
            
            let totalSize = 0;
            const fileDetails = [];
            
            for (const file of pdfFiles) {
                const filePath = path.join(tempDir, file);
                const stats = await fs.stat(filePath);
                totalSize += stats.size;
                fileDetails.push({
                    name: file,
                    size: stats.size,
                    created: stats.birthtime,
                    modified: stats.mtime
                });
            }
            
            return {
                fileCount: pdfFiles.length,
                totalSize: totalSize,
                files: fileDetails
            };
        } catch (error) {
            logger.error('Error getting temp file stats:', error);
            return { fileCount: 0, totalSize: 0, files: [] };
        }
    }
}

module.exports = new PdfService();
