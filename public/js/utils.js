/**
 * Utility functions for the Wynzio dashboard
 */
const Utils = (function() {
    /**
     * Format a date to a human-readable string
     * @param {string|Date} dateInput - Date string or Date object
     * @param {boolean} includeTime - Whether to include the time
     * @returns {string} Formatted date string
     */
    function formatDate(dateInput, includeTime = false) {
        if (!dateInput) return 'N/A';
        
        const date = new Date(dateInput);
        
        if (isNaN(date.getTime())) {
            return 'Invalid date';
        }
        
        const options = {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        };
        
        if (includeTime) {
            options.hour = '2-digit';
            options.minute = '2-digit';
        }
        
        return date.toLocaleDateString('en-US', options);
    }
    
    /**
     * Generate initials from a name
     * @param {string} name - Full name
     * @returns {string} Initials (up to 2 characters)
     */
    function getInitials(name) {
        if (!name) return '';
        
        const parts = name.trim().split(' ');
        
        if (parts.length === 1) {
            return parts[0].charAt(0).toUpperCase();
        }
        
        return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }
    
    /**
     * Generate a random color based on a string
     * @param {string} str - Input string
     * @returns {string} CSS color string
     */
    function stringToColor(str) {
        if (!str) return '#4261ee'; // Default color
        
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        
        const colors = [
            '#4261ee', '#2a4bd8', '#5f7bff', // Blues
            '#28a745', '#218838', '#1e7e34', // Greens
            '#dc3545', '#c82333', '#bd2130', // Reds
            '#ffc107', '#e0a800', '#d39e00', // Yellows
            '#17a2b8', '#138496', '#117a8b', // Teals
            '#6c757d', '#5a6268', '#545b62', // Grays
            '#6f42c1', '#6610f2', '#6f42c1', // Purples
            '#fd7e14', '#e96a05', '#ca5a0a'  // Oranges
        ];
        
        return colors[Math.abs(hash) % colors.length];
    }
    
    /**
     * Show a notification message
     * @param {string} message - Notification message
     * @param {string} type - Notification type ('success', 'error', 'warning', 'info')
     * @param {number} duration - Duration in milliseconds
     */
    function showNotification(message, type = 'info', duration = 3000) {
        // Create container if it doesn't exist
        let container = document.querySelector('.notification-container');
        
        if (!container) {
            container = document.createElement('div');
            container.classList.add('notification-container');
            document.body.appendChild(container);
        }
        
        // Create notification element
        const notification = document.createElement('div');
        notification.classList.add('notification');
        notification.classList.add(`notification-${type}`);
        
        // Add icon based on type
        let icon;
        switch (type) {
            case 'success':
                icon = 'fas fa-check-circle';
                break;
            case 'error':
                icon = 'fas fa-times-circle';
                break;
            case 'warning':
                icon = 'fas fa-exclamation-triangle';
                break;
            default:
                icon = 'fas fa-info-circle';
        }
        
        notification.innerHTML = `
            <div class="notification-icon">
                <i class="${icon}"></i>
            </div>
            <div class="notification-content">
                <p>${message}</p>
            </div>
            <button class="notification-close">
                <i class="fas fa-times"></i>
            </button>
        `;
        
        // Add to container
        container.appendChild(notification);
        
        // Add event listener to close button
        const closeButton = notification.querySelector('.notification-close');
        closeButton.addEventListener('click', function() {
            notification.classList.add('notification-closing');
            setTimeout(() => notification.remove(), 300);
        });
        
        // Auto-close after duration
        setTimeout(() => {
            if (notification.parentNode) {
                notification.classList.add('notification-closing');
                setTimeout(() => notification.remove(), 300);
            }
        }, duration);
        
        // Show notification with animation
        setTimeout(() => notification.classList.add('notification-visible'), 10);
    }
    
    /**
     * Add CSS styles to document
     * @param {string} css - CSS rules
     * @param {string} id - Style element ID
     */
    function addCSS(css, id) {
        // Check if style with this ID already exists
        if (id && document.getElementById(id)) {
            return;
        }
        
        const style = document.createElement('style');
        style.textContent = css;
        
        if (id) {
            style.id = id;
        }
        
        document.head.appendChild(style);
    }
    
    /**
     * Store data in localStorage with optional expiration
     * @param {string} key - Storage key
     * @param {any} value - Value to store
     * @param {number} expiration - Expiration time in seconds (optional)
     */
    function storeData(key, value, expiration = null) {
        const item = {
            value: value,
            timestamp: new Date().getTime()
        };
        
        if (expiration) {
            item.expiration = expiration * 1000; // Convert to milliseconds
        }
        
        localStorage.setItem(key, JSON.stringify(item));
    }
    
    /**
     * Retrieve data from localStorage
     * @param {string} key - Storage key
     * @param {any} defaultValue - Default value if key not found or expired
     * @returns {any} Retrieved value or default value
     */
    function getData(key, defaultValue = null) {
        const itemStr = localStorage.getItem(key);
        
        if (!itemStr) {
            return defaultValue;
        }
        
        try {
            const item = JSON.parse(itemStr);
            const now = new Date().getTime();
            
            // Check if item has expiration and is expired
            if (item.expiration && now - item.timestamp > item.expiration) {
                localStorage.removeItem(key);
                return defaultValue;
            }
            
            return item.value;
        } catch (e) {
            console.error('Error parsing stored data:', e);
            return defaultValue;
        }
    }
    
    /**
     * Remove data from localStorage
     * @param {string} key - Storage key
     */
    function removeData(key) {
        localStorage.removeItem(key);
    }
    
    /**
     * Create a debounced version of a function
     * @param {Function} func - Function to debounce
     * @param {number} wait - Wait time in milliseconds
     * @returns {Function} Debounced function
     */
    function debounce(func, wait = 300) {
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
    
    /**
     * Create a throttled version of a function
     * @param {Function} func - Function to throttle
     * @param {number} limit - Limit time in milliseconds
     * @returns {Function} Throttled function
     */
    function throttle(func, limit = 300) {
        let inThrottle;
        
        return function executedFunction(...args) {
            if (!inThrottle) {
                func(...args);
                inThrottle = true;
                
                setTimeout(() => {
                    inThrottle = false;
                }, limit);
            }
        };
    }
    
    // Public API
    return {
        formatDate,
        getInitials,
        stringToColor,
        showNotification,
        addCSS,
        storeData,
        getData,
        removeData,
        debounce,
        throttle
    };
})();