// Utility functions for the PDF Filler application

const utils = {
    // Get URL parameters
    getUrlParam(param) {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get(param);
    },

    // Show loading spinner
    showLoading() {
        document.getElementById('loadingSpinner').classList.remove('d-none');
    },

    // Hide loading spinner
    hideLoading() {
        document.getElementById('loadingSpinner').classList.add('d-none');
    },

    // Show error message
    showError(message, title = 'Error', isPermanent = false) {
        if (isPermanent) {
            // Show as a modal for permanent errors
            this.showErrorModal(message, title);
        } else {
            // Use toast for non-critical errors
            this.showToast(message, title, 'danger');
        }
    },
    
    // Show error in a modal (for permanent errors)
    showErrorModal(message, title = 'Error') {
        // Set global flag to indicate error modal is active
        window.hasActiveErrorModal = true;
        
        // Remove any existing modals
        const existingModal = document.querySelector('.error-modal-container');
        if (existingModal) {
            existingModal.remove();
        }
        
        // Create modal container
        const modalContainer = document.createElement('div');
        modalContainer.className = 'error-modal-container';
        
        // Create modal content
        const modalContent = document.createElement('div');
        modalContent.className = 'error-modal bg-white';
        
        // Create modal header
        const modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header bg-danger text-white';
        modalHeader.innerHTML = `
            <h5 class="modal-title"><i class="fas fa-exclamation-triangle me-2"></i>${title}</h5>
        `;
        
        // Create modal body
        const modalBody = document.createElement('div');
        modalBody.className = 'modal-body';
        modalBody.innerHTML = `
            <p>${message}</p>
            <p class="mt-3 mb-0 text-muted small">Please refresh the page or enter a valid URL to continue.</p>
        `;
        
        // Assemble modal (no footer with buttons)
        modalContent.appendChild(modalHeader);
        modalContent.appendChild(modalBody);
        modalContainer.appendChild(modalContent);
        
        // Add to document
        document.body.appendChild(modalContainer);
        
        // Prevent interaction with the page behind the modal
        const allFocusableElements = document.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        allFocusableElements.forEach(el => {
            if (!modalContainer.contains(el)) {
                el.setAttribute('tabindex', '-1');
                el.setAttribute('data-original-tabindex', el.getAttribute('tabindex') || '0');
            }
        });
    },

    // Show toast notification
    showToast(message, title = 'Notification', type = 'info') {
        // Remove any existing toasts
        const existingToast = document.querySelector('.toast-container');
        if (existingToast) {
            existingToast.remove();
        }

        // Create toast container
        const toastContainer = document.createElement('div');
        toastContainer.className = 'toast-container position-fixed top-0 end-0 p-3';
        toastContainer.style.zIndex = '9999';

        // Create toast
        const toastEl = document.createElement('div');
        toastEl.className = `toast show border-${type}`;
        toastEl.setAttribute('role', 'alert');
        toastEl.innerHTML = `
            <div class="toast-header bg-${type} text-white">
                <i class="fas fa-${type === 'danger' ? 'exclamation-triangle' : type === 'success' ? 'check-circle' : 'info-circle'} me-2"></i>
                <strong class="me-auto">${title}</strong>
                <button type="button" class="btn-close btn-close-white" data-bs-dismiss="toast"></button>
            </div>
            <div class="toast-body">
                ${message}
            </div>
        `;

        toastContainer.appendChild(toastEl);
        document.body.appendChild(toastContainer);

        // Auto-remove after some seconds
        const autoHideDelay = 8000; // 8 seconds for all toast types
        setTimeout(() => {
            if (toastContainer.parentNode) {
                toastContainer.remove();
            }
        }, autoHideDelay);

        // Handle close button
        const closeBtn = toastEl.querySelector('.btn-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                toastContainer.remove();
            });
        }
    },

    // Debounce function for performance optimization
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }
};
