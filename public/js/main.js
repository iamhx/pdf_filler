// Initialize the application when the DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
    // Get the file ID and session ID from the URL
    const fileId = utils.getUrlParam('fileId');
    const sessionId = utils.getUrlParam('sessionId');
    
    if (!fileId) {
        // Show as permanent error modal
        utils.showError('No PDF file specified. Please provide a valid fileId parameter.', 'Missing File ID', true);
        window.hasActiveErrorModal = true;
        window.disablePageInteraction();
        return;
    }

    if (!sessionId) {
        // Show as permanent error modal
        utils.showError('A valid session ID is required to access documents in this system.', 'Session ID Required', true);
        window.hasActiveErrorModal = true;
        window.disablePageInteraction();
        return;
    }

    // Check if this PDF is still valid (not already signed/declined)
    await checkPdfValidity(fileId, sessionId);

    // Initialize the PDF editor
    const editor = new PdfEditor();
    await editor.initialize(fileId, sessionId);
});

// Add page visibility and back button handling
window.addEventListener('pageshow', async (event) => {
    // This event fires when the page is shown, including from browser cache (back button)
    if (event.persisted && !window.hasActiveErrorModal) {
        // Page was loaded from cache (back button navigation)
        const fileId = utils.getUrlParam('fileId');
        const sessionId = utils.getUrlParam('sessionId');
        
        if (!fileId) {
            // Show as permanent error modal
            utils.showError('No PDF file specified. Please provide a valid fileId parameter.', 'Missing File ID', true);
            window.hasActiveErrorModal = true;
            window.disablePageInteraction();
            return;
        }

        if (!sessionId) {
            // Show as permanent error modal
            utils.showError('A valid session ID is required to access documents in this system.', 'Session ID Required', true);
            window.hasActiveErrorModal = true;
            window.disablePageInteraction();
            return;
        }
        
        // Only check validity if we have both fileId and sessionId
        await checkPdfValidity(fileId, sessionId);
    }
});

// Track if there's already an error modal showing
window.hasActiveErrorModal = false;

// Function to check if PDF is still valid for viewing/editing
async function checkPdfValidity(fileId, sessionId) {
    // Don't recheck if we're already showing an error
    if (window.hasActiveErrorModal) {
        return false;
    }
    
    try {
        // Add timestamp for cache busting
        const timestamp = new Date().getTime();
        
        // First, use HEAD request for efficiency
        const response = await fetch(`/api/pdf/${fileId}${sessionId ? `?sessionId=${sessionId}` : ''}&_t=${timestamp}`, {
            method: 'HEAD', // Only check headers, don't download the PDF
            cache: 'no-store' // Prevent browser caching
        });
        
        if (!response.ok) {
            // For HEAD requests, we need to make a GET request to get error details
            const detailResponse = await fetch(`/api/pdf/${fileId}${sessionId ? `?sessionId=${sessionId}` : ''}&_t=${timestamp}`, {
                method: 'GET',
                cache: 'no-store' // Prevent browser caching
            });
            
            if (!detailResponse.ok) {
                let errorData = {};
                try {
                    errorData = await detailResponse.json();
                } catch (e) {
                    console.error('Failed to parse error response:', e);
                    errorData = { message: 'Unable to load document. Please try again later.' };
                }
                
                // Determine the appropriate error message and title
                const message = errorData.message || 'This PDF is no longer available.';
                let title = 'Document Unavailable';
                
                if (detailResponse.status === 410) {
                    // Different types of 410 errors
                    if (errorData.error === 'PDF already signed') {
                        title = 'Already Signed';
                    } else if (errorData.error === 'PDF declined') {
                        title = 'PDF Declined';
                    } else if (errorData.error === 'URL expired') {
                        title = 'URL Expired';
                    } else if (errorData.error === 'Session expired') {
                        title = 'Session Expired';
                    }
                } else if (detailResponse.status === 404) {
                    if (errorData.error === 'Session not found') {
                        title = 'Invalid Session';
                    } else if (errorData.error === 'Session completed') {
                        title = 'Session Ended';
                    } else if (errorData.error === 'Invalid document') {
                        title = 'Invalid Document';
                    } else {
                        title = 'Not Found';
                    }
                } else if (detailResponse.status === 400) {
                    if (errorData.error === 'Session ID required') {
                        title = 'Session Required';
                    } else {
                        title = 'Invalid Request';
                    }
                }
                
                // Show error message as a permanent modal and prevent further interaction
                utils.showError(message, title, true);
                
                // Set flag to prevent further API calls
                window.hasActiveErrorModal = true;
                
                // Disable all interactive elements
                window.disablePageInteraction();
                
                return false;
            }
        }
        
        return true;
    } catch (error) {
        console.error('Error checking PDF validity:', error);
        // If we can't check validity, show an error
        utils.showError('Could not verify PDF status. There might be a network issue.', 'Connection Error', true);
        window.hasActiveErrorModal = true;
        window.disablePageInteraction();
        return false;
    }
}

// Function to disable all page interaction
window.disablePageInteraction = function() {
    // Disable all buttons
    const buttons = document.querySelectorAll('button');
    buttons.forEach(button => {
        button.disabled = true;
        button.style.opacity = '0.5';
        button.style.pointerEvents = 'none';
    });
    
    // Disable all input elements
    const inputs = document.querySelectorAll('input, textarea, select');
    inputs.forEach(input => {
        input.disabled = true;
        input.style.opacity = '0.5';
        input.style.pointerEvents = 'none';
    });
    
    // Disable all links
    const links = document.querySelectorAll('a');
    links.forEach(link => {
        link.style.pointerEvents = 'none';
        link.style.opacity = '0.5';
        link.setAttribute('tabindex', '-1');
    });
    
    // Disable all interactive elements
    const interactive = document.querySelectorAll('[role="button"], [role="tab"], .dropdown-toggle, .nav-item');
    interactive.forEach(element => {
        element.style.pointerEvents = 'none';
        element.style.opacity = '0.5';
        element.setAttribute('tabindex', '-1');
        if (element.hasAttribute('data-bs-toggle')) {
            element.removeAttribute('data-bs-toggle');
        }
    });
    
    // Disable all canvas elements (for PDF drawing)
    const canvases = document.querySelectorAll('canvas');
    canvases.forEach(canvas => {
        canvas.style.pointerEvents = 'none';
    });
    
    // Add an overlay to prevent interaction if the modal is not displayed
    if (!document.querySelector('.error-modal-container')) {
        const overlay = document.createElement('div');
        overlay.id = 'page-interaction-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.2);
            z-index: 999;
            pointer-events: all;
        `;
        document.body.appendChild(overlay);
    }
    
    // Disable fabric.js interaction if initialized
    if (window.pdfEditor && window.pdfEditor.fabricCanvas) {
        window.pdfEditor.fabricCanvas.selection = false;
        window.pdfEditor.fabricCanvas.interactive = false;
        window.pdfEditor.fabricCanvas.requestRenderAll();
    }
};
