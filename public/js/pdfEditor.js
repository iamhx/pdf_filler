class PdfEditor {
    constructor() {
        this.pdfDoc = null;
        this.canvas = null;
        this.ctx = null;
        this.fabricCanvas = null;
        this.currentPage = 1;
        this.totalPages = 0;
        this.currentTool = null;
        this.fileId = null;
        this.sessionId = null;
        this.pdfImageData = null;
        this.scale = 1.0;
        this.baseScale = 1.0; // The base scale that fits the PDF in container
        this.zoomLevel = 1.0; // User zoom level (1.0 = 100%)
        this.pageObjects = {}; // Store objects per page
        this.isPageSwitching = false; // Flag to prevent duplicate saves
        this.resizeTimeout = null; // For debouncing resize events
        
        // Tool-specific color memory
        this.toolColors = {
            text: '#000000',
            draw: '#000000', 
            signature: '#000000'
        };
        
        // Current active event listeners (for cleanup)
        this.activeEventListeners = {
            textClick: null,
            signatureColorChange: null,
            clearSignature: null,
            addSignature: null
        };
        
        // Initialize PDF.js
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.7.107/pdf.worker.min.js';
    }

    async initialize(fileId, sessionId = null) {
        this.fileId = fileId;
        this.sessionId = sessionId;
        await this.loadPdf();
        this.setupCanvas();
        this.setupTools();
        // setupEventListeners will be called after Fabric.js is initialized in renderPage
    }

    setupCanvas() {
        this.canvas = document.getElementById('pdfCanvas');
        this.ctx = this.canvas.getContext('2d');
        
        // Don't initialize Fabric.js here - do it in renderPage
        
        // Render the initial page
        if (this.pdfDoc) {
            this.renderPage(1);
        }
    }

    async loadPdf() {
        // Don't try to load if we already have an error showing
        if (window.hasActiveErrorModal) {
            return;
        }
        
        try {
            utils.showLoading();
            
            // Add timestamp for cache busting
            const timestamp = new Date().getTime();
            
            // Always include sessionId in the request if available
            const response = await fetch(`/api/pdf/${this.fileId}${this.sessionId ? `?sessionId=${this.sessionId}` : ''}&_t=${timestamp}`, {
                headers: {
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                },
                cache: 'no-store'
            });
            if (!response.ok) {
                // Handle specific error responses
                let errorData;
                try {
                    errorData = await response.json();
                } catch (e) {
                    errorData = { message: 'Unable to load document. Please try again later.' };
                    console.error('Failed to parse error response:', e);
                }
                
                utils.hideLoading();
                
                let title = 'Document Error';
                let message = errorData.message || 'There was a problem loading this document.';
                
                if (response.status === 410) {
                    // URL expired, already signed, or declined
                    title = errorData.error === 'PDF already signed' ? 'Already Signed' : 
                           errorData.error === 'PDF declined' ? 'PDF Declined' : 
                           errorData.error === 'URL expired' ? 'URL Expired' : 
                           errorData.error === 'Session expired' ? 'Session Expired' : 'Document Unavailable';
                } else if (response.status === 404) {
                    title = errorData.error === 'Session not found' ? 'Invalid Session' : 
                           errorData.error === 'Session completed' ? 'Session Ended' : 
                           errorData.error === 'Invalid document' ? 'Invalid Document' : 'File Not Found';
                } else if (response.status === 400) {
                    title = errorData.error === 'Session ID required' ? 'Session Required' : 'Invalid Request';
                }
                
                // Show error message as a persistent modal and prevent further interaction
                utils.showError(message, title, true);
                
                // Disable all interactive elements on the page
                if (typeof window.disablePageInteraction === 'function') {
                    window.disablePageInteraction();
                } else {
                    // Fallback if the global function is not available
                    document.querySelectorAll('button, input, a, [role="button"]').forEach(el => {
                        el.disabled = true;
                        el.style.pointerEvents = 'none';
                        el.style.opacity = '0.5';
                    });
                }
                
                return;
            }
            
            const pdfBlob = await response.blob();
            
            const loadingTask = pdfjsLib.getDocument({
                data: await pdfBlob.arrayBuffer()
            });
            
            this.pdfDoc = await loadingTask.promise;
            this.totalPages = this.pdfDoc.numPages;
            this.updatePageInfo();
            utils.hideLoading();
        } catch (error) {
            utils.hideLoading();
            console.error('Error loading PDF:', error);
            
            // Show a user-friendly error and disable page interaction
            utils.showError('We couldn\'t load this PDF. It might be corrupted or in an unsupported format.', 'Error Loading PDF', true);
            
            // Disable page interaction
            if (typeof window.disablePageInteraction === 'function') {
                window.disablePageInteraction();
            }
        }
    }

    async renderPage(pageNumber) {
        try {
            if (!this.pdfDoc) return;
            if (this.isPageSwitching) return; // Prevent concurrent page switches
            
            this.isPageSwitching = true;
            utils.showLoading();
            
            // Only save objects if we're switching to a different page AND not skipping save
            // For same page re-renders (zoom/resize), objects are already saved by caller
            if (this.fabricCanvas && this.currentPage && this.currentPage !== pageNumber && !this.skipPageSave) {
                this.saveCurrentPageObjects();
            }
            
            // Clear the skip flag
            this.skipPageSave = false;
            
            // Update current page early so loadPageObjects works correctly
            const previousPage = this.currentPage;
            this.currentPage = pageNumber;
            
            const page = await this.pdfDoc.getPage(pageNumber);
            
            // Calculate appropriate base scale with better mobile handling
            const pdfContainer = document.querySelector('.pdf-container');
            const containerWidth = pdfContainer.clientWidth - 80;
            const viewport = page.getViewport({ scale: 1.0 });
            
            // Improved mobile scaling logic
            const isMobile = window.innerWidth <= 768;
            if (isMobile) {
                // On mobile, ensure minimum readable scale but allow scrolling
                const minMobileScale = 0.8; // Minimum scale for readability
                const fitWidthScale = (containerWidth - 40) / viewport.width; // Extra margin for mobile
                this.baseScale = Math.max(minMobileScale, Math.min(fitWidthScale, 1.2));
            } else {
                // Desktop: fit to width with reasonable maximum
                this.baseScale = Math.min(containerWidth / viewport.width, 1.5);
            }
            
            // Apply user zoom level to base scale
            this.scale = this.baseScale * this.zoomLevel;
            const scaledViewport = page.getViewport({ scale: this.scale });

            // Create a temporary canvas for PDF rendering
            const tempCanvas = document.createElement('canvas');
            const tempCtx = tempCanvas.getContext('2d');
            tempCanvas.width = scaledViewport.width;
            tempCanvas.height = scaledViewport.height;

            // Render PDF to temporary canvas
            await page.render({
                canvasContext: tempCtx,
                viewport: scaledViewport
            }).promise;

            // Get the PDF as data URL using PNG for better text quality than JPEG
            const pdfDataURL = tempCanvas.toDataURL('image/png');
            
            // Cleanup to free memory
            tempCanvas.width = 0;
            tempCanvas.height = 0;

            // Set canvas size and initialize/resize Fabric canvas
            this.canvas.width = scaledViewport.width;
            this.canvas.height = scaledViewport.height;
            
            // Let canvas display at its actual size, don't force CSS dimensions
            this.canvas.style.width = '';
            this.canvas.style.height = '';
            this.canvas.style.display = 'block';
            
            const isFirstInit = !this.fabricCanvas;
            if (!this.fabricCanvas) {
                this.fabricCanvas = new fabric.Canvas('pdfCanvas');
                // Apply the current tool state now that fabricCanvas exists
                this.applyCurrentToolState();
            } else {
                // Clear existing canvas completely
                this.fabricCanvas.clear();
                this.fabricCanvas.isDrawingMode = false; // Reset drawing mode
                // Reapply current tool state after clearing
                this.applyCurrentToolState();
            }
            
            this.fabricCanvas.setDimensions({
                width: scaledViewport.width,
                height: scaledViewport.height
            });

            // Set the PDF as background image
            const img = new Image();
            img.onload = () => {
                const fabricImage = new fabric.Image(img, {
                    selectable: false,
                    evented: false
                });
                
                this.fabricCanvas.setBackgroundImage(fabricImage, () => {
                    // Load objects for this page if they exist
                    const pageObjects = this.loadPageObjects(pageNumber);
                    
                    if (pageObjects.length > 0) {
                        this.restorePageObjects(pageObjects, pageNumber);
                    } else {
                        // No stored objects
                        this.fabricCanvas.renderAll();
                        
                        // Update page info
                        this.updatePageInfo();
                        this.updateZoomDisplay();
                        this.isPageSwitching = false;
                        utils.hideLoading();
                    }
                    
                    // Set up event listeners only on first initialization
                    if (isFirstInit) {
                        this.setupEventListeners();
                    }
                });
            };
            img.src = pdfDataURL;

        } catch (error) {
            utils.showError('Error rendering PDF page');
            console.error('Error rendering page:', error);
        }
    }

    setupTools() {
        // Pointer Tool (default)
        document.getElementById('pointerTool').addEventListener('click', () => {
            this.setActiveTool('pointer');
        });

        // Text Tool
        document.getElementById('textTool').addEventListener('click', () => {
            this.setActiveTool('text');
            this.addTextClickHandler();
        });

        // Drawing Tool
        document.getElementById('drawTool').addEventListener('click', () => {
            this.setActiveTool('draw');
        });

        // Signature Tool
        document.getElementById('signatureTool').addEventListener('click', () => {
            this.setActiveTool('signature');
            this.openSignatureModal();
        });

        // Zoom Controls
        document.getElementById('zoomIn').addEventListener('click', () => {
            this.zoomIn();
        });

        document.getElementById('zoomOut').addEventListener('click', () => {
            this.zoomOut();
        });

        document.getElementById('zoomFit').addEventListener('click', () => {
            this.zoomFit();
        });

        // Mobile Controls (duplicate functionality for mobile buttons)
        this.setupMobileControls();

        // Set pointer as default tool
        this.setActiveTool('pointer');

        // Note: Properties panel setup is moved to setupEventListeners 
        // since it needs fabricCanvas to exist
    }

    setupMobileControls() {
        // Mobile controls are no longer needed since we use the same bottom nav for all devices
        // Remove this method or leave empty for backwards compatibility
    }

    syncToolButtons() {
        // Update active state for bottom navigation tools
        const allNavItems = document.querySelectorAll('.nav-item');
        allNavItems.forEach(btn => btn.classList.remove('active'));
        
        // Add active class to current tool button
        const currentToolBtn = document.querySelector(`[data-tool="${this.currentTool}"]`);
        if (currentToolBtn) {
            currentToolBtn.classList.add('active');
        }
        
        // Show/hide tool properties panel based on the current tool
        this.updateToolPropertiesPanel();
    }

    addTextClickHandler() {
        // Add click listener to canvas for text creation (extracted for reuse)
        const addTextOnClick = (e) => {
            const pointer = this.fabricCanvas.getPointer(e.e);
            const scaledFontSize = this.getScaledFontSize(20);
            
            const text = new fabric.IText('Click to edit', {
                left: pointer.x,
                top: pointer.y,
                fontSize: scaledFontSize,
                fontFamily: 'Helvetica, Arial, sans-serif', // Match PDF font
                fill: this.getCurrentColor(),
                scaleX: 1,
                scaleY: 1,
                // Constrain text annotations to proportional resizing only
                lockUniScaling: true,    // Forces uniform scaling (maintains aspect ratio)
                lockRotation: true,      // Prevents rotation
                lockSkewingX: true,      // Prevents horizontal skewing
                lockSkewingY: true       // Prevents vertical skewing
            });
            
            // Additional control visibility settings to ensure constraints work
            text.setControlsVisibility({
                // Hide rotation control
                mtr: false,
                // Hide individual corner scaling controls, only keep uniform scaling
                tl: true,   // top-left (uniform scaling)
                tr: true,   // top-right (uniform scaling) 
                bl: true,   // bottom-left (uniform scaling)
                br: true,   // bottom-right (uniform scaling)
                // Hide middle controls that allow non-uniform scaling
                ml: false,  // middle-left (width only)
                mt: false,  // middle-top (height only)
                mr: false,  // middle-right (width only)
                mb: false   // middle-bottom (height only)
            });
            
            this.fabricCanvas.add(text);
            this.fabricCanvas.setActiveObject(text);
            
            // Immediately switch back to pointer tool
            this.setActiveTool('pointer');
        };
        
        // Store the listener reference and add it
        this.activeEventListeners.textClick = addTextOnClick;
        this.fabricCanvas.on('mouse:down', addTextOnClick);
    }

    setupPropertiesPanel() {
        const colorInput = document.getElementById('elementColor');

        colorInput.addEventListener('input', () => {
            const newColor = colorInput.value;
            
            // Save the color for the current tool
            if (this.currentTool && this.toolColors.hasOwnProperty(this.currentTool)) {
                this.setToolColor(this.currentTool, newColor);
            }
            
            // Apply color to selected object if any
            const activeObject = this.fabricCanvas.getActiveObject();
            if (activeObject) {
                if (activeObject.type === 'i-text') {
                    activeObject.set('fill', newColor);
                } else if (activeObject.type === 'path') {
                    activeObject.set('stroke', newColor);
                } else if (activeObject.type === 'image') {
                    // Note: Cannot change color of images/signatures easily
                    // Color change not supported for images/signatures
                }
                this.fabricCanvas.requestRenderAll();
            }
            
            // Update drawing brush color if in draw mode
            if (this.fabricCanvas.isDrawingMode) {
                this.fabricCanvas.freeDrawingBrush.color = newColor;
            }
        });
    }

    setupEventListeners() {
        // Only set up if fabricCanvas exists
        if (!this.fabricCanvas) return;
        
        // Set up properties panel now that fabricCanvas exists
        this.setupPropertiesPanel();
        
        // Object selection
        this.fabricCanvas.on('selection:created', this.handleObjectSelection.bind(this));
        this.fabricCanvas.on('selection:updated', this.handleObjectSelection.bind(this));
        this.fabricCanvas.on('selection:cleared', this.handleSelectionCleared.bind(this));

        // Auto-save when objects are added, modified, or removed
        this.fabricCanvas.on('object:added', () => {
            // Don't auto-save during restoration or page switching
            if (this.isRestoring || this.isPageSwitching) return;
            // Small delay to ensure object is fully added
            setTimeout(() => this.saveCurrentPageObjects(), 10);
        });
        
        this.fabricCanvas.on('object:modified', () => {
            // Don't auto-save during restoration or page switching
            if (this.isRestoring || this.isPageSwitching) return;
            this.saveCurrentPageObjects();
        });
        
        this.fabricCanvas.on('object:removed', () => {
            // Don't auto-save during restoration or page switching
            if (this.isRestoring || this.isPageSwitching) return;
            this.saveCurrentPageObjects();
        });

        // Note: Removed auto-switching for draw tool - user manually switches tools

        // Submit button
        document.getElementById('submitBtn').addEventListener('click', async () => {
            await this.saveChanges();
        });

        // Decline button
        document.getElementById('declineBtn').addEventListener('click', async () => {
            await this.declinePdf();
        });
        
        // Page navigation
        document.getElementById('prevPage').addEventListener('click', async () => {
            await this.prevPage();
        });
        
        document.getElementById('nextPage').addEventListener('click', async () => {
            await this.nextPage();
        });
        
        // Delete selected object
        document.getElementById('deleteBtn').addEventListener('click', () => {
            this.deleteSelectedObject();
        });
        
        // Add keyboard listener for Delete key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Delete' && this.fabricCanvas.getActiveObject()) {
                this.deleteSelectedObject();
            }
        });

        // Navigation buttons
        document.getElementById('nextPage').addEventListener('click', async () => {
            await this.nextPage();
        });
        document.getElementById('prevPage').addEventListener('click', async () => {
            await this.prevPage();
        });
        
        // Window resize handler for responsive PDF scaling
        window.addEventListener('resize', () => {
            // Debounce resize events
            clearTimeout(this.resizeTimeout);
            this.resizeTimeout = setTimeout(() => {
                if (this.pdfDoc && this.currentPage && !this.isPageSwitching) {
                    // Window resized, re-rendering PDF for new dimensions
                    // Save current objects before re-rendering, preserving current scale
                    if (this.fabricCanvas) {
                        const oldScale = this.scale; // Preserve the current scale for correct normalization
                        this.saveCurrentPageObjectsWithScale(oldScale);
                    }
                    // Set flag to prevent double save in renderPage
                    this.skipPageSave = true;
                    this.renderPage(this.currentPage);
                }
            }, 300);
        });
    }

    cleanupActiveEventListeners() {
        // Remove any active tool-specific event listeners
        if (this.fabricCanvas && this.activeEventListeners.textClick) {
            this.fabricCanvas.off('mouse:down', this.activeEventListeners.textClick);
            this.activeEventListeners.textClick = null;
        }
        
        // Clean up signature modal listeners
        const signatureColorInput = document.getElementById('signatureColor');
        const clearSignatureBtn = document.getElementById('clearSignature');
        const addSignatureBtn = document.getElementById('addSignature');
        
        if (signatureColorInput && this.activeEventListeners.signatureColorChange) {
            signatureColorInput.removeEventListener('input', this.activeEventListeners.signatureColorChange);
            this.activeEventListeners.signatureColorChange = null;
        }
        
        if (clearSignatureBtn && this.activeEventListeners.clearSignature) {
            clearSignatureBtn.onclick = null;
            this.activeEventListeners.clearSignature = null;
        }
        
        if (addSignatureBtn && this.activeEventListeners.addSignature) {
            addSignatureBtn.onclick = null;
            this.activeEventListeners.addSignature = null;
        }
    }

    handleObjectSelection() {
        // Show delete button for selected objects
        document.getElementById('elementProperties').classList.remove('d-none');
        
        // Update tool properties panel - this handles all color picker logic
        this.updateToolPropertiesPanel();
    }

    handleSelectionCleared() {
        // Hide delete button when nothing is selected
        document.getElementById('elementProperties').classList.add('d-none');
        
        // Update tool properties panel - this handles all color picker logic
        this.updateToolPropertiesPanel();
    }

    setActiveTool(tool) {
        // Clean up any active event listeners from previous tool
        this.cleanupActiveEventListeners();
        
        // Deselect all objects when switching tools
        if (this.fabricCanvas) {
            this.fabricCanvas.discardActiveObject();
            this.fabricCanvas.renderAll();
        }
        
        this.currentTool = tool;
        
        // Only handle canvas operations if fabricCanvas exists
        if (this.fabricCanvas) {
            // Handle drawing mode and canvas selection
            if (tool === 'draw') {
                this.fabricCanvas.isDrawingMode = true;
                this.fabricCanvas.freeDrawingBrush.width = this.getCurrentBrushWidth();
                this.fabricCanvas.freeDrawingBrush.color = this.getCurrentColor();
                this.fabricCanvas.selection = false; // Disable selection in draw mode
            } else {
                this.fabricCanvas.isDrawingMode = false;
                this.fabricCanvas.selection = true; // Enable selection for pointer tool
            }
        }
        
        // Update UI - this will handle color picker, labels, and panel visibility
        this.syncToolButtons();
    }

    openSignatureModal() {
        const modal = new bootstrap.Modal(document.getElementById('signatureModal'));
        const signatureCanvas = document.getElementById('signatureCanvas');
        
        // Clean up any existing signature canvas first
        if (window.currentSignaturePad && !window.currentSignaturePad._disposed) {
            window.currentSignaturePad.dispose();
            window.currentSignaturePad = null;
        }
        
        // Clear any existing canvas content completely
        const context = signatureCanvas.getContext('2d');
        context.clearRect(0, 0, signatureCanvas.width, signatureCanvas.height);
        
        // Reset canvas element to ensure clean state
        signatureCanvas.width = signatureCanvas.width; // This completely clears the canvas
        
        // Set up the signature color picker with current signature color
        const signatureColorInput = document.getElementById('signatureColor');
        const clearSignatureBtn = document.getElementById('clearSignature');
        signatureColorInput.value = this.getCurrentColor();
        signatureColorInput.disabled = false;
        signatureColorInput.title = "";
        
        // Initialize signature pad with proper responsive sizing
        const canvasContainer = signatureCanvas.closest('.signature-canvas-container');
        
        // Calculate responsive dimensions based on container
        const initializeSignatureCanvas = () => {
            // Get container dimensions
            const containerWidth = canvasContainer.clientWidth - 32; // Account for padding
            let canvasHeight = 300;
            
            // Adjust height for smaller screens
            if (window.innerWidth <= 480) {
                canvasHeight = 200;
            } else if (window.innerWidth <= 768) {
                canvasHeight = 250;
            }
            
            // Calculate width to fit container
            const canvasWidth = Math.max(300, containerWidth);
            
            // Create Fabric.js canvas
            const signaturePad = new fabric.Canvas('signatureCanvas', {
                isDrawingMode: true,
                width: canvasWidth,
                height: canvasHeight
            });
            
            return signaturePad;
        };
        
        // Initialize after a brief delay to ensure container is rendered
        setTimeout(() => {
            const signaturePad = initializeSignatureCanvas();
            window.currentSignaturePad = signaturePad;
            
            // Set up drawing properties
            signaturePad.freeDrawingBrush.width = 3;
            signaturePad.freeDrawingBrush.color = this.getCurrentColor();

            // Lock the color once drawing starts to prevent rainbow signatures
            let drawingStarted = false;
            let lockedColor = this.getCurrentColor();
            
            // Initially disable the Add Signature button
            const addSignatureBtn = document.getElementById('addSignature');
            addSignatureBtn.disabled = true;
            addSignatureBtn.textContent = 'Draw signature first';
            
            // Set up event handlers
            signaturePad.on('path:created', () => {
                if (!drawingStarted) {
                    drawingStarted = true;
                    lockedColor = signaturePad.freeDrawingBrush.color;
                    // Disable color picker once drawing starts
                    signatureColorInput.disabled = true;
                    signatureColorInput.title = "Color locked while drawing. Clear signature to change color.";
                }
                // Enable Add Signature button once something is drawn
                addSignatureBtn.disabled = false;
                addSignatureBtn.textContent = 'Add Signature';
            });

            // Set up color change handler
            const colorChangeHandler = (e) => {
                if (!drawingStarted) {
                    const newColor = e.target.value;
                    signaturePad.freeDrawingBrush.color = newColor;
                    lockedColor = newColor;
                }
            };
            
            signatureColorInput.addEventListener('input', colorChangeHandler);
            this.activeEventListeners.signatureColorChange = colorChangeHandler;

            // Set up clear button
            const clearHandler = () => {
                signaturePad.clear();
                drawingStarted = false;
                signatureColorInput.disabled = false;
                signatureColorInput.title = "";
                addSignatureBtn.disabled = true;
                addSignatureBtn.textContent = 'Draw signature first';
                
                // Reset brush color to current selection
                const currentColor = signatureColorInput.value;
                signaturePad.freeDrawingBrush.color = currentColor;
                lockedColor = currentColor;
            };
            
            clearSignatureBtn.onclick = clearHandler;
            this.activeEventListeners.clearSignature = clearHandler;

            // Set up add signature button
            const addHandler = () => {
                if (signaturePad.getObjects().length === 0) {
                    return; // No signature drawn
                }

                // Convert signature to image with improved error handling
                try {
                    const dataURL = signaturePad.toDataURL({
                        format: 'png',
                        quality: 1.0,
                        multiplier: 2 // Higher resolution
                    });

                    // Create image object and add to main canvas
                    fabric.Image.fromURL(dataURL, (img) => {
                        try {
                            img.set({
                                left: 100,
                                top: 100,
                                scaleX: 0.5,
                                scaleY: 0.5,
                                isSignature: true // Mark as signature for special handling
                            });
                            
                            this.fabricCanvas.add(img);
                            this.fabricCanvas.setActiveObject(img);
                            this.fabricCanvas.renderAll();
                            this.saveCurrentPageObjects();
                        } catch (fabricError) {
                            console.warn('Error adding signature to canvas:', fabricError);
                            alert('Failed to add signature to PDF. Please try again.');
                        }
                    }, { crossOrigin: 'anonymous' });
                } catch (error) {
                    console.warn('Error converting signature to image:', error);
                    alert('Failed to process signature. Please try drawing again.');
                    return;
                }

                // Properly dispose signature pad
                try {
                    if (signaturePad && !signaturePad._disposed) {
                        signaturePad.dispose();
                    }
                } catch (e) {
                    // Signature pad already disposed
                }
                window.currentSignaturePad = null;
                
                // Close modal
                modal.hide();
                
                // Switch back to pointer tool
                this.setActiveTool('pointer');
            };
            
            addSignatureBtn.onclick = addHandler;
            this.activeEventListeners.addSignature = addHandler;

            // Handle modal close/cancel - properly clean up canvas
            const modalElement = document.getElementById('signatureModal');
            const handleModalClose = () => {
                // Safest cleanup - just nullify the reference
                try {
                    if (signaturePad) {
                        // Don't call any Fabric.js methods that might fail
                        // Just clear our reference
                        window.currentSignaturePad = null;
                    }
                } catch (e) {
                    // Signature pad cleanup error: ${e.message}
                }
                window.currentSignaturePad = null;
                
                // Reset to pointer tool
                this.setActiveTool('pointer');
            };
            
            // Add event listener for when modal is hidden
            modalElement.addEventListener('hidden.bs.modal', handleModalClose, { once: true });
        }, 50);
        
        // Show the modal
        modal.show();
    }

    saveCurrentPageObjects() {
        if (this.fabricCanvas) {
            // Exit drawing mode temporarily to ensure all paths are finalized
            const wasDrawing = this.fabricCanvas.isDrawingMode;
            if (wasDrawing) {
                this.fabricCanvas.isDrawingMode = false;
            }
            
            // Get all objects and convert to JSON, normalizing coordinates for zoom independence
            const objects = this.fabricCanvas.getObjects();
            const currentScale = this.scale;
            
            this.pageObjects[this.currentPage] = objects.map(obj => {
                const objData = obj.toObject();
                
                // Normalize coordinates to be zoom-independent
                if (currentScale && currentScale !== 1.0) {
                    objData.left = objData.left / currentScale;
                    objData.top = objData.top / currentScale;
                    
                    // Special handling for text objects
                    if (objData.type === 'i-text') {
                        // For text, we need to store the base font size without any scaling applied
                        const currentScaleX = objData.scaleX || 1;
                        const currentScaleY = objData.scaleY || 1;
                        
                        // If this object already has a stored base font size, use it
                        // Otherwise, calculate it from the current state
                        if (!objData.baseFontSize) {
                            objData.baseFontSize = (objData.fontSize || 20) / currentScale;
                        }
                        
                        // Store the manual scaling from resize handles
                        objData.manualScaleX = currentScaleX;
                        objData.manualScaleY = currentScaleY;
                        
                        // For storage, use the base font size and reset scale to 1
                        objData.fontSize = objData.baseFontSize;
                        objData.scaleX = 1;
                        objData.scaleY = 1;
                    } else {
                        // For other objects, normalize the scale
                        objData.scaleX = (objData.scaleX || 1) / currentScale;
                        objData.scaleY = (objData.scaleY || 1) / currentScale;
                    }
                    
                    if (objData.strokeWidth) {
                        objData.strokeWidth = objData.strokeWidth / currentScale;
                    }
                }
                return objData;
            });
            
            // Restore drawing mode if it was active
            if (wasDrawing) {
                this.fabricCanvas.isDrawingMode = true;
            }
        }
    }

    saveCurrentPageObjectsWithScale(useScale) {
        if (this.fabricCanvas) {
            // Exit drawing mode temporarily to ensure all paths are finalized
            const wasDrawing = this.fabricCanvas.isDrawingMode;
            if (wasDrawing) {
                this.fabricCanvas.isDrawingMode = false;
            }
            
            // Get all objects and convert to JSON, normalizing coordinates for zoom independence
            const objects = this.fabricCanvas.getObjects();
            
            this.pageObjects[this.currentPage] = objects.map(obj => {
                const objData = obj.toObject();
                // Normalize coordinates to be zoom-independent using the provided scale
                if (useScale && useScale !== 1.0) {
                    objData.left = objData.left / useScale;
                    objData.top = objData.top / useScale;
                    
                    // Special handling for text objects
                    if (objData.type === 'i-text') {
                        // For text, we need to store the base font size without any scaling applied
                        const currentScaleX = objData.scaleX || 1;
                        const currentScaleY = objData.scaleY || 1;
                        
                        // If this object already has a stored base font size, use it
                        // Otherwise, calculate it from the current state
                        if (!objData.baseFontSize) {
                            objData.baseFontSize = (objData.fontSize || 20) / useScale;
                        }
                        
                        // Store the manual scaling from resize handles
                        objData.manualScaleX = currentScaleX;
                        objData.manualScaleY = currentScaleY;
                        
                        // For storage, use the base font size and reset scale to 1
                        objData.fontSize = objData.baseFontSize;
                        objData.scaleX = 1;
                        objData.scaleY = 1;
                    } else {
                        // For other objects, normalize the scale
                        objData.scaleX = (objData.scaleX || 1) / useScale;
                        objData.scaleY = (objData.scaleY || 1) / useScale;
                    }
                    
                    if (objData.strokeWidth) {
                        objData.strokeWidth = objData.strokeWidth / useScale;
                    }
                }
                return objData;
            });
            
            // Restore drawing mode if it was active
            if (wasDrawing) {
                this.fabricCanvas.isDrawingMode = true;
            }
        }
    }

    loadPageObjects(pageNumber) {
        if (this.pageObjects[pageNumber]) {
            return this.pageObjects[pageNumber].slice();
        }
        return [];
    }

    restorePageObjects(pageObjects, pageNumber) {
        // Set flag to prevent auto-save during restoration
        this.isRestoring = true;
        
        let pendingObjects = 0;
        let totalObjects = pageObjects.length;
        const currentScale = this.scale;
        
        // Function to finish restoration when all objects are ready
        const finishRestoration = () => {
            this.fabricCanvas.renderAll();
            this.updatePageInfo();
            this.updateZoomDisplay();
            this.isPageSwitching = false;
            // Clear restoration flag
            this.isRestoring = false;
            utils.hideLoading();
        };
        
        // Function to scale object coordinates to current zoom level
        const scaleObjectForCurrentZoom = (objData) => {
            if (currentScale && currentScale !== 1.0) {
                objData.left = objData.left * currentScale;
                objData.top = objData.top * currentScale;
                
                // Special handling for text objects
                if (objData.type === 'i-text') {
                    // For text, scale the base font size and restore manual scaling
                    const baseFontSize = objData.baseFontSize || objData.fontSize || 20;
                    objData.fontSize = baseFontSize * currentScale;
                    
                    // Restore any manual scaling that was applied via resize handles
                    objData.scaleX = objData.manualScaleX || 1;
                    objData.scaleY = objData.manualScaleY || 1;
                    
                    // Store the base font size for future saves
                    objData.baseFontSize = baseFontSize;
                } else {
                    // For other objects, scale the scale properties
                    objData.scaleX = (objData.scaleX || 1) * currentScale;
                    objData.scaleY = (objData.scaleY || 1) * currentScale;
                }
                
                if (objData.strokeWidth) {
                    objData.strokeWidth = objData.strokeWidth * currentScale;
                }
            }
            return objData;
        };
        
        // Function to add object to canvas and check if we're done
        const addObjectAndCheck = (obj) => {
            this.fabricCanvas.add(obj);
            pendingObjects--;
            if (pendingObjects === 0) {
                finishRestoration();
            }
        };
        
        // Process each object
        pageObjects.forEach(objData => {
            // Make a copy and scale it for current zoom
            const scaledObjData = scaleObjectForCurrentZoom({...objData});
            
            if (scaledObjData.type === 'i-text') {
                const text = new fabric.IText(scaledObjData.text, {
                    ...scaledObjData,
                    // Ensure consistent font family
                    fontFamily: scaledObjData.fontFamily || 'Helvetica, Arial, sans-serif',
                    // Ensure constrained resizing for restored text objects
                    lockUniScaling: true,    // Forces uniform scaling (maintains aspect ratio)
                    lockRotation: true,      // Prevents rotation
                    lockSkewingX: true,      // Prevents horizontal skewing
                    lockSkewingY: true       // Prevents vertical skewing
                });
                
                // Additional control visibility settings to ensure constraints work
                text.setControlsVisibility({
                    // Hide rotation control
                    mtr: false,
                    // Hide individual corner scaling controls, only keep uniform scaling
                    tl: true,   // top-left (uniform scaling)
                    tr: true,   // top-right (uniform scaling) 
                    bl: true,   // bottom-left (uniform scaling)
                    br: true,   // bottom-right (uniform scaling)
                    // Hide middle controls that allow non-uniform scaling
                    ml: false,  // middle-left (width only)
                    mt: false,  // middle-top (height only)
                    mr: false,  // middle-right (width only)
                    mb: false   // middle-bottom (height only)
                });
                
                pendingObjects++;
                // Add synchronously
                setTimeout(() => addObjectAndCheck(text), 0);
            } else if (scaledObjData.type === 'path') {
                pendingObjects++;
                fabric.Path.fromObject(scaledObjData, (path) => {
                    addObjectAndCheck(path);
                });
            } else if (scaledObjData.type === 'image') {
                pendingObjects++;
                fabric.Image.fromObject(scaledObjData, (img) => {
                    addObjectAndCheck(img);
                });
            } else {
                // Handle other object types generically
                pendingObjects++;
                fabric.util.enlivenObjects([scaledObjData], (objects) => {
                    if (objects && objects[0]) {
                        addObjectAndCheck(objects[0]);
                    } else {
                        pendingObjects--;
                        if (pendingObjects === 0) {
                            finishRestoration();
                        }
                    }
                });
            }
        });
        
        // If no objects to restore, finish immediately
        if (pendingObjects === 0) {
            finishRestoration();
        }
    }

    updatePageInfo() {
        const pageInfo = document.getElementById('pageInfo');
        const pageInfoMobile = document.getElementById('pageInfoMobile');
        const pageText = `${this.currentPage} / ${this.totalPages}`;
        
        if (pageInfo) {
            pageInfo.textContent = pageText;
        }
        if (pageInfoMobile) {
            pageInfoMobile.textContent = `${this.currentPage}/${this.totalPages}`;
        }
        
        // Update navigation buttons (desktop)
        const prevBtn = document.getElementById('prevPage');
        const nextBtn = document.getElementById('nextPage');
        
        if (prevBtn) prevBtn.disabled = this.currentPage <= 1;
        if (nextBtn) nextBtn.disabled = this.currentPage >= this.totalPages;
        
        // Update navigation buttons (mobile)
        const prevBtnMobile = document.getElementById('prevPageMobile');
        const nextBtnMobile = document.getElementById('nextPageMobile');
        
        if (prevBtnMobile) prevBtnMobile.disabled = this.currentPage <= 1;
        if (nextBtnMobile) nextBtnMobile.disabled = this.currentPage >= this.totalPages;
    }

    async goToPage(pageNumber) {
        if (pageNumber < 1 || pageNumber > this.totalPages || pageNumber === this.currentPage) {
            return;
        }
        
        // The rendering will handle saving current page objects
        await this.renderPage(pageNumber);
    }

    async nextPage() {
        await this.goToPage(this.currentPage + 1);
    }

    async prevPage() {
        await this.goToPage(this.currentPage - 1);
    }
    
    deleteSelectedObject() {
        const activeObject = this.fabricCanvas.getActiveObject();
        if (activeObject) {
            // Handle group selection
            if (activeObject.type === 'activeSelection') {
                activeObject.forEachObject(obj => {
                    this.fabricCanvas.remove(obj);
                });
            } else {
                this.fabricCanvas.remove(activeObject);
            }
            this.fabricCanvas.discardActiveObject();
            this.fabricCanvas.requestRenderAll();
        }
    }

    async saveChanges() {
        try {
            utils.showLoading();
            
            // Save current page objects
            this.saveCurrentPageObjects();
            
            // Check if there are any annotations across all pages
            const hasAnnotations = this.hasAnyAnnotations();
            
            if (!hasAnnotations) {
                utils.hideLoading();
                // Show error dialog - cannot submit without annotations
                this.showNoAnnotationsDialog();
                return;
            }
            
            // Show confirmation dialog
            const confirmed = await this.showSubmitConfirmationDialog();
            if (!confirmed) {
                utils.hideLoading();
                return;
            }
            
            // Convert all pages to modifications object
            const modifications = {
                pages: this.pageObjects,
                totalPages: this.totalPages,
                currentPageObjects: this.fabricCanvas.toJSON().objects,
                canvasWidth: this.fabricCanvas.width,
                canvasHeight: this.fabricCanvas.height
            };

            // Send to server
            const signUrl = `/api/pdf/${this.fileId}/sign${this.sessionId ? `?sessionId=${this.sessionId}` : ''}`;
            const response = await fetch(signUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ modifications })
            });

            if (!response.ok) {
                // Handle specific error responses
                const errorData = await response.json().catch(() => ({}));
                
                if (response.status === 410) {
                    // URL expired, already signed, or declined
                    const message = errorData.message || 'This PDF link has expired.';
                    const title = errorData.error === 'PDF already signed' ? 'Already Signed' : 
                                 errorData.error === 'PDF declined' ? 'PDF Declined' : 'URL Expired';
                    utils.hideLoading();
                    utils.showError(message, title);
                    return;
                } else if (response.status === 404) {
                    const message = errorData.message || 'The PDF file was not found. It may have been removed.';
                    utils.hideLoading();
                    utils.showError(message, 'File Not Found');
                    return;
                } else {
                    throw new Error('Failed to save changes');
                }
            }

            const result = await response.json();
            utils.hideLoading();
            
            // Use POST-redirect-GET pattern to prevent back button issues
            // Replace current history entry and redirect to success page
            window.history.replaceState(null, '', '/success.html');
            window.location.href = '/success.html';
        } catch (error) {
            utils.hideLoading();
            utils.showError('Error saving changes');
            console.error('Error saving changes:', error);
        }
    }

    async declinePdf() {
        try {
            // Show confirmation dialog first
            const confirmed = await this.showDeclineConfirmationDialog();
            if (!confirmed) {
                return;
            }
            
            utils.showLoading();
            
            const declineUrl = `/api/pdf/${this.fileId}/decline${this.sessionId ? `?sessionId=${this.sessionId}` : ''}`;
            const response = await fetch(declineUrl, {
                method: 'POST'
            });

            if (!response.ok) {
                // Handle specific error responses
                const errorData = await response.json().catch(() => ({}));
                
                if (response.status === 410) {
                    // URL expired, already signed, or declined
                    const message = errorData.message || 'This PDF link has expired.';
                    const title = errorData.error === 'PDF already signed' ? 'Already Signed' : 
                                 errorData.error === 'PDF declined' ? 'PDF Declined' : 'URL Expired';
                    utils.hideLoading();
                    utils.showError(message, title);
                    return;
                } else if (response.status === 404) {
                    const message = errorData.message || 'The PDF file was not found. It may have been removed.';
                    utils.hideLoading();
                    utils.showError(message, 'File Not Found');
                    return;
                } else {
                    throw new Error('Failed to decline PDF');
                }
            }

            utils.hideLoading();
            window.location.href = '/declined.html';
        } catch (error) {
            utils.hideLoading();
            utils.showError('Error declining PDF');
            console.error('Error declining PDF:', error);
        }
    }

    applyCurrentToolState() {
        // Apply the current tool state to the fabricCanvas
        if (!this.fabricCanvas || !this.currentTool) return;
        
        if (this.currentTool === 'draw') {
            this.fabricCanvas.isDrawingMode = true;
            this.fabricCanvas.freeDrawingBrush.width = this.getCurrentBrushWidth();
            this.fabricCanvas.freeDrawingBrush.color = this.getCurrentColor();
            this.fabricCanvas.selection = false;
        } else {
            this.fabricCanvas.isDrawingMode = false;
            this.fabricCanvas.selection = true;
        }
    }

    getCurrentColor() {
        // Return the color for the current tool, fallback to color input, then black
        if (this.currentTool && this.toolColors[this.currentTool]) {
            return this.toolColors[this.currentTool];
        }
        const colorInput = document.getElementById('elementColor');
        return colorInput ? colorInput.value : '#000000';
    }

    setToolColor(tool, color) {
        if (this.toolColors.hasOwnProperty(tool)) {
            this.toolColors[tool] = color;
        }
    }

    updateColorPicker(color) {
        const colorInput = document.getElementById('elementColor');
        if (colorInput) {
            colorInput.value = color;
        }
    }

    getCurrentBrushWidth() {
        const baseWidth = 2; // Default brush width
        return baseWidth * (this.scale || 1); // Scale brush width with zoom
    }

    updateColorSectionLabel(labelText) {
        const toolColorLabel = document.querySelector('#toolColorSection .property-label');
        
        if (toolColorLabel) {
            toolColorLabel.textContent = labelText;
        }
    }

    updateColorPreview(color) {
        // No longer needed - color input shows the color directly
        // Keeping this method for backwards compatibility
    }

    updateToolPropertiesPanel() {
        const panel = document.getElementById('toolPropertiesPanel');
        const activeObject = this.fabricCanvas?.getActiveObject();
        const colorSection = document.getElementById('toolColorSection');
        const colorInput = document.getElementById('elementColor');
        
        // Determine if we should show the panel
        const shouldShowPanel = this.currentTool !== 'pointer' || activeObject;
        
        if (shouldShowPanel) {
            panel.classList.add('show');
            
            if (activeObject) {
                // Object is selected - handle object-specific logic
                if (activeObject.type === 'activeSelection') {
                    // Multiple objects selected
                    this.updateColorSectionLabel('Multiple Objects');
                    colorInput.disabled = true;
                    colorInput.title = "Cannot change color of multiple objects";
                    colorSection.style.display = 'block';
                } else if (activeObject.isSignature) {
                    // Single signature object - hide color picker entirely
                    colorSection.style.display = 'none';
                } else {
                    // Single non-signature object
                    this.updateColorSectionLabel('Object Color');
                    colorInput.disabled = false;
                    colorInput.title = "";
                    colorSection.style.display = 'block';
                    
                    // Update color input to show object's color
                    let objectColor = '#000000';
                    if (activeObject.type === 'i-text') {
                        objectColor = activeObject.fill || '#000000';
                    } else if (activeObject.type === 'path') {
                        objectColor = activeObject.stroke || '#000000';
                    }
                    colorInput.value = objectColor;
                }
            } else {
                // No object selected, show tool color
                this.updateColorSectionLabel('Tool Color');
                colorInput.disabled = false;
                colorInput.title = "";
                colorSection.style.display = 'block';
                
                if (this.toolColors[this.currentTool]) {
                    colorInput.value = this.toolColors[this.currentTool];
                }
            }
        } else {
            panel.classList.remove('show');
        }
    }

    // Zoom functionality
    zoomIn() {
        this.setZoom(this.zoomLevel * 1.25); // 25% increase
    }

    zoomOut() {
        this.setZoom(this.zoomLevel * 0.8); // 20% decrease
    }

    zoomFit() {
        this.setZoom(1.0); // Reset to fit width
    }

    setZoom(newZoomLevel) {
        // Clamp zoom level between 0.25x and 4x
        newZoomLevel = Math.max(0.25, Math.min(4.0, newZoomLevel));
        
        if (newZoomLevel === this.zoomLevel) return; // No change needed
        
        // Save current objects before changing zoom, preserving current scale
        if (this.fabricCanvas) {
            const oldScale = this.scale; // Preserve the current scale for correct normalization
            this.saveCurrentPageObjectsWithScale(oldScale);
        }
        
        this.zoomLevel = newZoomLevel;
        
        // Update zoom display
        this.updateZoomDisplay();
        
        // Re-render the current page with new zoom level
        if (this.pdfDoc && this.currentPage) {
            // Set flag to prevent double save in renderPage
            this.skipPageSave = true;
            // Re-render with new zoom (this will automatically restore objects)
            this.renderPage(this.currentPage);
        }
    }

    updateZoomDisplay() {
        const zoomDisplay = document.getElementById('zoomLevel');
        const zoomDisplayMobile = document.getElementById('zoomLevelMobile');
        const zoomText = Math.round(this.zoomLevel * 100) + '%';
        
        if (zoomDisplay) {
            zoomDisplay.textContent = zoomText;
        }
        if (zoomDisplayMobile) {
            zoomDisplayMobile.textContent = zoomText;
        }
    }

    // Helper method to get the appropriate font size for current zoom level
    getScaledFontSize(baseFontSize = 20) {
        return baseFontSize * (this.scale || 1);
    }

    // Helper method to get the normalized font size (for storage)
    getNormalizedFontSize(currentFontSize) {
        return currentFontSize / (this.scale || 1);
    }

    hasAnyAnnotations() {
        // Check if any page has annotations
        for (const pageNum in this.pageObjects) {
            if (this.pageObjects[pageNum] && this.pageObjects[pageNum].length > 0) {
                return true;
            }
        }
        return false;
    }

    showNoAnnotationsDialog() {
        // Create and show error dialog
        const modalHtml = `
            <div class="modal fade" id="noAnnotationsModal" tabindex="-1" aria-hidden="true">
                <div class="modal-dialog modal-dialog-centered">
                    <div class="modal-content">
                        <div class="modal-header border-0 pb-2" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important; color: white !important;">
                            <h5 class="modal-title w-100 text-center" style="color: white !important; margin: 0;">
                                <i class="fas fa-exclamation-triangle me-2"></i>Cannot Submit
                            </h5>
                        </div>
                        <div class="modal-body px-4 py-4">
                            <p class="mb-0 text-center">You cannot submit this PDF without adding any annotations, text, or signatures. Please add at least one annotation before submitting.</p>
                        </div>
                        <div class="modal-footer border-0 pt-0 pb-4 justify-content-center">
                            <button type="button" class="btn btn-secondary px-4" data-bs-dismiss="modal">
                                <i class="fas fa-check me-1"></i>Understood
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // Add modal to page
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        
        // Show modal
        const modal = new bootstrap.Modal(document.getElementById('noAnnotationsModal'));
        modal.show();
        
        // Clean up modal after it's hidden
        document.getElementById('noAnnotationsModal').addEventListener('hidden.bs.modal', function() {
            this.remove();
        }, { once: true });
    }

    async showSubmitConfirmationDialog() {
        return new Promise((resolve) => {
            // Create and show confirmation dialog
            const modalHtml = `
                <div class="modal fade" id="submitConfirmModal" tabindex="-1" aria-hidden="true">
                    <div class="modal-dialog modal-dialog-centered">
                        <div class="modal-content">
                            <div class="modal-header border-0 pb-2" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important; color: white !important;">
                                <h5 class="modal-title w-100 text-center" style="color: white !important; margin: 0;">
                                    <i class="fas fa-check-circle me-2"></i>Confirm Submission
                                </h5>
                            </div>
                            <div class="modal-body px-4 py-4">
                                <p class="mb-0 text-center">Are you sure you want to submit this PDF?</p>
                            </div>
                            <div class="modal-footer border-0 pt-0 pb-4 justify-content-center">
                                <button type="button" class="btn btn-outline-secondary me-3" data-bs-dismiss="modal" id="cancelSubmit">
                                    <i class="fas fa-times me-1"></i>Cancel
                                </button>
                                <button type="button" class="btn btn-success px-4" id="confirmSubmit">
                                    <i class="fas fa-check me-1"></i>Submit PDF
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            // Add modal to page
            document.body.insertAdjacentHTML('beforeend', modalHtml);
            
            // Show modal
            const modal = new bootstrap.Modal(document.getElementById('submitConfirmModal'));
            modal.show();
            
            // Handle user choice
            document.getElementById('confirmSubmit').addEventListener('click', () => {
                modal.hide();
                resolve(true);
            }, { once: true });
            
            document.getElementById('cancelSubmit').addEventListener('click', () => {
                modal.hide();
                resolve(false);
            }, { once: true });
            
            // Clean up modal after it's hidden
            document.getElementById('submitConfirmModal').addEventListener('hidden.bs.modal', function() {
                this.remove();
            }, { once: true });
        });
    }

    async showDeclineConfirmationDialog() {
        return new Promise((resolve) => {
            // Create and show decline confirmation dialog
            const modalHtml = `
                <div class="modal fade" id="declineConfirmModal" tabindex="-1" aria-hidden="true">
                    <div class="modal-dialog modal-dialog-centered">
                        <div class="modal-content">
                            <div class="modal-header border-0 pb-2" style="background: linear-gradient(135deg, #dc3545 0%, #c82333 100%) !important; color: white !important;">
                                <h5 class="modal-title w-100 text-center" style="color: white !important; margin: 0;">
                                    <i class="fas fa-exclamation-triangle me-2"></i>Decline PDF
                                </h5>
                            </div>
                            <div class="modal-body px-4 py-4">
                                <p class="mb-0 text-center">Are you sure you want to decline this PDF? This action cannot be undone and any annotations you've made will be lost.</p>
                            </div>
                            <div class="modal-footer border-0 pt-0 pb-4 justify-content-center">
                                <button type="button" class="btn btn-outline-secondary me-3" data-bs-dismiss="modal" id="cancelDecline">
                                    <i class="fas fa-times me-1"></i>Cancel
                                </button>
                                <button type="button" class="btn btn-danger px-4" id="confirmDecline">
                                    <i class="fas fa-ban me-1"></i>Decline PDF
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            // Add modal to page
            document.body.insertAdjacentHTML('beforeend', modalHtml);
            
            // Show modal
            const modal = new bootstrap.Modal(document.getElementById('declineConfirmModal'));
            modal.show();
            
            // Handle user choice
            document.getElementById('confirmDecline').addEventListener('click', () => {
                modal.hide();
                resolve(true);
            }, { once: true });
            
            document.getElementById('cancelDecline').addEventListener('click', () => {
                modal.hide();
                resolve(false);
            }, { once: true });
            
            // Clean up modal after it's hidden
            document.getElementById('declineConfirmModal').addEventListener('hidden.bs.modal', function() {
                this.remove();
            }, { once: true });
        });
    }
}
